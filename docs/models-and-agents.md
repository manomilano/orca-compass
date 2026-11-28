---
description: Understand supported agents, model discovery, usage pools, preferences, and launch refusals.
---

# Models and agents

Use this page to understand model discovery, usage pools and preferences for
each supported agent. Run `orcacompass tiers` for your current discovered
models; availability varies by account and agent version.

## Agents

An agent is a coding CLI that Orca can launch as a worker. OrcaCompass considers
it only when its CLI is installed, Orca treats it as enabled and does not report
it as `unavailable`, and your `orcacompass agents disable` or `agents only`
settings allow it. The options therefore differ per user.
`orcacompass agents` shows each agent's verdict and the reason.

| Agent | Orca agent ID | Executable | Model list comes from | Effort levels | Usage data from Orca | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | Orca's model catalog, then its cached account catalog, then Anthropic families in the evidence snapshot | from the same source, else `low` to `max` | session, weekly, monthly (on monthly-only accounts), Fable weekly | Supported |
| Codex | `codex` | `codex` | Orca's model catalog, then `$CODEX_HOME/models_cache.json` (default `~/.codex`), then the evidence snapshot (Codex ladder families only) | per model, from those files | session, weekly | Supported |
| Cursor | `cursor` | `cursor-agent` (also `%LOCALAPPDATA%\cursor-agent`) | `cursor-agent models` | encoded in the model ID (`…-high`) | monthly, plus the `Cursor Models` and `Other Models` buckets | Supported |
| Grok Build (xAI) | `grok` | `grok` (also `$GROK_HOME/bin`, `~/.grok/bin`) | `$GROK_HOME/models_cache.json` (default `~/.grok`), then `grok models` | per model from that cache; else `low` to `xhigh` (Grok 4.5 up to `high`) | weekly credits or monthly budget | Supported |
| Antigravity (Google) | `antigravity` | `agy` (also `%LOCALAPPDATA%\agy\bin`, `~/.local/bin`) | `agy models` | `low` to `xhigh` per model (Gemini effort ids; Orca's catalog for the rest) | 5-hour, weekly, and any other reported window length per quota group | Supported |
| OpenCode | `opencode` | `opencode` (also `~/.opencode/bin`) | `opencode models` | none (Orca passes no effort to OpenCode) | none: pay per use or local | Supported; last resort by default |
| Muse (Meta) | `muse` | `muse` | built-in list: `muse-wonder-1.0`, `muse-spark-1.1`, `muse-ember-1.0`, `muse-spark-1.3` (neither Muse nor Orca lists Muse models) | `minimal` to `max`, default `high` (Orca's Muse menu) | session and weekly when Orca reports `muse` usage (otherwise unknown) | Supported; model ids not yet checked against a Muse account |

**OpenCode** lists every model it can reach: providers with an API key
(OpenRouter and others, pay per token), OpenCode's own models, and local
servers such as Ollama (this machine's resources). It has no usage window, so
its routes are low confidence and say how they are paid for (`runs on this
machine (ollama)`, `free model through openrouter`, `pay per use through
openrouter`). Because it costs money or local resources, it is in
`lastResortAgents` by default: routing first tries every other agent and uses
OpenCode only when no other agent can take the job (offering it as a `use`
option when another agent can still run at elevated risk, or handing back a
`decide` when only OpenCode is left and cannot run automatically), with a
warning. `--agent
opencode`, a preference for the tier (`orcacompass prefer daily opencode
[model]`) or `"lastResortAgents": []` makes it an ordinary agent; without usage
data it still ranks after agents that have it. OpenRouter's `~vendor/x-latest`
aliases are skipped, a model listed twice is kept from its cheapest source, and
a `-free` copy is rated as the model it copies. Local models usually have no
benchmark evidence, so they are unranked and skipped; to use one, name it in a
preference (`orcacompass prefer light opencode gemma4:12b`). `tierOverrides`
sets only a model's cost tier and cannot make it qualify. Orca accepts `--model` for OpenCode only in an
existing worktree (`--worktree current` or a selector), not a new one.

### Model discovery

OrcaCompass reads model lists when it builds the placement table: every
`placementsTtlHours` (5 hours by default), on `orcacompass refresh`, or when
your tier settings change (see [Tiers and
routing](tiers-and-routing.md#when-placement-runs)). Claude Code's and
Codex's lists come first from Orca's model catalog (`agent-model-catalog.db`
in Orca's data folder, `%APPDATA%\orca` on Windows): the models Orca's model
picker offers, with the efforts recorded for each. The legacy
`agent-model-catalog.json` is tried after the database and before agent caches. Orca saves Claude
Code's and Codex's model lists there, and Antigravity's effort menus (Antigravity's models still
come from `agy`); it lists the others live, as OrcaCompass does.

OrcaCompass opens the catalog read-only and needs `node:sqlite` (Node.js 22.13+ without
flags); without SQLite, the legacy JSON catalog can still be used. If neither Orca
catalog supplies models, the agent's own source below is tried. Database
read failures are included in discovery notes when no legacy catalog is used.

Cursor, Antigravity and OpenCode
use live commands; Grok first reads its native model cache.
For live listings, the last good list is used when the command fails or
succeeds without listing any model; a sign-in prompt instead skips the agent
as `not signed in`.

After Orca's catalog, Claude's list is the catalog Claude Code caches under
`$CLAUDE_CONFIG_DIR/cache/model-catalog` (default
`~/.claude/cache/model-catalog`), choosing the newest `fetchedAt` among
`*-cc.json` catalogs, then the evidence snapshot.

Live provider lists
determine which model makers Cursor, Antigravity and OpenCode expose. Gemini models route through
Antigravity or Cursor; the Gemini CLI is not an agent here.

## How a model gets its profile

Each model has two separate profiles:

- **Capability:** coding, agentic and reasoning scores from benchmark evidence.
  When an axis has no direct score, a usable hint can borrow the highest score
  from the same provider: either the same family or a model with a hint at or
  below the target hint tier. Ties use release date, then ID. A new Gemini
  release without a hint borrows the scores of the latest earlier release of
  its line. Without direct evidence or a usable inheritance candidate, that
  axis stays unranked.
- **Cost tier:** the first available tier from a user override, API price,
  family/model-line or provider-lineup hint, then evidence class (or the
  previous release's price for a Gemini release borrowing its scores).

The job's needs and effort select the eligible models, from every cost tier.
Their routes are [ranked](tiers-and-routing.md#ranking-covering-routes) by
[quota](tiers-and-routing.md#quota-reservations-and-risk): the bucket with the
most capacity left comes first, and in it the most economical route.
`orcacompass ranking` shows the evidence and `orcacompass tiers`
shows the cost tiers. Cursor `auto` has no profile and is only offered as an option.
See [How it works](how-it-works.md) for a worked example and
[Tiers and routing](tiers-and-routing.md#needs-and-ranking) for the full order.

Effort follows the job's effort demand (`--demand`); without it the requested
tier's default applies.

## Inspect available models

Run `orcacompass tiers` to see the models discovered for your installed agents
with their cost tiers, and `orcacompass ranking` for their evidence.
`orcacompass status` shows a model count per agent, the pick for each tier, and
banned, refused and unclassified models. Availability depends on your account, agent
version, and current provider catalog. Model IDs in this guide are examples,
not a guarantee of access.

Cursor maps Cursor-trained models (`cursor-` IDs), Composer, all normalized `grok` IDs, and Auto to the
`Cursor Models` bucket, and other models to `Other Models`. This mapping is
inferred because Orca does not report it directly.

Antigravity keeps provider launch IDs while normalizing them for classification:
for example, `claude-opus-4-6-thinking` is classified as `claude-opus-4-6`.
Its Gemini and Claude/GPT quota groups are evaluated separately.

## Your preferences and bans

`orcacompass prefer <tier> <agent> [model]` stores a favorite route per tier
in `pins`. It must pass every exclusion (your agent choice, request flags,
Orca's switches, availability, bans), and its quota must not be exhausted. A
favorite at its usage limit is skipped, and routing says so. See
[Preferences (pins)](tiers-and-routing.md#preferences-pins) for the
`preferRiskLimit` rules.

For example, a switch can appear as `preferred codex
gpt-6.1-terra skipped: weekly would be 90.5% used with this worker (limit 90%); resets in 2d`.

`orcacompass ban <model-or-family>` stores entries in `banModels`. An entry
matches a model's base ID, so `claude-opus-5-5` also covers Cursor's
`claude-opus-5-5-high`, or its catalog family, so `grok` covers Grok 4.5 to 4.7
but not Grok Build (`grok-build`). Banned models are never chosen or shown as
alternatives and are listed as `banned by you`.

## Models an agent refuses at launch

A listed model can still be unavailable to your account. Orca starts the
worker anyway and reports the requested model as effective. `orcacompass verify
--dispatch <id>` reads the new worker's terminal and recognizes each agent's
refusal (seen November 2026, with an unknown or unavailable model):

| Agent | In an Orca worker | Refusal |
| --- | --- | --- |
| Codex | idles at its prompt, no `worker_done` | `The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.` |
| Claude Code | idles at its prompt, no `worker_done` | `There's an issue with the selected model (gpt-6-terra). It may not exist or you may not have access to it.` |
| Cursor | `cursor-agent` exits 1; Orca fails the start after its 60 s readiness wait | `Cannot use this model: claude-opus-9-9. Available models: …` |
| Grok Build | exits 1 | `Couldn't set model 'grok-9-fake': Invalid params: "unknown model id".` |
| Antigravity | exits 1 | `invalid model selection (--model "gemini-9-fake" …): model gemini-9-fake is not recognized as a known model …` |
| OpenCode | prints error | `Error: Model unavailable: openrouter/fake/nonexistent-9` |

See [Verify and rejections](verify-and-rejections.md#refusal-phrases-recognized)
for matching rules and soft warnings that do not count as refusals. See
[What a rejection does](verify-and-rejections.md#what-a-rejection-does) for how
to clear saved refusals. Routing skips a refused agent and model for
`rejectionTtlHours` (a week by default) and lists it as `refused by <agent> …`.

## Agents you enabled in Orca (experimental)

Orca keeps its agent switches (Settings → Agents) in
`settings.disabledTuiAgents`, a list of disabled agent IDs (empty means every
detected agent is enabled). No Orca command exposes it, so OrcaCompass reads it
read-only from the active profile's `profile-state.db`, or `orca-data.json` for
a profile without a database. A disabled agent is skipped with the reason
`not enabled in Orca`. If the setting cannot be read, or the field is missing or
not a list, it is reported as `unknown` and no agent is excluded for it.
