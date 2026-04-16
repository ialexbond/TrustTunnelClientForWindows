import type { Meta, StoryObj } from "@storybook/react";
import {
  HeartPulse,
  Package,
  Zap,
  Users,
  Shield,
  Gauge,
} from "lucide-react";
import { StatCard } from "./StatCard";
import { StatusIndicator } from "./StatusIndicator";
import { ProgressBar } from "./ProgressBar";
import { Card } from "./Card";
import { cn } from "../lib/cn";

/* ═══════════════════════════════════════════════════════
   StatCard — Overview Tab Variants (Phase 13)

   Все 6 карточек построены на базе StatCard или Card
   в единой стилистике. Каждая — отдельная story.
   ═══════════════════════════════════════════════════════ */

const meta: Meta = {
  title: "Primitives/StatCard/Overview Variants",
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div style={{ width: 280, backgroundColor: "var(--color-bg-primary)", padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

/* ── 1. Статус сервера ── */
export const Status: Story = {
  name: "1. Статус",
  render: () => (
    <Card padding="md">
      <div className="flex flex-col gap-1">
        <div className="flex items-start">
          <span aria-hidden="true" style={{ color: "var(--color-accent-interactive)" }}>
            <HeartPulse className="w-4 h-4" />
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StatusIndicator status="success" size="md" pulse />
          <span className="text-xl font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
            Работает
          </span>
        </div>
        <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          Статус сервера
        </div>
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>Ping</span>
            <span className="text-xs font-[var(--font-weight-semibold)]" style={{ color: "var(--color-success-500)" }}>42ms</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>IP</span>
            <span className="text-xs font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>185.22.153.xx</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>Страна</span>
            <span className="text-xs" style={{ color: "var(--color-text-primary)" }}>🇩🇪 Германия</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>Uptime</span>
            <span className="text-xs font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>14д 7ч</span>
          </div>
        </div>
      </div>
    </Card>
  ),
};

/* ── 2. Версия протокола ── */
export const Version: Story = {
  name: "2. Версия протокола",
  render: () => (
    <StatCard
      icon={<Package className="w-4 h-4" />}
      label="Версия протокола"
      value="1.0.49"
    />
  ),
};

export const VersionWithUpdate: Story = {
  name: "2b. Версия (обновление)",
  render: () => (
    <StatCard
      icon={<Package className="w-4 h-4" />}
      label="Версия протокола"
      value="1.0.47"
      trend={-1}
    />
  ),
};

/* ── 3. Скорость (общая карточка) ── */
export const Speed: Story = {
  name: "3. Скорость",
  render: () => (
    <Card padding="md">
      <div className="flex flex-col gap-1">
        <div className="flex items-start">
          <span aria-hidden="true" style={{ color: "var(--color-accent-interactive)" }}>
            <Zap className="w-4 h-4" />
          </span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-xl font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
            124
          </span>
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>↓</span>
          <span className="text-sm" style={{ color: "var(--color-text-muted)" }}>/</span>
          <span className="text-xl font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
            98
          </span>
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>↑</span>
          <span className="text-xs ml-1" style={{ color: "var(--color-text-muted)" }}>Мбит/с</span>
        </div>
        <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          Скорость
        </div>
      </div>
    </Card>
  ),
};

export const SpeedNotMeasured: Story = {
  name: "3b. Скорость (не замерена)",
  render: () => (
    <StatCard
      icon={<Zap className="w-4 h-4" />}
      label="Скорость"
      value="—"
    />
  ),
};

/* ── 4. Пользователей ── */
export const UsersCount: Story = {
  name: "4. Пользователей",
  render: () => (
    <StatCard
      icon={<Users className="w-4 h-4" />}
      label="Пользователей"
      value="2"
    />
  ),
};

/* ── 5. Безопасность ── */
export const Security: Story = {
  name: "5. Безопасность",
  render: () => (
    <Card padding="md">
      <div className="flex flex-col gap-1">
        <div className="flex items-start">
          <span aria-hidden="true" style={{ color: "var(--color-accent-interactive)" }}>
            <Shield className="w-4 h-4" />
          </span>
        </div>
        <div className="text-xl font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
          2 / 4
        </div>
        <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          Безопасность
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {[
            { name: "Firewall", ok: true },
            { name: "Fail2Ban", ok: false },
            { name: "SSH", ok: false },
            { name: "TLS", ok: true },
          ].map((item) => (
            <div
              key={item.name}
              className="rounded-[var(--radius-sm)] px-2 py-1 text-xs"
              style={{
                backgroundColor: item.ok ? "rgba(16, 185, 129, 0.08)" : "rgba(224, 85, 69, 0.08)",
                color: item.ok ? "var(--color-success-500)" : "var(--color-danger-500)",
              }}
            >
              {item.name}
            </div>
          ))}
        </div>
      </div>
    </Card>
  ),
};

/* ── 6. Нагрузка ── */
export const Load: Story = {
  name: "6. Нагрузка",
  render: () => (
    <Card padding="md">
      <div className="flex flex-col gap-1">
        <div className="flex items-start">
          <span aria-hidden="true" style={{ color: "var(--color-accent-interactive)" }}>
            <Gauge className="w-4 h-4" />
          </span>
        </div>
        <div className="text-xl font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
          12%
        </div>
        <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          Нагрузка
        </div>
        <div className="mt-2 space-y-2">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>CPU</span>
              <span className="text-xs font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>12%</span>
            </div>
            <ProgressBar value={12} size="sm" color="success" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>RAM</span>
              <span className="text-xs font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>340 / 1024 МБ</span>
            </div>
            <ProgressBar value={33} size="sm" color="accent" />
          </div>
        </div>
      </div>
    </Card>
  ),
};

/* ── Все 6 вместе — grid ── */
export const AllOverviewCards: Story = {
  name: "Все карточки (grid)",
  decorators: [
    (Story) => (
      <div style={{ width: 800, backgroundColor: "var(--color-bg-primary)", padding: 16 }}>
        <Story />
      </div>
    ),
  ],
  render: () => (
    <div className="grid grid-cols-3 gap-3">
      {/* Row 1 */}
      <Card padding="md">
        <div className="flex flex-col gap-1">
          <div className="flex items-start">
            <span aria-hidden="true" style={{ color: "var(--color-accent-interactive)" }}><HeartPulse className="w-4 h-4" /></span>
          </div>
          <div className="flex items-center gap-2">
            <StatusIndicator status="success" size="sm" pulse />
            <span className="text-xl font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>Работает</span>
          </div>
          <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>Статус</div>
        </div>
      </Card>

      <StatCard icon={<Package className="w-4 h-4" />} label="Версия протокола" value="1.0.49" />

      <Card padding="md">
        <div className="flex flex-col gap-1">
          <div className="flex items-start">
            <span aria-hidden="true" style={{ color: "var(--color-accent-interactive)" }}><Zap className="w-4 h-4" /></span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className="text-xl font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>124</span>
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>↓ /</span>
            <span className="text-xl font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>98</span>
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>↑ Мбит/с</span>
          </div>
          <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>Скорость</div>
        </div>
      </Card>

      {/* Row 2 */}
      <StatCard icon={<Users className="w-4 h-4" />} label="Пользователей" value="2" />

      <Card padding="md">
        <div className="flex flex-col gap-1">
          <div className="flex items-start">
            <span aria-hidden="true" style={{ color: "var(--color-accent-interactive)" }}><Shield className="w-4 h-4" /></span>
          </div>
          <div className="text-xl font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>2 / 4</div>
          <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>Безопасность</div>
        </div>
      </Card>

      <Card padding="md">
        <div className="flex flex-col gap-1">
          <div className="flex items-start">
            <span aria-hidden="true" style={{ color: "var(--color-accent-interactive)" }}><Gauge className="w-4 h-4" /></span>
          </div>
          <div className="text-xl font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>12%</div>
          <div className="text-sm" style={{ color: "var(--color-text-muted)" }}>Нагрузка</div>
          <div className="mt-1">
            <ProgressBar value={12} size="sm" color="success" />
          </div>
        </div>
      </Card>
    </div>
  ),
};
