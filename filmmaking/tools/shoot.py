#!/usr/bin/env python3
"""Shoots a cut movie from shots.json + bible.json (run in the movie folder).
  shoot.py keys  [ids...] [--v N]     paint the first-frame still of each shot from the character and location references
  shoot.py clips [ids...] [--take N]  film each shot from its still (and last still, if it names one), dialogue included
  shoot.py sheet [ids...]             contact sheet of the stills -> frames/_sheet.jpg (look at it before paying for clips)
  shoot.py cost                       price of filming every shot once
  shoot.py claims [ids...]            after filming: frames/_claims_<n>.jpg, three large frames per shot with the shot's `claims`
                                      (facts the story needs the picture to show) printed beside them, to check one by one
Optional per shot: `props` (keys of bible.props, each {ref, desc}), `extra_refs` (path or [path, sentence]), `claims` (list),
`first_from` {shot, back}: film from the frame `back` seconds before the end of that shot's chosen take, taken while things still
move, and cut there (moving handover: no anchor pause at the join). bible.worlds[scene] is a look added per scene.
Every still is 16:9, saved as frames/<id>.webp; every clip as clips/<id>_takeN.mp4; cut.json names the chosen take.
A shot is cut to the next one, so nothing has to join frame-exactly: what must match is the people, the place, the light and the
screen direction, and those come from the references (portrait + sheet per character, one master still per place)."""
import json, os, subprocess, sys
T = os.path.dirname(os.path.abspath(__file__)); FILM = os.path.join(T, "film.py")
S = json.load(open("shots.json")); B = json.load(open("bible.json")); SH = {s["id"]: s for s in S["shots"]}
def opt(name, default):
    return type(default)(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default
def ids(only_film=False):
    a = [x for x in sys.argv[2:] if x in SH]
    r = a or list(SH)
    return [i for i in r if not (only_film and SH[i].get("keyframe_only"))]
def keyfile(i):
    for e in (".png", ".webp", ".jpg"):
        if os.path.exists(f"frames/{i}{e}"): return f"frames/{i}{e}"
def no_cast(s, prompt):
    """A shot without people: bible.no_cast = {replace: [[a, b]...], add: "..."} keeps the look text from conjuring one."""
    nc = B.get("no_cast")
    if s.get("cast") or not nc: return prompt
    for a, b in nc.get("replace", []): prompt = prompt.replace(a, b)
    return prompt + " " + nc.get("add", "")
def key_job(i, v):
    s = SH[i]; refs = []; who = []
    for k in s.get("cast", []):
        c = B["cast"][k]; refs.append(c.get("portrait") or f"library/{k}/{k}_portrait.webp"); n = len(refs)   # a costume variant keeps the face of the main portrait
        t = f"{c['name'].split()[0]} is {c.get('ref_noun', 'the man')} in reference image {n}"
        if c.get("always_sheet"): refs.append(f"library/{k}/{k}_sheet.webp"); t += f" (his face is in reference image {n}; his clothes and full body are in reference image {n + 1})"
        elif s.get("sheets"): refs.append(f"library/{k}/{k}_sheet.webp"); t += f" (full body in reference image {n + 1})"
        who.append(t + f": {c['look']}.")
    if s.get("loc_ref"): refs.append(S["locations"][s["scene"]]); who.append(f"Reference image {len(refs)} shows the location; keep its architecture and props.")
    for k in s.get("props", []):
        refs.append(B["props"][k]["ref"]); who.append(f"Reference image {len(refs)} shows {B['props'][k]['desc']}.")
    for r in s.get("extra_refs", []):
        if isinstance(r, str): refs.append(r); who.append(f"Reference image {len(refs)} is the creature reference.")
        else: refs.append(r[0]); who.append(f"Reference image {len(refs)} {r[1]}")
    if who: who.append(B.get("keep", "Keep every face, hairstyle and costume exactly as in the references."))
    prompt = " ".join([s["key"]] + who + [w for w in [B.get("worlds", {}).get(s.get("scene"))] if w] + [look_of(s)])
    prompt = no_cast(s, prompt)
    name = i if v == 1 else f"{i}_v{v}"
    return ["python3", FILM, "image", name, prompt, "--model", S["image_model"], "--size", "1920x1080", "--est", "0.02", "--seed", str(s.get("seed", 1) + v - 1)] + sum([["--ref", r] for r in refs], [])
def png(f):
    """Some video models (wan, veo, grok) only read PNG/JPEG frames: shots.json "png_frames": true converts first."""
    if not S.get("png_frames") or f.endswith(".png"): return f
    os.makedirs("frames_png", exist_ok=True); o = "frames_png/" + os.path.splitext(os.path.basename(f))[0] + ".png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", f, "-vf", "scale=1920:1080", o], check=True); return o
def look_of(s):
    """bible.looks[shot.layer] when the film has time layers, else bible.look."""
    return B["looks"][s["layer"]] if s.get("layer") and B.get("looks") else B["look"]
