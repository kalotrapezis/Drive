#include <QtTest>
#include <QTemporaryDir>
#include <QSqlDatabase>
#include <QSqlQuery>
#include "../src/setupmodel.h"

class SetupModelTest : public QObject {
    Q_OBJECT
private slots:
    void initAndRoutes() {
        QTemporaryDir d; QVERIFY(d.isValid());
        QDir source(d.path()+"/source"), selectedRoot(d.path()+"/selected"), destination(d.path()+"/selected/target"), outside(d.path()+"/outside"), insideSource(d.path()+"/selected/source"); QVERIFY(source.mkpath(".")); QVERIFY(selectedRoot.mkpath(".")); QVERIFY(destination.mkpath(".")); QVERIFY(outside.mkpath(".")); QVERIFY(insideSource.mkpath("."));
        QVariantList disks{QVariantMap{{"id", "disk"}, {"label", "Test disk"}, {"root", selectedRoot.path()}, {"present", true}, {"kind", "removable"}}};
        const QString db = d.path()+"/catalog.sqlite";
        { SetupModel model(db, disks); QVERIFY(model.ready()); QVERIFY(!model.localDeviceName().isEmpty()); QVERIFY2(model.storages().size() == 2, qPrintable(model.errorMessage())); QVERIFY2(model.saveRoute(source.path(), "disk", destination.path(), "Copy"), qPrintable(model.errorMessage())); QCOMPARE(model.configRevision(), 1); }
        { SetupModel model(db, disks); QVERIFY(model.ready()); QCOMPARE(model.storages().size(), 2); QCOMPARE(model.routes().size(), 1); { QSqlDatabase count = QSqlDatabase::addDatabase("QSQLITE", "count-check"); count.setDatabaseName(db); QVERIFY(count.open()); QSqlQuery q(count); QVERIFY(q.exec("SELECT COUNT(*) FROM devices WHERE is_local=1")); QVERIFY(q.next()); QCOMPARE(q.value(0).toInt(), 1); count.close(); } QSqlDatabase::removeDatabase("count-check"); QVERIFY(!model.saveRoute(source.path(), "missing", destination.path(), "Copy")); QVERIFY(!model.saveRoute(source.path(), "disk", outside.path(), "Copy")); QVERIFY(!model.saveRoute(insideSource.path(), "disk", destination.path(), "Copy")); QVERIFY(!model.saveRoute(source.path(), "disk", source.path(), "Copy")); QVERIFY(!model.saveRoute(source.path(), "disk", destination.path(), "Bad")); }
        { QSqlDatabase check = QSqlDatabase::addDatabase("QSQLITE", "trigger-check"); check.setDatabaseName(db); QVERIFY(check.open()); { QSqlQuery q(check); QVERIFY(q.exec("INSERT INTO history(id,origin_device_id,catalog_generation,origin_sequence,event) VALUES('h','local',1,1,'queued')")); QVERIFY(!q.exec("UPDATE history SET event='failed'")); QVERIFY(!q.exec("DELETE FROM history")); } check.close(); }
        QSqlDatabase::removeDatabase("trigger-check");
    }

    void unsupportedVersion() {
        QTemporaryDir d; QVERIFY(d.isValid()); const QString db = d.path() + "/bad.sqlite";
        { QSqlDatabase bad = QSqlDatabase::addDatabase("QSQLITE", "bad-schema"); bad.setDatabaseName(db); QVERIFY(bad.open()); QSqlQuery q(bad); QVERIFY(q.exec("CREATE TABLE schema_version(singleton INTEGER PRIMARY KEY, version INTEGER)")); QVERIFY(q.exec("INSERT INTO schema_version VALUES(1,99)")); }
        QSqlDatabase::removeDatabase("bad-schema");
        SetupModel model(db); QVERIFY(!model.ready()); QVERIFY(model.errorMessage().contains("Unsupported"));
    }
};
QTEST_GUILESS_MAIN(SetupModelTest)
#include "setupmodel_test.moc"
