import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import { AdvancedConfigAccordion } from "./AdvancedConfigAccordion";

const SAMPLE_TOML = `listen_address = "0.0.0.0:443"
[metrics]
enable = true
`;

function renderAccordion(
  props: Partial<ComponentProps<typeof AdvancedConfigAccordion>> = {},
) {
  return render(
    <SnackBarProvider>
      <AdvancedConfigAccordion vpnTomlContent={SAMPLE_TOML} {...props} />
    </SnackBarProvider>,
  );
}

beforeEach(() => {
  i18n.changeLanguage("ru");
  vi.clearAllMocks();
});

describe("AdvancedConfigAccordion", () => {
  it("renders Accordion trigger «Расширенная конфигурация»", () => {
    renderAccordion();
    expect(screen.getByText("Расширенная конфигурация")).toBeInTheDocument();
  });

  it("Accordion is closed by default — section buttons hidden", () => {
    renderAccordion();
    // Accordion uses visibility:hidden when collapsed → toBeVisible() returns false
    const mainButton = screen.queryByTestId("section-trigger-main");
    if (mainButton) {
      expect(mainButton).not.toBeVisible();
    }
  });

  it("opens accordion on trigger click and exposes 5 section buttons", async () => {
    renderAccordion();
    fireEvent.click(screen.getByText("Расширенная конфигурация"));
    await waitFor(() =>
      expect(screen.getByTestId("section-trigger-main")).toBeVisible(),
    );
    expect(screen.getByTestId("section-trigger-protocols")).toBeVisible();
    expect(screen.getByTestId("section-trigger-timeouts")).toBeVisible();
    expect(screen.getByTestId("section-trigger-metrics")).toBeVisible();
    expect(screen.getByTestId("section-trigger-icmp")).toBeVisible();
  });

  it("renders «Показать сырой TOML» button when open", async () => {
    renderAccordion();
    fireEvent.click(screen.getByText("Расширенная конфигурация"));
    await waitFor(() =>
      expect(screen.getByText("Показать сырой TOML")).toBeVisible(),
    );
  });

  it("opens VpnTomlSectionsModal when section button clicked", async () => {
    renderAccordion();
    fireEvent.click(screen.getByText("Расширенная конфигурация"));
    await waitFor(() =>
      expect(screen.getByTestId("section-trigger-metrics")).toBeVisible(),
    );
    fireEvent.click(screen.getByTestId("section-trigger-metrics"));
    // Section modal opens with «Метрики» title
    await waitFor(() =>
      expect(screen.getByText("Метрики")).toBeInTheDocument(),
    );
  });

  it("opens RawTomlModal when «Показать сырой TOML» clicked", async () => {
    renderAccordion();
    fireEvent.click(screen.getByText("Расширенная конфигурация"));
    await waitFor(() =>
      expect(screen.getByText("Показать сырой TOML")).toBeVisible(),
    );
    fireEvent.click(screen.getByText("Показать сырой TOML"));
    // RawTomlModal renders <pre> с TOML content
    await waitFor(() =>
      expect(screen.getByTestId("raw-toml-content")).toBeInTheDocument(),
    );
  });

  it("renders allowedSniSlot custom node when provided", async () => {
    renderAccordion({
      allowedSniSlot: <div data-testid="sni-editor-mock">SNI editor</div>,
    });
    fireEvent.click(screen.getByText("Расширенная конфигурация"));
    await waitFor(() =>
      expect(screen.getByTestId("sni-editor-mock")).toBeVisible(),
    );
    expect(screen.queryByTestId("allowed-sni-slot-placeholder")).toBeNull();
  });

  it("renders placeholder when allowedSniSlot not provided", async () => {
    renderAccordion();
    fireEvent.click(screen.getByText("Расширенная конфигурация"));
    await waitFor(() =>
      expect(
        screen.getByTestId("allowed-sni-slot-placeholder"),
      ).toBeVisible(),
    );
  });

  it("renders dirty count Badge in trigger when dirtyAdvancedCount > 0", () => {
    renderAccordion({ dirtyAdvancedCount: 2 });
    // Badge text uses dirty_banner key — содержит «несохранённых изменений»
    expect(screen.getByText(/несохранённ/i)).toBeInTheDocument();
  });

  it("does NOT render dirty count Badge when dirtyAdvancedCount === 0", () => {
    renderAccordion({ dirtyAdvancedCount: 0 });
    expect(screen.queryByText(/несохранённ/i)).toBeNull();
  });
});
