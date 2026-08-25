#include "wirelesssession.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonValue>
#include <QSslCertificate>
#include <QSslConfiguration>
#include <QSslKey>
#include <QSslServer>
#include <QSslSocket>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <unistd.h>

namespace {

void appendU32(QByteArray &out, quint32 value) {
    out.append(char((value >> 24) & 0xff)); out.append(char((value >> 16) & 0xff));
    out.append(char((value >> 8) & 0xff)); out.append(char(value & 0xff));
}

void appendU64(QByteArray &out, quint64 value) {
    for (int shift = 56; shift >= 0; shift -= 8) out.append(char((value >> shift) & 0xff));
}

quint32 readU32(const QByteArray &data, int offset) {
    return (quint32(uchar(data[offset])) << 24) | (quint32(uchar(data[offset + 1])) << 16)
        | (quint32(uchar(data[offset + 2])) << 8) | quint32(uchar(data[offset + 3]));
}

quint64 readU64(const QByteArray &data, int offset) {
    quint64 value = 0;
    for (int index = 0; index < 8; ++index) value = (value << 8) | quint64(uchar(data[offset + index]));
    return value;
}

QByteArray normalizedFingerprint(QByteArray value) {
    value.replace(":", ""); value.replace(" ", "");
    return value.toLower();
}

bool safeRelative(const QString &relative) {
    const QString clean = QDir::cleanPath(relative);
    return !relative.trimmed().isEmpty() && clean != "." && clean != ".." && !clean.startsWith("../")
        && !clean.contains("/../") && !QFileInfo(clean).isAbsolute();
}

bool under(const QString &child, const QString &root) {
    const QString c = QDir::cleanPath(child), r = QDir::cleanPath(root);
    return c == r || c.startsWith(r.endsWith('/') ? r : r + '/');
}

bool loadCertificate(const QString &path, QSslCertificate *certificate, QString *error) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) { if (error) *error = file.errorString(); return false; }
    const auto certificates = QSslCertificate::fromDevice(&file, QSsl::Pem);
    if (certificates.isEmpty()) { if (error) *error = QStringLiteral("No PEM certificate found in %1").arg(path); return false; }
    *certificate = certificates.first();
    return true;
}

bool loadPrivateKey(const QString &path, QSslKey *key, QString *error) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) { if (error) *error = file.errorString(); return false; }
    *key = QSslKey(&file, QSsl::Rsa, QSsl::Pem);
    if (key->isNull()) { if (error) *error = QStringLiteral("No readable PEM private key found in %1").arg(path); return false; }
    return true;
}

bool hashFile(QFile &file, qint64 expectedSize, QByteArray *hash, QString *error) {
    if (!file.seek(0)) { if (error) *error = file.errorString(); return false; }
    QCryptographicHash digest(QCryptographicHash::Sha256);
    qint64 total = 0;
    while (!file.atEnd()) {
        const QByteArray chunk = file.read(1024 * 1024);
        if (chunk.isEmpty() && !file.atEnd()) { if (error) *error = file.errorString(); return false; }
        digest.addData(chunk); total += chunk.size();
    }
    if (total != expectedSize) { if (error) *error = QStringLiteral("Wireless partial size changed during verification"); return false; }
    if (hash) *hash = digest.result();
    return true;
}

}

namespace LocalDrive::WirelessProtocol {

QByteArray encodePacket(const QJsonObject &header, const QByteArray &payload) {
    const QByteArray json = QJsonDocument(header).toJson(QJsonDocument::Compact);
    QByteArray packet;
    packet.reserve(4 + json.size() + 8 + payload.size());
    appendU32(packet, quint32(json.size()));
    packet.append(json);
    appendU64(packet, quint64(payload.size()));
    packet.append(payload);
    return packet;
}

DecodeResult decodePacket(QByteArray &buffer, Packet *packet, QString *error) {
    if (buffer.size() < 4) return DecodeResult::Incomplete;
    const quint32 headerSize = readU32(buffer, 0);
    if (headerSize == 0 || headerSize > MaxHeaderBytes) { if (error) *error = "Wireless packet header is invalid"; return DecodeResult::Invalid; }
    if (buffer.size() < 4 + qint64(headerSize) + 8) return DecodeResult::Incomplete;
    const int payloadOffset = 4 + int(headerSize) + 8;
    const quint64 payloadSize = readU64(buffer, 4 + int(headerSize));
    if (payloadSize > MaxPayloadBytes) { if (error) *error = "Wireless packet payload is too large"; return DecodeResult::Invalid; }
    const qint64 packetSize = payloadOffset + qint64(payloadSize);
    if (buffer.size() < packetSize) return DecodeResult::Incomplete;
    QJsonParseError parseError{};
    const QJsonDocument document = QJsonDocument::fromJson(buffer.mid(4, int(headerSize)), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isObject()) { if (error) *error = "Wireless packet header is not JSON"; return DecodeResult::Invalid; }
    if (packet) {
        packet->header = document.object();
        packet->payload = buffer.mid(payloadOffset, int(payloadSize));
    }
    buffer.remove(0, int(packetSize));
    return DecodeResult::Complete;
}

}

