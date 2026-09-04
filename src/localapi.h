#pragma once

#include <QObject>
#include <QHash>
#include <QJsonObject>
#include <QMutex>
#include <QTcpServer>
#include <atomic>
#include <functional>
#include <utility>

#include "verifiedcopy.h"

class SetupModel;

class LocalApi final : public QObject {
    Q_OBJECT
public:
    explicit LocalApi(SetupModel *model, QObject *parent = nullptr);
    ~LocalApi() override;
    bool start(quint16 port = 43172);
    void setWebRoot(QString root);
    quint16 port() const { return m_tcp.serverPort(); }
    bool isLoopbackBound() const;
#ifdef LOCAL_DRIVE_TESTING
    void setRouteTestHook(std::function<void(const QString &, const QString &)> hook) { m_routeTestHook = std::move(hook); }
#endif

private:
    void acceptConnections();
    QJsonObject state() const;
    QJsonObject files(const QString &relativePath, int *status = nullptr) const;
    QJsonObject recentFiles() const;
    QJsonObject photos(const QString &after = {}, bool screenshots = false) const;
    QJsonObject fileActivity(const QString &contentType, const QString &relativePath, int *status = nullptr) const;
    QJsonObject problems() const;
    QJsonObject problemAction(const QString &id, const QString &action, int *status);
    QJsonObject openFile(const QString &contentType, const QString &relativePath, int *status) const;
    QJsonObject createFolder(const QString &relativeParent, const QString &name, int *status) const;
    QJsonObject templates() const;
    QJsonObject fileLabels() const;
    QJsonObject labelledFiles(const QString &contentType, bool favorites) const;
    QJsonObject fileAction(const QJsonObject &options, int *status);
    QJsonObject createFromTemplate(const QJsonObject &options, int *status) const;
    QJsonObject saveRoute(const QJsonObject &options, int *status);
    QJsonObject startPhoneImport(const QJsonObject &options, int *status);
    QJsonObject startPhoneExport(const QJsonObject &options, int *status);
    QJsonObject routePreview(const QString &id) const;
    QJsonObject startRoutePreview(const QString &routeId, int *status);
    QJsonObject startRouteExecution(const QString &id, int *status);
    QJsonObject routeControl(const QString &id, const QString &action, int *status);
    QJsonObject routeManifest(const QString &id, int *status) const;
    QJsonObject routeHistory(const QString &routeId, int *status) const;
    QString photoPath(const QString &relativePath, bool screenshots) const;
    QByteArray photoThumbnail(const QString &relativePath, bool screenshots = false, bool preview = false) const;
    QJsonObject photoInfo(const QString &relativePath, bool screenshots) const;
    QJsonObject importPreview(const QString &id) const;
    void startImportPreview(const QString &id, const QString &source, const QString &target);
    QJsonObject startImportExecution(const QString &id, int *status);

    SetupModel *m_model;
    QTcpServer m_tcp;
    QByteArray m_token;
    QString m_webRoot;
    mutable QMutex m_previewMutex;
    QHash<QString, QJsonObject> m_importPreviews;
    QHash<QString, VerifiedCopy::Request> m_importRequests;
    QHash<QString, VerifiedCopy::Preview> m_importPlans;
    QHash<QString, QJsonObject> m_routePreviews;
    QHash<QString, VerifiedCopy *> m_routeEngines;
    QHash<QString, QJsonObject> m_routeManifests;
    QList<class QThread *> m_workers;
    std::atomic_bool m_stopping = false;
#ifdef LOCAL_DRIVE_TESTING
    std::function<void(const QString &, const QString &)> m_routeTestHook;
#endif
};
