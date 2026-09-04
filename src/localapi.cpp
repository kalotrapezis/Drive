#include "localapi.h"

#include "setupmodel.h"
#include "verifiedcopy.h"

#include <algorithm>
#include <QDir>
#include <QCoreApplication>
#include <QMimeDatabase>
#include <QTimer>
#include <QDirIterator>
#include <QDateTime>
#include <QDesktopServices>
#include <QBuffer>
#include <QCryptographicHash>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QImage>
#include <QImageReader>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QMutexLocker>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QSet>
#include <QSaveFile>
#include <QStandardPaths>
#include <QProcess>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <QStorageInfo>
#include <QTcpSocket>
#include <QThread>
#include <QTimeZone>
#include <QUrl>
#include <QUrlQuery>
#include <QUuid>
#include <algorithm>
#include <utility>

namespace {
QJsonArray json(const QVariantList &items) { return QJsonArray::fromVariantList(items); }

void sendResponse(QTcpSocket *socket, const QByteArray &status, const QByteArray &payload, const QByteArray &contentType = "application/json") {
    if (!socket || socket->state() == QAbstractSocket::UnconnectedState) return;
    socket->setProperty("handled", true);
    socket->write("HTTP/1.1 " + status + "\r\nContent-Type: " + contentType + "\r\nContent-Length: "
                  + QByteArray::number(payload.size()) + "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n" + payload);
    socket->disconnectFromHost();
}

void sendJson(QTcpSocket *socket, const QByteArray &status, const QJsonObject &body) {
    sendResponse(socket, status, QJsonDocument(body).toJson(QJsonDocument::Compact));
}

QByteArray statusText(int status) {
    if (status == 200) return "200 OK";
    if (status == 202) return "202 Accepted";
    if (status == 400) return "400 Bad Request";
    if (status == 404) return "404 Not Found";
    if (status == 409) return "409 Conflict";
    return "500 Internal Server Error";
}

QVariantMap routeFor(const SetupModel *model, const QString &contentType) {
    for (const auto &value : model->routes()) {
        const auto route = value.toMap();
        if (route.value("contentType") == contentType) return route;
    }
    return {};
}

QString screenshotsRoot() {
#ifdef LOCAL_DRIVE_TESTING
    if (qEnvironmentVariableIsSet("LOCAL_DRIVE_TEST_SCREENSHOTS")) return qEnvironmentVariable("LOCAL_DRIVE_TEST_SCREENSHOTS");
#endif
    const QString pictures = QStandardPaths::writableLocation(QStandardPaths::PicturesLocation);
    return pictures.isEmpty() ? QString() : QDir(pictures).filePath("Screenshots");
}

bool isPhoto(const QFileInfo &file) {
    static const QSet<QString> extensions{"jpg", "jpeg", "png", "webp", "gif", "tif", "tiff", "avif"};
    return extensions.contains(file.suffix().toLower());
}

bool isVideo(const QFileInfo &file) {
    static const QSet<QString> extensions{"mp4", "mov", "m4v", "avi", "mkv", "webm", "3gp"};
    return extensions.contains(file.suffix().toLower());
}

bool safeRelative(const QString &relative) {
    return !relative.isEmpty() && !QDir::isAbsolutePath(relative) && relative != ".." && !relative.startsWith("../")
        && !relative.contains("/../") && !relative.endsWith("/..") && !relative.contains('\\');
}

QJsonObject catalogState(const QString &path) {
    QJsonObject result{{"pendingFiles", 0}, {"pendingBytes", 0}, {"lastMetadataUpdate", QString()}, {"activeTransfer", QJsonValue::Null}};
    const QString connection = QStringLiteral("local-api-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    {
        QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection);
        db.setDatabaseName(path);
        db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
        if (db.open()) {
            QSqlQuery pending(db);
            if (pending.exec("SELECT COUNT(*),COALESCE(SUM(size_bytes),0),COALESCE(MAX(updated_at),'') FROM pending_metadata WHERE state='pending'") && pending.next()) {
                result.insert("pendingFiles", pending.value(0).toLongLong());
                result.insert("pendingBytes", pending.value(1).toLongLong());
                result.insert("lastMetadataUpdate", pending.value(2).toString());
            }
            QSqlQuery active(db);
            if (active.exec("SELECT j.state,j.bytes_total,j.bytes_done,j.updated_at,COALESCE(s.label,'') FROM jobs j JOIN routes r ON r.id=j.route_id LEFT JOIN storage s ON s.id=r.destination_storage_id WHERE j.state IN ('Queued','Copying','Verifying','Paused') ORDER BY j.updated_at DESC LIMIT 1") && active.next()) {
                result.insert("activeTransfer", QJsonObject{{"state", active.value(0).toString()},
                                                            {"bytesTotal", active.value(1).toLongLong()},
                                                            {"bytesDone", active.value(2).toLongLong()},
                                                            {"updatedAt", active.value(3).toString()},
                                                            {"destination", active.value(4).toString()}});
            }
        }
        db.close();
    }
    QSqlDatabase::removeDatabase(connection);
    return result;
}

void saveImportReviewItems(const QString &databasePath, const QString &source, const QString &target, const VerifiedCopy::Preview &preview) {
    struct Finding { QString category, title, summary, state; qint64 count; QStringList paths, evidence; };
    const QList<Finding> findings{
        {"Duplicates", "Exact duplicates found during import preview", "Choose which locations to retain before import execution.", "needs_decision", preview.duplicates + preview.destinationDuplicates, preview.duplicatePaths, {}},
        {"Conflicts", "Destination paths contain different files", "Compare the versions before anything is copied or replaced.", "needs_decision", preview.conflicts, preview.conflictPaths, preview.conflictEvidence},
        {"Permissions", "Some source items could not be read", "Fix folder permissions and run the preview again.", "can_retry", preview.unreadable, {}, {}},
        {"Unsupported", "Unsupported source items were skipped", "Keep them in the source or replace them with regular files before import.", "needs_decision", preview.unsupported, preview.unsupportedPaths, preview.unsupportedEvidence},
    };
    if (std::none_of(findings.cbegin(), findings.cend(), [](const Finding &finding) { return finding.count > 0; })) return;
    const QString connection = QStringLiteral("import-review-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    {
        QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection);
        db.setDatabaseName(databasePath);
        if (db.open() && db.transaction()) {
            bool ok = true;
            for (const Finding &finding : findings) {
                if (finding.count <= 0) continue;
                const QByteArray evidence = (source + '\n' + target + '\n' + finding.category + '\n' + finding.paths.join('\n') + '\n' + finding.evidence.join('\n')).toUtf8();
                const QString sourceId = QString::fromLatin1(QCryptographicHash::hash(evidence, QCryptographicHash::Sha256).toHex());
                const QJsonObject details{{"source", source}, {"target", target}, {"paths", QJsonArray::fromStringList(finding.paths)}, {"evidence", QJsonArray::fromStringList(finding.evidence)}};
                QSqlQuery query(db);
                query.prepare("INSERT INTO review_items(id,category,source_kind,source_id,title,summary,details_json,item_count,state) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_kind,source_id,category) DO UPDATE SET title=excluded.title,summary=excluded.summary,details_json=excluded.details_json,item_count=excluded.item_count,updated_at=CURRENT_TIMESTAMP,state=CASE WHEN review_items.state IN ('saved','resolved','dismissed') THEN review_items.state ELSE excluded.state END");
                query.addBindValue(QStringLiteral("review-%1").arg(sourceId)); query.addBindValue(finding.category); query.addBindValue("import"); query.addBindValue(sourceId); query.addBindValue(finding.title); query.addBindValue(finding.summary); query.addBindValue(QString::fromUtf8(QJsonDocument(details).toJson(QJsonDocument::Compact))); query.addBindValue(finding.count); query.addBindValue(finding.state);
                if (!query.exec()) { ok = false; break; }
            }
            if (ok) db.commit(); else db.rollback();
        }
        db.close();
    }
    QSqlDatabase::removeDatabase(connection);
}

QStringList acceptedImportValues(const QString &databasePath, const QString &source, const QString &target, const QString &category, const QString &action, const QString &key) {
    QStringList result;
    const QString connection = QStringLiteral("accepted-import-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    {
        QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(databasePath); db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
        if (db.open()) {
            QSqlQuery query(db);
            query.prepare("SELECT ri.details_json FROM review_items ri JOIN review_resolutions rr ON rr.review_item_id=ri.id AND rr.action=? WHERE ri.category=? AND ri.source_kind='import' AND ri.state='resolved' ORDER BY rr.occurred_at DESC,rr.rowid DESC");
            query.addBindValue(action); query.addBindValue(category);
            if (query.exec()) while (query.next()) {
                const QJsonObject details = QJsonDocument::fromJson(query.value(0).toByteArray()).object();
                if (details.value("source").toString() != source || details.value("target").toString() != target) continue;
                for (const QJsonValue &value : details.value(key).toArray()) if (value.isString()) result.append(value.toString());
                break;
            }
        }
        db.close();
    }
    QSqlDatabase::removeDatabase(connection);
    result.sort(); result.removeDuplicates();
    return result;
}

QStringList acceptedDuplicatePairs(const QString &databasePath, const QString &source, const QString &target) { return acceptedImportValues(databasePath, source, target, "Duplicates", "accept_existing", "paths"); }
QStringList acceptedConflictEvidence(const QString &databasePath, const QString &source, const QString &target) { return acceptedImportValues(databasePath, source, target, "Conflicts", "keep_both", "evidence"); }
QStringList acceptedUnsupportedEvidence(const QString &databasePath, const QString &source, const QString &target) { return acceptedImportValues(databasePath, source, target, "Unsupported", "skip_unsupported", "evidence"); }

QString importedName(const QString &destinationRoot, const QString &relative, QSet<QString> &reserved) {
    const QFileInfo info(relative);
    const QString directory = info.path() == "." ? QString() : info.path() + "/";
    const QString suffix = info.suffix().isEmpty() ? QString() : "." + info.suffix();
    const QString stem = info.completeBaseName();
    for (int number = 1; number < 10000; ++number) {
        const QString marker = number == 1 ? QStringLiteral(" (imported)") : QStringLiteral(" (imported %1)").arg(number);
        const QString candidate = directory + stem + marker + suffix;
        if (!reserved.contains(candidate) && !QFileInfo::exists(QDir(destinationRoot).filePath(candidate))) { reserved.insert(candidate); return candidate; }
    }
    return {};
}
}

LocalApi::LocalApi(SetupModel *model, QObject *parent)
    : QObject(parent), m_model(model), m_token(QUuid::createUuid().toString(QUuid::Id128).toUtf8()) {
    connect(&m_tcp, &QTcpServer::newConnection, this, &LocalApi::acceptConnections);
}

LocalApi::~LocalApi() {
    m_stopping.store(true);
    for (QThread *worker : std::as_const(m_workers)) if (worker) worker->wait();
}

bool LocalApi::start(quint16 port) {
    return m_model && m_tcp.listen(QHostAddress::LocalHost, port);
}

void LocalApi::setWebRoot(QString root) {
    m_webRoot = !root.isEmpty() && QFileInfo(root).isDir() ? QFileInfo(root).canonicalFilePath() : QString();
}

bool LocalApi::isLoopbackBound() const {
    return m_tcp.isListening() && m_tcp.serverAddress().isLoopback();
}

