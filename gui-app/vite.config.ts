/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  build: {
    // Desktop app — bundle size is not a concern, suppress warning
    chunkSizeWarningLimit: 1000,
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
