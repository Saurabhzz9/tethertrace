pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
plugins { id("com.android.application") version "8.9.1" apply false }
rootProject.name = "hello"
include(":app")
