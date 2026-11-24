#!/usr/bin/env python3
"""Upload files of any size to Arnd's Google Drive (bypasses the Drive connector's ~3 MB limit).

Uses an OAuth "Desktop app" client in Arnd's own Google Cloud project ("Director Uploader"),
scope drive.file: the uploader only sees files and folders it created itself.
So it keeps its own folder tree on Drive ("Director/..."), created on demand.

Credential (secret, never commit / never put in memory, chat or Drive):
    /mnt/project-files/.secrets/google-drive-oauth.json
    {"client_id": ..., "client_secret": ..., "refresh_token": ...}
    Override with env GOOGLE_DRIVE_OAUTH_FILE.

Usage:
    python3 drive_upload.py upload LOCAL_FILE "Director/movies/leaf-journey/cut" [--name NAME] [--replace]
    python3 drive_upload.py ls "Director/movies/leaf-journey"
    python3 drive_upload.py whoami
    # one-time setup (needs client_id/client_secret already in the credential file):
    python3 drive_upload.py auth-url
    python3 drive_upload.py auth-exchange "<full redirect URL or code>"
"""
import json, mimetypes, os, sys, urllib.parse
import requests

CRED = os.environ.get("GOOGLE_DRIVE_OAUTH_FILE", "/mnt/project-files/.secrets/google-drive-oauth.json")
SCOPE = "https://www.googleapis.com/auth/drive.file"
REDIRECT = "http://127.0.0.1:8765"
API = "https://www.googleapis.com/drive/v3"
UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
FOLDER = "application/vnd.google-apps.folder"
CHUNK = 16 * 1024 * 1024  # multiple of 256 KiB


def load():
    with open(CRED) as f:
        return json.load(f)


def save(c):
    os.makedirs(os.path.dirname(CRED), exist_ok=True)
    tmp = CRED + ".tmp"
    with open(tmp, "w") as f:
        json.dump(c, f, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CRED)


def token():
    c = load()
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": c["client_id"], "client_secret": c["client_secret"],
        "refresh_token": c["refresh_token"], "grant_type": "refresh_token"}, timeout=60)
    if r.status_code != 200:
        sys.exit(f"token refresh failed ({r.status_code}): {r.text[:300]}\n"
                 "If 'invalid_grant': access was revoked or expired; redo auth-url / auth-exchange.")
    return r.json()["access_token"]


def H(tok):
    return {"Authorization": f"Bearer {tok}"}


def q_escape(s):
    return s.replace("\\", "\\\\").replace("'", "\\'")


def find(tok, name, parent, folder=None):
    q = f"name='{q_escape(name)}' and '{parent}' in parents and trashed=false"
    if folder is True:
        q += f" and mimeType='{FOLDER}'"
    r = requests.get(f"{API}/files", headers=H(tok), params={
        "q": q, "fields": "files(id,name,mimeType,size,createdTime)", "spaces": "drive"}, timeout=60)
    r.raise_for_status()
    return r.json()["files"]


def ensure_path(tok, path):
    parent = "root"
    for part in [p for p in path.strip("/").split("/") if p]:
        hits = find(tok, part, parent, folder=True)
        if hits:
            parent = hits[0]["id"]
        else:
            r = requests.post(f"{API}/files", headers=H(tok), params={"fields": "id"},
                              json={"name": part, "mimeType": FOLDER, "parents": [parent]}, timeout=60)
            r.raise_for_status()
            parent = r.json()["id"]
    return parent


