# Models and agents

Models and providers change often:
run `orcacompass status` for what your own machine and subscriptions offer
right now. Available models vary by account and agent version.

## Agents

An agent is a coding CLI that Orca can launch as a worker. OrcaCompass only
considers agents whose CLI is installed, that are enabled in Orca, that Orca
does not report as `unavailable`, and that you have not switched off with
`orcacompass agents disable` or `agents only`, so the options differ per user.
`orcacompass agents` shows each agent's verdict and the reason.

| Agent | Orca agent ID | Executable | Model list comes from | Effort levels | Usage data from Orca | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | its cached account catalog, then Orca's catalog, then Anthropic families in the evidence snapshot | from the same source, else `low` to `max` | session, weekly, Fable weekly | Supported |
| Codex | `codex` | `codex` | `~/.codex/models_cache.json`, then Orca's model catalog, then the evidence snapshot (Codex ladder families only) | per model, from those files | session, weekly | Supported |
| Cursor | `cursor` | `cursor-agent` (also `%LOCALAPPDATA%\cursor-agent`) | `cursor-agent models` | encoded in the model ID (`…-high`) | monthly, plus the `Cursor Models` and `Other Models` buckets | Supported |
| Grok Build (xAI) | `grok` | `grok` (also `$GROK_HOME/bin`, `~/.grok/bin`) | `~/.grok/models_cache.json`, then `grok models` | per model from that cache; else `low` to `xhigh` (Grok 4.5 up to `high`) | weekly credits or monthly budget | Supported; verified on Windows |
| Antigravity (Google) | `antigravity` | `agy` (also `%LOCALAPPDATA%\agy\bin`, `~/.local/bin`) | `agy models` | `low` to `high` | weekly, and 5-hour when reported, per quota group | Supported; verified on Windows |
| OpenCode | `opencode` | `opencode` (also `~/.opencode/bin`) | `opencode models` | none (Orca passes no effort to OpenCode) | none: pay per use or local | Supported; last resort by default |
| Muse (Meta) | `muse` | `muse` | none (Orca has no Muse model list) | — | none | Detected only, never routed |

