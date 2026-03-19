<!-- markdownlint-disable MD041 MD033 -->
<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://cdn.adguardcdn.com/website/github.com/TrustTunnel/logo_dark.svg" width="300px" alt="TrustTunnel" />
<img src="https://cdn.adguardcdn.com/website/github.com/TrustTunnel/logo_light.svg" width="300px" alt="TrustTunnel" />
</picture>
</p>

<h2 align="center">TrustTunnel Client for Windows</h2>

<p align="center">
Графический клиент для защищённого сетевого туннелирования на базе протокола TrustTunnel.<br>
Автоматически разворачивает сервер на удалённой машине через SSH и подключается к нему.
</p>

<p align="center">
  <a href="https://github.com/ialexbond/TrustTunnelClient/releases">Скачать</a>
  · <a href="https://github.com/TrustTunnel/TrustTunnel">TrustTunnel Endpoint</a>
  · <a href="#быстрый-старт">Быстрый старт</a>
</p>

---

## Что такое TrustTunnel

**TrustTunnel** — использует механизмы адаптивного сетевого взаимодействия,
включая работу поверх стандартных транспортных протоколов (HTTP/2, QUIC),
что обеспечивает стабильность соединения в различных сетевых условиях.

Ключевые характеристики протокола:

- Туннелирование TCP, UDP и ICMP трафика
- Использование стандартных сетевых протоколов для обеспечения совместимости с различными сетевыми инфраструктурами
- Поддержка системного туннеля (TUN) и SOCKS5-прокси
- Split tunneling — раздельная маршрутизация трафика
- Пользовательские DNS-серверы через туннель

## Что делает этот клиент

**TrustTunnel Client for Windows** — это графическое desktop-приложение,
которое позволяет:

1. **Автоматически развернуть** VIP-сервер TrustTunnel на удалённом Linux-сервере
   через SSH (нужен только IP, логин и пароль)
2. **Подключиться** к развёрнутому серверу одним нажатием кнопки
3. **Управлять маршрутизацией** — раздельный доступ через туннель и напрямую,
   импорт/экспорт списков доменов
4. **Настраивать** параметры подключения — Kill Switch,
   Post-Quantum криптография, MTU, протокол (HTTP/2 или HTTP/3)
5. **Автоматически обновляться** через встроенный механизм

Приложение работает в **портативном режиме** — не требует установки,
все данные хранятся рядом с исполняемым файлом. Сворачивается в системный трей.

---

## Быстрый старт

### Что нужно

- **Windows 10/11** (x64)
- **Удалённый Linux-сервер** с root-доступом по SSH (Ubuntu 22+, Debian 11+)
  — например VPS от любого хостинг-провайдера
- Минимум **1 ядро CPU** и **512 МБ RAM** (рекомендуется 1 ГБ)
- **Домен**, направленный на IP сервера

### Использование

1. Скачайте архив `TrustTunnel-v*-portable-win64.zip`
   из [Releases](https://github.com/ialexbond/TrustTunnelClient/releases) (Проект предоставляется для исследовательских и образовательных целей.
Использование должно осуществляться в рамках применимого законодательства.)
2. Распакуйте в любую папку
3. Запустите `TrustTunnel.exe` (потребуются права администратора — WinTUN нуждается в них)
4. В мастере настройки введите данные SSH-сервера (IP, порт, логин, пароль)
5. Настройте параметры протокола (имя пользователя, пароль, тип сертификата и т.д.)
6. Приложение автоматически установит TrustTunnel-сервер и создаст конфигурацию
7. Перейдите на вкладку **Настройки** и нажмите **Подключить** — готово

---

## Архитектура

```text
┌──────────────────────────────────────────────────┐
│  TrustTunnel.exe (Tauri v2 + React + Tailwind)   │
│  └── GUI: настройка, подключение, маршруты, трей │
│      │                                           │
│      ├── SSH Deploy (Rust) ──► удалённый сервер  │
│      │   установка endpoint через SSH            │
│      │                                           │
│      ├── Self-Update ──► GitHub Releases          │
│      │                                           │
│      └── Sidecar: trusttunnel_client.exe (C++)   │
│          VPN-подключение через WinTUN             │
└──────────────────────────────────────────────────┘
```

