#!/bin/bash
# Builds the spend doc for the artifact and copies the movie folder to project files.
cd /home/user/work/movies/leaf-journey && python3 - <<'PY'
import json,os,time,urllib.request
l=json.load(open("ledger.json"))
r=urllib.request.Request("https://openrouter.ai/api/v1/key",headers={"Authorization":"Bearer "+os.environ["OPEN_ROUTER_KEY"]})
u=float(json.loads(urllib.request.urlopen(r).read())["data"]["usage"])
keep=("kind","name","model","cost_usd","at","duration")
doc={"title":"The Leaf","budget_usd":l["budget_usd"],"key_delta_usd":round(u-l["key_usage_at_start"],4),
 "updated_at":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),"entries":[{k:e.get(k) for k in keep if e.get(k) is not None} for e in l["entries"]]}
json.dump(doc,open("/home/user/work/artifacts/spend-doc.json","w"))
print("ledger",round(sum(e.get("cost_usd") or 0 for e in l["entries"]),3),"key",doc["key_delta_usd"],"n",len(doc["entries"]))
PY
mkdir -p /mnt/project-files/movies/ /mnt/project-files/tools/
cp -r /home/user/work/movies/leaf-journey /mnt/project-files/movies/ 2>&1 | tail -2
cp /home/user/work/tools/*.py /home/user/work/tools/sync.sh /mnt/project-files/tools/
