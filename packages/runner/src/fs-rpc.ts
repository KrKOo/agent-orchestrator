import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { FsListResult } from "@orch/protocol";

/** True when `path` equals `root` or lies beneath it (both already realpath'd). */
export function isWithinRoot(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Lists subdirectories of `path` for the UI path picker. `""` lists the allowed roots themselves.
 * The path is realpath'd and must stay inside some allowed root.
 */
export async function fsList(path: string, allowedRoots: string[]): Promise<FsListResult> {
  if (path === "") {
    return {
      path: "",
      entries: allowedRoots.map((root) => ({
        name: root,
        path: root,
        isDir: true as const,
        isGitRepo: existsSync(join(root, ".git")),
      })),
    };
  }

  let real: string;
  try {
    real = await realpath(path);
  } catch {
    // Do not reveal existence of paths outside the roots.
    if (!allowedRoots.some((root) => isWithinRoot(resolve(path), root))) throw new Error("Path outside allowedRoots");
    throw new Error(`No such directory: ${path}`);
  }
  if (!allowedRoots.some((root) => isWithinRoot(real, root))) throw new Error("Path outside allowedRoots");
  if (!(await stat(real)).isDirectory()) throw new Error(`Not a directory: ${path}`);

  const entries: FsListResult["entries"] = [];
  for (const dirent of await readdir(real, { withFileTypes: true })) {
    if (dirent.name.startsWith(".")) continue;
    const entryPath = join(real, dirent.name);
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = (await stat(entryPath)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    entries.push({ name: dirent.name, path: entryPath, isDir: true, isGitRepo: existsSync(join(entryPath, ".git")) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { path: real, entries };
}
