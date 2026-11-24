/* Stem Review — local listening app. No dependencies. */
'use strict';

const COLORS = ['#7c9cff', '#3ecf8e', '#ffb454', '#ff6b9a', '#5ad1e6', '#c792ea', '#f78c6c',
  '#a3e635', '#f472b6', '#60a5fa', '#facc15', '#34d399', '#fb7185', '#a78bfa', '#2dd4bf'];
const MIX_COLOR = '#e8eaf0';
const QUICK_TAGS = ['clean separation', 'bleed between stems', 'missing part', 'silent stem',
  'clipping / distortion', 'level mismatch vs mix', 'timing offset', 'artifacts / noise'];

const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4.2" height="16" rx="1.2"/><rect x="13.8" y="4" width="4.2" height="16" rx="1.2"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0 4-7a2.5 2.5 0 0 1 3 2.6L13.4 9H19a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 17.7 21H7"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3zm0 0-4 7a2.5 2.5 0 0 1-3-2.6l.6-3.4H5a2 2 0 0 1-2-2.3l1.3-8A2 2 0 0 1 6.3 3H17"/></svg>',
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (t) => { if (!isFinite(t) || t < 0) t = 0; const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`; };
const fmtShort = (t) => { if (!t) return '–'; const m = Math.floor(t / 60), s = Math.round(t - m * 60); return `${m}:${String(s).padStart(2, '0')}`; };
const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) + ' dB' : '-∞');

const S = { songs: [], reviews: {}, filter: 'all', q: '', player: null, view: null };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1400);
}

/* ============================================================== API */
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}
async function saveReview(id, review) {
  S.reviews[id] = review;
  renderProgress();
  return api(`/api/reviews/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(review) });
}
const reviewOf = (id) => S.reviews[id] || { comment: '', verdict: '' };

function renderProgress() {
  const n = S.songs.length;
  const a = S.songs.filter((s) => reviewOf(s.id).verdict === 'approve').length;
  const r = S.songs.filter((s) => reviewOf(s.id).verdict === 'reject').length;
  $('#progress').innerHTML = `<span><b style="color:var(--text)">${a + r}</b> / ${n} reviewed</span>
    <span class="bar"><i style="width:${(a / n) * 100}%;background:var(--approve)"></i><i style="width:${(r / n) * 100}%;background:var(--reject)"></i></span>`;
}

/* ============================================================== audio engine */
let CTX = null;
function ctx() {
  if (!CTX) {
    try { CTX = new AudioContext({ sampleRate: 44100, latencyHint: 'interactive' }); }
    catch (e) { CTX = new AudioContext(); }
  }
  return CTX;
}

async function fetchBuffer(url, signal, onProgress) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(r.status);
  const total = +r.headers.get('Content-Length');
  if (!total || !r.body) return r.arrayBuffer();
  const out = new Uint8Array(total);
  const reader = r.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got); got += value.length;
    onProgress(got / total);
  }
  return out.buffer;
}

function computePeaks(buf, n = 1600) {
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const len = buf.length, step = len / n, peaks = new Float32Array(n);
  let max = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step), b = Math.min(len, Math.floor((i + 1) * step));
    let p = 0;
    for (const ch of chans) for (let j = a; j < b; j += 2) { const v = Math.abs(ch[j]); if (v > p) p = v; }
    peaks[i] = p; if (p > max) max = p;
  }
  // rms on a stride for speed
  const ch0 = chans[0]; let cnt = 0;
  for (let j = 0; j < len; j += 64) { sumSq += ch0[j] * ch0[j]; cnt++; }
  return { peaks, max, rms: Math.sqrt(sumSq / Math.max(1, cnt)) };
}

