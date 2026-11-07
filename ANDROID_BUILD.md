# WALLET OS for Android

This repository builds the existing WALLET OS application as an Android APK using Capacitor 8. The native project is generated during CI from the tracked configuration; the application UI and business logic continue to come from the root `index.html`.

## Android application

- Display name: WALLET OS
- Android application ID: `com.walletos.finance`
- Runtime: Capacitor 8.6.0
- Minimum supported Android level: Capacitor's Android 8+ baseline
- Build output: `android/app/build/outputs/apk/debug/app-debug.apk`

The debug APK is installable on an Android device for testing. It is not a Play Store release build and is not signed with a private release keystore.

## Build from a local checkout

Use Node.js 22.2 or newer, Java 21, Android SDK Platform 36 and the Android build-tools package required by the generated Gradle project.

```sh
npm install
npm test
npm run android:build
```

The preparation script copies `index.html`, `sw.js`, `manifest.webmanifest` and `icon.svg` into the generated `www/` bundle. Capacitor then copies that bundle into Android before Gradle builds the APK.

## Automated APK

Every push to `main` that changes the app, API, tests, mobile configuration or Android workflow starts **Android APK**. It runs the Node regression suite, generates the Android project, builds the debug APK and publishes it as a GitHub Actions artifact named `WALLET-OS-debug-APK` for 30 days. The workflow can also be started manually from the repository Actions tab.

## API and authentication behavior

The native webview uses the secure local origin `https://localhost`. The app routes its two Vercel functions (AI and Aden exchange rates) to the current production deployment. Those APIs explicitly allow CORS only from `https://localhost`; other cross-origin websites remain blocked. The AI route still requires the same authenticated Supabase session and its existing server-side checks.

Email verification and password recovery open the hosted WALLET OS website because the native custom URL scheme is not registered as a Supabase redirect. After confirming an email or changing a password in the browser, return to the APK and sign in there.

## Data and privacy notes

- The Android app has its own device storage. Guest/local-only data that exists only in a desktop browser is not automatically copied into the APK.
- Sign in to the same Supabase cloud account to load cloud-synced wallets and financial records on Android.
- Offline local-first behavior is retained after the app shell and Supabase SDK have been cached on the device. Market quotes, AI requests, authentication and cloud synchronization need an internet connection.
- Supabase financial data remains protected by the existing user-scoped Row Level Security policies. The APK contains no service-role key, no AI provider secret and no private signing key.
- The build uses a debug signing certificate. A separately managed private keystore and Play App Signing configuration are required before publishing a store-ready release.

## Release signing

Do not commit a keystore or its passwords. For a release APK/AAB, store the signing material as protected repository secrets, wire it into a dedicated release workflow, and rotate the key if it is ever exposed.
