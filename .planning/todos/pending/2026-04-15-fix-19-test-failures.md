---
created: 2026-04-15T08:35:00Z
title: "Исправить 19 падающих тестов (97% pass rate → 100%)"
area: testing
files:
  - gui-app/src/**/*.test.tsx
---

## Problem

Milestone audit v3.0 (QA-03): 19 из 1361 тестов падают. 86/97 тестовых файлов проходят, 8 файлов падают, 3 пропущены.

Основные причины:
- Обновлённые i18n ключи (StatusBadge, Select, EmptyState перешли на t())
- Изменённые CVA варианты (Button, Badge) ломают snapshot/assertion тесты
- Моки Tauri API не обновлены под новые команды

## Solution

1. Запустить `npx vitest run` и проанализировать 8 падающих файлов
2. Обновить i18n-моки в тестах
3. Обновить assertions под новые CVA-варианты
4. Обновить Tauri command моки

Приоритет: MEDIUM — 97% pass rate, но 100% нужен для CI.
