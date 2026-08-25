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
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Runs one user-started wireless transfer outside the Activity lifetime. */
public final class TransferService extends Service {
    private static final int NOTIFICATION_ID = 1002;
    private static final String CHANNEL = "local-drive-transfer";
    private ExecutorService worker;

    @Override public void onCreate() {
        super.onCreate();
        createChannel();
        worker = Executors.newSingleThreadExecutor();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, notification("Μεταφορά σε εξέλιξη"));
        if (intent == null || intent.getStringExtra("sourceUri") == null || intent.getStringExtra("relative") == null) {
            finish(startId, "Αποτυχία: λείπει η πηγή μεταφοράς");
            return START_NOT_STICKY;
        }
        final Uri sourceUri = Uri.parse(intent.getStringExtra("sourceUri"));
        final String relative = intent.getStringExtra("relative");
        worker.execute(() -> transfer(startId, sourceUri, relative));
        return START_NOT_STICKY;
    }

    private void transfer(int startId, Uri sourceUri, String relative) {
        File temporary = null;
        try {
            temporary = copyToCache(this, sourceUri);
            WirelessSender.send(temporary, relative, WirelessProfileStore.senderProfile(this));
            finish(startId, "Ολοκληρώθηκε: " + relative);
        } catch (Exception error) {
            finish(startId, "Αποτυχία: " + error.getMessage());
        } finally {
            if (temporary != null) temporary.delete();
        }
    }

    static File copyToCache(android.content.Context context, Uri sourceUri) throws Exception {
        final File temporary = File.createTempFile("local-drive-transfer-", ".partial", context.getCacheDir());
        try (InputStream input = context.getContentResolver().openInputStream(sourceUri);
             FileOutputStream output = new FileOutputStream(temporary)) {
            if (input == null) throw new IllegalStateException("Δεν ήταν δυνατή η ανάγνωση του αρχείου");
            final byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) if (read > 0) output.write(buffer, 0, read);
        } catch (Exception error) {
            temporary.delete();
            throw error;
        }
        return temporary;
    }

    private void finish(int startId, String message) {
        final NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(NOTIFICATION_ID, notification(message));
        stopSelf(startId);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager.class).createNotificationChannel(
                    new NotificationChannel(CHANNEL, "Local Drive transfers", NotificationManager.IMPORTANCE_LOW));
        }
    }

    private Notification notification(String text) {
        final Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        return builder.setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Local Drive").setContentText(text).setOngoing(true).build();
    }

    @Override public void onDestroy() {
        if (worker != null) worker.shutdownNow();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
