#include "verifiedcopy.h"
#include "remoteinventory.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QStorageInfo>
#include <QStandardPaths>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QImageReader>
#include <QSaveFile>
#include <QSet>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QThread>
#include <QTextStream>
#include <QUuid>
#include <KIO/CopyJob>
#include <KIO/DeleteJob>
#include <KIO/FileCopyJob>
#include <KIO/Global>
#include <KIO/MkdirJob>
#include <KIO/StatJob>
#include <KIO/TransferJob>
#include <algorithm>
#include <cstring>
#include <limits>

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
struct SourceFile { QString relative; QString absolute; QString destinationRelative; qint64 size = 0; qint64 mtime = 0; };
struct CleanupItem { QString id; SourceFile source; QString destination; QByteArray hash; };
struct RootPins { int source = -1; int destination = -1; dev_t sourceDevice = 0; ino_t sourceInode = 0; dev_t destinationDevice = 0; ino_t destinationInode = 0; };
thread_local const std::atomic_bool *previewCancel = nullptr;

struct PreviewCancelScope {
    explicit PreviewCancelScope(const std::atomic_bool *cancelled) : previous(previewCancel) { previewCancel = cancelled; }
    ~PreviewCancelScope() { previewCancel = previous; }
    const std::atomic_bool *previous;
};

qint64 cleanupCutoff(const QString &policy) {
    if (policy == QStringLiteral("Nothing")) return std::numeric_limits<qint64>::max();
    if (policy == QStringLiteral("Last day")) return QDateTime::currentDateTimeUtc().addDays(-1).toMSecsSinceEpoch();
    if (policy == QStringLiteral("Last week")) return QDateTime::currentDateTimeUtc().addDays(-7).toMSecsSinceEpoch();
    return QDateTime::currentDateTimeUtc().addMonths(-1).toMSecsSinceEpoch();
}

void closePins(RootPins &pins) { if (pins.source >= 0) ::close(pins.source); if (pins.destination >= 0) ::close(pins.destination); pins.source = pins.destination = -1; }
struct PinGuard { RootPins pins; ~PinGuard() { closePins(pins); } };
struct FdGuard { int fd = -1; ~FdGuard() { if (fd >= 0) ::close(fd); } };
struct NamedPartialGuard { int parent = -1; QByteArray name; ~NamedPartialGuard() { if (parent >= 0 && !name.isEmpty()) ::unlinkat(parent, name.constData(), 0); } void release() { name.clear(); } };

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

QString stableErrorCode(const QString &message) {
    const QString text = message.toLower();
    if (text.contains("cancel")) return QStringLiteral("cancelled");
    if (text.contains("interrupted before restart")) return QStringLiteral("interrupted");
    if (text.contains("source changed")) return QStringLiteral("source_changed");
    if (text.contains("permission")) return QStringLiteral("permission_denied");
    if (text.contains("not enough free space") || text.contains("staging limit")) return QStringLiteral("insufficient_space");
    if (text.contains("destination folder is unavailable") || text.contains("destination is outside")) return QStringLiteral("destination_unavailable");
    if (text.contains("storage identity") || text.contains("wrong device")) return QStringLiteral("destination_wrong_device");
    if (text.contains("conflict") || text.contains("different content") || text == QStringLiteral("destination differs")) return QStringLiteral("name_conflict");
    if (text.contains("hash mismatch")) return QStringLiteral("destination_hash_mismatch");
    if (text.contains("trash")) return QStringLiteral("unsupported_trash");
    if (text.contains("catalog") || text.contains("ledger")) return QStringLiteral("catalog_error");
    if (text.contains("source") || text.contains("read")) return QStringLiteral("read_error");
    if (text.contains("destination") || text.contains("write") || text.contains("flush") || text.contains("publication")) return QStringLiteral("write_error");
    return QStringLiteral("operation_failed");
}

