"""
Generate ALL bundle icons (PNG full set + multi-res ICO) as composite:
rounded-square background + shield-dark logo at 80% size.

Two editions sharing the same shield source:
  - **pro**   → bg = accent-900 `#0b2221` (dark teal) → gui-pro/src-tauri/icons/
  - **light** → bg = accent-50  `#f0f4f4` (light slate) → gui-light/src-tauri/icons/

Reads high-res source PNG from logo/png/shield-dark-1024.png, downsamples
via LANCZOS per target size (sharp result at every resolution).

Usage:
    python scripts/gen-brand-icon.py            # both editions
    python scripts/gen-brand-icon.py --edition pro
    python scripts/gen-brand-icon.py --edition light

Outputs (per edition, to {edition_dir}/src-tauri/icons/):
    32x32.png, 64x64.png, 128x128.png, 128x128@2x.png  — таскбар + Explorer
    icon.png              — runtime window icon (512, loaded via include_bytes!)
    app-icon.png          — source (1024)
    Square*Logo.png       — Windows Store (30/44/71/89/107/142/150/284/310)
    StoreLogo.png         — Windows Store (50)
    icon.ico              — NSIS installer (multi-res 16/32/48/64/128/256)
"""
import argparse
import os
import sys
from PIL import Image, ImageDraw

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
SHIELD_SRC = os.path.join(REPO_ROOT, "..", "..", "..", "logo", "png", "shield-dark-1024.png")

RADIUS_RATIO = 0.20
SHIELD_RATIO = 0.80

# Per-edition configuration: bg color + output directory (relative to REPO_ROOT).
# Matches tokens.css accent-50 / accent-900 for consistency с design system.
EDITIONS = {
    "pro": {
        "bg": (0x0b, 0x22, 0x21, 255),        # #0b2221 — accent-900 (dark teal)
        "out_subdir": os.path.join("gui-pro", "src-tauri", "icons"),
    },
    "light": {
        "bg": (0xf0, 0xf4, 0xf4, 255),        # #f0f4f4 — accent-50 (light slate)
        "out_subdir": os.path.join("gui-light", "src-tauri", "icons"),
    },
}


def make_icon(size: int, shield: Image.Image, bg_color: tuple) -> Image.Image:
    """Composite rounded-square bg + shield at SHIELD_RATIO. RGBA output."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    radius = int(size * RADIUS_RATIO)

    # Rounded-rect bg
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=radius, fill=255
    )
    bg = Image.new("RGBA", (size, size), bg_color)
    img.paste(bg, (0, 0), mask)

    # Shield centered
    shield_size = int(size * SHIELD_RATIO)
    resized = shield.resize((shield_size, shield_size), Image.Resampling.LANCZOS)
    pad = (size - shield_size) // 2
    img.paste(resized, (pad, pad), resized)
    return img


def generate_edition(name: str, cfg: dict, shield: Image.Image) -> int:
    """Generate full icon set for one edition. Returns 0 on success."""
    out_dir = os.path.join(REPO_ROOT, cfg["out_subdir"])
    bg = cfg["bg"]
    bg_hex = "#{:02x}{:02x}{:02x}".format(bg[0], bg[1], bg[2])

    print(f"\n--- Edition: {name.upper()} ---")
    print(f"  bg color: {bg_hex}")
    print(f"  out dir:  {out_dir}")

    if not os.path.isdir(out_dir):
        print(f"  WARN: output dir does not exist, creating: {out_dir}")
    os.makedirs(out_dir, exist_ok=True)

    # Standard PNG outputs (Tauri bundle + runtime window icon)
    targets = [
        (32, "32x32.png"),
        (64, "64x64.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
        (512, "icon.png"),          # <- runtime window icon (include_bytes! в lib.rs)
        (1024, "app-icon.png"),     # <- source-quality master
        # Windows Store tiles (MSIX) — синхронизируем чтобы не было смешения
        # старая/новая айконка в разных местах
        (30,  "Square30x30Logo.png"),
        (44,  "Square44x44Logo.png"),
        (71,  "Square71x71Logo.png"),
        (89,  "Square89x89Logo.png"),
        (107, "Square107x107Logo.png"),
        (142, "Square142x142Logo.png"),
        (150, "Square150x150Logo.png"),
        (284, "Square284x284Logo.png"),
        (310, "Square310x310Logo.png"),
        (50,  "StoreLogo.png"),
    ]
    for size, fname in targets:
        img = make_icon(size, shield, bg)
        out = os.path.join(out_dir, fname)
        img.save(out, format="PNG", optimize=True)
        print(f"  PNG  {size:>4}x{size}  -> {fname}")

    # Multi-res ICO — Pillow `sizes=` kwarg downsamples from primary (base 256),
    # blurring small variants because radius scales with size. `append_images`
    # packs per-size frames rendered independently by make_icon().
    ico_sizes = [16, 32, 48, 64, 128, 256]
    ico_imgs = [make_icon(s, shield, bg) for s in ico_sizes]
    ico_out = os.path.join(out_dir, "icon.ico")
    # Largest first — Windows Explorer picks best-matching size; largest-first
    # gives higher-quality downsampling if OS ignores smaller frames.
    ico_imgs.reverse()
    ico_imgs[0].save(
        ico_out,
        format="ICO",
        append_images=ico_imgs[1:],
    )
    print(f"  ICO  multi-res  -> icon.ico  ({', '.join(f'{s}x{s}' for s in ico_sizes)})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate bundle icons for Pro and/or Light editions")
    parser.add_argument(
        "--edition",
        choices=["pro", "light", "both"],
        default="both",
        help="Which edition to generate (default: both)",
    )
    args = parser.parse_args()

    shield_path = os.path.normpath(SHIELD_SRC)
    if not os.path.exists(shield_path):
        print(f"ERROR: shield source not found: {shield_path}", file=sys.stderr)
        return 1

    shield = Image.open(shield_path).convert("RGBA")
    print(f"Source shield: {shield_path}  {shield.size}")

    editions_to_gen = ["pro", "light"] if args.edition == "both" else [args.edition]

    for name in editions_to_gen:
        cfg = EDITIONS[name]
        rc = generate_edition(name, cfg, shield)
        if rc != 0:
            return rc

    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
