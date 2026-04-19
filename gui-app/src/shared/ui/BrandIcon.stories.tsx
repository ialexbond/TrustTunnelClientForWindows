import type { Meta, StoryObj } from "@storybook/react";

/**
 * Preview композитной program-icon: rounded square фон #0b2221 + shield
 * внутри. Будет использован в installer / taskbar / Start menu вместо
 * текущего plain-shield PNG.
 *
 * Radius ratio фиксирован 0.25 (64 / 256) — это «очень сильно
 * закругленный» в Apple/iOS стиле (app-icon corner). Shield занимает
 * 70% bounding box с центровкой.
 */

interface BrandIconProps {
  /** Final icon size in pixels. Preview рендерит scaled копию. */
  size: number;
  /** Background color. Default — token #0b2221 (darkest accent). */
  bg?: string;
  /** Shield SVG source. Dark-variant — читабельный на тёмном фоне. */
  shieldSrc?: string;
  /** Radius ratio относительно размера. 0.25 = Apple app-icon. */
  radiusRatio?: number;
  /** Shield size ratio — 0.7 = 70% от bounding box. */
  shieldRatio?: number;
}

function BrandIcon({
  size,
  bg = "#0b2221",
  shieldSrc = "/logo/shield-dark.svg",
  radiusRatio = 0.25,
  shieldRatio = 0.8,
}: BrandIconProps) {
  const shieldSize = Math.round(size * shieldRatio);
  const padding = Math.round((size - shieldSize) / 2);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * radiusRatio,
        background: bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding,
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <img
        src={shieldSrc}
        alt="TrustTunnel"
        width={shieldSize}
        height={shieldSize}
        draggable={false}
      />
    </div>
  );
}

const meta: Meta<typeof BrandIcon> = {
  title: "Brand/AppIcon",
  component: BrandIcon,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    size: { control: { type: "range", min: 16, max: 512, step: 8 } },
    radiusRatio: { control: { type: "range", min: 0, max: 0.5, step: 0.01 } },
    shieldRatio: { control: { type: "range", min: 0.4, max: 0.9, step: 0.01 } },
    bg: { control: "color" },
  },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { size: 256, radiusRatio: 0.25, shieldRatio: 0.8 },
};

/**
 * Все реальные размеры bundle'а side-by-side — смотришь как выглядит
 * в Start menu (32), Taskbar (32), Explorer large thumbnail (128),
 * .ico high-res (256).
 */
export const AllSizes: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
      {[16, 24, 32, 48, 64, 128, 256].map((s) => (
        <div key={s} style={{ textAlign: "center", fontSize: 11 }}>
          <BrandIcon size={s} />
          <div style={{ marginTop: 4, color: "#888" }}>{s}px</div>
        </div>
      ))}
    </div>
  ),
};

/** Контекст «как это будет на светлом фоне» — проверка контраста. */
export const OnLightBackground: Story = {
  args: { size: 128 },
  decorators: [
    (Story) => (
      <div style={{ background: "#f5f5f5", padding: 32, borderRadius: 8 }}>
        <Story />
      </div>
    ),
  ],
};

/** На тёмном фоне — чтобы бордер не сливался с desktop. */
export const OnDarkBackground: Story = {
  args: { size: 128 },
  decorators: [
    (Story) => (
      <div style={{ background: "#202020", padding: 32, borderRadius: 8 }}>
        <Story />
      </div>
    ),
  ],
};
