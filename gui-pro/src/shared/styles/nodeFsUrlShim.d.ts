// Minimal ambient types for the two `node:` builtins `selfHostedFonts.test.ts` calls.
//
// This package's tsconfig ships no `@types/node` (see `appSettingsContract.test.ts` for the same
// constraint documented against `node:fs`) — deliberately narrow, to keep Node globals out of the
// frontend source tree. Widening the `types` list project-wide for one guard test is out of scope
// here, so this file declares only the exports actually used, typed precisely enough to avoid `any`
// (lint runs `--max-warnings 0`, and `no-explicit-any` is a warning).
//
// A `declare module "node:fs"` written INSIDE a file that itself has top-level `import`/`export`
// is treated by TypeScript as a module AUGMENTATION (extending an existing module's shape), which
// then fails with "module cannot be found" because no real module declaration exists to augment.
// A standalone `.d.ts` with no top-level import/export is a script file instead, where the same
// syntax is a genuine ambient module DECLARATION — hence this file is separate and import-free.
//
// `readFileSync` returns `Uint8Array` — a plain ES2020 type already in `lib`, not the Node-specific
// `Buffer` — so callers read bytes by hand instead of Buffer-only helpers like `.readUInt32BE()`.
declare module "node:fs" {
  // `import("node:url").URL`, not the bare `URL` name: unqualified inside this ambient block it
  // would resolve to lib.dom's global `URL` (this tsconfig's `lib` includes "DOM"), which is a
  // structurally different, wider type than our minimal node:url shim below — and an instance of
  // the minimal shim is not assignable to it.
  export function readFileSync(
    path: import("node:url").URL | string,
    encoding: "utf-8",
  ): string;
  export function readFileSync(path: import("node:url").URL | string): Uint8Array;
}

declare module "node:url" {
  export class URL {
    constructor(input: string, base?: string | URL);
  }
}
