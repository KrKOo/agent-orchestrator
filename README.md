# Agent Orchestrator

Runs multi-step AI-agent **flows** (prompt → skill → command → slash command → shell command → git commit → push → PR, or pull request review → GitHub review — with loops such as review → fix until approved, and branches such as "fix only when the review asks for it") inside hardened Docker sandboxes, driven from a web UI with live token streaming.

- `packages/protocol` — flow schema + validation, templates, run events, runner wire protocol, REST types.
- `packages/server` — Hono API, SQLite (drizzle), scheduler, runner/browser WebSockets, GitHub (PAT or App: login, webhooks, Checks, reviews).
- `packages/runner` — connects out to the server, supervises `omp auth-broker`/`auth-gateway`, runs jobs: workspace (git worktree or PR checkout), Docker sandbox + squid egress proxy, `omp acp` over ACP, MCP output server, subagent transcript tail.
- `packages/web` — React UI (flow editor, run view, runners).
- `docker/` — sandbox (`orch/sandbox-omp`) and egress (`orch/egress`) images. `deploy/` — server image, compose + Caddy, runner systemd unit, example configs.

## Local setup (M1)

Requires Bun ≥ 1.4, Docker, and `omp` logged in (`omp login`).

```sh
bun install
bun run images                                   # builds orch/sandbox-omp + orch/egress
echo '{}' > orch.server.json                     # all defaults: 127.0.0.1:7800, ./data, auth none
bun packages/server/src/main.ts runner-token create --name laptop   # prints runnerId + token once
```

`~/.agent-orchestrator/runner.json` (override path with `ORCH_RUNNER_CONFIG`):

```json
{ "runnerId": "<from CLI>", "token": "<from CLI>", "allowedRoots": ["/Users/me/Documents"] }
```

Other runner fields (defaults): `serverUrl` (`ws://127.0.0.1:7800/runner/ws`), `labels`, `maxConcurrentJobs` (2), `acceptUntrusted` (false), `dataDir` (`~/.agent-orchestrator/runner`), `skillDirs`, `commandDirs` (`~/.omp/agent/*`, `~/.claude/*`), `ports` (`mcp` 7802, `broker` 7803, `gateway` 7804), `hostBind` (`127.0.0.1`; docker bridge IP on Linux), `dockerRuntime` (e.g. `runsc`), `git.authorName/authorEmail`.

```sh
bun run dev     # server :7800 (serves packages/web/dist), runner, vite :5173
bun test
```

Server config (`ORCH_SERVER_CONFIG`, default `./orch.server.json`; `bun run dev` uses the repo-root file): `bind`, `dataDir`, `publicUrl`, `auth` (`{mode:"none"}` | `{mode:"github", allowedLogins, sessionSecret}`), `github` (`null` | `{kind:"pat", token}` | `{kind:"app", appId, privateKeyPath, clientId, clientSecret, webhookSecret}`, plus optional `apiBaseUrl`, `webBaseUrl`, `maxConcurrentPerRepo`).

### Sandbox guarantees

