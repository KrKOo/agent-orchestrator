#!/usr/bin/env bun
// Builds orch/sandbox-omp:latest and orch/egress:latest.
import { join } from "node:path";

const BASE = "https://build.stencil.so";
const root = join(import.meta.dir, "..");

function fail(msg: string): never {
  console.error(`build-images: ${msg}`);
  process.exit(1);
}

const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : fail(`Unsupported arch: ${process.arch}`);

interface BuildFile { name: string; url: string; sha256: string }

async function resolveOmp(): Promise<{ url: string; sha256: string; version?: string }> {
  const api = `${BASE}/api/products/omp/latest/linux-${arch}?channel=stable`;
  let res: Response;
  try {
    res = await fetch(api);
  } catch (err) {
    fail(`Failed to query ${api}: ${(err as Error).message}`);
  }
  if (!res.ok) fail(`${api} returned HTTP ${res.status}`);
  const body = (await res.json()) as { build?: { version?: string; files?: BuildFile[] } };
  const want = `omp-linux-${arch}`;
  const file = body.build?.files?.find((f) => f.name === want);
  if (!file?.url || !file.sha256) fail(`No ${want} file in ${api} response`);
  return { url: BASE + file.url, sha256: file.sha256, version: body.build?.version };
}

async function docker(args: string[]): Promise<void> {
  console.log(`$ docker ${args.join(" ")}`);
  const proc = Bun.spawn(["docker", ...args], { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
  const code = await proc.exited;
  if (code !== 0) fail(`docker ${args[0]} exited with code ${code}`);
}

const omp = await resolveOmp();
console.log(`omp ${omp.version ?? "?"} linux-${arch}: ${omp.url}`);
await docker([
  "build",
  "--build-arg", `OMP_URL=${omp.url}`,
  "--build-arg", `OMP_SHA256=${omp.sha256}`,
  "-t", "orch/sandbox-omp:latest",
  "docker/sandbox-omp",
]);
await docker(["build", "-t", "orch/egress:latest", "docker/egress"]);
console.log("Built orch/sandbox-omp:latest and orch/egress:latest");
