import { useQuery } from "@tanstack/react-query";
import { api, errorMessage } from "../api";
import { Collapsible, formatTime } from "../ui";

export function Runners() {
  const runners = useQuery({ queryKey: ["runners"], queryFn: api.listRunners, refetchInterval: 5000 });

  return (
    <div className="page">
      <div className="page-header">
        <h2>Runners</h2>
      </div>
      {runners.error && <p className="error">{errorMessage(runners.error)}</p>}
      {runners.data && runners.data.length === 0 && (
        <p className="muted">
          No runners registered. Create a token with{" "}
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
