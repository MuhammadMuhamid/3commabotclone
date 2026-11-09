import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * OD-4: `/enroll` is a separate page (`enroll.html`), not a dashboard route.
 * In production nginx maps `location = /enroll` to it; this does the same
 * for the dev server, whose SPA fallback would otherwise serve index.html.
 */
function enrollPageRewrite(): Plugin {
  return {
    name: "enroll-page-rewrite",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === "/enroll" || req.url?.startsWith("/enroll?")) req.url = "/enroll.html";
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), enrollPageRewrite()],
  build: {
    rollupOptions: {
      // Two entries: the dashboard, and the minimal enrollment page, which
      // must not load the dashboard bundle (no router, no login, no API client).
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        enroll: resolve(import.meta.dirname, "enroll.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/health": "http://localhost:4000",
    },
  },
});
