"""Real-HTTP end-to-end tests: local-server/server.py must serve the SAME real-.srt
architecture as the Worker. Starts the actual server on port 8766 and hits it over
real HTTP with urllib — the proof that ExoPlayer's DefaultDataSource (a plain Java
HTTP GET, outside any WebView) can NEVER get a 404 on a published subtitle.

Run: python3 -m unittest discover -s tests -p 'local_server_test.py' -v
(the server is started/stopped by the test module itself)
"""
import base64
import gzip
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "local-server" / "server.py"
PORT = 8766
BASE = f"http://127.0.0.1:{PORT}"
STORE = ROOT / "local-server" / "subs"

SINHALA_SRT = (
    "1\n00:00:01,000 --> 00:00:03,500\nආයුබෝවන් ලොව! මෙය පරීක්ෂණයකි.\n\n"
    "2\n00:00:04,000 --> 00:00:06,000\nදෙවන පේළිය\n"
)

_proc = None


def _start_server():
    global _proc
    # clean slate: no stale tokens from earlier runs
    if STORE.exists():
        shutil.rmtree(STORE)
    env = dict(os.environ)
    _proc = subprocess.Popen(
        [sys.executable, str(SERVER), "--port", str(PORT), "--host", "127.0.0.1"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env,
    )
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/gemini-test", timeout=2).read()
            return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("server did not come up")


def _stop_server():
    global _proc
    if _proc:
        _proc.terminate()
        try:
            _proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _proc.kill()
        _proc = None


def get(path, headers=None):
    req = urllib.request.Request(BASE + path, headers=headers or {})
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status, dict(r.headers), r.read()


def post(path, body, headers=None):
    data = json.dumps(body).encode() if isinstance(body, dict) else body
    h = {"Content-Type": "application/json"}
    h.update(headers or {})
    req = urllib.request.Request(BASE + path, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, r.read()


class TestRealHttpDelivery(unittest.TestCase):
    """BUG #1's exact failure mode, tested for real: publish → GET → must be HTTP 200
    with real Sinhala cue content (never 404, never a Service-Worker cache)."""

    @classmethod
    def setUpClass(cls):
        _start_server()

    @classmethod
    def tearDownClass(cls):
        _stop_server()

    def test_01_publish_returns_real_srt_url(self):
        status, body = post("/api/publish-srt", {"text": SINHALA_SRT})
        self.assertEqual(status, 200)
        j = json.loads(body)
        self.assertTrue(j["ok"], j)
        self.assertTrue(j["url"].endswith(".srt"), j["url"])
        self.assertTrue(j["url"].startswith("http://127.0.0.1:8766/sub/"), j["url"])
        self.assertEqual(j["cues"], 2, j)

    def test_02_get_sub_returns_real_http_200_sinhala(self):
        _, body = post("/api/publish-srt", {"text": SINHALA_SRT})
        url = json.loads(body)["url"]
        path = url.replace(BASE, "")
        status, headers, data = get(path)
        self.assertEqual(status, 200, f"THE FATAL BUG would be here: got {status}")
        self.assertIn("application/x-subrip", headers.get("Content-Type", ""))
        self.assertIn("charset=utf-8", headers.get("Content-Type", ""))
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "*")
        text = data.decode("utf-8")
        self.assertIn("ආයුබෝවන්", text)
        self.assertIn("-->", text)
        self.assertTrue(text.startswith("1\n"), "cue numbering intact")

    def test_03_get_by_full_url_through_plain_http(self):
        # exactly what ExoPlayer's DefaultDataSource does: a plain Java HTTP GET on the full URL
        _, body = post("/api/publish-srt", {"text": SINHALA_SRT})
        url = json.loads(body)["url"]
        with urllib.request.urlopen(url, timeout=10) as r:
            self.assertEqual(r.status, 200)
            self.assertIn("ආයුබෝවන්", r.read().decode("utf-8"))

    def test_04_sha256_dedupe_same_content_same_token(self):
        _, b1 = post("/api/publish-srt", {"text": SINHALA_SRT})
        _, b2 = post("/api/publish-srt", {"text": SINHALA_SRT})
        self.assertEqual(json.loads(b1)["token"], json.loads(b2)["token"])

    def test_05_publish_b64_zip_upload(self):
        # a local .zip upload (Baiscope-style): best entry extracted, junk skipped
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("__MACOSX/._junk", "junkjunkjunk")
            z.writestr("Subs/Nested/Breaking.si.srt", SINHALA_SRT)
            z.writestr("info.nfo", "nfo")
        _, body = post("/api/publish-srt", {"b64": base64.b64encode(buf.getvalue()).decode()})
        j = json.loads(body)
        self.assertTrue(j["ok"], j)
        status, _, data = get(j["url"].replace(BASE, ""))
        self.assertEqual(status, 200)
        text = data.decode("utf-8")
        self.assertIn("ආයුබෝවන්", text)
        self.assertNotIn("junkjunkjunk", text)

    def test_06_publish_b64_gz_upload(self):
        gz = gzip.compress(SINHALA_SRT.encode("utf-8"))
        _, body = post("/api/publish-srt", {"b64": base64.b64encode(gz).decode()})
        j = json.loads(body)
        self.assertTrue(j["ok"], j)
        _, _, data = get(j["url"].replace(BASE, ""))
        self.assertIn("ආයුබෝවන්", data.decode("utf-8"))

    def test_07_multipart_file_upload(self):
        boundary = "----sibridge"
        parts = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="si.srt"\r\n'
            f"Content-Type: application/x-subrip\r\n\r\n"
        ).encode() + SINHALA_SRT.encode("utf-8") + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(
            BASE + "/api/publish-srt", data=parts,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            j = json.loads(r.read())
        self.assertTrue(j["ok"], j)
        self.assertEqual(j["cues"], 2, j)

    def test_08_unknown_token_is_404_but_published_never(self):
        try:
            get("/sub/0000000000000000.srt")
            self.fail("unknown token must 404")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 404)
        # the published one still 200
        _, body = post("/api/publish-srt", {"text": SINHALA_SRT})
        status, _, _ = get(json.loads(body)["url"].replace(BASE, ""))
        self.assertEqual(status, 200)

    def test_09_bad_publish_rejected(self):
        try:
            post("/api/publish-srt", {"text": "<html>not a subtitle</html>"})
            self.fail("non-subtitle must be rejected")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)

    def test_10_index_json_dynamic_with_live_host(self):
        status, _, data = get("/index.json")
        self.assertEqual(status, 200)
        j = json.loads(data)
        types = [s["type"] for s in j["sources"]]
        self.assertIn("sites", types)
        self.assertIn("deeplinks", types)
        for s in j["sources"]:
            self.assertIn(f"http://127.0.0.1:{PORT}", s["url"])
            self.assertNotIn("YOUR-HOST", s["url"])

    def test_11_sites_and_deeplinks_json(self):
        status, _, data = get("/sites.json")
        self.assertEqual(status, 200)
        sites = json.loads(data)
        self.assertIn("rows", sites)
        # AnantPlay v2.23.1: Sites.merge reads rows.<Cats.KEYS>; `index` must be a real boolean
        self.assertIn("more", sites["rows"])
        row = sites["rows"]["more"][0]
        self.assertIsInstance(row["index"], bool)
        self.assertTrue(row["index"])
        self.assertEqual(row["url"], f"{BASE}/")
        self.assertIn("Sinhala", sites["languages"])
        status, _, data = get("/deeplinks.json")
        j = json.loads(data)
        # deeplinks.json is keyed by hostname (Sites.hostOf), not a flat template object
        self.assertEqual(list(j.keys()), ["127.0.0.1"], list(j.keys()))
        host = j["127.0.0.1"]
        self.assertEqual(host["movie"], f"{BASE}/?type=movie&tmdb={{tmdb}}&imdb={{imdb}}")
        self.assertEqual(host["episode"], f"{BASE}/?type=tv&tmdb={{tmdb}}&imdb={{imdb}}&s={{season}}&e={{episode}}")

    def test_12_bridge_ui_served(self):
        status, _, data = get("/")
        self.assertEqual(status, 200)
        self.assertIn("Sinhala Subtitle Bridge".encode() or "සිංහල උපසිරැසි පාලම".encode(), data)
        status, _, _ = get("/app.js")
        self.assertEqual(status, 200)
        status, _, _ = get("/style.css")
        self.assertEqual(status, 200)

    def test_13_search_validates_imdb(self):
        try:
            get("/api/search?imdb=zzz")
            self.fail("bad imdb must 400")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)

    def test_14_cors_preflight(self):
        req = urllib.request.Request(BASE + "/api/publish-srt", method="OPTIONS")
        with urllib.request.urlopen(req, timeout=5) as r:
            self.assertEqual(r.status, 204)
            self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), "*")

    def test_15_gemini_test_health(self):
        status, _, data = get("/gemini-test")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(data)["ok"])

    # ── security regressions (Gate 4, parity with the Worker) ──────────────
    def _post_status(self, path, body):
        try:
            post(path, body)
            return 200
        except urllib.error.HTTPError as e:
            return e.code

    def test_16_fetch_sub_blocks_ssrf(self):
        # loopback, link-local metadata, RFC1918, non-allowlisted host, non-http scheme
        for bad in (
            f"{BASE}/index.json",                       # loopback, same server
            "http://127.0.0.1:8766/index.json",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.5/x.srt",
            "http://192.168.1.10/x.srt",
            "https://evil.example/x.srt",
            "ftp://dl.opensubtitles.org/x.zip",
            "file:///etc/passwd",
        ):
            self.assertEqual(self._post_status("/api/fetch-sub", {"url": bad}), 400, bad)

    def test_17_fetch_sub_allows_provider_hosts(self):
        # a legitimate provider URL must pass the guard (it then fails on the network,
        # which is a 502 — anything but the 400 the SSRF guard returns)
        status = self._post_status("/api/fetch-sub", {"url": "https://dl.subdl.com/subtitle/none.zip"})
        self.assertIn(status, (502, 200), status)

    def test_18_publish_size_cap(self):
        huge = "1\n00:00:01,000 --> 00:00:02,000\n" + ("x" * (2 * 1024 * 1024 + 4096)) + "\n"
        self.assertEqual(self._post_status("/api/publish-srt", {"text": huge}), 413)

    def test_19_bad_token_is_404_and_published_still_200(self):
        # the route regex is ^[0-9a-f]{16}$, so a malformed token never reaches storage
        try:
            get("/sub/" + "Z" * 16 + ".srt")
            self.fail("non-hex token must be rejected")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 404)
        _, body = post("/api/publish-srt", {"text": SINHALA_SRT})
        status, headers, _ = get(json.loads(body)["url"].replace(BASE, ""))
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")

    def test_20_head_request_on_srt(self):
        _, body = post("/api/publish-srt", {"text": SINHALA_SRT})
        path = json.loads(body)["url"].replace(BASE, "")
        req = urllib.request.Request(BASE + path, method="HEAD")
        with urllib.request.urlopen(req, timeout=5) as r:
            self.assertEqual(r.status, 200)
            self.assertIn("application/x-subrip", r.headers.get("Content-Type", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
