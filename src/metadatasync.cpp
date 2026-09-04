#include "metadatasync.h"

#include "verifiedcopy.h"
#include "wirelessprotocol.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSqlDatabase>
#include <QSqlError>
#include <QSqlQuery>
#include <QStringList>
#include <QUuid>

namespace {

bool safeRelative(const QString &relative) {
    const QString clean = QDir::cleanPath(relative);
    return !relative.trimmed().isEmpty() && clean != "." && clean != ".." && !clean.startsWith("../")
        && !clean.contains("/../") && !QFileInfo(clean).isAbsolute();
}

bool validHash(const QString &value) {
    const QByteArray bytes = value.toLatin1();
    return value.isEmpty() || (bytes.size() == 64 && bytes == bytes.toLower() && QByteArray::fromHex(bytes).size() == 32);
}

bool fail(QString *error, const QString &message) {
    if (error) *error = message;
    return false;
}

QString deviceIdFor(const QString &stableId) {
    return QStringLiteral("wireless-device-%1").arg(QString::fromLatin1(
        QCryptographicHash::hash(stableId.toUtf8(), QCryptographicHash::Sha256).toHex().left(16)));
}

bool merge(QSqlDatabase &db, const LocalDrive::Metadata::Delta &delta, QVariantMap *summary, QString *error) {
    if (!db.transaction()) return fail(error, db.lastError().text());
    QSqlQuery q(db);
    const QString internalDeviceId = deviceIdFor(delta.deviceId);
    q.prepare("INSERT INTO devices(id,stable_id,name,kind,is_local,last_seen_at,last_inventory_at) VALUES(?,?,?,'Phone',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) "
              "ON CONFLICT(id) DO UPDATE SET stable_id=excluded.stable_id,name=excluded.name,last_seen_at=CURRENT_TIMESTAMP,last_inventory_at=CURRENT_TIMESTAMP");
    q.addBindValue(internalDeviceId); q.addBindValue(delta.deviceId); q.addBindValue(delta.deviceName);
    if (!q.exec()) { db.rollback(); return fail(error, q.lastError().text()); }

    for (const auto &item : delta.items) {
        q.prepare("SELECT item_id,source_root,relative_path,size_bytes,modified_at FROM metadata_events WHERE origin_device_id=? AND catalog_generation=? AND origin_sequence=?");
        q.addBindValue(internalDeviceId); q.addBindValue(delta.catalogGeneration); q.addBindValue(item.originSequence);
        if (!q.exec()) { db.rollback(); return fail(error, q.lastError().text()); }
        if (q.next() && (q.value(0).toString() != item.itemId || q.value(1).toString() != item.root || q.value(2).toString() != item.relativePath
                         || q.value(3).toLongLong() != item.sizeBytes || q.value(4).toLongLong() != item.modifiedAt)) {
            db.rollback(); return fail(error, QStringLiteral("Metadata sequence collision detected"));
        }
        const QString eventId = QStringLiteral("metadata-%1").arg(QString::fromLatin1(QCryptographicHash::hash(
            (internalDeviceId + '\n' + QString::number(delta.catalogGeneration) + '\n' + QString::number(item.originSequence)).toUtf8(), QCryptographicHash::Sha256).toHex()));
        q.prepare("INSERT OR IGNORE INTO metadata_events(id,origin_device_id,catalog_generation,origin_sequence,item_id,source_root,relative_path,size_bytes,modified_at,captured_at,type_hint,media_metadata,content_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
        q.addBindValue(eventId); q.addBindValue(internalDeviceId); q.addBindValue(delta.catalogGeneration); q.addBindValue(item.originSequence);
        q.addBindValue(item.itemId); q.addBindValue(item.root); q.addBindValue(item.relativePath); q.addBindValue(item.sizeBytes); q.addBindValue(item.modifiedAt);
        q.addBindValue(item.capturedAt.isEmpty() ? QVariant() : QVariant(item.capturedAt)); q.addBindValue(item.typeHint.isEmpty() ? QVariant() : QVariant(item.typeHint));
        q.addBindValue(QString::fromUtf8(QJsonDocument(item.mediaMetadata).toJson(QJsonDocument::Compact)));
        q.addBindValue(item.contentSha256.isEmpty() ? QVariant() : QVariant(item.contentSha256));
        if (!q.exec()) { db.rollback(); return fail(error, q.lastError().text()); }

        q.prepare("INSERT INTO pending_metadata(origin_device_id,item_id,source_root,relative_path,size_bytes,modified_at,captured_at,type_hint,media_metadata,content_sha256,origin_sequence,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',CURRENT_TIMESTAMP) "
                  "ON CONFLICT(origin_device_id,item_id) DO UPDATE SET source_root=excluded.source_root,relative_path=excluded.relative_path,size_bytes=excluded.size_bytes,modified_at=excluded.modified_at,captured_at=excluded.captured_at,type_hint=excluded.type_hint,media_metadata=excluded.media_metadata,content_sha256=excluded.content_sha256,origin_sequence=excluded.origin_sequence,state='pending',updated_at=CURRENT_TIMESTAMP");
        q.addBindValue(internalDeviceId); q.addBindValue(item.itemId); q.addBindValue(item.root); q.addBindValue(item.relativePath); q.addBindValue(item.sizeBytes); q.addBindValue(item.modifiedAt);
        q.addBindValue(item.capturedAt.isEmpty() ? QVariant() : QVariant(item.capturedAt)); q.addBindValue(item.typeHint.isEmpty() ? QVariant() : QVariant(item.typeHint));
        q.addBindValue(QString::fromUtf8(QJsonDocument(item.mediaMetadata).toJson(QJsonDocument::Compact)));
        q.addBindValue(item.contentSha256.isEmpty() ? QVariant() : QVariant(item.contentSha256)); q.addBindValue(item.originSequence);
        if (!q.exec()) { db.rollback(); return fail(error, q.lastError().text()); }
    }

    q.prepare("INSERT INTO metadata_cursors(origin_device_id,catalog_generation,highest_contiguous) VALUES(?,?,0) ON CONFLICT(origin_device_id,catalog_generation) DO NOTHING");
    q.addBindValue(internalDeviceId); q.addBindValue(delta.catalogGeneration);
    if (!q.exec()) { db.rollback(); return fail(error, q.lastError().text()); }
    q.prepare("SELECT highest_contiguous FROM metadata_cursors WHERE origin_device_id=? AND catalog_generation=?");
    q.addBindValue(internalDeviceId); q.addBindValue(delta.catalogGeneration);
    if (!q.exec() || !q.next()) { db.rollback(); return fail(error, q.lastError().text()); }
    qint64 cursor = q.value(0).toLongLong();
    for (;;) {
        QSqlQuery next(db); next.prepare("SELECT 1 FROM metadata_events WHERE origin_device_id=? AND catalog_generation=? AND origin_sequence=?");
        next.addBindValue(internalDeviceId); next.addBindValue(delta.catalogGeneration); next.addBindValue(cursor + 1);
        if (!next.exec()) { db.rollback(); return fail(error, next.lastError().text()); }
        if (!next.next()) break;
        ++cursor;
    }
    q.prepare("UPDATE metadata_cursors SET highest_contiguous=?,updated_at=CURRENT_TIMESTAMP WHERE origin_device_id=? AND catalog_generation=?");
    q.addBindValue(cursor); q.addBindValue(internalDeviceId); q.addBindValue(delta.catalogGeneration);
    if (!q.exec()) { db.rollback(); return fail(error, q.lastError().text()); }

    qint64 files = 0, bytes = 0;
    q.prepare("SELECT COUNT(*),COALESCE(SUM(size_bytes),0),COALESCE(MAX(updated_at),'') FROM pending_metadata WHERE state='pending'");
    if (!q.exec() || !q.next()) { db.rollback(); return fail(error, q.lastError().text()); }
    files = q.value(0).toLongLong(); bytes = q.value(1).toLongLong();
    if (summary) {
        summary->insert("files", files); summary->insert("bytes", bytes); summary->insert("lastUpdate", q.value(2).toString()); summary->insert("cursor", cursor);
    }
    if (!db.commit()) return fail(error, db.lastError().text());
    return true;
}

}

namespace LocalDrive::Metadata {

bool fromJson(const QJsonObject &object, Delta *delta, QString *error) {
    if (!delta || object.value("type").toString() != QStringLiteral("metadata") || object.value("protocol").toInt() != LocalDrive::WirelessProtocol::Version)
        return fail(error, QStringLiteral("Metadata frame header is invalid"));
    Delta parsed;
    parsed.deviceId = object.value("deviceId").toString().trimmed(); parsed.deviceName = object.value("name").toString().trimmed();
    parsed.catalogGeneration = object.value("catalogGeneration").toVariant().toLongLong();
    const QJsonArray items = object.value("items").toArray();
    if (!parsed.deviceId.startsWith("wireless:") || parsed.deviceName.isEmpty() || parsed.catalogGeneration < 1 || items.size() > 512)
        return fail(error, QStringLiteral("Metadata frame identity or size is invalid"));
    for (const auto &value : items) {
        if (!value.isObject()) return fail(error, QStringLiteral("Metadata item is not an object"));
        const QJsonObject json = value.toObject(); Item item;
        item.itemId = json.value("itemId").toString().trimmed(); item.root = json.value("root").toString(); item.relativePath = QDir::cleanPath(json.value("relativePath").toString());
        item.sizeBytes = json.value("sizeBytes").toVariant().toLongLong(); item.modifiedAt = json.value("modifiedAt").toVariant().toLongLong(); item.originSequence = json.value("originSequence").toVariant().toLongLong();
        item.capturedAt = json.value("capturedAt").toString(); item.typeHint = json.value("typeHint").toString(); item.mediaMetadata = json.value("mediaMetadata").toObject(); item.contentSha256 = json.value("contentSha256").toString().toLower();
        if (item.itemId.isEmpty() || item.itemId.size() > 256 || (item.root != "Drive" && item.root != "DCIM") || !safeRelative(item.relativePath) || item.relativePath.size() > 4096
            || item.sizeBytes < 0 || item.modifiedAt < 0 || item.originSequence < 1 || !validHash(item.contentSha256) || item.typeHint.size() > 128 || item.capturedAt.size() > 128)
            return fail(error, QStringLiteral("Metadata item is invalid"));
        parsed.items.append(item);
    }
    *delta = parsed;
    return true;
}

bool mergeFile(const QString &databasePath, const Delta &delta, QVariantMap *summary, QString *error) {
    if (databasePath.trimmed().isEmpty()) return fail(error, QStringLiteral("Metadata catalog path is missing"));
    if (!VerifiedCopy::ensureCatalog(databasePath, error)) return false;
    const QString connection = QStringLiteral("metadata-%1").arg(QString::fromLatin1(QUuid::createUuid().toByteArray().toHex()));
    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(databasePath);
    if (!db.open()) { QSqlDatabase::removeDatabase(connection); return fail(error, db.lastError().text()); }
    const bool result = merge(db, delta, summary, error);
    db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase(connection);
    return result;
}

QJsonArray resolutionsAfter(const QString &databasePath, qint64 generation, qint64 cursor, QString *error) {
    QJsonArray result;
    if (generation < 0 || cursor < 0 || databasePath.trimmed().isEmpty()) { fail(error, QStringLiteral("Resolution cursor is invalid")); return result; }
    const QString connection = QStringLiteral("resolution-export-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(databasePath); db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
    if (!db.open()) { fail(error, db.lastError().text()); db = {}; QSqlDatabase::removeDatabase(connection); return result; }
    QSqlQuery query(db);
    query.prepare("SELECT rr.id,d.stable_id,rr.catalog_generation,rr.origin_sequence,rr.review_item_id,rr.action,rr.evidence_sha256,rr.result_state,rr.occurred_at,ri.category,ri.title FROM review_resolutions rr JOIN devices d ON d.id=rr.origin_device_id JOIN review_items ri ON ri.id=rr.review_item_id WHERE rr.origin_device_id='local' AND (rr.catalog_generation>? OR (rr.catalog_generation=? AND rr.origin_sequence>?)) ORDER BY rr.catalog_generation,rr.origin_sequence LIMIT 64");
    query.addBindValue(generation); query.addBindValue(generation); query.addBindValue(cursor);
    if (!query.exec()) fail(error, query.lastError().text());
    else while (query.next()) result.append(QJsonObject{{"id", query.value(0).toString()}, {"originDeviceId", query.value(1).toString()}, {"catalogGeneration", query.value(2).toLongLong()}, {"originSequence", query.value(3).toLongLong()}, {"reviewItemId", query.value(4).toString()}, {"action", query.value(5).toString()}, {"evidenceSha256", query.value(6).toString()}, {"resultState", query.value(7).toString()}, {"occurredAt", query.value(8).toString()}, {"category", query.value(9).toString().left(128)}, {"title", query.value(10).toString().left(256)}});
    db.close(); db = {}; QSqlDatabase::removeDatabase(connection);
    return result;
}

QJsonArray activeReviews(const QString &databasePath, QString *error) {
    QJsonArray result;
    const QString connection = QStringLiteral("review-export-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(databasePath); db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
    if (!db.open()) { fail(error, db.lastError().text()); db = {}; QSqlDatabase::removeDatabase(connection); return result; }
    QSqlQuery query(db);
    query.prepare("SELECT id,category,source_kind,title,summary,details_json,item_count,state FROM review_items WHERE state NOT IN ('resolved','dismissed') ORDER BY updated_at DESC,rowid DESC LIMIT 32");
    if (!query.exec()) fail(error, query.lastError().text());
    else while (query.next()) {
        const QString id = query.value(0).toString(), category = query.value(1).toString(), source = query.value(2).toString(), state = query.value(7).toString();
        const QString detailsText = query.value(5).toString(); const int count = query.value(6).toInt();
        QJsonObject details = QJsonDocument::fromJson(detailsText.toUtf8()).object();
        if (QJsonDocument(details).toJson(QJsonDocument::Compact).size() > 8192) details = {};
        const QString evidence = QString::fromLatin1(QCryptographicHash::hash((id + '\n' + category + '\n' + state + '\n' + detailsText + '\n' + QString::number(count)).toUtf8(), QCryptographicHash::Sha256).toHex());
        QJsonArray actions;
        if (source != "job" && state != "saved") actions.append("save");
        if (source == "import" && category == "Duplicates" && !details.value("paths").toArray().isEmpty()) actions.append("accept_existing");
        if (source == "import" && category == "Conflicts" && !details.value("paths").toArray().isEmpty()) actions.append("keep_both");
        if (source == "import" && category == "Unsupported" && !details.value("evidence").toArray().isEmpty()) actions.append("skip_unsupported");
        if (source == "metadata" && state == "saved" && details.value("changed").toInt() == 0 && details.value("missing").toInt() == 0) actions.append("dismiss");
        result.append(QJsonObject{{"id", id.left(256)}, {"category", category.left(128)}, {"title", query.value(3).toString().left(256)}, {"summary", query.value(4).toString().left(512)}, {"itemCount", count}, {"state", state}, {"evidenceSha256", evidence}, {"allowedActions", actions}});
    }
    db.close(); db = {}; QSqlDatabase::removeDatabase(connection);
    return result;
}

QJsonObject catalogSnapshot(const QString &databasePath, qint64 locationCursor, QString *error) {
    QString localError; QString *failure = error ? error : &localError; failure->clear();
    if (locationCursor < 0) { fail(failure, QStringLiteral("Location cursor is invalid")); return {}; }
    QJsonObject result{{"pendingFiles", 0}, {"pendingBytes", 0}, {"lastUpdate", QString()}, {"devices", QJsonArray{}}, {"storages", QJsonArray{}}, {"locations", QJsonArray{}}, {"activeTransfer", QJsonValue::Null}};
    const QString connection = QStringLiteral("catalog-snapshot-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(databasePath); db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
    if (!db.open()) { fail(failure, db.lastError().text()); db = {}; QSqlDatabase::removeDatabase(connection); return {}; }
    QSqlQuery query(db);
    if (!query.exec("SELECT COUNT(*),COALESCE(SUM(size_bytes),0),COALESCE(MAX(updated_at),'') FROM pending_metadata WHERE state='pending'") || !query.next()) fail(failure, query.lastError().text());
    else {
        result["pendingFiles"] = query.value(0).toLongLong(); result["pendingBytes"] = query.value(1).toLongLong(); result["lastUpdate"] = query.value(2).toString();
        QJsonArray devices;
        if (!query.exec("SELECT id,name,kind,is_local,COALESCE(last_seen_at,''),CASE WHEN is_local=1 OR last_seen_at>=datetime('now','-5 minutes') THEN 'online' WHEN last_seen_at IS NOT NULL THEN 'last_reported' ELSE 'not_checked' END FROM devices WHERE hidden=0 ORDER BY is_local DESC,last_seen_at DESC LIMIT 32")) fail(failure, query.lastError().text());
        else while (query.next()) devices.append(QJsonObject{{"id", query.value(0).toString().left(256)}, {"label", query.value(1).toString().left(256)}, {"kind", query.value(2).toString()}, {"local", query.value(3).toBool()}, {"lastSeen", query.value(4).toString()}, {"status", query.value(5).toString()}});
        result["devices"] = devices;
        QJsonArray storages;
        if (!failure->isEmpty()) { }
        else if (!query.exec("SELECT s.id,s.device_id,s.label,s.kind,s.presence,COALESCE(s.last_seen_at,''),COALESCE(s.bytes_total,0),COALESCE(s.bytes_free,0),COALESCE((SELECT SUM(l.size_bytes) FROM locations l WHERE l.storage_id=s.id AND l.state IN ('present','verified')),0) FROM storage s WHERE s.hidden=0 ORDER BY s.kind='local' DESC,s.last_seen_at DESC LIMIT 32")) fail(failure, query.lastError().text());
        else while (query.next()) storages.append(QJsonObject{{"id", query.value(0).toString().left(256)}, {"deviceId", query.value(1).toString().left(256)}, {"label", query.value(2).toString().left(256)}, {"kind", query.value(3).toString()}, {"presence", query.value(4).toString()}, {"lastSeen", query.value(5).toString()}, {"bytesTotal", query.value(6).toLongLong()}, {"bytesFree", query.value(7).toLongLong()}, {"knownBytes", query.value(8).toLongLong()}});
        result["storages"] = storages;
        if (failure->isEmpty()) {
            QJsonArray locations;
            query.prepare("SELECT l.rowid,l.id,l.content_id,l.storage_id,s.device_id,s.label,l.relative_path,l.state,l.size_bytes,lower(c.sha256),COALESCE(lower(l.destination_sha256),''),COALESCE(l.verified_at,''),COALESCE(l.last_seen_at,''),COALESCE(c.original_name,'') FROM locations l JOIN content c ON c.id=l.content_id JOIN storage s ON s.id=l.storage_id WHERE l.state<>'deleted' AND (?=0 OR l.rowid<?) ORDER BY l.rowid DESC LIMIT 33"); query.addBindValue(locationCursor); query.addBindValue(locationCursor);
            if (!query.exec()) fail(failure, query.lastError().text());
            else while (query.next()) {
                if (locations.size() == 32) { result["locationsHasMore"] = true; break; }
                locations.append(QJsonObject{{"cursor", query.value(0).toLongLong()}, {"id", query.value(1).toString().left(256)}, {"contentId", query.value(2).toString().left(256)}, {"storageId", query.value(3).toString().left(256)}, {"deviceId", query.value(4).toString().left(256)}, {"storageLabel", query.value(5).toString().left(256)}, {"relativePath", query.value(6).toString().left(1024)}, {"state", query.value(7).toString()}, {"sizeBytes", query.value(8).toLongLong()}, {"contentSha256", query.value(9).toString()}, {"receiptSha256", query.value(10).toString()}, {"verifiedAt", query.value(11).toString()}, {"lastSeen", query.value(12).toString()}, {"name", query.value(13).toString().left(256)}});
            }
            result["locations"] = locations; result["locationRequestCursor"] = locationCursor;
            result["locationNextCursor"] = locations.isEmpty() ? 0 : locations.last().toObject().value("cursor").toInteger();
            if (!result.contains("locationsHasMore")) result["locationsHasMore"] = false;
        }
        if (failure->isEmpty()) {
            if (!query.exec("SELECT state,bytes_total,bytes_done,updated_at FROM jobs WHERE state IN ('Queued','Copying','Verifying','Paused') ORDER BY updated_at DESC LIMIT 1")) fail(failure, query.lastError().text());
            else if (query.next()) result["activeTransfer"] = QJsonObject{{"state", query.value(0).toString()}, {"bytesTotal", query.value(1).toLongLong()}, {"bytesDone", query.value(2).toLongLong()}, {"updatedAt", query.value(3).toString()}};
        }
    }
    db.close(); db = {}; QSqlDatabase::removeDatabase(connection);
    if (!failure->isEmpty()) return {};
    return result;
}

QJsonArray applyReviewActions(const QString &databasePath, const QString &deviceStableId, const QJsonArray &actions, QString *error) {
    QJsonArray accepted;
    if (actions.size() > 16 || !deviceStableId.startsWith("wireless:")) { fail(error, QStringLiteral("Review action batch is invalid")); return accepted; }
    if (actions.isEmpty()) return accepted;
    QString localError;
    QString *failure = error ? error : &localError;
    failure->clear();
    const QString connection = QStringLiteral("review-action-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(databasePath);
    if (!db.open() || !db.transaction()) { fail(failure, db.lastError().text()); db = {}; QSqlDatabase::removeDatabase(connection); return accepted; }
    QSqlQuery query(db); const QString originId = deviceIdFor(deviceStableId);
    for (const QJsonValue &value : actions) {
        if (!value.isObject()) { fail(failure, QStringLiteral("Review action is invalid")); break; }
        const QJsonObject item = value.toObject(); const QString actionId = item.value("id").toString(), reviewId = item.value("reviewItemId").toString(), action = item.value("action").toString(), suppliedEvidence = item.value("evidenceSha256").toString().toLower();
        const qint64 generation = item.value("catalogGeneration").toVariant().toLongLong(), sequence = item.value("originSequence").toVariant().toLongLong();
        if (actionId.isEmpty() || actionId.size() > 256 || reviewId.isEmpty() || reviewId.size() > 256 || generation < 1 || sequence < 1 || !validHash(suppliedEvidence) || suppliedEvidence.isEmpty()) { fail(failure, QStringLiteral("Review action fields are invalid")); break; }
        query.prepare("SELECT origin_device_id,catalog_generation,origin_sequence,review_item_id,action,evidence_sha256 FROM review_resolutions WHERE id=?"); query.addBindValue(actionId);
        if (!query.exec()) { fail(failure, query.lastError().text()); break; }
        if (query.next()) {
            if (query.value(0).toString() != originId || query.value(1).toLongLong() != generation || query.value(2).toLongLong() != sequence || query.value(3).toString() != reviewId || query.value(4).toString() != action || query.value(5).toString() != suppliedEvidence) { fail(failure, QStringLiteral("Review action collision detected")); break; }
            accepted.append(actionId); continue;
        }
        query.prepare("SELECT category,source_kind,state,details_json,item_count FROM review_items WHERE id=?"); query.addBindValue(reviewId);
        if (!query.exec() || !query.next()) { fail(failure, QStringLiteral("Review item no longer exists")); break; }
        const QString category = query.value(0).toString(), source = query.value(1).toString(), state = query.value(2).toString(), detailsText = query.value(3).toString(); const int count = query.value(4).toInt(); const QJsonObject details = QJsonDocument::fromJson(detailsText.toUtf8()).object();
        const QString expectedEvidence = QString::fromLatin1(QCryptographicHash::hash((reviewId + '\n' + category + '\n' + state + '\n' + detailsText + '\n' + QString::number(count)).toUtf8(), QCryptographicHash::Sha256).toHex());
        const bool cleanMetadata = source == "metadata" && state == "saved" && details.value("changed").toInt() == 0 && details.value("missing").toInt() == 0;
        const bool allowed = (action == "save" && source != "job" && state != "saved") || (action == "dismiss" && cleanMetadata)
            || (action == "accept_existing" && source == "import" && category == "Duplicates" && !details.value("paths").toArray().isEmpty())
            || (action == "keep_both" && source == "import" && category == "Conflicts" && !details.value("paths").toArray().isEmpty())
            || (action == "skip_unsupported" && source == "import" && category == "Unsupported" && !details.value("evidence").toArray().isEmpty());
        if (!allowed || state == "resolved" || state == "dismissed" || suppliedEvidence != expectedEvidence) { fail(failure, QStringLiteral("Review action evidence changed or action is not allowed")); break; }
        query.prepare("INSERT INTO review_resolutions(id,origin_device_id,catalog_generation,origin_sequence,review_item_id,action,evidence_sha256,details_json) VALUES(?,?,?,?,?,?,?,?)"); query.addBindValue(actionId); query.addBindValue(originId); query.addBindValue(generation); query.addBindValue(sequence); query.addBindValue(reviewId); query.addBindValue(action); query.addBindValue(suppliedEvidence); query.addBindValue(detailsText);
        if (!query.exec()) { fail(failure, query.lastError().text()); break; }
        const QString targetState = action == "save" ? QStringLiteral("saved") : action == "dismiss" ? QStringLiteral("dismissed") : QStringLiteral("resolved");
        query.prepare("UPDATE review_items SET state=?,updated_at=CURRENT_TIMESTAMP,resolved_at=CASE WHEN ? IN ('dismissed','resolved') THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?"); query.addBindValue(targetState); query.addBindValue(targetState); query.addBindValue(reviewId);
        if (!query.exec()) { fail(failure, query.lastError().text()); break; }
        accepted.append(actionId);
    }
    if (failure->isEmpty()) { if (!db.commit()) fail(failure, db.lastError().text()); } else db.rollback();
    db.close(); db = {}; QSqlDatabase::removeDatabase(connection);
    if (!failure->isEmpty()) accepted = {};
    return accepted;
}

QJsonArray pendingCorrections(const QString &databasePath, const QString &deviceStableId, QString *error) {
    QJsonArray result; if (!deviceStableId.startsWith("wireless:")) { fail(error, QStringLiteral("Correction device is invalid")); return result; }
    const QString connection = QStringLiteral("correction-export-%1").arg(QUuid::createUuid().toString(QUuid::Id128));
    QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(databasePath); db.setConnectOptions(QStringLiteral("QSQLITE_OPEN_READONLY"));
    if (!db.open()) fail(error, db.lastError().text());
    else {
        QSqlQuery query(db); query.prepare("SELECT c.id,c.action,c.source_root,c.relative_path,c.expected_size,c.expected_sha256,c.created_at FROM device_corrections c JOIN devices d ON d.id=c.target_device_id LEFT JOIN device_correction_results r ON r.correction_id=c.id WHERE d.stable_id=? AND r.id IS NULL ORDER BY c.rowid LIMIT 16"); query.addBindValue(deviceStableId);
        if (!query.exec()) fail(error, query.lastError().text());
        else while (query.next()) result.append(QJsonObject{{"id", query.value(0).toString().left(256)}, {"action", query.value(1).toString()}, {"root", query.value(2).toString()}, {"relativePath", query.value(3).toString().left(4096)}, {"expectedSize", query.value(4).toLongLong()}, {"expectedSha256", query.value(5).toString()}, {"createdAt", query.value(6).toString()}});
    }
    db.close(); db = {}; QSqlDatabase::removeDatabase(connection); return result;
}

QJsonArray applyCorrectionResults(const QString &databasePath, const QString &deviceStableId, const QJsonArray &results, QString *error) {
    QJsonArray accepted; if (!deviceStableId.startsWith("wireless:") || results.size() > 16) { fail(error, QStringLiteral("Correction result batch is invalid")); return accepted; }
    if (results.isEmpty()) return accepted;
    QString localError; QString *failure = error ? error : &localError; failure->clear();
    const QString connection = QStringLiteral("correction-result-%1").arg(QUuid::createUuid().toString(QUuid::Id128)); QSqlDatabase db = QSqlDatabase::addDatabase(QStringLiteral("QSQLITE"), connection); db.setDatabaseName(databasePath);
    if (!db.open() || !db.transaction()) fail(failure, db.lastError().text());
    else {
        QSqlQuery query(db); const QString originId = deviceIdFor(deviceStableId);
        for (const QJsonValue &value : results) {
            if (!value.isObject()) { fail(failure, QStringLiteral("Correction result is invalid")); break; }
            const QJsonObject item = value.toObject(); const QString id = item.value("id").toString(), correctionId = item.value("correctionId").toString(), status = item.value("status").toString(), hash = item.value("observedSha256").toString().toLower(), message = item.value("error").toString().left(512); const qint64 size = item.contains("observedSize") ? item.value("observedSize").toVariant().toLongLong() : -1;
            if (id.isEmpty() || id.size() > 256 || correctionId.isEmpty() || correctionId.size() > 256 || !QStringList{"verified","changed","missing","failed"}.contains(status) || size < -1 || (!hash.isEmpty() && !validHash(hash)) || (status == "verified" && hash.isEmpty()) || (status == "failed" && message.isEmpty())) { fail(failure, QStringLiteral("Correction result fields are invalid")); break; }
            query.prepare("SELECT r.origin_device_id,r.correction_id,r.status,COALESCE(r.observed_size,-1),COALESCE(r.observed_sha256,''),r.error_message FROM device_correction_results r WHERE r.id=?"); query.addBindValue(id);
            if (!query.exec()) { fail(failure, query.lastError().text()); break; }
            if (query.next()) {
                if (query.value(0).toString()!=originId || query.value(1).toString()!=correctionId || query.value(2).toString()!=status || query.value(3).toLongLong()!=size || query.value(4).toString()!=hash || query.value(5).toString()!=message) { fail(failure, QStringLiteral("Correction result collision detected")); break; }
                accepted.append(id); continue;
            }
            query.prepare("SELECT c.expected_size,c.expected_sha256,COALESCE(c.review_item_id,'') FROM device_corrections c JOIN devices d ON d.id=c.target_device_id WHERE c.id=? AND d.stable_id=?"); query.addBindValue(correctionId); query.addBindValue(deviceStableId);
            if (!query.exec() || !query.next()) { fail(failure, QStringLiteral("Correction request is missing or targets another device")); break; }
            if (status == "verified" && (size != query.value(0).toLongLong() || hash != query.value(1).toString())) { fail(failure, QStringLiteral("Verified correction result does not match expected evidence")); break; }
            const QString reviewId = query.value(2).toString();
            query.prepare("INSERT INTO device_correction_results(id,correction_id,origin_device_id,status,observed_size,observed_sha256,error_message) VALUES(?,?,?,?,?,?,?)"); query.addBindValue(id); query.addBindValue(correctionId); query.addBindValue(originId); query.addBindValue(status); query.addBindValue(size < 0 ? QVariant() : QVariant(size)); query.addBindValue(hash.isEmpty() ? QVariant() : QVariant(hash)); query.addBindValue(message);
            if (!query.exec()) { fail(failure, query.lastError().text()); break; }
            if (!reviewId.isEmpty()) {
                const QString reviewState = status == "verified" ? QStringLiteral("resolved") : status == "failed" ? QStringLiteral("needs_device") : QStringLiteral("needs_decision");
                query.prepare("UPDATE review_items SET state=?,updated_at=CURRENT_TIMESTAMP,resolved_at=CASE WHEN ?='resolved' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?"); query.addBindValue(reviewState); query.addBindValue(reviewState); query.addBindValue(reviewId);
                if (!query.exec()) { fail(failure, query.lastError().text()); break; }
            }
            accepted.append(id);
        }
        if (failure->isEmpty()) { if (!db.commit()) fail(failure, db.lastError().text()); } else db.rollback();
    }
    db.close(); db = {}; QSqlDatabase::removeDatabase(connection); if (!failure->isEmpty()) accepted = {}; return accepted;
}

QJsonObject mergeAcknowledgement(const QString &databasePath, const Delta &delta, qint64 resolutionGeneration, qint64 resolutionCursor, QString *error) {
    return mergeAcknowledgement(databasePath, delta, resolutionGeneration, resolutionCursor, {}, error);
}

QJsonObject mergeAcknowledgement(const QString &databasePath, const Delta &delta, qint64 resolutionGeneration, qint64 resolutionCursor, const QJsonArray &reviewActions, QString *error) {
    return mergeAcknowledgement(databasePath, delta, resolutionGeneration, resolutionCursor, reviewActions, 0, error);
}

QJsonObject mergeAcknowledgement(const QString &databasePath, const Delta &delta, qint64 resolutionGeneration, qint64 resolutionCursor, const QJsonArray &reviewActions, qint64 locationCursor, QString *error) {
    return mergeAcknowledgement(databasePath, delta, resolutionGeneration, resolutionCursor, reviewActions, locationCursor, {}, error);
}

QJsonObject mergeAcknowledgement(const QString &databasePath, const Delta &delta, qint64 resolutionGeneration, qint64 resolutionCursor, const QJsonArray &reviewActions, qint64 locationCursor, const QJsonArray &correctionResults, QString *error) {
    QString localError; QString *failure = error ? error : &localError; failure->clear();
    if (resolutionGeneration < 0 || resolutionCursor < 0) { fail(failure, QStringLiteral("Resolution cursor is invalid")); return {}; }
    QVariantMap summary;
    if (!mergeFile(databasePath, delta, &summary, failure)) return {};
    const QJsonArray acceptedReviewActions = applyReviewActions(databasePath, delta.deviceId, reviewActions, failure);
    if (!failure->isEmpty()) return {};
    const QJsonArray acceptedCorrectionResults = applyCorrectionResults(databasePath, delta.deviceId, correctionResults, failure);
    if (!failure->isEmpty()) return {};
    const QJsonArray resolutions = resolutionsAfter(databasePath, resolutionGeneration, resolutionCursor, failure);
    if (!failure->isEmpty()) return {};
    const QJsonArray reviews = activeReviews(databasePath, failure);
    if (!failure->isEmpty()) return {};
    const QJsonObject snapshot = catalogSnapshot(databasePath, locationCursor, failure);
    if (!failure->isEmpty()) return {};
    const QJsonArray corrections = pendingCorrections(databasePath, delta.deviceId, failure);
    if (!failure->isEmpty()) return {};
    QJsonObject response{{"type", "metadata-ok"}, {"protocol", LocalDrive::WirelessProtocol::Version},
            {"cursor", summary.value("cursor").toLongLong()}, {"pendingFiles", summary.value("files").toLongLong()},
            {"pendingBytes", summary.value("bytes").toLongLong()}, {"lastUpdate", summary.value("lastUpdate").toString()},
            {"resolutions", resolutions}, {"activeReviews", reviews}, {"acceptedReviewActions", acceptedReviewActions}, {"corrections", corrections}, {"acceptedCorrectionResults", acceptedCorrectionResults}, {"catalogSnapshot", snapshot}};
    while (QJsonDocument(response).toJson(QJsonDocument::Compact).size() > LocalDrive::WirelessProtocol::MaxHeaderBytes - 1024) {
        QJsonObject bounded = response.value("catalogSnapshot").toObject(); QJsonArray items = bounded.value("locations").toArray();
        if (!items.isEmpty()) { items.removeLast(); bounded["locations"] = items; bounded["locationsTruncated"] = true; bounded["locationsHasMore"] = true; bounded["locationNextCursor"] = items.isEmpty() ? bounded.value("locationRequestCursor") : items.last().toObject().value("cursor"); response["catalogSnapshot"] = bounded; continue; }
        QJsonArray exported = response.value("resolutions").toArray();
        if (!exported.isEmpty()) { exported.removeLast(); response["resolutions"] = exported; response["resolutionsTruncated"] = true; continue; }
        exported = response.value("corrections").toArray();
        if (!exported.isEmpty()) { exported.removeLast(); response["corrections"] = exported; response["correctionsTruncated"] = true; continue; }
        QJsonArray active = response.value("activeReviews").toArray();
        if (!active.isEmpty()) { active.removeLast(); response["activeReviews"] = active; response["activeReviewsTruncated"] = true; continue; }
        items = bounded.value("devices").toArray();
        if (!items.isEmpty()) { items.removeLast(); bounded["devices"] = items; bounded["devicesTruncated"] = true; response["catalogSnapshot"] = bounded; continue; }
        items = bounded.value("storages").toArray();
        if (!items.isEmpty()) { items.removeLast(); bounded["storages"] = items; bounded["storagesTruncated"] = true; response["catalogSnapshot"] = bounded; continue; }
        return fail(failure, QStringLiteral("Metadata acknowledgement exceeds the protocol limit")), QJsonObject{};
    }
    return response;
}

}
