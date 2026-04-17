---
status: partial
phase: 14-overflow-menu-dns-upstream-auto-qr
source: [14-VERIFICATION.md]
started: 2026-04-17T20:55:00Z
updated: 2026-04-17T20:55:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. QR clipboard image copy — real paste target verification
expected: SnackBar "QR-код скопирован" + PNG 240×240 с QR на белом фоне в Paint/Telegram/браузере (JSDOM не реализует Canvas + ClipboardItem, автотесты покрывают fallback path + D-29 security invariant, но реальный happy-path с paste в external app нужно проверить вручную)
result: [pending]

### 2. `npm run prerelease` full gate — clippy + build
expected: Полный зелёный `npm run prerelease` (typecheck + lint + test + clippy + build) на основной копии с sidecar binaries; worktree их не содержит по конвенции CLAUDE.md
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps
