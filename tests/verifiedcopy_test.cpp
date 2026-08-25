#include <QtTest>
#include <QFile>
#include <QFileInfo>
#include <QTemporaryDir>
#include <QDir>
#include <QDateTime>
#include <QJsonDocument>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QStorageInfo>
#include <limits>
#include <algorithm>
#include <sys/stat.h>
#include <unistd.h>

#include "../src/verifiedcopy.h"

namespace {
void writeFile(const QString &path, const QByteArray &data) {
    QVERIFY2(QDir().mkpath(QFileInfo(path).absolutePath()), qPrintable(path));
    QFile file(path); QVERIFY2(file.open(QIODevice::WriteOnly), qPrintable(file.errorString()));
    QCOMPARE(file.write(data), data.size());
}

VerifiedCopy::Request requestFor(const QString &source, const QString &destination, const QString &identity, const QString &db) {
    VerifiedCopy::Request request;
    request.sourceRoot = source;
    request.destinationRoot = destination;
    request.selectedStorageRoot = destination;
    request.storageIdentity = identity;
    request.databasePath = db;
    request.routeId = QStringLiteral("route-test");
    request.destinationStorageId = QStringLiteral("disk-test");
    return request;
}
}

class VerifiedCopyTest final : public QObject {
    Q_OBJECT
private slots:
    void previewAndVerifiedReceipt() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QStorageInfo t7("/mnt/T7");
        if (t7.isValid() && t7.device() == QByteArrayLiteral("/dev/sda1")) QCOMPARE(VerifiedCopy::liveStorageIdentity("/mnt/T7"), QStringLiteral("storage:f0544ced-baf2-47b4-9932-7f9b493e29f5"));
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        writeFile(source + "/nested/ελληνικά.txt", "hello"); writeFile(source + "/empty", {});
        const QString identity = VerifiedCopy::liveStorageIdentity(destination);
        QVERIFY(identity.startsWith("storage:"));
        const QString db = temp.path() + "/catalog.sqlite";
        auto request = requestFor(source, destination, identity, db);
        request.filesystemType = QStringLiteral("testfs");
        request.minimumFreeBytes = 1;
        const auto preview = VerifiedCopy::inspect(request);
        QVERIFY2(preview.ok, qPrintable(preview.error)); QCOMPARE(preview.files, 2); QCOMPARE(preview.toCopy, 5);
        VerifiedCopy copy(db); QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QVERIFY(QFileInfo::exists(destination + "/nested/ελληνικά.txt")); QVERIFY(QFileInfo::exists(destination + "/empty"));
        QVERIFY(QFileInfo::exists(source + "/nested/ελληνικά.txt"));
        QSqlDatabase dbCheck = QSqlDatabase::addDatabase("QSQLITE", "verified-check"); dbCheck.setDatabaseName(db); QVERIFY(dbCheck.open());
        QSqlQuery q(dbCheck); QVERIFY(q.exec("SELECT COUNT(*) FROM locations WHERE state='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 2);
        QVERIFY(q.exec("SELECT source_sha256,destination_sha256 FROM locations WHERE state='verified'")); int hashedLocations = 0; while (q.next()) { QVERIFY(!q.value(0).toString().isEmpty()); QCOMPARE(q.value(0).toString(), q.value(1).toString()); ++hashedLocations; } QCOMPARE(hashedLocations, 2);
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 2);
        QVERIFY(q.exec("SELECT filesystem_type FROM storage WHERE id='disk-test'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("testfs"));
        QVERIFY(q.exec("SELECT event_sequence FROM devices WHERE id='local'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 2);
        q.finish(); dbCheck.close(); dbCheck = QSqlDatabase(); QSqlDatabase::removeDatabase("verified-check");
        VerifiedCopy routeView(db); QVERIFY(routeView.previewRoute("route-test")); QTRY_VERIFY_WITH_TIMEOUT(!routeView.running(), 5000); QVERIFY(routeView.previewSuccessful()); QCOMPARE(routeView.previewData().value("minimumFreeBytes").toLongLong(), 1); QVERIFY(std::any_of(routeView.logEntries().cbegin(), routeView.logEntries().cend(), [](const QString &entry) { return entry.contains("status=Previewing"); })); QVERIFY(std::any_of(routeView.logEntries().cbegin(), routeView.logEntries().cend(), [](const QString &entry) { return entry.contains("status=Preview ready"); }));
    }

    void mixedTreeAccountsEverySelectedItem() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        writeFile(source + "/empty.txt", {});
        writeFile(source + "/nested/Ελληνικά/large.bin", QByteArray(1024 * 1024, 'L'));
        writeFile(source + "/duplicate-a.txt", "duplicate");
        writeFile(source + "/nested/duplicate-b.txt", "duplicate");
        writeFile(source + "/conflict.txt", "new"); writeFile(destination + "/conflict.txt", "old");
        const QString db = temp.path() + "/catalog.sqlite";
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), db);
        const auto preview = VerifiedCopy::inspect(request);
        QVERIFY2(preview.ok, qPrintable(preview.error)); QCOMPARE(preview.files, 5); QCOMPARE(preview.duplicates, 1); QCOMPARE(preview.toMap().value("duplicates").toLongLong(), 1); QCOMPARE(preview.conflicts, 1); QCOMPARE(preview.unsupported, 0); QCOMPARE(preview.conflictPaths, QStringList{QStringLiteral("conflict.txt")});
        VerifiedCopy::Preview hashFailure; hashFailure.error = QStringLiteral("Destination hash mismatch"); QCOMPARE(hashFailure.toMap().value("errorCode").toString(), QStringLiteral("destination_hash_mismatch")); QVERIFY(hashFailure.toMap().value("nextAction").toString().contains("Keep the source"));
        VerifiedCopy::Preview sourceFailure; sourceFailure.error = QStringLiteral("Source changed after preview"); QVERIFY(sourceFailure.toMap().value("nextAction").toString().contains("Rescan"));
        VerifiedCopy::Preview trashFailure; trashFailure.error = QStringLiteral("Trash cleanup failed: backend unavailable"); QCOMPARE(trashFailure.toMap().value("errorCode").toString(), QStringLiteral("unsupported_trash")); QVERIFY(trashFailure.toMap().value("nextAction").toString().contains("Trash"));
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QVERIFY(QFileInfo::exists(destination + "/empty.txt")); QVERIFY(QFileInfo::exists(destination + "/nested/Ελληνικά/large.bin"));
        QVERIFY(QFileInfo::exists(destination + "/duplicate-a.txt")); QVERIFY(QFileInfo::exists(destination + "/nested/duplicate-b.txt"));
        QVERIFY(QFileInfo::exists(source + "/conflict.txt"));
        QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "mixed-tree-check"); check.setDatabaseName(db); QVERIFY(check.open()); QSqlQuery q(check);
        QVERIFY(q.exec("SELECT state,error_code,error_message FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Conflict")); QCOMPARE(q.value(1).toString(), QStringLiteral("name_conflict")); QCOMPARE(q.value(2).toString(), QStringLiteral("One or more destinations differ"));
        QVERIFY(q.exec("SELECT COUNT(*) FROM job_items WHERE state='Complete'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 4);
        QVERIFY(q.exec("SELECT COUNT(*) FROM history")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 5);
        q.finish(); check.close(); check = QSqlDatabase(); QSqlDatabase::removeDatabase("mixed-tree-check");
    }

    void conflictNeverEnablesCleanup() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/conflict", "new"); writeFile(destination + "/conflict", "old");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath); request.behavior = QStringLiteral("Move"); request.keepPolicy = QStringLiteral("Nothing");
        VerifiedCopy seed; QString error; QVERIFY2(seed.executeBlocking(request, &error), qPrintable(error));
        VerifiedCopy copy(dbPath); QVERIFY(copy.previewRoute("route-test")); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 5000); QVERIFY(copy.previewSuccessful()); QVERIFY(copy.startCopy()); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 10000);
        QVERIFY(!copy.cleanupReady()); QVERIFY(QFileInfo::exists(source + "/conflict"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "conflict-cleanup-check"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db); QVERIFY(q.exec("SELECT state FROM jobs ORDER BY rowid DESC LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Conflict")); q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("conflict-cleanup-check");
    }

