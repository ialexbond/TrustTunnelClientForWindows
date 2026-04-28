import { parse, stringify } from "smol-toml";
import type {
  TomlFieldSchema,
  TomlFieldType,
  ConfigFileName,
  ConfigBundle,
} from "./types";
import { inferTomlFieldType } from "./types";

/**
 * Phase 15.1 — Schema builder: parse TOML files + apply defaults map → TomlFieldSchema tree.
 *
 * Architecture:
 *   smol-toml parses raw TOML to JS object (no comment preservation).
 *   buildSchemaFromBundle walks the parsed object, dispatching by inferred type.
 *   For each field: lookup defaults map (D-6.1 isExplicit) + disrupt map (D-4.4 isDisruptHigh) +
 *   tooltip i18n key (D-3.2 tooltipKey).
 *
 * Phase 15.1-05 provides:
 *   - DEFAULTS_MAP per file (vpn / hosts / rules / credentials)
 *   - DISRUPT_HIGH_FIELDS set (paths like "listen_address", "ipv6_available", "main_hosts.cert_chain_path")
 *   - TOOLTIP_KEY_PREFIX = "server.config.field_desc.{file}"
 *
 * Phase 15.1 design choice: skip stringify() for round-trip — instead, computeRawContent
 * uses smol-toml.stringify on edited tree (NOT on original). Backend toml_edit applies
 * format-preserving structural diff (Plan 15.1-01 save_config_file → toml_edit::DocumentMut parse → write).
 * Acceptable trade-off: comments NOT preserved on save through Configuration tab. Users editing TOML
 * via SSH retain comments; Configuration tab edits через generic save replace whole file.
 */

/** Per-file defaults: path joined.with.dots → default value. */
export type DefaultsMap = Record<string, unknown>;

/** Per-file disrupt-high paths: Set of "joined.path" strings. */
export type DisruptSet = Set<string>;

/** Schema tree for one file — root is `{ kind: "table", fields: {...} }`. */
export interface FileSchemaTree {
  fileName: ConfigFileName | "credentials"; // credentials read-only included
  /** Root of schema tree — table with file's top-level fields. */
  root: TomlFieldSchema;
  /** Lookup map: path.join(".") → schema. For O(1) lookup during dispatch. */
  flatMap: Map<string, TomlFieldSchema>;
}

/**
 * Parse one file string + build TomlFieldSchema tree.
 * Soft-fail на parse error: returns empty tree (caller shows error banner).
 *
 * D-6.1 backbone: tree содержит UNION (explicit fields из parsed TOML) ∪ (default fields из defaults map):
 *   - Explicit fields: present в parsed → isExplicit=true, value из parsed
 *   - Default fields: НЕ present в parsed но есть в defaults map → isExplicit=false, value из defaults
 *   - Unknown fields: present в parsed но НЕТ в defaults map → isExplicit=true, isUnknown=true (D-16.1)
 *
 * After buildNode walks parsed, an additional pass adds default-only fields:
 *   for (const defaultPath of Object.keys(defaults)) {
 *     if (!flatMap.has(defaultPath)) {
 *       // Add synthetic schema with isExplicit=false, value from defaults
 *     }
 *   }
 * (Implementation detail для D-6.1 "Показать все поля (+N default)" toggle in Plan 15.1-06.)
 */
