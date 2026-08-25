package org.localdrive.android;

import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Stores only persistable SAF roots and receipt-backed scan state. */
public final class RootStore {
    private static final String PREFS = "local-drive-roots";
    private static final String DRIVE = "drive-uri";
    private static final String PHOTOS = "photos-uri";
    private static final String STATUS = "sync-status";
    private static final String AUTO_ENABLED = "auto-enabled";

    private RootStore() {}

    public static void saveDrive(Context context, String uri) { preferences(context).edit().putString(DRIVE, uri).apply(); }
    public static void savePhotos(Context context, String uri) { preferences(context).edit().putString(PHOTOS, uri).apply(); }
    public static String drive(Context context) { return preferences(context).getString(DRIVE, ""); }
    public static String photos(Context context) { return preferences(context).getString(PHOTOS, ""); }
    public static boolean hasRoots(Context context) { return !drive(context).isEmpty() && !photos(context).isEmpty(); }
    public static boolean autoEnabled(Context context) { return !preferences(context).contains(AUTO_ENABLED) || preferences(context).getBoolean(AUTO_ENABLED, false); }
    public static void setAutoEnabled(Context context, boolean enabled) { preferences(context).edit().putBoolean(AUTO_ENABLED, enabled).apply(); }

    public static boolean sent(Context context, String key) { return preferences(context).getBoolean("sent-" + digest(key), false); }
    public static void markSent(Context context, String key) { preferences(context).edit().putBoolean("sent-" + digest(key), true).apply(); }
    public static void setStatus(Context context, String status) { preferences(context).edit().putString(STATUS, status).apply(); }
    public static String status(Context context) { return preferences(context).getString(STATUS, "Αυτόματος συγχρονισμός δεν έχει ξεκινήσει."); }

    private static SharedPreferences preferences(Context context) { return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    private static String digest(String value) {
        try {
            final byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            final StringBuilder result = new StringBuilder(bytes.length * 2);
            for (byte item : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
            return result.toString();
        } catch (Exception error) {
            throw new IllegalStateException("Could not hash sync state", error);
        }
    }
}
