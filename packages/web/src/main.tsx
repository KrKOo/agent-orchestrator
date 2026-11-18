import "./styles.css";

import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { CircleUserRound, Compass, LogOut, Menu, Play, Server, Settings2, Workflow, X } from "lucide-react";
import { type ReactNode, StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link, Navigate, NavLink, Outlet, RouterProvider, useLocation } from "react-router";
import { api, errorMessage, redirectToLogin } from "./api";
import { ToastProvider } from "./components/Toast";
import { FlowEditor } from "./routes/FlowEditor";
import { Flows } from "./routes/Flows";
import { Runners } from "./routes/Runners";
import { Runs } from "./routes/Runs";
import { RunView } from "./routes/RunView";
import { ATTENTION_STATUSES, runsFilterSearch } from "./runsFilter";
import { currentTheme, setTheme } from "./theme";
import { EmptyState, Popover, setAttentionTitleCount, Skeleton, useDismiss, usePageTitle } from "./ui";

/** How often the sidebar re-counts runs waiting for the user. */
const ATTENTION_POLL_MS = 5000;

function ThemePicker() {
  const themes = useQuery({ queryKey: ["themes"], queryFn: api.themes, staleTime: Infinity });
  const [theme, setThemeState] = useState(currentTheme);
  if (!themes.data) return null;
  const { themes: names, defaultTheme } = themes.data;
  // A cookie naming a since-removed theme is served as the default, so show it that way.
  const value = theme !== null && names.includes(theme) ? theme : "";
  return (
    <label className="theme-picker muted">
      Theme
      <select
        value={value}
        onChange={(e) => {
          const next = e.target.value || null;
          setTheme(next);
          setThemeState(next);
        }}
      >
        <option value="">Default ({defaultTheme ?? "system"})</option>
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Runs in `awaiting_input`/`awaiting_approval`; mirrored into the tab title as `(n)`. */
function useAttentionCount(enabled: boolean): number {
  const runs = useQuery({
    queryKey: ["runs", "attention"],
    queryFn: () => api.listRuns({ status: ATTENTION_STATUSES }),
    refetchInterval: ATTENTION_POLL_MS,
    enabled,
  });
  const count = runs.data?.length ?? 0;
  useEffect(() => setAttentionTitleCount(count), [count]);
  return count;
}

function AttentionBadge({ count }: { count: number }) {
  if (count === 0) return null;
  const label = `${count} run${count === 1 ? "" : "s"} waiting for you`;
  return (
    <Link className="attention-badge" to={`/runs${runsFilterSearch({ tab: "attention", q: "" })}`} aria-label={label} title={label}>
      {count}
    </Link>
  );
}

function NavItem({ to, icon, label, children }: { to: string; icon: ReactNode; label: string; children?: ReactNode }) {
  return (
    <div className="nav-item">
      <NavLink className="nav-link" to={to} title={label}>
        {icon}
        <span className="nav-label">{label}</span>
      </NavLink>
      {children}
    </div>
  );
}

function UserMenu({ showThemes }: { showThemes: boolean }) {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: Infinity });
  const logout = useMutation({ mutationFn: api.logout, onSettled: () => window.location.reload() });
  const user = me.data?.user ?? null;
  if (!user && !showThemes) return null;
  return (
    <Popover
      label={user ? `Account: ${user.login}` : "Settings"}
      buttonClassName="user-button"
      align="start"
      placement="above"
      button={
        <>
          {user ? <CircleUserRound size={18} aria-hidden /> : <Settings2 size={18} aria-hidden />}
          <span className="nav-label">{user ? user.login : "Settings"}</span>
        </>
      }
    >
      {() => (
        <div className="user-menu">
          {user && (
            <div className="user-menu-head muted">
              Signed in as <strong>{user.login}</strong>
            </div>
          )}
          {showThemes && <ThemePicker />}
          {user && (
            <>
              <div className="menu-sep" />
              <button type="button" className="menu-item" disabled={logout.isPending} onClick={() => logout.mutate()}>
                <LogOut size={15} aria-hidden />
                Log out
              </button>
            </>
          )}
        </div>
      )}
    </Popover>
  );
}

function Layout() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: Infinity });
  const loginRequired = me.data?.authMode === "github" && me.data.user === null;
  useEffect(() => {
    if (loginRequired) redirectToLogin();
  }, [loginRequired]);
  const ready = !!me.data && !loginRequired;
  const attention = useAttentionCount(ready);

  // Below 640px the sidebar is a drawer: closed by navigation, Escape, or a click outside it.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const dismissRefs = useRef([sidebarRef, menuButtonRef]).current;
  useDismiss(drawerOpen, closeDrawer, dismissRefs);
  const location = useLocation();
  useEffect(closeDrawer, [location.pathname, location.search, closeDrawer]);

  return (
    <div className="app">
      <aside ref={sidebarRef} className={`sidebar ${drawerOpen ? "open" : ""}`} aria-label="Sidebar">
        <Link className="brand" to="/flows" title="Agent Orchestrator">
          <Compass size={22} aria-hidden />
          <span className="nav-label">Agent Orchestrator</span>
        </Link>
        <nav className="sidebar-nav" aria-label="Main">
          <NavItem to="/flows" icon={<Workflow size={18} aria-hidden />} label="Flows" />
          <NavItem to="/runs" icon={<Play size={18} aria-hidden />} label="Runs">
            <AttentionBadge count={attention} />
          </NavItem>
          <NavItem to="/runners" icon={<Server size={18} aria-hidden />} label="Runners" />
        </nav>
        <div className="sidebar-foot">{ready && <UserMenu showThemes />}</div>
      </aside>
      <div className={`drawer-backdrop ${drawerOpen ? "open" : ""}`} aria-hidden />
      <div className="main-col">
        <header className="mobile-bar">
          <button
            ref={menuButtonRef}
            type="button"
            className="icon-btn"
            aria-label={drawerOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            {drawerOpen ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
          </button>
          <Link className="brand grow" to="/flows">
            <Compass size={20} aria-hidden />
            Agent Orchestrator
          </Link>
          <AttentionBadge count={attention} />
        </header>
        <main className="content">
          {me.error ? (
            <p className="error pad">{errorMessage(me.error)}</p>
          ) : !ready ? (
            loginRequired ? (
              <p className="muted pad">Redirecting to login…</p>
            ) : (
              <div className="page">
                <Skeleton />
              </div>
            )
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
}

function NotFound() {
  usePageTitle("Not found");
  return (
    <div className="page">
      <EmptyState
        icon={<Compass size={32} />}
        title="Page not found"
        action={
          <Link className="btn primary" to="/flows">
            Go to flows
          </Link>
        }
      >
        Nothing lives at this address.
      </EmptyState>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/flows" replace /> },
      { path: "flows", element: <Flows /> },
      { path: "flows/:id", element: <FlowEditor /> },
      { path: "runs", element: <Runs /> },
      { path: "runs/:id", element: <RunView /> },
      { path: "runners", element: <Runners /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
