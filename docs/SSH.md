# SSH connections

Account & AI → SSH across your companies is the owner's shared server library. Enable “Allow Work agents in all my companies” on a connection to make it available in every current and future company/project in that owner's workspace. Company → SSH and Project → SSH show inherited shared connections. These records survive reloads, chats and restarts. Credentials are encrypted in the workspace database and never returned by settings or included in chat metadata.

Company → Members → Permission scopes has “SSH across all my companies”. Only the owner can change it. It applies to that member's existing and future company/project grants under the same owner, without granting access to additional companies or projects. Project guests remain project guests. Individual SSH scopes continue to work independently; turning off the shared permission does not remove separately enabled scopes. Removing a member's final access grant also removes their shared permission. Changes are audited. Owner-wide permission defaults off for every existing member.

Members with SSH permission can manage connections within their authorized company/project and use enabled shared servers in Work. Only the owner can change the shared library. All tools continue to check current membership and connection permission, including during a command. Owner funding does not change this boundary.

Shared connections can route through another owner SSH connection as a jump host (up to four hops). Every hop authenticates against its pinned host fingerprint. Work requires each hop to be enabled and aborts if a hop changes or is revoked. Cycles are rejected. Tailscale device connections use the saved account's scoped network transport; a Tailscale server can also act as the first jump host.

Edit connection preserves saved credentials when fields are blank. A profile imported without a trusted fingerprint remains disabled and cannot authenticate until the owner supplies a verified fingerprint. Connection tests authenticate without running a remote command. Offline devices and invalid remote logins remain visible so their settings can be repaired.

Storage adds a separate owner_ssh_connections table; scoped SSH rows and their encryption binding remain unchanged. The account_members.owner_ssh field defaults to zero. The prior company-team app ignores these additions and uses explicit column inserts, allowing rollback while preserving data. Older pre-scopes builds still require their documented membership compatibility fix.
