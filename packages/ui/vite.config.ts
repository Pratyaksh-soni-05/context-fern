// Served by the daemon in production (packages/daemon/src/ui-assets.ts
// reads packages/ui/dist/* directly) — this file only matters for local
// dev (`bun run dev` inside this package) and `bun run build`. The dev
// server proxies every daemon API path to a real running daemon so the
// browser's same-origin fetches work without CORS — defaults to the
// daemon's default port (7420); override with FERN_UI_DEV_DAEMON_PORT
// if your daemon ended up on a different one (e.g. 7420 was taken).

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const daemonPort = process.env.FERN_UI_DEV_DAEMON_PORT ?? "7420";
const daemonTarget = `http://127.0.0.1:${daemonPort}`;

const DAEMON_API_PATHS = [
  "/prompt",
  "/tools",
  "/exchange-end",
  "/undo",
  "/merge",
  "/mode",
  "/tree",
  "/status",
  "/fronds",
  "/frond",
  "/search",
  "/projects",
  "/leaflets",
  "/stats",
  "/heatmap",
  "/ui-code",
  "/session",
];

export default defineConfig({
  // The daemon serves this app at /ui — every asset reference in the
  // built index.html must carry that prefix, since ui-assets.ts only
  // resolves paths under /ui/*. Kept the same in dev so dev and
  // production URLs match (visit http://localhost:5173/ui/ in dev).
  base: "/ui/",
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(
      DAEMON_API_PATHS.map((path) => [path, { target: daemonTarget }]),
    ),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
