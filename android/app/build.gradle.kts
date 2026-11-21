import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The version follows the web app's package.json, so the APK, the extension and the site match.
val webVersion = (JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>)["version"] as String
val versionParts = webVersion.split(".").map { it.toInt() }

// Release signing comes from the environment (CI secrets or a local keystore), never from git.
val keystorePath: String? = System.getenv("KAIPASS_KEYSTORE")

android {
    namespace = "io.github.thanhkaiba.kaipass"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.thanhkaiba.kaipass"
        minSdk = 26
        targetSdk = 36
        versionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]
        versionName = webVersion
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("KAIPASS_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KAIPASS_KEY_ALIAS") ?: "kaipass"
                keyPassword = System.getenv("KAIPASS_KEY_PASSWORD") ?: System.getenv("KAIPASS_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    // The web app, built with `npm run build:android`, is served from the APK's assets.
    sourceSets["main"].assets.srcDirs(rootProject.file("../dist-android"))

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.fragment:fragment-ktx:1.8.8")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.autofill:autofill:1.3.0")
    implementation("androidx.credentials:credentials:1.5.0")
    implementation("com.google.android.gms:play-services-auth:21.4.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}
