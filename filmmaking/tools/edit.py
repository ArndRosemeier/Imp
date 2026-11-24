#!/usr/bin/env python3
"""Cuts the movie from edl.json and cut.json (run in the movie folder):  edit.py <out.mp4>
edl cuts: {shot, in, out, lead, tail, gain_db}. Picture runs in..out. Sound runs (in-lead)..(out+tail) and stays in sync
with its own picture, so `lead` makes a J-cut (sound of the next shot arrives before its picture) and `tail` an L-cut
(sound of this shot runs on under the next picture). Each clip's sound is levelled, given 40 ms fades, and mixed.
edl music: {file, at | at_cut, until_cut, src_in, gain_db, filter, fade_out}. A title on black ends the film."""
import json, subprocess, sys, os
E = json.load(open("edl.json")); cut = json.load(open("cut.json")); out = sys.argv[1]
inputs, fc, v, a = [], [], [], []; t = 0.0; start = {}
for n, c in enumerate(E["cuts"]):
    inputs += ["-i", cut[c["shot"]]]; d = c["out"] - c["in"]; start[c["shot"]] = t
    lead, tail = c.get("lead", 0), c.get("tail", 0)
    vf = f"[{n}:v]trim={c['in']}:{c['out']},setpts=PTS-STARTPTS,scale=1280:720,fps=24,format=yuv420p"
    if n == 0 and E.get("fade_in"): vf += f",fade=t=in:d={E['fade_in']}"
    fc.append(vf + f"[v{n}]"); v.append(f"[v{n}]")
    a0, a1 = max(0, c["in"] - lead), c["out"] + tail; ad = a1 - a0; delay = int(round((t - (c["in"] - a0)) * 1000))
    fi = max(0.04, lead * 0.6); fo = max(0.04, tail * 0.6)
    target = c.get("gain_db")
    lvl = f"loudnorm=I={target}:TP=-3:LRA=11" if target else "loudnorm=I=-19:TP=-3:LRA=11"
    fc.append(f"[{n}:a]atrim={a0}:{a1},asetpts=PTS-STARTPTS,aresample=48000,{lvl},afade=t=in:d={fi},afade=t=out:st={ad - fo}:d={fo},adelay={max(delay,0)}:all=1[a{n}]")
    a.append(f"[a{n}]"); t += d
end = t; start["END"] = end; total = end + E.get("title_seconds", 0); N = len(E["cuts"])
font = "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf"
fc.append(f"color=c=black:s=1280x720:r=24:d={E.get('title_seconds', 0)},format=yuv420p,drawtext=fontfile={font}:text='{E['title']}':fontcolor=0xE8D9B0:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2:alpha='if(lt(t,0.5),0,min(1,(t-0.5)/0.6))'[vt]")
fc.append("".join(v) + f"[vt]concat=n={N + 1}:v=1:a=0[vout]")
for k, m in enumerate(E.get("music", [])):
    i = N + k; inputs += ["-i", m["file"]]
    at = start[m["at_cut"]] if "at_cut" in m else m.get("at", 0)
    until = start[m["until_cut"]] if "until_cut" in m else total
    src = m.get("src_in", at if m.get("src_from_timeline") else 0); d = until - at
    f = f"[{i}:a]atrim={src}:{src + d},asetpts=PTS-STARTPTS,aresample=48000,loudnorm=I={m['gain_db']}:TP=-6"
    if m.get("filter"): f += "," + m["filter"]
    if m.get("fade_out"): f += f",afade=t=out:st={d - m['fade_out']}:d={m['fade_out']}"
    fc.append(f + f",adelay={int(at * 1000)}:all=1[m{k}]"); a.append(f"[m{k}]")
fc.append("".join(a) + f"amix=inputs={len(a)}:normalize=0:duration=longest,apad=whole_dur={total},atrim=0:{total},alimiter=limit=0.9[aout]")
cmd = ["ffmpeg", "-v", "error", "-y"] + inputs + ["-filter_complex", ";".join(fc), "-map", "[vout]", "-map", "[aout]",
       "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]
subprocess.run(cmd, check=True)
json.dump({"cut_points": {k: round(x, 2) for k, x in start.items()}, "length": round(total, 2)}, open("timeline.json", "w"), indent=1)
print(out, f"{total:.1f}s", {k: round(x, 1) for k, x in start.items()})
