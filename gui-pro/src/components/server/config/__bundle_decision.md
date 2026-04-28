# Phase 15.1 — smol-toml Bundle Decision

**Decision date:** 2026-04-28
**Plan:** 15.1-02 Task 1
**Reference:** RESEARCH.md Open Question #1 (HIGH risk — +15 KB gzip budget gate)

## Measurement

`smol-toml@1.6.1` distribution measured locally on disk (after `npm install`):

| File | Raw size | Gzip (per-file) |
|------|---------:|----------------:|
| dist/date.js      | 4 942 B | 1 827 B |
| dist/error.js     | 2 787 B | 1 340 B |
| dist/extract.js   | 4 243 B | 1 668 B |
| dist/index.js     | 1 883 B |   950 B |
| dist/parse.js     | 5 694 B | 2 025 B |
| dist/primitive.js | 6 576 B | 2 240 B |
| dist/stringify.js | 6 453 B | 2 158 B |
| dist/struct.js    | 7 308 B | 2 263 B |
| dist/util.js      | 4 209 B | 1 750 B |
| **Total raw**     | **43.1 KB** | — |
| **Sum of per-file gzip** | — | **15.8 KB** (worst case, no chunk merging) |
| **Concatenated → single gzip** | — | **7.7 KB** (realistic Vite output: bundler concatenates all modules into one chunk before gzip) |

**Realistic bundle impact:** **≈ 7.7 KB gzip** when Vite/Rollup concatenates smol-toml modules
into a single chunk (default behaviour for production build). Per-file gzip overstates the
overhead because gzip's compression window is per-file, while the bundler combines source
into one stream before gzipping.

## Decision

```yaml
bundle_fallback: false
gzip_estimate: 7.7 KB
budget: 15 KB (+15 KB Phase 15.1 frontend additions budget per CONTEXT.md constraints)
margin: 7.3 KB headroom
```

**Plan 15.1-04 MUST use full smol-toml `parse()` for type inference.** No `typeof`-only
fallback path is required. The package fits comfortably within the +15 KB Phase 15.1 budget
(visitor pattern + 4 default maps + tooltips i18n delta together stay below +15 KB total).

## Verification command (re-run on next build for regression check)

```bash
cd gui-pro
node -e "
const fs=require('fs'),path=require('path'),zlib=require('zlib');
const find=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{
  const p=path.join(d,e.name);
  return e.isDirectory()?find(p):[p].filter(()=>p.endsWith('.js')&&!p.endsWith('.map.js'));
});
const all=Buffer.concat(find('node_modules/smol-toml/dist').map(f=>fs.readFileSync(f)));
console.log('smol-toml concat gzip:', (zlib.gzipSync(all).length/1024).toFixed(1), 'KB');
"
```

## Build verification (Plan 15.1-02 Task 1 acceptance)

`npm run build` ran successfully. Build output (Vite v6.4.2):
- main bundle: 667 KB raw / 186 KB gzip (existing app — unrelated)
- index bundle: 211 KB raw / 65 KB gzip (existing app — unrelated)
- smol-toml: **NOT YET INCLUDED** in build output (no consumer imports it yet — Plan 15.1-04 will add the first import)
- Tree-shake confirmed: `grep -l "smol-toml\|TomlDate\|TomlError" dist/assets/*.js` returns empty.

After Plan 15.1-04 wires `useTomlConfigState` to `parse()`, the smol-toml chunk will materialise.
Expected post-15.1-04 delta on main bundle: +7-8 KB gzip (within +15 KB budget).

## Re-evaluation trigger

Re-run the gzip measurement and revisit `bundle_fallback` if any of these change:
1. smol-toml bumps to a major version (1.x → 2.x) with API breaks
2. Plan 15.1-04 reports build chunk delta > 15 KB gzip in its SUMMARY
3. Phase 15.1 acceptance gate (`npm run build`) shows a smol-toml chunk above the budget

Until then: **bundle_fallback: false**.
