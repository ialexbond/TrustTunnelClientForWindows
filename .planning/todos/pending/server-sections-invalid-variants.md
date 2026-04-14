---
title: "Кнопки серверных секций используют несуществующие варианты Button (secondary, success, icon=)"
area: bug
priority: high
created: 2026-04-14
source: design-system-audit
---

ServerPanel секции (ServerStatusSection, UsersSection, DangerZoneSection и др.) используют:
- variant="secondary" — не существует в Phase 2 Button API
- variant="success" — не существует
- icon={} prop — не существует

Доступные варианты: primary, danger, ghost, icon
Иконки размещаются как children, не через prop.

TypeScript ошибки уже видны при tsc --noEmit. Нужно пройти по всем секциям и обновить.
