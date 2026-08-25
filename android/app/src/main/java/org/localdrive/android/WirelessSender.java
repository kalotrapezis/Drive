package org.localdrive.android;

import org.json.JSONObject;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManagerFactory;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.util.Locale;

/** The Android client for the Alpha Linux wireless file protocol. */
public final class WirelessSender {
    private static final int PROTOCOL = 1;
    private static final int MAX_HEADER_BYTES = 64 * 1024;
    private static final int MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

    private WirelessSender() {}

    public static final class Profile {
        public final String host;
        public final int port;
        public final byte[] clientPkcs12;
        public final char[] clientPassword;
        public final byte[] serverCaPem;
        public final String serverFingerprint;
        public final String deviceId;
        public final String deviceName;

        public Profile(String host, int port, byte[] clientPkcs12, char[] clientPassword,
                       byte[] serverCaPem, String serverFingerprint, String deviceId, String deviceName) {
            this.host = host;
            this.port = port;
            this.clientPkcs12 = clientPkcs12;
            this.clientPassword = clientPassword == null ? new char[0] : clientPassword.clone();
            this.serverCaPem = serverCaPem;
            this.serverFingerprint = serverFingerprint;
            this.deviceId = deviceId;
            this.deviceName = deviceName;
        }
    }

    /** Sends one file and returns only after the Linux receipt matches size and SHA-256. */
    public static void send(File source, String relative, Profile profile) throws Exception {
        if (source == null || !source.isFile() || !source.canRead()) throw new IOException("Wireless source is not readable");
        if (profile == null || profile.host == null || profile.host.trim().isEmpty() || profile.port <= 0 || profile.port > 65535) throw new IOException("Wireless profile is invalid");
        if (profile.clientPkcs12 == null || profile.clientPkcs12.length == 0 || profile.serverCaPem == null || profile.serverCaPem.length == 0) throw new IOException("Wireless profile has no credentials");
        if (profile.deviceId == null || !profile.deviceId.startsWith("wireless:") || profile.deviceName == null || profile.deviceName.trim().isEmpty()) throw new IOException("Wireless device identity is invalid");
        final String cleanRelative = safeRelative(relative);
        final long size = source.length();
        final byte[] digest = sha256(source);
        try (SSLSocket socket = open(profile);
             DataInputStream input = new DataInputStream(socket.getInputStream());
             DataOutputStream output = new DataOutputStream(socket.getOutputStream());
             RandomAccessFile file = new RandomAccessFile(source, "r")) {
            writeFrame(output, new JSONObject().put("type", "hello").put("protocol", PROTOCOL)
                    .put("deviceId", profile.deviceId).put("name", profile.deviceName), null, 0);
            requireType(readFrame(input), "hello-ok");
            writeFrame(output, new JSONObject().put("type", "file").put("protocol", PROTOCOL)
                    .put("deviceId", profile.deviceId).put("name", profile.deviceName)
                    .put("relative", cleanRelative).put("size", size)
                    .put("sha256", hex(digest)).put("mtime", source.lastModified()), null, 0);
            long offset = requireOffset(readFrame(input), "file-ready");
            if (offset < 0 || offset > size) throw new IOException("Wireless receiver returned an invalid resume offset");
            final byte[] chunk = new byte[MAX_PAYLOAD_BYTES];
            while (offset < size) {
                file.seek(offset);
                final int wanted = (int) Math.min(chunk.length, size - offset);
                final int read = file.read(chunk, 0, wanted);
                if (read <= 0) throw new IOException("Wireless source changed during read");
                final long end = offset + read;
                writeFrame(output, new JSONObject().put("type", "chunk").put("offset", offset), chunk, read);
                final long acknowledged = requireOffset(readFrame(input), "chunk-ack");
                if (acknowledged != end) throw new IOException("Wireless receiver acknowledged an unexpected offset");
                offset = acknowledged;
            }
            final JSONObject receipt = readFrame(input);
            if (!"receipt".equals(receipt.optString("type")) || receipt.optLong("size", -1) != size
                    || !hex(digest).equalsIgnoreCase(receipt.optString("sha256"))) throw new IOException("Wireless receipt does not match the source");
        }
    }

