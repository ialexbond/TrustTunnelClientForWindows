/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// Build hash (T-13): a short ~6-char label that uniquely identifies THIS build
// (not the version — version is frozen). Injected at `tauri build` time via the
// VITE_BUILD_HASH env var and exposed as a compile-time `__BUILD_HASH__` global.
// A `define` global is used instead of `import.meta.env.VITE_BUILD_HASH` so the
// value is inlined as a literal at build time and the About screen needs no
// VITE_ runtime env wiring. Empty string ("") when unset → About falls back to
// the bare `v{version}` (graceful dev-run fallback). See CLAUDE.md «Метка сборки».
const BUILD_HASH = process.env.VITE_BUILD_HASH || "";

export default defineConfig(async () => ({
  plugins: [react()],
  define: {
    __BUILD_HASH__: JSON.stringify(BUILD_HASH),
  },
  build: {
    // Desktop app — bundle size is not a concern, suppress warning
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      // HTML entries, each with its own React root:
      //  - main: the app
      //  - trayMenu: custom tray context menu (small popup at cursor on right click)
      input: {
        main: "index.html",
        trayMenu: "tray-menu.html",
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    // HMR and file watching completely disabled — VPN changes network,
    // which kills connections and triggers unwanted page reloads.
    hmr: false,
    watch: null,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: true,
    // ISO-03 (09-03): global mock reset between every test. Without this a spy
    // that silently inherits a reset state (the H-5 vacuous-spy class) can pass
    // tautologically. clearMocks/restoreMocks reset call history + original
    // implementations; unstubGlobals undoes vi.stubGlobal. This is the
    // structural backstop that makes the next vacuous-spy bug fail loudly
    // instead of passing silently.
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/test/**",
        "src/vite-env.d.ts",
        "src/shared/i18n/locales/**",
        "src/components/wizard/types.ts",
        "src/shared/ui/index.ts",
        "src/shared/styles/**",
      ],
    },
  },
}));
