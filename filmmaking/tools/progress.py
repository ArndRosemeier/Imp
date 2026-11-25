#!/usr/bin/env python3
"""Builds the progress page of a movie from its progress.json (run in the movie folder).
  progress.py set <step-id> <todo|doing|done|blocked> ["note"]   mark a step and rebuild
  progress.py img <step-id> <image> "caption"                    attach a thumbnail to a step
  progress.py learn "text"                                       add a workflow learning
  progress.py build                                              only rebuild progress.html
progress.json: {title, logline, spend_url, steps:[{id,name,what,status,note,at,images:[{file,caption}]}], learnings:[]}
The page shows spending from ledger.json. Publish progress.html with the Artifact tool after each change."""
import base64, html, io, json, os, sys, time
ROOT = os.path.abspath(os.environ.get("FILM_ROOT") or os.getcwd())
P = os.path.join(ROOT, "progress.json")
E = html.escape

def thumb(path, w=480):
    from PIL import Image
    im = Image.open(os.path.join(ROOT, path)).convert("RGB")
    im.thumbnail((w, w))
    b = io.BytesIO(); im.save(b, "JPEG", quality=72)
    return "data:image/jpeg;base64," + base64.b64encode(b.getvalue()).decode()

def spend():
    try:
        l = json.load(open(os.path.join(ROOT, "ledger.json")))
        return sum(e.get("cost_usd") or e.get("est_usd") or 0 for e in l["entries"]), l.get("budget_usd", 0)
    except Exception:
        return 0.0, 0.0

CSS = """
/* Layout: a production board. Header with where the film stands and what it has cost, then the workflow as one vertical run of steps, then what was learned. */
:root{--bg:#eef0ee;--panel:#f9faf8;--ink:#1d2422;--muted:#5f6b67;--line:#cfd6d2;--torch:#c2570c;--moss:#2e7359;--stone:#8a9691;--bad:#b3261e;
--display:"Bricolage Grotesque","Trebuchet MS",sans-serif;--body:"Source Sans 3",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121615;--panel:#1a201e;--ink:#e6ece9;--muted:#9aa7a2;--line:#2e3835;--torch:#f08a3c;--moss:#62c29b;--stone:#6d7975;--bad:#ef6b62;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#121615;--panel:#1a201e;--ink:#e6ece9;--muted:#9aa7a2;--line:#2e3835;--torch:#f08a3c;--moss:#62c29b;--stone:#6d7975;--bad:#ef6b62;color-scheme:dark}
body{background:var(--bg);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.5;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:28px 56px}
.wrap{max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:32px}
h1{font-family:var(--display);font-weight:700;font-size:34px;line-height:1.1;margin:0;text-wrap:balance}
h2{font-family:var(--display);font-weight:600;font-size:20px;margin:0}
.eyebrow{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.log{margin:0;color:var(--muted);max-width:62ch}
header{display:flex;flex-direction:column;gap:10px}
.facts{display:flex;flex-wrap:wrap;gap:10px 36px;border-block:1px solid var(--line);padding-block:14px}
.fact b{display:block;font-family:var(--mono);font-weight:500;font-size:18px;font-variant-numeric:tabular-nums}
.fact a{color:var(--torch)}
.meter{height:8px;background:var(--line);border-radius:4px;overflow:hidden}
.meter i{display:block;height:100%;background:var(--moss)}
ol.steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.step{display:grid;grid-template-columns:28px minmax(0,1fr);gap:0 14px;padding-bottom:22px;position:relative}
.step:not(:last-child)::before{content:"";position:absolute;left:13px;top:26px;bottom:0;width:2px;background:var(--line)}
.step.done:not(:last-child)::before{background:var(--moss)}
.mark{width:28px;height:28px;border-radius:50%;border:2px solid var(--stone);display:grid;place-items:center;font-family:var(--mono);font-size:13px;background:var(--bg);color:var(--muted);z-index:1}
.done .mark{background:var(--moss);border-color:var(--moss);color:var(--bg)}
.doing .mark{border-color:var(--torch);color:var(--torch);box-shadow:0 0 0 4px color-mix(in srgb,var(--torch) 22%,transparent)}
.blocked .mark{border-color:var(--bad);color:var(--bad)}
.head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.name{font-family:var(--display);font-weight:600;font-size:18px}
.todo .name{color:var(--muted)}
.state{font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:600}
.done .state{color:var(--moss)}.doing .state{color:var(--torch)}.blocked .state{color:var(--bad)}.todo .state{color:var(--stone)}
.at{font-family:var(--mono);font-size:12px;color:var(--muted)}
.what{margin:2px 0 0;color:var(--muted);font-size:14.5px;max-width:65ch}
.note{margin:8px 0 0;max-width:65ch;white-space:pre-line}
.shots figure:only-child{grid-column:1/-1}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:12px}
figure{margin:0}figure img{display:block;width:100%;border-radius:3px;border:1px solid var(--line)}
figcaption{font-size:12.5px;color:var(--muted);margin-top:3px}
ul.learn{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px;max-width:68ch}
section{display:flex;flex-direction:column;gap:14px}
"""
LABEL = {"todo": "To do", "doing": "In progress", "done": "Done", "blocked": "Waiting"}

