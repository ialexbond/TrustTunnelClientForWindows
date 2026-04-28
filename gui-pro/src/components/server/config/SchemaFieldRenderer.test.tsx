import { describe, it } from "vitest";

/**
 * Phase 15.1 — Wave 0 stub. Realised in Plan 15.1-03.
 *
 * Will cover REQ-15.7 type dispatch:
 *   - boolean → ToggleField rendered
 *   - integer → NumberField rendered
 *   - string → StringField rendered
 *   - array-of-strings → string-array editor
 *   - array-of-tables → ArrayOfTablesBlock rendered
 *   - table (≥2 sub-sections) → TabsInline rendered (D-9.1)
 *   - unknown (D-16.1) → RawUnknownField + warning badge
 */
describe("SchemaFieldRenderer", () => {
  it.todo("dispatches boolean → ToggleField (REQ-15.7)");
  it.todo("dispatches integer → NumberField (REQ-15.7)");
  it.todo("dispatches string → StringField (REQ-15.7)");
  it.todo("dispatches array-of-strings → chip-list editor (REQ-15.7)");
  it.todo("dispatches array-of-tables → ArrayOfTablesBlock (REQ-15.7)");
  it.todo("dispatches table (≥2 sub-sections) → TabsInline (D-9.1)");
  it.todo("dispatches unknown (D-16.1) → RawUnknownField + warning badge");
});
