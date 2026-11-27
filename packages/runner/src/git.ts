export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Extra env; values are never placed in argv. */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/** Runs host git with hooks disabled. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const proc = Bun.spawn(["git", "-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    signal: opts.signal,
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

export async function gitOk(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const res = await git(cwd, args, opts);
  if (res.code !== 0) {
    // Name the subcommand, not a leading `-c <key=value>` config pair.
    let i = 0;
    while (args[i] === "-c") i += 2;
    throw new Error(`git ${args[i] ?? args[0]} failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`);
  }
  return res.stdout.trim();
}

export function parseGitHubRemote(url: string): { owner: string; name: string } | null {
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

export async function originRepo(path: string): Promise<{ owner: string; name: string } | null> {
  const res = await git(path, ["remote", "get-url", "origin"]);
  return res.code === 0 ? parseGitHubRemote(res.stdout) : null;
}

/** Stages everything and commits with the message file; returns the new HEAD sha. */
export async function commitAll(
  worktree: string,
  messageFile: string,
  author: { authorName?: string; authorEmail?: string },
  signal?: AbortSignal,
): Promise<string> {
  await gitOk(worktree, ["add", "-A"], { signal });
  const diff = await git(worktree, ["diff", "--cached", "--quiet"], { signal });
  if (diff.code === 0) throw new Error("No changes to commit");
  if (diff.code !== 1) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  const identity = [
    ...(author.authorName ? ["-c", `user.name=${author.authorName}`] : []),
    ...(author.authorEmail ? ["-c", `user.email=${author.authorEmail}`] : []),
  ];
  await gitOk(worktree, [...identity, "commit", "-F", messageFile], { signal });
  return gitOk(worktree, ["rev-parse", "HEAD"], { signal });
}

/**
 * Env that passes the token as an `http.extraheader` through `GIT_CONFIG_*`, so it never
 * touches disk, argv, or the sandbox.
 */
function tokenEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Pushes HEAD to `branch` on GitHub, authenticated with `token` (see `tokenEnv`).
 * `leaseSha` (or `null` for "ref must not exist") turns the push into `--force-with-lease`, refusing
 * to overwrite remote work the runner has not seen. `baseUrl` defaults to `https://github.com`
 * (tests point it at a local `file://` dir, like the PR checkout's `gitUrl`). */
export async function pushBranch(
  worktree: string,
  repo: { owner: string; name: string },
  branch: string,
  token: string,
  signal?: AbortSignal,
  leaseSha?: string | null,
  baseUrl: string = "https://github.com",
): Promise<void> {
  await gitOk(
    worktree,
    [
      "-c",
      "credential.helper=",
      "push",
      // `--force-with-lease=<ref>:<expect>`: expect the remote ref to still be at `leaseSha`
      // (an empty expect means the remote ref must not exist). Plain `--force` would clobber it.
      ...(leaseSha !== undefined ? [`--force-with-lease=refs/heads/${branch}:${leaseSha ?? ""}`] : []),
      `${baseUrl}/${repo.owner}/${repo.name}.git`,
      `HEAD:refs/heads/${branch}`,
    ],
    { signal, env: tokenEnv(token) },
  );
}

/** Shallow-fetches `shas` from `url` into the repo at `dir`, authenticated with `token` (see `tokenEnv`). */
export async function fetchShas(dir: string, url: string, shas: string[], token: string, depth: number, signal?: AbortSignal): Promise<void> {
  await gitOk(dir, ["-c", "credential.helper=", "fetch", "--quiet", "--no-tags", `--depth=${depth}`, url, ...shas], {
    signal,
    env: tokenEnv(token),
  });
}

/**
 * Fetches remote branches `branches` into local refs `refs/orch/remote/<branch>` in the repo at `dir`,
 * authenticated with `token` (see `tokenEnv`). Deliberately not `+refs/heads/*`: the user's
 * remote-tracking refs (`refs/remotes/*`) stay untouched, and stale orchestrator refs are overwritten.
 */
export async function fetchBranches(dir: string, url: string, branches: string[], token: string, signal?: AbortSignal): Promise<void> {
  await gitOk(
    dir,
    ["-c", "credential.helper=", "fetch", "--quiet", "--no-tags", url, ...branches.map((b) => `+refs/heads/${b}:refs/orch/remote/${b}`)],
    { signal, env: tokenEnv(token) },
  );
}

/**
 * The sha of `branch` on the remote at `url`, or null when it does not exist; read from the remote itself
 * (`ls-remote`), never from local refs, which a sandbox mounting the repo's git dir can rewrite.
 */
export async function remoteBranchSha(dir: string, url: string, branch: string, token: string, signal?: AbortSignal): Promise<string | null> {
  const out = await gitOk(dir, ["-c", "credential.helper=", "ls-remote", "--heads", url, `refs/heads/${branch}`], {
    signal,
    env: tokenEnv(token),
  });
  // The pattern also matches longer refs ending in it (`refs/heads/x/refs/heads/<branch>`): compare the ref exactly.
  const ref = `refs/heads/${branch}`;
  const line = out.split("\n").find((l) => l.split("\t")[1] === ref);
  return line ? line.split("\t")[0]! : null;
}
