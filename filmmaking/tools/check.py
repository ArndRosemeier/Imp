#!/usr/bin/env python3
"""Continuity checks on the clips named in cut.json, no paid calls.
 1. hidden cuts: the biggest frame-to-frame scene change inside each clip
 2. joins: how alike the last frame of a clip and the first frame of the next are (SSIM)
 3. leaf colour: mean hue/saturation of the leaf-coloured pixels at start and end of each clip"""
import json, subprocess, re, sys, os, tempfile
def run(a): return subprocess.run(a,capture_output=True,text=True)
def scene_max(clip):
    r=run(["ffmpeg","-i",clip,"-vf","select='gte(scene,0)',metadata=print","-an","-f","null","-"])
    pts=re.findall(r"pts_time:([\d.]+)\n.*?scene_score=([\d.]+)",r.stderr)
    s=sorted(((float(v),float(t)) for t,v in pts),reverse=True)[:1]
    return s[0] if s else (0,0)
def grab(clip,where,out):
    a=["ffmpeg","-v","error","-y"]+(["-sseof","-0.12"] if where=="last" else [])+["-i",clip]+(["-update","1"] if where=="last" else ["-frames:v","1"])+[out]
    run(a)
def ssim(a,b):
    r=run(["ffmpeg","-i",a,"-i",b,"-filter_complex","[0]scale=1280:720[x];[1]scale=1280:720[y];[x][y]ssim","-f","null","-"])
    m=re.search(r"All:([\d.]+)",r.stderr); return float(m.group(1)) if m else None
def leaf_colour(img):
    from PIL import Image
    im=Image.open(img).convert("HSV").resize((320,180)); px=list(im.get_flattened_data())
    # leaf pixels: red to orange hue, strongly saturated, not dark
    sel=[(h,s,v) for h,s,v in px if (h<28 or h>245) and s>150 and v>110]
    if len(sel)<200: return None
    hs=[(h if h<128 else h-256) for h,_,_ in sel]
    return round(sum(hs)/len(hs)*360/256,1), round(sum(s for _,s,_ in sel)/len(sel)/2.55), round(len(sel)/len(px)*100,1)
cut=json.load(open("cut.json")); ids=list(cut); tmp=tempfile.mkdtemp(); out={}
for i,k in enumerate(ids):
    grab(cut[k],"first",f"{tmp}/{k}_a.png"); grab(cut[k],"last",f"{tmp}/{k}_b.png")
    sc,t=scene_max(cut[k])
    out[k]={"clip":cut[k],"biggest_jump":round(sc,3),"at_s":round(t,2),"hidden_cut":sc>0.1,
            "leaf_start":leaf_colour(f"{tmp}/{k}_a.png"),"leaf_end":leaf_colour(f"{tmp}/{k}_b.png")}
    if i: out[k]["join_ssim"]=ssim(f"{tmp}/{ids[i-1]}_b.png",f"{tmp}/{k}_a.png")
for k,v in out.items(): print(k,json.dumps(v))
json.dump(out,open("continuity.json","w"),indent=1)
