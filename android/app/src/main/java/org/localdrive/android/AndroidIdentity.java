package org.localdrive.android;

import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import javax.security.auth.x500.X500Principal;
import java.math.BigInteger;
import java.security.KeyStore;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.Date;
import java.util.Locale;

/** Creates and exposes only the public half of the Android pairing identity. */
public final class AndroidIdentity {
    public static final String ALIAS = "local-drive-client";

    private AndroidIdentity() {}

    public static void ensureGenerated() throws Exception {
        final KeyStore store = keyStore();
        if (store.containsAlias(ALIAS)) return;
        final KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore");
        final long now = System.currentTimeMillis();
        generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA512)
                .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                .setCertificateSubject(new X500Principal("CN=Local Drive Android"))
                .setCertificateSerialNumber(BigInteger.ONE)
                .setCertificateNotBefore(new Date(now - 60_000))
                .setCertificateNotAfter(new Date(now + 10L * 365 * 24 * 60 * 60 * 1000))
                .setUserAuthenticationRequired(false)
                .build());
        generator.generateKeyPair();
    }

    public static String certificatePem() throws Exception {
        final byte[] encoded = certificate().getEncoded();
        final String base64 = Base64.encodeToString(encoded, Base64.NO_WRAP);
        final StringBuilder wrapped = new StringBuilder("-----BEGIN CERTIFICATE-----\n");
        for (int offset = 0; offset < base64.length(); offset += 64) wrapped.append(base64, offset, Math.min(offset + 64, base64.length())).append('\n');
        return wrapped.append("-----END CERTIFICATE-----\n").toString();
    }

    public static String certificateFingerprint() throws Exception {
        return hex(MessageDigest.getInstance("SHA-256").digest(certificate().getEncoded()));
    }

    public static String pairingJson(Context context) throws Exception {
        return new org.json.JSONObject()
                .put("protocol", 1)
                .put("deviceId", BeaconService.identityFor(context))
                .put("deviceName", (Build.MANUFACTURER + " " + Build.MODEL).trim())
                .put("clientCertificatePem", certificatePem())
                .put("clientFingerprint", certificateFingerprint())
                .toString(2);
    }

    private static X509Certificate certificate() throws Exception {
        ensureGenerated();
        return (X509Certificate) keyStore().getCertificate(ALIAS);
    }

    private static KeyStore keyStore() throws Exception {
        final KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    private static String hex(byte[] bytes) {
        final StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }
}
