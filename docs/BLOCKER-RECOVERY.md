# Recovery before stopping

Work agents now review their first proposed blocker before ending the run. The
review asks them to inspect current state, use enabled alternatives, finish
independent work, and report evidence for a real dependency. It explicitly
preserves permission limits, human takeover, MFA, and uncertain external outcomes.
It does not automatically replay any tool or bypass an approval.

Hosted runs persist one review allowance per job in `chat_blocker_reviews`, so
server restarts cannot repeatedly trigger the review. Remaining calls in the
same provider response are deferred until the model reads the guidance. Native
workers perform one review per invocation and allow two checkpoint-format repair
turns. A repeat blocker or exhausted format repairs still stops with saved work.
Existing blocked jobs are not bulk resumed by this change. Historical blockers
and unrelated provider authentication failures remain separate.

Verification: `node test/premature-blockers.js`, `node test/cloud-api-agents.js`,
`node test/cloud-agents.js`, `node test/runtime-recovery.js`,
`node test/agent-guidance.js`, and `node test/chat-concurrency.js`.
These use deterministic provider fixtures and the actual runner paths; they do
not establish how frequently a real model will resolve a proposed blocker.

Deploy the three changed runtime files over the current app/worker images,
verify baseline hashes first, back up SQLite databases using the backup API, and
preserve other services. Rollback restores prior image references; the additive
review table can remain without discarding post-deployment data.