    void photoOrganizationPreservesFoldersAndSidecars() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        writeFile(source + "/photo.jpg", QByteArray::fromBase64("/9j/4AAQSkZJRgABAQAAAQABAAD/4QA2RXhpZgAATU0AKgAAAAgAAZADAAIAAAAUAAAAGgAAAAAyMDAxOjAyOjAzIDA0OjA1OjA2AP/bAEMACAYGBwYFCAcHBwkJCAoMFA0MCwsMGRITDxQdGh8eHRocHCAkLicgIiwjHBwoNyksMDE0NDQfJzk9ODI8LjM0Mv/bAEMBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMv/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAAADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGjqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AOLooor5k/cT/9k=")); writeFile(source + "/photo.xmp", "metadata"); writeFile(source + "/notes.txt", "keep"); writeFile(source + "/album/nested.jpg", "nested");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        request.organizePhotos = true;
        const auto preview = VerifiedCopy::inspect(request);
        QVERIFY2(preview.ok, qPrintable(preview.error));
        QCOMPARE(preview.organized, 2);
        QCOMPARE(preview.toMap().value("organized").toLongLong(), 2);
        QString organizedPhoto, organizedSidecar;
        for (const auto &entry : preview.manifest) {
            if (entry.relative == "photo.jpg") organizedPhoto = entry.destination;
            if (entry.relative == "photo.xmp") organizedSidecar = entry.destination;
        }
        QCOMPARE(organizedPhoto, QStringLiteral("Local Drive/Gallery/2001/photo.jpg"));
        QCOMPARE(organizedSidecar, QFileInfo(organizedPhoto).path() + "/photo.xmp");
        QVERIFY(std::none_of(preview.manifest.cbegin(), preview.manifest.cend(), [](const auto &entry) { return entry.relative == "notes.txt" && entry.destination != "notes.txt"; }));
        QVERIFY(std::none_of(preview.manifest.cbegin(), preview.manifest.cend(), [](const auto &entry) { return entry.relative == "album/nested.jpg" && entry.destination != "album/nested.jpg"; }));
        QString error; VerifiedCopy copy; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QVERIFY(QFileInfo::exists(destination + "/" + organizedPhoto)); QVERIFY(QFileInfo::exists(destination + "/" + organizedSidecar));
        QVERIFY(QFileInfo::exists(destination + "/notes.txt")); QVERIFY(QFileInfo::exists(destination + "/album/nested.jpg"));
        QSqlDatabase catalog = QSqlDatabase::addDatabase("QSQLITE", "photo-route-check"); catalog.setDatabaseName(request.databasePath); QVERIFY(catalog.open()); QSqlQuery route(catalog); QVERIFY(route.exec("SELECT organize_photos,content_type FROM routes WHERE id='route-test'")); QVERIFY(route.next()); QCOMPARE(route.value(0).toInt(), 1); QCOMPARE(route.value(1).toString(), QStringLiteral("Photos")); route.finish(); catalog.close(); catalog = QSqlDatabase(); QSqlDatabase::removeDatabase("photo-route-check");
    }

    void minimumFreeSpaceMarginIsPreviewedAndEnforced() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "margin");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        request.minimumFreeBytes = 1;
        auto preview = VerifiedCopy::inspect(request); QVERIFY2(preview.ok, qPrintable(preview.error)); QCOMPARE(preview.minimumFreeBytes, 1); QCOMPARE(preview.toMap().value("minimumFreeBytes").toLongLong(), 1);
        request.minimumFreeBytes = std::numeric_limits<qint64>::max();
        preview = VerifiedCopy::inspect(request); QVERIFY(!preview.ok); QCOMPARE(preview.toMap().value("errorCode").toString(), QStringLiteral("insufficient_space")); QCOMPARE(preview.minimumFreeBytes, std::numeric_limits<qint64>::max());
    }

    void stagingMaximumStopsOversizedIntakeBeforeCopy() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "12345");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        request.stagingMaxBytes = 4;
        const auto preview = VerifiedCopy::inspect(request);
        QVERIFY(!preview.ok); QCOMPARE(preview.stagingMaxBytes, 4); QCOMPARE(preview.toMap().value("stagingMaxBytes").toLongLong(), 4); QCOMPARE(preview.toMap().value("errorCode").toString(), QStringLiteral("insufficient_space"));
        VerifiedCopy copy; QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(error.contains("Staging limit"));
        QVERIFY(QFileInfo::exists(source + "/file")); QVERIFY(!QFileInfo::exists(destination + "/file"));
    }

    void runtimeSpaceRecheckKeepsSourceWhenDestinationFills() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "space");
        const qint64 available = QStorageInfo(destination).bytesAvailable();
        if (available < 16 * 1024 * 1024) QSKIP("Sandbox does not have enough free space for deterministic fill test");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        request.minimumFreeBytes = available - 5;
        VerifiedCopy copy; bool fill = true; bool queuedOnRetry = false;
        copy.setTestHook([&](const QString &, const QString &stage) {
            if (stage != "before-space-check") return;
            if (fill) { writeFile(destination + "/space-filler", QByteArray(8 * 1024 * 1024, 'F')); return; }
            QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "runtime-queued-check"); check.setDatabaseName(request.databasePath); QVERIFY(check.open()); QSqlQuery q(check); QVERIFY(q.exec("SELECT state FROM jobs ORDER BY rowid DESC LIMIT 1")); QVERIFY(q.next()); queuedOnRetry = q.value(0).toString() == QStringLiteral("Queued"); q.finish(); check.close(); check = QSqlDatabase(); QSqlDatabase::removeDatabase("runtime-queued-check");
        });
        QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(error.contains("free space")); QVERIFY(QFileInfo::exists(source + "/file")); QVERIFY(!QFileInfo::exists(destination + "/file"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "runtime-space-check"); db.setDatabaseName(request.databasePath); QVERIFY(db.open()); QSqlQuery q(db); QVERIFY(q.exec("SELECT state,error_code FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Failed")); QCOMPARE(q.value(1).toString(), QStringLiteral("insufficient_space")); q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("runtime-space-check");
        QVERIFY(QFile::remove(destination + "/space-filler")); fill = false; request.minimumFreeBytes = 1; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error)); QVERIFY(queuedOnRetry);
    }

    void pauseAndResumeKeepsJobRecoverable() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", db = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        writeFile(source + "/a.bin", QByteArray(2 * 1024 * 1024, 'a')); writeFile(source + "/b.bin", QByteArray(2 * 1024 * 1024, 'b'));
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), db);
        VerifiedCopy copy(db); bool resumedInVerification = false; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QVERIFY(QFile::remove(destination + "/a.bin")); QVERIFY(QFile::remove(destination + "/b.bin"));
        writeFile(source + "/a.bin", QByteArray(2 * 1024 * 1024, 'A')); writeFile(source + "/b.bin", QByteArray(2 * 1024 * 1024, 'B'));
        copy.setTestHook([&copy, &db, &resumedInVerification](const QString &path, const QString &stage) { if (path.endsWith("/a.bin") && stage == "before-verification") { QSqlDatabase state = QSqlDatabase::addDatabase("QSQLITE", "verifying-state-check"); state.setDatabaseName(db); QVERIFY(state.open()); QSqlQuery q(state); QVERIFY(q.exec("SELECT state FROM jobs ORDER BY rowid DESC LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Verifying")); q.finish(); state.close(); state = QSqlDatabase(); QSqlDatabase::removeDatabase("verifying-state-check"); copy.pause(); } else if (stage == "after-pause-resume") { QSqlDatabase state = QSqlDatabase::addDatabase("QSQLITE", "resumed-verifying-state-check"); state.setDatabaseName(db); QVERIFY(state.open()); QSqlQuery q(state); QVERIFY(q.exec("SELECT state FROM jobs ORDER BY rowid DESC LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Verifying")); resumedInVerification = true; q.finish(); state.close(); state = QSqlDatabase(); QSqlDatabase::removeDatabase("resumed-verifying-state-check"); } });
        QVERIFY(copy.previewRoute("route-test")); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 5000); QVERIFY(copy.previewSuccessful());
        QSignalSpy finished(&copy, &VerifiedCopy::finished);
        QVERIFY(copy.startCopy()); QTRY_VERIFY_WITH_TIMEOUT(copy.paused(), 5000);
        QSqlDatabase pausedDb = QSqlDatabase::addDatabase("QSQLITE", "paused-job-check"); pausedDb.setDatabaseName(db); QVERIFY(pausedDb.open()); QSqlQuery pausedQuery(pausedDb);
        QVERIFY(pausedQuery.exec("SELECT state FROM jobs ORDER BY rowid DESC LIMIT 1")); QVERIFY(pausedQuery.next()); QCOMPARE(pausedQuery.value(0).toString(), QStringLiteral("Paused"));
        pausedQuery.finish(); pausedDb.close(); pausedDb = QSqlDatabase(); QSqlDatabase::removeDatabase("paused-job-check");
        QVERIFY(!QFileInfo::exists(destination + "/a.bin"));
        copy.resume(); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 10000); QVERIFY(!copy.paused()); QVERIFY(resumedInVerification); QVERIFY(finished.count() > 0); QVERIFY(finished.last().at(0).toBool());
        QFile resultA(destination + "/a.bin"), resultB(destination + "/b.bin"); QVERIFY(resultA.open(QIODevice::ReadOnly)); QCOMPARE(resultA.read(1), QByteArray("A")); QVERIFY(resultB.open(QIODevice::ReadOnly)); QCOMPARE(resultB.read(1), QByteArray("B"));
        QVERIFY(QFileInfo::exists(source + "/a.bin")); QVERIFY(QFileInfo::exists(source + "/b.bin"));

        QVERIFY(QFile::remove(destination + "/a.bin")); QVERIFY(QFile::remove(destination + "/b.bin"));
        writeFile(source + "/a.bin", QByteArray(2 * 1024 * 1024, 'C')); writeFile(source + "/b.bin", QByteArray(2 * 1024 * 1024 + 1, 'D'));
        finished.clear(); QVERIFY(copy.previewRoute("route-test")); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 5000); QVERIFY(copy.startCopy()); QTRY_VERIFY_WITH_TIMEOUT(copy.paused(), 5000);
        copy.cancel(); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 10000); QVERIFY(!copy.paused()); QVERIFY(finished.count() > 0); QVERIFY(!finished.last().at(0).toBool());
        QSqlDatabase cancelledDb = QSqlDatabase::addDatabase("QSQLITE", "paused-cancel-check"); cancelledDb.setDatabaseName(db); QVERIFY(cancelledDb.open()); QSqlQuery cancelledQuery(cancelledDb);
        QVERIFY(cancelledQuery.exec("SELECT state FROM jobs ORDER BY rowid DESC LIMIT 1")); QVERIFY(cancelledQuery.next()); QCOMPARE(cancelledQuery.value(0).toString(), QStringLiteral("Cancelled"));
        cancelledQuery.finish(); cancelledDb.close(); cancelledDb = QSqlDatabase(); QSqlDatabase::removeDatabase("paused-cancel-check");
        QVERIFY(QFileInfo::exists(source + "/a.bin")); QVERIFY(QFileInfo::exists(source + "/b.bin"));
    }

    void previewCancellationStopsSafely() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", db = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/large.bin", QByteArray(32 * 1024 * 1024, 'P'));
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), db); VerifiedCopy setup; QString error; QVERIFY2(setup.executeBlocking(request, &error), qPrintable(error)); QVERIFY(QFile::remove(destination + "/large.bin"));
        VerifiedCopy copy(db); QVERIFY(copy.previewRoute("route-test")); copy.cancel(); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 5000); QVERIFY(!copy.previewSuccessful()); QCOMPARE(copy.previewData().value("errorCode").toString(), QStringLiteral("cancelled"));
    }

    void previewReportsUnreadableSource() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", unreadable = source + "/unreadable.txt";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(unreadable, "private");
        QVERIFY(QFile::setPermissions(unreadable, QFileDevice::Permissions()));
        if (::access(unreadable.toLocal8Bit().constData(), R_OK) == 0) { QVERIFY(QFile::setPermissions(unreadable, QFileDevice::ReadOwner | QFileDevice::WriteOwner)); QSKIP("The test account can read mode-000 files"); }
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        const auto preview = VerifiedCopy::inspect(request);
        QVERIFY(!preview.ok); QCOMPARE(preview.unreadable, 1); QVERIFY(preview.error.contains("Unreadable")); QCOMPARE(preview.toMap().value("errorCode").toString(), QStringLiteral("permission_denied")); QVERIFY(preview.toMap().value("sourceSafe").toBool()); QVERIFY(preview.toMap().value("nextAction").toString().contains("permissions"));
        QVERIFY(QFile::setPermissions(unreadable, QFileDevice::ReadOwner | QFileDevice::WriteOwner));
    }

    void previewRejectsReadOnlyDestination() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file.txt", "safe");
        QVERIFY(QFile::setPermissions(destination, QFileDevice::ReadOwner | QFileDevice::ExeOwner));
        if (::access(destination.toLocal8Bit().constData(), W_OK) == 0) { QVERIFY(QFile::setPermissions(destination, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner)); QSKIP("The test account can write the read-only destination"); }
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        const auto preview = VerifiedCopy::inspect(request);
        QVERIFY(!preview.ok); QVERIFY(preview.error.contains("Permission denied")); QCOMPARE(preview.toMap().value("errorCode").toString(), QStringLiteral("permission_denied")); QVERIFY(preview.toMap().value("sourceSafe").toBool()); QVERIFY(preview.toMap().value("nextAction").toString().contains("permissions"));
        QVERIFY(QFile::setPermissions(destination, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner));
    }

    void destinationBecomesReadOnlyBeforePartialOpen() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", db = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file.txt", "safe");
        if (::geteuid() == 0) QSKIP("Root bypasses destination permission checks");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), db);
        VerifiedCopy copy; copy.setTestHook([&](const QString &path, const QString &stage) { if (stage == "before-partial-open") QVERIFY(QFile::setPermissions(QFileInfo(path).absolutePath(), QFileDevice::ReadOwner | QFileDevice::ExeOwner)); });
        QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(error.contains("Permission denied"));
        QVERIFY(QFileInfo::exists(source + "/file.txt")); QVERIFY(!QFileInfo::exists(destination + "/file.txt"));
        QVERIFY(QFile::setPermissions(destination, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner));
        QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "destination-write-failure-check"); check.setDatabaseName(db); QVERIFY(check.open()); QSqlQuery q(check);
        QVERIFY(q.exec("SELECT state,error_code FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Failed")); QCOMPARE(q.value(1).toString(), QStringLiteral("permission_denied"));
        q.finish(); check.close(); check = QSqlDatabase(); QSqlDatabase::removeDatabase("destination-write-failure-check");
    }

    void identicalConflictAndIdentityGuards() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        writeFile(source + "/same.txt", "same"); writeFile(source + "/conflict.txt", "new");
        writeFile(destination + "/same.txt", "same"); writeFile(destination + "/conflict.txt", "old");
        const QString identity = VerifiedCopy::liveStorageIdentity(destination);
        auto request = requestFor(source, destination, identity, temp.path() + "/catalog.sqlite");
        const auto preview = VerifiedCopy::inspect(request); QVERIFY(preview.ok); QCOMPARE(preview.identical, 1); QCOMPARE(preview.conflicts, 1); QCOMPARE(preview.conflictPaths, QStringList{QStringLiteral("conflict.txt")});
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QFile conflict(destination + "/conflict.txt"); QVERIFY(conflict.open(QIODevice::ReadOnly)); QCOMPARE(conflict.readAll(), QByteArray("old"));
        QSqlDatabase conflictDb = QSqlDatabase::addDatabase("QSQLITE", "conflict-check"); conflictDb.setDatabaseName(request.databasePath); QVERIFY(conflictDb.open()); QSqlQuery conflictQuery(conflictDb);
        QVERIFY(conflictQuery.exec("SELECT state FROM jobs LIMIT 1")); QVERIFY(conflictQuery.next()); QCOMPARE(conflictQuery.value(0).toString(), QStringLiteral("Conflict"));
        QVERIFY(conflictQuery.exec("SELECT COUNT(*) FROM history WHERE event='conflict'")); QVERIFY(conflictQuery.next()); QCOMPARE(conflictQuery.value(0).toInt(), 1);
        conflictQuery.finish(); conflictDb.close(); conflictDb = QSqlDatabase(); QSqlDatabase::removeDatabase("conflict-check");
        auto wrong = request; wrong.storageIdentity = QStringLiteral("storage:not-this-disk"); QVERIFY(!VerifiedCopy::inspect(wrong).ok);
        auto outside = request; outside.selectedStorageRoot = temp.path() + "/outside"; QVERIFY(!VerifiedCopy::inspect(outside).ok);
        auto move = request; move.behavior = QStringLiteral("Move"); move.keepPolicy = QStringLiteral("Nothing"); QVERIFY(VerifiedCopy::inspect(move).ok);
    }

    void verifiedMoveRequiresExplicitTrashAndRecordsIt() {
        QTemporaryDir temp(QDir::homePath() + "/.localdrive-test-XXXXXX"); QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", dataHome = temp.path() + "/xdg";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        QVERIFY(QDir().mkpath(dataHome + "/Trash/info")); QVERIFY(QDir().mkpath(dataHome + "/Trash/files"));
        writeFile(source + "/file.txt", "move me");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        request.behavior = QStringLiteral("Move");
        request.keepPolicy = QStringLiteral("Nothing");
        VerifiedCopy copy; QString error;
        QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QVERIFY(QFileInfo::exists(source + "/file.txt"));
        QSqlDatabase before = QSqlDatabase::addDatabase("QSQLITE", "move-before-cleanup"); before.setDatabaseName(request.databasePath); QVERIFY(before.open()); QSqlQuery beforeQuery(before);
        QVERIFY(beforeQuery.exec("SELECT state FROM jobs LIMIT 1")); QVERIFY(beforeQuery.next()); QCOMPARE(beforeQuery.value(0).toString(), QStringLiteral("Cleanup pending"));
        beforeQuery.finish(); before.close(); before = QSqlDatabase(); QSqlDatabase::removeDatabase("move-before-cleanup");

        VerifiedCopy routeView(request.databasePath); QVERIFY(routeView.previewRoute("route-test")); QTRY_VERIFY_WITH_TIMEOUT(!routeView.running(), 5000); QVERIFY(routeView.previewSuccessful()); QVERIFY(routeView.cleanupReady());
        const QVariantMap cleanupPreview = routeView.cleanupPreview(); QCOMPARE(cleanupPreview.value("files").toLongLong(), 1); QCOMPARE(cleanupPreview.value("bytes").toLongLong(), 7);
        const QVariantList history = routeView.recentHistory(); QCOMPARE(history.size(), 1); QCOMPARE(history.first().toMap().value("event").toString(), QStringLiteral("verified"));
        const QString manifestPath = temp.path() + "/manifest.json"; QVERIFY(routeView.exportManifest(QUrl::fromLocalFile(manifestPath), "json"));
        QFile manifest(manifestPath); QVERIFY(manifest.open(QIODevice::ReadOnly)); const QJsonObject manifestObject = QJsonDocument::fromJson(manifest.readAll()).object(); QCOMPARE(manifestObject.value("format").toString(), QStringLiteral("localdrive-manifest-v1")); QCOMPARE(manifestObject.value("files").toArray().size(), 1);
        const QString csvPath = temp.path() + "/manifest.csv"; QVERIFY(routeView.exportManifest(QUrl::fromLocalFile(csvPath), "csv")); QFile csv(csvPath); QVERIFY(csv.open(QIODevice::ReadOnly)); QVERIFY(csv.readLine().startsWith("path,destination,size,mtime")); QVERIFY(csv.readLine().contains("file.txt"));

        const QByteArray previousDataHome = qgetenv("XDG_DATA_HOME"); qputenv("XDG_DATA_HOME", dataHome.toUtf8());
        QVERIFY2(copy.cleanupBlocking(request, &error), qPrintable(error));
        if (previousDataHome.isNull()) qunsetenv("XDG_DATA_HOME"); else qputenv("XDG_DATA_HOME", previousDataHome);
        QVERIFY(!QFileInfo::exists(source + "/file.txt"));
        QSqlDatabase after = QSqlDatabase::addDatabase("QSQLITE", "move-after-cleanup"); after.setDatabaseName(request.databasePath); QVERIFY(after.open()); QSqlQuery afterQuery(after);
        QVERIFY(afterQuery.exec("SELECT state FROM jobs LIMIT 1")); QVERIFY(afterQuery.next()); QCOMPARE(afterQuery.value(0).toString(), QStringLiteral("Complete"));
        QVERIFY(afterQuery.exec("SELECT cleanup_state FROM job_items LIMIT 1")); QVERIFY(afterQuery.next()); QCOMPARE(afterQuery.value(0).toString(), QStringLiteral("trashed"));
        QVERIFY(afterQuery.exec("SELECT COUNT(*) FROM history WHERE event='trashed'")); QVERIFY(afterQuery.next()); QCOMPARE(afterQuery.value(0).toInt(), 1);
        afterQuery.finish(); after.close(); after = QSqlDatabase(); QSqlDatabase::removeDatabase("move-after-cleanup");
    }

    void cleanupPrecheckFailureIsRecorded() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); const QString sourceFile = source + "/file.txt"; writeFile(sourceFile, "original");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite"); request.behavior = QStringLiteral("Move"); request.keepPolicy = QStringLiteral("Nothing");
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QFile changed(sourceFile); QVERIFY(changed.open(QIODevice::Append)); QVERIFY(changed.write(" changed") > 0); changed.close(); QVERIFY(!copy.cleanupBlocking(request, &error)); QVERIFY(error.contains("changed")); QVERIFY(QFileInfo::exists(sourceFile));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "cleanup-precheck"); db.setDatabaseName(request.databasePath); QVERIFY(db.open()); QSqlQuery q(db); QVERIFY(q.exec("SELECT state,error_code FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Cleanup pending")); QCOMPARE(q.value(1).toString(), QStringLiteral("source_changed")); QVERIFY(q.exec("SELECT cleanup_state FROM job_items LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("failed")); QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='failed'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1); q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("cleanup-precheck");
    }

    void cleanupCancellationBeforeTrashRetainsSources() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "cancel cleanup");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath); request.behavior = QStringLiteral("Move"); request.keepPolicy = QStringLiteral("Nothing");
        VerifiedCopy copy(dbPath); QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        copy.setTestHook([&copy](const QString &, const QString &stage) { if (stage == QStringLiteral("before-trash")) copy.cancel(); });
        QVERIFY(!copy.cleanupBlocking(request, &error)); QVERIFY(error.contains("cancelled")); QVERIFY(QFileInfo::exists(source + "/file")); QVERIFY(QFileInfo::exists(destination + "/file"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "cleanup-cancel-check"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT state,error_code FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Cleanup pending")); QCOMPARE(q.value(1).toString(), QStringLiteral("cancelled"));
        QVERIFY(q.exec("SELECT cleanup_state FROM job_items LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("failed"));
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='failed'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1);
        q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("cleanup-cancel-check");
    }

    void cleanupTrashFailureRemainsUncertain() {
        QTemporaryDir temp(QDir::homePath() + "/.localdrive-test-XXXXXX"); QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", dbPath = temp.path() + "/catalog.sqlite", original = source + "/file", hidden = source + "/file.hidden";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(original, "trash failure");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath); request.behavior = QStringLiteral("Move"); request.keepPolicy = QStringLiteral("Nothing");
        VerifiedCopy copy(dbPath); QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        copy.setTestHook([&](const QString &path, const QString &stage) { if (stage == QStringLiteral("before-trash")) { QVERIFY(path == original); QVERIFY(QFile::rename(path, hidden)); } });
        QVERIFY(!copy.cleanupBlocking(request, &error)); QVERIFY(error.contains("Trash cleanup failed")); QVERIFY(QFile::rename(hidden, original));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "cleanup-uncertain-kio-check"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT state,error_code FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Cleanup pending")); QCOMPARE(q.value(1).toString(), QStringLiteral("catalog_error"));
        QVERIFY(q.exec("SELECT cleanup_state FROM job_items LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("pending"));
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='failed'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1);
        q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("cleanup-uncertain-kio-check");
    }

    void cleanupDestinationLossIsRecorded() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", oldDestination = temp.path() + "/old-destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "cleanup");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath); request.behavior = QStringLiteral("Move"); request.keepPolicy = QStringLiteral("Nothing");
        VerifiedCopy copy(dbPath); QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error)); QVERIFY(QFile::remove(destination + "/file")); QVERIFY(QDir().rename(destination, oldDestination));
        QVERIFY(!copy.cleanupBlocking(request, &error)); QVERIFY(error.contains("Destination")); QVERIFY(QFileInfo::exists(source + "/file"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "cleanup-destination-loss"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db); QVERIFY(q.exec("SELECT state,error_code FROM jobs ORDER BY rowid DESC LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Cleanup pending")); QCOMPARE(q.value(1).toString(), QStringLiteral("destination_unavailable")); QVERIFY(q.exec("SELECT cleanup_state FROM job_items LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("failed")); q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("cleanup-destination-loss");
    }

    void uncertainCleanupNeverAutoCompletes() {
        QTemporaryDir temp(QDir::homePath() + "/.localdrive-test-XXXXXX"); QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "uncertain");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath); request.behavior = QStringLiteral("Move"); request.keepPolicy = QStringLiteral("Nothing");
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QSqlDatabase seed = QSqlDatabase::addDatabase("QSQLITE", "uncertain-cleanup-seed"); seed.setDatabaseName(dbPath); QVERIFY(seed.open()); QSqlQuery seedQuery(seed); QVERIFY(seedQuery.exec("UPDATE job_items SET cleanup_state='pending'")); seedQuery.finish(); seed.close(); seed = QSqlDatabase(); QSqlDatabase::removeDatabase("uncertain-cleanup-seed");
        QVERIFY(!copy.cleanupBlocking(request, &error)); QVERIFY(error.contains("uncertain"));
        VerifiedCopy routeView(dbPath); QVERIFY(routeView.previewRoute("route-test")); QTRY_VERIFY_WITH_TIMEOUT(!routeView.running(), 5000); QVERIFY(routeView.previewSuccessful()); QVERIFY(routeView.cleanupReady()); const QVariantMap uncertainPreview = routeView.cleanupPreview(); QVERIFY(uncertainPreview.value("uncertain").toBool()); QCOMPARE(uncertainPreview.value("pending").toLongLong(), 1);
        QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "uncertain-cleanup-check"); check.setDatabaseName(dbPath); QVERIFY(check.open()); QSqlQuery q(check);
        QVERIFY(q.exec("SELECT state,error_code,error_message FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Cleanup pending")); QCOMPARE(q.value(1).toString(), QStringLiteral("catalog_error")); QVERIFY(q.value(2).toString().contains("review system Trash"));
        QVERIFY(q.exec("SELECT cleanup_state FROM job_items LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("pending"));
        q.finish(); check.close(); check = QSqlDatabase(); QSqlDatabase::removeDatabase("uncertain-cleanup-check");
    }

    void retentionPolicyPreviewsOnlyExpiredSources() {
        QTemporaryDir temp(QDir::homePath() + "/.localdrive-test-XXXXXX"); QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        writeFile(source + "/recent.txt", "recent");
        writeFile(source + "/old.txt", "old");
        QFile old(source + "/old.txt"); QVERIFY(old.open(QIODevice::ReadWrite)); QVERIFY(old.setFileTime(QDateTime::currentDateTimeUtc().addDays(-2), QFileDevice::FileModificationTime)); old.close();
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        request.keepPolicy = QStringLiteral("Last day");
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QVERIFY(QFileInfo::exists(source + "/recent.txt"));
        QSqlDatabase before = QSqlDatabase::addDatabase("QSQLITE", "retention-before-cleanup"); before.setDatabaseName(request.databasePath); QVERIFY(before.open()); QSqlQuery beforeQuery(before);
        QVERIFY(beforeQuery.exec("SELECT state,keep_policy FROM jobs LIMIT 1")); QVERIFY(beforeQuery.next()); QCOMPARE(beforeQuery.value(0).toString(), QStringLiteral("Cleanup pending")); QCOMPARE(beforeQuery.value(1).toString(), QStringLiteral("Last day"));
        beforeQuery.finish(); before.close(); before = QSqlDatabase(); QSqlDatabase::removeDatabase("retention-before-cleanup");
        QVERIFY(QFileInfo::exists(source + "/recent.txt"));
        QVERIFY(QFileInfo::exists(source + "/old.txt"));
        VerifiedCopy routeView(request.databasePath); QVERIFY(routeView.previewRoute("route-test")); QTRY_VERIFY_WITH_TIMEOUT(!routeView.running(), 5000); QVERIFY(routeView.previewSuccessful());
        const QVariantMap cleanupPreview = routeView.cleanupPreview(); QCOMPARE(cleanupPreview.value("files").toLongLong(), 1); QCOMPARE(cleanupPreview.value("bytes").toLongLong(), 3);
    }

    void symlinkAndSourceChangeStaySafe() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "data");
        QVERIFY(QFile::link(source + "/file", source + "/link"));
        const QString identity = VerifiedCopy::liveStorageIdentity(destination);
        auto request = requestFor(source, destination, identity, temp.path() + "/catalog.sqlite");
        const auto preview = VerifiedCopy::inspect(request); QVERIFY(preview.ok); QCOMPARE(preview.unsupported, 1);
        VerifiedCopy copy; copy.setTestHook([](const QString &path, const QString &stage) { if (stage == "before-source-recheck") { QFile file(path); QVERIFY(file.open(QIODevice::Append)); QVERIFY(file.write("changed") > 0); } });
        QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(error.contains("changed"));
        QVERIFY(QFileInfo::exists(source + "/file")); QVERIFY(!QFileInfo::exists(destination + "/file"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "source-change-check"); db.setDatabaseName(request.databasePath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT state,error_code FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Failed")); QCOMPARE(q.value(1).toString(), QStringLiteral("source_changed"));
        QVERIFY(q.exec("SELECT event FROM history LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("failed"));
        q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("source-change-check");
    }

    void sourceChangedAfterPreviewIsRecorded() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "before");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath);
        VerifiedCopy seed(dbPath); QString seedError; QVERIFY2(seed.executeBlocking(request, &seedError), qPrintable(seedError)); QVERIFY(QFile::remove(destination + "/file"));
        VerifiedCopy copy(dbPath); QVERIFY(copy.previewRoute("route-test")); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 5000); QVERIFY(copy.previewSuccessful());
        QFile changed(source + "/file"); QVERIFY(changed.open(QIODevice::Append)); QVERIFY(changed.write("after") > 0); changed.close();
        QVERIFY(copy.startCopy()); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 10000); QVERIFY(QFileInfo::exists(source + "/file")); QVERIFY(!QFileInfo::exists(destination + "/file"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "preview-change-check"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT state,error_code,error_message FROM jobs ORDER BY created_at DESC,rowid DESC LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Failed")); QCOMPARE(q.value(1).toString(), QStringLiteral("source_changed")); QVERIFY(q.value(2).toString().contains("preview"));
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='failed'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1); q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("preview-change-check");
    }

    void destinationUnavailableAfterPreviewIsRecorded() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", oldDestination = temp.path() + "/old-destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "disk");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath);
        VerifiedCopy seed(dbPath); QString seedError; QVERIFY2(seed.executeBlocking(request, &seedError), qPrintable(seedError)); QVERIFY(QFile::remove(destination + "/file"));
        VerifiedCopy copy(dbPath); QVERIFY(copy.previewRoute("route-test")); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 5000); QVERIFY(copy.previewSuccessful());
        QVERIFY(QDir().rename(destination, oldDestination)); QVERIFY(copy.startCopy()); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 10000); QVERIFY(QFileInfo::exists(source + "/file"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "destination-change-check"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT state,error_code,error_message FROM jobs ORDER BY created_at DESC,rowid DESC LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Failed")); QCOMPARE(q.value(1).toString(), QStringLiteral("destination_unavailable")); QVERIFY(q.value(2).toString().contains("Destination"));
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='failed'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1); q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("destination-change-check");
    }

    void destinationDisconnectDuringCopyKeepsSourceSafe() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", oldDestination = temp.path() + "/old-destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", QByteArray(2 * 1024 * 1024, 'c'));
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath);
        VerifiedCopy copy; bool unplugged = false;
        copy.setTestHook([&](const QString &, const QString &stage) { if (!unplugged && stage == "during-copy") { unplugged = QDir().rename(destination, oldDestination) && QDir().mkpath(destination); } });
        QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(unplugged); QVERIFY(error.contains("storage identity"));
        QVERIFY(QDir(destination).removeRecursively()); QVERIFY(QDir().rename(oldDestination, destination)); QVERIFY(QFileInfo::exists(source + "/file")); QVERIFY(!QFileInfo::exists(destination + "/file"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "disconnect-copy-check"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT state,error_code FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Failed")); QCOMPARE(q.value(1).toString(), QStringLiteral("destination_wrong_device"));
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 0); q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("disconnect-copy-check");
    }

    void destinationDisconnectDuringVerificationKeepsSourceSafe() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", oldDestination = temp.path() + "/old-destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", QByteArray(2 * 1024 * 1024, 'v'));
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath);
        VerifiedCopy copy; bool unplugged = false;
        copy.setTestHook([&](const QString &, const QString &stage) { if (!unplugged && stage == "before-verification") { unplugged = QDir().rename(destination, oldDestination) && QDir().mkpath(destination); } });
        QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(unplugged); QVERIFY(error.contains("storage identity"));
        QVERIFY(QDir(destination).removeRecursively()); QVERIFY(QDir().rename(oldDestination, destination)); QVERIFY(QFileInfo::exists(source + "/file")); QVERIFY(!QFileInfo::exists(destination + "/file"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "disconnect-verification-check"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT state,error_code FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Failed")); QCOMPARE(q.value(1).toString(), QStringLiteral("destination_wrong_device"));
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 0); q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("disconnect-verification-check");
    }

    void publishedBeforeReceiptIsIdempotent() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "retry");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        VerifiedCopy copy; copy.setFailAfterPublishOnce(true); QString error; QVERIFY(!copy.executeBlocking(request, &error));
        QVERIFY(QFileInfo::exists(destination + "/file")); VerifiedCopy restarted(request.databasePath); QVERIFY2(restarted.executeBlocking(request, &error), qPrintable(error));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "retry-check"); db.setDatabaseName(request.databasePath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT COUNT(*) FROM locations WHERE state='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1);
        q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("retry-check");
        QVERIFY2(restarted.executeBlocking(request, &error), qPrintable(error));
        QSqlDatabase dbAgain = QSqlDatabase::addDatabase("QSQLITE", "retry-again-check"); dbAgain.setDatabaseName(request.databasePath); QVERIFY(dbAgain.open()); QSqlQuery qAgain(dbAgain);
        QVERIFY(qAgain.exec("SELECT COUNT(*) FROM history WHERE event='verified'")); QVERIFY(qAgain.next()); QCOMPARE(qAgain.value(0).toInt(), 1);
        qAgain.finish(); dbAgain.close(); dbAgain = QSqlDatabase(); QSqlDatabase::removeDatabase("retry-again-check");
    }

    void cancellationKeepsSourceAndPartialOnly() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        writeFile(source + "/a.bin", QByteArray(2 * 1024 * 1024, 'a')); writeFile(source + "/b.bin", QByteArray(2 * 1024 * 1024, 'b'));
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        VerifiedCopy copy; copy.setTestHook([&copy](const QString &path, const QString &stage) { if (stage == "before-source-recheck" && path.endsWith("/a.bin")) copy.cancel(); });
        QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(error.contains("cancelled"));
        QVERIFY(QFileInfo::exists(source + "/a.bin")); QVERIFY(QFileInfo::exists(source + "/b.bin"));
        QVERIFY(QFileInfo::exists(destination + "/a.bin")); QVERIFY(QFileInfo::exists(destination + "/b.bin") == false);
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "cancel-check"); db.setDatabaseName(request.databasePath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT state FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Cancelled"));
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='cancelled'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1);
        q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("cancel-check");
        VerifiedCopy retry; QVERIFY2(retry.executeBlocking(request, &error), qPrintable(error));
        QVERIFY(QFileInfo::exists(destination + "/a.bin")); QVERIFY(QFileInfo::exists(destination + "/b.bin"));
        QSqlDatabase retryDb = QSqlDatabase::addDatabase("QSQLITE", "cancel-retry-check"); retryDb.setDatabaseName(request.databasePath); QVERIFY(retryDb.open()); QSqlQuery retryQuery(retryDb);
        QVERIFY(retryQuery.exec("SELECT COUNT(*) FROM history WHERE event='verified'")); QVERIFY(retryQuery.next()); QCOMPARE(retryQuery.value(0).toInt(), 2);
        retryQuery.finish(); retryDb.close(); retryDb = QSqlDatabase(); QSqlDatabase::removeDatabase("cancel-retry-check");
    }

    void symlinkDestinationComponentsStayUntouched() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", outside = temp.path() + "/outside";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); QVERIFY(QDir().mkpath(outside));
        writeFile(source + "/file", "safe");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        const QString final = destination + "/file";
        QVERIFY(QFile::link(outside + "/target", final));
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error)); QVERIFY(!QFileInfo(outside + "/target").exists()); QVERIFY(QFileInfo(final).isSymLink());

        QDir(destination).removeRecursively(); QVERIFY(QDir().mkpath(destination));
        QVERIFY(QFile::link(outside, destination + "/nested"));
        auto nested = request; writeFile(source + "/nested/file", "nested");
        QVERIFY(!copy.executeBlocking(nested, &error)); QVERIFY(!QFileInfo(outside + "/file").exists());
    }

    void fifoIsUnsupportedAndNeverOpened() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/regular", "safe"); writeFile(source + "/other", "other");
        QVERIFY(::mkfifo((source + "/pipe").toLocal8Bit().constData(), 0600) == 0);
        QVERIFY(::mkfifo((destination + "/regular").toLocal8Bit().constData(), 0600) == 0);
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        const auto preview = VerifiedCopy::inspect(request); QVERIFY2(preview.ok, qPrintable(preview.error)); QCOMPARE(preview.unsupported, 1); QCOMPARE(preview.conflicts, 1);
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QVERIFY(QFileInfo::exists(destination + "/other")); QVERIFY(QFileInfo(destination + "/regular").isSymLink() == false); QVERIFY(!QFileInfo::exists(destination + "/pipe"));
    }

    void disabledOrMissingSavedRouteIsRejected() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "route");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath);
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "route-state-edit"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("UPDATE routes SET enabled=0 WHERE id='route-test'")); q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("route-state-edit");
        VerifiedCopy routeCopy(dbPath); QVERIFY(!routeCopy.previewRoute("route-test")); QVERIFY(!routeCopy.previewSuccessful());
        db = QSqlDatabase::addDatabase("QSQLITE", "route-state-edit-2"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q2(db);
        QVERIFY(q2.exec("UPDATE routes SET enabled=1")); QVERIFY(q2.exec("UPDATE storage SET presence='missing' WHERE id='disk-test'")); q2.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("route-state-edit-2");
        QVERIFY(!routeCopy.previewRoute("route-test")); QVERIFY(!routeCopy.previewSuccessful());
        QVERIFY(routeCopy.previewData().value("error").toString().contains("Waiting"));
    }

    void changedContentAfterCompleteCanBeCopiedAgain() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "one");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QVERIFY(QFile::remove(destination + "/file")); writeFile(source + "/file", "two");
        QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QFile result(destination + "/file"); QVERIFY(result.open(QIODevice::ReadOnly)); QCOMPARE(result.readAll(), QByteArray("two"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "changed-content-check"); db.setDatabaseName(request.databasePath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 2);
        q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("changed-content-check");
    }

    void lateConflictContinuesWithTruthfulLaterItems() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/a", "new-a"); writeFile(source + "/b", "new-b");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        VerifiedCopy copy; bool injected = false;
        copy.setTestHook([&](const QString &path, const QString &stage) { if (!injected && stage == "before-source-recheck" && path.endsWith("/a")) { writeFile(destination + "/a", "late-conflict"); injected = true; } });
        QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QFile later(destination + "/b"); QVERIFY(later.open(QIODevice::ReadOnly)); QCOMPARE(later.readAll(), QByteArray("new-b"));
        QFile conflict(destination + "/a"); QVERIFY(conflict.open(QIODevice::ReadOnly)); QCOMPARE(conflict.readAll(), QByteArray("late-conflict"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "late-conflict-check"); db.setDatabaseName(request.databasePath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT state FROM job_items WHERE destination_path LIKE '%/a'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Conflict"));
        QVERIFY(q.exec("SELECT state FROM job_items WHERE destination_path LIKE '%/b'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Complete"));
        QVERIFY(q.exec("SELECT state FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Conflict"));
        q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("late-conflict-check");
    }

    void forcedLedgerFailureIsSurfaced() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "ledger");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath);
        VerifiedCopy copy; bool injected = false;
        copy.setTestHook([&](const QString &path, const QString &stage) {
            if (injected || stage != "before-source-recheck") return;
            injected = true; QFile changed(path); QVERIFY(changed.open(QIODevice::Append)); QVERIFY(changed.write("changed") > 0); changed.close();
            QSqlDatabase hookDb = QSqlDatabase::addDatabase("QSQLITE", "forced-ledger"); hookDb.setDatabaseName(dbPath);
            if (hookDb.open()) { QSqlQuery q(hookDb); q.exec("CREATE TRIGGER forced_ledger_failure BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END"); q.finish(); hookDb.close(); }
            hookDb = QSqlDatabase(); QSqlDatabase::removeDatabase("forced-ledger");
        });
        QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(error.contains("Catalog terminalization failed"));
        QVERIFY(!QFileInfo::exists(destination + "/file"));
    }

    void identicalDestinationReplacementCannotBeReceipted() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "same"); writeFile(destination + "/file", "same");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        VerifiedCopy copy; bool replaced = false;
        copy.setTestHook([&](const QString &path, const QString &stage) { if (!replaced && stage == "before-existing-receipt-final-hash") { replaced = true; QVERIFY(QFile::remove(path)); writeFile(path, "replacement"); } });
        QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(error.contains("changed after final hash"));
        QFile result(destination + "/file"); QVERIFY(result.open(QIODevice::ReadOnly)); QCOMPARE(result.readAll(), QByteArray("replacement"));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "final-hash-replacement-check"); db.setDatabaseName(request.databasePath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 0);
        q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("final-hash-replacement-check");
    }

    void lateDestinationAppearanceCannotPublishAnonymousPartial() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "source");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        VerifiedCopy copy; bool appeared = false;
        copy.setTestHook([&](const QString &path, const QString &stage) { if (!appeared && stage == "before-publish") { appeared = true; writeFile(path, "wrong"); } });
        QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QFile result(destination + "/file"); QVERIFY(result.open(QIODevice::ReadOnly)); QCOMPARE(result.readAll(), QByteArray("wrong")); QVERIFY(QFileInfo::exists(source + "/file"));
    }

    void replacedRootIsRejectedBeforePublication() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", oldDestination = temp.path() + "/old-destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "root");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        VerifiedCopy copy; bool replaced = false;
        copy.setTestHook([&](const QString &, const QString &stage) { if (!replaced && stage == "before-receipt-final-hash") { replaced = true; QVERIFY(QDir().rename(destination, oldDestination)); QVERIFY(QDir().mkpath(destination)); } });
        QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(error.contains("identity changed")); QVERIFY(!QFileInfo::exists(destination + "/file")); QVERIFY(QFileInfo::exists(source + "/file"));
    }

    void renamedNestedParentIsNotPublicationAuthority() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", oldParent = temp.path() + "/old-parent";
        QVERIFY(QDir().mkpath(source + "/nested")); QVERIFY(QDir().mkpath(destination + "/nested")); writeFile(source + "/nested/file", "nested-parent");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        VerifiedCopy copy; bool replaced = false;
        copy.setTestHook([&](const QString &, const QString &stage) { if (!replaced && stage == "before-parent-refresh") { replaced = true; QVERIFY(QDir().rename(destination + "/nested", oldParent)); QVERIFY(QDir().mkpath(destination + "/nested")); } });
        QString error; QVERIFY(!copy.executeBlocking(request, &error)); QVERIFY(error.contains("parent changed")); QVERIFY(!QFileInfo::exists(destination + "/nested/file")); QVERIFY(QFileInfo::exists(source + "/nested/file"));
    }

    void verifiedCopyUpgradesSchemaVersionThree() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "migration");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), dbPath);
        VerifiedCopy first; QString error; QVERIFY2(first.executeBlocking(request, &error), qPrintable(error));
        QSqlDatabase downgrade = QSqlDatabase::addDatabase("QSQLITE", "verifiedcopy-v3"); downgrade.setDatabaseName(dbPath); QVERIFY(downgrade.open()); QSqlQuery q(downgrade); QVERIFY(q.exec("UPDATE schema_version SET version=3 WHERE singleton=1")); q.finish(); downgrade.close(); downgrade = QSqlDatabase(); QSqlDatabase::removeDatabase("verifiedcopy-v3");
        QVERIFY2(first.executeBlocking(request, &error), qPrintable(error));
        QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "verifiedcopy-v4"); check.setDatabaseName(dbPath); QVERIFY(check.open()); QSqlQuery checkQuery(check); QVERIFY(checkQuery.exec("SELECT version FROM schema_version")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toInt(), 6); QVERIFY(checkQuery.exec("SELECT content_type FROM routes WHERE id='route-test'")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toString(), QStringLiteral("Drive")); checkQuery.finish(); check.close(); check = QSqlDatabase(); QSqlDatabase::removeDatabase("verifiedcopy-v4");
    }

    void asyncRemoteDirectoryImportUsesVerifiedReceipts() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/phone", destination = temp.path() + "/destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        writeFile(source + "/nested/one.txt", "one"); writeFile(source + "/two.txt", "two");
        QVariantMap options{{"sourceUrl", QUrl::fromLocalFile(source).toString()}, {"destinationRoot", destination}, {"selectedStorageRoot", destination}, {"storageIdentity", VerifiedCopy::liveStorageIdentity(destination)}, {"filesystemType", QStorageInfo(destination).fileSystemType()}, {"routeId", "phone-route"}, {"destinationStorageId", "disk-test"}, {"sourceStorageId", "phone-storage"}, {"sourceStorageIdentity", "mtp:file-phone"}, {"sourceStorageLabel", "Test phone"}, {"sourceDeviceId", "phone-device"}, {"sourceDeviceStableId", "mtp:file-phone"}, {"sourceDeviceName", "Test phone"}, {"maxItems", 10}, {"maxBytes", 1024}};
        VerifiedCopy copy(dbPath); QSignalSpy progress(&copy, &VerifiedCopy::progressChanged); QVERIFY(copy.startRemoteImportDirectory(options)); QTRY_VERIFY_WITH_TIMEOUT(!copy.running(), 15000); QCOMPARE(copy.status(), QStringLiteral("Complete")); QVERIFY(progress.count() > 0); const QList<QVariant> lastProgress = progress.last(); QCOMPARE(lastProgress.at(0).toLongLong(), lastProgress.at(1).toLongLong());
        QVERIFY(QFileInfo::exists(destination + "/nested/one.txt")); QVERIFY(QFileInfo::exists(destination + "/two.txt"));
        QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "remote-directory-check"); check.setDatabaseName(dbPath); QVERIFY(check.open()); QSqlQuery q(check); QVERIFY(q.exec("SELECT COUNT(*) FROM locations WHERE state='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 2); QVERIFY(q.exec("SELECT COUNT(*) FROM storage WHERE kind='mtp'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1); q.finish(); check.close(); check = QSqlDatabase(); QSqlDatabase::removeDatabase("remote-directory-check");
    }

    void interruptedRemoteStreamRetainsSourceAndRetries() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/phone.bin", destination = temp.path() + "/destination", dbPath = temp.path() + "/catalog.sqlite";
        QVERIFY(QDir().mkpath(destination)); writeFile(source, QByteArray(2 * 1024 * 1024, 'w'));
        VerifiedCopy::RemoteRequest request;
        request.sourceUrl = QUrl::fromLocalFile(source); request.sourceRelative = "phone.bin"; request.destinationRoot = destination; request.destinationRelative = "phone.bin"; request.selectedStorageRoot = destination; request.storageIdentity = VerifiedCopy::liveStorageIdentity(destination); request.filesystemType = QStorageInfo(destination).fileSystemType(); request.databasePath = dbPath; request.routeId = "unreliable-remote-route"; request.destinationStorageId = "disk-test"; request.sourceStorageId = "phone-storage"; request.sourceStorageIdentity = "wireless:test-phone"; request.sourceDeviceId = "phone-device"; request.sourceDeviceStableId = "wireless:test-phone"; request.sourceDeviceName = "Test phone";
        VerifiedCopy interrupted(dbPath); bool faultInjected = false; interrupted.setTestHook([&](const QString &, const QString &stage) { if (!faultInjected && stage == "remote-during-copy") { faultInjected = true; interrupted.cancel(); } });
        QString error; QVERIFY(!interrupted.executeRemoteBlocking(request, &error)); QVERIFY(faultInjected); QVERIFY(error.contains("cancelled")); QVERIFY(QFileInfo::exists(source)); QVERIFY(!QFileInfo::exists(destination + "/phone.bin"));
        QSqlDatabase failed = QSqlDatabase::addDatabase("QSQLITE", "unreliable-remote-failed"); failed.setDatabaseName(dbPath); QVERIFY(failed.open()); QSqlQuery failedQuery(failed); QVERIFY(failedQuery.exec("SELECT state,error_code FROM jobs ORDER BY rowid DESC LIMIT 1")); QVERIFY(failedQuery.next()); QCOMPARE(failedQuery.value(0).toString(), QStringLiteral("Cancelled")); QCOMPARE(failedQuery.value(1).toString(), QStringLiteral("cancelled")); failedQuery.finish(); failed.close(); failed = QSqlDatabase(); QSqlDatabase::removeDatabase("unreliable-remote-failed");
        VerifiedCopy retry(dbPath); QVERIFY2(retry.executeRemoteBlocking(request, &error), qPrintable(error)); QVERIFY(QFileInfo::exists(destination + "/phone.bin"));
        QSqlDatabase complete = QSqlDatabase::addDatabase("QSQLITE", "unreliable-remote-complete"); complete.setDatabaseName(dbPath); QVERIFY(complete.open()); QSqlQuery completeQuery(complete); QVERIFY(completeQuery.exec("SELECT COUNT(*) FROM locations WHERE state='verified'")); QVERIFY(completeQuery.next()); QCOMPARE(completeQuery.value(0).toInt(), 1); QVERIFY(completeQuery.exec("SELECT COUNT(*) FROM history WHERE event='verified'")); QVERIFY(completeQuery.next()); QCOMPARE(completeQuery.value(0).toInt(), 1); completeQuery.finish(); complete.close(); complete = QSqlDatabase(); QSqlDatabase::removeDatabase("unreliable-remote-complete");
    }
};

QTEST_GUILESS_MAIN(VerifiedCopyTest)
#include "verifiedcopy_test.moc"
