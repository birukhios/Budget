plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Host of your deployed PWA, e.g. birr.example.com — no scheme, no slash.
// Set it in gradle.properties or pass -PappHost=… ; it is baked into the
// Digital Asset Links statement that lets the TWA run without a URL bar.
val appHost: String = (project.findProperty("appHost") as String?) ?: "example.com"

android {
    namespace = "et.birukfin.forwarder"
    compileSdk = 35

    defaultConfig {
        applicationId = "et.birukfin.forwarder"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        manifestPlaceholders["hostName"] = appHost
        resValue("string", "asset_statements",
            """[{ \"relation\": [\"delegate_permission/common.handle_all_urls\"], """ +
            """\"target\": { \"namespace\": \"web\", \"site\": \"https://$appHost\" } }]""")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")  // sideload-friendly
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.browser:browser:1.8.0")
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
}