- Per run: `--internal` Docker network; the only route out is a per-run squid proxy (`gateway_only` | `allowlist` | `open`).
- Run container: `--cap-drop ALL`, `no-new-privileges`, host uid. `$HOME` is a per-run Docker volume
  (`orch-home-<runId>`, removed with the sandbox and by the runner's startup cleanup); `/tmp` is tmpfs.
  `.git/hooks` and `.git/config` are mounted read-only over the repo.
- Model access goes through the host `omp auth-gateway`; the gateway bearer is the only secret in the sandbox.
- Flow models are picked from the gateway's model list (`/api/catalog`, advertised by online runners) in the
  flow editor; `harness.modelRoles` maps extra omp roles (`slow`, `plan`, `task`, …) to models, with `smol`
  (`smolModel`) and unset roles falling back to `model`.
- git commit/push run on the host. GitHub API calls run on the server. The agent never holds GitHub credentials.
- **Shell steps** run a templated command as `bash -c` in the sandbox at the workspace path. Template values
  reach the script as environment variables (`{{steps.<id>.output}}` is rewritten to `${ORCH_REF_n}` and the
  value is exported quoted), so untrusted text in them stays data and can never become shell code. Stdout is
  the step output (kept beyond 1 MB only as a truncation-marked prefix); stderr streams to the run log; a
  non-zero exit fails the step. Shell steps are allowed in pull request flows, but there they run in the PR
  author's checkout: anything the command executes from it (build scripts, tests, package installs) is
  untrusted code with the sandbox's network and gateway access. The flow editor warns about this.
- **Intervention steps** pause the run and open a chat under the step in the run view. Pick one of the run's
  sessions — the shared agent (ACP) session of prompt/skill/command steps, or the `omp -p` session of an
  earlier slash step (resumed with `--resume`) — and send any text, slash commands included; replies stream
  into the step's transcript. *Continue run* passes the selected session's latest reply on as
  `{{steps.<gate>.output}}`; later agent steps keep the chat in their context when they share the session.
  While it waits for you the run status is `awaiting_input` (it still holds its runner slot); it is `running` again
  while a reply is generated. Without a timeout the run waits until answered or cancelled.
- **Every step takes `timeoutSec`; `0` disables the timeout** — the step runs until it finishes or the run is
  cancelled (for intervention steps this is the same as leaving the field empty). The default is 1800 (30 min).
- **Run names** identify runs on the Runs page. Give one in the Run dialog (`name` on
  `POST /api/flows/<id>/runs`, ≤120 chars), or check **Generate the name with an agent** (`autoName`) and the
  runner that picks up the run asks the flow's model to name it from the flow and its inputs before step 1 —
  one headless `omp -p --no-session --no-tools` prompt, its first reply line (clamped to 120 chars) becomes the
  run's name; the first name reported wins. Naming never fails a run: if it times out (60s, enforced inside the
  sandbox) or errors the run proceeds unnamed until a later retry names it. The Runs page and
  run view also identify runs by their GitHub inputs — issue and PR links are derived from the resolved inputs,
  so a queued issue run is recognizable before it even starts.
- **Retrying a failed or cancelled run** picks up where it stopped — same run, same transcript, same step outputs. **Retry**
  (header button) re-runs the first step that did not succeed or get skipped by a loop or condition (the last step if all did) and continues to the end;
  **Run from here** (per step) resets that step and everything after it, keeping earlier outputs — use it to recover
  from bad upstream output without rerunning what worked. Retrying from a later step of a local-path flow runs on
  the runner that ran the previous attempt and adopts its worktree as left; if that runner stays offline, the run
  fails with `resume_runner_lost` (retry from step 1 instead). Retrying from step 1 resets the worktree to the base
  ref; PR-checkout runs always start from a fresh checkout of the PR head. Outputs of skipped steps come back as
  `{{steps.…}}`, and the event transcript continues in one view with continuous sequence numbers even across runner
  restarts. Agent steps resume in a fresh session (ACP has no conversation resume); the sandbox is recreated per
  attempt, so `$HOME` and `/tmp` are not carried over. A retried intervention lists the run's sessions
  again: slash sessions continue their earlier conversation, the agent session is a new one that starts from its
  last result.
  Runs that publish a check run get a fresh one for the new attempt.

### Sandbox tooling

`orch/sandbox-omp` (Debian trixie) ships most of what agents need offline:

- Build tools (gcc/g++, make, cmake, autotools, pkg-config, OpenSSL/zlib/libffi/SQLite headers), git + git-lfs,
  curl/wget, archive tools, ripgrep, fd, jq, yq, sqlite3, shellcheck.
- Runtimes pinned in `docker/sandbox-omp/mise.toml` and installed with `mise install --system` (read-only, any
  uid): Node.js LTS + corepack (pnpm/yarn), Bun, Python + uv, Go, cargo-binstall. Rust comes from rustup
  (minimal profile + clippy, rustfmt) in the read-only `/usr/local/rustup`. Bump a version by editing the pin and
  running `bun run images`; the build runs every tool as a non-root uid, behind the real entrypoint, and fails on
  a broken pin.

