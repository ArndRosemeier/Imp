#!/usr/bin/env python3
"""Leaf journey pipeline: every OpenRouter call goes through here, is checked
against the budget before it is sent, and is written to ledger.json after.

  film.py key
  film.py image  <name> "<prompt>" [--ref a.png ...] [--aspect 16:9] [--model id] [--est 0.1]
  film.py video  <name> "<prompt>" --model id --duration 8 [--first f.png] [--last l.png]
                 [--resolution 720p] [--seed N] [--no-audio] --est <usd>
  film.py poll   <name>          (waits for a started video job and downloads it)
  film.py music  <name> "<prompt>" --model id [--est 0.1]
  film.py sfx    <name> "<prompt>" --model id [--est 0.03]
The key is read from OPEN_ROUTER_KEY and never printed.
"""
import argparse, base64, json, os, sys, time, urllib.request, urllib.error

ROOT = os.path.abspath(os.environ.get("FILM_ROOT") or os.getcwd())  # the movie folder: one per movie
LEDGER = os.path.join(ROOT, "ledger.json")
BASE = "https://openrouter.ai/api/v1"
BUDGET_USD = 20.0
KEY = os.environ.get("OPEN_ROUTER_KEY") or os.environ.get("OPENROUTER_API_KEY") or ""


def http(method, path, body=None, binary=False, timeout=600):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Authorization": "Bearer " + KEY}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return (raw, r.headers.get("Content-Type", "")) if binary else json.loads(raw)
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} on {method} {path}: {e.read()[:1500].decode('utf-8', 'replace')}")


def key_usage():
    return float(http("GET", "/key")["data"]["usage"])


def load():
    if os.path.exists(LEDGER):
        return json.load(open(LEDGER))
    return {"budget_usd": BUDGET_USD, "key_usage_at_start": key_usage(), "entries": []}


def save(ledger):
    tmp = LEDGER + ".tmp"
    json.dump(ledger, open(tmp, "w"), indent=1)
    os.replace(tmp, LEDGER)


def spent(ledger):
    return sum(e.get("cost_usd") or e.get("est_usd") or 0 for e in ledger["entries"])


def guard(ledger, est):
    """Refuse a call whose estimate would take the film past the budget."""
    by_ledger = spent(ledger)
    by_key = key_usage() - ledger["key_usage_at_start"]
    worst = max(by_ledger, by_key)
    budget = ledger.get("budget_usd", BUDGET_USD)
    if worst + est > budget:
        sys.exit(f"BUDGET STOP: spent ${worst:.2f} (ledger ${by_ledger:.2f}, key ${by_key:.2f}), "
                 f"this call is estimated at ${est:.2f}, limit ${budget:.2f}.")
    return key_usage()


def record(ledger, before, **entry):
    time.sleep(2)
    delta = round(key_usage() - before, 6)
    entry["key_delta_usd"] = delta
    if entry.get("cost_usd") is None:
        entry["cost_usd"] = delta if delta > 0 else None
    entry["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    ledger = load()  # read again: another call may have written meanwhile
    ledger["entries"].append(entry)
    save(ledger)
    print(f"cost ${entry['cost_usd']} (key delta ${delta}); film total ${spent(ledger):.3f}")


def data_url(path):
    raw = open(path, "rb").read()
    mt = "image/png" if raw[:4] == b"\x89PNG" else "image/webp" if raw[8:12] == b"WEBP" else "image/jpeg"
    return f"data:{mt};base64,{base64.b64encode(raw).decode()}"


def image_part(path):
    return {"type": "image_url", "image_url": {"url": data_url(path)}}


def ext_of(raw):
    if raw[:4] == b"\x89PNG": return ".png"
    if raw[8:12] == b"WEBP": return ".webp"
    if raw[:3] == b"\xff\xd8\xff": return ".jpg"
    if raw[:3] == b"ID3" or raw[:2] in (b"\xff\xfb", b"\xff\xf3"): return ".mp3"
    if raw[4:8] == b"ftyp": return ".mp4"
    if raw[:4] == b"RIFF": return ".wav"
    return ".bin"


def cmd_key(a):
    ledger = load(); save(ledger)
    print(f"ledger ${spent(ledger):.3f}; key delta ${key_usage() - ledger['key_usage_at_start']:.3f}; budget ${BUDGET_USD}")


def cmd_image(a):
    ledger = load(); before = guard(ledger, a.est)
    body = {"model": a.model, "prompt": a.prompt}
    if a.aspect: body["aspect_ratio"] = a.aspect
    if a.size: body["size"] = a.size
    if a.seed is not None: body["seed"] = a.seed
    if a.ref: body["input_references"] = [image_part(p) for p in a.ref]
    r = http("POST", "/images", body)
    item = r["data"][0]
    raw = base64.b64decode(item["b64_json"]) if item.get("b64_json") else urllib.request.urlopen(item["url"]).read()
    out = os.path.join(ROOT, a.dir, a.name + ext_of(raw))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "wb").write(raw)
    print(out)
    record(ledger, before, kind="image", name=a.name, model=a.model, prompt=a.prompt,
           refs=[os.path.basename(p) for p in a.ref or []], seed=a.seed, file=os.path.relpath(out, ROOT),
           cost_usd=(r.get("usage") or {}).get("cost"), est_usd=a.est)


