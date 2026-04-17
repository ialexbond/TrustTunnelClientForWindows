import type { Meta, StoryObj } from "@storybook/react";
import {
  HeartPulse, Package, Zap, Users, Shield, Gauge,
  ArrowDown, ArrowUp, ChevronRight, RefreshCw, ArrowUpCircle,
  Activity, Globe, Clock, Network, AlertTriangle,
} from "lucide-react";
import { ProgressBar } from "./ProgressBar";
import { Skeleton } from "./Skeleton";
import { Card } from "./Card";

/* ═══════════════════════════════════════════════════════
   Overview Cards — карточки обзора серверной панели

   Layout: flex-wrap masonry, 800–1200px контейнер
   Row 1: Статус | Ping | Скорость | Пользователей
   Row 2: IP-адрес | Страна | Uptime | Версия протокола
   Row 3: Безопасность (2×2) | Нагрузка

   Каждая карточка: позитив / негатив / skeleton
   ═══════════════════════════════════════════════════════ */

/* ── Shared styles ── */
const muted = { color: "var(--color-text-muted)" };
const primary = { color: "var(--color-text-primary)" };
const accent = { color: "var(--color-accent-interactive)" };
const bigNum = { fontSize: "2rem", fontWeight: 600, lineHeight: 1, color: "var(--color-text-primary)" } as const;
const danger = { color: "var(--color-danger-500)" };

/* ── ECG paths ── */
const ecgPath = "M0,18 L36,18 L40,18 L44,4 L48,32 L52,10 L56,22 L60,18 L100,18 L104,18 L108,4 L112,32 L116,10 L120,22 L124,18 L160,18";
const ecgFlat = "M0,18 L160,18";

/* ── ECG animated SVG — 12-layer gradient tail ── */
const ecgLayers = [
  { dash: "36 184", opacity: 0.02, delay: "0s" },
  { dash: "33 187", opacity: 0.04, delay: "-0.05s" },
  { dash: "30 190", opacity: 0.07, delay: "-0.1s" },
  { dash: "27 193", opacity: 0.10, delay: "-0.15s" },
  { dash: "24 196", opacity: 0.14, delay: "-0.2s" },
  { dash: "21 199", opacity: 0.20, delay: "-0.25s" },
  { dash: "18 202", opacity: 0.28, delay: "-0.3s" },
  { dash: "15 205", opacity: 0.38, delay: "-0.35s" },
  { dash: "12 208", opacity: 0.50, delay: "-0.4s" },
  { dash: "9 211",  opacity: 0.65, delay: "-0.45s" },
  { dash: "6 214",  opacity: 0.82, delay: "-0.5s" },
  { dash: "3 217",  opacity: 1.0,  delay: "-0.55s" },
];

function EcgSvg({ color, path, anim }: { color: string; path: string; anim: string }) {
  return (
    <svg width="160" height="36" viewBox="0 0 160 36" fill="none">
      <style>{`@keyframes ${anim} { from { stroke-dashoffset: 20; } to { stroke-dashoffset: -100; } }`}</style>
      <path d={path} stroke={color} strokeWidth="1.5" fill="none" opacity="0.15"
        strokeLinecap="round" strokeLinejoin="round" pathLength={100} />
      {ecgLayers.map((l, i) => (
        <path key={i} d={path} stroke={color} strokeWidth="2" fill="none" opacity={l.opacity}
          strokeLinecap="round" strokeLinejoin="round" pathLength={100}
          style={{ strokeDasharray: l.dash, animation: `${anim} 2s linear infinite`, animationDelay: l.delay }} />
      ))}
    </svg>
  );
}

/* ── Title component ── */
function Title({ icon, text, onRefresh, clickable }: { icon: React.ReactNode; text: string; onRefresh?: boolean; clickable?: boolean }) {
  return (
    <div className="flex items-center justify-between mb-3" style={{ height: 32 }}>
      <div className="flex items-center gap-2 h-full whitespace-nowrap">
        <span className="flex items-center justify-center w-5 h-5 shrink-0" style={accent}>{icon}</span>
        <span className="text-lg font-[var(--font-weight-semibold)]" style={primary}>{text}</span>
      </div>
      <div className="flex items-center h-full shrink-0 ml-2">
        {onRefresh && (
          <button className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-md)] hover:bg-[var(--color-bg-hover)] transition-colors" aria-label="Обновить" style={muted}>
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
        {clickable && (
          <span className="flex items-center justify-center w-8 h-8">
            <ChevronRight className="w-5 h-5" style={muted} />
          </span>
        )}
      </div>
    </div>
  );
}

