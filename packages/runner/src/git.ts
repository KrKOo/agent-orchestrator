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
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`);
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
 * Pushes HEAD to `branch` on GitHub. The token is passed as an `http.extraheader` through
 * `GIT_CONFIG_*` env, so it never touches disk, argv, or the sandbox.
 */
export async function pushBranch(
  worktree: string,
  repo: { owner: string; name: string },
  branch: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  await gitOk(
    worktree,
    ["-c", "credential.helper=", "push", `https://github.com/${repo.owner}/${repo.name}.git`, `HEAD:refs/heads/${branch}`],
    {
      signal,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      },
    },
  );
}
