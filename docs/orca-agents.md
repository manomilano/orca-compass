---
description: Compare the Orca compatibility reference with the adapters and launch arguments in this checkout.
---

# Orca agents and OrcaCompass support

Compare Orca's historical launch and trust behavior with OrcaCompass's
discovery, usage mapping and launch arguments in this checkout.

::: warning Historical Orca compatibility reference
The launch and trust table records an inspection dated 2026-11-03 with
Orca IDE 1.4.246. The Orca application source is not in this checkout, so
this checkout cannot independently verify these historical observations.
They are not a guarantee for newer versions. The adapter descriptions below
are backed by the OrcaCompass source.
:::

Every agent ID below can be named in
`orca orchestration worker-start --agent <id>`. The list comes from Orca's
built-in agent table (`resources/app.asar.unpacked/out/main/chunks/tui-agent-config-*.js`
in the Orca install).

Read the table as follows:

- **`--model` at launch**: from Orca's per-agent catalogs
  (`resources/app.asar.unpacked/out/shared/agent-session/options/agent-session-option-catalog-*.js`).
  ✅ Orca passes `--model` (and `--effort` where listed). ❌ Orca has a catalog
  but refuses `--model` at launch (`Agent <id> does not support launch-time model
  selection`). — no catalog. With ❌ or —, the agent runs the model from its
  own config.
- **Auto-trust**: Orca answers the agent's "trust this folder" prompt before
  launch (`preflightTrust`), or the launch command carries a trust flag.
  Without it, a worker in a folder the agent has not trusted can stop at that
  prompt; Orca then fails the start with `Agent startup blocked:
  agent-trust-workspace`.
- **OrcaCompass**: what OrcaCompass does with the agent today.

| Agent id | Command | `--model` at launch | Auto-trust | OrcaCompass |
|---|---|---|---|---|
| `claude` | `claude` | ✅ | ✅ | Supported: routed |
| `claude-agent-teams` | `orca claude-teams` (not on Windows or WSL) | not checked | ✅ | Not supported |
| `codex` | `codex` | ✅ | ✅ | Supported: routed |
| `cursor` | `cursor-agent` | ✅ (effort is part of the model id) | ✅ | Supported: routed; also carries xAI, Google, Meta and other models through Cursor |
| `antigravity` | `agy` | ✅ | ✅ | Basic support: routed without quota tracking on Orca 1.4.280+ (pending Orca/Antigravity update; see below) |
| `muse` | `muse --trust-workspace` | ✅ | ✅ (flag) | Orca accepts any `--model`; neither Muse nor Orca lists Muse models, so OrcaCompass routes a built-in list |
| `grok` | `grok` | ✅ (since 1.4.246; passed as `-m` / `--reasoning-effort`) | ❌ | Supported: routed. OrcaCompass reads Grok's models (`$GROK_HOME/models_cache.json`, default `~/.grok`, then `grok models`), tiers them and knows their effort limits. Orca does not auto-trust folders for Grok, so a worker in a folder Grok has not trusted stops at its trust prompt. xAI models also route through Cursor |
| `hermes` | `hermes --tui` | — | — | Not supported: Orca passes no model to Hermes |
| `gemini` | `gemini` | ❌ | — | Not an agent here: Gemini models route through Antigravity or Cursor |
| `codebuddy` | `codebuddy` / `cbc` | ✅ | — | Not supported yet (Orca side allows it) |
| `omp` | `omp` | ✅ (no effort) | — | Not supported yet (Orca side allows it) |
| `opencode` | `opencode` | ✅ (existing worktree only, no effort) | — | Supported: routed as a last resort by default (`lastResortAgents`). Models from a live `opencode models` call: API-key providers such as OpenRouter (pay per token), OpenCode's own models, and local servers such as Ollama. No effort is passed. Its routes need `--worktree current` or another existing worktree, because Orca refuses `--model` for OpenCode in a new one |
| `qoder` | `qodercli` / `qoder` | — | ✅ | Not supported |
| `qoder-cn` | `qoderclicn` / `qodercn` | — | ✅ | Not supported |
| `kimi` | `kimi` / `kimi-code` | — | ✅ | Not supported |
| `copilot` | `copilot` | — | ✅ | Not supported |
| `command-code` | `command-code --trust` | — | ✅ (flag) | Not supported |
| `opencode2` | `opencode2 --standalone` | — | — | Not supported |
| `openclaude` | `openclaude` | — | — | Not supported |
| `autohand` | `autohand` | — | — | Not supported |
| `ante` | `ante` | — | — | Not supported |
| `trae` | `traecli` | — | — | Not supported |
| `mimo-code` | `mimo` | — | — | Not supported |
| `pi` | `pi` | — | — | Not supported |
| `prime-agent` | `prime-agent` | — | — | Not supported |
| `aider` | `aider` | — | — | Not supported |
| `goose` | `goose` | — | — | Not supported |
| `amp` | `amp` | — | — | Not supported |
| `kilo` | `kilo` | — | — | Not supported |
| `kiro` | `kiro-cli chat --tui` | — | — | Not supported |
| `crush` | `crush` | — | — | Not supported |
| `aug` | `auggie` | — | — | Not supported |
| `cline` | `cline` | — | — | Not supported |
| `freebuff` | `freebuff` | — | — | Not supported |
| `codebuff` | `codebuff` | — | — | Not supported |
| `continue` | `cn` | — | — | Not supported |
| `droid` | `droid` | — | — | Not supported |
| `mistral-vibe` | `vibe` / `mistral-vibe` | — | — | Not supported |
| `qwen-code` | `qwen` | — | — | Not supported |
| `rovo` | `acli rovodev run` | — | — | Not supported |
| `openclaw` | `openclaw` | — | — | Not supported |
| `dsh` | `dsh-tui .` | — | — | Not supported |
| `zcode` | `zcode` | — | — | Not supported |
| `devin` | `devin` | — | — | Not supported |
| `jcode` | `jcode` | — | — | Not supported |