struct WirelessReceiver::Connection {
    QSslSocket *socket = nullptr;
    QByteArray buffer;
    bool helloReceived = false;
    QString deviceId;
    QJsonObject fileHeader;
    QString partialDirectory;
    QString partialPath;
    QFile partial;
    qint64 expectedSize = 0;
    qint64 offset = 0;
};

WirelessReceiver::WirelessReceiver(QObject *parent) : QObject(parent) {}

WirelessReceiver::~WirelessReceiver() { stop(); }

bool WirelessReceiver::start(const Configuration &configuration, QString *error) {
    stop();
    if (configuration.certificatePath.isEmpty() || configuration.privateKeyPath.isEmpty() || configuration.clientCaPath.isEmpty() || configuration.expectedClientFingerprint.isEmpty()) {
        if (error) *error = QStringLiteral("Wireless receiver requires a server certificate, private key, client CA, and pinned client fingerprint");
        return false;
    }
    if (configuration.stagingRoot.isEmpty() || !QDir().mkpath(configuration.stagingRoot)) { if (error) *error = QStringLiteral("Wireless staging directory is unavailable"); return false; }
    const QFileInfo stagingInfo(configuration.stagingRoot);
    if (stagingInfo.isSymLink()) { if (error) *error = QStringLiteral("Wireless staging directory must not be a symlink"); return false; }
    QSslCertificate certificate, clientCa;
    QSslKey privateKey;
    QString loadError;
    if (!loadCertificate(configuration.certificatePath, &certificate, &loadError) || !loadPrivateKey(configuration.privateKeyPath, &privateKey, &loadError) || !loadCertificate(configuration.clientCaPath, &clientCa, &loadError)) { if (error) *error = loadError; return false; }
    QSslConfiguration ssl = QSslConfiguration::defaultConfiguration();
    ssl.setLocalCertificate(certificate); ssl.setPrivateKey(privateKey); ssl.setCaCertificates({clientCa});
    ssl.setPeerVerifyMode(QSslSocket::VerifyPeer); ssl.setProtocol(QSsl::TlsV1_3OrLater);
    m_configuration = configuration;
    m_configuration.expectedClientFingerprint = normalizedFingerprint(m_configuration.expectedClientFingerprint);
    m_server = new QSslServer(this); m_server->setSslConfiguration(ssl);
    connect(m_server, &QTcpServer::newConnection, this, &WirelessReceiver::acceptConnection);
    connect(m_server, &QTcpServer::pendingConnectionAvailable, this, [this] { acceptConnection(); });
    connect(m_server, &QSslServer::sslErrors, this, [this](QSslSocket *socket, const QList<QSslError> &) { closeConnection(socket); });
    connect(m_server, &QSslServer::peerVerifyError, this, [this](QSslSocket *socket, const QSslError &) { closeConnection(socket); });
    if (!m_server->listen(configuration.bindAddress, configuration.port)) { if (error) *error = m_server->errorString(); stop(); return false; }
    return true;
}

void WirelessReceiver::stop() {
    const auto sockets = m_connections.keys();
    for (QSslSocket *socket : sockets) closeConnection(socket);
    if (m_server) { m_server->close(); delete m_server; m_server = nullptr; }
}

bool WirelessReceiver::listening() const { return m_server && m_server->isListening(); }
quint16 WirelessReceiver::port() const { return listening() ? m_server->serverPort() : 0; }

void WirelessReceiver::acceptConnection() {
    while (m_server && m_server->hasPendingConnections()) {
        auto *socket = qobject_cast<QSslSocket *>(m_server->nextPendingConnection());
        if (!socket) continue;
        auto *connection = new Connection; connection->socket = socket; m_connections.insert(socket, connection);
        connect(socket, &QSslSocket::readyRead, this, &WirelessReceiver::readSocket);
        connect(socket, &QSslSocket::disconnected, this, &WirelessReceiver::socketDisconnected);
        connect(socket, &QSslSocket::sslErrors, this, &WirelessReceiver::socketSslErrors);
        if (!socket->isEncrypted()) connect(socket, &QSslSocket::encrypted, this, [this, socket] { acceptConnection(); });
        else if (socket->peerCertificate().digest(QCryptographicHash::Sha256).toHex().toLower() != m_configuration.expectedClientFingerprint) closeConnection(socket);
    }
}