The agent adds tools into `$HOME` without root (`mise use -g <tool>@<ver>`, `uv tool install`, `npm i -g`,
`cargo binstall`, `go install`); their bin directories come first on `PATH`. rustup works unchanged: the entrypoint
seeds a writable `$RUSTUP_HOME` (`~/.rustup`) whose preinstalled toolchain symlinks the image's files, so a
`rust-toolchain.toml` channel, `rustup toolchain install`, `rustup target add` and `rustup component add` all land
in `$HOME` (downloads from `static.rust-lang.org`, part of the crates.io preset). The image puts a short guide saying so
in `~/.omp/agent/AGENTS.md`. `$HOME` is disk-backed so installs don't count against the run's memory limit; the
volume has no size quota, but it lives only as long as the run's sandbox.

Installing needs network: with the default `gateway_only` nothing outside the model gateway is reachable. In
`allowlist` mode the flow editor's registry buttons (npm, PyPI, crates.io, Go modules, GitHub releases, mise) add
the domains each registry downloads from (`NETWORK_PRESETS` in `packages/protocol/src/flow.ts`); the flow still
stores the plain domain list. In pull request flows that access extends to the PR's build and install scripts. The
mise `aqua:`/`github:` backends call `api.github.com` unauthenticated (60 requests/hour per IP).

There is no `apt` at runtime. For system packages, build a custom image and set it as the flow's `sandbox.image`:

```dockerfile
FROM orch/sandbox-omp:latest
RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev && rm -rf /var/lib/apt/lists/*
```

The run's `$HOME` volume starts as a copy of the image's `/home/agent`, so every sandbox image needs a
`/home/agent` that any uid can write (`orch/sandbox-omp` creates it with mode 1777, and images built `FROM` it
inherit it). After updating a runner to this version, rebuild the images with `bun run images`: older
`orch/sandbox-omp` builds have no `/home/agent` and fail at sandbox start, with the entrypoint's error in the run.
Custom images not built from `orch/sandbox-omp` need `RUN mkdir -m 1777 /home/agent`.

## Public control plane (M2)

See `deploy/`: `server.Dockerfile`, `compose.yml` (server + Caddy TLS, `ORCH_DOMAIN`), `orch.server.example.json`, `orch-runner.service`, and `runner*.example.json`. Runners connect outbound over `wss://<domain>/runner/ws`. Create owner-bound tokens with `runner-token create --name <n> --owner <login>` or from the Runners page.

## Pull request reviews (M3)

A pull request is a flow input, like a GitHub issue: declare one input of type `github_pull_request` and paste the
PR URL into the Run dialog (or `POST /api/flows/<id>/runs` with `{"inputs": {"pr": "https://github.com/owner/repo/pull/123"}}`).
Its fields are `{{inputs.<key>.url|repo|number|title|body|baseSha|headSha|diffPath}}`; `title` and `body` arrive wrapped in
`<untrusted_pr_text>`. A flow with a PR input:

- uses the `github_checkout` workspace (set automatically in the editor): the runner checks out the PR head on the host,
  mounts it read-only and writes the diff to `/orch/context/pr.diff`;
- runs untrusted, on runners with `acceptUntrusted: true`: approval `auto`, no `open` network, no git commit/push/PR steps;
  shell steps are allowed but run against the untrusted checkout (see Shell steps above).

**`github_comment` steps** work in any flow: they post the output of an earlier prompt/skill/command/slash/shell/intervention step
(`bodyFrom` accepts `"<stepId>"`, `"<stepId>.output"` or `"<stepId>.structured.<field>"`) as a comment on the issue or pull
request of a required `github_issue`/`github_pull_request` input (`target`).
The server posts it with its own credentials (mentions neutralized); the target comes from the run's resolved inputs, never
from the agent. The step's output is the comment URL.

Typical review flow: prompt (review `{{inputs.pr.diffPath}}`) → intervention (check and discuss the review) → prompt (write
the final review) → `github_comment` (`target: "pr"`, `bodyFrom` the final prompt). Leave out the last step to keep the
review in the run view.

