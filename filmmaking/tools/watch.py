#!/usr/bin/env python3
"""A reviewer with eyes and ears: asks a multimodal chat model about an audio file or a video clip.
  watch.py <file.mp3|file.mp4> "<question>" [--model google/gemini-4-hydrogen] [--json]
As a module: ask(path, question, model=...) -> text. The answer is a second opinion, not a measurement: models can be wrong
or agreeable, so ask for descriptions ("what does the voice sound like?") before yes/no questions, and cross-check what matters."""
import sys, os, json, base64, subprocess, tempfile, urllib.request, urllib.error
MODEL = "google/gemini-4-hydrogen"
def ask(path, question, model=MODEL, max_tokens=4000, small=True):
    ext = path.rsplit(".", 1)[-1].lower()
    if ext in ("mp4", "mov", "webm"):
        src = path
        if small:   # shrink for upload: 640 px wide, 12 fps is plenty for a review
            src = tempfile.mktemp(suffix=".mp4")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-vf", "scale=854:-2,fps=15", "-c:v", "libx264", "-crf", "26", "-c:a", "aac", "-b:a", "96k", src], check=True)
        part = {"type": "video_url", "video_url": {"url": "data:video/mp4;base64," + base64.b64encode(open(src, "rb").read()).decode()}}
    else:
        mp3 = tempfile.mktemp(suffix=".mp3"); subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-vn", "-ac", "1", "-b:a", "96k", mp3], check=True)
        part = {"type": "input_audio", "input_audio": {"data": base64.b64encode(open(mp3, "rb").read()).decode(), "format": "mp3"}}
    body = {"model": model, "messages": [{"role": "user", "content": [part, {"type": "text", "text": question}]}], "max_tokens": max_tokens, "temperature": 0.2, "usage": {"include": True}}
    r = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=json.dumps(body).encode(),
                               headers={"Authorization": "Bearer " + os.environ["OPEN_ROUTER_KEY"], "Content-Type": "application/json"})
    try: j = json.loads(urllib.request.urlopen(r, timeout=600).read())
    except urllib.error.HTTPError as e: return "ERROR %s: %s" % (e.code, e.read()[:400].decode("utf-8", "replace"))
    if "choices" not in j: return "ERROR: " + json.dumps(j)[:400]
    ask.cost = (j.get("usage") or {}).get("cost")
    return j["choices"][0]["message"].get("content") or ""
if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if not x.startswith("--")]
    m = sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else MODEL
    if "--model" in sys.argv: a.remove(m)
    print(ask(a[0], a[1], m)); print("[cost $%s]" % getattr(ask, "cost", None), file=sys.stderr)