void WirelessReceiver::closeConnection(QSslSocket *socket) {
    if (!socket) return;
    auto it = m_connections.find(socket);
    if (it != m_connections.end()) { (*it)->partial.close(); delete it.value(); m_connections.erase(it); }
    socket->disconnect(this); socket->disconnectFromHost(); socket->deleteLater();
}

void WirelessReceiver::socketDisconnected() { closeConnection(qobject_cast<QSslSocket *>(sender())); }
void WirelessReceiver::socketSslErrors(const QList<QSslError> &) { closeConnection(qobject_cast<QSslSocket *>(sender())); }

bool WirelessReceiver::send(QSslSocket *socket, const QJsonObject &header, const QByteArray &payload) {
    if (!socket || !socket->isEncrypted()) return false;
    const QByteArray packet = LocalDrive::WirelessProtocol::encodePacket(header, payload);
    return socket->write(packet) == packet.size();
}

void WirelessReceiver::readSocket() {
    auto *socket = qobject_cast<QSslSocket *>(sender());
    auto it = m_connections.find(socket);
    if (it == m_connections.end()) return;
    Connection &connection = *it.value();
    connection.buffer.append(socket->readAll());
    for (;;) {
        LocalDrive::WirelessProtocol::Packet packet; QString decodeError;
        const auto result = LocalDrive::WirelessProtocol::decodePacket(connection.buffer, &packet, &decodeError);
        if (result == LocalDrive::WirelessProtocol::DecodeResult::Incomplete) return;
        if (result == LocalDrive::WirelessProtocol::DecodeResult::Invalid) { emit errorMessage(decodeError); closeConnection(socket); return; }
        QString packetError;
        if (!handlePacket(connection, packet, &packetError)) { emit errorMessage(packetError); send(socket, QJsonObject{{"type", "error"}, {"message", packetError}}); closeConnection(socket); return; }
    }
}

bool WirelessReceiver::handlePacket(Connection &connection, const LocalDrive::WirelessProtocol::Packet &packet, QString *error) {
    const QString type = packet.header.value("type").toString();
    if (!connection.helloReceived) {
        if (type != QStringLiteral("hello") || packet.header.value("protocol").toInt() != LocalDrive::WirelessProtocol::Version || !packet.header.value("deviceId").toString().startsWith(QStringLiteral("wireless:")) || packet.header.value("name").toString().trimmed().isEmpty()) { if (error) *error = QStringLiteral("Wireless hello is invalid"); return false; }
        connection.deviceId = packet.header.value("deviceId").toString(); connection.helloReceived = true;
        emit deviceObserved(connection.deviceId, packet.header.value("name").toString().trimmed());
        return send(connection.socket, QJsonObject{{"type", "hello-ok"}, {"protocol", LocalDrive::WirelessProtocol::Version}});
    }
    if (type == QStringLiteral("file")) return startFile(connection, packet.header, error);
    if (type == QStringLiteral("chunk")) return handleChunk(connection, packet.header, packet.payload, error);
    if (error) *error = QStringLiteral("Unknown wireless packet type");
    return false;
}

