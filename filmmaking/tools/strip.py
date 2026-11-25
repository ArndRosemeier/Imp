#!/usr/bin/env python3
"""strip.py <clip> <out.jpg> [n=8] [t0 t1]: n evenly spaced frames of a clip, time-stamped, on one sheet (4 per row, 480 px wide) for a close look at motion."""
import subprocess, sys, tempfile, os
from PIL import Image, ImageDraw
clip, out = sys.argv[1], sys.argv[2]; n = int(sys.argv[3]) if len(sys.argv) > 3 else 8
dur = float(subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",clip],capture_output=True,text=True).stdout)
t0 = float(sys.argv[4]) if len(sys.argv) > 4 else 0.0; t1 = float(sys.argv[5]) if len(sys.argv) > 5 else dur - 0.2
T = tempfile.mkdtemp(); sh = Image.new("RGB", (1920, 270 * -(-n // 4)))
for k in range(n):
    t = t0 + (t1 - t0) * k / (n - 1); f = os.path.join(T, f"{k}.jpg")
    subprocess.run(["ffmpeg","-v","error","-y","-ss",f"{t:.3f}","-i",clip,"-frames:v","1","-vf","scale=480:270",f])
    im = Image.open(f); ImageDraw.Draw(im).text((6, 4), f"{t:.2f}s", fill=(255, 255, 0)); sh.paste(im, ((k % 4) * 480, (k // 4) * 270))
sh.save(out, quality=84); print(out)
