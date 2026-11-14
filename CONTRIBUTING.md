# Contributing to OrcaCompass

Contributions that improve routing accuracy, discovery reliability, or the
coordinator experience are welcome. For bugs, include a minimal reproduction;
for larger changes, open an issue describing the problem and proposed behavior.
Report security issues privately through [SECURITY.md](SECURITY.md).

## Ways to contribute

- **Report a bug** with the command you ran, what you expected, and the relevant
  part of `orcacompass status --json` (remove paths and account details first).
- **Add or correct a model family** in the tier table, with the evidence for
  the tier (see below).
- **Add an agent adapter** so OrcaCompass can route to another agent CLI.
- **Improve the docs or the Skill** when something is unclear or out of date.

Small, focused pull requests are the easiest to review. For anything larger,
open an issue first so we can agree on the approach before you write code.

[New issues](https://github.com/manomilano/orca-compass/issues/new/choose) start
from a form for a bug report or a feature request
(`.github/ISSUE_TEMPLATE/`); blank issues are off. Questions go to the README
and the [user guide](docs/README.md) first. A new pull request opens with the
template in `.github/PULL_REQUEST_TEMPLATE.md`.

## What to expect

Issues and pull requests are reviewed on a best-effort basis; a friendly
reminder after a week or two of silence is welcome.

## Licensing

OrcaCompass is licensed under the [Apache License 2.0](LICENSE). By submitting a
contribution you agree that it is licensed under the same terms (section 5 of
the license); no separate contributor agreement is required. Preserve the
bundled data attributions in [NOTICE](NOTICE).

## Development setup

Use Node.js 24 and npm for development, matching CI. Node.js 20 is the minimum
for running the published CLI, not for running the development tools: Vitest 5
requires Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`.

```sh
git clone https://github.com/manomilano/orca-compass.git
cd orca-compass
npm install
npm test
npx tsc --noEmit
npm run build
npm run test:package
npm run test:install
npm run docs:build
```

`npm test` runs the Vitest suite once (`vitest run`); use `npx vitest` to
re-run tests on change. `npm install` runs the `prepare` script to compile
TypeScript. Use `npm link`
to try the CLI locally, or run `node dist/cli.js --help` after a build. Install
and sign in to agent CLIs only when testing live discovery; Orca must be running
for live usage. Unit tests use fixtures and injected dependencies.

The package smoke check packs the compiled CLI, installs it into a temporary
directory offline, and checks its executable, exit codes, bundled metadata and
Skill. Build first; the smoke check deliberately skips lifecycle scripts. It
does not contact Orca or agent accounts. SQLite integration tests create their
own temporary database; they never open your Orca profile.

After installer changes, build and run `npm run test:install`. It exercises
real npm/npx and `skills@1` in temporary profiles: fresh install, upgrade,
repeat install, downgrade refusal and a failed CLI update. A local registry
serves temporary test versions; nothing is published and your installed
CLI, Skills and settings are untouched. It downloads `skills@1` from npm
and prints the temporary folder containing the logs.
On Windows the outer test environment leaves telemetry and CI overrides unset
so the test exercises OrcaCompass's own workaround for the Skill installer's
shutdown crash. Only its Windows `skills` subprocesses disable telemetry.

`tests/skill.test.ts` keeps the Skill and the CLI in step: it runs every
`orcacompass` command written in `skills/orcacompass/SKILL.md`, checks every
flag the Skill names against `orcacompass --help`, and checks that the JSON
fields the Skill tells an agent to read are in the output. When you change a
command, a flag or an output field, change the Skill in the same pull request.

CI runs the suite, type check, build and package smoke check on Windows, macOS
and Linux with Node.js 24, and the installer check on the same three systems. A
separate job checks the compiled package on Node.js 20, the minimum supported
runtime. The user guide builds on Linux in CI. CI runs on every pull request,
including pull requests from forks, with read-only access and no secrets.

## Releases

Anyone can contribute; only the maintainer releases. A release is never a side
effect of merging or of pushing a tag.

1. A pull request raises `version` in `package.json` and `package-lock.json`,
   updates `tests/version.test.ts`, and adds a `## <version>` section to
   `CHANGELOG.md`. Releases raise the patch number (0.2.1, then 0.2.2); a
   minor or major step is the maintainer's decision.
2. After the merge, the maintainer runs the **Release** workflow on `main`
   (`gh workflow run release.yml --ref main`). It refuses a version that is
   already on npm or has no changelog section, then repeats every CI check,
   including the installer check, on all three systems.
3. The publish job waits for the maintainer's approval in the `npm`
   environment. It publishes to npm through trusted publishing (the
   repository stores no npm token), then creates the `v<version>` tag and the
   GitHub release from the changelog section.

Run it with `-f dry_run=true` to do everything except publish. Do not create
version tags by hand; the workflow creates them after a successful publish.

## User guide

For model-data updates, follow [Model data](docs/model-data.md). Review changes
to the two snapshots in `data/`, preserve source attribution, and run the tests.
A score-file update on public `main` reaches installed clients through refresh;
it does not require publishing a new npm package. The Models.dev fallback
snapshot reaches users with the next npm release; normal catalog refreshes
fetch Models.dev directly.

Edit the Markdown pages in `docs/`. `docs/README.md` is the guide's overview on
GitHub and is included by `docs/index.md` for the website, so its content has
one source. Add new pages to the sidebar in `docs/.vitepress/config.mts`.

```sh
npm run docs:dev       # edit and preview locally
npm run docs:build     # production build, including internal link checks
npm run docs:preview   # inspect the production build
```

VitePress is a development-only dependency. Its Vite override keeps the stable
VitePress release on the patched Vite 6 line; review the override when upgrading
VitePress. The CLI package contains no website build tools.

The hosted guide is published separately after merge: run the **Publish user
guide** workflow on `main` (or `gh workflow run pages.yml --ref main`). Pushing
documentation alone does not deploy the website.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/cli.ts`, `src/setup.ts`, `src/install.ts`, `src/verify.ts` | CLI commands, setup, installation, and launch verification |
| `src/placements/` | Agent discovery, metadata sources, and cached model tier placement |
| `src/routing/` | Usage and Orca settings, routing, effort, and rejection handling |
| `src/system/`, `src/types.ts`, `src/config.ts`, `src/paths.ts` | Process execution, shared types, configuration, and paths |
| `tests/` | Tests, synthetic fixtures, and helpers |
| `data/`, `scripts/` | Bundled metadata snapshots and maintenance scripts |
| `skills/orcacompass/`, `docs/` | Coordinator Skill and user guide |

## Add an agent adapter

1. Implement discovery in `src/placements/agents/`, following the existing
   adapters and injected dependencies. Return an `AgentDiscovery` from
   `src/types.ts`; handle unavailable executables, missing models, malformed
   output, and sign-in prompts without inventing availability. Use
   `listModels` for supported CLI model-listing commands.
2. Describe model IDs, supported efforts, launch representation, and usage
   pools. Register the agent in `src/placements/build.ts` and `AGENT_IDS` in
   `src/types.ts`. Map its usage in `src/routing/orca-usage.ts` when applicable.
3. Add synthetic fixtures and tests for discovery, routing, usage, effort, and
   launch arguments. Update the guide and Skill. Never include real account data.

## Add or correct model placement

The family and model-line tables are in `src/placements/tiers.ts`. Placement
also uses provider descriptions, scores, and overrides; see
[Tiers and routing](docs/tiers-and-routing.md). Check that discovery supplies
matching models, add classification and routing tests where appropriate, and
explain the evidence for the change in the PR. Review the score anchors when
changing a Claude or GPT family.

## Routing and score changes

Behavior changes must come with tests. Use deterministic synthetic inputs and
fixed times to show the previous failure and the intended route or score.
Cover affected boundaries: thresholds, stale/expired usage, ties, pins,
downgrades/upgrades, Cursor Auto, effort snapping, or missing score anchors.
Keep routing tests independent of live accounts and network responses.

When changing metadata parsing or snapshots, preserve source attribution and
offline fallback behavior. Do not commit real account output, credentials,
personal paths, or task content in fixtures, issues, or screenshots.

### Files served from `main`

Installed copies of OrcaCompass download some files straight from this
repository's `main` branch, so merging a change to them reaches every user at
once, including users who have not updated:

| File | Read by |
| --- | --- |
| `data/evidence-manifest.json`, `data/evidence-snapshot.json` | 0.2.2 and later |
| `data/modelindex-snapshot.json` (frozen) | 0.2.0 and 0.2.1 |

Do not delete, rename or change the format of these files. A new format gets a
new file name and a new release that reads it; keep the old file until old
releases have mostly gone. `tests/served-files.test.ts` fails when one is
missing or unreadable.

## Commits and pull requests

Use Conventional Commits with a short imperative subject, for example:

```text
feat: add an agent adapter
fix: preserve unknown usage confidence
docs: clarify tier overrides
```

Keep PRs focused. Explain the problem, resulting behavior, and validation;
include a concrete before/after example for routing changes.

## PR checklist

- [ ] The change has a clear scope and explanation.
- [ ] Routing, scoring, or discovery behavior changes have relevant tests.
- [ ] `npm test` passes.
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm run build` passes.
- [ ] `npm run test:package` passes after the build.
- [ ] `npm run test:install` passes after the build for installer changes.
- [ ] `npm run docs:build` passes for guide changes.
- [ ] README, configuration example, and Skill match any public behavior changes.
- [ ] Fixtures and diagnostics contain no credentials or personal/account data.
- [ ] Metadata attribution and the existing license are preserved.
- [ ] Files served from `main` (see above) stay present and readable by older releases.
