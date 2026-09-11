import type { DefaultsMap } from "../types";

/**
 * Phase 15.1 D-6.2 + D-2.1 — credentials.toml READ-ONLY defaults map.
 *
 * [[client]] schema:
 *   username (string, required)
 *   password (string, required) — D-11.1 fully masked в preview UI
 *
 * Defaults present для type detection (string masking UX в preview);
 * actual editing forbidden via Plan 15.1-01 backend reject (file_name enum
 * char-whitelist) + Plan 15.1-04 type-level guard (ConfigFileName excludes
 * "credentials").
 *
 * Sync notice: derived from upstream CONFIGURATION.md as of 2026-04-28.
 * Manual review required at upgrade.
 */
export const CREDENTIALS_DEFAULTS: DefaultsMap = {
  "client": [],
  "client.username": "",
  "client.password": "",
};
