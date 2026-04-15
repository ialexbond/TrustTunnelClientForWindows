---
created: 2026-04-15T08:35:00Z
title: "Закрыть документационные гэпы v3.0: screen specs, use cases, test cases, decisions"
area: docs
files:
  - memory/v3/screens/
  - memory/v3/use-cases/
  - memory/v3/test-cases/
  - memory/v3/decisions/
---

## Problem

Milestone audit v3.0 выявил 4 частично выполненных документационных требования:

- **DOC-03**: memory/v3/screens/ содержит только control-panel.md — нужны спеки для Settings, Routing, Dashboard, Log, About, Server sub-screens
- **DOC-04**: memory/v3/use-cases/ содержит только application-shell.md — нужны use cases для каждого экрана
- **DOC-05**: memory/v3/test-cases/ содержит только application-shell.md — нужны test cases для каждого экрана
- **DOC-07**: memory/v3/decisions/ содержит 2 файла — нужны decision records для фаз 2-6

## Solution

Создать документацию для каждого экрана по шаблону:
1. screens/{screen-name}.md — состояния, переходы, ошибки, зависимости
2. use-cases/UC-{screen}.md — пользовательские сценарии
3. test-cases/TC-{screen}.md — позитивные и негативные тест-кейсы
4. decisions/phase-{N}-decisions.md — ключевые решения каждой фазы

Приоритет: LOW — документация не блокирует функциональность.
