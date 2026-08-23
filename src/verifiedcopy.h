#pragma once

#include <QObject>
#include <QVariantMap>
#include <QVector>
#include <atomic>
#include <functional>

class VerifiedCopy final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool running READ running NOTIFY runningChanged)
    Q_PROPERTY(bool previewSuccessful READ previewSuccessful NOTIFY previewChanged)
    Q_PROPERTY(QVariantMap previewData READ previewData NOTIFY previewChanged)
    Q_PROPERTY(QString status READ status NOTIFY statusChanged)
public:
    struct Request {
        QString sourceRoot;
        QString destinationRoot;
        QString selectedStorageRoot;
        QString storageIdentity;
        QString databasePath;
        QString routeId;
        QString destinationStorageId = QStringLiteral("destination");
        QString behavior = QStringLiteral("Copy");
    };
    struct Preview {
        struct ManifestEntry { QString relative; qint64 size = 0; qint64 mtime = 0; };
        bool ok = false;
        QString error;
        qint64 files = 0;
        qint64 bytes = 0;
        qint64 toCopy = 0;
        qint64 identical = 0;
        qint64 conflicts = 0;
        qint64 unsupported = 0;
        qint64 freeBytes = 0;
        QVector<QString> paths;
        QVector<ManifestEntry> manifest;
        QVariantMap toMap() const;
    };

    explicit VerifiedCopy(const QString &databasePath = {}, QObject *parent = nullptr);
    ~VerifiedCopy() override;

    static QString liveStorageIdentity(const QString &root, QString *error = nullptr);
    static Preview inspect(const Request &request);

    bool executeBlocking(const Request &request, QString *error = nullptr);
    bool running() const { return m_running.load(); }
    bool previewSuccessful() const { return m_preview.ok; }
    QVariantMap previewData() const { return m_preview.toMap(); }
    QString status() const { return m_status; }

    Q_INVOKABLE bool previewRoute(const QString &routeId);
    Q_INVOKABLE bool startCopy();
    Q_INVOKABLE void cancel();

    // Test-only deterministic fault hook: called after final publication and before receipt commit.
    void setFailAfterPublishOnce(bool enabled) { m_failAfterPublishOnce.store(enabled); }
    void setTestHook(std::function<void(const QString &, const QString &)> hook) { m_testHook = std::move(hook); }

signals:
    void previewChanged();
    void runningChanged();
    void statusChanged();
    void progressChanged(qint64 done, qint64 total, const QString &path);
    void finished(bool success, const QString &message);

private:
    void setStatus(const QString &status);
    QVariantMap routeMap(const QString &routeId);
    bool execute(const Request &request, const Preview &authorized, QString *error, QString *completionMessage = nullptr);
    Preview m_preview;
    Request m_request;
    QString m_status;
    QString m_databasePath;
    class QThread *m_thread = nullptr;
    std::atomic_bool m_cancelled = false;
    std::atomic_bool m_running = false;
    std::atomic_bool m_failAfterPublishOnce = false;
    std::function<void(const QString &, const QString &)> m_testHook;
};
