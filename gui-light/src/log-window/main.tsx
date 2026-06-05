// Entry file: mounts its own React root via ReactDOM.createRoot below.
import React from "react";
import ReactDOM from "react-dom/client";
import { LogWindow } from "./LogWindow";
import "../shared/styles/tokens.css";
import "../index.css";

// Dev-only aggregated log window (T-14), Light mirror. Referenced ONLY by the
// `#[cfg(feature = "devtools")]`-gated `open_log_window` Rust command — a release
// build has no command to create this window. See gui-light/src-tauri/src/lib.rs.
ReactDOM.createRoot(document.getElementById("log-window-root")!).render(
  <React.StrictMode>
    <LogWindow />
  </React.StrictMode>,
);