/* ── Decorator helper ── */
const wrap = (minW: number, maxW: number): Story["decorators"] =>
  [(S) => <div style={{ minWidth: minW, maxWidth: maxW, backgroundColor: "var(--color-bg-primary)", padding: 12 }}><S /></div>];

/* ── Meta ── */
const meta: Meta = {
  title: "Primitives/StatCard/Overview Variants",
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component: "Карточки обзора серверной панели. 10 карточек в 3 ряда, адаптивный flex-wrap layout (800–1200px). Каждая карточка имеет позитивное, негативное и skeleton состояния.",
      },
    },
  },
};

export default meta;
type Story = StoryObj;

/* ═══════════════════════════════════════════════════════
   1. СТАТУС — ECG heartbeat / flatline
   ═══════════════════════════════════════════════════════ */

/** Протокол работает — анимированный ECG пульс с двойным зигзагом */
export const StatusActive: Story = {
  name: "1a. Статус — работает",
  decorators: wrap(220, 280),
  render: () => (
    <Card padding="md">
      <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" />
      <div className="flex flex-col items-center justify-center gap-1.5 py-1">
        <EcgSvg color="var(--color-success-500)" path={ecgPath} anim="ecg-trace" />
        <span className="text-sm" style={muted}>Работает</span>
      </div>
    </Card>
  ),
};

/** Протокол остановлен — плоская линия с красным градиентным трейсером */
export const StatusStopped: Story = {
  name: "1b. Статус — остановлен",
  decorators: wrap(220, 280),
  render: () => (
    <Card padding="md">
      <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" />
      <div className="flex flex-col items-center justify-center gap-1.5 py-1">
        <EcgSvg color="var(--color-danger-500)" path={ecgFlat} anim="ecg-flat" />
        <span className="text-sm" style={danger}>Остановлен</span>
      </div>
    </Card>
  ),
};

/** Сервер недоступен — прочерк */
export const StatusUnavailable: Story = {
  name: "1c. Статус — недоступен",
  decorators: wrap(220, 280),
  render: () => (
    <Card padding="md">
      <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" />
      <div className="flex flex-col items-center justify-center gap-1.5 py-1" style={{ minHeight: 56 }}>
        <span style={{ ...bigNum, ...muted }}>—</span>
      </div>
    </Card>
  ),
};

/** Загрузка данных статуса */
export const StatusSkeleton: Story = {
  name: "1d. Статус — skeleton",
  decorators: wrap(220, 280),
  render: () => (
    <Card padding="md">
      <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" />
      <div className="flex flex-col items-center justify-center gap-1.5 py-1">
        <Skeleton variant="line" width={160} height={36} />
        <Skeleton variant="line" width={70} height={20} />
      </div>
    </Card>
  ),
};

/* ═══════════════════════════════════════════════════════
   2. PING — latency metric
   ═══════════════════════════════════════════════════════ */

/** Нормальный пинг — зелёный */
export const PingGood: Story = {
  name: "2a. Ping — хороший",
  decorators: wrap(140, 200),
  render: () => (
    <Card padding="md">
      <Title icon={<Activity className="w-5 h-5" />} text="Ping" onRefresh />
      <div className="flex items-baseline justify-center gap-1 py-2">
        <span style={{ ...bigNum, color: "var(--color-success-500)" }}>42</span>
        <span className="text-sm" style={muted}>ms</span>
      </div>
    </Card>
  ),
};

/** Высокий пинг — warning */
export const PingHigh: Story = {
  name: "2b. Ping — высокий",
  decorators: wrap(140, 200),
  render: () => (
    <Card padding="md">
      <Title icon={<Activity className="w-5 h-5" />} text="Ping" onRefresh />
      <div className="flex items-baseline justify-center gap-1 py-2">
        <span style={{ ...bigNum, color: "var(--color-warning-500)" }}>350</span>
        <span className="text-sm" style={muted}>ms</span>
      </div>
    </Card>
  ),
};

/** Критический пинг — 3 цифры, красный */
export const PingCritical: Story = {
  name: "2c. Ping — критический",
  decorators: wrap(140, 200),
  render: () => (
    <Card padding="md">
      <Title icon={<Activity className="w-5 h-5" />} text="Ping" onRefresh />
      <div className="flex items-baseline justify-center gap-1 py-2">
        <span style={{ ...bigNum, color: "var(--color-danger-500)" }}>1247</span>
        <span className="text-sm" style={muted}>ms</span>
      </div>
    </Card>
  ),
};

