#!/usr/bin/env python3
"""Dialogue shots by lip-sync: lay a shot's recorded lines on a silent track with room for the action, then
have an avatar model perform the keyframe to that track.
  dialogue.py build <ids...>   -> voice/shot/<id>.mp3 + .json (who speaks from when to when)
  dialogue.py shoot <ids...>   -> clips/<id>.mp4 (builds first when the track is missing)
Timing: shots.json may give a shot "lead" (seconds before the first line, default 1.2), "gap" (between lines, 1.0)
and "tail" (minimum after the last line, 1.2); the track is padded to the planned duration.
One visible speaking mouth per clip is safe: with a bearded or turned-away speaker the avatar model gives every line to
the clearest face, so give such a speaker a shot of their own (reverse shot) instead of a two-shot.
Lines come from voice/<character>/<shot>_<n>.mp3 (see voicecut.py). Run in the movie folder."""
import json, os, subprocess, sys
S = json.load(open("shots.json")); SH = {s["id"]: s for s in S["shots"]}; B = json.load(open("bible.json"))
VOICE = {"albert_b": "albert", "albert_k": "albert_y"}
def dur(f): return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]))
def build(i):
    s = SH[i]; t = s.get("lead", 1.2); parts = []; plan = []
    for n, (who, text) in enumerate(s["lines"]):
        f = (s.get("takes") or {}).get(str(n)) or f"voice/{VOICE.get(who, who)}/{i}_{n}.mp3"; d = dur(f)  # "takes": {"0": file} borrows a line cut for another shot
        if n: t += s.get("gap", 1.0)
        parts.append((f, t)); plan.append({"who": who, "text": text, "t0": round(t, 2), "t1": round(t + d, 2)}); t += d
    total = max(s["duration"], t + s.get("tail", 1.2))
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-t", f"{total:.2f}", "-i", "anullsrc=r=44100:cl=mono"]
    for f, _ in parts: cmd += ["-i", f]
    fl = "".join(f"[{k+1}:a]aresample=44100,aformat=channel_layouts=mono,adelay={int(t0*1000)}[a{k}];" for k, (_, t0) in enumerate(parts))
    fl += "[0:a]" + "".join(f"[a{k}]" for k in range(len(parts))) + f"amix=inputs={len(parts)+1}:normalize=0:duration=first[o]"
    os.makedirs("voice/shot", exist_ok=True)
    subprocess.run(cmd + ["-filter_complex", fl, "-map", "[o]", "-c:a", "libmp3lame", "-q:a", "2", f"voice/shot/{i}.mp3"], check=True)
    json.dump({"total": round(total, 2), "lines": plan}, open(f"voice/shot/{i}.json", "w"), indent=1)
    return total, plan
def prompt(i, plan):
    s = SH[i]; tag = lambda w: B["cast"][w]["tag"]; out = [s["action"]]
    for k, l in enumerate(plan):
        others = [tag(w) for w in s["cast"] if w != l["who"]]
        out.append(("First " if k == 0 and len(plan) > 1 else "Then " if k else "") + f"{tag(l['who'])} says: '{l['text']}'" +
                   (f" While these words are heard, {' and '.join(others)} keeps the mouth closed and listens." if others else ""))
    out.append("Before, between and after the lines nobody's lips move. Natural small movements, breathing and blinking; the wind moves hair and clothes. The camera stays where it is.")
    return " ".join(out)
if __name__ == "__main__":
    cmd, ids = sys.argv[1], [x for x in sys.argv[2:] if x in SH]
    jobs = []
    for i in ids:
        if cmd == "build" or not os.path.exists(f"voice/shot/{i}.json"): total, plan = build(i)
        else: j = json.load(open(f"voice/shot/{i}.json")); total, plan = j["total"], j["lines"]
        print(i, total, [(l["who"], l["t0"], l["t1"]) for l in plan])
        if cmd == "shoot":
            os.makedirs("frames_png", exist_ok=True); png = f"frames_png/{i}.png"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f"frames/{i}.webp", "-vf", "scale=1920:1080", png], check=True)
            model = S.get("lipsync_model", "heygen/heygen-avatar-6-turbo")
            jobs.append(subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lipsync.py"), i, "--audio", f"voice/shot/{i}.mp3",
                                          "--image", png, "--prompt", prompt(i, plan), "--model", SH[i].get("lipsync_model", model), "--est", str(round(total * 0.06, 2))]))
    sys.exit(max([j.wait() for j in jobs] or [0]))
