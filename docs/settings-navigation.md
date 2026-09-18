# Boardly settings and connections

The profile icon at the top right opens Settings, Connectors, Billing & usage,
Apps & devices, Help & tutorial and Sign out. The menu supports keyboard arrows,
Home, End and Escape. Settings use normal routes, so browser Back and refresh work
without signing out. On phones, use the Settings section picker or search.

## Where to configure something

| What you need | Where to start | What receives access |
| --- | --- | --- |
| Profile photo, name, email, sign-in security | Profile menu → Settings → Profile & preferences → Manage profile & security | Your Clerk identity |
| Activity animation | Profile & preferences | This browser |
| ChatGPT, OpenAI API key, model, spending cap | Account settings → AI & models | Your own companies; an invited member uses the sponsoring owner's funding for shared work |
| Workspace plan, seats, invoices | Account settings → Billing & usage | The workspace subscription; separate from ChatGPT and agent purchase cards |
| GitHub account token | Account settings → GitHub | Reusable credential; select repositories in company or project settings |
| Repository and branch | Company or project settings → GitHub | Projects inherit the company repository unless they set their own |
| ComputerUse API | Companies home or Account settings → ComputerUse | Account inventory; connecting alone does not assign desktops |
| Computer assignment | Company home or Company settings → ComputerUse | Projects inherit; Project settings can override or disable computer use |
| SSH computer/server | Account, company or project settings → SSH computers & servers | Account connections are inherited by all companies; company connections by their projects; project connections stay local |
| Tailscale | Account settings → Tailscale | Network reachability; add SSH credentials and allow Work access separately |
| IMAP mailbox | Company settings → Company email | That company's projects, with explicit agent permission; reads inboxes, does not send campaigns |
| Environment variables/API secrets | Project settings → Environment & secrets | Only that project |
| Agent purchase card and limits | Project settings → Agent purchase cards | Only that project; separate from Boardly subscription billing |
| External AI client | Account settings → Developer & MCP | Account-scoped revocable key; currently restricted by the server to the platform owner |
| Desktop app and sync | Account settings → Apps & devices | Download apps; cloud sync keys currently restricted to the platform owner |
| Company/project members | Its Settings → Team & permissions | Company access is inherited; project-only membership stays limited |

The connector catalog shows saved configuration from the API. “Token saved” or
“API key saved” is not an uptime or authentication guarantee. Use the detail page's
connection test where offered. Errors remain visible and the catalog has a refresh
control. Search by provider, device or purpose. Email, secrets and purchase cards
in the account catalog guide you to the company or project that should own them.

## Organization and everyday work

Companies contain boards; boards group projects; projects hold tasks, chats and
files. Companies home retains ComputerUse inventory and the company activity
overview. Company home retains its computer selector and board/team chat access.
Project toolbars keep AI actions, Files, Links and Computer use, plus Connectors
and Settings. Account tools no longer occupy a second toolbar.

Company and project Settings → General provides names and management controls;
Project General also has description and JSON export. Destructive controls are
inside a labeled Danger zone and retain explicit confirmation. Moving boards or
projects is an expandable action in their containing view. Import is under account
Import & export. The guided tutorial and its downloadable copy use the new paths.

## Access and routing

- Account settings: `#/settings/profile`, `ai`, `billing`, `connectors`, `github`,
  `computeruse`, `ssh`, `tailscale`, `apps`, `mcp`, `data`, `help`.
- Company settings: `#/company/<id>/settings/<section>`.
- Project settings: `#/board/<id>/settings/<section>`.
- Company/project sections: `general`, `members`, `connectors`, `github`, `ssh`,
  `computeruse`; `emails` is company-only; `environment` and `payments` are project-only.
- `#/account` remains a compatibility entry into account settings.
- Existing `boardly-account` events open the corresponding new route and preserve
  a return link to the prior company/project view within the current app session.

UI visibility follows current owner/member scopes; server authorization remains
authoritative. Revoking a scope removes its open settings content after the
existing permission refresh. Navigating through settings does not replace keys,
change computer assignments, alter members or start a purchase.

## Validation

`node test/settings-navigation-browser.cjs` covers keyboard focus, profile callback,
preferences, search, deep links, Back/reload, connector discovery, company/project
saves, member controls, ComputerUse inheritance, GitHub account handoff, SSH setup,
AI/billing/apps/MCP and mobile layouts with isolated fixture identities. It also
checks restricted deep links and live member scope revocation. Existing ComputerUse,
SSH, GitHub, onboarding and membership browser regressions cover their complete
flows. Production verification compares published assets and checks data integrity.

Profile and security use Clerk's existing `useUser`/`useClerk().openUserProfile()`
integration; see [Clerk's React hook reference](https://clerk.com/docs/react/reference/hooks/use-clerk).
