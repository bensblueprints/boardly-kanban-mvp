# Task 49 verification checkpoint

Base commit: b7b3cd73b12a25cf45eeaeff294feddc57b045d5 on release/production-20260910.

Implemented: visible cloud header download link; welcome/final onboarding download prompts; platform selection; Windows, Apple Silicon Mac and Linux installation guidance; explicit customer sync limitation; retained platform-owner legacy sync setup.

Passed: Vite production build, chatgpt-onboarding-browser.cjs, settings-navigation-browser.cjs, desktop-downloads-browser.cjs and git diff --check. Browser checks cover onboarding navigation, failed-save recovery, persistence, exact installer URLs, platform filters, owner/member behavior, keyboard navigation and 320/390/1440px layouts. Tests use isolated fixtures, not real customer sign-in.

All four published v1.9.0 installer files match GitHub sizes and SHA256 digests:

- Boardly-1.9.0-arm64.dmg: 109544173 bytes; afc4c749ad9da525b39702bab158f5acf5a7bf3aa9a45acd0247e1a41c45bce3
- Boardly-1.9.0.AppImage: 117166477 bytes; b116757f60ad999293d85a0ee67f313b2104b2cdec394a97f66953b5e3631801
- Boardly.Setup.1.9.0.exe: 89224777 bytes; 003b58d9355e7657f3f54675f88d935050f93f9cbd6fd628cdb524359f4b7130
- boardly_1.9.0_amd64.deb: 79860050 bytes; 12ab7866c6f6b16e02b04edeed6b49bad68739bb164477b6e9ce8d0ae7439977

Remaining acceptance: card 48 must supply customer desktop account linking and cloud sync before the real install/sign-in/sync walkthrough can pass. Current cloud sync endpoints remain platform-owner-only. Card 371 records strict Mac codesign failure; the fresh Mac SSH attempt returned Device is not in your Tailscale network. Byte verification does not establish native installation, Windows publisher signature, Mac signing or real cloud sync.

No physical Linux desktop interaction or rollback database access occurred. Project file 977 contains the verification checkpoint. Logs and installer inventory are preserved under /tmp/boardly-task49-lgz9lj_w/verification on the enabled Pop!_OS SSH host.

This is a pre-sync checkpoint: commit/push, remote SHA verification and production deployment were not yet confirmed when this record was authored. Task 49 remains unfinished.
