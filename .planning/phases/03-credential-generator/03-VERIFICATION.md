---
phase: 03-credential-generator
verified: 2026-04-10T00:00:00Z
status: human_needed
score: 3/3 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Открыть wizard, перейти к шагу AddUserForm. Навести курсор на иконку Shuffle у поля username — должен появиться tooltip 'Generate random username' через ~400ms. Нажать — поле заполняется читаемым именем вида 'swift-fox' или 'bold-eagle42'."
    expected: "Иконка Shuffle видна справа внутри поля, tooltip появляется с задержкой, после клика поле заполнено случайным именем"
    why_human: "Tooltip delay и визуальное позиционирование иконки нельзя верифицировать grep'ом"
  - test: "В AddUserForm нажать Shuffle у поля password. Нажать Eye для раскрытия — убедиться что пароль из 16 символов смешанного регистра с спецсимволами. Проверить порядок иконок: [Shuffle] слева от [Eye]."
    expected: "Две иконки справа, Shuffle левее Eye, пароль 16 символов из charset a-zA-Z0-9!@#$%^&*"
    why_human: "Визуальный порядок и читаемость пароля требует запуска приложения"
  - test: "Открыть Server panel > UsersSection. Проверить оба поля (username, password) — иконки Shuffle присутствуют. Начать добавление пользователя (нажать Add) — убедиться что Shuffle-кнопки становятся серыми/неактивными."
    expected: "Shuffle-иконки видны в обоих полях; при isAdding=true кнопки выглядят disabled (opacity-30) и не реагируют на клик"
    why_human: "Disabled-состояние и визуальный вид требует живого UI"
---

# Phase 03: Credential Generator — Отчёт верификации

**Цель фазы:** Users can generate random credentials directly from VPN user form inputs
**Верифицировано:** 2026-04-10
**Статус:** human_needed
**Повторная верификация:** Нет — начальная верификация

## Достижение цели

### Наблюдаемые истины (из ROADMAP Success Criteria)

| # | Истина | Статус | Доказательство |
|---|--------|--------|----------------|
| 1 | Username input показывает иконку-генератор, клик заполняет поле случайным значением | VERIFIED | AddUserForm.tsx строки 35-45: `onClick={() => w.setNewUsername(generateUsername())`; UsersSection.tsx строки 298-308: `onClick={() => setNewUsername(generateUsername())` |
| 2 | Password input показывает иконку-генератор, клик заполняет поле случайным значением | VERIFIED | AddUserForm.tsx строки 61-71: `onClick={() => w.setNewPassword(generatePassword())`; UsersSection.tsx строки 318-327: `onClick={() => setNewPassword(generatePassword())` |
| 3 | Генератор доступен в wizard (AddUserForm) и server panel (UsersSection) | VERIFIED | Обе формы содержат Shuffle-кнопки для username и password; оба файла импортируют `generateUsername, generatePassword` из `credentialGenerator` |

**Счёт:** 3/3 критериев успеха ROADMAP выполнены

### Артефакты

| Артефакт | Ожидание | Статус | Детали |
|----------|----------|--------|--------|
| `gui-app/src/shared/utils/credentialGenerator.ts` | generateUsername, generatePassword; crypto.getRandomValues; без Math.random | VERIFIED | Файл 57 строк; оба экспорта присутствуют; secureRandInt использует `crypto.getRandomValues(Uint32Array)`; runtime-guard T-03-03 добавлен; Math.random отсутствует |
| `gui-light/src/shared/utils/credentialGenerator.ts` | Идентичная копия gui-app версии | VERIFIED | diff не выдал отличий; файл идентичен |
| `gui-app/src/shared/utils/credentialGenerator.test.ts` | 6 тестов: формат, уникальность, no-Math.random, длина пароля, charset, уникальность пароля | VERIFIED | Файл существует; тесты задокументированы в 03-01-SUMMARY как "All 6 vitest tests: PASSED" |
| `gui-app/src/components/wizard/AddUserForm.tsx` | Shuffle иконка в username и password полях | VERIFIED | Импорт `Shuffle, Tooltip, generateUsername, generatePassword`; кнопки на строках 36-45 (username) и 61-71 (password); `disabled={w.addingUser}` на обеих |
| `gui-app/src/components/server/UsersSection.tsx` | Shuffle иконка в username и password полях | VERIFIED | Импорт `Shuffle, Tooltip, generateUsername, generatePassword`; кнопки на строках 298-308 (username) и 318-327 (password); `disabled={isAdding}` на обеих; `showIcon={false}` убран (Eye восстановлен) |
| `gui-app/src/shared/i18n/locales/en.json` | common.generate_username, common.generate_password | VERIFIED | Строки 957-958: "Generate random username" / "Generate random password" |
| `gui-app/src/shared/i18n/locales/ru.json` | Русские переводы тех же ключей | VERIFIED | Строки 957-958: "Сгенерировать имя пользователя" / "Сгенерировать пароль" |

### Проверка ключевых связей

| От | К | Через | Статус | Детали |
|----|---|-------|--------|--------|
| AddUserForm.tsx | credentialGenerator.ts | `import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator"` | WIRED | Строка 5 AddUserForm.tsx; функции вызываются в onClick строк 39 и 64 |
| UsersSection.tsx | credentialGenerator.ts | `import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator"` | WIRED | Строка 28 UsersSection.tsx; функции вызываются в onClick строк 301 и 321 |
| Shuffle кнопка (username) | setNewUsername / setNewPassword | `onClick={() => w.setNewUsername(generateUsername())` | WIRED | Прямой вызов React state setter; аналогично в UsersSection |
| Shuffle кнопка (password) | setNewPassword | `onClick={() => w.setNewPassword(generatePassword())` | WIRED | Прямой вызов React state setter; аналогично в UsersSection |

