package org.localdrive.android;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Small Alpha surface: discovery stays visible while pairing/transfer are added. */
public final class MainActivity extends Activity {
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

        final Button stop = new Button(this);
        stop.setText("Παύση ανίχνευσης");
        stop.setOnClickListener(view -> stopService(new Intent(this, BeaconService.class)));
        layout.addView(stop, new LinearLayout.LayoutParams(-1, -2));
        setContentView(layout);

        final Intent service = new Intent(this, BeaconService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service);
        else startService(service);
    }
}
