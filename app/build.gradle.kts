plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "am.heraxos.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "am.ahazang.app"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
        // адрес сервера Ahazang
        buildConfigField("String", "SERVER", "\"https://ahazang.klegal.ru\"")
        // нативные звонки (WebRTC): только 64- и 32-битные ARM-телефоны — так приложение меньше
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    // Ключ подписи НЕ хранится в репозитории: GitHub Actions берёт его из секретов
    // ANDROID_KEYSTORE_B64 (keystore в base64) и ANDROID_KEYSTORE_PASSWORD, локально — из ahazang.jks рядом.
    signingConfigs {
        create("ahazang") {
            storeFile = file(System.getenv("ANDROID_KEYSTORE_FILE") ?: "ahazang.jks")
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
            keyAlias = "ahazang"
            keyPassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("ahazang")
        }
        debug { signingConfig = signingConfigs.getByName("ahazang") }
    }

    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // WebRTC для нативных звонков (сборка Google WebRTC для Android)
    implementation("io.getstream:stream-webrtc-android:1.3.10")
}
