plugins { id("com.android.application") }
android {
    namespace = "com.example.hello"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.example.hello"
        minSdk = 24
        targetSdk = 36
        versionCode = 3
        versionName = "0.3"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