/** Пинг недоступен */
export const PingUnavailable: Story = {
  name: "2d. Ping — недоступен",
  decorators: wrap(140, 200),
  render: () => (
    <Card padding="md">
      <Title icon={<Activity className="w-5 h-5" />} text="Ping" onRefresh />
      <div className="flex items-center justify-center py-2">
        <span style={{ ...bigNum, ...muted }}>—</span>
      </div>
    </Card>
  ),
};

/** Загрузка пинга */
export const PingSkeleton: Story = {
  name: "2e. Ping — skeleton",
  decorators: wrap(140, 200),
  render: () => (
    <Card padding="md">
      <Title icon={<Activity className="w-5 h-5" />} text="Ping" onRefresh />
      <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
        <Skeleton variant="line" width={70} height={32} />
      </div>
    </Card>
  ),
};

/* ═══════════════════════════════════════════════════════
   3. СКОРОСТЬ — download / upload
   ═══════════════════════════════════════════════════════ */

/** Скорость замерена */
export const SpeedMeasured: Story = {
  name: "3a. Скорость — замерена",
  decorators: wrap(340, 440),
  render: () => (
    <Card padding="md">
      <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
      <div className="flex items-center justify-center gap-8 py-2">
        <div className="flex items-center gap-2">
          <ArrowDown className="w-7 h-7 shrink-0" style={{ color: "var(--color-success-400)" }} />
          <div className="flex items-baseline gap-1">
            <span style={bigNum}>124</span>
            <span className="text-sm whitespace-nowrap" style={muted}>Мбит/с</span>
          </div>
        </div>
        <div className="h-8 shrink-0" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
        <div className="flex items-center gap-2">
          <ArrowUp className="w-7 h-7 shrink-0" style={{ color: "var(--color-warning-500)" }} />
          <div className="flex items-baseline gap-1">
            <span style={bigNum}>98</span>
            <span className="text-sm whitespace-nowrap" style={muted}>Мбит/с</span>
          </div>
        </div>
      </div>
    </Card>
  ),
};

/** Скорость не замерена */
export const SpeedNotMeasured: Story = {
  name: "3b. Скорость — не замерена",
  decorators: wrap(340, 440),
  render: () => (
    <Card padding="md">
      <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
      <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
        <span className="text-sm" style={muted}>Не измерялась</span>
      </div>
    </Card>
  ),
};

/** Ошибка замера скорости */
export const SpeedError: Story = {
  name: "3c. Скорость — ошибка замера",
  decorators: wrap(340, 440),
  render: () => (
    <Card padding="md">
      <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
      <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
        <span className="text-sm" style={danger}>Ошибка замера</span>
      </div>
    </Card>
  ),
};

/** Загрузка скорости */
export const SpeedSkeleton: Story = {
  name: "3d. Скорость — skeleton",
  decorators: wrap(340, 440),
  render: () => (
    <Card padding="md">
      <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
      <div className="flex items-center justify-center gap-8 py-2">
        <div className="flex items-center gap-2">
          <Skeleton variant="circle" width={28} height={28} />
          <Skeleton variant="line" width={80} height={32} />
        </div>
        <div className="h-8 shrink-0" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
        <div className="flex items-center gap-2">
          <Skeleton variant="circle" width={28} height={28} />
          <Skeleton variant="line" width={80} height={32} />
        </div>
      </div>
    </Card>
  ),
};

/* ═══════════════════════════════════════════════════════
   4. ПОЛЬЗОВАТЕЛЕЙ — user count
   ═══════════════════════════════════════════════════════ */

/** Есть активные пользователи */
export const UsersActive: Story = {
  name: "4a. Пользователей — есть",
  decorators: wrap(180, 240),
  render: () => (
    <Card padding="md">
      <Title icon={<Users className="w-5 h-5" />} text="Пользователей" clickable />
      <div className="flex items-center justify-center py-2">
        <span style={bigNum}>2</span>
      </div>
    </Card>
  ),
};

/** Нет пользователей */
export const UsersEmpty: Story = {
  name: "4b. Пользователей — нет",
  decorators: wrap(180, 240),
  render: () => (
    <Card padding="md">
      <Title icon={<Users className="w-5 h-5" />} text="Пользователей" clickable />
      <div className="flex items-center justify-center py-2">
        <span style={{ ...bigNum, ...muted }}>0</span>
      </div>
    </Card>
  ),
};

/** Загрузка */
export const UsersSkeleton: Story = {
  name: "4c. Пользователей — skeleton",
  decorators: wrap(180, 240),
  render: () => (
    <Card padding="md">
      <Title icon={<Users className="w-5 h-5" />} text="Пользователей" clickable />
      <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
        <Skeleton variant="line" width={40} height={32} />
      </div>
    </Card>
  ),
};