QString nextActionForError(const QString &code) {
    if (code == QStringLiteral("cancelled")) return QStringLiteral("Run preview again when ready.");
    if (code == QStringLiteral("interrupted")) return QStringLiteral("Retry the transfer; verified destinations remain safe.");
    if (code == QStringLiteral("source_changed")) return QStringLiteral("Rescan the source and preview again.");
    if (code == QStringLiteral("permission_denied")) return QStringLiteral("Fix the reported permissions, then preview again.");
    if (code == QStringLiteral("insufficient_space")) return QStringLiteral("Free space or lower the safety margin, then preview again.");
    if (code == QStringLiteral("destination_wrong_device")) return QStringLiteral("Reconnect the exact destination disk, then preview again.");
    if (code == QStringLiteral("destination_unavailable")) return QStringLiteral("Reconnect the destination and check its folder, then preview again.");
    if (code == QStringLiteral("name_conflict")) return QStringLiteral("Review the conflicting destination before retrying.");
    if (code == QStringLiteral("destination_hash_mismatch")) return QStringLiteral("Keep the source and retry after checking the destination disk.");
    if (code == QStringLiteral("unsupported_trash")) return QStringLiteral("Keep the source and retry cleanup when system Trash is available.");
    if (code == QStringLiteral("catalog_error")) return QStringLiteral("Keep the source and repair or reopen the catalog before retrying.");
    if (code == QStringLiteral("write_error")) return QStringLiteral("Check destination access and disk health, then preview again.");
    if (code == QStringLiteral("read_error")) return QStringLiteral("Restore source access, then preview again.");
    return QStringLiteral("Fix the reported problem, then preview again.");
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

void scanPinned(int dirFd, const QString &root, const QString &relative, QVector<SourceFile> &files, qint64 &unsupported, QStringList &unsupportedPaths, QStringList &unsupportedEvidence, QString *scanError, const std::atomic_bool *cancelled) {
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
        // Root-level .templates is application data, not transferable library content.
        if (relative.isEmpty() && name == ".templates") continue;
        const QString child = relative.isEmpty() ? name : relative + "/" + name;
        struct stat st{};
        if (::fstatat(dirFd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) { if (scanError) *scanError = QString::fromLocal8Bit(strerror(errno)); break; }
        if (S_ISLNK(st.st_mode)) { ++unsupported; unsupportedPaths.append(child); unsupportedEvidence.append(child + QStringLiteral("\nsymlink")); continue; }
        if (S_ISDIR(st.st_mode)) {
            const int childFd = ::openat(dirFd, entry->d_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
            if (childFd < 0) { if (scanError) *scanError = QString::fromLocal8Bit(strerror(errno)); break; }
            scanPinned(childFd, root, child, files, unsupported, unsupportedPaths, unsupportedEvidence, scanError, cancelled); ::close(childFd);
            if (scanError && !scanError->isEmpty()) break;
        } else if (S_ISREG(st.st_mode)) {
            const qint64 mtime = st.st_mtim.tv_sec * 1000 + st.st_mtim.tv_nsec / 1000000;
            files.push_back({child, QDir(root).filePath(child), {}, st.st_size, mtime});
        } else { ++unsupported; unsupportedPaths.append(child); unsupportedEvidence.append(child + QStringLiteral("\nmode:") + QString::number(st.st_mode & S_IFMT)); }
    }
    ::closedir(dir);
#else
    Q_UNUSED(dirFd); Q_UNUSED(root); Q_UNUSED(relative); Q_UNUSED(files); Q_UNUSED(unsupported); Q_UNUSED(unsupportedPaths); Q_UNUSED(unsupportedEvidence); Q_UNUSED(scanError); Q_UNUSED(cancelled);
#endif
}

bool excludeSources(QVector<SourceFile> &files, const QStringList &requested, QString *error) {
    if (requested.isEmpty()) return true;
    QSet<QString> excluded;
    for (const QString &raw : requested) {
        const QString path = QDir::cleanPath(raw);
        if (path.isEmpty() || path == "." || path == ".." || path.startsWith("../") || path.contains("/../") || QFileInfo(path).isAbsolute()) {
            if (error) *error = "Accepted duplicate path is unsafe"; return false;
        }
        excluded.insert(path);
    }
    const qsizetype before = files.size();
    files.erase(std::remove_if(files.begin(), files.end(), [&](const SourceFile &file) { return excluded.contains(file.relative); }), files.end());
    if (before - files.size() != excluded.size()) { if (error) *error = "Accepted duplicate evidence changed; preview again"; return false; }
    return true;
}

QDateTime parseMediaDate(const QString &value) {
    const QString text = value.trimmed();
    for (const QString &format : {QStringLiteral("yyyy:MM:dd HH:mm:ss"), QStringLiteral("yyyy-MM-dd HH:mm:ss"), QStringLiteral("yyyy-MM-dd"), QStringLiteral("yyyy/MM/dd HH:mm:ss")}) {
        const QDateTime date = QDateTime::fromString(text, format);
        if (date.isValid()) return date;
    }
    const QDateTime iso = QDateTime::fromString(text, Qt::ISODate);
    return iso.isValid() ? iso : QDateTime();
}

QString jpegExifDateTimeOriginal(const QString &path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return {};
    // ponytail: inspect only the JPEG header window; full media indexing belongs to the later Gallery phase.
    const QByteArray data = file.read(128 * 1024);
    if (data.size() < 4 || static_cast<uchar>(data[0]) != 0xff || static_cast<uchar>(data[1]) != 0xd8) return {};
    const auto u16be = [&data](int offset) -> quint16 { return (static_cast<quint16>(static_cast<uchar>(data[offset])) << 8) | static_cast<quint16>(static_cast<uchar>(data[offset + 1])); };
    for (int position = 2; position + 4 <= data.size();) {
        if (static_cast<uchar>(data[position]) != 0xff) { ++position; continue; }
        const uchar marker = static_cast<uchar>(data[position + 1]);
        position += 2;
        if (marker == 0xda || marker == 0xd9) break;
        if (position + 2 > data.size()) break;
        const int segmentLength = u16be(position);
        if (segmentLength < 2 || position + segmentLength > data.size()) break;
        const int payload = position + 2;
        if (marker == 0xe1 && segmentLength >= 8 && data.mid(payload, 6) == QByteArrayLiteral("Exif\0\0")) {
            const int tiff = payload + 6;
            if (tiff + 8 > data.size()) return {};
            const bool little = data[tiff] == 'I' && data[tiff + 1] == 'I';
            if (!little && !(data[tiff] == 'M' && data[tiff + 1] == 'M')) return {};
            const auto u16 = [&](int offset) -> quint16 {
                return little ? static_cast<quint16>(static_cast<uchar>(data[offset]) | (static_cast<quint16>(static_cast<uchar>(data[offset + 1])) << 8)) : u16be(offset);
            };
            const auto u32 = [&](int offset) -> quint32 {
                if (little) return static_cast<quint32>(static_cast<uchar>(data[offset])) | (static_cast<quint32>(static_cast<uchar>(data[offset + 1])) << 8) | (static_cast<quint32>(static_cast<uchar>(data[offset + 2])) << 16) | (static_cast<quint32>(static_cast<uchar>(data[offset + 3])) << 24);
                return (static_cast<quint32>(static_cast<uchar>(data[offset])) << 24) | (static_cast<quint32>(static_cast<uchar>(data[offset + 1])) << 16) | (static_cast<quint32>(static_cast<uchar>(data[offset + 2])) << 8) | static_cast<quint32>(static_cast<uchar>(data[offset + 3]));
            };
            const auto ifdDate = [&](auto &&self, int ifdOffset, bool followExifPointer) -> QString {
                const int ifd = tiff + ifdOffset;
                if (ifd < tiff || ifd + 2 > data.size()) return {};
                const quint16 count = u16(ifd);
                if (count > 512 || ifd + 2 + count * 12 > data.size()) return {};
                for (quint16 index = 0; index < count; ++index) {
                    const int entry = ifd + 2 + index * 12;
                    const quint16 tag = u16(entry);
                    const quint16 type = u16(entry + 2);
                    const quint32 valueCount = u32(entry + 4);
                    const quint32 typeSize = type == 2 ? 1 : type == 3 ? 2 : type == 4 ? 4 : 0;
                    if (typeSize == 0 || valueCount == 0 || valueCount > 1024 || valueCount > std::numeric_limits<quint32>::max() / typeSize) continue;
                    const quint32 byteCount = valueCount * typeSize;
                    if (followExifPointer && tag == 0x8769 && type == 4 && valueCount == 1) {
                        const QString nested = self(self, static_cast<int>(u32(entry + 8)), false);
                        if (!nested.isEmpty()) return nested;
                        continue;
                    }
                    const quint32 valueOffset = byteCount <= 4 ? static_cast<quint32>(entry + 8 - tiff) : u32(entry + 8);
                    const quint64 valueEnd = static_cast<quint64>(tiff) + valueOffset + byteCount;
                    if (valueEnd > static_cast<quint64>(data.size())) continue;
                    if (tag == 0x9003 && type == 2) {
                        QString value = QString::fromLatin1(data.constData() + tiff + valueOffset, static_cast<int>(valueCount)).trimmed();
                        if (const int nul = value.indexOf(QChar::Null); nul >= 0) value.truncate(nul);
                        return value;
                    }
                }
                return {};
            };
            const quint32 firstIfd = u32(tiff + 4);
            const QString date = ifdDate(ifdDate, static_cast<int>(firstIfd), true);
            if (!date.isEmpty()) return date;
        }
        position += segmentLength;
    }
    return {};
}

bool isMediaFile(const QString &path) {
    static const QSet<QString> extensions = {QStringLiteral("jpg"), QStringLiteral("jpeg"), QStringLiteral("png"), QStringLiteral("heic"), QStringLiteral("heif"), QStringLiteral("webp"), QStringLiteral("gif"), QStringLiteral("tif"), QStringLiteral("tiff"), QStringLiteral("avif"), QStringLiteral("mp4"), QStringLiteral("mov"), QStringLiteral("m4v"), QStringLiteral("avi"), QStringLiteral("mkv"), QStringLiteral("webm"), QStringLiteral("3gp")};
    return extensions.contains(QFileInfo(path).suffix().toLower());
}

QString sidecarStem(const QString &path) {
    static const QSet<QString> extensions = {QStringLiteral("xmp"), QStringLiteral("json"), QStringLiteral("aae"), QStringLiteral("thm")};
    const QString suffix = QFileInfo(path).suffix().toLower();
    return extensions.contains(suffix) ? QFileInfo(path).completeBaseName().toCaseFolded() : QString();
}

int mediaYear(const SourceFile &file) {
    const QDateTime exif = parseMediaDate(jpegExifDateTimeOriginal(file.absolute));
    if (exif.isValid() && exif.date().year() >= 1970 && exif.date().year() <= 2100) return exif.date().year();
    QImageReader reader(file.absolute);
    QSet<QString> keys;
    for (const QString &key : reader.textKeys()) keys.insert(key);
    keys.unite({QStringLiteral("DateTimeOriginal"), QStringLiteral("DateTime"), QStringLiteral("date-time-original")});
    for (const QString &key : keys) {
        const QString normalized = key.toLower().remove(' ').remove('_').remove('-');
        if (!normalized.contains(QStringLiteral("datetimeoriginal")) && normalized != QStringLiteral("datetime") && normalized != QStringLiteral("date")) continue;
        const QDateTime date = parseMediaDate(reader.text(key));
        if (date.isValid() && date.date().year() >= 1970 && date.date().year() <= 2100) return date.date().year();
    }
    const QDateTime birth = QFileInfo(file.absolute).birthTime();
    if (birth.isValid() && birth.date().year() >= 1970 && birth.date().year() <= 2100) return birth.date().year();
    const QDateTime modified = file.mtime > 0 ? QDateTime::fromMSecsSinceEpoch(file.mtime) : QDateTime();
    return modified.isValid() && modified.date().year() >= 1970 && modified.date().year() <= 2100 ? modified.date().year() : 0;
}

void assignDestinationPaths(const VerifiedCopy::Request &request, QVector<SourceFile> &files) {
    for (SourceFile &file : files) file.destinationRelative = file.relative;
    if (request.organizePhotos) {
        QHash<QString, QString> organizedByStem;
        for (const SourceFile &file : files) {
            if (file.relative.contains('/') || !isMediaFile(file.relative)) continue;
            const int year = mediaYear(file);
            const QString folder = year > 0 ? QStringLiteral("Local Drive/Gallery/%1").arg(year) : QStringLiteral("Local Drive/Gallery/Unknown date");
            const QString destination = folder + "/" + QFileInfo(file.relative).fileName();
            organizedByStem.insert(QFileInfo(file.relative).completeBaseName().toCaseFolded(), destination);
        }
        for (SourceFile &file : files) {
            if (!file.relative.contains('/') && isMediaFile(file.relative)) file.destinationRelative = organizedByStem.value(QFileInfo(file.relative).completeBaseName().toCaseFolded(), file.relative);
            else if (!file.relative.contains('/') && !sidecarStem(file.relative).isEmpty()) {
                const QString destination = organizedByStem.value(sidecarStem(file.relative));
                if (!destination.isEmpty()) file.destinationRelative = QFileInfo(destination).path() + "/" + QFileInfo(file.relative).fileName();
            }
        }
    }
    for (SourceFile &file : files) if (request.destinationOverrides.contains(file.relative)) file.destinationRelative = request.destinationOverrides.value(file.relative);
}

bool validateDestinationOverrides(const VerifiedCopy::Request &request, const QVector<SourceFile> &files, QString *error) {
    QSet<QString> sources, destinations;
    for (const SourceFile &file : files) {
        sources.insert(file.relative);
        const QString path = QDir::cleanPath(file.destinationRelative);
        if (path.isEmpty() || path == "." || path == ".." || path.startsWith("../") || path.contains("/../") || QFileInfo(path).isAbsolute() || destinations.contains(path)) {
            if (error) *error = "Import destination decision is unsafe; preview again";
            return false;
        }
        destinations.insert(path);
    }
    for (auto it = request.destinationOverrides.cbegin(); it != request.destinationOverrides.cend(); ++it) {
        if (!sources.contains(it.key())) { if (error) *error = "Conflict evidence changed; preview again"; return false; }
    }
    return true;
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

bool openPartialFd(int rootFd, dev_t device, const QString &root, const QString &finalPath, QFile &file, int *parentOut, QString *namedPartial, QString *error) {
#ifdef __linux__
    const int parentFd = openDestinationParentFd(rootFd, root, finalPath, device, error);
    if (parentFd < 0) return false;
    int partialFd = ::openat(parentFd, ".", O_TMPFILE | O_RDWR | O_CLOEXEC, 0600);
    QString partialName;
    if (partialFd < 0 && (errno == EOPNOTSUPP || errno == EINVAL || errno == EISDIR)) {
        partialName = QStringLiteral(".local-drive-%1.partial").arg(QUuid::createUuid().toString(QUuid::Id128));
        partialFd = ::openat(parentFd, partialName.toLocal8Bit().constData(), O_CREAT | O_EXCL | O_NOFOLLOW | O_RDWR | O_CLOEXEC, 0600);
    }
    if (partialFd < 0) { const int saved = errno; ::close(parentFd); if (error) *error = QString::fromLocal8Bit(strerror(saved)); return false; }
    if (!file.open(partialFd, QIODevice::WriteOnly, QFileDevice::AutoCloseHandle)) { ::close(partialFd); ::close(parentFd); if (error) *error = file.errorString(); return false; }
    if (namedPartial) *namedPartial = partialName;
    if (parentOut) *parentOut = parentFd; else ::close(parentFd);
    return true;
#else
    Q_UNUSED(rootFd); Q_UNUSED(device); Q_UNUSED(root); Q_UNUSED(finalPath); Q_UNUSED(file); Q_UNUSED(parentOut); Q_UNUSED(namedPartial); if (error) *error = "Linux staging is unavailable"; return false;
#endif
}

bool openPartialFd(int rootFd, dev_t device, const QString &root, const QString &finalPath, QFile &file, int *parentOut, QString *error) {
    return openPartialFd(rootFd, device, root, finalPath, file, parentOut, nullptr, error);
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

bool ensureCatalogColumn(QSqlDatabase &db, const QString &table, const QString &column, const QString &definition, QString *error) {
    QSqlQuery columns(db);
    if (!columns.exec(QStringLiteral("PRAGMA table_info(%1)").arg(table))) { if (error) *error = columns.lastError().text(); return false; }
    while (columns.next()) if (columns.value(1).toString() == column) return true;
    QSqlQuery alter(db);
    if (!alter.exec(QStringLiteral("ALTER TABLE %1 ADD COLUMN %2").arg(table, definition))) { if (error) *error = alter.lastError().text(); return false; }
    return true;
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
        if (!q.exec("SELECT version FROM schema_version WHERE singleton=1") || !q.next()) { if (error) *error = "Unsupported catalog schema version"; return false; }
        const int version = q.value(0).toInt();
        if (version == 1) {
            QString migrationError;
            if (!db.transaction()
                || !ensureCatalogColumn(db, "routes", "keep_policy", "keep_policy TEXT NOT NULL DEFAULT 'Everything' CHECK (keep_policy IN ('Everything', 'Last month', 'Last week', 'Last day', 'Nothing'))", &migrationError)
                || !ensureCatalogColumn(db, "jobs", "keep_policy", "keep_policy TEXT NOT NULL DEFAULT 'Everything' CHECK (keep_policy IN ('Everything', 'Last month', 'Last week', 'Last day', 'Nothing'))", &migrationError)
                || !ensureCatalogColumn(db, "storage", "filesystem_type", "filesystem_type TEXT", &migrationError)
                || !ensureCatalogColumn(db, "routes", "staging_max_bytes", "staging_max_bytes INTEGER CHECK (staging_max_bytes IS NULL OR staging_max_bytes >= 0)", &migrationError)
                || !ensureCatalogColumn(db, "routes", "minimum_free_bytes", "minimum_free_bytes INTEGER CHECK (minimum_free_bytes IS NULL OR minimum_free_bytes >= 0)", &migrationError)
                || !ensureCatalogColumn(db, "routes", "organize_photos", "organize_photos INTEGER NOT NULL DEFAULT 0 CHECK (organize_photos IN (0, 1))", &migrationError)
                || !q.exec("UPDATE routes SET keep_policy='Nothing' WHERE behavior='Move'")
                || !q.exec("UPDATE jobs SET keep_policy='Nothing' WHERE behavior='Move'")
                || !q.exec("UPDATE schema_version SET version=2,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = migrationError.isEmpty() ? q.lastError().text() : migrationError; return false; }
        }
        if (version <= 2) {
            QString migrationError;
            if (!db.transaction()
                || !ensureCatalogColumn(db, "routes", "staging_root", "staging_root TEXT CHECK (staging_root IS NULL OR staging_root <> '')", &migrationError)
                || !q.exec("UPDATE schema_version SET version=3,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = migrationError.isEmpty() ? q.lastError().text() : migrationError; return false; }
        }
        if (version <= 3) {
            QString migrationError;
            if (!db.transaction()
                || !ensureCatalogColumn(db, "routes", "content_type", "content_type TEXT NOT NULL DEFAULT 'Drive' CHECK (content_type IN ('Drive', 'Photos'))", &migrationError)
                || !q.exec("UPDATE routes SET content_type='Photos' WHERE organize_photos=1")
                || !q.exec("UPDATE schema_version SET version=4,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = migrationError.isEmpty() ? q.lastError().text() : migrationError; return false; }
        }
        if (version <= 4) {
            QString migrationError;
            if (!db.transaction()
                || !ensureCatalogColumn(db, "devices", "onboarding_seen", "onboarding_seen INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_seen IN (0, 1))", &migrationError)
                || !ensureCatalogColumn(db, "devices", "hidden", "hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))", &migrationError)
                || !ensureCatalogColumn(db, "storage", "onboarding_seen", "onboarding_seen INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_seen IN (0, 1))", &migrationError)
                || !ensureCatalogColumn(db, "storage", "hidden", "hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))", &migrationError)
                || !q.exec("UPDATE devices SET onboarding_seen=1 WHERE is_local=0")
                || !q.exec("UPDATE storage SET onboarding_seen=1 WHERE kind<>'local'")
                || !q.exec("UPDATE schema_version SET version=5,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = migrationError.isEmpty() ? q.lastError().text() : migrationError; return false; }
        }
        if (version <= 5) {
            if (!db.transaction()
                || !q.exec("CREATE TABLE IF NOT EXISTS device_aliases (alias TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, transport TEXT NOT NULL CHECK (transport IN ('mtp', 'wireless')), last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
                || !q.exec("UPDATE schema_version SET version=6,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        }
        if (version <= 6) {
            if (!db.transaction()
                || !q.exec("CREATE TABLE IF NOT EXISTS metadata_events (id TEXT PRIMARY KEY,origin_device_id TEXT NOT NULL REFERENCES devices(id),catalog_generation INTEGER NOT NULL CHECK (catalog_generation > 0),origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),item_id TEXT NOT NULL CHECK (item_id <> ''),source_root TEXT NOT NULL CHECK (source_root IN ('Drive','DCIM')),relative_path TEXT NOT NULL,size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),modified_at INTEGER NOT NULL CHECK (modified_at >= 0),captured_at TEXT,type_hint TEXT,media_metadata TEXT NOT NULL DEFAULT '{}',content_sha256 TEXT,received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(origin_device_id,catalog_generation,origin_sequence))")
                || !q.exec("CREATE TABLE IF NOT EXISTS pending_metadata (origin_device_id TEXT NOT NULL REFERENCES devices(id),item_id TEXT NOT NULL CHECK (item_id <> ''),source_root TEXT NOT NULL CHECK (source_root IN ('Drive','DCIM')),relative_path TEXT NOT NULL,size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),modified_at INTEGER NOT NULL CHECK (modified_at >= 0),captured_at TEXT,type_hint TEXT,media_metadata TEXT NOT NULL DEFAULT '{}',content_sha256 TEXT,origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','complete','review')),updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(origin_device_id,item_id))")
                || !q.exec("CREATE TABLE IF NOT EXISTS metadata_cursors (origin_device_id TEXT NOT NULL REFERENCES devices(id),catalog_generation INTEGER NOT NULL CHECK (catalog_generation > 0),highest_contiguous INTEGER NOT NULL DEFAULT 0 CHECK (highest_contiguous >= 0),updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(origin_device_id,catalog_generation))")
                || !q.exec("UPDATE schema_version SET version=7,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        }
        if (version <= 7) {
            if (!db.transaction()
                || !q.exec("CREATE TABLE IF NOT EXISTS review_items (id TEXT PRIMARY KEY,category TEXT NOT NULL CHECK (category IN ('Duplicates','Conflicts','Permissions','Transfers','Storage','External changes','Unsupported')),source_kind TEXT NOT NULL CHECK (source_kind IN ('import','job','metadata','system')),source_id TEXT NOT NULL CHECK (source_id <> ''),title TEXT NOT NULL CHECK (title <> ''),summary TEXT NOT NULL DEFAULT '',details_json TEXT NOT NULL DEFAULT '{}',item_count INTEGER NOT NULL DEFAULT 1 CHECK (item_count > 0),bytes_total INTEGER NOT NULL DEFAULT 0 CHECK (bytes_total >= 0),state TEXT NOT NULL DEFAULT 'needs_decision' CHECK (state IN ('needs_decision','needs_device','can_retry','saved','resolved','dismissed')),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,resolved_at TEXT,UNIQUE(source_kind,source_id,category))")
                || !q.exec("UPDATE schema_version SET version=8,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        }
        if (version <= 8) {
            if (!db.transaction()
                || !q.exec("CREATE TABLE IF NOT EXISTS managed_inventory (route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,relative_path TEXT NOT NULL CHECK (relative_path <> '' AND relative_path NOT LIKE '/%' AND relative_path <> '..' AND relative_path NOT LIKE '../%' AND relative_path NOT LIKE '%/../%' AND relative_path NOT LIKE '%/..'),size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),modified_ms INTEGER NOT NULL CHECK (modified_ms >= 0),content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64 AND content_sha256=lower(content_sha256) AND content_sha256 NOT GLOB '*[^0-9a-f]*'),state TEXT NOT NULL DEFAULT 'present' CHECK (state IN ('present','missing')),first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(route_id,relative_path))")
                || !q.exec("CREATE TABLE IF NOT EXISTS inventory_events (id TEXT PRIMARY KEY,origin_device_id TEXT NOT NULL REFERENCES devices(id),catalog_generation INTEGER NOT NULL CHECK (catalog_generation > 0),origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),route_id TEXT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,event TEXT NOT NULL CHECK (event IN ('added','changed','missing','reappeared')),relative_path TEXT NOT NULL,previous_sha256 TEXT,current_sha256 TEXT,size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(origin_device_id,catalog_generation,origin_sequence),CHECK (previous_sha256 IS NULL OR (length(previous_sha256)=64 AND previous_sha256=lower(previous_sha256) AND previous_sha256 NOT GLOB '*[^0-9a-f]*')),CHECK (current_sha256 IS NULL OR (length(current_sha256)=64 AND current_sha256=lower(current_sha256) AND current_sha256 NOT GLOB '*[^0-9a-f]*')))")
                || !q.exec("CREATE TRIGGER IF NOT EXISTS inventory_events_immutable_update BEFORE UPDATE ON inventory_events BEGIN SELECT RAISE(ABORT, 'inventory events are append-only'); END")
                || !q.exec("CREATE TRIGGER IF NOT EXISTS inventory_events_immutable_delete BEFORE DELETE ON inventory_events BEGIN SELECT RAISE(ABORT, 'inventory events are append-only'); END")
                || !q.exec("UPDATE schema_version SET version=9,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        }
        if (version <= 9) {
            if (!db.transaction()
                || !q.exec("CREATE TABLE IF NOT EXISTS review_resolutions (id TEXT PRIMARY KEY,origin_device_id TEXT NOT NULL REFERENCES devices(id),catalog_generation INTEGER NOT NULL CHECK (catalog_generation > 0),origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),review_item_id TEXT NOT NULL REFERENCES review_items(id),action TEXT NOT NULL CHECK (action IN ('save','dismiss')),evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256)=64 AND evidence_sha256=lower(evidence_sha256) AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),details_json TEXT NOT NULL DEFAULT '{}',result_state TEXT NOT NULL DEFAULT 'applied_local' CHECK (result_state IN ('applied_local','pending_device','failed')),occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(origin_device_id,catalog_generation,origin_sequence))")
                || !q.exec("CREATE TRIGGER IF NOT EXISTS review_resolutions_immutable_update BEFORE UPDATE ON review_resolutions BEGIN SELECT RAISE(ABORT, 'review resolutions are append-only'); END")
                || !q.exec("CREATE TRIGGER IF NOT EXISTS review_resolutions_immutable_delete BEFORE DELETE ON review_resolutions BEGIN SELECT RAISE(ABORT, 'review resolutions are append-only'); END")
                || !q.exec("UPDATE schema_version SET version=10,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        }
        if (version <= 10) {
            if (!db.transaction()
                || !q.exec("DROP TRIGGER IF EXISTS review_resolutions_immutable_update")
                || !q.exec("DROP TRIGGER IF EXISTS review_resolutions_immutable_delete")
                || !q.exec("ALTER TABLE review_resolutions RENAME TO review_resolutions_v10")
                || !q.exec("CREATE TABLE review_resolutions (id TEXT PRIMARY KEY,origin_device_id TEXT NOT NULL REFERENCES devices(id),catalog_generation INTEGER NOT NULL CHECK (catalog_generation > 0),origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),review_item_id TEXT NOT NULL REFERENCES review_items(id),action TEXT NOT NULL CHECK (action IN ('save','dismiss','accept_existing')),evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256)=64 AND evidence_sha256=lower(evidence_sha256) AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),details_json TEXT NOT NULL DEFAULT '{}',result_state TEXT NOT NULL DEFAULT 'applied_local' CHECK (result_state IN ('applied_local','pending_device','failed')),occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(origin_device_id,catalog_generation,origin_sequence))")
                || !q.exec("INSERT INTO review_resolutions SELECT * FROM review_resolutions_v10")
                || !q.exec("DROP TABLE review_resolutions_v10")
                || !q.exec("CREATE TRIGGER review_resolutions_immutable_update BEFORE UPDATE ON review_resolutions BEGIN SELECT RAISE(ABORT, 'review resolutions are append-only'); END")
                || !q.exec("CREATE TRIGGER review_resolutions_immutable_delete BEFORE DELETE ON review_resolutions BEGIN SELECT RAISE(ABORT, 'review resolutions are append-only'); END")
                || !q.exec("UPDATE schema_version SET version=11,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        }
        if (version <= 11) {
            if (!db.transaction()
                || !q.exec("DROP TRIGGER IF EXISTS review_resolutions_immutable_update")
                || !q.exec("DROP TRIGGER IF EXISTS review_resolutions_immutable_delete")
                || !q.exec("ALTER TABLE review_resolutions RENAME TO review_resolutions_v11")
                || !q.exec("CREATE TABLE review_resolutions (id TEXT PRIMARY KEY,origin_device_id TEXT NOT NULL REFERENCES devices(id),catalog_generation INTEGER NOT NULL CHECK (catalog_generation > 0),origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),review_item_id TEXT NOT NULL REFERENCES review_items(id),action TEXT NOT NULL CHECK (action IN ('save','dismiss','accept_existing','keep_both')),evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256)=64 AND evidence_sha256=lower(evidence_sha256) AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),details_json TEXT NOT NULL DEFAULT '{}',result_state TEXT NOT NULL DEFAULT 'applied_local' CHECK (result_state IN ('applied_local','pending_device','failed')),occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(origin_device_id,catalog_generation,origin_sequence))")
                || !q.exec("INSERT INTO review_resolutions SELECT * FROM review_resolutions_v11")
                || !q.exec("DROP TABLE review_resolutions_v11")
                || !q.exec("CREATE TRIGGER review_resolutions_immutable_update BEFORE UPDATE ON review_resolutions BEGIN SELECT RAISE(ABORT, 'review resolutions are append-only'); END")
                || !q.exec("CREATE TRIGGER review_resolutions_immutable_delete BEFORE DELETE ON review_resolutions BEGIN SELECT RAISE(ABORT, 'review resolutions are append-only'); END")
                || !q.exec("UPDATE schema_version SET version=12,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        }
        if (version <= 12) {
            if (!db.transaction()
                || !q.exec("DROP TRIGGER IF EXISTS review_resolutions_immutable_update")
                || !q.exec("DROP TRIGGER IF EXISTS review_resolutions_immutable_delete")
                || !q.exec("ALTER TABLE review_resolutions RENAME TO review_resolutions_v12")
                || !q.exec("CREATE TABLE review_resolutions (id TEXT PRIMARY KEY,origin_device_id TEXT NOT NULL REFERENCES devices(id),catalog_generation INTEGER NOT NULL CHECK (catalog_generation > 0),origin_sequence INTEGER NOT NULL CHECK (origin_sequence > 0),review_item_id TEXT NOT NULL REFERENCES review_items(id),action TEXT NOT NULL CHECK (action IN ('save','dismiss','accept_existing','keep_both','skip_unsupported')),evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256)=64 AND evidence_sha256=lower(evidence_sha256) AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),details_json TEXT NOT NULL DEFAULT '{}',result_state TEXT NOT NULL DEFAULT 'applied_local' CHECK (result_state IN ('applied_local','pending_device','failed')),occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(origin_device_id,catalog_generation,origin_sequence))")
                || !q.exec("INSERT INTO review_resolutions SELECT * FROM review_resolutions_v12")
                || !q.exec("DROP TABLE review_resolutions_v12")
                || !q.exec("CREATE TRIGGER review_resolutions_immutable_update BEFORE UPDATE ON review_resolutions BEGIN SELECT RAISE(ABORT, 'review resolutions are append-only'); END")
                || !q.exec("CREATE TRIGGER review_resolutions_immutable_delete BEFORE DELETE ON review_resolutions BEGIN SELECT RAISE(ABORT, 'review resolutions are append-only'); END")
                || !q.exec("UPDATE schema_version SET version=13,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        }
        if (version <= 13) {
            QString migrationError;
            if (!db.transaction()
                || !ensureCatalogColumn(db, "devices", "last_seen_at", "last_seen_at TEXT", &migrationError)
                || !ensureCatalogColumn(db, "storage", "last_seen_at", "last_seen_at TEXT", &migrationError)
                || !ensureCatalogColumn(db, "storage", "bytes_total", "bytes_total INTEGER CHECK (bytes_total IS NULL OR bytes_total >= 0)", &migrationError)
                || !ensureCatalogColumn(db, "storage", "bytes_free", "bytes_free INTEGER CHECK (bytes_free IS NULL OR bytes_free >= 0)", &migrationError)
                || !q.exec("UPDATE schema_version SET version=14,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = migrationError.isEmpty() ? q.lastError().text() : migrationError; return false; }
        }
        if (version <= 14) {
            if (!db.transaction()
                || !q.exec("CREATE TABLE IF NOT EXISTS device_corrections (id TEXT PRIMARY KEY,target_device_id TEXT NOT NULL REFERENCES devices(id),action TEXT NOT NULL CHECK (action='recheck_location'),source_root TEXT NOT NULL CHECK (source_root IN ('Drive','DCIM')),relative_path TEXT NOT NULL CHECK (relative_path<>'' AND relative_path NOT LIKE '/%' AND relative_path<>'..' AND relative_path NOT LIKE '../%' AND relative_path NOT LIKE '%/../%' AND relative_path NOT LIKE '%/..'),expected_size INTEGER NOT NULL CHECK (expected_size>=0),expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256)=64 AND expected_sha256=lower(expected_sha256) AND expected_sha256 NOT GLOB '*[^0-9a-f]*'),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
                || !q.exec("CREATE TABLE IF NOT EXISTS device_correction_results (id TEXT PRIMARY KEY,correction_id TEXT NOT NULL UNIQUE REFERENCES device_corrections(id),origin_device_id TEXT NOT NULL REFERENCES devices(id),status TEXT NOT NULL CHECK (status IN ('verified','changed','missing','failed')),observed_size INTEGER CHECK (observed_size IS NULL OR observed_size>=0),observed_sha256 TEXT CHECK (observed_sha256 IS NULL OR (length(observed_sha256)=64 AND observed_sha256=lower(observed_sha256) AND observed_sha256 NOT GLOB '*[^0-9a-f]*')),error_message TEXT NOT NULL DEFAULT '',completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
                || !q.exec("CREATE TRIGGER IF NOT EXISTS device_corrections_immutable_update BEFORE UPDATE ON device_corrections BEGIN SELECT RAISE(ABORT, 'device corrections are append-only'); END")
                || !q.exec("CREATE TRIGGER IF NOT EXISTS device_corrections_immutable_delete BEFORE DELETE ON device_corrections BEGIN SELECT RAISE(ABORT, 'device corrections are append-only'); END")
                || !q.exec("CREATE TRIGGER IF NOT EXISTS device_correction_results_immutable_update BEFORE UPDATE ON device_correction_results BEGIN SELECT RAISE(ABORT, 'device correction results are append-only'); END")
                || !q.exec("CREATE TRIGGER IF NOT EXISTS device_correction_results_immutable_delete BEFORE DELETE ON device_correction_results BEGIN SELECT RAISE(ABORT, 'device correction results are append-only'); END")
                || !q.exec("UPDATE schema_version SET version=15,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        }
        if (version <= 15) {
            QString migrationError;
            if (!db.transaction()
                || !ensureCatalogColumn(db, "device_corrections", "review_item_id", "review_item_id TEXT REFERENCES review_items(id)", &migrationError)
                || !q.exec("UPDATE schema_version SET version=16,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = migrationError.isEmpty() ? q.lastError().text() : migrationError; return false; }
        }
        if (version <= 16) {
            QString migrationError;
            if (!db.transaction()
                || !ensureCatalogColumn(db, "app_config", "hub_enabled", "hub_enabled INTEGER NOT NULL DEFAULT 0 CHECK (hub_enabled IN (0, 1))", &migrationError)
                || !ensureCatalogColumn(db, "app_config", "hub_limit_percent", "hub_limit_percent INTEGER NOT NULL DEFAULT 80 CHECK (hub_limit_percent BETWEEN 1 AND 95)", &migrationError)
                || !q.exec("UPDATE schema_version SET version=17,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); if (error) *error = migrationError.isEmpty() ? q.lastError().text() : migrationError; return false; }
        } else if (version != 17) {
            if (error) *error = "Unsupported catalog schema version"; return false;
        }
    }
    return true;
}

QString stableJobId(const VerifiedCopy::Request &r, const QVector<SourceFile> &files) {
    QByteArray manifest;
    for (const SourceFile &file : files) manifest += file.relative.toUtf8() + '\0' + file.destinationRelative.toUtf8() + '\0' + QByteArray::number(file.size) + '\0' + QByteArray::number(file.mtime) + '\n';
    return QStringLiteral("job-%1").arg(QString::fromLatin1(QCryptographicHash::hash(
        r.routeId.toUtf8() + '\n' + r.sourceRoot.toUtf8() + '\n' + r.destinationRoot.toUtf8() + '\n' + r.keepPolicy.toUtf8() + '\n' + QByteArray::number(r.organizePhotos) + '\n' + manifest, QCryptographicHash::Sha256).toHex()));
}

QString stableItemId(const QString &job, const QString &relative) {
    return QStringLiteral("item-%1").arg(QString::fromLatin1(QCryptographicHash::hash((job + "\n" + relative).toUtf8(), QCryptographicHash::Sha256).toHex()));
}

bool prepareCatalog(QSqlDatabase &db, const VerifiedCopy::Request &r, const VerifiedCopy::Preview &preview,
                    const QVector<SourceFile> &files, QString &routeId, QString &jobId, QString &destinationStorageId,
                    QString *error, const QString &jobIdOverride = {}) {
    if (!initializeCatalog(db, error)) return false;
    routeId = r.routeId.isEmpty() ? QStringLiteral("route-%1").arg(QString::fromLatin1(QCryptographicHash::hash((r.sourceRoot + r.destinationRoot).toUtf8(), QCryptographicHash::Sha256).toHex())) : r.routeId;
    jobId = jobIdOverride.isEmpty() ? stableJobId(r, files) : jobIdOverride;
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    QSqlQuery q(db);
    QString sourceDeviceId = r.sourceDeviceId.isEmpty() ? QStringLiteral("local") : r.sourceDeviceId;
    const QString sourceDeviceStableId = r.sourceDeviceStableId.isEmpty() ? sourceDeviceId : r.sourceDeviceStableId;
    const QString sourceDeviceName = r.sourceDeviceName.isEmpty() ? QStringLiteral("Computer") : r.sourceDeviceName;
    const QString sourceDeviceKind = r.sourceDeviceKind.isEmpty() ? QStringLiteral("Desktop") : r.sourceDeviceKind;
    QString sourceStorageId = r.sourceStorageId.isEmpty() ? QStringLiteral("local") : r.sourceStorageId;
    const QString sourceStorageIdentity = r.sourceStorageIdentity.isEmpty() ? sourceStorageId : r.sourceStorageIdentity;
    const QString sourceStorageKind = r.sourceStorageKind.isEmpty() ? QStringLiteral("local") : r.sourceStorageKind;
    const QString sourceTransport = sourceStorageIdentity.startsWith(QStringLiteral("wireless:")) ? QStringLiteral("wireless") : sourceStorageKind;
    const QString sourceStorageLabel = r.sourceStorageLabel.isEmpty() ? sourceDeviceName : r.sourceStorageLabel;
    q.prepare("INSERT OR IGNORE INTO devices(id,stable_id,name,kind,is_local) VALUES('local','local','Computer','Desktop',1)");
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    if (sourceDeviceId != QStringLiteral("local")) {
        bool resolvedDevice = false;
        if (sourceTransport == QStringLiteral("mtp") || sourceTransport == QStringLiteral("wireless")) {
            q.prepare("SELECT device_id FROM device_aliases WHERE alias=?");
            q.addBindValue(sourceDeviceStableId);
            if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
            if (q.next()) { sourceDeviceId = q.value(0).toString(); resolvedDevice = true; }
        }
        if (!resolvedDevice) {
            q.prepare("SELECT id FROM devices WHERE stable_id=?");
            q.addBindValue(sourceDeviceStableId);
            if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
            if (q.next()) sourceDeviceId = q.value(0).toString();
        }
        q.prepare("INSERT OR IGNORE INTO devices(id,stable_id,name,kind,is_local) VALUES(?,?,?,?,0)");
        q.addBindValue(sourceDeviceId); q.addBindValue(sourceDeviceStableId); q.addBindValue(sourceDeviceName); q.addBindValue(sourceDeviceKind);
        if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    }
    if (sourceStorageId != QStringLiteral("local")) {
        q.prepare("SELECT id FROM storage WHERE stable_identity=?");
        q.addBindValue(sourceStorageIdentity);
        if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        if (q.next()) sourceStorageId = q.value(0).toString();
    }
    if (sourceStorageId == QStringLiteral("local")) {
        q.prepare("INSERT OR IGNORE INTO storage(id,stable_identity,device_id,kind,label,filesystem_type,selected_root,presence) VALUES('local','local','local','local','Computer','', '/','present')");
    } else {
        q.prepare("INSERT OR IGNORE INTO storage(id,stable_identity,device_id,kind,label,filesystem_type,selected_root,presence) VALUES(?,?,?,?,?,?,?,?)");
        q.addBindValue(sourceStorageId); q.addBindValue(sourceStorageIdentity); q.addBindValue(sourceDeviceId); q.addBindValue(sourceStorageKind); q.addBindValue(sourceStorageLabel); q.addBindValue(QString()); q.addBindValue(QStringLiteral("/")); q.addBindValue(QStringLiteral("present"));
    }
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    if (sourceDeviceId != QStringLiteral("local") && sourceStorageIdentity != QStringLiteral("local") && (sourceTransport == QStringLiteral("mtp") || sourceTransport == QStringLiteral("wireless"))) {
        q.prepare("INSERT INTO device_aliases(alias,device_id,transport,last_seen_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(alias) DO UPDATE SET device_id=excluded.device_id,transport=excluded.transport,last_seen_at=CURRENT_TIMESTAMP");
        q.addBindValue(sourceStorageIdentity); q.addBindValue(sourceDeviceId); q.addBindValue(sourceTransport);
        if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    }
    QString destinationDeviceId = r.destinationDeviceId.isEmpty() ? QStringLiteral("local") : r.destinationDeviceId;
    const QString destinationDeviceStableId = r.destinationDeviceStableId.isEmpty() ? destinationDeviceId : r.destinationDeviceStableId;
    if (destinationDeviceId != QStringLiteral("local")) {
        q.prepare("SELECT device_id FROM device_aliases WHERE alias=?"); q.addBindValue(destinationDeviceStableId);
        if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
        if (q.next()) destinationDeviceId = q.value(0).toString();
        else {
            q.prepare("SELECT id FROM devices WHERE stable_id=?"); q.addBindValue(destinationDeviceStableId);
            if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
            if (q.next()) destinationDeviceId = q.value(0).toString();
        }
        q.prepare("INSERT OR IGNORE INTO devices(id,stable_id,name,kind,is_local) VALUES(?,?,?,?,0)");
        q.addBindValue(destinationDeviceId); q.addBindValue(destinationDeviceStableId); q.addBindValue(r.destinationDeviceName); q.addBindValue(r.destinationDeviceKind);
        if (!q.exec()) { db.rollback(); if (error) *error = QStringLiteral("Destination device catalog: %1").arg(q.lastError().text()); return false; }
        q.prepare("INSERT INTO device_aliases(alias,device_id,transport,last_seen_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(alias) DO UPDATE SET device_id=excluded.device_id,transport=excluded.transport,last_seen_at=CURRENT_TIMESTAMP");
        q.addBindValue(destinationDeviceStableId); q.addBindValue(destinationDeviceId); q.addBindValue(r.destinationStorageKind);
        if (!q.exec()) { db.rollback(); if (error) *error = QStringLiteral("Destination alias catalog: %1").arg(q.lastError().text()); return false; }
    }
    destinationStorageId = r.destinationStorageId;
    q.prepare("SELECT id FROM storage WHERE stable_identity=?");
    q.addBindValue(r.storageIdentity);
    if (!q.exec()) { db.rollback(); if (error) *error = QStringLiteral("Destination storage catalog: %1").arg(q.lastError().text()); return false; }
    if (q.next()) destinationStorageId = q.value(0).toString();
    q.prepare("INSERT OR IGNORE INTO storage(id,stable_identity,device_id,kind,label,filesystem_type,selected_root,presence) VALUES(?,?,?,?,?,?,?,?)");
    const QUrl destinationRootUrl(r.destinationRoot);
    const QString catalogRoot = destinationRootUrl.scheme().isEmpty() ? r.destinationRoot : destinationRootUrl.path(QUrl::FullyDecoded);
    q.addBindValue(destinationStorageId); q.addBindValue(r.storageIdentity); q.addBindValue(destinationDeviceId); q.addBindValue(r.destinationStorageKind); q.addBindValue(r.destinationStorageLabel); q.addBindValue(r.filesystemType); q.addBindValue(catalogRoot); q.addBindValue("present");
    if (!q.exec()) { db.rollback(); if (error) *error = QStringLiteral("Destination storage catalog: %1").arg(q.lastError().text()); return false; }
    q.prepare("INSERT OR IGNORE INTO routes(id,source_storage_id,destination_storage_id,source_root,destination_root,behavior,keep_policy,content_type,staging_max_bytes,minimum_free_bytes,organize_photos,enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    const QString contentType = r.contentType == QStringLiteral("Photos") || r.contentType == QStringLiteral("Drive") ? r.contentType
                                                                                                                         : (r.organizePhotos ? QStringLiteral("Photos") : QStringLiteral("Drive"));
    q.addBindValue(routeId); q.addBindValue(sourceStorageId); q.addBindValue(destinationStorageId); q.addBindValue(r.sourceRoot); q.addBindValue(r.destinationRoot); q.addBindValue(r.behavior); q.addBindValue(r.keepPolicy); q.addBindValue(contentType); q.addBindValue(r.stagingMaxBytes); q.addBindValue(r.minimumFreeBytes); q.addBindValue(r.organizePhotos); q.addBindValue(r.routeEnabled);
    if (!q.exec()) { db.rollback(); if (error) *error = QStringLiteral("Route insert: %1").arg(q.lastError().text()); return false; }
    q.prepare("UPDATE routes SET staging_max_bytes=?,minimum_free_bytes=?,organize_photos=?,enabled=? WHERE id=?"); q.addBindValue(r.stagingMaxBytes); q.addBindValue(r.minimumFreeBytes); q.addBindValue(r.organizePhotos); q.addBindValue(r.routeEnabled); q.addBindValue(routeId);
    if (!q.exec()) { db.rollback(); if (error) *error = QStringLiteral("Route update: %1").arg(q.lastError().text()); return false; }
    q.prepare("INSERT OR IGNORE INTO jobs(id,route_id,behavior,keep_policy,source_path,destination_path,bytes_total) VALUES(?,?,?,?,?,?,?)");
    q.addBindValue(jobId); q.addBindValue(routeId); q.addBindValue(r.behavior); q.addBindValue(r.keepPolicy); q.addBindValue(r.sourceRoot); q.addBindValue(r.destinationRoot); q.addBindValue(preview.bytes);
    if (!q.exec()) { db.rollback(); if (error) *error = QStringLiteral("Job insert: %1").arg(q.lastError().text()); return false; }
    q.prepare("UPDATE jobs SET state='Queued',error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?"); q.addBindValue(jobId);
    if (!q.exec()) { db.rollback(); if (error) *error = QStringLiteral("Job update: %1").arg(q.lastError().text()); return false; }
    for (const SourceFile &file : files) {
        q.prepare("INSERT OR IGNORE INTO job_items(id,job_id,source_path,destination_path,expected_size,bytes_done,state,source_mtime) VALUES(?,?,?,?,?,?,?,?)");
        q.addBindValue(stableItemId(jobId, file.relative)); q.addBindValue(jobId); q.addBindValue(file.absolute); q.addBindValue(QDir(r.destinationRoot).filePath(file.destinationRelative)); q.addBindValue(file.size); q.addBindValue(0); q.addBindValue("Queued"); q.addBindValue(QString::number(file.mtime));
        if (!q.exec()) { db.rollback(); if (error) *error = QStringLiteral("Job item insert: %1").arg(q.lastError().text()); return false; }
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

bool recordReceipt(QSqlDatabase &db, const VerifiedCopy::Request &r, const QString &destinationStorageId, const QString &jobId,
                   const SourceFile &source, const QString &destination, const QByteArray &hash, QString *error,
                   const QString &destinationRelativeOverride = {}) {
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    QSqlQuery q(db);
    const QString contentId = QStringLiteral("content-%1").arg(QString::fromLatin1(hash.toHex()));
    const QString itemId = stableItemId(jobId, source.relative);
    const QString storageRoot = QStorageInfo(r.destinationRoot).rootPath();
    const QString destinationRelative = destinationRelativeOverride.isEmpty()
        ? QDir(storageRoot.isEmpty() ? r.destinationRoot : storageRoot).relativeFilePath(destination)
        : destinationRelativeOverride;
    const QString locationId = QStringLiteral("location-%1").arg(QString::fromLatin1(QCryptographicHash::hash((destinationStorageId + "\n" + destinationRelative).toUtf8(), QCryptographicHash::Sha256).toHex()));
    const QString now = QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs);
    q.prepare("SELECT state,expected_size,expected_sha256 FROM job_items WHERE id=?"); q.addBindValue(itemId);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    if (q.next() && q.value(0).toString() == "Complete" && q.value(1).toLongLong() == source.size && q.value(2).toString() == QString::fromLatin1(hash.toHex())) { db.rollback(); return true; }
    q.prepare("INSERT OR IGNORE INTO content(id,sha256,size_bytes,original_name,modified_at) VALUES(?,?,?,?,?)");
    q.addBindValue(contentId); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(source.size); q.addBindValue(QFileInfo(source.relative).fileName()); q.addBindValue(now);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    q.prepare("UPDATE job_items SET content_id=?,source_path=?,destination_path=?,expected_size=?,expected_sha256=?,bytes_done=?,state='Complete',source_mtime=?,destination_sha256=?,verified_at=?,cleanup_state='not_requested' WHERE id=?");
    q.addBindValue(contentId); q.addBindValue(source.absolute); q.addBindValue(destination); q.addBindValue(source.size); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(source.size); q.addBindValue(QString::number(source.mtime)); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(now); q.addBindValue(itemId);
    if (!q.exec() || q.numRowsAffected() == 0) { db.rollback(); if (error) *error = q.lastError().text().isEmpty() ? QStringLiteral("Missing catalog job item") : q.lastError().text(); return false; }
    q.prepare("INSERT OR IGNORE INTO locations(id,content_id,storage_id,relative_path,state,size_bytes,source_sha256,destination_sha256,verified_at,last_seen_at,last_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    q.addBindValue(locationId); q.addBindValue(contentId); q.addBindValue(destinationStorageId); q.addBindValue(destinationRelative); q.addBindValue("verified"); q.addBindValue(source.size); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(now); q.addBindValue(now); q.addBindValue(now);
    if (!q.exec()) {
        // A retry may have published the same file before its receipt was committed.
        q.prepare("UPDATE locations SET content_id=?,state='verified',size_bytes=?,source_sha256=?,destination_sha256=?,verified_at=?,last_seen_at=?,last_verified_at=? WHERE storage_id=? AND relative_path=? AND (destination_sha256=? OR destination_sha256 IS NULL)");
        q.addBindValue(contentId); q.addBindValue(source.size); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(now); q.addBindValue(now); q.addBindValue(now); q.addBindValue(destinationStorageId); q.addBindValue(destinationRelative); q.addBindValue(QString::fromLatin1(hash.toHex()));
        if (!q.exec() || q.numRowsAffected() == 0) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    } else if (q.numRowsAffected() == 0) {
        q.prepare("UPDATE locations SET content_id=?,state='verified',size_bytes=?,source_sha256=?,destination_sha256=?,verified_at=?,last_seen_at=?,last_verified_at=? WHERE storage_id=? AND relative_path=?");
        q.addBindValue(contentId); q.addBindValue(source.size); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(QString::fromLatin1(hash.toHex())); q.addBindValue(now); q.addBindValue(now); q.addBindValue(now); q.addBindValue(destinationStorageId); q.addBindValue(destinationRelative);
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

void releaseDatabase(QSqlDatabase &db, const QString &name);

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
    q.prepare("UPDATE jobs SET state=?,error_code=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"); q.addBindValue(state); q.addBindValue(stableErrorCode(result)); q.addBindValue(result); q.addBindValue(jobId);
    if (!q.exec() || q.numRowsAffected() != 1) { db.rollback(); if (error) *error = q.lastError().text().isEmpty() ? "Catalog job terminalization failed" : q.lastError().text(); return false; }
    if (!db.commit()) { db.rollback(); if (error) *error = db.lastError().text(); return false; }
    return true;
}

bool recordRejectedPlan(const VerifiedCopy::Request &request, const VerifiedCopy::Preview &preview, const QString &message, QString *error) {
    const QString databasePath = request.databasePath.isEmpty() ? defaultCatalogPath() : request.databasePath;
    const QString connection = QStringLiteral("rejected-plan-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    auto db = QSqlDatabase::addDatabase("QSQLITE", connection); db.setDatabaseName(databasePath);
    if (!db.open()) { if (error) *error = db.lastError().text(); return false; }
    QVector<SourceFile> files;
    files.reserve(preview.manifest.size());
    for (const VerifiedCopy::Preview::ManifestEntry &entry : preview.manifest)
        files.push_back({entry.relative, QDir(request.sourceRoot).filePath(entry.relative), entry.destination, entry.size, entry.mtime});
    QString routeId, jobId, destinationStorageId, catalogError;
    const QString rejectedJobId = QStringLiteral("job-rejected-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    const bool ok = prepareCatalog(db, request, preview, files, routeId, jobId, destinationStorageId, &catalogError, rejectedJobId)
        && terminalizeJob(db, jobId, nullptr, {}, "Failed", "failed", message, &catalogError);
    releaseDatabase(db, connection);
    if (!ok && error) *error = catalogError;
    return ok;
}

bool setItemState(QSqlDatabase &db, const QString &itemId, const QString &state, QString *error) {
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    QSqlQuery q(db); q.prepare("SELECT state FROM job_items WHERE id=?"); q.addBindValue(itemId);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    if (q.next() && q.value(0).toString() == "Complete") { db.rollback(); return true; }
    q.prepare("UPDATE job_items SET state=? WHERE id=?"); q.addBindValue(state); q.addBindValue(itemId);
    if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    if (state == QStringLiteral("Copying") || state == QStringLiteral("Verifying")) {
        q.prepare("UPDATE jobs SET state=?,updated_at=CURRENT_TIMESTAMP WHERE id=(SELECT job_id FROM job_items WHERE id=?)"); q.addBindValue(state); q.addBindValue(itemId);
        if (!q.exec()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    }
    if (!db.commit()) { db.rollback(); if (error) *error = db.lastError().text(); return false; }
    return true;
}

bool recordCleanupFailure(QSqlDatabase &db, const QVector<CleanupItem> &items, const QString &jobId, const QString &message, QString *error) {
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    QSqlQuery q(db);
    for (const CleanupItem &item : items) {
        q.prepare("UPDATE job_items SET cleanup_state='failed' WHERE id=?"); q.addBindValue(item.id);
        if (!q.exec() || !appendHistory(db, jobId, item.id, "failed", item.source.absolute, item.destination, QString::fromLatin1(item.hash.toHex()), {}, message, error)) { db.rollback(); if (error && error->isEmpty()) *error = q.lastError().text(); return false; }
    }
    q.prepare("UPDATE jobs SET error_code=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"); q.addBindValue(stableErrorCode(message)); q.addBindValue(message); q.addBindValue(jobId);
    if (!q.exec() || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    if (error) *error = message;
    return true;
}

bool recordCleanupUncertain(QSqlDatabase &db, const QVector<CleanupItem> &items, const QString &jobId, const QString &message, QString *error) {
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    for (const CleanupItem &item : items) {
        if (!appendHistory(db, jobId, item.id, "failed", item.source.absolute, item.destination, {}, {}, message, error)) { db.rollback(); return false; }
    }
    QSqlQuery q(db); q.prepare("UPDATE jobs SET error_code='catalog_error',error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"); q.addBindValue(message); q.addBindValue(jobId);
    if (!q.exec() || !db.commit()) { db.rollback(); if (error) *error = q.lastError().text(); return false; }
    if (error) *error = message;
    return true;
}

bool trashVerifiedMove(QSqlDatabase &db, const VerifiedCopy::Request &request, const QString &jobId, QString *error,
                       const std::atomic_bool *cancelled, const std::function<void(const QString &, const QString &)> &testHook) {
    if (request.keepPolicy == QStringLiteral("Everything")) { if (error) *error = "Keep Everything has no cleanup"; return false; }
    QSqlQuery q(db);
    q.prepare("SELECT behavior,keep_policy,state FROM jobs WHERE id=?"); q.addBindValue(jobId);
    if (!q.exec() || !q.next() || q.value(0).toString() != request.behavior || q.value(1).toString() != request.keepPolicy || q.value(2).toString() != "Cleanup pending") { if (error) *error = "The job is not ready for cleanup"; return false; }
    q.prepare("SELECT id,source_path,destination_path,expected_size,source_mtime,expected_sha256 FROM job_items WHERE job_id=? AND state='Complete' AND cleanup_state IN ('not_requested','failed') ORDER BY source_path"); q.addBindValue(jobId);
    if (!q.exec()) { if (error) *error = q.lastError().text(); return false; }
    QVector<CleanupItem> items;
    const qint64 cutoff = cleanupCutoff(request.keepPolicy);
    while (q.next()) {
        if (q.value(4).toLongLong() >= cutoff) continue;
        items.push_back({q.value(0).toString(), {QString(), q.value(1).toString(), {}, q.value(3).toLongLong(), q.value(4).toLongLong()}, q.value(2).toString(), QByteArray::fromHex(q.value(5).toString().toLatin1())});
    }
    if (items.isEmpty()) {
        QSqlQuery uncertain(db); uncertain.prepare("SELECT COUNT(*) FROM job_items WHERE job_id=? AND state='Complete' AND cleanup_state='pending'"); uncertain.addBindValue(jobId);
        if (!uncertain.exec() || !uncertain.next()) { if (error) *error = uncertain.lastError().text(); return false; }
        if (uncertain.value(0).toInt() > 0) {
            const QString message = QStringLiteral("Cleanup outcome is uncertain; review system Trash before retrying.");
            QSqlQuery mark(db); mark.prepare("UPDATE jobs SET error_code='catalog_error',error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"); mark.addBindValue(message); mark.addBindValue(jobId);
            if (!mark.exec()) { if (error) *error = mark.lastError().text(); return false; }
            if (error) *error = message;
            return false;
        }
        q.prepare("UPDATE jobs SET state='Complete',completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,error_code=NULL,error_message=NULL WHERE id=?"); q.addBindValue(jobId);
        if (!q.exec()) { if (error) *error = q.lastError().text(); return false; }
        return true;
    }
    const QString sourceRoot = canonicalDir(request.sourceRoot), destinationRoot = canonicalDir(request.destinationRoot);
    PinGuard roots;
    if (sourceRoot.isEmpty() || destinationRoot.isEmpty()) {
        const QString message = sourceRoot.isEmpty() ? QStringLiteral("Source folder is unavailable during cleanup") : QStringLiteral("Destination folder is unavailable during cleanup");
        recordCleanupFailure(db, items, jobId, message, error);
        return false;
    }
    if (!pinRoots(sourceRoot, destinationRoot, roots.pins, error)) { const QString message = error && !error->isEmpty() ? *error : QStringLiteral("Cleanup roots are unavailable"); recordCleanupFailure(db, items, jobId, message, error); return false; }
    QString identityError;
    if (storageIdentity(destinationRoot, &identityError) != request.storageIdentity || !liveRootMatches(sourceRoot, roots.pins.sourceDevice, roots.pins.sourceInode) || !liveRootMatches(destinationRoot, roots.pins.destinationDevice, roots.pins.destinationInode)) { recordCleanupFailure(db, items, jobId, QStringLiteral("A transfer root or storage identity changed"), error); return false; }
    for (CleanupItem &item : items) {
        const QString absolute = QDir::cleanPath(QFileInfo(item.source.absolute).absoluteFilePath());
        item.source.relative = QDir(sourceRoot).relativeFilePath(absolute);
        if (item.source.relative.isEmpty() || item.source.relative == "." || item.source.relative == ".." || item.source.relative.startsWith("../") || item.source.relative.contains("/../")) { recordCleanupFailure(db, items, jobId, QStringLiteral("Cleanup source escapes the selected root"), error); return false; }
        QByteArray hash; struct stat sourceStat{}; QString sourceError;
        if (!sameFileOpenedFd(roots.pins.source, item.source.relative, item.source, &hash, &sourceStat, &sourceError) || hash != item.hash || sourceStat.st_mtim.tv_sec * 1000 + sourceStat.st_mtim.tv_nsec / 1000000 != item.source.mtime) { recordCleanupFailure(db, items, jobId, sourceError.isEmpty() ? QStringLiteral("Source changed before cleanup") : sourceError, error); return false; }
        item.source.absolute = QDir(sourceRoot).filePath(item.source.relative);
    }
    if (cancelled && cancelled->load()) { if (error) *error = "Cleanup cancelled before Trash; sources retained"; return false; }
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    for (const CleanupItem &item : items) {
        q.prepare("UPDATE job_items SET cleanup_state='pending' WHERE id=? AND state='Complete'"); q.addBindValue(item.id);
        if (!q.exec() || q.numRowsAffected() != 1) { db.rollback(); if (error) *error = q.lastError().text().isEmpty() ? "Cleanup item disappeared" : q.lastError().text(); return false; }
    }
    if (!db.commit()) { db.rollback(); if (error) *error = db.lastError().text(); return false; }
    if (testHook) testHook(items.first().source.absolute, QStringLiteral("before-trash"));
    if (cancelled && cancelled->load()) {
        const QString message = QStringLiteral("Cleanup cancelled before Trash; sources retained");
        recordCleanupFailure(db, items, jobId, message, error);
        return false;
    }
    QList<QUrl> urls;
    for (const CleanupItem &item : items) urls.append(QUrl::fromLocalFile(item.source.absolute));
    KIO::CopyJob *trashJob = KIO::trash(urls, KIO::HideProgressInfo);
    trashJob->setAutoDelete(false);
    const bool trashed = trashJob->exec();
    const QString trashError = trashJob->errorString();
    delete trashJob;
    if (!trashed) {
        const QString message = QStringLiteral("Trash cleanup failed: %1").arg(trashError.isEmpty() ? QStringLiteral("the system Trash is unavailable") : trashError);
        recordCleanupUncertain(db, items, jobId, message, error);
        return false;
    }
    if (!db.transaction()) { if (error) *error = "Trash succeeded but catalog transaction could not start"; return false; }
    for (const CleanupItem &item : items) {
        q.prepare("UPDATE job_items SET cleanup_state='trashed' WHERE id=? AND cleanup_state='pending'"); q.addBindValue(item.id);
        if (!q.exec() || q.numRowsAffected() != 1 || !appendHistory(db, jobId, item.id, "trashed", item.source.absolute, item.destination, QString::fromLatin1(item.hash.toHex()), QString::fromLatin1(item.hash.toHex()), "moved to system Trash", error)) { db.rollback(); if (error && error->isEmpty()) *error = "Trash succeeded but catalog update failed"; return false; }
    }
    q.prepare("UPDATE jobs SET state='Complete',completed_at=CURRENT_TIMESTAMP,error_code=NULL,error_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?"); q.addBindValue(jobId);
    if (!q.exec() || q.numRowsAffected() != 1 || !db.commit()) { db.rollback(); if (error && error->isEmpty()) *error = "Trash succeeded but catalog update failed"; return false; }
    return true;
}

enum class PublishResult { Published, AlreadyExists, Failed };

PublishResult publishNoReplaceFd(int partialFd, int parentFd, const QString &final, QString *error) {
#ifdef __linux__
    const QByteArray name = QFileInfo(final).fileName().toLocal8Bit();
    errno = 0; const int result = ::linkat(partialFd, "", parentFd, name.constData(), AT_EMPTY_PATH); const int saved = errno;
    if (result != 0) {
        if (saved == EEXIST) return PublishResult::AlreadyExists;
        struct stat partialStat{}; QByteArray partialName;
        const int scanFd = ::dup(parentFd); DIR *dir = scanFd < 0 ? nullptr : ::fdopendir(scanFd);
        if (::fstat(partialFd, &partialStat) == 0 && dir) while (const dirent *entry = ::readdir(dir)) {
            if (!std::strcmp(entry->d_name, ".") || !std::strcmp(entry->d_name, "..")) continue;
            struct stat candidate{};
            if (::fstatat(parentFd, entry->d_name, &candidate, AT_SYMLINK_NOFOLLOW) == 0 && candidate.st_dev == partialStat.st_dev && candidate.st_ino == partialStat.st_ino) { partialName = entry->d_name; break; }
        }
        if (dir) ::closedir(dir); else if (scanFd >= 0) ::close(scanFd);
#ifdef SYS_renameat2
        if (!partialName.isEmpty() && ::syscall(SYS_renameat2, parentFd, partialName.constData(), parentFd, name.constData(), RENAME_NOREPLACE) == 0) {
            if (::fsync(parentFd) != 0) { if (error) *error = "Destination directory could not be flushed"; return PublishResult::Failed; }
            return PublishResult::Published;
        }
        if (!partialName.isEmpty() && errno == EEXIST) { ::unlinkat(parentFd, partialName.constData(), 0); return PublishResult::AlreadyExists; }
#endif
        if (error) *error = saved == ENOSYS || saved == EINVAL || saved == EOPNOTSUPP || saved == EPERM ? "Destination publication is unavailable" : QString::fromLocal8Bit(strerror(saved));
        return PublishResult::Failed;
    }
    if (::fsync(parentFd) != 0) { if (error) *error = "Destination directory could not be flushed"; return PublishResult::Failed; }
    return PublishResult::Published;
#else
    Q_UNUSED(partialFd); Q_UNUSED(parentFd); Q_UNUSED(final); if (error) *error = "Anonymous fd publication is unavailable"; return PublishResult::Failed;
#endif
}

PublishResult publishNamedNoReplaceFd(int partialParent, const QString &partialName,
                                      int destinationParent, const QString &final,
                                      QString *error) {
#ifdef __linux__
    const QByteArray oldName = partialName.toLocal8Bit();
    const QByteArray newName = QFileInfo(final).fileName().toLocal8Bit();
    errno = 0;
#ifdef SYS_renameat2
    if (::syscall(SYS_renameat2, partialParent, oldName.constData(), destinationParent, newName.constData(), RENAME_NOREPLACE) == 0) {
        if (::fsync(destinationParent) != 0) { if (error) *error = "Named partial publication could not be made durable"; return PublishResult::Failed; }
        return PublishResult::Published;
    }
    if (errno == EEXIST) return PublishResult::AlreadyExists;
    if (errno != ENOSYS && errno != EINVAL) { if (error) *error = QString::fromLocal8Bit(strerror(errno)); return PublishResult::Failed; }
#endif
    if (::linkat(partialParent, oldName.constData(), destinationParent, newName.constData(), 0) != 0) {
        const int saved = errno;
        if (saved == EEXIST) return PublishResult::AlreadyExists;
        if (error) *error = QString::fromLocal8Bit(strerror(saved));
        return PublishResult::Failed;
    }
    if (::fsync(destinationParent) != 0 || ::unlinkat(partialParent, oldName.constData(), 0) != 0 || ::fsync(partialParent) != 0) {
        if (error) *error = "Named partial publication could not be made durable";
        return PublishResult::Failed;
    }
    return PublishResult::Published;
#else
    Q_UNUSED(partialParent); Q_UNUSED(partialName); Q_UNUSED(destinationParent); Q_UNUSED(final);
    if (error) *error = "Named partial publication is unavailable";
    return PublishResult::Failed;
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

bool remoteStat(const QUrl &url, qint64 *size, qint64 *mtime, QString *error) {
    QEventLoop loop;
    bool ok = true;
    KIO::UDSEntry entry;
    auto *job = KIO::stat(url, KIO::StatJob::SourceSide, KIO::StatDefaultDetails, KIO::HideProgressInfo);
    QObject::connect(job, &KJob::result, &loop, [&loop, &ok, &entry, error, job](KJob *finished) {
        if (finished->error()) { ok = false; if (error) *error = finished->errorText(); }
        else entry = job->statResult();
        loop.quit();
    });
    loop.exec();
    if (!ok) return false;
    if (entry.numberValue(KIO::UDSEntry::UDS_FILE_TYPE, 0) == 0040000) { if (error) *error = "MTP source is a directory; import one file at a time"; return false; }
    const qint64 sourceSize = entry.numberValue(KIO::UDSEntry::UDS_SIZE, -1);
    if (sourceSize < 0) { if (error) *error = "MTP source size is unavailable"; return false; }
    if (size) *size = sourceSize;
    if (mtime) *mtime = entry.numberValue(KIO::UDSEntry::UDS_MODIFICATION_TIME, 0) * 1000;
    return true;
}

bool remoteHash(const QUrl &url, qint64 expectedSize, QByteArray *hash, QString *error) {
    QEventLoop loop; QCryptographicHash digest(QCryptographicHash::Sha256); qint64 received = 0; QString failure;
    auto *job = KIO::get(url, KIO::NoReload, KIO::HideProgressInfo);
    QObject::connect(job, &KIO::TransferJob::data, &loop, [&](KIO::Job *, const QByteArray &data) { digest.addData(data); received += data.size(); });
    QObject::connect(job, &KJob::result, &loop, [&](KJob *finished) { if (finished->error()) failure = finished->errorText(); loop.quit(); });
    loop.exec();
    if (!failure.isEmpty() || received != expectedSize) { if (error) *error = failure.isEmpty() ? QStringLiteral("Remote size changed during verification") : failure; return false; }
    if (hash) *hash = digest.result();
    return true;
}

bool runKioJob(KJob *job, QString *error) {
    QEventLoop loop; bool ok = true;
    QObject::connect(job, &KJob::result, &loop, [&](KJob *finished) { if (finished->error()) { ok = false; if (error) *error = finished->errorText(); } loop.quit(); });
    loop.exec(); return ok;
}

bool ensureRemoteDirectory(const QUrl &root, const QUrl &directory, QString *error) {
    const QString rootPath = QDir::cleanPath(root.path(QUrl::FullyDecoded));
    const QString directoryPath = QDir::cleanPath(directory.path(QUrl::FullyDecoded));
    const QString relative = QDir(rootPath).relativeFilePath(directoryPath);
    if (root.scheme() != directory.scheme() || root.authority() != directory.authority() || relative == ".." || relative.startsWith("../") || QDir::isAbsolutePath(relative)) {
        if (error) *error = QStringLiteral("Destination folder is outside phone storage");
        return false;
    }
    if (relative == ".") return true;
    QString currentPath = rootPath;
    for (const QString &part : relative.split('/', Qt::SkipEmptyParts)) {
        currentPath = QDir(currentPath).filePath(part);
        QUrl current = root; current.setPath(currentPath);
        QEventLoop statLoop; bool exists = false, directoryEntry = false; QString statFailure;
        auto *statJob = KIO::stat(current, KIO::StatJob::SourceSide, KIO::StatDefaultDetails, KIO::HideProgressInfo);
        QObject::connect(statJob, &KJob::result, &statLoop, [&](KJob *finished) {
            if (!finished->error()) { exists = true; directoryEntry = statJob->statResult().isDir(); }
            else if (finished->error() != KIO::ERR_DOES_NOT_EXIST) statFailure = finished->errorText();
            statLoop.quit();
        });
        statLoop.exec();
        if (!statFailure.isEmpty()) { if (error) *error = statFailure; return false; }
        if (exists) { if (!directoryEntry) { if (error) *error = QStringLiteral("Destination folder path contains a file"); return false; } continue; }
        QEventLoop loop; QString failure;
        auto *job = KIO::mkdir(current);
        QObject::connect(job, &KJob::result, &loop, [&](KJob *finished) {
            if (finished->error() && finished->error() != KIO::ERR_DIR_ALREADY_EXIST && finished->error() != KIO::ERR_FILE_ALREADY_EXIST) failure = finished->errorText();
            loop.quit();
        });
        loop.exec();
        if (!failure.isEmpty()) { if (error) *error = failure; return false; }
    }
    return true;
}
}

QVariantMap VerifiedCopy::Preview::toMap() const {
    const QString code = errorCode.isEmpty() && !error.isEmpty() ? stableErrorCode(error) : errorCode;
    return {{"ok", ok}, {"error", error}, {"errorCode", code}, {"sourceSafe", sourceSafe}, {"nextAction", nextAction.isEmpty() && !code.isEmpty() ? nextActionForError(code) : nextAction}, {"files", files}, {"bytes", bytes}, {"toCopy", toCopy},
            {"identical", identical}, {"duplicates", duplicates}, {"destinationDuplicates", destinationDuplicates}, {"organized", organized}, {"conflicts", conflicts}, {"conflictPaths", conflictPaths}, {"conflictEvidence", conflictEvidence}, {"duplicatePaths", duplicatePaths}, {"unsupported", unsupported}, {"unsupportedPaths", unsupportedPaths}, {"unsupportedEvidence", unsupportedEvidence}, {"unreadable", unreadable}, {"freeBytes", freeBytes}, {"minimumFreeBytes", minimumFreeBytes}, {"stagingMaxBytes", stagingMaxBytes}};
}

VerifiedCopy::VerifiedCopy(const QString &databasePath, QObject *parent)
    : QObject(parent), m_databasePath(databasePath.isEmpty() ? defaultCatalogPath() : databasePath) {}

bool VerifiedCopy::stagingUsage(const QString &root, qint64 *bytes, QString *error) {
    qint64 total = 0;
    QDirIterator iterator(root, QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot, QDirIterator::Subdirectories);
    while (iterator.hasNext()) {
        iterator.next();
        const QFileInfo info = iterator.fileInfo();
        if (info.isSymLink()) { if (error) *error = QStringLiteral("Staging root contains a symlink"); return false; }
        if (info.isFile()) total += info.size();
    }
    if (bytes) *bytes = total;
    return true;
}

VerifiedCopy::~VerifiedCopy() {
    cancel();
    if (m_thread) { m_thread->wait(); delete m_thread; m_thread = nullptr; }
}

QString VerifiedCopy::liveStorageIdentity(const QString &root, QString *error) { return storageIdentity(root, error); }

bool VerifiedCopy::ensureCatalog(const QString &databasePath, QString *error) {
    if (databasePath.trimmed().isEmpty()) { if (error) *error = QStringLiteral("Catalog path is missing"); return false; }
    if (!QDir().mkpath(QFileInfo(databasePath).absolutePath())) { if (error) *error = QStringLiteral("Catalog directory is unavailable"); return false; }
    const QString connection = QStringLiteral("catalog-init-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(databasePath);
    if (!db.open()) { QSqlDatabase::removeDatabase(connection); if (error) *error = db.lastError().text(); return false; }
    const bool result = initializeCatalog(db, error);
    releaseDatabase(db, connection);
    return result;
}

VerifiedCopy::Preview VerifiedCopy::inspect(const Request &request, const std::atomic_bool *cancelled) {
    PreviewCancelScope cancelScope(cancelled);
    Preview result;
    if (request.behavior != "Copy" && request.behavior != "Move") { result.error = "Unknown transfer behavior"; return result; }
    if (request.minimumFreeBytes < 0) { result.error = "Minimum free-space margin cannot be negative"; return result; }
    if (request.stagingMaxBytes < 0) { result.error = "Staging maximum cannot be negative"; return result; }
    if (request.keepPolicy != "Everything" && request.keepPolicy != "Last month" && request.keepPolicy != "Last week" && request.keepPolicy != "Last day" && request.keepPolicy != "Nothing") { result.error = "Unknown Keep policy"; return result; }
    if ((request.keepPolicy == "Nothing" && request.behavior != "Move") || (request.keepPolicy == "Everything" && request.behavior == "Move")) { result.error = "Keep policy and transfer behavior do not match"; return result; }
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
    if (::access(destination.toLocal8Bit().constData(), W_OK) != 0) { result.error = QString::fromLocal8Bit(strerror(errno)); closePins(pins); return result; }
    QVector<SourceFile> files;
    QString scanError; scanPinned(pins.source, source, {}, files, result.unsupported, result.unsupportedPaths, result.unsupportedEvidence, &scanError, previewCancel);
    if (!scanError.isEmpty()) { result.error = scanError; closePins(pins); return result; }
    if (!excludeSources(files, request.excludedSourcePaths, &result.error)) { closePins(pins); return result; }
    std::sort(files.begin(), files.end(), [](const SourceFile &a, const SourceFile &b) { return a.relative < b.relative; });
    assignDestinationPaths(request, files);
    if (!validateDestinationOverrides(request, files, &result.error)) { closePins(pins); return result; }
    QHash<QByteArray, QStringList> destinationHashes;
    if (request.detectDestinationDuplicates) {
        QVector<SourceFile> destinationFiles;
        qint64 destinationUnsupported = 0; QStringList destinationUnsupportedPaths, destinationUnsupportedEvidence;
        scanPinned(pins.destination, destination, {}, destinationFiles, destinationUnsupported, destinationUnsupportedPaths, destinationUnsupportedEvidence, &scanError, previewCancel);
        if (!scanError.isEmpty()) { result.error = scanError; closePins(pins); return result; }
        for (const SourceFile &file : destinationFiles) {
            QByteArray hash; QString hashError;
            if (!sameFileOpenedFd(pins.destination, file.relative, file, &hash, nullptr, &hashError)) { result.error = hashError.isEmpty() ? QStringLiteral("Destination library contains an unreadable item") : hashError; closePins(pins); return result; }
            destinationHashes[hash + '\0' + QByteArray::number(file.size)].append(file.relative);
        }
    }
    result.files = files.size();
    QHash<QByteArray, QString> sourceHashes;
    for (const SourceFile &file : files) {
        result.manifest.append({file.relative, file.destinationRelative, file.size, file.mtime});
        if (file.destinationRelative != file.relative) ++result.organized;
        result.bytes += file.size;
        QByteArray sourceHash; QString sourceError;
        if (!sameFileOpenedFd(pins.source, file.relative, file, &sourceHash, nullptr, &sourceError)) {
            ++result.unreadable; result.paths.append(file.relative); continue;
        }
        const QByteArray duplicateKey = sourceHash + '\0' + QByteArray::number(file.size);
        const QString sourceDuplicate = sourceHashes.value(duplicateKey);
        if (!sourceDuplicate.isEmpty()) {
            ++result.duplicates;
            if (request.detectDestinationDuplicates) result.duplicatePaths.append(QStringLiteral("%1 ↔ %2").arg(file.relative, sourceDuplicate));
        } else sourceHashes.insert(duplicateKey, file.relative);
        QString error; struct stat targetStat{};
        if (!statPinned(pins.destination, destination, file.destinationRelative, &targetStat, &error)) {
            const QStringList existing = destinationHashes.value(duplicateKey);
            // The first source occurrence remains the candidate copy; later exact copies wait for review.
            if (request.detectDestinationDuplicates && sourceDuplicate.isEmpty() && !existing.isEmpty()) {
                ++result.destinationDuplicates;
                result.duplicatePaths.append(QStringLiteral("%1 ↔ %2").arg(file.relative, existing.first()));
            } else if (!request.detectDestinationDuplicates || sourceDuplicate.isEmpty()) result.toCopy += file.size;
            result.paths.append(file.relative);
            continue;
        }
        const bool targetRegular = S_ISREG(targetStat.st_mode);
        if (!targetRegular) { ++result.conflicts; result.conflictPaths.append(file.destinationRelative); result.conflictEvidence.append(QStringLiteral("%1\n%2\n%3\nnon-regular:%4:%5").arg(file.relative, file.destinationRelative, QString::fromLatin1(sourceHash.toHex()), QString::number(targetStat.st_size), QString::number(targetStat.st_mtim.tv_sec * 1000 + targetStat.st_mtim.tv_nsec / 1000000))); continue; }
        QByteArray targetHash;
        if (!sameFileOpenedFd(pins.destination, file.destinationRelative, file, &targetHash, nullptr, &error)) { result.error = error; closePins(pins); return result; }
        if (sourceHash == targetHash && targetStat.st_size == file.size) ++result.identical;
        else { ++result.conflicts; result.conflictPaths.append(file.destinationRelative); result.conflictEvidence.append(QStringLiteral("%1\n%2\n%3\n%4").arg(file.relative, file.destinationRelative, QString::fromLatin1(sourceHash.toHex()), QString::fromLatin1(targetHash.toHex()))); }
        if (sourceHash != targetHash || targetStat.st_size != file.size) result.paths.append(file.relative);
    }
    result.freeBytes = QStorageInfo(destination).bytesAvailable();
    result.minimumFreeBytes = request.minimumFreeBytes;
    result.stagingMaxBytes = request.stagingMaxBytes;
    if (result.unreadable > 0) { result.error = "Unreadable source items remain; fix permissions and preview again"; closePins(pins); return result; }
    // ponytail: this is a per-job intake bound; full queue occupancy needs a persisted staging root and queue ledger.
    if (request.stagingMaxBytes > 0 && result.toCopy > request.stagingMaxBytes) { result.error = "Staging limit reached before transfer"; closePins(pins); return result; }
    if (result.freeBytes < result.toCopy || result.freeBytes - result.toCopy < request.minimumFreeBytes) { result.error = "Not enough free space including the configured safety margin"; closePins(pins); return result; }
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
        QSqlQuery q(db); q.prepare("SELECT r.source_root,r.destination_root,r.behavior,r.keep_policy,r.destination_storage_id,s.stable_identity,COALESCE(s.filesystem_type,''),s.selected_root,COALESCE(r.staging_max_bytes,0),COALESCE(r.minimum_free_bytes,0),COALESCE(r.organize_photos,0),s.presence FROM routes r JOIN storage s ON s.id=r.destination_storage_id WHERE r.id=? AND r.enabled=1"); q.addBindValue(routeId);
        if (q.exec() && q.next()) {
            if (q.value(11).toString() != QStringLiteral("present")) { result = {{"ok", false}, {"error", "Saved route is Waiting for the exact storage to reconnect"}}; releaseDatabase(db, connection); return result; }
            m_request = Request{q.value(0).toString(), q.value(1).toString(), q.value(7).toString(), q.value(5).toString(), q.value(6).toString(), dbPath, routeId, q.value(4).toString(), q.value(2).toString(), q.value(3).toString(), q.value(9).toLongLong(), q.value(8).toLongLong(), q.value(10).toBool(), QStringLiteral("local"), QStringLiteral("local"), QStringLiteral("local"), QStringLiteral("Computer"), QStringLiteral("local"), QStringLiteral("local"), QStringLiteral("Computer"), QStringLiteral("Desktop")};
            result = {{"ok", true}};
        } else result = {{"ok", false}, {"error", "Saved destination storage is unavailable"}};
    } else result = {{"ok", false}, {"error", db.lastError().text()}};
    releaseDatabase(db, connection);
    return result;
}

bool VerifiedCopy::previewRoute(const QString &routeId) {
    if (m_running.load() || m_thread != nullptr) return false;
    m_cleanupReady.store(false); emit cleanupChanged();
    const QVariantMap route = routeMap(routeId);
    if (!route.value("ok").toBool()) { m_preview = {}; m_preview.error = route.value("error").toString(); emit previewChanged(); return false; }
    const bool pendingCleanup = cleanupPreview().value("ok").toBool();
    if (m_cleanupReady.exchange(pendingCleanup) != pendingCleanup) emit cleanupChanged();
    m_preview = {};
    emit previewChanged();
    m_cancelled.store(false); m_running.store(true); emit runningChanged(); setStatus("Previewing");
    const Request request = m_request;
    QThread *thread = QThread::create([this, request] {
        const Preview result = inspect(request, &m_cancelled);
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

QVariantMap VerifiedCopy::cleanupPreview() const {
    QVariantMap result{{"ok", false}, {"files", 0}, {"bytes", 0}};
    if (m_request.keepPolicy == QStringLiteral("Everything")) return result;
    const QString connection = QStringLiteral("cleanup-preview-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    auto db = QSqlDatabase::addDatabase("QSQLITE", connection); db.setDatabaseName(m_request.databasePath.isEmpty() ? defaultCatalogPath() : m_request.databasePath);
    if (!db.open()) { result.insert("error", db.lastError().text()); return result; }
    QSqlQuery job(db); job.prepare("SELECT id FROM jobs WHERE route_id=? AND keep_policy=? AND state='Cleanup pending' ORDER BY created_at DESC,rowid DESC LIMIT 1"); job.addBindValue(m_request.routeId); job.addBindValue(m_request.keepPolicy);
    if (!job.exec() || !job.next()) { releaseDatabase(db, connection); return result; }
    QSqlQuery items(db); items.prepare("SELECT expected_size,source_mtime,cleanup_state FROM job_items WHERE job_id=? AND state='Complete' AND cleanup_state IN ('not_requested','failed','pending')"); items.addBindValue(job.value(0));
    if (!items.exec()) { result.insert("error", items.lastError().text()); releaseDatabase(db, connection); return result; }
    const qint64 cutoff = cleanupCutoff(m_request.keepPolicy); qint64 files = 0, bytes = 0, pending = 0;
    while (items.next()) {
        if (items.value(2).toString() == QStringLiteral("pending")) { ++pending; continue; }
        if (items.value(1).toLongLong() < cutoff) { ++files; bytes += items.value(0).toLongLong(); }
    }
    result.insert("ok", true); result.insert("files", files); result.insert("bytes", bytes); result.insert("pending", pending); result.insert("uncertain", pending > 0); result.insert("policy", m_request.keepPolicy);
    releaseDatabase(db, connection);
    return result;
}

QVariantList VerifiedCopy::recentHistory() const {
    return recentHistoryForRoute(m_request.databasePath.isEmpty() ? defaultCatalogPath() : m_request.databasePath, m_request.routeId);
}

QVariantList VerifiedCopy::recentHistoryForRoute(const QString &databasePath, const QString &routeId) {
    QVariantList result;
    if (databasePath.isEmpty() || routeId.isEmpty()) return result;
    const QString connection = QStringLiteral("history-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    auto db = QSqlDatabase::addDatabase("QSQLITE", connection); db.setDatabaseName(databasePath);
    if (!db.open()) return result;
    QSqlQuery q(db); q.prepare("SELECT h.event,h.source_path,h.destination_path,h.result,h.occurred_at FROM history h JOIN jobs j ON j.id=h.job_id WHERE j.route_id=? ORDER BY h.occurred_at DESC,h.rowid DESC LIMIT 8"); q.addBindValue(routeId);
    if (q.exec()) while (q.next()) result.append(QVariantMap{{"event", q.value(0)}, {"source", q.value(1)}, {"destination", q.value(2)}, {"result", q.value(3)}, {"occurredAt", q.value(4)}});
    releaseDatabase(db, connection);
    return result;
}

QVariantMap VerifiedCopy::manifestData() const {
    if (!m_preview.ok) return {};
    QVariantList entries;
    for (const Preview::ManifestEntry &entry : m_preview.manifest) entries.append(QVariantMap{{"path", entry.relative}, {"destination", entry.destination}, {"size", entry.size}, {"mtime", entry.mtime}});
    return {{"format", "localdrive-manifest-v1"}, {"source", m_request.sourceRoot}, {"destination", m_request.destinationRoot}, {"files", entries}};
}

bool VerifiedCopy::exportManifest(const QUrl &url, const QString &format) const {
    if (m_running.load() || !m_preview.ok || !url.isLocalFile() || (format != "json" && format != "csv")) return false;
    const QString path = url.toLocalFile(); if (path.isEmpty()) return false;
    QSaveFile output(path); if (!output.open(QIODevice::WriteOnly | QIODevice::Text)) return false;
    if (format == "json") {
        const QJsonObject document = QJsonObject::fromVariantMap(manifestData());
        if (output.write(QJsonDocument(document).toJson(QJsonDocument::Indented)) < 0) return false;
    } else {
        const auto csv = [](const QString &value) { QString escaped = value; escaped.replace('"', "\"\""); return '"' + escaped + '"'; };
        QTextStream stream(&output); stream << "path,destination,size,mtime\n";
        for (const Preview::ManifestEntry &entry : m_preview.manifest) stream << csv(entry.relative) << ',' << csv(entry.destination) << ',' << entry.size << ',' << entry.mtime << '\n';
        if (stream.status() != QTextStream::Ok) return false;
    }
    return output.commit();
}

bool VerifiedCopy::startCopy() {
    if (m_running.load() || m_thread != nullptr || !m_preview.ok || (m_request.behavior != "Copy" && m_request.behavior != "Move")) return false;
    m_cancelled.store(false); m_paused.store(false); emit pausedChanged(); m_copying.store(true); m_running.store(true); emit runningChanged(); setStatus("Copying");
    const Request request = m_request;
    const Preview authorized = m_preview;
    QThread *thread = QThread::create([this, request, authorized] {
        QString error, completion; const bool success = execute(request, authorized, &error, &completion);
        QMetaObject::invokeMethod(this, [this, request, success, error, completion] {
            m_copying.store(false);
            if (m_paused.exchange(false)) { m_pauseCondition.notify_all(); emit pausedChanged(); }
            if (success && request.keepPolicy != "Everything" && completion.startsWith(QStringLiteral("Cleanup pending"))) { m_cleanupReady.store(true); emit cleanupChanged(); }
            setStatus(success ? completion : (error.contains("cancelled") ? QStringLiteral("Cancelled") : QStringLiteral("Failed")));
            emit finished(success, success ? completion : error);
        }, Qt::QueuedConnection);
    });
    connect(thread, &QThread::finished, this, [this, thread] { thread->deleteLater(); if (m_thread == thread) { m_thread = nullptr; m_running.store(false); emit runningChanged(); } });
    m_thread = thread;
    thread->start();
    return true;
}

bool VerifiedCopy::startRemoteImportDirectory(const QVariantMap &options) {
    if (m_running.load() || m_thread != nullptr) return false;
    RemoteRequest base;
    base.sourceUrl = QUrl(options.value("sourceUrl").toString());
    base.sourceRootUrl = base.sourceUrl;
    base.destinationRoot = options.value("destinationRoot").toString();
    base.selectedStorageRoot = options.value("selectedStorageRoot").toString();
    base.storageIdentity = options.value("storageIdentity").toString();
    base.filesystemType = options.value("filesystemType").toString();
    base.databasePath = m_databasePath;
    base.routeId = options.value("routeId").toString();
    base.destinationStorageId = options.value("destinationStorageId", QStringLiteral("destination")).toString();
    base.sourceStorageId = options.value("sourceStorageId").toString();
    base.sourceStorageIdentity = options.value("sourceStorageIdentity").toString();
    base.sourceStorageLabel = options.value("sourceStorageLabel", QStringLiteral("MTP phone")).toString();
    base.sourceDeviceId = options.value("sourceDeviceId").toString();
    base.sourceDeviceStableId = options.value("sourceDeviceStableId").toString();
    base.sourceDeviceName = options.value("sourceDeviceName", QStringLiteral("MTP phone")).toString();
    base.destinationStorageKind = options.value("destinationStorageKind", QStringLiteral("removable")).toString();
    base.destinationStorageLabel = options.value("destinationStorageLabel", QStringLiteral("Destination")).toString();
    base.destinationDeviceId = options.value("destinationDeviceId", QStringLiteral("local")).toString();
    base.destinationDeviceStableId = options.value("destinationDeviceStableId", QStringLiteral("local")).toString();
    base.destinationDeviceName = options.value("destinationDeviceName", QStringLiteral("Computer")).toString();
    base.minimumFreeBytes = options.value("minimumFreeBytes").toLongLong();
    base.stagingMaxBytes = options.value("stagingMaxBytes").toLongLong();
    base.resumable = options.value("resumable").toBool() || base.sourceStorageIdentity.startsWith(QStringLiteral("wireless:"));
    const QString destinationPrefix = QDir::cleanPath(options.value("destinationPrefix").toString());
    bool itemsOk = false, bytesOk = false;
    const qint64 maxItems = options.value("maxItems", 100000).toLongLong(&itemsOk);
    const qint64 maxBytes = options.value("maxBytes", 64LL * 1024 * 1024 * 1024).toLongLong(&bytesOk);
    if (!base.sourceUrl.isValid() || (base.sourceUrl.scheme() != QStringLiteral("mtp") && base.sourceUrl.scheme() != QStringLiteral("file")) || base.destinationRoot.isEmpty() || base.storageIdentity.isEmpty() || base.minimumFreeBytes < 0 || base.stagingMaxBytes < 0 || !itemsOk || !bytesOk || maxItems < 0 || maxBytes < 0) return false;

    m_cancelled.store(false); m_paused.store(false); m_copying.store(false); emit pausedChanged(); m_running.store(true); emit runningChanged(); setStatus(QStringLiteral("Scanning phone"));
    QThread *thread = QThread::create([this, base, destinationPrefix, maxItems, maxBytes] {
        QVector<RemoteInventoryItem> items;
        QString error;
        bool success = collectRemoteDirectory(base.sourceUrl, maxItems, maxBytes, items, &error);
        qint64 total = 0, done = 0;
        for (const RemoteInventoryItem &item : items) total += item.size;
        if (success && base.stagingMaxBytes > 0) {
            qint64 used = 0, incoming = 0;
            success = stagingUsage(base.destinationRoot, &used, &error);
            if (success) for (const RemoteInventoryItem &item : items) {
                const QString relative = destinationPrefix.isEmpty() ? item.relative : QDir(destinationPrefix).filePath(item.relative);
                if (!QFileInfo::exists(QDir(base.destinationRoot).filePath(relative))) incoming += item.size;
            }
            if (success && (used > base.stagingMaxBytes || incoming > base.stagingMaxBytes - used)) { success = false; error = QStringLiteral("Staging capacity reached; phone source was not modified"); }
        }
        if (success) {
            for (const RemoteInventoryItem &item : items) {
                if (m_cancelled.load()) { success = false; error = QStringLiteral("Import cancelled"); break; }
                RemoteRequest request = base;
                request.sourceUrl = item.url;
                request.sourceRelative = item.relative;
                request.destinationRelative = destinationPrefix.isEmpty() ? item.relative : QDir(destinationPrefix).filePath(item.relative);
                request.progressOffset = done;
                request.progressTotal = total;
                QMetaObject::invokeMethod(this, [this, item] { setStatus(QStringLiteral("Importing %1").arg(item.relative)); }, Qt::QueuedConnection);
                if (!executeRemoteBlocking(request, &error)) { success = false; break; }
                done += item.size;
                QMetaObject::invokeMethod(this, [this, done, total, item] { emit progressChanged(done, total, item.relative); }, Qt::QueuedConnection);
            }
        }
        QMetaObject::invokeMethod(this, [this, success, error] {
            setStatus(success ? QStringLiteral("Complete") : (error == QStringLiteral("Import cancelled") ? QStringLiteral("Cancelled") : QStringLiteral("Failed")));
            emit finished(success, success ? QStringLiteral("Phone import completed") : error);
        }, Qt::QueuedConnection);
    });
    connect(thread, &QThread::finished, this, [this, thread] { thread->deleteLater(); if (m_thread == thread) { m_thread = nullptr; m_running.store(false); emit runningChanged(); } });
    m_thread = thread;
    thread->start();
    return true;
}

bool VerifiedCopy::cleanup() {
    if (m_running.load() || m_thread != nullptr || !m_cleanupReady.load() || m_request.keepPolicy == "Everything") return false;
    m_cancelled.store(false); m_paused.store(false); m_copying.store(false); emit pausedChanged(); m_running.store(true); emit runningChanged(); setStatus("Moving verified sources to Trash");
    const Request request = m_request;
    QThread *thread = QThread::create([this, request] {
        QString error; const bool success = cleanupBlocking(request, &error);
        QMetaObject::invokeMethod(this, [this, success, error] {
            if (m_paused.exchange(false)) { m_pauseCondition.notify_all(); emit pausedChanged(); }
            if (success) { m_cleanupReady.store(false); emit cleanupChanged(); }
            setStatus(success ? QStringLiteral("Complete") : QStringLiteral("Cleanup failed"));
            emit finished(success, success ? QStringLiteral("Sources moved to Trash") : error);
        }, Qt::QueuedConnection);
    });
    connect(thread, &QThread::finished, this, [this, thread] { thread->deleteLater(); if (m_thread == thread) { m_thread = nullptr; m_running.store(false); emit runningChanged(); } });
    m_thread = thread;
    thread->start();
    return true;
}

void VerifiedCopy::cancel() { m_cancelled.store(true); m_pauseCondition.notify_all(); if (m_running.load()) setStatus("Cancelling"); }
void VerifiedCopy::appendLog(const QString &message) {
    if (message.isEmpty()) return;
    m_logEntries.append(QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs) + QStringLiteral(" ") + message);
    while (m_logEntries.size() > 200) m_logEntries.removeFirst();
    emit logEntriesChanged();
}
void VerifiedCopy::setStatus(const QString &status) { if (m_status == status) return; m_status = status; appendLog(QStringLiteral("status=%1").arg(status)); emit statusChanged(); }

bool VerifiedCopy::waitIfPaused(QSqlDatabase &db, const QString &jobId, QString *error) {
    if (!m_paused.load()) return true;
    QSqlQuery q(db);
    q.prepare("UPDATE jobs SET state='Paused',updated_at=CURRENT_TIMESTAMP WHERE id=?"); q.addBindValue(jobId);
    if (!q.exec()) { if (error) *error = q.lastError().text(); return false; }
    QMetaObject::invokeMethod(this, [this] { setStatus("Paused"); }, Qt::QueuedConnection);
    std::unique_lock lock(m_pauseMutex);
    m_pauseCondition.wait(lock, [this] { return !m_paused.load() || m_cancelled.load(); });
    if (m_cancelled.load()) return true;
    QString resumeState = QStringLiteral("Copying");
    QSqlQuery phase(db); phase.prepare("SELECT 1 FROM job_items WHERE job_id=? AND state='Verifying' LIMIT 1"); phase.addBindValue(jobId);
    if (!phase.exec()) { if (error) *error = phase.lastError().text(); return false; }
    if (phase.next()) resumeState = QStringLiteral("Verifying");
    q.prepare("UPDATE jobs SET state=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"); q.addBindValue(resumeState); q.addBindValue(jobId);
    if (!q.exec()) { if (error) *error = q.lastError().text(); return false; }
    if (m_testHook) m_testHook(jobId, QStringLiteral("after-pause-resume"));
    QMetaObject::invokeMethod(this, [this, resumeState] { setStatus(resumeState); }, Qt::QueuedConnection);
    return true;
}

void VerifiedCopy::pause() {
    if (!m_copying.load() || m_paused.exchange(true)) return;
    emit pausedChanged();
    QMetaObject::invokeMethod(this, [this] { setStatus("Pausing"); }, Qt::QueuedConnection);
}

void VerifiedCopy::resume() {
    if (!m_paused.exchange(false)) return;
    m_pauseCondition.notify_all();
    emit pausedChanged();
    QMetaObject::invokeMethod(this, [this] { setStatus("Resuming"); }, Qt::QueuedConnection);
}

bool VerifiedCopy::executeBlocking(const Request &request, QString *error) {
    const Preview plan = inspect(request);
    if (!plan.ok) { if (error) *error = plan.error; return false; }
    return execute(request, plan, error);
}

bool VerifiedCopy::executePreviewBlocking(const Request &request, const Preview &preview, QString *error, QString *completionMessage) {
    return execute(request, preview, error, completionMessage);
}

bool VerifiedCopy::executeResumableLocalRemoteBlocking(const RemoteRequest &remote, QString *error) {
    if (error) error->clear();
    const QFileInfo sourceInputInfo(remote.sourceUrl.toLocalFile());
    if (sourceInputInfo.isSymLink()) { if (error) *error = "Wireless simulation source must not be a symlink"; return false; }
    const QString sourcePath = QFileInfo(remote.sourceUrl.toLocalFile()).canonicalFilePath();
    const QFileInfo sourceInfo(sourcePath);
    if (sourcePath.isEmpty() || !sourceInfo.isFile() || sourceInfo.isSymLink()) { if (error) *error = "Wireless simulation source is not a regular local file"; return false; }
    const QString destinationRoot = canonicalDir(remote.destinationRoot);
    const QString selectedRoot = canonicalDir(remote.selectedStorageRoot.isEmpty() ? remote.destinationRoot : remote.selectedStorageRoot);
    if (destinationRoot.isEmpty() || selectedRoot.isEmpty() || !under(destinationRoot, selectedRoot)) { if (error) *error = "Destination is outside the selected storage root"; return false; }
    const QString destinationRelative = QDir::cleanPath(remote.destinationRelative);
    if (destinationRelative.isEmpty() || destinationRelative == "." || destinationRelative == ".." || destinationRelative.startsWith("../") || destinationRelative.contains("/../") || QFileInfo(destinationRelative).isAbsolute()) { if (error) *error = "Destination path is unsafe"; return false; }
    QString identityError;
    if (remote.storageIdentity.isEmpty() || storageIdentity(destinationRoot, &identityError) != remote.storageIdentity) { if (error) *error = identityError.isEmpty() ? "Destination storage identity could not be verified" : identityError; return false; }

    QFile sourceFile(sourcePath);
    if (!sourceFile.open(QIODevice::ReadOnly)) { if (error) *error = sourceFile.errorString(); return false; }
    struct stat sourceStat{};
    if (::fstat(sourceFile.handle(), &sourceStat) != 0 || !S_ISREG(sourceStat.st_mode)) { if (error) *error = "Wireless source is not a regular file"; return false; }
    const qint64 sourceSize = sourceStat.st_size;
    const qint64 sourceMtime = sourceStat.st_mtim.tv_sec * 1000 + sourceStat.st_mtim.tv_nsec / 1000000;
    if (sourceSize > QStorageInfo(destinationRoot).bytesAvailable() || QStorageInfo(destinationRoot).bytesAvailable() - sourceSize < remote.minimumFreeBytes) { if (error) *error = "Not enough free space including the configured safety margin"; return false; }

    Request request;
    request.sourceRoot = remote.sourceRootUrl.isValid() ? remote.sourceRootUrl.toString() : sourcePath;
    request.destinationRoot = destinationRoot;
    request.selectedStorageRoot = selectedRoot;
    request.storageIdentity = remote.storageIdentity;
    request.filesystemType = remote.filesystemType;
    request.databasePath = remote.databasePath.isEmpty() ? defaultCatalogPath() : remote.databasePath;
    request.routeId = remote.routeId;
    request.destinationStorageId = remote.destinationStorageId;
    request.destinationStorageKind = remote.destinationStorageKind; request.destinationStorageLabel = remote.destinationStorageLabel; request.destinationDeviceId = remote.destinationDeviceId; request.destinationDeviceStableId = remote.destinationDeviceStableId; request.destinationDeviceName = remote.destinationDeviceName;
    request.minimumFreeBytes = remote.minimumFreeBytes;
    request.stagingMaxBytes = remote.stagingMaxBytes;
    request.sourceStorageId = remote.sourceStorageId;
    request.sourceStorageIdentity = remote.sourceStorageIdentity;
    request.sourceStorageKind = QStringLiteral("mtp");
    request.sourceStorageLabel = remote.sourceStorageLabel;
    request.sourceDeviceId = remote.sourceDeviceId;
    request.sourceDeviceStableId = remote.sourceDeviceStableId;
    request.sourceDeviceName = remote.sourceDeviceName;
    request.sourceDeviceKind = QStringLiteral("Phone");
    SourceFile source{remote.sourceRelative.isEmpty() ? sourceInfo.fileName() : remote.sourceRelative, sourcePath, destinationRelative, sourceSize, sourceMtime};
    Preview plan;
    plan.ok = true; plan.files = 1; plan.bytes = sourceSize; plan.toCopy = sourceSize; plan.freeBytes = QStorageInfo(destinationRoot).bytesAvailable();
    plan.manifest.append({source.relative, destinationRelative, sourceSize, sourceMtime});

    RootPins roots;
    if (!pinRoot(destinationRoot, roots.destination, &roots.destinationDevice, &roots.destinationInode, error)) return false;
    const QString connection = QStringLiteral("wireless-resume-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    auto db = QSqlDatabase::addDatabase("QSQLITE", connection); db.setDatabaseName(request.databasePath);
    if (!db.open()) { if (error) *error = db.lastError().text(); closePins(roots); releaseDatabase(db, connection); return false; }
    QString routeId, jobId, destinationStorageId, catalogError;
    if (!prepareCatalog(db, request, plan, {source}, routeId, jobId, destinationStorageId, &catalogError)) { if (error) *error = catalogError; closePins(roots); releaseDatabase(db, connection); return false; }
    const QString destination = QDir(destinationRoot).filePath(destinationRelative);
    const QString itemId = stableItemId(jobId, source.relative);
    QFile partial;
    FdGuard partialParent;
    auto failRemote = [&](const QString &message, const QString &state = QStringLiteral("Failed"), const QString &event = QStringLiteral("failed")) {
        partial.close();
        QString terminalError;
        if (!terminalizeJob(db, jobId, &source, destination, state, event, message, &terminalError)) { if (error) *error = "Catalog terminalization failed: " + terminalError; }
        else if (error) *error = message;
        closePins(roots); releaseDatabase(db, connection); return false;
    };
    if (!setItemState(db, itemId, QStringLiteral("Copying"), &catalogError)) return failRemote(catalogError);

    auto hashPath = [](const QString &path, qint64 size, QByteArray *hash, QString *hashError) {
        QFile file(path);
        if (!file.open(QIODevice::ReadOnly)) { if (hashError) *hashError = file.errorString(); return false; }
        return hashFd(file.handle(), size, hash, nullptr, hashError);
    };
    struct stat existing{}; QString statError;
    if (statPinned(roots.destination, destinationRoot, destinationRelative, &existing, &statError)) {
        if (!S_ISREG(existing.st_mode) || existing.st_size != sourceSize) return failRemote("Destination differs", QStringLiteral("Conflict"), QStringLiteral("conflict"));
        QByteArray sourceHash, existingHash;
        QString hashError;
        if (!hashPath(sourcePath, sourceSize, &sourceHash, &hashError) || !hashPath(destination, sourceSize, &existingHash, &hashError)) return failRemote(hashError.isEmpty() ? QStringLiteral("Existing destination could not be verified") : hashError);
        if (sourceHash != existingHash) return failRemote("Destination differs", QStringLiteral("Conflict"), QStringLiteral("conflict"));
        FdGuard existingFd; struct stat flushed{};
        if (!flushPublishedFd(roots.destination, roots.destinationDevice, destinationRoot, destination, &flushed, &catalogError, &existingFd.fd) || !recordReceipt(db, request, destinationStorageId, jobId, source, destination, sourceHash, &catalogError)) return failRemote(catalogError);
        QSqlQuery complete(db); complete.prepare("UPDATE jobs SET state='Complete',completed_at=CURRENT_TIMESTAMP,error_code=NULL,error_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?"); complete.addBindValue(jobId);
        if (!complete.exec()) return failRemote(complete.lastError().text());
        emit progressChanged(sourceSize, sourceSize, source.relative);
        closePins(roots); releaseDatabase(db, connection); return true;
    }
    if (!statError.isEmpty()) return failRemote(statError);

    const QString partialToken = QString::fromLatin1(QCryptographicHash::hash((sourcePath + "\n" + destinationRelative + "\n" + QString::number(sourceSize) + "\n" + QString::number(sourceMtime)).toUtf8(), QCryptographicHash::Sha256).toHex());
    const QString partialRelative = QStringLiteral(".local-drive-partials/%1.partial").arg(partialToken);
    const QString partialPath = QDir(destinationRoot).filePath(partialRelative);
    const int partialParentFd = openDestinationParentFd(roots.destination, destinationRoot, partialPath, roots.destinationDevice, &catalogError);
    if (partialParentFd < 0) return failRemote(catalogError.isEmpty() ? QStringLiteral("Wireless partial staging could not be opened") : catalogError);
    partialParent.fd = partialParentFd;
    const QByteArray partialName = QFileInfo(partialPath).fileName().toLocal8Bit();
    const int partialFd = ::openat(partialParent.fd, partialName.constData(), O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (partialFd < 0 || !partial.open(partialFd, QIODevice::ReadWrite, QFileDevice::AutoCloseHandle)) return failRemote(QStringLiteral("Wireless partial staging could not be opened: %1").arg(partial.isOpen() ? partial.errorString() : QString::fromLocal8Bit(strerror(errno))));
    struct stat partialStat{};
    if (::fstat(partial.handle(), &partialStat) != 0 || !S_ISREG(partialStat.st_mode) || partialStat.st_size > sourceSize) return failRemote("Wireless partial is invalid; it was retained for inspection");
    const qint64 resumed = partialStat.st_size;
    QCryptographicHash sourceHash(QCryptographicHash::Sha256);
    if (!sourceFile.seek(0) || !partial.seek(0)) return failRemote("Wireless partial could not be rewound");
    qint64 checked = 0;
    while (checked < resumed) {
        const qint64 wanted = std::min<qint64>(1024 * 1024, resumed - checked);
        const QByteArray expected = sourceFile.read(wanted);
        const QByteArray actual = partial.read(wanted);
        if (expected.size() != wanted || actual != expected) return failRemote("Wireless partial does not match the source; it was retained for inspection");
        sourceHash.addData(expected); checked += wanted;
    }
    if (!sourceFile.seek(resumed) || !partial.seek(0) || !partial.seek(partial.size())) return failRemote("Wireless partial seek failed");
    emit progressChanged(remote.progressOffset + resumed, remote.progressTotal > 0 ? remote.progressTotal : sourceSize, source.relative);
    while (checked < sourceSize) {
        if (m_cancelled.load()) { partial.flush(); ::fsync(partial.handle()); return failRemote("Wireless transfer cancelled; source retained and partial retained", QStringLiteral("Cancelled"), QStringLiteral("cancelled")); }
        const QByteArray chunk = sourceFile.read(std::min<qint64>(1024 * 1024, sourceSize - checked));
        if (chunk.isEmpty()) return failRemote(sourceFile.errorString().isEmpty() ? QStringLiteral("Wireless source read failed") : sourceFile.errorString());
        if (partial.write(chunk) != chunk.size()) return failRemote(partial.errorString());
        sourceHash.addData(chunk); checked += chunk.size();
        emit progressChanged(remote.progressOffset + checked, remote.progressTotal > 0 ? remote.progressTotal : sourceSize, source.relative);
        if (m_testHook) m_testHook(source.relative, QStringLiteral("wireless-during-copy"));
    }
    if (!partial.flush() || ::fsync(partial.handle()) != 0) return failRemote("Wireless partial could not be flushed");
    if (!setItemState(db, itemId, QStringLiteral("Verifying"), &catalogError)) return failRemote(catalogError);
    QByteArray verifiedHash; struct stat verifiedStat{}; FdGuard verifiedFd;
    if (!hashFd(partial.handle(), sourceSize, &verifiedHash, &verifiedStat, &catalogError, &verifiedFd.fd) || verifiedHash != sourceHash.result()) return failRemote(catalogError.isEmpty() ? QStringLiteral("Wireless destination hash mismatch") : catalogError);
    struct stat sourceAfter{};
    if (::fstat(sourceFile.handle(), &sourceAfter) != 0 || sourceAfter.st_size != sourceStat.st_size || sourceAfter.st_mtim.tv_sec != sourceStat.st_mtim.tv_sec || sourceAfter.st_mtim.tv_nsec != sourceStat.st_mtim.tv_nsec) return failRemote("Wireless source changed during transfer");
    partial.close();
    if (m_testHook) m_testHook(destination, QStringLiteral("before-wireless-publish"));
    if (storageIdentity(destinationRoot, &identityError) != remote.storageIdentity) return failRemote("Destination storage identity changed");
    FdGuard destinationParent;
    if ((destinationParent.fd = openDestinationParentFd(roots.destination, destinationRoot, destination, roots.destinationDevice, &catalogError)) < 0) return failRemote(catalogError);
    const PublishResult publication = publishNamedNoReplaceFd(partialParent.fd, QString::fromLocal8Bit(partialName), destinationParent.fd, destination, &catalogError);
    if (publication == PublishResult::AlreadyExists) return failRemote("Destination appeared during wireless import", QStringLiteral("Conflict"), QStringLiteral("conflict"));
    if (publication != PublishResult::Published) return failRemote(catalogError.isEmpty() ? QStringLiteral("Wireless destination publication failed") : catalogError);
    FdGuard publishedFd; struct stat publishedStat{};
    if (!flushPublishedFd(roots.destination, roots.destinationDevice, destinationRoot, destination, &publishedStat, &catalogError, &publishedFd.fd) || publishedStat.st_dev != verifiedStat.st_dev || publishedStat.st_ino != verifiedStat.st_ino) return failRemote(catalogError.isEmpty() ? QStringLiteral("Published wireless destination changed") : catalogError);
    QByteArray finalHash; struct stat finalStat{};
    SourceFile finalSource = source;
    if (!sameFileOpenedFd(roots.destination, destinationRelative, finalSource, &finalHash, &finalStat, &catalogError) || finalHash != verifiedHash || finalStat.st_dev != publishedStat.st_dev || finalStat.st_ino != publishedStat.st_ino) return failRemote(catalogError.isEmpty() ? QStringLiteral("Published wireless destination failed final verification") : catalogError);
    if (!recordReceipt(db, request, destinationStorageId, jobId, source, destination, finalHash, &catalogError)) return failRemote(catalogError);
    QSqlQuery complete(db); complete.prepare("UPDATE jobs SET state='Complete',completed_at=CURRENT_TIMESTAMP,error_code=NULL,error_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?"); complete.addBindValue(jobId);
    if (!complete.exec()) return failRemote(complete.lastError().text());
    closePins(roots); releaseDatabase(db, connection); return true;
}

bool VerifiedCopy::executeRemoteBlocking(const RemoteRequest &remote, QString *error) {
    if (error) error->clear();
    if (!remote.sourceUrl.isValid() || (remote.sourceUrl.scheme() != QStringLiteral("mtp") && remote.sourceUrl.scheme() != QStringLiteral("file"))) { if (error) *error = "MTP import requires a valid mtp:/ or file:// source"; return false; }
    if (remote.resumable && remote.sourceUrl.isLocalFile()) return executeResumableLocalRemoteBlocking(remote, error);
    const QString destinationRoot = canonicalDir(remote.destinationRoot);
    const QString selectedRoot = canonicalDir(remote.selectedStorageRoot.isEmpty() ? remote.destinationRoot : remote.selectedStorageRoot);
    if (destinationRoot.isEmpty() || selectedRoot.isEmpty() || !under(destinationRoot, selectedRoot)) { if (error) *error = "Destination is outside the selected storage root"; return false; }
    const QString destinationRelative = QDir::cleanPath(remote.destinationRelative);
    if (destinationRelative.isEmpty() || destinationRelative == "." || destinationRelative == ".." || destinationRelative.startsWith("../") || destinationRelative.contains("/../") || QFileInfo(destinationRelative).isAbsolute()) { if (error) *error = "Destination path is unsafe"; return false; }
    QString identityError;
    if (remote.storageIdentity.isEmpty() || storageIdentity(destinationRoot, &identityError) != remote.storageIdentity) { if (error) *error = identityError.isEmpty() ? "Destination storage identity could not be verified" : identityError; return false; }
    qint64 sourceSize = 0, sourceMtime = 0;
    if (!remoteStat(remote.sourceUrl, &sourceSize, &sourceMtime, error)) return false;
    if (sourceSize > QStorageInfo(destinationRoot).bytesAvailable() || QStorageInfo(destinationRoot).bytesAvailable() - sourceSize < remote.minimumFreeBytes) { if (error) *error = "Not enough free space including the configured safety margin"; return false; }

    Request request;
    request.sourceRoot = remote.sourceRootUrl.isValid() ? remote.sourceRootUrl.toString() : remote.sourceUrl.toString();
    request.destinationRoot = destinationRoot;
    request.selectedStorageRoot = selectedRoot;
    request.storageIdentity = remote.storageIdentity;
    request.filesystemType = remote.filesystemType;
    request.databasePath = remote.databasePath.isEmpty() ? defaultCatalogPath() : remote.databasePath;
    request.routeId = remote.routeId;
    request.destinationStorageId = remote.destinationStorageId;
    request.destinationStorageKind = remote.destinationStorageKind; request.destinationStorageLabel = remote.destinationStorageLabel; request.destinationDeviceId = remote.destinationDeviceId; request.destinationDeviceStableId = remote.destinationDeviceStableId; request.destinationDeviceName = remote.destinationDeviceName;
    request.minimumFreeBytes = remote.minimumFreeBytes;
    request.stagingMaxBytes = remote.stagingMaxBytes;
    request.sourceStorageId = remote.sourceStorageId;
    request.sourceStorageIdentity = remote.sourceStorageIdentity;
    request.sourceStorageKind = QStringLiteral("mtp");
    request.sourceStorageLabel = remote.sourceStorageLabel;
    request.sourceDeviceId = remote.sourceDeviceId;
    request.sourceDeviceStableId = remote.sourceDeviceStableId;
    request.sourceDeviceName = remote.sourceDeviceName;
    request.sourceDeviceKind = QStringLiteral("Phone");
    SourceFile source{remote.sourceRelative, remote.sourceUrl.toString(), destinationRelative, sourceSize, sourceMtime};
    if (source.relative.isEmpty()) source.relative = QFileInfo(remote.sourceUrl.path(QUrl::FullyDecoded)).fileName();
    if (source.relative.isEmpty()) { if (error) *error = "MTP source filename is unavailable"; return false; }
    Preview plan;
    plan.ok = true; plan.files = 1; plan.bytes = sourceSize; plan.toCopy = sourceSize; plan.freeBytes = QStorageInfo(destinationRoot).bytesAvailable();
    plan.manifest.append({source.relative, destinationRelative, sourceSize, sourceMtime});

    RootPins roots;
    if (!pinRoot(destinationRoot, roots.destination, &roots.destinationDevice, &roots.destinationInode, error)) return false;
    const QString connection = QStringLiteral("remote-import-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    auto db = QSqlDatabase::addDatabase("QSQLITE", connection); db.setDatabaseName(request.databasePath);
    if (!db.open()) { if (error) *error = db.lastError().text(); closePins(roots); releaseDatabase(db, connection); return false; }
    QString routeId, jobId, destinationStorageId, catalogError;
    if (!prepareCatalog(db, request, plan, {source}, routeId, jobId, destinationStorageId, &catalogError)) { if (error) *error = catalogError; closePins(roots); releaseDatabase(db, connection); return false; }
    auto failRemote = [&](const QString &message, const QString &state = QStringLiteral("Failed"), const QString &event = QStringLiteral("failed")) {
        QString terminalError;
        if (!terminalizeJob(db, jobId, &source, QDir(destinationRoot).filePath(destinationRelative), state, event, message, &terminalError)) { if (error) *error = "Catalog terminalization failed: " + terminalError; }
        else if (error) *error = message;
        closePins(roots); releaseDatabase(db, connection); return false;
    };
    const QString destination = QDir(destinationRoot).filePath(destinationRelative);
    const QString itemId = stableItemId(jobId, source.relative);
    if (!setItemState(db, itemId, QStringLiteral("Copying"), &catalogError)) return failRemote(catalogError);
    QFile partial; FdGuard partialParent; QString namedPartial;
    if (!openPartialFd(roots.destination, roots.destinationDevice, destinationRoot, destination, partial, &partialParent.fd, &namedPartial, &catalogError)) return failRemote(catalogError.isEmpty() ? QStringLiteral("Destination staging could not be opened") : catalogError);
    NamedPartialGuard namedGuard{partialParent.fd, namedPartial.toLocal8Bit()};
    QCryptographicHash sourceHash(QCryptographicHash::Sha256);
    qint64 received = 0; QString streamError; bool writeFailed = false;
    QEventLoop loop;
    auto *transfer = KIO::get(remote.sourceUrl, KIO::NoReload, KIO::HideProgressInfo);
    QObject::connect(transfer, &KIO::TransferJob::data, &loop, [this, &partial, &sourceHash, &received, &writeFailed, &remote, sourceSize, transfer](KIO::Job *, const QByteArray &data) {
        if (data.isEmpty()) return;
        if (m_cancelled.load()) { transfer->kill(KJob::EmitResult); return; }
        if (partial.write(data) != data.size()) { writeFailed = true; transfer->kill(KJob::EmitResult); return; }
        sourceHash.addData(data); received += data.size();
        const qint64 progressTotal = remote.progressTotal > 0 ? remote.progressTotal : sourceSize;
        const qint64 progressDone = remote.progressTotal > 0 ? remote.progressOffset + received : received;
        emit progressChanged(progressDone, progressTotal, remote.sourceRelative);
        if (m_testHook) m_testHook(remote.sourceRelative, QStringLiteral("remote-during-copy"));
    });
    QObject::connect(transfer, &KJob::result, &loop, [&loop, &streamError, &writeFailed, &partial](KJob *finished) {
        if (finished->error()) streamError = finished->errorText();
        else if (writeFailed) streamError = partial.errorString();
        loop.quit();
    });
    loop.exec();
    if (m_cancelled.load()) { partial.close(); return failRemote(QStringLiteral("MTP transfer cancelled; source retained"), QStringLiteral("Cancelled"), QStringLiteral("cancelled")); }
    if (!streamError.isEmpty()) { partial.close(); return failRemote("MTP transfer failed: " + streamError); }
    if (received != sourceSize || !partial.flush() || ::fsync(partial.handle()) != 0) { partial.close(); return failRemote("MTP source size or destination flush check failed"); }
    if (!setItemState(db, itemId, QStringLiteral("Verifying"), &catalogError)) { partial.close(); return failRemote(catalogError); }
    QByteArray destinationHash; struct stat partialStat{}; FdGuard partialVerified;
    if (!hashFd(partial.handle(), sourceSize, &destinationHash, &partialStat, &catalogError, &partialVerified.fd) || destinationHash != sourceHash.result()) { partial.close(); return failRemote(catalogError.isEmpty() ? QStringLiteral("Destination hash mismatch") : catalogError); }
    partial.close();
    qint64 sourceSizeAfter = 0, sourceMtimeAfter = 0;
    if (!remoteStat(remote.sourceUrl, &sourceSizeAfter, &sourceMtimeAfter, &catalogError) || sourceSizeAfter != sourceSize || (sourceMtime > 0 && sourceMtimeAfter > 0 && sourceMtimeAfter != sourceMtime)) return failRemote(catalogError.isEmpty() ? QStringLiteral("MTP source changed during transfer") : catalogError);
    struct stat existing{}; QString statError;
    if (statPinned(roots.destination, destinationRoot, destinationRelative, &existing, &statError)) {
        if (!S_ISREG(existing.st_mode)) return failRemote("Destination differs", QStringLiteral("Conflict"), QStringLiteral("conflict"));
        QByteArray existingHash; SourceFile existingSource = source; existingSource.size = sourceSize;
        if (!sameFileOpenedFd(roots.destination, destinationRelative, existingSource, &existingHash, nullptr, &catalogError) || existingHash != destinationHash) return failRemote("Destination differs", QStringLiteral("Conflict"), QStringLiteral("conflict"));
        FdGuard existingFd; struct stat flushed{};
        if (!flushPublishedFd(roots.destination, roots.destinationDevice, destinationRoot, destination, &flushed, &catalogError, &existingFd.fd)) return failRemote(catalogError);
        if (!recordReceipt(db, request, destinationStorageId, jobId, source, destination, destinationHash, &catalogError)) return failRemote(catalogError);
    } else {
        if (!statError.isEmpty()) return failRemote(statError);
        FdGuard freshParent; struct stat partialParentStat{}, freshParentStat{};
        if (::fstat(partialParent.fd, &partialParentStat) != 0 || (freshParent.fd = openDestinationParentFd(roots.destination, destinationRoot, destination, roots.destinationDevice, &catalogError)) < 0 || ::fstat(freshParent.fd, &freshParentStat) != 0 || partialParentStat.st_dev != freshParentStat.st_dev || partialParentStat.st_ino != freshParentStat.st_ino) return failRemote(catalogError.isEmpty() ? QStringLiteral("Destination parent changed before publication") : catalogError);
        const PublishResult publication = namedPartial.isEmpty() ? publishNoReplaceFd(partialVerified.fd, freshParent.fd, destination, &catalogError) : publishNamedNoReplaceFd(partialParent.fd, namedPartial, freshParent.fd, destination, &catalogError);
        if (publication == PublishResult::AlreadyExists) return failRemote("Destination appeared during MTP import", QStringLiteral("Conflict"), QStringLiteral("conflict"));
        if (publication != PublishResult::Published) return failRemote(catalogError.isEmpty() ? QStringLiteral("Destination publication failed") : catalogError);
        namedGuard.release();
        FdGuard published; struct stat publishedStat{};
        if (!flushPublishedFd(roots.destination, roots.destinationDevice, destinationRoot, destination, &publishedStat, &catalogError, &published.fd) || publishedStat.st_dev != partialStat.st_dev || publishedStat.st_ino != partialStat.st_ino) return failRemote(catalogError.isEmpty() ? QStringLiteral("Published destination changed before receipt") : catalogError);
        QByteArray finalHash; SourceFile finalSource = source; struct stat finalStat{};
        if (!sameFileOpenedFd(roots.destination, destinationRelative, finalSource, &finalHash, &finalStat, &catalogError) || finalHash != destinationHash || finalStat.st_dev != publishedStat.st_dev || finalStat.st_ino != publishedStat.st_ino) return failRemote(catalogError.isEmpty() ? QStringLiteral("Published destination changed after verification") : catalogError);
        if (!recordReceipt(db, request, destinationStorageId, jobId, source, destination, finalHash, &catalogError)) return failRemote(catalogError);
    }
    QSqlQuery final(db); final.prepare("UPDATE jobs SET state='Complete',completed_at=CURRENT_TIMESTAMP,error_code=NULL,error_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?"); final.addBindValue(jobId);
    if (!final.exec()) return failRemote(final.lastError().text());
    emit progressChanged(sourceSize, sourceSize, source.relative);
    closePins(roots); releaseDatabase(db, connection); return true;
}

bool VerifiedCopy::executeExportBlocking(const ExportRequest &remote, QString *error) {
    if (error) error->clear();
    const QFileInfo sourceInfo(remote.sourcePath);
    const QString relative = QDir::cleanPath(remote.destinationRelative);
    if (!sourceInfo.isFile() || !sourceInfo.isReadable()) { if (error) *error = QStringLiteral("Export source must be a readable local file"); return false; }
    if (!remote.destinationUrl.isValid() || (remote.destinationUrl.scheme() != QStringLiteral("mtp") && remote.destinationUrl.scheme() != QStringLiteral("file"))) { if (error) *error = QStringLiteral("Export destination must be an MTP or file URL"); return false; }
    if (relative.isEmpty() || relative == "." || relative == ".." || relative.startsWith("../") || relative.contains("/../") || QFileInfo(relative).isAbsolute()) { if (error) *error = QStringLiteral("Export destination path is unsafe"); return false; }
    if (remote.destinationStorageIdentity.isEmpty() || remote.destinationDeviceStableId.isEmpty()) { if (error) *error = QStringLiteral("Export destination identity is required"); return false; }

    QFile source(remote.sourcePath);
    if (!source.open(QIODevice::ReadOnly)) { if (error) *error = source.errorString(); return false; }
    QCryptographicHash digest(QCryptographicHash::Sha256);
    while (!source.atEnd()) { const QByteArray data = source.read(1024 * 1024); if (data.isEmpty() && source.error() != QFile::NoError) { if (error) *error = source.errorString(); return false; } digest.addData(data); }
    const QByteArray sourceHash = digest.result();
    const qint64 sourceSize = source.size(), sourceMtime = sourceInfo.lastModified().toMSecsSinceEpoch();
    source.close();

    QUrl parent = remote.destinationUrl.adjusted(QUrl::RemoveFilename);
    QUrl temporary = parent;
    temporary.setPath(parent.path() + QStringLiteral(".local-drive-%1.partial").arg(QUuid::createUuid().toString(QUuid::Id128)));
    Request request;
    const QUrl destinationRoot = remote.destinationRootUrl.isValid() ? remote.destinationRootUrl : parent;
    request.sourceRoot = sourceInfo.absolutePath(); request.destinationRoot = destinationRoot.toString(); request.selectedStorageRoot = destinationRoot.toString();
    request.storageIdentity = remote.destinationStorageIdentity; request.filesystemType = QStringLiteral("mtp"); request.databasePath = remote.databasePath.isEmpty() ? defaultCatalogPath() : remote.databasePath;
    request.routeId = remote.routeId; request.destinationStorageId = remote.destinationStorageId; request.destinationStorageKind = QStringLiteral("mtp"); request.destinationStorageLabel = remote.destinationStorageLabel;
    request.destinationDeviceId = remote.destinationDeviceId; request.destinationDeviceStableId = remote.destinationDeviceStableId; request.destinationDeviceName = remote.destinationDeviceName; request.destinationDeviceKind = QStringLiteral("Phone");
    SourceFile item{sourceInfo.fileName(), sourceInfo.absoluteFilePath(), relative, sourceSize, sourceMtime};
    Preview plan; plan.ok = true; plan.files = 1; plan.bytes = sourceSize; plan.toCopy = sourceSize; plan.manifest.append({item.relative, relative, sourceSize, sourceMtime});
    const QString connection = QStringLiteral("remote-export-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    auto db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(request.databasePath);
    if (!db.open()) { if (error) *error = db.lastError().text(); releaseDatabase(db, connection); return false; }
    QString routeId, jobId, destinationStorageId, catalogError;
    if (!prepareCatalog(db, request, plan, {item}, routeId, jobId, destinationStorageId, &catalogError)) { if (error) *error = catalogError; releaseDatabase(db, connection); return false; }
    const QString destination = remote.destinationUrl.toString();
    const QString itemId = stableItemId(jobId, item.relative);
    const auto failExport = [&](const QString &message, const QString &state = QStringLiteral("Failed"), const QString &event = QStringLiteral("failed")) {
        QString terminalError; terminalizeJob(db, jobId, &item, destination, state, event, message, &terminalError);
        if (error) *error = terminalError.isEmpty() ? message : QStringLiteral("Catalog terminalization failed: %1").arg(terminalError);
        releaseDatabase(db, connection); return false;
    };
    if (!setItemState(db, itemId, QStringLiteral("Copying"), &catalogError)) return failExport(catalogError);

    if (!ensureRemoteDirectory(destinationRoot, parent, &catalogError)) return failExport(QStringLiteral("MTP destination folder failed: %1").arg(catalogError));
    qint64 existingSize = 0; bool exists = false; QString statFailure;
    QEventLoop statLoop; auto *statJob = KIO::stat(remote.destinationUrl, KIO::StatJob::SourceSide, KIO::StatDefaultDetails, KIO::HideProgressInfo);
    QObject::connect(statJob, &KJob::result, &statLoop, [&](KJob *finished) {
        if (!finished->error()) { exists = true; existingSize = statJob->statResult().numberValue(KIO::UDSEntry::UDS_SIZE, -1); }
        else if (finished->error() != KIO::ERR_DOES_NOT_EXIST) statFailure = finished->errorText();
        statLoop.quit();
    });
    statLoop.exec();
    if (!statFailure.isEmpty()) return failExport(QStringLiteral("MTP destination check failed: %1").arg(statFailure));
    if (exists) {
        QByteArray existingHash;
        if (existingSize != sourceSize || !remoteHash(remote.destinationUrl, sourceSize, &existingHash, &catalogError) || existingHash != sourceHash) return failExport(QStringLiteral("Destination differs"), QStringLiteral("Conflict"), QStringLiteral("conflict"));
    } else {
        if (!runKioJob(KIO::file_copy(QUrl::fromLocalFile(sourceInfo.absoluteFilePath()), temporary, -1, KIO::HideProgressInfo), &catalogError)) return failExport(QStringLiteral("MTP export failed: %1").arg(catalogError));
        QByteArray stagedHash;
        if (!remoteHash(temporary, sourceSize, &stagedHash, &catalogError) || stagedHash != sourceHash) { runKioJob(KIO::del(temporary, KIO::HideProgressInfo), nullptr); return failExport(catalogError.isEmpty() ? QStringLiteral("MTP staged hash mismatch") : catalogError); }
        const QFileInfo sourceAfter(remote.sourcePath);
        if (!sourceAfter.isFile() || sourceAfter.size() != sourceSize || sourceAfter.lastModified().toMSecsSinceEpoch() != sourceMtime) { runKioJob(KIO::del(temporary, KIO::HideProgressInfo), nullptr); return failExport(QStringLiteral("Source changed during MTP export")); }
        if (!runKioJob(KIO::move(temporary, remote.destinationUrl, KIO::HideProgressInfo), &catalogError)) { runKioJob(KIO::del(temporary, KIO::HideProgressInfo), nullptr); return failExport(QStringLiteral("MTP publication failed: %1").arg(catalogError)); }
        QByteArray finalHash;
        if (!remoteHash(remote.destinationUrl, sourceSize, &finalHash, &catalogError) || finalHash != sourceHash) return failExport(catalogError.isEmpty() ? QStringLiteral("Published MTP destination failed verification") : catalogError);
    }
    if (!setItemState(db, itemId, QStringLiteral("Verifying"), &catalogError)) return failExport(catalogError);
    if (!recordReceipt(db, request, destinationStorageId, jobId, item, destination, sourceHash, &catalogError, relative)) return failExport(catalogError);
    QSqlQuery complete(db); complete.prepare("UPDATE jobs SET state='Complete',completed_at=CURRENT_TIMESTAMP,error_code=NULL,error_message=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?"); complete.addBindValue(jobId);
    if (!complete.exec()) return failExport(complete.lastError().text());
    emit progressChanged(sourceSize, sourceSize, relative);
    releaseDatabase(db, connection); return true;
}

bool VerifiedCopy::cleanupBlocking(const Request &request, QString *error) {
    const QString databasePath = request.databasePath.isEmpty() ? defaultCatalogPath() : request.databasePath;
    const QString connection = QStringLiteral("cleanup-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    auto db = QSqlDatabase::addDatabase("QSQLITE", connection); db.setDatabaseName(databasePath);
    if (!db.open()) { if (error) *error = db.lastError().text(); return false; }
    QSqlQuery job(db); job.prepare("SELECT id FROM jobs WHERE route_id=? AND keep_policy=? AND state='Cleanup pending' ORDER BY created_at DESC,rowid DESC LIMIT 1"); job.addBindValue(request.routeId); job.addBindValue(request.keepPolicy);
    if (!job.exec() || !job.next()) { if (error) *error = "No verified job is waiting for cleanup"; releaseDatabase(db, connection); return false; }
    const QString jobId = job.value(0).toString();
    const bool result = trashVerifiedMove(db, request, jobId, error, &m_cancelled, m_testHook);
    releaseDatabase(db, connection);
    return result;
}

bool VerifiedCopy::execute(const Request &request, const Preview &authorized, QString *error, QString *completionMessage) {
    const Preview plan = authorized;
    if (!plan.ok) { if (error) *error = plan.error; return false; }
    const QString sourceRoot = canonicalDir(request.sourceRoot), destinationRoot = canonicalDir(request.destinationRoot);
    if (sourceRoot.isEmpty() || destinationRoot.isEmpty()) {
        const QString failure = sourceRoot.isEmpty() ? QStringLiteral("Source folder is unavailable after preview") : QStringLiteral("Destination folder is unavailable after preview");
        QString catalogError;
        if (!recordRejectedPlan(request, plan, failure, &catalogError) && error) *error = "Catalog terminalization failed: " + catalogError;
        else if (error) *error = failure;
        return false;
    }
    PinGuard rootPins;
    QString pinError;
    if (!pinRoots(sourceRoot, destinationRoot, rootPins.pins, &pinError)) {
        const QString failure = pinError.isEmpty() ? QStringLiteral("Destination folder is unavailable after preview") : pinError;
        QString catalogError;
        if (!recordRejectedPlan(request, plan, failure, &catalogError) && error) *error = "Catalog terminalization failed: " + catalogError;
        else if (error) *error = failure;
        return false;
    }
    QVector<SourceFile> files; qint64 unsupported = 0; QStringList unsupportedPaths, unsupportedEvidence; QString scanError; scanPinned(rootPins.pins.source, sourceRoot, {}, files, unsupported, unsupportedPaths, unsupportedEvidence, &scanError, &m_cancelled);
    if (!scanError.isEmpty()) { if (error) *error = scanError; return false; }
    unsupportedEvidence.sort(); unsupportedEvidence.removeDuplicates();
    QStringList acceptedUnsupported = request.acceptedUnsupportedEvidence; acceptedUnsupported.sort(); acceptedUnsupported.removeDuplicates();
    if (unsupportedEvidence != acceptedUnsupported) { if (error) *error = "Unsupported-item evidence changed; preview again"; return false; }
    if (!excludeSources(files, request.excludedSourcePaths, error)) return false;
    std::sort(files.begin(), files.end(), [](const SourceFile &a, const SourceFile &b) { return a.relative < b.relative; });
    assignDestinationPaths(request, files);
    if (!validateDestinationOverrides(request, files, error)) return false;
    const bool manifestMatches = files.size() == plan.manifest.size()
        && std::equal(files.cbegin(), files.cend(), plan.manifest.cbegin(), [](const SourceFile &file, const Preview::ManifestEntry &entry) {
            return file.relative == entry.relative && file.destinationRelative == entry.destination && file.size == entry.size && file.mtime == entry.mtime;
        });
    if (!manifestMatches) {
        const QString failure = "Source changed after preview; manifest no longer matches";
        QString catalogError;
        if (!recordRejectedPlan(request, plan, failure, &catalogError) && error) *error = "Catalog terminalization failed: " + catalogError;
        else if (error) *error = failure;
        return false;
    }
    QString connectionError;
    const QString connection = QStringLiteral("copy-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    auto db = QSqlDatabase::addDatabase("QSQLITE", connection);
    db.setDatabaseName(request.databasePath.isEmpty() ? defaultCatalogPath() : request.databasePath);
    if (!db.open()) { if (error) *error = db.lastError().text(); return false; }
    QString routeId, jobId, destinationStorageId;
    if (!prepareCatalog(db, request, plan, files, routeId, jobId, destinationStorageId, &connectionError)) { releaseDatabase(db, connection); if (error) *error = connectionError; return false; }
    qint64 done = 0;
    bool conflictSeen = false;
    const auto rootsStillPinned = [&] {
        QString identityError;
        return liveRootMatches(sourceRoot, rootPins.pins.sourceDevice, rootPins.pins.sourceInode) && liveRootMatches(destinationRoot, rootPins.pins.destinationDevice, rootPins.pins.destinationInode) && VerifiedCopy::liveStorageIdentity(destinationRoot, &identityError) == request.storageIdentity;
    };
    for (const SourceFile &source : files) {
        const QString itemId = stableItemId(jobId, source.relative);
        if (!waitIfPaused(db, jobId, &connectionError)) { if (error) *error = connectionError; releaseDatabase(db, connection); return false; }
        if (m_cancelled.load()) {
            if (!terminalizeJob(db, jobId, &source, QDir(destinationRoot).filePath(source.destinationRelative), "Cancelled", "cancelled", "cancelled before file", &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; releaseDatabase(db, connection); return false; }
            releaseDatabase(db, connection); if (error) *error = "Copy cancelled; source retained and no final destination was published"; return false;
        }
        const QString destination = QDir(destinationRoot).filePath(source.destinationRelative);
        QByteArray destinationHash; struct stat boundDestination{}; FdGuard boundDestinationFd;
        if (sameFileOpenedFd(rootPins.pins.destination, source.destinationRelative, source, &destinationHash, &boundDestination, &connectionError, &boundDestinationFd.fd)) {
            QString sourceError; QByteArray sourceHash;
            if (!sameFileOpenedFd(rootPins.pins.source, source.relative, source, &sourceHash, nullptr, &sourceError)) { const QString failure = sourceError.isEmpty() ? "Source could not be opened safely" : sourceError; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (sourceHash != destinationHash) { conflictSeen = true; if (!markItemTerminal(db, jobId, source, destination, "Conflict", "conflict", "destination differs", &connectionError)) { if (error) *error = connectionError; releaseDatabase(db, connection); return false; } done += source.size; emit progressChanged(done, plan.bytes, source.relative); continue; }
            if (!rootsStillPinned()) { const QString failure = "Destination storage identity changed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (boundDestinationFd.fd < 0 || ::fsync(boundDestinationFd.fd) != 0) { const QString failure = "Existing destination could not be flushed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            struct stat flushedDestination{};
            if (!flushPublishedFd(rootPins.pins.destination, rootPins.pins.destinationDevice, destinationRoot, destination, &flushedDestination, &connectionError) || flushedDestination.st_dev != boundDestination.st_dev || flushedDestination.st_ino != boundDestination.st_ino) { const QString failure = "Existing destination changed before receipt"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (m_testHook) m_testHook(destination, QStringLiteral("before-existing-receipt"));
            QByteArray receiptHash; struct stat receiptStat{};
            if (!sameFileOpenedFd(rootPins.pins.destination, source.destinationRelative, source, &receiptHash, &receiptStat, &connectionError) || receiptHash != sourceHash || receiptStat.st_dev != boundDestination.st_dev || receiptStat.st_ino != boundDestination.st_ino || ::fsync(boundDestinationFd.fd) != 0) { const QString failure = "Existing destination changed before receipt"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (m_testHook) m_testHook(destination, QStringLiteral("before-existing-receipt-final-hash"));
            struct stat finalAfterHook{}; QByteArray hashAfterHook;
            if (!sameFileOpenedFd(rootPins.pins.destination, source.destinationRelative, source, &hashAfterHook, &finalAfterHook, &connectionError) || hashAfterHook != sourceHash || finalAfterHook.st_dev != boundDestination.st_dev || finalAfterHook.st_ino != boundDestination.st_ino || ::fsync(boundDestinationFd.fd) != 0) { const QString failure = "Existing destination changed after final hash"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            receiptHash = hashAfterHook;
            if (!rootsStillPinned()) { const QString failure = "Destination storage identity changed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (!recordReceipt(db, request, destinationStorageId, jobId, source, destination, receiptHash, &connectionError)) { const QString failure = connectionError; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            done += source.size; emit progressChanged(done, plan.bytes, source.relative); continue;
        }
        QString existingError;
        struct stat existingAny{};
        if (statPinned(rootPins.pins.destination, destinationRoot, source.destinationRelative, &existingAny, &existingError)) { conflictSeen = true; if (!markItemTerminal(db, jobId, source, destination, "Conflict", "conflict", "destination differs", &connectionError)) { if (error) *error = connectionError; releaseDatabase(db, connection); return false; } done += source.size; emit progressChanged(done, plan.bytes, source.relative); continue; }
        if (m_testHook) m_testHook(destination, QStringLiteral("before-space-check"));
        if (!rootsStillPinned()) { const QString failure = "Destination storage identity changed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        QStorageInfo liveStorage(destinationRoot); liveStorage.refresh();
        const qint64 available = liveStorage.bytesAvailable();
        if (available < source.size || available - source.size < request.minimumFreeBytes) { const QString failure = "Not enough free space during transfer; source retained"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        if (!setItemState(db, itemId, "Copying", &connectionError)) { releaseDatabase(db, connection); if (error) *error = connectionError; return false; }
        QFile sourceFile, partialFile; FdGuard partialParent;
        if (m_testHook) m_testHook(destination, QStringLiteral("before-partial-open"));
        const int sourceFd = openBeneathFd(rootPins.pins.source, source.relative, O_RDONLY | O_NONBLOCK | O_CLOEXEC, 0, &connectionError);
        struct stat sourceStat{};
        if (sourceFd < 0 || !sourceFile.open(sourceFd, QIODevice::ReadOnly, QFileDevice::AutoCloseHandle) || ::fstat(sourceFile.handle(), &sourceStat) != 0 || !S_ISREG(sourceStat.st_mode) || sourceStat.st_size != source.size || (sourceStat.st_mtim.tv_sec * 1000 + sourceStat.st_mtim.tv_nsec / 1000000) != source.mtime || !openPartialFd(rootPins.pins.destination, rootPins.pins.destinationDevice, destinationRoot, destination, partialFile, &partialParent.fd, &connectionError)) { const QString failure = connectionError.isEmpty() ? "Source changed or anonymous staging could not be opened" : connectionError; if (sourceFile.isOpen()) sourceFile.close(); else if (sourceFd >= 0) ::close(sourceFd); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        QCryptographicHash sourceHash(QCryptographicHash::Sha256); qint64 copied = 0; bool copyHookFired = false;
        while (!sourceFile.atEnd()) {
            if (!waitIfPaused(db, jobId, &connectionError)) { if (error) *error = connectionError; partialFile.close(); sourceFile.close(); releaseDatabase(db, connection); return false; }
            if (m_cancelled.load()) { partialFile.flush(); partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Cancelled", "cancelled", "cancelled during copy", &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = "Copy cancelled; source retained and no final destination was published"; releaseDatabase(db, connection); return false; }
            const QByteArray chunk = sourceFile.read(1024 * 1024);
            if (chunk.isEmpty() && !sourceFile.atEnd()) { const QString failure = sourceFile.errorString(); partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            if (partialFile.write(chunk) != chunk.size()) { const QString failure = partialFile.errorString(); partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
            sourceHash.addData(chunk); copied += chunk.size();
            if (!copyHookFired && m_testHook) { copyHookFired = true; m_testHook(destination, QStringLiteral("during-copy")); }
        }
        if (!partialFile.flush()) { const QString failure = partialFile.errorString(); partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        const int partialFd = partialFile.handle();
        if (partialFd < 0 || ::fsync(partialFd) != 0) { const QString failure = "Destination file could not be flushed"; partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        if (!setItemState(db, itemId, QStringLiteral("Verifying"), &connectionError)) { if (error) *error = connectionError; partialFile.close(); sourceFile.close(); releaseDatabase(db, connection); return false; }
        if (m_testHook) m_testHook(destination, QStringLiteral("before-verification"));
        if (!waitIfPaused(db, jobId, &connectionError)) { if (error) *error = connectionError; partialFile.close(); sourceFile.close(); releaseDatabase(db, connection); return false; }
        if (m_cancelled.load()) { partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Cancelled", "cancelled", "cancelled during verification", &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = "Copy cancelled; source retained and no final destination was published"; releaseDatabase(db, connection); return false; }
        QByteArray verifiedHash; struct stat partialStat{}; FdGuard partialVerifiedFd;
        if (!hashFd(partialFd, source.size, &verifiedHash, &partialStat, &connectionError, &partialVerifiedFd.fd) || verifiedHash != sourceHash.result()) { const QString failure = connectionError.isEmpty() ? "Destination hash mismatch" : connectionError; partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        if (!waitIfPaused(db, jobId, &connectionError)) { if (error) *error = connectionError; partialFile.close(); sourceFile.close(); releaseDatabase(db, connection); return false; }
        if (m_cancelled.load()) { partialFile.close(); sourceFile.close(); if (!terminalizeJob(db, jobId, &source, destination, "Cancelled", "cancelled", "cancelled during verification", &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = "Copy cancelled; source retained and no final destination was published"; releaseDatabase(db, connection); return false; }
        partialFile.close();
        if (m_testHook) m_testHook(source.absolute, QStringLiteral("before-source-recheck"));
        if (!waitIfPaused(db, jobId, &connectionError)) { if (error) *error = connectionError; sourceFile.close(); releaseDatabase(db, connection); return false; }
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
            if (sameFileOpenedFd(rootPins.pins.destination, source.destinationRelative, source, &existingHash, &existingStat, &connectionError) && existingHash == verifiedHash) {
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
        if (publishedFd.fd < 0 || ::fstat(publishedFd.fd, &pinnedFinal) != 0 || !sameFileOpenedFd(rootPins.pins.destination, source.destinationRelative, source, &receiptHash, &receiptStat, &connectionError) || receiptHash != verifiedHash || receiptStat.st_dev != publishedStat.st_dev || receiptStat.st_ino != publishedStat.st_ino || pinnedFinal.st_dev != publishedStat.st_dev || pinnedFinal.st_ino != publishedStat.st_ino) { const QString failure = "Published destination changed before receipt"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        if (m_testHook) m_testHook(destination, QStringLiteral("before-receipt-final-hash"));
        struct stat finalAfterHook{}; QByteArray hashAfterHook;
        if (!sameFileOpenedFd(rootPins.pins.destination, source.destinationRelative, source, &hashAfterHook, &finalAfterHook, &connectionError) || hashAfterHook != verifiedHash || finalAfterHook.st_dev != publishedStat.st_dev || finalAfterHook.st_ino != publishedStat.st_ino || ::fstat(publishedFd.fd, &pinnedFinal) != 0 || pinnedFinal.st_dev != publishedStat.st_dev || pinnedFinal.st_ino != publishedStat.st_ino) { const QString failure = "Published destination changed after final hash"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        receiptHash = hashAfterHook;
        if (!rootsStillPinned()) { const QString failure = "Destination storage identity changed"; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        if (!recordReceipt(db, request, destinationStorageId, jobId, source, destination, receiptHash, &connectionError)) { const QString failure = connectionError; if (!terminalizeJob(db, jobId, &source, destination, "Failed", "failed", failure, &connectionError)) { if (error) *error = "Catalog terminalization failed: " + connectionError; } else if (error) *error = failure; releaseDatabase(db, connection); return false; }
        done += copied; emit progressChanged(done, plan.bytes, source.relative);
    }
    QSqlQuery final(db); final.prepare("UPDATE jobs SET state=?,error_code=CASE WHEN ?='Conflict' THEN 'name_conflict' ELSE NULL END,error_message=CASE WHEN ?='Conflict' THEN 'One or more destinations differ' ELSE NULL END,completed_at=CASE WHEN ?='Cleanup pending' THEN NULL ELSE CURRENT_TIMESTAMP END,updated_at=CURRENT_TIMESTAMP WHERE id=?"); const QString finalState = conflictSeen ? QStringLiteral("Conflict") : (request.keepPolicy != "Everything" ? QStringLiteral("Cleanup pending") : QStringLiteral("Complete")); final.addBindValue(finalState); final.addBindValue(finalState); final.addBindValue(finalState); final.addBindValue(finalState); final.addBindValue(jobId);
    if (!final.exec()) { if (error) *error = final.lastError().text(); final.finish(); releaseDatabase(db, connection); return false; }
    final.finish();
    if (completionMessage) *completionMessage = conflictSeen ? QStringLiteral("Completed with conflicts") : (request.keepPolicy != "Everything" ? QStringLiteral("Cleanup pending — review before moving eligible sources to Trash") : QStringLiteral("Complete"));
    releaseDatabase(db, connection); return true;
}
