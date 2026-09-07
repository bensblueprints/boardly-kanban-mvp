# GitHub connections and production releases

Account owners can open a company or project and select **GitHub**. Save a GitHub repository URL, target branch and personal access token, then select **Test connection**. Use a fine-grained token restricted to that repository with Contents read/write permission; organization approval and branch protection still apply. GitHub OAuth sign-in is separate from repository access.

Projects inherit their company's connection. A project connection overrides it, including when that override is paused. Removing the project connection restores inheritance. Pausing, rotating or removing a connection takes effect on subsequent operations, including running jobs. Moving a project invalidates the old company's scope.

Tokens are encrypted with AES-256-GCM using the existing `project-secrets.key`. Keep a private backup of that key alongside the databases. Tokens are never included in normal UI responses or agent prompts. The server authenticates GitHub requests and checks tenant, project, connection revision and Work permission for each operation. Ask and Plan receive no repository action tools.

Work agents automatically check the configured repository and remote branch before starting. Both the hosted API worker and Codex worker can list and read source, push explicit file changes and verify a release SHA. Writes create Git objects and advance the branch without force pushing; they reject concurrent branch changes. Source changes must be tested before pushing. A blocked push (including branch protection) must be resolved before deployment.

The GitHub deployment tool checks that the tested SHA equals the current remote branch and then executes the configured command through an enabled scoped SSH connection. It exports `BOARDLY_RELEASE_SHA` and `BOARDLY_REPOSITORY`; the command must deploy that immutable SHA and verify the resulting service. For another authorized deployment mechanism, the agent must first use `verifyDeployment` with the exact tested SHA. Arbitrary shell or independent infrastructure cannot be globally gated by this helper.

Repository operations use GitHub's REST API. Each file is limited to 2 MB; one commit may contain up to 100 files and 4 MB. Regular source files and executable modes are supported. Credential paths and recognizable access tokens are rejected. Symlinks, submodules, Git LFS and a full local Git clone are not provided by these tools. Larger changes can use multiple verified commits. Tokens can expire or be revoked; persistent configuration does not guarantee perpetual access.

Codex integration: `scripts/project-github-client.cjs`, through a private per-job Unix socket broker. Hosted integration: `github_status`, `github_list_files`, `github_read_file`, `github_commit_files`, `github_verify_deployment`, `github_deploy`.

Verification: `npm run test:github` covers encryption, inheritance, concurrent updates, actual broker requests, worker execution, hosted tool loops, permission revocation and release gating with a GitHub-shaped fixture. It makes no writes to real repositories.

Reference: [GitHub fine-grained token permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens), [Git trees](https://docs.github.com/en/rest/git/trees).
