/// <reference types="vite/client" />

// Build hash (T-13) — compile-time global injected by vite.config.ts `define`
// from the VITE_BUILD_HASH env var. Empty string when no build hash was set
// (plain dev run); the About screen falls back to a bare `v{version}`.
declare const __BUILD_HASH__: string;
