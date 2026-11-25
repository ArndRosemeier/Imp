#!/usr/bin/env python3
"""Lip-sync a still (or a clip) to a recorded line with an audio-driven avatar model, through the film's ledger.
  lipsync.py <name> --audio line.mp3 [--image still.png | --video clip.mp4] [--prompt "..."] [--model heygen/heygen-avatar-6-turbo] [--res 1080p]
Writes clips/<name>.mp4 (the model returns the supplied audio as the clip's sound). Run in the movie folder."""
import argparse, base64, json, os, sys, time, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import film
p = argparse.ArgumentParser(); p.add_argument("name"); p.add_argument("--audio", required=True); p.add_argument("--image"); p.add_argument("--video"); p.add_argument("--vname")
p.add_argument("--prompt", default=""); p.add_argument("--model", default="heygen/heygen-avatar-6-turbo"); p.add_argument("--res", default="1080p"); p.add_argument("--est", type=float, default=0.7)
a = p.parse_args()
def durl(path, mt): return f"data:{mt};base64," + base64.b64encode(open(path, "rb").read()).decode()
ledger = film.load(); before = film.guard(ledger, a.est)
refs = []
if a.image: refs.append({"type": "image_url", "image_url": {"url": film.data_url(a.image)}})
if a.video: refs.append({"type": "video_url", "video_url": {"url": a.video if a.video.startswith("https://") else durl(a.video, "video/mp4")}})  # providers only fetch video by https link
refs.append({"type": "audio_url", "audio_url": {"url": durl(a.audio, "audio/mpeg")}})
body = {"model": a.model, "resolution": a.res, "input_references": refs}
if a.prompt: body["prompt"] = a.prompt
r = film.http("POST", "/videos", body); t0 = time.time()
while True:
    s = film.http("GET", "/videos/" + r["id"]); st = s.get("status")
    if st == "completed": break
    if st not in ("pending", "in_progress"):
        film.record(ledger, before, kind="video-failed", name=a.name, model=a.model, cost_usd=(s.get("usage") or {}).get("cost") or 0.0, error=str(s.get("error"))[:400]); sys.exit(f"job {st}: {s.get('error')}")
    if time.time() - t0 > 1500: sys.exit("still running: " + r["id"])
    time.sleep(8)
raw, ct = film.http("GET", f"/videos/{r['id']}/content?index=0", binary=True)
out = os.path.join(film.ROOT, "clips", a.name + ".mp4"); os.makedirs(os.path.dirname(out), exist_ok=True); open(out, "wb").write(raw)
print(out, f"{time.time() - t0:.0f}s")
film.record(ledger, before, kind="lipsync", name=a.name, model=a.model, prompt=a.prompt, audio=a.audio, first=a.image and os.path.basename(a.image), video=a.video and (a.vname or "link"),
            file="clips/" + a.name + ".mp4", cost_usd=(s.get("usage") or {}).get("cost"), est_usd=a.est)
