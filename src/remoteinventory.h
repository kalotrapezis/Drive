#pragma once

#include <QUrl>
#include <QString>
#include <QVector>
#include <atomic>

struct RemoteInventoryItem {
    QUrl url;
    QString relative;
    qint64 size = 0;
    bool supported = true;
};

bool collectRemoteDirectory(const QUrl &root, qint64 maxItems, qint64 maxBytes,
                            QVector<RemoteInventoryItem> &items, QString *error,
                            const std::atomic_bool *cancelled = nullptr, int timeoutMs = 0);