## How OrcaCompass handles each agent

Source: `src/routing/environment.ts` and `src/placements/agents/*.ts`, `src/routing/router.ts`,
`src/routing/rejection.ts`, `src/verify.ts`.

### Shared steps (every agent)

1. **Find the CLI** with `find(<binary>, extra dirs)`: adapter-specific
   folders first, then PATH and the additional Unix tool folders. Not found → `installed: false`, never routed.
2. **Read the model list** when the placement table is built (every
   `placementsTtlHours`, on `refresh`, or when the table is stale), never on a
   route that reuses a fresh table. For Claude Code and Codex, Orca's model
   catalog comes first (`src/placements/agents/orca-catalog.ts`): the newest
   probe in `agent-model-catalog.db` that found models for the agent, opened
   read-only once per build, then the `agent-model-catalog.json` older Orca
   versions wrote. OrcaCompass reads that catalog only for Claude Code and Codex. Live model-list commands run through
   `listModels` (`src/placements/agents/list-cache.ts`): a nonempty successful
   listing is saved to the OrcaCompass cache; if the command later fails or
   lists no model, the saved copy is used with its age ("using the list from 3h ago"). If no models were parsed, a sign-in
   prompt marks the agent `signedOut` and prevents fallback.
3. **Build each model's profile**: coding, agentic and reasoning scores from
   the evidence snapshot, and a cost tier from your `tierOverrides`, the
   snapshot price, the family or lineup hint, then the evidence class
   (`src/placements/profiles.ts`), stored in `placements.json`
   (`src/placements/build.ts`).
4. **Check usage in parallel with loading the table and agent switches** with `orca account list --json` (`src/routing/orca-usage.ts`):
   each model draws on named usage pools; a pool missing a finite usage percentage stays unknown (`null`), never read as 0% (a valid `0` stays `0`), and a missing reset time (`resetsAt` `0` or `null`) is kept as available with no reset time rather than skipped. A missing window length stays `null` (Antigravity grouped buckets need a positive `windowMinutes` to name each window). OpenCode has no usage entry: Orca's
   `rateLimits.opencodeGo` (the OpenCode Go subscription, which needs a cookie
   configured in Orca) is ignored for now, because which OpenCode models bill to
   it is not known yet; OpenCode routes say they have no usage window.
5. **Skip the agent** when it is turned off in Orca's Settings → Agents
   (`disabledTuiAgents`, read-only from Orca's profile state,
   `src/routing/orca-settings.ts`), when Orca reports it `unavailable`, or when
   it is signed out.
6. **Skip models the agent refused** at an earlier launch (`orcacompass verify`
   saves them for `rejectionTtlHours`).
7. **Build `launchArgs`** (`resolve` in `src/routing/router.ts`):
   - `flag` models: `--agent <id> --model <id> [--effort <e>]`, effort resolved
     to the requested level, otherwise the next higher offered level
     (`applied: flag`, or `provider-default` when none). A model with no level
     at or above a demanded effort is not eligible; only a tier default falls
     back to the nearest lower level.
   - `variant` models (effort inside the id): `--agent <id> --model <id-for-effort>`,
     no `--effort` (`applied: model-id`). Explicit `--effort` requests are never
     snapped: models that cannot apply that exact level are excluded.
8. **After launch**, `orcacompass verify --dispatch <id> --reservation <id>` reads the worker's
   output and matches the agent's own refusal text (below).

### Agent adapter reference {#per-agent}

