import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { polyfillCountryFlagEmojis } from "country-flag-emoji-polyfill";
import App from "./App";
import { MigrationOfferGate } from "./components/migration/MigrationOfferGate";
import { SnackBarProvider } from "./shared/ui/SnackBarContext";
import "./shared/styles/tokens.css";
import "./index.css";
import "./shared/i18n";

// M-06 follow-up: Windows 11's Segoe UI Emoji renders regional indicator
// pairs (🇷🇺 = U+1F1F7 + U+1F1FA) as ASCII letters ("RU") instead of a
// flag glyph. The polyfill swaps in Twemoji's country-flag subset via
// @font-face so the Country card on the Overview tab renders correctly.
// No-op on platforms where flags already render natively (Mac/Linux/mobile).
//
// Font bundled locally в /fonts/TwemojiCountryFlags.woff2 — CDN
// (cdn.jsdelivr.net) ненадёжен в Tauri webview (offline use, corporate
// firewalls), а Vite копирует public/* в bundle.
polyfillCountryFlagEmojis(
  "Twemoji Country Flags",
  "/fonts/TwemojiCountryFlags.woff2",
);

// Block F5, Ctrl+R reload shortcuts
document.addEventListener("keydown", (e) => {
  if (
    e.key === "F5" ||
    e.key === "F12" ||
    (e.ctrlKey && e.key === "r") ||
    (e.ctrlKey && e.shiftKey && e.key === "R") ||
    (e.ctrlKey && e.shiftKey && e.key === "I")
  ) {
    e.preventDefault();
  }
});

// Block right-click context menu
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// G-8 (09-RESEARCH-quality §G-8): frontend crashes were console.error-only,
// which is lost in a release build (no devtools). Route them into the existing
// rotating, sanitized activity.log sink so a non-technical user's bug report
// carries a real trace.
//
// D-29 (memory/security-posture.md): a crashed promise's `reason` can carry SSH
// params / a password (e.g. `e.reason.password`). We therefore extract ONLY the
// `.message` / `.stack` STRINGS and never hand the raw object to the sink — the
// Rust side also runs sanitize() (defence in depth), but the handler must not
// hand-feed credentials in the first place. Fire-and-forget: a logging failure
// must never replace the crash it is trying to record.
function persistCrash(message: string, details?: string) {
  invoke("write_activity_log", { tag: "ERROR", message, details }).catch(() => {
    // Silent fail — logging the crash must not itself throw.
  });
}

// React Error Boundary to catch rendering errors without crashing the page
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
    // G-8: persist message/stack strings only (D-29 — never the raw error object).
    persistCrash(
      `[ErrorBoundary] ${error.message}`,
      error.stack ?? info.componentStack ?? undefined,
    );
  }

  render() {
    if (this.state.hasError) {
      // Bilingual fallback — i18n may not be loaded when global boundary triggers
      const lang = navigator.language.startsWith("ru") ? "ru" : "en";
      const title = lang === "ru" ? "Произошла ошибка в интерфейсе" : "A UI error occurred";
      const retry = lang === "ru" ? "Попробовать снова" : "Try again";
      return (
        <div style={{ padding: 32, color: "#ef4444", fontFamily: "monospace" }}>
          <h2>{title}</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>{this.state.error}</pre>
          <button
            onClick={() => this.setState({ hasError: false, error: "" })}
            style={{
              marginTop: 16, padding: "8px 16px",
              background: "#333", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer",
            }}
          >
            {retry}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Catch ALL unhandled errors and rejections globally
window.addEventListener("error", (e) => {
  console.error("[global error]", e.error);
  // G-8: persist message/stack strings only (D-29 — never the raw error object).
  const err = e.error as Error | undefined;
  persistCrash(`[global error] ${err?.message ?? e.message}`, err?.stack);
  e.preventDefault();
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[unhandled rejection]", e.reason);
  // G-8 + D-29: a rejection's `reason` may carry SSH params/password. Pull out
  // ONLY the message/stack strings — never forward the raw `e.reason` object.
  const reason = e.reason as { message?: string; stack?: string } | undefined;
  const message =
    typeof e.reason === "string" ? e.reason : reason?.message ?? "Unhandled promise rejection";
  persistCrash(`[unhandled rejection] ${message}`, reason?.stack);
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SnackBarProvider>
        {/* Phase 32 (32-08): the migration offer is asked HERE, wrapping <App />, and not inside
            it. On the one launch where a previous version's data is waiting in another folder, the
            question and the adoption behind it both complete before App mounts — so App's very
            first read of the manifest already sees the adopted servers. Mounting App first and
            refreshing afterwards would show an empty list and then pop the data in, which is the
            one thing this must not do. Every other launch (which is all of them, after the first)
            renders <App /> directly: the gate's probe is a single marker check. */}
        <MigrationOfferGate>
          <App />
        </MigrationOfferGate>
      </SnackBarProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
