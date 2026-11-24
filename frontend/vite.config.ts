import { defineConfig, searchForWorkspaceRoot } from "vite";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { proxiedOrigin } from "./src/lib/devProxyOrigin";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));

// The Maximizer's engine (master_me, GPL-3) is for personal builds only: it lives in a gitignored folder that CI never has.
const maximizerEngine = path.join(frontendRoot, "private/maximizer/index.ts");
const hasMaximizer = existsSync(maximizerEngine);

// Public names this dev server is opened under (ngrok, Tailscale): exact hostnames, also trusted by the /api proxy.
const fronts = ["subdivine-luisa-tidally.ngrok-free.dev", "mac-mini.tail676d13.ts.net"];
const apiTarget = process.env.CRATEMIND_API_TARGET ?? "http://localhost:8000";

export default defineConfig(({ mode }) => ({
  define: { __MAXIMIZER__: JSON.stringify(hasMaximizer) },
  plugins: [react(), tailwindcss(), {
    name: "maximizer-engine",
    resolveId: (id) => id !== "virtual:maximizer-engine" ? undefined : hasMaximizer ? maximizerEngine : "\0no-maximizer",
    load: (id) => id === "\0no-maximizer" ? "export const loadMaximizer = undefined, createMaximizer = undefined;" : undefined,
  }, {
    name: "desktop-html",
    transformIndexHtml(html) {
      return mode === "desktop" ? html
        .replace(/<script data-web-theme>[\s\S]*?<\/script>/, "")
        .replace(/<link rel="manifest"[^>]*>/, "") : html;
    },
  }],
  build: { outDir: mode === "desktop" ? "dist-desktop" : "dist" },
  // AudioWorklet consumes a same-origin module URL, without a Worker wrapper.
  worker: { format: "es" },
  resolve: {
    alias: {
      "@": path.resolve(frontendRoot, "./src"),
    },
  },
  server: {
    port: 5173,
    allowedHosts: fronts,
    // Both outputs are generated locally, regardless of the dev server's mode.
    watch: { ignored: ["**/dist/**", "**/dist-desktop/**"] },
    fs: {
      // Dependencies may live on another volume; only expose the font packages.
      allow: [
        searchForWorkspaceRoot(frontendRoot),
        ...["@fontsource-variable/inter", "@fontsource-variable/geist", "@fontsource/jetbrains-mono"].map(
          (name) => realpathSync(path.resolve(frontendRoot, "node_modules", name)),
        ),
      ],
    },
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        // The backend refuses a write whose Origin is not its own (backend/app/web_guard.py): vouch for our own pages.
        bypass(req, res) {
          const origin = proxiedOrigin(req.method, req.headers.origin, req.headers.host, fronts, new URL(apiTarget).origin);
          if (origin === null) {
            res?.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({
              detail: "Το αίτημα ήρθε από άλλη ιστοσελίδα και απορρίφθηκε.", code: "origin_not_allowed",
            }));
            return "/"; // already answered: Vite stops here
          }
          if (origin !== undefined) req.headers.origin = origin;
        },
      },
    },
  },
}));
