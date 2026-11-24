#!/usr/bin/env python3
"""Local stem listening / review app.

Usage:
    python3 server.py                       # uses ../listening_34_passed_20261116
    python3 server.py --data /path/to/folder --port 8765

Reviews are written to reviews.csv (song_id, comment, verdict) next to this file.
Standard library only.
"""
import argparse
import csv
import io
import json
import os
import re
import struct
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")
DEFAULT_DATA = os.path.join(os.path.dirname(APP_DIR), "listening_34_passed_20261116")
CSV_FIELDS = ["song_id", "comment", "verdict"]  # verdict: approve | reject | (blank)

LOCK = threading.Lock()
REVIEWS = {}
CFG = {}


# ---------------------------------------------------------------- metadata

def wav_info(path):
    """Read RIFF header -> duration/channels/rate without decoding audio."""
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"RIFF":
                return None
            f.read(4)
            if f.read(4) != b"WAVE":
                return None
            fmt = None
            while True:
                hdr = f.read(8)
                if len(hdr) < 8:
                    return None
                cid, size = hdr[:4], struct.unpack("<I", hdr[4:])[0]
                if cid == b"fmt ":
                    data = f.read(size)
                    _tag, ch, sr, _br, align, bits = struct.unpack("<HHIIHH", data[:16])
                    fmt = (ch, sr, align, bits)
                elif cid == b"data" and fmt:
                    ch, sr, align, bits = fmt
                    return {"channels": ch, "sample_rate": sr, "bits": bits,
                            "duration": size / float(align * sr)}
                else:
                    f.seek(size + (size & 1), 1)
    except OSError:
        return None


def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def stem_sort_key(name):
    m = re.match(r"(\d+)", name)
    return (int(m.group(1)) if m else 10**9, name.lower())


def build_songs(data_dir):
    first21 = {r["project_id"]: r for r in read_csv(os.path.join(data_dir, "first21_manifest.csv"))}
    next13 = {r["project_id"]: r for r in read_csv(os.path.join(data_dir, "full_mix_next13_validation.csv"))}
    songs = []
    for entry in os.listdir(data_dir):
        d = os.path.join(data_dir, entry)
        if not (entry.isdigit() and os.path.isdir(d)):
            continue
        mix_path = os.path.join(d, "full_mix.wav")
        stem_dir = os.path.join(d, "stems")
        stems = []
        if os.path.isdir(stem_dir):
            for s in sorted((n for n in os.listdir(stem_dir) if n.lower().endswith(".wav")), key=stem_sort_key):
                label = re.sub(r"\.wav$", "", s, flags=re.I)
                label = re.sub(r"^\d+_", "", label)
                stems.append({"file": s, "label": label,
                              "url": "/audio/%s/stems/%s" % (entry, urllib.parse.quote(s))})
        meta = first21.get(entry, {})
        title = re.sub(r"\.mmpz$", "", meta.get("title", "")).strip()
        song = {
            "id": entry,
            "title": title or "Project %s" % entry,
            "has_title": bool(title),
            "category": meta.get("category") or "",
            "renderer": meta.get("renderer") or ("1.2.2 batch" if entry in next13 else ""),
            "check": meta.get("full_mix_check") or next13.get(entry, {}).get("status", ""),
            "batch": "first21" if entry in first21 else ("next13" if entry in next13 else ""),
            "mix_url": "/audio/%s/full_mix.wav" % entry if os.path.exists(mix_path) else None,
            "stems": stems,
            "duration": (wav_info(mix_path) or {}).get("duration") if os.path.exists(mix_path) else None,
        }
        ac = os.path.join(d, "audio_checks.json")
        if os.path.exists(ac):
            try:
                c = json.load(open(ac))[0]
                song["peak"] = c.get("finite_peak")
                song["rms"] = c.get("finite_rms")
            except Exception:
                pass
        songs.append(song)
    songs.sort(key=lambda s: int(s["id"]))
    return songs


# ---------------------------------------------------------------- reviews

def load_reviews(path):
    out = {}
    for r in read_csv(path):
        sid = (r.get("song_id") or "").strip()
        if sid:
            out[sid] = {"comment": r.get("comment", ""), "verdict": (r.get("verdict") or "").strip()}
    return out


