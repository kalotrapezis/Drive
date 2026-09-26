package org.localdrive.android;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsetsController;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

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
    private TextView decisionHistory;
    private LinearLayout problemsContainer;
    private LinearLayout dashboardContainer;
    private Button autoSync;
    private LinearLayout[] sections;
    private Button[] navigationButtons;
    private boolean autoSyncRunning;
    private String locationFilter = "all";

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (getActionBar() != null) getActionBar().hide();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && getWindow().getInsetsController() != null) {
            getWindow().getInsetsController().setSystemBarsAppearance(WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
        } else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        final LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(Color.rgb(248, 250, 250));
        shell.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
            return insets;
        });
        final LinearLayout syncSection = section(), driveSection = section(), photosSection = section(), newSection = section();
        sections = new LinearLayout[]{syncSection, driveSection, photosSection, newSection};

        final TextView title = new TextView(this);
        String identityStatus;
        try {
            AndroidIdentity.ensureGenerated();
            identityStatus = "\nΤο ασφαλές client identity είναι έτοιμο για pairing.";
        } catch (Exception error) {
            identityStatus = "\nΔεν ήταν δυνατή η δημιουργία του client identity.";
        }
        title.setText("Local Drive\n\nΤο κινητό είναι διαθέσιμο για ασύρματη ανίχνευση.\nΗ ανίχνευση δεν δίνει πρόσβαση σε αρχεία." + identityStatus);
        title.setTextSize(20);
        syncSection.addView(title, new LinearLayout.LayoutParams(-1, -2));

        profileStatus = new TextView(this);
        syncSection.addView(profileStatus, new LinearLayout.LayoutParams(-1, -2));

        dashboardContainer = new LinearLayout(this);
        dashboardContainer.setOrientation(LinearLayout.VERTICAL);
        syncSection.addView(dashboardContainer, new LinearLayout.LayoutParams(-1, -2));

        final Button importProfile = new Button(this);
        importProfile.setText("Εισαγωγή Linux pairing profile");
        importProfile.setOnClickListener(view -> {
            final Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/json");
            startActivityForResult(intent, IMPORT_PROFILE);
        });
        syncSection.addView(importProfile, new LinearLayout.LayoutParams(-1, -2));

        final Button shareIdentity = new Button(this);
        shareIdentity.setText("Κοινή χρήση public pairing certificate");
        shareIdentity.setOnClickListener(view -> sharePairingIdentity());
        syncSection.addView(shareIdentity, new LinearLayout.LayoutParams(-1, -2));

        driveSection.addView(sectionTitle("Drive Files", "Διαχείριση της σταθερής ρίζας Drive του κινητού."));

        final Button driveRoot = new Button(this);
        driveRoot.setText("Επίλεξε fixed root Drive");
        driveRoot.setOnClickListener(view -> pickRoot(PICK_DRIVE_ROOT));
        driveSection.addView(driveRoot, new LinearLayout.LayoutParams(-1, -2));

        photosSection.addView(sectionTitle("Photos & Videos", "Ο φάκελος DCIM είναι η σταθερή πηγή για φωτογραφίες και βίντεο."));

        final Button photosRoot = new Button(this);
        photosRoot.setText("Επίλεξε fixed root DCIM → Photos");
        photosRoot.setOnClickListener(view -> pickRoot(PICK_PHOTOS_ROOT));
        photosSection.addView(photosRoot, new LinearLayout.LayoutParams(-1, -2));

        rootStatus = new TextView(this);
        syncSection.addView(rootStatus, new LinearLayout.LayoutParams(-1, -2));

        problemsContainer = new LinearLayout(this);
        problemsContainer.setOrientation(LinearLayout.VERTICAL);
        syncSection.addView(problemsContainer, new LinearLayout.LayoutParams(-1, -2));

        decisionHistory = new TextView(this);
        syncSection.addView(decisionHistory, new LinearLayout.LayoutParams(-1, -2));

        autoSync = new Button(this);
        autoSync.setText("Έναρξη αυτόματου συγχρονισμού");
        autoSync.setOnClickListener(view -> {
            if (autoSyncRunning) stopAutoSync();
            else startAutoSync();
        });
        syncSection.addView(autoSync, new LinearLayout.LayoutParams(-1, -2));

        newSection.addView(sectionTitle("Νέο +", "Επίλεξε ένα αρχείο ή μέσο για ασφαλή μεταφορά στο laptop."));

        final Button driveSend = new Button(this);
        driveSend.setText("Επιλογή αρχείου → Drive");
        driveSend.setOnClickListener(view -> pickFile(PICK_DRIVE_FILE));
        newSection.addView(driveSend, new LinearLayout.LayoutParams(-1, -2));

        final Button photoSend = new Button(this);
        photoSend.setText("Επιλογή φωτογραφίας/βίντεο → Photos");
        photoSend.setOnClickListener(view -> pickFile(PICK_PHOTO_FILE));
        newSection.addView(photoSend, new LinearLayout.LayoutParams(-1, -2));

        final Button stop = new Button(this);
        stop.setText("Παύση ανίχνευσης");
        stop.setOnClickListener(view -> stopService(new Intent(this, BeaconService.class)));
        syncSection.addView(stop, new LinearLayout.LayoutParams(-1, -2));

        final LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        for (LinearLayout section : sections) content.addView(section, new LinearLayout.LayoutParams(-1, -2));
        final ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.addView(content);
        shell.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));

        final LinearLayout navigation = new LinearLayout(this);
        navigation.setOrientation(LinearLayout.HORIZONTAL);
        navigation.setPadding(6, 6, 6, 6);
        navigation.setBackgroundColor(Color.WHITE);
        final String[] labels = {"Sync\n& συνδέσεις", "Drive\nαρχεία", "Photos\n& videos", "Νέο\n+"};
        final String[] descriptions = {"tab-sync", "tab-drive", "tab-photos", "tab-new"};
        navigationButtons = new Button[labels.length];
        for (int index = 0; index < labels.length; ++index) {
            final int selected = index;
            final Button button = new Button(this);
            button.setText(labels[index]); button.setTextSize(12); button.setAllCaps(false); button.setContentDescription(descriptions[index]);
            button.setOnClickListener(view -> showSection(selected));
            navigationButtons[index] = button;
            navigation.addView(button, new LinearLayout.LayoutParams(0, -2, 1));
        }
        shell.addView(navigation, new LinearLayout.LayoutParams(-1, -2));
        setContentView(shell);
        showSection(0);

        final Intent service = new Intent(this, BeaconService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
        else startService(service);
        refreshProfileStatus();
        refreshRootStatus();
        refreshDashboard();
        refreshProblems();
        refreshDecisionHistory();
        maybeStartAutoSync();
    }

    private LinearLayout section() {
        final LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(40, 36, 40, 36);
        layout.setGravity(Gravity.CENTER_HORIZONTAL);
        return layout;
    }

    private TextView sectionTitle(String title, String summary) {
        final TextView view = new TextView(this);
        view.setText(title + "\n\n" + summary);
        view.setTextSize(20);
        view.setPadding(0, 8, 0, 24);
        return view;
    }

    private void showSection(int selected) {
        if (sections == null || navigationButtons == null || selected < 0 || selected >= sections.length) return;
        for (int index = 0; index < sections.length; ++index) {
            final boolean active = index == selected;
            sections[index].setVisibility(active ? View.VISIBLE : View.GONE);
            navigationButtons[index].setSelected(active);
            navigationButtons[index].setTextColor(active ? Color.rgb(0, 125, 131) : Color.rgb(55, 64, 68));
            navigationButtons[index].setAlpha(active ? 1f : 0.72f);
        }
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

    private void refreshDecisionHistory() {
        if (decisionHistory == null) return;
        final java.util.List<org.json.JSONObject> items = RootStore.resolutions(this);
        final java.util.List<JSONObject> corrections = RootStore.correctionHistory(this);
        final StringBuilder text = new StringBuilder("\nΑποφάσεις συγχρονισμού: ").append(items.size() + corrections.size());
        for (int index = 0; index < Math.min(3, items.size()); ++index) {
            final org.json.JSONObject item = items.get(index);
            final String action = item.optString("action");
            text.append("\n• ").append("dismiss".equals(action) ? "Έγινε απόκρυψη" : "accept_existing".equals(action) ? "Χρησιμοποιήθηκε υπάρχον αντίγραφο" : "keep_both".equals(action) ? "Διατηρήθηκαν και τα δύο" : "skip_unsupported".equals(action) ? "Τα μη υποστηριζόμενα έμειναν στην πηγή" : "Αποθηκεύτηκε για έλεγχο")
                    .append(": ").append(item.optString("title", "Πρόβλημα συγχρονισμού"));
        }
        for (int index = 0; index < Math.min(3, corrections.size()); ++index) text.append("\n• Επανέλεγχος στο κινητό: ").append(correctionLabel(corrections.get(index).optString("status")));
        if (items.isEmpty() && corrections.isEmpty()) text.append(" · καμία ακόμη");
        decisionHistory.setText(text);
    }

    private void refreshProblems() {
        if (problemsContainer == null) return;
        problemsContainer.removeAllViews();
        final TextView heading = new TextView(this);
        heading.setText("\nΠροβλήματα & διορθώσεις"); heading.setTextSize(18);
        problemsContainer.addView(heading);
        if (!WirelessProfileStore.hasProfile(this)) {
            addProblemText("Χρειάζεται pairing profile για να ληφθούν τα ενεργά προβλήματα.");
            return;
        }
        try {
            final String peer = WirelessProfileStore.senderProfile(this).serverFingerprint;
            final java.util.List<JSONObject> reviews = RootStore.activeReviews(this, peer);
            final JSONArray pendingCorrections = RootStore.pendingCorrectionResults(this, peer);
            for (int index = 0; index < pendingCorrections.length(); ++index) addProblemText("Επανέλεγχος στο κινητό: " + correctionLabel(pendingCorrections.getJSONObject(index).optString("status")) + " · περιμένει επιβεβαίωση από το laptop.");
            if (reviews.isEmpty() && pendingCorrections.length() == 0) { addProblemText("Δεν υπάρχουν ενεργά προβλήματα."); return; }
            for (JSONObject review : reviews) {
                addProblemText(review.optString("title", "Πρόβλημα συγχρονισμού") + "\n" + review.optString("summary"));
                final JSONArray actions = review.getJSONArray("allowedActions");
                for (int index = 0; index < actions.length(); ++index) {
                    final String action = actions.getString(index);
                    final Button button = new Button(this); button.setText(actionLabel(action));
                    button.setOnClickListener(view -> queueProblemDecision(peer, review, action));
                    problemsContainer.addView(button, new LinearLayout.LayoutParams(-1, -2));
                }
            }
        } catch (Exception error) {
            addProblemText("Δεν ήταν δυνατή η εμφάνιση των προβλημάτων: " + error.getMessage());
        }
    }

    private void refreshDashboard() {
        if (dashboardContainer == null) return;
        dashboardContainer.removeAllViews();
        final TextView heading = new TextView(this); heading.setText("\nSync & συνδέσεις"); heading.setTextSize(20); dashboardContainer.addView(heading);
        if (!WirelessProfileStore.hasProfile(this)) { addDashboardText("Δεν υπάρχουν ακόμη δεδομένα από το laptop."); return; }
        try {
            final JSONObject snapshot = RootStore.catalogSnapshot(this, WirelessProfileStore.senderProfile(this).serverFingerprint);
            if (!snapshot.has("devices")) { addDashboardText("Περιμένει τον πρώτο ασφαλή συγχρονισμό καταλόγου."); return; }
            addDashboardText("Σε αναμονή: " + snapshot.optLong("pendingFiles") + " αρχεία · " + formatBytes(snapshot.optLong("pendingBytes")) + "\nΤελευταία ενημέρωση: " + snapshot.optString("lastUpdate", "—"));
            final JSONObject transfer = snapshot.optJSONObject("activeTransfer");
            if (transfer == null) addDashboardText("Τρέχουσα μεταφορά: καμία");
            else addDashboardText("Τρέχουσα μεταφορά: " + transfer.optString("state") + " · " + formatBytes(transfer.optLong("bytesDone")) + " / " + formatBytes(transfer.optLong("bytesTotal")));
            addDashboardText("\nΑποθηκευτικοί χώροι");
            final JSONArray storages = snapshot.getJSONArray("storages");
            for (int index = 0; index < storages.length(); ++index) {
                final JSONObject storage = storages.getJSONObject(index); final long total = storage.optLong("bytesTotal"), free = storage.optLong("bytesFree");
                addDashboardText(storage.optString("label") + " · " + storage.optString("presence") + "\n" + (total > 0 ? formatBytes(total - free) + " χρησιμοποιούνται · " + formatBytes(free) + " ελεύθερα από " + formatBytes(total) : formatBytes(storage.optLong("knownBytes")) + " γνωστά αρχεία"));
                if (total > 0) { final ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); bar.setMax(1000); bar.setProgress((int) Math.min(1000L, Math.max(0L, (total - free) * 1000L / total))); dashboardContainer.addView(bar, new LinearLayout.LayoutParams(-1, -2)); }
            }
            addDashboardText("\nΣυσκευές");
            final JSONArray devices = snapshot.getJSONArray("devices");
            for (int index = 0; index < devices.length(); ++index) {
                final JSONObject device = devices.getJSONObject(index); final String status = device.optString("status");
                addDashboardText("• " + device.optString("label") + " (" + device.optString("kind") + ") · " + ("online".equals(status) ? "online τώρα" : "last_reported".equals(status) ? "τελευταία αναφορά " + device.optString("lastSeen") : "δεν έχει ελεγχθεί"));
            }
            addDashboardText("\nΠρόσφατες θέσεις αρχείων");
            final LinearLayout filters = new LinearLayout(this); filters.setOrientation(LinearLayout.HORIZONTAL);
            filters.addView(locationFilterButton("Όλα", "all")); filters.addView(locationFilterButton("Verified", "verified")); filters.addView(locationFilterButton("Attention", "attention")); dashboardContainer.addView(filters);
            final JSONArray locations = snapshot.optJSONArray("locations");
            if (locations == null || locations.length() == 0) addDashboardText("Δεν υπάρχουν ακόμη καταγεγραμμένες θέσεις.");
            else { int shown = 0; for (int index = 0; index < locations.length() && shown < 10; ++index) {
                final JSONObject location = locations.getJSONObject(index); final boolean verified = "verified".equals(location.optString("state"));
                if (("verified".equals(locationFilter) && !verified) || ("attention".equals(locationFilter) && verified)) continue;
                addDashboardText((verified ? "✓ " : "⚠ ") + location.optString("relativePath") + "\n" + location.optString("storageLabel") + " · " + formatBytes(location.optLong("sizeBytes")) + " · " + (verified ? "SHA-256 verified " + location.optString("verifiedAt") : location.optString("state")));
                ++shown;
            } if (shown == 0) addDashboardText("Δεν υπάρχουν αποτελέσματα με αυτό το φίλτρο."); }
            final LinearLayout pages = new LinearLayout(this); pages.setOrientation(LinearLayout.HORIZONTAL);
            final Button latest = new Button(this); latest.setText("Νεότερα"); latest.setEnabled(snapshot.optLong("locationRequestCursor") != 0); latest.setOnClickListener(view -> requestLocationPage(0)); pages.addView(latest);
            final Button older = new Button(this); older.setText("Παλαιότερα"); older.setEnabled(snapshot.optBoolean("locationsHasMore") && snapshot.optLong("locationNextCursor") > 0); older.setOnClickListener(view -> requestLocationPage(snapshot.optLong("locationNextCursor"))); pages.addView(older); dashboardContainer.addView(pages);
            if (snapshot.optBoolean("locationsTruncated")) addDashboardText("Η σελίδα περιορίστηκε για να μείνει ασφαλώς μέσα στο όριο του ασύρματου πακέτου.");
        } catch (Exception error) { addDashboardText("Δεν ήταν δυνατή η εμφάνιση του καταλόγου: " + error.getMessage()); }
    }

    private Button locationFilterButton(String label, String filter) {
        final Button button = new Button(this); button.setText(label); button.setEnabled(!filter.equals(locationFilter)); button.setOnClickListener(view -> { locationFilter = filter; refreshDashboard(); }); return button;
    }

    private void requestLocationPage(long cursor) {
        try {
            final String peer = WirelessProfileStore.senderProfile(this).serverFingerprint; RootStore.setLocationCursor(this, peer, cursor);
            final Intent sync = new Intent(this, AutoSyncService.class).setAction(AutoSyncService.ACTION_SYNC_NOW);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(sync); else startService(sync);
            RootStore.setStatus(this, "Φόρτωση σελίδας θέσεων από το laptop..."); refreshRootStatus();
        } catch (Exception error) { rootStatus.setText("Δεν φορτώθηκε η σελίδα: " + error.getMessage()); }
    }

    private void addDashboardText(String value) {
        final TextView text = new TextView(this); text.setText(value); text.setPadding(0, 8, 0, 8); dashboardContainer.addView(text, new LinearLayout.LayoutParams(-1, -2));
    }

    private String formatBytes(long bytes) {
        if (bytes < 1000) return bytes + " B";
        final String[] units = {"KB", "MB", "GB", "TB"}; double value = bytes; int unit = -1;
        do { value /= 1000.0; ++unit; } while (value >= 1000.0 && unit < units.length - 1);
        return String.format(java.util.Locale.ROOT, "%.1f %s", value, units[unit]);
    }

    private void addProblemText(String value) {
        final TextView text = new TextView(this); text.setText(value);
        problemsContainer.addView(text, new LinearLayout.LayoutParams(-1, -2));
    }

    private void queueProblemDecision(String peer, JSONObject review, String action) {
        try {
            RootStore.queueReviewAction(this, peer, review, action);
            RootStore.setStatus(this, "Η διόρθωση περιμένει ασφαλή επιβεβαίωση από το laptop.");
            startAutoSync(); refreshProblems(); refreshRootStatus();
        } catch (Exception error) {
            rootStatus.setText("Η διόρθωση δεν αποθηκεύτηκε: " + error.getMessage());
        }
    }

    private String actionLabel(String action) {
        if ("dismiss".equals(action)) return "Απόκρυψη";
        if ("accept_existing".equals(action)) return "Χρήση υπάρχοντος αντιγράφου";
        if ("keep_both".equals(action)) return "Διατήρηση και των δύο";
        if ("skip_unsupported".equals(action)) return "Να μείνουν στην πηγή";
        return "Αποθήκευση για έλεγχο";
    }

    private String correctionLabel(String status) {
        if ("verified".equals(status)) return "επαληθεύτηκε";
        if ("changed".equals(status)) return "το αρχείο άλλαξε";
        if ("missing".equals(status)) return "το αρχείο λείπει";
        return "ο έλεγχος απέτυχε";
    }

    @Override protected void onResume() {
        super.onResume();
        refreshProfileStatus();
        refreshRootStatus();
        refreshDashboard();
        refreshProblems();
        refreshDecisionHistory();
    }
}
