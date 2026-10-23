import "@xyflow/react/dist/style.css";
import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, NavLink, Outlet, RouterProvider } from "react-router";
import { FlowEditor } from "./routes/FlowEditor";
import { Flows } from "./routes/Flows";
import { Runners } from "./routes/Runners";
import { Runs } from "./routes/Runs";
import { RunView } from "./routes/RunView";

function Layout() {
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Agent Orchestrator</span>
        <nav>
          <NavLink to="/flows">Flows</NavLink>
          <NavLink to="/runs">Runs</NavLink>
          <NavLink to="/runners">Runners</NavLink>
        </nav>
      </header>
      <main className="content">
        <Outlet />
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
