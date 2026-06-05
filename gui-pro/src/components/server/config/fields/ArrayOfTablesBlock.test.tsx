import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../../../shared/i18n";
import { ArrayOfTablesBlock } from "./ArrayOfTablesBlock";
import type { TomlFieldSchema } from "../types";

/**
 * Phase 3 safety-net (Stream 3) — ArrayOfTablesBlock D-5.2 last-element guard.
 *
 * The main_hosts last-element guard was untested before this net (RESEARCH §3
 * stream 3). Guard rule (D-5.2): ONLY for schema.key === "main_hosts", when
 * exactly 1 entry remains, the entry's trash button is DISABLED (the server
 * requires at least one main host). Other arrays (rules, ping_hosts, …) have no
 * such guard.
 *
 * Behavior/aria only (D-04): role + aria-label + `i18n.t(...)`. Pins CURRENT
 * behavior against UNCHANGED production code (D-06).
 */
function arraySchema(
  key: string,
  entries: Record<string, unknown>[],
): TomlFieldSchema {
  return {
    key,
    path: [key],
    type: { kind: "array-of-tables", value: entries },
    isExplicit: true,
  };
}

const renderEntry = (index: number) => (
  <div data-testid={`entry-${index}`}>entry {index}</div>
);

describe("ArrayOfTablesBlock (Phase 3 — D-5.2 main_hosts guard)", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
  });

  it("D-5.2: main_hosts with exactly 1 entry has its trash button DISABLED", () => {
    render(
      <ArrayOfTablesBlock
        schema={arraySchema("main_hosts", [{ hostname: "a.com" }])}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        renderEntry={renderEntry}
      />,
    );
    const trash = screen.getByRole("button", {
      name: i18n.t("server.config.delete_host", { hostname: "a.com" }),
    });
    expect(trash).toBeDisabled();
  });

  it("D-5.2: clicking the disabled last-main-host trash does NOT call onRemove", () => {
    const onRemove = vi.fn();
    render(
      <ArrayOfTablesBlock
        schema={arraySchema("main_hosts", [{ hostname: "a.com" }])}
        onAdd={vi.fn()}
        onRemove={onRemove}
        renderEntry={renderEntry}
      />,
    );
    const trash = screen.getByRole("button", {
      name: i18n.t("server.config.delete_host", { hostname: "a.com" }),
    });
    fireEvent.click(trash);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("D-5.2: main_hosts with 2 entries enables both trash buttons (guard lifts)", () => {
    const onRemove = vi.fn();
    render(
      <ArrayOfTablesBlock
        schema={arraySchema("main_hosts", [
          { hostname: "a.com" },
          { hostname: "b.com" },
        ])}
        onAdd={vi.fn()}
        onRemove={onRemove}
        renderEntry={renderEntry}
      />,
    );
    const trashA = screen.getByRole("button", {
      name: i18n.t("server.config.delete_host", { hostname: "a.com" }),
    });
    const trashB = screen.getByRole("button", {
      name: i18n.t("server.config.delete_host", { hostname: "b.com" }),
    });
    expect(trashA).toBeEnabled();
    expect(trashB).toBeEnabled();
    fireEvent.click(trashA);
    expect(onRemove).toHaveBeenCalledWith(["main_hosts"], 0);
  });

  it("guard is specific to main_hosts — a single rules entry's trash stays ENABLED", () => {
    const onRemove = vi.fn();
    render(
      <ArrayOfTablesBlock
        schema={arraySchema("rule", [{ cidr: "10.0.0.0/8", action: "allow" }])}
        onAdd={vi.fn()}
        onRemove={onRemove}
        renderEntry={renderEntry}
      />,
    );
    // [PHASE-4 BUG, D-06] The component passes `{ index: idx + 1 }` to the
    // delete_rule key, but ru.json interpolates `{{hostname}}` — so the var is
    // never filled and the trash aria-label renders as "Удалить правило "
    // (trailing space, NO rule number). We PIN this current-but-buggy behavior
    // here; a Phase-4 fix should align the placeholder name (index vs hostname).
    const trash = screen.getByRole("button", {
      name: i18n.t("server.config.delete_rule", {}),
    });
    expect(trash).toBeEnabled();
    fireEvent.click(trash);
    expect(onRemove).toHaveBeenCalledWith(["rule"], 0);
  });

  it("renders the empty-state add button when the array has no entries", () => {
    const onAdd = vi.fn();
    render(
      <ArrayOfTablesBlock
        schema={arraySchema("main_hosts", [])}
        onAdd={onAdd}
        onRemove={vi.fn()}
        renderEntry={renderEntry}
      />,
    );
    const addBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("common.add", { defaultValue: "Добавить" })),
    });
    fireEvent.click(addBtn);
    expect(onAdd).toHaveBeenCalledWith(["main_hosts"]);
  });

  it("renders one parent-provided entry slot per array element", () => {
    render(
      <ArrayOfTablesBlock
        schema={arraySchema("main_hosts", [
          { hostname: "a.com" },
          { hostname: "b.com" },
        ])}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        renderEntry={renderEntry}
      />,
    );
    expect(screen.getByTestId("entry-0")).toBeInTheDocument();
    expect(screen.getByTestId("entry-1")).toBeInTheDocument();
  });
});