class Player {
  constructor(song, onChange) {
    this.song = song;
    this.onChange = onChange;
    this.abort = new AbortController();
    this.master = ctx().createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx().destination);
    this.playing = false;
    this.offset = 0;
    this.t0 = 0;
    this.focus = 'mix'; // 'mix' | 'stems' | <stem index>
    this.tracks = [];
    if (song.mix_url) this.tracks.push(this.makeTrack('mix', 'Full mix', song.mix_url, MIX_COLOR));
    song.stems.forEach((s, i) => this.tracks.push(this.makeTrack(i, s.label, s.url, COLORS[i % COLORS.length], s.file)));
    if (!song.mix_url) this.focus = 'stems';
    this.load();
  }

  makeTrack(key, label, url, color, file) {
    const gain = ctx().createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    return { key, label, url, color, file, gain, vol: 1, mute: false, solo: false,
      buffer: null, src: null, state: 'loading', progress: 0, peaks: null };
  }

  get stems() { return this.tracks.filter((t) => t.key !== 'mix'); }
  get mix() { return this.tracks.find((t) => t.key === 'mix'); }
  get duration() {
    const d = Math.max(0, ...this.tracks.map((t) => (t.buffer ? t.buffer.duration : 0)));
    return d || this.song.duration || 0;
  }
  get loadedFraction() { return this.tracks.reduce((a, t) => a + (t.state === 'loading' ? t.progress : 1), 0) / this.tracks.length; }

  async load() {
    const queue = [...this.tracks];
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift();
        try {
          const ab = await fetchBuffer(t.url, this.abort.signal, (p) => { t.progress = p * 0.9; this.onChange('progress', t); });
          if (this.abort.signal.aborted) return;
          t.buffer = await ctx().decodeAudioData(ab);
          if (this.abort.signal.aborted) { t.buffer = null; return; }
          Object.assign(t, computePeaks(t.buffer));
          t.state = 'ready'; t.progress = 1;
          if (this.playing) this.startTrack(t, ctx().currentTime + 0.03);
          this.applyGains(true);
        } catch (e) {
          if (this.abort.signal.aborted) return;
          console.error(t.url, e); t.state = 'error';
        }
        this.onChange('loaded', t);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  time() {
    if (!this.playing) return this.offset;
    return Math.min(this.duration, this.offset + Math.max(0, ctx().currentTime - this.t0));
  }

  audible(t) {
    if (this.focus === 'mix') return t.key === 'mix';
    if (this.focus === 'stems') {
      if (t.key === 'mix') return false;
      const anySolo = this.stems.some((s) => s.solo);
      return anySolo ? t.solo : !t.mute;
    }
    return t.key === this.focus;
  }

  applyGains(instant) {
    const now = ctx().currentTime;
    for (const t of this.tracks) {
      const target = this.audible(t) ? t.vol : 0;
      t.gain.gain.cancelScheduledValues(now);
      if (instant) t.gain.gain.setValueAtTime(target, now);
      else t.gain.gain.setTargetAtTime(target, now, 0.006); // ~20ms click-free switch
    }
  }

  startTrack(t, when) {
    if (!t.buffer) return;
    const off = this.offset + (when - this.t0);
    if (off >= t.buffer.duration) return;
    const src = ctx().createBufferSource();
    src.buffer = t.buffer;
    src.connect(t.gain);
    src.start(when, Math.max(0, off));
    t.src = src;
  }

  stopAll() {
    for (const t of this.tracks) if (t.src) { try { t.src.stop(); } catch (e) {} t.src.disconnect(); t.src = null; }
  }

  async play() {
    if (this.playing) return;
    await ctx().resume();
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    this.applyGains(true);
    const when = ctx().currentTime + 0.04;
    this.t0 = when;
    for (const t of this.tracks) this.startTrack(t, when);
    this.playing = true;
    this.onChange('state');
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.time();
    this.stopAll();
    this.playing = false;
    this.onChange('state');
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    t = Math.max(0, Math.min(this.duration, t));
    if (this.playing) { this.stopAll(); this.playing = false; this.offset = t; this.play(); }
    else { this.offset = t; this.onChange('tick'); }
  }

  setFocus(f) { this.focus = f; this.applyGains(); this.onChange('focus'); }

  destroy() {
    this.abort.abort();
    this.stopAll();
    this.playing = false;
    for (const t of this.tracks) { t.gain.disconnect(); t.buffer = null; t.peaks = null; }
    this.master.disconnect();
  }
}

