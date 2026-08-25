#pragma once

#include <QByteArray>
#include <QHostAddress>
#include <QHash>
#include <QJsonObject>
#include <QObject>
#include <QSslError>
#include <QString>
#include <utility>

#include "wirelessprotocol.h"
#include <functional>

class QSslServer;
class QSslSocket;

namespace LocalDrive::WirelessProtocol {

inline constexpr int MaxHeaderBytes = 64 * 1024;
inline constexpr int MaxPayloadBytes = 8 * 1024 * 1024;

struct Packet {
    QJsonObject header;
    QByteArray payload;
};

QByteArray encodePacket(const QJsonObject &header, const QByteArray &payload = {});

enum class DecodeResult { Incomplete, Complete, Invalid };
DecodeResult decodePacket(QByteArray &buffer, Packet *packet, QString *error = nullptr);

}

class WirelessReceiver final : public QObject {
    Q_OBJECT
public:
    struct Configuration {
        QHostAddress bindAddress = QHostAddress::Any;
        quint16 port = 0;
        QString destinationRoot;
        QString stagingRoot;
        QString certificatePath;
        QString privateKeyPath;
        QString clientCaPath;
        QByteArray expectedClientFingerprint;
    };
    using FinalizeHandler = std::function<QJsonObject(const QJsonObject &, const QString &, QString *)>;

    explicit WirelessReceiver(QObject *parent = nullptr);
    ~WirelessReceiver() override;

    bool start(const Configuration &configuration, QString *error = nullptr);
    void stop();
    bool listening() const;
    quint16 port() const;
    void setFinalizeHandler(FinalizeHandler handler) { m_finalize = std::move(handler); }

signals:
    void receipt(const QJsonObject &receipt);
    void errorMessage(const QString &message);

private slots:
    void acceptConnection();
    void readSocket();
    void socketDisconnected();
    void socketSslErrors(const QList<QSslError> &errors);

private:
    struct Connection;
    void closeConnection(QSslSocket *socket);
    bool send(QSslSocket *socket, const QJsonObject &header, const QByteArray &payload = {});
    bool handlePacket(Connection &connection, const LocalDrive::WirelessProtocol::Packet &packet, QString *error);
    bool startFile(Connection &connection, const QJsonObject &header, QString *error);
    bool handleChunk(Connection &connection, const QJsonObject &header, const QByteArray &payload, QString *error);
    bool finishFile(Connection &connection, QString *error);

    QSslServer *m_server = nullptr;
    Configuration m_configuration;
    FinalizeHandler m_finalize;
    QHash<QSslSocket *, Connection *> m_connections;
};
