#pragma once

#include <QJsonObject>
#include <QJsonArray>
#include <QString>
#include <QVariantMap>
#include <QVector>

class QSqlDatabase;

namespace LocalDrive::Metadata {

struct Item {
    QString itemId;
    QString root;
    QString relativePath;
    qint64 sizeBytes = 0;
    qint64 modifiedAt = 0;
    qint64 originSequence = 0;
    QString capturedAt;
    QString typeHint;
    QJsonObject mediaMetadata;
    QString contentSha256;
};

struct Delta {
    QString deviceId;
    QString deviceName;
    qint64 catalogGeneration = 1;
    QVector<Item> items;
};

bool fromJson(const QJsonObject &object, Delta *delta, QString *error = nullptr);
bool mergeFile(const QString &databasePath, const Delta &delta, QVariantMap *summary = nullptr, QString *error = nullptr);
QJsonArray resolutionsAfter(const QString &databasePath, qint64 generation, qint64 cursor, QString *error = nullptr);
QJsonArray activeReviews(const QString &databasePath, QString *error = nullptr);
QJsonObject catalogSnapshot(const QString &databasePath, qint64 locationCursor = 0, QString *error = nullptr);
QJsonArray applyReviewActions(const QString &databasePath, const QString &deviceStableId, const QJsonArray &actions, QString *error = nullptr);
QJsonArray pendingCorrections(const QString &databasePath, const QString &deviceStableId, QString *error = nullptr);
QJsonArray applyCorrectionResults(const QString &databasePath, const QString &deviceStableId, const QJsonArray &results, QString *error = nullptr);
QJsonObject mergeAcknowledgement(const QString &databasePath, const Delta &delta, qint64 resolutionGeneration, qint64 resolutionCursor, QString *error = nullptr);
QJsonObject mergeAcknowledgement(const QString &databasePath, const Delta &delta, qint64 resolutionGeneration, qint64 resolutionCursor, const QJsonArray &reviewActions, QString *error);
QJsonObject mergeAcknowledgement(const QString &databasePath, const Delta &delta, qint64 resolutionGeneration, qint64 resolutionCursor, const QJsonArray &reviewActions, qint64 locationCursor, QString *error);
QJsonObject mergeAcknowledgement(const QString &databasePath, const Delta &delta, qint64 resolutionGeneration, qint64 resolutionCursor, const QJsonArray &reviewActions, qint64 locationCursor, const QJsonArray &correctionResults, QString *error);

}
