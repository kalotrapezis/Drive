#include "wirelessreceivercontroller.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonObject>
#include <QJsonDocument>
#include <QStorageInfo>
#include <QStandardPaths>
#include <QSettings>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QUuid>


#include "verifiedcopy.h"
#include "setupmodel.h"
#include "wirelessprofile.h"

namespace {
QString normalizedFingerprint(QString value) {
    return value.remove(QLatin1Char(':')).remove(QLatin1Char(' ')).toLower();
}
}

WirelessReceiverController::WirelessReceiverController(const QString &databasePath, SetupModel *setupModel, QObject *parent)
    : QObject(parent), m_databasePath(databasePath), m_setupModel(setupModel), m_receiver(this) {
    m_catalog = databasePath;
    QSettings settings(QStringLiteral("LocalDrive"), QStringLiteral("LocalDrive"));
    m_savedDestination = settings.value(QStringLiteral("wireless/destination")).toString();
    m_savedHost = settings.value(QStringLiteral("wireless/host"), QStringLiteral("127.0.0.1")).toString();
    m_savedCertificate = settings.value(QStringLiteral("wireless/certificate")).toString();
    m_savedPrivateKey = settings.value(QStringLiteral("wireless/privateKey")).toString();
    m_savedClientCa = settings.value(QStringLiteral("wireless/clientCa")).toString();
    m_savedFingerprint = settings.value(QStringLiteral("wireless/fingerprint")).toString();
    const uint savedPort = settings.value(QStringLiteral("wireless/port"), 43171u).toUInt();
    m_savedPort = savedPort <= 65535u ? static_cast<quint16>(savedPort) : 0;
    m_savedEnabled = settings.value(QStringLiteral("wireless/enabled"), false).toBool();
    m_receiver.setFinalizeHandler([this](const QJsonObject &header, const QString &partialPath, QString *error) {
        return finalize(header, partialPath, error);
    });
    connect(&m_receiver, &WirelessReceiver::receipt, this, [this](const QJsonObject &receipt) {
        m_status = QStringLiteral("Received %1 (%2 bytes)").arg(receipt.value("relative").toString()).arg(receipt.value("size").toInteger());
        log(QStringLiteral("RECEIPT %1 sha256=%2").arg(receipt.value("relative").toString(), receipt.value("sha256").toString()));
        emit changed();
    });
    connect(&m_receiver, &WirelessReceiver::deviceObserved, this, [this](const QString &stableIdentity, const QString &label) {
        if (m_setupModel) m_setupModel->observeWirelessTransfer(stableIdentity, label);
        log(QStringLiteral("INFO authenticated wireless device=%1 name=%2").arg(stableIdentity, label));
        emit changed();
    });
    connect(&m_receiver, &WirelessReceiver::errorMessage, this, [this](const QString &message) {
        m_status = QStringLiteral("Error");
        log(QStringLiteral("ERROR wireless receiver: %1").arg(message));
        emit changed();
    });
}

bool WirelessReceiverController::start(const QString &destination, const QString &certificate, const QString &privateKey,
                                        const QString &clientCa, const QString &clientFingerprint, quint16 port) {
    if (m_receiver.listening()) return false;
    const QString root = QFileInfo(destination).canonicalFilePath();
    const QString fingerprint = normalizedFingerprint(clientFingerprint);
    if (root.isEmpty() || !QFileInfo(root).isDir() || certificate.trimmed().isEmpty() || privateKey.trimmed().isEmpty()
        || clientCa.trimmed().isEmpty() || fingerprint.size() != 64 || QByteArray::fromHex(fingerprint.toLatin1()).size() != 32 || port == 0) {
        m_status = QStringLiteral("Invalid receiver configuration");
        log(QStringLiteral("ERROR receiver configuration is incomplete or unsafe"));
        emit changed();
        return false;
    }
    WirelessReceiver::Configuration configuration;
    configuration.port = port;
    configuration.destinationRoot = root;
    configuration.stagingRoot = QDir(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation)).filePath(QStringLiteral("wireless-staging"));
    configuration.catalogPath = m_catalog;
    configuration.certificatePath = certificate;
    configuration.privateKeyPath = privateKey;
    configuration.clientCaPath = clientCa;
    configuration.expectedClientFingerprint = fingerprint.toLatin1();
    QString error;
    if (!m_receiver.start(configuration, &error)) {
        m_status = QStringLiteral("Start failed");
        log(QStringLiteral("ERROR %1").arg(error));
        emit changed();
        return false;
    }
    m_destination = root;
    saveConfiguration(root, certificate, privateKey, clientCa, fingerprint, port);
    m_status = QStringLiteral("Listening on port %1").arg(m_receiver.port());
    log(QStringLiteral("INFO wireless receiver listening port=%1 destination=%2").arg(m_receiver.port()).arg(root));
    emit changed();
    return true;
}

