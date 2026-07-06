# Launch Strategy — Boardly

## Positioning
Freelancers and small teams who hate per-seat pricing. Trello's pricing model punishes exactly the people kanban helps most: a 6-person studio pays $360/year forever. Boardly's pitch is arithmetic: **$19 once vs $5/user/month — a 3-person team breaks even in 6 weeks.**

## Target communities (rules-aware angles)

| Community | Angle |
|---|---|
| r/selfhosted | "I built a self-hosted Trello replacement (SQLite, Docker, MIT)" — lead with the stack and docker-compose, not the price. They reward source-first posts; link GitHub, mention the paid installer only if asked. |
| r/opensource | MIT release announcement. Focus on full-fidelity JSON export as an anti-lock-in feature. No sales links in the post body. |
| r/Entrepreneur / r/smallbusiness | Cost-cutting story: "We cut $600/yr of SaaS with one $19 tool." Share the math, disclose you're the maker (required). |
| r/freelance | Workflow post: desktop-mode kanban for solo client work; VPS mode when a client wants visibility. Disclose maker status. |
| r/webdev / r/node | Show-off/tech post: Express + better-sqlite3 + React + dnd, dual Node/Electron ABI trick for better-sqlite3. Devs love the implementation detail. |
| Hacker News | Show HN (below). |
| Indie Hackers | Build-in-public: pricing experiment "one-time vs subscription" — IH loves pricing meta-discussion. |

## Show HN draft
**Title:** Show HN: Boardly – a self-hosted Trello replacement in Express + SQLite

I got tired of paying per-seat for kanban, so I built a self-hosted board: lists, drag & drop cards, checklists, labels, due dates, local attachments, comments, and activity logs. Single Node process, better-sqlite3 (one file = your whole workspace), React/Vite frontend.

Two deploy modes from the same code: an Electron desktop app that embeds the Express server on a random local port, or Docker on any cheap VPS. The interesting technical bit was shipping better-sqlite3 for both Node and Electron ABIs — the postinstall vendors both prebuilds and picks the right one at runtime.

Export is full-fidelity JSON (attachment bytes embedded, base64) and imports round-trip deep-equal — I wrote the smoke test to enforce it, because export features that silently drop data are the thing I hate most about SaaS lock-in.

MIT source. There's a $19 packaged installer for people who don't want to build it, which is the business-model experiment: pay once vs rent forever. Happy to answer anything about the stack or the model.

## SEO keywords (10)
1. self-hosted trello alternative
2. open source kanban board
3. trello alternative one-time payment
4. self hosted kanban docker
5. kanban board desktop app windows
6. trello without subscription
7. free kanban board self hosted
8. trello export alternative
9. project management no monthly fee
10. kanban app for freelancers

## AppSumo / PitchGround pitch
Boardly is the self-hosted Trello replacement for teams that are done with per-seat pricing. One $19 license replaces $5/user/month forever: unlimited boards, drag & drop cards, checklists with progress bars, labels, due dates, file attachments, comments, and activity history — running on the buyer's own hardware as a Windows desktop app or a Docker container on any $5 VPS. Data lives in a single SQLite file with one-click full-fidelity JSON export, so there is zero lock-in (not even to us). MIT-licensed source builds trust; the deal buys the polished 1-click installer and lifetime updates. LTV math for your audience: a 10-seat team saves $581 in year one alone.

## Pricing math
- Suggested price: **$19 one-time**
- Trello Standard: $5/user/month → a **single user** breaks even in **3.8 months**
- 3-person team: pays for itself in **6 weeks**
- 10-person team: **$600/year → Boardly saves $581 in year one**, $1,781 over three years
