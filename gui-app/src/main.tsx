import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SnackBarProvider } from "./shared/ui/SnackBarContext";
import "./shared/styles/tokens.css";
import "./index.css";
import "./shared/i18n";

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
  e.preventDefault();
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[unhandled rejection]", e.reason);
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <SnackBarProvider>
        <App />
      </SnackBarProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
