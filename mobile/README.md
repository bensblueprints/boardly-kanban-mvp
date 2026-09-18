# Boardly mobile

Expo SDK 56 / React Native 0.85 app for Android and iOS. Native Clerk sign-in, secure credential cache, account selection, company filters and project search open the complete Boardly workspace in a restricted WebView. Files share through the device share sheet; external links open in the system browser. An internet connection is required.

```sh
npm ci
node scripts/configure-cloud.cjs
npm run typecheck
npx expo prebuild --no-install --template expo-template-bare-minimum@56.0.35
npm run android
# On a Mac with Xcode:
npm run ios
```

The configuration script reads only the public authentication configuration. Clerk secret keys and service credentials never belong in the mobile app. `.env.local`, native generated folders, signing keys and build outputs are ignored. The native template is pinned to SDK 56; the unqualified current template targets a newer SDK.

Android package and iOS bundle identifier: `com.boardlyagent.app`. Native Clerk currently requires iOS 17 or later. Its prebuilt authentication components are beta; verify sign-in, account recovery and session persistence on both platforms before a store release.

The server must publish the matching `/mobile/` frontend entry. Native session tokens are requested when needed and passed only to that trusted, current document. They never go in a URL or ordinary device storage. Existing tenant selection and membership checks remain enforced by the cloud API. File and attachment requests include authenticated headers. Share files are removed from the app cache after the share sheet closes.

The app explicitly disables WebView debugging in release builds. Inspect this on a production Android system image or physical device: Chromium forces inspection on Android `userdebug`/`eng` system images even when a non-debuggable app disables it. Our API 36 emulator uses such a system image; its debug socket does not indicate that the APK is debuggable.

GitHub Actions builds Apple Silicon iOS simulator and unsigned iPhone device apps. App Store/TestFlight distribution and installable iPhone builds additionally require the appropriate Apple signing account and provisioning profile; Google Play distribution requires its developer account and a private upload key. Neither unsigned archive is an installable iPhone IPA.

Android release builds require `BOARDLY_KEYSTORE_PATH`, `BOARDLY_KEYSTORE_PASSWORD`, `BOARDLY_KEY_ALIAS` and `BOARDLY_KEY_PASSWORD` in the build environment. Keep the keystore and its passwords outside the repository with a private backup. The signing plugin deliberately fails a release build without these values; it never substitutes the public Android debug key. After prebuild, run `./gradlew assembleRelease bundleRelease -PreactNativeArchitectures=arm64-v8a,x86_64` from `android/`. Release builds bundle JavaScript and run without Metro.

Root tests: `node test/native-workspace-browser.cjs` and `node test/chatgpt-onboarding-browser.cjs`. These verify the web portion with isolated test accounts. Device testing and release-signing evidence are tracked on Boardly project 2, card 330.
