#pragma once

#include <QObject>
#include <QUrl>
#include <QStringList>
#include <QHash>
#include <QVariantList>
#include <QVariantMap>
#include <QVector>
#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>

class QSqlDatabase;

class VerifiedCopy final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool running READ running NOTIFY runningChanged)
    Q_PROPERTY(bool previewSuccessful READ previewSuccessful NOTIFY previewChanged)
    Q_PROPERTY(bool cleanupReady READ cleanupReady NOTIFY cleanupChanged)
    Q_PROPERTY(bool paused READ paused NOTIFY pausedChanged)
    Q_PROPERTY(QVariantMap previewData READ previewData NOTIFY previewChanged)
    Q_PROPERTY(QString status READ status NOTIFY statusChanged)
    Q_PROPERTY(QStringList logEntries READ logEntries NOTIFY logEntriesChanged)
public:
    struct Request {
        QString sourceRoot;
        QString destinationRoot;
        QString selectedStorageRoot;
        QString storageIdentity;
        QString filesystemType;
        QString databasePath;
        QString routeId;
        QString destinationStorageId = QStringLiteral("destination");
        QString behavior = QStringLiteral("Copy");
        QString keepPolicy = QStringLiteral("Everything");
        qint64 minimumFreeBytes = 0;
        qint64 stagingMaxBytes = 0;
        bool organizePhotos = false;
        QString contentType;
        QString sourceStorageId = QStringLiteral("local");
        QString sourceStorageIdentity = QStringLiteral("local");
        QString sourceStorageKind = QStringLiteral("local");
        QString sourceStorageLabel = QStringLiteral("Computer");
        QString sourceDeviceId = QStringLiteral("local");
        QString sourceDeviceStableId = QStringLiteral("local");
        QString sourceDeviceName = QStringLiteral("Computer");
        QString sourceDeviceKind = QStringLiteral("Desktop");
        bool detectDestinationDuplicates = false;
        bool routeEnabled = true;
        QStringList excludedSourcePaths;
        QHash<QString, QString> destinationOverrides;
        QStringList acceptedUnsupportedEvidence;
        QString destinationStorageKind = QStringLiteral("removable");
        QString destinationStorageLabel = QStringLiteral("Destination");
        QString destinationDeviceId = QStringLiteral("local");
        QString destinationDeviceStableId = QStringLiteral("local");
        QString destinationDeviceName = QStringLiteral("Computer");
        QString destinationDeviceKind = QStringLiteral("Desktop");
    };
    struct RemoteRequest {
        QUrl sourceUrl;
        QUrl sourceRootUrl;
        QString sourceRelative;
        QString destinationRoot;
        QString destinationRelative;
        QString selectedStorageRoot;
        QString storageIdentity;
        QString filesystemType;
        QString databasePath;
        QString routeId;
        QString destinationStorageId = QStringLiteral("destination");
        QString sourceStorageId;
        QString sourceStorageIdentity;
        QString sourceStorageLabel = QStringLiteral("MTP phone");
        QString sourceDeviceId;
        QString sourceDeviceStableId;
        QString sourceDeviceName = QStringLiteral("MTP phone");
        qint64 minimumFreeBytes = 0;
        qint64 stagingMaxBytes = 0;
        qint64 progressOffset = 0;
        qint64 progressTotal = 0;
        bool resumable = false;
        QString destinationStorageKind = QStringLiteral("removable");
        QString destinationStorageLabel = QStringLiteral("Destination");
        QString destinationDeviceId = QStringLiteral("local");
        QString destinationDeviceStableId = QStringLiteral("local");
        QString destinationDeviceName = QStringLiteral("Computer");
    };
    struct Preview {
        struct ManifestEntry { QString relative; QString destination; qint64 size = 0; qint64 mtime = 0; };
        bool ok = false;
        QString error;
        QString errorCode;
        bool sourceSafe = true;
        QString nextAction;
        qint64 files = 0;
        qint64 bytes = 0;
        qint64 toCopy = 0;
        qint64 identical = 0;
        qint64 duplicates = 0;
        qint64 destinationDuplicates = 0;
        qint64 organized = 0;
        qint64 conflicts = 0;
        qint64 unsupported = 0;
        qint64 unreadable = 0;
        qint64 freeBytes = 0;
        qint64 minimumFreeBytes = 0;
        qint64 stagingMaxBytes = 0;
        QVector<QString> paths;
        QStringList conflictPaths;
        QStringList conflictEvidence;
        QStringList duplicatePaths;
        QStringList unsupportedPaths;
        QStringList unsupportedEvidence;
        QVector<ManifestEntry> manifest;
        QVariantMap toMap() const;
    };
    struct ExportRequest {
        QString sourcePath;
        QUrl destinationUrl;
        QUrl destinationRootUrl;
        QString destinationRelative;
        QString databasePath;
        QString routeId;
        QString destinationStorageId;
        QString destinationStorageIdentity;
        QString destinationStorageLabel;
        QString destinationDeviceId;
        QString destinationDeviceStableId;
        QString destinationDeviceName;
    };

    explicit VerifiedCopy(const QString &databasePath = {}, QObject *parent = nullptr);
    ~VerifiedCopy() override;

    static QString liveStorageIdentity(const QString &root, QString *error = nullptr);
    static bool stagingUsage(const QString &root, qint64 *bytes, QString *error = nullptr);
    static bool ensureCatalog(const QString &databasePath, QString *error = nullptr);
    static Preview inspect(const Request &request, const std::atomic_bool *cancelled = nullptr);
    static QVariantList recentHistoryForRoute(const QString &databasePath, const QString &routeId);

    bool executeBlocking(const Request &request, QString *error = nullptr);
    bool executePreviewBlocking(const Request &request, const Preview &preview, QString *error = nullptr, QString *completionMessage = nullptr);
    bool executeRemoteBlocking(const RemoteRequest &request, QString *error = nullptr);
    bool executeExportBlocking(const ExportRequest &request, QString *error = nullptr);
    bool running() const { return m_running.load(); }
    bool previewSuccessful() const { return m_preview.ok; }
    bool cleanupReady() const { return m_cleanupReady.load(); }
    bool paused() const { return m_paused.load(); }
    QVariantMap previewData() const { return m_preview.toMap(); }
    QString status() const { return m_status; }
    QStringList logEntries() const { return m_logEntries; }

    Q_INVOKABLE bool previewRoute(const QString &routeId);
    Q_INVOKABLE QVariantMap cleanupPreview() const;
    Q_INVOKABLE QVariantList recentHistory() const;
    QVariantMap manifestData() const;
    Q_INVOKABLE bool exportManifest(const QUrl &url, const QString &format = QStringLiteral("json")) const;
    Q_INVOKABLE bool startCopy();
    Q_INVOKABLE bool startRemoteImportDirectory(const QVariantMap &options);
    Q_INVOKABLE bool cleanup();
    Q_INVOKABLE void pause();
    Q_INVOKABLE void resume();
    Q_INVOKABLE void cancel();

    bool cleanupBlocking(const Request &request, QString *error = nullptr);

    // Test-only deterministic fault hook: called after final publication and before receipt commit.
    void setFailAfterPublishOnce(bool enabled) { m_failAfterPublishOnce.store(enabled); }
    void setTestHook(std::function<void(const QString &, const QString &)> hook) { m_testHook = std::move(hook); }

