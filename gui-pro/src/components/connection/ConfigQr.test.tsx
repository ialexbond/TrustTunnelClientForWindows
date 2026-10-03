import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { renderWithProviders as render } from "../../test/test-utils";
// RED (15-01): ./ConfigQr does not exist yet — 15-03 builds it from the LOCKED
// story (ConfigQr.stories.tsx) with the deeplink SOURCE swapped from SSH to the
// new local command. The import fails to resolve today, so every case is RED
// until 15-03. This file pins B-12..B-15 (the modal contract).
import { ConfigQr } from "./ConfigQr";

// The design contract (from ConfigQr.stories.tsx, owner-approved).
const HEADING = "QR-код конфигурации";
const QR_ARIA = "QR-код — нажмите, чтобы скопировать ссылку";
const LINK_COPIED = "Ссылка скопирована в буфер обмена";
const CLOSE_LABEL = "Закрыть";

const MOCK_DEEPLINK = "tt://4f8a2c9b6d1e7a3f0c5b8e2d9a6f1c4be0d7a29c";

// A ConfigSummary-shaped config (name for the heading, path for the invoke arg).
const CONFIG = {
  id: "cfg-de-abc12345",
  name: "Германия — Frankfurt",
  host: "de1.example.com",
  display_host: "de1.example.com",
  user: "swift-fox",
  path: "C:/app/TrustTunnel_swift-fox.toml",
  order: 0,
  last_used: true,
};

// Mock qrcode.react so the test does not pull the real SVG renderer.
vi.mock("qrcode.react", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QRCodeSVG: (props: any) => <svg data-testid="qr-code" data-value={props.value} />,
}));

// Mock the Tauri command bridge.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  // The design contract literals below are the locked Russian strings — pin the locale to ru
  // (same pattern as UserConfigModal.test.tsx) so the i18n-driven component renders them.
  void i18n.changeLanguage("ru");
  vi.clearAllMocks();
  Object.assign(navigator, {
    clipboard: {
      writeText: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
    },
  });
});

