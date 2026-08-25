package org.localdrive.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;

import java.io.File;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Copy-only background scan; an item is remembered only after a Linux receipt. */
public final class AutoSyncService extends Service {
    private static final int NOTIFICATION_ID = 1003;
    private static final String CHANNEL = "local-drive-auto-sync";
    private ScheduledExecutorService scheduler;
    private boolean scanning;
    private boolean scheduled;

    @Override public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "Local Drive automatic sync", NotificationManager.IMPORTANCE_LOW));
        scheduler = Executors.newSingleThreadScheduledExecutor();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, notification("Αναμονή για νέα αρχεία"));
        if (!RootStore.hasRoots(this) || !WirelessProfileStore.hasProfile(this)) {
            update("Χρειάζονται pairing profile και οι δύο fixed roots");
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (scheduler != null && !scheduled) {
            scheduled = true;
            scheduler.scheduleWithFixedDelay(this::scanAndSend, 0, 60, TimeUnit.SECONDS);
        }
        return START_STICKY;
    }

    private void scanAndSend() {
        if (scanning) return;
        scanning = true;
        try {
            update("Σάρωση Drive...");
            final boolean driveCompleted = RootScanner.scan(this, Uri.parse(RootStore.drive(this)), entry -> sendIfNeeded("Drive", entry));
            if (driveCompleted) {
                update("Σάρωση Photos...");
                RootScanner.scan(this, Uri.parse(RootStore.photos(this)), entry -> sendIfNeeded("Photos", entry));
            }
            if (driveCompleted) update("Αναμονή για νέα αρχεία");
        } catch (Exception error) {
            update("Παύση: " + error.getMessage());
        } finally {
            scanning = false;
        }
    }

    private boolean sendIfNeeded(String root, RootScanner.Entry entry) {
        final String key = root + "|" + entry.uri + "|" + entry.size + "|" + entry.modified;
        if (RootStore.sent(this, key)) return true;
        File temporary = null;
        try {
            update("Αποστολή " + root + "/" + entry.relative);
            temporary = TransferService.copyToCache(this, entry.uri);
            WirelessSender.send(temporary, root + "/" + entry.relative, WirelessProfileStore.senderProfile(this));
            RootStore.markSent(this, key);
            return true;
        } catch (Exception error) {
            update("Αποτυχία " + root + "/" + entry.relative + ": " + error.getMessage());
            return false;
        } finally {
            if (temporary != null) temporary.delete();
        }
    }

    private void update(String message) {
        RootStore.setStatus(this, message);
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(message));
    }

    private Notification notification(String message) {
        final Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder.setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Local Drive").setContentText(message).setOngoing(true).build();
    }

    @Override public void onDestroy() {
        if (scheduler != null) scheduler.shutdownNow();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
