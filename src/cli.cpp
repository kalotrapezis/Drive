#include <QCommandLineOption>
#include <QCommandLineParser>
#include <QCryptographicHash>
#include <QCoreApplication>
#include <QDir>
#include <QDirIterator>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QStorageInfo>
#include <QStandardPaths>
#include <QTextStream>
#include <QUrl>

#include <memory>

#include <KIO/CopyJob>
#include <KIO/ListJob>

#include "verifiedcopy.h"
#include "remoteinventory.h"

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

bool stagingUsage(const QString &root, qint64 *bytes, QString *error) {
    qint64 total = 0;
    QDirIterator iterator(root, QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot, QDirIterator::Subdirectories);
    while (iterator.hasNext()) {
        iterator.next();
        const QFileInfo info = iterator.fileInfo();
        if (info.isSymLink()) { if (error) *error = "staging root contains a symlink"; return false; }
        if (info.isFile()) total += info.size();
    }
    if (bytes) *bytes = total;
    return true;
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

VerifiedCopy::RemoteRequest remoteRequest(const QUrl &source, const QString &sourceRelative, const QString &destination, const QString &destinationRelative, const QString &catalog, const QString &transport = QStringLiteral("mtp")) {
    const QString sourceKey = source.toString(QUrl::FullyEncoded);
    const QString sourceDigest = QString::fromLatin1(QCryptographicHash::hash(sourceKey.toUtf8(), QCryptographicHash::Sha256).toHex());
    const QString destinationDigest = QString::fromLatin1(QCryptographicHash::hash(destination.toUtf8(), QCryptographicHash::Sha256).toHex());
    VerifiedCopy::RemoteRequest request;
    request.sourceUrl = source;
    request.sourceRelative = sourceRelative;
    request.destinationRoot = destination;
    request.destinationRelative = destinationRelative;
    request.selectedStorageRoot = destination;
    request.storageIdentity = VerifiedCopy::liveStorageIdentity(destination);
    request.filesystemType = QStorageInfo(destination).fileSystemType();
    request.databasePath = catalog;
    request.routeId = QStringLiteral("%1-route-%2").arg(transport, sourceDigest.left(16) + QStringLiteral("-") + destinationDigest.left(16));
    request.destinationStorageId = QStringLiteral("cli-%1").arg(destinationDigest.left(16));
    request.sourceStorageIdentity = QStringLiteral("%1:%2").arg(transport, sourceDigest);
    request.sourceStorageId = QStringLiteral("%1-%2").arg(transport, sourceDigest.left(16));
    request.sourceDeviceStableId = QStringLiteral("%1-device:%2").arg(transport, sourceDigest);
    request.sourceDeviceId = QStringLiteral("%1-device-%2").arg(transport, sourceDigest.left(16));
    request.sourceDeviceName = transport == QStringLiteral("wireless") ? QStringLiteral("Wireless simulation") : QStringLiteral("MTP source");
    request.sourceStorageLabel = request.sourceDeviceName;
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
        if (!stagingUsage(destination, &used, &usageError)) return fail(output, usageError);
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
        const VerifiedCopy::RemoteRequest request = remoteRequest(item.url, item.relative, destination, item.relative, catalog);
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
    parser.addPositionalArgument(QStringLiteral("command"), QStringLiteral("mtp-inventory, mtp-scan, copy, verified-import, wireless-simulate, verified-import-dir, verified-stage-dir, verified-preview, or verified-copy"));
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
