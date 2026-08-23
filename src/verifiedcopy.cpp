#include "verifiedcopy.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QStorageInfo>
#include <QStandardPaths>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QThread>
#include <QUuid>
#include <algorithm>
#include <cstring>

#include <cerrno>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <dirent.h>
#include <unistd.h>
#ifdef __linux__
#include <linux/fs.h>
#include <linux/openat2.h>
#endif

namespace {
struct SourceFile { QString relative; QString absolute; qint64 size = 0; qint64 mtime = 0; };
struct RootPins { int source = -1; int destination = -1; dev_t sourceDevice = 0; ino_t sourceInode = 0; dev_t destinationDevice = 0; ino_t destinationInode = 0; };
thread_local const std::atomic_bool *previewCancel = nullptr;

void closePins(RootPins &pins) { if (pins.source >= 0) ::close(pins.source); if (pins.destination >= 0) ::close(pins.destination); pins.source = pins.destination = -1; }
struct PinGuard { RootPins pins; ~PinGuard() { closePins(pins); } };
struct FdGuard { int fd = -1; ~FdGuard() { if (fd >= 0) ::close(fd); } };

bool pinRoot(const QString &path, int &fd, dev_t *device, ino_t *inode, QString *error) {
#ifdef __linux__
    fd = ::open(path.toLocal8Bit().constData(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) { if (error) *error = QString::fromLocal8Bit(strerror(errno)); return false; }
    struct stat st{};
    if (::fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode)) { if (error) *error = "Root is not a directory"; ::close(fd); fd = -1; return false; }
    if (device) *device = st.st_dev;
    if (inode) *inode = st.st_ino;
    return true;
#else
    Q_UNUSED(path); Q_UNUSED(fd); Q_UNUSED(device); Q_UNUSED(inode); if (error) *error = "Pinned Linux roots are unavailable"; return false;
#endif
}

bool pinRoots(const QString &source, const QString &destination, RootPins &pins, QString *error) {
    if (!pinRoot(source, pins.source, &pins.sourceDevice, &pins.sourceInode, error)) return false;
    if (!pinRoot(destination, pins.destination, &pins.destinationDevice, &pins.destinationInode, error)) { closePins(pins); return false; }
    return true;
}

QString defaultCatalogPath() {
    return QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/catalog.sqlite";
}

bool under(const QString &child, const QString &root) {
    const QString c = QDir::cleanPath(child), r = QDir::cleanPath(root);
    return c == r || c.startsWith(r.endsWith('/') ? r : r + '/');
}

QString canonicalDir(const QString &path) {
    const QFileInfo info(path);
    return info.isDir() && !info.isSymLink() ? info.canonicalFilePath() : QString();
}

int openBeneathFd(int rootFd, const QString &relative, int flags, mode_t mode, QString *error) {
#ifdef __linux__
    struct open_how how{}; how.flags = static_cast<quint64>(flags); how.mode = mode; how.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV;
    const QByteArray name = relative.isEmpty() ? QByteArrayLiteral(".") : relative.toUtf8();
    const int fd = static_cast<int>(::syscall(SYS_openat2, rootFd, name.constData(), &how, sizeof(how)));
    if (fd < 0 && error) *error = errno == ENOSYS ? QStringLiteral("Linux safe path opening is unavailable") : QString::fromLocal8Bit(strerror(errno));
    return fd;
#else
    Q_UNUSED(rootFd); Q_UNUSED(relative); Q_UNUSED(flags); Q_UNUSED(mode); if (error) *error = "Pinned Linux roots are unavailable"; return -1;
#endif
}

void scanPinned(int dirFd, const QString &root, const QString &relative, QVector<SourceFile> &files, qint64 &unsupported, QString *scanError, const std::atomic_bool *cancelled) {
#ifdef __linux__
    if (cancelled && cancelled->load()) { if (scanError) *scanError = "Preview cancelled"; return; }
    const int listingFd = ::dup(dirFd);
    if (listingFd < 0) { if (scanError) *scanError = QString::fromLocal8Bit(strerror(errno)); return; }
    DIR *dir = ::fdopendir(listingFd);
    if (!dir) { ::close(listingFd); if (scanError) *scanError = QString::fromLocal8Bit(strerror(errno)); return; }
    while (dirent *entry = ::readdir(dir)) {
        if (cancelled && cancelled->load()) { if (scanError) *scanError = "Preview cancelled"; break; }
        const QString name = QString::fromLocal8Bit(entry->d_name);
        if (name == "." || name == "..") continue;
        const QString child = relative.isEmpty() ? name : relative + "/" + name;
        struct stat st{};
        if (::fstatat(dirFd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) { if (scanError) *scanError = QString::fromLocal8Bit(strerror(errno)); break; }
        if (S_ISLNK(st.st_mode)) { ++unsupported; continue; }
        if (S_ISDIR(st.st_mode)) {
            const int childFd = ::openat(dirFd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
            if (childFd < 0) { if (scanError) *scanError = QString::fromLocal8Bit(strerror(errno)); break; }
            scanPinned(childFd, root, child, files, unsupported, scanError, cancelled); ::close(childFd);
            if (scanError && !scanError->isEmpty()) break;
        } else if (S_ISREG(st.st_mode)) {
            const qint64 mtime = st.st_mtim.tv_sec * 1000 + st.st_mtim.tv_nsec / 1000000;
            files.push_back({child, QDir(root).filePath(child), st.st_size, mtime});
        } else ++unsupported;
    }
    ::closedir(dir);
#else
    Q_UNUSED(dirFd); Q_UNUSED(root); Q_UNUSED(relative); Q_UNUSED(files); Q_UNUSED(unsupported); Q_UNUSED(scanError); Q_UNUSED(cancelled);
#endif
}

bool sameFileOpenedFd(int rootFd, const QString &relative, const SourceFile &source, QByteArray *hash, struct stat *openedStat, QString *error, int *keepFd = nullptr) {
    const int fd = openBeneathFd(rootFd, relative, O_RDONLY | O_NONBLOCK | O_CLOEXEC, 0, error);
    if (fd < 0) return false;
    struct stat info{}; QFile file;
    if (!file.open(fd, QIODevice::ReadOnly, QFileDevice::AutoCloseHandle) || ::fstat(file.handle(), &info) != 0 || !S_ISREG(info.st_mode) || info.st_size != source.size) { if (file.isOpen()) file.close(); else ::close(fd); return false; }
    QCryptographicHash digest(QCryptographicHash::Sha256);
    while (!file.atEnd()) { if (previewCancel && previewCancel->load()) { if (error) *error = "Preview cancelled"; file.close(); return false; } const QByteArray chunk = file.read(1024 * 1024); if (chunk.isEmpty() && !file.atEnd()) { if (error) *error = file.errorString(); file.close(); return false; } digest.addData(chunk); }
    if (hash) *hash = digest.result();
    if (openedStat) *openedStat = info;
    if (keepFd) { *keepFd = ::dup(file.handle()); if (*keepFd < 0) { if (error) *error = QString::fromLocal8Bit(strerror(errno)); file.close(); return false; } }
    return true;
}

bool hashFd(int fd, qint64 expectedSize, QByteArray *hash, struct stat *openedStat, QString *error, int *keepFd = nullptr) {
    struct stat info{};
    if (fd < 0 || ::fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_size != expectedSize) { if (error) *error = "Anonymous partial is not a regular file"; return false; }
    const int readFd = ::dup(fd);
    if (readFd < 0 || ::lseek(readFd, 0, SEEK_SET) < 0) { if (readFd >= 0) ::close(readFd); if (error) *error = QString::fromLocal8Bit(strerror(errno)); return false; }
    QFile file; if (!file.open(readFd, QIODevice::ReadOnly, QFileDevice::AutoCloseHandle)) { ::close(readFd); if (error) *error = file.errorString(); return false; }
    QCryptographicHash digest(QCryptographicHash::Sha256);
    while (!file.atEnd()) { const QByteArray chunk = file.read(1024 * 1024); if (chunk.isEmpty() && !file.atEnd()) { if (error) *error = file.errorString(); file.close(); return false; } digest.addData(chunk); }
    if (hash) *hash = digest.result(); if (openedStat) *openedStat = info;
    if (keepFd) { *keepFd = ::dup(fd); if (*keepFd < 0) { if (error) *error = QString::fromLocal8Bit(strerror(errno)); return false; } }
    return true;
}

int openDestinationParentFd(int rootFd, const QString &root, const QString &filePath, dev_t expectedDevice, QString *error) {
#ifdef __linux__
    const QString relative = QDir(root).relativeFilePath(QFileInfo(filePath).absolutePath());
    if (relative == ".." || relative.startsWith("../") || relative.contains("/../")) { if (error) *error = "Destination escapes selected storage"; return -1; }
    int current = ::dup(rootFd);
    if (current < 0) { if (error) *error = QString::fromLocal8Bit(strerror(errno)); return -1; }
    for (const QString &part : relative.split('/', Qt::SkipEmptyParts)) {
        const QByteArray name = part.toLocal8Bit();
        int next = ::openat(current, name.constData(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
        if (next < 0 && errno == ENOENT) {
            if (::mkdirat(current, name.constData(), 0700) != 0 && errno != EEXIST) { if (error) *error = QString::fromLocal8Bit(strerror(errno)); ::close(current); return -1; }
            next = ::openat(current, name.constData(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
        }
        if (next < 0) { if (error) *error = "Destination contains a symlink or non-directory"; ::close(current); return -1; }
        struct stat child{};
        if (::fstat(next, &child) != 0 || child.st_dev != expectedDevice) { if (error) *error = "Destination crosses a filesystem boundary"; ::close(next); ::close(current); return -1; }
        ::close(current); current = next;
    }
    return current;
#else
    Q_UNUSED(rootFd); Q_UNUSED(root); Q_UNUSED(filePath); Q_UNUSED(expectedDevice); if (error) *error = "Pinned Linux roots are unavailable"; return -1;
#endif
}

bool statPinned(int rootFd, const QString &root, const QString &relative, struct stat *st, QString *error) {
#ifdef __linux__
    const QString parentRelative = QFileInfo(relative).path() == "." ? QString() : QFileInfo(relative).path();
    const QString name = QFileInfo(relative).fileName();
    int parent = ::dup(rootFd);
    if (parent < 0) { if (error) *error = QString::fromLocal8Bit(strerror(errno)); return false; }
    for (const QString &part : parentRelative.split('/', Qt::SkipEmptyParts)) {
        const int next = ::openat(parent, part.toLocal8Bit().constData(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) { ::close(parent); return false; }
        ::close(parent); parent = next;
    }
    const bool ok = ::fstatat(parent, name.toLocal8Bit().constData(), st, AT_SYMLINK_NOFOLLOW) == 0;
    if (!ok && error && errno != ENOENT) *error = QString::fromLocal8Bit(strerror(errno));
    ::close(parent); Q_UNUSED(root); return ok;
#else
    Q_UNUSED(rootFd); Q_UNUSED(root); Q_UNUSED(relative); Q_UNUSED(st); if (error) *error = "Pinned Linux roots are unavailable"; return false;
#endif
}

bool liveRootMatches(const QString &path, dev_t device, ino_t inode) {
#ifdef __linux__
    const int fd = ::open(path.toLocal8Bit().constData(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return false;
    struct stat st{}; const bool ok = ::fstat(fd, &st) == 0 && st.st_dev == device && st.st_ino == inode;
    ::close(fd); return ok;
#else
    Q_UNUSED(path); Q_UNUSED(device); Q_UNUSED(inode); return false;
#endif
}

bool openPartialFd(int rootFd, dev_t device, const QString &root, const QString &finalPath, QFile &file, int *parentOut, QString *error) {
#ifdef __linux__
    const int parentFd = openDestinationParentFd(rootFd, root, finalPath, device, error);
    if (parentFd < 0) return false;
    const int partialFd = ::openat(parentFd, ".", O_TMPFILE | O_RDWR | O_CLOEXEC, 0600);
    if (partialFd < 0) { const int saved = errno; ::close(parentFd); if (error) *error = saved == EOPNOTSUPP || saved == EINVAL ? "Destination filesystem does not support anonymous durable staging" : QString::fromLocal8Bit(strerror(saved)); return false; }
    if (!file.open(partialFd, QIODevice::WriteOnly, QFileDevice::AutoCloseHandle)) { ::close(partialFd); ::close(parentFd); if (error) *error = file.errorString(); return false; }
    if (parentOut) *parentOut = parentFd; else ::close(parentFd);
    return true;
#else
    Q_UNUSED(rootFd); Q_UNUSED(device); Q_UNUSED(root); Q_UNUSED(finalPath); Q_UNUSED(file); Q_UNUSED(parentOut); if (error) *error = "Anonymous Linux staging is unavailable"; return false;
#endif
}

QString storageIdentity(const QString &root, QString *error) {
    const QString canonical = canonicalDir(root);
    if (canonical.isEmpty()) { if (error) *error = "Destination root is unavailable or is a symlink"; return {}; }
    struct stat rootStat {};
    if (::stat(canonical.toLocal8Bit().constData(), &rootStat) != 0) { if (error) *error = QString::fromLocal8Bit(strerror(errno)); return {}; }
    QDir uuids(QStringLiteral("/dev/disk/by-uuid"));
    for (const QFileInfo &entry : uuids.entryInfoList(QDir::System | QDir::NoDotAndDotDot, QDir::Name)) {
        struct stat deviceStat {};
        const QByteArray target = entry.absoluteFilePath().toLocal8Bit();
        if (::stat(target.constData(), &deviceStat) == 0 && deviceStat.st_rdev == rootStat.st_dev)
            return QStringLiteral("storage:%1").arg(entry.fileName());
    }
    // ponytail: major/minor is the smallest portable local fallback; replace with a UUID when the device exposes one.
    return QStringLiteral("storage:device:%1:%2").arg(major(rootStat.st_dev)).arg(minor(rootStat.st_dev));
}

bool initializeCatalog(QSqlDatabase &db, QString *error) {
    QSqlQuery q(db);
    if (!q.exec("PRAGMA foreign_keys = ON")) { if (error) *error = q.lastError().text(); return false; }
    if (!q.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'") || !q.next()) {
        QFile schema(QStringLiteral(":/src/catalog/schema.sql"));
        if (!schema.open(QIODevice::ReadOnly)) { if (error) *error = schema.errorString(); return false; }
        if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
        QString statement; bool trigger = false;
        for (const QString &line : QString::fromUtf8(schema.readAll()).split('\n')) {
            statement += line + '\n';
            const QString trimmed = line.trimmed();
            if (statement.trimmed().startsWith("CREATE TRIGGER")) trigger = true;
            if (!trimmed.endsWith(';') || (trigger && trimmed != "END;")) continue;
            if (!q.exec(statement.trimmed())) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
            statement.clear(); trigger = false;
        }
        if (!db.commit()) { if (error) *error = db.lastError().text(); return false; }
    } else {
        if (!q.exec("SELECT version FROM schema_version WHERE singleton=1") || !q.next() || q.value(0).toInt() != 1) {
            if (error) *error = "Unsupported catalog schema version"; return false;
        }
    }
    return true;
}

QString stableJobId(const VerifiedCopy::Request &r, const QVector<SourceFile> &files) {
    QByteArray manifest;
    for (const SourceFile &file : files) manifest += file.relative.toUtf8() + '\0' + QByteArray::number(file.size) + '\0' + QByteArray::number(file.mtime) + '\n';
    return QStringLiteral("job-%1").arg(QString::fromLatin1(QCryptographicHash::hash(
        r.routeId.toUtf8() + '\n' + r.sourceRoot.toUtf8() + '\n' + r.destinationRoot.toUtf8() + '\n' + manifest, QCryptographicHash::Sha256).toHex()));
}

QString stableItemId(const QString &job, const QString &relative) {
    return QStringLiteral("item-%1").arg(QString::fromLatin1(QCryptographicHash::hash((job + "\n" + relative).toUtf8(), QCryptographicHash::Sha256).toHex()));
}

bool prepareCatalog(QSqlDatabase &db, const VerifiedCopy::Request &r, const VerifiedCopy::Preview &preview,
                    const QVector<SourceFile> &files, QString &routeId, QString &jobId, QString *error) {
    if (!initializeCatalog(db, error)) return false;
    routeId = r.routeId.isEmpty() ? QStringLiteral("route-%1").arg(QString::fromLatin1(QCryptographicHash::hash((r.sourceRoot + r.destinationRoot).toUtf8(), QCryptographicHash::Sha256).toHex())) : r.routeId;
    jobId = stableJobId(r, files);
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    QSqlQuery q(db);
    q.prepare("INSERT OR IGNORE INTO devices(id,stable_id,name,kind,is_local) VALUES('local','local','Computer','Desktop',1)");
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    q.prepare("INSERT OR IGNORE INTO storage(id,stable_identity,device_id,kind,label,selected_root,presence) VALUES('local','local','local','local','Computer','/','present')");
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    q.prepare("INSERT OR IGNORE INTO storage(id,stable_identity,device_id,kind,label,selected_root,presence) VALUES(?,?,?,?,?,?,?)");
    q.addBindValue(r.destinationStorageId); q.addBindValue(r.storageIdentity); q.addBindValue("local"); q.addBindValue("removable"); q.addBindValue("Destination"); q.addBindValue(r.destinationRoot); q.addBindValue("present");
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    q.prepare("INSERT OR IGNORE INTO routes(id,source_storage_id,destination_storage_id,source_root,destination_root,behavior) VALUES(?,?,?,?,?,?)");
    q.addBindValue(routeId); q.addBindValue("local"); q.addBindValue(r.destinationStorageId); q.addBindValue(r.sourceRoot); q.addBindValue(r.destinationRoot); q.addBindValue(r.behavior);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    q.prepare("INSERT OR IGNORE INTO jobs(id,route_id,behavior,source_path,destination_path,bytes_total) VALUES(?,?,?,?,?,?)");
    q.addBindValue(jobId); q.addBindValue(routeId); q.addBindValue(r.behavior); q.addBindValue(r.sourceRoot); q.addBindValue(r.destinationRoot); q.addBindValue(preview.bytes);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    for (const SourceFile &file : files) {
        q.prepare("INSERT OR IGNORE INTO job_items(id,job_id,source_path,destination_path,expected_size,bytes_done,state,source_mtime) VALUES(?,?,?,?,?,?,?,?)");
        q.addBindValue(stableItemId(jobId, file.relative)); q.addBindValue(jobId); q.addBindValue(file.absolute); q.addBindValue(QDir(r.destinationRoot).filePath(file.relative)); q.addBindValue(file.size); q.addBindValue(0); q.addBindValue("Queued"); q.addBindValue(QString::number(file.mtime));
        if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    }
    if (!db.commit()) { db.rollback(); if (error) *error = db.lastError().text(); return false; }
    return true;
}

bool appendHistory(QSqlDatabase &db, const QString &jobId, const QString &itemId, const QString &event,
                   const QString &source, const QString &destination, const QString &sourceHash,
                   const QString &destinationHash, const QString &result, QString *error) {
    QSqlQuery q(db);
    if (!q.exec("UPDATE devices SET event_sequence=event_sequence+1 WHERE id='local'")) { if (error) *error = q.lastError().text(); return false; }
    if (!q.exec("SELECT event_sequence FROM devices WHERE id='local'") || !q.next()) { if (error) *error = q.lastError().text(); return false; }
    const qint64 sequence = q.value(0).toLongLong();
    q.prepare("INSERT INTO history(id,origin_device_id,catalog_generation,origin_sequence,job_id,item_id,event,source_path,destination_path,source_sha256,destination_sha256,result) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    q.addBindValue(QStringLiteral("history-%1").arg(QUuid::createUuid().toString(QUuid::Id128))); q.addBindValue("local"); q.addBindValue(1); q.addBindValue(sequence); q.addBindValue(jobId); q.addBindValue(itemId); q.addBindValue(event); q.addBindValue(source); q.addBindValue(destination); q.addBindValue(sourceHash.isEmpty() ? QVariant() : QVariant(sourceHash)); q.addBindValue(destinationHash.isEmpty() ? QVariant() : QVariant(destinationHash)); q.addBindValue(result);
    if (!q.exec()) { if (error) *error = q.lastError().text(); return false; }
    return true;
}

bool recordReceipt(QSqlDatabase &db, const VerifiedCopy::Request &r, const QString &jobId,
                   const SourceFile &source, const QString &destination, const QByteArray &hash, QString *error) {
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    QSqlQuery q(db);
    const QString contentId = QStringLiteral("content-%1").arg(QString::fromLatin1(hash.toHex()));
    const QString itemId = stableItemId(jobId, source.relative);
    const QString locationId = QStringLiteral("location-%1").arg(QString::fromLatin1(QCryptographicHash::hash((r.destinationStorageId + "\n" + source.relative).toUtf8(), QCryptographicHash::Sha256).toHex()));
    const QString now = QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs);
    q.prepare("SELECT state,expected_size,expected_sha256 FROM job_items WHERE id=?"); q.addBindValue(itemId);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    if (q.next() && q.value(0).toString() == "Complete" && q.value(1).toLongLong() == source.size && q.value(2).toString() == QString::fromLatin1(hash.toHex())) { db.rollback(); return true; }
    q.prepare("INSERT OR IGNORE INTO content(id,sha256,size_bytes,original_name,modified_at) VALUES(?,?,?,?,?)");
    q.addBindValue(contentId); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(source.size); q.addBindValue(QFileInfo(source.absolute).fileName()); q.addBindValue(now);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    q.prepare("UPDATE job_items SET content_id=?,source_path=?,destination_path=?,expected_size=?,expected_sha256=?,bytes_done=?,state='Complete',source_mtime=?,destination_sha256=?,verified_at=?,cleanup_state='not_requested' WHERE id=?");
    q.addBindValue(contentId); q.addBindValue(source.absolute); q.addBindValue(destination); q.addBindValue(source.size); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(source.size); q.addBindValue(QString::number(source.mtime)); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(now); q.addBindValue(itemId);
    if (!q.exec() || q.numRowsAffected() == 0) { db.rollback(); if (error) *error = q.lastError().text().isEmpty() ? QStringLiteral("Missing catalog job item") : q.lastError().text(); return false; }
    q.prepare("INSERT OR IGNORE INTO locations(id,content_id,storage_id,relative_path,state,size_bytes,source_sha256,destination_sha256,verified_at,last_seen_at,last_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    q.addBindValue(locationId); q.addBindValue(contentId); q.addBindValue(r.destinationStorageId); q.addBindValue(source.relative); q.addBindValue("verified"); q.addBindValue(source.size); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(now); q.addBindValue(now); q.addBindValue(now);
    if (!q.exec()) {
        // A retry may have published the same file before its receipt was committed.
        q.prepare("UPDATE locations SET content_id=?,state='verified',size_bytes=?,source_sha256=?,destination_sha256=?,verified_at=?,last_seen_at=?,last_verified_at=? WHERE storage_id=? AND relative_path=? AND (destination_sha256=? OR destination_sha256 IS NULL)");
        q.addBindValue(contentId); q.addBindValue(source.size); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(now); q.addBindValue(now); q.addBindValue(now); q.addBindValue(r.destinationStorageId); q.addBindValue(source.relative); q.addBindValue(QString::fromLatin1(hash.toHex()));
        if (!q.exec() || q.numRowsAffected() == 0) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    } else if (q.numRowsAffected() == 0) {
        q.prepare("UPDATE locations SET content_id=?,state='verified',size_bytes=?,source_sha256=?,destination_sha256=?,verified_at=?,last_seen_at=?,last_verified_at=? WHERE storage_id=? AND relative_path=?");
        q.addBindValue(contentId); q.addBindValue(source.size); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(now); q.addBindValue(now); q.addBindValue(now); q.addBindValue(r.destinationStorageId); q.addBindValue(source.relative);
        if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    }
    q.prepare("UPDATE jobs SET state='Copying',bytes_done=MIN(bytes_total,bytes_done+?),updated_at=CURRENT_TIMESTAMP WHERE id=?"); q.addBindValue(source.size); q.addBindValue(jobId);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    if (!appendHistory(db, jobId, itemId, "verified", source.absolute, destination, QString::fromLatin1(hash.toHex()), QString::fromLatin1(hash.toHex()), "verified copy", error) || !db.commit()) { db.rollback(); if (error && error->isEmpty()) *error = db.lastError().text(); return false; }
    return true;
}

bool markItemTerminal(QSqlDatabase &db, const QString &jobId, const SourceFile &source,
                      const QString &destination, const QString &state, const QString &event,
                      const QString &result, QString *error) {
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    QSqlQuery q(db);
    const QString itemId = stableItemId(jobId, source.relative);
    q.prepare("SELECT state FROM job_items WHERE id=?"); q.addBindValue(itemId);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    if (q.next() && q.value(0).toString() == state) { db.rollback(); return true; }
    q.prepare("UPDATE job_items SET state=?,cleanup_state='not_requested' WHERE id=?"); q.addBindValue(state); q.addBindValue(itemId);
    if (!q.exec() || q.numRowsAffected() != 1 || !appendHistory(db, jobId, itemId, event, source.absolute, destination, {}, {}, result, error) || !db.commit()) { db.rollback(); if (error && error->isEmpty()) *error = db.lastError().text(); return false; }
    return true;
}

bool markRemainingTerminal(QSqlDatabase &db, const QString &jobId, const QString &state, const QString &event, const QString &result, QString *error) {
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    QSqlQuery q(db);
    q.prepare("SELECT id,source_path,destination_path FROM job_items WHERE job_id=? AND state IN ('Queued','Copying','Verifying')"); q.addBindValue(jobId);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    const auto eventRows = [&] {
        QVector<QVariantList> rows;
        while (q.next()) rows.push_back({q.value(0), q.value(1), q.value(2)});
        return rows;
    }();
    for (const QVariantList &row : eventRows) {
        q.prepare("UPDATE job_items SET state=?,cleanup_state='not_requested' WHERE id=?"); q.addBindValue(state); q.addBindValue(row[0]);
        if (!q.exec() || q.numRowsAffected() != 1 || !appendHistory(db, jobId, row[0].toString(), event, row[1].toString(), row[2].toString(), {}, {}, result, error)) { db.rollback(); return false; }
    }
    if (!db.commit()) { db.rollback(); if (error) *error = db.lastError().text(); return false; }
    return true;
}

// Every abort path uses this single transaction so the ledger cannot claim a
// successful job after an item/history write failed.
bool terminalizeJob(QSqlDatabase &db, const QString &jobId, const SourceFile *current,
                    const QString &destination, const QString &state, const QString &event,
                    const QString &result, QString *error) {
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    QSqlQuery q(db);
    if (current) {
        const QString itemId = stableItemId(jobId, current->relative);
        q.prepare("SELECT state FROM job_items WHERE id=?"); q.addBindValue(itemId);
        if (!q.exec() || !q.next()) { db.rollback(); if (error) *error = q.lastError().text().isEmpty() ? "Missing catalog job item" : q.lastError().text(); return false; }
        if (q.value(0).toString() != state) {
            q.prepare("UPDATE job_items SET state=?,cleanup_state='not_requested' WHERE id=?"); q.addBindValue(state); q.addBindValue(itemId);
            if (!q.exec() || q.numRowsAffected() != 1 || !appendHistory(db, jobId, itemId, event, current->absolute, destination, {}, {}, result, error)) { db.rollback(); return false; }
        }
    }
    q.prepare("SELECT id,source_path,destination_path FROM job_items WHERE job_id=? AND state IN ('Queued','Copying','Verifying')"); q.addBindValue(jobId);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    QVector<QVariantList> pending;
    while (q.next()) pending.push_back({q.value(0), q.value(1), q.value(2)});
    for (const QVariantList &row : pending) {
        q.prepare("UPDATE job_items SET state=?,cleanup_state='not_requested' WHERE id=?"); q.addBindValue(state); q.addBindValue(row[0]);
        if (!q.exec() || q.numRowsAffected() != 1 || !appendHistory(db, jobId, row[0].toString(), event, row[1].toString(), row[2].toString(), {}, {}, result, error)) { db.rollback(); return false; }
    }
    q.prepare("UPDATE jobs SET state=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"); q.addBindValue(state); q.addBindValue(result); q.addBindValue(jobId);
    if (!q.exec() || q.numRowsAffected() != 1) { db.rollback(); if (error) *error = q.lastError().text().isEmpty() ? "Catalog job terminalization failed" : q.lastError().text(); return false; }
    if (!db.commit()) { db.rollback(); if (error) *error = db.lastError().text(); return false; }
    return true;
}

bool setItemState(QSqlDatabase &db, const QString &itemId, const QString &state, QString *error) {
    QSqlQuery q(db); q.prepare("SELECT state FROM job_items WHERE id=?"); q.addBindValue(itemId);
    if (!q.exec()) { if (error) *error = q.lastError().text(); return false; }
    if (q.next() && q.value(0).toString() == "Complete") return true;
    q.prepare("UPDATE job_items SET state=? WHERE id=?"); q.addBindValue(state); q.addBindValue(itemId);
    if (!q.exec()) { if (error) *error = q.lastError().text(); return false; }
    return true;
}

enum class PublishResult { Published, AlreadyExists, Failed };

PublishResult publishNoReplaceFd(int partialFd, int parentFd, const QString &final, QString *error) {
#ifdef __linux__
    const QByteArray name = QFileInfo(final).fileName().toLocal8Bit();
    errno = 0; const int result = ::linkat(partialFd, "", parentFd, name.constData(), AT_EMPTY_PATH); const int saved = errno;
    if (result != 0) { if (saved == EEXIST) return PublishResult::AlreadyExists; if (error) *error = saved == ENOSYS || saved == EINVAL ? "Anonymous fd publication is unavailable" : QString::fromLocal8Bit(strerror(saved)); return PublishResult::Failed; }
    if (::fsync(parentFd) != 0) { if (error) *error = "Destination directory could not be flushed"; return PublishResult::Failed; }
    return PublishResult::Published;
#else
    Q_UNUSED(partialFd); Q_UNUSED(parentFd); Q_UNUSED(final); if (error) *error = "Anonymous fd publication is unavailable"; return PublishResult::Failed;
#endif
}

bool flushPublishedFd(int rootFd, dev_t device, const QString &root, const QString &path, struct stat *verified, QString *error, int *keepFd = nullptr) {
#ifdef __linux__
    const QString relative = QDir(root).relativeFilePath(path);
    const int fd = openBeneathFd(rootFd, relative, O_RDONLY | O_NONBLOCK | O_CLOEXEC, 0, error); struct stat st{};
    if (fd < 0 || ::fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || ::fsync(fd) != 0) { if (fd >= 0) ::close(fd); if (error) *error = "Published destination could not be flushed"; return false; }
    if (verified) *verified = st;
    const int parent = openDestinationParentFd(rootFd, root, path, device, error);
    if (parent < 0 || ::fsync(parent) != 0) { if (parent >= 0) ::close(parent); ::close(fd); if (error) *error = "Destination directory could not be flushed"; return false; }
    ::close(parent); if (keepFd) *keepFd = fd; else ::close(fd); return true;
#else
    Q_UNUSED(rootFd); Q_UNUSED(device); Q_UNUSED(root); Q_UNUSED(path); Q_UNUSED(verified); Q_UNUSED(keepFd); if (error) *error = "Destination durability is unavailable"; return false;
#endif
}

void releaseDatabase(QSqlDatabase &db, const QString &name) {
    db.close();
    db = QSqlDatabase();
    QSqlDatabase::removeDatabase(name);
}
}

QVariantMap VerifiedCopy::Preview::toMap() const {
    return {{"ok", ok}, {"error", error}, {"files", files}, {"bytes", bytes}, {"toCopy", toCopy},
            {"identical", identical}, {"conflicts", conflicts}, {"unsupported", unsupported}, {"freeBytes", freeBytes}};
}

VerifiedCopy::VerifiedCopy(const QString &databasePath, QObject *parent)
    : QObject(parent), m_databasePath(databasePath.isEmpty() ? defaultCatalogPath() : databasePath) {}

VerifiedCopy::~VerifiedCopy() {
    cancel();
    if (m_thread) { m_thread->wait(); delete m_thread; m_thread = nullptr; }
}

QString VerifiedCopy::liveStorageIdentity(const QString &root, QString *error) { return storageIdentity(root, error); }

VerifiedCopy::Preview VerifiedCopy::inspect(const Request &request) {
    Preview result;
    if (request.behavior != "Copy") { result.error = "Move routes are saved but not executable yet"; return result; }
    const QString source = canonicalDir(request.sourceRoot), destination = canonicalDir(request.destinationRoot);
    if (source.isEmpty()) { result.error = "Source folder is unavailable or is a symlink"; return result; }
    if (destination.isEmpty()) { result.error = "Destination folder is unavailable or is a symlink"; return result; }
    if (under(source, destination) || under(destination, source)) { result.error = "Source and destination overlap"; return result; }
    if (!request.selectedStorageRoot.isEmpty()) {
        const QString selectedRoot = canonicalDir(request.selectedStorageRoot);
        if (selectedRoot.isEmpty() || !under(destination, selectedRoot)) { result.error = "Destination is outside the selected storage root"; return result; }
    }
    QString identityError;
    const QString live = storageIdentity(destination, &identityError);
    if (live.isEmpty()) { result.error = identityError; return result; }
    if (request.storageIdentity.isEmpty() || live != request.storageIdentity) { result.error = "Destination storage identity could not be verified"; return result; }
    RootPins pins;
    if (!pinRoots(source, destination, pins, &result.error)) return result;
    if (!liveRootMatches(source, pins.sourceDevice, pins.sourceInode) || !liveRootMatches(destination, pins.destinationDevice, pins.destinationInode)) { result.error = "Selected root changed during preview"; closePins(pins); return result; }
    if (storageIdentity(destination, &identityError) != live) { result.error = "Destination storage identity changed during preview"; closePins(pins); return result; }
    QVector<SourceFile> files;
    QString scanError; scanPinned(pins.source, source, {}, files, result.unsupported, &scanError, previewCancel);
    if (!scanError.isEmpty()) { result.error = scanError; closePins(pins); return result; }
    std::sort(files.begin(), files.end(), [](const SourceFile &a, const SourceFile &b) { return a.relative < b.relative; });
    result.files = files.size();
    for (const SourceFile &file : files) {
        result.manifest.append({file.relative, file.size, file.mtime});
        result.bytes += file.size;
        QString error; struct stat targetStat{};
        if (!statPinned(pins.destination, destination, file.relative, &targetStat, &error)) { result.toCopy += file.size; result.paths.append(file.relative); continue; }
        const bool targetRegular = S_ISREG(targetStat.st_mode);
        if (!targetRegular) { ++result.conflicts; continue; }
        QByteArray sourceHash, targetHash;
        if (!sameFileOpenedFd(pins.source, file.relative, file, &sourceHash, nullptr, &error) || !sameFileOpenedFd(pins.destination, file.relative, file, &targetHash, nullptr, &error)) { result.error = error; closePins(pins); return result; }
        if (sourceHash == targetHash && targetStat.st_size == file.size) ++result.identical;
        else ++result.conflicts;
        if (sourceHash != targetHash || targetStat.st_size != file.size) result.paths.append(file.relative);
    }
    result.freeBytes = QStorageInfo(destination).bytesAvailable();
    if (result.freeBytes < result.toCopy) { result.error = "Not enough free space for this copy"; closePins(pins); return result; }
    result.ok = true;
    closePins(pins);
    return result;
}

QVariantMap VerifiedCopy::routeMap(const QString &routeId) {
    QVariantMap result;
    const QString dbPath = m_databasePath;
    const QString connection = QStringLiteral("route-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    auto db = QSqlDatabase::addDatabase("QSQLITE", connection); db.setDatabaseName(dbPath);
    if (db.open()) {
        QSqlQuery q(db); q.prepare("SELECT r.source_root,r.destination_root,r.behavior,r.destination_storage_id,s.stable_identity,s.selected_root FROM routes r JOIN storage s ON s.id=r.destination_storage_id WHERE r.id=? AND r.enabled=1 AND s.presence='present'"); q.addBindValue(routeId);
        if (q.exec() && q.next()) {
            m_request = Request{q.value(0).toString(), q.value(1).toString(), q.value(5).toString(), q.value(4).toString(), dbPath, routeId, q.value(3).toString(), q.value(2).toString()};
            result = {{"ok", true}};
        } else result = {{"ok", false}, {"error", "Saved destination storage is unavailable"}};
    } else result = {{"ok", false}, {"error", db.lastError().text()}};
    releaseDatabase(db, connection);
    return result;
}

bool VerifiedCopy::previewRoute(const QString &routeId) {
    if (m_running.load() || m_thread != nullptr) return false;
    const QVariantMap route = routeMap(routeId);
    if (!route.value("ok").toBool()) { m_preview = {}; m_preview.error = route.value("error").toString(); emit previewChanged(); return false; }
    m_preview = {};
    emit previewChanged();
    m_cancelled.store(false); m_running.store(true); emit runningChanged(); setStatus("Previewing");
    const Request request = m_request;
    QThread *thread = QThread::create([this, request] {
        previewCancel = &m_cancelled;
        const Preview result = inspect(request);
        previewCancel = nullptr;
        QMetaObject::invokeMethod(this, [this, result] {
            m_preview = result;
            emit previewChanged();
            setStatus(result.ok ? "Preview ready" : "Preview failed");
        }, Qt::QueuedConnection);
    });
    connect(thread, &QThread::finished, this, [this, thread] { thread->deleteLater(); if (m_thread == thread) { m_thread = nullptr; m_running.store(false); emit runningChanged(); } });
    m_thread = thread;
    thread->start();
    return true;
}

bool VerifiedCopy::startCopy() {
    if (m_running.load() || m_thread != nullptr || !m_preview.ok || m_request.behavior != "Copy") return false;
    m_cancelled.store(false); m_running.store(true); emit runningChanged(); setStatus("Copying");
    const Request request = m_request;
    const Preview authorized = m_preview;
    QThread *thread = QThread::create([this, request, authorized] {
        QString error, completion; const bool success = execute(request, authorized, &error, &completion);
        QMetaObject::invokeMethod(this, [this, success, error, completion] {
            setStatus(success ? completion : (error.contains("cancelled") ? QStringLiteral("Cancelled") : QStringLiteral("Failed")));
            emit finished(success, success ? completion : error);
        }, Qt::QueuedConnection);
    });
    connect(thread, &QThread::finished, this, [this, thread] { thread->deleteLater(); if (m_thread == thread) { m_thread = nullptr; m_running.store(false); emit runningChanged(); } });
    m_thread = thread;
    thread->start();
    return true;
}

void VerifiedCopy::cancel() { m_cancelled.store(true); if (m_running.load()) setStatus("Cancelling"); }
void VerifiedCopy::setStatus(const QString &status) { if (m_status == status) return; m_status = status; emit statusChanged(); }

bool VerifiedCopy::executeBlocking(const Request &request, QString *error) { const Preview plan = inspect(request); return plan.ok && execute(request, plan, error); }

bool VerifiedCopy::execute(const Request &request, const Preview &authorized, QString *error, QString *completionMessage) {
    const Preview plan = authorized;
    if (!plan.ok) { if (error) *error = plan.error; return false; }
    const QString sourceRoot = canonicalDir(request.sourceRoot), destinationRoot = canonicalDir(request.destinationRoot);
    PinGuard rootPins;
    QString pinError;
    if (!pinRoots(sourceRoot, destinationRoot, rootPins.pins, &pinError)) { if (error) *error = pinError; return false; }
    QVector<SourceFile> files; qint64 unsupported = 0; QString scanError; scanPinned(rootPins.pins.source, sourceRoot, {}, files, unsupported, &scanError, &m_cancelled);
    if (!scanError.isEmpty()) { if (error) *error = scanError; return false; }
    std::sort(files.begin(), files.end(), [](const SourceFile &a, const SourceFile &b) { return a.relative < b.relative; });
    if (files.size() != plan.manifest.size()) { if (error) *error = "Source changed after preview; manifest no longer matches"; return false; }
    for (int i = 0; i < files.size(); ++i) if (files[i].relative != plan.manifest[i].relative || files[i].size != plan.manifest[i].size || files[i].mtime != plan.manifest[i].mtime) { if (error) *error = "Source changed after preview; manifest no longer matches"; return false; }
    QString connectionError;
    const QString connection = QStringLiteral("copy-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    auto db = QSqlDatabase::addDatabase("QSQLITE", connection);
    db.setDatabaseName(request.databasePath.isEmpty() ? defaultCatalogPath() : request.databasePath);
    if (!db.open()) { if (error) *error = db.lastError().text(); return false; }
    QString routeId, jobId;
    if (!prepareCatalog(db, request, plan, files, routeId, jobId, &connectionError)) { releaseDatabase(db, connection); if (error) *error = connectionError; return false; }
    qint64 done = 0;
    bool conflictSeen = false;
    const auto rootsStillPinned = [&] {
        QString identityError;
        return liveRootMatches(sourceRoot, rootPins.pins.sourceDevice, rootPins.pins.sourceInode) && liveRootMatches(destinationRoot, rootPins.pins.destinationDevice, rootPins.pins.destinationInode) && VerifiedCopy::liveStorageIdentity(destinationRoot, &identityError) == request.storageIdentity;
    };
    for (const SourceFile &source : files) {
        const QString itemId = stableItemId(jobId, source.relative);
        if (m_cancelled.load()) {
            if (!terminalizeJob(db, jobId, &source, QDir(destinationRoot).filePath(source.relative), "Cancelled", "cancelled", "cancelled before file", &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; releaseDatabase(db, connection); return false; }
            releaseDatabase(db, connection); if (error) *error = "Copy cancelled; source retained and no final destination was published"; return false;
        }
        if (!setItemState(db, itemId, "Copying", &connectionError)) { releaseDatabase(db, connection); if (error) *error = connectionError; return false; }
        const QString destination = QDir(destinationRoot).filePath(source.relative);
        QByteArray destinationHash; struct stat boundDestination{}; FdGuard boundDestinationFd;
        if (sameFileOpenedFd(rootPins.pins.destination, source.relative, source, &destinationHash, &boundDestination, &connectionError, &boundDestinationFd.fd)) {
            QString sourceError; QByteArray sourceHash;
            if (!sameFileOpenedFd(rootPins.pins.source, source.relative, source, &sourceHash, nullptr, &sourceError)) { const QString failure = sourceError.isEmpty() ? "Source could not be opened safely" : sourceError; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (sourceHash != destinationHash) { conflictSeen = true; if (!markItemTerminal(db, jobId, source, destination, "Conflict", "conflict", "destination differs", &connectionError)) { if (error) *error = connectionError; releaseDatabase(db, connection); return false; } done += source.size; emit progressChanged(done, plan.bytes, source.relative); continue; }
            if (!rootsStillPinned()) { const QString failure = "Destination storage identity changed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (boundDestinationFd.fd < 0 || ::fsync(boundDestinationFd.fd) != 0) { const QString failure = "Existing destination could not be flushed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            struct stat flushedDestination{};
            if (!flushPublishedFd(rootPins.pins.destination, rootPins.pins.destinationDevice, destinationRoot, destination, &flushedDestination, &connectionError) || flushedDestination.st_dev != boundDestination.st_dev || flushedDestination.st_ino != boundDestination.st_ino) { const QString failure = "Existing destination changed before receipt"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (m_testHook) m_testHook(destination, QStringLiteral("before-existing-receipt"));
            QByteArray receiptHash; struct stat receiptStat{};
            if (!sameFileOpenedFd(rootPins.pins.destination, source.relative, source, &receiptHash, &receiptStat, &connectionError) || receiptHash != sourceHash || receiptStat.st_dev != boundDestination.st_dev || receiptStat.st_ino != boundDestination.st_ino || ::fsync(boundDestinationFd.fd) != 0) { const QString failure = "Existing destination changed before receipt"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (m_testHook) m_testHook(destination, QStringLiteral("before-existing-receipt-final-hash"));
            struct stat finalAfterHook{}; QByteArray hashAfterHook;
            if (!sameFileOpenedFd(rootPins.pins.destination, source.relative, source, &hashAfterHook, &finalAfterHook, &connectionError) || hashAfterHook != sourceHash || finalAfterHook.st_dev != boundDestination.st_dev || finalAfterHook.st_ino != boundDestination.st_ino || ::fsync(boundDestinationFd.fd) != 0) { const QString failure = "Existing destination changed after final hash"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            receiptHash = hashAfterHook;
            if (!rootsStillPinned()) { const QString failure = "Destination storage identity changed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (!recordReceipt(db, request, jobId, source, destination, receiptHash, &connectionError)) { const QString failure = connectionError; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            done += source.size; emit progressChanged(done, plan.bytes, source.relative); continue;
        }
        QString existingError;
        struct stat existingAny{};
        if (statPinned(rootPins.pins.destination, destinationRoot, source.relative, &existingAny, &existingError)) { conflictSeen = true; if (!markItemTerminal(db, jobId, source, destination, "Conflict", "conflict", "destination differs", &connectionError)) { if (error) *error = connectionError; releaseDatabase(db, connection); return false; } done += source.size; emit progressChanged(done, plan.bytes, source.relative); continue; }
        if (!rootsStillPinned()) { const QString failure = "Destination storage identity changed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        QFile sourceFile, partialFile; FdGuard partialParent;
        const int sourceFd = openBeneathFd(rootPins.pins.source, source.relative, O_RDONLY | O_NONBLOCK | O_CLOEXEC, 0, &connectionError);
        struct stat sourceStat{};
        if (sourceFd < 0 || !sourceFile.open(sourceFd, QIODevice::ReadOnly, QFileDevice::AutoCloseHandle) || ::fstat(sourceFile.handle(), &sourceStat) != 0 || !S_ISREG(sourceStat.st_mode) || sourceStat.st_size != source.size || (sourceStat.st_mtim.tv_sec * 1000 + sourceStat.st_mtim.tv_nsec / 1000000) != source.mtime || !openPartialFd(rootPins.pins.destination, rootPins.pins.destinationDevice, destinationRoot, destination, partialFile, &partialParent.fd, &connectionError)) { const QString failure = connectionError.isEmpty() ? "Source changed or anonymous staging could not be opened" : connectionError; if (sourceFile.isOpen()) sourceFile.close(); else if (sourceFd >= 0) ::close(sourceFd); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        QCryptographicHash sourceHash(QCryptographicHash::Sha256); qint64 copied = 0;
        while (!sourceFile.atEnd()) {
            if (m_cancelled.load()) { partialFile.flush(); partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Cancelled", "cancelled", "cancelled during copy", &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = "Copy cancelled; source retained and no final destination was published"; releaseDatabase(db, connection); return false; }
            const QByteArray chunk = sourceFile.read(1024 * 1024);
            if (chunk.isEmpty() && !sourceFile.atEnd()) { const QString failure = sourceFile.errorString(); partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (partialFile.write(chunk) != chunk.size()) { const QString failure = partialFile.errorString(); partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            sourceHash.addData(chunk); copied += chunk.size();
        }
        if (!partialFile.flush()) { const QString failure = partialFile.errorString(); partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        const int partialFd = partialFile.handle();
        if (partialFd < 0 || ::fsync(partialFd) != 0) { const QString failure = "Destination file could not be flushed"; partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        QByteArray verifiedHash; struct stat partialStat{}; FdGuard partialVerifiedFd;
        if (!hashFd(partialFd, source.size, &verifiedHash, &partialStat, &connectionError, &partialVerifiedFd.fd) || verifiedHash != sourceHash.result()) { const QString failure = connectionError.isEmpty() ? "Destination hash mismatch" : connectionError; partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        partialFile.close();
        if (m_testHook) m_testHook(source.absolute, QStringLiteral("before-source-recheck"));
        struct stat sourceAfter{}; const bool sourceStable = ::fstat(sourceFile.handle(), &sourceAfter) == 0 && sourceAfter.st_size == source.size && (sourceAfter.st_mtim.tv_sec * 1000 + sourceAfter.st_mtim.tv_nsec / 1000000) == source.mtime;
        sourceFile.close();
        if (sourceStat.st_size != source.size || (sourceStat.st_mtim.tv_sec * 1000 + sourceStat.st_mtim.tv_nsec / 1000000) != source.mtime || !sourceStable) { if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", "source changed during copy", &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = "Source changed during copy; source retained"; releaseDatabase(db, connection); return false; }
        if (m_testHook) m_testHook(destination, QStringLiteral("before-publish"));
        QString publishError;
        if (!rootsStillPinned()) { const QString failure = "Destination storage identity changed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        if (partialVerifiedFd.fd < 0 || ::fstat(partialVerifiedFd.fd, &partialStat) != 0) { const QString failure = "Verified anonymous partial is unavailable"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        if (m_testHook) m_testHook(destination, QStringLiteral("before-parent-refresh"));
        FdGuard freshParent; struct stat stagingParentStat{}, freshParentStat{};
        if (::fstat(partialParent.fd, &stagingParentStat) != 0 || (freshParent.fd = openDestinationParentFd(rootPins.pins.destination, destinationRoot, destination, rootPins.pins.destinationDevice, &connectionError)) < 0 || ::fstat(freshParent.fd, &freshParentStat) != 0 || stagingParentStat.st_dev != freshParentStat.st_dev || stagingParentStat.st_ino != freshParentStat.st_ino) { const QString failure = "Destination parent changed before publication"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        const PublishResult publication = publishNoReplaceFd(partialVerifiedFd.fd, freshParent.fd, destination, &publishError);
        struct stat publishedStat{}; FdGuard publishedFd;
        if (publication == PublishResult::AlreadyExists) {
            QByteArray existingHash;
            struct stat existingStat{};
            if (sameFileOpenedFd(rootPins.pins.destination, source.relative, source, &existingHash, &existingStat, &connectionError) && existingHash == verifiedHash) {
                if (!flushPublishedFd(rootPins.pins.destination, rootPins.pins.destinationDevice, destinationRoot, destination, &existingStat, &connectionError, &publishedFd.fd)) { const QString failure = connectionError; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
                publishedStat = existingStat;
            }
            else {
                const QString failure = "Destination appeared with different content";
                conflictSeen = true;
                if (!markItemTerminal(db, jobId, source, destination, "Conflict", "conflict", failure, &connectionError)) { if (error) *error = connectionError; releaseDatabase(db, connection); return false; }
                done += source.size; emit progressChanged(done, plan.bytes, source.relative); continue;
            }
        } else if (publication == PublishResult::Failed) {
            if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", publishError, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = publishError; releaseDatabase(db, connection); return false;
        }
        if (m_failAfterPublishOnce.exchange(false)) { if (error) *error = "Test fault after publication; retry is safe"; releaseDatabase(db, connection); return false; }
        if (publication == PublishResult::Published && (!flushPublishedFd(rootPins.pins.destination, rootPins.pins.destinationDevice, destinationRoot, destination, &publishedStat, &connectionError, &publishedFd.fd) || publishedStat.st_dev != partialStat.st_dev || publishedStat.st_ino != partialStat.st_ino)) { const QString failure = "Published destination inode did not match verified partial"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        if (!rootsStillPinned()) { const QString failure = "Destination storage identity changed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        QByteArray receiptHash; struct stat receiptStat{};
        struct stat pinnedFinal{};
        if (publishedFd.fd < 0 || ::fstat(publishedFd.fd, &pinnedFinal) != 0 || !sameFileOpenedFd(rootPins.pins.destination, source.relative, source, &receiptHash, &receiptStat, &connectionError) || receiptHash != verifiedHash || receiptStat.st_dev != publishedStat.st_dev || receiptStat.st_ino != publishedStat.st_ino || pinnedFinal.st_dev != publishedStat.st_dev || pinnedFinal.st_ino != publishedStat.st_ino) { const QString failure = "Published destination changed before receipt"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        if (m_testHook) m_testHook(destination, QStringLiteral("before-receipt-final-hash"));
        struct stat finalAfterHook{}; QByteArray hashAfterHook;
        if (!sameFileOpenedFd(rootPins.pins.destination, source.relative, source, &hashAfterHook, &finalAfterHook, &connectionError) || hashAfterHook != verifiedHash || finalAfterHook.st_dev != publishedStat.st_dev || finalAfterHook.st_ino != publishedStat.st_ino || ::fstat(publishedFd.fd, &pinnedFinal) != 0 || pinnedFinal.st_dev != publishedStat.st_dev || pinnedFinal.st_ino != publishedStat.st_ino) { const QString failure = "Published destination changed after final hash"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        receiptHash = hashAfterHook;
        if (!rootsStillPinned()) { const QString failure = "Destination storage identity changed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        if (!recordReceipt(db, request, jobId, source, destination, receiptHash, &connectionError)) { const QString failure = connectionError; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        done += copied; emit progressChanged(done, plan.bytes, source.relative);
    }
    QSqlQuery final(db); final.prepare("UPDATE jobs SET state=?,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?"); final.addBindValue(conflictSeen ? "Conflict" : "Complete"); final.addBindValue(jobId);
    if (!final.exec()) { if (error) *error = final.lastError().text(); final.finish(); releaseDatabase(db, connection); return false; }
    final.finish();
    if (completionMessage) *completionMessage = conflictSeen ? QStringLiteral("Completed with conflicts") : QStringLiteral("Complete");
    releaseDatabase(db, connection); return true;
}
