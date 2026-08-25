package org.localdrive.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Candidate-only discovery. Pairing and file access are deliberately separate. */
public final class BeaconService extends Service {
    private static final int PORT = 43170;
    private static final String CHANNEL = "local-drive-discovery";
    private static final String PREFS = "local-drive-identity";
    private static final String GENERATED_ID = "generated-id";
    private ScheduledExecutorService scheduler;
    private String identity;
    private String label;

    @Override public void onCreate() {
        super.onCreate();
        identity = loadIdentity();
        label = (Build.MANUFACTURER + " " + Build.MODEL).trim();
        createChannel();
        startForeground(1001, notification());
        scheduler = Executors.newSingleThreadScheduledExecutor();
        scheduler.scheduleAtFixedRate(this::broadcast, 0, 5, TimeUnit.SECONDS);
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            final NotificationChannel channel = new NotificationChannel(CHANNEL, "Local Drive discovery", NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    private Notification notification() {
        final Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return builder.setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("Local Drive")
                .setContentText("Available for local discovery")
                .setOngoing(true)
                .build();
    }

    private void broadcast() {
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            final JSONObject beacon = new JSONObject();
            beacon.put("magic", "local-drive-discovery-v1");
            beacon.put("protocol", 1);
            beacon.put("stableIdentity", identity);
            beacon.put("label", label);
            final byte[] payload = beacon.toString().getBytes(StandardCharsets.UTF_8);
            socket.send(new DatagramPacket(payload, payload.length, InetAddress.getByName("255.255.255.255"), PORT));
        } catch (Exception ignored) {
            // Discovery is best-effort; the next scheduled beacon retries without exposing credentials.
        }
    }

    private String loadIdentity() {
        final String androidId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        if (androidId != null && !androidId.trim().isEmpty()) return "wireless:android-" + androidId.toLowerCase(Locale.ROOT);
        final SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        String generated = preferences.getString(GENERATED_ID, "");
        if (generated.isEmpty()) {
            generated = UUID.randomUUID().toString().replace("-", "");
            preferences.edit().putString(GENERATED_ID, generated).apply();
        }
        return "wireless:android-generated-" + generated;
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }

    @Override public void onDestroy() {
        if (scheduler != null) scheduler.shutdownNow();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
