plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "am.heraxos.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "am.heraxos.app"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0." + (System.getenv("GITHUB_RUN_NUMBER") ?: "0")
        // адрес вашего сервера Heraxos
        buildConfigField("String", "SERVER", "\"https://82-26-86-235.sslip.io:8445\"")
    }

    signingConfigs {
        create("heraxos") {
            storeFile = file("heraxos.jks")
            storePassword = "heraxos2026"
            keyAlias = "heraxos"
            keyPassword = "heraxos2026"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("heraxos")
        }
        debug { signingConfig = signingConfigs.getByName("heraxos") }
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
}
