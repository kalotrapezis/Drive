#pragma once

#include <QObject>
#include <QPointer>
#include <QVariantList>
#include <QUrl>

#include "wirelessprotocol.h"

namespace KIO { class ListJob; }

class SetupModel final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantList storages READ storages NOTIFY changed)
    Q_PROPERTY(QVariantList routes READ routes NOTIFY changed)
    Q_PROPERTY(QVariantList mtpDevices READ mtpDevices NOTIFY changed)
    Q_PROPERTY(QVariantList wirelessDevices READ wirelessDevices NOTIFY changed)
    Q_PROPERTY(QVariantList connectedDevices READ connectedDevices NOTIFY changed)
    Q_PROPERTY(QVariantList deviceList READ deviceList NOTIFY changed)
    Q_PROPERTY(QVariantList firstSeenDevices READ firstSeenDevices NOTIFY changed)
    Q_PROPERTY(QVariantList hiddenDevices READ hiddenDevices NOTIFY changed)
    Q_PROPERTY(QString mtpDeviceLabel READ mtpDeviceLabel NOTIFY changed)
    Q_PROPERTY(int configRevision READ configRevision NOTIFY changed)
    Q_PROPERTY(bool ready READ ready NOTIFY changed)
    Q_PROPERTY(QString errorMessage READ errorMessage NOTIFY changed)
    Q_PROPERTY(QString localDeviceName READ localDeviceName NOTIFY changed)
public:
    static constexpr quint16 wirelessDiscoveryPort() { return LocalDrive::WirelessProtocol::DiscoveryPort; }
    explicit SetupModel(const QString &databasePath = {}, const QVariantList &storageOverride = {}, QObject *parent = nullptr);
    ~SetupModel() override;

    QVariantList storages() const { return m_storages; }
    QVariantList routes() const { return m_routes; }
    QVariantList mtpDevices() const { return m_mtpDevices; }
    QVariantList wirelessDevices() const { return m_wirelessDevices; }
    QVariantList connectedDevices() const;
    QVariantList deviceList() const { return m_deviceList; }
    QVariantList firstSeenDevices() const { return m_firstSeenDevices; }
    QVariantList hiddenDevices() const { return m_hiddenDevices; }
    QString mtpDeviceLabel() const { const auto devices = connectedDevices(); return devices.isEmpty() ? QString() : devices.first().toMap().value("label").toString(); }
    int configRevision() const { return m_revision; }
    bool ready() const { return m_ready; }
    QString errorMessage() const { return m_error; }
    QString localDeviceName() const { return m_localDeviceName; }
    QString databasePath() const { return m_databasePath; }
    Q_INVOKABLE bool saveRoute(const QString &source, const QString &storageId, const QString &destination, const QString &keepPolicy = QStringLiteral("Everything"), qint64 minimumFreeBytes = 0, bool organizePhotos = false, qint64 stagingMaxBytes = 0, const QString &stagingRoot = {}, const QString &contentType = QStringLiteral("Drive"));
    Q_INVOKABLE void refreshRoutes();
    Q_INVOKABLE void refreshStorages();
    Q_INVOKABLE void refreshMtpDevices();
    Q_INVOKABLE bool startWirelessDiscovery();
    Q_INVOKABLE void stopWirelessDiscovery();
    Q_INVOKABLE bool ingestWirelessBeacon(const QVariantMap &beacon);
    Q_INVOKABLE bool observeWirelessTransfer(const QString &stableIdentity, const QString &label);
    Q_INVOKABLE bool pairWirelessDevice(const QString &wirelessDeviceId, const QString &targetDeviceId);
    Q_INVOKABLE bool acknowledgeDevice(const QString &deviceId, bool hide);
    Q_INVOKABLE bool showDevice(const QString &deviceId);
    Q_INVOKABLE QString pathFromUrl(const QUrl &url) const { return url.toLocalFile(); }
#ifdef LOCAL_DRIVE_TESTING
    void setMtpDevicesForTest(const QVariantList &devices);
    void setWirelessDevicesForTest(const QVariantList &devices);
#endif

signals:
    void changed();

private:
    bool openCatalog();
    bool fail(const QString &message);
    void loadRoutes();
    void loadDeviceLists();
    void expireWirelessDevices();
    QString upsertDiscoveredPhone(const QString &alias, const QString &name, const QString &transport, const QString &preferredDeviceId = {});
    QVariantList m_mtpDevices;
    QVariantList m_wirelessDevices;
    QPointer<KIO::ListJob> m_mtpJob;
    class QUdpSocket *m_wirelessSocket = nullptr;
    class QTimer *m_wirelessExpiryTimer = nullptr;
    QString m_databasePath, m_connectionName, m_error;
    QVariantList m_storages, m_routes, m_firstSeenDevices, m_hiddenDevices;
    QVariantList m_deviceList;
    int m_revision = 0;
    bool m_ready = false;
    QString m_localDeviceName;
};
