#include "remoteinventory.h"

#include <QDir>
#include <QEventLoop>

#include <KIO/ListJob>
#include <KIO/UDSEntry>

namespace {
QString safeRemoteRelative(const QUrl &root, const QUrl &item) {
    if (root.scheme() != item.scheme() || root.host() != item.host()) return {};
    const QString rootPath = QDir::cleanPath(root.path(QUrl::FullyDecoded));
    const QString itemPath = QDir::cleanPath(item.path(QUrl::FullyDecoded));
    const QString prefix = rootPath.endsWith('/') ? rootPath : rootPath + '/';
    if (!itemPath.startsWith(prefix)) return {};
    const QString relative = QDir::fromNativeSeparators(itemPath.mid(prefix.size()));
    return relative.isEmpty() || relative == "." || relative == ".." || relative.startsWith("../") || relative.contains("/../") ? QString() : relative;
}
}

bool collectRemoteDirectory(const QUrl &root, qint64 maxItems, qint64 maxBytes,
                            QVector<RemoteInventoryItem> &items, QString *error) {
    if (maxItems < 0 || maxBytes < 0) { if (error) *error = "scan limits cannot be negative"; return false; }
    QEventLoop loop;
    bool bounded = false, invalid = false, failed = false;
    qint64 bytes = 0;
    auto *job = KIO::listRecursive(root, KIO::HideProgressInfo, KIO::ListJob::ListFlag::ExcludeDotAndDotDot);
    QObject::connect(job, &KIO::ListJob::entries, &loop, [&items, &bytes, &bounded, &invalid, root, maxItems, maxBytes, job](KIO::Job *, const KIO::UDSEntryList &entries) {
        if (bounded || invalid) return;
        for (const auto &entry : entries) {
            if (entry.numberValue(KIO::UDSEntry::UDS_FILE_TYPE, 0) == 0040000) continue;
            const qint64 size = entry.numberValue(KIO::UDSEntry::UDS_SIZE, -1);
            QUrl url(entry.stringValue(KIO::UDSEntry::UDS_URL));
            QString relative = safeRemoteRelative(root, url);
            if (relative.isEmpty()) {
                relative = QDir::fromNativeSeparators(entry.stringValue(KIO::UDSEntry::UDS_NAME));
                if (!relative.isEmpty() && relative != "." && relative != ".." && !relative.startsWith("../") && !relative.contains("/../")) {
                    url = root;
                    QString path = root.path(QUrl::FullyDecoded);
                    if (!path.endsWith('/')) path += '/';
                    url.setPath(path + relative);
                }
            }
            if (size < 0 || !url.isValid() || relative.isEmpty()) { invalid = true; job->kill(KJob::EmitResult); return; }
            if ((maxItems > 0 && items.size() >= maxItems) || (maxBytes > 0 && (bytes > maxBytes || size > maxBytes - bytes))) { bounded = true; job->kill(KJob::EmitResult); return; }
            items.append({url, relative, size});
            bytes += size;
        }
    });
    QObject::connect(job, &KJob::result, &loop, [&loop, &bounded, &invalid, &failed, error](KJob *finished) {
        if (bounded) { if (error) *error = "scan bounds exceeded; source was not modified"; }
        else if (invalid) { if (error) *error = "source inventory entry is invalid"; }
        else if (finished->error()) { failed = true; if (error) *error = finished->errorText(); }
        loop.quit();
    });
    loop.exec();
    return !bounded && !invalid && !failed;
}
