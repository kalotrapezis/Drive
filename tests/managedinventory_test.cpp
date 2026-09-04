#include <QtTest>
#include <QDir>
#include <QFile>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QTemporaryDir>

#include "../src/managedinventory.h"
#include "../src/setupmodel.h"
#include "../src/verifiedcopy.h"

namespace {
void writeFile(const QString &path, const QByteArray &contents)
{
    QFile file(path);
    QVERIFY2(file.open(QIODevice::WriteOnly | QIODevice::Truncate), qPrintable(file.errorString()));
    QCOMPARE(file.write(contents), contents.size());
}

int count(QSqlQuery &query, const QString &table)
{
    if (!query.exec(QStringLiteral("SELECT COUNT(*) FROM %1").arg(table)) || !query.next()) return -1;
    return query.value(0).toInt();
}
}

class ManagedInventoryTest final : public QObject {
    Q_OBJECT

private slots:
    void recordsManualChangesOnce()
    {
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        QDir source(temp.path() + "/Drive"), disk(temp.path() + "/disk"), destination(temp.path() + "/disk/Drive");
        QVERIFY(source.mkpath("."));
        QVERIFY(destination.mkpath("."));

        const QString databasePath = temp.path() + "/catalog.sqlite";
        const QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}};
        QString routeId;
        {
            SetupModel model(databasePath, disks);
            QVERIFY2(model.ready(), qPrintable(model.errorMessage()));
            QVERIFY2(model.saveRoute(source.path(), "disk", destination.path(), "Everything", 0, false, 0, {}, "Drive"), qPrintable(model.errorMessage()));
            routeId = model.routes().first().toMap().value("id").toString();
        }

        const QString path = source.filePath("manual.txt");
        writeFile(path, "first");
        QString error;
        QVariantMap result = LocalDrive::ManagedInventory::scan(databasePath, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error));
        QCOMPARE(result.value("added").toInt(), 1);

        QSqlDatabase database = QSqlDatabase::addDatabase("QSQLITE", "managed-inventory-check");
        database.setDatabaseName(databasePath);
        QVERIFY(database.open());
        QSqlQuery query(database);
        query.prepare("SELECT content_sha256,state FROM managed_inventory WHERE route_id=? AND relative_path='manual.txt'");
        query.addBindValue(routeId);
        QVERIFY(query.exec());
        QVERIFY(query.next());
        const QString originalHash = query.value(0).toString();
        QCOMPARE(originalHash.size(), 64);
        QCOMPARE(query.value(1).toString(), QStringLiteral("present"));
        QVERIFY(query.exec("SELECT previous_sha256,current_sha256 FROM inventory_events WHERE event='added'"));
        QVERIFY(query.next());
        QVERIFY(query.value(0).isNull());
        QCOMPARE(query.value(1).toString(), originalHash);
        QCOMPARE(count(query, "inventory_events"), 1);
        const int initialReviews = count(query, "review_items");
        QVERIFY(initialReviews > 0);
        query.finish();

        error.clear();
        result = LocalDrive::ManagedInventory::scan(databasePath, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error));
        QCOMPARE(result.value("added").toInt(), 0);
        QCOMPARE(result.value("changed").toInt(), 0);
        QCOMPARE(result.value("missing").toInt(), 0);
        QCOMPARE(count(query, "inventory_events"), 1);
        QCOMPARE(count(query, "review_items"), initialReviews);
        query.finish();

        writeFile(path, "second version");
        error.clear();
        result = LocalDrive::ManagedInventory::scan(databasePath, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error));
        QCOMPARE(result.value("changed").toInt(), 1);
        QVERIFY(query.exec("SELECT previous_sha256,current_sha256 FROM inventory_events WHERE event='changed'"));
        QVERIFY(query.next());
        QCOMPARE(query.value(0).toString(), originalHash);
        const QString changedHash = query.value(1).toString();
        QVERIFY(!changedHash.isEmpty());
        QVERIFY(changedHash != originalHash);
        query.finish();

        QVERIFY(QFile::remove(path));
        error.clear();
        result = LocalDrive::ManagedInventory::scan(databasePath, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error));
        QCOMPARE(result.value("missing").toInt(), 1);
        query.prepare("SELECT content_sha256,state FROM managed_inventory WHERE route_id=? AND relative_path='manual.txt'");
        query.addBindValue(routeId);
        QVERIFY(query.exec());
        QVERIFY(query.next());
        QCOMPARE(query.value(0).toString(), changedHash);
        QCOMPARE(query.value(1).toString(), QStringLiteral("missing"));
        QVERIFY(query.exec("SELECT previous_sha256,current_sha256 FROM inventory_events WHERE event='missing'"));
        QVERIFY(query.next());
        QCOMPARE(query.value(0).toString(), changedHash);
        QVERIFY(query.value(1).isNull());

        query.finish();
        database.close();
        database = QSqlDatabase();
        QSqlDatabase::removeDatabase("managed-inventory-check");
    }

    void watcherDetectsNewFile()
    {
        QTemporaryDir temp;
        QVERIFY(temp.isValid());
        QDir source(temp.path() + "/Drive"), disk(temp.path() + "/disk"), destination(temp.path() + "/disk/Drive");
        QVERIFY(source.mkpath("."));
        QVERIFY(destination.mkpath("."));
        const QString databasePath = temp.path() + "/catalog.sqlite";
        const QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}};
        SetupModel model(databasePath, disks);
        QVERIFY(model.ready());
        QVERIFY(model.saveRoute(source.path(), "disk", destination.path()));

        ManagedRootWatcher watcher(databasePath);
        QSignalSpy changed(&watcher, &ManagedRootWatcher::inventoryChanged);
        watcher.refresh();
        QVERIFY(changed.wait(5000));
        changed.clear();
        writeFile(source.filePath("watched.txt"), "watched");
        QVERIFY(changed.wait(5000));

        QSqlDatabase database = QSqlDatabase::addDatabase("QSQLITE", "managed-watcher-check");
        database.setDatabaseName(databasePath);
        QVERIFY(database.open());
        QSqlQuery query(database);
        QVERIFY(query.exec("SELECT COUNT(*) FROM managed_inventory WHERE relative_path='watched.txt' AND state='present'"));
        QVERIFY(query.next());
        QCOMPARE(query.value(0).toInt(), 1);
        query.finish(); database.close(); database = QSqlDatabase();
        QSqlDatabase::removeDatabase("managed-watcher-check");
    }

    void receiptBackedImportIsNotReportedAsExternal()
    {
        QTemporaryDir temp; QVERIFY(temp.isValid());
        QDir source(temp.path() + "/Drive"), imported(temp.path() + "/Import"), disk(temp.path() + "/disk"), destination(temp.path() + "/disk/Drive");
        QVERIFY(source.mkpath(".")); QVERIFY(imported.mkpath(".")); QVERIFY(destination.mkpath(".")); writeFile(imported.filePath("known.txt"), "verified import");
        const QString databasePath = temp.path() + "/catalog.sqlite";
        const QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}};
        SetupModel model(databasePath, disks); QVERIFY(model.ready()); QVERIFY(model.saveRoute(source.path(), "disk", destination.path()));

        VerifiedCopy::Request request;
        request.sourceRoot = imported.path(); request.destinationRoot = source.path(); request.selectedStorageRoot = source.path();
        request.storageIdentity = VerifiedCopy::liveStorageIdentity(source.path()); request.databasePath = databasePath;
        request.routeId = "import-drive-test"; request.destinationStorageId = "local"; request.sourceStorageId = "external-import-test";
        request.sourceStorageIdentity = "folder:test"; request.routeEnabled = false; request.contentType = "Drive";
        VerifiedCopy copy; QString error; QVERIFY2(copy.executeBlocking(request, &error), qPrintable(error));

        const QVariantMap result = LocalDrive::ManagedInventory::scan(databasePath, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error)); QCOMPARE(result.value("added").toInt(), 0);
        QSqlDatabase database = QSqlDatabase::addDatabase("QSQLITE", "managed-receipt-check"); database.setDatabaseName(databasePath); QVERIFY(database.open()); QSqlQuery query(database);
        QVERIFY(query.exec("SELECT COUNT(*) FROM managed_inventory WHERE relative_path='known.txt' AND state='present'")); QVERIFY(query.next()); QCOMPARE(query.value(0).toInt(), 1);
        QVERIFY(query.exec("SELECT COUNT(*) FROM inventory_events")); QVERIFY(query.next()); QCOMPARE(query.value(0).toInt(), 0);
        QVERIFY(query.exec("SELECT COUNT(*) FROM review_items")); QVERIFY(query.next()); QCOMPARE(query.value(0).toInt(), 0);
        query.finish(); database.close(); database = QSqlDatabase(); QSqlDatabase::removeDatabase("managed-receipt-check");
    }
};

QTEST_GUILESS_MAIN(ManagedInventoryTest)
#include "managedinventory_test.moc"
