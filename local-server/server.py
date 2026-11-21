#!/usr/bin/env python3
"""AnantPlay Sinhala Subtitle Bridge — local LAN / Termux server (zero cloud).

Pure Python 3 STANDARD LIBRARY ONLY (runs on Termux/Windows/Linux with just python3).
Serves the EXACT same endpoints as the Cloudflare Worker:

    GET  /                     → bridge UI index.html
    GET  /style.css, /app.js   → UI assets
    GET  /index.json           → dynamic catalog (this host's origin)
    GET  /sites.json           → dynamic sites catalog (rows.more, index:true)
    GET  /deeplinks.json       → host-keyed deeplink templates
    POST /api/publish-srt      → store a clean UTF-8 .srt (JSON {text} or {b64} or
                                 multipart file upload) → {"url": ".../sub/<token>.srt"}
    GET  /sub/<token>.srt      → REAL HTTP 200, application/x-subrip; charset=utf-8
                                 (this is the BUG #1 fix — ExoPlayer fetches a real file)
    GET  /api/search           → OpenSubtitles legacy REST (+ SubDL with X-SubDL-Key)
    POST /api/fetch-sub        → download .gz/.zip upstream, extract best .srt/.vtt,
                                 normalize, publish → real .srt URL
    GET  /gemini-test          → health probe (used by the e2e test)

Security (parity with worker/src/index.js):
    * /api/fetch-sub only downloads from an allowlisted subtitle provider over http(s),
      re-validating every redirect hop. Loopback/RFC1918/CGNAT/link-local/.local hosts,
      IP literals, credentials in the URL and odd ports are rejected (SSRF guard).
    * Upstream bodies and every gunzip/unzip result are capped (5 MB) → zip-bomb safe.
    * /api/publish-srt caps the request body and the decoded subtitle (2 MB).
    * Uploaded archives: `..` traversal rejected, __MACOSX/ ignored, nested folders OK.

Storage: ./subs/ directory, SHA-256 deduplicated (token = first 16 hex), 24h TTL swept
lazily on each request. AnantPlay has android:usesCleartextTraffic="true"
(AndroidManifest.xml:19), so http://<LAN-IP>:8765 works from the app.

Run:  python3 local-server/server.py            (0.0.0.0:8765)
      python3 local-server/server.py --port 8765 --host 0.0.0.0
"""
import argparse
import base64
import binascii
import gzip
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # repo root
PUBLIC = ROOT / "bridge-ui" / "public"
STORE = ROOT / "local-server" / "subs"
TTL = 24 * 3600
UA_OS = "TemporaryUserAgent"                            # OpenSubtitles legacy REST UA (SubOs.java:26)
UA_GENERIC = "Mozilla/5.0 (X11; Linux x86_64) AnantPlaySiBridge/2.1 (local)"

MAX_UPSTREAM = 5 * 1024 * 1024          # 5 MiB compressed download cap
MAX_UNCOMPRESSED = 5 * 1024 * 1024      # 5 MiB gunzip/unzip cap (zip-bomb guard)
MAX_PUBLISH = 2 * 1024 * 1024           # 2 MiB finished .srt cap
MAX_BODY = MAX_PUBLISH * 2              # raw HTTP body cap (JSON/b64 envelope)
MAX_REDIRECTS = 3
TIMEOUT = 15

# Subtitle providers /api/fetch-sub may download from. Subdomains match too.
DEFAULT_ALLOWED_HOSTS = ("opensubtitles.org", "opensubtitles.com", "subdl.com", "subdl.org", "piratelk.com")
ALLOWED_HOSTS = list(DEFAULT_ALLOWED_HOSTS)
for _extra in (os.environ.get("SI_BRIDGE_ALLOWED_HOSTS") or "").split(","):
    _extra = _extra.strip().lower()
    if _extra and _extra not in ALLOWED_HOSTS:
        ALLOWED_HOSTS.append(_extra)

TOKEN_RE = re.compile(r"[0-9a-f]{16}")
HOST_HEADER_RE = re.compile(r"^(?:[A-Za-z0-9.\-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$")

PRIVATE_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa", ".intranet", ".lan")


