#pragma once

#include <QByteArray>
#include <QtGlobal>
#include <QString>

namespace LocalDrive::WirelessProfile {

QString normalizedFingerprint(QString fingerprint);
QString certificateFingerprint(const QByteArray &pem, QString *error = nullptr);
bool exportProfile(const QString &path, const QString &host, quint16 port,
                   const QString &serverCertificatePath, const QString &fingerprint, QString *error);
bool acceptProfile(const QString &inputPath, const QString &clientCertificatePath,
                   QString *deviceId, QString *fingerprint, QString *error);

}
