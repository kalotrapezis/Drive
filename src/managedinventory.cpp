#include "managedinventory.h"

#include "verifiedcopy.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QFileSystemWatcher>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QStorageInfo>
#include <QThread>
#include <QTimer>
#include <QTimeZone>
#include <QUuid>
#include <utility>

namespace {

struct KnownItem { qint64 size = 0, modified = 0; QString hash, state; };
struct ObservedItem { QString relative, absolute, hash; qint64 size = 0, modified = 0; };

QString key(const QString &routeId, const QString &relative) { return routeId + '\n' + relative; }

bool hashStable(const QFileInfo &before, QString *hash, const std::atomic_bool *cancelled) {
    QFile file(before.filePath());
    if (!file.open(QIODevice::ReadOnly)) return false;
    QCryptographicHash digest(QCryptographicHash::Sha256);
    while (!file.atEnd()) {
        if (cancelled && cancelled->load()) return false;
        const QByteArray chunk = file.read(1024 * 1024);
        if (chunk.isEmpty() && file.error() != QFile::NoError) return false;
        digest.addData(chunk);
    }
    const QFileInfo after(before.filePath());
    if (!after.isFile() || after.size() != before.size() || after.lastModified().toMSecsSinceEpoch() != before.lastModified().toMSecsSinceEpoch()) return false;
    *hash = QString::fromLatin1(digest.result().toHex());
    return true;
}

bool appendEvent(QSqlDatabase &db, const QString &routeId, const QString &event, const QString &relative,
                 const QString &previousHash, const QString &currentHash, qint64 size, QString *error) {
    QSqlQuery query(db);
    if (!query.exec("UPDATE devices SET event_sequence=event_sequence+1 WHERE id='local'")
        || !query.exec("SELECT catalog_generation,event_sequence FROM devices WHERE id='local'") || !query.next()) {
        if (error) *error = query.lastError().text(); return false;
    }
    const qint64 generation = query.value(0).toLongLong(), sequence = query.value(1).toLongLong();
    query.prepare("INSERT INTO inventory_events(id,origin_device_id,catalog_generation,origin_sequence,route_id,event,relative_path,previous_sha256,current_sha256,size_bytes) VALUES(?,'local',?,?,?,?,?,?,?,?)");
    query.addBindValue(QStringLiteral("inventory-%1").arg(QUuid::createUuid().toString(QUuid::Id128)));
    query.addBindValue(generation); query.addBindValue(sequence); query.addBindValue(routeId); query.addBindValue(event); query.addBindValue(relative);
    query.addBindValue(previousHash.isEmpty() ? QVariant() : QVariant(previousHash)); query.addBindValue(currentHash.isEmpty() ? QVariant() : QVariant(currentHash)); query.addBindValue(size);
    if (query.exec()) return true;
    if (error) *error = query.lastError().text();
    return false;
}

bool refreshVerifiedLocation(QSqlDatabase &db, const QString &routeId, const QString &relative, const QString &hash, bool *matched, QString *error) {
    QSqlQuery query(db);
    query.prepare("SELECT r.source_storage_id,r.source_root,s.selected_root FROM routes r JOIN storage s ON s.id=r.source_storage_id WHERE r.id=?");
    query.addBindValue(routeId);
    if (!query.exec() || !query.next()) { if (error) *error = query.lastError().text().isEmpty() ? QStringLiteral("Managed route storage is unavailable") : query.lastError().text(); return false; }
    const QString storageId = query.value(0).toString(), sourceRoot = query.value(1).toString(), selectedRoot = query.value(2).toString();
    const QString filesystemRoot = QStorageInfo(sourceRoot).rootPath();
    const QString storageRelative = QDir(filesystemRoot.isEmpty() ? selectedRoot : filesystemRoot).relativeFilePath(QDir(sourceRoot).filePath(relative));
    query.prepare("UPDATE locations SET state='verified',last_seen_at=CURRENT_TIMESTAMP,last_verified_at=CURRENT_TIMESTAMP WHERE storage_id=? AND relative_path IN (?,?) AND destination_sha256=? AND state='verified'");
    query.addBindValue(storageId); query.addBindValue(storageRelative); query.addBindValue(relative); query.addBindValue(hash);
    if (!query.exec()) { if (error) *error = query.lastError().text(); return false; }
    if (matched) *matched = query.numRowsAffected() > 0;
    return true;
}

bool saveReview(QSqlDatabase &db, const QString &routeId, const QString &root, const QStringList &paths,
                int added, int changed, int missing, qint64 bytes, QString *error) {
    if (paths.isEmpty()) return true;
    const QString sourceId = QString::fromLatin1(QCryptographicHash::hash(
        (routeId + '\n' + paths.join('\n') + '\n' + QString::number(added) + '\n' + QString::number(changed) + '\n' + QString::number(missing)).toUtf8(),
        QCryptographicHash::Sha256).toHex());
    const QJsonObject details{{"root", root}, {"paths", QJsonArray::fromStringList(paths.mid(0, 200))}, {"added", added}, {"changed", changed}, {"missing", missing}};
    QSqlQuery query(db);
    query.prepare("INSERT INTO review_items(id,category,source_kind,source_id,title,summary,details_json,item_count,bytes_total,state) VALUES(?,'External changes','metadata',?,'External changes detected','Files added outside Local Drive were indexed; changed or missing files require review.',?,?,?,?) ON CONFLICT(source_kind,source_id,category) DO UPDATE SET updated_at=CURRENT_TIMESTAMP");
    query.addBindValue(QStringLiteral("review-%1").arg(sourceId)); query.addBindValue(sourceId);
    query.addBindValue(QString::fromUtf8(QJsonDocument(details).toJson(QJsonDocument::Compact))); query.addBindValue(paths.size()); query.addBindValue(bytes);
    query.addBindValue(changed || missing ? QStringLiteral("needs_decision") : QStringLiteral("saved"));
    if (query.exec()) return true;
    if (error) *error = query.lastError().text();
    return false;
}

}

