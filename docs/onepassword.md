# 1Password logins for ComputerUse

Open your profile menu → Settings → 1Password.

1. Create an **Automation** vault in 1Password and add only the login items your agents need. Create a service account with read permission for that vault. Built-in Personal/Private/Employee vaults cannot be used by service accounts.
2. Paste the service account token into Boardly's password field and connect. Do not paste your master password, recovery information or token into a chat.
3. Choose a vault and login with **Choose a login from 1Password**, then review its name and actual HTTPS sign-in URL. For a custom item, you can instead add an approved login manually: its display name, complete HTTPS login URL, password field reference, and optional username field reference. Use `op://<vault ID>/<item ID>/<field ID>` references. The username and password must be in the same item. IDs prevent a renamed or duplicated title from silently selecting another item.
4. Open Company settings → 1Password, select permitted logins and **Save login access**. Projects inherit these grants. Project settings can add project-only grants. Revoke an inherited grant at the company level, or move the grant to individual projects.
5. Assign a ComputerUse desktop to the company/project and enable agent control. Members also need Computer use permission.
6. In a Work request, ask the agent to use the approved login. It opens a separate login browser, observes the page, and fills the visible username/password stages. It can then continue the requested workflow. For MFA, CAPTCHA or additional approval, choose **Take control** on the desktop, finish the step, then return control to the agent.

For the Codex worker, the existing ComputerUse client exports:

```js
await computer.logins({ desktop_id }); // approved IDs, names and website origins
await computer.login({ desktop_id, login_id, mode: 'open' });
// Observe the page; navigate to the login form if needed.
await computer.login({ desktop_id, login_id, mode: 'fill', field: 'username' });
// If the site has a separate password stage, navigate to it and observe first.
await computer.login({ desktop_id, login_id, mode: 'fill', field: 'password' });
```

Hosted API agents have equivalent `computer_logins` and `computer_login` tools. Neither interface returns credential values. The fill command does not submit a form. Normal computer actions continue the task under the user's authorization.

## Access and storage

The service account token is encrypted on the Boardly server. Login references, exact approved website, grants and an audit of requested/completed/failed actions are stored. Password values are fetched when needed, passed in memory over the private desktop connection, and excluded from agent results, chat activity, operation records and service logs. The ComputerUse operation fingerprint is keyed rather than a guessable password hash.

Fill requires the approved HTTPS origin, one focused browser tab and one visible field in the main frame. It rejects cross-origin form actions, hidden fields, ambiguous fields and password fields switched to visible text. Embedded third-party login frames and unusual custom inputs may require human takeover. Configure the actual sign-in origin, such as `accounts.google.com`, instead of a site's marketing domain. Only grant origins you trust.

A logged-in desktop has access to that website account. Website cookies and sessions can persist in the desktop's dedicated browser profile until logout, expiry or desktop reset. Disconnecting 1Password prevents future lookup; **it does not log out existing website sessions**. Use the website's session revocation when access must end immediately. The integration cannot protect a password from malware, arbitrary programs running in the guest, or the approved website itself. Restrict desktop access and use accounts with appropriate permissions.

New guest images need `login-browser.py`, the updated guest agent/protocol, Python's `websocket` package, and a write exception for only the dedicated login-browser profile. Existing desktops receive this as a service update; they do not need to be erased or re-enrolled.

References: [1Password SDK](https://developer.1password.com/docs/sdks/), [service account setup](https://developer.1password.com/docs/service-accounts/get-started/).
