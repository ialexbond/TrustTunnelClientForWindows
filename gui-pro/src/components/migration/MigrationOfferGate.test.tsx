import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import ru from "../../shared/i18n/locales/ru.json";
import en from "../../shared/i18n/locales/en.json";
import { MigrationOfferGate } from "./MigrationOfferGate";

const invokeMock = vi.mocked(invoke);

/** The application behind the gate. Its presence in the DOM is «the app has started». */
const APP = <div data-testid="the-app">the application</div>;

/**
 * Route the two commands this gate uses. Anything else resolves null, matching the global mock —
 * the gate's own children mount `TitleBar`/`WindowControls`, which talk to the window API, not
 * `invoke`.
 */
function backend({ pending, onResolve }: { pending: boolean; onResolve?: (accept: boolean) => void }) {
  invokeMock.mockImplementation((cmd: string, args?: unknown) => {
    if (cmd === "migration_offer_pending") return Promise.resolve(pending);
    if (cmd === "resolve_migration_offer") {
      onResolve?.((args as { accept: boolean } | undefined)?.accept as boolean);
      return Promise.resolve("adopted");
    }
    return Promise.resolve(null);
  });
}

const originalLanguage = i18n.language;

beforeEach(async () => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  // The product's primary language, pinned explicitly: jsdom reports an English `navigator.language`,
  // so without this the copy assertions below would silently check the mirror instead of the original.
  await i18n.changeLanguage("ru");
});

afterAll(async () => {
  await i18n.changeLanguage(originalLanguage);
});