/* ═══════════════════════════════════════════════════════
   5. IP-АДРЕС
   ═══════════════════════════════════════════════════════ */

/** IP известен */
export const IpKnown: Story = {
  name: "5a. IP — известен",
  decorators: wrap(220, 300),
  render: () => (
    <Card padding="md">
      <Title icon={<Network className="w-5 h-5" />} text="IP-адрес" />
      <div className="flex items-center justify-center py-2">
        <span style={bigNum}>185.22.153.xx</span>
      </div>
    </Card>
  ),
};

/** IP неизвестен */
export const IpUnknown: Story = {
  name: "5b. IP — неизвестен",
  decorators: wrap(220, 300),
  render: () => (
    <Card padding="md">
      <Title icon={<Network className="w-5 h-5" />} text="IP-адрес" />
      <div className="flex items-center justify-center py-2">
        <span style={{ ...bigNum, ...muted }}>—</span>
      </div>
    </Card>
  ),
};

/** Загрузка IP */
export const IpSkeleton: Story = {
  name: "5c. IP — skeleton",
  decorators: wrap(220, 300),
  render: () => (
    <Card padding="md">
      <Title icon={<Network className="w-5 h-5" />} text="IP-адрес" />
      <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
        <Skeleton variant="line" width={180} height={32} />
      </div>
    </Card>
  ),
};

/* ═══════════════════════════════════════════════════════
   6. СТРАНА
   ═══════════════════════════════════════════════════════ */

/** Страна определена */
export const CountryKnown: Story = {
  name: "6a. Страна — определена",
  decorators: wrap(180, 240),
  render: () => (
    <Card padding="md">
      <Title icon={<Globe className="w-5 h-5" />} text="Страна" />
      <div className="flex items-center justify-center py-2">
        <span className="text-xl font-[var(--font-weight-semibold)]" style={primary}>Германия</span>
      </div>
    </Card>
  ),
};

/** Страна неизвестна — прочерк (единый стиль негативных состояний) */
export const CountryUnknown: Story = {
  name: "6b. Страна — неизвестна",
  decorators: wrap(180, 240),
  render: () => (
    <Card padding="md">
      <Title icon={<Globe className="w-5 h-5" />} text="Страна" />
      <div className="flex items-center justify-center py-2">
        <span className="text-xl font-[var(--font-weight-semibold)]" style={muted}>—</span>
      </div>
    </Card>
  ),
};

/** Загрузка страны */
export const CountrySkeleton: Story = {
  name: "6c. Страна — skeleton",
  decorators: wrap(180, 240),
  render: () => (
    <Card padding="md">
      <Title icon={<Globe className="w-5 h-5" />} text="Страна" />
      <div className="flex items-center justify-center py-2">
        <Skeleton variant="line" width={120} height={28} />
      </div>
    </Card>
  ),
};

/* ═══════════════════════════════════════════════════════
   7. UPTIME
   ═══════════════════════════════════════════════════════ */

/** Сервер работает */
export const UptimeActive: Story = {
  name: "7a. Uptime — активен",
  decorators: wrap(160, 220),
  render: () => (
    <Card padding="md">
      <Title icon={<Clock className="w-5 h-5" />} text="Uptime" />
      <div className="flex items-center justify-center py-2">
        <span style={bigNum}>14д 7ч</span>
      </div>
    </Card>
  ),
};

/** Долгий uptime — с месяцами */
export const UptimeLong: Story = {
  name: "7b. Uptime — месяцы",
  decorators: wrap(160, 220),
  render: () => (
    <Card padding="md">
      <Title icon={<Clock className="w-5 h-5" />} text="Uptime" />
      <div className="flex items-center justify-center py-2">
        <span style={bigNum}>1м 14д 7ч</span>
      </div>
    </Card>
  ),
};

/** Uptime неизвестен */
export const UptimeUnknown: Story = {
  name: "7c. Uptime — неизвестен",
  decorators: wrap(160, 220),
  render: () => (
    <Card padding="md">
      <Title icon={<Clock className="w-5 h-5" />} text="Uptime" />
      <div className="flex items-center justify-center py-2">
        <span style={{ ...bigNum, ...muted }}>—</span>
      </div>
    </Card>
  ),
};

/** Загрузка uptime */
export const UptimeSkeleton: Story = {
  name: "7d. Uptime — skeleton",
  decorators: wrap(160, 220),
  render: () => (
    <Card padding="md">
      <Title icon={<Clock className="w-5 h-5" />} text="Uptime" />
      <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
        <Skeleton variant="line" width={100} height={32} />
      </div>
    </Card>
  ),
};

