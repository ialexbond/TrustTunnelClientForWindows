import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import { RawTomlModal } from "./RawTomlModal";

const SAMPLE = `listen_address = "0.0.0.0:443"
ipv6_available = true
log_level = "info"
`;

function renderModal(props: Partial<ComponentProps<typeof RawTomlModal>> = {}) {
  return render(
    <SnackBarProvider>
      <RawTomlModal isOpen onClose={vi.fn()} content={SAMPLE} {...props} />
    </SnackBarProvider>,
  );
}

beforeEach(() => {
  i18n.changeLanguage("ru");
  vi.clearAllMocks();
});

describe("RawTomlModal", () => {
  it("renders TOML content inside <pre>", async () => {
    renderModal();
    const pre = await screen.findByTestId("raw-toml-content");
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toContain("listen_address");
    expect(pre.textContent).toContain("0.0.0.0:443");
  });

  it("renders Russian title from i18n", async () => {
    renderModal();
    expect(await screen.findByText("Показать сырой TOML")).toBeInTheDocument();
  });

  it("Copy button calls navigator.clipboard.writeText with full content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    renderModal();
    const copyBtn = await screen.findByLabelText("Копировать");
    fireEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SAMPLE));
  });

  it("Copy fallback when clipboard.writeText is missing — does not throw", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    renderModal();
    const copyBtn = await screen.findByLabelText("Копировать");
    // Должен не выбросить исключение
    fireEvent.click(copyBtn);
  });

  it("renders readonly hint", async () => {
    renderModal();
    expect(await screen.findByText(/только для чтения/i)).toBeInTheDocument();
  });

  it("renders default fileLabel «vpn.toml»", async () => {
    renderModal();
    expect(await screen.findByText("vpn.toml")).toBeInTheDocument();
  });

  it("renders custom fileLabel when provided", async () => {
    renderModal({ fileLabel: "hosts.toml" });
    expect(await screen.findByText("hosts.toml")).toBeInTheDocument();
  });

  it("Close button fires onClose", async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(await screen.findByText("Закрыть"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("re-rendering with isOpen=false then isOpen=true preserves content (T-03 invariant)", () => {
    const { rerender } = renderModal({ isOpen: false });
    rerender(
      <SnackBarProvider>
        <RawTomlModal isOpen onClose={vi.fn()} content={SAMPLE} />
      </SnackBarProvider>,
    );
    // После повторного открытия hint снова в DOM
    expect(screen.getByText(/только для чтения/i)).toBeInTheDocument();
  });
});
