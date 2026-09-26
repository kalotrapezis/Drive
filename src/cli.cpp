#include <QCommandLineOption>
#include <QCommandLineParser>
#include <QCryptographicHash>
#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QJsonObject>
#include <QSaveFile>
#include <QJsonValue>
#include <QHash>
#include <QNetworkDatagram>
#include <QStorageInfo>
#include <QStandardPaths>
#include <QTextStream>
#include <QTimer>
#include <QUrl>
#include <QUdpSocket>
#include <QSslCertificate>
#include <QSslConfiguration>
#include <QSslKey>
#include <QSslSocket>

#include <memory>

#include <KIO/CopyJob>
#include <KIO/ListJob>

#include "verifiedcopy.h"
#include "remoteinventory.h"
#include "wirelessprotocol.h"
#include "wirelessprofile.h"
#include "wirelesssession.h"

namespace {

struct Output {
    QFile logFile;
    QTextStream terminal{stderr, QIODevice::WriteOnly};

    void write(const QString &line) {
        terminal << line << Qt::endl;
        if (logFile.isOpen()) {
            QTextStream file(&logFile);
            file << line << Qt::endl;
            logFile.flush();
        }
    }
};

QUrl urlFromArgument(const QString &argument) {
    const QUrl url = QUrl::fromUserInput(argument);
    return url.isValid() ? url : QUrl();
}

QString localPathFromArgument(const QString &argument) {
    const QUrl url = urlFromArgument(argument);
    return url.isLocalFile() ? QDir::cleanPath(url.toLocalFile()) : QString();
}

int fail(Output &output, const QString &message) {
    output.write(QStringLiteral("ERROR %1").arg(message));
    return 2;
}

int runInventory(QCoreApplication &app, Output &output, const QUrl &url) {
    output.write(QStringLiteral("INFO inventory started url=%1").arg(url.toString()));
    auto *job = KIO::listDir(url, KIO::HideProgressInfo, KIO::ListJob::ListFlag::ExcludeDotAndDotDot);
    QObject::connect(job, &KIO::ListJob::entries, &app, [&output](KIO::Job *, const KIO::UDSEntryList &entries) {
        for (const auto &entry : entries) {
            const QString name = entry.stringValue(KIO::UDSEntry::UDS_NAME);
            const bool directory = entry.numberValue(KIO::UDSEntry::UDS_FILE_TYPE, 0) == 0040000;
            const auto size = entry.numberValue(KIO::UDSEntry::UDS_SIZE, -1);
            output.write(QStringLiteral("ITEM %1 type=%2 size=%3")
                             .arg(name, directory ? QStringLiteral("directory") : QStringLiteral("file"), QString::number(size)));
        }
    });
    QObject::connect(job, &KJob::result, &app, [&app, &output](KJob *finished) {
        if (finished->error()) {
            output.write(QStringLiteral("ERROR inventory failed: %1").arg(finished->errorText()));
            app.exit(1);
            return;
        }
        output.write(QStringLiteral("INFO inventory completed"));
        app.exit(0);
    });
    return app.exec();
}

int runRecursiveInventory(QCoreApplication &app, Output &output, const QUrl &url, qint64 maxItems, qint64 maxBytes) {
    if (maxItems < 0 || maxBytes < 0) return fail(output, QStringLiteral("scan limits cannot be negative"));
    output.write(QStringLiteral("INFO scan started url=%1 max_items=%2 max_bytes=%3").arg(url.toString()).arg(maxItems).arg(maxBytes));
    qint64 files = 0, bytes = 0;
    bool boundedOut = false;
    auto *job = KIO::listRecursive(url, KIO::HideProgressInfo, KIO::ListJob::ListFlag::ExcludeDotAndDotDot);
    QObject::connect(job, &KIO::ListJob::entries, &app, [&output, &files, &bytes, &boundedOut, maxItems, maxBytes, job](KIO::Job *, const KIO::UDSEntryList &entries) {
        if (boundedOut) return;
        for (const auto &entry : entries) {
            const bool directory = entry.numberValue(KIO::UDSEntry::UDS_FILE_TYPE, 0) == 0040000;
            const qint64 size = entry.numberValue(KIO::UDSEntry::UDS_SIZE, 0);
            if (!directory && ((maxItems > 0 && files >= maxItems) || (maxBytes > 0 && bytes > maxBytes - size))) {
                boundedOut = true;
                job->kill(KJob::EmitResult);
                return;
            }
            if (!directory) { ++files; bytes += size; }
            const QString item = entry.stringValue(KIO::UDSEntry::UDS_URL);
            output.write(QStringLiteral("ITEM %1 type=%2 size=%3").arg(item.isEmpty() ? entry.stringValue(KIO::UDSEntry::UDS_NAME) : item,
                                                                     directory ? QStringLiteral("directory") : QStringLiteral("file"), QString::number(size)));
        }
    });
    QObject::connect(job, &KJob::result, &app, [&app, &output, &files, &bytes, &boundedOut](KJob *finished) {
        if (boundedOut) {
            output.write(QStringLiteral("ERROR scan bounds exceeded; source was not modified"));
            app.exit(2);
        } else if (finished->error()) {
            output.write(QStringLiteral("ERROR scan failed: %1").arg(finished->errorText()));
            app.exit(1);
        } else {
            output.write(QStringLiteral("SCAN completed files=%1 bytes=%2").arg(files).arg(bytes));
            app.exit(0);
        }
    });
    return app.exec();
}

int runCopy(QCoreApplication &app, Output &output, const QUrl &source, const QUrl &destination) {
    if (destination.isLocalFile() && QFileInfo(destination.toLocalFile()).exists()
        && !QFileInfo(destination.toLocalFile()).isDir()) {
        return fail(output, QStringLiteral("refusing existing destination file: %1").arg(destination.toLocalFile()));
    }

    output.write(QStringLiteral("INFO copy started source=%1 destination=%2")
                     .arg(source.toString(), destination.toString()));
    auto *job = KIO::copy({source}, destination, KIO::HideProgressInfo);
    auto lastPercent = std::make_shared<unsigned long>(-1);
    QObject::connect(job, &KJob::percentChanged, &app, [&output, lastPercent](KJob *, unsigned long percent) {
        if (*lastPercent == percent) return;
        *lastPercent = percent;
        output.write(QStringLiteral("PROGRESS percent=%1").arg(percent));
    });
    QObject::connect(job, &KJob::processedSize, &app, [&output](KJob *, qulonglong size) {
        output.write(QStringLiteral("PROGRESS bytes=%1").arg(size));
    });
    QObject::connect(job, &KJob::result, &app, [&app, &output](KJob *finished) {
        if (finished->error()) {
            output.write(QStringLiteral("ERROR copy failed: %1").arg(finished->errorText()));
            app.exit(1);
            return;
        }
        output.write(QStringLiteral("INFO copy completed"));
        app.exit(0);
    });
    return app.exec();
}

VerifiedCopy::Request localRequest(const QString &source, const QString &destination, const QString &catalog, qint64 stagingMaxBytes) {
    VerifiedCopy::Request request;
    request.sourceRoot = source;
    request.destinationRoot = destination;
    request.selectedStorageRoot = destination;
    request.storageIdentity = VerifiedCopy::liveStorageIdentity(destination);
    request.filesystemType = QStorageInfo(destination).fileSystemType();
    request.databasePath = catalog;
    request.stagingMaxBytes = stagingMaxBytes;
    request.destinationStorageId = QStringLiteral("cli-%1").arg(QString::fromLatin1(
        QCryptographicHash::hash(destination.toUtf8(), QCryptographicHash::Sha256).toHex().left(16)));
    request.routeId = QStringLiteral("cli-route-%1").arg(QString::fromLatin1(
        QCryptographicHash::hash((source + QChar('\n') + destination).toUtf8(), QCryptographicHash::Sha256).toHex().left(16)));
    return request;
}

void writePreview(Output &output, const VerifiedCopy::Preview &preview) {
    output.write(QStringLiteral("PREVIEW ok=%1 files=%2 bytes=%3 to_copy=%4 identical=%5 duplicates=%6 conflicts=%7 unreadable=%8 free_bytes=%9 margin=%10")
                     .arg(preview.ok).arg(preview.files).arg(preview.bytes).arg(preview.toCopy).arg(preview.identical)
                     .arg(preview.duplicates).arg(preview.conflicts).arg(preview.unreadable).arg(preview.freeBytes).arg(preview.minimumFreeBytes));
    if (!preview.error.isEmpty()) output.write(QStringLiteral("ERROR preview failed: %1").arg(preview.error));
}

int runVerifiedLocal(QCoreApplication &, Output &output, const QString &command,
                     const QString &source, const QString &destination, const QString &catalog, qint64 stagingMaxBytes) {
    if (!QFileInfo(source).isDir() || !QFileInfo(destination).isDir())
        return fail(output, QStringLiteral("source and destination must be existing local directories"));
    if (!QDir().mkpath(QFileInfo(catalog).absolutePath()))
        return fail(output, QStringLiteral("could not create catalog directory: %1").arg(QFileInfo(catalog).absolutePath()));
    const VerifiedCopy::Request request = localRequest(source, destination, catalog, stagingMaxBytes);
    if (request.storageIdentity.isEmpty()) return fail(output, QStringLiteral("could not identify destination storage"));
    VerifiedCopy::Preview preview = VerifiedCopy::inspect(request);
    writePreview(output, preview);
    if (!preview.ok || command == QStringLiteral("verified-preview")) return preview.ok ? 0 : 1;

    VerifiedCopy engine(catalog);
    QObject::connect(&engine, &VerifiedCopy::progressChanged, [&output](qint64 done, qint64 total, const QString &path) {
        output.write(QStringLiteral("PROGRESS bytes=%1 total=%2 path=%3").arg(done).arg(total).arg(path));
    });
    QString error;
    output.write(QStringLiteral("INFO verified copy started source=%1 destination=%2 catalog=%3").arg(source, destination, catalog));
    if (!engine.executeBlocking(request, &error)) return fail(output, error);
    output.write(QStringLiteral("INFO verified copy completed"));
    return 0;
}

VerifiedCopy::RemoteRequest remoteRequest(const QUrl &source, const QString &sourceRelative, const QString &destination, const QString &destinationRelative, const QString &catalog, const QString &transport = QStringLiteral("mtp"), const QUrl &identityRoot = {}) {
    const QUrl identityUrl = identityRoot.isValid() ? identityRoot : source;
    const QString sourceKey = identityUrl.toString(QUrl::FullyEncoded);
    const QString sourceDigest = QString::fromLatin1(QCryptographicHash::hash(sourceKey.toUtf8(), QCryptographicHash::Sha256).toHex());
    const QString destinationDigest = QString::fromLatin1(QCryptographicHash::hash(destination.toUtf8(), QCryptographicHash::Sha256).toHex());
    const QStringList parts = identityUrl.path(QUrl::FullyDecoded).split('/', Qt::SkipEmptyParts);
    const QString deviceStableId = transport == QStringLiteral("mtp") && identityUrl.scheme() == QStringLiteral("mtp") && !parts.isEmpty()
        ? QStringLiteral("mtp:%1").arg(parts.first()) : QStringLiteral("%1-device:%2").arg(transport, sourceDigest);
    const QString storageKey = parts.size() > 1 ? deviceStableId + QLatin1Char('\n') + parts.at(1) : sourceKey;
    const QString storageDigest = QString::fromLatin1(QCryptographicHash::hash(storageKey.toUtf8(), QCryptographicHash::Sha256).toHex());
    VerifiedCopy::RemoteRequest request;
    request.sourceUrl = source;
    request.sourceRootUrl = identityUrl;
    request.sourceRelative = sourceRelative;
    request.destinationRoot = destination;
    request.destinationRelative = destinationRelative;
    request.selectedStorageRoot = destination;
    request.storageIdentity = VerifiedCopy::liveStorageIdentity(destination);
    request.filesystemType = QStorageInfo(destination).fileSystemType();
    request.databasePath = catalog;
    request.routeId = QStringLiteral("%1-route-%2").arg(transport, sourceDigest.left(16) + QStringLiteral("-") + destinationDigest.left(16));
    request.destinationStorageId = QStringLiteral("cli-%1").arg(destinationDigest.left(16));
    request.sourceStorageIdentity = QStringLiteral("%1:%2").arg(transport, storageDigest);
    request.sourceStorageId = QStringLiteral("%1-storage-%2").arg(transport, storageDigest.left(16));
    request.sourceDeviceStableId = deviceStableId;
    request.sourceDeviceId = QStringLiteral("%1-device-%2").arg(transport, QString::fromLatin1(QCryptographicHash::hash(deviceStableId.toUtf8(), QCryptographicHash::Sha256).toHex().left(16)));
    request.sourceDeviceName = transport == QStringLiteral("wireless") ? QStringLiteral("Wireless simulation") : parts.value(0, QStringLiteral("MTP source"));
    request.sourceStorageLabel = parts.value(1, request.sourceDeviceName);
    request.resumable = transport == QStringLiteral("wireless");
    return request;
}

bool executeRemoteRequest(VerifiedCopy &engine, Output &output, const VerifiedCopy::RemoteRequest &request, QString *error) {
    if (!engine.executeRemoteBlocking(request, error)) return false;
    output.write(QStringLiteral("RECEIPT verified path=%1").arg(request.destinationRelative));
    return true;
}

int runVerifiedRemote(Output &output, const QUrl &source, const QString &destination, const QString &catalog, const QString &transport = QStringLiteral("mtp")) {
    if (!source.isValid() || !QFileInfo(destination).isDir()) return fail(output, QStringLiteral("source URL and existing local destination directory are required"));
    if (!QDir().mkpath(QFileInfo(catalog).absolutePath())) return fail(output, QStringLiteral("could not create catalog directory: %1").arg(QFileInfo(catalog).absolutePath()));
    const QString relative = QFileInfo(source.path(QUrl::FullyDecoded)).fileName();
    if (relative.isEmpty()) return fail(output, QStringLiteral("source URL has no filename"));
    const VerifiedCopy::RemoteRequest request = remoteRequest(source, relative, destination, relative, catalog, transport);
    if (request.storageIdentity.isEmpty()) return fail(output, QStringLiteral("could not identify destination storage"));
    output.write(QStringLiteral("INFO verified %1 import started source=%2 destination=%3 catalog=%4").arg(transport == QStringLiteral("wireless") ? QStringLiteral("wireless simulation") : QStringLiteral("MTP"), source.toString(), destination, catalog));
    VerifiedCopy engine(catalog);
    QObject::connect(&engine, &VerifiedCopy::progressChanged, [&output](qint64 done, qint64 total, const QString &path) {
        output.write(QStringLiteral("PROGRESS bytes=%1 total=%2 path=%3").arg(done).arg(total).arg(path));
    });
    QString error;
    if (!executeRemoteRequest(engine, output, request, &error)) return fail(output, error);
    output.write(QStringLiteral("INFO verified %1 import completed").arg(transport == QStringLiteral("wireless") ? QStringLiteral("wireless simulation") : QStringLiteral("MTP")));
    return 0;
}

int runVerifiedExport(Output &output, const QString &source, const QUrl &destination, const QString &catalog) {
    const QStringList parts = destination.path(QUrl::FullyDecoded).split('/', Qt::SkipEmptyParts);
    if (!QFileInfo(source).isFile() || !destination.isValid() || (destination.scheme() != QStringLiteral("mtp") && destination.scheme() != QStringLiteral("file"))) return fail(output, QStringLiteral("verified-export requires a local source file and MTP destination file URL"));
    const QString deviceName = destination.scheme() == QStringLiteral("mtp") ? parts.value(0) : QStringLiteral("Test phone");
    const QString deviceStable = destination.scheme() == QStringLiteral("mtp") ? QStringLiteral("mtp:%1").arg(deviceName) : QStringLiteral("mtp:file-test-phone");
    const QString storageLabel = destination.scheme() == QStringLiteral("mtp") ? parts.value(1, QStringLiteral("Phone storage")) : QStringLiteral("Test phone storage");
    const QString storageDigest = QString::fromLatin1(QCryptographicHash::hash((deviceStable + QLatin1Char('\n') + storageLabel).toUtf8(), QCryptographicHash::Sha256).toHex());
    const QString relative = destination.scheme() == QStringLiteral("mtp") ? parts.mid(2).join('/') : QFileInfo(destination.toLocalFile()).fileName();
    if (relative.isEmpty()) return fail(output, QStringLiteral("MTP destination must include a filename inside phone storage"));
    VerifiedCopy::ExportRequest request;
    request.sourcePath = source; request.destinationUrl = destination; request.destinationRelative = relative; request.databasePath = catalog;
    if (destination.scheme() == QStringLiteral("mtp")) { request.destinationRootUrl = destination; request.destinationRootUrl.setPath(QStringLiteral("/%1/%2/").arg(parts.value(0), parts.value(1))); }
    else request.destinationRootUrl = destination.adjusted(QUrl::RemoveFilename);
    request.destinationDeviceStableId = deviceStable; request.destinationDeviceId = QStringLiteral("mtp-device-%1").arg(QString::fromLatin1(QCryptographicHash::hash(deviceStable.toUtf8(), QCryptographicHash::Sha256).toHex().left(16))); request.destinationDeviceName = deviceName;
    request.destinationStorageIdentity = QStringLiteral("mtp:%1").arg(storageDigest); request.destinationStorageId = QStringLiteral("mtp-storage-%1").arg(storageDigest.left(16)); request.destinationStorageLabel = storageLabel;
    request.routeId = QStringLiteral("mtp-export-%1").arg(QString::fromLatin1(QCryptographicHash::hash((QFileInfo(source).absolutePath() + QLatin1Char('\n') + request.destinationStorageIdentity).toUtf8(), QCryptographicHash::Sha256).toHex().left(16)));
    VerifiedCopy engine(catalog); QString error;
    QObject::connect(&engine, &VerifiedCopy::progressChanged, [&output](qint64 done, qint64 total, const QString &path) { output.write(QStringLiteral("PROGRESS bytes=%1 total=%2 path=%3").arg(done).arg(total).arg(path)); });
    if (!engine.executeExportBlocking(request, &error)) return fail(output, error);
    output.write(QStringLiteral("RECEIPT verified MTP export path=%1").arg(relative));
    return 0;
}

int runWirelessBeacon(Output &output, const QString &stableIdentity, const QString &label, const QString &endpoint) {
    if (!stableIdentity.startsWith(QStringLiteral("wireless:")) || label.trimmed().isEmpty()) return fail(output, QStringLiteral("wireless-beacon needs a wireless: identity and a non-empty name"));
    QJsonObject beacon{{"magic", QString::fromLatin1(LocalDrive::WirelessProtocol::Magic)}, {"protocol", LocalDrive::WirelessProtocol::Version}, {"stableIdentity", stableIdentity}, {"label", label.trimmed()}};
    if (!endpoint.trimmed().isEmpty()) beacon.insert(QStringLiteral("endpoint"), endpoint.trimmed());
    const QByteArray payload = QJsonDocument(beacon).toJson(QJsonDocument::Compact);
    QUdpSocket socket;
    const qint64 sent = socket.writeDatagram(payload, QHostAddress::Broadcast, LocalDrive::WirelessProtocol::DiscoveryPort);
    if (sent != payload.size()) return fail(output, QStringLiteral("could not broadcast wireless beacon: %1").arg(socket.errorString()));
    output.write(QStringLiteral("INFO wireless beacon sent identity=%1 name=%2 port=%3").arg(stableIdentity, label, QString::number(LocalDrive::WirelessProtocol::DiscoveryPort)));
    return 0;
}

int runWirelessDiscover(QCoreApplication &app, Output &output, int durationSeconds) {
    if (durationSeconds <= 0) return fail(output, QStringLiteral("wireless-discover duration must be positive"));
    QUdpSocket socket;
    if (!socket.bind(QHostAddress::AnyIPv4, LocalDrive::WirelessProtocol::DiscoveryPort, QUdpSocket::ShareAddress | QUdpSocket::ReuseAddressHint))
        return fail(output, QStringLiteral("could not listen for wireless discovery: %1").arg(socket.errorString()));
    QHash<QString, qint64> lastSeen;
    output.write(QStringLiteral("INFO wireless discovery listening port=%1 duration=%2s").arg(LocalDrive::WirelessProtocol::DiscoveryPort).arg(durationSeconds));
    QTimer expiry;
    expiry.setInterval(5000);
    QObject::connect(&socket, &QUdpSocket::readyRead, [&] {
        while (socket.hasPendingDatagrams()) {
            const QNetworkDatagram datagram = socket.receiveDatagram();
            QJsonParseError parseError;
            const QJsonDocument document = QJsonDocument::fromJson(datagram.data(), &parseError);
            if (parseError.error != QJsonParseError::NoError || !document.isObject()) continue;
            const QJsonObject object = document.object();
            const QString identity = object.value(QStringLiteral("stableIdentity")).toString().trimmed();
            const QString label = object.value(QStringLiteral("label")).toString().trimmed();
            if (object.value(QStringLiteral("magic")).toString() != QString::fromLatin1(LocalDrive::WirelessProtocol::Magic)
                || object.value(QStringLiteral("protocol")).toInt() != LocalDrive::WirelessProtocol::Version
                || !identity.startsWith(QStringLiteral("wireless:")) || label.isEmpty()) continue;
            const qint64 now = QDateTime::currentMSecsSinceEpoch();
            if (!lastSeen.contains(identity)) {
                const QString endpoint = object.value(QStringLiteral("endpoint")).toString().trimmed().isEmpty()
                    ? datagram.senderAddress().toString() : object.value(QStringLiteral("endpoint")).toString().trimmed();
                output.write(QStringLiteral("DEVICE ONLINE identity=%1 name=%2 endpoint=%3").arg(identity, label, endpoint));
            }
            lastSeen.insert(identity, now);
        }
    });
    QObject::connect(&expiry, &QTimer::timeout, [&] {
        const qint64 now = QDateTime::currentMSecsSinceEpoch();
        for (auto it = lastSeen.begin(); it != lastSeen.end();) {
            if (now - it.value() > 15000) {
                output.write(QStringLiteral("DEVICE OFFLINE identity=%1").arg(it.key()));
                it = lastSeen.erase(it);
            } else {
                ++it;
            }
        }
    });
    expiry.start();
    QTimer::singleShot(durationSeconds * 1000, &app, [&app, &output] {
        output.write(QStringLiteral("INFO wireless discovery stopped"));
        app.quit();
    });
    return app.exec();
}

bool loadWirelessCertificate(const QString &path, QSslCertificate *certificate, QString *error) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) { if (error) *error = file.errorString(); return false; }
    const auto certificates = QSslCertificate::fromDevice(&file, QSsl::Pem);
    if (certificates.isEmpty()) { if (error) *error = QStringLiteral("no PEM certificate found in %1").arg(path); return false; }
    *certificate = certificates.first();
    return true;
}

