import type { CreateCommentResult, CreatePullRequestResult, GitHubIssueInput } from "@orch/protocol";
import type { CheckAnnotation, CheckConclusion } from "./report";

// A trailing path, query or fragment (`/files`, `#discussion_r1`) is allowed; anything else after the number is not.
const ISSUE_URL_RE = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/issues\/(\d+)(?:[/?#].*)?$/;
const PR_URL_RE = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/** An issue or pull request parsed from its github.com URL. */
export interface GitHubRef {
  repo: string;
  number: number;
}

function parseRef(re: RegExp, url: string): GitHubRef | null {
  const m = re.exec(url.trim());
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

export const parseIssueUrl = (url: string): GitHubRef | null => parseRef(ISSUE_URL_RE, url);
export const parsePullUrl = (url: string): GitHubRef | null => parseRef(PR_URL_RE, url);

/** Authors GitHub reports with these associations are treated like fork PRs. */
const UNTRUSTED_ASSOCIATIONS = new Set(["FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"]);

/** Fork and first-time-contributor PRs are subject to the trigger's `forkPolicy`. */
export function isUntrustedPullSource(headRepo: string | undefined, baseRepo: string, authorAssociation: string): boolean {
  return headRepo !== baseRepo || UNTRUSTED_ASSOCIATIONS.has(authorAssociation);
}

/** PR metadata run creation needs; `baseSha`/`headSha` pin the checkout. */
export interface PullRequestInfo {
  url: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  /** Fork or first-time-contributor PR (see `isUntrustedPullSource`). */
  untrustedSource: boolean;
}

export class GitHubError extends Error {
  /** `status` is the GitHub HTTP status, or 0 for invalid input / network failures. */
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface CreatePullRequest {
  repo: string;
  head: string;
  base: string | null;
  title: string;
  body: string;
  draft: boolean;
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  annotations?: CheckAnnotation[];
}

export interface CreateCheckRun {
  name: string;
  head_sha: string;
  status: "queued" | "in_progress";
  external_id: string;
  details_url: string;
  output?: CheckRunOutput;
}

export interface UpdateCheckRun {
  status?: "queued" | "in_progress" | "completed";
  conclusion?: CheckConclusion;
  completed_at?: string;
  output?: CheckRunOutput;
}

/** Entry of `GET /repos/{o}/{r}/pulls/{n}/files`; `patch` is absent for binary or huge diffs. */
export interface ChangedFile {
  filename: string;
  patch?: string;
}

/**
 * PR state plus check aggregation, read by the manager before merging. `mergeable` is null while
 * GitHub computes it; `mergeableState` distinguishes clean/dirty/blocked/behind/unstable.
 */
export interface PullStatus {
  url: string;
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  /** null while GitHub computes it. */
  mergeable: boolean | null;
  /** GitHub `mergeable_state`: clean | dirty | blocked | behind | unstable | unknown | has_hooks | draft. */
  mergeableState: string;
  head: { ref: string; sha: string; repo: string | null };
  base: { ref: string; sha: string };
  /** Check runs and commit statuses of `head.sha`. */
  checks: { state: "success" | "failure" | "pending" | "none"; failing: string[]; pending: string[] };
}

/**
 * Encodes a git ref path (`heads/feature/x`) for a URL path: each `/`-separated segment is encoded
 * separately, so slashes stay separators (GitHub takes the raw ref there) while spaces and `#` in a
 * segment become safe.
 */
function encodeRefPath(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

/** Upper bound on `GET /pulls/{n}/files` pages (GitHub lists at most 3000 files). */
const MAX_FILE_PAGES = 30;
const FILES_PER_PAGE = 100;
/** Page size and page cap for a commit's check runs and commit statuses (`getPullStatus`). */
const CHECKS_PER_PAGE = 100;
const MAX_CHECK_PAGES = 30;

/** Minimal GitHub REST client. `baseUrl` is the REST API root, `webBaseUrl` the site root (OAuth endpoints). */
export class GitHubApi {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = "https://api.github.com",
    private readonly webBaseUrl = "https://github.com",
  ) {}

  private async request<T>(method: string, url: string, token: string | null, body?: unknown): Promise<T> {
    const target = url.startsWith("/") ? `${this.baseUrl}${url}` : url;
    let res: Response;
    try {
      res = await this.fetchFn(target, {
        method,
        headers: {
          // The OAuth endpoint on the site answers JSON only for a plain JSON Accept.
          Accept: url.startsWith("/") ? "application/vnd.github+json" : "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "agent-orchestrator",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new GitHubError(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`, 0);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { message?: string; errors?: ({ message?: string } | string)[] };
        detail =
          [j.message, ...(j.errors ?? []).map((e) => (typeof e === "string" ? e : e.message))].filter(Boolean).join("; ") || detail;
      } catch {}
      throw new GitHubError(`GitHub ${method} ${url} → ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** Resolves an issue; `token` null fetches unauthenticated. */
  async getIssue(ref: GitHubRef, token: string | null): Promise<GitHubIssueInput> {
    const issue = await this.request<{ html_url: string; number: number; title: string; body: string | null }>(
      "GET",
      `/repos/${ref.repo}/issues/${ref.number}`,
      token,
    );
    return { url: issue.html_url, repo: ref.repo, number: issue.number, title: issue.title, body: issue.body ?? "" };
  }

  /** True when issue `number` of `repo` is a pull request (the issues API marks PRs with `pull_request`). */
  async isPullRequest(token: string | null, repo: string, number: number): Promise<boolean> {
    const issue = await this.request<{ pull_request?: unknown }>("GET", `/repos/${repo}/issues/${number}`, token);
    return issue.pull_request !== undefined && issue.pull_request !== null;
  }

  /** Resolves a PR to the metadata run creation needs. Deleted fork heads (`head.repo === null`) are an error. */
  async getPull(ref: GitHubRef, token: string | null): Promise<PullRequestInfo> {
    const pr = await this.request<{
      html_url: string;
      number: number;
      title: string;
      body: string | null;
      author_association: string;
      head: { sha: string; repo: { full_name: string } | null };
      base: { sha: string; repo: { full_name: string } };
    }>("GET", `/repos/${ref.repo}/pulls/${ref.number}`, token);
    if (pr.head.repo === null) throw new GitHubError(`Pull request ${ref.number} head repository was deleted`, 404);
    return {
      url: pr.html_url,
      // Canonical casing from GitHub, not the URL's (scheduler keys the per-repo cap on this).
      repo: pr.base.repo.full_name,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      untrustedSource: isUntrustedPullSource(pr.head.repo.full_name, pr.base.repo.full_name, pr.author_association),
    };
  }

  /** Opens a PR; a null `base` targets the repository's default branch. */
  async createPullRequest(token: string, pr: CreatePullRequest): Promise<CreatePullRequestResult> {
    const base =
      pr.base ?? (await this.request<{ default_branch: string }>("GET", `/repos/${pr.repo}`, token)).default_branch;
    const created = await this.request<{ html_url: string; number: number }>("POST", `/repos/${pr.repo}/pulls`, token, {
      title: pr.title,
      body: pr.body,
      head: pr.head,
      base,
      draft: pr.draft,
    });
    return { url: created.html_url, number: created.number };
  }

  async createCheckRun(token: string, repo: string, body: CreateCheckRun): Promise<{ id: number }> {
    const created = await this.request<{ id: number }>("POST", `/repos/${repo}/check-runs`, token, body);
    return { id: created.id };
  }

  async updateCheckRun(token: string, repo: string, checkRunId: number, body: UpdateCheckRun): Promise<void> {
    await this.request<unknown>("PATCH", `/repos/${repo}/check-runs/${checkRunId}`, token, body);
  }

  /**
   * Concatenates pages 1, 2, … of a paginated list until a short page. Hitting `MAX_CHECK_PAGES` full pages
   * throws: a status computed from a truncated list could miss the one failing check.
   */
  private async allPages<R, T>(fetchPage: (page: number) => Promise<R>, items: (res: R) => T[]): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= MAX_CHECK_PAGES; page++) {
      const batch = items(await fetchPage(page));
      all.push(...batch);
      if (batch.length < CHECKS_PER_PAGE) return all;
    }
    throw new GitHubError(`More than ${MAX_CHECK_PAGES * CHECKS_PER_PAGE} checks or statuses; cannot evaluate them all`, 0);
  }

  /** All files changed by a PR (paginated). */
  async listPullFiles(token: string, repo: string, number: number): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    for (let page = 1; page <= MAX_FILE_PAGES; page++) {
      const batch = await this.request<{ filename: string; patch?: string }[]>(
        "GET",
        `/repos/${repo}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`,
        token,
      );
      for (const f of batch) files.push(f.patch === undefined ? { filename: f.filename } : { filename: f.filename, patch: f.patch });
      if (batch.length < FILES_PER_PAGE) break;
    }
    return files;
  }

  /** Comments on an issue or pull request conversation (PRs share the issue comments API). */
  async createIssueComment(token: string, repo: string, number: number, body: string): Promise<CreateCommentResult> {
    const created = await this.request<{ html_url: string }>("POST", `/repos/${repo}/issues/${number}/comments`, token, { body });
    return { url: created.html_url };
  }

  /** Creates an issue; returns its html_url and number for the manager's issue ledger. */
  async createIssue(token: string, repo: string, issue: { title: string; body: string }): Promise<{ url: string; number: number }> {
    const created = await this.request<{ html_url: string; number: number }>("POST", `/repos/${repo}/issues`, token, issue);
    return { url: created.html_url, number: created.number };
  }

  async getDefaultBranch(token: string, repo: string): Promise<string> {
    const repoData = await this.request<{ default_branch: string }>("GET", `/repos/${repo}`, token);
    return repoData.default_branch;
  }

  /** Head sha of `branch`, or null when it does not exist (404). */
  async getBranchSha(token: string, repo: string, branch: string): Promise<string | null> {
    try {
      const ref = await this.request<{ object: { sha: string } }>(
        "GET",
        `/repos/${repo}/git/ref/heads/${encodeRefPath(branch)}`,
        token,
      );
      return ref.object.sha;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Creates `refs/heads/<branch>` at `sha`. GitHub's 422 "Reference already exists" is the expected
   * outcome of a concurrent creation (two workers ensuring the same integration branch) and resolves.
   */
  async createBranch(token: string, repo: string, branch: string, sha: string): Promise<void> {
    try {
      await this.request<unknown>("POST", `/repos/${repo}/git/refs`, token, { ref: `refs/heads/${branch}`, sha });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 422 && /already.?exist/i.test(err.message)) return;
      throw err;
    }
  }

  /** Full PR state plus check-run/commit-status aggregation for `head.sha`. */
  async getPullStatus(token: string, repo: string, number: number): Promise<PullStatus> {
    const pr = await this.request<{
      html_url: string;
      number: number;
      state: string;
      merged: boolean;
      draft: boolean;
      mergeable: boolean | null;
      mergeable_state: string;
      head: { ref: string; sha: string; repo: { full_name: string } | null };
      base: { ref: string; sha: string };
    }>("GET", `/repos/${repo}/pulls/${number}`, token);
    const sha = pr.head.sha;
    // Every page of both: one failing or pending check past the first page must not read as `success`.
    const [checkRuns, statuses] = await Promise.all([
      this.allPages(
        (page) =>
          this.request<{ check_runs: { name: string | null; conclusion: string | null; status: string }[] }>(
            "GET",
            `/repos/${repo}/commits/${sha}/check-runs?per_page=${CHECKS_PER_PAGE}&page=${page}`,
            token,
          ),
        (r) => r.check_runs,
      ),
      this.allPages(
        (page) =>
          this.request<{ statuses: { state: string; context: string }[] }>(
            "GET",
            `/repos/${repo}/commits/${sha}/status?per_page=${CHECKS_PER_PAGE}&page=${page}`,
            token,
          ),
        (r) => r.statuses,
      ),
    ]);

    const failing: string[] = [];
    const pending: string[] = [];
    let reported = false;
    for (const run of checkRuns) {
      const name = run.name ?? "check run";
      reported = true;
      if (run.status !== "completed") {
        pending.push(name);
        continue;
      }
      // `timed_out`, `action_required` and `startup_failure` (the CI never ran) block a merge as much as a plain failure.
      if (
        run.conclusion === "failure" ||
        run.conclusion === "cancelled" ||
        run.conclusion === "timed_out" ||
        run.conclusion === "action_required" ||
        run.conclusion === "startup_failure"
      ) {
        failing.push(name);
      }
    }
    for (const status of statuses) {
      reported = true;
      if (status.state === "failure" || status.state === "error") failing.push(status.context);
      else if (status.state === "pending") pending.push(status.context);
    }
    const checks: PullStatus["checks"] = failing.length
      ? { state: "failure", failing, pending: [] }
      : pending.length
        ? { state: "pending", failing: [], pending }
        : reported
          ? { state: "success", failing: [], pending: [] }
          : { state: "none", failing: [], pending: [] };

    return {
      url: pr.html_url,
      number: pr.number,
      state: pr.state === "open" ? "open" : "closed",
      merged: pr.merged,
      draft: pr.draft,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
      head: { ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo?.full_name ?? null },
      base: { ref: pr.base.ref, sha: pr.base.sha },
      checks,
    };
  }

  /**
   * Squash-merges a PR. GitHub rejects an unmergeable PR with 405 and a head sha that moved since
   * `sha` with 409; both surface as `GitHubError` with that status so the caller can re-read and retry.
   */
  async mergePullRequest(
    token: string,
    repo: string,
    number: number,
    opts: { method: "squash"; sha?: string; commitTitle?: string },
  ): Promise<{ sha: string }> {
    const res = await this.request<{ sha: string }>(
      "PUT",
      `/repos/${repo}/pulls/${number}/merge`,
      token,
      // GitHub merges PUT bodies with absent keys as omitted; only send what the caller chose.
      {
        merge_method: opts.method,
        ...(opts.sha !== undefined ? { sha: opts.sha } : {}),
        ...(opts.commitTitle !== undefined ? { commit_title: opts.commitTitle } : {}),
      },
    );
    return { sha: res.sha };
  }

  /** The open PR from `head` (branch in `repo`) into `base`, or null when there is none. */
  async findOpenPull(token: string, repo: string, head: string, base: string): Promise<{ number: number; url: string } | null> {
    // GitHub's `head` filter is `<owner>:<branch>`; with `owner/name:branch` it silently matches nothing.
    const owner = repo.split("/")[0]!;
    const open = await this.request<{ number: number; html_url: string }[]>(
      "GET",
      `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`,
      token,
    );
    const first = open[0];
    return first ? { number: first.number, url: first.html_url } : null;
  }

  /** `GET /user` with a user access token. */
  async getUser(token: string): Promise<{ id: number; login: string }> {
    const user = await this.request<{ id: number; login: string }>("GET", "/user", token);
    return { id: user.id, login: user.login };
  }

  /** The OAuth authorize URL on the GitHub site. */
  authorizeUrl(clientId: string, redirectUri: string, state: string): string {
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, allow_signup: "false" });
    return `${this.webBaseUrl}/login/oauth/authorize?${q}`;
  }

  /** Exchanges an OAuth callback `code` for a user access token. */
  async exchangeOAuthCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<string> {
    const res = await this.request<{ access_token?: string; error?: string; error_description?: string }>(
      "POST",
      `${this.webBaseUrl}/login/oauth/access_token`,
      null,
      { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri },
    );
    if (!res.access_token) throw new GitHubError(`OAuth code exchange failed: ${res.error_description ?? res.error ?? "no token"}`, 0);
    return res.access_token;
  }
}
