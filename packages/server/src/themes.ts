import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { THEME_NAME } from "./config";

const EXT = ".css";

/**
 * Theme stylesheets: `<name>.css` in the built-in directory (`packages/web/themes`) and the optional admin
 * directory (`ui.themesDir`). Both are read on every call, so a dropped-in file shows up on the next page
 * load without a restart. A custom theme replaces a built-in of the same name.
 */
export class ThemeStore {
  /** Lookup order: custom first, so it shadows a built-in. */
  readonly dirs: readonly string[];

  constructor(builtinDir: string, customDir: string | null) {
    this.dirs = customDir === null ? [builtinDir] : [customDir, builtinDir];
  }

  /** Theme names from both directories, deduped and sorted. */
  list(): string[] {
    const names = new Set<string>();
    for (const dir of this.dirs) {
      for (const name of listDir(dir)) {
        if (!name.endsWith(EXT)) continue;
        const theme = name.slice(0, -EXT.length);
        if (THEME_NAME.test(theme) && isFile(join(dir, name))) names.add(theme);
      }
    }
    return [...names].sort();
  }

  /** Absolute path of the theme's stylesheet; null if the name is invalid or no directory has it. */
  resolve(name: string): string | null {
    // Checked before any path is built: the pattern admits no separators or dots, so no traversal.
    if (!THEME_NAME.test(name)) return null;
    for (const dir of this.dirs) {
      const file = join(dir, name + EXT);
      if (isFile(file)) return file;
    }
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
