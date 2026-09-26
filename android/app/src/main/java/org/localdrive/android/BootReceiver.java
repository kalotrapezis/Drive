package org.localdrive.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Restores the already-approved local sync after a device reboot. */
public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())
                || !RootStore.autoEnabled(context)
                || !RootStore.hasRoots(context)
                || !WirelessProfileStore.hasProfile(context)) return;
        start(context, BeaconService.class);
        start(context, AutoSyncService.class);
    }

    private static void start(Context context, Class<?> service) {
        final Intent intent = new Intent(context, service);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }
}
