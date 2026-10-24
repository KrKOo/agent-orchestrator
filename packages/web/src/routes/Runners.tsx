import type { CreateRunnerTokenResponse } from "@orch/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Collapsible, CopyButton, formatTime } from "../ui";

export function Runners() {
  const runners = useQuery({ queryKey: ["runners"], queryFn: api.listRunners, refetchInterval: 5000 });

  return (
    <div className="page">
      <div className="page-header">
        <h2>Runners</h2>
      </div>
      <CreateRunnerToken />
      {runners.error && <p className="error">{errorMessage(runners.error)}</p>}
      {runners.data && runners.data.length === 0 && (
        <p className="muted">
          No runners registered. Create a token above, or on the server host with{" "}
          <code>bun packages/server/src/main.ts runner-token create --name laptop</code>.
        </p>
      )}
      {runners.data && runners.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>State</th>
              <th>Name</th>
              <th>Labels</th>
              <th>Allowed roots</th>
              <th>Jobs</th>
              <th>Harnesses</th>
              <th>Skills / commands</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {runners.data.map((r) => {
              const caps = r.capabilities;
              return (
                <tr key={r.id}>
                  <td>
                    <span className={`dot ${r.online ? "dot-on" : "dot-off"}`} /> {r.online ? "online" : "offline"}
                  </td>
                  <td>
                    {r.name}
                    <div className="mono small muted">{r.id}</div>
                  </td>
                  <td>
                    {(caps?.labels ?? r.labels).map((l) => (
                      <span key={l} className="tag">
                        {l}
                      </span>
                    ))}
                  </td>
                  <td className="mono small">
                    {caps?.allowedRoots.map((p) => (
                      <div key={p}>{p}</div>
                    )) ?? "—"}
                  </td>
                  <td>
                    {r.runningJobs}/{caps?.maxConcurrentJobs ?? "?"}
                  </td>
                  <td className="small">{caps?.harnesses.map((h) => `${h.id} ${h.version}`).join(", ") ?? "—"}</td>
                  <td>
                    {caps ? (
                      <Collapsible summary={`${caps.skills.length} skills · ${caps.commands.length} commands`}>
                        <CatalogList title="Skills" items={caps.skills} />
                        <CatalogList title="Commands" items={caps.commands} />
                      </Collapsible>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{formatTime(r.lastSeenAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CatalogList({ title, items }: { title: string; items: { name: string; description: string }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="catalog-list">
      <strong>{title}</strong>
      <ul>
        {items.map((i) => (
          <li key={i.name}>
            <span className="mono">{i.name}</span> <span className="muted small">{i.description}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** WebSocket URL runners connect to, derived from the page origin (the UI is served by the server). */
function runnerServerUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/runner/ws`;
}

function parseLabels(text: string): string[] {
  return text
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
}

function CreateRunnerToken() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("");
  const [created, setCreated] = useState<(CreateRunnerTokenResponse & { labels: string[] }) | null>(null);
  const create = useMutation({
    mutationFn: (vars: { name: string; labels: string[] }) => api.createRunnerToken(vars.name, vars.labels),
    onSuccess: (res, vars) => {
      setCreated({ ...res, labels: vars.labels });
      setName("");
      setLabels("");
      qc.invalidateQueries({ queryKey: ["runners"] });
    },
  });
  const submit = () => {
    if (name.trim()) create.mutate({ name: name.trim(), labels: parseLabels(labels) });
  };

  const snippet =
    created &&
    JSON.stringify(
      {
        serverUrl: runnerServerUrl(),
        runnerId: created.runnerId,
        token: created.token,
        labels: created.labels,
        allowedRoots: [],
      },
      null,
      2,
    );

  return (
    <div className="token-panel">
      <form
        className="row gap wrap token-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <strong>Create runner token</strong>
        <input aria-label="Runner name" placeholder="name, e.g. laptop" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          aria-label="Runner labels"
          placeholder="labels, comma separated"
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={!name.trim() || create.isPending}>
          {create.isPending ? "Creating…" : "Create token"}
        </button>
      </form>
      {create.error && <p className="error">{errorMessage(create.error)}</p>}
      {created && snippet && (
        <div className="token-result">
          <p className="small">
            Runner <span className="mono">{created.runnerId}</span> created. The token is shown only once; store it
            now.
          </p>
          <CopyField label="Runner id" value={created.runnerId} />
          <CopyField label="Token" value={created.token} />
          <div className="field">
            <span>
              <code>~/.agent-orchestrator/runner.json</code> (add your <code>allowedRoots</code>)
            </span>
            <pre className="mono token-snippet">{snippet}</pre>
            <div className="row gap">
              <CopyButton value={snippet} />
              <button type="button" className="btn small" onClick={() => setCreated(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="row gap">
        <input className="mono grow" readOnly value={value} onFocus={(e) => e.target.select()} />
        <CopyButton value={value} />
      </div>
    </div>
  );
}

