import "./styles.css";

import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, NavLink, Outlet, RouterProvider } from "react-router";
import { api, errorMessage, redirectToLogin } from "./api";
import { FlowEditor } from "./routes/FlowEditor";
import { Flows } from "./routes/Flows";
import { Runners } from "./routes/Runners";
import { Runs } from "./routes/Runs";
import { RunView } from "./routes/RunView";
import { currentTheme, setTheme } from "./theme";

function ThemePicker() {
  const themes = useQuery({ queryKey: ["themes"], queryFn: api.themes, staleTime: Infinity });
  const [theme, setThemeState] = useState(currentTheme);
  if (!themes.data) return null;
  const { themes: names, defaultTheme } = themes.data;
  // A cookie naming a since-removed theme is served as the default, so show it that way.
  const value = theme !== null && names.includes(theme) ? theme : "";
  return (
    <label className="row gap-tight theme-picker muted">
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

function Layout() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: Infinity });
  const loginRequired = me.data?.authMode === "github" && me.data.user === null;
  useEffect(() => {
    if (loginRequired) redirectToLogin();
  }, [loginRequired]);
  const logout = useMutation({ mutationFn: api.logout, onSettled: () => window.location.reload() });
  const user = me.data?.user ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Agent Orchestrator</span>
        <nav>
          <NavLink to="/flows">Flows</NavLink>
          <NavLink to="/runs">Runs</NavLink>
          <NavLink to="/runners">Runners</NavLink>
        </nav>
        <span className="grow" />
        {me.data && !loginRequired && <ThemePicker />}
        {user && (
          <span className="row gap user-menu">
            <span className="muted">
              Signed in as <strong>{user.login}</strong>
            </span>
            <button type="button" className="btn small" disabled={logout.isPending} onClick={() => logout.mutate()}>
              Log out
            </button>
          </span>
        )}
      </header>
      <main className="content">
        {me.error ? (
          <p className="error pad">{errorMessage(me.error)}</p>
        ) : !me.data || loginRequired ? (
          <p className="muted pad">{loginRequired ? "Redirecting to login…" : "Loading…"}</p>
        ) : (
          <Outlet />
        )}
      </main>
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
      { path: "*", element: <p className="muted pad">Not found.</p> },
    ],
  },
]);

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