# ─────────────────────────── subtitle processing ───────────────────────────
def to_clean_srt(text: str):
    """BOM-strip, newline-normalize, validate; returns (text, was_vtt) or raises."""
    if not isinstance(text, str):
        raise ValueError("subtitle must be text")
    if text.startswith("\ufeff"):
        text = text[1:]
    stripped = text.lstrip()
    was_vtt = stripped.startswith("WEBVTT")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text).rstrip() + "\n"
    if not was_vtt and "-->" not in text:
        raise ValueError("not a subtitle file (no '-->' cues)")
    if len(text.encode("utf-8")) > MAX_PUBLISH:
        raise ValueError("subtitle too large (2 MB max)")
    return text, was_vtt


def parse_srt_cues(text: str):
    cues = []
    for block in re.split(r"\n\n+", text.strip()):
        lines = [l for l in block.split("\n") if l.strip()]
        if len(lines) < 2:
            continue
        i = 1 if re.fullmatch(r"\d+", lines[0].strip()) else 0
        if i >= len(lines) or "-->" not in lines[i]:
            continue
        cues.append({"idx": len(cues), "ts": lines[i], "lines": lines[i + 1:]})
    return cues


def is_gzip(b: bytes) -> bool:
    return len(b) > 1 and b[0] == 0x1F and b[1] == 0x8B


def is_zip(b: bytes) -> bool:
    return len(b) > 3 and b[0:4] == b"PK\x03\x04"


def _candidate_ok(name: str) -> bool:
    n = name.lower()
    if not n:
        return False
    if n.startswith("__macosx/") or n.startswith("__macosx\\"):
        return False
    # reject absolute paths and Windows drive letters as well as `..` traversal
    if n.startswith("/") or n.startswith("\\") or re.match(r"^[a-z]:[\\/]", n):
        return False
    if ".." in n.replace("\\", "/").split("/"):
        return False
    return n.endswith(".srt") or n.endswith(".vtt")


def _rank(name: str) -> int:
    n = name.lower()
    score = 100 if n.endswith(".srt") else (40 if n.endswith(".vtt") else 0)
    score -= 5 * len(n.split("/"))
    if re.search(r"සිංහල|sinhala|(^|[-._])si\b|[-.]si[._-]|\.si\.", n):
        score += 30
    if len(n) < 40:
        score += 10
    return score


def pick_best_entry(names, infos=None):
    subs = [n for n in names if _candidate_ok(n)]
    if infos is not None:
        # zip-bomb guard: never pick an entry whose declared size blows the cap
        subs = [n for n in subs if infos.get(n, 0) <= MAX_UNCOMPRESSED]
    if not subs:
        return None
    return max(subs, key=_rank)


def extract_best_zip(raw: bytes):
    """Return (bytes, name) of the best .srt/.vtt entry; None if nothing valid."""
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        infos = {i.filename: i.file_size for i in z.infolist()}
        best = pick_best_entry(z.namelist(), infos)
        if best is None:
            return None
        if infos.get(best, 0) > MAX_UNCOMPRESSED:
            raise ValueError("zip entry too large (zip-bomb guard)")
        with z.open(best) as fh:
            data = fh.read(MAX_UNCOMPRESSED + 1)
        if len(data) > MAX_UNCOMPRESSED:
            raise ValueError("zip entry too large (zip-bomb guard)")
        return data, best


def decompress_any(raw: bytes):
    """gunzip or unzip; returns (bytes, entry_name) — entry_name empty when not a zip."""
    if is_gzip(raw):
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as gz:
            data = gz.read(MAX_UNCOMPRESSED + 1)
        if len(data) > MAX_UNCOMPRESSED:
            raise ValueError("decompressed content too large")
        return data, ""
    if is_zip(raw):
        got = extract_best_zip(raw)
        if got is None:
            raise ValueError("no subtitle entry inside zip")
        return got
    if len(raw) > MAX_UNCOMPRESSED:
        raise ValueError("subtitle file too large")
    return raw, ""


