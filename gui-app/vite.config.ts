import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
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
}));
