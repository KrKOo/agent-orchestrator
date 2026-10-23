import type { CreatePullRequestResult, GitHubIssueInput } from "@orch/protocol";
import type { CheckAnnotation, CheckConclusion } from "./report";
import type { ChangedFile } from "./review";

export const ISSUE_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/;

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

export interface CreateReview {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: { path: string; line: number; side: "RIGHT"; body: string }[];
}

/** Upper bound on `GET /pulls/{n}/files` pages (GitHub lists at most 3000 files). */
const MAX_FILE_PAGES = 30;
const FILES_PER_PAGE = 100;

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

  /** Resolves an issue URL; `token` null fetches unauthenticated. */
  async getIssue(url: string, token: string | null): Promise<GitHubIssueInput> {
    const m = ISSUE_URL_RE.exec(url.trim());
    if (!m) throw new GitHubError("Invalid GitHub issue URL", 0);
    const [, owner, name, num] = m;
    const issue = await this.request<{ html_url: string; number: number; title: string; body: string | null }>(
      "GET",
      `/repos/${owner}/${name}/issues/${num}`,
      token,
    );
    return { url: issue.html_url, repo: `${owner}/${name}`, number: issue.number, title: issue.title, body: issue.body ?? "" };
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

  async createReview(token: string, repo: string, number: number, review: CreateReview): Promise<void> {
    await this.request<unknown>("POST", `/repos/${repo}/pulls/${number}/reviews`, token, review);
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
