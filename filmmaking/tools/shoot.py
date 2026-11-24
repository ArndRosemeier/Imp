#!/usr/bin/env python3
"""Shoots a cut movie from shots.json + bible.json (run in the movie folder).
  shoot.py keys  [ids...] [--v N]     paint the first-frame still of each shot from the character and location references
  shoot.py clips [ids...] [--take N]  film each shot from its still (and last still, if it names one), dialogue included
  shoot.py sheet [ids...]             contact sheet of the stills -> frames/_sheet.jpg (look at it before paying for clips)
  shoot.py cost                       price of filming every shot once
Every still is 16:9, saved as frames/<id>.webp; every clip as clips/<id>_takeN.mp4; cut.json names the chosen take.
A shot is cut to the next one, so nothing has to join frame-exactly: what must match is the people, the place, the light and the
screen direction, and those come from the references (portrait + sheet per character, one master still per place)."""
import json, os, subprocess, sys
T = os.path.dirname(os.path.abspath(__file__)); FILM = os.path.join(T, "film.py")
S = json.load(open("shots.json")); B = json.load(open("bible.json")); SH = {s["id"]: s for s in S["shots"]}
def opt(name, default):
    return type(default)(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default
def ids(only_film=False):
    a = [x for x in sys.argv[2:] if x in SH]
    r = a or list(SH)
    return [i for i in r if not (only_film and SH[i].get("keyframe_only"))]
def keyfile(i):
    for e in (".png", ".webp", ".jpg"):
        if os.path.exists(f"frames/{i}{e}"): return f"frames/{i}{e}"
def key_job(i, v):
    s = SH[i]; refs = []; who = []
    for k in s.get("cast", []):
        c = B["cast"][k]; refs.append(f"library/{k}/{k}_portrait.webp"); n = len(refs)
        t = f"{c['name'].split()[0]} is the man in reference image {n}"
        if s.get("sheets"): refs.append(f"library/{k}/{k}_sheet.webp"); t += f" (full body in reference image {n + 1})"
        who.append(t + f": {c['look']}.")
    if s.get("loc_ref"): refs.append(S["locations"][s["scene"]]); who.append(f"Reference image {len(refs)} shows the location; keep its architecture, props and light.")
    for r in s.get("extra_refs", []): refs.append(r); who.append(f"Reference image {len(refs)} is the creature reference.")
    if who: who.append("Keep every face, hairstyle and costume exactly as in the references.")
    prompt = " ".join([s["key"]] + who + [B["look"]])
    name = i if v == 1 else f"{i}_v{v}"
    return ["python3", FILM, "image", name, prompt, "--model", S["image_model"], "--size", "1920x1080", "--est", "0.02", "--seed", str(s.get("seed", 1) + v - 1)] + sum([["--ref", r] for r in refs], [])
def clip_prompt(s):
    p = [s["action"]]
    for who, text in s.get("lines", []):
        p.append(f'{S["tags"][who]}, says in {B["voice_prompt"][who]}: "{text}"')
    p.append("Only the man who is speaking moves his lips; nobody else speaks." if s.get("lines") else "Nobody speaks.")
    return " ".join(p + [S["style"], f"Sound: {s['sound']}."])
def run_all(jobs, width=6):
    fails = []
    for k in range(0, len(jobs), width):
        ps = [(n, subprocess.Popen(j, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)) for n, j in jobs[k:k + width]]
        for n, p in ps:
            out = p.communicate()[0].strip().splitlines()
            print(n, "|", " | ".join(out[-2:]))
            if p.returncode: fails.append(n)
    if fails: print("FAILED:", fails)
cmd = sys.argv[1]
if cmd == "keys":
    v = opt("--v", 1)
    run_all([(i, key_job(i, v)) for i in ids() if SH[i].get("key")])
elif cmd == "clips":
    take = opt("--take", 1); jobs = []
    for i in ids(True):
        s = SH[i]; name = f"{i}_take{take}"
        j = ["python3", FILM, "video", name, clip_prompt(s), "--model", S["model"], "--duration", str(s["duration"]), "--resolution", S["resolution"],
             "--first", keyfile(i), "--seed", str(s.get("seed", 1) + take - 1), "--est", str(round(s["duration"] * S["usd_per_second"] * 1.05, 2))]
        if s.get("last"): j += ["--last", keyfile(s["last"])]
        jobs.append((name, j))
    run_all(jobs, opt("--width", 5))
    cut = json.load(open("cut.json")) if os.path.exists("cut.json") else {}
    for n, _ in jobs:
        if os.path.exists(f"clips/{n}.mp4"): cut[n.split("_take")[0]] = f"clips/{n}.mp4"
    json.dump(cut, open("cut.json", "w"), indent=1)
elif cmd == "sheet":
    from PIL import Image, ImageDraw
    L = [i for i in ids() if keyfile(i)]; cols = 4; w, h = 480, 270
    sheet = Image.new("RGB", (cols * w, -(-len(L) // cols) * h))
    for n, i in enumerate(L):
        im = Image.open(keyfile(i)).convert("RGB").resize((w, h)); ImageDraw.Draw(im).text((8, 6), i, fill=(255, 255, 0))
        sheet.paste(im, ((n % cols) * w, (n // cols) * h))
    sheet.save("frames/_sheet.jpg", quality=85); print("frames/_sheet.jpg", len(L))
elif cmd == "cost":
    d = sum(s["duration"] for s in S["shots"] if not s.get("keyframe_only"))
    print(f"{d} s of film in {sum(1 for s in S['shots'] if not s.get('keyframe_only'))} shots, one take each: ${d * S['usd_per_second']:.2f}")
