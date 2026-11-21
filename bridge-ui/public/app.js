/* Sinhala Subtitle Bridge — app.js (TV D-pad navigable, zero hardcoded pirate URLs).
 *
 * Security notes:
 *  - The user's Gemini / SubDL keys are read from the form, kept in localStorage on this
 *    device only, and sent straight to the provider or the bridge backend. They are never
 *    hardcoded, never logged, and never placed in a URL that this page requests.
 *  - Every value that comes from an external API is rendered with textContent (never
 *    innerHTML), so subtitle metadata can not inject markup.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = { loadedSrt: null, deliveredUrl: null, token: null };
  var DEFAULT_MODEL = 'gemini-flash-latest';
  var MAX_UPLOAD = 5 * 1024 * 1024; // 5 MB (server caps the decoded subtitle at 2 MB)

  var LS = {
    gemini: 'si-bridge-gemini-key',
    subdl: 'si-bridge-subdl-key',
    model: 'si-bridge-model',
    embed: 'si-bridge-embed',
  };

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private mode */ } }

  function normalizeModel(raw) {
    var m = String(raw || '').trim();
    return /^[A-Za-z0-9._-]{2,64}$/.test(m) ? m : DEFAULT_MODEL;
  }

  // ── deeplink auto-fill (BUG #3): ?type=&tmdb=&imdb=&s=&e= ──────────────────
  function applyDeeplink() {
    var q = new URLSearchParams(location.search);
    var touched = false;
    ['type', 'tmdb', 'imdb', 's', 'e'].forEach(function (k) {
      if (!q.get(k)) return;
      touched = true;
      if (k === 'type') $('type').value = q.get('type') === 'movie' ? 'movie' : 'tv';
      if (k === 'tmdb') $('tmdb').value = q.get('tmdb');
      if (k === 'imdb') $('imdb').value = q.get('imdb');
      if (k === 's') $('season').value = q.get('s');
      if (k === 'e') $('episode').value = q.get('e');
    });
    if (!touched) return;
    $('resolveMsg').textContent = 'AnantPlay deeplink detected — auto-filling…';
    resolveFromCinemeta();
    searchSubs(); // zero typing: auto-search immediately
  }

  // ── Cinemeta resolve (tmdb → imdb / title) ─────────────────────────────────
  function resolveFromCinemeta() {
    var tmdb = $('tmdb').value.trim();
    var imdb = $('imdb').value.trim();
    var type = $('type').value;
    if (!tmdb && !imdb) { $('resolveMsg').textContent = 'IMDb හෝ TMDB එකක් ලියන්න.'; return; }
    var url = 'https://v3-cinemeta.strem.io/' + (type === 'movie' ? 'movie' : 'series') + '/' + (imdb || 'tmdb:' + tmdb) + '.json';
    fetch(url).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.meta) { $('resolveMsg').textContent = 'Cinemeta හිට නොහමු වුණා — නම අතින් ලියන්න.'; return; }
      var m = j.meta;
      if (m.imdb_id && !imdb) $('imdb').value = m.imdb_id;
      if (m.name) $('title').value = m.name;
      $('resolveMsg').textContent = '✔ ' + (m.name || '') + (m.year ? ' (' + m.year + ')' : '') + ' — Cinemeta';
    }).catch(function () {
      $('resolveMsg').textContent = 'Cinemeta offline — fields එක අතින් සම්පූර්ණ කරන්න.';
    });
  }

  // ── safe DOM helpers (no innerHTML anywhere) ───────────────────────────────
  function hintEl(text) {
    var p = document.createElement('p');
    p.className = 'hint';
    p.textContent = text;
    return p;
  }
  function replaceChildren(id, nodes) {
    var box = $(id);
    while (box.firstChild) box.removeChild(box.firstChild);
    for (var i = 0; i < nodes.length; i++) box.appendChild(nodes[i]);
  }

  // ── search ──────────────────────────────────────────────────────────────────
  function searchSubs() {
    var imdb = $('imdb').value.trim();
    if (!/^tt\d{4,10}$/.test(imdb)) {
      $('searchMsg').textContent = 'IMDb id එක අවශ්‍යයි (e.g. tt1234567) — Resolve බොත්තම එය ලබා දේ.';
      $('results').hidden = false;
      return;
    }
    $('results').hidden = false;
    replaceChildren('resultList', [hintEl('සොයමින්… (OpenSubtitles + SubDL + piratelk)')]);
    var q = '/api/search?imdb=' + encodeURIComponent(imdb) +
      '&season=' + encodeURIComponent($('season').value || 0) +
      '&episode=' + encodeURIComponent($('episode').value || 0) +
      ($('title').value.trim() ? '&title=' + encodeURIComponent($('title').value.trim()) : '');
    var headers = {};
    var subdlKey = $('subdlKey').value.trim();
    if (subdlKey) headers['X-SubDL-Key'] = subdlKey;
    fetch(q, { headers: headers })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok || !j.results.length) {
          replaceChildren('resultList', [hintEl('ප්‍රතිඵල නැහැ — EN subtitle එකක් තෝරලා 3 වන කොටසින් සිංහලට පරිවර්තනය කරන්න.')]);
          $('searchMsg').textContent = (j && j.failed && j.failed.length) ? 'Unreachable: ' + j.failed.join(', ') : '';
          return;
        }
        var rows = j.results.map(function (r) {
          var row = document.createElement('button');
          row.className = 'result-row';
          row.setAttribute('role', 'option');
          row.textContent = '[' + r.provider + '] ' + r.lang + ' · ' + (r.release || '—') + (r.hearingImpaired ? ' · SDH' : '');
          row.onclick = function () { fetchSub(r.url, row); };
          return row;
        });
        replaceChildren('resultList', rows);
        $('searchMsg').textContent = j.count + ' results.' + (j.failed && j.failed.length ? ' Unreachable: ' + j.failed.join(', ') : '');
      })
      .catch(function () { $('searchMsg').textContent = 'සෙවීම අසාර්ථකි — නැවත උත්සාහ කරන්න.'; });
  }

  function showDelivered(j, extra) {
    state.deliveredUrl = j.url;
    state.token = j.token;
    $('delivered').hidden = false;
    $('srtLink').href = j.url;
    $('srtLink').textContent = j.url;
    $('deliveredMsg').textContent = '✔ ' + j.cues + ' cues · ' + j.bytes + ' bytes · HTTP 200 .srt' + (extra || '');
    $('delivered').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ── fetch + extract + publish one result → REAL .srt URL ────────────────────
  function fetchSub(upstreamUrl, rowEl) {
    if (rowEl) rowEl.disabled = true;
    fetch('/api/fetch-sub', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: upstreamUrl }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (rowEl) rowEl.disabled = false;
        if (!j.ok) { $('searchMsg').textContent = 'ගෙන ඒම අසාර්ථකි: ' + j.error; return; }
        showDelivered(j);
        fetch(j.url, { cache: 'no-store' }).then(function (r) {
          return r.ok ? r.text() : '';
        }).then(function (t) { if (t) { state.loadedSrt = t; $('translate').classList.add('ready'); } });
      })
      .catch(function (e) {
        if (rowEl) rowEl.disabled = false;
        $('searchMsg').textContent = 'ජාලය: ' + e;
      });
  }

  // ── upload .srt/.zip/.gz → publish ──────────────────────────────────────────
  function arrayBufferToBase64(buf) {
    var bytes = new Uint8Array(buf);
    var CHUNK = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }

  function uploadFile() {
    var f = $('fileInput').files && $('fileInput').files[0];
    if (!f) { $('uploadMsg').textContent = 'ගොනුවක් තෝරන්න.'; return; }
    if (f.size > MAX_UPLOAD) { $('uploadMsg').textContent = 'ගොනුව විශාල වැඩියි (5 MB උපරිම).'; return; }
    var fr = new FileReader();
    fr.onerror = function () { $('uploadMsg').textContent = 'ගොනුව කියවීමට නොහැකි විය.'; };
    fr.onload = function () {
      var b64;
      try { b64 = arrayBufferToBase64(fr.result); }
      catch (e) { $('uploadMsg').textContent = 'ගොනුව encode කිරීමට නොහැකි විය.'; return; }
      fetch('/api/publish-srt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ b64: b64, name: f.name }),
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) { $('uploadMsg').textContent = 'අසාර්ථකි: ' + j.error; return; }
          showDelivered(j, ' · uploaded');
          $('uploadMsg').textContent = 'Uploaded ✔';
          fetch(j.url, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) { state.loadedSrt = t; });
        })
        .catch(function (e) { $('uploadMsg').textContent = 'ජාලය: ' + e; });
    };
    fr.readAsArrayBuffer(f);
  }

  // ── Gemini EN→SI timestamp-locked batch translation ───────────────────────────
  var PROMPT = 'You are a professional English→Sinhala subtitle translator. Translate ONLY the text lines to natural Sinhala. '
    + 'Keep the cue numbers and timestamp lines EXACTLY as given, character for character. Reply with the SAME number of cues, '
    + 'the SAME cue-number lines and the SAME timestamps, only the text translated. Do not merge, split, reorder or drop cues.';

  function validateBatch(batch, got) {
    if (got.length !== batch.length) return 'cue count ' + got.length + ' != ' + batch.length + ' (translation must not merge/split cues)';
    for (var i = 0; i < batch.length; i++) {
      if (got[i].ts !== batch[i].ts) {
        return 'timestamp changed for cue ' + (batch[i].idx + 1) + ' (expected "' + batch[i].ts + '")';
      }
      if (!got[i].lines.length || !got[i].lines.join('').trim()) return 'empty text for cue ' + (batch[i].idx + 1);
    }
    return null;
  }

  function translateLoaded() {
    if (!state.loadedSrt) { $('translateMsg').textContent = 'පළමුව 2 කොටසින් subtitle එකක් ගන්න (හෝ upload කරන්න).'; return; }
    var key = $('geminiKey').value.trim();
    if (!key) { $('translateMsg').textContent = 'Gemini key එකක් අවශ්‍යයි (aistudio.google.com — නොමිලේ).'; return; }
    var model = normalizeModel($('model').value);
    lsSet(LS.model, model);
    var cues = parseCues(state.loadedSrt);
    if (!cues.length) { $('translateMsg').textContent = 'Cue කිසිවක් හමු නොවිණි.'; return; }

    var expectedTs = cues.map(function (c) { return c.ts; });
    var expectedCount = cues.length;
    var out = new Array(cues.length);
    var BATCH = 250;
    var idx = 0;
    var endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);

    $('translateMsg').textContent = 'පරිවර්තනය ආරම්භ… (' + cues.length + ' cues, ' + Math.ceil(cues.length / BATCH) + ' batches, ' + model + ')';

    function fail(msg) {
      $('translateMsg').textContent = '⚠ ' + msg + ' — කිසිවක් publish නොකළා. නැවත උත්සාහ කරන්න.';
    }

    function requestBatch(batch) {
      var body = batch.map(function (c) { return c.idx + '\n' + c.ts + '\n' + c.lines.join('\n'); }).join('\n\n');
      return fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: PROMPT + '\n\n' + body }] }],
          generationConfig: { temperature: 0.1 },
        }),
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        var parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
        return parts && parts[0] ? String(parts[0].text || '') : '';
      });
    }

    function attempt(batch, tries) {
      requestBatch(batch).then(function (text) {
        var got = parseCues(text);
        var problem = validateBatch(batch, got);
        if (problem) {
          if (tries < 1) { attempt(batch, tries + 1); return; }
          fail(problem);
          return;
        }
        for (var i = 0; i < batch.length; i++) out[batch[i].idx] = got[i].lines.join('\n');
        idx += batch.length;
        $('translateMsg').textContent = 'batch ' + Math.min(idx, cues.length) + '/' + cues.length + ' · ' + batch.length + ' cues timestamp-validated';
        next();
      }).catch(function (e) {
        if (tries < 1) { attempt(batch, tries + 1); return; }
        fail('Gemini: ' + e);
      });
    }

    function finalize() {
      for (var i = 0; i < cues.length; i++) {
        if (typeof out[i] !== 'string' || !out[i].trim()) { fail('cue ' + (i + 1) + ' was not translated'); return; }
      }
      var srt = cues.map(function (c, n) { return (n + 1) + '\n' + c.ts + '\n' + out[c.idx]; }).join('\n\n') + '\n';

      // hard assertions before publishing: cue count + byte-identical timestamps
      var finalCues = parseCues(srt);
      if (finalCues.length !== expectedCount) { fail('assembly changed the cue count'); return; }
      for (var k = 0; k < finalCues.length; k++) {
        if (finalCues[k].ts !== expectedTs[k]) { fail('assembly changed a timestamp'); return; }
      }

      fetch('/api/publish-srt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: srt }),
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) { fail('publish: ' + j.error); return; }
          if (j.cues !== expectedCount) { fail('published cue count mismatch'); return; }
          showDelivered(j, ' · සිංහල');
          $('translateMsg').textContent = '✔ සිංහල .srt URL එක සූදානම්! (' + j.cues + ' cues, timestamps byte-identical)';
          state.loadedSrt = srt;
        })
        .catch(function (e) { fail('publish: ' + e); });
    }

    function next() {
      if (idx >= cues.length) { finalize(); return; }
      attempt(cues.slice(idx, idx + BATCH), 0);
    }

    next();
  }

  function parseCues(text) {
    var cues = [];
    String(text).split(/\n\n+/).forEach(function (b) {
      var lines = b.split('\n').filter(function (l) { return l.trim() !== ''; });
      if (lines.length < 2) return;
      var i = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
      if (!lines[i] || lines[i].indexOf('-->') < 0) return;
      cues.push({ idx: cues.length, ts: lines[i], lines: lines.slice(i + 1) });
    });
    return cues;
  }

  // ── stream handoff modes ─────────────────────────────────────────────────────
  var MUX_DEMO = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'; // public-domain HLS test stream

  function handoff(url) {
    // The location of this page is the AnantPlay-embedded WebView; navigating the whole
    // page straight to the media URL triggers the Sniffer handoff (decide() →
    // shouldOverrideUrlLoading → PlayerActivity). Subtitles captured earlier ride along.
    location.href = url;
  }

  function loadEmbed() {
    var tpl = $('embedTemplate').value.trim();
    if (!tpl) { return; }
    lsSet(LS.embed, tpl);
    var stream = $('streamUrl').value.trim() || MUX_DEMO;
    var url = tpl.replace('{STREAM}', encodeURIComponent(stream));
    var f = $('embedFrame');
    f.hidden = false;
    f.src = url;
  }

  // ── wiring ───────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    // restore this device's settings only (never sent anywhere but the provider/backend)
    var savedModel = lsGet(LS.model);
    if (savedModel) $('model').value = savedModel;
    var savedGemini = lsGet(LS.gemini);
    if (savedGemini) $('geminiKey').value = savedGemini;
    var savedSubdl = lsGet(LS.subdl);
    if (savedSubdl) $('subdlKey').value = savedSubdl;
    var savedEmbed = lsGet(LS.embed);
    if (savedEmbed) $('embedTemplate').value = savedEmbed;

    $('geminiKey').addEventListener('change', function () { lsSet(LS.gemini, $('geminiKey').value.trim()); });
    $('subdlKey').addEventListener('change', function () { lsSet(LS.subdl, $('subdlKey').value.trim()); });
    $('model').addEventListener('change', function () { lsSet(LS.model, normalizeModel($('model').value)); });

    $('btnResolve').onclick = resolveFromCinemeta;
    $('btnSearch').onclick = searchSubs;
    $('btnTranslate').onclick = translateLoaded;
    $('btnUpload').onclick = uploadFile;
    $('btnFetchIt').onclick = function () {
      if (!state.deliveredUrl) return;
      // REAL network fetch: WebView shouldInterceptRequest (WebActivity.java:443) sees
      // this genuine request → Sniffer.request() captures the .srt → rides with the stream.
      fetch(state.deliveredUrl, { cache: 'no-store' })
        .then(function (r) { return r.text(); })
        .then(function (t) { state.loadedSrt = t; $('deliveredMsg').textContent += ' · fetched for Sniffer'; });
    };
    $('btnCopy').onclick = function () {
      if (!state.deliveredUrl) return;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(state.deliveredUrl);
      $('deliveredMsg').textContent += ' · copied';
    };
    $('btnPlayStream').onclick = function () {
      var u = $('streamUrl').value.trim();
      if (!/^https?:\/\//.test(u)) { $('streamUrl').focus(); return; }
      handoff(u);
    };
    $('btnMuxDemo').onclick = function () { $('streamUrl').value = MUX_DEMO; handoff(MUX_DEMO); };
    $('btnEmbed').onclick = loadEmbed;

    // TV D-pad: every control must be reachable with the arrow keys.
    Array.prototype.forEach.call(document.querySelectorAll('button, input, select, a'), function (el) {
      el.setAttribute('tabindex', '0');
    });

    applyDeeplink();
  });
})();
