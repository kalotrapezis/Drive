package org.localdrive.android;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Log;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Small Alpha surface: discovery stays visible while pairing/transfer are added. */
public final class MainActivity extends Activity {
    private static final String TAG = "LocalDrive";
    private static final int IMPORT_PROFILE = 40;
    private static final int PICK_DRIVE_FILE = 41;
    private static final int PICK_PHOTO_FILE = 42;
    private static final int PICK_DRIVE_ROOT = 43;
    private static final int PICK_PHOTOS_ROOT = 44;
    private TextView profileStatus;
    private TextView rootStatus;
    private Button autoSync;
    private boolean autoSyncRunning;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        final LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(48, 48, 48, 48);
        layout.setGravity(Gravity.CENTER_HORIZONTAL);

        final TextView title = new TextView(this);
        String identityStatus;
        try {
            AndroidIdentity.ensureGenerated();
            identityStatus = "\nΤο ασφαλές client identity είναι έτοιμο για pairing.";
        } catch (Exception error) {
            identityStatus = "\nΔεν ήταν δυνατή η δημιουργία του client identity.";
        }
        title.setText("Local Drive\n\nΤο κινητό είναι διαθέσιμο για ασύρματη ανίχνευση.\nΗ ανίχνευση δεν δίνει πρόσβαση σε αρχεία." + identityStatus);
        title.setTextSize(18);
        layout.addView(title, new LinearLayout.LayoutParams(-1, -2));

        profileStatus = new TextView(this);
        layout.addView(profileStatus, new LinearLayout.LayoutParams(-1, -2));

        final Button importProfile = new Button(this);
        importProfile.setText("Εισαγωγή Linux pairing profile");
        importProfile.setOnClickListener(view -> {
            final Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/json");
            startActivityForResult(intent, IMPORT_PROFILE);
        });
        layout.addView(importProfile, new LinearLayout.LayoutParams(-1, -2));

        final Button shareIdentity = new Button(this);
        shareIdentity.setText("Κοινή χρήση public pairing certificate");
        shareIdentity.setOnClickListener(view -> sharePairingIdentity());
        layout.addView(shareIdentity, new LinearLayout.LayoutParams(-1, -2));

        final Button driveRoot = new Button(this);
        driveRoot.setText("Επίλεξε fixed root Drive");
        driveRoot.setOnClickListener(view -> pickRoot(PICK_DRIVE_ROOT));
        layout.addView(driveRoot, new LinearLayout.LayoutParams(-1, -2));

        final Button photosRoot = new Button(this);
        photosRoot.setText("Επίλεξε fixed root DCIM → Photos");
        photosRoot.setOnClickListener(view -> pickRoot(PICK_PHOTOS_ROOT));
        layout.addView(photosRoot, new LinearLayout.LayoutParams(-1, -2));

        rootStatus = new TextView(this);
        layout.addView(rootStatus, new LinearLayout.LayoutParams(-1, -2));

        autoSync = new Button(this);
        autoSync.setText("Έναρξη αυτόματου συγχρονισμού");
        autoSync.setOnClickListener(view -> {
            if (autoSyncRunning) stopAutoSync();
            else startAutoSync();
        });
        layout.addView(autoSync, new LinearLayout.LayoutParams(-1, -2));

        final Button driveSend = new Button(this);
        driveSend.setText("Επιλογή αρχείου → Drive");
        driveSend.setOnClickListener(view -> pickFile(PICK_DRIVE_FILE));
        layout.addView(driveSend, new LinearLayout.LayoutParams(-1, -2));

        final Button photoSend = new Button(this);
        photoSend.setText("Επιλογή φωτογραφίας/βίντεο → Photos");
        photoSend.setOnClickListener(view -> pickFile(PICK_PHOTO_FILE));
        layout.addView(photoSend, new LinearLayout.LayoutParams(-1, -2));

        final Button stop = new Button(this);
        stop.setText("Παύση ανίχνευσης");
        stop.setOnClickListener(view -> stopService(new Intent(this, BeaconService.class)));
        layout.addView(stop, new LinearLayout.LayoutParams(-1, -2));
        setContentView(layout);

