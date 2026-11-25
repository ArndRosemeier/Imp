#!/usr/bin/env python3
"""Render a run of 'continues' shots in order. Each shot starts on the real
last frame of the clip before (an exact join) and ends on its anchor still
(so drift cannot build up).  chain.py <first-shot> [<last-shot>] [--take N]"""
import json, subprocess, sys, os
FILM = os.path.join(os.path.dirname(os.path.abspath(__file__)), "film.py")
def last_frame(clip, out):
    subprocess.run(["ffmpeg","-v","error","-y","-sseof","-0.12","-i",clip,"-update","1",out],check=True)
def main():
    args=[a for a in sys.argv[1:] if not a.startswith("--")]
    take=int(sys.argv[sys.argv.index("--take")+1]) if "--take" in sys.argv else 1
    s=json.load(open("shots.json")); shots=s["shots"]; ids=[x["id"] for x in shots]
    lo=ids.index(args[0]); hi=ids.index(args[1]) if len(args)>1 else len(ids)-1
    price=json.load(open("shots.json")).get("usd_per_second",0.0695)
    for i in range(lo,hi+1):
        sh=shots[i]; name=f"{sh['id']}_take{take}"
        if sh["from"]=="prev":
            prev=json.load(open("cut.json"))[ids[i-1]] if os.path.exists("cut.json") else f"clips/{ids[i-1]}_take1.mp4"
            first=f"frames/{sh['id']}_start.png"; last_frame(prev,first)
        else: first=f"frames/{sh['from']}.webp"
        prompt=f"{sh['action']} {s['style']} Sound: {sh['sound']}."
        r=subprocess.run(["python3",FILM,"video",name,prompt,"--model",s["model"],"--duration",str(sh["duration"]),
            "--first",first,"--last",f"frames/{sh['to']}.webp","--seed",str(sh["seed"]+take-1),
            "--est",str(round(sh["duration"]*price*1.1,2))])
        if r.returncode: sys.exit(f"{name} failed")
        cut=json.load(open("cut.json")) if os.path.exists("cut.json") else {}
        cut[sh["id"]]=f"clips/{name}.mp4"; json.dump(cut,open("cut.json","w"),indent=1)
main()