- **Frontend**: React + TypeScript + Tailwind CSS
- **Backend**: Rust (Tauri v2) — управление sidecar-процессом,
  SSH-деплой сервера, системный трей
- **TUN-ядро**: C++ библиотеки TrustTunnel — сетевой стек,
  туннелирование, WinTUN-адаптер

---

## Сборка из исходников

### Требования

- **Node.js** >= 18
- **Rust** >= 1.75
- **CMake** >= 3.24
- **Visual Studio 2022** (C++ Build Tools)
- **Python** >= 3.10 (для Conan)

### Шаги

```bash
# 1. Клонировать репозиторий
git clone https://github.com/ialexbond/TrustTunnelClient.git
cd TrustTunnelClient

# 2. Собрать C++ sidecar (из корня проекта)
build_client.bat

# 3. Скопировать бинарник в папку Tauri sidecar
copy build\trusttunnel\Release\trusttunnel_client.exe ^
     gui-app\src-tauri\binaries\trusttunnel_client-x86_64-pc-windows-msvc.exe

# 4. Установить JS-зависимости и собрать GUI
cd gui-app
npm install
npm run tauri build
```

Готовый exe: `gui-app/src-tauri/target/release/trusttunnel.exe`

### Создание портативного архива

```powershell
$rel = "gui-app\src-tauri\target\release"
mkdir TrustTunnel-Portable
Copy-Item "$rel\trusttunnel.exe"       "TrustTunnel-Portable\TrustTunnel.exe"
Copy-Item "$rel\trusttunnel_client.exe" "TrustTunnel-Portable\"
Copy-Item "$rel\wintun.dll"            "TrustTunnel-Portable\"
Copy-Item "$rel\vcruntime140.dll"      "TrustTunnel-Portable\"
Copy-Item "$rel\vcruntime140_1.dll"    "TrustTunnel-Portable\"
Compress-Archive "TrustTunnel-Portable\*" "TrustTunnel-portable-win64.zip"
```

---

## Известные ограничения

- **Только Windows** — GUI-клиент поддерживает только Windows и не планируется для других платформ.
  Приложение использует WinTUN-адаптер, UAC и системный трей, специфичные для Windows.

## Известные проблемы

- **Потеря сетевого подключения при активном VPN** — через неопределённое время после подключения
  (от 30 минут до нескольких часов) может полностью отключиться интернет из-за сброса основного
  сетевого адаптера. Проблема **не связана с данным GUI-приложением** — она воспроизводится и в
  оригинальном CLI-клиенте TrustTunnel, то есть находится на уровне исходного кода
  [TrustTunnel Client](https://github.com/TrustTunnel/TrustTunnelClient).
  В качестве обходного решения в приложении реализован механизм автоматического восстановления:
  при отключении сетевого адаптера VPN-соединение разрывается, клиент ожидает восстановления
  сети и затем автоматически переподключается.

---

## Планы развития

- [ ] Поддержка нескольких серверов / профилей
- [ ] Split tunneling в GUI (выбор приложений/сайтов), использование geoip\geodat

---

## Технологии

| Компонент | Технология |
|---|---|
| GUI Framework | [Tauri v2](https://v2.tauri.app) |
| Frontend | React + TypeScript + Tailwind CSS |
| Backend | Rust |
| TUN Core | C++ (TrustTunnel Client Libraries) |
| Tunnel Driver | [WinTUN](https://www.wintun.net) |
| SSH Deploy | [russh](https://github.com/warp-tech/russh) |

---

## Благодарности

- [AdGuard](https://adguard.com) — за разработку протокола TrustTunnel
  и открытие исходного кода клиентских библиотек
- Клиентское приложение создано методом **вайб-кодинга** —
  AI-ассистент писал код на основе описания задач на естественном языке

---

## Лицензия

[Apache 2.0](LICENSE)

---

## Ссылки

- [TrustTunnel Endpoint](https://github.com/TrustTunnel/TrustTunnel) —
  серверная часть протокола
- [TrustTunnel CLI Client](trusttunnel/README.md) —
  справка по консольному клиенту (C++)
