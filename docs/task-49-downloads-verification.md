# Task 49 verification

Task 49 remains unfinished. Download discovery and installation guidance are deployed; customer account linking, sync and the native installation walkthrough remain open.

## Implemented and tested

Original base: b7b3cd73b12a25cf45eeaeff294feddc57b045d5. Tested application release: 5ed7f6f1da37520ea40772bc4fb018ba23c629b7 on release/production-20260910.

Implemented: visible cloud header download link; welcome/final onboarding download prompts; platform selection; Windows, Apple Silicon Mac and Linux installation guidance; explicit customer sync limitation; retained platform-owner legacy sync setup.

Passed: Vite production build, chatgpt-onboarding-browser.cjs, settings-navigation-browser.cjs, desktop-downloads-browser.cjs and git diff --check. Browser checks cover onboarding navigation, failed-save recovery, persistence, exact installer URLs, platform filters, owner/member behavior, keyboard navigation and 320/390/1440px layouts. Tests use isolated fixtures, not real customer sign-in. The exact-release checkout was clean and its production build passed.

## Published installer verification

All four published v1.9.0 installer files match GitHub sizes and SHA256 digests:

- Boardly-1.9.0-arm64.dmg: 109544173 bytes; afc4c749ad9da525b39702bab158f5acf5a7bf3aa9a45acd0247e1a41c45bce3
- Boardly-1.9.0.AppImage: 117166477 bytes; b116757f60ad999293d85a0ee67f313b2104b2cdec394a97f66953b5e3631801
- Boardly.Setup.1.9.0.exe: 89224777 bytes; 003b58d9355e7657f3f54675f88d935050f93f9cbd6fd628cdb524359f4b7130
- boardly_1.9.0_amd64.deb: 79860050 bytes; 12ab7866c6f6b16e02b04edeed6b49bad68739bb164477b6e9ce8d0ae7439977

## Production verification

Configured GitHub branch SHA was independently confirmed at 5ed7f6f1da37520ea40772bc4fb018ba23c629b7 after the source push. Running app image boardly-cloud:downloads-5ed7f6f is healthy with zero restarts. All 28 release-manifest files match inside the running container. All eight public assets match the release. Workstation checks independently returned HTTP 200 and matching hashes for all four app entry assets. Public /app and /healthz returned HTTP 200 from both machines.

An asset request using the default Python User-Agent returned HTTP 403; subsequent requests with a browser User-Agent succeeded. This does not establish the exact rejection cause. Workstation HTML includes an additional Cloudflare analytics script; its application asset references match the release.

Worker, ChatGPT, tailnet and tunnel container identities were preserved. The original assignment/job 595013b1-69f1-4fb6-93d0-298c1679f4e5 continued after app activation, as confirmed by subsequent tool execution and employee_team.

Activation records report 11 database backups at /opt/boardly-clerk/private-backups/before-task49-5ed7f6f-1790639407265418678. Release manifest and activation records are under /opt/boardly-clerk/task49-downloads-5ed7f6f. Previous app image: boardly-cloud:ordered-queue-b7b3cd7. Any rollback must preserve current data and unrelated services.

## Remaining acceptance and handoff

Evidence supports checklist items 185 (inventory/download locations) and 186 (visible platform-specific downloads and instructions). This document does not assert that checklist flags have been updated. Items 187 and 188 remain unfinished.

Card 48 must supply customer desktop account linking and cloud sync before the real install/sign-in/sync walkthrough can pass. Current cloud sync endpoints remain platform-owner-only; card 48 has no completed acceptance items. Card 371 records strict Mac codesign failure; this assignment's Mac SSH attempt returned Device is not in your Tailscale network. Byte verification does not establish native installation, Windows publisher signature, Mac signing or real cloud sync.

Next actions: complete and verify card 48 under its separate assignment; restore authorized Mac test access and resolve the recorded signing/notarization prerequisites; then resume task 49 for native install/sign-in/sync acceptance on supported test hosts. No security bypass is authorized or required by this report.

No physical Linux desktop interaction or rollback database access occurred. Project file 977 retains the earlier pre-deployment checkpoint. Logs and installer inventory are preserved under /tmp/boardly-task49-lgz9lj_w/verification on the enabled Pop!_OS SSH host; exact-release build evidence is under /tmp/task49-release-41i5x_f3. Deployment evidence was also sent to Morgan in confirmed team message 1000797d-b53c-4326-b02c-fd6291bff389.
