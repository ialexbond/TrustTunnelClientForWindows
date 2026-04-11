---
status: passed
phase: 02-update-ux
source: [02-01-SUMMARY.md, 02-02-SUMMARY.md]
started: 2026-04-11T08:00:00Z
updated: 2026-04-11T09:00:00Z
---

## Current Test

[all tests complete]

## Tests

### 1. "What's new" button appears
expected: When update is available and releaseNotes is non-empty, a "Что нового" button appears next to the update/download buttons in About panel.
result: pass

### 2. Changelog modal opens
expected: Clicking "Что нового" opens a modal dialog with the version in the title ("Что нового в vX.Y.Z").
result: pass

### 3. Markdown renders formatted
expected: Headers (#, ##, ###) render as styled headings, **bold** as bold text, *italic* as italic, - lists as bullet lists. No raw markdown symbols visible.
result: pass

### 4. Long changelog scrolls
expected: If changelog content is longer than the modal viewport, the content area scrolls independently. The modal itself does not grow beyond the window.
result: pass

### 5. Modal closes correctly
expected: Modal closes via: (a) X button in header, (b) "Закрыть" button in footer, (c) pressing Escape.
result: pass

### 6. Button hidden when no notes
expected: When releaseNotes is empty or undefined, the "Что нового" button does not appear.
result: pass

## Summary

total: 6
passed: 6
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