/* ═══════════════════════════════════════════════════════
   8. ВЕРСИЯ ПРОТОКОЛА
   ═══════════════════════════════════════════════════════ */

/** Текущая версия */
export const VersionCurrent: Story = {
  name: "8a. Версия — актуальна",
  decorators: wrap(220, 280),
  render: () => (
    <Card padding="md">
      <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
      <div className="flex items-center justify-center py-2">
        <span style={bigNum}>1.0.49</span>
      </div>
    </Card>
  ),
};

/** Доступно обновление */
export const VersionUpdate: Story = {
  name: "8b. Версия — обновление",
  decorators: wrap(220, 280),
  render: () => (
    <Card padding="md">
      <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
      <div className="flex items-center justify-center gap-3 py-2">
        <span style={bigNum}>1.0.47</span>
        <ArrowUpCircle className="w-6 h-6 shrink-0" style={{ color: "var(--color-warning-500)" }} />
      </div>
    </Card>
  ),
};

/** Загрузка версии */
export const VersionSkeleton: Story = {
  name: "8c. Версия — skeleton",
  decorators: wrap(220, 280),
  render: () => (
    <Card padding="md">
      <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
      <div className="flex items-center justify-center py-2" style={{ minHeight: 48 }}>
        <Skeleton variant="line" width={120} height={32} />
      </div>
    </Card>
  ),
};

/* ═══════════════════════════════════════════════════════
   9. БЕЗОПАСНОСТЬ — 2×2 grid
   ═══════════════════════════════════════════════════════ */

const securityItems = (items: { name: string; ok: boolean; label: string }[]) => (
  <div className="grid grid-cols-2 gap-2 mt-1">
    {items.map((item) => (
      <div key={item.name} className="rounded-[var(--radius-md)] px-3 py-2"
        style={{ backgroundColor: item.ok ? "var(--color-status-connected-bg)" : "var(--color-status-error-bg)" }}>
        <div className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</div>
        <div className="text-sm" style={{ color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)" }}>{item.label}</div>
      </div>
    ))}
  </div>
);

/** Смешанный статус (типичный) */
export const SecurityMixed: Story = {
  name: "9a. Безопасность — смешанная",
  decorators: wrap(300, 400),
  render: () => (
    <Card padding="md">
      <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
      {securityItems([
        { name: "Firewall", ok: true, label: "Активен" },
        { name: "Fail2Ban", ok: false, label: "Выключен" },
        { name: "SSH-ключ", ok: false, label: "Нет" },
        { name: "TLS", ok: true, label: "89 дн." },
      ])}
    </Card>
  ),
};

/** Всё защищено */
export const SecurityAllOk: Story = {
  name: "9b. Безопасность — всё ок",
  decorators: wrap(300, 400),
  render: () => (
    <Card padding="md">
      <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
      {securityItems([
        { name: "Firewall", ok: true, label: "Активен" },
        { name: "Fail2Ban", ok: true, label: "Активен" },
        { name: "SSH-ключ", ok: true, label: "Ed25519" },
        { name: "TLS", ok: true, label: "89 дн." },
      ])}
    </Card>
  ),
};

/** Всё отключено */
export const SecurityAllBad: Story = {
  name: "9c. Безопасность — всё плохо",
  decorators: wrap(300, 400),
  render: () => (
    <Card padding="md">
      <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
      {securityItems([
        { name: "Firewall", ok: false, label: "Выключен" },
        { name: "Fail2Ban", ok: false, label: "Выключен" },
        { name: "SSH-ключ", ok: false, label: "Нет" },
        { name: "TLS", ok: false, label: "Истёк" },
      ])}
    </Card>
  ),
};

/** TLS истекает скоро (≤14 дней) — warning, 2×2 grid */
export const SecurityTlsWarning: Story = {
  name: "9d. Безопасность — TLS скоро истекает",
  decorators: wrap(300, 400),
  render: () => (
    <Card padding="md">
      <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
      <div className="grid grid-cols-2 gap-2 mt-1">
        {[
          { name: "Firewall", label: "Активен", color: "var(--color-success-500)", bg: "var(--color-status-connected-bg)" },
          { name: "Fail2Ban", label: "Активен", color: "var(--color-success-500)", bg: "var(--color-status-connected-bg)" },
          { name: "SSH-ключ", label: "Ed25519", color: "var(--color-success-500)", bg: "var(--color-status-connected-bg)" },
        ].map((item) => (
          <div key={item.name} className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: item.bg }}>
            <div className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</div>
            <div className="text-sm" style={{ color: item.color }}>{item.label}</div>
          </div>
        ))}
        <div className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: "var(--color-status-connecting-bg)" }}>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>TLS</span>
            <AlertTriangle className="w-3.5 h-3.5" style={{ color: "var(--color-warning-500)" }} />
          </div>
          <div className="text-sm" style={{ color: "var(--color-warning-500)" }}>12 дн.</div>
        </div>
      </div>
    </Card>
  ),
};