# ─────────────────────────── SSRF guard (parity with the Worker) ───────────
def is_private_host(hostname: str) -> bool:
    h = (hostname or "").lower().rstrip(".")
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    if not h:
        return True
    if h in ("localhost", "localhost.localdomain"):
        return True
    if h.endswith(PRIVATE_SUFFIXES):
        return True
    if ":" in h:
        return True  # no raw IPv6 literals upstream
    m = re.fullmatch(r"(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})", h)
    if not m:
        return False
    a, b = int(m.group(1)), int(m.group(2))
    if a in (0, 10, 127):
        return True
    if a == 169 and b == 254:
        return True
    if a == 172 and 16 <= b <= 31:
        return True
    if a == 192 and b == 168:
        return True
    if a == 100 and 64 <= b <= 127:
        return True
    if a == 198 and b in (18, 19):
        return True
    if a >= 224:
        return True
    return False


def host_allowed(hostname: str) -> bool:
    h = (hostname or "").lower().rstrip(".")
    if h.startswith("www."):
        h = h[4:]
    if not h:
        return False
    for allowed in ALLOWED_HOSTS:
        a = allowed.lower().strip()
        if a.startswith("www."):
            a = a[4:]
        if a and (h == a or h.endswith("." + a)):
            return True
    return False


def assert_safe_upstream(raw: str) -> str:
    """Validate one upstream subtitle URL; returns it normalised or raises ValueError."""
    try:
        u = urllib.parse.urlsplit(str(raw or ""))
    except ValueError:
        raise ValueError("invalid subtitle URL")
    if u.scheme not in ("http", "https"):
        raise ValueError("only http(s) upstream URLs are allowed")
    if u.username or u.password:
        raise ValueError("upstream URL must not contain credentials")
    try:
        port = u.port
    except ValueError:
        raise ValueError("invalid upstream port")
    if port and port not in (80, 443):
        raise ValueError("upstream port not allowed")
    host = u.hostname or ""
    if is_private_host(host):
        raise ValueError("upstream host is private/loopback — SSRF blocked")
    if not host_allowed(host):
        raise ValueError("upstream host not allowlisted: " + host)
    return u.geturl()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow redirects implicitly — every hop is re-validated by hand."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def safe_http_get(url: str, headers=None, timeout=TIMEOUT, limit=MAX_UPSTREAM):
    """Allowlist + per-hop redirect re-validation + timeout + size cap."""
    current = assert_safe_upstream(url)
    for _ in range(MAX_REDIRECTS + 1):
        req = urllib.request.Request(current, headers=headers or {"User-Agent": UA_GENERIC})
        try:
            resp = _OPENER.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            if 300 <= e.code < 400:
                loc = e.headers.get("Location")
                if not loc:
                    raise ValueError("upstream redirect without a location")
                current = assert_safe_upstream(urllib.parse.urljoin(current, loc))
                try:
                    e.close()
                except Exception:
                    pass
                continue
            raise
        with resp:
            declared = int(resp.headers.get("Content-Length") or 0)
            if declared and declared > limit:
                raise ValueError("upstream file too large")
            data = resp.read(limit + 1)
            if len(data) > limit:
                raise ValueError("upstream file too large")
            return data
    raise ValueError("too many upstream redirects")


# ─────────────────────────── storage: SHA-256 dedupe + 24h TTL ──────────────
def sweep_expired():
    now = time.time()
    try:
        for f in STORE.glob("*.srt"):
            try:
                if now - f.stat().st_mtime > TTL:
                    f.unlink()
            except OSError:
                pass
    except OSError:
        pass


def publish_srt(text: str):
    STORE.mkdir(parents=True, exist_ok=True)
    token = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    path = STORE / f"{token}.srt"
    if not path.exists():
        tmp = STORE / f"{token}.tmp"
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    return token, path


def is_valid_token(token: str) -> bool:
    return bool(TOKEN_RE.fullmatch(token or ""))


def get_srt(token: str):
    if not is_valid_token(token):
        return None
    path = STORE / f"{token}.srt"
    if path.exists():
        return path.read_text(encoding="utf-8")
    return None


