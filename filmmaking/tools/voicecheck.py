#!/usr/bin/env python3
"""What can be measured about speech without ears.
  voicecheck.py <audio-or-video> [...]   prints median pitch (Hz) of the voiced parts, per file and per second-wide window,
                                         and the words a transcriber hears (costs a fraction of a cent, not ledgered if --no-stt)
A deep voice sits near 85-120 Hz, a light male voice near 130-180 Hz, so pitch tells the two characters apart."""
import sys, os, json, base64, subprocess, tempfile, urllib.request
import numpy as np, librosa
def wav_of(f):
    out = tempfile.mktemp(suffix=".wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f, "-vn", "-ac", "1", "-ar", "16000", "-af", "loudnorm=I=-18", out], check=True)
    return out
def pitch(f, win=1.0):
    y, sr = librosa.load(wav_of(f), sr=16000)
    f0, voiced, _ = librosa.pyin(y, fmin=60, fmax=350, sr=sr, frame_length=1024)
    t = librosa.times_like(f0, sr=sr, hop_length=256)
    ok = voiced & ~np.isnan(f0)
    med = float(np.median(f0[ok])) if ok.any() else None
    track = []
    for s in np.arange(0, len(y) / sr, win):
        m = ok & (t >= s) & (t < s + win)
        track.append(int(np.median(f0[m])) if m.sum() > 3 else 0)
    return med, track, len(y) / sr
def stt(f, model="mistralai/voxtral-mini-transcribe-3-0"):
    mp3 = tempfile.mktemp(suffix=".mp3")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f, "-vn", "-ac", "1", "-b:a", "64k", mp3], check=True)
    body = {"model": model, "input_audio": {"data": base64.b64encode(open(mp3, "rb").read()).decode(), "format": "mp3"}}
    r = urllib.request.Request("https://openrouter.ai/api/v1/audio/transcriptions", data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + os.environ["OPEN_ROUTER_KEY"], "Content-Type": "application/json"})
    try: return json.loads(urllib.request.urlopen(r, timeout=120).read()).get("text")
    except Exception as e: return "STT failed: %s" % e
if __name__ == "__main__":
    for f in [a for a in sys.argv[1:] if not a.startswith("--")]:
        med, track, dur = pitch(f)
        print(f"{os.path.basename(f)}: {dur:.1f}s median pitch {med and round(med)} Hz; per second {track}")
        if "--no-stt" not in sys.argv: print("   heard:", stt(f))
