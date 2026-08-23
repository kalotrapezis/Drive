#include <QtTest>
#include <QFile>
#include <QFileInfo>
#include <QTemporaryDir>
#include <QDir>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QStorageInfo>
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
        const auto preview = VerifiedCopy::inspect(request);
        QVERIFY2(preview.ok, qPrintable(preview.error)); QCOMPARE(preview.files, 2); QCOMPARE(preview.toCopy, 5);
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QVERIFY(QFileInfo::exists(destination + "/nested/ελληνικά.txt")); QVERIFY(QFileInfo::exists(destination + "/empty"));
        QVERIFY(QFileInfo::exists(source + "/nested/ελληνικά.txt"));
        QSqlDatabase dbCheck = QSqlDatabase::addDatabase("QSQLITE", "verified-check"); dbCheck.setDatabaseName(db); QVERIFY(dbCheck.open());
        QSqlQuery q(dbCheck); QVERIFY(q.exec("SELECT COUNT(*) FROM locations WHERE state='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 2);
        QVERIFY(q.exec("SELECT COUNT(*) FROM history WHERE event='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 2);
        QVERIFY(q.exec("SELECT event_sequence FROM devices WHERE id='local'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 2);
        q.finish(); dbCheck.close(); dbCheck = QSqlDatabase(); QSqlDatabase::removeDatabase("verified-check");
    }

    void identicalConflictAndIdentityGuards() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        writeFile(source + "/same.txt", "same"); writeFile(source + "/conflict.txt", "new");
        writeFile(destination + "/same.txt", "same"); writeFile(destination + "/conflict.txt", "old");
        const QString identity = VerifiedCopy::liveStorageIdentity(destination);
        auto request = requestFor(source, destination, identity, temp.path() + "/catalog.sqlite");
        const auto preview = VerifiedCopy::inspect(request); QVERIFY(preview.ok); QCOMPARE(preview.identical, 1); QCOMPARE(preview.conflicts, 1);
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QFile conflict(destination + "/conflict.txt"); QVERIFY(conflict.open(QIODevice::ReadOnly)); QCOMPARE(conflict.readAll(), QByteArray("old"));
        QSqlDatabase conflictDb = QSqlDatabase::addDatabase("QSQLITE", "conflict-check"); conflictDb.setDatabaseName(request.databasePath); QVERIFY(conflictDb.open()); QSqlQuery conflictQuery(conflictDb);
        QVERIFY(conflictQuery.exec("SELECT state FROM jobs LIMIT 1")); QVERIFY(conflictQuery.next()); QCOMPARE(conflictQuery.value(0).toString(), QStringLiteral("Conflict"));
        QVERIFY(conflictQuery.exec("SELECT COUNT(*) FROM history WHERE event='conflict'")); QVERIFY(conflictQuery.next()); QCOMPARE(conflictQuery.value(0).toInt(), 1);
        conflictQuery.finish(); conflictDb.close(); conflictDb = QSqlDatabase(); QSqlDatabase::removeDatabase("conflict-check");
        auto wrong = request; wrong.storageIdentity = QStringLiteral("storage:not-this-disk"); QVERIFY(!VerifiedCopy::inspect(wrong).ok);
        auto outside = request; outside.selectedStorageRoot = temp.path() + "/outside"; QVERIFY(!VerifiedCopy::inspect(outside).ok);
        auto move = request; move.behavior = QStringLiteral("Move"); QVERIFY(!VerifiedCopy::inspect(move).ok);
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
        QVERIFY(q.exec("SELECT state FROM jobs LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Failed"));
        QVERIFY(q.exec("SELECT event FROM history LIMIT 1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("failed"));
        q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("source-change-check");
    }

    void publishedBeforeReceiptIsIdempotent() {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        const QString source = temp.path() + "/source", destination = temp.path() + "/destination";
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination)); writeFile(source + "/file", "retry");
        auto request = requestFor(source, destination, VerifiedCopy::liveStorageIdentity(destination), temp.path() + "/catalog.sqlite");
        VerifiedCopy copy; copy.setFailAfterPublishOnce(true); QString error; QVERIFY(!copy.executeBlocking(request, &error));
        QVERIFY(QFileInfo::exists(destination + "/file")); QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "retry-check"); db.setDatabaseName(request.databasePath); QVERIFY(db.open()); QSqlQuery q(db);
        QVERIFY(q.exec("SELECT COUNT(*) FROM locations WHERE state='verified'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1);
        q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("retry-check");
        QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));
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
};

QTEST_GUILESS_MAIN(VerifiedCopyTest)
#include "verifiedcopy_test.moc"
