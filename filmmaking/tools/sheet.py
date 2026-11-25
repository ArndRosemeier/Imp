#!/usr/bin/env python3
"""sheet.py <out.jpg> <cols> <img>...  : labelled contact sheet at 960 px per tile, for inspecting stills closely."""
import sys, os
from PIL import Image, ImageDraw, ImageFont
out, cols, files = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
w, h = (960, 540) if cols <= 2 else (640, 360)
f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
sh = Image.new("RGB", (cols * w, -(-len(files) // cols) * h))
for n, p in enumerate(files):
    im = Image.open(p).convert("RGB").resize((w, h)); d = ImageDraw.Draw(im)
    t = os.path.splitext(os.path.basename(p))[0]; d.rectangle((0, 0, 14 * len(t) + 16, 32), fill=(0, 0, 0)); d.text((8, 4), t, font=f, fill=(255, 235, 60))
    sh.paste(im, ((n % cols) * w, (n // cols) * h))
sh.save(out, quality=88); print(out)
