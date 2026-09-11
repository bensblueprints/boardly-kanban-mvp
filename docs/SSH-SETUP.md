# Connect your machine with a Boardly key

Open **Account & AI → SSH across your companies → Add SSH connection**. This saves the connection in your own account, where your companies and projects inherit it. Other Boardly accounts cannot access it. New account connections made with the guided flow are owner-only; sharing can be changed explicitly under Computer sharing & assignment.

1. Enter `username@hostname` (or `username@IP`), or select a connected Tailscale device and enter its SSH username. Port 22 and a connection name are filled automatically.
2. Click **Generate connection key**. Boardly creates a separate Ed25519 key for this connection and stores its private part encrypted. Copy the Linux/macOS or Windows command and run it on the destination machine as the named SSH user. SSH/Remote Login must already be enabled; Windows administrator logins require an elevated PowerShell window. The command preserves existing keys and prints the machine's host-key fingerprints.
3. Click **I've installed the key — check connection**. Compare the displayed fingerprint with the machine's console output, choose whether Work agents may use it, then click **Trust and connect**. Boardly verifies key authentication before it saves trust or enables agent access.

You may close setup and resume from **Finish key setup** without generating another key. A completed connection offers **Show public key** for reinstalling its public key. Removing a connection deletes Boardly's saved key and permissions; remove its matching public-key line from the machine's `authorized_keys` file if you also want to remove the remote entry.

**Use an existing key or password** keeps the manual setup available, including passphrases, trusted fingerprints and jump hosts. Those saved credentials remain masked.

A private machine must be online and reachable from Boardly, typically through the account's Tailscale connection. Connecting SSH enables remote commands and installed GPU software; it does not install graphics drivers or GPU applications.

## Implementation and verification

- Private generated keys use existing AES-256-GCM connection storage with account and connection identity as associated data. API responses expose only the public key and masked connection metadata.
- Discovery stops at the server host-key exchange without sending authentication. Explicit trust is bound to the exact saved connection revision, expires after ten minutes, and is pinned during the subsequent authentication. Failed authentication leaves the record paused and untrusted. Existing trusted machines cannot be silently repinned through setup.
- Setup routes enforce existing account/company/project and per-connection access checks, including live permission revalidation during network calls. New account keys default to owner-only. Company/project delegated setup still requires the SSH permission scope.
- The additive `ssh_setup` table stores public key and temporary discovery metadata. It contains no private keys. Deleting a connection or replacing a generated credential removes that metadata.
- `test/ssh-setup.js` checks real SSH signature authentication, pending/restarted setup, safe idempotent Linux installation, encryption, account/member boundaries, stale trust, failed authentication and company inheritance. `test/ssh-setup-browser.cjs` covers desktop/mobile setup, copying, OS selection, reload, trust and actual fixture authentication. Existing SSH, broker, member and management regressions remain applicable.

Public-key installation follows the [OpenSSH authorized keys format](https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT). Windows administrators use the [Windows OpenSSH administrators key file](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_keymanagement).