export function buildFileSchemaTree(
  rawToml: string,
  fileName: ConfigFileName | "credentials",
  defaults: DefaultsMap,
  disruptSet: DisruptSet,
  tooltipKeyPrefix: string,
): FileSchemaTree {
  const flatMap = new Map<string, TomlFieldSchema>();
  let parsed: Record<string, unknown>;
  try {
    parsed = parse(rawToml || "") as Record<string, unknown>;
  } catch {
    // Soft-fail: empty tree
    return {
      fileName,
      root: {
        key: fileName,
        path: [],
        type: { kind: "table", fields: {} },
        isExplicit: false,
      },
      flatMap,
    };
  }

  // Recursive helper
  function buildNode(
    currentValue: unknown,
    currentPath: string[],
    currentKey: string,
  ): TomlFieldSchema {
    const pathKey = currentPath.join(".");
    const kind = inferTomlFieldType(currentValue);
    const isInDefaults = pathKey in defaults;
    const isExplicit = true; // present in parsed → explicit by definition
    const tooltipKey = `${tooltipKeyPrefix}.${pathKey || currentKey}`;
    const isDisruptHigh = disruptSet.has(pathKey);
    const isUnknown = !isInDefaults && pathKey.length > 0;

    let type: TomlFieldType;
    switch (kind) {
      case "boolean":
        type = { kind: "boolean", value: currentValue as boolean };
        break;
      case "integer":
        type = { kind: "integer", value: currentValue as number };
        break;
      case "string":
        type = { kind: "string", value: currentValue as string };
        break;
      case "array-of-strings":
        type = { kind: "array-of-strings", value: currentValue as string[] };
        break;
      case "array-of-tables":
        type = { kind: "array-of-tables", value: currentValue as Record<string, unknown>[] };
        break;
      case "table": {
        const fields: Record<string, TomlFieldType> = {};
        const tableObj = currentValue as Record<string, unknown>;
        for (const subKey of Object.keys(tableObj)) {
          const subSchema = buildNode(tableObj[subKey], [...currentPath, subKey], subKey);
          fields[subKey] = subSchema.type;
        }
        type = { kind: "table", fields };
        break;
      }
      default:
        type = { kind: "unknown", rawValue: String(currentValue ?? "") };
    }

    const schema: TomlFieldSchema = {
      key: currentKey,
      path: currentPath,
      type,
      isExplicit,
      tooltipKey,
      isDisruptHigh,
      isUnknown,
    };
    if (currentPath.length > 0) {
      flatMap.set(pathKey, schema);
    }
    return schema;
  }

  // Pass 1: walk parsed AST → produce TomlFieldSchema[] с isExplicit=true (existing buildNode logic)
  const rootFields: Record<string, TomlFieldType> = {};
  for (const topKey of Object.keys(parsed)) {
    const child = buildNode(parsed[topKey], [topKey], topKey);
    rootFields[topKey] = child.type;
  }

  // Pass 2 (D-6.1): для каждого default path не присутствующего в flatMap — создать synthetic
  // schema с isExplicit=false. Plan 15.1-06 ConfigurationTab фильтрует эти synthetic nodes
  // через showAll toggle: при showAll=false isExplicit=false скрыты; при showAll=true видимы.
  //
  // Helper: infer kind + value shape from default value (typeof + Array.isArray).
  function makeSyntheticSchema(defaultPath: string, defaultValue: unknown): TomlFieldSchema {
    const segs = defaultPath.split(".");
    const leafKey = segs[segs.length - 1];
    const kind = inferTomlFieldType(defaultValue);
    let type: TomlFieldType;
    switch (kind) {
      case "boolean":
        type = { kind: "boolean", value: defaultValue as boolean };
        break;
      case "integer":
        type = { kind: "integer", value: defaultValue as number };
        break;
      case "string":
        type = { kind: "string", value: defaultValue as string };
        break;
      case "array-of-strings":
        type = { kind: "array-of-strings", value: defaultValue as string[] };
        break;
      case "array-of-tables":
        type = { kind: "array-of-tables", value: defaultValue as Record<string, unknown>[] };
        break;
      case "table":
        type = { kind: "table", fields: {} };
        break;
      default:
        type = { kind: "unknown", rawValue: String(defaultValue ?? "") };
    }
    return {
      key: leafKey,
      path: segs,
      type,
      isExplicit: false, // D-6.1: defaults-only fields hidden by default
      tooltipKey: `${tooltipKeyPrefix}.${defaultPath}`,
      isDisruptHigh: disruptSet.has(defaultPath),
      isUnknown: false, // present in defaults map → known field
    };
  }

  for (const [defaultPath, defaultValue] of Object.entries(defaults)) {
    if (!flatMap.has(defaultPath)) {
      flatMap.set(defaultPath, makeSyntheticSchema(defaultPath, defaultValue));
    }
  }

  return {
    fileName,
    root: {
      key: fileName,
      path: [],
      type: { kind: "table", fields: rootFields },
      isExplicit: parsed && Object.keys(parsed).length > 0,
    },
    flatMap,
  };
}

