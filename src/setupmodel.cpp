#include "setupmodel.h"
#include <QFile>
#include <QFileInfo>
#include <QDir>
#include <QSysInfo>
#include <QStandardPaths>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QCryptographicHash>
#include <QDateTime>
#include <QJsonDocument>
#include <QJsonObject>
#include <QHostAddress>
#include <QNetworkDatagram>
#include <QTimer>
#include <QUdpSocket>
#include <QUuid>

#include <KIO/ListJob>
#include <KIO/UDSEntry>

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

bool ensureColumn(QSqlDatabase &db, const QString &table, const QString &column, const QString &definition, QString *error) {
    QSqlQuery columns(db);
    if (!columns.exec(QStringLiteral("PRAGMA table_info(%1)").arg(table))) { if (error) *error = columns.lastError().text(); return false; }
    while (columns.next()) if (columns.value(1).toString() == column) return true;
    QSqlQuery alter(db);
    if (!alter.exec(QStringLiteral("ALTER TABLE %1 ADD COLUMN %2").arg(table, definition))) { if (error) *error = alter.lastError().text(); return false; }
    return true;
}

bool recoverInterruptedJobs(QSqlDatabase &db, QString *error) {
    QSqlQuery table(db);
    if (!table.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history'") ) { if (error) *error = table.lastError().text(); return false; }
    if (!table.next()) return true;
    if (!db.transaction()) { if (error) *error = db.lastError().text(); return false; }
    const QString message = QStringLiteral("Transfer was interrupted before restart; retry is safe.");
    QSqlQuery jobs(db);
    if (!jobs.exec("SELECT id,keep_policy FROM jobs WHERE state IN ('Copying','Verifying','Paused')")) { db.rollback(); if (error) *error = jobs.lastError().text(); return false; }
    while (jobs.next()) {
        const QString jobId = jobs.value(0).toString();
        const QString keepPolicy = jobs.value(1).toString();
        bool unfinished = false;
        QSqlQuery items(db); items.prepare("SELECT id,source_path,destination_path FROM job_items WHERE job_id=? AND state IN ('Queued','Copying','Verifying','Paused')"); items.addBindValue(jobId);
        if (!items.exec()) { db.rollback(); if (error) *error = items.lastError().text(); return false; }
        while (items.next()) {
            unfinished = true;
            const QString itemId = items.value(0).toString();
            QSqlQuery updateItem(db); updateItem.prepare("UPDATE job_items SET state='Failed',cleanup_state='not_requested' WHERE id=?"); updateItem.addBindValue(itemId);
            if (!updateItem.exec() || updateItem.numRowsAffected() != 1) { db.rollback(); if (error) *error = updateItem.lastError().text(); return false; }
            QSqlQuery sequence(db);
            if (!sequence.exec("UPDATE devices SET event_sequence=event_sequence+1 WHERE id='local'") || !sequence.exec("SELECT event_sequence FROM devices WHERE id='local'") || !sequence.next()) { db.rollback(); if (error) *error = sequence.lastError().text(); return false; }
            const qint64 eventSequence = sequence.value(0).toLongLong();
            QSqlQuery history(db); history.prepare("INSERT INTO history(id,origin_device_id,catalog_generation,origin_sequence,job_id,item_id,event,source_path,destination_path,result) VALUES(?,?,?,?,?,?,?,?,?,?)");
            history.addBindValue(QStringLiteral("history-%1").arg(QUuid::createUuid().toString(QUuid::Id128))); history.addBindValue("local"); history.addBindValue(1); history.addBindValue(eventSequence); history.addBindValue(jobId); history.addBindValue(itemId); history.addBindValue("failed"); history.addBindValue(items.value(1)); history.addBindValue(items.value(2)); history.addBindValue(message);
            if (!history.exec()) { db.rollback(); if (error) *error = history.lastError().text(); return false; }
        }
        if (!unfinished) {
            QSqlQuery counts(db); counts.prepare("SELECT COUNT(*),SUM(CASE WHEN state='Complete' THEN 1 ELSE 0 END),SUM(CASE WHEN state='Conflict' THEN 1 ELSE 0 END) FROM job_items WHERE job_id=?"); counts.addBindValue(jobId);
            if (!counts.exec() || !counts.next()) { db.rollback(); if (error) *error = counts.lastError().text(); return false; }
            const int total = counts.value(0).toInt(), complete = counts.value(1).toInt(), conflicts = counts.value(2).toInt();
            QString state = QStringLiteral("Failed"), code = QStringLiteral("interrupted"), result = message;
            if (total > 0 && complete == total) { state = keepPolicy == QStringLiteral("Everything") ? QStringLiteral("Complete") : QStringLiteral("Cleanup pending"); code.clear(); result.clear(); }
            else if (total > 0 && conflicts > 0 && complete + conflicts == total) { state = QStringLiteral("Conflict"); code = QStringLiteral("name_conflict"); result = QStringLiteral("One or more destinations differ"); }
            QSqlQuery updateJob(db); updateJob.prepare("UPDATE jobs SET state=?,error_code=?,error_message=?,completed_at=CASE WHEN ?='Complete' THEN CURRENT_TIMESTAMP ELSE NULL END,updated_at=CURRENT_TIMESTAMP WHERE id=?"); updateJob.addBindValue(state); updateJob.addBindValue(code.isEmpty() ? QVariant() : QVariant(code)); updateJob.addBindValue(result.isEmpty() ? QVariant() : QVariant(result)); updateJob.addBindValue(state); updateJob.addBindValue(jobId);
            if (!updateJob.exec() || updateJob.numRowsAffected() != 1) { db.rollback(); if (error) *error = updateJob.lastError().text(); return false; }
            continue;
        }
        QSqlQuery updateJob(db); updateJob.prepare("UPDATE jobs SET state='Failed',error_code='interrupted',error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"); updateJob.addBindValue(message); updateJob.addBindValue(jobId);
        if (!updateJob.exec() || updateJob.numRowsAffected() != 1) { db.rollback(); if (error) *error = updateJob.lastError().text(); return false; }
    }
    if (!db.commit()) { db.rollback(); if (error) *error = db.lastError().text(); return false; }
    return true;
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
        if (remembered.exec("SELECT id,label,selected_root,kind,presence,COALESCE(filesystem_type,''),hidden FROM storage WHERE kind='removable'"))
            while (remembered.next()) if (!remembered.value(6).toBool()) m_storages.append(QVariantMap{{"id", remembered.value(0)}, {"label", remembered.value(1)}, {"root", remembered.value(2)}, {"kind", remembered.value(3)}, {"present", false}, {"filesystemType", remembered.value(5)}});
        refreshStorages();
    }
    QSqlQuery storageQuery(QSqlDatabase::database(m_connectionName));
    for (int index = 0; index < m_storages.size(); ++index) {
        auto storage = m_storages.at(index).toMap();
        if (storage.value("id") == "local") continue;
        QString identity = storage.value("identity").toString();
        if (identity.isEmpty()) identity = QStringLiteral("storage:%1").arg(storage.value("id").toString());
        storage.insert("identity", identity);
        m_storages[index] = storage;
        if (!storageQuery.prepare("INSERT OR IGNORE INTO storage(id,stable_identity,device_id,kind,label,filesystem_type,selected_root,presence) VALUES(?,?,?,?,?,?,?,?)")) { m_ready = false; fail(storageQuery.lastError().text()); return; }
        storageQuery.addBindValue(storage.value("id")); storageQuery.addBindValue(identity); storageQuery.addBindValue("local"); storageQuery.addBindValue(storage.value("kind", "removable")); storageQuery.addBindValue(storage.value("label")); storageQuery.addBindValue(storage.value("filesystemType")); storageQuery.addBindValue(storage.value("root")); storageQuery.addBindValue(storage.value("present").toBool() ? "present" : "missing");
        if (!storageQuery.exec()) { m_ready = false; fail(storageQuery.lastError().text()); return; }
        QSqlQuery visibility(QSqlDatabase::database(m_connectionName));
        visibility.prepare("SELECT hidden FROM storage WHERE id=?"); visibility.addBindValue(storage.value("id"));
        if (visibility.exec() && visibility.next() && visibility.value(0).toBool()) { m_storages.removeAt(index); --index; }
    }
    loadRoutes();
    loadDeviceLists();
    refreshMtpDevices();
    startWirelessDiscovery();
}

