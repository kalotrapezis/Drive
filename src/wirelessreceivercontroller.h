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
public:
    explicit WirelessReceiverController(const QString &databasePath, SetupModel *setupModel = nullptr, QObject *parent = nullptr);

    bool listening() const { return m_receiver.listening(); }
    QString status() const { return m_status; }
    QStringList logEntries() const { return m_logEntries; }
    quint16 port() const { return m_receiver.port(); }

    Q_INVOKABLE bool start(const QString &destination, const QString &certificate, const QString &privateKey,
                           const QString &clientCa, const QString &clientFingerprint, quint16 port = 43171);
    Q_INVOKABLE void stop();

signals:
    void changed();

private:
    void log(const QString &message);
    QJsonObject finalize(const QJsonObject &header, const QString &partialPath, QString *error);

    WirelessReceiver m_receiver;
    SetupModel *m_setupModel = nullptr;
    QString m_databasePath;
    QString m_destination;
    QString m_catalog;
    QString m_status = QStringLiteral("Stopped");
    QStringList m_logEntries;
};
