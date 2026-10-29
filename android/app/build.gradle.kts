plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Monotonic identity for every build, supplied by the release workflow as the GitHub Actions run
// number. versionCode/versionName only change when a release is cut, so the beta channel — which
// rebuilds on every push to `main` — would otherwise have no way to tell two builds of the same
// version apart. Left at 0 for local builds, which the updater reads as "not a CI build" and
// falls back to its timestamp heuristic for.
val bdsBuildId: Long = (project.findProperty("bdsBuildId") as String?)?.toLongOrNull() ?: 0L

android {
    namespace = "com.superdeepseek.app"
    // Android 16 (API 36). targetSdk 36 is what Play requires for updates since 2026-08-31.
    compileSdk = 36

    buildFeatures {
        buildConfig = true
    }
    
    defaultConfig {
        applicationId = "com.superdeepseek.app"
        minSdk = 26
        targetSdk = 36
        // Monotonically increasing versionCode ensures updates install smoothly over older versions.
        // 2.50 moved to a new signing key. 2.60 (same key) uses a new base so the local 2.60.0
        // baseline (bdsBuildId = 0) and every later CI build (2_600_100 + run number, 2.60.1) update any
        // 2.50.x build in place. 2.70 (same key) starts at 2_700_000 so it updates every 2.60.x build;
        // 2.70.1 moves to 2_701_000 so it is above every 2.70.0 CI build (run numbers < 1000).
        // 2.71.0 starts at 2_710_000 so it is above every 2.70.x build.
        // 2.72.0 starts at 2_720_000 so it is above every 2.71.x build (toolchain update:
        // AGP 8.13.2 / Gradle 8.13 / Kotlin 2.3.21 / compileSdk+targetSdk 36).
        versionCode = (2_720_000L + bdsBuildId).toInt()
        // Keep in sync with package.json "version".
        versionName = "2.72.0"
        buildConfigField("long", "BUILD_ID", "${bdsBuildId}L")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        signingConfigs {
            create("release") {
                val releaseKeystore = file("superdeepseek-release.jks").takeIf { it.exists() }
                    ?: rootProject.file("ci-release.jks").takeIf { it.exists() }
                    ?: rootProject.file("android/app/superdeepseek-release.jks").takeIf { it.exists() }

                val requireCiSigning = System.getenv("BDS_REQUIRE_RELEASE_SIGNING") == "true"
                val envStorePass = System.getenv("BDS_KEYSTORE_PASSWORD")
                val envAlias = System.getenv("BDS_KEY_ALIAS")
                val envKeyPass = System.getenv("BDS_KEY_PASSWORD")

                if (requireCiSigning && (releaseKeystore == null || !releaseKeystore.exists())) {
                    throw org.gradle.api.GradleException(
                        "CI requires an explicitly prepared release keystore; refusing to sign with a debug or fallback key."
                    )
                }
                if (requireCiSigning && (envStorePass.isNullOrEmpty() || envAlias.isNullOrEmpty() || envKeyPass.isNullOrEmpty())) {
                    throw org.gradle.api.GradleException(
                        "CI release signing credentials are incomplete; refusing to build a publishable APK."
                    )
                }

                if (releaseKeystore != null && releaseKeystore.exists()) {
                    storeFile = releaseKeystore
                    storePassword = if (!envStorePass.isNullOrEmpty()) envStorePass else "superdeepseek"
                    keyAlias = if (!envAlias.isNullOrEmpty()) envAlias else "superdeepseek"
                    keyPassword = if (!envKeyPass.isNullOrEmpty()) envKeyPass else "superdeepseek"
                } else {
                    // Local release builds may use the debug key for convenience. CI sets
                    // BDS_REQUIRE_RELEASE_SIGNING=true and must never take this fallback.
                    val debugConfig = getByName("debug")
                    storeFile = debugConfig.storeFile
                    storePassword = debugConfig.storePassword
                    keyAlias = debugConfig.keyAlias
                    keyPassword = debugConfig.keyPassword
                }
            }
        }
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Kotlin 2.x: compilerOptions replaces the removed/deprecated kotlinOptions block.
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }

    packaging {
        resources {
            excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1")
        }
        jniLibs {
            // The Linux sandbox execs proot from nativeLibraryDir (the only app
            // location Android allows exec() from), so the libraries must be
            // extracted at install time rather than mapped from the APK.
            useLegacyPackaging = true
            // proot and its loader are executables, not ordinary libraries: ship
            // them exactly as fetched.
            keepDebugSymbols += setOf("**/libproot.so", "**/libproot-loader.so", "**/libproot-loader32.so", "**/libtalloc.so")
        }
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
            isIncludeAndroidResources = true
            all {
                // WebViewBridgePickerTest needs more than Gradle's 512m default
                // (reproducible OOM). Override locally with -PtestMaxHeap=…
                it.maxHeapSize = (project.findProperty("testMaxHeap") as String?) ?: "1536m"
            }
        }
    }
}

dependencies {
    // Deliberately NOT the newest releases lint offers (core-ktx 1.19.1, webkit 1.18.0, …):
    // those AARs require compileSdk 37, and AGP 8.13 tops out at API 36.1. They come back
    // when the project moves to AGP 9.x. These are the newest lines that still build on
    // compileSdk 36; androidx.webkit matters most, because this app IS a WebView.
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.documentfile:documentfile:1.0.1")

    implementation("com.google.android.material:material:1.12.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.mockito:mockito-core:5.12.0")
    testImplementation("org.mockito.kotlin:mockito-kotlin:5.4.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20240303")
    // 4.17 is the first line with API 36 runtime support; with compileSdk 36 the
    // Robolectric tests would otherwise refuse to start.
    testImplementation("org.robolectric:robolectric:4.17")

    androidTestImplementation("androidx.test.ext:junit-ktx:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