/* ============================================================== waveform drawing */
function drawWave(canvas, track, ratio, color) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--wave-bg').trim();
  g.fillStyle = bg; g.fillRect(0, h / 2 - 0.5, w, 1);
  if (!track.peaks) return;
  const { peaks, max } = track;
  const norm = max > 0 ? 1 / max : 0; // normalise per track so quiet stems stay readable
  const bar = 2, gap = 1, cols = Math.floor((w * ratio) / (bar + gap));
  g.fillStyle = color;
  for (let i = 0; i < cols; i++) {
    const a = Math.floor((i / cols) * peaks.length), b = Math.max(a + 1, Math.floor(((i + 1) / cols) * peaks.length));
    let p = 0; for (let j = a; j < b; j++) if (peaks[j] > p) p = peaks[j];
    const v = Math.max(1, Math.sqrt(p * norm) * (h / 2 - 2));
    g.fillRect(i * (bar + gap), h / 2 - v, bar, v * 2);
  }
}

/* ============================================================== grid view */
function viewGrid() {
  S.view = 'grid';
  const counts = { all: S.songs.length, pending: 0, approve: 0, reject: 0 };
  for (const s of S.songs) { const v = reviewOf(s.id).verdict; counts[v || 'pending']++; }
  const chip = (k, l) => `<button class="chip ${S.filter === k ? 'on' : ''}" data-f="${k}">${l}<b>${counts[k]}</b></button>`;
  $('#app').innerHTML = `
    <div class="grid-head">
      <h1>Listening queue</h1>
      <div class="chips">${chip('all', 'All')}${chip('pending', 'To review')}${chip('approve', 'Approved')}${chip('reject', 'Rejected')}</div>
      <input class="search" id="q" placeholder="Search ID, title, category…" value="${esc(S.q)}">
    </div>
    <div class="cards" id="cards"></div>`;
  $('#app').querySelectorAll('.chip').forEach((b) => b.onclick = () => { S.filter = b.dataset.f; viewGrid(); });
  const q = $('#q');
  q.oninput = () => { S.q = q.value; renderCards(); };
  renderCards();
}

