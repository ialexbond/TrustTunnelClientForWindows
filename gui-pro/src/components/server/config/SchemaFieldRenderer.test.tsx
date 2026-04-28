import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../../../shared/i18n";
import { SchemaFieldRenderer } from "./SchemaFieldRenderer";
import type { TomlFieldSchema } from "./types";

/**
 * Phase 15.1 — REQ-15.7 type dispatch coverage.
 *
 * Replaces Wave 0 stub (it.todo skeleton) с real tests covering
 * each TomlFieldType.kind dispatch case + D-9.1 nested-table tabs +
 * D-16.1 forward-compat unknown field.
 */
describe("SchemaFieldRenderer", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
  });

  const baseSchema = (
    overrides: Partial<TomlFieldSchema> = {}
  ): TomlFieldSchema => ({
    key: "test_key",
    path: ["test_key"],
    type: { kind: "string", value: "" },
    isExplicit: true,
    ...overrides,
  });

  it("dispatches boolean → ToggleField (renders Toggle role=switch)", () => {
    const onChange = vi.fn();
    render(
      <SchemaFieldRenderer
        schema={baseSchema({ type: { kind: "boolean", value: true } })}
        onChange={onChange}
      />
    );
    // Toggle primitive renders как button с role=switch
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("dispatches integer → NumberField (renders input with numeric value)", () => {
    const onChange = vi.fn();
    render(
      <SchemaFieldRenderer
        schema={baseSchema({ type: { kind: "integer", value: 443 } })}
        onChange={onChange}
      />
    );
    // NumberInput primitive renders input с inputmode=numeric
    const input = screen.getByDisplayValue("443");
    expect(input).toBeInTheDocument();
  });

  it("dispatches string → StringField (renders text input)", () => {
    const onChange = vi.fn();
    render(
      <SchemaFieldRenderer
        schema={baseSchema({
          key: "listen_address",
          type: { kind: "string", value: "0.0.0.0:443" },
        })}
        onChange={onChange}
      />
    );
    expect(screen.getByDisplayValue("0.0.0.0:443")).toBeInTheDocument();
  });

  it("dispatches array-of-tables → ArrayOfTablesBlock (renders +Добавить when empty)", () => {
    const onChange = vi.fn();
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    render(
      <SchemaFieldRenderer
        schema={baseSchema({
          key: "ping_hosts",
          type: { kind: "array-of-tables", value: [] },
        })}
        onChange={onChange}
        onAddArrayEntry={onAdd}
        onRemoveArrayEntry={onRemove}
        getArrayEntrySchemas={() => []}
      />
    );
    // EmptyState renders "Добавить" Button — match button accessible name
    const addButton = screen.getByRole("button", { name: /Добавить/ });
    expect(addButton).toBeInTheDocument();
  });

  it("dispatches table with ≥2 sub-sections → TabsInline (D-9.1)", () => {
    const onChange = vi.fn();
    const childSchemas: TomlFieldSchema[] = [
      {
        key: "http1",
        path: ["listen_protocols", "http1"],
        type: { kind: "table", fields: { foo: { kind: "integer", value: 1 } } },
        isExplicit: true,
      },
      {
        key: "http2",
        path: ["listen_protocols", "http2"],
        type: { kind: "table", fields: { foo: { kind: "integer", value: 2 } } },
        isExplicit: true,
      },
      {
        key: "quic",
        path: ["listen_protocols", "quic"],
        type: { kind: "table", fields: { foo: { kind: "integer", value: 3 } } },
        isExplicit: true,
      },
    ];
    const getTableChildSchemas = (p: string[]): TomlFieldSchema[] => {
      if (p.length === 1 && p[0] === "listen_protocols") return childSchemas;
      return []; // leaves под http1/http2/quic — пустые для test
    };

    render(
      <SchemaFieldRenderer
        schema={baseSchema({
          key: "listen_protocols",
          path: ["listen_protocols"],
          type: { kind: "table", fields: {} },
        })}
        getTableChildSchemas={getTableChildSchemas}
        onChange={onChange}
      />
    );
    // TabsInline renders role=tablist
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "http1" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "http2" })).toBeInTheDocument();
  });

  it("dispatches unknown → RawUnknownField + warning badge (D-16.1)", () => {
    const onChange = vi.fn();
    render(
      <SchemaFieldRenderer
        schema={baseSchema({
          key: "future_upstream_field",
          type: { kind: "unknown", rawValue: "some_value" },
          isUnknown: true,
        })}
        onChange={onChange}
      />
    );
    // Warning badge text "новое upstream поле"
    expect(screen.getByText(/новое upstream поле/)).toBeInTheDocument();
    // Lucide AlertTriangle renders как svg.lucide-triangle-alert (Phase 15-03 finding)
    const svgs = document.querySelectorAll("svg.lucide-triangle-alert");
    expect(svgs.length).toBeGreaterThan(0);
  });
});
