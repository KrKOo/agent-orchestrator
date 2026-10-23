import type {
  ApiError,
  Catalog,
  ElicitationAction,
  FlowDefinitionInput,
  FlowRow,
  FsListResult,
  RunDetail,
  RunEvent,
  RunnerRow,
  RunRow,
} from "@orch/protocol";

/** Non-2xx response; `errors` carries flow validation messages (HTTP 400). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors: string[] = [],
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) {
    const err = (data ?? {}) as ApiError;
    const errors = err.errors ?? [];
    throw new ApiRequestError(res.status, err.error ?? errors[0] ?? `${res.status} ${res.statusText || "error"}`, errors);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  listFlows: () => request<FlowRow[]>("GET", "/api/flows"),
  getFlow: (id: string) => request<FlowRow>("GET", `/api/flows/${enc(id)}`),
  createFlow: (def: FlowDefinitionInput) => request<FlowRow>("POST", "/api/flows", def),
  updateFlow: (id: string, def: FlowDefinitionInput) => request<FlowRow>("PUT", `/api/flows/${enc(id)}`, def),
  deleteFlow: (id: string) => request<void>("DELETE", `/api/flows/${enc(id)}`),
  startRun: (flowId: string, inputs: Record<string, string>) =>
    request<RunRow>("POST", `/api/flows/${enc(flowId)}/runs`, { inputs }),

  listRuns: (flowId?: string) => request<RunRow[]>("GET", `/api/runs${flowId ? `?flowId=${enc(flowId)}` : ""}`),
  getRun: (id: string) => request<RunDetail>("GET", `/api/runs/${enc(id)}`),
  getRunEvents: (id: string, afterSeq = 0) =>
    request<RunEvent[]>("GET", `/api/runs/${enc(id)}/events?afterSeq=${afterSeq}`),
  cancelRun: (id: string) => request<{ ok: true }>("POST", `/api/runs/${enc(id)}/cancel`),
  respondPermission: (runId: string, requestId: string, optionId: string | null) =>
    request<{ ok: true }>("POST", `/api/runs/${enc(runId)}/permissions/${enc(requestId)}`, { optionId }),
  respondElicitation: (
    runId: string,
    requestId: string,
    action: ElicitationAction,
    content?: Record<string, unknown>,
  ) => request<{ ok: true }>("POST", `/api/runs/${enc(runId)}/elicitations/${enc(requestId)}`, { action, content }),

  listRunners: () => request<RunnerRow[]>("GET", "/api/runners"),
  listFs: (runnerId: string, path: string) =>
    request<FsListResult>("GET", `/api/runners/${enc(runnerId)}/fs?path=${enc(path)}`),
  catalog: () => request<Catalog>("GET", "/api/catalog"),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