To run on PR events too, add `trigger: {kind: "github_pull_request", repos: ["owner/name"]}`: each matching event fills the
PR input (other inputs must be optional and stay empty). Fork and first-time-contributor PRs follow `forkPolicy` — for
webhook events and manual starts alike (default `require_approval`; approve them from the run view; `skip` rejects a manual
start). Flows with a manual trigger have no policy. With `postChecks` (default `true`), runs of PR-triggered flows — webhook
or manual — publish a check run on the PR head with progress and finding annotations.

## Loops

A flow is a flat list of steps; a **`loop` step** ("Repeat from…") ends a loop body that starts at an earlier step `to`.
When the run reaches it, it jumps back to `to` until its stop condition holds or `maxIterations` (1–20, required) passes ran:

```yaml
steps:
  - { id: plan, kind: prompt, name: Plan, prompt: "Plan {{inputs.task}}" }
  - { id: implement, kind: prompt, name: Implement, prompt: "Implement the plan" }
  - id: review
    kind: prompt
    name: Review
    prompt: "Review the change. Previous fixes: {{steps.fix.output}}"
    structured:
      fields:
        - { name: approved, description: "true when the change needs no more fixes" }
        - { name: issues, description: "What still needs fixing" }
  - { id: fix, kind: prompt, name: Fix, prompt: "Fix: {{steps.review.structured.issues}}" }
  - id: again
    kind: loop
    name: Review/fix
    to: review
    maxIterations: 3
    stop: { when: value, ref: review.structured.approved, is: truthy }
  - { id: gate, kind: intervention, name: Check }
```

- **`stop.when`**: `max` (default) runs the body exactly `maxIterations` times. `value` stops as soon as `ref`
  (`<stepId>.output` or `<stepId>.structured.<field>` of a step directly in the body, not only inside a nested loop) is
  `truthy`/`falsy` (`is`); it is checked right after that step succeeds, so it breaks out mid-body — the rest of the body
  is marked `skipped` and keeps its previous values for later templates. `ask` pauses at the loop step like an
  intervention (optional `message`, `timeoutSec` caps each wait): chat with the run's sessions, then **Repeat from …**
  or **Continue run**.
- **Falsy** values: `false`, `null`, missing, `0`, empty or whitespace-only text, `"false"`/`"no"`/`"0"` (trimmed, any
  case), `[]` and `{}`. Everything else is truthy.
- **`onExhausted`** (`value` loops): when the last allowed pass ends without meeting the stop condition, `continue`
  (default) moves on to the next step and `fail` fails the run. `max` and `ask` loops ignore it: an `ask` loop's stop
  condition is the person's **Continue run**, so its last allowed pass still asks, just without offering repeat.
- A loop step has no output of its own: templates cannot reference `{{steps.<loopId>…}}`.
- **Forward refs**: a body step may use `{{steps.<later>.output}}` of a later step in the same (or an enclosing) body —
  the previous pass's output, empty on the first pass (like `{{steps.fix.output}}` in the review prompt above).
- Bodies of different loops nest or are disjoint (crossing loops are rejected), and `github_pr` cannot run inside a loop
  (it would open one PR per pass). Loops are allowed in pull request flows: they are bounded by `maxIterations` and step
  timeouts.
- The run view shows `n/max` badges on the body and an *Iteration n* divider in re-run steps' transcripts (both follow
  the innermost loop that has repeated, so a body step re-run by an outer pass is marked too). **Retrying** a run from
  inside a loop restarts that loop's counter at 1 (each attempt stays bounded).

## Conditions

A **`condition` step** ("If…") branches the run on a value. Its `ref` is a template path without braces
(`inputs.<key>[.<field>]`, `steps.<id>.output`, `steps.<id>.structured.<field>`), compared with `op`:
`equals` / `not_equals` (trimmed text), `contains` / `not_contains` (case-sensitive) — these take a `value` —
or `truthy` / `falsy` (same rules as loop stops). The **then-block** runs from the next step through `thenEnd`; the
optional **else-block** runs from the step after `thenEnd` through `elseEnd`. The branch not taken is marked `skipped`.

