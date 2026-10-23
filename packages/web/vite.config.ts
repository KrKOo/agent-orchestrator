import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const SERVER = "http://127.0.0.1:7800";

export default defineConfig({
  // Single local SPA bundle; the default 500 kB warning is noise here.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The server rejects browser WebSockets whose Origin differs from its publicUrl,
      // so proxied requests (HTTP and WS upgrades) present the server's own origin.
      "/api": { target: SERVER, ws: true, headers: { origin: SERVER } },
      "/auth": { target: SERVER, headers: { origin: SERVER } },
      // Lets a runner use the `serverUrl` shown on the Runners page (derived from the page origin) in dev.
      // Regex key so the `/runners` SPA route is not proxied.
      "^/runner/ws$": { target: SERVER, ws: true },
    },
  },
});
