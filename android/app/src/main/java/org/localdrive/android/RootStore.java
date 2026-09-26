package org.localdrive.android;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/** Stores only persistable SAF roots and receipt-backed scan state. */
public final class RootStore {
    private static final String PREFS = "local-drive-roots";
    private static final String DRIVE = "drive-uri";
    private static final String PHOTOS = "photos-uri";
    private static final String STATUS = "sync-status";
    private static final String AUTO_ENABLED = "auto-enabled";
    private static final String METADATA_SEQUENCE = "metadata-sequence";
    private static final String RESOLUTION_GENERATION = "resolution-generation-";
    private static final String RESOLUTION_CURSOR = "resolution-cursor-";
    private static final String ACTIVE_REVIEWS = "active-reviews-";
    private static final String REVIEW_ACTION = "review-action-";
    private static final String REVIEW_SEQUENCE = "review-sequence-";
    private static final String CATALOG_SNAPSHOT = "catalog-snapshot-";
    private static final String LOCATION_CURSOR = "location-cursor-";
    private static final String CORRECTION_RESULT = "correction-result-";
    private static final String CORRECTION_HISTORY = "correction-history-";

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
    public static long nextMetadataSequence(Context context) {
        return preferences(context).getLong(METADATA_SEQUENCE, 0L) + 1L;
    }
    public static void commitMetadataSequence(Context context, long sequence) { preferences(context).edit().putLong(METADATA_SEQUENCE, sequence).apply(); }
    public static long resolutionCursor(Context context, String peerIdentity) {
        if (peerIdentity == null || peerIdentity.trim().isEmpty()) throw new IllegalArgumentException("Resolution peer is invalid");
        return preferences(context).getLong(RESOLUTION_CURSOR + digest(peerIdentity), 0L);
    }
    public static long resolutionGeneration(Context context, String peerIdentity) {
        if (peerIdentity == null || peerIdentity.trim().isEmpty()) throw new IllegalArgumentException("Resolution peer is invalid");
        return preferences(context).getLong(RESOLUTION_GENERATION + digest(peerIdentity), 0L);
    }
    public static void applyResolutions(Context context, String peerIdentity, JSONArray resolutions) throws Exception {
        if (peerIdentity == null || peerIdentity.trim().isEmpty()) throw new IllegalArgumentException("Resolution peer is invalid");
        if (resolutions == null) return;
        if (resolutions.length() > 64) throw new IllegalArgumentException("Too many resolution events");
        final SharedPreferences current = preferences(context);
        final SharedPreferences.Editor editor = current.edit();
        long generationCursor = resolutionGeneration(context, peerIdentity), cursor = resolutionCursor(context, peerIdentity);
        for (int index = 0; index < resolutions.length(); ++index) {
            final JSONObject item = resolutions.getJSONObject(index);
            final String id = item.optString("id"), origin = item.optString("originDeviceId"), action = item.optString("action"), evidence = item.optString("evidenceSha256").toLowerCase(java.util.Locale.ROOT);
            final long sequence = item.optLong("originSequence", -1L), generation = item.optLong("catalogGeneration", -1L);
            if (id.isEmpty() || id.length() > 256 || origin.isEmpty() || origin.length() > 256 || (!("save".equals(action)) && !("dismiss".equals(action)) && !("accept_existing".equals(action)) && !("keep_both".equals(action)) && !("skip_unsupported".equals(action)))
                    || sequence < 1 || generation < 1 || !evidence.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Resolution event is invalid");
            final String key = "resolution-" + digest(origin + "\n" + id), previousEvidence = current.getString(key + "-evidence", "");
            if (!previousEvidence.isEmpty() && !previousEvidence.equals(evidence)) throw new IllegalStateException("Resolution event collision");
            editor.putString(key, item.toString()).putString(key + "-evidence", evidence);
            if (generation > generationCursor || (generation == generationCursor && sequence > cursor)) {
                generationCursor = generation;
                cursor = sequence;
            }
        }
        final String peerKey = digest(peerIdentity);
        if (!editor.putLong(RESOLUTION_GENERATION + peerKey, generationCursor).putLong(RESOLUTION_CURSOR + peerKey, cursor).commit()) throw new IllegalStateException("Could not persist resolution events");
    }
    public static List<JSONObject> resolutions(Context context) {
        final List<JSONObject> result = new ArrayList<>();
        for (Map.Entry<String, ?> entry : preferences(context).getAll().entrySet()) {
            if ((!entry.getKey().startsWith("resolution-") && !entry.getKey().startsWith("decision-")) || entry.getKey().endsWith("-evidence") || !(entry.getValue() instanceof String)) continue;
            try { result.add(new JSONObject((String) entry.getValue())); }
            catch (Exception ignored) { /* App-private corrupt state is omitted from presentation. */ }
        }
        result.sort(Comparator.<JSONObject>comparingLong(item -> item.optLong("catalogGeneration")).thenComparingLong(item -> item.optLong("originSequence")).reversed());
        return result;
    }
    public static void applyActiveReviews(Context context, String peerIdentity, JSONArray reviews) throws Exception {
        if (peerIdentity == null || peerIdentity.trim().isEmpty()) throw new IllegalArgumentException("Review peer is invalid");
        if (reviews == null) reviews = new JSONArray();
        if (reviews.length() > 32) throw new IllegalArgumentException("Too many active reviews");
        for (int index = 0; index < reviews.length(); ++index) validateReview(reviews.getJSONObject(index));
        if (!preferences(context).edit().putString(ACTIVE_REVIEWS + digest(peerIdentity), reviews.toString()).commit()) throw new IllegalStateException("Could not persist active reviews");
    }
    public static void applyCatalogSnapshot(Context context, String peerIdentity, JSONObject snapshot) throws Exception {
        if (peerIdentity == null || peerIdentity.trim().isEmpty()) throw new IllegalArgumentException("Catalog peer is invalid");
        if (snapshot == null) return;
        final long pendingFiles = snapshot.optLong("pendingFiles", -1L), pendingBytes = snapshot.optLong("pendingBytes", -1L), requestedCursor = snapshot.optLong("locationRequestCursor", 0L), nextCursor = snapshot.optLong("locationNextCursor", 0L);
        final JSONArray devices = snapshot.optJSONArray("devices"), storages = snapshot.optJSONArray("storages");
        final JSONArray locations = snapshot.optJSONArray("locations") == null ? new JSONArray() : snapshot.getJSONArray("locations");
        if (pendingFiles < 0 || pendingBytes < 0 || requestedCursor != locationCursor(context, peerIdentity) || nextCursor < 0 || devices == null || storages == null || devices.length() > 32 || storages.length() > 32 || locations.length() > 64) throw new IllegalArgumentException("Catalog snapshot is invalid");
        for (int index = 0; index < devices.length(); ++index) {
            final JSONObject item = devices.getJSONObject(index); final String status = item.optString("status");
            if (item.optString("id").isEmpty() || item.optString("label").isEmpty() || (!"online".equals(status) && !"last_reported".equals(status) && !"not_checked".equals(status))) throw new IllegalArgumentException("Catalog device is invalid");
        }
        for (int index = 0; index < storages.length(); ++index) {
            final JSONObject item = storages.getJSONObject(index); final String presence = item.optString("presence");
            if (item.optString("id").isEmpty() || item.optString("label").isEmpty() || item.optLong("bytesTotal", -1L) < 0 || item.optLong("bytesFree", -1L) < 0 || item.optLong("knownBytes", -1L) < 0
                    || (!"present".equals(presence) && !"missing".equals(presence) && !"offline".equals(presence) && !"unknown".equals(presence))) throw new IllegalArgumentException("Catalog storage is invalid");
        }
        for (int index = 0; index < locations.length(); ++index) {
            final JSONObject item = locations.getJSONObject(index); final String state = item.optString("state"), contentHash = item.optString("contentSha256").toLowerCase(java.util.Locale.ROOT), receiptHash = item.optString("receiptSha256").toLowerCase(java.util.Locale.ROOT);
            if (item.optLong("cursor", -1L) < 1 || item.optString("id").isEmpty() || item.optString("storageId").isEmpty() || item.optString("storageLabel").isEmpty() || item.optString("relativePath").isEmpty() || item.optString("relativePath").length() > 1024 || item.optLong("sizeBytes", -1L) < 0
                    || (!"partial".equals(state) && !"present".equals(state) && !"verified".equals(state) && !"trashed".equals(state) && !"unknown".equals(state)) || !contentHash.matches("[0-9a-f]{64}")
                    || (!receiptHash.isEmpty() && !receiptHash.matches("[0-9a-f]{64}")) || ("verified".equals(state) && (!contentHash.equals(receiptHash) || item.optString("verifiedAt").isEmpty()))) throw new IllegalArgumentException("Catalog location is invalid");
        }
        snapshot.put("locations", locations);
        if (!preferences(context).edit().putString(CATALOG_SNAPSHOT + digest(peerIdentity), snapshot.toString()).commit()) throw new IllegalStateException("Could not persist catalog snapshot");
    }
    public static JSONObject catalogSnapshot(Context context, String peerIdentity) {
        if (peerIdentity == null || peerIdentity.trim().isEmpty()) return new JSONObject();
        try { return new JSONObject(preferences(context).getString(CATALOG_SNAPSHOT + digest(peerIdentity), "{}")); }
        catch (Exception ignored) { return new JSONObject(); }
    }
    public static long locationCursor(Context context, String peerIdentity) {
        if (peerIdentity == null || peerIdentity.trim().isEmpty()) throw new IllegalArgumentException("Location peer is invalid");
        return preferences(context).getLong(LOCATION_CURSOR + digest(peerIdentity), 0L);
    }
    public static void setLocationCursor(Context context, String peerIdentity, long cursor) {
        if (peerIdentity == null || peerIdentity.trim().isEmpty() || cursor < 0) throw new IllegalArgumentException("Location cursor is invalid");
        preferences(context).edit().putLong(LOCATION_CURSOR + digest(peerIdentity), cursor).apply();
    }
    public static void applyCorrections(Context context, String peerIdentity, JSONArray corrections) throws Exception {
        if (peerIdentity == null || peerIdentity.trim().isEmpty()) throw new IllegalArgumentException("Correction peer is invalid");
        if (corrections == null) return; if (corrections.length() > 16) throw new IllegalArgumentException("Too many corrections");
        final SharedPreferences current = preferences(context); final SharedPreferences.Editor editor = current.edit(); final String prefix = CORRECTION_RESULT + digest(peerIdentity) + "-";
        for (int index = 0; index < corrections.length(); ++index) {
            final JSONObject request = corrections.getJSONObject(index); final String correctionId = request.optString("id"), key = prefix + digest(correctionId);
            if (current.contains(key)) continue;
            editor.putString(key, CorrectionExecutor.execute(context, request).toString());
        }
        if (!editor.commit()) throw new IllegalStateException("Could not persist correction results");
    }
    public static JSONArray pendingCorrectionResults(Context context, String peerIdentity) {
        final JSONArray result = new JSONArray(); if (peerIdentity == null || peerIdentity.trim().isEmpty()) return result; final String prefix = CORRECTION_RESULT + digest(peerIdentity) + "-";
        for (Map.Entry<String, ?> entry : preferences(context).getAll().entrySet()) {
            if (result.length() == 16) break; if (!entry.getKey().startsWith(prefix) || !(entry.getValue() instanceof String)) continue;
            try { result.put(new JSONObject((String) entry.getValue())); } catch (Exception ignored) { }
        }
        return result;
    }
    public static void acknowledgeCorrectionResults(Context context, String peerIdentity, JSONArray accepted) throws Exception {
        if (accepted == null) return; if (accepted.length() > 16) throw new IllegalArgumentException("Too many correction acknowledgements");
        final SharedPreferences current = preferences(context); final SharedPreferences.Editor editor = current.edit(); final String prefix = CORRECTION_RESULT + digest(peerIdentity) + "-";
        for (int index = 0; index < accepted.length(); ++index) {
            final String id = accepted.getString(index); boolean found = false;
            for (Map.Entry<String, ?> entry : current.getAll().entrySet()) {
                if (!entry.getKey().startsWith(prefix) || !(entry.getValue() instanceof String)) continue;
                try { if (id.equals(new JSONObject((String) entry.getValue()).optString("id"))) { editor.remove(entry.getKey()).putString(CORRECTION_HISTORY + digest(peerIdentity + "\n" + id), (String) entry.getValue()); found = true; break; } } catch (Exception ignored) { }
            }
            if (!found) throw new IllegalStateException("Unknown correction acknowledgement");
        }
        if (!editor.commit()) throw new IllegalStateException("Could not acknowledge correction results");
    }
    public static List<JSONObject> correctionHistory(Context context) {
        final List<JSONObject> result = new ArrayList<>();
        for (Map.Entry<String, ?> entry : preferences(context).getAll().entrySet()) {
            if (!entry.getKey().startsWith(CORRECTION_HISTORY) || !(entry.getValue() instanceof String)) continue;
            try { result.add(new JSONObject((String) entry.getValue())); } catch (Exception ignored) { }
        }
        result.sort(Comparator.comparing(item -> item.optString("id")));
        return result;
    }
    public static List<JSONObject> activeReviews(Context context, String peerIdentity) {
        final List<JSONObject> result = new ArrayList<>();
        if (peerIdentity == null || peerIdentity.trim().isEmpty()) return result;
        try {
            final JSONArray reviews = new JSONArray(preferences(context).getString(ACTIVE_REVIEWS + digest(peerIdentity), "[]"));
            for (int index = 0; index < reviews.length(); ++index) result.add(reviews.getJSONObject(index));
        } catch (Exception ignored) { /* App-private corrupt state is omitted from presentation. */ }
        return result;
    }
    public static void queueReviewAction(Context context, String peerIdentity, JSONObject review, String action) throws Exception {
        validateReview(review);
        boolean allowed = false;
        final JSONArray actions = review.getJSONArray("allowedActions");
        for (int index = 0; index < actions.length(); ++index) if (action.equals(actions.getString(index))) allowed = true;
        if (!allowed) throw new IllegalArgumentException("Review action is not allowed");
        final String peerKey = digest(peerIdentity);
        final long sequence = preferences(context).getLong(REVIEW_SEQUENCE + peerKey, 0L) + 1L;
        final String id = "android-review-" + digest(peerIdentity + "\n1\n" + sequence);
        final JSONObject queued = new JSONObject().put("id", id).put("reviewItemId", review.getString("id"))
                .put("action", action).put("evidenceSha256", review.getString("evidenceSha256"))
                .put("catalogGeneration", 1).put("originSequence", sequence)
                .put("title", review.optString("title")).put("category", review.optString("category"));
        if (!preferences(context).edit().putString(REVIEW_ACTION + peerKey + "-" + id, queued.toString()).putLong(REVIEW_SEQUENCE + peerKey, sequence).commit()) throw new IllegalStateException("Could not queue review action");
    }
    public static JSONArray pendingReviewActions(Context context, String peerIdentity) {
        final JSONArray result = new JSONArray();
        if (peerIdentity == null || peerIdentity.trim().isEmpty()) return result;
        final String prefix = REVIEW_ACTION + digest(peerIdentity) + "-";
        final List<JSONObject> pending = new ArrayList<>();
        for (Map.Entry<String, ?> entry : preferences(context).getAll().entrySet()) {
            if (!entry.getKey().startsWith(prefix) || !(entry.getValue() instanceof String)) continue;
            try { pending.add(new JSONObject((String) entry.getValue())); } catch (Exception ignored) { }
        }
        pending.sort(Comparator.comparingLong(item -> item.optLong("originSequence")));
        for (int index = 0; index < Math.min(16, pending.size()); ++index) result.put(pending.get(index));
        return result;
    }
    public static void acknowledgeReviewActions(Context context, String peerIdentity, JSONArray accepted) throws Exception {
        if (accepted == null) return;
        if (accepted.length() > 16) throw new IllegalArgumentException("Too many accepted review actions");
        final SharedPreferences current = preferences(context); final SharedPreferences.Editor editor = current.edit();
        final String prefix = REVIEW_ACTION + digest(peerIdentity) + "-";
        for (int index = 0; index < accepted.length(); ++index) {
            final String id = accepted.getString(index); final String key = prefix + id; final String json = current.getString(key, "");
            if (id.isEmpty() || json.isEmpty()) throw new IllegalStateException("Unknown review action acknowledgement");
            editor.remove(key).putString("decision-" + digest(peerIdentity + "\n" + id), json);
        }
        if (!editor.commit()) throw new IllegalStateException("Could not acknowledge review actions");
    }
    private static void validateReview(JSONObject review) throws Exception {
        final String id = review.optString("id"), evidence = review.optString("evidenceSha256").toLowerCase(java.util.Locale.ROOT);
        final JSONArray actions = review.optJSONArray("allowedActions");
        if (id.isEmpty() || id.length() > 256 || !evidence.matches("[0-9a-f]{64}") || actions == null || actions.length() > 5) throw new IllegalArgumentException("Active review is invalid");
        for (int index = 0; index < actions.length(); ++index) {
            final String action = actions.getString(index);
            if (!"save".equals(action) && !"dismiss".equals(action) && !"accept_existing".equals(action) && !"keep_both".equals(action) && !"skip_unsupported".equals(action)) throw new IllegalArgumentException("Active review action is invalid");
        }
    }
    public static String metadataItemId(String root, String relative) { return digest(root + "\n" + relative); }
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
