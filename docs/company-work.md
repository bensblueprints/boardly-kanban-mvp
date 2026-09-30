# Build a company team from Company AI

Open a company, choose **Chat with AI / Agent swarm**, then **Work**. Describe the desired departments, Boards, tasks and work to carry out. An empty company can start here without creating Boards manually.

Company Work can inspect existing structure, create or reuse departments and Boards, add tasks, provision each Board's AI employee roster, and assign a requested task to its Manager. The Manager can call Engineer, Designer and Reviewer specialists using the existing employee delegation system. Company and Board AI settings still determine the provider/model used for each run. These are AI employee roles, not invitations or real-world hiring.

Ask and Plan remain read-only. A setup-only instruction creates structure without enabling continuous backlog execution. The existing Department Work interface still supports selecting specific Boards for a swarm. Company Work uses a conversation and does not require manually selecting Boards.

The chat shows saved creation counts, links to the relevant Boards, and assignment status. A queued job is not reported as finished work. Stopping a company reply stops that reply; already delegated Board assignments retain their separate stop controls.

## Implementation and limits

- `read_company_structure` and `build_company_structure` are only available in owner Company Work runs. Company identity is derived from the saved thread, not supplied by the model.
- Setup is additive and transactional. Exact names are reused within their parent; existing descriptions and task state are preserved. Ambiguous existing duplicates fail instead of guessing. One setup supports 12 departments, 30 Boards and 150 tasks.
- Stable company-scoped request keys protect setup retries across conversation turns. Reusing a key with different contents fails. Delegation uses the existing stable assignment keys and refuses cross-company targets or tasks outside the chosen Board.
- Every action rechecks the saved run status and owner. Other company/tenant data, member management, secrets, account connections and recurring automation are not added to this tool surface.
- Company Work uses the hosted tool loop, including the existing subscription bridge when that is the account's configured funding path. Ask/Plan retain their existing routing.
- The additive `company_work_changes` table records concrete setup results. Existing conversations, employee IDs and task data are preserved.

## Verification

`node test/company-work.js` tests an empty company through setup and Manager assignment, duplicate retries, conflicting requests, cross-company denial, company AI selection, setup-only behavior, Ask/Plan and member/tenant isolation. `node test/company-work-browser.cjs` exercises the real React interface at desktop/mobile sizes, creation receipts and Board navigation against a deterministic provider fixture. Existing company AI, employee Manager and member-scope tests cover the shared execution paths. Provider fixtures establish tool integration, not a guarantee that every model will choose a correct business plan.
