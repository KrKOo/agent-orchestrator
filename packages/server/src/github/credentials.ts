import type { GitHubConfig } from "../config";

export interface GitHubCredentials {
  /** True when `tokenFor` can produce a token. */
  readonly configured: boolean;
  tokenFor(repo: string, access: "read" | "write"): Promise<string>;
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

export function credentialsFromConfig(github: GitHubConfig | null): GitHubCredentials {
  if (github === null) return new NoCredentials();
  switch (github.kind) {
    case "pat":
      return new PatCredentials(github.token);
  }
}