```yaml
steps:
  - id: review
    kind: prompt
    name: Review
    prompt: "Review the change"
    structured: { fields: [{ name: verdict, description: "approve or fix" }] }
  - { id: needs_fix, kind: condition, name: Needs a fix?, ref: steps.review.structured.verdict, op: equals, value: fix, thenEnd: fix, elseEnd: note }
  - { id: fix, kind: prompt, name: Fix, prompt: "Fix what the review found" }
  - { id: note, kind: shell, name: Note, command: "echo approved" }
  - { id: commit, kind: git_commit, name: Commit, messageFrom: review }
```

- An absent value (an optional input left out, a structured field never submitted) compares as empty text and is falsy;
  it does not fail the step. The condition's own output names the test, the branch it took and the value it saw.
- A condition step has no output for templates. Steps outside a branch cannot reference steps inside it (they may have
  been skipped), and `github_pr` needs a `git_push` that always runs before it.
- Branches nest inside one branch of another condition (a chain of if / else-if puts the next condition in the
  else-block), and branches and loop bodies nest or are disjoint. A condition inside a loop body decides again on every pass.
- **Retrying** from the condition step evaluates it again. Retrying from a step inside a branch runs that branch
  (from that step on) and skips the other one. In a branch the previous attempt skipped, only its first step can be
  run from (`409` otherwise): its later steps would miss the outputs of the branch steps before them.

### Manual branches

An intervention step can offer **`choices`** (2–8 `{id, label}`): at the gate one button per choice replaces
**Continue**, and the pick becomes the step's structured output `{{steps.<gate>.structured.choice}}`. A condition on
that ref compares with `equals` / `not_equals` against one of the gate's choice ids. The gate's output is still the
selected session's latest reply, and you can chat with the run's sessions before picking.

```yaml
steps:
  - { id: implement, kind: prompt, name: Implement, prompt: "Implement {{inputs.task}}" }
  - id: review
    kind: intervention
    name: Review
    message: "Approve the change or send it back for a fix"
    choices: [{ id: approve, label: Approve }, { id: fix, label: Fix }]
  - { id: wants_fix, kind: condition, name: Fix?, ref: steps.review.structured.choice, op: equals, value: fix, thenEnd: fix, elseEnd: commit }
  - { id: fix, kind: prompt, name: Fix, prompt: "Fix the change as discussed" }
  - { id: commit, kind: git_commit, name: Commit, messageFrom: implement }
```

One pick can drive several conditions. A gate inside a loop asks on every pass, so each pass branches on a fresh pick.
`continue` without a valid choice is rejected (`400`), and the run view shows `Chose: <label>` on the resolved gate.


## Structured output

Prompt, skill and command steps can declare a structured-output contract: `structured: {fields: [{name, description}, …]}`
(up to 32 fields; names match `/^[a-z][a-z0-9_]*$/`, every field required, any JSON value per field). The runner appends an
instruction to the step's prompt telling the agent to call the `submit_output` MCP tool with a JSON object of those
fields, and the tool's schema (what the model sees) is generated from the declaration (every declared field is required;
extra keys are allowed and kept). Validation is self-correcting: a
missing field comes back as a tool error naming what to add. If the agent finishes without calling `submit_output`, the step
fails with an explicit error (retryable from the run view).

Later steps consume the result as `{{steps.<id>.structured.<field>}}` in templates (string fields render raw, objects as
JSON) and as dotted refs in `*From` fields: `git_commit.messageFrom`, `github_pr.titleFrom`/`bodyFrom` and
`github_comment.bodyFrom` accept `"<stepId>"`, `"<stepId>.output"`, or `"<stepId>.structured.<field>"` — e.g. a PR-title flow:

```yaml
steps:
  - id: gen
    kind: prompt
    name: Generate
    prompt: "Draft the PR title and body for {{inputs.issue.title}}."
    structured:
      fields:
        - { name: title, description: "One-line PR title" }
        - { name: body, description: "Full PR description" }
  - id: push
    kind: git_push
    name: Push
  - id: pr
    kind: github_pr
    name: PR
    titleFrom: gen.structured.title
    bodyFrom: gen.structured.body
```

