import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Library, parseFrontmatter } from "../src/library";

let base: string;
let skillsA: string;
let skillsB: string;
let commands: string;

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "library-"));
  skillsA = join(base, "skillsA");
  skillsB = join(base, "skillsB");
  commands = join(base, "commands");
  write(join(skillsA, "review", "SKILL.md"), '---\nname: review\ndescription: "Review code"\n---\nReview body\n');
  write(join(skillsA, "nofm", "SKILL.md"), "Just a body\n");
  write(join(skillsB, "review", "SKILL.md"), "---\nname: review\ndescription: duplicate\n---\nOther\n");
  write(
    join(skillsB, "folded", "SKILL.md"),
    "---\nname: sec\ndescription: >\n  Security review\n  of changes\n---\nSec body\n",
  );
  mkdirSync(join(skillsB, "empty-dir"), { recursive: true });
  write(join(commands, "commit-msg.md"), "\nWrite a conventional commit message.\n\nArgs: $ARGUMENTS\n");
  write(join(commands, "pr.md"), "---\ndescription: PR description\n---\nDescribe $ARGUMENTS\n");
  write(join(commands, "notes.txt"), "ignored");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  test("parses quoted values and literal block scalars", () => {
    expect(parseFrontmatter("---\na: 'x: y'\nb: |\n  l1\n  l2\n---\nbody")).toEqual({
      attrs: { a: "x: y", b: "l1\nl2" },
      body: "body",
    });
  });
  test("no frontmatter returns the whole text", () => {
    expect(parseFrontmatter("hello\n---\n")).toEqual({ attrs: {}, body: "hello\n---\n" });
  });
});

describe("Library", () => {
  test("scans skills and commands with first-dir-wins and fallbacks", async () => {
    const lib = new Library([skillsA, skillsB, join(base, "missing")], [commands]);
    expect(await lib.scan()).toBe(true);
    expect(lib.catalog()).toEqual({
      skills: [
        { name: "nofm", description: "" },
        { name: "review", description: "Review code" },
        { name: "sec", description: "Security review of changes" },
      ],
      commands: [
        { name: "commit-msg", description: "Write a conventional commit message." },
        { name: "pr", description: "PR description" },
      ],
    });
    const review = lib.getSkill("review");
    expect(review.dir).toBe(join(skillsA, "review"));
    expect(review.body).toBe("Review body\n");
    expect(lib.getCommand("pr").body).toBe("Describe $ARGUMENTS\n");
    expect(() => lib.getSkill("nope")).toThrow("Unknown skill: nope");
    expect(() => lib.getCommand("nope")).toThrow("Unknown command: nope");
  });

  test("scan reports changes only when the catalog changes", async () => {
    const lib = new Library([skillsA], [commands]);
    expect(await lib.scan()).toBe(true);
    expect(await lib.scan()).toBe(false);
    write(join(skillsA, "added", "SKILL.md"), "---\ndescription: new\n---\n");
    expect(await lib.scan()).toBe(true);
    expect(lib.getSkill("added").description).toBe("new");
  });
});
