import { App } from "@octokit/app";
import { readFileSync } from "node:fs";
import type { GitHubConfig } from "../config";
import { GitHubError } from "./api";

/**
 * - `read`/`write`: contents + pull requests (+ issues read), for runners (checkout, push, PR creation).
 * - `report`: checks + pull requests write, for the server's own check-run reporting and pull request comments.
 * - `comment`: issues write, for `github_comment` steps on issues.
 */
export type TokenAccess = "read" | "write" | "report" | "comment";

export interface GitHubCredentials {
  /** True when `tokenFor` can produce a token. */
  readonly configured: boolean;
  /**
   * `installationId`, when known (webhook-triggered runs), skips the App installation lookup.
   * A repo the App is not installed on rejects with a 404 `GitHubError`.
   */
  tokenFor(repo: string, access: TokenAccess, installationId?: number): Promise<string>;
}

/** Personal access token: the same token for every repo and access level. */
export class PatCredentials implements GitHubCredentials {
  readonly configured = true;
  constructor(private readonly token: string) {}
  async tokenFor(): Promise<string> {
    return this.token;
  }
}

export class NoCredentials implements GitHubCredentials {
  readonly configured = false;
  async tokenFor(): Promise<string> {
    throw new Error("GitHub credentials not configured");
  }
}

const PERMISSIONS: Record<TokenAccess, Record<string, "read" | "write">> = {
  read: { contents: "read", pull_requests: "read", issues: "read" },
  write: { contents: "write", pull_requests: "write", issues: "read" },
  report: { checks: "write", pull_requests: "write" },
  comment: { issues: "write" },
};

/** Tokens are reused until this long before `expires_at`. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export interface AppCredentialsOptions {
  appId: number;
  privateKey: string;
  apiBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** GitHub App installation tokens, scoped to one repository and the permissions of the requested access. */
export class AppCredentials implements GitHubCredentials {
  readonly configured = true;
  private readonly app: App;
  private readonly installations = new Map<string, number>();
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly opts: AppCredentialsOptions) {
    this.app = new App({ appId: opts.appId, privateKey: opts.privateKey });
  }

  private requestOptions() {
    return { baseUrl: this.opts.apiBaseUrl, request: { fetch: this.opts.fetch ?? fetch } };
  }

  private async installationFor(repo: string): Promise<number> {
    const key = repo.toLowerCase();
    const cached = this.installations.get(key);
    if (cached !== undefined) return cached;
    const [owner, name] = repo.split("/") as [string, string];
    let id: number;
    try {
      const res = await this.app.octokit.request("GET /repos/{owner}/{repo}/installation", {
        owner,
        repo: name,
        ...this.requestOptions(),
      });
      id = res.data.id;
    } catch (err) {
      // An input problem (the user named a repo the App cannot see), unlike other lookup failures.
      if (err instanceof Error && "status" in err && err.status === 404) throw new GitHubError(`GitHub App is not installed on ${repo}`, 404);
      throw err;
    }
    this.installations.set(key, id);
    return id;
  }

  async tokenFor(repo: string, access: TokenAccess, installationId?: number): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    const id = installationId ?? (await this.installationFor(repo));
    const key = `${id}:${repo.toLowerCase()}:${access}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) return cached.token;
    const name = repo.split("/")[1]!;
    let data: { token: string; expires_at: string };
    try {
      const res = await this.app.octokit.request("POST /app/installations/{installation_id}/access_tokens", {
        installation_id: id,
        repositories: [name],
        permissions: PERMISSIONS[access],
        ...this.requestOptions(),
      });
      data = res.data;
    } catch (err) {
      // A stale cached installation (App reinstalled) is looked up afresh next time.
      if (installationId === undefined) this.installations.delete(repo.toLowerCase());
      throw err;
    }
    this.tokens.set(key, { token: data.token, expiresAt: Date.parse(data.expires_at) });
    return data.token;
  }
}

export function credentialsFromConfig(github: GitHubConfig | null, fetchFn?: typeof fetch): GitHubCredentials {
  if (github === null) return new NoCredentials();
  switch (github.kind) {
    case "pat":
      return new PatCredentials(github.token);
    case "app":
      return new AppCredentials({
        appId: github.appId,
        privateKey: readFileSync(github.privateKeyPath, "utf8"),
        apiBaseUrl: github.apiBaseUrl,
        ...(fetchFn ? { fetch: fetchFn } : {}),
      });
  }
}
