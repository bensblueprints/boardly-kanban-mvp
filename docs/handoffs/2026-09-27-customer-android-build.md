# Customer Android build — 2026-09-27

Boardly project 37, card 474. Source branch `task/474-customer-workspace` in `bensblueprints/boardly-kanban-mvp`.

This is the customer workspace app, package `com.boardlyagent.app`, version 1.0.1 / code 2. It is separate from the owner-paired `com.benboyce.boardlyvoice` 1.4.0 app. The existing customer release key is retained; private signing material stays outside source control.

The app includes Clerk native sign-in, company/project selection, full web workspace access, dashboard and profile shortcuts, and an authenticated Android Download update control. The updater verifies the download endpoint, size, hash, package/version and installed signing certificate before opening Android installation. Cancellation invalidates in-flight downloads; stale confirmation dialogs cannot install or discard a newer download or act after unmount.

Verification: TypeScript, authenticated download-route tests, isolated browser workspace/profile tests and stale-dialog regression test pass. Release APK/AAB and lint pass. Artifact and emulator checks are recorded below.

Artifacts: `/home/ben/Boardly-builds/2026-09-27/`. Logs and hashes accompany the build. Native build outputs, credentials and signing files are excluded from Git.

Published GitHub release: https://github.com/bensblueprints/boardly-kanban-mvp/releases/tag/android-v1.0.1 . APK, AAB, SHA256SUMS and artifacts.json are attached; uploaded APK/AAB digests match the verified local artifacts. Release tag points to `8d2e2698ff9e7579c0632851654000568c72a47b`. This publication does not replace production customer download metadata. The modified web profile bridge also requires deployment before its new profile action is exposed in the hosted workspace. Customer sign-in and the complete authenticated updater flow on this exact build still require end-to-end verification before claiming the complete app release. Physical Pixel was not connected during this build.

## Artifact verification

- `Boardly-Android-1.0.1.apk` — 57043652 bytes; SHA-256 `88a16a99a5da16c4f680685d1b7c2156dca1b6a308146474a73caa969afc0cd2`.
- `Boardly-Google-Play-1.0.1.aab` — 42231454 bytes; SHA-256 `0ec4e4818f8554a7cb4736613f2f83972dd4107f337ed504a8df1799cfe91ede`.

APK v2 signing verified with existing certificate SHA-256 `90f2177366540e63368e107888bb57e2b541d24b6d5254e37185c15c838cf1c4`. 16 KB ZIP alignment passes; embedded JavaScript is present and private signing-password scan passes. Signed install over customer 1.0.0 on isolated API 36 emulator succeeded without uninstalling. PackageManager confirms 1.0.1/code 2 and no DEBUGGABLE flag; launch renders the welcome screen. The emulator was signed out, so session-preservation and authenticated actions are not claimed tested.
