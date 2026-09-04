#pragma once

#include <QObject>
#include <QVariantMap>
#include <atomic>

class QFileSystemWatcher;
class QThread;
class QTimer;

namespace LocalDrive::ManagedInventory {

QVariantMap scan(const QString &databasePath, QString *error = nullptr, const std::atomic_bool *cancelled = nullptr);

}

class ManagedRootWatcher final : public QObject {
    Q_OBJECT
public:
    explicit ManagedRootWatcher(QString databasePath, QObject *parent = nullptr);
    ~ManagedRootWatcher() override;
    void refresh();

signals:
    void inventoryChanged();

private:
    void schedule();
    void startScan();
    QString m_databasePath;
    QFileSystemWatcher *m_watcher = nullptr;
    QTimer *m_debounce = nullptr;
    QTimer *m_periodic = nullptr;
    QThread *m_worker = nullptr;
    std::atomic_bool m_stopping{false};
    bool m_rescanRequested = false;
};
