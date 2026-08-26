#include <QtTest>
#include <QTemporaryDir>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QJsonDocument>
#include <QJsonObject>
#include <QUdpSocket>
#include "../src/setupmodel.h"

class SetupModelTest : public QObject {
    Q_OBJECT
private slots:
    void initAndRoutes() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.path()+"/source"), selectedRoot(d.path()+"/selected"), destination(d.path()+"/selected/target"), staging(d.path()+"/staging"), outside(d.path()+"/outside"), insideSource(d.path()+"/selected/source"); QVERIFY(source.mkpath(".")); QVERIFY(selectedRoot.mkpath(".")); QVERIFY(destination.mkpath(".")); QVERIFY(staging.mkpath(".")); QVERIFY(outside.mkpath(".")); QVERIFY(insideSource.mkpath("."));
        QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"filesystemType", "testfs"}, {"root", selectedRoot.path()}, {"present", true}, {"kind", "removable"}}};
        const QString db = d.path()+"/catalog.sqlite";
        { SetupModel model(db, disks); QVERIFY(model.ready()); QVERIFY(!model.localDeviceName().isEmpty()); QVERIFY2(model.storages().size() == 2, qPrintable(model.errorMessage())); QCOMPARE(model.storages().at(1).toMap().value("filesystemType").toString(), QStringLiteral("testfs")); QVERIFY2(model.saveRoute(source.path(), "disk", destination.path(), "Everything"), qPrintable(model.errorMessage())); QVERIFY2(model.saveRoute(source.path(), "disk", destination.path(), "Last week", 4 * 1024 * 1024, true, 8 * 1024 * 1024, staging.path(), "Photos"), qPrintable(model.errorMessage())); QCOMPARE(model.configRevision(), 2); }
        QSqlDatabase filesystem = QSqlDatabase::addDatabase("QSQLITE", "filesystem-check"); filesystem.setDatabaseName(db); QVERIFY(filesystem.open()); QSqlQuery filesystemQuery(filesystem); QVERIFY(filesystemQuery.exec("SELECT filesystem_type FROM storage WHERE id='disk'")); QVERIFY(filesystemQuery.next()); QCOMPARE(filesystemQuery.value(0).toString(), QStringLiteral("testfs")); filesystem.close(); filesystem = QSqlDatabase(); QSqlDatabase::removeDatabase("filesystem-check");
        { SetupModel model(db, disks); QVERIFY(model.ready()); QCOMPARE(model.storages().size(), 2); QCOMPARE(model.routes().size(), 2); QCOMPARE(model.routes().at(0).toMap().value("contentType").toString(), QStringLiteral("Drive")); QCOMPARE(model.routes().at(1).toMap().value("contentType").toString(), QStringLiteral("Photos")); QCOMPARE(model.routes().at(1).toMap().value("keepPolicy").toString(), QStringLiteral("Last week")); QCOMPARE(model.routes().at(1).toMap().value("behavior").toString(), QStringLiteral("Copy")); QCOMPARE(model.routes().at(1).toMap().value("minimumFreeBytes").toLongLong(), 4 * 1024 * 1024); QCOMPARE(model.routes().at(1).toMap().value("stagingMaxBytes").toLongLong(), 8 * 1024 * 1024); QCOMPARE(model.routes().at(1).toMap().value("stagingRoot").toString(), staging.canonicalPath()); QVERIFY(model.routes().at(1).toMap().value("organizePhotos").toBool()); { QSqlDatabase count = QSqlDatabase::addDatabase("QSQLITE", "count-check"); count.setDatabaseName(db); QVERIFY(count.open()); QSqlQuery q(count); QVERIFY(q.exec("SELECT COUNT(*) FROM devices WHERE is_local=1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1); count.close(); } QSqlDatabase::removeDatabase("count-check"); const int revision = model.configRevision(); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Everything", 0, false, 0, {}, "Archive")); QCOMPARE(model.configRevision(), revision); QVERIFY(!model.saveRoute(source.path(), "missing", destination.path(), "Everything")); QVERIFY(!model.saveRoute(source.path(), "disk", outside.path(), "Everything")); QVERIFY(!model.saveRoute(insideSource.path(), "disk", destination.path(), "Everything")); QVERIFY(!model.saveRoute(source.path(), "disk", source.path(), "Everything")); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Bad")); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Everything", -1)); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Everything", 0, false, -1)); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Everything", 0, false, 0, source.path())); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Everything", 0, false, 0, destination.path())); }
        { QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "trigger-check"); check.setDatabaseName(db); QVERIFY(check.open()); { QSqlQuery q(check); QVERIFY(q.exec("INSERT INTO history(id,origin_device_id,catalog_generation,origin_sequence,event) VALUES('h','local',1,1,'queued')")); QVERIFY(!q.exec("UPDATE history SET event='failed'")); QVERIFY(!q.exec("DELETE FROM history")); } check.close(); }
        QSqlDatabase::removeDatabase("trigger-check");
    }

    void deviceVisibilityPersistsWithoutTouchingRoutes() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir root(d.path() + "/disk"); QVERIFY(root.mkpath("."));
        const QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"filesystemType", "testfs"}, {"root", root.path()}, {"present", true}, {"kind", "removable"}}};
        const QString db = d.path() + "/catalog.sqlite";
        { SetupModel model(db, disks); QVERIFY(model.ready()); QCOMPARE(model.firstSeenDevices().size(), 1); QCOMPARE(model.firstSeenDevices().first().toMap().value("category").toString(), QStringLiteral("storage")); QVERIFY(model.acknowledgeDevice("disk", true)); QCOMPARE(model.storages().size(), 1); QVERIFY(model.firstSeenDevices().isEmpty()); QCOMPARE(model.hiddenDevices().size(), 1); }
        { SetupModel model(db, disks); QVERIFY(model.ready()); QCOMPARE(model.storages().size(), 1); QCOMPARE(model.hiddenDevices().size(), 1); QVERIFY(model.showDevice("disk")); QCOMPARE(model.storages().size(), 2); QVERIFY(model.hiddenDevices().isEmpty()); QVERIFY(model.firstSeenDevices().isEmpty()); }
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
        QVERIFY(checkQuery.exec("SELECT version FROM schema_version")); QVERIFY(checkQuery.next()); QCOMPARE(checkQuery.value(0).toInt(), 6);
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

    void wirelessCandidateCanPairAfterMtpAppears() {
        QTemporaryDir d; QVERIFY(d.isValid());
        SetupModel model(d.path() + "/catalog.sqlite"); QVERIFY(model.ready());
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
