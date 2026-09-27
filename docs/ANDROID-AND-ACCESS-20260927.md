# Android distribution and account access — 2026-09-27

The homepage links to `/download/android`. The existing Clerk sign-in flow protects this page. Signed-in customers can retrieve release metadata and an APK through `/api/mobile/android/release` and `/api/mobile/android/apk`. Anonymous requests are rejected; MCP credentials cannot download the app. The server reads an administrator-provisioned `/data/android-release/release.json`, alongside the release APK, with fields `version`, `version_code`, `file` (Boardly-N.N.N.apk), `size`, and `sha256`. Never put credentials in this manifest. An absent/invalid release is explicitly unavailable, not replaced by the owner-only voice companion APK.

**Android customer APK is not ready.** Existing Android source remains an owner-paired voice companion. The next release must add full workspace access, per-customer Clerk sign-in and a visible authenticated Download update action before customer distribution. Native Clerk standard/custom flow choice is awaiting Ben. The Pixel is not connected to ADB; do not claim the release is installed. Preserve the existing signing key so upgrades keep pairing/data.

GitHub settings now include an access review for a repository, username and permission. A preview verifies the connected account's repository administrator access and current recipient permissions. The human account owner confirms an unexpired review using a Clerk session. MCP tokens cannot approve. A hosted Work agent can prepare `github_access_review` for its enabled project repository when the requester is the account owner. The result links to the review screen and does not grant access. Existing voice-created Work tasks can use this agent tool. Direct native voice review and recipient acceptance are not claimed tested.

Confirmations are claimed durably before the provider write. Successful GitHub invitations are reported as awaiting recipient acceptance; 204 is reported as access updated. Changed credentials/access require a fresh review. Unknown write outcomes remain needs_review and are not retried automatically. No real invitation has been sent in verification.

The Hugging Face connector verifies a personal access token with `/api/whoami-v2`, encrypts it within the owner workspace, and shows account/organization metadata. It supports refresh/disconnect. Automated member changes and invitations are **not implemented**: ordinary invitations, paid-plan role changes, and Enterprise/SSO SCIM provisioning have different requirements. The organization and plan have been requested from Ben. Do not use a role update to invite a non-member; do not clear a member's existing resource-group grants accidentally. The current UI links to official member settings and explicitly says automated invitations are unavailable.

Tests: android-download.js, github-access.js, huggingface.js, account-github.js, ai-providers.js, github-workers.js, settings-navigation-browser.cjs, openwebui-browser.cjs, and the Vite production build. Tests use isolated accounts/provider fixtures and send no external invitations.

Rollback: revert only the app image to `boardly-cloud:openwebui-798c2dd`; keep newer data. Existing provider connection remains usable. Do not restart worker/tunnel/voice services for this app-only change.

## Play Store preparation

Keep a separate Play distribution variant: use Android App Bundle and Play-managed updates instead of the direct-APK self-updater. Google Play restricts REQUEST_INSTALL_PACKAGES self-updates. Review the app's microphone foreground service, exact alarm and full-screen incoming-call declarations against its actual core functionality. Prepare the privacy policy, Data Safety disclosures for audio/transcripts/provider processing, account-deletion flow, content rating, store graphics, support contact and reviewer sign-in instructions. Preserve signing/update continuity and verify 16 KB page alignment. Play Console access/account type and release approval remain needed before submission.

New personal developer accounts created after 13 November 2023 may require 12 closed-test users continuously opted in for 14 days before applying for production access. This is a calendar requirement, not something a build check can satisfy. No Play Store submission or approval is claimed.

Official release and policy references (checked 2026-09-27):
- https://support.google.com/googleplay/android-developer/answer/9859348
- https://support.google.com/googleplay/android-developer/answer/14151465
- https://support.google.com/googleplay/android-developer/answer/16558241
- https://support.google.com/googleplay/android-developer/answer/13392821
