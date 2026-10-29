import { defineConfig, searchForWorkspaceRoot } from "vite";
import { realpathSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), {
    name: "desktop-html",
    transformIndexHtml(html) {
      return mode === "desktop" ? html
        .replace(/<script data-web-theme>[\s\S]*?<\/script>/, "")
        .replace(/<link rel="manifest"[^>]*>/, "") : html;
    },
  }],
  build: { outDir: mode === "desktop" ? "dist-desktop" : "dist" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    allowedHosts: ["subdivine-luisa-tidally.ngrok-free.dev"],
    fs: {
      // Dependencies may live on another volume; only expose the font packages.
      allow: [
        searchForWorkspaceRoot(__dirname),
        ...["@fontsource-variable/inter", "@fontsource/jetbrains-mono"].map(
          (name) => realpathSync(path.resolve(__dirname, "node_modules", name)),
        ),
      ],
    },
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
}));
