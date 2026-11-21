/* Sinhala Subtitle Bridge v3 — app.js (clean Status & Secret Verification dashboard).
 *
 * Security notes (audited by tests/security.test.js §6):
 *  - No innerHTML / outerHTML / document.write anywhere — every node is built with
 *    createElement + textContent.
 *  - The optional Gemini / SubDL keys are kept ONLY in this browser's localStorage and
 *    sent as request headers to the bridge backend. They are never logged, never
 *    embedded in URLs, and there is no hardcoded key in this file.
 *  - Uploads are validated client-side BEFORE publishing (parseSrtLite below): the
 *    cue count must match and every timestamp line must survive byte-for-byte —
 *    "cue count changed" / "timestamp changed" are hard rejections.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var DEFAULT_MODEL = 'gemini-flash-latest';

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private mode */ } }

  /** Accept the known flash aliases; anything else sane passes through capped. */
  function normalizeModel(raw) {
    var m = String(raw || '').trim();
    if (!m) return DEFAULT_MODEL;
    if (!/^[\w.-]{1,64}$/.test(m)) return DEFAULT_MODEL;
    return m;
  }

  // ── tiny safe-DOM helpers ─────────────────────────────────────────────────
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function kvRow(list, key, value, ok) {
    var dt = el('dt', null, key);
    var dd = el('dd', null, value);
    if (ok === true) dd.classList.add('ok');
    if (ok === false) dd.classList.add('bad');
    list.appendChild(dt); list.appendChild(dd);
  }
  function linkItem(list, label, url) {
    var li = el('li');
    var a = el('a', null, label);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    li.appendChild(a);
    list.appendChild(li);
  }

  // ── tabs ──────────────────────────────────────────────────────────────────
  var panes = { tabStatus: 'statusPane', tabManual: 'manualPane' };
  Object.keys(panes).forEach(function (tabId) {
    $(tabId).addEventListener('click', function () {
      Object.keys(panes).forEach(function (t) {
        $(t).classList.toggle('active', t === tabId);
        $(panes[t]).hidden = t !== tabId;
      });
    });
  });

  // ── worker status card ────────────────────────────────────────────────────
  function loadStatus() {
    fetch('/api/status').then(function (r) { return r.json(); }).then(function (j) {
      var list = $('statusList');
      while (list.firstChild) list.removeChild(list.firstChild);
      if (!j.ok) { $('statusMsg').textContent = 'තත්ත්වය කියවිය නොහැකි විය — worker නොනැවතී / status unavailable'; return; }
      kvRow(list, 'Version', j.version);
      kvRow(list, 'Storage', j.storage === 'kv' ? 'Cloudflare KV (permanent job cache)' : 'Cache API + memory (bind SUBS_KV for permanent jobs)', j.storage === 'kv');
      kvRow(list, 'Gemini secret (GEMINI_API_KEY)', j.secrets.gemini ? 'සකසා ඇත · configured ✓' : 'නොමැත · not set', j.secrets.gemini);
      kvRow(list, 'SubDL secret (SUBDL_API_KEY)', j.secrets.subdl ? 'සකසා ඇත ✓' : 'අවශ්‍ය නම් ෴ · optional', j.secrets.subdl);
      kvRow(list, 'Translation model', j.model);
      kvRow(list, 'Publish cap', (j.limits.maxPublishBytes / 1024 / 1024).toFixed(0) + ' MB');
      $('ver').textContent = 'v' + j.version;
      $('statusMsg').textContent = '';
    }).catch(function () {
      $('statusMsg').textContent = '/api/status ලබා ගැනීමට නොහැකි විය — is the worker deployed?';
    });
  }
  loadStatus();

  // ── quick verification (resolve → subtitles → live progress) ─────────────
  function headers() {
    var h = { 'Content-Type': 'application/json' };
    var gk = lsGet('si-bridge-gemini-key');
    var sk = lsGet('si-bridge-subdl-key');
    if (gk) h['X-Gemini-Key'] = gk;
    if (sk) h['X-SubDL-Key'] = sk;
    var m = normalizeModel(lsGet('si-bridge-model'));
    if (m && m !== DEFAULT_MODEL) h['X-Gemini-Model'] = m;
    return h;
  }

  var pollTimer = null;
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function renderJob(j) {
    $('testOut').hidden = false;
    $('testTitle').textContent = (j.name ? j.name + ' · ' : '') + (j.imdb || '') + (j.cues ? ' · ' + j.cues + ' cues' : '');
    var st = $('testStatus');
    var bar = $('testBar'), fill = $('testFill');
    var links = $('testLinks');
    while (links.firstChild) links.removeChild(links.firstChild);
    if (j.status === 'done') {
      bar.hidden = true;
      st.textContent = j.source === 'human' ? 'මිනිස් සිංහල උපසිරැසි හමු විය ✓ (Human Sinhala found)' : 'Gemini පරිවර්තනය සම්පූර්ණ ✓ (AI translation done)';
      if (j.si && j.si.url) linkItem(links, 'සිංහල .srt (Sinhala)', j.si.url);
      if (j.en && j.en.url) linkItem(links, 'English .srt (paired source)', j.en.url);
      if (j.paired) linkItem(links, '/api/paired cue-lock JSON', j.paired);
    } else if (j.status === 'translating') {
      bar.hidden = false;
      fill.style.width = Math.round((j.progress || 0) * 100) + '%';
      st.textContent = 'පරිවර්තනය සිදු වෙමින් · Translating batch ' + (j.done || 0) + '/' + (j.total || '?')
        + (j.eta_sec ? ' · ETA ~' + j.eta_sec + 's' : '');
    } else {
      bar.hidden = true;
      st.textContent = 'තත්ත්වය: ' + (j.status || '?') + (j.error ? ' — ' + j.error : '');
    }
  }

  function pollJob(path) {
    stopPoll();
    pollTimer = setInterval(function () {
      fetch(path, { headers: headers() }).then(function (r) { return r.json(); }).then(function (j) {
        renderJob(j);
        if (j.status !== 'translating') stopPoll();
      }).catch(function () { stopPoll(); });
    }, 4000);
  }

  $('btnTest').addEventListener('click', function () {
    stopPoll();
    var q = $('qTitle').value.trim();
    var type = $('qType').value === 'tv' ? 'series' : 'movie';
    var season = parseInt($('qSeason').value || '0', 10) || 0;
    var episode = parseInt($('qEpisode').value || '0', 10) || 0;
    if (!q) { $('testMsg').textContent = 'නමක් හෝ IMDb id එකක් ටයිප් කරන්න.'; return; }
    $('testMsg').textContent = 'සොයමින්… · resolving…';
    $('testOut').hidden = true;

    var step = null;
    if (/^tt\d{4,10}$/.test(q)) {
      step = Promise.resolve({ ok: true, imdb: q, name: '', type: type, season: season, episode: episode });
    } else {
      step = fetch('/api/resolve?title=' + encodeURIComponent(q) + '&type=' + type
        + (season ? '&season=' + season : '') + (episode ? '&episode=' + episode : ''))
        .then(function (r) { return r.json(); });
    }
    step.then(function (res) {
      if (!res.ok) { $('testMsg').textContent = 'හමු නොවීය: ' + (res.error || 'no Cinemeta match'); return null; }
      $('testMsg').textContent = '';
      var p = '/subtitles/' + res.type + '/' + res.imdb + '.json?title=' + encodeURIComponent(q)
        + (res.season ? '&season=' + res.season : '') + (res.episode ? '&episode=' + res.episode : '');
      return fetch(p, { headers: headers() }).then(function (r) { return r.json(); }).then(function (j) {
        j.name = j.name || res.name;
        renderJob(j);
        if (j.status === 'translating') pollJob(p);
        if (j.status === 'needs-key') $('testMsg').textContent = 'Gemini secret නොමැත — Manual ටැබ් එකේ key එකක් දාන්න හෝ wrangler secret put GEMINI_API_KEY කරන්න.';
        if (j.status === 'not-found') $('testMsg').textContent = 'මෙම තේමාවට උපසිරැසි නොමැත (no human Sinhala and no English source).';
        return j;
      });
    }).catch(function () {
      $('testMsg').textContent = 'ජාල දෝෂයකි — නැවත උත්සාහ කරන්න.';
    });
  });

  // ── manual tab: optional keys ─────────────────────────────────────────────
  $('optGeminiKey').value = lsGet('si-bridge-gemini-key');
  $('optModel').value = lsGet('si-bridge-model') || DEFAULT_MODEL;
  $('optSubdlKey').value = lsGet('si-bridge-subdl-key');
  $('btnSaveKeys').addEventListener('click', function () {
    lsSet('si-bridge-gemini-key', $('optGeminiKey').value.trim());
    lsSet('si-bridge-model', normalizeModel($('optModel').value));
    lsSet('si-bridge-subdl-key', $('optSubdlKey').value.trim());
    $('keysMsg').textContent = 'සුරැකිණි ✓ (this browser only — request headers from now on)';
    loadStatus();
  });

  // ── client-side SRT validation (the same contract the worker enforces) ────
  var TS = /^(\d+:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{1,3})/;
  function parseSrtLite(text) {
    var cues = [];
    var blocks = String(text).split(/\n\n+/);
    for (var b = 0; b < blocks.length; b++) {
      var lines = blocks[b].split('\n').filter(function (l) { return l.trim() !== ''; });
      if (lines.length < 2) continue;
      var i = 0;
      if (/^\d+$/.test(lines[0].trim())) i = 1;
      if (!lines[i] || !TS.test(lines[i])) continue;
      cues.push({ ts: lines[i], text: lines.slice(i + 1).join('\n') });
    }
    return cues;
  }

  /** Reject an upload whose cues would not survive the round-trip intact. */
  function validateSrtRoundTrip(text) {
    var cues = parseSrtLite(text);
    if (!cues.length) return 'not a subtitle file (no "-->" cues found)';
    var rebuilt = cues.map(function (c, n) { return (n + 1) + '\n' + c.ts + '\n' + c.text; }).join('\n\n') + '\n';
    var again = parseSrtLite(rebuilt);
    if (again.length !== cues.length) return 'cue count changed (' + cues.length + ' → ' + again.length + ') — file rejected';
    for (var i = 0; i < cues.length; i++) {
      if (cues[i].ts !== again[i].ts) return 'timestamp changed at cue ' + (i + 1) + ' — file rejected';
    }
    return null; // valid
  }

  // ── manual tab: publish a local file ──────────────────────────────────────
  $('btnUpload').addEventListener('click', function () {
    var f = $('fileIn').files && $('fileIn').files[0];
    if (!f) { $('uploadMsg').textContent = 'ගොනුවක් තෝරන්න · pick a .srt / .zip / .gz file'; return; }
    $('uploadMsg').textContent = 'කියවමින්… · reading…';
    var fr = new FileReader();
    fr.onerror = function () { $('uploadMsg').textContent = 'ගොනුව කියවීමට නොහැකි විය.'; };
    fr.onload = function () {
      var bytes = new Uint8Array(fr.result);
      var isPlain = /\.(srt|vtt)$/i.test(f.name);
      if (isPlain) {
        // validate BEFORE upload: plain text only
        var text = new TextDecoder('utf-8').decode(bytes);
        var err = validateSrtRoundTrip(text);
        if (err) { $('uploadMsg').textContent = 'වලංගු නොවේ: ' + err; return; }
      }
      $('uploadMsg').textContent = 'ප්‍රකාශය කරමින්… · publishing…';
      fetch('/api/publish-srt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ b64: b64Of(bytes) }),
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j.ok) { $('uploadMsg').textContent = 'ප්‍රකාශය අසාර්ථක: ' + (j.error || '?'); return; }
        $('uploadMsg').textContent = 'ප්‍රකාශය සාර්ථක ✓ · ' + j.cues + ' cues';
        var links = $('uploadLinks');
        while (links.firstChild) links.removeChild(links.firstChild);
        linkItem(links, j.url, j.url);
      }).catch(function (e) {
        $('uploadMsg').textContent = 'ජාලය: ' + e;
      });
    };
    fr.readAsArrayBuffer(f);
  });

  function b64Of(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
})();
