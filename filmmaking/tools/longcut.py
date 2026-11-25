#!/usr/bin/env python3
"""Cuts a long film (about a hundred cuts) from edl.json and cut.json in two passes (run in the movie folder):
  longcut.py <out.mp4> [--from ID --to ID] [--crf 20]
Pass 1 renders every cut to its own picture file and its own WAV (segs/, cached by content), so one changed cut costs
seconds, not the whole film. Pass 2 joins pictures and sounds separately (a WAV join is exact to the sample, so sound
cannot drift against the picture over ten minutes), lays voice-overs and music on top and adds the title cards.
edl.json:
  {"title": "...", "title_seconds": 4, "end_title": "...", "end_seconds": 6, "size": "1280x720", "fps": 30,
   "grades": {"then": "<ffmpeg video filters for that layer>"},      a shot's layer comes from shots.json
   "cuts": [{"shot", "in", "out", "gain_db", "dissolve": 1.0, "mute": true, "fade_in", "fade_out"}],
   "over": [{"file", "at_cut", "offset", "gain_db", "in", "out"}],     a sound laid over the picture (voice-over)
   "music": [{"file", "at" | "at_cut", "until_cut", "gain_db", "fade_in", "fade_out", "loop"}]}
in/out default to the whole clip less 0.1 s at each end. "dissolve" cross-fades picture and sound from the cut before.
Every cut is a whole number of frames long. Clips of any size and frame rate are accepted."""
import hashlib, json, os, subprocess, sys
E = json.load(open("edl.json")); cut = json.load(open("cut.json")); SH = {s["id"]: s for s in json.load(open("shots.json"))["shots"]}
out = sys.argv[1]; W, H = E.get("size", "1280x720").split("x"); FPS = E.get("fps", 30); os.makedirs("segs", exist_ok=True)
CRF = sys.argv[sys.argv.index("--crf") + 1] if "--crf" in sys.argv else "20"
VENC = ["-c:v", "libx264", "-crf", CRF, "-preset", "fast", "-pix_fmt", "yuv420p", "-r", str(FPS), "-video_track_timescale", "15360", "-an"]
AENC = ["-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "-vn"]
def run(c): subprocess.run(["ffmpeg", "-v", "error", "-y"] + c, check=True)
def dur(f): return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]))
def has_audio(f): return b"audio" in subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", f])
def h(*x): return hashlib.md5(json.dumps(x).encode()).hexdigest()[:10]
cuts = E["cuts"]
if "--from" in sys.argv:
    ids = [c["shot"] for c in cuts]; cuts = cuts[ids.index(sys.argv[sys.argv.index("--from") + 1]):ids.index(sys.argv[sys.argv.index("--to") + 1]) + 1]
segs = []; t = 0.0; start = {}          # segs: (base name, frames)
for c in cuts:
    src = cut[c["shot"]]; d0 = dur(src); a = c.get("in", 0.1); n = round((c.get("out", d0 - 0.1) - a) * FPS); d = n / FPS; b = a + d
    grade = E.get("grades", {}).get(SH[c["shot"]].get("layer"), "")
    base = f"segs/{c['shot']}_" + h(src, os.path.getmtime(src), a, n, grade, c.get("gain_db"), c.get("mute"), c.get("fade_in"), c.get("fade_out"), W, H, FPS, CRF)
    if not (os.path.exists(base + ".mp4") and os.path.exists(base + ".wav")):
        vf = f"fps={FPS},trim={a}:{b + 0.5},setpts=PTS-STARTPTS,scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}" + ("," + grade if grade else "")
        if c.get("fade_in"): vf += f",fade=t=in:d={c['fade_in']}"
        if c.get("fade_out"): vf += f",fade=t=out:st={d - c['fade_out']}:d={c['fade_out']}"
        run(["-i", src, "-vf", vf, "-frames:v", str(n)] + VENC + [base + ".mp4"])
        if has_audio(src) and not c.get("mute"):
            af = f"atrim={a}:{b},asetpts=PTS-STARTPTS,aresample=48000,loudnorm=I={c.get('gain_db', -21)}:TP=-3:LRA=11,aresample=48000,afade=t=in:d=0.04,afade=t=out:st={d - 0.06}:d=0.06,asetpts=N/SR/TB,apad"
            run(["-i", src, "-af", af, "-t", f"{d:.6f}"] + AENC + [base + ".wav"])   # endless padding cut by -t: exact to the sample
        else: run(["-f", "lavfi", "-t", str(d), "-i", "anullsrc=r=48000:cl=stereo"] + AENC + [base + ".wav"])
    x = c.get("dissolve", 0)
    if x and segs:   # merge with the cut before: picture and sound cross-fade
        pb, pn = segs.pop(); xn = round(x * FPS); x = xn / FPS; m = "segs/x_" + h(pb, base, xn)
        if not os.path.exists(m + ".mp4"):
            run(["-i", pb + ".mp4", "-i", base + ".mp4", "-filter_complex", f"[0:v][1:v]xfade=transition=fade:duration={x}:offset={pn / FPS - x}[v]", "-map", "[v]", "-frames:v", str(pn + n - xn)] + VENC + [m + ".mp4"])
            tot = (pn + n - xn) / FPS
            run(["-i", pb + ".wav", "-i", base + ".wav", "-filter_complex", f"[0:a][1:a]acrossfade=d={x},asetpts=N/SR/TB,apad[a]", "-map", "[a]", "-t", f"{tot:.6f}"] + AENC + [m + ".wav"])
        t -= x; start[c["shot"]] = t; t += d; segs.append((m, pn + n - xn)); continue
    start[c["shot"]] = t; t += d; segs.append((base, n))
