import { defineConfig, searchForWorkspaceRoot } from "vite";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));

// The Maximizer's engine (master_me, GPL-3) is for personal builds only: it lives in a gitignored folder that CI never has.
const maximizerEngine = path.join(frontendRoot, "private/maximizer/index.ts");
const hasMaximizer = existsSync(maximizerEngine);

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
    allowedHosts: ["subdivine-luisa-tidally.ngrok-free.dev", "mac-mini.tail676d13.ts.net"],
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
        target: process.env.CRATEMIND_API_TARGET ?? "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
}));
