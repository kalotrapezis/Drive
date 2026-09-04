#pragma once

#include <QObject>
#include <QDir>
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
    Q_PROPERTY(bool hubEnabled READ hubEnabled NOTIFY changed)
    Q_PROPERTY(int hubLimitPercent READ hubLimitPercent NOTIFY changed)
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
    QString homeRoot() const { return m_homeRoot; }
    bool hubEnabled() const { return m_hubEnabled; }
    int hubLimitPercent() const { return m_hubLimitPercent; }
    QString hubRoot() const { return QDir(m_homeRoot).filePath(QStringLiteral("Local Drive/.incoming")); }
    QString databasePath() const { return m_databasePath; }
    Q_INVOKABLE bool saveRoute(const QString &source, const QString &storageId, const QString &destination, const QString &keepPolicy = QStringLiteral("Everything"), qint64 minimumFreeBytes = 0, bool organizePhotos = false, qint64 stagingMaxBytes = 0, const QString &stagingRoot = {}, const QString &contentType = QStringLiteral("Drive"));
    Q_INVOKABLE bool saveInitialRoutes(const QString &source, const QString &storageId, const QString &destinationParent, const QString &keepPolicy = QStringLiteral("Everything"), qint64 minimumFreeBytes = 0, bool organizePhotos = false, qint64 stagingMaxBytes = 0, const QString &stagingRoot = {});
    Q_INVOKABLE bool updateRouteRelationship(const QString &routeId, bool send, bool receive, bool keep);
    Q_INVOKABLE bool updateRouteCard(const QString &routeId, const QString &mode, const QString &keepPolicy, bool cache);
    Q_INVOKABLE bool cloneDriveMapToPhotos();
    Q_INVOKABLE void refreshRoutes();
    Q_INVOKABLE void refreshStorages();
    Q_INVOKABLE bool mountStorage(const QString &storageId);
    Q_INVOKABLE void refreshMtpDevices();
    Q_INVOKABLE bool startWirelessDiscovery();
    Q_INVOKABLE void stopWirelessDiscovery();
    Q_INVOKABLE bool ingestWirelessBeacon(const QVariantMap &beacon);
    Q_INVOKABLE bool observeWirelessTransfer(const QString &stableIdentity, const QString &label);
    Q_INVOKABLE bool pairWirelessDevice(const QString &wirelessDeviceId, const QString &targetDeviceId);
    Q_INVOKABLE bool acknowledgeDevice(const QString &deviceId, bool hide);
    Q_INVOKABLE bool showDevice(const QString &deviceId);
    Q_INVOKABLE bool setHubConfig(bool enabled, int limitPercent);
    Q_INVOKABLE QString pathFromUrl(const QUrl &url) const { return url.toLocalFile(); }
#ifdef LOCAL_DRIVE_TESTING
    void setMtpDevicesForTest(const QVariantList &devices);
    void setWirelessDevicesForTest(const QVariantList &devices);
    void setUsbConnectionsForTest(const QVariantList &devices) { m_usbConnections = devices; loadDeviceLists(); emit changed(); }
    void setHomeRootForTest(const QString &path) { m_homeRoot = QDir::cleanPath(path); }
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
    void refreshUsbConnections();
    QVariantList m_mtpDevices;
    QVariantList m_wirelessDevices;
    QVariantList m_usbConnections;
    QPointer<KIO::ListJob> m_mtpJob;
    class QUdpSocket *m_wirelessSocket = nullptr;
    class QTimer *m_wirelessExpiryTimer = nullptr;
    QString m_databasePath, m_connectionName, m_error, m_homeRoot = QDir::homePath();
    QVariantList m_storages, m_routes, m_firstSeenDevices, m_hiddenDevices;
    QVariantList m_deviceList;
    int m_revision = 0;
    bool m_ready = false;
    bool m_hubEnabled = false;
    int m_hubLimitPercent = 80;
    QString m_localDeviceName;
};