def save_reviews(path):
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        for sid in sorted(REVIEWS, key=lambda x: int(x) if x.isdigit() else 0):
            r = REVIEWS[sid]
            if r["comment"].strip() or r["verdict"]:
                w.writerow({"song_id": sid, "comment": r["comment"], "verdict": r["verdict"]})
    os.replace(tmp, path)


# ---------------------------------------------------------------- http

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".wav": "audio/wav", ".svg": "image/svg+xml"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if "/audio/" not in (str(args[0]) if args else ""):
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, download_name=None):
        if not os.path.isfile(path):
            return self.send_error(404)
        size = os.path.getsize(path)
        ext = os.path.splitext(path)[1].lower()
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = size - int(m.group(2))
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        else:
            self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        if download_name:
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % download_name)
        if ext in (".html", ".js", ".css"):
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def safe_join(self, base, rel):
        p = os.path.realpath(os.path.join(base, rel))
        return p if p.startswith(os.path.realpath(base) + os.sep) else None

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(url.path)
        if path == "/api/songs":
            return self.send_json(CFG["songs"])
        if path == "/api/reviews":
            with LOCK:
                return self.send_json(REVIEWS)
        if path == "/reviews.csv":
            with LOCK:
                if not os.path.exists(CFG["csv"]):
                    save_reviews(CFG["csv"])
            return self.send_file(CFG["csv"], "reviews.csv")
        if path.startswith("/audio/"):
            p = self.safe_join(CFG["data"], path[len("/audio/"):])
            return self.send_file(p) if p and p.lower().endswith(".wav") else self.send_error(404)
        if path in ("/", ""):
            path = "/index.html"
        p = self.safe_join(STATIC_DIR, path.lstrip("/"))
        return self.send_file(p) if p else self.send_error(404)

    def do_import(self):
        """POST /api/import[?dry=1] with raw CSV text. Merges: imported rows overwrite same song_id."""
        dry = "dry=1" in (urllib.parse.urlparse(self.path).query or "")
        n = int(self.headers.get("Content-Length", 0))
        text = self.rfile.read(n).decode("utf-8-sig", errors="replace")
        rows = list(csv.DictReader(io.StringIO(text)))
        if not rows or "song_id" not in rows[0]:
            return self.send_json({"error": "CSV needs a header row with song_id, comment, verdict"}, 400)
        known = {s["id"] for s in CFG["songs"]}
        incoming, skipped = {}, []
        for r in rows:
            sid = (r.get("song_id") or "").strip()
            verdict = (r.get("verdict") or "").strip().lower()
            if not sid.isdigit() or verdict not in ("", "approve", "reject"):
                skipped.append(sid or "?")
                continue
            incoming[sid] = {"comment": r.get("comment") or "", "verdict": verdict}
        with LOCK:
            added = [s for s in incoming if s not in REVIEWS]
            changed = [s for s in incoming if s in REVIEWS and REVIEWS[s] != incoming[s]]
            unchanged = len(incoming) - len(added) - len(changed)
            if not dry:
                REVIEWS.update(incoming)
                save_reviews(CFG["csv"])
        return self.send_json({"added": len(added), "overwritten": changed, "unchanged": unchanged,
                               "skipped": skipped, "unknown": [s for s in incoming if s not in known],
                               "applied": not dry})

    def do_POST(self):
        if self.path.startswith("/api/import"):
            return self.do_import()
        m = re.match(r"^/api/reviews/(\d+)$", self.path)
        if not m:
            return self.send_error(404)
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self.send_json({"error": "bad json"}, 400)
        verdict = body.get("verdict", "")
        if verdict not in ("", "approve", "reject"):
            return self.send_json({"error": "bad verdict"}, 400)
        with LOCK:
            REVIEWS[m.group(1)] = {"comment": str(body.get("comment", "")), "verdict": verdict}
            save_reviews(CFG["csv"])
        return self.send_json({"ok": True})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=DEFAULT_DATA)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--csv", default=os.path.join(APP_DIR, "reviews.csv"))
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    CFG["data"] = os.path.abspath(a.data)
    CFG["csv"] = os.path.abspath(a.csv)
    CFG["songs"] = build_songs(CFG["data"])
    REVIEWS.update(load_reviews(CFG["csv"]))
    url = "http://localhost:%d/" % a.port
    print("Loaded %d songs from %s" % (len(CFG["songs"]), CFG["data"]))
    print("Reviews -> %s (%d existing)" % (CFG["csv"], len(REVIEWS)))
    print("Open %s   (Ctrl+C to stop)" % url)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