def jobs_path(name):
    return os.path.join(ROOT, "clips", name + ".job.json")


def cmd_video(a):
    ledger = load(); before = guard(ledger, a.est)
    body = {"model": a.model, "prompt": a.prompt, "generate_audio": not a.no_audio,
            "duration": a.duration, "resolution": a.resolution, "aspect_ratio": "16:9"}
    if a.seed is not None: body["seed"] = a.seed
    frames = []
    if a.first: frames.append({**image_part(a.first), "frame_type": "first_frame"})
    if a.last: frames.append({**image_part(a.last), "frame_type": "last_frame"})
    if frames: body["frame_images"] = frames
    refs = [image_part(p) for p in a.ref or []]
    for p in a.aref or []:   # voice samples: Seedance 2 and newer honour audio references
        refs.append({"type": "audio_url", "audio_url": {"url": p}})  # must be an https URL the provider can fetch
    if refs: body["input_references"] = refs
    r = http("POST", "/videos", body)
    os.makedirs(os.path.join(ROOT, "clips"), exist_ok=True)
    job = {"id": r["id"], "name": a.name, "model": a.model, "prompt": a.prompt, "duration": a.duration,
           "resolution": a.resolution, "seed": a.seed, "first": a.first, "last": a.last, "est_usd": a.est,
           "refs": [os.path.basename(p) for p in a.ref or []] + (a.aref or []),
           "key_before": before}
    json.dump(job, open(jobs_path(a.name), "w"), indent=1)
    print("started", r["id"], r.get("status"))
    if not a.no_wait:
        finish(a.name)


def finish(name, max_wait=1500):
    job = json.load(open(jobs_path(name)))
    ledger = load()
    t0 = time.time()
    while True:
        r = http("GET", "/videos/" + job["id"])
        st = r.get("status")
        if st == "completed": break
        if st not in ("pending", "in_progress"):
            record(ledger, job["key_before"], kind="video-failed", name=name, model=job["model"],
                   cost_usd=(r.get("usage") or {}).get("cost"), error=str(r.get("error"))[:400])
            sys.exit(f"job {st}: {r.get('error')}")
        if time.time() - t0 > max_wait:
            sys.exit("still running; run: film.py poll " + name)
        time.sleep(10)
    raw, ctype = http("GET", f"/videos/{job['id']}/content?index=0", binary=True)
    if not ctype.startswith("video/"):
        sys.exit("no video in answer: " + ctype)
    out = os.path.join(ROOT, "clips", name + ".mp4")
    open(out, "wb").write(raw)
    print(out, f"{time.time() - t0:.0f}s")
    record(ledger, job["key_before"], kind="video", name=name, model=job["model"], prompt=job["prompt"],
           duration=job["duration"], resolution=job["resolution"], seed=job["seed"],
           first=job["first"] and os.path.basename(job["first"]), last=job["last"] and os.path.basename(job["last"]),
           refs=job.get("refs"), file="clips/" + name + ".mp4", cost_usd=(r.get("usage") or {}).get("cost"), est_usd=job["est_usd"])


def cmd_poll(a):
    finish(a.name)


