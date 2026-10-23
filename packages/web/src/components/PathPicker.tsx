import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Modal } from "../ui";

/** Browses directories on an online runner (`fs.list` relayed by the server) and picks one. */
export function PathPicker({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const runners = useQuery({ queryKey: ["runners"], queryFn: api.listRunners });
  const online = (runners.data ?? []).filter((r) => r.online);
  const [runnerId, setRunnerId] = useState<string | null>(null);
  const activeRunner = runnerId ?? online[0]?.id ?? null;
  const roots = online.find((r) => r.id === activeRunner)?.capabilities?.allowedRoots ?? [];
  const [path, setPath] = useState(initialPath.startsWith("/") ? initialPath : "");

  const listing = useQuery({
    queryKey: ["fs", activeRunner, path],
    queryFn: () => api.listFs(activeRunner!, path),
    enabled: activeRunner !== null,
    retry: false,
  });

  const goUp = () => {
    if (path === "" || roots.includes(path)) return setPath("");
    const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
    setPath(parent);
  };

  return (
    <Modal
      title="Choose workspace directory"
      onClose={onClose}
      wide
      footer={
        <>
          <span className="mono small grow">{path || "(allowed roots)"}</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={path === "" || !!listing.error}
            onClick={() => onSelect(path)}
          >
            Select this directory
          </button>
        </>
      }
    >
      <div className="row gap">
        <label className="field inline">
          <span>Runner</span>
          <select
            value={activeRunner ?? ""}
            onChange={(e) => {
              setRunnerId(e.target.value);
              setPath("");
            }}
          >
            {online.length === 0 && <option value="">No online runners</option>}
            {online.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn small" disabled={path === ""} onClick={goUp}>
          ↑ Up
        </button>
      </div>
      {runners.error && <p className="error">{errorMessage(runners.error)}</p>}
      {listing.error && <p className="error">{errorMessage(listing.error)}</p>}
      {listing.isLoading && <p className="muted">Loading…</p>}
      {listing.data && (
        <ul className="fs-list">
          {listing.data.entries.length === 0 && <li className="muted">No subdirectories.</li>}
          {listing.data.entries.map((e) => (
            <li key={e.path}>
              <button type="button" className="link-btn" onClick={() => setPath(e.path)}>
                <span className="folder">▸</span> {path === "" ? e.path : e.name}
              </button>
              {e.isGitRepo && <span className="tag">git</span>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