bool WirelessReceiver::startFile(Connection &connection, const QJsonObject &header, QString *error) {
    if (connection.partial.isOpen()) { if (error) *error = QStringLiteral("A wireless file is already active"); return false; }
    const QString relative = QDir::cleanPath(header.value("relative").toString());
    const qint64 size = header.value("size").toVariant().toLongLong();
    const QString hash = header.value("sha256").toString().toLower();
    if (!safeRelative(relative) || size < 0 || hash.size() != 64 || QByteArray::fromHex(hash.toLatin1()).size() != 32) { if (error) *error = QStringLiteral("Wireless file metadata is invalid"); return false; }
    const QString token = QString::fromLatin1(QCryptographicHash::hash((connection.deviceId + "\n" + relative + "\n" + QString::number(size) + "\n" + hash).toUtf8(), QCryptographicHash::Sha256).toHex());
    const QString directory = QDir(m_configuration.stagingRoot).filePath(token);
    if (!QDir().mkpath(directory) || QFileInfo(directory).isSymLink()) { if (error) *error = QStringLiteral("Wireless partial directory is unsafe"); return false; }
    const QString partialPath = QDir(directory).filePath(relative);
    if (!QDir().mkpath(QFileInfo(partialPath).absolutePath()) || QFileInfo(partialPath).isSymLink()) { if (error) *error = QStringLiteral("Wireless partial path is unsafe"); return false; }
    const QString stagingCanonical = QFileInfo(m_configuration.stagingRoot).canonicalFilePath();
    const QString parentCanonical = QFileInfo(QFileInfo(partialPath).absolutePath()).canonicalFilePath();
    if (stagingCanonical.isEmpty() || parentCanonical.isEmpty() || !under(parentCanonical, stagingCanonical)) { if (error) *error = QStringLiteral("Wireless partial path escapes staging"); return false; }
    if (QFileInfo(partialPath).isSymLink()) { if (error) *error = QStringLiteral("Wireless partial is a symlink"); return false; }
    connection.partial.setFileName(partialPath);
    if (!connection.partial.open(QIODevice::ReadWrite)) { if (error) *error = connection.partial.errorString(); return false; }
    if (connection.partial.size() > size) { if (error) *error = QStringLiteral("Wireless partial is larger than the source"); return false; }
    connection.fileHeader = header; connection.partialDirectory = directory; connection.partialPath = partialPath; connection.expectedSize = size; connection.offset = connection.partial.size();
    if (!send(connection.socket, QJsonObject{{"type", "file-ready"}, {"offset", connection.offset}})) { if (error) *error = QStringLiteral("Wireless ready response failed"); return false; }
    if (connection.offset == connection.expectedSize) return finishFile(connection, error);
    return true;
}

bool WirelessReceiver::handleChunk(Connection &connection, const QJsonObject &header, const QByteArray &payload, QString *error) {
    if (!connection.partial.isOpen()) { if (error) *error = QStringLiteral("Wireless chunk arrived without a file"); return false; }
    const qint64 offset = header.value("offset").toVariant().toLongLong();
    if (offset != connection.offset || payload.isEmpty() || payload.size() > LocalDrive::WirelessProtocol::MaxPayloadBytes || connection.offset + payload.size() > connection.expectedSize) { if (error) *error = QStringLiteral("Wireless chunk offset is invalid"); return false; }
    if (connection.partial.seek(connection.offset) != true || connection.partial.write(payload) != payload.size() || !connection.partial.flush() || ::fsync(connection.partial.handle()) != 0) { if (error) *error = connection.partial.errorString().isEmpty() ? QStringLiteral("Wireless partial write failed") : connection.partial.errorString(); return false; }
    connection.offset += payload.size();
    if (!send(connection.socket, QJsonObject{{"type", "chunk-ack"}, {"offset", connection.offset}})) { if (error) *error = QStringLiteral("Wireless chunk acknowledgement failed"); return false; }
    if (connection.offset == connection.expectedSize) return finishFile(connection, error);
    return true;
}

bool WirelessReceiver::finishFile(Connection &connection, QString *error) {
    if (!connection.partial.isOpen()) { if (error) *error = QStringLiteral("Wireless partial is not open"); return false; }
    QByteArray digest;
    const qint64 size = connection.expectedSize;
    if (!hashFile(connection.partial, size, &digest, error)) return false;
    const QByteArray expected = QByteArray::fromHex(connection.fileHeader.value("sha256").toString().toLatin1());
    if (digest != expected) { if (error) *error = QStringLiteral("Wireless source hash mismatch"); return false; }
    connection.partial.close();
    if (!m_finalize) { if (error) *error = QStringLiteral("Wireless receiver has no finalization handler"); return false; }
    QString finalizeError;
    QJsonObject receiptObject = m_finalize(connection.fileHeader, connection.partialPath, &finalizeError);
    if (receiptObject.isEmpty()) { if (error) *error = finalizeError.isEmpty() ? QStringLiteral("Wireless finalization failed") : finalizeError; return false; }
    receiptObject.insert(QStringLiteral("type"), QStringLiteral("receipt")); receiptObject.insert(QStringLiteral("size"), size); receiptObject.insert(QStringLiteral("sha256"), QString::fromLatin1(digest.toHex()));
    send(connection.socket, receiptObject);
    emit receipt(receiptObject);
    QDir(connection.partialDirectory).removeRecursively();
    connection.fileHeader = {}; connection.partialDirectory.clear(); connection.partialPath.clear(); connection.expectedSize = connection.offset = 0;
    return true;
}