void LocalApi::acceptConnections() {
    while (auto *socket = m_tcp.nextPendingConnection()) {
        socket->setReadBufferSize(16 * 1024 + 1);
        auto *deadline = new QTimer(socket);
        deadline->setSingleShot(true);
        connect(deadline, &QTimer::timeout, socket, [socket] {
            if (!socket->property("handled").toBool()) sendJson(socket, "408 Request Timeout", {{"error", "Request deadline exceeded"}});
        });
        deadline->start(10000);
        connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
        connect(socket, &QTcpSocket::readyRead, socket, [this, socket, deadline] {
            if (socket->property("handled").toBool()) return;
            QByteArray request = socket->property("request").toByteArray() + socket->readAll();
            if (request.size() > 16 * 1024) { sendJson(socket, "413 Content Too Large", {{"error", "Request too large"}}); return; }
            socket->setProperty("request", request);
            const qsizetype headerEnd = request.indexOf("\r\n\r\n");
            if (headerEnd < 0) return;
            QByteArray headerCharacters = request.left(headerEnd);
            headerCharacters.replace("\r\n", "");
            if (headerCharacters.contains('\r') || headerCharacters.contains('\n')) { sendJson(socket, "400 Bad Request", {{"error", "Invalid header lines"}}); return; }

            const QList<QByteArray> headerLines = request.left(headerEnd).split('\n');
            QHash<QByteArray, QByteArray> headers;
            for (const QByteArray &rawLine : headerLines.mid(1)) {
                QByteArray line = rawLine;
                if (line.endsWith('\r')) line.chop(1);
                const qsizetype separator = line.indexOf(':');
                const QByteArray name = line.left(separator).toLower();
                const bool validName = separator > 0 && std::all_of(name.begin(), name.end(), [](unsigned char c) {
                    return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || QByteArray("!#$%&'*+-.^_`|~").contains(c);
                });
                const bool validValue = std::all_of(line.begin(), line.end(), [](unsigned char c) { return c == '\t' || (c >= 32 && c != 127); });
                if (!validName || !validValue || headers.contains(name)) { sendJson(socket, "400 Bad Request", {{"error", "Invalid or duplicate header"}}); return; }
                headers.insert(name, line.mid(separator + 1).trimmed());
            }
            const auto allowedHost = [this](const QByteArray &host) {
                for (quint16 p : {port(), quint16(5173), quint16(4173)})
                    if (host == "localhost:" + QByteArray::number(p) || host == "127.0.0.1:" + QByteArray::number(p)) return true;
                return false;
            };
            if (!allowedHost(headers.value("host")) || (headers.contains("origin") &&
                (!headers.value("origin").startsWith("http://") || !allowedHost(headers.value("origin").mid(7)))) ||
                headers.value("sec-fetch-site").toLower() == "cross-site") {
                sendJson(socket, "403 Forbidden", {{"error", "Local origin required"}}); return;
            }
            const QByteArray length = headers.value("content-length", "0");
            bool lengthOk = true;
            const qint64 contentLength = length.toLongLong(&lengthOk);
            if (headers.contains("transfer-encoding") || headers.contains("expect") || !lengthOk || length.isEmpty() ||
                !std::all_of(length.begin(), length.end(), [](char c) { return c >= '0' && c <= '9'; }) || contentLength > 8 * 1024) {
                sendJson(socket, "400 Bad Request", {{"error", "Invalid request framing"}}); return;
            }
            if (request.size() < headerEnd + 4 + contentLength) return;

            const QList<QByteArray> parts = request.left(request.indexOf("\r\n")).split(' ');
            if (parts.size() != 3 || (parts[2] != "HTTP/1.1" && parts[2] != "HTTP/1.0") ||
                !parts[1].startsWith('/') || parts[1].startsWith("//") || parts[1].contains('#') ||
                std::any_of(parts[1].begin(), parts[1].end(), [](unsigned char c) { return c <= 32 || c == 127; }) ||
                !QUrl::fromEncoded(parts[1], QUrl::StrictMode).isValid() || request.size() != headerEnd + 4 + contentLength) {
                sendJson(socket, "400 Bad Request", {{"error", "Invalid request or pipelining"}}); return;
            }
            socket->setProperty("handled", true);
            socket->setProperty("request", QVariant());
            deadline->stop();
            QByteArray status = "404 Not Found", contentType = "application/json";
            QJsonObject body{{"error", "Not found"}};
            QByteArray payload;
            if (parts[0] == "GET") {
                const QUrl url = QUrl::fromEncoded(parts[1]);
                const QString path = url.path();
                if (path == "/api/v1/health") { status = "200 OK"; body = {{"status", "ok"}, {"apiVersion", 1}, {"application", "local-drive"}, {"appVersion", QCoreApplication::applicationVersion()}, {"userId", static_cast<qint64>(::geteuid())}}; }
                else if (path == "/api/v1/session") { status = "200 OK"; body = {{"token", QString::fromUtf8(m_token)}}; }
                else if (path == "/api/v1/templates") { status = "200 OK"; body = templates(); }
                else if (path == "/api/v1/file-labels") { body = fileLabels(); body.insert("root", QFileInfo(routeFor(m_model, "Drive").value("source").toString()).canonicalFilePath()); status = body.contains("error") ? "500 Internal Server Error" : "200 OK"; }
                else if (path == "/api/v1/labelled-files") { body = labelledFiles(QUrlQuery(url).queryItemValue("root"), QUrlQuery(url).queryItemValue("filter") == "favorites"); status = body.contains("error") ? "400 Bad Request" : "200 OK"; }
                else if (path == "/api/v1/refresh-connections") { m_model->refreshMtpDevices(); status = "202 Accepted"; body = {{"state", "checking"}}; }
                else if (path == "/api/v1/state") { status = "200 OK"; body = state(); }
                else if (path == "/api/v1/files") { int fileStatus = 200; body = files(QUrlQuery(url).queryItemValue("path", QUrl::FullyDecoded), &fileStatus); status = statusText(fileStatus); }
                else if (path == "/api/v1/recent-files") { status = "200 OK"; body = recentFiles(); }
                else if (path == "/api/v1/photos") { status = "200 OK"; body = photos(QUrlQuery(url).queryItemValue("after", QUrl::FullyDecoded)); }
                else if (path == "/api/v1/screenshots") { status = "200 OK"; body = photos(QUrlQuery(url).queryItemValue("after", QUrl::FullyDecoded), true); }
                else if (path == "/api/v1/file-activity") { const QUrlQuery query(url); int activityStatus = 200; body = fileActivity(query.queryItemValue("root"), query.queryItemValue("path", QUrl::FullyDecoded), &activityStatus); status = statusText(activityStatus); }
                else if (path == "/api/v1/problems") { status = "200 OK"; body = problems(); }
                else if (path == "/api/v1/import-preview") {
                    const QString id = QUrlQuery(url).queryItemValue("id");
                    body = importPreview(id);
                    status = body.isEmpty() ? "404 Not Found" : "200 OK";
                    if (body.isEmpty()) body = {{"error", "Preview not found"}};
                }
                else if (path == "/api/v1/route-preview") {
                    body = routePreview(QUrlQuery(url).queryItemValue("id"));
                    status = body.isEmpty() ? "404 Not Found" : "200 OK";
                    if (body.isEmpty()) body = {{"error", "Preview not found"}};
                }
                else if (path == "/api/v1/route-history") { int historyStatus = 200; body = routeHistory(QUrlQuery(url).queryItemValue("routeId"), &historyStatus); status = statusText(historyStatus); }
                else if (path == "/api/v1/photo-info") {
                    body = photoInfo(QUrlQuery(url).queryItemValue("path", QUrl::FullyDecoded), QUrlQuery(url).queryItemValue("root") == "Screenshots");
                    status = body.contains("error") ? "400 Bad Request" : "200 OK";
                }
                else if (path == "/api/v1/photo-thumbnail") {
                    payload = photoThumbnail(QUrlQuery(url).queryItemValue("path", QUrl::FullyDecoded), QUrlQuery(url).queryItemValue("root") == "Screenshots", QUrlQuery(url).queryItemValue("preview") == "1");
                    if (!payload.isEmpty()) { status = "200 OK"; contentType = "image/jpeg"; }
                }
                else if (!m_webRoot.isEmpty() && path != "/api" && !path.startsWith("/api/")) {
                    const QString relative = path == "/" ? QStringLiteral("index.html") : url.path(QUrl::FullyDecoded).mid(1);
                    const QStringList components = relative.split('/');
                    if (!safeRelative(relative) || relative.contains(QChar::Null) ||
                        std::any_of(components.begin(), components.end(), [](const QString &part) { return part.isEmpty() || part.startsWith('.'); })) {
                        sendJson(socket, "404 Not Found", {{"error", "Not found"}}); return;
                    }
                    int fd = ::open(QFile::encodeName(m_webRoot).constData(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
                    for (qsizetype i = 0; fd >= 0 && i < components.size(); ++i) {
                        const int next = ::openat(fd, QFile::encodeName(components[i]).constData(),
                            O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (i + 1 < components.size() ? O_DIRECTORY : 0));
                        ::close(fd); fd = next;
                    }
                    if (fd >= 0) {
                        QFile file;
                        if (file.open(fd, QIODevice::ReadOnly, QFileDevice::AutoCloseHandle)) {
                            struct stat info;
                            if (::fstat(fd, &info) == 0 && S_ISREG(info.st_mode)) {
                                const QByteArray data = file.readAll();
                                if (file.error() == QFileDevice::NoError) {
                                    sendResponse(socket, "200 OK", data, QMimeDatabase().mimeTypeForFile(relative, QMimeDatabase::MatchExtension).name().toUtf8()); return;
                                }
                            }
                        } else ::close(fd);
                    }
                }
            } else if (parts[0] == "POST") {
                const QUrl url = QUrl::fromEncoded(parts[1]);
                if (url.path() != "/api/v1/file-action" && url.path() != "/api/v1/create-from-template" && url.path() != "/api/v1/import-preview" && url.path() != "/api/v1/import-execute" && url.path() != "/api/v1/problem-action" && url.path() != "/api/v1/open-file" && url.path() != "/api/v1/create-folder" && url.path() != "/api/v1/save-route" && url.path() != "/api/v1/update-route-card" && url.path() != "/api/v1/clone-files-map" && url.path() != "/api/v1/route-preview" && url.path() != "/api/v1/route-execute" && url.path() != "/api/v1/route-manifest" && url.path() != "/api/v1/route-control" && url.path() != "/api/v1/mount-storage" && url.path() != "/api/v1/device-onboarding" && url.path() != "/api/v1/hub-config" && url.path() != "/api/v1/export-to-phone" && url.path() != "/api/v1/import-from-phone") { status = "405 Method Not Allowed"; body = {{"error", "This endpoint is read-only"}}; }
                else if (headers.value("x-local-drive-token") != m_token) { status = "403 Forbidden"; body = {{"error", "Invalid local session"}}; }
                else if (!headers.value("content-type").startsWith("application/json")) { status = "415 Unsupported Media Type"; body = {{"error", "JSON required"}}; }
                else {
                    QJsonParseError parseError;
                    const QJsonDocument document = QJsonDocument::fromJson(request.mid(headerEnd + 4, contentLength), &parseError);
                    const QJsonObject options = document.object();
                    if (parseError.error != QJsonParseError::NoError || !document.isObject()) { status = "400 Bad Request"; body = {{"error", "Invalid JSON request"}}; }
                    else if (url.path() == "/api/v1/hub-config") {
                        const int limit = options.value("limitPercent").toInt(-1);
                        if (!options.value("enabled").isBool() || limit < 1 || limit > 95) { status = "400 Bad Request"; body = {{"error", "Choose Use as hub and a storage limit from 1% to 95%"}}; }
                        else if (!m_model->setHubConfig(options.value("enabled").toBool(), limit)) { status = "409 Conflict"; body = {{"error", m_model->errorMessage()}}; }
                        else { status = "200 OK"; body = {{"ok", true}, {"enabled", m_model->hubEnabled()}, {"limitPercent", m_model->hubLimitPercent()}}; }
                    } else if (url.path() == "/api/v1/update-route-card") {
                        const QString id = options.value("id").toString(), mode = options.value("mode").toString(), keep = options.value("keepPolicy").toString();
                        if (id.isEmpty() || !options.value("cache").isBool()) { status = "400 Bad Request"; body = {{"error", "Choose a connection and its properties"}}; }
                        else if (!m_model->updateRouteCard(id, mode, keep, options.value("cache").toBool())) { status = "409 Conflict"; body = {{"error", m_model->errorMessage()}}; }
                        else { status = "200 OK"; body = {{"ok", true}, {"configRevision", m_model->configRevision()}}; }
                    } else if (url.path() == "/api/v1/clone-files-map") {
                        if (!m_model->cloneDriveMapToPhotos()) { status = "409 Conflict"; body = {{"error", m_model->errorMessage()}}; }
                        else { status = "200 OK"; body = {{"ok", true}, {"configRevision", m_model->configRevision()}}; }
                    } else if (url.path() == "/api/v1/device-onboarding") {
                        const QString id = options.value("id").toString();
                        if (id.isEmpty() || !options.value("participate").isBool()) { status = "400 Bad Request"; body = {{"error", "Choose a device and whether it participates in Drive"}}; }
                        else if (!m_model->acknowledgeDevice(id, !options.value("participate").toBool())) { status = "409 Conflict"; body = {{"error", m_model->errorMessage()}}; }
                        else { status = "200 OK"; body = {{"ok", true}, {"id", id}, {"participate", options.value("participate").toBool()}}; }
                    } else if (url.path() == "/api/v1/import-from-phone") {
                        int importStatus = 500; body = startPhoneImport(options, &importStatus); status = importStatus == 202 ? QByteArray("202 Accepted") : statusText(importStatus);
                    } else if (url.path() == "/api/v1/export-to-phone") {
                        int exportStatus = 500; body = startPhoneExport(options, &exportStatus); status = exportStatus == 202 ? QByteArray("202 Accepted") : statusText(exportStatus);
                    } else if (url.path() == "/api/v1/mount-storage") {
                        const QString id = options.value("id").toString();
                        if (id.isEmpty()) { status = "400 Bad Request"; body = {{"error", "Storage id is required"}}; }
                        else if (!m_model->mountStorage(id)) { status = "409 Conflict"; body = {{"error", m_model->errorMessage()}}; }
                        else { status = "202 Accepted"; body = {{"state", "mounting"}}; }
                    } else if (url.path() == "/api/v1/route-control") {
                        int controlStatus = 500;
                        body = routeControl(options.value("id").toString(), options.value("action").toString(), &controlStatus);
                        status = statusText(controlStatus);
                    } else if (url.path() == "/api/v1/route-manifest") {
                        int manifestStatus = 500;
                        body = routeManifest(options.value("id").toString(), &manifestStatus);
                        status = statusText(manifestStatus);
                    } else if (url.path() == "/api/v1/route-execute") {
                        int executionStatus = 500;
                        body = startRouteExecution(options.value("id").toString(), &executionStatus);
                        status = executionStatus == 202 ? QByteArray("202 Accepted") : statusText(executionStatus);
                    } else if (url.path() == "/api/v1/route-preview") {
                        int previewStatus = 500;
                        body = startRoutePreview(options.value("routeId").toString(), &previewStatus);
                        status = previewStatus == 202 ? QByteArray("202 Accepted") : statusText(previewStatus);
                    } else if (url.path() == "/api/v1/save-route") {
                        int routeStatus = 500;
                        body = saveRoute(options, &routeStatus);
                        status = statusText(routeStatus);
                    } else if (url.path() == "/api/v1/file-action") {
                        int actionStatus = 500; body = fileAction(options, &actionStatus); status = statusText(actionStatus);
                    } else if (url.path() == "/api/v1/create-folder") {
                        int folderStatus = 500;
                        body = createFolder(options.value("parent").toString(), options.value("name").toString(), &folderStatus);
                        status = statusText(folderStatus);
                    } else if (url.path() == "/api/v1/create-from-template") {
                        int templateStatus = 500; body = createFromTemplate(options, &templateStatus); status = statusText(templateStatus);
                    } else if (url.path() == "/api/v1/open-file") {
                        int openStatus = 500;
                        body = openFile(options.value("root").toString(), options.value("path").toString(), &openStatus);
                        status = statusText(openStatus);
                    } else if (url.path() == "/api/v1/problem-action") {
                        int actionStatus = 500;
                        body = problemAction(options.value("id").toString(), options.value("action").toString(), &actionStatus);
                        status = statusText(actionStatus);
                    } else if (url.path() == "/api/v1/import-execute") {
                        int executionStatus = 500;
                        body = startImportExecution(options.value("id").toString(), &executionStatus);
                        status = executionStatus == 202 ? QByteArray("202 Accepted") : statusText(executionStatus);
                    } else {
                        const QString source = options.value("source").toString(), target = options.value("target").toString();
                        if (source.trimmed().isEmpty() || (target != "Drive" && target != "Photos")) { status = "400 Bad Request"; body = {{"error", "Choose a source folder and Drive or Photos"}}; }
                        else {
                            const QString id = QUuid::createUuid().toString(QUuid::Id128);
                            startImportPreview(id, source, target);
                            status = "202 Accepted"; body = {{"id", id}, {"state", "scanning"}};
                        }
                    }
                }
            } else {
                status = "405 Method Not Allowed"; body = {{"error", "Only GET and authorized preview POST are allowed"}};
            }
            if (payload.isEmpty()) payload = QJsonDocument(body).toJson(QJsonDocument::Compact);
            sendResponse(socket, status, payload, contentType);
        });
    }
}

QJsonObject LocalApi::state() const {
    QJsonArray exports;
    { QMutexLocker lock(&m_previewMutex); for (auto it = m_routePreviews.cbegin(); it != m_routePreviews.cend(); ++it) if (it.key().startsWith("photo-export-")) { auto item = it.value(); item.insert("id", it.key()); exports.append(item); } }
    const int problemCount = problems().value("total").toInt();
    qint64 hubPendingBytes = 0; QString hubTarget;
    if (QFileInfo(m_model->hubRoot()).isDir()) VerifiedCopy::stagingUsage(m_model->hubRoot(), &hubPendingBytes);
    for (const auto &value : m_model->routes()) { const auto route = value.toMap(); if (!route.value("storagePresent").toBool()) { for (const auto &storageValue : m_model->storages()) { const auto storage = storageValue.toMap(); if (storage.value("id") == route.value("storageId")) { hubTarget = storage.value("label").toString(); break; } } if (!hubTarget.isEmpty()) break; } }
    return {{"ready", m_model->ready()},
            {"deviceName", m_model->localDeviceName()},
            {"libraryRoot", QDir(m_model->homeRoot()).filePath(QStringLiteral("Local Drive"))},
            {"configRevision", m_model->configRevision()},
            {"error", m_model->errorMessage()},
            {"problems", problemCount},
            {"photoExports", exports},
            {"hub", QJsonObject{{"enabled", m_model->hubEnabled()}, {"limitPercent", m_model->hubLimitPercent()}, {"pendingBytes", hubPendingBytes}, {"waitingFor", hubTarget}}},
            {"catalog", catalogState(m_model->databasePath())},
            {"routes", json(m_model->routes())},
            {"storages", json(m_model->storages())},
            {"devices", json(m_model->deviceList())},
            {"firstSeenDevices", json(m_model->firstSeenDevices())},
            {"hiddenDevices", json(m_model->hiddenDevices())},
            {"connectedDevices", json(m_model->connectedDevices())}};
}

QJsonObject LocalApi::startPhoneImport(const QJsonObject &options, int *status) {
    if (status) *status = 400;
    const QString phoneRootName = options.value("root").toString();
    const QString target = phoneRootName == "Drive" ? QStringLiteral("Drive") : phoneRootName == "DCIM" ? QStringLiteral("Photos") : QString();
    if (target.isEmpty()) return {{"error", "Choose Drive or DCIM"}};
    QVariantMap phone;
    for (const auto &value : m_model->connectedDevices()) { const auto candidate = value.toMap(); if (candidate.value("present").toBool() && candidate.value("stableIdentity").toString().startsWith("mtp:") && !candidate.value("phoneRoot").toString().isEmpty()) { phone = candidate; break; } }
    if (phone.isEmpty()) { if (status) *status = 409; return {{"error", "Connect and unlock the phone in File transfer mode"}}; }
    const QVariantMap route = routeFor(m_model, target);
    if (route.isEmpty()) { if (status) *status = 409; return {{"error", QStringLiteral("Configure the %1 route first").arg(target)}}; }

    QString destination = route.value("destination").toString(), selectedRoot = route.value("storageRoot").toString(), storageIdentity = route.value("storageIdentity").toString();
    QString storageId = route.value("storageId").toString(), filesystemType = route.value("filesystemType").toString();
    QString destinationStorageLabel = QStringLiteral("Backup storage"), destinationStorageKind = QStringLiteral("removable");
    for (const auto &value : m_model->storages()) { const auto storage = value.toMap(); if (storage.value("id") == storageId) { destinationStorageLabel = storage.value("label").toString(); destinationStorageKind = storage.value("kind", QStringLiteral("removable")).toString(); break; } }
    qint64 stagingMaxBytes = route.value("storagePresent").toBool() ? 0 : route.value("stagingMaxBytes").toLongLong();
    qint64 minimumFreeBytes = route.value("minimumFreeBytes").toLongLong();
    if (!route.value("storagePresent").toBool()) {
        QString configuredStaging = route.value("stagingRoot").toString();
        if ((configuredStaging.isEmpty() || stagingMaxBytes <= 0) && m_model->hubEnabled()) {
            configuredStaging = m_model->hubRoot();
            if (!QDir().mkpath(configuredStaging)) { if (status) *status = 409; return {{"error", "Laptop hub folder could not be prepared"}}; }
            const QStorageInfo laptop(configuredStaging); const qint64 total = laptop.bytesTotal();
            stagingMaxBytes = total / 100 * m_model->hubLimitPercent();
            minimumFreeBytes = std::max(minimumFreeBytes, total - stagingMaxBytes);
        }
        const QString stagingRoot = QFileInfo(configuredStaging).canonicalFilePath();
        if (stagingRoot.isEmpty() || stagingMaxBytes <= 0) { if (status) *status = 409; return {{"error", "Backup storage is unavailable and no bounded laptop staging folder is configured"}}; }
        destination = QDir(stagingRoot).filePath(target);
        if (!QDir().mkpath(destination)) { if (status) *status = 409; return {{"error", "Laptop staging folder could not be prepared"}}; }
        selectedRoot = stagingRoot; QString identityError; storageIdentity = VerifiedCopy::liveStorageIdentity(stagingRoot, &identityError); filesystemType = QStorageInfo(stagingRoot).fileSystemType();
        if (storageIdentity.isEmpty()) { if (status) *status = 409; return {{"error", identityError}}; }
        storageId = QStringLiteral("staging-%1").arg(QString::fromLatin1(QCryptographicHash::hash(stagingRoot.toUtf8(), QCryptographicHash::Sha256).toHex().left(16)));
        destinationStorageLabel = QStringLiteral("Laptop staging"); destinationStorageKind = QStringLiteral("local");
    }
    if (destination.isEmpty() || selectedRoot.isEmpty() || storageIdentity.isEmpty()) { if (status) *status = 409; return {{"error", "The destination route is not ready"}}; }

    QUrl source(phone.value("phoneRoot").toString()); QString sourcePath = source.path(QUrl::FullyDecoded); if (!sourcePath.endsWith('/')) sourcePath += '/'; sourcePath += phoneRootName + '/'; source.setPath(sourcePath);
    const QString id = QStringLiteral("phone-import-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    const QString phoneStable = phone.value("stableIdentity").toString(), phoneRoot = phone.value("phoneRoot").toString();
    const QString storageDigest = QString::fromLatin1(QCryptographicHash::hash((phoneStable + QLatin1Char('\n') + phoneRoot).toUtf8(), QCryptographicHash::Sha256).toHex());
    const QString routeDigest = QString::fromLatin1(QCryptographicHash::hash((route.value("id").toString() + QLatin1Char('\n') + phoneStable + QLatin1Char('\n') + phoneRootName + QLatin1Char('\n') + storageIdentity).toUtf8(), QCryptographicHash::Sha256).toHex());
    auto *engine = new VerifiedCopy(m_model->databasePath(), this);
    QVariantMap request{{"sourceUrl", source.toString()}, {"destinationRoot", destination}, {"selectedStorageRoot", selectedRoot}, {"storageIdentity", storageIdentity}, {"filesystemType", filesystemType}, {"minimumFreeBytes", minimumFreeBytes}, {"stagingMaxBytes", stagingMaxBytes}, {"routeId", QStringLiteral("mtp-import-%1").arg(routeDigest.left(16))}, {"destinationStorageId", storageId}, {"destinationStorageKind", destinationStorageKind}, {"destinationStorageLabel", destinationStorageLabel}, {"sourceStorageId", QStringLiteral("mtp-storage-%1").arg(storageDigest.left(16))}, {"sourceStorageIdentity", QStringLiteral("mtp:%1").arg(storageDigest)}, {"sourceStorageLabel", QStringLiteral("Phone storage")}, {"sourceDeviceId", phone.value("id")}, {"sourceDeviceStableId", phoneStable}, {"sourceDeviceName", phone.value("label")}};
    {
        QMutexLocker lock(&m_previewMutex);
        m_routePreviews.insert(id, {{"id", id}, {"state", "copying"}, {"phase", "phone-import"}, {"target", target}, {"root", phoneRootName}, {"progress", 0}});
        m_routeEngines.insert(id, engine);
    }
    connect(engine, &VerifiedCopy::progressChanged, this, [this, id](qint64 done, qint64 total, const QString &path) { QMutexLocker lock(&m_previewMutex); auto operation = m_routePreviews.value(id); operation.insert("bytesDone", done); operation.insert("bytesTotal", total); operation.insert("path", path); m_routePreviews[id] = operation; });
    connect(engine, &VerifiedCopy::finished, this, [this, engine, id](bool success, const QString &message) { QMutexLocker lock(&m_previewMutex); auto operation = m_routePreviews.value(id); operation.insert("state", success ? "transferred" : "failed"); operation.insert("result", message); m_routePreviews[id] = operation; m_routeEngines.remove(id); engine->deleteLater(); });
    if (!engine->startRemoteImportDirectory(request)) { QMutexLocker lock(&m_previewMutex); m_routePreviews.remove(id); m_routeEngines.remove(id); engine->deleteLater(); if (status) *status = 409; return {{"error", "The phone import could not start"}}; }
    if (status) *status = 202;
    return {{"id", id}, {"state", "copying"}, {"target", target}, {"destination", destinationStorageLabel}};
}

QJsonObject LocalApi::startPhoneExport(const QJsonObject &options, int *status) {
    if (status) *status = 400;
    const QString contentType = options.value("root").toString(), relative = QDir::cleanPath(options.value("path").toString());
    if ((contentType != "Drive" && contentType != "Photos") || !safeRelative(relative)) return {{"error", "Choose a file inside Drive or Photos"}};
    const QString root = QFileInfo(routeFor(m_model, contentType).value("source").toString()).canonicalFilePath();
    const QFileInfo source(QDir(root).filePath(relative)); const QString canonical = source.canonicalFilePath();
    if (root.isEmpty() || !source.isFile() || source.isSymLink() || canonical.isEmpty() || !safeRelative(QDir(root).relativeFilePath(canonical))) return {{"error", "File is unavailable or outside the configured root"}};
    QVariantMap phone;
    for (const auto &value : m_model->connectedDevices()) { const auto candidate = value.toMap(); if (candidate.value("present").toBool() && !candidate.value("phoneRoot").toString().isEmpty()) { phone = candidate; break; } }
    if (phone.isEmpty()) { if (status) *status = 409; return {{"error", "Connect and unlock the phone in File transfer mode"}}; }
    const QString phoneRoot = phone.value("phoneRoot").toString(), stable = phone.value("stableIdentity").toString();
    if (!stable.startsWith("mtp:")) { if (status) *status = 409; return {{"error", "Phone identity is not stable yet; check connections again"}}; }
    QUrl destination(phoneRoot); QString destinationPath = destination.path(QUrl::FullyDecoded); if (!destinationPath.endsWith('/')) destinationPath += '/';
    destinationPath += QStringLiteral("Drive/%1").arg(relative); destination.setPath(destinationPath);
    const QString storageDigest = QString::fromLatin1(QCryptographicHash::hash((stable + QLatin1Char('\n') + phoneRoot).toUtf8(), QCryptographicHash::Sha256).toHex());
    VerifiedCopy::ExportRequest request;
    request.sourcePath = canonical; request.destinationUrl = destination; request.destinationRootUrl = QUrl(phoneRoot); request.destinationRelative = QStringLiteral("Drive/%1").arg(relative); request.databasePath = m_model->databasePath();
    request.destinationDeviceId = phone.value("id").toString(); request.destinationDeviceStableId = stable; request.destinationDeviceName = phone.value("label").toString();
    request.destinationStorageId = QStringLiteral("mtp-storage-%1").arg(storageDigest.left(16)); request.destinationStorageIdentity = QStringLiteral("mtp:%1").arg(storageDigest); request.destinationStorageLabel = QStringLiteral("Phone storage");
    request.routeId = QStringLiteral("mtp-export-%1").arg(QString::fromLatin1(QCryptographicHash::hash((source.absolutePath() + QLatin1Char('\n') + request.destinationStorageIdentity).toUtf8(), QCryptographicHash::Sha256).toHex().left(16)));
    QThread *worker = QThread::create([request] { VerifiedCopy copy(request.databasePath); QString ignored; copy.executeExportBlocking(request, &ignored); });
    m_workers.append(worker); connect(worker, &QThread::finished, this, [this, worker] { m_workers.removeOne(worker); worker->deleteLater(); }); worker->start();
    if (status) *status = 202;
    return {{"state", "copying"}, {"destination", destination.toString()}, {"name", source.fileName()}};
}

QJsonObject LocalApi::files(const QString &relativePath, int *status) const {
    if (status) *status = 404;
    const QVariantMap selected = routeFor(m_model, QStringLiteral("Drive"));
    const QString root = QFileInfo(selected.value("source").toString()).canonicalFilePath();
    QJsonArray items;
    const QString requested = QDir::cleanPath(relativePath.trimmed());
    const QString normalized = requested == "." ? QString() : requested;
    if (!root.isEmpty() && (normalized.isEmpty() || safeRelative(normalized))) {
        const QString folder = normalized.isEmpty() ? root : QFileInfo(QDir(root).filePath(normalized)).canonicalFilePath();
        const QString confined = folder.isEmpty() ? QStringLiteral("..") : QDir(root).relativeFilePath(folder);
        if (QFileInfo(folder).isDir() && confined != ".." && !confined.startsWith("../") && !QDir::isAbsolutePath(confined)) {
            const auto entries = QDir(folder).entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::NoSymLinks, QDir::DirsFirst | QDir::Name | QDir::IgnoreCase);
        for (const auto &entry : entries.mid(0, 500)) {
            items.append(QJsonObject{{"name", entry.fileName()},
                                     {"directory", entry.isDir()},
                                     {"size", entry.isDir() ? 0 : entry.size()},
                                     {"modified", entry.lastModified().toString(Qt::ISODate)},
                                     {"type", entry.isDir() ? QStringLiteral("Folder") : entry.suffix().toUpper()}});
        }
            if (status) *status = 200;
            // A mounted destination is not proof that any listed file was verified there.
            return {{"root", root}, {"currentPath", confined == "." ? QString() : confined}, {"verifiedOn", QString()}, {"items", items}, {"truncated", entries.size() > 500}};
        }
    }
    return {{"error", "Drive folder not found or outside the configured root"}, {"root", root}, {"currentPath", QString()}, {"verifiedOn", QString()}, {"items", items}, {"truncated", false}};
}

QJsonObject LocalApi::recentFiles() const {
    QJsonArray items;
    const QString routeId = routeFor(m_model, QStringLiteral("Drive")).value("id").toString();
    if (routeId.isEmpty()) return {{"items", items}};
    const QString connection = QStringLiteral("recent-files-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    {
        QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(m_model->databasePath()); db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
        if (db.open()) {
            QSqlQuery query(db); query.prepare("SELECT relative_path,size_bytes,modified_ms FROM managed_inventory WHERE route_id=? AND state='present' ORDER BY modified_ms DESC,relative_path LIMIT 100"); query.addBindValue(routeId);
            if (query.exec()) while (query.next()) {
                const QFileInfo path(query.value(0).toString());
                items.append(QJsonObject{{"name", path.fileName()}, {"path", query.value(0).toString()}, {"directory", false}, {"size", query.value(1).toLongLong()}, {"modified", QDateTime::fromMSecsSinceEpoch(query.value(2).toLongLong(), QTimeZone::UTC).toString(Qt::ISODate)}, {"type", path.suffix().toUpper()}});
            }
        }
        db.close();
    }
    QSqlDatabase::removeDatabase(connection);
    return {{"items", items}, {"truncated", items.size() == 100}};
}

QJsonObject LocalApi::photos(const QString &after, bool screenshots) const {
    const QVariantMap selected = routeFor(m_model, QStringLiteral("Photos"));
    const QString root = screenshots ? screenshotsRoot() : selected.value("source").toString();
    QJsonArray items;
    if (!root.isEmpty() && QFileInfo(root).isDir()) {
        QDirIterator iterator(root, QDir::Files | QDir::NoSymLinks, QDirIterator::Subdirectories);
        // ponytail: O(N) scan per page, bounded 501-entry buffer; use the catalog index for large libraries.
        QMap<QString, QFileInfo> page;
        while (iterator.hasNext()) {
            const QFileInfo entry(iterator.next());
            if (!isPhoto(entry) && !isVideo(entry)) continue;
            const QString relative = QDir(root).relativeFilePath(entry.filePath());
            if (relative <= after) continue;
            page.insert(relative, entry);
            if (page.size() > 501) page.erase(std::prev(page.end()));
        }
        const bool more = page.size() > 500;
        if (more) page.erase(std::prev(page.end()));
        for (auto item = page.cbegin(); item != page.cend(); ++item) {
            const QString relative = item.key();
            const QFileInfo entry = item.value();
            const QString folder = QFileInfo(relative).path();
            const QDateTime bestDate = entry.birthTime().isValid() ? entry.birthTime() : entry.lastModified();
            items.append(QJsonObject{{"path", relative},
                                     {"name", entry.fileName()},
                                     {"size", entry.size()},
                                     {"modified", entry.lastModified().toString(Qt::ISODate)},
                                     {"captured", bestDate.toString(Qt::ISODate)},
                                     {"dateSource", entry.birthTime().isValid() ? QStringLiteral("Created") : QStringLiteral("Modified")},
                                     {"type", isVideo(entry) ? QStringLiteral("Video") : QStringLiteral("Photo")},
                                     {"collection", folder == "." ? QStringLiteral("Unsorted") : folder}});
        }
        return {{"root", root}, {"verifiedOn", QString()}, {"items", items}, {"truncated", more}, {"nextCursor", more ? page.lastKey() : QString()}};
    }
    return {{"root", screenshots ? root : QString()}, {"verifiedOn", QString()}, {"items", items}, {"truncated", false}};
}

QJsonObject LocalApi::fileActivity(const QString &contentType, const QString &relativePath, int *status) const {
    if (status) *status = 404;
    const QString relative = QDir::cleanPath(relativePath.trimmed());
    if ((contentType != "Drive" && contentType != "Photos") || !safeRelative(relative)) return {{"error", "Choose a file inside Drive or Photos"}};
    const QString root = QFileInfo(routeFor(m_model, contentType).value("source").toString()).canonicalFilePath();
    const QFileInfo candidate(QDir(root).filePath(relative));
    const QString canonical = candidate.canonicalFilePath(), confined = canonical.isEmpty() ? QStringLiteral("..") : QDir(root).relativeFilePath(canonical);
    if (root.isEmpty() || !candidate.isFile() || candidate.isSymLink() || confined == ".." || confined.startsWith("../") || QDir::isAbsolutePath(confined)) return {{"error", QStringLiteral("File not found or outside the configured %1 root").arg(contentType)}};

    QJsonArray items;
    const QString connection = QStringLiteral("file-activity-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    {
        QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(m_model->databasePath()); db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
        if (db.open()) {
            QSqlQuery query(db);
            query.prepare("SELECT h.id,h.event,h.occurred_at,COALESCE(h.result,''),COALESCE(h.source_path,''),COALESCE(h.destination_path,'') FROM history h JOIN jobs j ON j.id=h.job_id JOIN routes r ON r.id=j.route_id WHERE r.content_type=? AND (h.destination_path=? OR h.source_path=?) ORDER BY h.occurred_at DESC,h.rowid DESC LIMIT 50");
            query.addBindValue(contentType); query.addBindValue(canonical); query.addBindValue(canonical);
            if (query.exec()) while (query.next()) items.append(QJsonObject{{"id", query.value(0).toString()}, {"event", query.value(1).toString()}, {"occurredAt", query.value(2).toString()}, {"result", query.value(3).toString()}, {"sourcePath", query.value(4).toString()}, {"destinationPath", query.value(5).toString()}});
        }
        db.close();
    }
    QSqlDatabase::removeDatabase(connection);
    if (status) *status = 200;
    return {{"root", contentType}, {"path", confined}, {"items", items}, {"truncated", items.size() == 50}};
}

QJsonObject LocalApi::problems() const {
    QJsonArray items;
    QJsonArray history;
    QJsonObject counts;
    int total = 0;
    const auto append = [&](QJsonObject item) {
        const QString category = item.value("category").toString();
        const int count = std::max(1, item.value("itemCount").toInt());
        counts.insert(category, counts.value(category).toInt() + count);
        total += count;
        items.append(item);
    };
    const QString connection = QStringLiteral("problems-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    {
        QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection);
        db.setDatabaseName(m_model->databasePath());
        db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
        if (db.open()) {
            QSqlQuery reviews(db);
            if (reviews.exec("SELECT id,category,title,summary,details_json,item_count,bytes_total,state,updated_at,source_kind,COALESCE((SELECT COALESCE(r.status,'pending') FROM device_corrections c LEFT JOIN device_correction_results r ON r.correction_id=c.id WHERE c.review_item_id=review_items.id ORDER BY c.rowid DESC LIMIT 1),''),COALESCE((SELECT r.error_message FROM device_corrections c JOIN device_correction_results r ON r.correction_id=c.id WHERE c.review_item_id=review_items.id ORDER BY c.rowid DESC LIMIT 1),'') FROM review_items WHERE state NOT IN ('resolved','dismissed') ORDER BY updated_at DESC,rowid DESC")) while (reviews.next()) {
                QJsonObject details = QJsonDocument::fromJson(reviews.value(4).toByteArray()).object();
                if (!reviews.value(10).toString().isEmpty()) details.insert("correctionStatus", reviews.value(10).toString());
                if (!reviews.value(11).toString().isEmpty()) details.insert("correctionError", reviews.value(11).toString());
                append({{"id", reviews.value(0).toString()}, {"category", reviews.value(1).toString()}, {"title", reviews.value(2).toString()}, {"summary", reviews.value(3).toString()}, {"details", details}, {"itemCount", reviews.value(5).toInt()}, {"bytes", reviews.value(6).toLongLong()}, {"state", reviews.value(7).toString()}, {"updatedAt", reviews.value(8).toString()}, {"source", reviews.value(9).toString()}});
            }
            QSqlQuery jobs(db);
            if (jobs.exec("SELECT j.id,j.state,COALESCE(j.error_code,''),COALESCE(j.error_message,''),j.source_path,j.destination_path,j.updated_at,r.content_type,COALESCE((SELECT COUNT(*) FROM job_items ji WHERE ji.job_id=j.id AND ji.state IN ('Conflict','Failed')),0) FROM jobs j JOIN routes r ON r.id=j.route_id WHERE j.state IN ('Conflict','Failed','Cleanup pending') ORDER BY j.updated_at DESC")) while (jobs.next()) {
                const QString state = jobs.value(1).toString(), code = jobs.value(2).toString();
                const bool permission = code.contains("permission", Qt::CaseInsensitive);
                const bool storage = code.contains("space", Qt::CaseInsensitive) || code.contains("destination", Qt::CaseInsensitive);
                const QString category = state == "Conflict" ? QStringLiteral("Conflicts") : permission ? QStringLiteral("Permissions") : storage ? QStringLiteral("Storage") : QStringLiteral("Transfers");
                const QString reviewState = state == "Conflict" ? QStringLiteral("needs_decision") : storage ? QStringLiteral("needs_device") : QStringLiteral("can_retry");
                const QJsonObject details{{"source", jobs.value(4).toString()}, {"destination", jobs.value(5).toString()}, {"contentType", jobs.value(7).toString()}, {"errorCode", code}};
                append({{"id", QStringLiteral("job-%1").arg(jobs.value(0).toString())}, {"category", category}, {"title", state == "Conflict" ? QStringLiteral("Transfer contains conflicting files") : state == "Cleanup pending" ? QStringLiteral("Verified cleanup is waiting") : QStringLiteral("Transfer can be reviewed and retried")}, {"summary", jobs.value(3).toString()}, {"details", details}, {"itemCount", std::max(1, jobs.value(8).toInt())}, {"bytes", 0}, {"state", reviewState}, {"updatedAt", jobs.value(6).toString()}, {"source", "job"}});
            }
            QSqlQuery metadata(db);
            if (metadata.exec("SELECT COUNT(*),COALESCE(SUM(size_bytes),0),COALESCE(MAX(updated_at),'') FROM pending_metadata WHERE state='review'") && metadata.next() && metadata.value(0).toInt() > 0) {
                append({{"id", "metadata-review"}, {"category", "External changes"}, {"title", "Metadata changes need review"}, {"summary", "Items changed or disappeared after metadata preflight."}, {"details", QJsonObject{}}, {"itemCount", metadata.value(0).toInt()}, {"bytes", metadata.value(1).toLongLong()}, {"state", "needs_decision"}, {"updatedAt", metadata.value(2).toString()}, {"source", "metadata"}});
            }
            QSqlQuery resolutions(db);
            if (resolutions.exec("SELECT rr.id,rr.review_item_id,rr.action,rr.result_state,rr.occurred_at,ri.category,ri.title FROM review_resolutions rr JOIN review_items ri ON ri.id=rr.review_item_id ORDER BY rr.occurred_at DESC,rr.rowid DESC LIMIT 100")) while (resolutions.next()) {
                history.append(QJsonObject{{"id", resolutions.value(0).toString()}, {"problemId", resolutions.value(1).toString()}, {"action", resolutions.value(2).toString()}, {"state", resolutions.value(3).toString()}, {"occurredAt", resolutions.value(4).toString()}, {"category", resolutions.value(5).toString()}, {"title", resolutions.value(6).toString()}});
            }
            QSqlQuery corrections(db);
            if (corrections.exec("SELECT r.id,c.review_item_id,c.action,r.status,r.completed_at,ri.category,ri.title FROM device_correction_results r JOIN device_corrections c ON c.id=r.correction_id JOIN review_items ri ON ri.id=c.review_item_id ORDER BY r.completed_at DESC,r.rowid DESC LIMIT 100")) while (corrections.next()) {
                history.append(QJsonObject{{"id", corrections.value(0).toString()}, {"problemId", corrections.value(1).toString()}, {"action", corrections.value(2).toString()}, {"state", corrections.value(3).toString()}, {"occurredAt", corrections.value(4).toString()}, {"category", corrections.value(5).toString()}, {"title", corrections.value(6).toString()}});
            }
        }
        db.close();
    }
    QSqlDatabase::removeDatabase(connection);
    return {{"total", total}, {"counts", counts}, {"items", items}, {"history", history}};
}

QJsonObject LocalApi::problemAction(const QString &id, const QString &action, int *status) {
    if (status) *status = 400;
    if (id.trimmed().isEmpty() || (action != "save" && action != "dismiss" && action != "accept_existing" && action != "keep_both" && action != "skip_unsupported" && action != "recheck_location")) return {{"error", "Choose a valid problem and action"}};
    const QString connection = QStringLiteral("problem-action-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    QJsonObject result;
    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection);
    db.setDatabaseName(m_model->databasePath());
    if (!db.open() || !db.transaction()) { result = {{"error", "Catalog unavailable"}}; if (status) *status = 500; }
    else {
        QSqlQuery query(db);
        query.prepare("SELECT category,source_kind,state,details_json,item_count FROM review_items WHERE id=?"); query.addBindValue(id);
        if (!query.exec() || !query.next()) { db.rollback(); result = {{"error", "Problem not found"}}; if (status) *status = 404; }
        else {
            const QString category = query.value(0).toString(), sourceKind = query.value(1).toString(), currentState = query.value(2).toString(), detailsText = query.value(3).toString();
            const int itemCount = query.value(4).toInt();
            const QJsonObject details = QJsonDocument::fromJson(detailsText.toUtf8()).object();
            const QString targetState = action == "save" ? QStringLiteral("saved") : action == "dismiss" ? QStringLiteral("dismissed") : QStringLiteral("resolved");
            const bool cleanObservation = sourceKind == "metadata" && details.value("changed").toInt() == 0 && details.value("missing").toInt() == 0;
            const bool importDuplicate = sourceKind == "import" && category == "Duplicates" && !details.value("paths").toArray().isEmpty();
            const bool importConflict = sourceKind == "import" && category == "Conflicts" && !details.value("paths").toArray().isEmpty();
            const bool importUnsupported = sourceKind == "import" && category == "Unsupported" && !details.value("evidence").toArray().isEmpty();
            const QString recheckDevice = details.value("deviceStableId").toString(), recheckRoot = details.value("root").toString(), recheckPath = details.value("path").toString(), recheckHash = details.value("expectedSha256").toString().toLower(); const qint64 recheckSize = details.value("expectedSize").toVariant().toLongLong();
            const bool validRecheck = sourceKind == "metadata" && recheckDevice.startsWith("wireless:") && (recheckRoot == "Drive" || recheckRoot == "DCIM") && safeRelative(recheckPath) && recheckSize >= 0 && recheckHash.size() == 64 && QByteArray::fromHex(recheckHash.toLatin1()).size() == 32;
            if (action == "recheck_location" && validRecheck && currentState != "resolved" && currentState != "dismissed") {
                query.prepare("SELECT c.id FROM device_corrections c LEFT JOIN device_correction_results r ON r.correction_id=c.id WHERE c.review_item_id=? AND r.id IS NULL ORDER BY c.rowid DESC LIMIT 1"); query.addBindValue(id);
                if (!query.exec()) { db.rollback(); result = {{"error", query.lastError().text()}}; if (status) *status = 500; }
                else {
                    QString correctionId; if (query.next()) correctionId = query.value(0).toString();
                    if (correctionId.isEmpty()) {
                        correctionId = QStringLiteral("correction-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
                        query.prepare("INSERT INTO device_corrections(id,target_device_id,review_item_id,action,source_root,relative_path,expected_size,expected_sha256) SELECT ?,id,?,'recheck_location',?,?,?,? FROM devices WHERE stable_id=?"); query.addBindValue(correctionId); query.addBindValue(id); query.addBindValue(recheckRoot); query.addBindValue(recheckPath); query.addBindValue(recheckSize); query.addBindValue(recheckHash); query.addBindValue(recheckDevice);
                        if (!query.exec() || query.numRowsAffected() != 1) { db.rollback(); result = {{"error", "The paired target device is unavailable"}}; if (status) *status = 409; correctionId.clear(); }
                    }
                    if (!correctionId.isEmpty()) {
                        query.prepare("UPDATE review_items SET state='needs_device',updated_at=CURRENT_TIMESTAMP,resolved_at=NULL WHERE id=?"); query.addBindValue(id);
                        if (!query.exec() || !db.commit()) { db.rollback(); result = {{"error", query.lastError().text()}}; if (status) *status = 500; }
                        else { result = {{"ok", true}, {"id", id}, {"action", action}, {"correctionId", correctionId}}; if (status) *status = 200; }
                    }
                }
            }
            else if (action == "recheck_location") { db.rollback(); result = {{"error", "This problem has no current verified phone evidence to recheck"}}; if (status) *status = 409; }
            else if (currentState == targetState) { db.rollback(); result = {{"ok", true}, {"id", id}, {"action", action}}; if (status) *status = 200; }
            else if (currentState == "resolved" || currentState == "dismissed" || (action == "dismiss" && (currentState != "saved" || !cleanObservation)) || (action == "accept_existing" && !importDuplicate) || (action == "keep_both" && !importConflict) || (action == "skip_unsupported" && !importUnsupported)) {
                db.rollback(); result = {{"error", action == "dismiss" ? "Only a saved, clean external observation can be dismissed" : action == "accept_existing" ? "Only an imported exact-duplicate group can use the existing copies" : action == "keep_both" ? "Only an imported conflict group can keep both versions" : action == "skip_unsupported" ? "Only an imported unsupported group can be kept in the source" : "This problem is already resolved"}}; if (status) *status = 409;
            } else if (!query.exec("UPDATE devices SET event_sequence=event_sequence+1 WHERE id='local'") || !query.exec("SELECT catalog_generation,event_sequence FROM devices WHERE id='local'") || !query.next()) {
                db.rollback(); result = {{"error", query.lastError().text()}}; if (status) *status = 500;
            } else {
                const qint64 generation = query.value(0).toLongLong(), sequence = query.value(1).toLongLong();
                const QString evidence = QString::fromLatin1(QCryptographicHash::hash((id + '\n' + category + '\n' + currentState + '\n' + detailsText + '\n' + QString::number(itemCount)).toUtf8(), QCryptographicHash::Sha256).toHex());
                query.prepare("INSERT INTO review_resolutions(id,origin_device_id,catalog_generation,origin_sequence,review_item_id,action,evidence_sha256,details_json) VALUES(?,'local',?,?,?,?,?,?)");
                query.addBindValue(QStringLiteral("resolution-%1").arg(QUuid::createUuid().toString(QUuid::Id128))); query.addBindValue(generation); query.addBindValue(sequence); query.addBindValue(id); query.addBindValue(action); query.addBindValue(evidence); query.addBindValue(detailsText);
                if (!query.exec()) { db.rollback(); result = {{"error", query.lastError().text()}}; if (status) *status = 500; }
                else {
                    query.prepare("UPDATE review_items SET state=?,updated_at=CURRENT_TIMESTAMP,resolved_at=CASE WHEN ? IN ('dismissed','resolved') THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?"); query.addBindValue(targetState); query.addBindValue(targetState); query.addBindValue(id);
                    if (!query.exec() || !db.commit()) { db.rollback(); result = {{"error", query.lastError().text()}}; if (status) *status = 500; }
                    else { result = {{"ok", true}, {"id", id}, {"action", action}}; if (status) *status = 200; }
                }
            }
        }
    }
    db.close(); db = {}; QSqlDatabase::removeDatabase(connection);
    return result;
}

QJsonObject LocalApi::openFile(const QString &contentType, const QString &relativePath, int *status) const {
    if (status) *status = 404;
    const QString relative = QDir::cleanPath(relativePath.trimmed());
    if (contentType != "Drive" && contentType != "Photos" && contentType != "Screenshots") return {{"error", "Choose a supported library root"}};
    const QString root = QFileInfo(contentType == "Screenshots" ? screenshotsRoot() : routeFor(m_model, contentType).value("source").toString()).canonicalFilePath();
    if (root.isEmpty() || !safeRelative(relative)) return {{"error", QStringLiteral("File not found or outside the configured %1 root").arg(contentType)}};
    const QFileInfo candidate(QDir(root).filePath(relative));
    const QString canonical = candidate.canonicalFilePath(), confined = canonical.isEmpty() ? QStringLiteral("..") : QDir(root).relativeFilePath(canonical);
    if (!candidate.isFile() || candidate.isSymLink() || confined == ".." || confined.startsWith("../") || QDir::isAbsolutePath(confined)) return {{"error", QStringLiteral("File not found or outside the configured %1 root").arg(contentType)}};
#ifdef LOCAL_DRIVE_TESTING
    const bool opened = true;
#else
    const bool opened = QDesktopServices::openUrl(QUrl::fromLocalFile(canonical));
#endif
    if (!opened) { if (status) *status = 500; return {{"error", "The desktop could not open this file"}}; }
    if (status) *status = 200;
    return {{"ok", true}, {"root", contentType}, {"path", confined}};
}

QJsonObject LocalApi::createFolder(const QString &relativeParent, const QString &rawName, int *status) const {
    if (status) *status = 400;
    const QString name = rawName.trimmed(), requested = QDir::cleanPath(relativeParent.trimmed()), relative = requested == "." ? QString() : requested;
    if (name.isEmpty() || name == "." || name == ".." || name.size() > 255 || name.contains('/') || name.contains('\\')
        || std::any_of(name.cbegin(), name.cend(), [](QChar character) { return character.isNull() || character.category() == QChar::Other_Control; })) return {{"error", "Choose a valid folder name"}};
    if (!relative.isEmpty() && !safeRelative(relative)) return {{"error", "Parent folder is outside Drive"}};
    const QString root = QFileInfo(routeFor(m_model, QStringLiteral("Drive")).value("source").toString()).canonicalFilePath();
    const QString parent = relative.isEmpty() ? root : QFileInfo(QDir(root).filePath(relative)).canonicalFilePath();
    const QString confined = parent.isEmpty() ? QStringLiteral("..") : QDir(root).relativeFilePath(parent);
    if (root.isEmpty() || !QFileInfo(parent).isDir() || confined == ".." || confined.startsWith("../") || QDir::isAbsolutePath(confined)) { if (status) *status = 404; return {{"error", "Parent folder not found or outside Drive"}}; }
    const QString target = QDir(parent).filePath(name);
    if (QFileInfo::exists(target)) { if (status) *status = 409; return {{"error", "A file or folder with this name already exists"}}; }
    if (!QDir(parent).mkdir(name)) { if (status) *status = 500; return {{"error", "The folder could not be created"}}; }
    if (status) *status = 200;
    const QString created = relative.isEmpty() ? name : relative + "/" + name;
    return {{"ok", true}, {"path", created}};
}

QJsonObject LocalApi::fileLabels() const {
    QFile file(m_model->databasePath() + ".file-labels.json");
    if (!file.exists()) return {{"items", QJsonObject{}}};
    if (!file.open(QIODevice::ReadOnly)) return {{"error", "File labels could not be read"}};
    QJsonParseError error;
    const auto document = QJsonDocument::fromJson(file.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !document.isObject() || !document.object().value("items").isObject()) return {{"error", "File labels are damaged; they were not overwritten"}};
    return document.object();
}

QJsonObject LocalApi::fileAction(const QJsonObject &options, int *status) {
    *status = 400;
    const QString action = options.value("action").toString(), relative = options.value("path").toString();
    if (action == "reveal-photo" || action == "edit-photo") {
        if (options.value("root") != "Photos" && options.value("root") != "Screenshots") return {{"error", "Choose a photo library"}};
        const QString path = photoPath(relative, options.value("root") == "Screenshots");
        if (path.isEmpty()) return {{"error", "Image is unavailable or outside the library"}};
        bool opened = false;
#ifdef LOCAL_DRIVE_TESTING
        opened = true;
#else
        if (action == "reveal-photo") opened = QDesktopServices::openUrl(QUrl::fromLocalFile(QFileInfo(path).absolutePath()));
        else {
            for (const QString &name : {QStringLiteral("kolourpaint"), QStringLiteral("krita"), QStringLiteral("gimp")}) {
                const QString program = QStandardPaths::findExecutable(name);
                if (!program.isEmpty()) { opened = QProcess::startDetached(program, {path}); break; }
            }
        }
#endif
        *status = opened ? 200 : 503;
        return opened ? QJsonObject{{"state", "opened"}} : QJsonObject{{"error", "Could not open desktop application. For editing install Krita, KolourPaint or GIMP"}};
    }
    if (action == "export-photos") {
        if (!m_workers.isEmpty()) { *status = 409; return {{"error", "Wait for current work to finish"}}; }
        const auto source = routeFor(m_model, "Photos").value("source").toString();
        QString destination;
        for (const auto &value : m_model->storages()) { const auto storage = value.toMap(); if (storage.value("id").toString() == options.value("storageId").toString() && storage.value("present").toBool()) destination = storage.value("root").toString(); }
        const QString name = options.value("name").toString();
        if (source.isEmpty() || destination.isEmpty() || !name.endsWith(".ldrive") || name.startsWith('.') || name.contains('/') || name.contains('\\') || name.contains(QChar::Null)) return {{"error", "Choose available storage and a .ldrive filename"}};
        QFile script(":/src/photo_archive.py");
        if (!script.open(QIODevice::ReadOnly)) { *status = 500; return {{"error", "Archive exporter is missing"}}; }
        const auto code = QString::fromUtf8(script.readAll());
        const auto id = QStringLiteral("photo-export-") + QUuid::createUuid().toString(QUuid::Id128);
        { QMutexLocker lock(&m_previewMutex); m_routePreviews.insert(id, QJsonObject{{"state", "copying"}}); }
        auto *worker = QThread::create([this, source, destination, name, code, id] {
            QProcess process; process.start("python3", {"-c", code, source, destination, name});
            if (!process.waitForStarted()) { QMutexLocker lock(&m_previewMutex); m_routePreviews[id] = QJsonObject{{"state", "failed"}, {"result", "Python 3.14 is required for archive export"}}; return; }
            QByteArray pending;
            while (true) {
                process.waitForReadyRead(250); pending += process.readAllStandardOutput();
                while (pending.contains('\n')) { const auto newline = pending.indexOf('\n'); const auto event = QJsonDocument::fromJson(pending.left(newline)).object(); pending.remove(0, newline + 1); if (!event.isEmpty()) { QMutexLocker lock(&m_previewMutex); m_routePreviews[id] = event; } }
                if (m_stopping.load()) { process.kill(); process.waitForFinished(); break; }
                if (process.state() == QProcess::NotRunning) break;
            }
            QMutexLocker lock(&m_previewMutex);
            if (m_routePreviews[id].value("state") != "transferred" && m_routePreviews[id].value("state") != "failed") m_routePreviews[id] = QJsonObject{{"state", "failed"}, {"result", "Exporter stopped. Originals were kept; any .partial file is incomplete"}};
        });
        m_workers.append(worker); connect(worker, &QThread::finished, this, [this, worker] { m_workers.removeOne(worker); worker->deleteLater(); }); worker->start();
        *status = 202; return {{"id", id}};
    }
    if (action == "open-trash" || action == "scan") {
        bool opened = false;
        if (action == "open-trash") {
#ifdef LOCAL_DRIVE_TESTING
            opened = true;
#else
            opened = QDesktopServices::openUrl(QUrl("trash:/"));
#endif
        } else {
            for (const auto &name : QStringList{"skanpage", "simple-scan", "skanlite"}) {
                const auto program = QStandardPaths::findExecutable(name); if (program.isEmpty()) continue;
#ifdef LOCAL_DRIVE_TESTING
                opened = true;
#else
                opened = QProcess::startDetached(program, {});
#endif
                break;
            }
        }
        *status = opened ? 200 : 409;
        return opened ? QJsonObject{{"ok", true}} : QJsonObject{{"error", action == "scan" ? "No supported desktop scanner app could be opened (Skanpage, Document Scanner or Skanlite)" : "The system Trash could not be opened"}};
    }
    if (action == "create-tag") {
        const QString tag = options.value("tag").toString().trimmed();
        if (tag.isEmpty() || tag.size() > 80 || std::any_of(tag.cbegin(), tag.cend(), [](QChar c) { return c.category() == QChar::Other_Control; })) return {{"error", "Choose a tag of 1–80 printable characters"}};
        auto labels = fileLabels(); if (labels.contains("error")) { *status = 500; return labels; }
        auto tags = labels.value("tags").toArray(); if (!tags.contains(tag)) tags.append(tag); labels.insert("tags", tags);
        QSaveFile saved(m_model->databasePath() + ".file-labels.json"); const auto data = QJsonDocument(labels).toJson();
        if (!saved.open(QIODevice::WriteOnly) || saved.write(data) != data.size() || !saved.commit()) { *status = 500; return {{"error", "Tag could not be saved"}}; }
        *status = 200; return {{"ok", true}, {"tags", tags}};
    }
    if (!QStringList{"rename", "move", "copy", "trash", "labels"}.contains(action)) return {{"error", "Unknown file action"}};
    if (action != "labels" && (!m_workers.isEmpty() || !catalogState(m_model->databasePath()).value("activeTransfer").isNull())) { *status = 409; return {{"error", "Wait for active transfers to finish before changing files"}}; }
    const QString contentType = options.value("root").toString("Drive");
    if (contentType != "Drive" && contentType != "Photos") return {{"error", "Choose Drive or Photos"}};
    const QString root = QFileInfo(routeFor(m_model, contentType).value("source").toString()).canonicalFilePath();
    // Reject symlink components and reserved hidden paths, not just the final entry.
    const auto resolve = [&](const QString &path) -> QString {
        if (root.isEmpty() || !safeRelative(path)) return {};
        QString current = root;
        for (const auto &part : path.split('/')) {
            if (part.isEmpty() || part.startsWith('.') || part.contains(QChar::Null)) return {};
            current = QDir(current).filePath(part);
            if (QFileInfo(current).isSymLink()) return {};
        }
        return current;
    };
    const QString source = resolve(relative);
    const QFileInfo info(source);
    if (source.isEmpty() || !info.exists() || (!info.isFile() && !info.isDir())) return {{"error", "Item unavailable, reserved, or outside Drive"}};
    if (!options.contains("modified") || info.lastModified().toString(Qt::ISODate) != options.value("modified").toString()
        || (info.isFile() && info.size() != options.value("size").toInteger(-1))) { *status = 409; return {{"error", "Item changed; refresh Drive before retrying"}}; }
    auto labels = fileLabels();
    if (labels.contains("error")) { *status = 500; return labels; }
    auto items = labels.value("items").toObject();
    QString resultPath = relative;
    if (action == "labels") {
        if (!options.value("favorite").isBool() || !options.value("tags").isArray() || options.value("tags").toArray().size() > 50) return {{"error", "Invalid favorites or tags"}};
        QJsonArray tags;
        for (const auto &value : options.value("tags").toArray()) {
            const QString tag = value.toString().trimmed();
            if (!value.isString() || tag.isEmpty() || tag.size() > 80 || std::any_of(tag.cbegin(), tag.cend(), [](QChar c) { return c.category() == QChar::Other_Control; })) return {{"error", "Tags must contain 1–80 printable characters"}};
            if (!tags.contains(tag)) tags.append(tag);
        }
        items.insert(source, QJsonObject{{"favorite", options.value("favorite")}, {"tags", tags}});
        auto registered = labels.value("tags").toArray(); for (const auto &tag : tags) if (!registered.contains(tag)) registered.append(tag); labels.insert("tags", registered);
    } else if (action == "trash") {
        QString trashPath;
        if (!QFile::moveToTrash(source, &trashPath)) { *status = 500; return {{"error", "Could not move to system Trash; no permanent deletion attempted"}}; }
        resultPath = trashPath;
        for (const auto &key : items.keys()) if (key == source || key.startsWith(source + '/')) items.remove(key);
    } else {
        resultPath = options.value("destination").toString();
        const QString target = resolve(resultPath);
        if (target.isEmpty() || !QFileInfo(QFileInfo(target).absolutePath()).isDir() || target.startsWith(source + '/')) return {{"error", "Choose an existing destination folder inside Drive"}};
        if (action == "rename" && QFileInfo(target).absolutePath() != info.absolutePath()) return {{"error", "Rename must keep the same parent folder"}};
        if (QFileInfo::exists(target)) { *status = 409; return {{"error", "Destination already exists; nothing was replaced"}}; }
        if (action == "copy") {
            if (info.isDir()) return {{"error", "Folder copying is not supported yet; select a file"}};
            // ponytail: synchronous local copy; move to a worker when large-file responsiveness is needed.
            if (!QFile::copy(source, target)) { *status = 500; return {{"error", "Copy failed; the original was kept"}}; }
            QFile original(source), copied(target);
            QCryptographicHash originalHash(QCryptographicHash::Sha256), copiedHash(QCryptographicHash::Sha256);
            if (!original.open(QIODevice::ReadOnly) || !copied.open(QIODevice::ReadOnly) || !originalHash.addData(&original) || !copiedHash.addData(&copied) || originalHash.result() != copiedHash.result()) {
                *status = 409; return {{"error", "Copy could not be verified. Both files were kept; inspect the destination before retrying"}};
            }
        } else {
            // Atomic, no replacement, no copy/delete fallback across filesystems.
            if (::syscall(SYS_renameat2, AT_FDCWD, QFile::encodeName(source).constData(), AT_FDCWD, QFile::encodeName(target).constData(), 1 /* RENAME_NOREPLACE */) != 0) { *status = 409; return {{"error", "Move failed; destination may exist or be on another filesystem. Original kept"}}; }
        }
        for (const auto &key : items.keys()) if (key == source || key.startsWith(source + '/')) {
            items.insert(target + key.mid(source.size()), items.value(key));
            if (action != "copy") items.remove(key);
        }
    }
    labels.insert("items", items);
    QSaveFile saved(m_model->databasePath() + ".file-labels.json");
    const QByteArray data = QJsonDocument(labels).toJson();
    if (!saved.open(QIODevice::WriteOnly) || saved.write(data) != data.size() || !saved.commit()) {
        *status = 500; return {{"error", action == "labels" ? "Labels could not be saved" : "File action completed, but labels could not be updated. Refresh before doing anything else"}};
    }
    *status = 200;
    return {{"ok", true}, {"path", resultPath}, {"items", items}};
}

QJsonObject LocalApi::labelledFiles(const QString &contentType, bool favorites) const {
    if (contentType != "Drive" && contentType != "Photos") return {{"error", "Choose Drive or Photos"}};
    const QString root = QFileInfo(routeFor(m_model, contentType).value("source").toString()).canonicalFilePath();
    const auto labels = fileLabels(); if (labels.contains("error")) return labels;
    QJsonArray files;
    if (!root.isEmpty()) {
        const auto items = labels.value("items").toObject();
        for (auto it = items.begin(); it != items.end(); ++it) {
            if (!it.key().startsWith(root + '/')) continue;
            const auto label = it.value().toObject();
            if (favorites ? !label.value("favorite").toBool() : label.value("tags").toArray().isEmpty()) continue;
            const QFileInfo info(it.key());
            if (!info.exists() || info.isSymLink() || !info.canonicalFilePath().startsWith(root + '/')) continue;
            files.append(QJsonObject{{"name", info.fileName()}, {"path", QDir(root).relativeFilePath(it.key())}, {"directory", info.isDir()}, {"size", info.isDir() ? 0 : info.size()}, {"modified", info.lastModified().toString(Qt::ISODate)}, {"type", info.isDir() ? "Folder" : info.suffix().toUpper()}});
        }
    }
    return {{"items", files}, {"root", root}};
}

QJsonObject LocalApi::templates() const {
    const QString drive = routeFor(m_model, "Drive").value("source").toString();
    if (drive.isEmpty()) return {{"root", QString()}, {"items", QJsonArray{}}};
    const QString root = QDir(drive).filePath(".templates");
    QJsonArray items;
    if (!QFileInfo(root).isSymLink()) for (const QFileInfo &file : QDir(root).entryInfoList(QDir::Files | QDir::NoSymLinks, QDir::Name)) {
        if (file.isReadable() && file.size() <= 8 * 1024 * 1024) items.append(QJsonObject{{"name", file.fileName()}, {"size", file.size()}});
    }
    return {{"root", root}, {"items", items}};
}

QJsonObject LocalApi::createFromTemplate(const QJsonObject &options, int *status) const {
    if (status) *status = 400;
    const QString name = options.value("name").toString().trimmed(), selected = options.value("template").toString();
    const auto validName = [](const QString &value) { return !value.isEmpty() && value != "." && value != ".." && value.size() <= 255 && !value.contains('/') && !value.contains('\\') && std::none_of(value.cbegin(), value.cend(), [](QChar c) { return c.isNull() || c.category() == QChar::Other_Control; }); };
    if (!validName(name) || !validName(selected)) return {{"error", "Choose a valid template and filename"}};
    const QString drive = routeFor(m_model, "Drive").value("source").toString();
    if (drive.isEmpty()) return {{"error", "Configure Drive before creating files"}};
    const QString templateRoot = QDir(drive).filePath(".templates");
    const QFileInfo source(QDir(templateRoot).filePath(selected));
    if (QFileInfo(templateRoot).isSymLink() || source.isSymLink() || !source.isFile() || !source.isReadable() || source.size() > 8 * 1024 * 1024) return {{"error", "Template is unavailable or exceeds 8 MB"}};
    const QString relative = QDir::cleanPath(options.value("parent").toString().isEmpty() ? QStringLiteral(".") : options.value("parent").toString());
    if (relative == ".templates" || relative.startsWith(".templates/")) return {{"error", "The templates folder is reserved for application templates"}};
    if (relative != "." && !safeRelative(relative)) return {{"error", "Destination is outside Drive"}};
    const QString root = QFileInfo(routeFor(m_model, "Drive").value("source").toString()).canonicalFilePath();
    const QString parent = QFileInfo(QDir(root).filePath(relative)).canonicalFilePath();
    const QString confined = QDir(root).relativeFilePath(parent);
    if (root.isEmpty() || parent.isEmpty() || !QFileInfo(parent).isDir() || confined == ".." || confined.startsWith("../") || QDir::isAbsolutePath(confined)) return {{"error", "Choose an existing folder inside Drive"}};
    const QString target = QDir(parent).filePath(name);
    if (QFileInfo::exists(target) || QFileInfo(target).isSymLink()) { if (status) *status = 409; return {{"error", "A file already exists with this name"}}; }
    // QFile::copy refuses existing targets; templates are copied as data, never launched.
    if (!QFile::copy(source.filePath(), target)) { if (status) *status = 500; return {{"error", "Template could not be copied; existing files were not replaced"}}; }
    if (status) *status = 200;
    return {{"ok", true}, {"path", QDir(root).relativeFilePath(target)}};
}

QJsonObject LocalApi::saveRoute(const QJsonObject &options, int *status) {
    if (status) *status = 400;
    const QString type = options.value("contentType").toString(), source = options.value("source").toString(), storageId = options.value("storageId").toString(), destination = options.value("destination").toString(), keepPolicy = options.value("keepPolicy").toString("Everything");
    if ((type != "Drive" && type != "Photos") || source.trimmed().isEmpty() || storageId.trimmed().isEmpty() || destination.trimmed().isEmpty()) return {{"error", "Choose Drive or Photos, source, storage, and destination"}};
    for (const auto &value : m_model->routes()) {
        const auto route = value.toMap(); if (route.value("contentType") != type) continue;
        if (route.value("storageId") == storageId) { if (status) *status = 409; return {{"error", QStringLiteral("This %1 relationship already exists").arg(type)}}; }
        if (QDir::cleanPath(route.value("source").toString()) != QDir::cleanPath(source)) { if (status) *status = 409; return {{"error", QStringLiteral("All %1 relationships must share the same computer root").arg(type)}}; }
    }
    QVariantMap storage; for (const auto &value : m_model->storages()) if (value.toMap().value("id") == storageId) storage = value.toMap();
    const QString suggestedSource = QDir(m_model->homeRoot()).filePath(QStringLiteral("Local Drive/%1").arg(type));
    const QString suggestedDestination = QDir(storage.value("root").toString()).filePath(QStringLiteral("Local Drive/%1").arg(type));
    const bool madeSource = !QFileInfo::exists(source) && QDir::cleanPath(source) == QDir::cleanPath(suggestedSource);
    const bool madeDestination = !QFileInfo::exists(destination) && QDir::cleanPath(destination) == QDir::cleanPath(suggestedDestination);
    if (madeSource && !QDir().mkpath(source)) { if (status) *status = 409; return {{"error", "The proposed computer folder could not be created"}}; }
    if (madeDestination && !QDir().mkpath(destination)) { if (madeSource) QDir().rmdir(source); if (status) *status = 409; return {{"error", "The proposed storage folder could not be created"}}; }
    if (!m_model->saveRoute(source, storageId, destination, keepPolicy, 0, options.value("organizePhotos").toBool(false), 0, {}, type)) { if (madeDestination) QDir().rmdir(destination); if (madeSource) QDir().rmdir(source); return {{"error", m_model->errorMessage()}}; }
    if (status) *status = 200;
    return {{"ok", true}, {"contentType", type}, {"configRevision", m_model->configRevision()}};
}

QJsonObject LocalApi::routePreview(const QString &id) const {
    QMutexLocker lock(&m_previewMutex);
    return m_routePreviews.value(id);
}

QJsonObject LocalApi::startRoutePreview(const QString &routeId, int *status) {
    if (status) *status = 404;
    const QVariantList routes = m_model->routes();
    const bool known = std::any_of(routes.cbegin(), routes.cend(), [&](const QVariant &value) { return value.toMap().value("id").toString() == routeId; });
    if (routeId.isEmpty() || !known) return {{"error", "Route not found"}};
    QList<VerifiedCopy *> replaced;
    {
        QMutexLocker lock(&m_previewMutex);
        for (auto iterator = m_routePreviews.begin(); iterator != m_routePreviews.end();) {
            if (iterator.value().value("routeId") != routeId) { ++iterator; continue; }
            const QString state = iterator.value().value("state").toString();
            if (state == "scanning" || state == "copying") { if (status) *status = 409; return {{"error", "This route already has an active operation"}}; }
            if (auto *old = m_routeEngines.take(iterator.key())) replaced.append(old);
            m_routeManifests.remove(iterator.key());
            iterator = m_routePreviews.erase(iterator);
        }
    }
    for (auto *old : std::as_const(replaced)) old->deleteLater();
    const QString id = QUuid::createUuid().toString(QUuid::Id128);
    auto *engine = new VerifiedCopy(m_model->databasePath(), this);
#ifdef LOCAL_DRIVE_TESTING
    if (m_routeTestHook) engine->setTestHook(m_routeTestHook);
#endif
    {
        QMutexLocker lock(&m_previewMutex);
        m_routePreviews.insert(id, {{"id", id}, {"routeId", routeId}, {"state", "scanning"}});
        m_routeEngines.insert(id, engine);
    }
    connect(engine, &VerifiedCopy::runningChanged, this, [this, engine, id, routeId] {
        if (engine->running()) return;
        QMutexLocker lock(&m_previewMutex);
        if (m_routePreviews.value(id).value("state") != "scanning") return;
        const QJsonObject preview = QJsonObject::fromVariantMap(engine->previewData());
        m_routePreviews[id] = {{"id", id}, {"routeId", routeId}, {"state", "complete"}, {"preview", preview}};
        if (preview.value("ok").toBool()) m_routeManifests.insert(id, QJsonObject::fromVariantMap(engine->manifestData()));
        else { m_routeEngines.remove(id); engine->deleteLater(); }
    });
    connect(engine, &VerifiedCopy::progressChanged, this, [this, id](qint64 done, qint64 total, const QString &path) { QMutexLocker lock(&m_previewMutex); QJsonObject operation = m_routePreviews.value(id); if (operation.value("state") != "copying") return; operation.insert("bytesDone", done); operation.insert("bytesTotal", total); operation.insert("path", path); m_routePreviews[id] = operation; });
    connect(engine, &VerifiedCopy::pausedChanged, this, [this, engine, id] { QMutexLocker lock(&m_previewMutex); QJsonObject operation = m_routePreviews.value(id); if (operation.value("state") != "copying") return; operation.insert("paused", engine->paused()); m_routePreviews[id] = operation; });
    connect(engine, &VerifiedCopy::statusChanged, this, [this, engine, id] { QMutexLocker lock(&m_previewMutex); QJsonObject operation = m_routePreviews.value(id); if (operation.value("state") != "copying") return; operation.insert("status", engine->status()); m_routePreviews[id] = operation; });
    connect(engine, &VerifiedCopy::finished, this, [this, engine, id](bool success, const QString &message) { QMutexLocker lock(&m_previewMutex); QJsonObject operation = m_routePreviews.value(id); operation.insert("state", success ? "transferred" : "failed"); operation.insert("result", message); m_routePreviews[id] = operation; m_routeEngines.remove(id); engine->deleteLater(); });
    if (!engine->previewRoute(routeId)) {
        QMutexLocker lock(&m_previewMutex);
        m_routePreviews[id] = {{"id", id}, {"routeId", routeId}, {"state", "complete"}, {"preview", QJsonObject::fromVariantMap(engine->previewData())}};
        m_routeEngines.remove(id);
        m_routeManifests.remove(id);
        engine->deleteLater();
    }
    if (status) *status = 202;
    return {{"id", id}, {"routeId", routeId}, {"state", "scanning"}};
}

QJsonObject LocalApi::routeManifest(const QString &id, int *status) const {
    if (status) *status = 404;
    QMutexLocker lock(&m_previewMutex);
    if (id.isEmpty() || !m_routePreviews.contains(id) || !m_routeManifests.contains(id)) return {{"error", "Successful preview manifest not found"}};
    const QString routeId = m_routePreviews.value(id).value("routeId").toString();
    if (status) *status = 200;
    return {{"filename", QStringLiteral("local-drive-%1-manifest.json").arg(routeId)}, {"manifest", m_routeManifests.value(id)}};
}

QJsonObject LocalApi::routeHistory(const QString &routeId, int *status) const {
    if (status) *status = 404;
    const QVariantList routes = m_model->routes();
    if (routeId.isEmpty() || std::none_of(routes.cbegin(), routes.cend(), [&](const QVariant &value) { return value.toMap().value("id").toString() == routeId; })) return {{"error", "Route not found"}};
    if (status) *status = 200;
    return {{"routeId", routeId}, {"items", json(VerifiedCopy::recentHistoryForRoute(m_model->databasePath(), routeId))}};
}

QJsonObject LocalApi::startRouteExecution(const QString &id, int *status) {
    if (status) *status = 404;
    VerifiedCopy *engine = nullptr;
    {
        QMutexLocker lock(&m_previewMutex);
        const QJsonObject operation = m_routePreviews.value(id);
        if (id.isEmpty() || operation.isEmpty()) return {{"error", "Preview not found"}};
        if (operation.value("state") != "complete" || !operation.value("preview").toObject().value("ok").toBool() || !m_routeEngines.contains(id)) { if (status) *status = 409; return {{"error", "Only a completed successful preview can be transferred"}}; }
        engine = m_routeEngines.value(id);
        QJsonObject copying = operation; copying.insert("state", "copying"); copying.insert("bytesDone", 0); copying.insert("bytesTotal", operation.value("preview").toObject().value("toCopy")); m_routePreviews[id] = copying;
    }
    if (!engine->startCopy()) { QMutexLocker lock(&m_previewMutex); QJsonObject operation = m_routePreviews.value(id); operation.insert("state", "complete"); m_routePreviews[id] = operation; if (status) *status = 409; return {{"error", "Transfer could not start from this preview"}}; }
    if (status) *status = 202;
    return {{"id", id}, {"state", "copying"}};
}

QJsonObject LocalApi::routeControl(const QString &id, const QString &action, int *status) {
    if (status) *status = 404;
    VerifiedCopy *engine = nullptr;
    {
        QMutexLocker lock(&m_previewMutex);
        const QJsonObject operation = m_routePreviews.value(id);
        if (id.isEmpty() || operation.isEmpty()) return {{"error", "Transfer not found"}};
        if (operation.value("state") != "copying" || !m_routeEngines.contains(id)) { if (status) *status = 409; return {{"error", "This transfer is not active"}}; }
        engine = m_routeEngines.value(id);
    }
    if (action == "pause") engine->pause();
    else if (action == "resume") { if (!engine->paused()) { if (status) *status = 409; return {{"error", "This transfer is not paused"}}; } engine->resume(); }
    else if (action == "cancel") engine->cancel();
    else { if (status) *status = 400; return {{"error", "Choose pause, resume, or cancel"}}; }
    if (action == "pause" && !engine->paused()) { if (status) *status = 409; return {{"error", "This transfer could not be paused"}}; }
    if (status) *status = 200;
    return {{"id", id}, {"action", action}, {"paused", engine->paused()}, {"status", engine->status()}};
}

QString LocalApi::photoPath(const QString &relativePath, bool screenshots) const {
    const QString root = QFileInfo(screenshots ? screenshotsRoot() : routeFor(m_model, QStringLiteral("Photos")).value("source").toString()).canonicalFilePath();
    if (root.isEmpty() || relativePath.isEmpty() || QDir::isAbsolutePath(relativePath)) return {};
    const QFileInfo candidate(QDir(root).filePath(relativePath));
    const QString canonical = candidate.canonicalFilePath();
    const QString relativeCanonical = QDir(root).relativeFilePath(canonical);
    if (canonical.isEmpty() || !candidate.isFile() || !isPhoto(candidate) || relativeCanonical == ".." || relativeCanonical.startsWith("../")) return {};
    return canonical;
}

QJsonObject LocalApi::photoInfo(const QString &relativePath, bool screenshots) const {
    const QString canonical = photoPath(relativePath, screenshots);
    if (canonical.isEmpty()) return {{"error", "Image is unavailable or outside the library"}};
    QFile script(":/src/photo_info.py");
    if (!script.open(QIODevice::ReadOnly)) return {{"error", "Location reader unavailable"}};
    // ponytail: one bounded subprocess on explicit Map click; use a worker if latency becomes noticeable.
    QProcess process; process.start("python3", {"-c", QString::fromUtf8(script.readAll()), canonical});
    if (!process.waitForFinished(3000)) { process.kill(); process.waitForFinished(); return {{"error", "Location reader timed out"}}; }
    if (process.exitStatus() != QProcess::NormalExit || process.exitCode() != 0) return {{"error", "Location reader requires Python and Pillow"}};
    const auto result = QJsonDocument::fromJson(process.readAllStandardOutput());
    return result.isObject() ? result.object() : QJsonObject{{"error", "Invalid location metadata response"}};
}

QByteArray LocalApi::photoThumbnail(const QString &relativePath, bool screenshots, bool preview) const {
    const QString canonical = photoPath(relativePath, screenshots);
    if (canonical.isEmpty()) return {};
    QImageReader reader(canonical);
    reader.setAutoTransform(true);
    const QSize original = reader.size();
    if (!original.isValid() || static_cast<qint64>(original.width()) * original.height() > 60'000'000) return {};
    reader.setScaledSize(original.scaled(preview ? QSize(2560, 1920) : QSize(640, 480), Qt::KeepAspectRatio));
    const QImage image = reader.read();
    if (image.isNull()) return {};
    QByteArray bytes;
    QBuffer buffer(&bytes);
    buffer.open(QIODevice::WriteOnly);
    if (!image.save(&buffer, "JPEG", preview ? 92 : 78)) return {};
    return bytes;
}

QJsonObject LocalApi::importPreview(const QString &id) const {
    QMutexLocker lock(&m_previewMutex);
    return m_importPreviews.value(id);
}

void LocalApi::startImportPreview(const QString &id, const QString &source, const QString &target) {
    {
        QMutexLocker lock(&m_previewMutex);
        m_importPreviews.insert(id, {{"id", id}, {"state", "scanning"}, {"target", target}});
    }
    const QVariantMap route = routeFor(m_model, target);
    const QString destination = route.value("source").toString();
    QString identityError;
    const QString identity = VerifiedCopy::liveStorageIdentity(destination, &identityError);
    if (route.isEmpty() || destination.isEmpty() || identity.isEmpty()) {
        QMutexLocker lock(&m_previewMutex);
        m_importPreviews[id] = {{"id", id}, {"state", "complete"}, {"target", target}, {"preview", QJsonObject{{"ok", false}, {"error", identityError.isEmpty() ? QStringLiteral("Configure the %1 root before importing").arg(target) : identityError}}}};
        return;
    }
    VerifiedCopy::Request request;
    request.sourceRoot = source;
    request.destinationRoot = destination;
    request.selectedStorageRoot = destination;
    request.storageIdentity = identity;
    request.databasePath = m_model->databasePath();
    request.destinationStorageId = QStringLiteral("local");
    request.organizePhotos = false;
    request.contentType = target;
    const QString sourceKey = QString::fromLatin1(QCryptographicHash::hash(QFileInfo(source).absoluteFilePath().toUtf8(), QCryptographicHash::Sha256).toHex().left(24));
    request.routeId = QStringLiteral("import-%1-%2").arg(target.toLower(), sourceKey);
    request.sourceStorageId = QStringLiteral("external-import-%1").arg(sourceKey);
    request.sourceStorageIdentity = QStringLiteral("folder:%1").arg(sourceKey);
    request.sourceStorageLabel = QStringLiteral("Imported folder");
    request.detectDestinationDuplicates = true;
    request.routeEnabled = false;
    QThread *worker = QThread::create([this, id, target, request] {
        const VerifiedCopy::Preview result = VerifiedCopy::inspect(request, &m_stopping);
        if (!m_stopping.load()) saveImportReviewItems(request.databasePath, request.sourceRoot, target, result);
        QStringList previewPairs = result.duplicatePaths; previewPairs.sort(); previewPairs.removeDuplicates();
        const bool duplicatesAccepted = !previewPairs.isEmpty() && acceptedDuplicatePairs(request.databasePath, request.sourceRoot, target) == previewPairs;
        QStringList previewConflictEvidence = result.conflictEvidence; previewConflictEvidence.sort(); previewConflictEvidence.removeDuplicates();
        const bool conflictsAccepted = !previewConflictEvidence.isEmpty() && acceptedConflictEvidence(request.databasePath, request.sourceRoot, target) == previewConflictEvidence;
        QStringList previewUnsupportedEvidence = result.unsupportedEvidence; previewUnsupportedEvidence.sort(); previewUnsupportedEvidence.removeDuplicates();
        const bool unsupportedAccepted = !previewUnsupportedEvidence.isEmpty() && acceptedUnsupportedEvidence(request.databasePath, request.sourceRoot, target) == previewUnsupportedEvidence;
        QJsonObject previewJson = QJsonObject::fromVariantMap(result.toMap()); previewJson.insert("duplicatesAccepted", duplicatesAccepted); previewJson.insert("conflictsAccepted", conflictsAccepted); previewJson.insert("unsupportedAccepted", unsupportedAccepted);
        QMutexLocker lock(&m_previewMutex);
        m_importPreviews[id] = {{"id", id}, {"state", "complete"}, {"phase", "preview"}, {"target", target}, {"preview", previewJson}};
        m_importRequests.insert(id, request);
        m_importPlans.insert(id, result);
    });
    m_workers.append(worker);
    connect(worker, &QThread::finished, this, [this, worker] { m_workers.removeOne(worker); worker->deleteLater(); });
    worker->start();
}

QJsonObject LocalApi::startImportExecution(const QString &id, int *status) {
    if (status) *status = 400;
    VerifiedCopy::Request request;
    VerifiedCopy::Preview plan;
    {
        QMutexLocker lock(&m_previewMutex);
        const QJsonObject operation = m_importPreviews.value(id);
        if (id.isEmpty() || operation.isEmpty()) { if (status) *status = 404; return {{"error", "Preview not found"}}; }
        if (operation.value("state") != "complete" || !m_importRequests.contains(id) || !m_importPlans.contains(id)) { if (status) *status = 409; return {{"error", "Preview is not ready for execution"}}; }
        request = m_importRequests.value(id); plan = m_importPlans.value(id);
        if (!plan.ok) return {{"error", plan.error.isEmpty() ? QStringLiteral("Preview did not pass") : plan.error}};
        if (plan.unreadable) {
            if (status) *status = 409;
            return {{"error", "Resolve permission findings before importing"}};
        }
    }
    QStringList acceptedConflicts, acceptedConflictHashes;
    if (plan.conflicts) {
        acceptedConflictHashes = acceptedConflictEvidence(request.databasePath, request.sourceRoot, request.contentType);
        QStringList previewEvidence = plan.conflictEvidence; previewEvidence.sort(); previewEvidence.removeDuplicates();
        if (acceptedConflictHashes != previewEvidence) { if (status) *status = 409; return {{"error", "Choose Keep both for this exact conflict group in Problems & Fixes"}}; }
        acceptedConflicts = plan.conflictPaths; acceptedConflicts.sort(); acceptedConflicts.removeDuplicates();
        QSet<QString> reserved;
        for (const auto &entry : plan.manifest) reserved.insert(entry.destination);
        for (const QString &conflict : acceptedConflicts) {
            const auto matches = std::count_if(plan.manifest.cbegin(), plan.manifest.cend(), [&](const auto &entry) { return entry.destination == conflict; });
            if (matches != 1) { if (status) *status = 409; return {{"error", "Conflict evidence is ambiguous; preview again"}}; }
            const auto entry = std::find_if(plan.manifest.cbegin(), plan.manifest.cend(), [&](const auto &candidate) { return candidate.destination == conflict; });
            const QString replacement = importedName(request.destinationRoot, conflict, reserved);
            if (replacement.isEmpty()) { if (status) *status = 409; return {{"error", "No safe name is available for the imported version"}}; }
            request.destinationOverrides.insert(entry->relative, replacement);
        }
    }
    QStringList acceptedUnsupported;
    if (plan.unsupported) {
        acceptedUnsupported = acceptedUnsupportedEvidence(request.databasePath, request.sourceRoot, request.contentType);
        QStringList previewUnsupported = plan.unsupportedEvidence; previewUnsupported.sort(); previewUnsupported.removeDuplicates();
        if (acceptedUnsupported != previewUnsupported) { if (status) *status = 409; return {{"error", "Choose Keep unsupported in source for this exact group in Problems & Fixes"}}; }
        request.acceptedUnsupportedEvidence = acceptedUnsupported;
    }
    QStringList acceptedPairs;
    if (plan.duplicates || plan.destinationDuplicates) {
        acceptedPairs = acceptedDuplicatePairs(request.databasePath, request.sourceRoot, request.contentType);
        QStringList previewPairs = plan.duplicatePaths; previewPairs.sort(); previewPairs.removeDuplicates();
        if (acceptedPairs != previewPairs) { if (status) *status = 409; return {{"error", "Choose Use existing copies for this exact duplicate group in Problems & Fixes"}}; }
        for (const QString &pair : acceptedPairs) {
            const qsizetype separator = pair.indexOf(QStringLiteral(" ↔ "));
            if (separator <= 0) { if (status) *status = 409; return {{"error", "Duplicate evidence is invalid; preview again"}}; }
            request.excludedSourcePaths.append(pair.left(separator));
        }
    }
    {
        QMutexLocker lock(&m_previewMutex);
        const QJsonObject operation = m_importPreviews.value(id);
        if (operation.value("state") != "complete") { if (status) *status = 409; return {{"error", "Import already started or preview is no longer ready"}}; }
        m_importPreviews[id] = {{"id", id}, {"state", "copying"}, {"phase", "import"}, {"target", operation.value("target")}, {"preview", operation.value("preview")}};
    }
    QThread *worker = QThread::create([this, id, request, plan, acceptedPairs, acceptedConflicts, acceptedConflictHashes, acceptedUnsupported] {
        VerifiedCopy copy(request.databasePath);
        QString error, completion;
        VerifiedCopy::Request fullRequest = request; fullRequest.excludedSourcePaths.clear(); fullRequest.destinationOverrides.clear();
        const VerifiedCopy::Preview current = VerifiedCopy::inspect(fullRequest, &m_stopping);
        QStringList currentPairs = current.duplicatePaths; currentPairs.sort(); currentPairs.removeDuplicates();
        QStringList currentConflicts = current.conflictPaths; currentConflicts.sort(); currentConflicts.removeDuplicates();
        QStringList currentConflictHashes = current.conflictEvidence; currentConflictHashes.sort(); currentConflictHashes.removeDuplicates();
        QStringList currentUnsupported = current.unsupportedEvidence; currentUnsupported.sort(); currentUnsupported.removeDuplicates();
        const bool manifestMatches = current.manifest.size() == plan.manifest.size() && std::equal(current.manifest.cbegin(), current.manifest.cend(), plan.manifest.cbegin(), [](const auto &left, const auto &right) { return left.relative == right.relative && left.destination == right.destination && left.size == right.size && left.mtime == right.mtime; });
        bool ok = current.ok && manifestMatches && !current.unreadable && currentPairs == acceptedPairs && currentConflicts == acceptedConflicts && currentConflictHashes == acceptedConflictHashes && currentUnsupported == acceptedUnsupported;
        if (!ok) error = QStringLiteral("Import evidence changed; preview again");
        const VerifiedCopy::Preview filtered = ok ? VerifiedCopy::inspect(request, &m_stopping) : VerifiedCopy::Preview{};
        if (ok && (!filtered.ok || filtered.duplicates || filtered.destinationDuplicates || filtered.conflicts || filtered.unsupported != acceptedUnsupported.size() || filtered.unreadable)) { ok = false; error = filtered.error.isEmpty() ? QStringLiteral("Import findings changed; preview again") : filtered.error; }
        if (ok) ok = copy.executePreviewBlocking(request, filtered, &error, &completion);
        QMutexLocker lock(&m_previewMutex);
        QJsonObject operation = m_importPreviews.value(id);
        operation.insert("state", ok ? (completion == "Completed with conflicts" ? "attention" : "imported") : "failed");
        operation.insert("result", ok ? completion : error);
        m_importPreviews[id] = operation;
    });
    m_workers.append(worker);
    connect(worker, &QThread::finished, this, [this, worker] { m_workers.removeOne(worker); worker->deleteLater(); });
    worker->start();
    if (status) *status = 202;
    return {{"id", id}, {"state", "copying"}};
}
