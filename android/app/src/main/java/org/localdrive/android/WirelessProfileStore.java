package org.localdrive.android;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateFactory;
import java.util.Locale;

/** Stores non-secret receiver metadata and the public server CA in app-private storage. */
public final class WirelessProfileStore {
    private static final String PREFS = "local-drive-wireless-profile";
    private static final String CA_FILE = "wireless-server-ca.pem";
    private static final String HOST = "host";
    private static final String PORT = "port";
    private static final String FINGERPRINT = "fingerprint";

    private WirelessProfileStore() {}

    public static void importJson(Context context, String raw) throws Exception {
        final JSONObject json = new JSONObject(raw);
        if (json.optInt("protocol", -1) != 1) throw new IllegalArgumentException("Unsupported pairing profile protocol");
        final String host = json.optString("host", "").trim();
        final int port = json.optInt("port", -1);
        final String fingerprint = normalize(json.optString("serverFingerprint", ""));
        final String caPem = json.optString("serverCaPem", "").trim();
        if (host.isEmpty() || port < 1 || port > 65535 || !fingerprint.matches("[0-9a-f]{64}") || caPem.isEmpty()) throw new IllegalArgumentException("Pairing profile is incomplete");
        CertificateFactory.getInstance("X.509").generateCertificate(new java.io.ByteArrayInputStream(caPem.getBytes(StandardCharsets.UTF_8)));
        final File temporary = new File(context.getFilesDir(), CA_FILE + ".new");
        try (FileOutputStream output = new FileOutputStream(temporary)) { output.write(caPem.getBytes(StandardCharsets.UTF_8)); }
        final File destination = new File(context.getFilesDir(), CA_FILE);
        if (destination.exists() && !destination.delete()) throw new IllegalStateException("Could not replace server CA");
        if (!temporary.renameTo(destination)) throw new IllegalStateException("Could not store server CA");
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(HOST, host).putInt(PORT, port).putString(FINGERPRINT, fingerprint).apply();
    }

    public static boolean hasProfile(Context context) {
        return new File(context.getFilesDir(), CA_FILE).isFile()
                && context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).contains(HOST);
    }

    public static WirelessSender.Profile senderProfile(Context context) throws Exception {
        if (!hasProfile(context)) throw new IllegalStateException("No wireless pairing profile");
        final android.content.SharedPreferences preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new WirelessSender.Profile(preferences.getString(HOST, ""), preferences.getInt(PORT, -1), AndroidIdentity.ALIAS,
                readServerCa(context), preferences.getString(FINGERPRINT, ""), BeaconService.identityFor(context),
                (android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL).trim());
    }

    private static byte[] readServerCa(Context context) throws Exception {
        try (FileInputStream input = new FileInputStream(new File(context.getFilesDir(), CA_FILE));
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            final byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) >= 0) if (read > 0) output.write(buffer, 0, read);
            return output.toByteArray();
        }
    }

    private static String normalize(String value) { return value.replace(":", "").replace(" ", "").toLowerCase(Locale.ROOT); }
}
