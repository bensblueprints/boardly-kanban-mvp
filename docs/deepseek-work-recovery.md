# DeepSeek Work recovery fix

October 1, 2026. Applies to the shared provider adapter for account, company,
Department and Board selections; no connection keys, model selections or
project permissions change.

The SuperC run stalled after successful GitHub/SSH tool activity. Its saved
checkpoint reproduced HTTP 400 from DeepSeek: an assistant tool-call message
was not followed by all corresponding tool results. Public checkpoints remove
opaque provider turns, so parallel calls must be reconstructed together.

Changes:

- Rebuild consecutive checkpoint calls as one assistant message with multiple
  tool calls. Defer screenshot user messages until every tool result is sent.
- Explicitly disable DeepSeek thinking for normal requests, as connection tests
  already did. The Work runner uses a 4,096-token response budget and checkpoints
  intentionally exclude private reasoning. This provides consistent test/Work
  behavior and permits durable recovery without retaining reasoning content.
  Other providers retain their existing settings.
- Treat output-limit, empty-answer and invalid-answer failures as non-retryable.
  Never execute a partial tool call from a truncated response. Genuine transient
  network/provider failures retain the existing retry policy.
- Retain provider token usage even when the response fails output validation.

Verification: new regression tests cover parallel checkpoint replay, screenshot
ordering, two company selections, incomplete responses and usage accounting.
Existing provider, company routing, runtime recovery and model-probe suites pass.
A read-only diagnostic replay of the affected saved context through the patched
adapter returned HTTP 200 with two tool calls in about five seconds; proposed
tools were not executed by the diagnostic.

Run `node test/deepseek-work-recovery.js`, `node test/ai-providers.js`,
`node test/company-ai.js`, `node test/runtime-recovery.js`, and
`node test/model-probe.js` in the supported server environment.

References: [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
and [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/).
