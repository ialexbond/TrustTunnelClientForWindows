import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import i18n from "../../shared/i18n";
import { UpdateProgressModal } from "./UpdateProgressModal";

// ─── Tauri API mocks ───────────────────────────────────────
const listeners = new Map<
  string,
  (event: { payload: unknown }) => void
>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      eventName: string,
      cb: (event: { payload: unknown }) => void
    ) => {
      listeners.set(eventName, cb);
      return vi.fn(() => listeners.delete(eventName));
    }
  ),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, payload?: unknown) => invokeMock(cmd, payload),
}));

const sshParams = {
  host: "1.2.3.4",
  port: 22,
  user: "root",
  password: "MySecretPassw0rd!",
};

function emit(payload: {
  step: string;
  status: string;
  percent: number;
  message: string;
}) {
  const handler = listeners.get("update-protocol-step");
  if (handler) handler({ payload });
}

describe("UpdateProgressModal", () => {
  beforeEach(async () => {
    cleanup();
    listeners.clear();
    invokeMock.mockReset();
    await i18n.changeLanguage("ru");
  });

  it("renders active title + linear progress bar при isOpen=true", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    render(
      <UpdateProgressModal
        isOpen
        onClose={vi.fn()}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(screen.getByText(/Обновление протокола/)).toBeInTheDocument()
    );
    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).toHaveAttribute("aria-valuemin", "0");
    expect(progressbar).toHaveAttribute("aria-valuemax", "100");
  });

  it("aria-dialog wrapper + labelledby applied", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    render(
      <UpdateProgressModal
        isOpen
        onClose={vi.fn()}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
      />
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "update-modal-title");
  });

  it("backend progress event обновляет UI step + percent", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    render(
      <UpdateProgressModal
        isOpen
        onClose={vi.fn()}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );
    emit({ step: "swap", status: "running", percent: 65, message: "" });

    await waitFor(() => {
      const bar = screen.getByRole("progressbar");
      expect(bar).toHaveAttribute("aria-valuenow", "65");
    });
    // Step label «Применение» (apply UI step)
    const labelEl = screen.getByTestId("update-modal-current-step-label");
    expect(labelEl).toHaveTextContent("Применение");
  });

  it("complete success event → onSuccess + onClose через 300ms", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(
      <UpdateProgressModal
        isOpen
        onClose={onClose}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={onSuccess}
      />
    );

    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );
    emit({ step: "complete", status: "completed", percent: 100, message: "" });

    await waitFor(() => expect(onSuccess).toHaveBeenCalled(), {
      timeout: 1000,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("error state: 3-line message + Закрыть button + closeOnBackdrop=true", async () => {
    invokeMock.mockRejectedValueOnce("UPDATE_VERIFY_TIMEOUT");
    render(
      <UpdateProgressModal
        isOpen
        onClose={vi.fn()}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Не удалось обновить протокол/)
      ).toBeInTheDocument()
    );
    expect(screen.getByText(/Произошла ошибка/)).toBeInTheDocument();
    expect(
      screen.getByText(/Выполнен автоматический откат/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Сервер продолжает работать на v3\.0\.0/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Закрыть/ })
    ).toBeInTheDocument();
  });

  it("error state UPDATE_CANCELLED → cancelled copy", async () => {
    invokeMock.mockRejectedValueOnce("UPDATE_CANCELLED");
    render(
      <UpdateProgressModal
        isOpen
        onClose={vi.fn()}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(
        screen.getByText(/Обновление отменено пользователем/)
      ).toBeInTheDocument()
    );
  });

  it("error state: clicking Закрыть calls onClose", async () => {
    invokeMock.mockRejectedValueOnce("UPDATE_DOWNLOAD_FAILED");
    const onClose = vi.fn();
    render(
      <UpdateProgressModal
        isOpen
        onClose={onClose}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
      />
    );

    const closeBtn = await screen.findByRole("button", { name: /Закрыть/ });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("active state: no Закрыть/Отменить footer button visible (UI-SPEC D-DECISION-UI-4.1)", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    render(
      <UpdateProgressModal
        isOpen
        onClose={vi.fn()}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(screen.getByText(/Обновление протокола/)).toBeInTheDocument()
    );
    // Per UI-SPEC D-DECISION-UI-4.1: no Cancel + no Close button в active state
    expect(
      screen.queryByRole("button", { name: /Закрыть|Отменить/ })
    ).toBeNull();
    expect(screen.queryByTestId("update-modal-footer")).toBeNull();
  });

  it("onError callback invoked с errorCode при error phase", async () => {
    invokeMock.mockRejectedValueOnce("UPDATE_VERIFY_TIMEOUT");
    const onError = vi.fn();
    render(
      <UpdateProgressModal
        isOpen
        onClose={vi.fn()}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
        onError={onError}
      />
    );

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("UPDATE_VERIFY_TIMEOUT")
    );
  });

  // ── D-29 spy assertion 1: sshPassword не появляется в DOM ни в одном phase ──
  it("D-29 spy: sshPassword не появляется в DOM ни в одном phase", async () => {
    invokeMock.mockRejectedValueOnce("SSH_AUTH_FAILED");
    const { container } = render(
      <UpdateProgressModal
        isOpen
        onClose={vi.fn()}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Не удалось обновить протокол/)
      ).toBeInTheDocument()
    );
    const allText = container.textContent ?? "";
    expect(allText).not.toContain(sshParams.password);
  });

  // ── D-29 spy assertion 2: backend message с .bak / paths не leaks ──
  it("D-29 spy: backend message с suspicious tokens не renders unescaped", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    const { container } = render(
      <UpdateProgressModal
        isOpen
        onClose={vi.fn()}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );
    // Simulate hypothetical backend bug — message containing path.
    // Modal MUST NOT render this verbatim (Modal только показывает t() keys).
    emit({
      step: "backup",
      status: "running",
      percent: 35,
      message: "/opt/trusttunnel/trusttunnel_endpoint.bak",
    });

    await waitFor(() =>
      expect(
        screen.getByTestId("update-modal-current-step-label")
      ).toHaveTextContent("Резервная копия")
    );
    const allText = container.textContent ?? "";
    // Strict assertion — .bak substring не должен leak в DOM
    expect(allText).not.toContain(".bak");
    expect(allText).not.toContain("trusttunnel_endpoint.bak");
  });

  // ── D-29 spy assertion 3: console.warn calls не leak sshPassword ──
  it("D-29 spy: console.warn calls не содержат sshPassword", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce("SOMETHING_FAILED");
    render(
      <UpdateProgressModal
        isOpen
        onClose={vi.fn()}
        sshParams={sshParams}
        fromVersion="3.0.0"
        toVersion="1.0.33"
        onSuccess={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Не удалось обновить протокол/)
      ).toBeInTheDocument()
    );

    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(sshParams.password);
      }
    }
    warnSpy.mockRestore();
  });
});
