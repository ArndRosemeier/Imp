#!/usr/bin/env python3
"""Is the sound still in step with the picture in the finished cut?  synccheck.py <film.mp4> [ids...]
For dialogue shots it compares where the first word should fall (timeline.json + reviews/speech.json + edl in) with where
a transcript of the finished film hears it. More than about 0.15 s off means the join drifted."""
import base64, json, os, subprocess, sys, urllib.request
film = sys.argv[1]; T = json.load(open("timeline.json"))["cut_points"]; E = {c["shot"]: c for c in json.load(open("edl.json"))["cuts"]}; SP = json.load(open("reviews/speech.json"))
ids = sys.argv[2:] or [i for i in SP if i in T][::4]; worst = 0
for i in ids:
    t = T[i]; exp = t + SP[i]["first"] - E[i]["in"]; a = max(0, exp - 1.0)
    mp3 = subprocess.run(["ffmpeg", "-v", "quiet", "-ss", str(a), "-t", "8", "-i", film, "-vn", "-f", "mp3", "-"], capture_output=True).stdout
    body = {"model": "elevenlabs/scribe-v2", "input_audio": {"data": base64.b64encode(mp3).decode(), "format": "mp3"}, "timestamp_granularities": ["word"], "response_format": "verbose_json"}
    r = urllib.request.Request("https://openrouter.ai/api/v1/audio/transcriptions", data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + os.environ["OPEN_ROUTER_KEY"], "Content-Type": "application/json"})
    w = [x for x in json.loads(urllib.request.urlopen(r, timeout=300).read()).get("words", []) if x.get("type", "word") == "word"]
    if not w: print(i, "nothing heard"); continue
    off = a + w[0]["start"] - exp; worst = max(worst, abs(off)); print(i, f"expected {exp:.2f} heard {a + w[0]['start']:.2f} off {off:+.2f}", w[0].get("text"))
print("worst", round(worst, 2))
