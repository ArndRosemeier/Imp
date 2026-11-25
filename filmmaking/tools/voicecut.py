#!/usr/bin/env python3
"""One voice per character: all of a character's lines are spoken in ONE text-to-speech request (so they share one voice),
then cut into one file per line with a transcriber's word timings.
  voicecut.py <character> <all.mp3>    reads voice/lines.json {character: [[shot, n, text], ...]}, writes voice/<character>/<shot>_<n>.mp3
                                       and voice/<character>/index.json with times, the words heard, and a match score per line.
Run in the movie folder. A line whose words do not match is flagged; speak the whole set again rather than patching one line,
because a new request is a new voice (measured with voiceid.py: 0.98 inside one request, 0.59 between two)."""
import sys, os, json, re, base64, difflib, subprocess, urllib.request
who, src = sys.argv[1], sys.argv[2]
L = json.load(open("voice/lines.json"))[who]
body = {"model": "elevenlabs/scribe-v2", "input_audio": {"data": base64.b64encode(open(src, "rb").read()).decode(), "format": "mp3"},
        "timestamp_granularities": ["word"], "response_format": "verbose_json"}
r = urllib.request.Request("https://openrouter.ai/api/v1/audio/transcriptions", data=json.dumps(body).encode(),
                           headers={"Authorization": "Bearer " + os.environ["OPEN_ROUTER_KEY"], "Content-Type": "application/json"})
j = json.loads(urllib.request.urlopen(r, timeout=300).read())
NUM = {"40": "forty", "43": "fortythree", "22": "twentytwo", "3": "three"}
def norm(w):
    w = re.sub(r"[^a-z0-9]", "", w.lower()); return NUM.get(w, w)
words = [(norm(w.get("text") or w.get("word") or ""), w["start"], w["end"]) for w in j["words"] if (w.get("type", "word") == "word")]
words = [w for w in words if w[0]]
heard = [w[0] for w in words]
script = []; owner = []
for k, (shot, n, text) in enumerate(L):
    for w in text.replace("-", " ").split():
        if norm(w): script.append(norm(w)); owner.append(k)
script = [("fortythree" if a == "forty" and i + 1 < len(script) and script[i + 1] == "three" else a) for i, a in enumerate(script)]
m = difflib.SequenceMatcher(None, script, heard, autojunk=False)
span = {}
for a, b, size in m.get_matching_blocks():
    for d in range(size):
        k = owner[a + d]; s, e = words[b + d][1], words[b + d][2]
        span[k] = (min(span.get(k, (s, e))[0], s), max(span.get(k, (s, e))[1], e))
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], capture_output=True, text=True).stdout)
os.makedirs(f"voice/{who}", exist_ok=True); idx = []; ks = sorted(span)
for k, (shot, n, text) in enumerate(L):
    if k not in span: print("MISSING", shot, text); idx.append({"shot": shot, "n": n, "text": text, "missing": True}); continue
    s, e = span[k]
    prev_end = max([span[q][1] for q in ks if q < k], default=0); next_start = min([span[q][0] for q in ks if q > k], default=dur)
    tail = max([w[2] for w in words if e <= w[1] < next_start - 0.01], default=e)   # words heard after the last matched one (a name spelt differently) still belong to this line
    e = max(e, tail)
    s2 = max(s - 0.25, (prev_end + s) / 2 if prev_end else 0); e2 = min(e + 0.35, (e + next_start) / 2 if next_start < dur else dur)
    out = f"voice/{who}/{shot}_{n}.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{s2:.3f}", "-to", f"{e2:.3f}", "-i", src, "-af", f"afade=t=in:d=0.03,afade=t=out:st={e2 - s2 - 0.06:.3f}:d=0.06", "-b:a", "192k", out], check=True)
    got = " ".join(w[0] for w in words if s - 0.01 <= w[1] <= e + 0.01); want = " ".join(norm(w) for w in text.replace("-", " ").split() if norm(w)).replace("forty three", "fortythree")
    sc = difflib.SequenceMatcher(None, want, got).ratio()
    idx.append({"shot": shot, "n": n, "text": text, "file": out, "start": round(s2, 2), "end": round(e2, 2), "seconds": round(e2 - s2, 2), "match": round(sc, 2)})
    print(f"{shot}_{n} {e2 - s2:4.1f}s match {sc:.2f} {'  <-- CHECK' if sc < 0.9 else ''} | {text}")
json.dump({"source": src, "lines": idx}, open(f"voice/{who}/index.json", "w"), indent=1)
