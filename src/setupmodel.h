#pragma once

#include <QObject>
#include <QVariantList>
#include <QUrl>

class SetupModel final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantList storages READ storages NOTIFY changed)
    Q_PROPERTY(QVariantList routes READ routes NOTIFY changed)
    Q_PROPERTY(int configRevision READ configRevision NOTIFY changed)
    Q_PROPERTY(bool ready READ ready NOTIFY changed)
    Q_PROPERTY(QString errorMessage READ errorMessage NOTIFY changed)
    Q_PROPERTY(QString localDeviceName READ localDeviceName NOTIFY changed)
public:
    explicit SetupModel(const QString &databasePath = {}, const QVariantList &storageOverride = {}, QObject *parent = nullptr);
    ~SetupModel() override;

    QVariantList storages() const { return m_storages; }
    QVariantList routes() const { return m_routes; }
    int configRevision() const { return m_revision; }
    bool ready() const { return m_ready; }
    QString errorMessage() const { return m_error; }
    QString localDeviceName() const { return m_localDeviceName; }
    Q_INVOKABLE bool saveRoute(const QString &source, const QString &storageId, const QString &destination, const QString &behavior = QStringLiteral("Copy"));
    Q_INVOKABLE void refreshStorages();
    Q_INVOKABLE QString pathFromUrl(const QUrl &url) const { return url.toLocalFile(); }

signals:
    void changed();

private:
    bool openCatalog();
    bool fail(const QString &message);
    void loadRoutes();
    QString m_databasePath, m_connectionName, m_error;
    QVariantList m_storages, m_routes;
    int m_revision = 0;
    bool m_ready = false;
    QString m_localDeviceName;
};