def build():
    d = json.load(open(P)); s, b = spend()
    steps = d["steps"]; done = sum(x["status"] == "done" for x in steps)
    cur = next((x for x in steps if x["status"] in ("doing", "blocked")), None)
    o = ['<title>%s Production</title><meta name="claude:viewport-fit-sides" content="cover">' % E(d["title"]),
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@600;700&family=Source+Sans+3:wght@400;600&family=JetBrains+Mono:wght@400;500&display=swap">',
         "<style>" + CSS + "</style><div class=\"wrap\"><header><div class=\"eyebrow\">Production board</div>",
         "<h1>%s</h1><p class=\"log\">%s</p></header>" % (E(d["title"]), E(d.get("logline", "")))]
    o.append('<div><div class="facts"><div class="fact"><span class="eyebrow">Steps done</span><b>%d of %d</b></div>' % (done, len(steps)))
    o.append('<div class="fact"><span class="eyebrow">Now</span><b>%s</b></div>' % E(cur["name"] if cur else ("Finished" if done == len(steps) else "Starting")))
    o.append('<div class="fact"><span class="eyebrow">Spent on this film</span><b>$%.2f of $%.2f</b></div>' % (s, b))
    if d.get("spend_url"): o.append('<div class="fact"><span class="eyebrow">Every paid call</span><b><a href="%s">Cost report</a></b></div>' % E(d["spend_url"]))
    o.append('<div class="fact"><span class="eyebrow">Updated</span><b>%s UTC</b></div></div>' % time.strftime("%H:%M", time.gmtime()))
    o.append('<div class="meter" role="img" aria-label="%d of %d steps done"><i style="width:%d%%"></i></div></div>' % (done, len(steps), round(100 * done / len(steps))))
    o.append('<section><h2>The workflow, step by step</h2><ol class="steps">')
    for i, x in enumerate(steps, 1):
        st = x["status"]
        o.append('<li class="step %s"><div class="mark">%s</div><div><div class="head"><span class="name">%s</span><span class="state">%s</span>%s</div><p class="what">%s</p>' % (
            st, "✓" if st == "done" else i, E(x["name"]), LABEL[st], '<span class="at">%s UTC</span>' % E(x["at"]) if x.get("at") else "", E(x.get("what", ""))))
        if x.get("note"): o.append('<p class="note">%s</p>' % E(x["note"]))
        if x.get("images"):
            o.append('<div class="shots">' + "".join('<figure><img src="%s" alt="%s"><figcaption>%s</figcaption></figure>' % (thumb(im["file"], 1400 if "sheet" in im["file"] and "_sheet" in im["file"] else 480), E(im["caption"]), E(im["caption"])) for im in x["images"]) + "</div>")
        o.append("</div></li>")
    o.append("</ol></section>")
    if d.get("learnings"):
        o.append('<section><h2>What we have learned so far</h2><ul class="learn">' + "".join("<li>%s</li>" % E(t) for t in d["learnings"]) + "</ul></section>")
    o.append("</div>")
    open(os.path.join(ROOT, "progress.html"), "w").write("\n".join(o))
    print("progress.html", os.path.getsize(os.path.join(ROOT, "progress.html")) // 1024, "KB;", done, "of", len(steps))

def main():
    a = sys.argv[1:]
    if a and a[0] != "build":
        d = json.load(open(P))
        if a[0] == "learn": d.setdefault("learnings", []).append(a[1])
        else:
            x = next(s for s in d["steps"] if s["id"] == a[1])
            if a[0] == "set":
                x["status"] = a[2]
                if len(a) > 3: x["note"] = a[3]
                if a[2] == "done": x["at"] = time.strftime("%H:%M", time.gmtime())
            elif a[0] == "img": x.setdefault("images", []).append({"file": a[2], "caption": a[3]})
        json.dump(d, open(P, "w"), indent=1, ensure_ascii=False)
    build()
main()
