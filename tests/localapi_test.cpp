#include "../src/localapi.h"
#include "../src/setupmodel.h"

#include <QDir>
#include <QCoreApplication>
#include <QEventLoop>
#include <QHostAddress>
#include <QTcpSocket>
#include <QTimer>
#include <QFile>
#include <QFileInfo>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QSemaphore>
#include <QSignalSpy>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QStorageInfo>
#include <QTemporaryDir>
#include <QTest>
#include <QScopeGuard>
#include <QUrlQuery>
#include <unistd.h>

class LocalApiTest final : public QObject {
    Q_OBJECT
private slots:
    void packagedStaticFiles();
    void rejectsUnsafeHttpRequests();
    void requestDeadline();
    void servesStateOnlyOnLoopback();
    void photosPaginationHasNoSilentLimit();
    void templatesCopyWithoutOverwriteOrTraversal();
    void localizedScreenshotsAreReadOnly();
    void exportsPhotosAndSharesTags();
    void savesOnlyMissingValidatedRoute();
    void previewsConfiguredRoute();
    void controlsActiveRouteSafely();
    void stagingCapRejectsPhoneImportBeforeCopy();
    void deviceOnboardingPersistsParticipationChoice();
};

namespace {
QByteArray rawRequest(quint16 port, const QByteArray &request, int timeout = 3000, const QByteArray &tail = {}) {
    QTcpSocket socket;
    QEventLoop loop;
    QTimer timer;
    timer.setSingleShot(true);
    QByteArray response;
    QObject::connect(&socket, &QTcpSocket::readyRead, &loop, [&] { response += socket.readAll(); });
    QObject::connect(&socket, &QTcpSocket::disconnected, &loop, &QEventLoop::quit);
    QObject::connect(&timer, &QTimer::timeout, &loop, &QEventLoop::quit);
    QObject::connect(&socket, &QTcpSocket::connected, &loop, [&] {
        socket.write(request);
        if (!tail.isEmpty()) QTimer::singleShot(20, &socket, [&] { socket.write(tail); });
    });
    socket.connectToHost(QHostAddress::LocalHost, port);
    timer.start(timeout);
    loop.exec();
    response += socket.readAll();
    return response;
}

QByteArray responseBody(const QByteArray &response) { return response.mid(response.indexOf("\r\n\r\n") + 4); }
}