bool loadWirelessKey(const QString &path, QSslKey *key, QString *error) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) { if (error) *error = file.errorString(); return false; }
    *key = QSslKey(&file, QSsl::Rsa, QSsl::Pem);
    if (key->isNull()) { if (error) *error = QStringLiteral("no readable PEM private key found in %1").arg(path); return false; }
    return true;
}

int runWirelessProfileExport(Output &output, const QString &path, const QString &host, quint16 port,
                             const QString &serverCertificatePath, const QString &fingerprint) {
    QString loadError;
    if (!LocalDrive::WirelessProfile::exportProfile(path, host, port, serverCertificatePath, fingerprint, &loadError)) return fail(output, loadError);
    output.write(QStringLiteral("INFO wireless pairing profile exported path=%1").arg(path));
    return 0;
}

int runWirelessProfileAccept(Output &output, const QString &inputPath, const QString &clientCaPath) {
    QString readError;
    QString deviceId, actual;
    if (!LocalDrive::WirelessProfile::acceptProfile(inputPath, clientCaPath, &deviceId, &actual, &readError)) return fail(output, readError);
    output.write(QStringLiteral("INFO wireless client certificate accepted device=%1 fingerprint=%2 path=%3").arg(deviceId, actual, clientCaPath));
    return 0;
}

