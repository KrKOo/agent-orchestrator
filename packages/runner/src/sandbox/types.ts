import type { NetworkPolicy } from "@orch/protocol";

/** Bind mount; sandboxes mount host paths at `containerPath` (usually the identical path). */
export interface Mount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface SandboxFile {
  /** Relative path under the sandbox config dir (mounted at `/orch/config`). */
  path: string;
  content: string;
}

export interface CreateSandbox {
  runId: string;
  image: string;
  mounts: Mount[];
  files: SandboxFile[];
  env: Record<string, string>;
  network: NetworkPolicy;
  cpus: number;
  memoryMb: number;
}

export interface SandboxProcess {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

export interface Sandbox {
  exec(argv: string[], cwd: string): SandboxProcess;
  /** Idempotent; removes every resource the sandbox created. */
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  id: "docker";
  create(spec: CreateSandbox): Promise<Sandbox>;
}

/** Wraps a Bun `FileSink` (spawn stdin) as a web `WritableStream`. */
export function sinkToWritable(sink: { write(chunk: Uint8Array): unknown; flush(): unknown; end(): unknown }): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk);
      await sink.flush();
    },
    async close() {
      await sink.end();
    },
    async abort() {
      try {
        await sink.end();
      } catch {
        // already closed
      }
    },
  });
}

/** Mount order for `docker run`: parents before children so nested overlays apply. */
export function sortMountsByDepth(mounts: Mount[]): Mount[] {
  const depth = (p: string) => p.split("/").filter(Boolean).length;
  return [...mounts].sort((a, b) => depth(a.containerPath) - depth(b.containerPath));
}
