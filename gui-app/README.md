# TrustTunnel GUI

Современная GUI-оболочка для TrustTunnel VPN Client на базе **Tauri v2** + **React** + **Tailwind CSS**.

## Архитектура

```
gui-app/
├── src/                    # React frontend (Vite + Tailwind)
│   ├── components/
│   │   ├── Header.tsx      # Шапка приложения
│   │   ├── StatusPanel.tsx # Статус подключения + кнопки
│   │   ├── ConfigPanel.tsx # Настройки (путь к конфигу, log level)
│   │   └── LogPanel.tsx    # Панель логов в реальном времени
│   ├── App.tsx             # Главный компонент
│   └── main.tsx            # Точка входа
├── src-tauri/              # Tauri backend (Rust)
│   ├── src/
│   │   ├── lib.rs          # Tauri-команды: vpn_connect, vpn_disconnect
│   │   ├── sidecar.rs      # Управление C++ процессом через Sidecar
│   │   └── main.rs         # Точка входа
│   ├── binaries/           # Сюда кладётся C++ бинарник
│   ├── capabilities/       # Tauri v2 permissions
│   ├── Cargo.toml
│   └── tauri.conf.json
```

## Интеграция C++ бинарника через Sidecar

Tauri **Sidecar** позволяет упаковать внешний исполняемый файл в бандл приложения и управлять им как дочерним процессом.

### Шаг 1: Скомпилировать C++ клиент

```bash
# Из корня проекта TrustTunnelClient
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --target trusttunnel_client
```

### Шаг 2: Поместить бинарник в папку Sidecar

Tauri требует, чтобы имя файла содержало **target triple** платформы:

```
gui-app/src-tauri/binaries/
  trusttunnel_client-x86_64-pc-windows-msvc.exe   # Windows x64
  trusttunnel_client-aarch64-pc-windows-msvc.exe   # Windows ARM64
  trusttunnel_client-x86_64-unknown-linux-gnu      # Linux x64
  trusttunnel_client-x86_64-apple-darwin            # macOS x64
  trusttunnel_client-aarch64-apple-darwin           # macOS ARM64
```

Скопируйте собранный бинарник с нужным суффиксом:

```powershell
# Windows x64
copy build\trusttunnel\Release\trusttunnel_client.exe gui-app\src-tauri\binaries\trusttunnel_client-x86_64-pc-windows-msvc.exe
```

### Шаг 3: Конфигурация в tauri.conf.json

Уже настроено в `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "externalBin": ["binaries/trusttunnel_client"]
  },
  "plugins": {
    "shell": {
      "sidecar": true,
      "scope": [{
        "name": "binaries/trusttunnel_client",
        "sidecar": true,
        "args": true
      }]
    }
  }
}
```

### Шаг 4: Как это работает в коде

**Rust (src-tauri/src/sidecar.rs):**
- `spawn_trusttunnel()` — запускает `trusttunnel_client` с аргументами `-c <config> -l <loglevel>`
- Перехватывает stdout/stderr и отправляет в React через `app.emit("vpn-log", ...)`
- При завершении процесса отправляет `vpn-status` с соответствующим статусом

**React (src/App.tsx):**
- Вызывает `invoke("vpn_connect", { configPath, logLevel })` для подключения
- Слушает события `vpn-log` и `vpn-status` через `listen()`

### Преимущества Sidecar-подхода

1. **Нет перекомпиляции** — C++ код не нужно адаптировать
2. **Изоляция процессов** — VPN-клиент работает в отдельном процессе
3. **Управление жизненным циклом** — Tauri автоматически завершает sidecar при закрытии GUI
4. **Кроссплатформенность** — разные бинарники для разных ОС через target triple

## Разработка

```bash
cd gui-app

# Установить зависимости
npm install

# Запустить в режиме разработки (только фронтенд)
npm run dev

# Запустить Tauri (фронтенд + бэкенд)
npm run tauri dev

# Собрать продакшн-бандл
npm run tauri build
```

## Требования

- **Node.js** >= 18
- **Rust** >= 1.75
- **Tauri CLI** (установлен как devDependency)
- Собранный `trusttunnel_client` бинарник в `src-tauri/binaries/`
