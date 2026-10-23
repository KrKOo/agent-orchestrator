import type { CreatePullRequestResult, GitHubIssueInput } from "@orch/protocol";

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

/** Minimal GitHub REST client (no Octokit in M1). */
export class GitHubApi {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = "https://api.github.com",
  ) {}

  private async request<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
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
        const j = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
        detail = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join("; ") || detail;
      } catch {}
      throw new GitHubError(`GitHub ${method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
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
}
