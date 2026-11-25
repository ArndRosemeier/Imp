#!/usr/bin/env python3
"""Is it the same voice? Speaker embeddings (Resemblyzer) stand in for ears.
  voiceid.py a.mp3 b.mp4[:t0-t1] ...   prints the cosine similarity between every pair of files or time ranges
Rule of thumb for this model: the same speaker scores about 0.80 and up, different speakers below about 0.65.
It measures who is speaking (timbre), not how well. As a module: emb(path, t0, t1), sim(a, b)."""
import sys, types, subprocess, tempfile, os
sys.modules.setdefault("webrtcvad", types.ModuleType("webrtcvad"))   # only used by a helper we do not call
import numpy as np, librosa
from resemblyzer import VoiceEncoder
_E = None
def emb(path, t0=None, t1=None):
    global _E
    if _E is None: _E = VoiceEncoder("cpu", verbose=False)
    out = tempfile.mktemp(suffix=".wav")
    cmd = ["ffmpeg", "-v", "error", "-y"] + (["-ss", str(t0)] if t0 is not None else []) + (["-to", str(t1)] if t1 is not None else []) + ["-i", path, "-vn", "-ac", "1", "-ar", "16000", out]
    subprocess.run(cmd, check=True); y, _ = librosa.load(out, sr=16000); os.remove(out)
    iv = librosa.effects.split(y, top_db=30)                      # keep only the voiced stretches
    y = np.concatenate([y[a:b] for a, b in iv]) if len(iv) else y
    y = y / (np.abs(y).max() + 1e-9) * 0.9
    if len(y) < 16000 * 0.8: return None
    return _E.embed_utterance(y)
def sim(a, b): return None if a is None or b is None else float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
def parse(s):
    if ":" in s and "-" in s.rsplit(":", 1)[1]:
        p, r = s.rsplit(":", 1); a, b = r.split("-"); return p, float(a), float(b)
    return s, None, None
if __name__ == "__main__":
    items = [parse(a) for a in sys.argv[1:]]; embs = [emb(*i) for i in items]
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            s = sim(embs[i], embs[j]); print(f"{sys.argv[1+i]}  vs  {sys.argv[1+j]}:  {'too short' if s is None else round(s, 2)}")