int runWirelessReceive(QCoreApplication &app, Output &output, const QString &destination, const QString &certificatePath,
                       const QString &privateKeyPath, const QString &clientCaPath, const QString &clientFingerprint, quint16 port,
                       const QString &catalog) {
    if (!QFileInfo(destination).isDir()) return fail(output, QStringLiteral("wireless-receive needs an existing destination directory"));
    if (!QDir().mkpath(QFileInfo(catalog).absolutePath())) return fail(output, QStringLiteral("could not create catalog directory"));
    const QString identity = VerifiedCopy::liveStorageIdentity(destination);
    if (identity.isEmpty()) return fail(output, QStringLiteral("could not identify destination storage"));
    WirelessReceiver receiver;
    WirelessReceiver::Configuration configuration;
    configuration.port = port;
    configuration.destinationRoot = destination;
    configuration.stagingRoot = QDir(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)).filePath(QStringLiteral("wireless-staging"));
    configuration.catalogPath = catalog;
    configuration.certificatePath = certificatePath;
    configuration.privateKeyPath = privateKeyPath;
    configuration.clientCaPath = clientCaPath;
    configuration.expectedClientFingerprint = clientFingerprint.toLatin1();
    receiver.setFinalizeHandler([&output, &destination, &catalog, identity](const QJsonObject &header, const QString &partialPath, QString *error) {
        const QString relative = QDir::cleanPath(header.value("relative").toString());
        QString sourceRoot = QFileInfo(partialPath).absolutePath();
        const int parentLevels = qMax(0, int(relative.split('/', Qt::SkipEmptyParts).size()) - 1);
        for (int level = 0; level < parentLevels; ++level) sourceRoot = QFileInfo(sourceRoot).absolutePath();
        const QString deviceStableId = header.value("deviceId").toString();
        const QString deviceName = header.value("name").toString();
        const QString deviceDigest = QString::fromLatin1(QCryptographicHash::hash(deviceStableId.toUtf8(), QCryptographicHash::Sha256).toHex().left(16));
        const QString destinationDigest = QString::fromLatin1(QCryptographicHash::hash(destination.toUtf8(), QCryptographicHash::Sha256).toHex().left(16));
        VerifiedCopy::Request request;
        request.sourceRoot = sourceRoot;
        request.destinationRoot = destination;
        request.selectedStorageRoot = destination;
        request.storageIdentity = identity;
        request.filesystemType = QStorageInfo(destination).fileSystemType();
        request.databasePath = catalog;
        request.routeId = QStringLiteral("wireless-route-%1-%2").arg(deviceDigest, destinationDigest);
        request.destinationStorageId = QStringLiteral("wireless-destination-%1").arg(destinationDigest);
        request.sourceStorageId = QStringLiteral("wireless-storage-%1").arg(deviceDigest);
        request.sourceStorageIdentity = deviceStableId;
        request.sourceStorageKind = QStringLiteral("mtp");
        request.sourceStorageLabel = deviceName;
        request.sourceDeviceId = QStringLiteral("wireless-device-%1").arg(deviceDigest);
        request.sourceDeviceStableId = deviceStableId;
        request.sourceDeviceName = deviceName;
        request.sourceDeviceKind = QStringLiteral("Phone");
        request.behavior = QStringLiteral("Copy");
        request.keepPolicy = QStringLiteral("Everything");
        if (relative.isEmpty()) { if (error) *error = QStringLiteral("wireless receipt has no relative path"); return QJsonObject(); }
        VerifiedCopy::Preview preview = VerifiedCopy::inspect(request);
        if (!preview.ok) { if (error) *error = preview.error; return QJsonObject(); }
        if (!QFileInfo::exists(partialPath)) { if (error) *error = QStringLiteral("wireless partial disappeared before verification"); return QJsonObject(); }
        VerifiedCopy engine(catalog);
        QObject::connect(&engine, &VerifiedCopy::progressChanged, [&output](qint64 done, qint64 total, const QString &path) {
            output.write(QStringLiteral("PROGRESS wireless bytes=%1 total=%2 path=%3").arg(done).arg(total).arg(path));
        });
        if (!engine.executeBlocking(request, error)) return QJsonObject();
        return QJsonObject{{"relative", relative}, {"deviceId", deviceStableId}, {"name", deviceName}};
    });
    QString startError;
    if (!receiver.start(configuration, &startError)) return fail(output, startError);
    output.write(QStringLiteral("INFO wireless receiver listening port=%1").arg(receiver.port()));
    QObject::connect(&receiver, &WirelessReceiver::receipt, &app, [&app, &output](const QJsonObject &receipt) {
        output.write(QStringLiteral("RECEIPT wireless path=%1 sha256=%2 size=%3").arg(receipt.value("relative").toString(), receipt.value("sha256").toString()).arg(receipt.value("size").toInteger()));
        QTimer::singleShot(100, &app, [&app] { app.exit(0); });
    });
    QObject::connect(&receiver, &WirelessReceiver::errorMessage, &app, [&output](const QString &message) { output.write(QStringLiteral("ERROR wireless receiver: %1").arg(message)); });
    return app.exec();
}