SetupModel::~SetupModel() { if (m_mtpJob) m_mtpJob->kill(); stopWirelessDiscovery(); if (!m_connectionName.isEmpty()) QSqlDatabase::removeDatabase(m_connectionName); }

bool SetupModel::fail(const QString &message) { m_error = message; emit changed(); return false; }

QString SetupModel::upsertDiscoveredPhone(const QString &alias, const QString &name, const QString &transport, const QString &preferredDeviceId) {
    const QString cleanAlias = alias.trimmed(), cleanName = name.trimmed();
    if (cleanAlias.isEmpty() || cleanName.isEmpty() || (transport != QStringLiteral("mtp") && transport != QStringLiteral("wireless"))) { fail(QStringLiteral("Invalid discovered phone identity.")); return {}; }
    QSqlDatabase db = QSqlDatabase::database(m_connectionName);
    QString deviceId;
    QSqlQuery resolve(db);
    if (!preferredDeviceId.trimmed().isEmpty()) {
        resolve.prepare("SELECT id FROM devices WHERE id=? AND is_local=0"); resolve.addBindValue(preferredDeviceId.trimmed());
        if (!resolve.exec() || !resolve.next()) { fail(QStringLiteral("Unknown paired device.")); return {}; }
        deviceId = resolve.value(0).toString();
    } else {
        resolve.prepare("SELECT device_id FROM device_aliases WHERE alias=?"); resolve.addBindValue(cleanAlias);
        if (resolve.exec() && resolve.next()) deviceId = resolve.value(0).toString();
        if (deviceId.isEmpty()) {
            resolve.prepare("SELECT id FROM devices WHERE stable_id=? AND is_local=0"); resolve.addBindValue(cleanAlias);
            if (resolve.exec() && resolve.next()) deviceId = resolve.value(0).toString();
        }
        if (deviceId.isEmpty()) deviceId = QStringLiteral("%1-device-%2").arg(transport, QString::fromLatin1(QCryptographicHash::hash(cleanAlias.toUtf8(), QCryptographicHash::Sha256).toHex().left(24)));
    }
    QSqlQuery save(db);
    save.prepare("INSERT INTO devices(id,stable_id,name,kind,is_local,last_seen_at) VALUES(?,?,?,'Phone',0,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET name=excluded.name,last_seen_at=CURRENT_TIMESTAMP");
    save.addBindValue(deviceId); save.addBindValue(cleanAlias); save.addBindValue(cleanName);
    if (!save.exec()) { fail(save.lastError().text()); return {}; }
    QSqlQuery aliasSave(db);
    aliasSave.prepare("INSERT INTO device_aliases(alias,device_id,transport,last_seen_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(alias) DO UPDATE SET device_id=excluded.device_id,transport=excluded.transport,last_seen_at=CURRENT_TIMESTAMP");
    aliasSave.addBindValue(cleanAlias); aliasSave.addBindValue(deviceId); aliasSave.addBindValue(transport);
    if (!aliasSave.exec()) { fail(aliasSave.lastError().text()); return {}; }
    return deviceId;
}