# ─────────────────────────── upstream providers ───────────────────────────
def open_subs_search(imdb: str, season: int, episode: int, langs=("sin", "eng")):
    url = "https://rest.opensubtitles.org/search/imdbid-" + urllib.parse.quote(imdb)
    url += "/sublanguageid-" + ",".join(langs)
    if season:
        url += f"/season-{season}"
    if episode and episode > 0:
        url += f"/episode-{episode}"
    try:
        raw = safe_http_get(url, {"User-Agent": UA_OS, "Accept": "application/json"})
        arr = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return []
    if not isinstance(arr, list):
        return []
    out = []
    for r in arr[:40]:
        if not r.get("SubDownloadLink"):
            continue
        out.append({
            "provider": "opensubtitles",
            "id": str(r.get("IDSubtitleFile", "")),
            "url": r["SubDownloadLink"],
            "lang": r.get("SubLanguageID", r.get("ISO639", "en")),
            "release": r.get("MovieReleaseName", r.get("SubFileName", "")),
            "format": "srt",
            "hearingImpaired": str(r.get("SubHearingImpaired", "0")) == "1",
            "downloads": int(r.get("SubDownloadsCnt", 0) or 0),
        })
    return out


def subdl_search(imdb: str, season: int, episode: int, api_key: str):
    if not api_key:
        return []
    q = {"imdb_id": imdb, "languages": "si,en", "dl": "1"}
    if season:
        q["season"] = str(season)
    if episode and episode > 0:
        q["episode"] = str(episode)
    url = "https://api.subdl.com/api/v1/subtitles?" + urllib.parse.urlencode(q)
    try:
        raw = safe_http_get(url, {"User-Agent": UA_GENERIC, "X-SubDL-Key": api_key})
        j = json.loads(raw.decode("utf-8", "replace"))
    except Exception:
        return []
    arr = j.get("subtitles") or []
    out = []
    for s in arr[:40]:
        dl = s.get("url") or ""
        if not dl:
            continue
        if dl.startswith("/"):
            dl = "https://dl.subdl.com" + dl
        out.append({
            "provider": "subdl",
            "id": str(s.get("id", "")),
            "url": dl,
            "lang": s.get("language", "si"),
            "release": s.get("release_name", s.get("name", "")),
            "format": "srt",
            "hearingImpaired": False,
            "downloads": 0,
        })
    return out


def piratelk_search(imdb: str, title_hint: str):
    try:
        robots = safe_http_get("https://piratelk.com/robots.txt", {"User-Agent": UA_GENERIC}, timeout=10, limit=64 * 1024)
        if re.search(r"(?m)^\s*Disallow:\s*/\s*$", robots.decode("utf-8", "replace")):
            return []
    except Exception:
        pass
    if not title_hint:
        return []
    return [{
        "provider": "piratelk",
        "id": "hint",
        "url": "https://piratelk.com/?s=" + urllib.parse.quote(title_hint),
        "lang": "si",
        "release": title_hint,
        "format": "zip",
        "hearingImpaired": False,
        "downloads": 0,
    }]


def fetch_upstream_sub(url: str) -> str:
    raw = safe_http_get(url, {"User-Agent": UA_OS, "Accept": "*/*"})
    data, _entry = decompress_any(raw)
    text = data.decode("utf-8", "replace")
    clean, _ = to_clean_srt(text)
    return clean


# ─────────────────────────── dynamic catalog (live origin) ─────────────────
def catalog(origin: str):
    """AnantPlay v2.23.1 shapes:
    sources → Sources.parseIndex; sites → Cats.KEYS rows + index boolean;
    deeplinks → {hostname: {movie,tv,episode}} (Sites.hostOf, no www.).
    """
    parsed = urllib.parse.urlsplit(origin)
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    site = {"name": "Sinhala Subtitle Bridge", "url": origin + "/", "index": True,
            "tags": ["Subtitles", "Sinhala"], "group": "More"}
    return {
        "/index.json": {"name": "Sinhala Subtitle Bridge", "sources": [
            {
                "id": origin,
                "name": "Sinhala Subtitle Bridge",
                "description": "Sinhala subtitles for any stream: search, machine-translate (EN→SI) or upload, then hand the real .srt URL to AnantPlay.",
                "type": "sites",
                "url": origin + "/sites.json",
            },
            {
                "id": origin + "/deeplinks",
                "name": "Sinhala Subtitle Bridge (deeplinks)",
                "description": "Auto-fill movie/tv/episode picks from AnantPlay Title Links.",
                "type": "deeplinks",
                "url": origin + "/deeplinks.json",
            },
        ]},
        "/sites.json": {
            "rows": {"more": [dict(site)]},
            "languages": {"Sinhala": [dict(site)]},
        },
        "/deeplinks.json": {
            host: {
                "movie": origin + "/?type=movie&tmdb={tmdb}&imdb={imdb}",
                "tv": origin + "/?type=tv&tmdb={tmdb}&imdb={imdb}",
                "episode": origin + "/?type=tv&tmdb={tmdb}&imdb={imdb}&s={season}&e={episode}",
            }
        },
    }