describe("MigrationOfferGate", () => {
  it("starts the application directly when there is nothing to offer", async () => {
    backend({ pending: false });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);

    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
    // The D-05 majority — the folder never moved — must not be asked a question that cannot help
    // them, and must not have an answer recorded on their behalf either.
    expect(invokeMock).not.toHaveBeenCalledWith("resolve_migration_offer", expect.anything());
  });

  it("holds the application back and asks first when a previous version is waiting", async () => {
    backend({ pending: true });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);

    // The exact two lines D-09 fixes, read from the shipped bundle rather than re-typed here — a
    // test carrying its own copy of the copy can agree with itself while the product drifts.
    expect(await screen.findByText(ru.migration.offer.heading)).toBeInTheDocument();
    expect(screen.getByText(ru.migration.offer.question)).toBeInTheDocument();
    // This is the whole point of the gate: the application has NOT started yet, so it cannot have
    // drawn an empty server list that the adoption then fills in underneath the user.
    expect(screen.queryByTestId("the-app")).not.toBeInTheDocument();
  });

  it("offers an action pair — never yes/no, never ok/cancel, and never a promise about autostart", async () => {
    backend({ pending: true });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);
    await screen.findByText(ru.migration.offer.heading);

    expect(screen.getByRole("button", { name: ru.migration.offer.accept })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ru.migration.offer.decline })).toBeInTheDocument();
    // «Отмена» would be a lie — the application starts either way and only the data differs. «Да» /
    // «Нет» would make the user re-read the question to find out what they are agreeing to.
    for (const forbidden of ["Отмена", "Да", "Нет", "ОК", "OK"]) {
      expect(screen.queryByRole("button", { name: forbidden })).not.toBeInTheDocument();
    }
    // The dictated «чтобы работал автозапуск» stays out: autostart is bought by the per-machine
    // location plus the logon task, so it happens identically whichever button is pressed.
    expect(document.body.textContent).not.toMatch(/автозапуск/i);
  });

  it("carries «Перенести» to the backend as an acceptance and then starts the application", async () => {
    const answered: boolean[] = [];
    backend({ pending: true, onResolve: (accept) => answered.push(accept) });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);
    await screen.findByText(ru.migration.offer.heading);
    await userEvent.click(screen.getByRole("button", { name: ru.migration.offer.accept }));

    await waitFor(() => expect(answered).toEqual([true]));
    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
  });

  it("carries «Не переносить» to the backend as a refusal and still starts the application", async () => {
    const answered: boolean[] = [];
    backend({ pending: true, onResolve: (accept) => answered.push(accept) });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);
    await screen.findByText(ru.migration.offer.heading);
    await userEvent.click(screen.getByRole("button", { name: ru.migration.offer.decline }));

    // Declining is an answer, not an abandonment: the refusal is recorded, and the application
    // starts — with the previous folder untouched, which is what makes the refusal recoverable.
    await waitFor(() => expect(answered).toEqual([false]));
    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
  });

  it("has no third way out — Escape neither answers the question nor starts the application", async () => {
    const answered: boolean[] = [];
    backend({ pending: true, onResolve: (accept) => answered.push(accept) });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);
    await screen.findByText(ru.migration.offer.heading);
    await userEvent.keyboard("{Escape}");

    // A dismissal would be an unrecorded answer, and an unrecorded answer means «adopt» by default —
    // so a stray Escape would silently decide for the user in one direction.
    expect(answered).toEqual([]);
    expect(screen.getByText(ru.migration.offer.heading)).toBeInTheDocument();
    expect(screen.queryByTestId("the-app")).not.toBeInTheDocument();
  });

  it("tells the user when the move failed — the same screen as a success would be a lie", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "migration_offer_pending") return Promise.resolve(true);
      // What the Rust side now returns when the manifest write fails: the copies are rolled back,
      // no marker is written, and the reason crosses as a rejection rather than as a success word.
      if (cmd === "resolve_migration_offer") {
        return Promise.reject("could not write the adopted manifest");
      }
      return Promise.resolve(null);
    });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);
    await screen.findByText(ru.migration.offer.heading);
    await userEvent.click(screen.getByRole("button", { name: ru.migration.offer.accept }));

    // THE POINT OF THE WHOLE CHANGE: the user whose servers, passwords and settings did NOT move
    // must not be shown exactly what the user whose move succeeded is shown.
    expect(await screen.findByText(ru.migration.failed.heading)).toBeInTheDocument();
    expect(screen.getByText(ru.migration.failed.body)).toBeInTheDocument();
    expect(screen.queryByTestId("the-app")).not.toBeInTheDocument();
    // Read from the shipped bundle, never retyped here: the message may not claim more than the
    // rollback guarantees, and the one thing it may claim is that the previous folder is untouched.
    expect(ru.migration.failed.body).toContain("ничего не потеряно");
  });

  it("still starts the application after the failure has been read", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "migration_offer_pending") return Promise.resolve(true);
      if (cmd === "resolve_migration_offer") return Promise.reject("disk full");
      return Promise.resolve(null);
    });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);
    await screen.findByText(ru.migration.offer.heading);
    await userEvent.click(screen.getByRole("button", { name: ru.migration.offer.accept }));
    await screen.findByText(ru.migration.failed.heading);
    await userEvent.click(screen.getByRole("button", { name: ru.migration.failed.continue }));

    // A failed migration is not a reason to strand somebody with no application. Getting BOTH of
    // these right is the requirement — telling the user, and still starting.
    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
  });

  it("does not raise the failure screen over a refusal that was not recorded", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "migration_offer_pending") return Promise.resolve(true);
      if (cmd === "resolve_migration_offer") return Promise.reject("marker not written");
      return Promise.resolve(null);
    });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);
    await screen.findByText(ru.migration.offer.heading);
    await userEvent.click(screen.getByRole("button", { name: ru.migration.offer.decline }));

    // «Не переносить» that could not be written down moved nothing and lost nothing — the only
    // consequence is being asked again next launch. Announcing «не удалось перенести данные» there
    // would report a data move that was never attempted.
    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
    expect(screen.queryByText(ru.migration.failed.heading)).not.toBeInTheDocument();
  });

  it("starts the application when the probe cannot be answered at all", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "migration_offer_pending"
        ? Promise.reject(new Error("no such command"))
        : Promise.resolve(null),
    );

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);

    // Fail-open, and the direction matters: the gate renders nothing while it waits, so a backend
    // that cannot answer must never be able to leave a permanently blank window. The adoption is
    // withheld rather than skipped — the next launch asks again.
    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
  });

  it("says so when the probe ran out of time instead of passing it off as «nothing to offer»", async () => {
    const logged: string[] = [];
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      // The one launch this gate exists for is also the expensive one: a registry read, two
      // canonicalisations and a full read of every `.toml` in the legacy folder. On a cold disk or
      // behind an on-access scanner it can outrun the bound. Here it simply never answers.
      if (cmd === "migration_offer_pending") return new Promise<boolean>(() => {});
      if (cmd === "write_activity_log") {
        logged.push(String((args as { message?: string } | undefined)?.message ?? ""));
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    vi.useFakeTimers();
    try {
      render(<MigrationOfferGate>{APP}</MigrationOfferGate>);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      // Timing out into the application is right — a blank window would be worse. What is not
      // right is that it looks identical to «there was nothing to offer», with nothing written
      // down anywhere, on the one launch where the difference is the user's whole server list.
      expect(screen.getByTestId("the-app")).toBeInTheDocument();
      expect(logged.join("\n")).toMatch(/timed out/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes nothing to the log when the probe answers in time", async () => {
    const logged: string[] = [];
    invokeMock.mockImplementation((cmd: string, args?: unknown) => {
      if (cmd === "migration_offer_pending") return Promise.resolve(false);
      if (cmd === "write_activity_log") {
        logged.push(String((args as { message?: string } | undefined)?.message ?? ""));
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);
    expect(await screen.findByTestId("the-app")).toBeInTheDocument();

    // The control for the test above: the ordinary launch — a marker file that exists — must stay
    // silent. A line on every launch of every installation is a log nobody reads.
    expect(logged).toEqual([]);
  });

  it("mirrors the offer into English with the same key set", async () => {
    await i18n.changeLanguage("en");
    backend({ pending: true });

    render(<MigrationOfferGate>{APP}</MigrationOfferGate>);

    expect(await screen.findByText(en.migration.offer.heading)).toBeInTheDocument();
    expect(screen.getByText(en.migration.offer.question)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.migration.offer.accept })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.migration.offer.decline })).toBeInTheDocument();
    // Mirrored, not shared: the English pair must be a pair of actions too, and «Cancel» is the
    // word that would creep in here first.
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });
});
