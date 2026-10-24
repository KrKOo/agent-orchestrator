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

## Public control plane (M2)

See `deploy/`: `server.Dockerfile`, `compose.yml` (server + Caddy TLS, `ORCH_DOMAIN`), `orch.server.example.json`, `orch-runner.service`, and `runner*.example.json`. Runners connect outbound over `wss://<domain>/runner/ws`. Create owner-bound tokens with `runner-token create --name <n> --owner <login>` or from the Runners page.

## PR checker (M3)

GitHub App settings:
- **Permissions:** Checks RW, Pull requests RW, Contents R, Issues R, Metadata R.
- **Events:** Pull request.
- **Webhook:** `https://<domain>/github/webhook`.

A flow with `trigger: {kind: "github_pull_request", repos: ["owner/name"]}` and `workspace: {kind: "github_checkout"}` runs on each matching PR event, on runners with `acceptUntrusted: true`. Prompts can use `{{inputs.pr.title|body|diffPath|…}}`. Results are reported as a check run (with annotations) and a COMMENT review.

Fork and first-time-contributor PRs follow `forkPolicy` (default `require_approval`; approve them from the run view).