namespace LocalDrive::ManagedInventory {

QVariantMap scan(const QString &databasePath, QString *error, const std::atomic_bool *cancelled) {
    QVariantMap summary{{"added", 0}, {"changed", 0}, {"missing", 0}, {"bytes", 0}, {"watchedDirectories", QStringList{}}};
    if (!VerifiedCopy::ensureCatalog(databasePath, error)) return summary;
    const QString connection = QStringLiteral("managed-inventory-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection);
    db.setDatabaseName(databasePath);
    if (!db.open()) { if (error) *error = db.lastError().text(); db = {}; QSqlDatabase::removeDatabase(connection); return summary; }

    QHash<QString, KnownItem> known;
    QSqlQuery query(db);
    if (!query.exec("SELECT route_id,relative_path,size_bytes,modified_ms,content_sha256,state FROM managed_inventory")) {
        if (error) *error = query.lastError().text(); db.close(); db = {}; QSqlDatabase::removeDatabase(connection); return summary;
    }
    while (query.next()) known.insert(key(query.value(0).toString(), query.value(1).toString()), {query.value(2).toLongLong(), query.value(3).toLongLong(), query.value(4).toString(), query.value(5).toString()});

    struct Route { QString id, root; QVector<ObservedItem> items; QSet<QString> seen; QStringList directories, unstable; bool accessible = false, complete = true; };
    QVector<Route> routes;
    if (!query.exec("SELECT id,source_root FROM routes WHERE enabled=1 ORDER BY id")) { if (error) *error = query.lastError().text(); }
    while (query.next()) routes.append({query.value(0).toString(), query.value(1).toString()});

    for (Route &route : routes) {
        const QFileInfo rootInfo(route.root);
        if (cancelled && cancelled->load()) break;
        if (!rootInfo.isDir() || !rootInfo.isReadable()) continue;
        route.accessible = true;
        route.directories.append(rootInfo.canonicalFilePath());
        QDirIterator iterator(route.root, QDir::AllEntries | QDir::NoDotAndDotDot | QDir::NoSymLinks, QDirIterator::Subdirectories);
        while (iterator.hasNext()) {
            if (cancelled && cancelled->load()) break;
            const QFileInfo info(iterator.next());
            if (info.isDir()) { route.directories.append(info.canonicalFilePath()); if (!info.isReadable()) route.complete = false; continue; }
            if (!info.isFile()) continue;
            const QString relative = QDir(route.root).relativeFilePath(info.filePath());
            route.seen.insert(relative);
            const KnownItem old = known.value(key(route.id, relative));
            QString hash = old.hash;
            if (old.hash.isEmpty() || old.size != info.size() || old.modified != info.lastModified().toMSecsSinceEpoch() || old.state == "missing") {
                if (!hashStable(info, &hash, cancelled)) { route.unstable.append(relative); continue; }
            }
            route.items.append({relative, info.filePath(), hash, info.size(), info.lastModified().toMSecsSinceEpoch()});
        }
        if (!QFileInfo(route.root).isDir()) route.accessible = route.complete = false;
    }
    if (cancelled && cancelled->load()) { db.close(); db = {}; QSqlDatabase::removeDatabase(connection); return summary; }

    if (!db.transaction()) { if (error) *error = db.lastError().text(); db.close(); db = {}; QSqlDatabase::removeDatabase(connection); return summary; }
    int totalAdded = 0, totalChanged = 0, totalMissing = 0; qint64 totalBytes = 0; QStringList watched;
    bool ok = true;
    for (const Route &route : std::as_const(routes)) {
        int added = 0, changed = 0, missing = 0; qint64 bytes = 0; QStringList paths;
        if (!route.accessible) continue;
        watched.append(route.directories);
        for (const ObservedItem &item : route.items) {
            const KnownItem old = known.value(key(route.id, item.relative));
            QString event;
            if (old.hash.isEmpty()) event = "added";
            else if (old.state == "missing") event = "reappeared";
            else if (old.hash != item.hash) event = "changed";
            QSqlQuery save(db);
            save.prepare("INSERT INTO managed_inventory(route_id,relative_path,size_bytes,modified_ms,content_sha256,state) VALUES(?,?,?,?,?,'present') ON CONFLICT(route_id,relative_path) DO UPDATE SET size_bytes=excluded.size_bytes,modified_ms=excluded.modified_ms,content_sha256=excluded.content_sha256,state='present',last_seen_at=CURRENT_TIMESTAMP");
            save.addBindValue(route.id); save.addBindValue(item.relative); save.addBindValue(item.size); save.addBindValue(item.modified); save.addBindValue(item.hash);
            if (!save.exec()) { if (error) *error = save.lastError().text(); ok = false; break; }
            save.prepare("INSERT OR IGNORE INTO content(id,sha256,size_bytes,original_name,modified_at) VALUES(?,?,?,?,?)");
            save.addBindValue(QStringLiteral("content-%1").arg(item.hash)); save.addBindValue(item.hash); save.addBindValue(item.size); save.addBindValue(QFileInfo(item.relative).fileName()); save.addBindValue(QDateTime::fromMSecsSinceEpoch(item.modified, QTimeZone::UTC).toString(Qt::ISODateWithMs));
            if (!save.exec()) { if (error) *error = save.lastError().text(); ok = false; break; }
            if (!event.isEmpty()) {
                bool receiptBacked = false;
                if (event == "added" && !refreshVerifiedLocation(db, route.id, item.relative, item.hash, &receiptBacked, error)) { ok = false; break; }
                if (!receiptBacked) {
                    if (!appendEvent(db, route.id, event, item.relative, old.hash, item.hash, item.size, error)) { ok = false; break; }
                    paths.append(item.relative); bytes += item.size;
                    if (event == "added") ++added; else ++changed;
                }
            }
        }
        if (!ok) break;
        for (auto it = known.cbegin(); route.complete && it != known.cend(); ++it) {
            const QString prefix = route.id + '\n';
            if (!it.key().startsWith(prefix) || it.value().state == "missing") continue;
            const QString relative = it.key().mid(prefix.size());
            if (route.seen.contains(relative) || route.unstable.contains(relative)) continue;
            QSqlQuery mark(db); mark.prepare("UPDATE managed_inventory SET state='missing',last_seen_at=CURRENT_TIMESTAMP WHERE route_id=? AND relative_path=?"); mark.addBindValue(route.id); mark.addBindValue(relative);
            if (!mark.exec() || !appendEvent(db, route.id, "missing", relative, it.value().hash, {}, it.value().size, error)) { if (error && error->isEmpty()) *error = mark.lastError().text(); ok = false; break; }
            paths.append(relative); ++missing;
        }
        if (!ok || !saveReview(db, route.id, route.root, paths, added, changed, missing, bytes, error)) { ok = false; break; }
        totalAdded += added; totalChanged += changed; totalMissing += missing; totalBytes += bytes;
    }
    if (ok) ok = db.commit(); else db.rollback();
    if (!ok && error && error->isEmpty()) *error = db.lastError().text();
    db.close(); db = {}; QSqlDatabase::removeDatabase(connection);
    if (ok) {
        summary.insert("added", totalAdded); summary.insert("changed", totalChanged); summary.insert("missing", totalMissing); summary.insert("bytes", totalBytes);
        watched.removeDuplicates();
        summary.insert("watchedDirectories", watched);
        int unstable = 0; for (const Route &route : std::as_const(routes)) unstable += route.unstable.size();
        summary.insert("unstable", unstable);
    }
    return summary;
}

}

ManagedRootWatcher::ManagedRootWatcher(QString databasePath, QObject *parent)
    : QObject(parent), m_databasePath(std::move(databasePath)), m_watcher(new QFileSystemWatcher(this)), m_debounce(new QTimer(this)), m_periodic(new QTimer(this)) {
    m_debounce->setSingleShot(true); m_debounce->setInterval(1500);
    m_periodic->setInterval(5 * 60 * 1000);
    connect(m_debounce, &QTimer::timeout, this, &ManagedRootWatcher::startScan);
    connect(m_periodic, &QTimer::timeout, this, &ManagedRootWatcher::schedule);
    connect(m_watcher, &QFileSystemWatcher::directoryChanged, this, [this] { schedule(); });
    connect(m_watcher, &QFileSystemWatcher::fileChanged, this, [this] { schedule(); });
    m_periodic->start();
}

ManagedRootWatcher::~ManagedRootWatcher() {
    m_stopping.store(true);
    if (m_worker) m_worker->wait();
}

void ManagedRootWatcher::refresh() { schedule(); }

void ManagedRootWatcher::schedule() {
    if (m_worker) m_rescanRequested = true;
    else m_debounce->start();
}

void ManagedRootWatcher::startScan() {
    if (m_worker) { m_rescanRequested = true; return; }
    m_worker = QThread::create([this] {
        QString error;
        const QVariantMap result = LocalDrive::ManagedInventory::scan(m_databasePath, &error, &m_stopping);
        QMetaObject::invokeMethod(this, [this, result, error] {
            if (m_stopping.load()) return;
            const QStringList oldPaths = m_watcher->directories();
            if (!oldPaths.isEmpty()) m_watcher->removePaths(oldPaths);
            const QStringList paths = result.value("watchedDirectories").toStringList();
            if (!paths.isEmpty()) m_watcher->addPaths(paths);
            if (result.value("unstable").toInt()) m_rescanRequested = true;
            if (error.isEmpty()) emit inventoryChanged();
        });
    });
    connect(m_worker, &QThread::finished, this, [this] {
        m_worker->deleteLater(); m_worker = nullptr;
        if (m_rescanRequested) { m_rescanRequested = false; schedule(); }
    });
    m_worker->start();
}
