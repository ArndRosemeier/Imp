#!/usr/bin/env python3
"""Review the takes named in cut.json without eyes on the moving picture or ears.
  review.py [ids...]   per shot: words a transcriber hears vs the script, pitch per second (who is speaking),
                       biggest frame-to-frame jump (hidden cut), loudness; writes review.json and
                       frames/_review_<n>.jpg strips (4 frames per shot) to look at."""
import json, os, re, subprocess, sys, difflib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voicecheck
S = json.load(open("shots.json")); SH = {s["id"]: s for s in S["shots"]}; cut = json.load(open("cut.json"))
def run(a): return subprocess.run(a, capture_output=True, text=True)
def scene_max(clip):
    r = run(["ffmpeg", "-i", clip, "-vf", "select='gte(scene,0)',metadata=print", "-an", "-f", "null", "-"])
    v = [(float(s), float(t)) for t, s in re.findall(r"pts_time:([\d.]+)\n.*?scene_score=([\d.]+)", r.stderr)]
    return max(v) if v else (0, 0)
def loud(clip):
    r = run(["ffmpeg", "-i", clip, "-af", "volumedetect", "-vn", "-f", "null", "-"])
    m = re.search(r"mean_volume: ([-\d.]+)", r.stderr); return float(m.group(1)) if m else None
norm = lambda t: re.sub(r"[^a-z ]", "", (t or "").lower()).split()
ids = [i for i in sys.argv[1:] if i in cut] or list(cut); out = json.load(open("review.json")) if os.path.exists("review.json") else {}
from PIL import Image, ImageDraw
tiles = []; import tempfile; TMP = tempfile.mkdtemp()
for i in ids:
    c = cut[i]; s = SH[i]; want = " ".join(t for _, t in s.get("lines", []))
    med, track, dur = voicecheck.pitch(c); heard = voicecheck.stt(c) if True else ""
    ratio = difflib.SequenceMatcher(None, norm(want), norm(heard)).ratio() if want else None
    sc, at = scene_max(c)
    out[i] = {"clip": c, "script": want, "heard": heard, "match": ratio and round(ratio, 2), "pitch_per_s": track,
              "jump": round(sc, 3), "jump_at": round(at, 2), "mean_db": loud(c), "dur": round(dur, 2)}
    flag = ("  <-- LINES" if want and ratio < 0.8 else "") + ("  <-- SPEECH IN SILENT SHOT" if not want and len(norm(heard)) > 2 else "") + ("  <-- JUMP" if sc > 0.2 else "")
    print(f"{i} {dur:.1f}s jump {sc:.2f}@{at:.1f} pitch {track}\n    script: {want}\n    heard:  {heard}{flag}")
    for k in range(4):
        t = dur * (0.02 + 0.3 * k); f = os.path.join(TMP, f"{i}_{k}.jpg")
        run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", c, "-frames:v", "1", "-vf", "scale=480:270", f])
        im = Image.open(f); ImageDraw.Draw(im).text((6, 4), f"{i} {t:.1f}s", fill=(255, 255, 0)); tiles.append(im)
json.dump(out, open("review.json", "w"), indent=1)
rows = len(tiles) // 4
for n in range(0, rows, 5):
    part = tiles[n * 4:(n + 5) * 4]; sh = Image.new("RGB", (1920, 270 * (len(part) // 4)))
    for k, im in enumerate(part): sh.paste(im, ((k % 4) * 480, (k // 4) * 270))
    sh.save(f"frames/_review_{n // 5 + 1}.jpg", quality=80); print(f"frames/_review_{n // 5 + 1}.jpg")