# ─────────────────────────── HTTP handler ─────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SiBridge/2.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # helpers ------------------------------------------------------------
    def _origin(self) -> str:
        host = (self.headers.get("Host") or "").strip()
        if not host or not HOST_HEADER_RE.fullmatch(host):
            host = "127.0.0.1:%d" % self.server.server_address[1]
        return "http://" + host

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-SubDL-Key, X-Gemini-Key")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if getattr(self, "_head_only", False):
            return
        self.wfile.write(body)

    def _bytes(self, data: bytes, ctype: str, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if getattr(self, "_head_only", False):
            return
        self.wfile.write(data)

    def _file(self, path: Path, ctype: str):
        if not path.exists():
            self._bytes(b"not found\n", "text/plain; charset=utf-8", 404)
            return
        self._bytes(path.read_bytes(), ctype)

    # dispatch ------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-SubDL-Key, X-Gemini-Key")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        self._head_only = True
        try:
            self.do_GET()
        finally:
            self._head_only = False

    def do_GET(self):
        sweep_expired()
        url = urllib.parse.urlparse(self.path)
        p = url.path
        q = urllib.parse.parse_qs(url.query)

        # the REAL subtitle delivery (BUG #1 fix) — HTTP 200 x-subrip
        m = re.fullmatch(r"/sub/([0-9a-f]{16})\.srt", p)
        if m:
            text = get_srt(m.group(1))
            if text is None:
                self._bytes("subtitle expired or not found\n".encode(), "text/plain; charset=utf-8", 404)
            else:
                self._bytes(text.encode("utf-8"), "application/x-subrip; charset=utf-8", 200,
                            {"Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff"})
            return

        cat = catalog(self._origin())
        if p in cat:
            self._json(cat[p])
            return

        if p == "/" or p == "/index.html":
            self._file(PUBLIC / "index.html", "text/html; charset=utf-8")
            return
        if p == "/style.css":
            self._file(PUBLIC / "style.css", "text/css; charset=utf-8")
            return
        if p == "/app.js":
            self._file(PUBLIC / "app.js", "application/javascript; charset=utf-8")
            return

        if p == "/api/search":
            imdb = (q.get("imdb") or [""])[0]
            if not re.fullmatch(r"tt\d{4,10}", imdb):
                self._json({"ok": False, "error": "bad imdb"}, 400)
                return
            season = _safe_int((q.get("season") or ["0"])[0], 0, 999)
            episode = _safe_int((q.get("episode") or ["0"])[0], 0, 9999)
            title = ((q.get("title") or [""])[0])[:200]
            key = self.headers.get("X-SubDL-Key") or ""
            failed = []
            results = []
            for name, fn in (("opensubtitles", lambda: open_subs_search(imdb, season, episode)),
                             ("subdl", lambda: subdl_search(imdb, season, episode, key)),
                             ("piratelk", lambda: piratelk_search(imdb, title))):
                try:
                    results += [r for r in fn() if r.get("url")]
                except Exception:
                    failed.append(name)
            self._json({"ok": True, "imdb": imdb, "season": season, "episode": episode,
                        "count": len(results), "results": results, "failed": failed})
            return

        if p == "/gemini-test":
            self._json({"ok": True, "server": "si-bridge-local", "origin": self._origin()})
            return

        self._json({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        p = url.path
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.close_connection = True
            self._json({"ok": False, "error": "request body too large (2 MB subtitle max)"}, 413)
            return
        body = self.rfile.read(length) if length else b""

        if p == "/api/publish-srt":
            ctype = self.headers.get("Content-Type") or ""
            text = None
            try:
                if ctype.startswith("multipart/form-data"):
                    # minimal multipart parse (file field any name)
                    bm = re.search(r'boundary="?([^";]+)"?', ctype)
                    if not bm:
                        raise ValueError("missing multipart boundary")
                    boundary = bm.group(1).encode()
                    for part in body.split(b"--" + boundary):
                        if b"filename=" not in part:
                            continue
                        blob = part.split(b"\r\n\r\n", 1)
                        if len(blob) == 2:
                            raw = blob[1].rstrip(b"\r\n")
                            data, _ = decompress_any(raw)
                            text = data.decode("utf-8", "replace")
                            break
                else:
                    j = json.loads(body.decode("utf-8")) if body else {}
                    if isinstance(j.get("b64"), str) and j["b64"]:
                        if len(j["b64"]) > MAX_BODY:
                            self._json({"ok": False, "error": "upload too large (2 MB max)"}, 413)
                            return
                        try:
                            raw = base64.b64decode(j["b64"], validate=True)
                        except (binascii.Error, ValueError):
                            raw = base64.b64decode(j["b64"], validate=False)
                        if len(raw) > MAX_UNCOMPRESSED:
                            self._json({"ok": False, "error": "upload too large (5 MB max)"}, 413)
                            return
                        data, _ = decompress_any(raw)
                        text = data.decode("utf-8", "replace")
                    elif isinstance(j.get("text"), str):
                        text = j["text"]
            except Exception as e:
                self._json({"ok": False, "error": "bad request: " + str(e)}, 400)
                return
            if not text:
                self._json({"ok": False, "error": "empty subtitle"}, 400)
                return
            try:
                clean, _ = to_clean_srt(text)
            except ValueError as e:
                msg = str(e)
                self._json({"ok": False, "error": msg}, 413 if "too large" in msg else 400)
                return
            token, _ = publish_srt(clean)
            self._json({"ok": True, "url": self._origin() + "/sub/" + token + ".srt",
                        "token": token, "bytes": len(clean.encode("utf-8")),
                        "cues": len(parse_srt_cues(clean))})
            return

        if p == "/api/fetch-sub":
            try:
                j = json.loads(body.decode("utf-8")) if body else {}
            except Exception:
                self._json({"ok": False, "error": "bad json"}, 400)
                return
            upstream = str(j.get("url") or "")
            try:
                upstream = assert_safe_upstream(upstream)
            except ValueError as e:
                self._json({"ok": False, "error": str(e)}, 400)
                return
            try:
                text = fetch_upstream_sub(upstream)
                token, _ = publish_srt(text)
                self._json({"ok": True, "url": self._origin() + "/sub/" + token + ".srt",
                            "token": token, "bytes": len(text.encode("utf-8")),
                            "cues": len(parse_srt_cues(text))})
            except Exception as e:
                self._json({"ok": False, "error": str(e)}, 502)
            return

        self._json({"ok": False, "error": "not found"}, 404)


def _safe_int(raw, default, maximum):
    try:
        return max(0, min(maximum, int(str(raw).strip() or default)))
    except (TypeError, ValueError):
        return default


def main():
    ap = argparse.ArgumentParser(description="AnantPlay Sinhala Subtitle Bridge — local server")
    ap.add_argument("--host", default="0.0.0.0", help="bind address (default 0.0.0.0 = LAN)")
    ap.add_argument("--port", type=int, default=8765, help="port (default 8765)")
    args = ap.parse_args()
    STORE.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    lan_ip = ""
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        lan_ip = s.getsockname()[0]
        s.close()
    except OSError:
        lan_ip = "127.0.0.1"
    print(f"SiBridge local server → http://{lan_ip}:{args.port}/  (LAN) · http://127.0.0.1:{args.port}/")
    print("AnantPlay (usesCleartextTraffic=true) can open this directly. Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
