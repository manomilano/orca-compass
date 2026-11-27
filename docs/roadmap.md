---
description: Review existing areas for future work and the limits of discovery, routing, and Orca integration.
---

# Roadmap and limitations

Review known limitations and areas for future work before relying on a route.
For current routing behavior and supported agents, see [How it works](how-it-works.md),
[Tiers and routing](tiers-and-routing.md), and [Orca agents](orca-agents.md).

## Areas for future work

- Replace Muse's built-in model list once Muse or Orca lists Muse models, and
  consider adapters for additional agents and orchestrators.
- Replace the experimental read of Orca's internal agent-switch store with a
  supported interface.
- Include OpenCode's existing-worktree requirement in launch arguments.
- Evaluate effort choices across tasks and models, and warn about unknown
  configuration keys that may be typos.

## Known limitations

- **Live coverage is incomplete.** Discovery and launches have mainly been
  checked on Windows; coverage across agents and macOS/Linux is incomplete.
  Orca may reject effort levels from a different model catalog.
- **Reservation buffers are heuristics.** Each routed worker reserves a fixed number of percentage points per quota, by cost tier and effort. The defaults are starting values, not measured token costs, and need calibrating against real usage; `reservations` lets you change them per provider, plan and window.
- **Usage is only as fresh as Orca's.** Orca refreshes usage while its window is in use and never on request, so a snapshot can be old. OrcaCompass says how old it is and holds reservations until a fresh one arrives; it cannot make Orca refresh.
- **Usage mapping is inferred.** Cursor model buckets and Antigravity quota
  groups are matched by model or group name; changes can make usage unknown or
  assign a model to the wrong pool. Cursor Auto's underlying model is opaque.
- **Discovery is an estimate.** A listed model can still be refused. Use
  [launch verification](verify-and-rejections.md) to detect known refusal
  wording and handle failures.
- **Orca integration has limits.** Agent switches come from an internal store;
  unexpected formats leave them unknown. Reading the database needs
  `node:sqlite`; use Node.js 24 or Node.js 22.13+ without extra flags.
  OrcaCompass calls the literal `orca` command for usage and verification;
  it does not select `orca-dev` or honor `ORCA_CLI_COMMAND`.
- **Folder trust is not checked.** Grok can stop at a trust prompt; OpenCode
  has no auto-trust in Orca, and whether it prompts is unchecked.
- **Privacy filtering is partial.** `excludeNoZdr` relies on Cursor's `NO ZDR`
  labels and does not verify every provider's retention policy.
- **Unknown config keys are ignored.** Check spelling when an option has no
  effect; see [Configuration](configuration.md).
