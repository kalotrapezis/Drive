#pragma once

#include <QObject>
#include <QStringList>

#include "wirelesssession.h"

class SetupModel;

class WirelessReceiverController final : public QObject {
    Q_OBJECT
    Q_PROPERTY(bool listening READ listening NOTIFY changed)
    Q_PROPERTY(QString status READ status NOTIFY changed)
    Q_PROPERTY(QStringList logEntries READ logEntries NOTIFY changed)
    Q_PROPERTY(quint16 port READ port NOTIFY changed)
    Q_PROPERTY(QString savedDestination READ savedDestination NOTIFY changed)
    Q_PROPERTY(QString savedCertificate READ savedCertificate NOTIFY changed)
    Q_PROPERTY(QString savedPrivateKey READ savedPrivateKey NOTIFY changed)
    Q_PROPERTY(QString savedClientCa READ savedClientCa NOTIFY changed)
    Q_PROPERTY(QString savedFingerprint READ savedFingerprint NOTIFY changed)
    Q_PROPERTY(quint16 savedPort READ savedPort NOTIFY changed)
    Q_PROPERTY(bool savedEnabled READ savedEnabled NOTIFY changed)
public:
    explicit WirelessReceiverController(const QString &databasePath, SetupModel *setupModel = nullptr, QObject *parent = nullptr);

    bool listening() const { return m_receiver.listening(); }
    QString status() const { return m_status; }
    QStringList logEntries() const { return m_logEntries; }
    quint16 port() const { return m_receiver.port(); }
    QString savedDestination() const { return m_savedDestination; }
    QString savedCertificate() const { return m_savedCertificate; }
    QString savedPrivateKey() const { return m_savedPrivateKey; }
    QString savedClientCa() const { return m_savedClientCa; }
    QString savedFingerprint() const { return m_savedFingerprint; }
    quint16 savedPort() const { return m_savedPort; }
    bool savedEnabled() const { return m_savedEnabled; }

    Q_INVOKABLE bool start(const QString &destination, const QString &certificate, const QString &privateKey,
                           const QString &clientCa, const QString &clientFingerprint, quint16 port = 43171);
    Q_INVOKABLE bool startSaved();
    Q_INVOKABLE void stop();

signals:
    void changed();

private:
    void log(const QString &message);
    void saveConfiguration(const QString &destination, const QString &certificate, const QString &privateKey,
                           const QString &clientCa, const QString &fingerprint, quint16 port);
    QJsonObject finalize(const QJsonObject &header, const QString &partialPath, QString *error);

    WirelessReceiver m_receiver;
    SetupModel *m_setupModel = nullptr;
    QString m_databasePath;
    QString m_destination;
    QString m_catalog;
    QString m_savedDestination, m_savedCertificate, m_savedPrivateKey, m_savedClientCa, m_savedFingerprint;
    quint16 m_savedPort = 0;
    bool m_savedEnabled = false;
    QString m_status = QStringLiteral("Stopped");
    QStringList m_logEntries;
};
