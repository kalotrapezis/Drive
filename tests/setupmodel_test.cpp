#include <QtTest>
#include <QTemporaryDir>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QSqlError>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStorageInfo>
#include <QUdpSocket>
#include <algorithm>
#include "../src/setupmodel.h"

class SetupModelTest : public QObject {
    Q_OBJECT
private slots:
    void mtpEntryUrlFallsBackToEntryNames() {
        const QUrl device = SetupModel::mtpEntryUrl(QUrl(QStringLiteral("mtp:/")), QStringLiteral("Xiaomi 15"), {});
        QCOMPARE(device.scheme(), QStringLiteral("mtp"));
        QCOMPARE(device.path(QUrl::FullyDecoded), QStringLiteral("/Xiaomi 15"));
        const QUrl storage = SetupModel::mtpEntryUrl(device, QStringLiteral("Internal shared storage"), {});
        QCOMPARE(storage.path(QUrl::FullyDecoded), QStringLiteral("/Xiaomi 15/Internal shared storage"));
        const QUrl reported(QStringLiteral("mtp:/usb:001,019/store:1"));
        QCOMPARE(SetupModel::mtpEntryUrl(device, QStringLiteral("ignored"), reported.toString()), reported);
    }
    void mtpIdentityUsesOnlyUniqueUsbSerialEvidence() {
        const QVariantMap first{{"detectedProduct", "Xiaomi 15"}, {"serialIdentity", "usb:first"}};
        const QVariantMap second{{"detectedProduct", "Xiaomi 15"}, {"serialIdentity", "usb:second"}};
        QCOMPARE(SetupModel::mtpStableIdentity("Xiaomi 15", {}, {first}), QStringLiteral("mtp:usb:first"));
        QVERIFY(SetupModel::mtpStableIdentity("Xiaomi 15", {}, {first, second}).isEmpty());
        QVERIFY(SetupModel::mtpStableIdentity("Other phone", {}, {first}).isEmpty());
        QCOMPARE(SetupModel::mtpStableIdentity("Xiaomi 15", "mtp:/usb:001,019/store:1", {first, second}), QStringLiteral("mtp:/usb:001,019/store:1"));
    }
    void reportsUserAvailableStorageCapacity() {
        QTemporaryDir d; QVERIFY(d.isValid());
        SetupModel model(d.filePath("catalog.sqlite"), {QVariantMap{{"id", "disk"}, {"label", "Disk"}, {"root", d.path()}, {"present", true}, {"kind", "removable"}}});
        const QStorageInfo home(QDir::homePath());
        const QVariantList storages = model.storages();
        const auto local = std::find_if(storages.cbegin(), storages.cend(), [](const QVariant &value) { return value.toMap().value("id") == "local"; });
        QVERIFY(local != storages.cend());
        QVERIFY(qAbs(local->toMap().value("bytesFree").toLongLong() - qint64(home.bytesAvailable())) <= 16 * 1024 * 1024);
    }
    void yearRetentionMigratesExistingCatalog() {
        QTemporaryDir d; QVERIFY(d.isValid()); const QString path = d.filePath("old.sqlite");
        {
            auto db = QSqlDatabase::addDatabase("QSQLITE", "year-upgrade"); db.setDatabaseName(path); QVERIFY(db.open()); QSqlQuery q(db);
            QFile schema(":/src/catalog/schema.sql"); QVERIFY(schema.open(QIODevice::ReadOnly));
            QString sql = QString::fromUtf8(schema.readAll()).replace("VALUES (1, 18)", "VALUES (1, 17)").replace("'Last year', ", "");
            QString statement; bool trigger = false;
            for (const auto &line : sql.split('\n')) {
                statement += line + '\n';
                if (statement.trimmed().startsWith("CREATE TRIGGER")) trigger = true;
                if (!line.trimmed().endsWith(';') || (trigger && line.trimmed() != "END;")) continue;
                QVERIFY2(q.exec(statement), qPrintable(q.lastError().text())); statement.clear(); trigger = false;
            }
            QVERIFY(q.exec("INSERT INTO devices(id,stable_id,name,kind,is_local) VALUES('local','local','Computer','Desktop',1)"));
            QVERIFY(q.exec("INSERT INTO storage(id,stable_identity,device_id,kind,label,selected_root,presence) VALUES('local','local','local','local','Computer','/','present'),('disk','disk','local','removable','Disk','/tmp','missing')"));
            QVERIFY(q.exec("INSERT INTO routes(id,source_storage_id,destination_storage_id,source_root,destination_root) VALUES('saved','local','disk','/source','/destination')"));
            QVERIFY(q.exec("INSERT INTO jobs(id,route_id,behavior,state,source_path,destination_path) VALUES('job','saved','Copy','Complete','/source','/destination')"));
            QVERIFY(q.exec("INSERT INTO history(id,origin_device_id,catalog_generation,origin_sequence,job_id,event) VALUES('history','local',1,1,'job','queued')"));
        }
        QSqlDatabase::removeDatabase("year-upgrade");
        SetupModel model(path); QVERIFY2(model.ready(), qPrintable(model.errorMessage()));
        QVERIFY2(model.updateRouteCard("saved", "Move", "Last year", false), qPrintable(model.errorMessage()));
        QCOMPARE(model.routes().first().toMap().value("keepPolicy").toString(), QStringLiteral("Last year"));
        {
            auto db = QSqlDatabase::addDatabase("QSQLITE", "year-check"); db.setDatabaseName(path); QVERIFY(db.open()); QSqlQuery q(db);
            QVERIFY(q.exec("SELECT job_id FROM history WHERE id='history'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("job"));
            QVERIFY(q.exec("UPDATE jobs SET keep_policy='Last year' WHERE id='job'"));
            QVERIFY(q.exec("PRAGMA foreign_key_check")); QVERIFY(!q.next());
        }
        QSqlDatabase::removeDatabase("year-check");
    }
    void removalStopsRoutesAndSurvivesRestart() {
        QTemporaryDir d; QVERIFY(d.isValid());
        const QString source = d.filePath("source"), destination = d.filePath("disk/Drive"), dbPath = d.filePath("catalog.sqlite");
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        QString route;
        {
            SetupModel model(dbPath, {QVariantMap{{"id", "disk"}, {"label", "Disk"}, {"root", d.filePath("disk")}, {"present", true}, {"kind", "removable"}}});
            QVERIFY(model.saveRoute(source, "disk", destination)); route = model.routes().first().toMap().value("id").toString();
            QVERIFY(!model.removeDevice("local")); QVERIFY(!model.removeDevice("missing"));
            QVERIFY(model.removeDevice("disk")); QVERIFY(model.routes().isEmpty()); QVERIFY(model.hiddenDevices().isEmpty());
            QVERIFY(model.routeExists(route)); QVERIFY(QFileInfo::exists(source)); QVERIFY(QFileInfo::exists(destination));
        }
        SetupModel model(dbPath); QVERIFY(model.ready()); QVERIFY(model.deviceRemoved("disk"));
        QVERIFY(model.routes().isEmpty()); QVERIFY(model.hiddenDevices().isEmpty()); QVERIFY(!model.showDevice("disk"));
        QVERIFY(model.routeExists(route));
    }
    void duplicateRoutesAndRemoval() {
        QTemporaryDir d; QVERIFY(d.isValid());
        const QString source = d.filePath("source"), destination = d.filePath("disk/Drive"), dbPath = d.filePath("catalog.sqlite");
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        {
            SetupModel model(dbPath, {QVariantMap{{"id", "disk"}, {"label", "Disk"}, {"root", d.filePath("disk")}, {"present", true}, {"kind", "removable"}}});
            QVERIFY(model.saveRoute(source, "disk", destination));
            QVERIFY(!model.saveRoute(source + "/.", "disk", destination)); QCOMPARE(model.configRevision(), 1);
            const QString otherSource = d.filePath("other-source"), otherDestination = d.filePath("disk/other-destination");
            QVERIFY(QDir().mkpath(otherSource)); QVERIFY(QDir().mkpath(otherDestination));
            QVERIFY(!model.saveRoute(otherSource, "disk", destination));
            QVERIFY(!model.saveRoute(source, "disk", otherDestination));
            QVERIFY(!model.saveRoute(otherSource, "disk", otherDestination, "Nothing", 1024));
            QCOMPARE(model.routes().size(), 1); QCOMPARE(model.configRevision(), 1);
            QCOMPARE(model.routes().first().toMap().value("source").toString(), source);
            QCOMPARE(model.routes().first().toMap().value("destination").toString(), destination);
            QCOMPARE(model.routes().first().toMap().value("keepPolicy").toString(), QStringLiteral("Everything"));
            {
                auto db = QSqlDatabase::addDatabase("QSQLITE", "source-device-duplicate"); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db);
                QVERIFY(q.exec("INSERT INTO storage(id,stable_identity,device_id,kind,label,selected_root) VALUES('local-alias','local-alias','local','local','Other local volume','/')"));
                QVERIFY(q.exec("UPDATE routes SET source_storage_id='local-alias'"));
            }
            QSqlDatabase::removeDatabase("source-device-duplicate");
            QVERIFY(!model.saveRoute(otherSource, "disk", otherDestination)); QCOMPARE(model.configRevision(), 1);
            QVERIFY(!model.acknowledgeDevice("disk", true)); QVERIFY(!model.acknowledgeDevice("local", true));
        }
        SetupModel model(dbPath); QVERIFY(model.ready()); QCOMPARE(model.routes().size(), 1);
        model.refreshRoutes(); model.refreshRoutes(); QCOMPARE(model.routes().size(), 1);
        const QString id = model.routes().first().toMap().value("id").toString();
        int status = 0; QVERIFY(model.removeRoute(id, &status)); QCOMPARE(status, 200); QVERIFY(model.routes().isEmpty()); QVERIFY(model.routeExists(id));
        QCOMPARE(model.contentRoot("Drive"), source);
        const int revision = model.configRevision(); QVERIFY(model.removeRoute(id, &status)); QCOMPARE(model.configRevision(), revision);
        QVERIFY(model.acknowledgeDevice("disk", true)); QVERIFY(model.showDevice("disk")); QVERIFY(QFileInfo::exists(destination));
    }
    void routeCardPropertiesPersist() {
        QTemporaryDir d; QVERIFY(d.isValid()); QDir source(d.filePath("Drive")), disk(d.filePath("disk")), destination(d.filePath("disk/Drive")); QVERIFY(source.mkpath(".")); QVERIFY(destination.mkpath("."));
        const QString db = d.filePath("catalog.sqlite"); SetupModel model(db, {QVariantMap{{"id", "disk"}, {"label", "Disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}}); model.setHomeRootForTest(d.path()); QVERIFY(model.ready()); QVERIFY(model.setHubConfig(true, 80)); QVERIFY(model.saveRoute(source.path(), "disk", destination.path()));
        const QString id = model.routes().first().toMap().value("id").toString(); QVERIFY(model.updateRouteCard(id, "Move", "Last week", true)); const QVariantMap route = model.routes().first().toMap(); QCOMPARE(route.value("behavior").toString(), QStringLiteral("Move")); QCOMPARE(route.value("keepPolicy").toString(), QStringLiteral("Last week")); QVERIFY(route.value("stagingMaxBytes").toLongLong() > 0); QCOMPARE(route.value("stagingRoot").toString(), source.path()); QCOMPARE(route.value("cacheLimitPercent").toInt(), 80);
        QVERIFY(model.updateRouteCard(id, "Move", "Last week", true, 73));
        QVERIFY(model.updateRouteCard(id, "Move", "Last week", false));
        QCOMPARE(model.routes().first().toMap().value("cacheLimitPercent").toInt(), 73);
        QVERIFY(model.updateRouteCard(id, "Move", "Last week", true));
        QCOMPARE(model.routes().first().toMap().value("cacheLimitPercent").toInt(), 73);
        QVERIFY(!model.updateRouteCard(id, "Move", "Last week", true, 96)); QVERIFY(!model.updateRouteCard(id, "Copy", "Last week", false));
        QVERIFY(model.cloneDriveMapToPhotos());
        for (const auto &entry : model.routes()) { const auto cloned = entry.toMap(); if (cloned.value("contentType") == "Photos") { QCOMPARE(cloned.value("cacheLimitPercent").toInt(), 73); QCOMPARE(cloned.value("stagingRoot"), cloned.value("source")); } }
        SetupModel reopened(db); QVERIFY(reopened.ready());
        for (const auto &entry : reopened.routes()) QCOMPARE(entry.toMap().value("cacheLimitPercent").toInt(), 73);
    }

    void changingPolicySettlesOnlyUntouchedCleanup() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.filePath("Drive")), disk(d.filePath("disk")), destination(d.filePath("disk/Drive"));
        QVERIFY(source.mkpath(".")); QVERIFY(destination.mkpath("."));
        const QString dbPath = d.filePath("catalog.sqlite");
        SetupModel model(dbPath, {QVariantMap{{"id", "disk"}, {"label", "Disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}});
        QVERIFY(model.saveRoute(source.path(), "disk", destination.path(), "Last week"));
        const QString routeId = model.routes().first().toMap().value("id").toString();
        auto seedCleanup = [&](const QString &jobId, const QString &cleanupState) {
            const QString connection = QStringLiteral("cleanup-policy-%1").arg(jobId);
            QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", connection); db.setDatabaseName(dbPath); QVERIFY(db.open()); QSqlQuery q(db);
            q.prepare("INSERT INTO jobs(id,route_id,behavior,keep_policy,state,source_path,destination_path,bytes_total,bytes_done) VALUES(?,?,?,?,?,?,?,?,?)");
            q.addBindValue(jobId); q.addBindValue(routeId); q.addBindValue("Copy"); q.addBindValue("Last week"); q.addBindValue("Cleanup pending"); q.addBindValue(source.path()); q.addBindValue(destination.path()); q.addBindValue(1); q.addBindValue(1); QVERIFY(q.exec());
            q.prepare("INSERT INTO job_items(id,job_id,source_path,destination_path,expected_size,expected_sha256,bytes_done,state,destination_sha256,verified_at,cleanup_state) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
            q.addBindValue(jobId + "-item"); q.addBindValue(jobId); q.addBindValue(source.filePath("file")); q.addBindValue(destination.filePath("file")); q.addBindValue(1); q.addBindValue(QString(64, QChar('a'))); q.addBindValue(1); q.addBindValue("Complete"); q.addBindValue(QString(64, QChar('a'))); q.addBindValue("2026-09-06T00:00:00Z"); q.addBindValue(cleanupState); QVERIFY(q.exec());
            q.finish(); db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase(connection);
        };
        seedCleanup("untouched", "not_requested");
        QVERIFY2(model.updateRouteCard(routeId, "Copy", "Everything", false), qPrintable(model.errorMessage()));
        QCOMPARE(model.routes().first().toMap().value("jobState").toString(), QStringLiteral("Complete"));
        QVERIFY(model.updateRouteCard(routeId, "Move", "Last week", false));
        seedCleanup("uncertain", "pending");
        QVERIFY(!model.updateRouteCard(routeId, "Copy", "Everything", false));
        QVERIFY(model.errorMessage().contains(QStringLiteral("previous cleanup")));
        QCOMPARE(model.routes().first().toMap().value("keepPolicy").toString(), QStringLiteral("Last week"));
        QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "cleanup-policy-check"); check.setDatabaseName(dbPath); QVERIFY(check.open()); QSqlQuery q(check);
        QVERIFY(q.exec("SELECT state FROM jobs WHERE id='untouched'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Complete"));
        QVERIFY(q.exec("SELECT state FROM jobs WHERE id='uncertain'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Cleanup pending"));
        q.finish(); check.close(); check = QSqlDatabase(); QSqlDatabase::removeDatabase("cleanup-policy-check");
    }

    void cloneRejectsLegacyDuplicateRoutesAtomically() {
        QTemporaryDir d; QVERIFY(d.isValid());
        const QString source = d.filePath("Local Drive/Drive"), destination = d.filePath("disk/Local Drive/Drive");
        QVERIFY(QDir().mkpath(source)); QVERIFY(QDir().mkpath(destination));
        SetupModel model(d.filePath("catalog.sqlite"), {QVariantMap{{"id", "disk"}, {"label", "Disk"}, {"root", d.filePath("disk")}, {"present", true}, {"kind", "removable"}}}); model.setHomeRootForTest(d.path());
        QVERIFY(model.saveRoute(source, "disk", destination));
        {
            auto db = QSqlDatabase::addDatabase("QSQLITE", "legacy-duplicate-test"); db.setDatabaseName(model.databasePath()); QVERIFY(db.open()); QSqlQuery q(db);
            QVERIFY(q.exec("INSERT INTO routes(id,source_storage_id,destination_storage_id,source_root,destination_root,content_type) SELECT 'legacy-duplicate',source_storage_id,destination_storage_id,source_root,destination_root,content_type FROM routes LIMIT 1"));
        }
        QSqlDatabase::removeDatabase("legacy-duplicate-test"); model.refreshRoutes(); QCOMPARE(model.routes().size(), 2);
        QVERIFY(!model.cloneDriveMapToPhotos()); model.refreshRoutes(); QCOMPARE(model.routes().size(), 2); QCOMPARE(model.configRevision(), 1);
        QVERIFY(!QFileInfo::exists(d.filePath("Local Drive/Photos"))); QVERIFY(!QFileInfo::exists(d.filePath("disk/Local Drive/Photos")));
    }

    void hubConfigPersistsAndRejectsUnsafeLimits() {
        QTemporaryDir d; QVERIFY(d.isValid()); const QString db = d.filePath("catalog.sqlite");
        { SetupModel model(db, {}); QVERIFY(model.ready()); QVERIFY(!model.hubEnabled()); QCOMPARE(model.hubLimitPercent(), 80); QVERIFY(model.setHubConfig(true, 75)); QVERIFY(model.hubEnabled()); QCOMPARE(model.hubLimitPercent(), 75); QVERIFY(!model.setHubConfig(true, 96)); QCOMPARE(model.hubLimitPercent(), 75); }
        { SetupModel model(db, {}); QVERIFY(model.ready()); QVERIFY(model.hubEnabled()); QCOMPARE(model.hubLimitPercent(), 75); }
    }

    void initAndRoutes() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.path()+"/source"), selectedRoot(d.path()+"/selected"), destination(d.path()+"/selected/target"), staging(d.path()+"/staging"), outside(d.path()+"/outside"), insideSource(d.path()+"/selected/source"); QVERIFY(source.mkpath(".")); QVERIFY(selectedRoot.mkpath(".")); QVERIFY(destination.mkpath(".")); QVERIFY(staging.mkpath(".")); QVERIFY(outside.mkpath(".")); QVERIFY(insideSource.mkpath("."));
        QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"filesystemType", "testfs"}, {"root", selectedRoot.path()}, {"present", true}, {"kind", "removable"}}};
        const QString db = d.path()+"/catalog.sqlite";
        { SetupModel model(db, disks); QVERIFY(model.ready()); QVERIFY(!model.localDeviceName().isEmpty()); QVERIFY2(model.storages().size() == 2, qPrintable(model.errorMessage())); QCOMPARE(model.storages().at(1).toMap().value("filesystemType").toString(), QStringLiteral("testfs")); QVERIFY2(model.saveRoute(source.path(), "disk", destination.path(), "Everything"), qPrintable(model.errorMessage())); QVERIFY2(model.saveRoute(source.path(), "disk", destination.path(), "Last week", 4 * 1024 * 1024, true, 8 * 1024 * 1024, staging.path(), "Photos"), qPrintable(model.errorMessage())); QCOMPARE(model.configRevision(), 2); }
        QSqlDatabase filesystem = QSqlDatabase::addDatabase("QSQLITE", "filesystem-check"); filesystem.setDatabaseName(db); QVERIFY(filesystem.open()); QSqlQuery filesystemQuery(filesystem); QVERIFY(filesystemQuery.exec("SELECT filesystem_type FROM storage WHERE id='disk'")); QVERIFY(filesystemQuery.next()); QCOMPARE(filesystemQuery.value(0).toString(), QStringLiteral("testfs")); filesystem.close(); filesystem = QSqlDatabase(); QSqlDatabase::removeDatabase("filesystem-check");
        { SetupModel model(db, disks); QVERIFY(model.ready()); QCOMPARE(model.storages().size(), 2); QCOMPARE(model.routes().size(), 2); QCOMPARE(model.routes().at(0).toMap().value("contentType").toString(), QStringLiteral("Drive")); QCOMPARE(model.routes().at(1).toMap().value("contentType").toString(), QStringLiteral("Photos")); QCOMPARE(model.routes().at(1).toMap().value("keepPolicy").toString(), QStringLiteral("Last week")); QCOMPARE(model.routes().at(1).toMap().value("behavior").toString(), QStringLiteral("Copy")); QCOMPARE(model.routes().at(1).toMap().value("minimumFreeBytes").toLongLong(), 4 * 1024 * 1024); QCOMPARE(model.routes().at(1).toMap().value("stagingMaxBytes").toLongLong(), 8 * 1024 * 1024); QCOMPARE(model.routes().at(1).toMap().value("stagingRoot").toString(), staging.canonicalPath()); QVERIFY(model.routes().at(1).toMap().value("organizePhotos").toBool()); const QString routeId = model.routes().at(0).toMap().value("id").toString(); QVERIFY(model.updateRouteRelationship(routeId, true, false, false)); QCOMPARE(model.routes().at(0).toMap().value("keepPolicy").toString(), QStringLiteral("Nothing")); QCOMPARE(model.routes().at(0).toMap().value("behavior").toString(), QStringLiteral("Move")); QVERIFY(!model.updateRouteRelationship(routeId, true, true, true)); { QSqlDatabase count = QSqlDatabase::addDatabase("QSQLITE", "count-check"); count.setDatabaseName(db); QVERIFY(count.open()); QSqlQuery q(count); QVERIFY(q.exec("SELECT COUNT(*) FROM devices WHERE is_local=1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1); count.close(); } QSqlDatabase::removeDatabase("count-check"); const int revision = model.configRevision(); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Everything", 0, false, 0, {}, "Archive")); QCOMPARE(model.configRevision(), revision); QVERIFY(!model.saveRoute(source.path(), "missing", destination.path(), "Everything")); QVERIFY(!model.saveRoute(source.path(), "disk", outside.path(), "Everything")); QVERIFY(!model.saveRoute(insideSource.path(), "disk", destination.path(), "Everything")); QVERIFY(!model.saveRoute(source.path(), "disk", source.path(), "Everything")); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Bad")); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Everything", -1)); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Everything", 0, false, -1)); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Everything", 0, false, 0, source.path())); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Everything", 0, false, 0, destination.path())); }
        { QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "trigger-check"); check.setDatabaseName(db); QVERIFY(check.open()); { QSqlQuery q(check); QVERIFY(q.exec("INSERT INTO history(id,origin_device_id,catalog_generation,origin_sequence,event) VALUES('h','local',1,1,'queued')")); QVERIFY(!q.exec("UPDATE history SET event='failed'")); QVERIFY(!q.exec("DELETE FROM history")); } check.close(); }
        QSqlDatabase::removeDatabase("trigger-check");
        { SetupModel remembered(db); QVariantMap disk; for (const auto &value : remembered.storages()) if (value.toMap().value("id") == "disk") disk = value.toMap(); QCOMPARE(disk.value("identity").toString(), QStringLiteral("storage:disk")); }
    }

    void deviceVisibilityPersistsWithoutTouchingRoutes() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir root(d.path() + "/disk"); QVERIFY(root.mkpath("."));
        const QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"filesystemType", "testfs"}, {"root", root.path()}, {"present", true}, {"kind", "removable"}}};
        const QString db = d.path() + "/catalog.sqlite";
        { SetupModel model(db, disks); QVERIFY(model.ready()); QCOMPARE(model.firstSeenDevices().size(), 1); QCOMPARE(model.firstSeenDevices().first().toMap().value("category").toString(), QStringLiteral("storage")); QVERIFY(model.acknowledgeDevice("disk", true)); QCOMPARE(model.storages().size(), 1); QVERIFY(model.firstSeenDevices().isEmpty()); QCOMPARE(model.hiddenDevices().size(), 1); }
        { SetupModel model(db, disks); QVERIFY(model.ready()); QCOMPARE(model.storages().size(), 1); QCOMPARE(model.hiddenDevices().size(), 1); QVERIFY(model.showDevice("disk")); QCOMPARE(model.storages().size(), 2); QVERIFY(model.hiddenDevices().isEmpty()); QVERIFY(model.firstSeenDevices().isEmpty()); }
    }

    void filesMapClonesOnceToIndependentPhotosMap() {
        QTemporaryDir d; QVERIFY(d.isValid()); QDir source(d.path() + "/Local Drive/Drive"), disk(d.path() + "/disk"), destination(d.path() + "/disk/Local Drive/Drive"); QVERIFY(source.mkpath(".")); QVERIFY(disk.mkpath(".")); QVERIFY(destination.mkpath("."));
        SetupModel model(d.path() + "/catalog.sqlite", {QVariantMap{{"id", "disk"}, {"label", "Disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}}); model.setHomeRootForTest(d.path()); QVERIFY(model.ready());
        QVERIFY(model.saveRoute(source.path(), "disk", destination.path(), "Last week", 123, false, 456, {}, "Drive"));
        QVERIFY2(model.cloneDriveMapToPhotos(), qPrintable(model.errorMessage())); QCOMPARE(model.routes().size(), 2); const QVariantMap photos = model.routes().last().toMap(); QCOMPARE(photos.value("contentType").toString(), QStringLiteral("Photos")); QCOMPARE(photos.value("storageId").toString(), QStringLiteral("disk")); QCOMPARE(photos.value("keepPolicy").toString(), QStringLiteral("Last week")); QCOMPARE(photos.value("minimumFreeBytes").toLongLong(), 123); QCOMPARE(photos.value("stagingMaxBytes").toLongLong(), 456); QVERIFY(photos.value("organizePhotos").toBool()); QVERIFY(QFileInfo::exists(d.path() + "/Local Drive/Photos")); QVERIFY(QFileInfo::exists(d.path() + "/disk/Local Drive/Photos"));
        QVERIFY(!model.cloneDriveMapToPhotos());
    }

    void offlineStorageRouteIsSavedWaitingWithoutCreatingFolders() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.path() + "/source"); QVERIFY(source.mkpath("."));
        const QString root = d.path() + "/offline-disk", destination = root + "/Drive";
        const QVariantList disks{QVariantMap{{"id", "disk"}, {"identity", "storage:offline-uuid"}, {"label", "Offline disk"}, {"root", root}, {"present", false}, {"kind", "removable"}}};
        const QString db = d.path() + "/catalog.sqlite";
        { SetupModel model(db, disks); QVERIFY(model.ready()); QVERIFY(model.saveRoute(source.path(), "disk", destination, "Everything")); QCOMPARE(model.routes().first().toMap().value("jobState").toString(), QStringLiteral("Waiting")); QCOMPARE(model.routes().first().toMap().value("destination").toString(), QDir::cleanPath(destination)); QCOMPARE(model.routes().first().toMap().value("storageIdentity").toString(), QStringLiteral("storage:offline-uuid")); QVERIFY(!QFileInfo::exists(destination)); }
        { SetupModel model(db, disks); QVERIFY(model.ready()); QCOMPARE(model.routes().size(), 1); QCOMPARE(model.routes().first().toMap().value("jobState").toString(), QStringLiteral("Waiting")); QVERIFY(!QFileInfo::exists(destination)); }
    }

    void rejectsProtectedEfiStorage() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.path() + "/source"); QVERIFY(source.mkpath("."));
        const QVariantList disks{QVariantMap{{"id", "efi"}, {"label", "efi"}, {"root", "/boot/efi"}, {"present", false}, {"kind", "removable"}}};
        SetupModel model(d.path() + "/catalog.sqlite", disks); QVERIFY(model.ready());
        QVERIFY(!model.saveRoute(source.path(), "efi", "/boot/efi/Local Drive", "Everything"));
        QVERIFY(model.errorMessage().contains(QStringLiteral("EFI")));
    }

    void savesInitialRoutesAtomicallyWithDistinctRoots() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.path() + "/source"), disk(d.path() + "/disk"), parent(d.path() + "/disk/Local Drive");
        QVERIFY(source.mkpath(".")); QVERIFY(parent.mkpath("."));
        const QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}};
        SetupModel model(d.path() + "/catalog.sqlite", disks); model.setHomeRootForTest(d.path()); QVERIFY(model.ready());
        QVERIFY2(model.saveInitialRoutes(source.path(), "disk", parent.path(), "Last week", 1024, true, 2048), qPrintable(model.errorMessage()));
        QCOMPARE(model.routes().size(), 2); QCOMPARE(model.configRevision(), 1);
        QCOMPARE(model.routes().at(0).toMap().value("source").toString(), source.path() + "/Drive");
        QCOMPARE(model.routes().at(1).toMap().value("source").toString(), source.path() + "/Photos");
        QCOMPARE(model.routes().at(0).toMap().value("destination").toString(), parent.path() + "/Drive");
        QCOMPARE(model.routes().at(1).toMap().value("destination").toString(), parent.path() + "/Photos");
        QVERIFY(QFileInfo::exists(source.path() + "/Drive")); QVERIFY(QFileInfo::exists(source.path() + "/Photos"));
        QVERIFY(QFileInfo::exists(parent.path() + "/Drive")); QVERIFY(QFileInfo::exists(parent.path() + "/Photos"));
        QCOMPARE(model.routes().at(1).toMap().value("keepPolicy").toString(), QStringLiteral("Last week"));
        QVERIFY(model.routes().at(1).toMap().value("organizePhotos").toBool());
        QVERIFY(!model.saveInitialRoutes(source.path(), "disk", parent.path()));
        QCOMPARE(model.routes().size(), 2); QCOMPARE(model.configRevision(), 1);
    }

    void initialRoutesRollBackFoldersWhenCatalogInsertFails() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.path() + "/source"), disk(d.path() + "/disk"), parent(d.path() + "/disk/Local Drive");
        QVERIFY(source.mkpath(".")); QVERIFY(parent.mkpath("."));
        const QString dbPath = d.path() + "/catalog.sqlite";
        const QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", disk.path()}, {"present", true}, {"kind", "removable"}}};
        SetupModel model(dbPath, disks); model.setHomeRootForTest(d.path()); QVERIFY(model.ready());
        QSqlDatabase lock = QSqlDatabase::addDatabase("QSQLITE", "initial-routes-lock"); lock.setDatabaseName(dbPath); QVERIFY(lock.open()); QSqlQuery q(lock); QVERIFY(q.exec("BEGIN EXCLUSIVE"));
        QVERIFY(!model.saveInitialRoutes(source.path(), "disk", parent.path()));
        QVERIFY(q.exec("ROLLBACK")); lock.close(); lock = QSqlDatabase(); QSqlDatabase::removeDatabase("initial-routes-lock");
        QVERIFY(!QFileInfo::exists(source.path() + "/Drive")); QVERIFY(!QFileInfo::exists(source.path() + "/Photos"));
        QVERIFY(!QFileInfo::exists(parent.path() + "/Drive")); QVERIFY(!QFileInfo::exists(parent.path() + "/Photos")); QCOMPARE(model.routes().size(), 0);
    }

    void unsupportedVersion() {
        QTemporaryDir d; QVERIFY(d.isValid()); const QString db = d.path() + "/bad.sqlite";
        { QSqlDatabase bad = QSqlDatabase::addDatabase("QSQLITE", "bad-schema"); bad.setDatabaseName(db); QVERIFY(bad.open()); QSqlQuery q(bad); QVERIFY(q.exec("CREATE TABLE schema_version(singleton INTEGER PRIMARY KEY, version INTEGER)")); QVERIFY(q.exec("INSERT INTO schema_version VALUES(1,99)")); }
        QSqlDatabase::removeDatabase("bad-schema");
        SetupModel model(db); QVERIFY(!model.ready()); QVERIFY(model.errorMessage().contains("Unsupported"));
    }

    void refreshRoutesShowsLatestJobState() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.path() + "/source"), root(d.path() + "/disk"), destination(d.path() + "/disk/target");
        QVERIFY(source.mkpath(".")); QVERIFY(root.mkpath(".")); QVERIFY(destination.mkpath("."));
        const QString dbPath = d.path() + "/catalog.sqlite";
        QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", root.path()}, {"present", true}, {"kind", "removable"}}};
        SetupModel model(dbPath, disks); QVERIFY(model.ready()); QVERIFY(model.saveRoute(source.path(), "disk", destination.path(), "Everything"));
        const QString routeId = model.routes().first().toMap().value("id").toString();
        QSqlDatabase state = QSqlDatabase::addDatabase("QSQLITE", "route-state"); state.setDatabaseName(dbPath); QVERIFY(state.open()); QSqlQuery q(state);
        q.prepare("INSERT INTO jobs(id,route_id,behavior,keep_policy,state,source_path,destination_path,bytes_total,error_code,error_message) VALUES(?,?,?,?,?,?,?,?,?,?)");
        q.addBindValue("state-job"); q.addBindValue(routeId); q.addBindValue("Copy"); q.addBindValue("Everything"); q.addBindValue("Conflict"); q.addBindValue(source.path()); q.addBindValue(destination.path()); q.addBindValue(0); q.addBindValue("name_conflict"); q.addBindValue("destination differs"); QVERIFY(q.exec());
        q.finish(); state.close(); state = QSqlDatabase(); QSqlDatabase::removeDatabase("route-state");
        model.refreshRoutes(); QCOMPARE(model.routes().first().toMap().value("jobState").toString(), QStringLiteral("Conflict")); QCOMPARE(model.routes().first().toMap().value("jobErrorCode").toString(), QStringLiteral("name_conflict")); QCOMPARE(model.routes().first().toMap().value("jobError").toString(), QStringLiteral("destination differs"));
    }

    void recoversInterruptedJobsOnCatalogOpen() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.path() + "/source"), root(d.path() + "/disk"), destination(d.path() + "/disk/target");
        QVERIFY(source.mkpath(".")); QVERIFY(root.mkpath(".")); QVERIFY(destination.mkpath("."));
        const QString dbPath = d.path() + "/catalog.sqlite";
        QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", root.path()}, {"present", true}, {"kind", "removable"}}};
        QString routeId;
        { SetupModel model(dbPath, disks); QVERIFY(model.ready()); QVERIFY(model.saveRoute(source.path(), "disk", destination.path(), "Everything")); routeId = model.routes().first().toMap().value("id").toString(); }
        { QSqlDatabase state = QSqlDatabase::addDatabase("QSQLITE", "interrupted-seed"); state.setDatabaseName(dbPath); QVERIFY(state.open()); QSqlQuery q(state);
          q.prepare("INSERT INTO jobs(id,route_id,behavior,keep_policy,state,source_path,destination_path,bytes_total) VALUES(?,?,?,?,?,?,?,?)"); q.addBindValue("interrupted-job"); q.addBindValue(routeId); q.addBindValue("Copy"); q.addBindValue("Everything"); q.addBindValue("Copying"); q.addBindValue(source.path()); q.addBindValue(destination.path()); q.addBindValue(4); QVERIFY(q.exec());
          q.prepare("INSERT INTO job_items(id,job_id,source_path,destination_path,expected_size,state) VALUES(?,?,?,?,?,?)"); q.addBindValue("interrupted-item"); q.addBindValue("interrupted-job"); q.addBindValue(source.path() + "/file"); q.addBindValue(destination.path() + "/file"); q.addBindValue(4); q.addBindValue("Copying"); QVERIFY(q.exec());
          q.finish(); state.close(); state = QSqlDatabase(); QSqlDatabase::removeDatabase("interrupted-seed"); }
        { SetupModel model(dbPath, disks); QVERIFY(model.ready()); QCOMPARE(model.routes().first().toMap().value("jobState").toString(), QStringLiteral("Failed")); QCOMPARE(model.routes().first().toMap().value("jobErrorCode").toString(), QStringLiteral("interrupted")); }
        QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "interrupted-check"); check.setDatabaseName(dbPath); QVERIFY(check.open()); QSqlQuery q(check);
        QVERIFY(q.exec("SELECT state,error_code FROM jobs WHERE id='interrupted-job'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Failed")); QCOMPARE(q.value(1).toString(), QStringLiteral("interrupted"));
        QVERIFY(q.exec("SELECT state FROM job_items WHERE id='interrupted-item'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("Failed"));
        QVERIFY(q.exec("SELECT event,result FROM history WHERE job_id='interrupted-job'")); QVERIFY(q.next()); QCOMPARE(q.value(0).toString(), QStringLiteral("failed")); QVERIFY(q.value(1).toString().contains("retry is safe"));
        q.prepare("INSERT INTO jobs(id,route_id,behavior,keep_policy,state,source_path,destination_path,bytes_total) VALUES(?,?,?,?,?,?,?,?)"); q.addBindValue("receipt-before-final-job"); q.addBindValue(routeId); q.addBindValue("Copy"); q.addBindValue("Everything"); q.addBindValue("Copying"); q.addBindValue(source.path()); q.addBindValue(destination.path()); q.addBindValue(4); QVERIFY(q.exec());
        q.prepare("INSERT INTO job_items(id,job_id,source_path,destination_path,expected_size,expected_sha256,destination_sha256,verified_at,state) VALUES(?,?,?,?,?,?,?,?,?)"); q.addBindValue("receipt-before-final-item"); q.addBindValue("receipt-before-final-job"); q.addBindValue(source.path() + "/file"); q.addBindValue(destination.path() + "/file"); q.addBindValue(4); q.addBindValue(QString(64, QChar('a'))); q.addBindValue(QString(64, QChar('a'))); q.addBindValue("2026-08-25T00:00:00Z"); q.addBindValue("Complete"); QVERIFY(q.exec());
        q.finish(); check.close(); check = QSqlDatabase(); QSqlDatabase::removeDatabase("interrupted-check");
        { SetupModel model(dbPath, disks); QVERIFY(model.ready()); QCOMPARE(model.routes().first().toMap().value("jobState").toString(), QStringLiteral("Complete")); }
    }

    void migratesSchemaVersionOne() {
        QTemporaryDir d; QVERIFY(d.isValid()); const QString dbPath = d.path() + "/v1.sqlite";
        QSqlDatabase old = QSqlDatabase::addDatabase("QSQLITE", "old-schema"); old.setDatabaseName(dbPath); QVERIFY(old.open()); QSqlQuery q(old);
        QVERIFY(q.exec("CREATE TABLE schema_version(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, installed_at TEXT)")); QVERIFY(q.exec("INSERT INTO schema_version VALUES(1,1,CURRENT_TIMESTAMP)"));
        QVERIFY(q.exec("CREATE TABLE app_config(singleton INTEGER PRIMARY KEY, config_revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT)")); QVERIFY(q.exec("INSERT INTO app_config(singleton) VALUES(1)"));
        QVERIFY(q.exec("CREATE TABLE devices(id TEXT PRIMARY KEY, stable_id TEXT UNIQUE, name TEXT, kind TEXT, is_local INTEGER DEFAULT 0)"));
        QVERIFY(q.exec("CREATE TABLE storage(id TEXT PRIMARY KEY, stable_identity TEXT UNIQUE, device_id TEXT, kind TEXT, label TEXT, selected_root TEXT, presence TEXT)"));
        QVERIFY(q.exec("CREATE TABLE routes(id TEXT PRIMARY KEY, source_storage_id TEXT, destination_storage_id TEXT, source_root TEXT, destination_root TEXT, behavior TEXT NOT NULL DEFAULT 'Copy', enabled INTEGER DEFAULT 1, created_at TEXT)"));
        QVERIFY(q.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY, route_id TEXT, behavior TEXT, state TEXT, source_path TEXT, destination_path TEXT, bytes_total INTEGER, created_at TEXT, error_message TEXT)"));
        QVERIFY(q.exec("INSERT INTO routes(id,source_storage_id,destination_storage_id,source_root,destination_root,behavior,enabled,created_at) VALUES('legacy-route','local','disk','/source','/destination','Move',1,CURRENT_TIMESTAMP)"));
        QVERIFY(q.exec("INSERT INTO jobs(id,route_id,behavior,state,source_path,destination_path,bytes_total) VALUES('legacy-job','legacy-route','Move','Queued','/source','/destination',0)"));
        old.close(); old = QSqlDatabase(); QSqlDatabase::removeDatabase("old-schema");
        SetupModel model(dbPath); QVERIFY(model.ready());
        QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "migrated-schema"); check.setDatabaseName(dbPath); QVERIFY(check.open()); QSqlQuery checkQuery(check);
        QVERIFY(checkQuery.exec("SELECT version FROM schema_version")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toInt(), 19); QVERIFY(checkQuery.exec("SELECT COUNT(*) FROM review_items")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toInt(), 0); QVERIFY(checkQuery.exec("SELECT COUNT(*) FROM managed_inventory")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toInt(), 0); QVERIFY(checkQuery.exec("SELECT COUNT(*) FROM review_resolutions")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toInt(), 0);
        QVERIFY(checkQuery.exec("SELECT keep_policy FROM routes WHERE id='legacy-route'")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toString(), QStringLiteral("Nothing"));
        QVERIFY(checkQuery.exec("SELECT staging_max_bytes,staging_root,minimum_free_bytes,organize_photos,content_type FROM routes WHERE id='legacy-route'")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toLongLong(), 0); QVERIFY(checkQuery.value(1).isNull()); QCOMPARE(checkQuery.value(2).toLongLong(), 0); QCOMPARE(checkQuery.value(3).toInt(), 0); QCOMPARE(checkQuery.value(4).toString(), QStringLiteral("Drive"));
        QVERIFY(checkQuery.exec("PRAGMA table_info(storage)")); bool hasFilesystemType = false; while (checkQuery.next()) hasFilesystemType = hasFilesystemType || checkQuery.value(1).toString() == QStringLiteral("filesystem_type"); QVERIFY(hasFilesystemType);
        check.close(); check = QSqlDatabase(); QSqlDatabase::removeDatabase("migrated-schema");
    }

    void migrationInfersPhotoContentTypeFromLegacyOrganization() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.path() + "/source"), root(d.path() + "/disk"), destination(d.path() + "/disk/target");
        QVERIFY(source.mkpath(".")); QVERIFY(root.mkpath(".")); QVERIFY(destination.mkpath("."));
        const QString dbPath = d.path() + "/catalog.sqlite";
        QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", root.path()}, {"present", true}, {"kind", "removable"}}};
        QString routeId;
        { SetupModel model(dbPath, disks); QVERIFY(model.ready()); QVERIFY(model.saveRoute(source.path(), "disk", destination.path(), "Everything")); routeId = model.routes().first().toMap().value("id").toString(); }
        QSqlDatabase downgrade = QSqlDatabase::addDatabase("QSQLITE", "photo-migration-downgrade"); downgrade.setDatabaseName(dbPath); QVERIFY(downgrade.open()); QSqlQuery q(downgrade); q.prepare("UPDATE schema_version SET version=3 WHERE singleton=1"); QVERIFY(q.exec()); q.prepare("UPDATE routes SET content_type='Drive',organize_photos=1 WHERE id=?"); q.addBindValue(routeId); QVERIFY(q.exec()); q.finish(); downgrade.close(); downgrade = QSqlDatabase(); QSqlDatabase::removeDatabase("photo-migration-downgrade");
        SetupModel migrated(dbPath, disks); QVERIFY(migrated.ready()); QCOMPARE(migrated.routes().first().toMap().value("contentType").toString(), QStringLiteral("Photos"));
    }

    void wirelessBeaconReusesPairedMtpIdentity() {
        QTemporaryDir d; QVERIFY(d.isValid());
        const QString dbPath = d.path() + "/catalog.sqlite";
        { SetupModel model(dbPath); QVERIFY(model.ready()); }
        QSqlDatabase seed = QSqlDatabase::addDatabase("QSQLITE", "wireless-identity-seed"); seed.setDatabaseName(dbPath); QVERIFY(seed.open()); QSqlQuery q(seed);
        QVERIFY(q.exec("INSERT INTO devices(id,stable_id,name,kind,is_local) VALUES('mtp-phone','mtp:Xiaomi 15','Xiaomi 15','Phone',0)"));
        QVERIFY(q.exec("INSERT INTO device_aliases(alias,device_id,transport) VALUES('mtp:Xiaomi 15','mtp-phone','mtp')"));
        q.finish(); seed.close(); seed = QSqlDatabase(); QSqlDatabase::removeDatabase("wireless-identity-seed");
        SetupModel model(dbPath); QVERIFY(model.ready());
        model.setMtpDevicesForTest({QVariantMap{{"id", "mtp-phone"}, {"stableIdentity", "mtp:Xiaomi 15"}, {"label", "Xiaomi 15"}, {"kind", "mtp"}, {"transport", "mtp"}, {"present", true}, {"status", "Online"}, {"url", "mtp:/Xiaomi 15"}, {"phoneRoot", "mtp:/Xiaomi 15"}}});
        const QVariantMap beacon{{"stableIdentity", "wireless:xiaomi-15"}, {"label", "Xiaomi 15"}, {"endpoint", "192.168.1.10:4317"}, {"rssi", -58}};
        QVERIFY(model.ingestWirelessBeacon(beacon)); QVERIFY(model.ingestWirelessBeacon(beacon));
        QCOMPARE(model.wirelessDevices().size(), 1); const QString candidateId = model.wirelessDevices().first().toMap().value("id").toString(); QVERIFY(candidateId != QStringLiteral("mtp-phone"));
        QVERIFY(model.pairWirelessDevice(candidateId, QStringLiteral("mtp-phone")));
        QCOMPARE(model.wirelessDevices().size(), 1); QCOMPARE(model.wirelessDevices().first().toMap().value("id").toString(), QStringLiteral("mtp-phone"));
        QCOMPARE(model.connectedDevices().size(), 1);
        const QVariantMap combined = model.connectedDevices().first().toMap();
        QVERIFY(combined.value("transports").toStringList().contains("mtp"));
        QVERIFY(combined.value("transports").toStringList().contains("wireless"));
        QCOMPARE(combined.value("status").toString(), QStringLiteral("Online"));
        QVariantMap expiredWireless = model.wirelessDevices().first().toMap(); expiredWireless.insert("present", false); expiredWireless.insert("status", "Offline"); expiredWireless.insert("lastSeenMs", 0);
        model.setWirelessDevicesForTest({expiredWireless});
        QCOMPARE(model.connectedDevices().size(), 1);
        QCOMPARE(model.connectedDevices().first().toMap().value("status").toString(), QStringLiteral("Online"));
        bool targetVisible = false, candidateVisible = false;
        for (const auto &device : model.deviceList()) { targetVisible = targetVisible || device.toMap().value("id") == QStringLiteral("mtp-phone"); candidateVisible = candidateVisible || device.toMap().value("id") == candidateId; }
        QVERIFY(targetVisible); QVERIFY(!candidateVisible);
        bool targetNeedsOnboarding = false;
        for (const auto &device : model.firstSeenDevices()) targetNeedsOnboarding = targetNeedsOnboarding || device.toMap().value("id") == QStringLiteral("mtp-phone");
        QVERIFY(!targetNeedsOnboarding);
        QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "wireless-identity-check"); check.setDatabaseName(dbPath); QVERIFY(check.open()); QSqlQuery checkQuery(check);
        QVERIFY(checkQuery.exec("SELECT COUNT(*) FROM devices WHERE is_local=0 AND hidden=0")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toInt(), 1);
        QVERIFY(checkQuery.exec("SELECT COUNT(*) FROM device_aliases WHERE device_id='mtp-phone'")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toInt(), 2);
        QVERIFY(checkQuery.exec("SELECT transport FROM device_aliases WHERE alias='wireless:xiaomi-15'")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toString(), QStringLiteral("wireless"));
        check.close(); check = QSqlDatabase(); QSqlDatabase::removeDatabase("wireless-identity-check");
    }

    void chargingOnlyUsbIsTemporaryAndMtpWins() {
        QTemporaryDir d; QVERIFY(d.isValid());
        SetupModel model(d.path() + "/catalog.sqlite"); QVERIFY(model.ready());
        model.setMtpDevicesForTest({});
        model.setUsbConnectionsForTest({QVariantMap{{"id", "usb-charge-test"}, {"label", "Phone"}, {"kind", "Phone"}, {"transport", "usb"}, {"present", true}, {"status", "Charging only"}}});
        QCOMPARE(model.connectedDevices().size(), 1);
        QCOMPARE(model.connectedDevices().first().toMap().value("status").toString(), QStringLiteral("Charging only"));
        QVERIFY(model.deviceList().isEmpty());
        model.setMtpDevicesForTest({QVariantMap{{"id", "mtp-test"}, {"stableIdentity", "mtp:Xiaomi 15"}, {"label", "Xiaomi 15"}, {"kind", "Phone"}, {"transport", "mtp"}, {"present", true}, {"status", "Online"}}});
        QCOMPARE(model.connectedDevices().size(), 1);
        QCOMPARE(model.connectedDevices().first().toMap().value("label").toString(), QStringLiteral("Xiaomi 15"));

        QVERIFY(model.observeWirelessTransfer("wireless:hidden", "Hidden phone"));
        const QString hiddenId = model.wirelessDevices().last().toMap().value("id").toString();
        QVERIFY(model.acknowledgeDevice(hiddenId, true));
        model.setMtpDevicesForTest({});
        model.setUsbConnectionsForTest({QVariantMap{{"id", "usb-hidden"}, {"label", "Phone"}, {"detectedProduct", "Hidden phone"}, {"kind", "Phone"}, {"transport", "usb"}, {"present", true}, {"status", "Charging only"}}});
        QVERIFY(model.connectedDevices().isEmpty());
    }

    void wirelessCandidateCanPairAfterMtpAppears() {
        QTemporaryDir d; QVERIFY(d.isValid());
        SetupModel model(d.path() + "/catalog.sqlite"); QVERIFY(model.ready());
        model.setUsbConnectionsForTest({});
        QVERIFY(model.ingestWirelessBeacon(QVariantMap{{"stableIdentity", "wireless:late-usb"}, {"label", "Late USB phone"}}));
        const QString candidateId = model.wirelessDevices().first().toMap().value("id").toString();
        QVERIFY(!candidateId.isEmpty());
        QVERIFY(model.connectedDevices().size() == 1);

#ifdef LOCAL_DRIVE_TESTING
        QSqlDatabase seed = QSqlDatabase::addDatabase("QSQLITE", "late-mtp-seed"); seed.setDatabaseName(d.path() + "/catalog.sqlite"); QVERIFY(seed.open()); QSqlQuery seedQuery(seed);
        QVERIFY(seedQuery.exec("INSERT INTO devices(id,stable_id,name,kind,is_local) VALUES('mtp-late-phone','mtp:late-phone','Late USB phone','Phone',0)"));
        QVERIFY(seedQuery.exec("INSERT INTO device_aliases(alias,device_id,transport) VALUES('mtp:late-phone','mtp-late-phone','mtp')"));
        seedQuery.finish(); seed.close(); seed = QSqlDatabase(); QSqlDatabase::removeDatabase("late-mtp-seed");
        model.setMtpDevicesForTest({QVariantMap{{"id", "mtp-late-phone"}, {"stableIdentity", "mtp:late-phone"}, {"label", "Late USB phone"}, {"kind", "mtp"}, {"transport", "mtp"}, {"present", true}, {"status", "Online"}}});
#endif
        QCOMPARE(model.connectedDevices().size(), 2);
        QVERIFY(model.pairWirelessDevice(candidateId, QStringLiteral("mtp-late-phone")));
        QCOMPARE(model.connectedDevices().size(), 1);
        const QVariantMap merged = model.connectedDevices().first().toMap();
        QCOMPARE(merged.value("id").toString(), QStringLiteral("mtp-late-phone"));
        QVERIFY(merged.value("transports").toStringList().contains("mtp"));
        QVERIFY(merged.value("transports").toStringList().contains("wireless"));
    }

    void wirelessUdpDiscoveryDeduplicatesBeacon() {
        QTemporaryDir d; QVERIFY(d.isValid());
        SetupModel model(d.path() + "/catalog.sqlite"); QVERIFY(model.ready());
        QUdpSocket sender;
        const auto send = [&sender](const QJsonObject &object) {
            const QByteArray payload = QJsonDocument(object).toJson(QJsonDocument::Compact);
            return sender.writeDatagram(payload, QHostAddress::LocalHost, SetupModel::wirelessDiscoveryPort()) == payload.size();
        };
        QVERIFY(send(QJsonObject{{"magic", "not-local-drive"}, {"stableIdentity", "wireless:ignored"}, {"label", "Ignored"}}));
        QTest::qWait(100);
        QVERIFY(model.wirelessDevices().isEmpty());
        const QJsonObject beacon{{"magic", "local-drive-discovery-v1"}, {"protocol", 1}, {"stableIdentity", "wireless:sim-phone"}, {"label", "Simulated phone"}, {"endpoint", "127.0.0.1:43171"}, {"rssi", -42}};
        QVERIFY(send(beacon)); QTRY_VERIFY_WITH_TIMEOUT(model.wirelessDevices().size() == 1, 2000);
        QVERIFY(send(beacon)); QTRY_VERIFY_WITH_TIMEOUT(model.wirelessDevices().size() == 1, 2000);
        const QString wirelessId = model.wirelessDevices().first().toMap().value("id").toString();
        int wirelessOccurrences = 0; for (const auto &device : model.connectedDevices()) if (device.toMap().value("id").toString() == wirelessId) ++wirelessOccurrences;
        QCOMPARE(wirelessOccurrences, 1);
        QCOMPARE(model.wirelessDevices().first().toMap().value("status").toString(), QStringLiteral("Online"));
        QCOMPARE(model.wirelessDevices().first().toMap().value("endpoint").toString(), QStringLiteral("127.0.0.1:43171"));
        QTRY_VERIFY_WITH_TIMEOUT(model.wirelessDevices().first().toMap().value("status").toString() == QStringLiteral("Offline"), 20000);
    }

    void rememberedWirelessCandidateCanPairAfterRestart() {
        QTemporaryDir d; QVERIFY(d.isValid());
        const QString dbPath = d.path() + "/catalog.sqlite";
        QString candidateId;
        { SetupModel model(dbPath); QVERIFY(model.ready()); QVERIFY(model.ingestWirelessBeacon(QVariantMap{{"stableIdentity", "wireless:remembered"}, {"label", "Remembered phone"}})); candidateId = model.wirelessDevices().first().toMap().value("id").toString(); }
        QSqlDatabase seed = QSqlDatabase::addDatabase("QSQLITE", "remembered-pair-seed"); seed.setDatabaseName(dbPath); QVERIFY(seed.open()); QSqlQuery q(seed); QVERIFY(q.exec("INSERT INTO devices(id,stable_id,name,kind,is_local) VALUES('mtp-phone-2','mtp:Remembered','Remembered phone','Phone',0)")); q.finish(); seed.close(); seed = QSqlDatabase(); QSqlDatabase::removeDatabase("remembered-pair-seed");
        { SetupModel model(dbPath); QVERIFY(model.ready()); QVERIFY(model.pairWirelessDevice(candidateId, QStringLiteral("mtp-phone-2"))); QCOMPARE(model.wirelessDevices().first().toMap().value("id").toString(), QStringLiteral("mtp-phone-2")); }
        { SetupModel model(dbPath); QVERIFY(model.ready()); model.setMtpDevicesForTest({QVariantMap{{"id", "mtp-phone-2"}, {"stableIdentity", "mtp:Remembered"}, {"label", "Remembered phone"}, {"kind", "mtp"}, {"transport", "mtp"}, {"present", true}, {"status", "Online"}}}); QVERIFY(model.ingestWirelessBeacon(QVariantMap{{"stableIdentity", "wireless:remembered"}, {"label", "Remembered phone"}})); QCOMPARE(model.connectedDevices().size(), 1); const QVariantMap merged = model.connectedDevices().first().toMap(); QCOMPARE(merged.value("id").toString(), QStringLiteral("mtp-phone-2")); QVERIFY(merged.value("transports").toStringList().contains("mtp")); QVERIFY(merged.value("transports").toStringList().contains("wireless")); int visible = 0; for (const auto &device : model.deviceList()) if (device.toMap().value("id").toString() == QStringLiteral("mtp-phone-2")) ++visible; QCOMPARE(visible, 1); }
    }
};
QTEST_GUILESS_MAIN(SetupModelTest)
#include "setupmodel_test.moc"
