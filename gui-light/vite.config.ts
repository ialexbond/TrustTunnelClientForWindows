import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// Build hash (T-13): mirror of Pro. Short ~6-char label identifying THIS build,
// injected via the VITE_BUILD_HASH env var at `tauri build` time and exposed as
// a compile-time `__BUILD_HASH__` global. Empty ("") when unset → About falls
// back to the bare `v{version}`. See CLAUDE.md «Метка сборки».
const BUILD_HASH = process.env.VITE_BUILD_HASH || "";

export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __BUILD_HASH__: JSON.stringify(BUILD_HASH),
  },
  build: {
    rollupOptions: {
      // Two HTML entries (Light mirror of Pro T-14):
      //  - main: the app
      //  - logWindow: dev-only aggregated log viewer. The bundle is always built,
      //    but it is ONLY reachable via the #[cfg(feature="devtools")]-gated
      //    `open_log_window` Rust command — a public build cannot open it.
      input: {
        main: "index.html",
        logWindow: "log-window.html",
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: false,
    watch: null,
  },
}));
