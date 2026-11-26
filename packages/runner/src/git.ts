import { existsSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Extra env; values are never placed in argv. */
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Drop every inherited `GIT_*` variable, so only `env` configures git (snapshot store calls). */
  isolated?: boolean;
}

function spawnGit(cwd: string, args: string[], opts: GitOptions) {
  const inherited = opts.isolated ? Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) : process.env;
  return Bun.spawn(["git", "-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    signal: opts.signal,
  });
}

/** Runs host git with hooks disabled. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const proc = spawnGit(cwd, args, opts);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

/**
 * Runs host git and hands its stdout to `onChunk` as it arrives, never holding it whole; `onChunk` returning false
 * stops reading and kills git. Throws on a non-zero exit, unless it was stopped early.
 */
async function gitStream(cwd: string, args: string[], opts: GitOptions, onChunk: (chunk: Uint8Array) => boolean | Promise<boolean>): Promise<void> {
  const proc = spawnGit(cwd, args, opts);
  const stderr = new Response(proc.stderr).text();
  let stopped = false;
  for await (const chunk of proc.stdout) {
    if (!(await onChunk(chunk))) {
      stopped = true;
      proc.kill();
      break;
    }
  }
  const [code, err] = await Promise.all([proc.exited, stderr]);
  if (!stopped && code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim() || `exit ${code}`}`);
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
 * Where `git_snapshot` keeps its objects and index: a bare repo the runner creates in the run dir, which is never
 * mounted into the sandbox. Snapshots never write to the user's repo, and git never reads a git dir, `commondir` or
 * config the agent could have planted in the workspace (a worktree's `.git` file, `.git/commondir`).
 */
export interface SnapshotStore {
  gitDir: string;
  /** Kept between snapshots: its stat cache spares `add -A` from rehashing unchanged files. */
  indexFile: string;
}

export function snapshotStore(runDir: string): SnapshotStore {
  // Absolute: git resolves relative GIT_DIR / GIT_INDEX_FILE against its own working directory.
  return { gitDir: resolve(runDir, "snapshots.git"), indexFile: resolve(runDir, "snapshots.index") };
}

/**
 * Config env for host git on a snapshot store, whose work tree (`.gitattributes`, anything named `.git`) the agent
 * writes: nothing it controls may pick a command, and nothing of the runner host's git setup may shape a snapshot.
 * Inherited `GIT_*` variables are dropped (`isolated`), system and global config are skipped and the store's own config
 * is fresh from `git init`, so no filter, textconv or diff driver exists for `.gitattributes` to select. Command-scope
 * entries force fsmonitor off, turn off the per-user ignore and attributes files (system attributes via
 * `GIT_ATTR_NOSYSTEM`), so only the workspace's own `.gitignore`/`.gitattributes` count, and silence per-file warnings
 * of `add` (its output is buffered).
 */
const CLEAN_CONFIG_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.excludesFile",
  GIT_CONFIG_VALUE_1: "/dev/null",
  GIT_CONFIG_KEY_2: "core.attributesFile",
  GIT_CONFIG_VALUE_2: "/dev/null",
  GIT_CONFIG_KEY_3: "core.safecrlf",
  GIT_CONFIG_VALUE_3: "false",
};

/**
 * Options for git on the store: `CLEAN_CONFIG_ENV`, isolated, and the store's git dir set explicitly, so git never
 * discovers one through the workspace. Pathspecs are literal: paths the agent named may contain glob characters.
 */
function storeOpts(store: SnapshotStore, signal: AbortSignal | undefined, extra: Record<string, string> = {}): GitOptions {
  return { signal, isolated: true, env: { ...CLEAN_CONFIG_ENV, GIT_DIR: store.gitDir, GIT_LITERAL_PATHSPECS: "1", ...extra } };
}

/** Streams the NUL-separated paths git prints with `-z` to `onPath`; only the last, unterminated path is held back. */
async function gitPaths(cwd: string, args: string[], opts: GitOptions, onPath: (path: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  await gitStream(cwd, args, opts, (chunk) => {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split("\0");
    rest = parts.pop()!;
    for (const path of parts) if (path) onPath(path);
    return true;
  });
  rest += decoder.decode();
  if (rest) onPath(rest);
}

/** Index entry for a file that never exists: it makes `add -A` walk a nested repo's directory (see `stageNestedRepos`). */
const NESTED_PLACEHOLDER = ".orch-snapshot-placeholder";
/** `--cacheinfo` entries per `update-index` call (bounds argv). */
const PLACEHOLDER_BATCH = 200;

/**
 * Lets `add -A` stage nested git repositories (a cloned dependency, a scaffolder's `git init`) as plain files. On its
 * own it records a directory with a `.git` as a gitlink, i.e. only that repo's HEAD commit: its uncommitted edits would
 * never reach a snapshot, and a repo without commits fails the whole `add`. A directory that already has index entries
 * is walked like any other, so each nested repo the walk would stop at gets a placeholder entry, for a file that does
 * not exist and so drops out in `add -A`. Repeats until none is left, which reaches repos nested inside nested ones.
 */
async function stageNestedRepos(workTree: string, opts: GitOptions): Promise<void> {
  const seen = new Set<string>();
  let blob: string | undefined;
  for (;;) {
    // Untracked, not ignored: a nested repo is listed as its directory (`sub/`), plain directories as their files.
    const nested: string[] = [];
    await gitPaths(workTree, ["ls-files", "--others", "--exclude-standard", "-z"], opts, (path) => {
      if (path.endsWith("/")) nested.push(path);
    });
    if (nested.length === 0) return;
    const again = nested.find((dir) => seen.has(dir));
    if (again !== undefined) throw new Error(`git_snapshot cannot stage the nested repository ${again}`);
    for (const dir of nested) seen.add(dir);
    // The empty blob (stdin is empty); the placeholder never reaches a tree.
    blob ??= await gitOk(workTree, ["hash-object", "-w", "--stdin"], opts);
    for (let i = 0; i < nested.length; i += PLACEHOLDER_BATCH) {
      const entries = nested.slice(i, i + PLACEHOLDER_BATCH).flatMap((dir) => ["--cacheinfo", `100644,${blob},${dir}${NESTED_PLACEHOLDER}`]);
      await gitOk(workTree, ["update-index", "--add", ...entries], opts);
    }
  }
}

/**
 * Removes from the store index, never from disk, every path `git <listArgs>` prints NUL-separated. The list goes
 * through `listFile`: it can be long (an install the agent ignored afterwards).
 */
async function dropIndexEntries(workTree: string, opts: GitOptions, listArgs: string[], listFile: string): Promise<void> {
  const out = await open(listFile, "w");
  let any = false;
  try {
    await gitStream(workTree, listArgs, opts, async (chunk) => {
      any = true;
      await out.write(chunk);
      return true;
    });
  } finally {
    await out.close();
  }
  // `--force`: the index may differ from the file (and the store has no HEAD); only the entry goes, never the file.
  if (any) await gitOk(workTree, ["rm", "--cached", "--force", "--quiet", "--ignore-unmatch", `--pathspec-from-file=${listFile}`, "--pathspec-file-nul"], opts);
}

/**
 * Records `workTree`'s current files (tracked and untracked; ignored per the `.gitignore` files inside it) as a tree
 * in `store` and returns its sha. The user's repo, its HEAD, branch and index are never touched; a workspace that is a
 * subdirectory of a larger repo is snapshotted on its own, so the rest of that repo never reaches a diff.
 */
export async function snapshotTree(store: SnapshotStore, workTree: string, signal?: AbortSignal): Promise<string> {
  if (!existsSync(join(store.gitDir, "HEAD"))) {
    // An index left from an older store would name objects this one lacks.
    await rm(store.indexFile, { force: true });
    await gitOk(dirname(store.gitDir), ["init", "--quiet", "--bare", "--template=", store.gitDir], { signal, isolated: true, env: CLEAN_CONFIG_ENV });
  }
  const opts = storeOpts(store, signal, { GIT_WORK_TREE: workTree, GIT_INDEX_FILE: store.indexFile });
  // A git killed mid-write (step timeout, cancel) leaves its lock behind; nothing else uses this index.
  const lock = `${store.indexFile}.lock`;
  const listFile = `${store.indexFile}.list`;
  await rm(lock, { force: true });
  try {
    if (existsSync(store.indexFile)) {
      // The index is kept between snapshots, which makes every path it holds tracked, and tracked paths are exempt
      // from `.gitignore`. Drop the ones ignored by now, so a snapshot depends on the workspace as it is, not on history.
      await dropIndexEntries(workTree, opts, ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"], listFile);
      // Drop entries whose file is gone or is no longer a file (D, T): a file entry where a directory holding a
      // nested repo now is hides that repo from `stageNestedRepos`, and `add -A` alone would record it as a gitlink
      // (or fail on one without commits). `add -A` re-adds whatever is there now.
      await dropIndexEntries(workTree, opts, ["diff-files", "--name-only", "--diff-filter=DT", "-z"], listFile);
    }
    await stageNestedRepos(workTree, opts);
    await gitOk(workTree, ["add", "-A"], opts);
    return await gitOk(workTree, ["write-tree"], opts);
  } finally {
    await rm(lock, { force: true });
    await rm(listFile, { force: true });
  }
}

/** Whether `sha` names a tree in `store` (a retry on another runner has none of its snapshots). */
export async function treeExists(store: SnapshotStore, sha: string, signal?: AbortSignal): Promise<boolean> {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) || !existsSync(store.gitDir)) return false;
  return (await git(store.gitDir, ["cat-file", "-e", `${sha}^{tree}`], storeOpts(store, signal))).code === 0;
}

export interface DiffLimits {
  /** Bytes of patch written to the patch file; the rest is cut with a marker. */
  patchBytes: number;
  /** Most paths listed in `files` ... */
  files: number;
  /** ... and the most characters they may add up to (`fileCount` counts every path). */
  fileChars: number;
}

/** Lines of `--stat` (git appends a `...` line and the totals when it cuts). */
const STAT_LINES = 500;

/**
 * Diff between two trees of `store`: writes the patch to `patchFile` and returns the changed paths and a `--stat`
 * summary. Every output is streamed and capped by `limits`, so a huge change set cannot exhaust the runner's memory
 * or disk. External diff and textconv stay off on top of `storeOpts` (this is host git on agent-written content).
 */
export async function diffTrees(
  store: SnapshotStore,
  base: string,
  tree: string,
  patchFile: string,
  limits: DiffLimits,
  signal?: AbortSignal,
): Promise<{ files: string[]; fileCount: number; stat: string; patchTruncated: boolean }> {
  const args = (...extra: string[]) => ["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...extra, base, tree];
  const opts = storeOpts(store, signal);

  const writePatch = async (): Promise<boolean> => {
    const out = await open(patchFile, "w");
    let left = limits.patchBytes;
    let truncated = false;
    try {
      await gitStream(store.gitDir, args(), opts, async (chunk) => {
        truncated = chunk.byteLength > left;
        const kept = truncated ? chunk.subarray(0, left) : chunk;
        await out.write(kept);
        left -= kept.byteLength;
        return !truncated;
      });
      if (truncated) await out.write(`\n… (diff truncated at ${limits.patchBytes} bytes)\n`);
    } finally {
      await out.close();
    }
    return truncated;
  };

  const listFiles = async () => {
    const files: string[] = [];
    let count = 0;
    let chars = 0;
    await gitPaths(store.gitDir, args("--name-only", "-z"), opts, (name) => {
      count++;
      chars += name.length;
      if (files.length < limits.files && chars <= limits.fileChars) files.push(name);
    });
    return { files, count };
  };

  const readStat = async (): Promise<string> => {
    let text = "";
    const decoder = new TextDecoder();
    // `--stat-count` already bounds it; the byte check guards anyway.
    await gitStream(store.gitDir, args("--stat", `--stat-count=${STAT_LINES}`), opts, (chunk) => {
      text += decoder.decode(chunk, { stream: true });
      return text.length < 1_000_000;
    });
    return (text + decoder.decode()).trimEnd();
  };

  const [patchTruncated, { files, count }, stat] = await Promise.all([writePatch(), listFiles(), readStat()]);
  return { files, fileCount: count, stat, patchTruncated };
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

/** Pushes HEAD to `branch` on GitHub, authenticated with `token` (see `tokenEnv`). */
export async function pushBranch(
  worktree: string,
  repo: { owner: string; name: string },
  branch: string,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  await gitOk(
    worktree,
    ["-c", "credential.helper=", "push", `https://github.com/${repo.owner}/${repo.name}.git`, `HEAD:refs/heads/${branch}`],
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