/** TLS критически истекает (≤7 дней) — danger, 2×2 grid */
export const SecurityTlsDanger: Story = {
  name: "9e. Безопасность — TLS истекает",
  decorators: wrap(300, 400),
  render: () => (
    <Card padding="md">
      <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
      <div className="grid grid-cols-2 gap-2 mt-1">
        {[
          { name: "Firewall", label: "Активен", color: "var(--color-success-500)", bg: "var(--color-status-connected-bg)" },
          { name: "Fail2Ban", label: "Активен", color: "var(--color-success-500)", bg: "var(--color-status-connected-bg)" },
          { name: "SSH-ключ", label: "Ed25519", color: "var(--color-success-500)", bg: "var(--color-status-connected-bg)" },
        ].map((item) => (
          <div key={item.name} className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: item.bg }}>
            <div className="text-sm font-[var(--font-weight-semibold)]" style={primary}>{item.name}</div>
            <div className="text-sm" style={{ color: item.color }}>{item.label}</div>
          </div>
        ))}
        <div className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: "var(--color-status-error-bg)" }}>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>TLS</span>
            <AlertTriangle className="w-3.5 h-3.5" style={{ color: "var(--color-danger-500)" }} />
          </div>
          <div className="text-sm" style={{ color: "var(--color-danger-500)" }}>3 дн.</div>
        </div>
      </div>
    </Card>
  ),
};

/** Загрузка безопасности */
export const SecuritySkeleton: Story = {
  name: "9f. Безопасность — skeleton",
  decorators: wrap(300, 400),
  render: () => (
    <Card padding="md">
      <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
      <div className="grid grid-cols-2 gap-2 mt-1">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
            <Skeleton variant="line" width={60} height={14} className="mb-1" />
            <Skeleton variant="line" width={50} height={14} />
          </div>
        ))}
      </div>
    </Card>
  ),
};

/* ═══════════════════════════════════════════════════════
   10. НАГРУЗКА — CPU / RAM progress bars
   ═══════════════════════════════════════════════════════ */

/** Нагрузка нормальная */
export const LoadNormal: Story = {
  name: "10a. Нагрузка — нормальная",
  decorators: wrap(300, 500),
  render: () => (
    <Card padding="md">
      <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" onRefresh />
      <div className="space-y-2.5 mt-1">
        <div>
          <div className="flex items-center justify-between mb-1"><span className="text-sm" style={muted}>CPU</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>12%</span></div>
          <ProgressBar value={12} size="sm" color="success" />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1"><span className="text-sm" style={muted}>RAM</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>340 / 1024 МБ</span></div>
          <ProgressBar value={33} size="sm" color="accent" />
        </div>
      </div>
    </Card>
  ),
};

/** Критическая нагрузка */
export const LoadCritical: Story = {
  name: "10b. Нагрузка — критическая",
  decorators: wrap(300, 500),
  render: () => (
    <Card padding="md">
      <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" onRefresh />
      <div className="space-y-2.5 mt-1">
        <div>
          <div className="flex items-center justify-between mb-1"><span className="text-sm" style={muted}>CPU</span><span className="text-sm font-[var(--font-weight-semibold)]" style={danger}>95%</span></div>
          <ProgressBar value={95} size="sm" color="danger" />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1"><span className="text-sm" style={muted}>RAM</span><span className="text-sm font-[var(--font-weight-semibold)]" style={danger}>920 / 1024 МБ</span></div>
          <ProgressBar value={90} size="sm" color="danger" />
        </div>
      </div>
    </Card>
  ),
};

/** Загрузка данных нагрузки */
export const LoadSkeleton: Story = {
  name: "10c. Нагрузка — skeleton",
  decorators: wrap(300, 500),
  render: () => (
    <Card padding="md">
      <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" onRefresh />
      <div className="space-y-2.5 mt-1">
        {[1, 2].map(i => (
          <div key={i}>
            <div className="flex items-center justify-between mb-1"><Skeleton variant="line" width={30} height={20} /><Skeleton variant="line" width={60} height={20} /></div>
            <Skeleton variant="line" width="100%" height={6} />
          </div>
        ))}
      </div>
    </Card>
  ),
};

