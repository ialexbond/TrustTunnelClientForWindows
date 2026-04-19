"""
Generate ALL bundle icons (PNG full set + multi-res ICO) as composite:
rounded-square background #0b2221 + shield-dark logo at 80% size.

Reads high-res source PNG from logo/png/shield-dark-1024.png, downsamples
via LANCZOS per target size (sharp result at every resolution).

Usage:
    python scripts/gen-brand-icon.py

Outputs to gui-app/src-tauri/icons/:
    32x32.png, 64x64.png, 128x128.png, 128x128@2x.png  — таскбар + Explorer
    icon.png              — runtime window icon (512, loaded via include_bytes!)
    app-icon.png          — source (1024)
    Square*Logo.png       — Windows Store (30/44/71/89/107/142/150/284/310)
    StoreLogo.png         — Windows Store (50)
    icon.ico              — NSIS installer (multi-res 16/32/48/64/128/256)
"""
import os
import sys
from PIL import Image, ImageDraw

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(SCRIPT_DIR)
SHIELD_SRC = os.path.join(REPO_ROOT, "..", "..", "..", "logo", "png", "shield-dark-1024.png")
OUT_DIR = os.path.join(REPO_ROOT, "gui-app", "src-tauri", "icons")

BG_COLOR = (0x0b, 0x22, 0x21, 255)   # #0b2221 opaque
RADIUS_RATIO = 0.25
SHIELD_RATIO = 0.80


def make_icon(size: int, shield: Image.Image) -> Image.Image:
    """Composite rounded-square bg + shield at SHIELD_RATIO. RGBA output."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    radius = int(size * RADIUS_RATIO)

    # Rounded-rect bg
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=radius, fill=255
    )
    bg = Image.new("RGBA", (size, size), BG_COLOR)
    img.paste(bg, (0, 0), mask)

    # Shield centered
    shield_size = int(size * SHIELD_RATIO)
    resized = shield.resize((shield_size, shield_size), Image.Resampling.LANCZOS)
    pad = (size - shield_size) // 2
    img.paste(resized, (pad, pad), resized)
    return img


def main() -> int:
    shield_path = os.path.normpath(SHIELD_SRC)
    if not os.path.exists(shield_path):
        print(f"ERROR: shield source not found: {shield_path}", file=sys.stderr)
        return 1

    shield = Image.open(shield_path).convert("RGBA")
    print(f"Source: {shield_path}  {shield.size}")

    os.makedirs(OUT_DIR, exist_ok=True)

    # Standard PNG outputs (Tauri bundle + runtime window icon)
    targets = [
        (32, "32x32.png"),
        (64, "64x64.png"),
        (128, "128x128.png"),
        (256, "128x128@2x.png"),
        (512, "icon.png"),          # <- runtime window icon (include_bytes! в lib.rs)
        (1024, "app-icon.png"),     # <- source-quality master
        # Windows Store tiles (используются MSIX; оставляем синхронизированными
        # чтобы не было смешения старая/новая айконка в разных местах)
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
    for size, name in targets:
        img = make_icon(size, shield)
        out = os.path.join(OUT_DIR, name)
        img.save(out, format="PNG", optimize=True)
        print(f"  PNG  {size:>4}x{size}  -> {name}")

    # Multi-res ICO. Pillow reads `sizes` kwarg to downsample from the
    # primary image (base 256) when flat — that blurs small variants
    # because the radius scales with size. `append_images` is what
    # actually packs per-size frames into the ICO, each rendered
    # independently by make_icon() above.
    ico_sizes = [16, 32, 48, 64, 128, 256]
    ico_imgs = [make_icon(s, shield) for s in ico_sizes]
    ico_out = os.path.join(OUT_DIR, "icon.ico")
    # Put largest first (Windows Explorer picks the best-matching size;
    # largest-first gives higher-quality downsampling if OS ignores the
    # smaller frames).
    ico_imgs.reverse()
    ico_imgs[0].save(
        ico_out,
        format="ICO",
        append_images=ico_imgs[1:],
    )
    print(f"  ICO  multi-res  -> icon.ico  ({', '.join(f'{s}x{s}' for s in ico_sizes)})")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