    private static SSLSocket open(Profile profile) throws Exception {
        final KeyStore clientStore = KeyStore.getInstance("PKCS12");
        clientStore.load(new ByteArrayInputStream(profile.clientPkcs12), profile.clientPassword);
        final KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(clientStore, profile.clientPassword);

        final CertificateFactory factory = CertificateFactory.getInstance("X.509");
        final Certificate serverCa = factory.generateCertificate(new ByteArrayInputStream(profile.serverCaPem));
        final KeyStore trustStore = KeyStore.getInstance(KeyStore.getDefaultType());
        trustStore.load(null, null);
        trustStore.setCertificateEntry("local-drive-server-ca", serverCa);
        final TrustManagerFactory trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trust.init(trustStore);

        final SSLContext context = SSLContext.getInstance("TLS");
        context.init(keys.getKeyManagers(), trust.getTrustManagers(), null);
        final SSLSocket socket = (SSLSocket) context.getSocketFactory().createSocket(profile.host, profile.port);
        socket.setSoTimeout(120000);
        socket.setEnabledProtocols(new String[]{"TLSv1.3"});
        socket.startHandshake();
        final SSLSession session = socket.getSession();
        if (session.getPeerCertificates().length == 0 || !hex(sha256(session.getPeerCertificates()[0].getEncoded())).equalsIgnoreCase(normalize(profile.serverFingerprint))) {
            socket.close();
            throw new IOException("Wireless server certificate fingerprint mismatch");
        }
        return socket;
    }

    private static JSONObject readFrame(DataInputStream input) throws Exception {
        final int headerSize = input.readInt();
        if (headerSize <= 0 || headerSize > MAX_HEADER_BYTES) throw new IOException("Wireless response header is invalid");
        final byte[] header = new byte[headerSize];
        input.readFully(header);
        final long payloadSize = input.readLong();
        if (payloadSize < 0 || payloadSize > MAX_PAYLOAD_BYTES) throw new IOException("Wireless response payload is invalid");
        final byte[] payload = new byte[(int) payloadSize];
        input.readFully(payload);
        return new JSONObject(new String(header, StandardCharsets.UTF_8));
    }

    private static void writeFrame(DataOutputStream output, JSONObject header, byte[] payload, int length) throws Exception {
        final byte[] json = header.toString().getBytes(StandardCharsets.UTF_8);
        if (json.length == 0 || json.length > MAX_HEADER_BYTES || length < 0 || length > MAX_PAYLOAD_BYTES) throw new IOException("Wireless packet is too large");
        output.writeInt(json.length);
        output.write(json);
        output.writeLong(length);
        if (length > 0) output.write(payload, 0, length);
        output.flush();
    }

    private static void requireType(JSONObject header, String expected) throws IOException {
        if (!expected.equals(header.optString("type"))) throw new IOException("Wireless receiver did not return " + expected);
    }

    private static long requireOffset(JSONObject header, String expected) throws IOException {
        requireType(header, expected);
        if (!header.has("offset")) throw new IOException("Wireless receiver returned no offset");
        return header.optLong("offset", -1);
    }

    private static String safeRelative(String value) throws IOException {
        if (value == null || value.trim().isEmpty()) throw new IOException("Wireless relative path is empty");
        final String normalized = value.replace('\\', '/');
        if (normalized.startsWith("/") || normalized.indexOf('\0') >= 0) throw new IOException("Wireless relative path is unsafe");
        final StringBuilder clean = new StringBuilder();
        for (String part : normalized.split("/")) {
            if (part.isEmpty() || ".".equals(part)) continue;
            if ("..".equals(part)) throw new IOException("Wireless relative path escapes its root");
            if (clean.length() > 0) clean.append('/');
            clean.append(part);
        }
        if (clean.length() == 0) throw new IOException("Wireless relative path is empty");
        return clean.toString();
    }

    private static byte[] sha256(File file) throws Exception {
        final MessageDigest digest = MessageDigest.getInstance("SHA-256");
        final byte[] buffer = new byte[1024 * 1024];
        try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
            int read;
            while ((read = input.read(buffer)) >= 0) if (read > 0) digest.update(buffer, 0, read);
        }
        return digest.digest();
    }

    private static byte[] sha256(byte[] value) throws Exception { return MessageDigest.getInstance("SHA-256").digest(value); }

    private static String hex(byte[] bytes) {
        final StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    private static String normalize(String value) { return value == null ? "" : value.replace(":", "").replace(" ", "").toLowerCase(Locale.ROOT); }
}