| | Claude | Codex | Cursor | Antigravity | Grok | OpenCode | Muse |
|---|---|---|---|---|---|---|---|
| **Adapter** | `claude.ts` | `codex.ts` | `cursor.ts` | `antigravity.ts` | `grok.ts` | `opencode.ts` | `muse.ts` |
| **Finds** | `claude` on PATH | `codex` on PATH | `cursor-agent` on PATH or `%LOCALAPPDATA%\cursor-agent` | `agy` on PATH, `%LOCALAPPDATA%\agy\bin` or `~/.local/bin` | `grok` on PATH, `$GROK_HOME/bin` or `~/.grok/bin` | `opencode` on PATH or `~/.opencode/bin` | `muse` on PATH |
| **Model list** | Orca's `agent-model-catalog.db`, then Claude Code's cached account catalog, then Anthropic families in the evidence snapshot | Orca's `agent-model-catalog.db`, then `$CODEX_HOME/models_cache.json` (`visibility: list`), then the evidence snapshot's Codex ladder families without `-latest` aliases | `cursor-agent models`, live | `agy models`, live (`id<TAB>label` rows) | `$GROK_HOME/models_cache.json` (default `~/.grok`; hidden models dropped); else `grok models`, live | `opencode models`, live (`provider/model` rows; OpenRouter `~` aliases skipped) | Built-in: `muse-wonder-1.0`, `muse-spark-1.1`, `muse-ember-1.0`, `muse-spark-1.3` (`MUSE_FALLBACK_MODELS`) |
| **Grouping** | — | — | Variants grouped by base id: effort, `-thinking` and `-fast` are stripped; `cursor-` prefix and old `claude-4.6-sonnet` ids normalized | `-low/-medium/-high/-xhigh` ids grouped; `-thinking` dropped only when the plain ID is in the evidence index and the suffixed ID is not | — | A model listed by several providers kept once, from the cheapest (local, then free, then paid) | — |
| **Effort** | Orca's catalog levels + default, else the account catalog; on the evidence snapshot fallback, assumed `low` to `max` | Orca's catalog levels + default, else the Codex cache's; on the evidence snapshot fallback, assumed `low` to `max` | Inside the model id (`…-high`); the plain id stands for `medium`; fast-only levels dropped | Gemini: inside the id. Others: Orca's catalog efforts (else `low`/`medium`/`high`) via `--effort` | Grok cache levels + default (none for multi-agent models); from `grok models`: `low` to `xhigh`, capped as in Orca's seed (4.5 up to `high`) | None (Orca passes no effort to OpenCode) | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; default `high` |
| **`launchArgs`** | `--model --effort` | `--model --effort` | `--model <variant id>` | `--model <variant id>` (Gemini) or `--model --effort` | `--model --effort` | `--model <provider/model>` | `--model --effort` |
| **Usage pools** | `session`, `weekly`, `monthly` (a spend window Orca reports only for an account with neither of the other two), plus `fableWeekly` for Fable | `session`, `weekly` | `monthly` + `Cursor Models` or `Other Models` bucket (which models draw on which is inferred) | None on Orca 1.4.280+ (Orca retired the standalone Antigravity usage meter in `stablyai/orca#50137`, so usage stays `unknown`); on older Orca: per quota group (`Gemini Models`, `Claude and GPT models`), 5-hour, weekly, and any other reported window length, else `session`/`weekly` | `weekly`, `monthly` | None: pay per use or local; the route says how it is paid (`rateLimits.opencodeGo` is ignored for now) | `session`, `weekly` read from Orca's `muse` rate-limits entry when present (stays unknown while Orca reports no usage for Muse) |
| **Refusal `verify` matches** | `There's an issue with the selected model` (idles) | `model is not supported when using Codex…` (idles) | `Cannot use this model` (exits) | `invalid model selection` / `not recognized as a known model` (exits) | `Couldn't set model … unknown model id` (exits) | `Model unavailable` | — |
| **Special rule** | — | — | Cursor `auto` has no profile or cost tier: offered as an option, never routed on its own | — | — | Last resort by default (`lastResortAgents`); routes note that Orca needs an existing worktree | — |

### Where OrcaCompass and Orca disagree today

- **Grok:** Orca 1.4.245 refused `--model` for Grok workers; 1.4.246 accepts
  `--agent grok --model <id> --effort <e>` (stablyai/orca#36480) and still
  refuses effort levels above a model's ceiling (Grok 4.5 above `high`), which
  matches the ceilings in `grok.ts`. End-to-end validation remains incomplete.
- **Effort lists for Claude and Codex** come from their local catalogs, Orca's
  catalog, or the evidence snapshot fallback.
  Orca checks effort against its own catalog for models it knows (for example
  `gpt-5.5` up to `xhigh`) and refuses others. Whether the two lists always
  agree has not been checked.
- **OpenCode:** the worktree rule is only a note in `reasons`; `launchArgs` do
  not add `--worktree`, so the caller must pick `--worktree current` or an
  existing one.
- **Folder trust:** OrcaCompass does not check it. Orca handles it for Claude,
  Codex, Cursor and Antigravity (and Muse through its launch flag). Grok
  can stop at its trust prompt; OpenCode has no auto-trust in Orca,
  but whether it asks has not been checked.
