plugins { id("com.android.application") }

// The same project builds two things:
//  - the runtime that tethertrace installs to run any package (the defaults below), and
//  - a standalone app for one package: -PtappId, -PtappName, -PtappVersion and -PtappEmbed=<folder
//    holding app.tapp>, used by `tethertrace convert app.tapp --to apk`.
val tappId = (findProperty("tappId") as String?) ?: "dev.tethertrace.host"
val tappName = (findProperty("tappName") as String?) ?: "tapp runtime"
val tappVersion = (findProperty("tappVersion") as String?) ?: "0.1.0"
val tappEmbed = findProperty("tappEmbed") as String?

android {
    namespace = "dev.tethertrace.host"
    compileSdk = 36
    defaultConfig {
        applicationId = tappId
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = tappVersion
        manifestPlaceholders["appLabel"] = tappName
    }
    sourceSets["main"].assets.srcDirs(listOfNotNull("../../shared", tappEmbed))
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
