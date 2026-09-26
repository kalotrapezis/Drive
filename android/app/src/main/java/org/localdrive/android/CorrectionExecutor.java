package org.localdrive.android;

import android.content.Context;
import android.net.Uri;

import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** Non-destructive device correction: re-read one exact SAF location and report evidence. */
public final class CorrectionExecutor {
    private CorrectionExecutor() {}

    public static JSONObject execute(Context context, JSONObject request) throws Exception {
        final String correctionId = request.optString("id"), action = request.optString("action"), root = request.optString("root"), relative = request.optString("relativePath"), expectedHash = request.optString("expectedSha256").toLowerCase(Locale.ROOT);
        final long expectedSize = request.optLong("expectedSize", -1L);
        if (correctionId.isEmpty() || correctionId.length() > 256 || !"recheck_location".equals(action) || (!"Drive".equals(root) && !"DCIM".equals(root)) || expectedSize < 0 || !expectedHash.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Correction request is invalid");
        final String resultId = "correction-result-" + hex(MessageDigest.getInstance("SHA-256").digest(correctionId.getBytes(StandardCharsets.UTF_8)));
        try {
            final String rootValue = "Drive".equals(root) ? RootStore.drive(context) : RootStore.photos(context);
            if (rootValue.isEmpty()) return result(resultId, correctionId, "failed", -1L, "", "Fixed root is unavailable");
            final Uri tree = Uri.parse(rootValue); final RootScanner.Entry before = RootScanner.find(context, tree, relative);
            if (before == null) return result(resultId, correctionId, "missing", -1L, "", "");
            if (before.size != expectedSize) return result(resultId, correctionId, "changed", before.size, "", "");
            final MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = context.getContentResolver().openInputStream(before.uri)) {
                if (input == null) throw new IllegalStateException("Location cannot be opened");
                final byte[] buffer = new byte[1024 * 1024]; int read;
                while ((read = input.read(buffer)) >= 0) if (read > 0) digest.update(buffer, 0, read);
            }
            final String observedHash = hex(digest.digest()); final RootScanner.Entry after = RootScanner.find(context, tree, relative);
            if (after == null) return result(resultId, correctionId, "missing", -1L, "", "");
            if (after.size != before.size || after.modified != before.modified) return result(resultId, correctionId, "changed", after.size, "", "Location changed during verification");
            return result(resultId, correctionId, expectedHash.equals(observedHash) ? "verified" : "changed", after.size, observedHash, "");
        } catch (Exception error) {
            return result(resultId, correctionId, "failed", -1L, "", error.getMessage() == null ? "Recheck failed" : error.getMessage());
        }
    }

    private static JSONObject result(String id, String correctionId, String status, long size, String hash, String error) throws Exception {
        final JSONObject result = new JSONObject().put("id", id).put("correctionId", correctionId).put("status", status).put("error", error == null ? "" : error);
        if (size >= 0) result.put("observedSize", size); if (!hash.isEmpty()) result.put("observedSha256", hash); return result;
    }

    private static String hex(byte[] bytes) {
        final StringBuilder result = new StringBuilder(bytes.length * 2); for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff)); return result.toString();
    }
}
