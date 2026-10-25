# Agent Orchestrator

Runs multi-step AI-agent **flows** (prompt → skill → command → slash command → git commit → push → PR, or GitHub PR checks) inside hardened Docker sandboxes, driven from a web UI with live token streaming.

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
- Run container: `--cap-drop ALL`, `no-new-privileges`, host uid, tmpfs HOME. `.git/hooks` and `.git/config` are mounted read-only over the repo.
- Model access goes through the host `omp auth-gateway`; the gateway bearer is the only secret in the sandbox.
- Flow models are picked from the gateway's model list (`/api/catalog`, advertised by online runners) in the
  flow editor; `harness.modelRoles` maps extra omp roles (`slow`, `plan`, `task`, …) to models, with `smol`
  (`smolModel`) and unset roles falling back to `model`.
- git commit/push run on the host. GitHub API calls run on the server. The agent never holds GitHub credentials.
- **Intervention steps** pause the run and open a chat under the step in the run view. Pick one of the run's
  sessions — the shared agent (ACP) session of prompt/skill/command steps, or the `omp -p` session of an
  earlier slash step (resumed with `--resume`) — and send any text, slash commands included; replies stream
  into the step's transcript. *Continue run* passes the selected session's latest reply on as
  `{{steps.<gate>.output}}`; later agent steps keep the chat in their context when they share the session.
  While it waits for you the run status is `awaiting_input` (it still holds its runner slot); it is `running` again
  while a reply is generated. Without a timeout the run waits until answered or cancelled. Not available in
  PR-triggered flows.
- **Retrying a failed or cancelled run** picks up where it stopped — same run, same transcript, same step outputs. **Retry**
  (header button) re-runs the first step that did not succeed (the last step if all did) and continues to the end;
  **Run from here** (per step) resets that step and everything after it, keeping earlier outputs — use it to recover
  from bad upstream output without rerunning what worked. Retrying from a later step of a local-path flow runs on
  the runner that ran the previous attempt and adopts its worktree as left; if that runner stays offline, the run
  fails with `resume_runner_lost` (retry from step 1 instead). Retrying from step 1 resets the worktree to the base
  ref; PR-checkout runs always start from a fresh checkout of the PR head. Outputs of skipped steps come back as
  `{{steps.…}}`, and the event transcript continues in one view with continuous sequence numbers even across runner
  restarts. Agent steps resume in a fresh session (ACP has no conversation resume); the sandbox is recreated per
  attempt, so tmpfs state (`$HOME`, `/tmp`) is not carried over. A retried intervention lists the run's sessions
  again: slash sessions continue their earlier conversation, the agent session is a new one that starts from its
  last result.
  PR-triggered runs get a fresh check run for the new attempt (a recurring finding may post a duplicate review).

## Public control plane (M2)

See `deploy/`: `server.Dockerfile`, `compose.yml` (server + Caddy TLS, `ORCH_DOMAIN`), `orch.server.example.json`, `orch-runner.service`, and `runner*.example.json`. Runners connect outbound over `wss://<domain>/runner/ws`. Create owner-bound tokens with `runner-token create --name <n> --owner <login>` or from the Runners page.

## PR checker (M3)

GitHub App settings:
- **Permissions:** Checks RW, Pull requests RW, Contents R, Issues R, Metadata R.
- **Events:** Pull request.
- **Webhook:** `https://<domain>/github/webhook`.

A flow with `trigger: {kind: "github_pull_request", repos: ["owner/name"]}` and `workspace: {kind: "github_checkout"}` runs on each matching PR event, on runners with `acceptUntrusted: true`. Prompts can use `{{inputs.pr.title|body|diffPath|…}}`. Results are reported as a check run (with annotations) and a COMMENT review.

Fork and first-time-contributor PRs follow `forkPolicy` (default `require_approval`; approve them from the run view).

Saved PR flows can also be started by hand: the flow editor's Run button takes a pull request URL, or `POST /api/flows/<id>/runs` with `{"prUrl": "https://github.com/owner/repo/pull/123"}`. The PR's repository must be in the flow's `repos` list; manual PR runs are untrusted like webhook runs (so they need an `acceptUntrusted` runner), report to GitHub the same way, and are not deduped — running the same PR twice creates two runs.

GitHub reporting is per flow: `postChecks` (default `true`) publishes the check run with progress and result annotations, and `postReview` (default `true`) posts the COMMENT review when the agent reports findings — the review rides on the check run, so `postChecks: false` disables it too. With both off, results appear only in the orchestrator's run view.
