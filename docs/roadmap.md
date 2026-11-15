# Roadmap and limitations

OrcaCompass discovers available models, builds evidence profiles, and recommends a
route using current usage and configuration. The coordinator classifies the
work and launches the worker. See [How it works](how-it-works.md),
[Tiers and routing](tiers-and-routing.md), and [Orca agents](orca-agents.md)
for current behavior and supported agents.

## Areas for future work

- Support Muse when a reliable model list is available, and consider adapters
  for additional agents and orchestrators.
- Replace the experimental read of Orca's internal agent-switch store with a
  supported interface.
- Include OpenCode's existing-worktree requirement in launch arguments.
- Evaluate effort choices across tasks and models, and warn about unknown
  configuration keys that may be typos.

## Known limitations

- **Live coverage is incomplete.** Discovery and launches have mainly been
  checked on Windows; coverage across agents and macOS/Linux is incomplete.
  Orca may reject effort levels from a different model catalog.
- **Hand-outs are estimates.** Recent routes adjust usage but do not reserve capacity; simultaneous calls can still select the same route.
- **Usage mapping is inferred.** Cursor model buckets and Antigravity quota
  groups are matched by model or group name; changes can make usage unknown or
  assign a model to the wrong pool. Cursor Auto's underlying model is opaque.
- **Discovery is an estimate.** A listed model can still be refused. Use
  [launch verification](verify-and-rejections.md) to detect known refusal
  wording and handle failures.
- **Orca integration has limits.** Agent switches come from an internal store;
  unexpected formats leave them unknown. Reading the database needs
  `node:sqlite`; use Node.js 24 or Node.js 22.13+ without extra flags.
  OrcaCompass calls the literal `orca` command.
- **Folder trust is not checked.** Grok can stop at a trust prompt; OpenCode
  has no auto-trust in Orca, and whether it prompts is unchecked.
- **Privacy filtering is partial.** `excludeNoZdr` relies on Cursor's `NO ZDR`
  labels and does not verify every provider's retention policy.
- **Unknown config keys are ignored.** Check spelling when an option has no
  effect; see [Configuration](configuration.md).
