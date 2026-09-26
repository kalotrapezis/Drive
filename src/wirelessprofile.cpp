#include "wirelessprofile.h"

#include <QCryptographicHash>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>
#include <QSslCertificate>

namespace LocalDrive::WirelessProfile {

QString normalizedFingerprint(QString fingerprint) {
    return fingerprint.remove(QLatin1Char(':')).remove(QLatin1Char(' ')).toLower();
}

QString certificateFingerprint(const QByteArray &pem, QString *error) {
    const auto certificates = QSslCertificate::fromData(pem, QSsl::Pem);
    if (certificates.isEmpty()) {
        if (error) *error = QStringLiteral("no readable PEM certificate found");
        return {};
    }
    return QString::fromLatin1(certificates.first().digest(QCryptographicHash::Sha256).toHex());
}

bool exportProfile(const QString &path, const QString &host, quint16 port,
                   const QString &serverCertificatePath, const QString &fingerprint, QString *error) {
    if (host.trimmed().isEmpty() || port == 0) {
        if (error) *error = QStringLiteral("wireless profile needs a host and non-zero port");
        return false;
    }
    QFile certificate(serverCertificatePath);
    if (!certificate.open(QIODevice::ReadOnly | QIODevice::Text)) {
        if (error) *error = certificate.errorString();
        return false;
    }
    const QByteArray pem = certificate.readAll();
    QString certificateError;
    const QString expected = certificateFingerprint(pem, &certificateError);
    if (expected.isEmpty()) {
        if (error) *error = certificateError;
        return false;
    }
    if (normalizedFingerprint(fingerprint) != expected) {
        if (error) *error = QStringLiteral("server fingerprint does not match SERVER_CERT (expected %1)").arg(expected);
        return false;
    }
    QSaveFile output(path);
    if (!output.open(QIODevice::WriteOnly | QIODevice::Text)) {
        if (error) *error = output.errorString();
        return false;
    }
    const QJsonObject profile{{"protocol", 1}, {"host", host.trimmed()}, {"port", static_cast<int>(port)},
                              {"serverFingerprint", expected}, {"serverCaPem", QString::fromUtf8(pem)}};
    if (output.write(QJsonDocument(profile).toJson(QJsonDocument::Indented)) < 0 || !output.commit()) {
        if (error) *error = output.errorString();
        return false;
    }
    return true;
}

bool acceptProfile(const QString &inputPath, const QString &clientCertificatePath,
                   QString *deviceId, QString *fingerprint, QString *error) {
    if (QFileInfo(inputPath).absoluteFilePath() == QFileInfo(clientCertificatePath).absoluteFilePath()) {
        if (error) *error = QStringLiteral("profile input and client certificate output must differ");
        return false;
    }
    QFile input(inputPath);
    if (!input.open(QIODevice::ReadOnly | QIODevice::Text)) {
        if (error) *error = input.errorString();
        return false;
    }
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(input.readAll(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
        if (error) *error = QStringLiteral("invalid JSON profile: %1").arg(parseError.errorString());
        return false;
    }
    const QJsonObject profile = document.object();
    if (profile.value(QStringLiteral("protocol")).toInt(-1) != 1) {
        if (error) *error = QStringLiteral("unsupported pairing profile protocol");
        return false;
    }
    const QString id = profile.value(QStringLiteral("deviceId")).toString();
    if (!id.startsWith(QStringLiteral("wireless:"))) {
        if (error) *error = QStringLiteral("pairing profile has no wireless device identity");
        return false;
    }
    const QByteArray pem = profile.value(QStringLiteral("clientCertificatePem")).toString().toUtf8();
    QString certificateError;
    const QString actual = certificateFingerprint(pem, &certificateError);
    if (actual.isEmpty()) {
        if (error) *error = certificateError;
        return false;
    }
    if (normalizedFingerprint(profile.value(QStringLiteral("clientFingerprint")).toString()) != actual) {
        if (error) *error = QStringLiteral("client fingerprint does not match the certificate (actual %1)").arg(actual);
        return false;
    }
    QSaveFile output(clientCertificatePath);
    if (!output.open(QIODevice::WriteOnly | QIODevice::Text)) {
        if (error) *error = output.errorString();
        return false;
    }
    const auto certificates = QSslCertificate::fromData(pem, QSsl::Pem);
    if (output.write(certificates.first().toPem()) < 0 || !output.commit()) {
        if (error) *error = output.errorString();
        return false;
    }
    if (deviceId) *deviceId = id;
    if (fingerprint) *fingerprint = actual;
    return true;
}

}
