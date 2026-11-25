#!/usr/bin/env python3
"""Have a watching model check clips against the shot list: watchreview.py <ids...> [--take N]
Uses cut.json (chosen clip per shot) or clips/<id>.mp4. Writes reviews/<id>.txt and prints a one-line verdict each.
A second opinion, not the truth: confirm what it reports on frames (shoot.py claims) before a retake."""
import json, os, re, subprocess, sys
S = json.load(open("shots.json")); SH = {s["id"]: s for s in S["shots"]}
cut = json.load(open("cut.json")) if os.path.exists("cut.json") else {}
W = os.path.join(os.path.dirname(os.path.abspath(__file__)), "watch.py"); os.makedirs("reviews", exist_ok=True)
def q(s):
    if s.get("lines"):
        plan = json.load(open(f"voice/shot/{s['id']}.json"))["lines"] if os.path.exists(f"voice/shot/{s['id']}.json") else []
        said = " ".join(f"From {l['t0']} s to {l['t1']} s {l['who'].split('_')[0]} should say '{l['text']}'." for l in plan) or str(s["lines"])
        talk = f"Dialogue plan: {said} For each line: which person in the picture (describe them) moves their lips to it, and does anyone else move their lips then?"
    else: talk = "Nobody should speak. Does anyone move their lips as if speaking, or is a voice heard?"
    return (f"One shot of a photoreal film drama. It should show: {s['action']} Required facts: {'; '.join(s.get('claims', ['none listed']))}. Answer briefly. "
            f"1) What actually happens, in order? 2) Is each required fact shown (yes/no each)? 3) {talk} 4) Anything wrong, artificial or impossible: frozen background, "
            "hands, objects appearing or changing, text in the picture, morphing, a cut inside the shot? 5) Last line exactly in this form: VERDICT: <score 1-10> <KEEP or RETAKE> <reason in ten words>")
ids = [x for x in sys.argv[1:] if x in SH]; ps = []
for k in range(0, len(ids), 8):
    ps = [(i, subprocess.Popen([sys.executable, W, cut.get(i) or f"clips/{i}.mp4", q(SH[i])], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)) for i in ids[k:k + 8]]
    for i, p in ps:
        out = p.communicate()[0].strip(); open(f"reviews/{i}.txt", "w").write(out)
        v = re.findall(r"VERDICT:.*", out); print(i, v[-1] if v else "NO VERDICT")