QVariantList SetupModel::connectedDevices() const {
    QVariantList result;
    const auto add = [&result](const QVariantMap &incoming) {
        const QString id = incoming.value("id").toString();
        for (auto &value : result) {
            auto current = value.toMap();
            if (current.value("id").toString() != id) continue;
            QStringList transports = current.value("transports").toStringList();
            const QString transport = incoming.value("transport").toString();
            if (!transport.isEmpty() && !transports.contains(transport)) transports.append(transport);
            current.insert("transports", transports);
            for (auto it = incoming.cbegin(); it != incoming.cend(); ++it) if (!current.contains(it.key()) || current.value(it.key()).toString().isEmpty()) current.insert(it.key(), it.value());
            if (incoming.value("present").toBool() || incoming.value("status").toString() == QStringLiteral("Online")) {
                current.insert("present", true);
                current.insert("status", QStringLiteral("Online"));
            }
            if (incoming.value("lastSeenMs").toLongLong() > current.value("lastSeenMs").toLongLong()) current.insert("lastSeenMs", incoming.value("lastSeenMs"));
            value = current;
            return;
        }
        auto first = incoming;
        first.insert("transports", QStringList{incoming.value("transport").toString()});
        result.append(first);
    };
    for (const auto &value : m_mtpDevices) add(value.toMap());
    for (const auto &value : m_wirelessDevices) add(value.toMap());
    return result;
}

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
        if (!q.exec("SELECT version FROM schema_version WHERE singleton=1") || !q.next()) return fail(QStringLiteral("Unsupported catalog schema version"));
        const int version = q.value(0).toInt();
        if (version == 1) {
            QString migrationError;
            if (!db.transaction()
                || !ensureColumn(db, "routes", "keep_policy", "keep_policy TEXT NOT NULL DEFAULT 'Everything' CHECK (keep_policy IN ('Everything', 'Last month', 'Last week', 'Last day', 'Nothing'))", &migrationError)
                || !ensureColumn(db, "jobs", "keep_policy", "keep_policy TEXT NOT NULL DEFAULT 'Everything' CHECK (keep_policy IN ('Everything', 'Last month', 'Last week', 'Last day', 'Nothing'))", &migrationError)
                || !ensureColumn(db, "storage", "filesystem_type", "filesystem_type TEXT", &migrationError)
                || !ensureColumn(db, "routes", "staging_max_bytes", "staging_max_bytes INTEGER CHECK (staging_max_bytes IS NULL OR staging_max_bytes >= 0)", &migrationError)
                || !ensureColumn(db, "routes", "minimum_free_bytes", "minimum_free_bytes INTEGER CHECK (minimum_free_bytes IS NULL OR minimum_free_bytes >= 0)", &migrationError)
                || !ensureColumn(db, "routes", "organize_photos", "organize_photos INTEGER NOT NULL DEFAULT 0 CHECK (organize_photos IN (0, 1))", &migrationError)
                || !q.exec("UPDATE routes SET keep_policy='Nothing' WHERE behavior='Move'")
                || !q.exec("UPDATE jobs SET keep_policy='Nothing' WHERE behavior='Move'")
                || !q.exec("UPDATE schema_version SET version=2,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); return fail(migrationError.isEmpty() ? q.lastError().text() : migrationError); }
        }
        if (version <= 2) {
            QString migrationError;
            if (!db.transaction()
                || !ensureColumn(db, "routes", "staging_root", "staging_root TEXT CHECK (staging_root IS NULL OR staging_root <> '')", &migrationError)
                || !q.exec("UPDATE schema_version SET version=3,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); return fail(migrationError.isEmpty() ? q.lastError().text() : migrationError); }
        }
        if (version <= 3) {
            QString migrationError;
            if (!db.transaction()
                || !ensureColumn(db, "routes", "content_type", "content_type TEXT NOT NULL DEFAULT 'Drive' CHECK (content_type IN ('Drive', 'Photos'))", &migrationError)
                || !q.exec("UPDATE routes SET content_type='Photos' WHERE organize_photos=1")
                || !q.exec("UPDATE schema_version SET version=4,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); return fail(migrationError.isEmpty() ? q.lastError().text() : migrationError); }
        }
        if (version <= 4) {
            QString migrationError;
            if (!db.transaction()
                || !ensureColumn(db, "devices", "onboarding_seen", "onboarding_seen INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_seen IN (0, 1))", &migrationError)
                || !ensureColumn(db, "devices", "hidden", "hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))", &migrationError)
                || !ensureColumn(db, "storage", "onboarding_seen", "onboarding_seen INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_seen IN (0, 1))", &migrationError)
                || !ensureColumn(db, "storage", "hidden", "hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))", &migrationError)
                || !q.exec("UPDATE devices SET onboarding_seen=1 WHERE is_local=0")
                || !q.exec("UPDATE storage SET onboarding_seen=1 WHERE kind<>'local'")
                || !q.exec("UPDATE schema_version SET version=5,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); return fail(migrationError.isEmpty() ? q.lastError().text() : migrationError); }
        }
        if (version <= 5) {
            QString migrationError;
            if (!db.transaction()
                || !q.exec("CREATE TABLE IF NOT EXISTS device_aliases (alias TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, transport TEXT NOT NULL CHECK (transport IN ('mtp', 'wireless')), last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
                || !q.exec("UPDATE schema_version SET version=6,installed_at=CURRENT_TIMESTAMP WHERE singleton=1")
                || !db.commit()) { db.rollback(); return fail(migrationError.isEmpty() ? q.lastError().text() : migrationError); }
        } else if (version != 6) return fail(QStringLiteral("Unsupported catalog schema version"));
    }
    QFile machineId("/etc/machine-id");
    const QString hostname = QSysInfo::machineHostName();
    const QByteArray stable = machineId.open(QIODevice::ReadOnly) ? machineId.readAll().trimmed() : hostname.toUtf8();
    q.prepare("INSERT OR IGNORE INTO devices(id,stable_id,name,kind,is_local) VALUES('local',:stable,:name,'Desktop',1)");
    q.bindValue(":stable", QStringLiteral("machine:%1").arg(QString::fromUtf8(stable)));
    q.bindValue(":name", hostname);
    if (!q.exec()) return fail(q.lastError().text());
    if (!q.exec("INSERT OR IGNORE INTO storage(id,stable_identity,device_id,kind,label,filesystem_type,selected_root,presence) VALUES('local','local','local','local','Computer','', '/','present')")) return fail(q.lastError().text());
    QString recoveryError;
    if (!recoverInterruptedJobs(db, &recoveryError)) return fail(recoveryError);
    q.exec("SELECT config_revision FROM app_config WHERE singleton=1"); if (q.next()) m_revision = q.value(0).toInt();
    m_ready = true; emit changed(); return true;
}

void SetupModel::refreshStorages() {
    for (auto &value : m_storages) if (value.toMap().value("kind") == "removable") { auto storage = value.toMap(); storage.insert("present", false); value = storage; }
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
        const QString identity = QStringLiteral("storage:%1").arg(uuid);
        QVariantMap item{{"id", "storage:" + uuid}, {"identity", identity}, {"label", volume->label().isEmpty() ? QFileInfo(root).fileName() : volume->label()}, {"filesystemType", volume->fsType()}, {"root", root}, {"present", true}, {"kind", "removable"}};
        QSqlQuery visibility(QSqlDatabase::database(m_connectionName));
        visibility.prepare("SELECT hidden FROM storage WHERE id=?"); visibility.addBindValue(item.value("id"));
        const bool hidden = visibility.exec() && visibility.next() && visibility.value(0).toBool();
        bool duplicate = false;
        for (int index = m_storages.size() - 1; index >= 0; --index) {
            if (m_storages.at(index).toMap().value("id") != item.value("id")) continue;
            if (hidden) m_storages.removeAt(index); else m_storages[index] = item;
            duplicate = true;
        }
        if (!hidden && !duplicate) m_storages.append(item);
        QSqlQuery save(QSqlDatabase::database(m_connectionName));
        save.prepare("INSERT INTO storage(id,stable_identity,device_id,kind,label,filesystem_type,selected_root,presence) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stable_identity=excluded.stable_identity,label=excluded.label,filesystem_type=excluded.filesystem_type,selected_root=excluded.selected_root,presence='present'");
        save.addBindValue(item.value("id")); save.addBindValue(identity); save.addBindValue("local"); save.addBindValue("removable"); save.addBindValue(item.value("label")); save.addBindValue(item.value("filesystemType")); save.addBindValue(root); save.addBindValue("present");
        if (!save.exec()) { fail(save.lastError().text()); return; }
    }
    m_error.clear();
    loadDeviceLists();
    emit changed();
}

void SetupModel::refreshMtpDevices() {
    if (m_mtpJob) { m_mtpJob->disconnect(this); m_mtpJob->kill(); m_mtpJob = nullptr; }
    m_mtpDevices.clear();
    m_mtpJob = KIO::listDir(QUrl(QStringLiteral("mtp:/")), KIO::HideProgressInfo, KIO::ListJob::ListFlag::ExcludeDotAndDotDot);
    connect(m_mtpJob, &KIO::ListJob::entries, this, [this](KIO::Job *, const KIO::UDSEntryList &entries) {
        for (const auto &entry : entries) {
            const QString name = entry.stringValue(KIO::UDSEntry::UDS_NAME);
            if (name.isEmpty()) continue;
            const QString url = entry.stringValue(KIO::UDSEntry::UDS_URL);
            const QString stable = (url.isEmpty() ? QStringLiteral("mtp:%1").arg(name) : (url.startsWith(QStringLiteral("mtp:")) ? url : QStringLiteral("mtp:%1").arg(url)));
            const QString deviceId = upsertDiscoveredPhone(stable, name, QStringLiteral("mtp"));
            if (deviceId.isEmpty()) continue;
            QSqlQuery hidden(QSqlDatabase::database(m_connectionName)); hidden.prepare("SELECT hidden FROM devices WHERE id=?"); hidden.addBindValue(deviceId);
            if (!hidden.exec() || !hidden.next() || !hidden.value(0).toBool()) {
                const QVariantMap phone{{"id", deviceId}, {"stableIdentity", stable}, {"label", name}, {"kind", "mtp"}, {"transport", "mtp"}, {"present", true}, {"status", "Online"}, {"url", url}, {"phoneRoot", url}};
                m_mtpDevices.append(phone);
                if (!url.isEmpty()) {
                    QUrl storageUrl(url);
                    QString path = storageUrl.path(QUrl::FullyDecoded);
                    if (!path.endsWith('/')) { path += '/'; storageUrl.setPath(path); }
                    auto *storageJob = KIO::listDir(storageUrl, KIO::HideProgressInfo, KIO::ListJob::ListFlag::ExcludeDotAndDotDot);
                    connect(storageJob, &KIO::ListJob::entries, this, [this, deviceId](KIO::Job *, const KIO::UDSEntryList &storageEntries) {
                        for (const auto &storageEntry : storageEntries) {
                            if (storageEntry.numberValue(KIO::UDSEntry::UDS_FILE_TYPE, 0) != 0040000) continue;
                            const QString detected = storageEntry.stringValue(KIO::UDSEntry::UDS_URL);
                            if (detected.isEmpty()) continue;
                            for (auto &value : m_mtpDevices) if (value.toMap().value("id") == deviceId) { auto phone = value.toMap(); phone.insert("phoneRoot", detected); value = phone; }
                            emit changed();
                            return;
                        }
                    });
                }
            }
        }
        loadDeviceLists();
        emit changed();
    });
    connect(m_mtpJob, &KJob::result, this, [this](KJob *job) {
        if (m_mtpJob != job) return;
        if (job->error()) m_mtpDevices.clear();
        m_mtpJob = nullptr;
        loadDeviceLists();
        emit changed();
    });
}

bool SetupModel::startWirelessDiscovery() {
    if (m_wirelessSocket) return true;
    auto *socket = new QUdpSocket(this);
    if (!socket->bind(QHostAddress::AnyIPv4, wirelessDiscoveryPort(), QUdpSocket::ShareAddress | QUdpSocket::ReuseAddressHint)) {
        socket->deleteLater();
        return false;
    }
    m_wirelessSocket = socket;
    connect(socket, &QUdpSocket::readyRead, this, [this] {
        while (m_wirelessSocket && m_wirelessSocket->hasPendingDatagrams()) {
            QNetworkDatagram datagram = m_wirelessSocket->receiveDatagram();
            QJsonParseError parseError;
            const QJsonDocument document = QJsonDocument::fromJson(datagram.data(), &parseError);
            if (parseError.error != QJsonParseError::NoError || !document.isObject()) continue;
            const QJsonObject object = document.object();
            if (object.value(QStringLiteral("magic")).toString() != QString::fromLatin1(LocalDrive::WirelessProtocol::Magic) || object.value(QStringLiteral("protocol")).toInt() != LocalDrive::WirelessProtocol::Version) continue;
            QVariantMap beacon = object.toVariantMap();
            // Discovery is candidate-only. Pairing data is accepted only from an explicit local pairing flow.
            beacon.remove(QStringLiteral("pairedDeviceId"));
            if (!beacon.contains(QStringLiteral("endpoint"))) beacon.insert(QStringLiteral("endpoint"), datagram.senderAddress().toString());
            ingestWirelessBeacon(beacon);
        }
    });
    m_wirelessExpiryTimer = new QTimer(this);
    m_wirelessExpiryTimer->setInterval(5000);
    connect(m_wirelessExpiryTimer, &QTimer::timeout, this, &SetupModel::expireWirelessDevices);
    m_wirelessExpiryTimer->start();
    return true;
}

void SetupModel::stopWirelessDiscovery() {
    if (m_wirelessExpiryTimer) { m_wirelessExpiryTimer->stop(); m_wirelessExpiryTimer->deleteLater(); m_wirelessExpiryTimer = nullptr; }
    if (m_wirelessSocket) { m_wirelessSocket->close(); m_wirelessSocket->deleteLater(); m_wirelessSocket = nullptr; }
}

bool SetupModel::ingestWirelessBeacon(const QVariantMap &beacon) {
    const QString stable = beacon.value("stableIdentity", beacon.value("deviceStableId")).toString().trimmed();
    const QString label = beacon.value("label", beacon.value("name")).toString().trimmed();
    if (!stable.startsWith(QStringLiteral("wireless:")) || label.isEmpty()) return fail(QStringLiteral("Wireless beacon needs a stable identity and name."));
    const QString deviceId = upsertDiscoveredPhone(stable, label, QStringLiteral("wireless"), beacon.value("pairedDeviceId").toString());
    if (deviceId.isEmpty()) return false;
    QVariantMap item{{"id", deviceId}, {"stableIdentity", stable}, {"label", label}, {"kind", "wireless"}, {"transport", "wireless"}, {"present", true}, {"status", "Online"}, {"lastSeenMs", QDateTime::currentMSecsSinceEpoch()}};
    for (const auto &key : {QStringLiteral("endpoint"), QStringLiteral("rssi"), QStringLiteral("protocol")}) if (beacon.contains(key)) item.insert(key, beacon.value(key));
    QSqlQuery hidden(QSqlDatabase::database(m_connectionName)); hidden.prepare("SELECT hidden FROM devices WHERE id=?"); hidden.addBindValue(deviceId);
    const bool isHidden = hidden.exec() && hidden.next() && hidden.value(0).toBool();
    for (int index = m_wirelessDevices.size() - 1; index >= 0; --index) if (m_wirelessDevices.at(index).toMap().value("id") == deviceId) m_wirelessDevices.removeAt(index);
    if (!isHidden) m_wirelessDevices.append(item);
    loadDeviceLists();
    m_error.clear();
    emit changed();
    return true;
}

bool SetupModel::pairWirelessDevice(const QString &wirelessDeviceId, const QString &targetDeviceId) {
    if (wirelessDeviceId.trimmed().isEmpty() || targetDeviceId.trimmed().isEmpty() || wirelessDeviceId == targetDeviceId) return fail(QStringLiteral("Choose two different device identities to pair."));
    QString wirelessAlias;
    QVariantMap wirelessItem;
    for (const auto &value : m_wirelessDevices) if (value.toMap().value("id").toString() == wirelessDeviceId) { wirelessItem = value.toMap(); wirelessAlias = wirelessItem.value("stableIdentity").toString(); break; }
    QSqlDatabase db = QSqlDatabase::database(m_connectionName);
    if (wirelessAlias.isEmpty()) {
        QSqlQuery remembered(db); remembered.prepare("SELECT a.alias,d.name FROM device_aliases a JOIN devices d ON d.id=a.device_id WHERE a.device_id=? AND a.transport='wireless' LIMIT 1"); remembered.addBindValue(wirelessDeviceId);
        if (remembered.exec() && remembered.next()) {
            wirelessAlias = remembered.value(0).toString();
            wirelessItem = QVariantMap{{"id", wirelessDeviceId}, {"stableIdentity", wirelessAlias}, {"label", remembered.value(1)}, {"kind", "wireless"}, {"transport", "wireless"}, {"present", false}, {"status", "Offline"}, {"lastSeenMs", 0}};
        }
    }
    if (wirelessAlias.isEmpty()) return fail(QStringLiteral("Unknown wireless device."));
    if (!db.transaction()) return fail(db.lastError().text());
    QSqlQuery target(db); target.prepare("SELECT 1 FROM devices WHERE id=? AND is_local=0 AND kind='Phone'"); target.addBindValue(targetDeviceId);
    if (!target.exec() || !target.next()) { db.rollback(); return fail(QStringLiteral("Unknown phone device.")); }
    QSqlQuery alias(db); alias.prepare("UPDATE device_aliases SET device_id=?,last_seen_at=CURRENT_TIMESTAMP WHERE alias=?"); alias.addBindValue(targetDeviceId); alias.addBindValue(wirelessAlias);
    if (!alias.exec() || alias.numRowsAffected() != 1) { db.rollback(); return fail(QStringLiteral("Wireless identity is not pairable.")); }
    QSqlQuery archive(db); archive.prepare("UPDATE devices SET hidden=1 WHERE id=? AND id<>?"); archive.addBindValue(wirelessDeviceId); archive.addBindValue(targetDeviceId);
    if (!archive.exec()) { db.rollback(); return fail(archive.lastError().text()); }
    QSqlQuery acknowledge(db); acknowledge.prepare("UPDATE devices SET onboarding_seen=1 WHERE id=?"); acknowledge.addBindValue(targetDeviceId);
    if (!acknowledge.exec() || acknowledge.numRowsAffected() != 1) { db.rollback(); return fail(QStringLiteral("Could not acknowledge the paired phone.")); }
    if (!db.commit()) { db.rollback(); return fail(db.lastError().text()); }
    for (int index = m_wirelessDevices.size() - 1; index >= 0; --index) if (m_wirelessDevices.at(index).toMap().value("id").toString() == wirelessDeviceId || m_wirelessDevices.at(index).toMap().value("id").toString() == targetDeviceId) m_wirelessDevices.removeAt(index);
    wirelessItem.insert("id", targetDeviceId); wirelessItem.insert("paired", true); wirelessItem.insert("pairedDeviceId", targetDeviceId);
    m_wirelessDevices.append(wirelessItem);
    loadDeviceLists();
    m_error.clear();
    emit changed();
    return true;
}

void SetupModel::expireWirelessDevices() {
    const qint64 now = QDateTime::currentMSecsSinceEpoch();
    bool changedState = false;
    for (auto &value : m_wirelessDevices) {
        auto item = value.toMap();
        const bool online = now - item.value("lastSeenMs").toLongLong() <= 15000;
        const QString status = online ? QStringLiteral("Online") : QStringLiteral("Offline");
        if (item.value("present").toBool() != online || item.value("status").toString() != status) { item.insert("present", online); item.insert("status", status); value = item; changedState = true; }
    }
    if (changedState) { loadDeviceLists(); emit changed(); }
}

void SetupModel::loadDeviceLists() {
    m_firstSeenDevices.clear();
    m_hiddenDevices.clear();
    m_deviceList.clear();
    QSqlDatabase db = QSqlDatabase::database(m_connectionName);
    QSqlQuery devices(db);
    if (devices.exec("SELECT id,stable_id,name,kind,onboarding_seen,hidden FROM devices WHERE is_local=0 ORDER BY name")) {
        while (devices.next()) {
            const QString stable = devices.value(1).toString();
            QVariantMap item{{"id", devices.value(0)}, {"stableIdentity", stable}, {"label", devices.value(2)}, {"kind", devices.value(3)}, {"category", "device"}, {"present", true}, {"hidden", devices.value(5).toBool()}};
            if (devices.value(3).toString() == QStringLiteral("Phone") && stable.startsWith(QStringLiteral("mtp:"))) item.insert("url", stable.mid(4));
            QStringList transports;
            QSqlQuery aliases(db); aliases.prepare("SELECT group_concat(transport, ',') FROM device_aliases WHERE device_id=?"); aliases.addBindValue(devices.value(0));
            if (aliases.exec() && aliases.next()) transports = aliases.value(0).toString().split(',', Qt::SkipEmptyParts);
            item.insert("transports", transports);
            item.insert("wirelessCandidate", transports.contains(QStringLiteral("wireless")) && !transports.contains(QStringLiteral("mtp")));
            QString status = QStringLiteral("Offline");
            for (const auto &current : connectedDevices()) if (current.toMap().value("id") == devices.value(0)) { status = current.toMap().value("status", QStringLiteral("Online")).toString(); break; }
            item.insert("status", status);
            if (devices.value(5).toBool()) m_hiddenDevices.append(item);
            else { m_deviceList.append(item); if (!devices.value(4).toBool()) m_firstSeenDevices.append(item); }
        }
    }
    QSqlQuery storage(db);
    if (storage.exec("SELECT id,stable_identity,label,kind,filesystem_type,selected_root,presence,onboarding_seen,hidden FROM storage WHERE kind<>'local' ORDER BY label")) {
        while (storage.next()) {
            QVariantMap item{{"id", storage.value(0)}, {"stableIdentity", storage.value(1)}, {"label", storage.value(2)}, {"kind", storage.value(3)}, {"category", "storage"}, {"filesystemType", storage.value(4)}, {"root", storage.value(5)}, {"present", storage.value(6).toString() == "present"}, {"hidden", storage.value(8).toBool()}};
            if (storage.value(8).toBool()) m_hiddenDevices.append(item);
            else if (!storage.value(7).toBool()) m_firstSeenDevices.append(item);
        }
    }
}

bool SetupModel::acknowledgeDevice(const QString &deviceId, bool hide) {
    if (deviceId.trimmed().isEmpty()) return fail(QStringLiteral("Device identity is empty."));
    QSqlDatabase db = QSqlDatabase::database(m_connectionName);
    if (!db.transaction()) return fail(db.lastError().text());
    QSqlQuery exists(db); exists.prepare("SELECT 1 FROM storage WHERE id=?"); exists.addBindValue(deviceId);
    const bool isStorage = exists.exec() && exists.next();
    if (!isStorage) { exists.finish(); exists.prepare("SELECT 1 FROM devices WHERE id=? AND is_local=0"); exists.addBindValue(deviceId); }
    if ((!isStorage && (!exists.exec() || !exists.next())) || (isStorage && !exists.isActive())) { db.rollback(); return fail(QStringLiteral("Unknown device.")); }
    QSqlQuery update(db);
    update.prepare(isStorage ? "UPDATE storage SET onboarding_seen=1,hidden=? WHERE id=?" : "UPDATE devices SET onboarding_seen=1,hidden=? WHERE id=?");
    update.addBindValue(hide ? 1 : 0); update.addBindValue(deviceId);
    if (!update.exec()) { db.rollback(); return fail(update.lastError().text()); }
    if (!db.commit()) { db.rollback(); return fail(db.lastError().text()); }
    if (hide) {
        for (int index = m_storages.size() - 1; index >= 0; --index) if (m_storages.at(index).toMap().value("id") == deviceId) m_storages.removeAt(index);
        for (int index = m_mtpDevices.size() - 1; index >= 0; --index) if (m_mtpDevices.at(index).toMap().value("id") == deviceId) m_mtpDevices.removeAt(index);
    }
    loadDeviceLists();
    m_error.clear();
    emit changed();
    return true;
}

bool SetupModel::showDevice(const QString &deviceId) {
    if (deviceId.trimmed().isEmpty()) return fail(QStringLiteral("Device identity is empty."));
    QSqlDatabase db = QSqlDatabase::database(m_connectionName);
    QSqlQuery storage(db); storage.prepare("SELECT label,kind,filesystem_type,selected_root,presence,stable_identity FROM storage WHERE id=? AND kind<>'local'"); storage.addBindValue(deviceId);
    if (storage.exec() && storage.next()) {
        QSqlQuery update(db); update.prepare("UPDATE storage SET hidden=0,onboarding_seen=1 WHERE id=?"); update.addBindValue(deviceId);
        if (!update.exec()) return fail(update.lastError().text());
        bool exists = false; for (const auto &value : m_storages) exists = exists || value.toMap().value("id") == deviceId;
        if (!exists) m_storages.append(QVariantMap{{"id", deviceId}, {"identity", storage.value(5)}, {"label", storage.value(0)}, {"kind", storage.value(1)}, {"filesystemType", storage.value(2)}, {"root", storage.value(3)}, {"present", storage.value(4).toString() == "present"}});
    } else {
        QSqlQuery update(db); update.prepare("UPDATE devices SET hidden=0,onboarding_seen=1 WHERE id=? AND is_local=0"); update.addBindValue(deviceId);
        if (!update.exec() || update.numRowsAffected() != 1) return fail(QStringLiteral("Unknown hidden device."));
        refreshMtpDevices();
    }
    loadDeviceLists();
    m_error.clear();
    emit changed();
    return true;
}

void SetupModel::loadRoutes() {
    QSqlQuery q(QSqlDatabase::database(m_connectionName));
    if (!q.exec("SELECT routes.id,source_root,destination_root,behavior,keep_policy,content_type,destination_storage_id,COALESCE(staging_max_bytes,0),COALESCE(staging_root,''),COALESCE(minimum_free_bytes,0),COALESCE(organize_photos,0),COALESCE((SELECT state FROM jobs j WHERE j.route_id=routes.id ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1),''),COALESCE((SELECT error_code FROM jobs j WHERE j.route_id=routes.id ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1),''),COALESCE((SELECT error_message FROM jobs j WHERE j.route_id=routes.id ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1),''),s.stable_identity,COALESCE(s.filesystem_type,''),s.selected_root,s.presence FROM routes JOIN storage s ON s.id=routes.destination_storage_id WHERE routes.enabled=1 ORDER BY routes.created_at")) return;
    while (q.next()) {
        const bool present = q.value(17).toString() == QStringLiteral("present");
        const QString state = q.value(11).toString();
        m_routes.append(QVariantMap{{"id", q.value(0)}, {"source", q.value(1)}, {"destination", q.value(2)}, {"behavior", q.value(3)}, {"keepPolicy", q.value(4)}, {"contentType", q.value(5)}, {"storageId", q.value(6)}, {"stagingMaxBytes", q.value(7)}, {"stagingRoot", q.value(8)}, {"minimumFreeBytes", q.value(9)}, {"organizePhotos", q.value(10).toBool()}, {"jobState", state.isEmpty() && !present ? QStringLiteral("Waiting") : state}, {"jobErrorCode", q.value(12)}, {"jobError", q.value(13)}, {"storageIdentity", q.value(14)}, {"filesystemType", q.value(15)}, {"storageRoot", q.value(16)}, {"storagePresent", present}});
    }
}

void SetupModel::refreshRoutes() { m_routes.clear(); loadRoutes(); emit changed(); }

bool SetupModel::saveRoute(const QString &source, const QString &storageId, const QString &destination, const QString &keepPolicy, qint64 minimumFreeBytes, bool organizePhotos, qint64 stagingMaxBytes, const QString &stagingRoot, const QString &contentType) {
    const QString src = cleanPath(source), requestedDestination = destination.trimmed(), staging = stagingRoot.trimmed().isEmpty() ? QString() : cleanPath(stagingRoot);
    const QString policy = keepPolicy == "Copy" ? QStringLiteral("Everything") : keepPolicy == "Move" ? QStringLiteral("Nothing") : keepPolicy;
    const QString type = contentType.trimmed();
    if ((policy != "Everything" && policy != "Last month" && policy != "Last week" && policy != "Last day" && policy != "Nothing") || (type != "Drive" && type != "Photos") || minimumFreeBytes < 0 || stagingMaxBytes < 0 || src.isEmpty() || !QFileInfo(src).isDir() || (!stagingRoot.trimmed().isEmpty() && (staging.isEmpty() || !QFileInfo(staging).isDir()))) return fail("Choose an existing source folder and valid content, Keep, staging, and safety policies.");
    const QString behavior = policy == "Nothing" ? QStringLiteral("Move") : QStringLiteral("Copy");
    QVariantMap selected; for (const auto &v : m_storages) if (v.toMap().value("id") == storageId) selected = v.toMap();
    const bool storagePresent = selected.value("present").toBool();
    const QString rootInput = selected.value("root").toString().trimmed();
    const QString root = storagePresent ? cleanPath(rootInput) : (QFileInfo(rootInput).isAbsolute() ? QDir::cleanPath(QFileInfo(rootInput).absoluteFilePath()) : QString());
    const QString dst = storagePresent ? cleanPath(requestedDestination) : (QFileInfo(requestedDestination).isAbsolute() ? QDir::cleanPath(QFileInfo(requestedDestination).absoluteFilePath()) : QString());
    if (selected.isEmpty() || root.isEmpty() || dst.isEmpty() || (storagePresent && !QFileInfo(dst).isDir()) || !underOrEqual(dst, root) || underOrEqual(src, root) || underOrEqual(src, dst) || underOrEqual(dst, src)) return fail("Destination is not a selected storage folder or overlaps the source.");
    if (!staging.isEmpty() && (underOrEqual(staging, src) || underOrEqual(src, staging) || underOrEqual(staging, dst) || underOrEqual(dst, staging))) return fail("Staging folder must not overlap the source or destination.");
    const QString routeId = QUuid::createUuid().toString(QUuid::Id128);
    auto db = QSqlDatabase::database(m_connectionName); if (!db.transaction()) return fail(db.lastError().text()); QSqlQuery q(db);
    q.prepare("INSERT INTO routes(id,source_storage_id,destination_storage_id,source_root,destination_root,behavior,keep_policy,content_type,staging_max_bytes,staging_root,minimum_free_bytes,organize_photos) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    q.addBindValue(routeId); q.addBindValue("local"); q.addBindValue(storageId); q.addBindValue(src); q.addBindValue(dst); q.addBindValue(behavior); q.addBindValue(policy); q.addBindValue(type); q.addBindValue(stagingMaxBytes); q.addBindValue(staging.isEmpty() ? QVariant() : QVariant(staging)); q.addBindValue(minimumFreeBytes); q.addBindValue(organizePhotos && type == "Photos");
    if (!q.exec()) { db.rollback(); return fail(q.lastError().text()); }
    if (!q.exec("UPDATE app_config SET config_revision=config_revision+1,updated_at=CURRENT_TIMESTAMP WHERE singleton=1")) { db.rollback(); return fail(q.lastError().text()); }
    if (!db.commit()) { db.rollback(); return fail(db.lastError().text()); }
    ++m_revision; m_error.clear(); m_routes.append(QVariantMap{{"id", routeId}, {"source", src}, {"destination", dst}, {"behavior", behavior}, {"keepPolicy", policy}, {"contentType", type}, {"storageId", storageId}, {"stagingMaxBytes", stagingMaxBytes}, {"stagingRoot", staging}, {"minimumFreeBytes", minimumFreeBytes}, {"organizePhotos", organizePhotos && type == "Photos"}, {"storageIdentity", selected.value("identity")}, {"filesystemType", selected.value("filesystemType")}, {"storageRoot", root}, {"jobState", storagePresent ? QString() : QStringLiteral("Waiting")}, {"jobErrorCode", QString()}, {"jobError", QString()}, {"storagePresent", storagePresent}}); emit changed(); return true;
}