When a step declares fields, the editor's variable picker offers each `steps.<id>.structured.<field>` (and `*From` selects
validate against the declared names). Steps without a declaration keep the permissive `steps.<id>.structured` access, so
older flows and replayed run data keep working. Slash steps are text-only: they run headless (`omp -p`) without the MCP
server.

GitHub App settings:
- **Permissions:** Checks RW, Pull requests RW, Contents R, Issues RW (comments on issues), Metadata R.
- **Events:** Pull request.
- **Webhook:** `https://<domain>/github/webhook`.

## Themes

A theme is one plain CSS file, `<name>.css`, that overrides the variables below and may add any other rules.
Names match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (letters, digits, `-`, `_`; no dots). Built-in themes `light` and `dark`
(in `packages/web/themes/`) pin the default palette to one mode.

**Adding one:** put the file in `ui.themesDir` and reload the page: it appears in the *Theme* picker (account menu at
the bottom of the sidebar), with no rebuild or restart. A custom theme replaces a built-in of the same name.

```json
{ "ui": { "theme": "corporate", "themesDir": "/data/themes" } }
```

`ui.theme` is the default for every browser (null = follow the OS light/dark setting); the server refuses to start if
it names a theme that doesn't exist. `themesDir` is relative to the config file's directory.

**Selection order** for `GET /theme.css`, a render-blocking `<link>` in `index.html` (so no unthemed flash):
1. the `orch_theme` cookie set by the picker, if it names an existing theme;
2. `ui.theme`;
3. nothing: the built-in styles, following the OS setting.

The base styles live in cascade layers (`@layer xyflow, orch`) and themes are unlayered, so a theme rule always beats
a built-in one regardless of specificity. Light and dark values use `light-dark()` on a `:root` with
`color-scheme: light dark`: force a mode with `:root { color-scheme: dark; }`, or give one value for both modes. The
flow canvas maps xyflow's `--xy-*` variables onto these, so it follows the theme too. The UI needs native `light-dark()`
(Chrome/Edge 123, Firefox 120, Safari 17.5); `vite.config.ts` sets `build.cssTarget` to match so the minifier keeps it.

| Group | Variables |
|---|---|
| Color | `--bg` `--panel` `--panel-2` `--border` `--text` `--muted` `--accent` `--accent-text` `--danger` `--ok` `--warn` `--info` `--user-bubble` `--code-bg` `--overlay` (modal backdrop) `--on-danger` (text on danger badges) |
| Effects | `--shadow` (a full `box-shadow` value, popovers and dialogs) `--shadow-sm` (subtle raise, cards) `--focus-ring` (a `box-shadow` value for keyboard focus) `--transition` (duration + easing for hover/press; `none` under `prefers-reduced-motion`) |
| Type | `--font-sans` `--font-mono` `--font-size` (base, 14px) `--text-xs` (11px) `--text-sm` (12px) `--text-md` (13px) |
| Shape | `--radius-xs` (3px) `--radius-sm` (4px) `--radius-md` (6px) `--radius-lg` (10px) |
| Spacing | `--space-1` (4px) `--space-2` (8px) `--space-3` (12px) `--space-4` (16px) `--space-5` (24px) `--space-6` (32px) |

These variables are the stable contract. Class names can be targeted for bigger changes, but may change between
releases. Example `corporate.css`:

```css
:root {
  --accent: light-dark(#7a1fa2, #c77dff);
  --accent-text: #ffffff;
  --font-sans: "IBM Plex Sans", system-ui, sans-serif;
  --radius-md: 2px;
  --radius-lg: 4px;
}
.sidebar {
  border-right: 3px solid var(--accent);
}
```

The top bar was replaced by a left sidebar (`.sidebar`) in the UI refresh; themes that styled `.topbar` need to move
those rules to `.sidebar`.

Theme CSS is trusted admin content: it can load external fonts or images (there is no CSP), so only admins should be
able to write `themesDir`.