        final Intent service = new Intent(this, BeaconService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
        else startService(service);
        refreshProfileStatus();
        refreshRootStatus();
        maybeStartAutoSync();
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        Log.d(TAG, "activity result request=" + requestCode + " result=" + resultCode + " flags=" + (data == null ? 0 : data.getFlags()) + " uri=" + (data == null ? null : data.getData()));
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        if (requestCode == PICK_DRIVE_ROOT || requestCode == PICK_PHOTOS_ROOT) {
            final int grantFlags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            saveRoot(data.getData(), requestCode == PICK_DRIVE_ROOT ? "Drive" : "DCIM", grantFlags);
            return;
        }
        if (requestCode == PICK_DRIVE_FILE || requestCode == PICK_PHOTO_FILE) {
            startTransfer(data.getData(), requestCode == PICK_DRIVE_FILE ? "Drive" : "Photos");
            return;
        }
        if (requestCode != IMPORT_PROFILE) return;
        try (InputStream input = getContentResolver().openInputStream(data.getData()); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new IllegalStateException("Δεν ήταν δυνατή η ανάγνωση του profile");
            final byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) >= 0) if (read > 0) output.write(buffer, 0, read);
            WirelessProfileStore.importJson(this, output.toString(StandardCharsets.UTF_8.name()));
            refreshProfileStatus();
            maybeStartAutoSync();
        } catch (Exception error) {
            Log.e(TAG, "profile import failed", error);
            profileStatus.setText("Pairing profile: αποτυχία εισαγωγής (" + error.getMessage() + ")");
        }
    }

    private void pickRoot(int requestCode) {
        final Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(intent, requestCode);
    }

    private void saveRoot(Uri uri, String expectedName, int grantFlags) {
        try {
            final String actualName = documentName(uri);
            if (!expectedName.equalsIgnoreCase(actualName)) throw new IllegalArgumentException("Επίλεξε τον φάκελο " + expectedName + ", όχι " + actualName);
            if ((grantFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0) throw new SecurityException("Ο provider δεν έδωσε δικαίωμα ανάγνωσης");
            getContentResolver().takePersistableUriPermission(uri, grantFlags);
            if ("Drive".equals(expectedName)) RootStore.saveDrive(this, uri.toString());
            else RootStore.savePhotos(this, uri.toString());
            refreshRootStatus();
            maybeStartAutoSync();
        } catch (Exception error) {
            Log.e(TAG, "fixed root save failed for " + expectedName, error);
            rootStatus.setText("Fixed root: αποτυχία (" + error.getMessage() + ")");
        }
    }

    private String documentName(Uri uri) {
        final String documentId = DocumentsContract.getTreeDocumentId(uri);
        final Uri documentUri = DocumentsContract.buildDocumentUriUsingTree(uri, documentId);
        try (Cursor cursor = getContentResolver().query(documentUri, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0) == null ? "" : cursor.getString(0);
        }
        return "";
    }

    private void maybeStartAutoSync() {
        if (RootStore.autoEnabled(this) && WirelessProfileStore.hasProfile(this) && RootStore.hasRoots(this)) startAutoSync();
    }

    private void startAutoSync() {
        if (!WirelessProfileStore.hasProfile(this) || !RootStore.hasRoots(this)) {
            rootStatus.setText("Πρώτα αποθήκευσε pairing profile και τα δύο fixed roots.");
            return;
        }
        RootStore.setAutoEnabled(this, true);
        final Intent service = new Intent(this, AutoSyncService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
        else startService(service);
        autoSyncRunning = true;
        autoSync.setText("Διακοπή αυτόματου συγχρονισμού");
        rootStatus.setText("Αυτόματος συγχρονισμός: " + RootStore.status(this));
    }

    private void stopAutoSync() {
        RootStore.setAutoEnabled(this, false);
        stopService(new Intent(this, AutoSyncService.class));
        autoSyncRunning = false;
        autoSync.setText("Έναρξη αυτόματου συγχρονισμού");
        rootStatus.setText("Αυτόματος συγχρονισμός: σταματημένος.");
    }

    private void pickFile(int requestCode) {
        if (!WirelessProfileStore.hasProfile(this)) {
            profileStatus.setText("Πρώτα εισήγαγε Linux pairing profile.");
            return;
        }
        final Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(intent, requestCode);
    }

    private void startTransfer(Uri uri, String root) {
        final String name = displayName(uri);
        if (name.isEmpty()) {
            profileStatus.setText("Μεταφορά: δεν βρέθηκε όνομα αρχείου.");
            return;
        }
        final Intent transfer = new Intent(this, TransferService.class)
                .setData(uri)
                .putExtra("sourceUri", uri.toString())
                .putExtra("relative", root + "/" + name)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(transfer);
            else startService(transfer);
            profileStatus.setText("Μεταφορά ξεκίνησε: " + root + "/" + name);
        } catch (Exception error) {
            profileStatus.setText("Μεταφορά: αποτυχία εκκίνησης (" + error.getMessage() + ")");
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                final String value = cursor.getString(0);
                if (value != null && !value.trim().isEmpty()) return value.replace('/', '_').replace('\\', '_');
            }
        }
        final String fallback = uri.getLastPathSegment();
        return fallback == null ? "" : fallback.replace('/', '_').replace('\\', '_');
    }

    private void sharePairingIdentity() {
        try {
            final Intent share = new Intent(Intent.ACTION_SEND);
            share.setType("application/json");
            share.putExtra(Intent.EXTRA_TEXT, AndroidIdentity.pairingJson(this));
            startActivity(Intent.createChooser(share, "Αποστολή pairing certificate"));
        } catch (Exception error) {
            profileStatus.setText("Pairing certificate: αποτυχία εξαγωγής (" + error.getMessage() + ")");
        }
    }

    private void refreshProfileStatus() {
        profileStatus.setText(WirelessProfileStore.hasProfile(this)
                ? "Pairing profile: αποθηκευμένο· έτοιμο για έλεγχο receiver."
                : "Pairing profile: δεν έχει εισαχθεί Linux receiver profile.");
    }

    private void refreshRootStatus() {
        if (rootStatus == null) return;
        rootStatus.setText("Drive: " + (RootStore.drive(this).isEmpty() ? "δεν έχει δοθεί" : "έτοιμο")
                + " · DCIM/Photos: " + (RootStore.photos(this).isEmpty() ? "δεν έχει δοθεί" : "έτοιμο")
                + "\n" + RootStore.status(this));
        if (autoSync != null && !RootStore.hasRoots(this)) autoSync.setText("Έναρξη αυτόματου συγχρονισμού");
    }

    @Override protected void onResume() {
        super.onResume();
        refreshProfileStatus();
        refreshRootStatus();
    }
}