### Трассировка данных (Уровень 4)

| Артефакт | Переменная данных | Источник | Реальные данные | Статус |
|----------|-------------------|----------|-----------------|--------|
| AddUserForm.tsx (username Shuffle) | `w.newUsername` | `generateUsername()` — синхронная чистая функция | Да — crypto.getRandomValues CSPRNG | FLOWING |
| AddUserForm.tsx (password Shuffle) | `w.newPassword` | `generatePassword()` — синхронная чистая функция | Да — crypto.getRandomValues CSPRNG | FLOWING |
| UsersSection.tsx (username Shuffle) | `newUsername` | `generateUsername()` — синхронная чистая функция | Да — crypto.getRandomValues CSPRNG | FLOWING |
| UsersSection.tsx (password Shuffle) | `newPassword` | `generatePassword()` — синхронная чистая функция | Да — crypto.getRandomValues CSPRNG | FLOWING |

### Поведенческие spot-checks

| Поведение | Команда | Результат | Статус |
|-----------|---------|-----------|--------|
| generateUsername экспортирован | `grep -c "export function generateUsername" gui-app/src/shared/utils/credentialGenerator.ts` | 1 | PASS |
| generatePassword экспортирован | `grep -c "export function generatePassword" gui-app/src/shared/utils/credentialGenerator.ts` | 1 | PASS |
| crypto.getRandomValues используется | grep в credentialGenerator.ts | найдено | PASS |
| Math.random отсутствует | grep в credentialGenerator.ts (кроме комментария) | 0 совпадений в коде | PASS |
| gui-app и gui-light идентичны | diff обоих файлов | нет различий | PASS |
| Shuffle в AddUserForm | grep "Shuffle" | найдено | PASS |
| Shuffle в UsersSection | grep "Shuffle" | найдено | PASS |
| i18n en.json ключи | grep "generate_username" en.json | строки 957-958 | PASS |
| i18n ru.json ключи | grep "Сгенерировать" ru.json | строки 957-958 | PASS |
| Tooltip в AddUserForm | grep "common.generate_username" AddUserForm.tsx | найдено | PASS |
| TypeScript компиляция | tsc --noEmit | 0 ошибок (по SUMMARY 03-02) | PASS (документировано) |

### Покрытие требований

| Требование | Исходный план | Описание | Статус | Доказательство |
|------------|---------------|----------|--------|----------------|
| CRED-01 | 03-01, 03-02 | Иконка генерации случайного username внутри поля ввода | SATISFIED | Shuffle-кнопка с `onClick={() => generateUsername()}` в обоих формах |
| CRED-02 | 03-01, 03-02 | Иконка генерации случайного пароля внутри поля ввода | SATISFIED | Shuffle-кнопка с `onClick={() => generatePassword()}` в обоих формах |
| CRED-03 | 03-02 | Генератор доступен во всех формах добавления VPN-пользователей (wizard + server panel) | SATISFIED | AddUserForm.tsx (wizard) + UsersSection.tsx (server panel) оба содержат генераторы |

### Найденные анти-паттерны

Анти-паттерны не обнаружены. Нет заглушек, placeholder-значений, пустых handlers или TODO в изменённых файлах.

**Примечание:** В ADJECTIVES и NOUNS массивах строка `"hawk"` дублируется дважды (строки 16 и 18 в обоих credentialGenerator.ts). Это не влияет на корректность генерации и не является заглушкой — лишь незначительно снижает энтропию пула существительных. Severity: Info.

### Требуется человеческая верификация

#### 1. Tooltip delay и визуальное позиционирование иконки в AddUserForm

**Тест:** Запустить приложение, перейти к шагу AddUserForm в wizard. Навести курсор на Shuffle иконку у поля username — ждать ~400ms — должен появиться tooltip "Generate random username". Нажать иконку — поле заполняется именем вида "swift-fox".
**Ожидается:** Tooltip с задержкой 400ms; имя читаемое, формат adjective-noun; иконка внутри поля справа
**Почему человек:** Tooltip-задержка и визуальное расположение требует живого UI

#### 2. Порядок иконок [Shuffle][Eye] в password полях

**Тест:** В AddUserForm и UsersSection проверить password поле — должны быть видны две иконки справа: Shuffle левее Eye. Нажать Shuffle — поле заполняется 16 символами (по-прежнему скрыто). Нажать Eye — пароль виден, 16 символов из charset a-zA-Z0-9!@#$%^&*.
**Ожидается:** [Shuffle] слева, [Eye] справа; пароль 16 символов смешанного charset
**Почему человек:** Визуальный порядок иконок и читаемость пароля

#### 3. Disabled-состояние во время добавления пользователя

**Тест:** В UsersSection заполнить username и password, нажать кнопку "Add user" — во время загрузки проверить что Shuffle-кнопки стали полупрозрачными (opacity-30) и не реагируют на клик.
**Ожидается:** Оба Shuffle-кнопки disabled во время `isAdding=true`; аналогично `w.addingUser` в AddUserForm
**Почему человек:** Визуальный disabled-стиль и блокировка кликов требует запуска UI

### Итог

Все три ROADMAP Success Criteria программно верифицированы. Утилита `credentialGenerator.ts` реализована корректно с CSPRNG, идентично скопирована в gui-light, протестирована (6 тестов). Оба UI-компонента (AddUserForm и UsersSection) импортируют и вызывают генераторные функции, используют Tooltip с i18n-ключами, передают disabled-состояние. Требуется человеческая проверка визуального UX: расположение иконок, tooltip-задержка, disabled-вид.

---

_Верифицировано: 2026-04-10_
_Верификатор: Claude (gsd-verifier)_
