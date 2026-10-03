import { useEffect, useRef } from "react";

/**
 * IpDustOverlay — a slow, gentle field of small <canvas> particles (Telegram-spoiler style) used
 * to MASK the server IP while it is hidden. It is rendered absolutely over the (transparent) IP
 * value; the caller cross-fades the value vs. this overlay on reveal.
 *
 * `active` pauses the animation: the requestAnimationFrame loop runs ONLY while active (i.e. while
 * the IP is hidden), so a revealed card costs nothing. The particle colour is read from the
 * element's resolved `color` (set via CSS var) and re-read periodically, so it follows the theme.
 *
 * NOT a security control — it obscures the address from casual shoulder-surfing, it is not a
 * cryptographic mask.
 */
export function IpDustOverlay({ active = true }: { active?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !parent || !ctx) return;

    let raf = 0;
    let dpr = 1;
    let colorTick = 0;
    let fill = "rgb(150,150,160)";
    type Particle = { x: number; y: number; vx: number; vy: number; life: number; ttl: number; r: number };
    let parts: Particle[] = [];

    // IN-02 (10.1 review) — tuning constants, all hand-picked for a calm, tasteful
    // «spoiler dust» look (CSS-px values scaled by dpr so density/speed read the same
    // on HiDPI): drift speed ±0.22 px/frame (slow, not a scatter); lifetime 55–120
    // frames (~1–2 s) with a random head-start (×70) so particles don't all fade in
    // unison; radius 0.45–1.05 px (sub-pixel specks). Density is set in resize().
    const spawn = (): Particle => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.22 * dpr,
      vy: (Math.random() - 0.5) * 0.22 * dpr,
      life: Math.random() * 70,
      ttl: 55 + Math.random() * 65,
      r: (Math.random() * 0.6 + 0.45) * dpr,
    });

    const readColor = () => {
      const c = getComputedStyle(canvas).color;
      if (c) fill = c;
    };

    const resize = () => {
      const rect = parent.getBoundingClientRect();
      // WR-03 (10.1 review): if the parent has no layout box yet (mounted under an
      // off-screen / display:none tab), bail instead of building an invisible 1×1
      // particle field — the ResizeObserver re-fires resize() once it gets a real
      // size, so the dust appears correctly the moment the card becomes visible.
      if (rect.width === 0 || rect.height === 0) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      // Decorative density over the hidden (transparent) value — the address text is not rendered
      // when hidden, so the dust only needs to read as a tasteful particle field.
      // IN-02: ~1 particle per 34 device-px², clamped to [120, 620] so both a short IP and a long
      // IPv6 read as an even field without the count exploding on a wide card.
      const n = Math.min(620, Math.max(120, Math.round((canvas.width * canvas.height) / 34)));
      parts = Array.from({ length: n }, spawn);
    };

    const tick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (colorTick++ % 40 === 0) readColor();
      ctx.fillStyle = fill;
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.life += 1;
        if (p.life >= p.ttl || p.x < 0 || p.y < 0 || p.x > canvas.width || p.y > canvas.height) {
          Object.assign(p, spawn(), { life: 0 });
        }
        ctx.globalAlpha = Math.sin((p.life / p.ttl) * Math.PI) * 0.95; // fade in, then out
        ctx.fillRect(p.x, p.y, p.r * 2, p.r * 2); // square specks — cheaper than arc() at this density
      }
      raf = requestAnimationFrame(tick);
    };

    readColor();
    resize();
    tick();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ color: "var(--color-text-secondary)" }}
    />
  );
}
