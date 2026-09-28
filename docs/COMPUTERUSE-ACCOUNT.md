# ComputerUse account and assignments — 10 September 2026

Connect once in Account & AI → ComputerUse account using an account:read API key from ComputerUse. The owner configures one connection for each Boardly account/workspace. Credentials are encrypted with AES-256-GCM and authenticated to the workspace and fixed provider origin; they are never exposed in API responses or agent prompts.

Company → Computers assigns multiple active rentals. Projects inherit the current company assignment unless they have an explicit override. Project → Computer use can select its own list, choose company inheritance or disable computers by saving an empty override. Sharing a rental shares its desktop and storage; use separate rentals for separate sessions. Replacing/disconnecting the account key clears assignments. Assignment never rents or charges for a computer.

A separate Computer use membership scope is off by default. The scope permits assignment and live rental inspection within the granted company/project. It does not reveal the owner API key. All provider operations recheck permissions and connection/assignment revisions after external I/O. Moving a project to another company changes inherited computers immediately; stale in-flight assignments are rejected.

The API-backed Work agent inspection tool verifies live active rental ownership. Screen actions and VM provisioning remain unavailable until the ComputerUse worker desktop controller is integrated. The native Codex worker has not been given this API inspection tool. No paid rental capacity is enabled by this release.

Public boardlyagent.com pricing adds 8 GB Standard at $24.99/30 days and 16 GB Creator at $39.99/30 days. These currently describe physical host tiers. With the proposed Proxmox migration, reserve host RAM and finalize honest guest RAM before activating checkout. Windows surcharge remains undecided and is not charged.

Validation: dedicated API fixture tests account encryption, multiple assignments, company inheritance, explicit disable, active ownership, member scope, cross-account isolation, permission revocation, disconnect races and company-move races. Existing membership/agent scopes, hosted agent execution and payment lifecycle/concurrency tests pass. Frontend production build passes. No production customer credentials or synthetic rentals were created.