def clip_prompt(s):
    p = [s["action"]]
    for who, text in s.get("lines", []):
        tag = S.get("tags", {}).get(who) or B["cast"][who]["tag"]; vp = B.get("voice_prompt", {}).get(who) or B["cast"][who]["voice_prompt"]
        p.append(f'{tag}, says in {vp}: "{text}"')
    p.append("Only the person who is speaking moves their lips; nobody else speaks." if s.get("lines") else S.get("silent", "Nobody speaks."))
    if s.get("scene") in S.get("outdoor_scenes", []) and S.get("outdoor"): p.append(S["outdoor"])  # stops frozen seas behind moving people
    w = B.get("worlds", {}).get(s.get("scene"))
    style = S["styles"][s["layer"]] if s.get("layer") and S.get("styles") else S["style"]
    return no_cast(s, " ".join(p + ([w] if w else []) + [style, f"Sound: {s['sound']}."]))
def handover(i):
    """First frame of shot i = a frame of the previous shot's chosen take, `back` seconds before its end."""
    h = SH[i]["first_from"]; clip = json.load(open("cut.json"))[h["shot"]]
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip], capture_output=True, text=True).stdout)
    at = round(dur - h["back"], 3); out = f"frames/{i}_first.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(at), "-i", clip, "-frames:v", "1", out], check=True)
    hv = json.load(open("handover.json")) if os.path.exists("handover.json") else {}
    hv[i] = {"from": h["shot"], "clip": clip, "cut_at": at}; json.dump(hv, open("handover.json", "w"), indent=1)
    return out
def run_all(jobs, width=6):
    fails = []
    for k in range(0, len(jobs), width):
        ps = [(n, subprocess.Popen(j, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)) for n, j in jobs[k:k + width]]
        for n, p in ps:
            out = p.communicate()[0].strip().splitlines()
            print(n, "|", " | ".join(out[-2:]))
            if p.returncode: fails.append(n)
    if fails: print("FAILED:", fails)
cmd = sys.argv[1]
if cmd == "keys":
    v = opt("--v", 1)
    run_all([(i, key_job(i, v)) for i in ids() if SH[i].get("key")])
elif cmd == "clips":
    take = opt("--take", 1); jobs = []
    for i in ids(True):
        s = SH[i]; name = f"{i}_take{take}"
        j = ["python3", FILM, "video", name, clip_prompt(s), "--model", S["model"], "--duration", str(s["duration"]), "--resolution", S["resolution"],
             "--first", png(handover(i) if s.get("first_from") else keyfile(i)), "--seed", str(s.get("seed", 1) + take - 1), "--est", str(round(s["duration"] * S["usd_per_second"] * 1.05, 2))]
        if s.get("last"): j += ["--last", png(keyfile(s["last"]))]
        jobs.append((name, j))
    run_all(jobs, opt("--width", 5))
    cut = json.load(open("cut.json")) if os.path.exists("cut.json") else {}
    for n, _ in jobs:
        if os.path.exists(f"clips/{n}.mp4"): cut[n.split("_take")[0]] = f"clips/{n}.mp4"
    json.dump(cut, open("cut.json", "w"), indent=1)
elif cmd == "sheet":
    from PIL import Image, ImageDraw
    L = [i for i in ids() if keyfile(i)]; cols = 4; w, h = 480, 270
    sheet = Image.new("RGB", (cols * w, -(-len(L) // cols) * h))
    for n, i in enumerate(L):
        im = Image.open(keyfile(i)).convert("RGB").resize((w, h)); ImageDraw.Draw(im).text((8, 6), i, fill=(255, 255, 0))
        sheet.paste(im, ((n % cols) * w, (n // cols) * h))
    sheet.save("frames/_sheet.jpg", quality=85); print("frames/_sheet.jpg", len(L))
elif cmd == "cost":
    d = sum(s["duration"] for s in S["shots"] if not s.get("keyframe_only"))
    print(f"{d} s of film in {sum(1 for s in S['shots'] if not s.get('keyframe_only'))} shots, one take each: ${d * S['usd_per_second']:.2f}")
elif cmd == "claims":
    from PIL import Image, ImageDraw, ImageFont
    import textwrap, tempfile
    cut = json.load(open("cut.json")); TMP = tempfile.mkdtemp(); f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 20)
    L = [i for i in ids(True) if i in cut]; per = opt("--per", 2)
    for n in range(0, len(L), per):
        part = L[n:n + per]; sh = Image.new("RGB", (1920, 520 * len(part)), (18, 18, 18)); d = ImageDraw.Draw(sh)
        for r, i in enumerate(part):
            dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", cut[i]], capture_output=True, text=True).stdout)
            for k, fr in enumerate((0.04, 0.5, 0.97)):
                o = os.path.join(TMP, f"{i}_{k}.jpg")
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{dur * fr:.2f}", "-i", cut[i], "-frames:v", "1", "-vf", "scale=640:360", o])
                sh.paste(Image.open(o), (k * 640, r * 520))
            txt = f"{i} ({os.path.basename(cut[i])}, {dur:.1f}s)  must show:  " + "  |  ".join(SH[i].get("claims", ["(no claims listed)"]))
            d.multiline_text((12, r * 520 + 368), "\n".join(textwrap.wrap(txt, 170)), font=f, fill=(255, 230, 120))
        o = f"frames/_claims_{n // per + 1}.jpg"; sh.save(o, quality=86); print(o, part)
