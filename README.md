# fictional-octo-tribble
An Android app written in Kotlin with Jetpack Compose.

- Compile/target SDK 35, min SDK 24
- Android Gradle Plugin 8.13.2, Kotlin 2.2.21, Gradle 8.14.3 (via the wrapper)
- Requires JDK 17 or newer and the Android SDK (`platforms;android-35`, `build-tools;35.0.0`)

## Build and test

```sh
./gradlew assembleDebug        # build the debug APK -> app/build/outputs/apk/debug/
./gradlew testDebugUnitTest    # run unit tests
./gradlew lintDebug            # run Android lint
```

Point Gradle at your SDK with `ANDROID_HOME` or a `local.properties` file containing `sdk.dir=/path/to/sdk`.