**OpenCode** lists every model it can reach: providers with an API key
(OpenRouter and others, pay per token), OpenCode's own models, and local
servers such as Ollama (this machine's resources). It has no usage window, so
its routes are low confidence and say how they are paid for (`runs on this
machine (ollama)`, `free model through openrouter`, `pay per use through
openrouter`). Because it costs money or local resources, it is in
`lastResortAgents` by default: routing first tries every other agent,
including a lower tier, and uses OpenCode only when nothing else can take the
job (or instead of waiting under `--no-downgrade`), with a warning. `--agent
opencode`, a preference for the tier (`orcacompass prefer daily opencode
[model]`) or `"lastResortAgents": []` makes it an ordinary agent; without usage
data it still ranks after agents that have it. OpenRouter's `~vendor/x-latest`
aliases are skipped, a model listed twice is kept from its cheapest source, and
a `-free` copy is rated as the model it copies. Local models usually have no
capability score: give them a tier with `tierOverrides` (for example
`"gemma4:12b": "light"`). Orca accepts `--model` for OpenCode only in an
existing worktree (`--worktree current` or a selector), not a new one.

Model lists are read when the placement table is built: every
`placementsTtlHours` (5 hours by default), on `orcacompass refresh`, or when
your tier settings change (see [Tiers and
routing](tiers-and-routing.md#when-placement-runs)). Cursor, Antigravity and
OpenCode lists come from live commands; Grok first reads its native model cache.
For live listings, the last good list is used only when the command fails;
a sign-in prompt skips the agent as `not signed in`.
Claude's list is the catalog Claude Code caches under
`~/.claude/cache/model-catalog` for your account, then Orca's catalog, then
the evidence snapshot. Model makers reachable today: Anthropic
and OpenAI (directly and through Cursor); Google, xAI, Meta, Moonshot, Zhipu,
and DeepSeek through Cursor; xAI through Grok Build; Google, Anthropic and
OpenAI through Antigravity; and Cursor's own Auto. Gemini models route through
Antigravity or Cursor; the Gemini CLI is not an agent here.

## How a model gets its profile

Benchmark evidence and class hints form coding, agentic and reasoning scores.
The highest axis band is the class; the lowest class that covers the job forms
the fit group. `orcacompass ranking` displays the profiles and evidence.
Cursor `auto` is only a fallback and has no profile. See
[Tiers and routing](tiers-and-routing.md#ranking) for the routing order.

Effort follows the job's effort demand (`--demand`); without it the requested
tier's default applies.

## Inspect available models

Run `orcacompass status` to see the models discovered for your installed agents,
their tiers, and any exclusions. Availability depends on your account, agent
version, and current provider catalog. Model IDs in this guide are examples,
not a guarantee of access.

Cursor maps Cursor-trained models (`cursor-` IDs), Composer and Auto to the
`Cursor Models` bucket, and other models to `Other Models`. This mapping is
inferred because Orca does not report it directly.

Antigravity keeps provider launch IDs while normalizing them for classification:
for example, `claude-opus-4-6-thinking` is classified as `claude-opus-4-6`.
Its Gemini and Claude/GPT quota groups are evaluated separately.

## Your preferences and bans

`orcacompass prefer <tier> <agent> [model]` stores a preferred route per tier
in `pins`. It must survive every exclusion (your agent choice, request flags,
Orca's switches, availability, bans) and be unblocked. When projected usage
exceeds `preferRiskLimit` (100% by default), the best unblocked alternative
with known usage within that limit is chosen. If every alternative is risky,
unavailable, blocked, or has unknown usage, the favorite is retained.
Projection is `used% / elapsed fraction`, with no extrapolation under 10%
into a window. The route explains a switch, for example `preferred codex
gpt-6.1-terra skipped: weekly on pace for 150% (limit 100%), resets in 2d`.
It also explains when an over-limit favorite is retained.

`orcacompass ban <model-or-family>` stores entries in `banModels`. An entry
matches a model's base ID, so `claude-opus-5-5` also covers Cursor's
`claude-opus-5-5-high`, or its catalog family, so `grok` covers Grok 4.5 to 4.7
but not Grok Build (`grok-build`). Banned models are never chosen or shown as
alternatives and are listed as `banned by you`.

## Models an agent refuses at launch

A listed model can still be one the account cannot use, and Orca starts the
worker anyway, reporting the requested model as effective. `orcacompass verify
--dispatch <id>` reads the new worker's terminal and recognizes each agent's
refusal (seen November 2026, with an unknown or unavailable model):

| Agent | In an Orca worker | Refusal |
| --- | --- | --- |
| Codex | idles at its prompt, no `worker_done` | `The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.` |
| Claude Code | idles at its prompt, no `worker_done` | `There's an issue with the selected model (gpt-6-terra). It may not exist or you may not have access to it.` |
| Cursor | `cursor-agent` exits 1; Orca fails the start after its 60 s readiness wait | `Cannot use this model: claude-opus-9-9. Available models: …` |
| Grok Build | exits 1 | `Couldn't set model 'grok-9-fake': Invalid params: "unknown model id".` |
| Antigravity | exits 1 | `invalid model selection (--model "gemini-9-fake" …): model gemini-9-fake is not recognized as a known model …` |

A refusal counts only on a line that names the model. Soft warnings that
still run the model (Codex's ``Model metadata for `x` not found``, Claude
Code's `doesn't recognize the model "x"`) do not count. A refused agent and
model is skipped for `rejectionTtlHours` (a week by default) and listed as
`refused by <agent> …`; `orcacompass rejected --clear` forgets them.

## Agents you enabled in Orca (experimental)

Orca keeps its agent switches (Settings → Agents) in
`settings.disabledTuiAgents`, a list of disabled agent IDs (empty means every
detected agent is enabled). No Orca command exposes it, so OrcaCompass reads it
read-only from the active profile's `profile-state.db`, or `orca-data.json` for
a profile without a database. A disabled agent is skipped with the reason
`not enabled in Orca`. If the setting cannot be read, or the field is missing or
not a list, it is reported as `unknown` and no agent is excluded for it.