void LocalApiTest::packagedStaticFiles() {
    QTemporaryDir temp; QVERIFY(temp.isValid());
    const QString root = temp.filePath("web");
    QVERIFY(QDir().mkpath(root + "/assets"));
    QVERIFY(QDir().mkpath(root + "/.hidden"));
    const QList<QPair<QString, QByteArray>> assets{
        {"index.html", "<!doctype html><title>Drive</title>"}, {"assets/app-a12b.js", "export default 1;"},
        {"assets/app-a12b.css", "body{color:red}"}, {"assets/logo.svg", "<svg/>"},
        {"assets/empty.txt", ""}, {".secret", "secret"}, {".hidden/file.txt", "hidden"}};
    for (const auto &asset : assets) {
        QFile file(root + '/' + asset.first); QVERIFY(file.open(QIODevice::WriteOnly)); QCOMPARE(file.write(asset.second), asset.second.size());
    }
    QFile outside(temp.filePath("outside.txt")); QVERIFY(outside.open(QIODevice::WriteOnly)); outside.write("outside"); outside.close();
    QVERIFY(QFile::link(outside.fileName(), root + "/escape.txt"));
    QVERIFY(QFile::link(root + "/.secret", root + "/hidden-link.txt"));
    QVERIFY(QFile::link(root + "/assets", root + "/linked-assets"));
    SetupModel model(temp.filePath("catalog.sqlite"), {}); LocalApi api(&model); QVERIFY(api.start(0));
    const auto get = [&](const QByteArray &path) { return rawRequest(api.port(), "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + QByteArray::number(api.port()) + "\r\n\r\n"); };
    QVERIFY(get("/").startsWith("HTTP/1.1 404"));
    api.setWebRoot(root + "/assets/..");
    QCOMPARE(responseBody(get("/")), assets[0].second);
    const QList<QByteArray> mime{"text/html", "javascript", "text/css", "image/svg+xml", "text/plain"};
    for (int i = 0; i < 5; ++i) {
        const auto response = get('/' + assets[i].first.toUtf8() + "?v=1");
        QVERIFY2(response.startsWith("HTTP/1.1 200"), response.constData());
        QVERIFY(response.left(response.indexOf("\r\n\r\n")).contains(mime[i]));
        QCOMPARE(responseBody(response), assets[i].second);
        QVERIFY(!response.contains("Access-Control-Allow-Origin"));
    }
    for (const QByteArray &path : {"/missing", "/api/v1/missing", "/../outside.txt", "/%2e%2e/outside.txt", "/assets/%2e%2e/index.html",
                                  "/.secret", "/.hidden/file.txt", "/escape.txt", "/hidden-link.txt", "/linked-assets/app-a12b.js", "/assets%5capp-a12b.js", "/index.html%00.txt"}) {
        const auto response = get(path); QVERIFY2(response.startsWith("HTTP/1.1 404"), response.constData());
    }
    const QString oldVersion = QCoreApplication::applicationVersion();
    const auto restore = qScopeGuard([&] { QCoreApplication::setApplicationVersion(oldVersion); });
    QCoreApplication::setApplicationVersion("0.1.0-test");
    const auto health = QJsonDocument::fromJson(responseBody(get("/api/v1/health"))).object();
    QCOMPARE(health.value("application").toString(), QString("local-drive"));
    QCOMPARE(health.value("appVersion").toString(), QString("0.1.0-test"));
    QCOMPARE(health.value("apiVersion").toInt(), 1);
    QCOMPARE(health.value("userId").toInteger(), static_cast<qint64>(::geteuid()));
    api.setWebRoot(temp.filePath("missing")); QVERIFY(get("/").startsWith("HTTP/1.1 404"));
    api.setWebRoot(""); QVERIFY(get("/").startsWith("HTTP/1.1 404"));
}

void LocalApiTest::rejectsUnsafeHttpRequests() {
    QTemporaryDir temp; QVERIFY(temp.isValid());
    SetupModel model(temp.filePath("catalog.sqlite"), {}); LocalApi api(&model); QVERIFY(api.start(0)); QVERIFY(api.isLoopbackBound());
    const QByteArray host = "127.0.0.1:" + QByteArray::number(api.port());
    const auto get = [&](const QByteArray &path, const QByteArray &headers) {
        return rawRequest(api.port(), "GET " + path + " HTTP/1.1\r\n" + headers + "\r\n");
    };
    for (const QByteArray &path : {"/api/v1/health", "/api/v1/session", "/api/v1/state", "/"}) {
        for (const QByteArray &badHost : {QByteArray(), QByteArray("evil.test"), QByteArray("localhost"), QByteArray("localhost:80"), host + ".evil.test", QByteArray("127.1:5173"), QByteArray("[::1]:5173")})
            QVERIFY(get(path, "Host: " + badHost + "\r\n").startsWith("HTTP/1.1 403"));
        for (const QByteArray &origin : {QByteArray("null"), QByteArray(), QByteArray("https://") + host, QByteArray("http://evil.test"), QByteArray("http://") + host + "/", QByteArray("http://localhost:51730"), QByteArray("http://user@") + host})
            QVERIFY(get(path, "Host: " + host + "\r\nOrigin: " + origin + "\r\n").startsWith("HTTP/1.1 403"));
        QVERIFY(get(path, "Host: " + host + "\r\nSec-Fetch-Site: cross-site\r\n").startsWith("HTTP/1.1 403"));
        QVERIFY(get(path, "").startsWith("HTTP/1.1 403"));
    }
    for (const auto &allowed : {host, "localhost:" + QByteArray::number(api.port()), QByteArray("localhost:5173"), QByteArray("127.0.0.1:5173"), QByteArray("localhost:4173"), QByteArray("127.0.0.1:4173")}) {
        const auto response = get("/api/v1/session", "Host: " + allowed + "\r\nOrigin: http://" + allowed + "\r\nSec-Fetch-Site: same-origin\r\n");
        QVERIFY2(response.startsWith("HTTP/1.1 200"), response.constData());
        QVERIFY(!QJsonDocument::fromJson(responseBody(response)).object().value("token").toString().isEmpty());
        QVERIFY(!response.contains("Access-Control-Allow-Origin"));
    }
    for (const QByteArray &framing : {"Content-Length: 0\r\nContent-Length: 0\r\n", "Content-Length: 0\r\ncOnTeNt-LeNgTh: 1\r\n",
                                     "Content-Length: +0\r\n", "Content-Length: -1\r\n", "Content-Length: 0,0\r\n", "Content-Length: \r\n",
                                     "Content-Length: 9999999999999999999999\r\n", "Content-Length: 8193\r\n", "Content-Length : 0\r\n",
                                     "Transfer-Encoding: chunked\r\n", "Content-Length: 0\r\nTransfer-Encoding: identity\r\n", "Expect: 100-continue\r\n",
                                     "Host: localhost:5173\r\n", "Origin: http://localhost:5173\r\nOrigin: null\r\n", "BadHeader\r\n", " folded: value\r\n", "X: a\nY: b\r\n"}) {
        const auto response = get("/api/v1/session", "Host: " + host + "\r\n" + framing);
        QVERIFY2(response.startsWith("HTTP/1.1 400"), response.constData());
    }
    const QByteArray sessionRequest = "GET /api/v1/session HTTP/1.1\r\nHost: " + host + "\r\n\r\n";
    const auto token = QJsonDocument::fromJson(responseBody(rawRequest(api.port(), sessionRequest))).object().value("token").toString().toUtf8();
    const QByteArray body = "{\"action\":\"create-tag\",\"tag\":\"pipeline-tag\"}";
    const QByteArray post = "POST /api/v1/file-action HTTP/1.1\r\nHost: " + host + "\r\nContent-Type: application/json\r\nX-Local-Drive-Token: " + token + "\r\nContent-Length: " + QByteArray::number(body.size()) + "\r\n\r\n" + body;
    QByteArray foreignPost = post;
    foreignPost.replace("\r\nHost:", "\r\nOrigin: null\r\nHost:");
    QVERIFY(rawRequest(api.port(), foreignPost).startsWith("HTTP/1.1 403"));
    const auto pipeline = rawRequest(api.port(), post + post);
    QVERIFY(pipeline.startsWith("HTTP/1.1 400")); QCOMPARE(pipeline.count("HTTP/1.1"), 1);
    const auto labels = QJsonDocument::fromJson(responseBody(get("/api/v1/file-labels", "Host: " + host + "\r\n"))).object();
    QVERIFY(!labels.value("tags").toArray().contains("pipeline-tag"));
    for (const QByteArray &target : {"http://localhost:5173/api/v1/session", "//localhost:5173/api/v1/session", "/api/v1/session#fragment", "/api/v1/%zz"})
        QVERIFY(get(target, "Host: " + host + "\r\n").startsWith("HTTP/1.1 400"));
    const auto fragmented = rawRequest(api.port(), post.left(post.size() - 2), 3000, post.right(2));
    QVERIFY2(fragmented.startsWith("HTTP/1.1 200"), fragmented.constData()); QCOMPARE(fragmented.count("HTTP/1.1"), 1);
}

void LocalApiTest::requestDeadline() {
    QTemporaryDir temp; QVERIFY(temp.isValid()); SetupModel model(temp.filePath("catalog.sqlite"), {});
    LocalApi api(&model); QVERIFY(api.start(0));
    const auto response = rawRequest(api.port(), "GET /api/v1/session HTTP/1.1\r\n", 12000);
    QVERIFY2(response.startsWith("HTTP/1.1 408"), response.constData());
    QCOMPARE(response.count("HTTP/1.1"), 1);
}

void LocalApiTest::exportsPhotosAndSharesTags() {
    QTemporaryDir temp; QVERIFY(temp.isValid());
    const QString photos = temp.filePath("Photos"), disk = temp.filePath("disk"); QVERIFY(QDir().mkpath(photos)); QVERIFY(QDir().mkpath(disk + "/Photos"));
    QFile file(photos + "/photo.jpg"); QVERIFY(file.open(QIODevice::WriteOnly)); file.write("test photo"); file.close();
    SetupModel model(temp.filePath("catalog.sqlite"), {QVariantMap{{"id", "disk"}, {"root", disk}, {"label", "Disk"}, {"present", true}, {"kind", "removable"}}});
    QVERIFY(model.saveRoute(photos, "disk", disk + "/Photos", "Everything", 0, false, 0, {}, "Photos"));
    LocalApi api(&model); QVERIFY(api.start(0)); QNetworkAccessManager network;
    const QString base = QString("http://127.0.0.1:%1/api/v1/").arg(api.port());
    const auto get = [&](const QString &path) { auto *reply = network.get(QNetworkRequest(QUrl(base + path))); QSignalSpy done(reply, &QNetworkReply::finished); done.wait(3000); const auto result = QJsonDocument::fromJson(reply->readAll()).object(); reply->deleteLater(); return result; };
    const auto token = get("session").value("token").toString().toUtf8();
    const auto post = [&](const QJsonObject &options) { QNetworkRequest request(QUrl(base + "file-action")); request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json"); request.setRawHeader("X-Local-Drive-Token", token); auto *reply = network.post(request, QJsonDocument(options).toJson()); QSignalSpy done(reply, &QNetworkReply::finished); done.wait(3000); auto result = QJsonDocument::fromJson(reply->readAll()).object(); result.insert("httpStatus", reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt()); reply->deleteLater(); return result; };
    QCOMPARE(post({{"action", "create-tag"}, {"tag", "Διακοπές"}}).value("httpStatus").toInt(), 200);
    QVERIFY(get("file-labels").value("tags").toArray().contains("Διακοπές"));
    // A present backup disk alone cannot certify the individual source photos.
    QCOMPARE(get("photos").value("verifiedOn").toString(), QString());
    QCOMPARE(post({{"action", "labels"}, {"root", "Photos"}, {"path", "photo.jpg"}, {"modified", QFileInfo(file).lastModified().toString(Qt::ISODate)}, {"size", QFileInfo(file).size()}, {"favorite", true}, {"tags", QJsonArray{"Διακοπές"}}}).value("httpStatus").toInt(), 200);
    QCOMPARE(get("labelled-files?root=Photos&filter=favorites").value("items").toArray().size(), 1);
    QCOMPARE(get("labelled-files?root=Drive&filter=favorites").value("items").toArray().size(), 0);
    const auto start = post({{"action", "export-photos"}, {"storageId", "disk"}, {"name", "test.ldrive"}});
    QCOMPARE(start.value("httpStatus").toInt(), 202);
    const auto id = start.value("id").toString(); QVERIFY(!id.isEmpty());
    QJsonObject progress;
    QTRY_VERIFY_WITH_TIMEOUT(([&] { progress = get("route-preview?id=" + id); return progress.value("state") == "transferred" || progress.value("state") == "failed"; })(), 10000);
    QVERIFY2(progress.value("state") == "transferred", qPrintable(progress.value("result").toString()));
    QCOMPARE(get("state").value("photoExports").toArray().first().toObject().value("id").toString(), id);
    QVERIFY(QFileInfo::exists(disk + "/test.ldrive")); QVERIFY(file.open(QIODevice::ReadOnly)); QCOMPARE(file.readAll(), QByteArray("test photo"));
}

void LocalApiTest::localizedScreenshotsAreReadOnly() {
    QTemporaryDir temp; QVERIFY(temp.isValid());
    const QString pictures = temp.filePath("Εικόνες/Screenshots"); QVERIFY(QDir().mkpath(pictures));
    QImage image(20, 20, QImage::Format_RGB32); image.fill(Qt::green); QVERIFY(image.save(pictures + "/screen.png"));
    qputenv("LOCAL_DRIVE_TEST_SCREENSHOTS", pictures.toUtf8()); const auto reset = qScopeGuard([] { qunsetenv("LOCAL_DRIVE_TEST_SCREENSHOTS"); });
    SetupModel model(temp.filePath("catalog.sqlite"), {}); LocalApi api(&model); QVERIFY(api.start(0)); QNetworkAccessManager network;
    const QString base = QString("http://127.0.0.1:%1/api/v1/").arg(api.port());
    auto *reply = network.get(QNetworkRequest(QUrl(base + "screenshots"))); QSignalSpy done(reply, &QNetworkReply::finished); QVERIFY(done.wait(3000));
    const auto result = QJsonDocument::fromJson(reply->readAll()).object(); reply->deleteLater();
    QCOMPARE(result.value("root").toString(), pictures); QCOMPARE(result.value("items").toArray().size(), 1); QCOMPARE(result.value("verifiedOn").toString(), QString());
    auto *thumbnail = network.get(QNetworkRequest(QUrl(base + "photo-thumbnail?root=Screenshots&path=screen.png"))); QSignalSpy imageDone(thumbnail, &QNetworkReply::finished); QVERIFY(imageDone.wait(3000));
    QVERIFY(!QImage::fromData(thumbnail->readAll()).isNull()); thumbnail->deleteLater(); QVERIFY(QFileInfo::exists(pictures + "/screen.png"));
    auto *preview = network.get(QNetworkRequest(QUrl(base + "photo-thumbnail?root=Screenshots&path=screen.png&preview=1"))); QSignalSpy previewDone(preview, &QNetworkReply::finished); QVERIFY(previewDone.wait(3000)); QVERIFY(!QImage::fromData(preview->readAll()).isNull()); preview->deleteLater();
    auto *escape = network.get(QNetworkRequest(QUrl(base + "photo-info?root=Screenshots&path=../outside.jpg"))); QSignalSpy escapeDone(escape, &QNetworkReply::finished); QVERIFY(escapeDone.wait(3000)); QCOMPARE(escape->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 400); escape->deleteLater();
}

void LocalApiTest::templatesCopyWithoutOverwriteOrTraversal() {
    QTemporaryDir temp; QVERIFY(temp.isValid());
    const QString root = temp.filePath("Drive"), disk = temp.filePath("disk"), destination = temp.filePath("disk/Drive"), templates = temp.filePath("Drive/.templates");
    QVERIFY(QDir().mkpath(root)); QVERIFY(QDir().mkpath(destination)); QVERIFY(QDir().mkpath(templates));
    QFile source(templates + "/Blank.txt"); QVERIFY(source.open(QIODevice::WriteOnly)); source.write("template data"); source.close();
    QVERIFY(::symlink(source.fileName().toLocal8Bit().constData(), (templates + "/linked.txt").toLocal8Bit().constData()) == 0);
    SetupModel model(temp.filePath("catalog.sqlite"), {QVariantMap{{"id", "disk"}, {"root", disk}, {"label", "Disk"}, {"present", true}, {"kind", "removable"}}}); model.setHomeRootForTest(temp.path());
    QVERIFY(model.saveRoute(root, "disk", destination));
    LocalApi api(&model); QVERIFY(api.start(0)); QNetworkAccessManager network;
    const QString base = QString("http://127.0.0.1:%1/api/v1/").arg(api.port());
    auto *session = network.get(QNetworkRequest(QUrl(base + "session"))); QSignalSpy sessionDone(session, &QNetworkReply::finished); QVERIFY(sessionDone.wait(3000));
    const QByteArray token = QJsonDocument::fromJson(session->readAll()).object().value("token").toString().toUtf8(); session->deleteLater();
    auto *listing = network.get(QNetworkRequest(QUrl(base + "templates"))); QSignalSpy listDone(listing, &QNetworkReply::finished); QVERIFY(listDone.wait(3000));
    QCOMPARE(QJsonDocument::fromJson(listing->readAll()).object().value("items").toArray().size(), 1); listing->deleteLater();
    const auto post = [&](QString chosen, QString name, QString parent) {
        QNetworkRequest request(QUrl(base + "create-from-template")); request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json"); request.setRawHeader("X-Local-Drive-Token", token);
        auto *reply = network.post(request, QJsonDocument(QJsonObject{{"template", chosen}, {"name", name}, {"parent", parent}}).toJson());
        QSignalSpy done(reply, &QNetworkReply::finished); const bool finished = done.wait(3000);
        const int status = finished ? reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() : 0; reply->deleteLater(); return status;
    };
    QCOMPARE(post("Blank.txt", "new.txt", ""), 200);
    QCOMPARE(post("Blank.txt", "new.txt", ""), 409);
    QCOMPARE(post("Blank.txt", "../escape.txt", ""), 400);
    QCOMPARE(post("Blank.txt", "escape.txt", ".."), 400);
    QCOMPARE(post("linked.txt", "linked-copy.txt", ""), 400);
    QFile created(root + "/new.txt"); QVERIFY(created.open(QIODevice::ReadOnly)); QCOMPARE(created.readAll(), QByteArray("template data"));
    QVERIFY(!QFileInfo::exists(temp.filePath("escape.txt")));
    const auto act = [&](QString action, QString path, QString target = QString(), bool stale = false) {
        const QFileInfo info(root + '/' + path);
        QNetworkRequest request(QUrl(base + "file-action")); request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json"); request.setRawHeader("X-Local-Drive-Token", token);
        auto *reply = network.post(request, QJsonDocument(QJsonObject{{"action", action}, {"path", path}, {"destination", target}, {"modified", stale ? "old" : info.lastModified().toString(Qt::ISODate)}, {"size", info.size()}, {"favorite", true}, {"tags", QJsonArray{"Medical", "Medical"}}}).toJson());
        QSignalSpy done(reply, &QNetworkReply::finished); const bool finished = done.wait(3000);
        const int status = finished ? reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() : 0; reply->deleteLater(); return status;
    };
    QCOMPARE(act("copy", "new.txt", "copy.txt"), 200);
    QFile copy(root + "/copy.txt"); QVERIFY(copy.open(QIODevice::ReadOnly)); QCOMPARE(copy.readAll(), QByteArray("template data")); copy.close();
    QCOMPARE(act("copy", "new.txt", "copy.txt"), 409);
    QCOMPARE(act("rename", "new.txt", "copy.txt"), 409);
    QCOMPARE(act("rename", "new.txt", "renamed.txt", true), 409);
    QCOMPARE(act("labels", "new.txt"), 200);
    QCOMPARE(act("rename", "new.txt", "renamed.txt"), 200);
    QVERIFY(!QFileInfo::exists(root + "/new.txt")); QVERIFY(QFileInfo::exists(root + "/renamed.txt"));
    auto *labelsReply = network.get(QNetworkRequest(QUrl(base + "file-labels"))); QSignalSpy labelsDone(labelsReply, &QNetworkReply::finished); QVERIFY(labelsDone.wait(3000));
    const auto labels = QJsonDocument::fromJson(labelsReply->readAll()).object().value("items").toObject(); labelsReply->deleteLater();
    QVERIFY(!labels.contains(root + "/new.txt")); QVERIFY(labels.value(root + "/renamed.txt").toObject().value("favorite").toBool());
    QCOMPARE(labels.value(root + "/renamed.txt").toObject().value("tags").toArray(), QJsonArray{"Medical"});
    QCOMPARE(act("copy", "renamed.txt", "../escape.txt"), 400);
    QCOMPARE(act("trash", ".templates/Blank.txt"), 400);
    QVERIFY(::symlink(temp.path().toLocal8Bit().constData(), (root + "/outside").toLocal8Bit().constData()) == 0);
    QCOMPARE(act("move", "renamed.txt", "outside/escape.txt"), 400);
    QVERIFY(QDir(root).mkdir("Folder"));
    QCOMPARE(act("move", "renamed.txt", "Folder/renamed.txt"), 200);
    QCOMPARE(act("rename", "Folder", "Renamed folder"), 200);
    QVERIFY(QFileInfo::exists(root + "/Renamed folder/renamed.txt"));
}

void LocalApiTest::photosPaginationHasNoSilentLimit() {
    QTemporaryDir temp; QVERIFY(temp.isValid());
    const QString root = temp.filePath("Photos"), disk = temp.filePath("disk"), destination = temp.filePath("disk/Photos");
    QVERIFY(QDir().mkpath(root)); QVERIFY(QDir().mkpath(destination));
    for (int i = 0; i < 501; ++i) { QFile file(QDir(root).filePath(QString("%1.jpg").arg(i, 4, 10, QLatin1Char('0')))); QVERIFY(file.open(QIODevice::WriteOnly)); file.write("test"); }
    SetupModel model(temp.filePath("catalog.sqlite"), {QVariantMap{{"id", "disk"}, {"root", disk}, {"label", "Disk"}, {"present", true}, {"kind", "removable"}}});
    QVERIFY(model.saveRoute(root, "disk", destination, "Everything", 0, false, 0, {}, "Photos"));
    LocalApi api(&model); QVERIFY(api.start(0)); QNetworkAccessManager network;
    auto *first = network.get(QNetworkRequest(QUrl(QString("http://127.0.0.1:%1/api/v1/photos").arg(api.port()))));
    QSignalSpy firstDone(first, &QNetworkReply::finished); QVERIFY(firstDone.wait(3000));
    const auto page = QJsonDocument::fromJson(first->readAll()).object(); first->deleteLater();
    QCOMPARE(page.value("items").toArray().size(), 500); QVERIFY(page.value("truncated").toBool());
    QCOMPARE(page.value("nextCursor").toString(), QStringLiteral("0499.jpg"));
    auto *second = network.get(QNetworkRequest(QUrl(QString("http://127.0.0.1:%1/api/v1/photos?after=0499.jpg").arg(api.port()))));
    QSignalSpy secondDone(second, &QNetworkReply::finished); QVERIFY(secondDone.wait(3000));
    const auto last = QJsonDocument::fromJson(second->readAll()).object(); second->deleteLater();
    QCOMPARE(last.value("items").toArray().size(), 1); QVERIFY(!last.value("truncated").toBool());
    QCOMPARE(last.value("items").toArray().first().toObject().value("path").toString(), QStringLiteral("0500.jpg"));
}

void LocalApiTest::servesStateOnlyOnLoopback() {
    QTemporaryDir temp;
    QVERIFY(temp.isValid());
    QDir photos(temp.filePath("Photos/2026")), drive(temp.filePath("Drive")), disk(temp.filePath("disk")), destination(temp.filePath("disk/Photos")), driveDestination(temp.filePath("disk/Drive"));
    QVERIFY(photos.mkpath("."));
    QVERIFY(drive.mkpath("Medical"));
    QVERIFY(destination.mkpath("."));
    QVERIFY(driveDestination.mkpath("."));
    QImage sample(40, 24, QImage::Format_RGB32);
    sample.fill(Qt::green);
    QVERIFY(sample.save(photos.filePath("sample.jpg")));
    QFile secret(temp.filePath("secret.jpg"));
    QVERIFY(secret.open(QIODevice::WriteOnly));
    secret.write("not an image");
    secret.close();
    QFile nested(drive.filePath("Medical/report.txt")); QVERIFY(nested.open(QIODevice::WriteOnly)); nested.write("nested"); nested.close();
    QVERIFY(::symlink(temp.filePath("secret.jpg").toLocal8Bit().constData(), drive.filePath("outside.jpg").toLocal8Bit().constData()) == 0);
    const QVariantList disks{QVariantMap{{"id", "disk"}, {"identity", VerifiedCopy::liveStorageIdentity(disk.path())}, {"filesystemType", QStorageInfo(disk.path()).fileSystemType()}, {"label", "Test disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}};
    SetupModel model(temp.filePath("catalog.sqlite"), disks);
    model.setHomeRootForTest(temp.path());
    QVERIFY(model.ready());
    QVERIFY(model.saveRoute(temp.filePath("Photos"), "disk", destination.path(), "Everything", 0, true, 0, {}, "Photos"));
    QVERIFY(model.saveRoute(drive.path(), "disk", driveDestination.path(), "Everything", 0, true, 0, {}, "Drive"));
    {
        QSqlDatabase catalog = QSqlDatabase::addDatabase("QSQLITE", "localapi-recent-setup"); catalog.setDatabaseName(model.databasePath()); QVERIFY(catalog.open()); QSqlQuery insert(catalog);
        for (const QVariantList &item : {QVariantList{"Older/old.txt", 3, 1000, QString(64, QLatin1Char('1')), "Drive"}, QVariantList{"New/new.pdf", 7, 3000, QString(64, QLatin1Char('2')), "Drive"}, QVariantList{"2026/hidden.jpg", 9, 4000, QString(64, QLatin1Char('3')), "Photos"}}) {
            insert.prepare("INSERT INTO managed_inventory(route_id,relative_path,size_bytes,modified_ms,content_sha256,state) SELECT id,?,?,?,?, 'present' FROM routes WHERE content_type=?");
            for (const QVariant &value : item) insert.addBindValue(value); QVERIFY(insert.exec());
        }
        insert.finish(); catalog.close(); catalog = QSqlDatabase(); QSqlDatabase::removeDatabase("localapi-recent-setup");
    }

    LocalApi api(&model);
    QVERIFY(api.start(0));
    QVERIFY(api.isLoopbackBound());

    QNetworkAccessManager network;
    auto *reply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/state").arg(api.port()))));
    QSignalSpy finished(reply, &QNetworkReply::finished);
    QVERIFY(finished.wait(3000));
    QCOMPARE(reply->error(), QNetworkReply::NoError);
    const QByteArray state = reply->readAll();
    QVERIFY(state.contains("configRevision"));
    QVERIFY(state.contains("\"pendingFiles\":0"));
    QVERIFY(state.contains("storages"));
    reply->deleteLater();

    auto *refreshReply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/refresh-connections").arg(api.port()))));
    QSignalSpy refreshFinished(refreshReply, &QNetworkReply::finished); QVERIFY(refreshFinished.wait(3000));
    QCOMPARE(refreshReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202);
    QVERIFY(refreshReply->readAll().contains("checking")); refreshReply->deleteLater();

    auto *photosReply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/photos").arg(api.port()))));
    QSignalSpy photosFinished(photosReply, &QNetworkReply::finished);
    QVERIFY(photosFinished.wait(3000));
    QCOMPARE(photosReply->error(), QNetworkReply::NoError);
    const QByteArray photoList = photosReply->readAll();
    QVERIFY(photoList.contains("sample.jpg"));
    QVERIFY(photoList.contains("2026"));
    photosReply->deleteLater();

    QUrl nestedFilesUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/files").arg(api.port())); QUrlQuery nestedFilesQuery; nestedFilesQuery.addQueryItem("path", "Medical"); nestedFilesUrl.setQuery(nestedFilesQuery);
    auto *nestedFilesReply = network.get(QNetworkRequest(nestedFilesUrl)); QSignalSpy nestedFilesFinished(nestedFilesReply, &QNetworkReply::finished); QVERIFY(nestedFilesFinished.wait(3000));
    QCOMPARE(nestedFilesReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); const QJsonObject nestedFiles = QJsonDocument::fromJson(nestedFilesReply->readAll()).object(); QCOMPARE(nestedFiles.value("currentPath").toString(), QStringLiteral("Medical")); QCOMPARE(nestedFiles.value("items").toArray().first().toObject().value("name").toString(), QStringLiteral("report.txt")); nestedFilesReply->deleteLater();

    QUrl escapedFilesUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/files").arg(api.port())); QUrlQuery escapedFilesQuery; escapedFilesQuery.addQueryItem("path", "../"); escapedFilesUrl.setQuery(escapedFilesQuery);
    auto *escapedFilesReply = network.get(QNetworkRequest(escapedFilesUrl)); QSignalSpy escapedFilesFinished(escapedFilesReply, &QNetworkReply::finished); QVERIFY(escapedFilesFinished.wait(3000)); QCOMPARE(escapedFilesReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 404); escapedFilesReply->deleteLater();

    auto *recentReply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/recent-files").arg(api.port())))); QSignalSpy recentFinished(recentReply, &QNetworkReply::finished); QVERIFY(recentFinished.wait(3000)); QCOMPARE(recentReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200);
    const QJsonArray recentItems = QJsonDocument::fromJson(recentReply->readAll()).object().value("items").toArray(); QCOMPARE(recentItems.size(), 2); QCOMPARE(recentItems.at(0).toObject().value("path").toString(), QStringLiteral("New/new.pdf")); QCOMPARE(recentItems.at(1).toObject().value("path").toString(), QStringLiteral("Older/old.txt")); recentReply->deleteLater();

    QUrl thumbnailUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/photo-thumbnail").arg(api.port()));
    QUrlQuery thumbnailQuery;
    thumbnailQuery.addQueryItem("path", "2026/sample.jpg");
    thumbnailUrl.setQuery(thumbnailQuery);
    auto *thumbnailReply = network.get(QNetworkRequest(thumbnailUrl));
    QSignalSpy thumbnailFinished(thumbnailReply, &QNetworkReply::finished);
    QVERIFY(thumbnailFinished.wait(3000));
    QCOMPARE(thumbnailReply->error(), QNetworkReply::NoError);
    QCOMPARE(thumbnailReply->header(QNetworkRequest::ContentTypeHeader).toString(), QStringLiteral("image/jpeg"));
    QVERIFY(thumbnailReply->readAll().startsWith(QByteArray::fromHex("ffd8")));
    thumbnailReply->deleteLater();

    QUrl escapeUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/photo-thumbnail").arg(api.port()));
    QUrlQuery escapeQuery;
    escapeQuery.addQueryItem("path", "../secret.jpg");
    escapeUrl.setQuery(escapeQuery);
    auto *escapeReply = network.get(QNetworkRequest(escapeUrl));
    QSignalSpy escapeFinished(escapeReply, &QNetworkReply::finished);
    QVERIFY(escapeFinished.wait(3000));
    QCOMPARE(escapeReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 404);
    escapeReply->deleteLater();

    QDir imported(temp.filePath("Import"));
    QVERIFY(imported.mkpath("."));
    QVERIFY(QFile::copy(photos.filePath("sample.jpg"), imported.filePath("same-photo.jpg")));
    const QUrl previewUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/import-preview").arg(api.port()));
    const QByteArray previewBody = QJsonDocument(QJsonObject{{"source", imported.path()}, {"target", "Photos"}}).toJson(QJsonDocument::Compact);
    QNetworkRequest unauthorizedRequest(previewUrl);
    unauthorizedRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    auto *unauthorized = network.post(unauthorizedRequest, previewBody);
    QSignalSpy unauthorizedFinished(unauthorized, &QNetworkReply::finished);
    QVERIFY(unauthorizedFinished.wait(3000));
    QCOMPARE(unauthorized->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 403);
    unauthorized->deleteLater();

    auto *sessionReply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/session").arg(api.port()))));
    QSignalSpy sessionFinished(sessionReply, &QNetworkReply::finished);
    QVERIFY(sessionFinished.wait(3000));
    const QString token = QJsonDocument::fromJson(sessionReply->readAll()).object().value("token").toString();
    QVERIFY(!token.isEmpty());
    sessionReply->deleteLater();

    QDir phone(temp.filePath("phone")); QVERIFY(phone.mkpath("Drive"));
    model.setMtpDevicesForTest({QVariantMap{{"id", "test-phone"}, {"stableIdentity", "mtp:Test phone"}, {"label", "Test phone"}, {"kind", "mtp"}, {"transport", "mtp"}, {"present", true}, {"status", "Online"}, {"phoneRoot", QUrl::fromLocalFile(phone.path()).toString()}}});
    QNetworkRequest exportRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/export-to-phone").arg(api.port()))); exportRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); exportRequest.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    auto *exportReply = network.post(exportRequest, QJsonDocument(QJsonObject{{"root", "Drive"}, {"path", "Medical/report.txt"}}).toJson(QJsonDocument::Compact)); QSignalSpy exportFinished(exportReply, &QNetworkReply::finished); QVERIFY(exportFinished.wait(3000)); QCOMPARE(exportReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); exportReply->deleteLater();
    for (int attempt = 0; attempt < 100 && !QFileInfo::exists(phone.filePath("Drive/Medical/report.txt")); ++attempt) QTest::qWait(20);
    QFile exported(phone.filePath("Drive/Medical/report.txt")); QVERIFY(exported.open(QIODevice::ReadOnly)); QCOMPARE(exported.readAll(), QByteArrayLiteral("nested"));
    {
        QSqlDatabase catalog = QSqlDatabase::addDatabase("QSQLITE", "localapi-export-check"); catalog.setDatabaseName(model.databasePath()); QVERIFY(catalog.open()); QSqlQuery check(catalog);
        int receipts = 0; for (int attempt = 0; attempt < 100 && receipts == 0; ++attempt) { QVERIFY(check.exec("SELECT COUNT(*) FROM history WHERE event='verified'")); QVERIFY(check.next()); receipts = check.value(0).toInt(); check.finish(); if (!receipts) QTest::qWait(20); }
        QCOMPARE(receipts, 1); QVERIFY(check.exec("SELECT relative_path FROM locations WHERE storage_id LIKE 'mtp-storage-%'")); QVERIFY(check.next()); QCOMPARE(check.value(0).toString(), QStringLiteral("Drive/Medical/report.txt")); check.finish();
        QVERIFY(check.exec("SELECT selected_root FROM storage WHERE stable_identity LIKE 'mtp:%'")); QVERIFY(check.next()); QCOMPARE(check.value(0).toString(), phone.path());
        check.finish(); catalog.close(); catalog = QSqlDatabase(); QSqlDatabase::removeDatabase("localapi-export-check");
    }
    {
        QUrl activityUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/file-activity").arg(api.port())); QUrlQuery activityQuery; activityQuery.addQueryItem("root", "Drive"); activityQuery.addQueryItem("path", "Medical/report.txt"); activityUrl.setQuery(activityQuery);
        auto *activityReply = network.get(QNetworkRequest(activityUrl)); QSignalSpy activityFinished(activityReply, &QNetworkReply::finished); QVERIFY(activityFinished.wait(3000)); const QJsonArray activity = QJsonDocument::fromJson(activityReply->readAll()).object().value("items").toArray(); activityReply->deleteLater(); QCOMPARE(activity.size(), 1); QVERIFY(!activity.first().toObject().value("id").toString().isEmpty()); QCOMPARE(activity.first().toObject().value("event").toString(), QStringLiteral("verified"));
    }
    QNetworkRequest phoneImportRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/import-from-phone").arg(api.port()))); phoneImportRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); phoneImportRequest.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    QNetworkRequest unauthorizedPhoneImport(phoneImportRequest.url()); unauthorizedPhoneImport.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); auto *deniedPhoneImport = network.post(unauthorizedPhoneImport, QJsonDocument(QJsonObject{{"root", "Drive"}}).toJson(QJsonDocument::Compact)); QSignalSpy deniedPhoneImportFinished(deniedPhoneImport, &QNetworkReply::finished); QVERIFY(deniedPhoneImportFinished.wait(3000)); QCOMPARE(deniedPhoneImport->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 403); deniedPhoneImport->deleteLater();
    auto *phoneImport = network.post(phoneImportRequest, QJsonDocument(QJsonObject{{"root", "Drive"}}).toJson(QJsonDocument::Compact)); QSignalSpy phoneImportStarted(phoneImport, &QNetworkReply::finished); QVERIFY(phoneImportStarted.wait(3000)); QCOMPARE(phoneImport->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); const QJsonObject phoneImportStart = QJsonDocument::fromJson(phoneImport->readAll()).object(); const QString phoneImportId = phoneImportStart.value("id").toString(); QCOMPARE(phoneImportStart.value("destination").toString(), QStringLiteral("Test disk")); phoneImport->deleteLater(); QVERIFY(!phoneImportId.isEmpty());
    QJsonObject phoneImportResult; for (int attempt = 0; attempt < 200 && phoneImportResult.value("state") != "transferred" && phoneImportResult.value("state") != "failed"; ++attempt) { QTest::qWait(20); QUrl resultUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/route-preview").arg(api.port())); QUrlQuery resultQuery; resultQuery.addQueryItem("id", phoneImportId); resultUrl.setQuery(resultQuery); auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); phoneImportResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater(); }
    QVERIFY2(phoneImportResult.value("state") == "transferred", QJsonDocument(phoneImportResult).toJson(QJsonDocument::Compact).constData()); QFile importedFromPhone(driveDestination.filePath("Medical/report.txt")); QVERIFY(importedFromPhone.open(QIODevice::ReadOnly)); QCOMPARE(importedFromPhone.readAll(), QByteArrayLiteral("nested"));
    {
        QSqlDatabase catalog = QSqlDatabase::addDatabase("QSQLITE", "localapi-phone-import-check"); catalog.setDatabaseName(model.databasePath()); QVERIFY(catalog.open()); QSqlQuery check(catalog);
        QVERIFY(check.exec("SELECT s.stable_identity,r.source_root FROM routes r JOIN storage s ON s.id=r.source_storage_id WHERE r.id LIKE 'mtp-import-%'")); QVERIFY(check.next()); QVERIFY(check.value(0).toString().startsWith("mtp:")); QCOMPARE(QUrl(check.value(1).toString()).path(QUrl::FullyDecoded), QDir(phone.path()).filePath("Drive/")); QVERIFY(!check.next());
        check.finish(); catalog.close(); catalog = QSqlDatabase(); QSqlDatabase::removeDatabase("localapi-phone-import-check");
    }

    const QUrl createFolderUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/create-folder").arg(api.port())); QNetworkRequest createFolderRequest(createFolderUrl); createFolderRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); createFolderRequest.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    const QByteArray createFolderBody = QJsonDocument(QJsonObject{{"parent", "Medical"}, {"name", "Records"}}).toJson(QJsonDocument::Compact);
    QNetworkRequest unauthorizedFolderRequest(createFolderUrl); unauthorizedFolderRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); auto *unauthorizedFolder = network.post(unauthorizedFolderRequest, createFolderBody); QSignalSpy unauthorizedFolderFinished(unauthorizedFolder, &QNetworkReply::finished); QVERIFY(unauthorizedFolderFinished.wait(3000)); QCOMPARE(unauthorizedFolder->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 403); unauthorizedFolder->deleteLater();
    auto *createdFolder = network.post(createFolderRequest, createFolderBody); QSignalSpy createdFolderFinished(createdFolder, &QNetworkReply::finished); QVERIFY(createdFolderFinished.wait(3000)); QCOMPARE(createdFolder->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); QCOMPARE(QJsonDocument::fromJson(createdFolder->readAll()).object().value("path").toString(), QStringLiteral("Medical/Records")); QVERIFY(QFileInfo::exists(drive.filePath("Medical/Records"))); createdFolder->deleteLater();
    auto *duplicateFolder = network.post(createFolderRequest, createFolderBody); QSignalSpy duplicateFolderFinished(duplicateFolder, &QNetworkReply::finished); QVERIFY(duplicateFolderFinished.wait(3000)); QCOMPARE(duplicateFolder->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 409); duplicateFolder->deleteLater();
    for (const QJsonObject &unsafe : {QJsonObject{{"parent", "../"}, {"name", "escaped"}}, QJsonObject{{"parent", "Medical"}, {"name", "../escaped"}}}) { auto *unsafeFolder = network.post(createFolderRequest, QJsonDocument(unsafe).toJson(QJsonDocument::Compact)); QSignalSpy unsafeFolderFinished(unsafeFolder, &QNetworkReply::finished); QVERIFY(unsafeFolderFinished.wait(3000)); QCOMPARE(unsafeFolder->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 400); unsafeFolder->deleteLater(); }
    QVERIFY(!QFileInfo::exists(temp.filePath("escaped")));

    const QUrl openFileUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/open-file").arg(api.port())); QNetworkRequest openFileRequest(openFileUrl); openFileRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); openFileRequest.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    auto *openedFile = network.post(openFileRequest, QJsonDocument(QJsonObject{{"root", "Drive"}, {"path", "Medical/report.txt"}}).toJson(QJsonDocument::Compact)); QSignalSpy openedFileFinished(openedFile, &QNetworkReply::finished); QVERIFY(openedFileFinished.wait(3000)); QCOMPARE(openedFile->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); QVERIFY(QJsonDocument::fromJson(openedFile->readAll()).object().value("ok").toBool()); openedFile->deleteLater();
    auto *openedPhoto = network.post(openFileRequest, QJsonDocument(QJsonObject{{"root", "Photos"}, {"path", "2026/sample.jpg"}}).toJson(QJsonDocument::Compact)); QSignalSpy openedPhotoFinished(openedPhoto, &QNetworkReply::finished); QVERIFY(openedPhotoFinished.wait(3000)); QCOMPARE(openedPhoto->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); QCOMPARE(QJsonDocument::fromJson(openedPhoto->readAll()).object().value("root").toString(), QStringLiteral("Photos")); openedPhoto->deleteLater();
    for (const QString &unsafePath : {QStringLiteral("../secret.jpg"), QStringLiteral("outside.jpg")}) {
        auto *unsafeOpen = network.post(openFileRequest, QJsonDocument(QJsonObject{{"root", "Drive"}, {"path", unsafePath}}).toJson(QJsonDocument::Compact)); QSignalSpy unsafeOpenFinished(unsafeOpen, &QNetworkReply::finished); QVERIFY(unsafeOpenFinished.wait(3000)); QCOMPARE(unsafeOpen->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 404); unsafeOpen->deleteLater();
    }
    auto *wrongRootOpen = network.post(openFileRequest, QJsonDocument(QJsonObject{{"root", "Backup"}, {"path", "Medical/report.txt"}}).toJson(QJsonDocument::Compact)); QSignalSpy wrongRootOpenFinished(wrongRootOpen, &QNetworkReply::finished); QVERIFY(wrongRootOpenFinished.wait(3000)); QCOMPARE(wrongRootOpen->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 404); wrongRootOpen->deleteLater();

    QNetworkRequest authorizedRequest(previewUrl);
    authorizedRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    authorizedRequest.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    auto *authorized = network.post(authorizedRequest, previewBody);
    QSignalSpy authorizedFinished(authorized, &QNetworkReply::finished);
    QVERIFY(authorizedFinished.wait(3000));
    QCOMPARE(authorized->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202);
    const QString previewId = QJsonDocument::fromJson(authorized->readAll()).object().value("id").toString();
    QVERIFY(!previewId.isEmpty());
    authorized->deleteLater();

    QJsonObject previewResult;
    for (int attempt = 0; attempt < 50 && previewResult.value("state") != "complete"; ++attempt) {
        QUrl resultUrl(previewUrl);
        QUrlQuery resultQuery;
        resultQuery.addQueryItem("id", previewId);
        resultUrl.setQuery(resultQuery);
        auto *resultReply = network.get(QNetworkRequest(resultUrl));
        QSignalSpy resultFinished(resultReply, &QNetworkReply::finished);
        QVERIFY(resultFinished.wait(3000));
        previewResult = QJsonDocument::fromJson(resultReply->readAll()).object();
        resultReply->deleteLater();
        if (previewResult.value("state") != "complete") QTest::qWait(20);
    }
    QCOMPARE(previewResult.value("state").toString(), QStringLiteral("complete"));
    const QJsonObject preview = previewResult.value("preview").toObject();
    QVERIFY(preview.value("ok").toBool());
    QCOMPARE(preview.value("destinationDuplicates").toInt(), 1);
    QCOMPARE(preview.value("toCopy").toInt(), 0);

    const QUrl executeUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/import-execute").arg(api.port()));
    QNetworkRequest executeRequest(executeUrl); executeRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); executeRequest.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    auto *blockedImport = network.post(executeRequest, QJsonDocument(QJsonObject{{"id", previewId}}).toJson(QJsonDocument::Compact)); QSignalSpy blockedImportFinished(blockedImport, &QNetworkReply::finished); QVERIFY(blockedImportFinished.wait(3000));
    QCOMPARE(blockedImport->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 409); blockedImport->deleteLater();

    QDir cleanImport(temp.filePath("CleanImport")); QVERIFY(cleanImport.mkpath("."));
    QImage unique(31, 17, QImage::Format_RGB32); unique.fill(Qt::blue); QVERIFY(unique.save(cleanImport.filePath("new-photo.jpg")));
    const QByteArray cleanPreviewBody = QJsonDocument(QJsonObject{{"source", cleanImport.path()}, {"target", "Photos"}}).toJson(QJsonDocument::Compact);
    auto *cleanPreviewStart = network.post(authorizedRequest, cleanPreviewBody); QSignalSpy cleanPreviewStarted(cleanPreviewStart, &QNetworkReply::finished); QVERIFY(cleanPreviewStarted.wait(3000));
    QCOMPARE(cleanPreviewStart->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202);
    const QString cleanPreviewId = QJsonDocument::fromJson(cleanPreviewStart->readAll()).object().value("id").toString(); cleanPreviewStart->deleteLater(); QVERIFY(!cleanPreviewId.isEmpty());
    QJsonObject cleanPreviewResult;
    for (int attempt = 0; attempt < 100 && cleanPreviewResult.value("state") != "complete"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", cleanPreviewId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000));
        cleanPreviewResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (cleanPreviewResult.value("state") != "complete") QTest::qWait(20);
    }
    QVERIFY(cleanPreviewResult.value("preview").toObject().value("ok").toBool());
    QCOMPARE(cleanPreviewResult.value("preview").toObject().value("toCopy").toInt(), QFileInfo(cleanImport.filePath("new-photo.jpg")).size());
    auto *execute = network.post(executeRequest, QJsonDocument(QJsonObject{{"id", cleanPreviewId}}).toJson(QJsonDocument::Compact)); QSignalSpy executeStarted(execute, &QNetworkReply::finished); QVERIFY(executeStarted.wait(3000));
    QCOMPARE(execute->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); execute->deleteLater();
    QJsonObject importResult;
    for (int attempt = 0; attempt < 150 && importResult.value("state") != "imported" && importResult.value("state") != "failed" && importResult.value("state") != "attention"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", cleanPreviewId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000));
        importResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (importResult.value("state") == "copying") QTest::qWait(20);
    }
    QCOMPARE(importResult.value("state").toString(), QStringLiteral("imported"));
    QVERIFY(QFileInfo::exists(temp.filePath("Photos/new-photo.jpg"))); QVERIFY(QFileInfo::exists(cleanImport.filePath("new-photo.jpg")));
    {
        QSqlDatabase catalog = QSqlDatabase::addDatabase("QSQLITE", "localapi-import-check"); catalog.setDatabaseName(model.databasePath()); QVERIFY(catalog.open()); QSqlQuery query(catalog);
        QVERIFY(query.exec("SELECT COUNT(*) FROM history h JOIN jobs j ON j.id=h.job_id JOIN routes rt ON rt.id=j.route_id WHERE h.event='verified' AND rt.id LIKE 'import-photos-%' AND rt.content_type='Photos' AND rt.enabled=0")); QVERIFY(query.next()); QCOMPARE(query.value(0).toInt(), 1);
        query.finish(); catalog.close(); catalog = QSqlDatabase(); QSqlDatabase::removeDatabase("localapi-import-check");
    }
    QUrl activityUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/file-activity").arg(api.port())); QUrlQuery activityQuery; activityQuery.addQueryItem("root", "Photos"); activityQuery.addQueryItem("path", "new-photo.jpg"); activityUrl.setQuery(activityQuery);
    auto *activityReply = network.get(QNetworkRequest(activityUrl)); QSignalSpy activityFinished(activityReply, &QNetworkReply::finished); QVERIFY(activityFinished.wait(3000)); QCOMPARE(activityReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200);
    const QJsonObject activity = QJsonDocument::fromJson(activityReply->readAll()).object(); QCOMPARE(activity.value("path").toString(), QStringLiteral("new-photo.jpg")); QCOMPARE(activity.value("items").toArray().size(), 1); QCOMPARE(activity.value("items").toArray().first().toObject().value("event").toString(), QStringLiteral("verified")); activityReply->deleteLater();
    QUrl unsafeActivityUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/file-activity?root=Photos&path=../secret.jpg").arg(api.port())); auto *unsafeActivity = network.get(QNetworkRequest(unsafeActivityUrl)); QSignalSpy unsafeActivityFinished(unsafeActivity, &QNetworkReply::finished); QVERIFY(unsafeActivityFinished.wait(3000)); QCOMPARE(unsafeActivity->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 404); unsafeActivity->deleteLater();

    auto *problemsReply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/problems").arg(api.port()))));
    QSignalSpy problemsFinished(problemsReply, &QNetworkReply::finished);
    QVERIFY(problemsFinished.wait(3000));
    QCOMPARE(problemsReply->error(), QNetworkReply::NoError);
    const QJsonObject problems = QJsonDocument::fromJson(problemsReply->readAll()).object();
    QCOMPARE(problems.value("total").toInt(), 1);
    QCOMPARE(problems.value("counts").toObject().value("Duplicates").toInt(), 1);
    const QString duplicateId = problems.value("items").toArray().first().toObject().value("id").toString();
    QCOMPARE(problems.value("items").toArray().first().toObject().value("source").toString(), QStringLiteral("import"));
    problemsReply->deleteLater();

    const QUrl actionUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/problem-action").arg(api.port()));
    const QByteArray saveBody = QJsonDocument(QJsonObject{{"id", duplicateId}, {"action", "save"}}).toJson(QJsonDocument::Compact);
    QNetworkRequest unauthorizedAction(actionUrl); unauthorizedAction.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    auto *rejectedAction = network.post(unauthorizedAction, saveBody); QSignalSpy rejectedFinished(rejectedAction, &QNetworkReply::finished); QVERIFY(rejectedFinished.wait(3000));
    QCOMPARE(rejectedAction->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 403); rejectedAction->deleteLater();

    QNetworkRequest actionRequest(actionUrl); actionRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); actionRequest.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    auto *savedAction = network.post(actionRequest, saveBody); QSignalSpy savedFinished(savedAction, &QNetworkReply::finished); QVERIFY(savedFinished.wait(3000));
    QCOMPARE(savedAction->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); QVERIFY(QJsonDocument::fromJson(savedAction->readAll()).object().value("ok").toBool()); savedAction->deleteLater();

    auto *savedProblemsReply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/problems").arg(api.port())))); QSignalSpy savedProblemsFinished(savedProblemsReply, &QNetworkReply::finished); QVERIFY(savedProblemsFinished.wait(3000));
    const QJsonObject savedProblems = QJsonDocument::fromJson(savedProblemsReply->readAll()).object();
    QCOMPARE(savedProblems.value("items").toArray().first().toObject().value("state").toString(), QStringLiteral("saved"));
    QCOMPARE(savedProblems.value("history").toArray().first().toObject().value("action").toString(), QStringLiteral("save")); savedProblemsReply->deleteLater();

    const QByteArray unsafeDismissBody = QJsonDocument(QJsonObject{{"id", duplicateId}, {"action", "dismiss"}}).toJson(QJsonDocument::Compact);
    auto *unsafeDismiss = network.post(actionRequest, unsafeDismissBody); QSignalSpy unsafeDismissFinished(unsafeDismiss, &QNetworkReply::finished); QVERIFY(unsafeDismissFinished.wait(3000));
    QCOMPARE(unsafeDismiss->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 409); unsafeDismiss->deleteLater();

    const QByteArray acceptExistingBody = QJsonDocument(QJsonObject{{"id", duplicateId}, {"action", "accept_existing"}}).toJson(QJsonDocument::Compact);
    auto *acceptedExisting = network.post(actionRequest, acceptExistingBody); QSignalSpy acceptedExistingFinished(acceptedExisting, &QNetworkReply::finished); QVERIFY(acceptedExistingFinished.wait(3000));
    QCOMPARE(acceptedExisting->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); acceptedExisting->deleteLater();
    auto *acceptedPreviewStart = network.post(authorizedRequest, previewBody); QSignalSpy acceptedPreviewStarted(acceptedPreviewStart, &QNetworkReply::finished); QVERIFY(acceptedPreviewStarted.wait(3000));
    const QString acceptedPreviewId = QJsonDocument::fromJson(acceptedPreviewStart->readAll()).object().value("id").toString(); acceptedPreviewStart->deleteLater(); QVERIFY(!acceptedPreviewId.isEmpty());
    QJsonObject acceptedPreviewResult;
    for (int attempt = 0; attempt < 100 && acceptedPreviewResult.value("state") != "complete"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", acceptedPreviewId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); acceptedPreviewResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (acceptedPreviewResult.value("state") != "complete") QTest::qWait(20);
    }
    QVERIFY(acceptedPreviewResult.value("preview").toObject().value("duplicatesAccepted").toBool());
    auto *duplicateImport = network.post(executeRequest, QJsonDocument(QJsonObject{{"id", acceptedPreviewId}}).toJson(QJsonDocument::Compact)); QSignalSpy duplicateImportStarted(duplicateImport, &QNetworkReply::finished); QVERIFY(duplicateImportStarted.wait(3000));
    QCOMPARE(duplicateImport->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); duplicateImport->deleteLater();
    QJsonObject duplicateImportResult;
    for (int attempt = 0; attempt < 150 && duplicateImportResult.value("state") != "imported" && duplicateImportResult.value("state") != "failed"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", acceptedPreviewId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000));
        duplicateImportResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (duplicateImportResult.value("state") == "copying") QTest::qWait(20);
    }
    QCOMPARE(duplicateImportResult.value("state").toString(), QStringLiteral("imported"));
    QVERIFY(!QFileInfo::exists(temp.filePath("Photos/same-photo.jpg"))); QVERIFY(QFileInfo::exists(imported.filePath("same-photo.jpg")));

    QDir conflictImport(temp.filePath("ConflictImport")); QVERIFY(conflictImport.mkpath("."));
    QFile existingConflict(temp.filePath("Photos/conflict.txt")); QVERIFY(existingConflict.open(QIODevice::WriteOnly)); existingConflict.write("existing"); existingConflict.close();
    QFile incomingConflict(conflictImport.filePath("conflict.txt")); QVERIFY(incomingConflict.open(QIODevice::WriteOnly)); incomingConflict.write("incoming"); incomingConflict.close();
    const QByteArray conflictPreviewBody = QJsonDocument(QJsonObject{{"source", conflictImport.path()}, {"target", "Photos"}}).toJson(QJsonDocument::Compact);
    auto *conflictPreviewStart = network.post(authorizedRequest, conflictPreviewBody); QSignalSpy conflictPreviewStarted(conflictPreviewStart, &QNetworkReply::finished); QVERIFY(conflictPreviewStarted.wait(3000));
    const QString conflictPreviewId = QJsonDocument::fromJson(conflictPreviewStart->readAll()).object().value("id").toString(); conflictPreviewStart->deleteLater(); QVERIFY(!conflictPreviewId.isEmpty());
    QJsonObject conflictPreviewResult;
    for (int attempt = 0; attempt < 100 && conflictPreviewResult.value("state") != "complete"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", conflictPreviewId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); conflictPreviewResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (conflictPreviewResult.value("state") != "complete") QTest::qWait(20);
    }
    QCOMPARE(conflictPreviewResult.value("preview").toObject().value("conflicts").toInt(), 1);
    auto *conflictProblemsReply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/problems").arg(api.port())))); QSignalSpy conflictProblemsFinished(conflictProblemsReply, &QNetworkReply::finished); QVERIFY(conflictProblemsFinished.wait(3000));
    const QJsonArray conflictProblems = QJsonDocument::fromJson(conflictProblemsReply->readAll()).object().value("items").toArray(); conflictProblemsReply->deleteLater();
    QString conflictId;
    for (const QJsonValue &value : conflictProblems) { const QJsonObject item = value.toObject(); if (item.value("category").toString() == "Conflicts" && item.value("details").toObject().value("source").toString() == conflictImport.path()) conflictId = item.value("id").toString(); }
    QVERIFY(!conflictId.isEmpty());
    auto *keepBoth = network.post(actionRequest, QJsonDocument(QJsonObject{{"id", conflictId}, {"action", "keep_both"}}).toJson(QJsonDocument::Compact)); QSignalSpy keepBothFinished(keepBoth, &QNetworkReply::finished); QVERIFY(keepBothFinished.wait(3000)); QCOMPARE(keepBoth->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); keepBoth->deleteLater();
    auto *acceptedConflictStart = network.post(authorizedRequest, conflictPreviewBody); QSignalSpy acceptedConflictStarted(acceptedConflictStart, &QNetworkReply::finished); QVERIFY(acceptedConflictStarted.wait(3000));
    const QString acceptedConflictId = QJsonDocument::fromJson(acceptedConflictStart->readAll()).object().value("id").toString(); acceptedConflictStart->deleteLater();
    QJsonObject acceptedConflictResult;
    for (int attempt = 0; attempt < 100 && acceptedConflictResult.value("state") != "complete"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", acceptedConflictId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); acceptedConflictResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (acceptedConflictResult.value("state") != "complete") QTest::qWait(20);
    }
    QVERIFY(acceptedConflictResult.value("preview").toObject().value("conflictsAccepted").toBool());
    QVERIFY(existingConflict.open(QIODevice::WriteOnly | QIODevice::Truncate)); existingConflict.write("changed existing"); existingConflict.close();
    auto *staleConflictExecute = network.post(executeRequest, QJsonDocument(QJsonObject{{"id", acceptedConflictId}}).toJson(QJsonDocument::Compact)); QSignalSpy staleConflictStarted(staleConflictExecute, &QNetworkReply::finished); QVERIFY(staleConflictStarted.wait(3000)); QCOMPARE(staleConflictExecute->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); staleConflictExecute->deleteLater();
    QJsonObject staleConflictResult;
    for (int attempt = 0; attempt < 150 && staleConflictResult.value("state") != "failed"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", acceptedConflictId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); staleConflictResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (staleConflictResult.value("state") == "copying") QTest::qWait(20);
    }
    QCOMPARE(staleConflictResult.value("state").toString(), QStringLiteral("failed")); QVERIFY(staleConflictResult.value("result").toString().contains("evidence changed")); QVERIFY(!QFileInfo::exists(temp.filePath("Photos/conflict (imported).txt")));
    QVERIFY(existingConflict.open(QIODevice::WriteOnly | QIODevice::Truncate)); existingConflict.write("existing"); existingConflict.close();
    auto *recheckedConflictStart = network.post(authorizedRequest, conflictPreviewBody); QSignalSpy recheckedConflictStarted(recheckedConflictStart, &QNetworkReply::finished); QVERIFY(recheckedConflictStarted.wait(3000));
    const QString recheckedConflictId = QJsonDocument::fromJson(recheckedConflictStart->readAll()).object().value("id").toString(); recheckedConflictStart->deleteLater();
    QJsonObject recheckedConflictResult;
    for (int attempt = 0; attempt < 100 && recheckedConflictResult.value("state") != "complete"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", recheckedConflictId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); recheckedConflictResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (recheckedConflictResult.value("state") != "complete") QTest::qWait(20);
    }
    QVERIFY(recheckedConflictResult.value("preview").toObject().value("conflictsAccepted").toBool());
    auto *conflictExecute = network.post(executeRequest, QJsonDocument(QJsonObject{{"id", recheckedConflictId}}).toJson(QJsonDocument::Compact)); QSignalSpy conflictExecuteStarted(conflictExecute, &QNetworkReply::finished); QVERIFY(conflictExecuteStarted.wait(3000)); QCOMPARE(conflictExecute->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); conflictExecute->deleteLater();
    QJsonObject conflictImportResult;
    for (int attempt = 0; attempt < 150 && conflictImportResult.value("state") != "imported" && conflictImportResult.value("state") != "failed"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", recheckedConflictId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); conflictImportResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (conflictImportResult.value("state") == "copying") QTest::qWait(20);
    }
    QCOMPARE(conflictImportResult.value("state").toString(), QStringLiteral("imported"));
    QVERIFY(existingConflict.open(QIODevice::ReadOnly)); QCOMPARE(existingConflict.readAll(), QByteArray("existing")); existingConflict.close();
    QFile importedConflict(temp.filePath("Photos/conflict (imported).txt")); QVERIFY(importedConflict.open(QIODevice::ReadOnly)); QCOMPARE(importedConflict.readAll(), QByteArray("incoming")); importedConflict.close(); QVERIFY(QFileInfo::exists(conflictImport.filePath("conflict.txt")));

    QDir changedImport(temp.filePath("ChangedImport")); QVERIFY(changedImport.mkpath("."));
    QFile existingEvidence(temp.filePath("Photos/evidence-existing.txt")); QVERIFY(existingEvidence.open(QIODevice::WriteOnly)); existingEvidence.write("same evidence"); existingEvidence.close();
    QFile candidateEvidence(changedImport.filePath("candidate.txt")); QVERIFY(candidateEvidence.open(QIODevice::WriteOnly)); candidateEvidence.write("same evidence"); candidateEvidence.close();
    const QByteArray changedPreviewBody = QJsonDocument(QJsonObject{{"source", changedImport.path()}, {"target", "Photos"}}).toJson(QJsonDocument::Compact);
    auto *changedPreviewStart = network.post(authorizedRequest, changedPreviewBody); QSignalSpy changedPreviewStarted(changedPreviewStart, &QNetworkReply::finished); QVERIFY(changedPreviewStarted.wait(3000));
    const QString changedPreviewId = QJsonDocument::fromJson(changedPreviewStart->readAll()).object().value("id").toString(); changedPreviewStart->deleteLater(); QVERIFY(!changedPreviewId.isEmpty());
    QJsonObject changedPreviewResult;
    for (int attempt = 0; attempt < 100 && changedPreviewResult.value("state") != "complete"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", changedPreviewId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); changedPreviewResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (changedPreviewResult.value("state") != "complete") QTest::qWait(20);
    }
    QCOMPARE(changedPreviewResult.value("preview").toObject().value("destinationDuplicates").toInt(), 1);
    auto *changedProblemsReply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/problems").arg(api.port())))); QSignalSpy changedProblemsFinished(changedProblemsReply, &QNetworkReply::finished); QVERIFY(changedProblemsFinished.wait(3000));
    const QJsonArray changedProblems = QJsonDocument::fromJson(changedProblemsReply->readAll()).object().value("items").toArray(); changedProblemsReply->deleteLater();
    QString changedDuplicateId;
    for (const QJsonValue &value : changedProblems) { const QJsonObject item = value.toObject(); if (item.value("category").toString() == "Duplicates" && item.value("details").toObject().value("source").toString() == changedImport.path()) changedDuplicateId = item.value("id").toString(); }
    QVERIFY(!changedDuplicateId.isEmpty());
    auto *acceptChanged = network.post(actionRequest, QJsonDocument(QJsonObject{{"id", changedDuplicateId}, {"action", "accept_existing"}}).toJson(QJsonDocument::Compact)); QSignalSpy acceptChangedFinished(acceptChanged, &QNetworkReply::finished); QVERIFY(acceptChangedFinished.wait(3000)); QCOMPARE(acceptChanged->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); acceptChanged->deleteLater();
    QVERIFY(candidateEvidence.open(QIODevice::WriteOnly | QIODevice::Truncate)); candidateEvidence.write("changed evidence"); candidateEvidence.close();
    auto *changedExecution = network.post(executeRequest, QJsonDocument(QJsonObject{{"id", changedPreviewId}}).toJson(QJsonDocument::Compact)); QSignalSpy changedExecutionStarted(changedExecution, &QNetworkReply::finished); QVERIFY(changedExecutionStarted.wait(3000)); QCOMPARE(changedExecution->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); changedExecution->deleteLater();
    QJsonObject changedExecutionResult;
    for (int attempt = 0; attempt < 150 && changedExecutionResult.value("state") != "failed"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", changedPreviewId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); changedExecutionResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (changedExecutionResult.value("state") == "copying") QTest::qWait(20);
    }
    QCOMPARE(changedExecutionResult.value("state").toString(), QStringLiteral("failed")); QVERIFY(changedExecutionResult.value("result").toString().contains("evidence changed")); QVERIFY(!QFileInfo::exists(temp.filePath("Photos/candidate.txt")));

    QDir unsupportedImport(temp.filePath("UnsupportedImport")); QVERIFY(unsupportedImport.mkpath("."));
    QFile regularUnsupported(unsupportedImport.filePath("regular.txt")); QVERIFY(regularUnsupported.open(QIODevice::WriteOnly)); regularUnsupported.write("regular bytes"); regularUnsupported.close();
    QVERIFY(::symlink("regular.txt", unsupportedImport.filePath("latest-link.txt").toLocal8Bit().constData()) == 0);
    const QByteArray unsupportedPreviewBody = QJsonDocument(QJsonObject{{"source", unsupportedImport.path()}, {"target", "Photos"}}).toJson(QJsonDocument::Compact);
    auto *unsupportedPreviewStart = network.post(authorizedRequest, unsupportedPreviewBody); QSignalSpy unsupportedPreviewStarted(unsupportedPreviewStart, &QNetworkReply::finished); QVERIFY(unsupportedPreviewStarted.wait(3000));
    const QString unsupportedPreviewId = QJsonDocument::fromJson(unsupportedPreviewStart->readAll()).object().value("id").toString(); unsupportedPreviewStart->deleteLater();
    QJsonObject unsupportedPreviewResult;
    for (int attempt = 0; attempt < 100 && unsupportedPreviewResult.value("state") != "complete"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", unsupportedPreviewId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); unsupportedPreviewResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (unsupportedPreviewResult.value("state") != "complete") QTest::qWait(20);
    }
    const QJsonObject unsupportedPlan = unsupportedPreviewResult.value("preview").toObject(); QCOMPARE(unsupportedPlan.value("unsupported").toInt(), 1); QCOMPARE(unsupportedPlan.value("unsupportedPaths").toArray().first().toString(), QStringLiteral("latest-link.txt"));
    auto *blockedUnsupported = network.post(executeRequest, QJsonDocument(QJsonObject{{"id", unsupportedPreviewId}}).toJson(QJsonDocument::Compact)); QSignalSpy blockedUnsupportedFinished(blockedUnsupported, &QNetworkReply::finished); QVERIFY(blockedUnsupportedFinished.wait(3000)); QCOMPARE(blockedUnsupported->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 409); blockedUnsupported->deleteLater();
    auto *unsupportedProblemsReply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/problems").arg(api.port())))); QSignalSpy unsupportedProblemsFinished(unsupportedProblemsReply, &QNetworkReply::finished); QVERIFY(unsupportedProblemsFinished.wait(3000));
    const QJsonArray unsupportedProblems = QJsonDocument::fromJson(unsupportedProblemsReply->readAll()).object().value("items").toArray(); unsupportedProblemsReply->deleteLater();
    QString unsupportedId;
    for (const QJsonValue &value : unsupportedProblems) { const QJsonObject item = value.toObject(); if (item.value("category").toString() == "Unsupported" && item.value("details").toObject().value("source").toString() == unsupportedImport.path()) unsupportedId = item.value("id").toString(); }
    QVERIFY(!unsupportedId.isEmpty());
    auto *skipUnsupported = network.post(actionRequest, QJsonDocument(QJsonObject{{"id", unsupportedId}, {"action", "skip_unsupported"}}).toJson(QJsonDocument::Compact)); QSignalSpy skipUnsupportedFinished(skipUnsupported, &QNetworkReply::finished); QVERIFY(skipUnsupportedFinished.wait(3000)); QCOMPARE(skipUnsupported->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); skipUnsupported->deleteLater();
    auto *acceptedUnsupportedStart = network.post(authorizedRequest, unsupportedPreviewBody); QSignalSpy acceptedUnsupportedStarted(acceptedUnsupportedStart, &QNetworkReply::finished); QVERIFY(acceptedUnsupportedStarted.wait(3000));
    const QString acceptedUnsupportedId = QJsonDocument::fromJson(acceptedUnsupportedStart->readAll()).object().value("id").toString(); acceptedUnsupportedStart->deleteLater();
    QJsonObject acceptedUnsupportedResult;
    for (int attempt = 0; attempt < 100 && acceptedUnsupportedResult.value("state") != "complete"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", acceptedUnsupportedId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); acceptedUnsupportedResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (acceptedUnsupportedResult.value("state") != "complete") QTest::qWait(20);
    }
    QVERIFY(acceptedUnsupportedResult.value("preview").toObject().value("unsupportedAccepted").toBool());
    auto *unsupportedExecute = network.post(executeRequest, QJsonDocument(QJsonObject{{"id", acceptedUnsupportedId}}).toJson(QJsonDocument::Compact)); QSignalSpy unsupportedExecuteStarted(unsupportedExecute, &QNetworkReply::finished); QVERIFY(unsupportedExecuteStarted.wait(3000)); QCOMPARE(unsupportedExecute->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); unsupportedExecute->deleteLater();
    QJsonObject unsupportedImportResult;
    for (int attempt = 0; attempt < 150 && unsupportedImportResult.value("state") != "imported" && unsupportedImportResult.value("state") != "failed"; ++attempt) {
        QUrl resultUrl(previewUrl); QUrlQuery query; query.addQueryItem("id", acceptedUnsupportedId); resultUrl.setQuery(query);
        auto *resultReply = network.get(QNetworkRequest(resultUrl)); QSignalSpy resultFinished(resultReply, &QNetworkReply::finished); QVERIFY(resultFinished.wait(3000)); unsupportedImportResult = QJsonDocument::fromJson(resultReply->readAll()).object(); resultReply->deleteLater();
        if (unsupportedImportResult.value("state") == "copying") QTest::qWait(20);
    }
    QCOMPARE(unsupportedImportResult.value("state").toString(), QStringLiteral("imported")); QVERIFY(QFileInfo::exists(temp.filePath("Photos/regular.txt"))); QVERIFY(QFileInfo(unsupportedImport.filePath("latest-link.txt")).isSymLink()); QVERIFY(!QFileInfo::exists(temp.filePath("Photos/latest-link.txt")));

    {
        QSqlDatabase catalog = QSqlDatabase::addDatabase("QSQLITE", "localapi-clean-review"); catalog.setDatabaseName(model.databasePath()); QVERIFY(catalog.open()); QSqlQuery insert(catalog);
        insert.prepare("INSERT INTO review_items(id,category,source_kind,source_id,title,summary,details_json,item_count,state) VALUES('clean-observation','External changes','metadata','clean-1','External file indexed','Safe observation',?,1,'saved')");
        insert.addBindValue(QStringLiteral("{\"added\":1,\"changed\":0,\"missing\":0}")); QVERIFY(insert.exec()); insert.finish(); catalog.close(); catalog = QSqlDatabase(); QSqlDatabase::removeDatabase("localapi-clean-review");
    }
    const QByteArray dismissBody = QJsonDocument(QJsonObject{{"id", "clean-observation"}, {"action", "dismiss"}}).toJson(QJsonDocument::Compact);
    auto *dismissed = network.post(actionRequest, dismissBody); QSignalSpy dismissedFinished(dismissed, &QNetworkReply::finished); QVERIFY(dismissedFinished.wait(3000));
    QCOMPARE(dismissed->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); dismissed->deleteLater();

    {
        QSqlDatabase catalog = QSqlDatabase::addDatabase("QSQLITE", "localapi-recheck-setup"); catalog.setDatabaseName(model.databasePath()); QVERIFY(catalog.open()); QSqlQuery insert(catalog);
        QVERIFY(insert.exec("INSERT INTO devices(id,stable_id,name,kind) VALUES('phone-recheck','wireless:test-phone','Test phone','Phone')"));
        insert.prepare("INSERT INTO review_items(id,category,source_kind,source_id,title,summary,details_json,item_count) VALUES('phone-change','External changes','metadata','phone-change-1','Phone item changed','Recheck source evidence',?,1)");
        insert.addBindValue(QStringLiteral("{\"deviceStableId\":\"wireless:test-phone\",\"root\":\"DCIM\",\"path\":\"Camera/a.jpg\",\"expectedSize\":5,\"expectedSha256\":\"%1\"}").arg(QString(64, QLatin1Char('a')))); QVERIFY(insert.exec());
        insert.finish(); catalog.close(); catalog = QSqlDatabase(); QSqlDatabase::removeDatabase("localapi-recheck-setup");
    }
    const QByteArray recheckBody = QJsonDocument(QJsonObject{{"id", "phone-change"}, {"action", "recheck_location"}}).toJson(QJsonDocument::Compact);
    for (int attempt = 0; attempt < 2; ++attempt) {
        auto *recheck = network.post(actionRequest, recheckBody); QSignalSpy recheckFinished(recheck, &QNetworkReply::finished); QVERIFY(recheckFinished.wait(3000));
        QCOMPARE(recheck->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); QVERIFY(!QJsonDocument::fromJson(recheck->readAll()).object().value("correctionId").toString().isEmpty()); recheck->deleteLater();
    }
    {
        QSqlDatabase catalog = QSqlDatabase::addDatabase("QSQLITE", "localapi-recheck-check"); catalog.setDatabaseName(model.databasePath()); QVERIFY(catalog.open()); QSqlQuery check(catalog);
        QVERIFY(check.exec("SELECT COUNT(*),MIN(ri.state) FROM device_corrections c JOIN review_items ri ON ri.id=c.review_item_id WHERE c.review_item_id='phone-change'")); QVERIFY(check.next()); QCOMPARE(check.value(0).toInt(), 1); QCOMPARE(check.value(1).toString(), QStringLiteral("needs_device"));
        check.finish(); catalog.close(); catalog = QSqlDatabase(); QSqlDatabase::removeDatabase("localapi-recheck-check");
    }
    auto *recheckProblemsReply = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/problems").arg(api.port())))); QSignalSpy recheckProblemsFinished(recheckProblemsReply, &QNetworkReply::finished); QVERIFY(recheckProblemsFinished.wait(3000));
    const QJsonArray recheckProblems = QJsonDocument::fromJson(recheckProblemsReply->readAll()).object().value("items").toArray(); recheckProblemsReply->deleteLater();
    bool pendingShown = false; for (const QJsonValue &value : recheckProblems) { const QJsonObject item = value.toObject(); if (item.value("id") == "phone-change") pendingShown = item.value("details").toObject().value("correctionStatus") == "pending"; } QVERIFY(pendingShown);

    QNetworkRequest request(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/state").arg(api.port())));
    request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    auto *post = network.post(request, QByteArrayLiteral("{}"));
    QSignalSpy postFinished(post, &QNetworkReply::finished);
    QVERIFY(postFinished.wait(3000));
    QCOMPARE(post->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 405);
    post->deleteLater();
}

void LocalApiTest::stagingCapRejectsPhoneImportBeforeCopy() {
    QTemporaryDir temp; QVERIFY(temp.isValid());
    QDir drive(temp.filePath("Drive")), offline(temp.filePath("offline")), staging(temp.filePath("staging")), phone(temp.filePath("phone")); QVERIFY(drive.mkpath(".")); QVERIFY(offline.mkpath("Drive")); QVERIFY(staging.mkpath(".")); QVERIFY(phone.mkpath("Drive"));
    QFile source(phone.filePath("Drive/five.bin")); QVERIFY(source.open(QIODevice::WriteOnly)); QCOMPARE(source.write("12345"), 5); source.close();
    SetupModel model(temp.filePath("catalog.sqlite"), {QVariantMap{{"id", "offline"}, {"identity", "storage:offline"}, {"label", "Offline disk"}, {"root", offline.path()}, {"present", false}, {"kind", "removable"}}}); QVERIFY(model.ready());
    QVERIFY(model.saveRoute(drive.path(), "offline", offline.filePath("Drive"), "Everything", 0, false, 4, staging.path(), "Drive"));
    model.setMtpDevicesForTest({QVariantMap{{"id", "test-phone"}, {"stableIdentity", "mtp:Test phone"}, {"label", "Test phone"}, {"kind", "mtp"}, {"transport", "mtp"}, {"present", true}, {"status", "Online"}, {"phoneRoot", QUrl::fromLocalFile(phone.path()).toString()}}});
    LocalApi api(&model); QVERIFY(api.start(0)); QNetworkAccessManager network;
    auto *session = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/session").arg(api.port())))); QSignalSpy sessionFinished(session, &QNetworkReply::finished); QVERIFY(sessionFinished.wait(3000)); const QString token = QJsonDocument::fromJson(session->readAll()).object().value("token").toString(); session->deleteLater();
    QNetworkRequest request(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/import-from-phone").arg(api.port()))); request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); request.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    auto *started = network.post(request, QJsonDocument(QJsonObject{{"root", "Drive"}}).toJson(QJsonDocument::Compact)); QSignalSpy startedFinished(started, &QNetworkReply::finished); QVERIFY(startedFinished.wait(3000)); QCOMPARE(started->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); const QJsonObject start = QJsonDocument::fromJson(started->readAll()).object(); const QString id = start.value("id").toString(); QCOMPARE(start.value("destination").toString(), QStringLiteral("Laptop staging")); started->deleteLater();
    QJsonObject operation; for (int attempt = 0; attempt < 200 && operation.value("state") != "failed"; ++attempt) { QTest::qWait(20); QUrl url(QStringLiteral("http://127.0.0.1:%1/api/v1/route-preview").arg(api.port())); QUrlQuery query; query.addQueryItem("id", id); url.setQuery(query); auto *reply = network.get(QNetworkRequest(url)); QSignalSpy finished(reply, &QNetworkReply::finished); QVERIFY(finished.wait(3000)); operation = QJsonDocument::fromJson(reply->readAll()).object(); reply->deleteLater(); }
    QCOMPARE(operation.value("state").toString(), QStringLiteral("failed")); QVERIFY(operation.value("result").toString().contains("Staging capacity")); QVERIFY(QFileInfo::exists(phone.filePath("Drive/five.bin"))); QVERIFY(!QFileInfo::exists(staging.filePath("Drive/five.bin")));
}

void LocalApiTest::deviceOnboardingPersistsParticipationChoice() {
    QTemporaryDir temp; QVERIFY(temp.isValid()); QDir disk(temp.filePath("disk")); QVERIFY(disk.mkpath("."));
    SetupModel model(temp.filePath("catalog.sqlite"), {QVariantMap{{"id", "new-disk"}, {"identity", VerifiedCopy::liveStorageIdentity(disk.path())}, {"label", "New disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}}); QVERIFY(model.ready());
    QCOMPARE(model.firstSeenDevices().size(), 1);
    LocalApi api(&model); QVERIFY(api.start(0)); QNetworkAccessManager network;
    auto *session = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/session").arg(api.port())))); QSignalSpy sessionDone(session, &QNetworkReply::finished); QVERIFY(sessionDone.wait(3000)); const QString token = QJsonDocument::fromJson(session->readAll()).object().value("token").toString(); session->deleteLater();
    const QUrl url(QStringLiteral("http://127.0.0.1:%1/api/v1/device-onboarding").arg(api.port())); QNetworkRequest request(url); request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); request.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    auto decide = [&](bool participate) { auto *reply = network.post(request, QJsonDocument(QJsonObject{{"id", "new-disk"}, {"participate", participate}}).toJson(QJsonDocument::Compact)); QSignalSpy done(reply, &QNetworkReply::finished); if (!done.wait(3000)) return false; const bool ok = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() == 200; reply->deleteLater(); return ok; };
    QVERIFY(decide(true)); QVERIFY(model.firstSeenDevices().isEmpty()); QVERIFY(model.hiddenDevices().isEmpty());
    QVERIFY(decide(false)); QCOMPARE(model.hiddenDevices().size(), 1); QVERIFY(model.storages().size() == 1);
    QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "onboarding-check"); db.setDatabaseName(model.databasePath()); QVERIFY(db.open()); QSqlQuery query(db); QVERIFY(query.exec("SELECT onboarding_seen,hidden FROM storage WHERE id='new-disk'")); QVERIFY(query.next()); QCOMPARE(query.value(0).toInt(), 1); QCOMPARE(query.value(1).toInt(), 1); query.finish(); db.close(); db = {}; QSqlDatabase::removeDatabase("onboarding-check");
}

void LocalApiTest::savesOnlyMissingValidatedRoute() {
    QTemporaryDir temp; QVERIFY(temp.isValid());
    QDir drive(temp.filePath("Drive")), photos(temp.filePath("Photos")), disk(temp.filePath("disk")), driveDestination(temp.filePath("disk/Drive")), photosDestination(temp.filePath("disk/Photos"));
    QVERIFY(drive.mkpath(".")); QVERIFY(photos.mkpath(".")); QVERIFY(driveDestination.mkpath(".")); QVERIFY(photosDestination.mkpath("."));
    SetupModel model(temp.filePath("catalog.sqlite"), QVariantList{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}});
    QVERIFY(model.ready()); QVERIFY(model.saveRoute(drive.path(), "disk", driveDestination.path(), "Everything", 0, false, 0, {}, "Drive"));
    LocalApi api(&model); QVERIFY(api.start(0)); QNetworkAccessManager network;
    auto *session = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/session").arg(api.port())))); QSignalSpy sessionFinished(session, &QNetworkReply::finished); QVERIFY(sessionFinished.wait(3000)); const QString token = QJsonDocument::fromJson(session->readAll()).object().value("token").toString(); session->deleteLater(); QVERIFY(!token.isEmpty());
    const QUrl url(QStringLiteral("http://127.0.0.1:%1/api/v1/save-route").arg(api.port())); QNetworkRequest request(url); request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); request.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    QJsonObject options{{"contentType", "Photos"}, {"source", photos.path()}, {"storageId", "disk"}, {"destination", temp.filePath("outside")}, {"keepPolicy", "Everything"}, {"organizePhotos", true}};
    auto *invalid = network.post(request, QJsonDocument(options).toJson(QJsonDocument::Compact)); QSignalSpy invalidFinished(invalid, &QNetworkReply::finished); QVERIFY(invalidFinished.wait(3000)); QCOMPARE(invalid->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 400); invalid->deleteLater(); QCOMPARE(model.routes().size(), 1);
    options["destination"] = photosDestination.path(); auto *saved = network.post(request, QJsonDocument(options).toJson(QJsonDocument::Compact)); QSignalSpy savedFinished(saved, &QNetworkReply::finished); QVERIFY(savedFinished.wait(3000)); QCOMPARE(saved->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); QCOMPARE(QJsonDocument::fromJson(saved->readAll()).object().value("configRevision").toInt(), 2); saved->deleteLater(); QCOMPARE(model.routes().size(), 2); QVERIFY(model.routes().last().toMap().value("organizePhotos").toBool());
    auto *duplicate = network.post(request, QJsonDocument(options).toJson(QJsonDocument::Compact)); QSignalSpy duplicateFinished(duplicate, &QNetworkReply::finished); QVERIFY(duplicateFinished.wait(3000)); QCOMPARE(duplicate->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 409); duplicate->deleteLater(); QCOMPARE(model.routes().size(), 2);
}

void LocalApiTest::previewsConfiguredRoute() {
    QTemporaryDir temp; QVERIFY(temp.isValid());
    QDir source(temp.filePath("Drive")), disk(temp.filePath("disk")), destination(temp.filePath("disk/Drive"));
    QVERIFY(source.mkpath(".")); QVERIFY(destination.mkpath("."));
    QFile file(source.filePath("new.txt")); QVERIFY(file.open(QIODevice::WriteOnly)); QCOMPARE(file.write("preview"), 7); file.close();
    const QString identity = VerifiedCopy::liveStorageIdentity(destination.path()); QVERIFY(!identity.isEmpty());
    SetupModel model(temp.filePath("catalog.sqlite"), QVariantList{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", disk.path()}, {"identity", identity}, {"filesystemType", QString::fromLatin1(QStorageInfo(destination.path()).fileSystemType())}, {"present", true}, {"kind", "removable"}}});
    QVERIFY(model.ready()); QVERIFY(model.saveRoute(source.path(), "disk", destination.path(), "Nothing", 0, false, 0, {}, "Drive"));
    const QString routeId = model.routes().first().toMap().value("id").toString();
    LocalApi api(&model); QVERIFY(api.start(0)); QNetworkAccessManager network;
    QNetworkRequest unauthorizedRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/route-preview").arg(api.port()))); unauthorizedRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json"));
    auto *unauthorized = network.post(unauthorizedRequest, QJsonDocument(QJsonObject{{"routeId", routeId}}).toJson(QJsonDocument::Compact)); QSignalSpy unauthorizedFinished(unauthorized, &QNetworkReply::finished); QVERIFY(unauthorizedFinished.wait(3000)); QCOMPARE(unauthorized->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 403); unauthorized->deleteLater();
    auto *session = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/session").arg(api.port())))); QSignalSpy sessionFinished(session, &QNetworkReply::finished); QVERIFY(sessionFinished.wait(3000)); const QString token = QJsonDocument::fromJson(session->readAll()).object().value("token").toString(); session->deleteLater(); QVERIFY(!token.isEmpty());
    QNetworkRequest request(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/route-preview").arg(api.port()))); request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); request.setRawHeader("X-Local-Drive-Token", token.toUtf8());
    auto *missing = network.post(request, QJsonDocument(QJsonObject{{"routeId", "missing"}}).toJson(QJsonDocument::Compact)); QSignalSpy missingFinished(missing, &QNetworkReply::finished); QVERIFY(missingFinished.wait(3000)); QCOMPARE(missing->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 404); missing->deleteLater();
    auto *started = network.post(request, QJsonDocument(QJsonObject{{"routeId", routeId}}).toJson(QJsonDocument::Compact)); QSignalSpy startedFinished(started, &QNetworkReply::finished); QVERIFY(startedFinished.wait(3000)); QCOMPARE(started->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); const QString previewId = QJsonDocument::fromJson(started->readAll()).object().value("id").toString(); started->deleteLater(); QVERIFY(!previewId.isEmpty());
    QJsonObject operation;
    for (int attempt = 0; attempt < 60 && operation.value("state") != "complete"; ++attempt) {
        QTest::qWait(50); QUrl url(QStringLiteral("http://127.0.0.1:%1/api/v1/route-preview").arg(api.port())); QUrlQuery query; query.addQueryItem("id", previewId); url.setQuery(query);
        auto *poll = network.get(QNetworkRequest(url)); QSignalSpy pollFinished(poll, &QNetworkReply::finished); QVERIFY(pollFinished.wait(3000)); QCOMPARE(poll->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); operation = QJsonDocument::fromJson(poll->readAll()).object(); poll->deleteLater();
    }
    QCOMPARE(operation.value("state").toString(), QStringLiteral("complete")); const QJsonObject preview = operation.value("preview").toObject(); QVERIFY2(preview.value("ok").toBool(), qPrintable(preview.value("error").toString())); QCOMPARE(preview.value("files").toInt(), 1); QCOMPARE(preview.value("toCopy").toInt(), 7);
    QNetworkRequest manifestRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/route-manifest").arg(api.port()))); manifestRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); manifestRequest.setRawHeader("X-Local-Drive-Token", token.toUtf8()); const QByteArray operationBody = QJsonDocument(QJsonObject{{"id", previewId}}).toJson(QJsonDocument::Compact);
    auto *manifestReply = network.post(manifestRequest, operationBody); QSignalSpy manifestFinished(manifestReply, &QNetworkReply::finished); QVERIFY(manifestFinished.wait(3000)); QCOMPARE(manifestReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); const QJsonObject manifest = QJsonDocument::fromJson(manifestReply->readAll()).object().value("manifest").toObject(); manifestReply->deleteLater(); QCOMPARE(manifest.value("format").toString(), QStringLiteral("localdrive-manifest-v1")); const QJsonArray manifestFiles = manifest.value("files").toArray(); QCOMPARE(manifestFiles.size(), 1); QCOMPARE(manifestFiles.first().toObject().value("path").toString(), QStringLiteral("new.txt")); QCOMPARE(manifestFiles.first().toObject().value("size").toInt(), 7);
    QNetworkRequest executeRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/route-execute").arg(api.port()))); executeRequest.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); executeRequest.setRawHeader("X-Local-Drive-Token", token.toUtf8()); const QByteArray executeBody = QJsonDocument(QJsonObject{{"id", previewId}}).toJson(QJsonDocument::Compact);
    auto *execute = network.post(executeRequest, executeBody); QSignalSpy executeFinished(execute, &QNetworkReply::finished); QVERIFY(executeFinished.wait(3000)); QCOMPARE(execute->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); execute->deleteLater();
    operation = {};
    for (int attempt = 0; attempt < 100 && operation.value("state") != "transferred" && operation.value("state") != "failed"; ++attempt) {
        QTest::qWait(50); QUrl url(QStringLiteral("http://127.0.0.1:%1/api/v1/route-preview").arg(api.port())); QUrlQuery query; query.addQueryItem("id", previewId); url.setQuery(query);
        auto *poll = network.get(QNetworkRequest(url)); QSignalSpy pollFinished(poll, &QNetworkReply::finished); QVERIFY(pollFinished.wait(3000)); operation = QJsonDocument::fromJson(poll->readAll()).object(); poll->deleteLater();
    }
    QCOMPARE(operation.value("state").toString(), QStringLiteral("transferred")); QVERIFY(operation.value("result").toString().startsWith("Cleanup pending")); QVERIFY(QFileInfo::exists(destination.filePath("new.txt"))); QVERIFY(QFileInfo::exists(source.filePath("new.txt"))); QFile copied(destination.filePath("new.txt")); QVERIFY(copied.open(QIODevice::ReadOnly)); QCOMPARE(copied.readAll(), QByteArrayLiteral("preview"));
    QUrl historyUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/route-history").arg(api.port())); QUrlQuery historyQuery; historyQuery.addQueryItem("routeId", routeId); historyUrl.setQuery(historyQuery); auto *historyReply = network.get(QNetworkRequest(historyUrl)); QSignalSpy historyFinished(historyReply, &QNetworkReply::finished); QVERIFY(historyFinished.wait(3000)); QCOMPARE(historyReply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200); const QJsonArray history = QJsonDocument::fromJson(historyReply->readAll()).object().value("items").toArray(); historyReply->deleteLater(); QVERIFY(!history.isEmpty()); QCOMPARE(history.first().toObject().value("event").toString(), QStringLiteral("verified")); QCOMPARE(history.first().toObject().value("result").toString(), QStringLiteral("verified copy"));
    auto *replay = network.post(executeRequest, executeBody); QSignalSpy replayFinished(replay, &QNetworkReply::finished); QVERIFY(replayFinished.wait(3000)); QCOMPARE(replay->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 409); replay->deleteLater();
}

void LocalApiTest::controlsActiveRouteSafely() {
    QTemporaryDir temp; QVERIFY(temp.isValid()); QDir source(temp.filePath("Drive")), disk(temp.filePath("disk")), destination(temp.filePath("disk/Drive")); QVERIFY(source.mkpath(".")); QVERIFY(destination.mkpath("."));
    QFile file(source.filePath("controlled.bin")); QVERIFY(file.open(QIODevice::WriteOnly)); QCOMPARE(file.write(QByteArray(2 * 1024 * 1024, 'c')), 2 * 1024 * 1024); file.close();
    const QString identity = VerifiedCopy::liveStorageIdentity(destination.path()); SetupModel model(temp.filePath("catalog.sqlite"), QVariantList{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", disk.path()}, {"identity", identity}, {"filesystemType", QString::fromLatin1(QStorageInfo(destination.path()).fileSystemType())}, {"present", true}, {"kind", "removable"}}}); QVERIFY(model.ready()); QVERIFY(model.saveRoute(source.path(), "disk", destination.path(), "Everything")); const QString routeId = model.routes().first().toMap().value("id").toString();
    QSemaphore copyEntered, continueCopy, resumedEntered, continueResume; LocalApi api(&model); api.setRouteTestHook([&](const QString &, const QString &stage) { if (stage == "during-copy") { copyEntered.release(); continueCopy.acquire(); } else if (stage == "after-pause-resume") { resumedEntered.release(); continueResume.acquire(); } }); QVERIFY(api.start(0)); QNetworkAccessManager network;
    auto *session = network.get(QNetworkRequest(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/session").arg(api.port())))); QSignalSpy sessionFinished(session, &QNetworkReply::finished); QVERIFY(sessionFinished.wait(3000)); const QString token = QJsonDocument::fromJson(session->readAll()).object().value("token").toString(); session->deleteLater();
    auto authorized = [&](const QString &path) { QNetworkRequest request(QUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/%2").arg(api.port()).arg(path))); request.setHeader(QNetworkRequest::ContentTypeHeader, QStringLiteral("application/json")); request.setRawHeader("X-Local-Drive-Token", token.toUtf8()); return request; };
    auto *startPreview = network.post(authorized("route-preview"), QJsonDocument(QJsonObject{{"routeId", routeId}}).toJson(QJsonDocument::Compact)); QSignalSpy previewStarted(startPreview, &QNetworkReply::finished); QVERIFY(previewStarted.wait(3000)); QCOMPARE(startPreview->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); const QString id = QJsonDocument::fromJson(startPreview->readAll()).object().value("id").toString(); startPreview->deleteLater();
    QUrl pollUrl(QStringLiteral("http://127.0.0.1:%1/api/v1/route-preview").arg(api.port())); QUrlQuery pollQuery; pollQuery.addQueryItem("id", id); pollUrl.setQuery(pollQuery); QJsonObject operation;
    for (int attempt = 0; attempt < 100 && operation.value("state") != "complete"; ++attempt) { QTest::qWait(25); auto *poll = network.get(QNetworkRequest(pollUrl)); QSignalSpy done(poll, &QNetworkReply::finished); QVERIFY(done.wait(3000)); operation = QJsonDocument::fromJson(poll->readAll()).object(); poll->deleteLater(); }
    QVERIFY(operation.value("preview").toObject().value("ok").toBool()); const QByteArray idBody = QJsonDocument(QJsonObject{{"id", id}}).toJson(QJsonDocument::Compact); auto *execute = network.post(authorized("route-execute"), idBody); QSignalSpy executeFinished(execute, &QNetworkReply::finished); QVERIFY(executeFinished.wait(3000)); QCOMPARE(execute->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 202); execute->deleteLater(); const bool entered = copyEntered.tryAcquire(1, 3000); if (!entered) continueCopy.release(); QVERIFY(entered);
    auto control = [&](const QString &action, int *httpStatus) { auto *reply = network.post(authorized("route-control"), QJsonDocument(QJsonObject{{"id", id}, {"action", action}}).toJson(QJsonDocument::Compact)); QSignalSpy done(reply, &QNetworkReply::finished); if (!done.wait(3000)) { *httpStatus = 0; reply->deleteLater(); return QJsonObject{}; } *httpStatus = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(); const QJsonObject result = QJsonDocument::fromJson(reply->readAll()).object(); reply->deleteLater(); return result; };
    int controlStatus = 0; const QJsonObject paused = control("pause", &controlStatus); continueCopy.release(); QCOMPARE(controlStatus, 200); QVERIFY(paused.value("paused").toBool());
    for (int attempt = 0; attempt < 100 && operation.value("status") != "Paused"; ++attempt) { QTest::qWait(25); auto *poll = network.get(QNetworkRequest(pollUrl)); QSignalSpy done(poll, &QNetworkReply::finished); QVERIFY(done.wait(3000)); operation = QJsonDocument::fromJson(poll->readAll()).object(); poll->deleteLater(); } QCOMPARE(operation.value("status").toString(), QStringLiteral("Paused"));
    const QJsonObject resumed = control("resume", &controlStatus); const int resumeStatus = controlStatus; const bool resumedHook = resumedEntered.tryAcquire(1, 3000); QJsonObject cancelled; int cancelStatus = 0; if (resumedHook) cancelled = control("cancel", &cancelStatus); continueResume.release(); QCOMPARE(resumeStatus, 200); QVERIFY(!resumed.value("paused").toBool()); QVERIFY(resumedHook); QCOMPARE(cancelStatus, 200); QCOMPARE(cancelled.value("action").toString(), QStringLiteral("cancel"));
    operation = {}; for (int attempt = 0; attempt < 200 && operation.value("state") != "failed"; ++attempt) { QTest::qWait(25); auto *poll = network.get(QNetworkRequest(pollUrl)); QSignalSpy done(poll, &QNetworkReply::finished); QVERIFY(done.wait(3000)); operation = QJsonDocument::fromJson(poll->readAll()).object(); poll->deleteLater(); }
    QCOMPARE(operation.value("state").toString(), QStringLiteral("failed")); QVERIFY(operation.value("result").toString().contains("source retained")); QVERIFY(QFileInfo::exists(source.filePath("controlled.bin"))); QVERIFY(!QFileInfo::exists(destination.filePath("controlled.bin")));
}

QTEST_MAIN(LocalApiTest)
#include "localapi_test.moc"