/* ═══════════════════════════════════════════════════════
   КОМПОЗИТЫ — все карточки вместе
   ═══════════════════════════════════════════════════════ */

const compositeDecorator: Story["decorators"] =
  [(S) => <div style={{ minWidth: 800, maxWidth: 1200, width: "100%", backgroundColor: "var(--color-bg-primary)", padding: 16 }}><S /></div>];

/** Все карточки — данные загружены, позитивные значения */
export const AllCards: Story = {
  name: "Все карточки",
  decorators: compositeDecorator,
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, width: "100%" }}>

      {/* ── Row 1: Статус | Ping | Скорость | Пользователей ── */}

      <Card padding="md" style={{ flex: "1 1 220px", maxWidth: 260 }}>
        <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" />
        <div className="flex flex-col items-center justify-center gap-1.5 py-1">
          <EcgSvg color="var(--color-success-500)" path={ecgPath} anim="ecg-trace-all" />
          <span className="text-sm" style={muted}>Работает</span>
        </div>
      </Card>

      <Card padding="md" style={{ flex: "1 1 140px", maxWidth: 180 }}>
        <Title icon={<Activity className="w-5 h-5" />} text="Ping" onRefresh />
        <div className="flex items-baseline justify-center gap-1 py-2">
          <span style={{ ...bigNum, color: "var(--color-success-500)" }}>42</span>
          <span className="text-sm" style={muted}>ms</span>
        </div>
      </Card>

      <Card padding="md" style={{ flex: "2 1 340px" }}>
        <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
        <div className="flex items-center justify-center gap-8 py-2">
          <div className="flex items-center gap-2">
            <ArrowDown className="w-7 h-7 shrink-0" style={{ color: "var(--color-success-400)" }} />
            <div className="flex items-baseline gap-1">
              <span style={bigNum}>124</span>
              <span className="text-sm whitespace-nowrap" style={muted}>Мбит/с</span>
            </div>
          </div>
          <div className="h-8 shrink-0" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
          <div className="flex items-center gap-2">
            <ArrowUp className="w-7 h-7 shrink-0" style={{ color: "var(--color-warning-500)" }} />
            <div className="flex items-baseline gap-1">
              <span style={bigNum}>98</span>
              <span className="text-sm whitespace-nowrap" style={muted}>Мбит/с</span>
            </div>
          </div>
        </div>
      </Card>

      <Card padding="md" style={{ flex: "1 1 180px" }}>
        <Title icon={<Users className="w-5 h-5" />} text="Пользователей" clickable />
        <div className="flex items-center justify-center py-2">
          <span style={bigNum}>2</span>
        </div>
      </Card>

      {/* ── Row 2: IP | Страна | Uptime | Версия ── */}

      <Card padding="md" style={{ flex: "1 1 240px" }}>
        <Title icon={<Network className="w-5 h-5" />} text="IP-адрес" />
        <div className="flex items-center justify-center py-2">
          <span style={bigNum}>185.22.153.xx</span>
        </div>
      </Card>

      <Card padding="md" style={{ flex: "1 1 180px" }}>
        <Title icon={<Globe className="w-5 h-5" />} text="Страна" />
        <div className="flex items-center justify-center py-2">
          <span className="text-xl font-[var(--font-weight-semibold)]" style={primary}>Германия</span>
        </div>
      </Card>

      <Card padding="md" style={{ flex: "1 1 160px" }}>
        <Title icon={<Clock className="w-5 h-5" />} text="Uptime" />
        <div className="flex items-center justify-center py-2">
          <span style={bigNum}>14д 7ч</span>
        </div>
      </Card>

      <Card padding="md" style={{ flex: "1 1 220px" }}>
        <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
        <div className="flex items-center justify-center py-2">
          <span style={bigNum}>1.0.49</span>
        </div>
      </Card>

      {/* ── Row 3: Безопасность | Нагрузка ── */}

      <Card padding="md" style={{ flex: "1 1 340px" }}>
        <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
        {securityItems([
          { name: "Firewall", ok: true, label: "Активен" },
          { name: "Fail2Ban", ok: false, label: "Выключен" },
          { name: "SSH-ключ", ok: false, label: "Нет" },
          { name: "TLS", ok: true, label: "89 дн." },
        ])}
      </Card>

      <Card padding="md" style={{ flex: "2 1 400px" }}>
        <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" onRefresh />
        <div className="space-y-2.5 mt-1">
          <div>
            <div className="flex items-center justify-between mb-1"><span className="text-sm" style={muted}>CPU</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>12%</span></div>
            <ProgressBar value={12} size="sm" color="success" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1"><span className="text-sm" style={muted}>RAM</span><span className="text-sm font-[var(--font-weight-semibold)]" style={primary}>340 / 1024 МБ</span></div>
            <ProgressBar value={33} size="sm" color="accent" />
          </div>
        </div>
      </Card>
    </div>
  ),
};

