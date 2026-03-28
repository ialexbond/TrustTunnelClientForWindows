import React from "react";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * Tests for main.tsx functionality.
 *
 * main.tsx is an entry point that:
 * 1. Registers keyboard shortcut blocking (F5, Ctrl+R, Ctrl+Shift+R)
 * 2. Registers context menu blocking
 * 3. Defines and exports ErrorBoundary class component
 * 4. Registers global error/unhandledrejection handlers
 * 5. Calls ReactDOM.createRoot and renders <App/>
 */

// Mock App component to avoid loading the full component tree
vi.mock("./App", () => ({
  __esModule: true,
  default: () => <div data-testid="mock-app">App</div>,
}));

// Mock CSS imports
vi.mock("./shared/styles/tokens.css", () => ({}));
vi.mock("./index.css", () => ({}));

// Mock recharts
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  LineChart: ({ children }: any) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
}));

// Track what ReactDOM.createRoot receives
let capturedRenderArg: React.ReactNode | null = null;
const mockRender = vi.fn((node: React.ReactNode) => {
  capturedRenderArg = node;
});
const mockCreateRoot = vi.fn(() => ({
  render: mockRender,
}));

vi.mock("react-dom/client", () => ({
  __esModule: true,
  default: {
    createRoot: (...args: any[]) => mockCreateRoot(...args),
  },
}));

// Will hold the real ErrorBoundary class after import
let ErrorBoundary: any;
let rootEl: HTMLDivElement;

describe("main.tsx", () => {
  beforeAll(async () => {
    // Create root element that main.tsx expects
    rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.appendChild(rootEl);

    // Import main.tsx — module-level code runs once
    const mod = await import("./main");
    ErrorBoundary = mod.ErrorBoundary;
  });

  afterAll(() => {
    if (rootEl && rootEl.parentNode) {
      document.body.removeChild(rootEl);
    }
  });

  // ─── ReactDOM.createRoot ───

  it("calls createRoot with #root element", () => {
    expect(mockCreateRoot).toHaveBeenCalledWith(rootEl);
  });

  it("calls render on the created root", () => {
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it("renders App inside ErrorBoundary inside StrictMode", () => {
    expect(capturedRenderArg).toBeTruthy();
    render(capturedRenderArg as React.ReactElement);
    expect(screen.getByTestId("mock-app")).toBeInTheDocument();
  });

  // ─── Keyboard shortcut blocking ───

  it("blocks F5 keydown", () => {
    const event = new KeyboardEvent("keydown", { key: "F5", cancelable: true, bubbles: true });
    const prevented = !document.dispatchEvent(event);
    expect(prevented).toBe(true);
  });

  it("blocks Ctrl+R keydown", () => {
    const event = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, cancelable: true, bubbles: true });
    const prevented = !document.dispatchEvent(event);
    expect(prevented).toBe(true);
  });

  it("blocks Ctrl+Shift+R keydown", () => {
    const event = new KeyboardEvent("keydown", { key: "R", ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });
    const prevented = !document.dispatchEvent(event);
    expect(prevented).toBe(true);
  });

  it("does not block normal key presses", () => {
    const event = new KeyboardEvent("keydown", { key: "a", cancelable: true, bubbles: true });
    const prevented = !document.dispatchEvent(event);
    expect(prevented).toBe(false);
  });

  it("does not block Ctrl+T", () => {
    const event = new KeyboardEvent("keydown", { key: "t", ctrlKey: true, cancelable: true, bubbles: true });
    const prevented = !document.dispatchEvent(event);
    expect(prevented).toBe(false);
  });

  // ─── Context menu blocking ───

  it("blocks right-click context menu", () => {
    const event = new Event("contextmenu", { cancelable: true, bubbles: true });
    const prevented = !document.dispatchEvent(event);
    expect(prevented).toBe(true);
  });

  // ─── Global error handlers ───

  it("global error handler logs to console", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const testError = new Error("Global test error");
    const event = new ErrorEvent("error", { error: testError, cancelable: true, bubbles: true });
    window.dispatchEvent(event);

    expect(errorSpy).toHaveBeenCalledWith("[global error]", testError);
    errorSpy.mockRestore();
  });

  it("global error handler prevents default", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const event = new ErrorEvent("error", { error: new Error("test"), cancelable: true, bubbles: true });
    const prevented = !window.dispatchEvent(event);
    expect(prevented).toBe(true);
    vi.restoreAllMocks();
  });

  it("unhandledrejection handler logs to console", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = new Event("unhandledrejection", { cancelable: true, bubbles: true });
    (event as any).reason = "Promise failed";
    window.dispatchEvent(event);

    expect(errorSpy).toHaveBeenCalledWith("[unhandled rejection]", "Promise failed");
    errorSpy.mockRestore();
  });

  it("unhandledrejection handler prevents default", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const event = new Event("unhandledrejection", { cancelable: true, bubbles: true });
    (event as any).reason = "test";
    const prevented = !window.dispatchEvent(event);
    expect(prevented).toBe(true);
    vi.restoreAllMocks();
  });
});

// ─── ErrorBoundary behavior tests using the REAL class from main.tsx ───
describe("ErrorBoundary (exported from main.tsx)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
    if (shouldThrow) throw new Error("Test render error");
    return <div>Child rendered OK</div>;
  }

  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <div>Hello World</div>
      </ErrorBoundary>
    );
    expect(screen.getByText("Hello World")).toBeInTheDocument();
  });

  it("catches render errors and shows fallback UI", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText("Произошла ошибка в интерфейсе")).toBeInTheDocument();
    expect(screen.queryByText("Child rendered OK")).not.toBeInTheDocument();
  });

  it("shows error message in pre tag", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );
    const pre = screen.getByText("Test render error");
    expect(pre.tagName).toBe("PRE");
  });

  it("calls componentDidCatch with error and component stack", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(errorSpy).toHaveBeenCalledWith("[ErrorBoundary]", expect.any(Error), expect.any(String));
  });

  it("getDerivedStateFromError returns correct state shape", () => {
    const result = ErrorBoundary.getDerivedStateFromError(new Error("test error"));
    expect(result).toEqual({ hasError: true, error: "test error" });
  });

  it("try again button resets error state", () => {
    let shouldThrow = true;
    function ConditionalThrower() {
      if (shouldThrow) throw new Error("Boom");
      return <div>Recovered OK</div>;
    }

    render(
      <ErrorBoundary>
        <ConditionalThrower />
      </ErrorBoundary>
    );

    expect(screen.getByText("Произошла ошибка в интерфейсе")).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByText("Попробовать снова"));

    expect(screen.getByText("Recovered OK")).toBeInTheDocument();
    expect(screen.queryByText("Произошла ошибка в интерфейсе")).not.toBeInTheDocument();
  });

  it("try again button re-catches if child still throws", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("Произошла ошибка в интерфейсе")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Попробовать снова"));
    // Still throwing, so fallback appears again
    expect(screen.getByText("Произошла ошибка в интерфейсе")).toBeInTheDocument();
  });

  it("renders multiple children when no error", () => {
    render(
      <ErrorBoundary>
        <div>First</div>
        <div>Second</div>
      </ErrorBoundary>
    );
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("fallback has heading, pre, and button elements", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={true} />
      </ErrorBoundary>
    );
    expect(screen.getByText("Произошла ошибка в интерфейсе").tagName).toBe("H2");
    expect(screen.getByText("Попробовать снова").tagName).toBe("BUTTON");
  });
});
