<!-- markdownlint-disable MD041 MD033 -->
<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="https://cdn.adguardcdn.com/website/github.com/TrustTunnel/logo_dark.svg" width="300px" alt="TrustTunnel" />
<img src="https://cdn.adguardcdn.com/website/github.com/TrustTunnel/logo_light.svg" width="300px" alt="TrustTunnel" />
</picture>
</p>

<h2 align="center">TrustTunnel Client for Windows — Pro v3.0.0 · Light v2.7.0</h2>

<p align="center">
Графический клиент для безопасного сетевого соединения по протоколу TrustTunnel.<br>
Две редакции: <b>Pro</b> (управление сервером + подключение) и <b>Light</b> (только подключение).
</p>

<p align="center">
  <a href="https://github.com/ialexbond/TrustTunnelClientForWindows/releases">Скачать</a>
  · <a href="https://github.com/TrustTunnel/TrustTunnel">TrustTunnel Endpoint</a>
  · <a href="#быстрый-старт">Быстрый старт</a>
</p>

---

## Две редакции

### TrustTunnel Pro

Полноценный клиент для администраторов: развёртывание сервера через SSH,
управление пользователями, дашборд, логи, расширенные сетевые настройки.

### TrustTunnel Light

Упрощённый клиент для обычных пользователей: импорт конфига,
подключение одной кнопкой, маршрутизация. Без серверных настроек.

| Функция | Pro | Light |
|---|:---:|:---:|
| Безопасное подключение | + | + |
| Импорт конфигурации (файл / ссылка / deeplink) | + | + |
| Маршрутизация (GeoIP, GeoSite, домены, IP) | + | + |
| Тема (тёмная / светлая), язык (RU / EN) | + | + |
| Автозапуск, автоподключение, системный трей | + | + |
| Проверка обновлений и автообновление | + | + |
| Контроль соединения (мониторинг, реконнект) | + | + |
| Генератор учётных данных | + | + |
| Управление сервером (SSH) | + | — |
| Установка протокола на сервер | + | — |
| Управление пользователями | + | — |
| Дашборд (пинг, статистика сервера) | + | — |
| Безопасность сервера (fail2ban, firewall) | + | — |
| Просмотр логов | + | — |
| Настройки соединения (протокол, MTU, Kill Switch, DNS) | + | — |
| QR-код конфигурации | + | — |

---

## Что нового в v3

Pro-редакция получила полный визуальный редизайн: двухуровневая дизайн-система
(токены + семантические переменные), нижний таббар с pill-индикатором, серверная
панель управления на 5 вкладок — **Обзор**, **Пользователи**, **Конфигурация**,
**Безопасность**, **Утилиты** — с живыми данными, skeleton loading при SSH-операциях
и встроенным Activity Log. Компоненты переведены на CVA, шрифт — Geist Sans/Mono.

---

## Что такое TrustTunnel

**TrustTunnel** — протокол адаптивного сетевого взаимодействия, работающий
поверх стандартных транспортных протоколов (HTTP/2, QUIC).

- Туннелирование TCP, UDP и ICMP трафика
- Системный сетевой адаптер (TUN) и SOCKS5-прокси
- Раздельная маршрутизация трафика (split tunneling)
- Пользовательские DNS-серверы через туннель
- Post-Quantum криптография (X25519MLKEM768)

---

## Быстрый старт

### Требования

- **Windows 10/11** (x64)
- Права администратора (для WinTUN-адаптера)

### Pro — для администраторов

1. Арендуйте Linux-сервер (Ubuntu 22+, Debian 11+), купите домен
2. Скачайте `TrustTunnel-Pro-v3.0.0-portable-win64.zip`
    из [Releases](https://github.com/ialexbond/TrustTunnelClientForWindows/releases)
3. Распакуйте и запустите `TrustTunnel.exe`
4. В мастере введите SSH-данные сервера (IP, порт, логин, пароль или SSH-ключ)
5. Приложение установит TrustTunnel-сервер и создаст конфигурацию
6. Нажмите **Подключить**

### Light — для пользователей

1. Получите конфиг-файл (.toml) или ссылку (tt://) от администратора
2. Скачайте `TrustTunnel-Light-v2.7.0-portable-win64.zip`
    из [Releases](https://github.com/ialexbond/TrustTunnelClientForWindows/releases)
3. Распакуйте и запустите `TrustTunnel Light.exe`
4. Импортируйте конфиг (файл или ссылка)
5. Нажмите кнопку подключения

> Также доступны установщики (.exe) для обеих редакций.

---

## Архитектура

```text
┌──────────────────────────────────────────────────┐
│  GUI (Tauri v2 + React + TypeScript + Tailwind)  │
│                                                  │
│  Pro: bottom nav, серверная панель 5 табов, SSH  │
│  Light: bottom nav, 4 экрана, без SSH            │
│                                                  │
│  Shared: UI-компоненты, хуки, i18n, tokens.css   │
│                                                  │
│  Sidecar: trusttunnel_client.exe (C++)           │
│  VPN-подключение через WinTUN                    │
└──────────────────────────────────────────────────┘
```

- **Frontend**: React 19 + TypeScript + Tailwind CSS
- **Backend**: Rust 1.88 (Tauri v2) — sidecar, SSH-деплой (Pro), системный трей
- **Network Core**: C++ библиотеки TrustTunnel — WinTUN-адаптер, DNS, маршрутизация

---

## Сборка из исходников

### Требования

- **Node.js** >= 18
- **Rust** >= 1.88
- **CMake** >= 3.24
- **Visual Studio 2022** (C++ Build Tools)
- **Python** >= 3.10 (для Conan)

### Сборка

```bash
# 1. Клонировать
git clone https://github.com/ialexbond/TrustTunnelClientForWindows.git
cd TrustTunnelClientForWindows

# 2. Собрать C++ sidecar
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build --target trusttunnel_client

# 3. Скопировать sidecar для Tauri
copy build\trusttunnel\trusttunnel_client.exe ^
     gui-app\src-tauri\trusttunnel_client-x86_64-pc-windows-msvc.exe

# 4. Собрать Pro
cd gui-app && npm install && npx tauri build

# 5. Собрать Light
cd ..\gui-light && npm install && npx tauri build
```

---

## Технологии

| Компонент | Технология |
|---|---|
| GUI Framework | [Tauri v2](https://v2.tauri.app) |
| Frontend | React 19 + TypeScript + Tailwind CSS |
| Backend | Rust 1.88 |
| Network Core | C++20 (TrustTunnel Client Libraries) |
| Tunnel Driver | [WinTUN](https://www.wintun.net) |
| SSH Deploy | [russh](https://github.com/warp-tech/russh) (Pro only) |

---

## Благодарности

- [AdGuard](https://adguard.com) — за разработку протокола TrustTunnel
    и открытие исходного кода клиентских библиотек

---

## Лицензия

[Apache 2.0](LICENSE)

---

## Ссылки

- [TrustTunnel Endpoint](https://github.com/TrustTunnel/TrustTunnel) —
    серверная часть протокола
- [TrustTunnel CLI Client](trusttunnel/README.md) —
    справка по консольному клиенту (C++)