bool WirelessReceiverController::startSaved() {
    if (!m_savedEnabled || m_savedDestination.isEmpty() || m_savedPort == 0) return false;
    return start(m_savedDestination, m_savedCertificate, m_savedPrivateKey, m_savedClientCa, m_savedFingerprint, m_savedPort);
}

void WirelessReceiverController::stop() {
    const bool wasListening = m_receiver.listening();
    if (wasListening) m_receiver.stop();
    if (!m_savedEnabled && !wasListening) return;
    QSettings settings(QStringLiteral("LocalDrive"), QStringLiteral("LocalDrive"));
    settings.setValue(QStringLiteral("wireless/enabled"), false);
    settings.sync();
    m_savedEnabled = false;
    m_status = QStringLiteral("Stopped");
    if (wasListening) log(QStringLiteral("INFO wireless receiver stopped"));
    emit changed();
}

bool WirelessReceiverController::exportProfile(const QString &path, const QString &host, quint16 port,
                                                const QString &serverCertificate) {
    QFile certificate(serverCertificate);
    QString error;
    if (!certificate.open(QIODevice::ReadOnly | QIODevice::Text)) {
        error = certificate.errorString();
    } else {
        const QString fingerprint = LocalDrive::WirelessProfile::certificateFingerprint(certificate.readAll(), &error);
        if (!fingerprint.isEmpty() && LocalDrive::WirelessProfile::exportProfile(path, host, port, serverCertificate, fingerprint, &error)) {
            QSettings settings(QStringLiteral("LocalDrive"), QStringLiteral("LocalDrive"));
            settings.setValue(QStringLiteral("wireless/host"), host.trimmed());
            settings.sync();
            m_savedHost = host.trimmed();
            m_status = QStringLiteral("Pairing profile exported");
            log(QStringLiteral("INFO wireless pairing profile exported path=%1").arg(path));
            emit changed();
            return true;
        }
    }
    m_status = QStringLiteral("Profile export failed");
    log(QStringLiteral("ERROR profile export: %1").arg(error));
    emit changed();
    return false;
}

QString WirelessReceiverController::acceptPairingProfile(const QString &inputPath, const QString &clientCertificate) {
    QString error, deviceId, fingerprint;
    if (!LocalDrive::WirelessProfile::acceptProfile(inputPath, clientCertificate, &deviceId, &fingerprint, &error)) {
        m_status = QStringLiteral("Profile import failed");
        log(QStringLiteral("ERROR profile import: %1").arg(error));
        emit changed();
        return {};
    }
    m_status = QStringLiteral("Android certificate accepted");
    log(QStringLiteral("INFO Android certificate accepted device=%1 fingerprint=%2").arg(deviceId, fingerprint));
    emit changed();
    return fingerprint;
}

void WirelessReceiverController::saveConfiguration(const QString &destination, const QString &certificate, const QString &privateKey,
                                                   const QString &clientCa, const QString &fingerprint, quint16 port) {
    QSettings settings(QStringLiteral("LocalDrive"), QStringLiteral("LocalDrive"));
    settings.setValue(QStringLiteral("wireless/destination"), destination);
    settings.setValue(QStringLiteral("wireless/certificate"), certificate);
    settings.setValue(QStringLiteral("wireless/privateKey"), privateKey);
    settings.setValue(QStringLiteral("wireless/clientCa"), clientCa);
    settings.setValue(QStringLiteral("wireless/fingerprint"), fingerprint);
    settings.setValue(QStringLiteral("wireless/port"), port);
    settings.setValue(QStringLiteral("wireless/enabled"), true);
    settings.sync();
    m_savedDestination = destination;
    m_savedCertificate = certificate;
    m_savedPrivateKey = privateKey;
    m_savedClientCa = clientCa;
    m_savedFingerprint = fingerprint;
    m_savedPort = port;
    m_savedEnabled = true;
}

