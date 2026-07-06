# Product Hunt Launch — Boardly

## Name
Boardly

## Tagline (60 chars)
Self-hosted Trello alternative. Pay $19 once, never per seat.

## Description (260 chars)
Boardly is a self-hosted kanban board: drag & drop cards, checklists with progress bars, labels, due dates, attachments, comments, activity logs, and full JSON export. Runs as a desktop app or on a $5 VPS. $19 once — no per-user pricing, ever. MIT source.

## Full description
Trello's Standard plan is $5 per user per month. That's fine at 2 people and absurd at 12 — a small agency pays more per year for kanban cards than for their actual hosting.

Boardly is the whole workflow, self-hosted:

- Multiple boards with colors, emoji, and starred favorites
- Drag & drop lists and cards (order persists exactly)
- Cards with markdown descriptions, due dates + overdue highlighting
- Checklists with progress bars, colored board-scoped labels
- Local file attachments, comments, and a per-card + per-board activity log
- Filter by label or due date, full-text search, keyboard shortcuts (n = new card, / = search)
- One-click JSON export/import with full fidelity — attachments included
- Archive instead of delete, restore anytime

Two ways to run it: as a Windows desktop app (Electron, double-click and go), or on any $5 VPS with Docker when your team needs it shared. Same code, same SQLite file.

The source is MIT on GitHub. The $19 one-time buys you the packaged 1-click installer and my gratitude.

## Maker first comment
Hey PH 👋

I built Boardly after doing per-seat math for a 9-person side project team: Trello wanted $540/year for what is, honestly, a list of lists. Next year: another $540. The year after that… you get it.

So I built the version I wanted to exist: a kanban board that lives on my own box. It does the things I actually use daily — drag & drop, checklists, labels, due dates, attachments, comments — and skips the enterprise stuff I never touched. Everything is a single SQLite file, and the JSON export is genuinely full-fidelity (it even embeds attachment bytes), so you're never locked in. Not even to me.

It's MIT on GitHub if you want to build from source. The $19 is for the 1-click installer if your time is worth more than the setup.

Honest limitations: it's single-password auth (it's YOUR server — share the password with your team), no real-time multiplayer sync yet, and no mobile app (the web UI works fine on a phone). Ask me anything!

## Gallery shots (5)
1. **Hero board** — dark board view with 4 colorful lists, cards showing labels, due-date chips, and checklist progress bars; board emoji + starred in header.
2. **Card modal** — open card with rendered markdown description, a 60% checklist progress bar, labels, attachment thumbnails, and a comment thread.
3. **Drag in motion** — card mid-drag between two lists (slight tilt), drop zone highlighted.
4. **Filter + search** — label filter dropdown open with colored labels, search box active showing filtered board.
5. **Pricing math graphic** — "Trello for 10 people over 3 years: $1,800. Boardly: $19. Once." with the two logos.