font = "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"
def card(text, d, name):
    n = round(d * FPS); base = f"segs/_{name}_" + h(text, n, W, H, FPS, CRF); tf = base + ".txt"; open(tf, "w").write(text)
    if not os.path.exists(base + ".mp4"):
        run(["-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r={FPS}:d={d + 1}", "-vf",
             f"drawtext=fontfile={font}:textfile={tf}:fontcolor=0xD8D2C4:fontsize=46:line_spacing=18:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,0.6),0,if(lt(t,1.6),(t-0.6),if(gt(t,{d}-1),({d}-t),1)))'",
             "-frames:v", str(n)] + VENC + [base + ".mp4"])
        run(["-f", "lavfi", "-t", str(n / FPS), "-i", "anullsrc=r=48000:cl=stereo"] + AENC + [base + ".wav"])
    return (base, n)
T0 = E.get("title_seconds", 0) if E.get("title") else 0; T1 = E.get("end_seconds", 5) if E.get("end_title") else 0
parts = ([card(E["title"], T0, "title")] if T0 else []) + segs + ([card(E["end_title"], T1, "end")] if T1 else [])
for ext in ("mp4", "wav"):
    open(f"segs/_{ext}.txt", "w").write("".join(f"file '{os.path.basename(p)}.{ext}'\n" for p, _ in parts))
run(["-f", "concat", "-safe", "0", "-i", "segs/_mp4.txt", "-c", "copy", "segs/_picture.mp4"])
run(["-f", "concat", "-safe", "0", "-i", "segs/_wav.txt", "-c", "copy", "segs/_sound.wav"])
total = sum(n for _, n in parts) / FPS; start["END"] = t
inputs = ["-i", "segs/_picture.mp4", "-i", "segs/_sound.wav"]; fc = []; mix = ["[1:a]"]
def at(m, k="at_cut", default=0.0): return T0 + start[m[k]] if m.get(k) in start else default
def add(args):
    global inputs
    inputs += args; return sum(1 for x in inputs if x == "-i") - 1
for m in E.get("over", []):
    if m.get("at_cut") not in start: continue
    i = add(["-i", m["file"]]); a0 = at(m) + m.get("offset", 0)
    tr = f"atrim={m.get('in', 0)}:{m['out']}," if "out" in m else ""
    fc.append(f"[{i}:a]{tr}asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,loudnorm=I={m.get('gain_db', -20)}:TP=-3,aresample=48000,afade=t=in:d=0.05,adelay={int(a0 * 1000)}:all=1[o{i}]"); mix.append(f"[o{i}]")
for m in E.get("music", []):
    if ("at_cut" in m and m["at_cut"] not in start) or ("until_cut" in m and m["until_cut"] not in start): continue
    i = add((["-stream_loop", "-1"] if m.get("loop") else []) + ["-i", m["file"]])
    a0 = at(m, default=m.get("at", 0)); a1 = at(m, "until_cut", total); d = a1 - a0 if m.get("loop") else min(a1 - a0, dur(m["file"]))
    fo = m.get("fade_out", 3)
    fc.append(f"[{i}:a]atrim=0:{d},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,loudnorm=I={m.get('gain_db', -24)}:TP=-6,aresample=48000,afade=t=in:d={m.get('fade_in', 1.5)},afade=t=out:st={d - fo}:d={fo},adelay={int(a0 * 1000)}:all=1[m{i}]"); mix.append(f"[m{i}]")
fc.append("".join(mix) + f"amix=inputs={len(mix)}:normalize=0:duration=first,alimiter=limit=0.9,atrim=0:{total}[aout]")
run(inputs + ["-filter_complex", ";".join(fc), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out])
json.dump({"cut_points": {k: round(T0 + x, 2) for k, x in start.items()}, "length": round(total, 2)}, open("timeline.json", "w"), indent=1)
print(out, f"{total:.1f}s", len(cuts), "cuts")
