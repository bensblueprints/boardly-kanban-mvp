# ChatGPT recovery and ordered task processing

The connector previously classified any failed turn mentioning authentication
or a refresh token as a permanent sign-in error. This stranded saved Work jobs
even when the failure was temporary. It also used cached account metadata to
decide whether a new login was needed, which could prevent reconnecting after
credentials were rejected.

Temporary network failures now remain retryable. An authorization failure gets
one managed `account/read` refresh and one new proposal-generation attempt.
Concurrent failures share the refresh; no Boardly tools execute in the connector.
Confirmed rejected credentials are recorded privately against the credential
file digest so reconnect remains available after service restart. Successful
device login clears that state. No raw provider diagnostics or tokens are exposed.
The connector still uses one Codex app-server authentication manager per account.
See https://learn.chatgpt.com/docs/app-server for managed ChatGPT authentication.

Continuous processing must be explicitly configured by the workspace owner.
`PUT /api/boards/:boardId/employees` accepts `ordered: true` with the existing
`enabled` and `instruction` fields. Ordered boards form one account queue:
ascending board ID, list position, card position, then card ID. Only non-archived
To Do cards are eligible. One root assignment runs at a time; an existing active
run on an ordered board holds new dispatch. Waiting cards remain To Do. Completed
or blocked assignments allow the next card to start. Returning a terminal card
to To Do makes it eligible again. Existing unordered teams retain their behavior.
Ordinary enable/pause calls preserve the saved ordering preference.

Verification:

```
node test/chatgpt-recovery.cjs
node test/chatgpt.js
node test/platform-reliability.js
node test/ordered-todo-queue.cjs
node test/employee-manager.js
```

Deploy the two incremental Dockerfiles only against their named production
baselines. Back up current databases and compose configuration first, check
active work, and preserve other services. Roll back images without restoring old
databases over newer work. Before rolling back the app, pause ordered teams via
the API: the old app does not understand their ordering flag.