describe("ConfigQr", () => {
  // ── B-12: renders the locked design; NO download; NO warning label ──────────
  it("renders heading + config name + QR + link + «Закрыть», with no download and no warning label", async () => {
    vi.mocked(invoke).mockResolvedValue(MOCK_DEEPLINK);
    render(<ConfigQr isOpen config={CONFIG} onClose={vi.fn()} />);

    // Heading + config name.
    expect(await screen.findByText(HEADING)).toBeInTheDocument();
    expect(screen.getByText(CONFIG.name)).toBeInTheDocument();

    // The clickable QR (query the rendered svg inside the aria-labelled button).
    const qrButton = await screen.findByRole("button", { name: QR_ARIA });
    expect(qrButton.querySelector("svg")).toBeInTheDocument();

    // The link field carries the deeplink value.
    const linkField = screen.getByLabelText("Ссылка конфигурации") as HTMLInputElement;
    await waitFor(() => expect(linkField.value).toBe(MOCK_DEEPLINK));

    // The «Закрыть» button is present.
    expect(screen.getByRole("button", { name: CLOSE_LABEL })).toBeInTheDocument();

    // D-08: NO «Скачать конфиг» button/text.
    expect(screen.queryByText(/Скачать/)).toBeNull();
    // D-07: NO extra security/warning label — the caption is the neutral scan copy,
    // and no «внимание»/«пароль»/«warning» text appears.
    expect(screen.getByText(/Отсканируйте QR/)).toBeInTheDocument();
    expect(screen.queryByText(/внимание/i)).toBeNull();
    expect(screen.queryByText(/пароль/i)).toBeNull();
    expect(screen.queryByText(/warning/i)).toBeNull();
  });

  // ── B-13: opens via the LOCAL command, never an SSH invoke ──────────────────
  it("calls export_config_deeplink_local with { configPath } on open, never an SSH export", async () => {
    vi.mocked(invoke).mockResolvedValue(MOCK_DEEPLINK);
    render(<ConfigQr isOpen config={CONFIG} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("export_config_deeplink_local", {
        configPath: CONFIG.path,
      });
    });
    // D-01: the SSH export path must NEVER be invoked.
    for (const call of vi.mocked(invoke).mock.calls) {
      expect(String(call[0])).not.toMatch(/server_export_config_deeplink/);
    }
  });

  // ── B-14: copy-link AND clicking the QR both copy the tt:// link ─────────────
  //    The QR image-clipboard path was removed (it did not work in the WebView2), so
  //    clicking the QR now copies the link — same as the «Ссылка» copy button.
  it("copy-link and clicking the QR both copy the tt:// link and push «Ссылка скопирована»", async () => {
    vi.mocked(invoke).mockResolvedValue(MOCK_DEEPLINK);
    render(<ConfigQr isOpen config={CONFIG} onClose={vi.fn()} />);

    // Wait for the deeplink to land so the copy handlers have a value.
    await screen.findByRole("button", { name: QR_ARIA });

    // The «Ссылка» copy button writes the link + pushes «Ссылка скопирована…».
    fireEvent.click(screen.getByRole("button", { name: "Скопировать ссылку" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(MOCK_DEEPLINK);
    expect(await screen.findByText(LINK_COPIED)).toBeInTheDocument();

    // Clicking the QR ALSO copies the link now.
    vi.mocked(navigator.clipboard.writeText).mockClear();
    fireEvent.click(screen.getByRole("button", { name: QR_ARIA }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(MOCK_DEEPLINK);
    expect(await screen.findByText(LINK_COPIED)).toBeInTheDocument();
  });

  // ── B-15: loading / error / retry states ────────────────────────────────────
  it("shows a skeleton while loading, an ErrorBanner + Retry on failure, and re-invokes on Retry", async () => {
    // 1st invoke: never resolves (pending) → loading affordance.
    let resolveFirst!: (v: string) => void;
    const pending = new Promise<string>((res) => {
      resolveFirst = res;
    });
    vi.mocked(invoke).mockReturnValueOnce(pending);
    const { rerender } = render(<ConfigQr isOpen config={CONFIG} onClose={vi.fn()} />);

    // While pending → a skeleton/loading affordance is shown.
    expect(await screen.findByTestId("qr-skeleton")).toBeInTheDocument();
    resolveFirst(MOCK_DEEPLINK);

    // Now drive the error state: re-mount with an invoke that rejects.
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("boom"));
    rerender(<ConfigQr isOpen config={{ ...CONFIG, path: "C:/app/other.toml" }} onClose={vi.fn()} />);

    // Error → an ErrorBanner (role=alert) + a Retry control appear.
    const retry = await screen.findByRole("button", { name: "Повторить попытку" });
    expect(retry).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Clicking Retry re-invokes the command.
    vi.mocked(invoke).mockResolvedValueOnce(MOCK_DEEPLINK);
    fireEvent.click(retry);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("export_config_deeplink_local", {
        configPath: "C:/app/other.toml",
      });
    });
  });

  // ── G-30.1-01 (30.1 UAT, T-14): the config file is deleted while this window is open ──────────
  //
  // The same class as the settings pane, decided differently and on purpose. This window is a
  // TRANSFER surface: the deeplink was built before the deletion and is still a valid bundle for the
  // receiving device — the file may well have been deleted BECAUSE it was being moved. So the link
  // stays and the user is told. Only a deletion that lands before the link exists leaves nothing to
  // hand over, and then there is nothing to retry either.
  describe("G-30.1-01 — the config file is deleted while the QR is open", () => {
    // Resolved INSIDE each test, not at describe-registration time: the suite pins the locale to ru
    // in `beforeEach`, which has not run yet while the describe body is being evaluated.
    const warning = () => i18n.t("connection.qr.file_missing");
    const noLink = () => i18n.t("connection.qr.file_missing_no_link");

    it("keeps the QR and the link, and says the file is gone", async () => {
      vi.mocked(invoke).mockResolvedValue(MOCK_DEEPLINK);
      render(<ConfigQr isOpen config={CONFIG} onClose={vi.fn()} fileMissing />);

      expect(await screen.findByText(warning())).toBeInTheDocument();
      // The thing the window exists for is NOT snatched away mid-scan.
      expect(await screen.findByRole("button", { name: QR_ARIA })).toBeInTheDocument();
      const linkField = screen.getByLabelText("Ссылка конфигурации") as HTMLInputElement;
      await waitFor(() => expect(linkField.value).toBe(MOCK_DEEPLINK));
    });

    it("the link stays COPYABLE — a deleted file does not invalidate a link already built", async () => {
      vi.mocked(invoke).mockResolvedValue(MOCK_DEEPLINK);
      render(<ConfigQr isOpen config={CONFIG} onClose={vi.fn()} fileMissing />);

      await screen.findByText(warning());
      fireEvent.click(await screen.findByRole("button", { name: "Скопировать ссылку" }));
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(MOCK_DEEPLINK));
    });

    it("warns rather than errors when the link is in hand — nothing has failed", async () => {
      vi.mocked(invoke).mockResolvedValue(MOCK_DEEPLINK);
      render(<ConfigQr isOpen config={CONFIG} onClose={vi.fn()} fileMissing />);

      const banner = await screen.findByText(warning());
      // The warning variant, not the error one: the error palette would claim the transfer broke.
      expect(banner.closest("[role='alert']")).toHaveClass("bg-[var(--color-status-connecting-bg)]");
    });

    it("says there is nothing to build when the file went BEFORE the link, and offers no retry", async () => {
      // Deliberately never resolves: the link has not arrived, and now the file is gone.
      vi.mocked(invoke).mockReturnValue(new Promise(() => {}) as never);
      render(<ConfigQr isOpen config={CONFIG} onClose={vi.fn()} fileMissing />);

      expect(await screen.findByText(noLink())).toBeInTheDocument();
      // Re-asking the backend to read a file that is not there changes nothing.
      expect(screen.queryByRole("button", { name: "Повторить попытку" })).toBeNull();
      // And no loading skeleton pretending a link is still on its way.
      expect(screen.queryByTestId("qr-skeleton")).toBeNull();
    });

    it("says nothing about a deletion while the file is still on disk", async () => {
      vi.mocked(invoke).mockResolvedValue(MOCK_DEEPLINK);
      render(<ConfigQr isOpen config={CONFIG} onClose={vi.fn()} />);

      await screen.findByRole("button", { name: QR_ARIA });
      expect(screen.queryByText(warning())).toBeNull();
      expect(screen.queryByText(noLink())).toBeNull();
    });
  });
});