/**
 * Top-level: build schema trees for all 4 files in bundle.
 * Plan 15.1-05 provides defaults / disrupt / tooltip prefix maps.
 */
export function buildSchemaFromBundle(
  bundle: ConfigBundle,
  defaultsMaps: Record<ConfigFileName | "credentials", DefaultsMap>,
  disruptSets: Record<ConfigFileName | "credentials", DisruptSet>,
): Record<ConfigFileName | "credentials", FileSchemaTree> {
  return {
    vpn: buildFileSchemaTree(
      bundle.vpnToml,
      "vpn",
      defaultsMaps.vpn,
      disruptSets.vpn,
      "server.config.field_desc.vpn",
    ),
    hosts: buildFileSchemaTree(
      bundle.hostsToml,
      "hosts",
      defaultsMaps.hosts,
      disruptSets.hosts,
      "server.config.field_desc.hosts",
    ),
    rules: buildFileSchemaTree(
      bundle.rulesToml,
      "rules",
      defaultsMaps.rules,
      disruptSets.rules,
      "server.config.field_desc.rules",
    ),
    credentials: buildFileSchemaTree(
      bundle.credentialsToml,
      "credentials",
      defaultsMaps.credentials,
      disruptSets.credentials,
      "server.config.field_desc.credentials",
    ),
  };
}

/**
 * Apply edit immutably to schema tree's parsed JS object representation.
 * Walks path[], updates leaf, returns new tree object.
 *
 * NOTE: This produces an updated parsed-JS-object — not directly TomlFieldSchema.
 * Use computeRawContent below to convert back to TOML string.
 */
export function applyEditToParsed(
  parsed: Record<string, unknown>,
  path: string[],
  newValue: unknown,
): Record<string, unknown> {
  if (path.length === 0) return parsed;
  const result: Record<string, unknown> = { ...parsed };
  // Cursor walks through nested objects/arrays; treats numeric path segments
  // as array indices so paths like ["main_hosts", "0", "hostname"] target
  // the array entry's field correctly.
  let cursor: unknown = result;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const isIndex = /^\d+$/.test(key);
    if (Array.isArray(cursor)) {
      const idx = Number(key);
      const child = cursor[idx];
      const next =
        Array.isArray(child)
          ? [...child]
          : typeof child === "object" && child !== null
            ? { ...(child as Record<string, unknown>) }
            : {};
      cursor[idx] = next;
      cursor = next;
    } else if (typeof cursor === "object" && cursor !== null) {
      const obj = cursor as Record<string, unknown>;
      const child = obj[key];
      let next: unknown;
      if (Array.isArray(child)) {
        next = [...child];
      } else if (typeof child === "object" && child !== null) {
        next = { ...(child as Record<string, unknown>) };
      } else {
        next = isIndex ? [] : {};
      }
      obj[key] = next;
      cursor = next;
    } else {
      // Cannot traverse — bail out
      return result;
    }
  }
  const last = path[path.length - 1];
  if (Array.isArray(cursor)) {
    cursor[Number(last)] = newValue;
  } else if (typeof cursor === "object" && cursor !== null) {
    (cursor as Record<string, unknown>)[last] = newValue;
  }
  return result;
}

/**
 * Convert edited parsed object back to raw TOML string for save.
 *
 * smol-toml stringify() does NOT preserve comments — accepted trade-off (RESEARCH.md Q2).
 * Backend toml_edit::DocumentMut в save_config_file (Plan 15.1-01) parses + validates;
 * format-preserving merge is NOT done end-to-end through Configuration tab.
 *
 * Production stewards editing TOML via SSH retain comments; GUI-driven save через generic
 * save command rewrites whole file (sans comments). Acceptable tradeoff per Phase 15.1 scope.
 */
export function computeRawContent(parsed: Record<string, unknown>): string {
  return stringify(parsed);
}
