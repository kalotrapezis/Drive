package org.localdrive.android;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** Small Alpha surface: discovery stays visible while pairing/transfer are added. */
public final class MainActivity extends Activity {
    private static final int IMPORT_PROFILE = 40;
    private static final int PICK_DRIVE_FILE = 41;
    private static final int PICK_PHOTO_FILE = 42;
    private TextView profileStatus;

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
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
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
        } catch (Exception error) {
            profileStatus.setText("Pairing profile: αποτυχία εισαγωγής (" + error.getMessage() + ")");
        }
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
}
