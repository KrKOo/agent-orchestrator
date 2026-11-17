import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { THEME_COOKIE, type ThemesResponse } from "@orch/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/app";
import { parseServerConfig } from "../src/config";
import { testDeps } from "./helpers";

let root: string;
let builtin: string;
let custom: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "themes-"));
  builtin = join(root, "builtin");
  custom = join(root, "custom");
  mkdirSync(builtin);
  mkdirSync(custom);
  // Outside both theme folders: must never be served.
  writeFileSync(join(root, "secret.css"), "SECRET");
  writeFileSync(join(builtin, "light.css"), "builtin-light");
  writeFileSync(join(builtin, "dark.css"), "builtin-dark");
  writeFileSync(join(custom, "dark.css"), "custom-dark");
  writeFileSync(join(custom, "brand.css"), "brand");
  writeFileSync(join(custom, "notes.md"), "not a theme");
  writeFileSync(join(custom, "bad name.css"), "invalid name");
  mkdirSync(join(custom, "dir.css"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function themeApp(ui: Record<string, unknown> = {}): Hono {
  return createApp(testDeps({ builtinThemesDir: builtin, config: { ui: { themesDir: custom, ...ui } } }));
}

async function themeCss(app: Hono, cookie?: string): Promise<string> {
  const res = await app.request("/theme.css", cookie === undefined ? {} : { headers: { Cookie: `${THEME_COOKIE}=${cookie}` } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("text/css");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(res.headers.get("vary")).toBe("Cookie");
  return res.text();
}

describe("/theme.css", () => {
  test("no cookie and no default: empty stylesheet (built-in styles)", async () => {
    expect(await themeCss(themeApp())).toBe("");
  });

  test("serves the configured default; a valid cookie beats it", async () => {
    const app = themeApp({ theme: "brand" });
    expect(await themeCss(app)).toBe("brand");
    expect(await themeCss(app, "light")).toBe("builtin-light");
  });

  test("a custom theme replaces the built-in of the same name", async () => {
    expect(await themeCss(themeApp(), "dark")).toBe("custom-dark");
  });

  test("unknown or malformed cookie falls back to the default without leaving the theme folders", async () => {
    const app = themeApp({ theme: "brand" });
    for (const cookie of ["missing", "../secret", "..%2Fsecret", "a/b", "", "bad name", "notes", "dir"]) {
      expect(await themeCss(app, cookie)).toBe("brand");
    }
    expect(await themeCss(themeApp(), "../secret")).toBe("");
  });

  test("a default theme removed after startup falls back to built-in styles", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const app = themeApp({ theme: "brand" });
      rmSync(join(custom, "brand.css"));
      expect(await themeCss(app)).toBe("");
      expect(warn).toHaveBeenCalled();
      const res = await app.request("/api/themes");
      expect(((await res.json()) as ThemesResponse).defaultTheme).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("/api/themes", () => {
  test("lists built-in and custom themes merged and sorted, with the default", async () => {
    const res = await themeApp({ theme: "dark" }).request("/api/themes");
    expect(res.status).toBe(200);
    expect((await res.json()) as ThemesResponse).toEqual({ themes: ["brand", "dark", "light"], defaultTheme: "dark" });
  });

  test("picks up a theme dropped in after startup", async () => {
    const app = themeApp();
    writeFileSync(join(custom, "late.css"), "late");
    const res = await app.request("/api/themes");
    expect(((await res.json()) as ThemesResponse).themes).toContain("late");
    expect(await themeCss(app, "late")).toBe("late");
  });

  test("requires a session in GitHub auth mode; /theme.css stays public", async () => {
    const deps = testDeps({
      builtinThemesDir: builtin,
      credentials: { configured: false, tokenFor: async () => "x" },
      config: {
        publicUrl: "https://orch.example.com",
        auth: { mode: "github", allowedLogins: ["alice"], sessionSecret: "s".repeat(40) },
        github: { kind: "app", appId: 1, privateKeyPath: "/nonexistent.pem", clientId: "c", clientSecret: "s", webhookSecret: "w" },
        ui: { theme: "light" },
      },
    });
    const app = createApp(deps);
    expect((await app.request("/api/themes")).status).toBe(401);
    expect(await themeCss(app)).toBe("builtin-light");
  });
});

describe("ui config", () => {
  test("themesDir resolves against the config file's directory; defaults are null", () => {
    expect(parseServerConfig({ ui: { themesDir: "themes" } }, "/etc/orch").ui).toEqual({ theme: null, themesDir: "/etc/orch/themes" });
    expect(parseServerConfig({}, "/etc/orch").ui).toEqual({ theme: null, themesDir: null });
  });

  test("rejects theme names that are not plain file names", () => {
    for (const theme of ["../x", "a/b", "", "-x", "a.b", "x".repeat(65)]) {
      expect(() => parseServerConfig({ ui: { theme } }, "/")).toThrow(/Invalid server config: ui\.theme/);
    }
    expect(parseServerConfig({ ui: { theme: "Corp_dark-2" } }, "/").ui.theme).toBe("Corp_dark-2");
  });
});
