// Tasks: a chat with a manager agent that plans work and drives child runs. List + "New task" form.
import type { TaskRepo, TaskSettings } from "@orch/protocol";
import { TASK_MESSAGE_MAX, TASK_TITLE_MAX } from "@orch/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiRequestError, api, errorMessage } from "../api";
import { PathPicker } from "../components/PathPicker";
import { HarnessModelPickers } from "../components/ModelPickers";
import { useToast } from "../components/Toast";
import { EmptyState, PageHeader, RelativeTime, Skeleton, StatusChip, usePageTitle } from "../ui";

/** One repo row of the form: GitHub `owner/name` and the host path of a local clone. */
function RepoRow({
  repo,
  onChange,
  onRemove,
}: {
  repo: TaskRepo;
  onChange: (repo: TaskRepo) => void;
  onRemove: () => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="row gap wrap">
      <input
        type="text"
        placeholder="owner/name"
        aria-label="GitHub repository"
        className="mono"
        value={repo.github}
        onChange={(e) => onChange({ ...repo, github: e.target.value })}
      />
      <input
        type="text"
        placeholder="/absolute/path/to/clone"
        aria-label="Local clone path"
        className="mono grow"
        value={repo.localPath}
        onChange={(e) => onChange({ ...repo, localPath: e.target.value })}
      />
      <button type="button" className="btn small" onClick={() => setPicking(true)}>
        Browse…
      </button>
      <button type="button" className="icon-btn" aria-label="Remove repository" onClick={onRemove}>
        <Trash2 size={14} aria-hidden />
      </button>
      {picking && (
        <PathPicker
          initialPath={repo.localPath}
          onClose={() => setPicking(false)}
          onSelect={(path) => {
            onChange({ ...repo, localPath: path });
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** Defaults the server fills anyway; the form sends explicit values so the payload is stable. */
function defaultSettings(): TaskSettings {
  return {
    repos: [{ github: "", localPath: "" }],
    interventions: "manager",
    merge: "auto",
    autoMergeFinal: false,
    managerModels: { model: "" },
    allowNetworkModes: ["gateway_only", "allowlist"],
    maxParallelRuns: 3,
  };
}

function NewTask({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [settings, setSettings] = useState<TaskSettings>(defaultSettings);
  const [errors, setErrors] = useState<string[]>([]);
  const create = useMutation({
    mutationFn: () => api.createTask({ title: title.trim(), message, settings }),
    onSuccess: (task) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast("Task created", { kind: "success" });
      onClose();
      // The task page is the chat; the list only leads there.
      navigate(`/tasks/${task.id}`);
    },
    onError: (err) => {
      // Validation failures carry `{errors}` (ApiRequestError); anything else is one message via toast.
      const list = err instanceof ApiRequestError && err.errors.length ? err.errors : [];
      setErrors(list);
      if (list.length === 0) toast(`Create failed: ${errorMessage(err)}`, { kind: "error" });
    },
  });
  const noRepos = settings.repos.some((r) => r.github.trim() === "" || r.localPath.trim() === "");
  // The server validates with zod (`TaskSettings`), but an empty manager model is a common miss: gate on it.
  const canCreate = title.trim() !== "" && message.trim() !== "" && !noRepos && settings.managerModels.model.trim() !== "";

  return (
    <div className="task-new">
      <PageHeader
        title="New task"
        actions={
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        }
      />
      {errors.length > 0 && (
        <ul className="error-list">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canCreate && !create.isPending) create.mutate();
        }}
      >
        <label className="field">
          <span>Title</span>
          <input
            type="text"
            maxLength={TASK_TITLE_MAX}
            placeholder="What should the manager get done?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>
        <label className="field">
          <span>First message</span>
          <textarea
            rows={4}
            maxLength={TASK_MESSAGE_MAX}
            placeholder="Describe the goal, constraints and pointers. The manager reads this before it plans."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        <div className="field">
          <span>Repositories (the first one is the manager's read-only workspace)</span>
          {settings.repos.map((repo, i) => (
            <RepoRow
              key={i}
              repo={repo}
              onChange={(next) =>
                setSettings({ ...settings, repos: settings.repos.map((r, j) => (j === i ? next : r)) })
              }
              onRemove={() => setSettings({ ...settings, repos: settings.repos.filter((_, j) => j !== i) })}
            />
          ))}
          <button
            type="button"
            className="btn small"
            onClick={() => setSettings({ ...settings, repos: [...settings.repos, { github: "", localPath: "" }] })}
          >
            <Plus size={13} aria-hidden />
            Add repository
          </button>
        </div>
        <div className="grid2">
          <label className="field">
            <span>Interventions</span>
            <select
              value={settings.interventions}
              onChange={(e) => setSettings({ ...settings, interventions: e.target.value as TaskSettings["interventions"] })}
            >
              <option value="manager">handled by the manager</option>
              <option value="user">the user answers</option>
            </select>
          </label>
          <label className="field">
            <span>Merge mode</span>
            <select
              value={settings.merge}
              onChange={(e) => setSettings({ ...settings, merge: e.target.value as TaskSettings["merge"] })}
            >
              <option value="auto">auto (the manager picks)</option>
              <option value="integration">integration branch</option>
              <option value="direct">straight to the default branch</option>
            </select>
          </label>
        </div>
        <label className="field inline">
          <input
            type="checkbox"
            checked={settings.autoMergeFinal}
            onChange={(e) => setSettings({ ...settings, autoMergeFinal: e.target.checked })}
          />
          <span>Let the manager merge the final PR into the default branch</span>
        </label>
        <div className="field">
          <span>Manager models</span>
          <HarnessModelPickers
            value={settings.managerModels}
            models={catalog.data?.models ?? []}
            onChange={(managerModels) => setSettings({ ...settings, managerModels })}
          />
        </div>
        <label className="field">
          <span>Max parallel runs</span>
          <input
            type="number"
            min={1}
            max={20}
            value={settings.maxParallelRuns}
            onChange={(e) => setSettings({ ...settings, maxParallelRuns: Number(e.target.value) })}
          />
        </label>
        {create.error && (
          <p className="error" role="alert">
            {errorMessage(create.error)}
          </p>
        )}
        <div className="row gap">
          <button type="submit" className="btn primary" disabled={!canCreate || create.isPending}>
            {create.isPending ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function Tasks() {
  usePageTitle("Tasks");
  const [creating, setCreating] = useState(false);
  // Archived tasks are hidden by default; the toggle lists them too, so they can be opened and reopened.
  const [showArchived, setShowArchived] = useState(false);
  const tasks = useQuery({
    queryKey: showArchived ? ["tasks", "archived"] : ["tasks"],
    queryFn: () => api.listTasks(showArchived),
    refetchInterval: 5000,
  });

  return (
    <div className="page">
      <PageHeader
        title="Tasks"
        subtitle="A chat with a manager agent that plans work and runs it through your flows."
        actions={
          <>
            <label className="field inline">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              <span>Show archived</span>
            </label>
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>
              <Plus size={15} aria-hidden />
              New task
            </button>
          </>
        }
      />
      {creating && <NewTask onClose={() => setCreating(false)} />}
      {tasks.isPending ? (
        <Skeleton rows={4} />
      ) : tasks.error && !tasks.data ? (
        <p className="error">{errorMessage(tasks.error)}</p>
      ) : !tasks.data || tasks.data.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare size={32} />}
          title="No tasks yet"
          action={
            <button type="button" className="btn primary" onClick={() => setCreating(true)}>
              Create your first task
            </button>
          }
        >
          Describe a goal in plain language; the manager plans it and drives runs.
        </EmptyState>
      ) : (
        <div role="table" aria-label="Tasks" className="list">
          <div role="row" className="list-grid tasks-grid list-head">
            <div role="columnheader" className="cell-status">
              Status
            </div>
            <div role="columnheader" className="cell-name">
              Title
            </div>
            <div role="columnheader" className="cell-meta">
              Repos
            </div>
            <div role="columnheader" className="cell-created">
              Updated
            </div>
          </div>
          {tasks.data.map((t) => (
            <div role="row" key={t.id} className="list-grid tasks-grid list-row">
              <div role="cell" className="cell-status">
                <StatusChip status={t.status} />
              </div>
              <div role="cell" className="cell-name">
                {/* The row's link: its ::after stretches over the whole row (see list pages CSS). */}
                <Link to={`/tasks/${t.id}`} className="list-row-link run-name">
                  {t.title}
                </Link>
              </div>
              <div role="cell" className="cell-meta small muted">
                {t.settings.repos.map((r) => r.github).join(", ")}
              </div>
              <div role="cell" className="cell-created">
                <RelativeTime ts={t.updatedAt} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