def cmd_music(a):
    ledger = load(); before = guard(ledger, a.est)
    body = {"model": a.model, "messages": [{"role": "user", "content": a.prompt}], "stream": True,
            "modalities": ["text", "audio"], "usage": {"include": True}}
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    chunks, cost = [], None
    with urllib.request.urlopen(req, timeout=900) as r:
        for line in r:
            line = line.strip()
            if not line.startswith(b"data: ") or line == b"data: [DONE]": continue
            try: ev = json.loads(line[6:])
            except ValueError: continue
            if ev.get("usage", {}) and ev["usage"].get("cost") is not None: cost = ev["usage"]["cost"]
            for ch in ev.get("choices", []):
                d = (ch.get("delta") or {}).get("audio") or {}
                if d.get("data"): chunks.append(d["data"])
    raw = base64.b64decode("".join(chunks))
    out = os.path.join(ROOT, "audio", a.name + ext_of(raw))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "wb").write(raw)
    print(out, len(raw))
    record(ledger, before, kind="music", name=a.name, model=a.model, prompt=a.prompt,
           file=os.path.relpath(out, ROOT), cost_usd=cost, est_usd=a.est)


def cmd_sfx(a):
    ledger = load(); before = guard(ledger, a.est)
    prompt = a.prompt if a.prompt.lower().startswith("the sound") else "The sound of " + a.prompt
    raw, _ = http("POST", "/audio/speech", {"model": a.model, "input": prompt, "response_format": "mp3"}, binary=True)
    out = os.path.join(ROOT, "audio", a.name + ext_of(raw))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "wb").write(raw)
    print(out, len(raw))
    record(ledger, before, kind="sfx", name=a.name, model=a.model, prompt=prompt,
           file=os.path.relpath(out, ROOT), cost_usd=None, est_usd=a.est)


def cmd_speech(a):
    """Spoken line or voice sample. --voice-desc describes the voice in words (Seed Audio reads it as instructions)."""
    ledger = load(); before = guard(ledger, a.est)
    body = {"model": a.model, "input": a.prompt, "response_format": "mp3"}
    if a.instructions: body["instructions"] = a.instructions
    if a.voice: body["voice"] = a.voice
    raw, _ = http("POST", "/audio/speech", body, binary=True)
    out = os.path.join(ROOT, a.dir, a.name + ext_of(raw))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "wb").write(raw)
    print(out, len(raw))
    record(ledger, before, kind="speech", name=a.name, model=a.model, prompt=a.prompt, instructions=a.instructions,
           file=os.path.relpath(out, ROOT), cost_usd=None, est_usd=a.est)


def main():
    if not KEY: sys.exit("OPEN_ROUTER_KEY is not set")
    p = argparse.ArgumentParser(); s = p.add_subparsers(dest="cmd", required=True)
    s.add_parser("key").set_defaults(f=cmd_key)
    i = s.add_parser("image"); i.add_argument("name"); i.add_argument("prompt"); i.add_argument("--model", required=True)
    i.add_argument("--ref", action="append"); i.add_argument("--aspect", default="16:9"); i.add_argument("--size")
    i.add_argument("--seed", type=int); i.add_argument("--dir", default="frames"); i.add_argument("--est", type=float, default=0.15)
    i.set_defaults(f=cmd_image)
    v = s.add_parser("video"); v.add_argument("name"); v.add_argument("prompt"); v.add_argument("--model", required=True)
    v.add_argument("--duration", type=int, required=True); v.add_argument("--first"); v.add_argument("--last")
    v.add_argument("--ref", action="append"); v.add_argument("--aref", action="append"); v.add_argument("--resolution", default="720p"); v.add_argument("--seed", type=int)
    v.add_argument("--no-audio", action="store_true"); v.add_argument("--no-wait", action="store_true")
    v.add_argument("--est", type=float, required=True); v.set_defaults(f=cmd_video)
    q = s.add_parser("poll"); q.add_argument("name"); q.set_defaults(f=cmd_poll)
    m = s.add_parser("music"); m.add_argument("name"); m.add_argument("prompt"); m.add_argument("--model", required=True)
    m.add_argument("--est", type=float, default=0.1); m.set_defaults(f=cmd_music)
    x = s.add_parser("sfx"); x.add_argument("name"); x.add_argument("prompt"); x.add_argument("--model", required=True)
    x.add_argument("--est", type=float, default=0.03); x.set_defaults(f=cmd_sfx)
    z = s.add_parser("speech"); z.add_argument("name"); z.add_argument("prompt"); z.add_argument("--model", required=True)
    z.add_argument("--instructions"); z.add_argument("--voice"); z.add_argument("--dir", default="audio")
    z.add_argument("--est", type=float, default=0.03); z.set_defaults(f=cmd_speech)
    a = p.parse_args(); a.f(a)


if __name__ == "__main__":
    main()
