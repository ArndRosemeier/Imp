#!/usr/bin/env python3
"""When is something said in each dialogue clip?  speechtimes.py [ids...]  -> reviews/speech.json
{id: {said, first, last, dur, match, words:[[word, t0, t1]]}}; `match` compares what was said with the script (1.0 = every word).
The edit trims dialogue shots by it, and a line can be lifted out as a voice-over. Scribe word times, about a cent a clip."""
import base64, difflib, json, os, re, subprocess, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
S = {s["id"]: s for s in json.load(open("shots.json"))["shots"]}; cut = json.load(open("cut.json"))
ids = [x for x in sys.argv[1:] if x in S] or [i for i in cut if S.get(i, {}).get("lines") and not S[i].get("skip")]
P = "reviews/speech.json"; out = json.load(open(P)) if os.path.exists(P) else {}
norm = lambda t: re.sub(r"[^a-z ]", "", t.lower().replace("-", " ")).split()
def one(i):
    mp3 = subprocess.check_output(["ffmpeg", "-v", "error", "-i", cut[i], "-vn", "-f", "mp3", "-q:a", "4", "-"])
    body = {"model": "elevenlabs/scribe-v2", "input_audio": {"data": base64.b64encode(mp3).decode(), "format": "mp3"}, "timestamp_granularities": ["word"], "response_format": "verbose_json"}
    r = urllib.request.Request("https://openrouter.ai/api/v1/audio/transcriptions", data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + os.environ["OPEN_ROUTER_KEY"], "Content-Type": "application/json"})
    j = json.loads(urllib.request.urlopen(r, timeout=300).read())
    w = [[x.get("text") or x.get("word"), round(x["start"], 2), round(x["end"], 2)] for x in j.get("words", []) if x.get("type", "word") == "word"]
    d = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", cut[i]]))
    want = norm(" ".join(t for _, t in S[i]["lines"])); got = norm(" ".join(x[0] for x in w))
    return i, {"clip": cut[i], "said": " ".join(x[0] for x in w), "first": w[0][1] if w else None, "last": w[-1][2] if w else None, "dur": round(d, 2),
               "match": round(difflib.SequenceMatcher(None, want, got).ratio(), 2), "words": w}
with ThreadPoolExecutor(8) as ex:
    for i, r in ex.map(one, ids):
        out[i] = r; print(i, r["match"], r["first"], r["last"], r["dur"], "|", r["said"][:90])
json.dump(out, open(P, "w"), indent=1)
