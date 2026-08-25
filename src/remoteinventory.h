#pragma once

#include <QUrl>
#include <QString>
#include <QVector>

struct RemoteInventoryItem {
    QUrl url;
    QString relative;
    qint64 size = 0;
};

bool collectRemoteDirectory(const QUrl &root, qint64 maxItems, qint64 maxBytes,
                            QVector<RemoteInventoryItem> &items, QString *error);