void WirelessReceiverController::log(const QString &message) {
    m_logEntries.append(message);
    while (m_logEntries.size() > 100) m_logEntries.removeFirst();
}

QJsonObject WirelessReceiverController::finalize(const QJsonObject &header, const QString &partialPath, QString *error) {
    const QString relative = QDir::cleanPath(header.value(QStringLiteral("relative")).toString());
    const QString deviceStableId = header.value(QStringLiteral("deviceId")).toString();
    const QString deviceName = header.value(QStringLiteral("name")).toString();
    if (relative.isEmpty() || !deviceStableId.startsWith(QStringLiteral("wireless:")) || deviceName.trimmed().isEmpty()) {
        if (error) *error = QStringLiteral("wireless receipt metadata is invalid");
        return {};
    }
    const QString deviceDigest = QString::fromLatin1(QCryptographicHash::hash(deviceStableId.toUtf8(), QCryptographicHash::Sha256).toHex().left(16));
    const QString destinationDigest = QString::fromLatin1(QCryptographicHash::hash(m_destination.toUtf8(), QCryptographicHash::Sha256).toHex().left(16));
    VerifiedCopy::Request request;
    QString sourceRoot = QFileInfo(partialPath).absolutePath();
    const int parentLevels = qMax(0, int(relative.split('/', Qt::SkipEmptyParts).size()) - 1);
    for (int level = 0; level < parentLevels; ++level) sourceRoot = QFileInfo(sourceRoot).absolutePath();
    request.sourceRoot = sourceRoot;
    request.destinationRoot = m_destination;
    request.selectedStorageRoot = m_destination;
    request.storageIdentity = VerifiedCopy::liveStorageIdentity(m_destination);
    request.filesystemType = QStorageInfo(m_destination).fileSystemType();
    request.databasePath = m_catalog;
    request.routeId = QStringLiteral("wireless-route-%1-%2").arg(deviceDigest, destinationDigest);
    request.destinationStorageId = QStringLiteral("wireless-destination-%1").arg(destinationDigest);
    request.sourceStorageId = QStringLiteral("wireless-storage-%1").arg(deviceDigest);
    request.sourceStorageIdentity = deviceStableId;
    // The catalog storage enum still uses the phone's physical MTP-like root;
    // the stable wireless identity records the actual transport as "wireless".
    request.sourceStorageKind = QStringLiteral("mtp");
    request.sourceStorageLabel = deviceName;
    request.sourceDeviceId = QStringLiteral("wireless-device-%1").arg(deviceDigest);
    request.sourceDeviceStableId = deviceStableId;
    request.sourceDeviceName = deviceName;
    request.sourceDeviceKind = QStringLiteral("Phone");
    request.behavior = QStringLiteral("Copy");
    request.keepPolicy = QStringLiteral("Everything");
    if (request.storageIdentity.isEmpty()) { if (error) *error = QStringLiteral("destination storage identity is unavailable"); return {}; }
    const auto preview = VerifiedCopy::inspect(request);
    if (!preview.ok) { if (error) *error = preview.error; return {}; }
    if (!QFileInfo::exists(partialPath)) { if (error) *error = QStringLiteral("wireless partial disappeared before verification"); return {}; }
    log(QStringLiteral("INFO finalizing %1 from %2").arg(relative, deviceName));
    VerifiedCopy engine(m_catalog);
    QObject::connect(&engine, &VerifiedCopy::progressChanged, this, [this](qint64 done, qint64 total, const QString &path) {
        log(QStringLiteral("PROGRESS wireless bytes=%1 total=%2 path=%3").arg(done).arg(total).arg(path));
    });
    if (!engine.executeBlocking(request, error)) return {};
    const QString wireHash = header.value(QStringLiteral("sha256")).toString().toLower();
    const QStringList parts = relative.split('/', Qt::SkipEmptyParts);
    const QString metadataRoot = parts.isEmpty() ? QString() : parts.first() == QStringLiteral("Drive") ? QStringLiteral("Drive") : parts.first() == QStringLiteral("Photos") ? QStringLiteral("DCIM") : QString();
    const QString metadataRelative = parts.mid(1).join('/');
    if (!metadataRoot.isEmpty() && !metadataRelative.isEmpty()) {
        const QString connection = QStringLiteral("wireless-metadata-receipt-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
        QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(m_catalog);
        if (!db.open() || !db.transaction()) { if (error) *error = db.lastError().text(); db = {}; QSqlDatabase::removeDatabase(connection); return {}; }
        QSqlQuery update(db); bool sizeMismatch = false; QString itemId;
        update.prepare("SELECT item_id,size_bytes FROM pending_metadata WHERE origin_device_id=(SELECT id FROM devices WHERE stable_id=?) AND source_root=? AND relative_path=?"); update.addBindValue(deviceStableId); update.addBindValue(metadataRoot); update.addBindValue(metadataRelative);
        if (!update.exec()) { db.rollback(); if (error) *error = update.lastError().text(); db.close(); db = {}; QSqlDatabase::removeDatabase(connection); return {}; }
        const qint64 receivedSize = header.value(QStringLiteral("size")).toVariant().toLongLong();
        if (update.next()) { itemId = update.value(0).toString(); sizeMismatch = update.value(1).toLongLong() != receivedSize; }
        update.prepare("UPDATE pending_metadata SET content_sha256=?,state=CASE WHEN size_bytes=? THEN 'complete' ELSE 'review' END,size_bytes=?,updated_at=CURRENT_TIMESTAMP WHERE origin_device_id=(SELECT id FROM devices WHERE stable_id=?) AND source_root=? AND relative_path=?");
        update.addBindValue(wireHash); update.addBindValue(receivedSize); update.addBindValue(receivedSize); update.addBindValue(deviceStableId); update.addBindValue(metadataRoot); update.addBindValue(metadataRelative);
        if (!update.exec()) { db.rollback(); if (error) *error = update.lastError().text(); db.close(); db = {}; QSqlDatabase::removeDatabase(connection); return {}; }
        if (sizeMismatch) {
            const QString sourceId = QString::fromLatin1(QCryptographicHash::hash((deviceStableId + '\n' + metadataRoot + '\n' + metadataRelative + '\n' + QString::number(receivedSize) + '\n' + wireHash).toUtf8(), QCryptographicHash::Sha256).toHex());
            const QJsonObject details{{"deviceStableId", deviceStableId}, {"root", metadataRoot}, {"path", metadataRelative}, {"expectedSize", receivedSize}, {"expectedSha256", wireHash}, {"itemId", itemId}};
            update.prepare("INSERT INTO review_items(id,category,source_kind,source_id,title,summary,details_json,item_count,state) VALUES(?, 'External changes','metadata',?,'Phone item changed before transfer','The transferred bytes were verified, but the metadata preflight size had changed. Recheck the current phone location before any correction.',?,1,'needs_decision') ON CONFLICT(source_kind,source_id,category) DO UPDATE SET summary=excluded.summary,details_json=excluded.details_json,updated_at=CURRENT_TIMESTAMP");
            update.addBindValue(QStringLiteral("review-%1").arg(sourceId)); update.addBindValue(sourceId); update.addBindValue(QString::fromUtf8(QJsonDocument(details).toJson(QJsonDocument::Compact)));
            if (!update.exec()) { db.rollback(); if (error) *error = update.lastError().text(); db.close(); db = {}; QSqlDatabase::removeDatabase(connection); return {}; }
        }
        if (!db.commit()) { db.rollback(); if (error) *error = db.lastError().text(); db.close(); db = {}; QSqlDatabase::removeDatabase(connection); return {}; }
        db.close(); db = {}; QSqlDatabase::removeDatabase(connection);
    }
    return QJsonObject{{QStringLiteral("relative"), relative}, {QStringLiteral("deviceId"), deviceStableId}, {QStringLiteral("name"), deviceName}};
}