/** Все карточки в состоянии загрузки */
export const AllCardsSkeleton: Story = {
  name: "Все карточки (skeleton)",
  decorators: compositeDecorator,
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, width: "100%" }}>

      {/* Row 1 */}
      <Card padding="md" style={{ flex: "1 1 220px", maxWidth: 260 }}>
        <Title icon={<HeartPulse className="w-5 h-5" />} text="Статус" />
        <div className="flex flex-col items-center justify-center gap-1.5 py-1">
          <Skeleton variant="line" width={160} height={36} />
          <Skeleton variant="line" width={70} height={20} />
        </div>
      </Card>

      <Card padding="md" style={{ flex: "1 1 140px", maxWidth: 180 }}>
        <Title icon={<Activity className="w-5 h-5" />} text="Ping" onRefresh />
        <div className="flex items-center justify-center py-2">
          <Skeleton variant="line" width={70} height={32} />
        </div>
      </Card>

      <Card padding="md" style={{ flex: "2 1 340px" }}>
        <Title icon={<Zap className="w-5 h-5" />} text="Скорость" onRefresh />
        <div className="flex items-center justify-center gap-8 py-2">
          <div className="flex items-center gap-2"><Skeleton variant="circle" width={28} height={28} /><Skeleton variant="line" width={80} height={32} /></div>
          <div className="h-8 shrink-0" style={{ width: 1, backgroundColor: "var(--color-border)" }} />
          <div className="flex items-center gap-2"><Skeleton variant="circle" width={28} height={28} /><Skeleton variant="line" width={80} height={32} /></div>
        </div>
      </Card>

      <Card padding="md" style={{ flex: "1 1 180px" }}>
        <Title icon={<Users className="w-5 h-5" />} text="Пользователей" clickable />
        <div className="flex items-center justify-center py-2">
          <Skeleton variant="line" width={40} height={32} />
        </div>
      </Card>

      {/* Row 2 */}
      <Card padding="md" style={{ flex: "1 1 240px" }}>
        <Title icon={<Network className="w-5 h-5" />} text="IP-адрес" />
        <div className="flex items-center justify-center py-2">
          <Skeleton variant="line" width={180} height={32} />
        </div>
      </Card>

      <Card padding="md" style={{ flex: "1 1 180px" }}>
        <Title icon={<Globe className="w-5 h-5" />} text="Страна" />
        <div className="flex items-center justify-center py-2">
          <Skeleton variant="line" width={120} height={28} />
        </div>
      </Card>

      <Card padding="md" style={{ flex: "1 1 160px" }}>
        <Title icon={<Clock className="w-5 h-5" />} text="Uptime" />
        <div className="flex items-center justify-center py-2">
          <Skeleton variant="line" width={100} height={32} />
        </div>
      </Card>

      <Card padding="md" style={{ flex: "1 1 220px" }}>
        <Title icon={<Package className="w-5 h-5" />} text="Версия протокола" clickable />
        <div className="flex items-center justify-center py-2">
          <Skeleton variant="line" width={120} height={32} />
        </div>
      </Card>

      {/* Row 3 */}
      <Card padding="md" style={{ flex: "1 1 340px" }}>
        <Title icon={<Shield className="w-5 h-5" />} text="Безопасность" clickable />
        <div className="grid grid-cols-2 gap-2 mt-1">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="rounded-[var(--radius-md)] px-3 py-2" style={{ backgroundColor: "var(--color-bg-elevated)" }}>
              <Skeleton variant="line" width={60} height={14} className="mb-1" />
              <Skeleton variant="line" width={50} height={14} />
            </div>
          ))}
        </div>
      </Card>

      <Card padding="md" style={{ flex: "2 1 400px" }}>
        <Title icon={<Gauge className="w-5 h-5" />} text="Нагрузка" onRefresh />
        <div className="space-y-2.5 mt-1">
          {[1, 2].map(i => (
            <div key={i}>
              <div className="flex items-center justify-between mb-1"><Skeleton variant="line" width={30} height={20} /><Skeleton variant="line" width={60} height={20} /></div>
              <Skeleton variant="line" width="100%" height={6} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  ),
};
