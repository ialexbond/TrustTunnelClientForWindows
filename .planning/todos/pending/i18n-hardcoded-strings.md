---
title: "Заменить зашитые русские строки на i18n-ключи в Select, StatusBadge, EmptyState"
area: design-system
priority: medium
created: 2026-04-14
source: design-system-audit
---

Компоненты содержат русские строки напрямую вместо i18n:
- Select.tsx: placeholder "Выберите..."
- StatusBadge.tsx: labels "Подключено", "Подключение...", "Ошибка", "Отключено"
- EmptyState.tsx: heading "Ничего нет"

Нужно заменить на t() вызовы для поддержки мультиязычности.
