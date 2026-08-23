#include "setupmodel.h"

#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QSysInfo>
#include <QStandardPaths>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QUuid>

#include <solid/device.h>
#include <solid/deviceinterface.h>
#include <solid/storageaccess.h>
#include <solid/storagevolume.h>
#include <solid/storagedrive.h>

namespace {
QString cleanPath(const QString &path) { return QFileInfo(path).canonicalFilePath(); }
bool underOrEqual(const QString &child, const QString &root) {
    const auto c = QDir::cleanPath(child), r = QDir::cleanPath(root);
    return c == r || c.startsWith(r.endsWith('/') ? r : r + '/');
}
}

SetupModel::SetupModel(const QString &databasePath, const QVariantList &storageOverride, QObject *parent) : QObject(parent) {
    m_databasePath = databasePath.isEmpty() ? QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/catalog.sqlite" : databasePath;
    QDir().mkpath(QFileInfo(m_databasePath).absolutePath());
    m_connectionName = QStringLiteral("setup-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    if (!openCatalog()) return;
    m_localDeviceName = QSysInfo::machineHostName();

    QVariantMap local{{"id", "local"}, {"label", "Computer"}, {"root", "/"}, {"present", true}, {"kind", "local"}};
    m_storages.append(local);
    if (!storageOverride.isEmpty()) m_storages += storageOverride;
    else {
        QSqlQuery remembered(QSqlDatabase::database(m_connectionName));
        if (remembered.exec("SELECT id,label,selected_root,kind,presence FROM storage WHERE kind='removable'"))
            while (remembered.next()) m_storages.append(QVariantMap{{"id", remembered.value(0)}, {"label", remembered.value(1)}, {"root", remembered.value(2)}, {"kind", remembered.value(3)}, {"present", false}});
        refreshStorages();
    }
    QSqlQuery storageQuery(QSqlDatabase::database(m_connectionName));
    for (const auto &value : m_storages) {
        const auto storage = value.toMap();
        if (storage.value("id") == "local") continue;
        if (!storageQuery.prepare("INSERT OR IGNORE INTO storage(id,stable_identity,device_id,kind,label,selected_root,presence) VALUES(?,?,?,?,?,?,?)")) { m_ready = false; fail(storageQuery.lastError().text()); return; }
        storageQuery.addBindValue(storage.value("id")); storageQuery.addBindValue(storage.value("id")); storageQuery.addBindValue("local"); storageQuery.addBindValue(storage.value("kind", "removable")); storageQuery.addBindValue(storage.value("label")); storageQuery.addBindValue(storage.value("root")); storageQuery.addBindValue(storage.value("present").toBool() ? "present" : "missing");
        if (!storageQuery.exec()) { m_ready = false; fail(storageQuery.lastError().text()); return; }
    }
    loadRoutes();
}

SetupModel::~SetupModel() { if (!m_connectionName.isEmpty()) QSqlDatabase::removeDatabase(m_connectionName); }

bool SetupModel::fail(const QString &message) { m_error = message; emit changed(); return false; }

bool SetupModel::openCatalog() {
    auto db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), m_connectionName);
    db.setDatabaseName(m_databasePath);
    if (!db.open()) return fail(db.lastError().text());
    QSqlQuery q(db);
    if (!q.exec("PRAGMA foreign_keys = ON")) return fail(q.lastError().text());
    if (!q.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'") || !q.next()) {
        QFile schema(QStringLiteral(":/src/catalog/schema.sql"));
        if (!schema.open(QIODevice::ReadOnly)) return fail(schema.errorString());
        if (!db.transaction()) return fail(db.lastError().text());
        QString statement; bool trigger = false;
        const auto lines = QString::fromUtf8(schema.readAll()).split('\n');
        for (const auto &line : lines) {
            statement += line + '\n';
            const auto trimmed = line.trimmed();
            if (statement.trimmed().startsWith(QStringLiteral("CREATE TRIGGER"))) trigger = true;
            if (!trimmed.endsWith(';') || (trigger && trimmed != QStringLiteral("END;"))) continue;
            if (!q.exec(statement.trimmed())) { db.rollback(); return fail(q.lastError().text()); }
            statement.clear(); trigger = false;
        }
        if (!statement.trimmed().isEmpty() || !db.commit()) return fail(db.lastError().text());
    } else {
        if (!q.exec("SELECT version FROM schema_version WHERE singleton=1") || !q.next() || q.value(0).toInt() != 1) return fail(QStringLiteral("Unsupported catalog schema version"));
    }
    QFile machineId("/etc/machine-id");
    const QString hostname = QSysInfo::machineHostName();
    const QByteArray stable = machineId.open(QIODevice::ReadOnly) ? machineId.readAll().trimmed() : hostname.toUtf8();
    q.prepare("INSERT OR IGNORE INTO devices(id,stable_id,name,kind,is_local) VALUES('local',:stable,:name,'Desktop',1)");
    q.bindValue(":stable", QStringLiteral("machine:%1").arg(QString::fromUtf8(stable)));
    q.bindValue(":name", hostname);
    if (!q.exec()) return fail(q.lastError().text());
    if (!q.exec("INSERT OR IGNORE INTO storage(id,stable_identity,device_id,kind,label,selected_root,presence) VALUES('local','local','local','local','Computer','/','present')")) return fail(q.lastError().text());
    q.exec("SELECT config_revision FROM app_config WHERE singleton=1"); if (q.next()) m_revision = q.value(0).toInt();
    m_ready = true; emit changed(); return true;
}

