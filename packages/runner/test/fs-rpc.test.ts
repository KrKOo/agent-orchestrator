import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsList } from "../src/fs-rpc";

let root: string;
let outside: string;

beforeAll(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "fsrpc-")));
  root = join(base, "root");
  outside = join(base, "outside");
  mkdirSync(join(root, "repo", ".git"), { recursive: true });
  mkdirSync(join(root, "plain", "nested"), { recursive: true });
  mkdirSync(join(root, ".hidden"), { recursive: true });
  writeFileSync(join(root, "file.txt"), "x");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(root, "escape"));
});

afterAll(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("fsList", () => {
  test("rejects a path escaping the root via ..", async () => {
    await expect(fsList("/Users/krkoo/Documents/../..", ["/Users/krkoo/Documents"])).rejects.toThrow(
      "Path outside allowedRoots",
    );
    await expect(fsList(join(root, "..", ".."), [root])).rejects.toThrow("Path outside allowedRoots");
  });

  test("rejects a symlink that resolves outside the root", async () => {
    await expect(fsList(join(root, "escape"), [root])).rejects.toThrow("Path outside allowedRoots");
  });

  test("does not reveal missing paths outside the roots", async () => {
    await expect(fsList(join(root, "..", "nope"), [root])).rejects.toThrow("Path outside allowedRoots");
    await expect(fsList(join(root, "nope"), [root])).rejects.toThrow("No such directory");
  });

  test("empty path lists the allowed roots", async () => {
    const res = await fsList("", [root, join(root, "repo")]);
    expect(res).toEqual({
      path: "",
      entries: [
        { name: root, path: root, isDir: true, isGitRepo: false },
        { name: join(root, "repo"), path: join(root, "repo"), isDir: true, isGitRepo: true },
      ],
    });
  });

  test("lists only non-dot directories and flags git repos", async () => {
    const res = await fsList(root, [root]);
    expect(res.path).toBe(root);
    // `escape` is a symlink to a directory: listed, but navigating into it is rejected.
    expect(res.entries).toEqual([
      { name: "escape", path: join(root, "escape"), isDir: true, isGitRepo: false },
      { name: "plain", path: join(root, "plain"), isDir: true, isGitRepo: false },
      { name: "repo", path: join(root, "repo"), isDir: true, isGitRepo: true },
    ]);
  });

  test("lists a nested directory", async () => {
    const res = await fsList(join(root, "plain"), [root]);
    expect(res.entries.map((e) => e.name)).toEqual(["nested"]);
  });

  test("rejects a file path", async () => {
    await expect(fsList(join(root, "file.txt"), [root])).rejects.toThrow("Not a directory");
  });
});