def upload(local, path, name=None, replace=False):
    tok = token()
    name = name or os.path.basename(local)
    parent = ensure_path(tok, path)
    existing = [f for f in find(tok, name, parent) if f["mimeType"] != FOLDER]
    size = os.path.getsize(local)
    mime = mimetypes.guess_type(local)[0] or "application/octet-stream"
    hdr = {**H(tok), "X-Upload-Content-Type": mime, "X-Upload-Content-Length": str(size),
           "Content-Type": "application/json; charset=UTF-8"}
    if existing and replace:  # new revision of the same file, keeps id and link
        r = requests.patch(f"{UPLOAD}/{existing[0]['id']}?uploadType=resumable", headers=hdr, json={}, timeout=60)
    else:
        if existing:
            sys.exit(f"'{name}' already exists in {path} (id {existing[0]['id']}); pass --replace or --name")
        r = requests.post(f"{UPLOAD}?uploadType=resumable", headers=hdr,
                          json={"name": name, "parents": [parent]}, timeout=60)
    r.raise_for_status()
    session = r.headers["Location"]
    sent = 0
    with open(local, "rb") as f:
        while True:
            chunk = f.read(CHUNK)
            end = sent + len(chunk) - 1
            rng = f"bytes {sent}-{end}/{size}" if chunk else f"bytes */{size}"
            r = requests.put(session, data=chunk, headers={"Content-Range": rng}, timeout=600)
            if r.status_code in (200, 201):
                meta = r.json()
                break
            if r.status_code != 308:
                sys.exit(f"upload failed ({r.status_code}): {r.text[:300]}")
            rg = r.headers.get("Range")
            sent = int(rg.split("-")[1]) + 1 if rg else 0
            f.seek(sent)
            print(f"  {sent * 100 // size}%", file=sys.stderr)
    fid = meta["id"]
    r = requests.get(f"{API}/files/{fid}", headers=H(tok),
                     params={"fields": "id,name,size,md5Checksum,webViewLink"}, timeout=60)
    r.raise_for_status()
    info = r.json()
    print(json.dumps(info, indent=1))
    return info


def ls(path):
    tok = token()
    parent = ensure_path(tok, path)
    r = requests.get(f"{API}/files", headers=H(tok), params={
        "q": f"'{parent}' in parents and trashed=false",
        "fields": "files(id,name,mimeType,size,modifiedTime)"}, timeout=60)
    r.raise_for_status()
    for f in r.json()["files"]:
        kind = "dir " if f["mimeType"] == FOLDER else f"{int(f.get('size', 0)):>11}"
        print(kind, f["name"], f["id"])


def share(file_id):
    """Make one file readable by anyone who has its link (needed where a model provider must fetch it by URL).
    Undo with: unshare <id>. Prints the direct download URL."""
    r = requests.post(f"https://www.googleapis.com/drive/v3/files/{file_id}/permissions", headers=H(token()),
                      json={"role": "reader", "type": "anyone"}, timeout=60)
    if r.status_code >= 300: sys.exit(f"share failed ({r.status_code}): {r.text[:300]}")
    print(f"https://drive.usercontent.google.com/download?id={file_id}&export=download")


def unshare(file_id):
    r = requests.delete(f"https://www.googleapis.com/drive/v3/files/{file_id}/permissions/anyoneWithLink", headers=H(token()), timeout=60)
    print("unshared" if r.status_code < 300 else f"unshare failed ({r.status_code}): {r.text[:200]}")


def auth_url():
    c = load()
    print("https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": c["client_id"], "redirect_uri": REDIRECT, "response_type": "code",
        "scope": SCOPE, "access_type": "offline", "prompt": "consent"}))


def auth_exchange(arg):
    code = urllib.parse.parse_qs(urllib.parse.urlparse(arg).query).get("code", [arg])[0]
    c = load()
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": c["client_id"], "client_secret": c["client_secret"], "code": code,
        "redirect_uri": REDIRECT, "grant_type": "authorization_code"}, timeout=60)
    if r.status_code != 200:
        sys.exit(f"exchange failed ({r.status_code}): {r.text[:300]}")
    j = r.json()
    if "refresh_token" not in j:
        sys.exit("no refresh_token returned")
    c["refresh_token"] = j["refresh_token"]
    save(c)
    print("refresh token stored in", CRED, "scope:", j.get("scope"))


def whoami():
    tok = token()
    r = requests.get(f"{API}/about", headers=H(tok), params={"fields": "user(displayName),storageQuota"}, timeout=60)
    r.raise_for_status()
    print(json.dumps(r.json(), indent=1))


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    cmd = a[0]
    if cmd == "upload":
        name = a[a.index("--name") + 1] if "--name" in a else None
        upload(a[1], a[2], name=name, replace="--replace" in a)
    elif cmd == "ls":
        ls(a[1])
    elif cmd == "share":
        share(a[1])
    elif cmd == "unshare":
        unshare(a[1])
    elif cmd == "whoami":
        whoami()
    elif cmd == "auth-url":
        auth_url()
    elif cmd == "auth-exchange":
        auth_exchange(a[1])
    else:
        sys.exit(__doc__)
