#include "wirelessreceivercontroller.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFileInfo>
#include <QJsonObject>
#include <QStorageInfo>
#include <QStandardPaths>


#include "verifiedcopy.h"
#include "setupmodel.h"

namespace {
QString normalizedFingerprint(QString value) {
    return value.remove(QLatin1Char(':')).remove(QLatin1Char(' ')).toLower();
}
}

WirelessReceiverController::WirelessReceiverController(const QString &databasePath, SetupModel *setupModel, QObject *parent)
    : QObject(parent), m_databasePath(databasePath), m_setupModel(setupModel), m_receiver(this) {
    m_catalog = databasePath;
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
    m_status = QStringLiteral("Listening on port %1").arg(m_receiver.port());
    log(QStringLiteral("INFO wireless receiver listening port=%1 destination=%2").arg(m_receiver.port()).arg(root));
    emit changed();
    return true;
}

void WirelessReceiverController::stop() {
    if (!m_receiver.listening()) return;
    m_receiver.stop();
    m_status = QStringLiteral("Stopped");
    log(QStringLiteral("INFO wireless receiver stopped"));
    emit changed();
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
    return QJsonObject{{QStringLiteral("relative"), relative}, {QStringLiteral("deviceId"), deviceStableId}, {QStringLiteral("name"), deviceName}};
}
