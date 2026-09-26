plugins {
    id("com.android.application")
}

android {
    namespace = "org.localdrive.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "org.localdrive.android"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1-alpha"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