signals:
    void previewChanged();
    void cleanupChanged();
    void runningChanged();
    void pausedChanged();
    void statusChanged();
    void logEntriesChanged();
    void progressChanged(qint64 done, qint64 total, const QString &path);
    void finished(bool success, const QString &message);

private:
    void setStatus(const QString &status);
    void appendLog(const QString &message);
    bool waitIfPaused(QSqlDatabase &db, const QString &jobId, QString *error);
    bool executeResumableLocalRemoteBlocking(const RemoteRequest &request, QString *error);
    QVariantMap routeMap(const QString &routeId);
    bool execute(const Request &request, const Preview &authorized, QString *error, QString *completionMessage = nullptr);
    Preview m_preview;
    Request m_request;
    QString m_status;
    QStringList m_logEntries;
    QString m_databasePath;
    class QThread *m_thread = nullptr;
    std::atomic_bool m_cancelled = false;
    std::atomic_bool m_running = false;
    std::atomic_bool m_cleanupReady = false;
    std::atomic_bool m_paused = false;
    std::atomic_bool m_copying = false;
    std::atomic_bool m_failAfterPublishOnce = false;
    std::mutex m_pauseMutex;
    std::condition_variable m_pauseCondition;
    std::function<void(const QString &, const QString &)> m_testHook;
};