int runWirelessSend(QCoreApplication &app, Output &output, const QString &sourcePath, const QString &host, quint16 port,
                    const QString &certificatePath, const QString &privateKeyPath, const QString &serverCaPath,
                    const QString &deviceId, const QString &deviceName, const QString &requestedRelative = {}) {
    QFile source(sourcePath);
    if (!source.open(QIODevice::ReadOnly)) return fail(output, source.errorString());
    const qint64 size = source.size();
    QCryptographicHash digest(QCryptographicHash::Sha256);
    while (!source.atEnd()) digest.addData(source.read(1024 * 1024));
    const QString relative = requestedRelative.trimmed().isEmpty() ? QFileInfo(sourcePath).fileName() : QDir::cleanPath(requestedRelative);
    if (relative.isEmpty() || QDir::isAbsolutePath(relative) || relative == QStringLiteral(".") || relative == QStringLiteral("..") || relative.startsWith(QStringLiteral("../")) || relative.contains(QStringLiteral("/../"))) return fail(output, QStringLiteral("wireless sender relative path is unsafe"));
    QSslCertificate localCertificate, serverCa;
    QSslKey privateKey;
    QString loadError;
    if (!loadWirelessCertificate(certificatePath, &localCertificate, &loadError) || !loadWirelessKey(privateKeyPath, &privateKey, &loadError) || !loadWirelessCertificate(serverCaPath, &serverCa, &loadError)) return fail(output, loadError);
    QSslConfiguration ssl = QSslConfiguration::defaultConfiguration();
    ssl.setLocalCertificate(localCertificate); ssl.setPrivateKey(privateKey); ssl.setCaCertificates({serverCa});
    ssl.setPeerVerifyMode(QSslSocket::VerifyPeer); ssl.setProtocol(QSsl::TlsV1_3OrLater);
    QSslSocket socket; socket.setSslConfiguration(ssl);
    QByteArray buffer; qint64 offset = -1, awaitingAck = -1; int exitCode = 1;
    QEventLoop loop; QTimer timeout; timeout.setSingleShot(true); timeout.setInterval(120000);
    const auto failAsync = [&](const QString &message) { if (exitCode == 1) { output.write(QStringLiteral("ERROR wireless sender: %1").arg(message)); exitCode = 2; loop.quit(); } };
    std::function<void()> sendNext;
    sendNext = [&] {
        if (offset < 0 || awaitingAck >= 0 || offset >= size) return;
        if (!source.seek(offset)) { failAsync(source.errorString()); return; }
        const QByteArray chunk = source.read(std::min<qint64>(LocalDrive::WirelessProtocol::MaxPayloadBytes, size - offset));
        if (chunk.isEmpty()) { failAsync(source.errorString().isEmpty() ? QStringLiteral("source read failed") : source.errorString()); return; }
        const qint64 end = offset + chunk.size();
        const QByteArray packet = LocalDrive::WirelessProtocol::encodePacket(QJsonObject{{"type", "chunk"}, {"offset", offset}}, chunk);
        if (socket.write(packet) != packet.size()) { failAsync(socket.errorString()); return; }
        awaitingAck = end;
    };
    QObject::connect(&timeout, &QTimer::timeout, &loop, [&] { failAsync(QStringLiteral("wireless sender timed out")); });
    QObject::connect(&socket, &QSslSocket::encrypted, &loop, [&] {
        timeout.start();
        socket.write(LocalDrive::WirelessProtocol::encodePacket(QJsonObject{{"type", "hello"}, {"protocol", LocalDrive::WirelessProtocol::Version}, {"deviceId", deviceId}, {"name", deviceName}}));
    });
    QObject::connect(&socket, &QSslSocket::readyRead, &loop, [&] {
        buffer.append(socket.readAll());
        for (;;) {
            LocalDrive::WirelessProtocol::Packet packet; QString decodeError;
            const auto decoded = LocalDrive::WirelessProtocol::decodePacket(buffer, &packet, &decodeError);
            if (decoded == LocalDrive::WirelessProtocol::DecodeResult::Incomplete) return;
            if (decoded == LocalDrive::WirelessProtocol::DecodeResult::Invalid) { failAsync(decodeError); return; }
            const QString type = packet.header.value("type").toString();
            if (type == QStringLiteral("hello-ok")) {
                const QByteArray header = LocalDrive::WirelessProtocol::encodePacket(QJsonObject{{"type", "file"}, {"protocol", LocalDrive::WirelessProtocol::Version}, {"deviceId", deviceId}, {"name", deviceName}, {"relative", relative}, {"size", size}, {"sha256", QString::fromLatin1(digest.result().toHex())}, {"mtime", QFileInfo(sourcePath).lastModified().toMSecsSinceEpoch()}});
                socket.write(header);
            } else if (type == QStringLiteral("file-ready")) {
                offset = packet.header.value("offset").toVariant().toLongLong();
                if (offset < 0 || offset > size) { failAsync(QStringLiteral("receiver returned an invalid resume offset")); return; }
                sendNext();
            } else if (type == QStringLiteral("chunk-ack")) {
                const qint64 acknowledged = packet.header.value("offset").toVariant().toLongLong();
                if (acknowledged != awaitingAck) { failAsync(QStringLiteral("receiver acknowledged an unexpected offset")); return; }
                offset = acknowledged; awaitingAck = -1; sendNext();
            } else if (type == QStringLiteral("receipt")) {
                if (packet.header.value("sha256").toString().toLatin1() != digest.result().toHex() || packet.header.value("size").toVariant().toLongLong() != size) { failAsync(QStringLiteral("receiver receipt does not match the source")); return; }
                output.write(QStringLiteral("INFO wireless send completed path=%1 size=%2").arg(relative).arg(size)); exitCode = 0; loop.quit(); return;
            } else if (type == QStringLiteral("error")) { failAsync(packet.header.value("message").toString()); return; }
        }
    });
    QObject::connect(&socket, &QSslSocket::sslErrors, &loop, [&](const QList<QSslError> &errors) { failAsync(errors.isEmpty() ? QStringLiteral("TLS verification failed") : errors.first().errorString()); });
    QObject::connect(&socket, &QSslSocket::errorOccurred, &loop, [&](QAbstractSocket::SocketError) { failAsync(socket.errorString()); });
    QObject::connect(&socket, &QSslSocket::disconnected, &loop, [&] { failAsync(QStringLiteral("wireless receiver disconnected before receipt")); });
    socket.connectToHostEncrypted(host, port);
    const int result = loop.exec();
    Q_UNUSED(result);
    return exitCode;
}