function filteredSongs() {
  const q = S.q.trim().toLowerCase();
  return S.songs.filter((s) => {
    const v = reviewOf(s.id).verdict;
    if (S.filter === 'pending' && v) return false;
    if (S.filter !== 'all' && S.filter !== 'pending' && v !== S.filter) return false;
    if (q && !`${s.id} ${s.title} ${s.category}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderCards() {
  const list = filteredSongs();
  const el = $('#cards');
  if (!list.length) { el.innerHTML = `<div class="empty">Nothing here.</div>`; return; }
  el.innerHTML = list.map((s) => {
    const r = reviewOf(s.id);
    const badge = r.verdict === 'approve' ? `<span class="badge approve">✓ Approved</span>`
      : r.verdict === 'reject' ? `<span class="badge reject">✕ Rejected</span>` : `<span class="badge">To review</span>`;
    const warn = s.check === 'AUDIO_REVIEW_REQUIRED' ? `<span class="tag warn" title="Full-mix level warning in manifest">level warning</span>` : '';
    return `<a class="card ${r.verdict}" href="#/song/${s.id}">
      <div class="card-top"><span class="card-id">${s.id}</span>${badge}</div>
      <div class="card-title ${s.has_title ? '' : 'untitled'}">${esc(s.has_title ? s.title : 'Untitled · LMMS 1.2.2 batch')}</div>
      <div class="card-meta">${s.category ? `<span class="tag">${esc(s.category)}</span>` : ''}
        <span class="tag">${s.stems.length} stem${s.stems.length === 1 ? '' : 's'}</span>
        <span class="tag mono">${fmtShort(s.duration)}</span>${warn}</div>
      ${r.comment.trim() ? `<div class="card-comment">${esc(r.comment)}</div>` : ''}
      <div class="stem-bars">${s.stems.map((_, i) => `<i style="background:${COLORS[i % COLORS.length]}"></i>`).join('')}</div>
    </a>`;
  }).join('');
}

/* ============================================================== detail view */
function viewSong(id) {
  const idx = S.songs.findIndex((s) => s.id === id);
  if (idx < 0) { location.hash = '#/'; return; }
  const song = S.songs[idx];
  S.view = 'song';
  const prev = S.songs[(idx - 1 + S.songs.length) % S.songs.length];
  const next = S.songs[(idx + 1) % S.songs.length];
  const review = { ...reviewOf(id) };

  const p = new Player(song, (what, t) => onPlayerChange(what, t));
  S.player = p;

  const tags = [
    song.category && `<span class="tag">${esc(song.category)}</span>`,
    `<span class="tag">${song.stems.length} stem${song.stems.length === 1 ? '' : 's'}</span>`,
    song.renderer && `<span class="tag mono">LMMS ${esc(song.renderer)}</span>`,
    song.check && `<span class="tag ${song.check === 'AUDIO_REVIEW_REQUIRED' ? 'warn' : ''} mono">${esc(song.check)}</span>`,
  ].filter(Boolean).join('');

  const trackRow = (t, i) => {
    const isMix = t.key === 'mix';
    return `<div class="track ${isMix ? 'mixrow' : ''}" data-i="${i}">
      <span class="key">${isMix ? 'M' : (t.key < 9 ? t.key + 1 : '')}</span>
      <div class="name"><span class="dot" style="background:${t.color}"></span>
        <div><span class="label" title="${esc(t.file || t.label)}">${esc(t.label)}</span><span class="sub" data-sub>loading…</span></div></div>
      <button class="ibtn play" data-act="play" title="${isMix ? 'Play full mix' : 'Play this stem alone'}">${ICON.play}</button>
      ${isMix ? '<span></span><span></span>' : `<button class="ibtn m" data-act="mute" title="Mute in 'All stems'">M</button>
      <button class="ibtn s" data-act="solo" title="Solo in 'All stems'">S</button>`}
      <div class="wave" data-wave><canvas class="base"></canvas><div class="played"><canvas class="hi"></canvas></div>
        <div class="hover"></div><div class="tip"></div><div class="head"></div>
        <div class="loading"><span>Loading</span><i></i></div></div>
      <div class="vol"><input type="range" min="0" max="1.5" step="0.01" value="1" data-act="vol" title="Track volume"></div>
    </div>`;
  };

  $('#app').innerHTML = `
    <div class="crumbs"><a href="#/">← All songs</a><span>/</span><span class="mono">${song.id}</span>
      <span class="sp"></span>
      <a class="btn ghost" href="#/song/${prev.id}" title="Previous  [">‹ ${prev.id}</a>
      <a class="btn ghost" href="#/song/${next.id}" title="Next  ]">${next.id} ›</a></div>
    <div class="song-head"><span class="id">${song.id}</span><span class="title">${esc(song.has_title ? song.title : 'Untitled')}</span></div>
    <div class="song-tags">${tags}</div>
    <div class="detail">
      <section>
        <div class="panel transport">
          <button class="play-big" id="playBtn" title="Play / pause (Space)">${ICON.play}</button>
          <div class="time mono" id="time">0:00.0 <span>/ ${fmt(song.duration)}</span></div>
          <div class="seg" id="seg">
            ${song.mix_url ? `<button data-focus="mix">Full mix <kbd>M</kbd></button>` : ''}
            <button data-focus="stems">All stems <kbd>A</kbd></button>
          </div>
          <div class="now" id="now"></div>
          <label class="master">Vol <input type="range" id="masterVol" min="0" max="1.2" step="0.01" value="0.9" style="width:90px"></label>
          <div class="loadbar" id="loadbar"><i style="width:0%"></i></div>
        </div>
        <div class="panel tracks" id="tracks">${p.tracks.map(trackRow).join('')}</div>
        <div class="hints">
          <span><kbd>Space</kbd> play/pause</span><span><kbd>M</kbd> full mix</span><span><kbd>A</kbd> all stems</span>
          <span><kbd>1</kbd>–<kbd>9</kbd> solo stem</span><span><kbd>←</kbd><kbd>→</kbd> ±5s</span>
          <span><kbd>Y</kbd> approve</span><span><kbd>N</kbd> reject</span><span><kbd>C</kbd> write note</span><span><kbd>[</kbd><kbd>]</kbd> prev/next</span>
        </div>
      </section>
      <aside class="panel review">
        <h3>Verdict</h3>
        <div class="verdict">
          <button class="vbtn approve" data-v="approve">${ICON.up}Approve<small>Y</small></button>
          <button class="vbtn reject" data-v="reject">${ICON.down}Reject<small>N</small></button>
        </div>
        <h3>Notes</h3>
        <textarea class="notes" id="notes" placeholder="What do you hear? Bleed, missing parts, artifacts, timing… (press C to focus, Esc to leave)">${esc(review.comment)}</textarea>
        <div class="quick">${QUICK_TAGS.map((q) => `<button data-q="${esc(q)}">+ ${esc(q)}</button>`).join('')}</div>
        <div class="saved" id="saved">${review.comment || review.verdict ? 'Saved in reviews.csv' : 'Autosaves to reviews.csv'}</div>
        <div class="review-nav">
          <a class="btn" href="#/song/${prev.id}">‹ Prev</a>
          <a class="btn primary" href="#/song/${next.id}" id="nextBtn">Next song ›</a>
        </div>
        <div class="stats" id="stats"></div>
      </aside>
    </div>`;

  /* --- wiring: tracks */
  const rows = [...document.querySelectorAll('#tracks .track')];
  rows.forEach((row, i) => {
    const t = p.tracks[i];
    t.row = row;
    t.wave = $('[data-wave]', row);
    t.played = $('.played', row);
    t.head = $('.head', row);
    row.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'play') {
        if (p.focus === t.key && p.playing) p.pause();
        else { p.setFocus(t.key); p.play(); }
      } else if (act === 'mute') { t.mute = !t.mute; p.setFocus('stems'); }
      else if (act === 'solo') { t.solo = !t.solo; p.setFocus('stems'); }
    });
    $('[data-act=vol]', row).oninput = (e) => { t.vol = +e.target.value; p.applyGains(); };
    $('[data-act=vol]', row).ondblclick = (e) => { e.target.value = 1; t.vol = 1; p.applyGains(); };
    const wave = t.wave, hover = $('.hover', row), tip = $('.tip', row);
    wave.addEventListener('mousemove', (e) => {
      const r = wave.getBoundingClientRect(), x = e.clientX - r.left;
      hover.style.left = x + 'px'; tip.style.left = Math.max(22, Math.min(r.width - 22, x)) + 'px';
      tip.textContent = fmt((x / r.width) * p.duration);
    });
    wave.addEventListener('click', (e) => {
      const r = wave.getBoundingClientRect();
      p.seek(((e.clientX - r.left) / r.width) * p.duration);
    });
  });

  $('#playBtn').onclick = () => p.toggle();
  $('#seg').querySelectorAll('button').forEach((b) => b.onclick = () => {
    p.setFocus(b.dataset.focus); if (!p.playing) p.play();
  });
  $('#masterVol').oninput = (e) => { p.master.gain.setTargetAtTime(+e.target.value, ctx().currentTime, 0.01); };

  /* --- wiring: review */
  const notes = $('#notes'), saved = $('#saved');
  let saveTimer = null;
  const persist = async () => {
    clearTimeout(saveTimer); saveTimer = null;
    saved.className = 'saved'; saved.textContent = 'Saving…';
    try {
      await saveReview(id, { ...review });
      saved.className = 'saved ok';
      saved.textContent = `✓ Saved to reviews.csv · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    } catch (e) { saved.className = 'saved err'; saved.textContent = 'Could not save — is server.py running?'; }
  };
  S.flushReview = () => { if (saveTimer) persist(); };
  notes.oninput = () => {
    review.comment = notes.value;
    saved.className = 'saved'; saved.textContent = 'Typing…';
    clearTimeout(saveTimer); saveTimer = setTimeout(persist, 600);
  };
  notes.onblur = () => S.flushReview();
  const paintVerdict = () => document.querySelectorAll('.vbtn').forEach((b) => b.classList.toggle('on', b.dataset.v === review.verdict));
  S.setVerdict = (v) => {
    review.verdict = review.verdict === v ? '' : v;
    paintVerdict(); persist();
    if (review.verdict) toast(review.verdict === 'approve' ? '👍 Approved' : '👎 Rejected');
  };
  document.querySelectorAll('.vbtn').forEach((b) => b.onclick = () => S.setVerdict(b.dataset.v));
  paintVerdict();
  document.querySelectorAll('.quick button').forEach((b) => b.onclick = () => {
    const tag = b.dataset.q;
    const v = notes.value.replace(/\s+$/, '');
    notes.value = v ? `${v}\n- ${tag}` : `- ${tag}`;
    notes.dispatchEvent(new Event('input')); notes.focus();
    notes.selectionStart = notes.selectionEnd = notes.value.length;
  });

  const stats = [['Duration', fmt(song.duration)], ['Stems', song.stems.length]];
  if (song.peak != null) stats.push(['Mix peak', db(song.peak)], ['Mix RMS', db(song.rms)]);
  $('#stats').innerHTML = stats.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');

  /* --- resize → redraw */
  S.ro = new ResizeObserver(() => p.tracks.forEach(drawTrack));
  S.ro.observe($('#tracks'));
  paintFocus();
  startTicker();
}

function drawTrack(t) {
  const p = S.player; if (!p || !t.wave) return;
  const w = t.wave.clientWidth;
  t.wave.style.setProperty('--full-w', w + 'px');
  const ratio = t.buffer && p.duration ? t.buffer.duration / p.duration : 1;
  const dim = getComputedStyle(document.documentElement).getPropertyValue('--faint').trim();
  drawWave($('canvas.base', t.wave), t, ratio, dim);
  drawWave($('canvas.hi', t.wave), t, ratio, t.color);
}

function paintFocus() {
  const p = S.player; if (!p) return;
  document.querySelectorAll('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.focus === String(p.focus)));
  for (const t of p.tracks) {
    const aud = p.audible(t);
    t.row.classList.toggle('focus', aud && p.focus !== 'stems' || (p.focus === 'stems' && aud && t.key !== 'mix'));
    t.row.style.opacity = (p.focus === 'stems' && t.key !== 'mix' && !aud) ? .5 : 1;
    const pb = $('[data-act=play]', t.row);
    const on = p.playing && p.focus === t.key;
    pb.classList.toggle('on', on); pb.innerHTML = on ? ICON.pause : ICON.play;
    $('.m', t.row)?.classList.toggle('on', t.mute);
    $('.s', t.row)?.classList.toggle('on', t.solo);
  }
  $('#playBtn').innerHTML = p.playing ? ICON.pause : ICON.play;
  let label, color;
  if (p.focus === 'mix') { label = 'Full mix'; color = MIX_COLOR; }
  else if (p.focus === 'stems') {
    const n = p.stems.filter((t) => p.audible(t)).length;
    label = `All stems (${n}/${p.stems.length})`; color = 'var(--accent)';
  } else { const t = p.tracks.find((x) => x.key === p.focus); label = t.label; color = t.color; }
  $('#now').innerHTML = `<span class="dot" style="background:${color}"></span>Listening to <b>${esc(label)}</b>`;
}

function onPlayerChange(what, t) {
  const p = S.player; if (!p || S.view !== 'song') return;
  if (what === 'progress' && t.row) {
    $('.loading i', t.row).style.setProperty('--p', (t.progress * 100) + '%');
  }
  if (what === 'loaded' && t.row) {
    const load = $('.loading', t.row); if (load) load.remove();
    const sub = $('[data-sub]', t.row);
    if (t.state === 'error') { sub.textContent = 'failed to load'; sub.style.color = 'var(--reject)'; }
    else {
      sub.textContent = `peak ${db(t.max)} · ${fmtShort(t.buffer.duration)}`;
      t.row.classList.toggle('silent', t.max < 1e-4);
      if (t.max < 1e-4) sub.textContent = 'silent';
    }
    p.tracks.forEach(drawTrack); // duration may have grown
    $('#time span').textContent = '/ ' + fmt(p.duration);
  }
  if (what === 'progress' || what === 'loaded') {
    const f = p.loadedFraction;
    const lb = $('#loadbar');
    if (lb) { $('i', lb).style.width = (f * 100) + '%'; if (f >= 1) setTimeout(() => lb.remove(), 300); }
  }
  if (what === 'state' || what === 'focus') paintFocus();
}

let rafId = 0;
function startTicker() {
  cancelAnimationFrame(rafId);
  const tick = () => {
    const p = S.player;
    if (!p || S.view !== 'song') return;
    const t = p.time(), d = p.duration || 1;
    if (p.playing && t >= d - 0.01) { p.pause(); p.offset = 0; }
    const frac = Math.min(1, t / d);
    $('#time').firstChild.textContent = fmt(t) + ' ';
    for (const tr of p.tracks) {
      if (!tr.played) continue;
      tr.played.style.width = (frac * 100) + '%';
      tr.head.style.left = (frac * 100) + '%';
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

/* ============================================================== keyboard */
document.addEventListener('keydown', (e) => {
  const typing = e.target.matches('textarea, input[type=text], input:not([type]), .search');
  if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const p = S.player;
  if (S.view !== 'song' || !p) return;
  const k = e.key.toLowerCase();
  const song = p.song;
  if (k === ' ') { e.preventDefault(); p.toggle(); }
  else if (k === 'arrowleft') { e.preventDefault(); p.seek(p.time() - (e.shiftKey ? 15 : 5)); }
  else if (k === 'arrowright') { e.preventDefault(); p.seek(p.time() + (e.shiftKey ? 15 : 5)); }
  else if (k === 'home' || k === '0') { p.seek(0); }
  else if (k === 'm' && p.mix) { p.setFocus('mix'); if (!p.playing) p.play(); }
  else if (k === 'a') { p.setFocus('stems'); if (!p.playing) p.play(); }
  else if (/^[1-9]$/.test(k) && +k <= song.stems.length) { p.setFocus(+k - 1); if (!p.playing) p.play(); }
  else if (k === 'y') S.setVerdict('approve');
  else if (k === 'n') S.setVerdict('reject');
  else if (k === 'c') { e.preventDefault(); $('#notes').focus(); }
  else if (k === '[' || k === ']') {
    const i = S.songs.findIndex((s) => s.id === song.id);
    const n = S.songs[(i + (k === ']' ? 1 : -1) + S.songs.length) % S.songs.length];
    location.hash = `#/song/${n.id}`;
  }
});

/* ============================================================== router */
function route() {
  if (S.flushReview) { S.flushReview(); S.flushReview = null; }
  if (S.player) { S.player.destroy(); S.player = null; }
  if (S.ro) { S.ro.disconnect(); S.ro = null; }
  S.setVerdict = null;
  const m = location.hash.match(/^#\/song\/(\d+)/);
  window.scrollTo(0, 0);
  if (m) viewSong(m[1]); else viewGrid();
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', () => S.flushReview && S.flushReview());

/* ============================================================== CSV import */
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (S.flushReview) S.flushReview();
  const text = await file.text();
  const post = (dry) => fetch(`/api/import${dry ? '?dry=1' : ''}`, { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text })
    .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; });
  try {
    const p = await post(true);
    const total = p.added + p.overwritten.length + p.unchanged;
    if (!total) { toast(`No valid rows in ${file.name}`); return; }
    const lines = [`Import ${total} review${total === 1 ? '' : 's'} from "${file.name}"?`, '',
      `• ${p.added} new`, `• ${p.unchanged} already identical`];
    if (p.overwritten.length) lines.push(`• ${p.overwritten.length} will OVERWRITE your current review: ${p.overwritten.join(', ')}`);
    if (p.skipped.length) lines.push(`• ${p.skipped.length} row(s) skipped (bad id/verdict): ${p.skipped.join(', ')}`);
    if (p.unknown.length) lines.push(`• ${p.unknown.length} id(s) not in this folder (kept in CSV): ${p.unknown.join(', ')}`);
    lines.push('', 'Songs not in the file keep their current review.');
    if (!confirm(lines.join('\n'))) return;
    await post(false);
    S.reviews = await api('/api/reviews');
    renderProgress();
    route();
    toast(`Imported ${total} review${total === 1 ? '' : 's'}`);
  } catch (err) {
    toast(`Import failed: ${err.message}`);
  }
};

(async function init() {
  try {
    [S.songs, S.reviews] = await Promise.all([api('/api/songs'), api('/api/reviews')]);
  } catch (e) {
    $('#app').innerHTML = `<div class="empty">Couldn't reach the local server. Start it with <code>python3 server.py</code>.</div>`;
    return;
  }
  renderProgress();
  route();
})();
