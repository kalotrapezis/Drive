#include <QtTest>
#include <QJsonArray>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QSet>

#include "../src/metadatasync.h"
#include "../src/verifiedcopy.h"
#include "../src/wirelessprotocol.h"

class MetadataSyncTest final : public QObject {
    Q_OBJECT
private slots:
    void mergesOutOfOrderAndIsIdempotent() {
        QTemporaryDir directory; QVERIFY(directory.isValid());
        const QString database = directory.filePath("catalog.sqlite");
        QVERIFY2(VerifiedCopy::ensureCatalog(database), "catalog initialization failed");
        LocalDrive::Metadata::Delta later{"wireless:test-phone", "Test phone", 1, {
            {"item-b", "Drive", "folder/b.txt", 2, 200, 2, {}, {}, {}, {}}
        }};
        QVariantMap summary;
        QVERIFY2(LocalDrive::Metadata::mergeFile(database, later, &summary), "metadata merge failed");
        QCOMPARE(summary.value("cursor").toLongLong(), 0);
        QCOMPARE(summary.value("files").toLongLong(), 1);
        LocalDrive::Metadata::Delta first{"wireless:test-phone", "Test phone", 1, {
            {"item-a", "DCIM", "a.jpg", 5, 100, 1, "2026-08-28T10:00:00Z", "image/jpeg", QJsonObject{{"camera", "test"}}, {}}
        }};
        QVERIFY2(LocalDrive::Metadata::mergeFile(database, first, &summary), "metadata merge failed");
        QCOMPARE(summary.value("cursor").toLongLong(), 2);
        QCOMPARE(summary.value("files").toLongLong(), 2);
        QCOMPARE(summary.value("bytes").toLongLong(), 7);
        QVERIFY(LocalDrive::Metadata::mergeFile(database, first, &summary));
        QCOMPARE(summary.value("files").toLongLong(), 2);

        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "metadata-check"); db.setDatabaseName(database); QVERIFY(db.open()); QSqlQuery query(db);
        QVERIFY(query.exec("SELECT COUNT(*),MAX(highest_contiguous) FROM metadata_events e JOIN metadata_cursors c ON c.origin_device_id=e.origin_device_id")); QVERIFY(query.next());
        QCOMPARE(query.value(0).toInt(), 2); QCOMPARE(query.value(1).toLongLong(), 2);
        db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("metadata-check");
    }

    void rejectsUnsafeMetadata() {
        LocalDrive::Metadata::Delta delta;
        QJsonObject item{{"itemId", "bad"}, {"root", "Drive"}, {"relativePath", "../escape"}, {"sizeBytes", 1}, {"modifiedAt", 1}, {"originSequence", 1}};
        QJsonObject frame{{"type", "metadata"}, {"protocol", LocalDrive::WirelessProtocol::Version}, {"deviceId", "wireless:test-phone"},
                          {"name", "Test phone"}, {"catalogGeneration", 1}, {"items", QJsonArray{item}}};
        QVERIFY(!LocalDrive::Metadata::fromJson(frame, &delta));
    }

    void acceptsEmptyMetadataHeartbeat() {
        LocalDrive::Metadata::Delta delta;
        const QJsonObject frame{{"type", "metadata"}, {"protocol", LocalDrive::WirelessProtocol::Version},
                                {"deviceId", "wireless:test-phone"}, {"name", "Test phone"},
                                {"catalogGeneration", 1}, {"items", QJsonArray{}}};
        QString error;
        QVERIFY2(LocalDrive::Metadata::fromJson(frame, &delta, &error), qPrintable(error));
        QVERIFY(delta.items.isEmpty());

        QTemporaryDir directory; QVERIFY(directory.isValid());
        const QString database = directory.filePath("catalog.sqlite");
        const QJsonObject acknowledgement = LocalDrive::Metadata::mergeAcknowledgement(database, delta, 0, 0, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error));
        QCOMPARE(acknowledgement.value("type").toString(), QStringLiteral("metadata-ok"));
        QVERIFY(acknowledgement.value("resolutions").toArray().isEmpty());
    }

    void exportsBoundedResolutionEvents() {
        QTemporaryDir directory; QVERIFY(directory.isValid());
        const QString database = directory.filePath("catalog.sqlite");
        QVERIFY(VerifiedCopy::ensureCatalog(database));
        {
            QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "resolution-export-setup"); db.setDatabaseName(database); QVERIFY(db.open()); QSqlQuery query(db);
            QVERIFY(query.exec("INSERT INTO devices(id,stable_id,name,kind,is_local) VALUES('local','machine:test','Test laptop','Laptop',1)"));
            QVERIFY(query.exec("INSERT INTO review_items(id,category,source_kind,source_id,title,state) VALUES('review-test','External changes','metadata','test-source','Indexed file','dismissed')"));
            QVERIFY(query.exec("INSERT INTO review_resolutions(id,origin_device_id,catalog_generation,origin_sequence,review_item_id,action,evidence_sha256) VALUES('resolution-test','local',1,7,'review-test','dismiss',lower(hex(zeroblob(32))))"));
            QVERIFY(query.exec("SELECT COUNT(*),MIN(origin_device_id) FROM review_resolutions")); QVERIFY(query.next()); QCOMPARE(query.value(0).toInt(), 1); QCOMPARE(query.value(1).toString(), QStringLiteral("local"));
            QVERIFY(query.exec("SELECT COUNT(*) FROM review_resolutions rr JOIN devices d ON d.id=rr.origin_device_id JOIN review_items ri ON ri.id=rr.review_item_id WHERE rr.origin_device_id='local' AND rr.origin_sequence>0")); QVERIFY(query.next()); QCOMPARE(query.value(0).toInt(), 1);
            query.finish(); db.close();
        }
        QSqlDatabase::removeDatabase("resolution-export-setup");
        QString error;
        const QJsonArray first = LocalDrive::Metadata::resolutionsAfter(database, 0, 0, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error)); QCOMPARE(first.size(), 1); QCOMPARE(first.first().toObject().value("action").toString(), QStringLiteral("dismiss")); QCOMPARE(first.first().toObject().value("originSequence").toInt(), 7);
        QCOMPARE(LocalDrive::Metadata::resolutionsAfter(database, 1, 7, &error).size(), 0);
        LocalDrive::Metadata::Delta phone{"wireless:test-phone", "Test phone", 1, {{"phone-item", "Drive", "phone.txt", 4, 10, 1, {}, {}, {}, {}}}};
        const QJsonObject acknowledgement = LocalDrive::Metadata::mergeAcknowledgement(database, phone, 0, 0, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error)); QCOMPARE(acknowledgement.value("type").toString(), QStringLiteral("metadata-ok")); QCOMPARE(acknowledgement.value("resolutions").toArray().size(), 1);
        QCOMPARE(LocalDrive::Metadata::mergeAcknowledgement(database, phone, 1, 7, &error).value("resolutions").toArray().size(), 0);
        {
            QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "resolution-generation-setup"); db.setDatabaseName(database); QVERIFY(db.open()); QSqlQuery query(db);
            QVERIFY(query.exec("INSERT INTO review_resolutions(id,origin_device_id,catalog_generation,origin_sequence,review_item_id,action,evidence_sha256) VALUES('resolution-next-generation','local',2,1,'review-test','save',lower(hex(zeroblob(32))))"));
            db.close();
        }
        QSqlDatabase::removeDatabase("resolution-generation-setup");
        const QJsonArray nextGeneration = LocalDrive::Metadata::resolutionsAfter(database, 1, 7, &error);
        QCOMPARE(nextGeneration.size(), 1); QCOMPARE(nextGeneration.first().toObject().value("catalogGeneration").toInt(), 2);
        QVERIFY(LocalDrive::Metadata::resolutionsAfter(database, -1, 0, &error).isEmpty()); QVERIFY(!error.isEmpty());
    }

    void appliesPhoneReviewDecisionOnlyForCurrentEvidence() {
        QTemporaryDir directory; QVERIFY(directory.isValid());
        const QString database = directory.filePath("catalog.sqlite");
        QVERIFY(VerifiedCopy::ensureCatalog(database));
        {
            QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "phone-review-setup"); db.setDatabaseName(database); QVERIFY(db.open()); QSqlQuery query(db);
            QVERIFY(query.exec("INSERT INTO devices(id,stable_id,name,kind,is_local) VALUES('local','machine:test','Test laptop','Laptop',1)"));
            QVERIFY(query.exec("INSERT INTO storage(id,stable_identity,device_id,kind,label,selected_root,presence,bytes_total,bytes_free) VALUES('local','storage:test','local','local','Laptop storage','/','present',1000,250)"));
            for (int index = 0; index < 31; ++index) {
                const QString suffix = QString::number(index), deviceId = QString(230, QLatin1Char('d')) + suffix, storageId = QString(230, QLatin1Char('s')) + suffix;
                query.prepare("INSERT INTO devices(id,stable_id,name,kind) VALUES(?,?,?,'Phone')"); query.addBindValue(deviceId); query.addBindValue(QStringLiteral("wireless:") + QString(220, QLatin1Char('w')) + suffix); query.addBindValue(QString(240, QLatin1Char('n')) + suffix); QVERIFY(query.exec());
                query.prepare("INSERT INTO storage(id,stable_identity,device_id,kind,label,selected_root,presence,bytes_total,bytes_free) VALUES(?,?,?,'mtp',?,?,'offline',1000,500)"); query.addBindValue(storageId); query.addBindValue(QStringLiteral("storage:") + QString(220, QLatin1Char('i')) + suffix); query.addBindValue(deviceId); query.addBindValue(QString(240, QLatin1Char('l')) + suffix); query.addBindValue(QStringLiteral("/extra/%1").arg(index)); QVERIFY(query.exec());
            }
            for (int index = 0; index < 64; ++index) {
                const QString hash = QStringLiteral("%1").arg(index + 1, 64, 16, QLatin1Char('0'));
                query.prepare("INSERT INTO content(id,sha256,size_bytes,original_name) VALUES(?,?,1,?)"); query.addBindValue(QStringLiteral("content-%1").arg(index)); query.addBindValue(hash); query.addBindValue(QStringLiteral("file-%1").arg(index)); QVERIFY(query.exec());
                query.prepare("INSERT INTO locations(id,content_id,storage_id,relative_path,state,size_bytes,source_sha256,destination_sha256,verified_at) VALUES(?,?,?,?,'verified',1,?,?,CURRENT_TIMESTAMP)");
                query.addBindValue(QStringLiteral("location-%1").arg(index)); query.addBindValue(QStringLiteral("content-%1").arg(index)); query.addBindValue("local"); query.addBindValue(QString(900, QLatin1Char('a')) + QString::number(index)); query.addBindValue(hash); query.addBindValue(hash); QVERIFY(query.exec());
            }
            query.prepare("INSERT INTO review_items(id,category,source_kind,source_id,title,summary,details_json,item_count) VALUES('duplicate-review','Duplicates','import','import-1','Existing copies','One file','{\"paths\":[\"a.jpg\"]}',1)");
            QVERIFY(query.exec()); db.close();
        }
        QSqlDatabase::removeDatabase("phone-review-setup");
        LocalDrive::Metadata::Delta phone{"wireless:test-phone", "Test phone", 1, {}};
        QString error;
        QJsonObject acknowledgement = LocalDrive::Metadata::mergeAcknowledgement(database, phone, 0, 0, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error));
        const QJsonObject review = acknowledgement.value("activeReviews").toArray().first().toObject();
        QCOMPARE(review.value("id").toString(), QStringLiteral("duplicate-review"));
        QVERIFY(review.value("allowedActions").toArray().contains(QStringLiteral("accept_existing")));
        const QJsonObject snapshot = acknowledgement.value("catalogSnapshot").toObject();
        QCOMPARE(snapshot.value("devices").toArray().first().toObject().value("label").toString(), QStringLiteral("Test laptop"));
        QCOMPARE(snapshot.value("storages").toArray().first().toObject().value("bytesTotal").toInt(), 1000);
        QCOMPARE(snapshot.value("storages").toArray().first().toObject().value("bytesFree").toInt(), 250);
        QVERIFY(snapshot.value("locationsTruncated").toBool());
        QVERIFY(!snapshot.value("locations").toArray().isEmpty());
        const QJsonObject location = snapshot.value("locations").toArray().first().toObject();
        QCOMPARE(location.value("state").toString(), QStringLiteral("verified")); QCOMPARE(location.value("contentSha256"), location.value("receiptSha256"));
        QVERIFY(QJsonDocument(acknowledgement).toJson(QJsonDocument::Compact).size() < LocalDrive::WirelessProtocol::MaxHeaderBytes);
        const qint64 nextLocationCursor = snapshot.value("locationNextCursor").toInteger(); QVERIFY(nextLocationCursor > 0); QVERIFY(snapshot.value("locationsHasMore").toBool());
        const QJsonObject olderAcknowledgement = LocalDrive::Metadata::mergeAcknowledgement(database, phone, 0, 0, QJsonArray{}, nextLocationCursor, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error)); const QJsonObject olderSnapshot = olderAcknowledgement.value("catalogSnapshot").toObject();
        QCOMPARE(olderSnapshot.value("locationRequestCursor").toInteger(), nextLocationCursor); QVERIFY(!olderSnapshot.value("locations").toArray().isEmpty());
        QSet<QString> latestIds; for (const QJsonValue &value : snapshot.value("locations").toArray()) latestIds.insert(value.toObject().value("id").toString());
        for (const QJsonValue &value : olderSnapshot.value("locations").toArray()) QVERIFY(!latestIds.contains(value.toObject().value("id").toString()));
        const QString correctionHash = QStringLiteral("%1").arg(1, 64, 16, QLatin1Char('0'));
        {
            QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "correction-setup"); db.setDatabaseName(database); QVERIFY(db.open()); QSqlQuery query(db);
            QVERIFY(query.exec("INSERT INTO review_items(id,category,source_kind,source_id,title,summary,item_count,state) VALUES('correction-review','External changes','metadata','correction-source','Recheck phone item','Verify source evidence',1,'needs_device')"));
            query.prepare("INSERT INTO device_corrections(id,target_device_id,review_item_id,action,source_root,relative_path,expected_size,expected_sha256) SELECT 'correction-1',id,'correction-review','recheck_location','Drive','folder/a.txt',1,? FROM devices WHERE stable_id='wireless:test-phone'"); query.addBindValue(correctionHash); QVERIFY(query.exec()); QCOMPARE(query.numRowsAffected(), 1); db.close();
        }
        QSqlDatabase::removeDatabase("correction-setup");
        acknowledgement = LocalDrive::Metadata::mergeAcknowledgement(database, phone, 0, 0, &error); QVERIFY2(error.isEmpty(), qPrintable(error));
        QCOMPARE(acknowledgement.value("corrections").toArray().first().toObject().value("id").toString(), QStringLiteral("correction-1"));
        QJsonObject correctionResult{{"id", "correction-result-1"}, {"correctionId", "correction-1"}, {"status", "verified"}, {"observedSize", 1}, {"observedSha256", QString(64, QLatin1Char('f'))}, {"error", ""}};
        QVERIFY(LocalDrive::Metadata::mergeAcknowledgement(database, phone, 0, 0, QJsonArray{}, 0, QJsonArray{correctionResult}, &error).isEmpty()); QVERIFY(!error.isEmpty()); error.clear(); correctionResult["observedSha256"] = correctionHash;
        acknowledgement = LocalDrive::Metadata::mergeAcknowledgement(database, phone, 0, 0, QJsonArray{}, 0, QJsonArray{correctionResult}, &error); QVERIFY2(error.isEmpty(), qPrintable(error));
        QCOMPARE(acknowledgement.value("acceptedCorrectionResults").toArray(), QJsonArray{"correction-result-1"}); QVERIFY(acknowledgement.value("corrections").toArray().isEmpty());
        QCOMPARE(LocalDrive::Metadata::mergeAcknowledgement(database, phone, 0, 0, QJsonArray{}, 0, QJsonArray{correctionResult}, &error).value("acceptedCorrectionResults").toArray(), QJsonArray{"correction-result-1"});
        {
            QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "correction-review-check"); db.setDatabaseName(database); QVERIFY(db.open()); QSqlQuery query(db);
            QVERIFY(query.exec("SELECT state,resolved_at IS NOT NULL FROM review_items WHERE id='correction-review'")); QVERIFY(query.next()); QCOMPARE(query.value(0).toString(), QStringLiteral("resolved")); QVERIFY(query.value(1).toBool()); db.close();
        }
        QSqlDatabase::removeDatabase("correction-review-check");

        QJsonObject action{{"id", "phone-action-1"}, {"reviewItemId", "duplicate-review"}, {"action", "accept_existing"},
                           {"evidenceSha256", QString(64, '0')}, {"catalogGeneration", 1}, {"originSequence", 1}};
        acknowledgement = LocalDrive::Metadata::mergeAcknowledgement(database, phone, 0, 0, QJsonArray{action}, &error);
        QVERIFY(acknowledgement.isEmpty()); QVERIFY(!error.isEmpty());

        error.clear(); action["evidenceSha256"] = review.value("evidenceSha256");
        acknowledgement = LocalDrive::Metadata::mergeAcknowledgement(database, phone, 0, 0, QJsonArray{action}, &error);
        QVERIFY2(error.isEmpty(), qPrintable(error));
        QCOMPARE(acknowledgement.value("acceptedReviewActions").toArray(), QJsonArray{"phone-action-1"});
        QVERIFY(acknowledgement.value("activeReviews").toArray().isEmpty());
        QCOMPARE(LocalDrive::Metadata::mergeAcknowledgement(database, phone, 0, 0, QJsonArray{action}, &error).value("acceptedReviewActions").toArray(), QJsonArray{"phone-action-1"});

        QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", "phone-review-check"); db.setDatabaseName(database); QVERIFY(db.open()); QSqlQuery query(db);
        QVERIFY(query.exec("SELECT ri.state,d.stable_id FROM review_items ri JOIN review_resolutions rr ON rr.review_item_id=ri.id JOIN devices d ON d.id=rr.origin_device_id WHERE ri.id='duplicate-review'")); QVERIFY(query.next());
        QCOMPARE(query.value(0).toString(), QStringLiteral("resolved")); QCOMPARE(query.value(1).toString(), QStringLiteral("wireless:test-phone"));
        db.close(); db = QSqlDatabase(); QSqlDatabase::removeDatabase("phone-review-check");
    }
};

QTEST_MAIN(MetadataSyncTest)
#include "metadatasync_test.moc"