int runVerifiedRemoteDirectory(Output &output, const QUrl &source, const QString &destination, const QString &catalog, qint64 maxItems, qint64 maxBytes, qint64 stagingCapBytes = 0, bool stagingMode = false) {
    if (!source.isValid() || !QFileInfo(destination).isDir()) return fail(output, QStringLiteral("source URL and existing local destination directory are required"));
    if (!QDir().mkpath(QFileInfo(catalog).absolutePath())) return fail(output, QStringLiteral("could not create catalog directory: %1").arg(QFileInfo(catalog).absolutePath()));
    QVector<RemoteInventoryItem> items; QString error;
    if (!collectRemoteDirectory(source, maxItems, maxBytes, items, &error)) return fail(output, error);
    qint64 bytes = 0;
    for (const RemoteInventoryItem &item : items) bytes += item.size;
    output.write(QStringLiteral("PREVIEW %1 files=%2 bytes=%3").arg(stagingMode ? QStringLiteral("verified-stage-dir") : QStringLiteral("verified-import-dir")).arg(items.size()).arg(bytes));
    if (stagingCapBytes < 0) return fail(output, QStringLiteral("staging maximum cannot be negative"));
    if (stagingCapBytes > 0) {
        qint64 used = 0; QString usageError;
        if (!VerifiedCopy::stagingUsage(destination, &used, &usageError)) return fail(output, usageError);
        qint64 incoming = 0;
        for (const RemoteInventoryItem &item : items) {
            const QFileInfo target(QDir(destination).filePath(item.relative));
            if (!target.exists()) incoming += item.size;
        }
        if (used > stagingCapBytes || incoming > stagingCapBytes - used) return fail(output, QStringLiteral("Staging capacity reached; source was not modified"));
        output.write(QStringLiteral("INFO staging occupancy used=%1 incoming=%2 cap=%3").arg(used).arg(incoming).arg(stagingCapBytes));
    }
    VerifiedCopy engine(catalog);
    QObject::connect(&engine, &VerifiedCopy::progressChanged, [&output](qint64 done, qint64 total, const QString &path) {
        output.write(QStringLiteral("PROGRESS bytes=%1 total=%2 path=%3").arg(done).arg(total).arg(path));
    });
    for (const RemoteInventoryItem &item : items) {
        const VerifiedCopy::RemoteRequest request = remoteRequest(item.url, item.relative, destination, item.relative, catalog, QStringLiteral("mtp"), source);
        if (request.storageIdentity.isEmpty()) return fail(output, QStringLiteral("could not identify destination storage"));
        if (!executeRemoteRequest(engine, output, request, &error)) return fail(output, QStringLiteral("batch stopped at %1: %2").arg(item.relative, error));
    }
    output.write(QStringLiteral("INFO verified MTP %1 completed files=%2 bytes=%3").arg(stagingMode ? QStringLiteral("staging") : QStringLiteral("directory import")).arg(items.size()).arg(bytes));
    return 0;
}

} // namespace

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("local-drive-cli"));

    QCommandLineParser parser;
    parser.setApplicationDescription(QStringLiteral("Local Drive keyboard-first transfer utility"));
    parser.addHelpOption();
    const QCommandLineOption logOption({QStringLiteral("l"), QStringLiteral("log-file")},
                                       QStringLiteral("Append live logs to FILE."), QStringLiteral("FILE"));
    const QCommandLineOption catalogOption(QStringLiteral("catalog-file"),
                                            QStringLiteral("SQLite catalog path for verified commands."), QStringLiteral("FILE"));
    const QCommandLineOption stagingOption(QStringLiteral("staging-max-bytes"),
                                            QStringLiteral("Per-job cap for verified local jobs; total on-disk cap for verified-stage-dir."), QStringLiteral("BYTES"));
    parser.addOption(logOption);
    parser.addOption(catalogOption);
    parser.addOption(stagingOption);
    const QCommandLineOption scanItemsOption(QStringLiteral("scan-max-items"), QStringLiteral("Maximum files for mtp-scan (0 means unlimited)."), QStringLiteral("COUNT"), QStringLiteral("100000"));
    const QCommandLineOption scanBytesOption(QStringLiteral("scan-max-bytes"), QStringLiteral("Maximum bytes for mtp-scan (0 means unlimited)."), QStringLiteral("BYTES"), QStringLiteral("68719476736"));
    parser.addOption(scanItemsOption);
    parser.addOption(scanBytesOption);
    parser.addPositionalArgument(QStringLiteral("command"), QStringLiteral("mtp-inventory, mtp-scan, wireless-beacon, wireless-discover, wireless-profile-export, wireless-profile-accept, wireless-receive, wireless-send, copy, verified-import, verified-export, wireless-simulate, verified-import-dir, verified-stage-dir, verified-preview, or verified-copy"));
    parser.addPositionalArgument(QStringLiteral("arguments"), QStringLiteral("Command arguments."));
    if (!parser.parse(app.arguments())) {
        Output output;
        return fail(output, parser.errorText());
    }

    Output output;
    if (parser.isSet(logOption)) {
        output.logFile.setFileName(parser.value(logOption));
        if (!output.logFile.open(QIODevice::WriteOnly | QIODevice::Append | QIODevice::Text))
            return fail(output, QStringLiteral("could not open log file: %1").arg(output.logFile.fileName()));
    }

    const QStringList args = parser.positionalArguments();
    if (args.isEmpty()) {
        parser.showHelp(2);
    }
    const QString command = args.first();
    if (command == QStringLiteral("mtp-inventory")) {
        if (args.size() != 2) return fail(output, QStringLiteral("usage: mtp-inventory URL"));
        const QUrl url = urlFromArgument(args.at(1));
        if (!url.isValid()) return fail(output, QStringLiteral("invalid URL"));
        return runInventory(app, output, url);
    }
    if (command == QStringLiteral("mtp-scan")) {
        if (args.size() != 2) return fail(output, QStringLiteral("usage: mtp-scan URL"));
        const QUrl url = urlFromArgument(args.at(1));
        if (!url.isValid()) return fail(output, QStringLiteral("invalid URL"));
        bool itemsOk = false, bytesOk = false;
        const qint64 maxItems = parser.value(scanItemsOption).toLongLong(&itemsOk);
        const qint64 maxBytes = parser.value(scanBytesOption).toLongLong(&bytesOk);
        if (!itemsOk || !bytesOk) return fail(output, QStringLiteral("scan limits must be integer values"));
        return runRecursiveInventory(app, output, url, maxItems, maxBytes);
    }
    if (command == QStringLiteral("wireless-beacon")) {
        if (args.size() < 3 || args.size() > 4) return fail(output, QStringLiteral("usage: wireless-beacon WIRELESS_ID NAME [ENDPOINT]"));
        return runWirelessBeacon(output, args.at(1), args.at(2), args.size() > 3 ? args.at(3) : QString());
    }
    if (command == QStringLiteral("wireless-discover")) {
        if (args.size() > 2) return fail(output, QStringLiteral("usage: wireless-discover [SECONDS]"));
        bool durationOk = true;
        const int duration = args.size() == 2 ? args.at(1).toInt(&durationOk) : 30;
        if (!durationOk) return fail(output, QStringLiteral("wireless discovery duration must be an integer"));
        return runWirelessDiscover(app, output, duration);
    }
    if (command == QStringLiteral("wireless-profile-export")) {
        if (args.size() != 6) return fail(output, QStringLiteral("usage: wireless-profile-export OUTPUT_JSON HOST PORT SERVER_CERT SERVER_FINGERPRINT"));
        bool portOk = false; const quint16 port = args.at(3).toUShort(&portOk);
        if (!portOk || port == 0) return fail(output, QStringLiteral("wireless profile port must be a valid non-zero integer"));
        return runWirelessProfileExport(output, args.at(1), args.at(2), port, args.at(4), args.at(5));
    }
    if (command == QStringLiteral("wireless-profile-accept")) {
        if (args.size() != 3) return fail(output, QStringLiteral("usage: wireless-profile-accept ANDROID_PAIRING_JSON CLIENT_CERT_OUTPUT"));
        return runWirelessProfileAccept(output, args.at(1), args.at(2));
    }
    if (command == QStringLiteral("wireless-receive")) {
        if (args.size() < 6 || args.size() > 7) return fail(output, QStringLiteral("usage: wireless-receive DESTINATION_DIRECTORY SERVER_CERT SERVER_KEY CLIENT_CA CLIENT_FINGERPRINT [PORT]"));
        bool portOk = true; const quint16 port = args.size() == 7 ? args.at(6).toUShort(&portOk) : 43171;
        if (!portOk || port == 0) return fail(output, QStringLiteral("wireless receiver port must be a valid non-zero integer"));
        const QString destination = localPathFromArgument(args.at(1));
        const QString catalog = parser.value(catalogOption).isEmpty()
            ? QDir(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)).filePath(QStringLiteral("catalog.sqlite"))
            : parser.value(catalogOption);
        return runWirelessReceive(app, output, destination, args.at(2), args.at(3), args.at(4), args.at(5), port, catalog);
    }
    if (command == QStringLiteral("wireless-send")) {
        if (args.size() != 9 && args.size() != 10) return fail(output, QStringLiteral("usage: wireless-send SOURCE_FILE HOST PORT CLIENT_CERT CLIENT_KEY SERVER_CA WIRELESS_ID DEVICE_NAME [RELATIVE_PATH]"));
        bool portOk = false; const quint16 port = args.at(3).toUShort(&portOk);
        if (!portOk || port == 0 || !args.at(7).startsWith(QStringLiteral("wireless:"))) return fail(output, QStringLiteral("wireless sender needs a valid port and wireless: device identity"));
        const QString source = localPathFromArgument(args.at(1));
        if (source.isEmpty()) return fail(output, QStringLiteral("wireless sender source must be a local file"));
        return runWirelessSend(app, output, source, args.at(2), port, args.at(4), args.at(5), args.at(6), args.at(7), args.at(8), args.size() == 10 ? args.at(9) : QString());
    }
    if (command == QStringLiteral("copy")) {
        if (args.size() != 3) return fail(output, QStringLiteral("usage: copy SOURCE DESTINATION_DIRECTORY"));
        const QUrl source = urlFromArgument(args.at(1));
        const QUrl destination = urlFromArgument(args.at(2));
        if (!source.isValid() || !destination.isValid()) return fail(output, QStringLiteral("invalid source or destination URL"));
        return runCopy(app, output, source, destination);
    }
    if (command == QStringLiteral("verified-import")) {
        if (args.size() != 3) return fail(output, QStringLiteral("usage: verified-import MTP_FILE_URL DESTINATION_DIRECTORY"));
        const QUrl source = urlFromArgument(args.at(1));
        const QString destination = localPathFromArgument(args.at(2));
        if (!source.isValid() || destination.isEmpty()) return fail(output, QStringLiteral("invalid source or destination"));
        const QString catalog = parser.value(catalogOption).isEmpty()
            ? QDir(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)).filePath(QStringLiteral("catalog.sqlite"))
            : parser.value(catalogOption);
        return runVerifiedRemote(output, source, destination, catalog);
    }
    if (command == QStringLiteral("verified-export")) {
        if (args.size() != 3) return fail(output, QStringLiteral("usage: verified-export SOURCE_FILE MTP_DESTINATION_FILE_URL"));
        const QString source = localPathFromArgument(args.at(1)); const QUrl destination = urlFromArgument(args.at(2));
        const QString catalog = parser.value(catalogOption).isEmpty() ? QDir(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)).filePath(QStringLiteral("catalog.sqlite")) : parser.value(catalogOption);
        return runVerifiedExport(output, source, destination, catalog);
    }
    if (command == QStringLiteral("wireless-simulate")) {
        if (args.size() != 3) return fail(output, QStringLiteral("usage: wireless-simulate SOURCE_FILE_URL DESTINATION_DIRECTORY"));
        const QUrl source = urlFromArgument(args.at(1));
        const QString destination = localPathFromArgument(args.at(2));
        if (!source.isValid() || destination.isEmpty()) return fail(output, QStringLiteral("invalid source or destination"));
        const QString catalog = parser.value(catalogOption).isEmpty()
            ? QDir(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)).filePath(QStringLiteral("catalog.sqlite"))
            : parser.value(catalogOption);
        return runVerifiedRemote(output, source, destination, catalog, QStringLiteral("wireless"));
    }
    if (command == QStringLiteral("verified-import-dir")) {
        if (args.size() != 3) return fail(output, QStringLiteral("usage: verified-import-dir MTP_DIRECTORY_URL DESTINATION_DIRECTORY"));
        const QUrl source = urlFromArgument(args.at(1));
        const QString destination = localPathFromArgument(args.at(2));
        if (!source.isValid() || destination.isEmpty()) return fail(output, QStringLiteral("invalid source or destination"));
        bool itemsOk = false, bytesOk = false;
        const qint64 maxItems = parser.value(scanItemsOption).toLongLong(&itemsOk);
        const qint64 maxBytes = parser.value(scanBytesOption).toLongLong(&bytesOk);
        if (!itemsOk || !bytesOk) return fail(output, QStringLiteral("scan limits must be integer values"));
        const QString catalog = parser.value(catalogOption).isEmpty()
            ? QDir(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)).filePath(QStringLiteral("catalog.sqlite"))
            : parser.value(catalogOption);
        return runVerifiedRemoteDirectory(output, source, destination, catalog, maxItems, maxBytes);
    }
    if (command == QStringLiteral("verified-stage-dir")) {
        if (args.size() != 3) return fail(output, QStringLiteral("usage: verified-stage-dir MTP_DIRECTORY_URL STAGING_DIRECTORY"));
        const QUrl source = urlFromArgument(args.at(1));
        const QString destination = localPathFromArgument(args.at(2));
        if (!source.isValid() || destination.isEmpty()) return fail(output, QStringLiteral("invalid source or staging destination"));
        bool itemsOk = false, bytesOk = false, stagingOk = false;
        const qint64 maxItems = parser.value(scanItemsOption).toLongLong(&itemsOk);
        const qint64 maxBytes = parser.value(scanBytesOption).toLongLong(&bytesOk);
        const qint64 stagingCap = parser.value(stagingOption).isEmpty() ? 0 : parser.value(stagingOption).toLongLong(&stagingOk);
        if (!itemsOk || !bytesOk || (!parser.value(stagingOption).isEmpty() && !stagingOk)) return fail(output, QStringLiteral("scan and staging limits must be integer values"));
        const QString catalog = parser.value(catalogOption).isEmpty()
            ? QDir(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)).filePath(QStringLiteral("catalog.sqlite"))
            : parser.value(catalogOption);
        return runVerifiedRemoteDirectory(output, source, destination, catalog, maxItems, maxBytes, stagingCap, true);
    }
    if (command == QStringLiteral("verified-preview") || command == QStringLiteral("verified-copy")) {
        if (args.size() != 3) return fail(output, QStringLiteral("usage: %1 SOURCE_DIRECTORY DESTINATION_DIRECTORY").arg(command));
        const QString source = localPathFromArgument(args.at(1));
        const QString destination = localPathFromArgument(args.at(2));
        if (source.isEmpty() || destination.isEmpty()) return fail(output, QStringLiteral("verified commands require local paths or file URLs"));
        const QString catalog = parser.value(catalogOption).isEmpty()
            ? QDir(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)).filePath(QStringLiteral("catalog.sqlite"))
            : parser.value(catalogOption);
        bool parsed = false;
        const qint64 stagingMaxBytes = parser.value(stagingOption).isEmpty() ? 0 : parser.value(stagingOption).toLongLong(&parsed);
        if (!parser.value(stagingOption).isEmpty() && !parsed) return fail(output, QStringLiteral("staging maximum must be an integer byte count"));
        return runVerifiedLocal(app, output, command, source, destination, catalog, stagingMaxBytes);
    }
    return fail(output, QStringLiteral("unknown command: %1").arg(command));
}