void SetupModel::refreshStorages() {
    QSqlQuery mark(QSqlDatabase::database(m_connectionName));
    if (!mark.exec("UPDATE storage SET presence='missing' WHERE kind='removable'")) { fail(mark.lastError().text()); return; }
    for (const auto &device : Solid::Device::listFromType(Solid::DeviceInterface::StorageAccess)) {
        const auto access = device.as<Solid::StorageAccess>();
        if (!access || !access->isAccessible()) continue;
        bool removableDrive = false;
        for (Solid::Device parent = device.parent(); parent.isValid(); parent = parent.parent()) {
            const auto drive = parent.as<Solid::StorageDrive>();
            if (drive) { removableDrive = drive->isRemovable() || drive->isHotpluggable(); break; }
        }
        if (!removableDrive) continue;
        const QString root = cleanPath(access->filePath());
        if (root.isEmpty() || root == "/") continue;
        const auto volume = device.as<Solid::StorageVolume>();
        const QString uuid = volume ? volume->uuid() : QString();
        if (uuid.isEmpty()) continue;
        QVariantMap item{{"id", "storage:" + uuid}, {"label", volume->label().isEmpty() ? QFileInfo(root).fileName() : volume->label()}, {"root", root}, {"present", true}, {"kind", "removable"}};
        bool duplicate = false;
        for (auto &v : m_storages) if (v.toMap().value("id") == item.value("id")) { v = item; duplicate = true; }
        if (!duplicate) m_storages.append(item);
        QSqlQuery save(QSqlDatabase::database(m_connectionName));
        save.prepare("INSERT INTO storage(id,stable_identity,device_id,kind,label,selected_root,presence) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,selected_root=excluded.selected_root,presence='present'");
        save.addBindValue(item.value("id")); save.addBindValue(item.value("id")); save.addBindValue("local"); save.addBindValue("removable"); save.addBindValue(item.value("label")); save.addBindValue(root); save.addBindValue("present");
        if (!save.exec()) { fail(save.lastError().text()); return; }
    }
    m_error.clear();
    emit changed();
}

void SetupModel::loadRoutes() {
    QSqlQuery q(QSqlDatabase::database(m_connectionName));
    if (!q.exec("SELECT source_root,destination_root,behavior FROM routes ORDER BY created_at")) return;
    while (q.next()) m_routes.append(QVariantMap{{"source", q.value(0)}, {"destination", q.value(1)}, {"behavior", q.value(2)}});
}

bool SetupModel::saveRoute(const QString &source, const QString &storageId, const QString &destination, const QString &behavior) {
    const QString src = cleanPath(source), dst = cleanPath(destination);
    if ((behavior != "Copy" && behavior != "Move") || src.isEmpty() || dst.isEmpty() || !QFileInfo(src).isDir() || !QFileInfo(dst).isDir()) return fail("Choose existing folders and Copy or Move.");
    QVariantMap selected; for (const auto &v : m_storages) if (v.toMap().value("id") == storageId) selected = v.toMap();
    const QString root = cleanPath(selected.value("root").toString());
    if (selected.isEmpty() || !selected.value("present").toBool() || root.isEmpty() || !underOrEqual(dst, root) || underOrEqual(src, root) || underOrEqual(src, dst) || underOrEqual(dst, src)) return fail("Destination is not a selected storage folder or overlaps the source.");
    auto db = QSqlDatabase::database(m_connectionName); if (!db.transaction()) return fail(db.lastError().text()); QSqlQuery q(db);
    q.prepare("INSERT INTO routes(id,source_storage_id,destination_storage_id,source_root,destination_root,behavior) VALUES(?,?,?,?,?,?)");
    q.addBindValue(QUuid::createUuid().toString(QUuid::Id128)); q.addBindValue("local"); q.addBindValue(storageId); q.addBindValue(src); q.addBindValue(dst); q.addBindValue(behavior);
    if (!q.exec()) { db.rollback(); return fail(q.lastError().text()); }
    if (!q.exec("UPDATE app_config SET config_revision=config_revision+1,updated_at=CURRENT_TIMESTAMP WHERE singleton=1")) { db.rollback(); return fail(q.lastError().text()); }
    if (!db.commit()) { db.rollback(); return fail(db.lastError().text()); }
    ++m_revision; m_error.clear(); m_routes.append(QVariantMap{{"source", src}, {"destination", dst}, {"behavior", behavior}}); emit changed(); return true;
}
