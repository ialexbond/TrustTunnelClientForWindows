---
title: "ServerSidebar — заменить hardcoded Tailwind цвета на дизайн-токены"
area: design-system
priority: high
created: 2026-04-14
source: design-system-audit
---

ServerSidebar использует hardcoded Tailwind классы для точек статуса:
- bg-emerald-400 → bg-[var(--color-status-connected)]
- bg-amber-400 → bg-[var(--color-status-connecting)]
- bg-neutral-500 → bg-[var(--color-status-disconnected)]
- bg-red-400 → bg-[var(--color-status-error)]

Нарушает принцип единого источника цветов через токены.
