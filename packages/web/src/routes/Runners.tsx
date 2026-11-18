// Runners: a responsive card grid. Token creation lives in a modal; the token is shown once there.
import type { CreateRunnerTokenResponse } from "@orch/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Server } from "lucide-react";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Collapsible, CopyButton, EmptyState, Modal, PageHeader, RelativeTime, Skeleton, usePageTitle } from "../ui";
import { useToast } from "../components/Toast";

export function Runners() {
  usePageTitle("Runners");
  const [adding, setAdding] = useState(false);
  const runners = useQuery({ queryKey: ["runners"], queryFn: api.listRunners, refetchInterval: 5000 });

  return (
    <div className="page">
      <PageHeader
        title="Runners"
        subtitle="Worker hosts that execute runs in sandboxes. Create a token to connect a new one."
        actions={
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            <Plus size={15} aria-hidden />
            Add runner
          </button>
        }
      />
      {adding && <AddRunnerModal onClose={() => setAdding(false)} />}
      {runners.isPending ? (
        <Skeleton rows={3} />
      ) : runners.error && !runners.data ? (
        <p className="error">{errorMessage(runners.error)}</p>
      ) : !runners.data || runners.data.length === 0 ? (
        <EmptyState
          icon={<Server size={32} />}
          title="No runners registered"
          action={
            <button type="button" className="btn primary" onClick={() => setAdding(true)}>
              Add runner
            </button>
          }
        >
          A runner executes runs. Create a token here, or on the server host with{" "}
          <code>bun packages/server/src/main.ts runner-token create --name laptop</code>.
        </EmptyState>
      ) : (
        <div className="runner-grid">
          {runners.data.map((r) => {
            const caps = r.capabilities;
            return (
              <div key={r.id} className="runner-card">
                <div className="runner-card-head">
                  <span className={`runner-state ${r.online ? "on" : "off"}`}>
                    <span className={`dot ${r.online ? "dot-on" : "dot-off"}`} aria-hidden />
                    {r.online ? "online" : "offline"}
                  </span>
                  <div className="runner-name">
                    <strong>{r.name}</strong>
                    <div className="mono small muted">{r.id}</div>
                  </div>
                </div>
                <div className="runner-facts">
                  <div className="runner-fact">
                    <span className="runner-fact-label">Last seen</span>
                    <RelativeTime ts={r.lastSeenAt} />
                  </div>
                  <div className="runner-fact">
                    <span className="runner-fact-label">Labels</span>
                    <span className="runner-tags">
                      {(caps?.labels ?? r.labels).map((l) => (
                        <span key={l} className="tag">
                          {l}
                        </span>
                      ))}
                      {(caps?.labels ?? r.labels).length === 0 && <span className="muted">—</span>}
                    </span>
                  </div>
                  <div className="runner-fact">
                    <span className="runner-fact-label">Harnesses</span>
                    <span className="small">{caps?.harnesses.map((h) => `${h.id} ${h.version}`).join(", ") || "—"}</span>
                  </div>
                  <div className="runner-fact">
                    <span className="runner-fact-label">Allowed roots</span>
                    <span className="mono small">
                      {caps?.allowedRoots.length ? caps.allowedRoots.join(", ") : "—"}
                    </span>
                  </div>
                </div>
                <JobsGauge running={r.runningJobs} max={caps?.maxConcurrentJobs ?? null} />
                {caps && (
                  <Collapsible summary={`${caps.skills.length} skills · ${caps.commands.length} commands`}>
                    <CatalogList title="Skills" items={caps.skills} />
                    <CatalogList title="Commands" items={caps.commands} />
                  </Collapsible>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** running/max as a labeled bar; announced to screen readers as a meter. */
function JobsGauge({ running, max }: { running: number; max: number | null }) {
  const pct = max && max > 0 ? Math.min(100, Math.round((running / max) * 100)) : 0;
  return (
    <div className="runner-jobs">
      <span className="runner-fact-label">Jobs</span>
      <span
        className="runner-jobs-bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={max ?? 0}
        aria-valuenow={running}
        aria-label={`Running ${running} of ${max ?? "?"} max jobs`}
      >
        <span className="runner-jobs-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="mono small">
        {running}/{max ?? "?"}
      </span>
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

function AddRunnerModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [labels, setLabels] = useState("");
  const [created, setCreated] = useState<(CreateRunnerTokenResponse & { labels: string[] }) | null>(null);
  const create = useMutation({
    mutationFn: (vars: { name: string; labels: string[] }) => api.createRunnerToken(vars.name, vars.labels),
    onSuccess: (res, vars) => {
      setCreated({ ...res, labels: vars.labels });
      setName("");
      setLabels("");
      toast("Runner token created", { kind: "success" });
      qc.invalidateQueries({ queryKey: ["runners"] });
    },
  });

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
    <Modal
      title={created ? "Runner token created" : "Add runner"}
      // Once the one-time token is on screen only "Done" closes: no Escape, backdrop click or X that could lose it.
      onClose={created ? undefined : onClose}
      wide
      footer={
        created ? (
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              form="add-runner-form"
              className="btn primary"
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create token"}
            </button>
          </>
        )
      }
    >
      {created && snippet ? (
        <div className="token-result">
          <p className="small">
            Runner <span className="mono">{created.runnerId}</span> created. The token is shown only once; store it now.
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
            </div>
          </div>
        </div>
      ) : (
        <form
          id="add-runner-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate({ name: name.trim(), labels: parseLabels(labels) });
          }}
        >
          <label className="field">
            Name
            <input
              autoFocus
              placeholder="name, e.g. laptop"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            Labels
            <input
              placeholder="labels, comma separated"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
            />
          </label>
          {create.error && (
            <p className="error" role="alert">
              {errorMessage(create.error)}
            </p>
          )}
        </form>
      )}
    </Modal>
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
