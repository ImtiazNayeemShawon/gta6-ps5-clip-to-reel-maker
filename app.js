'use strict';
const MB = window.Mediabunny;
const $ = (id) => document.getElementById(id);

/* ---------- Settings ---------- */

const DEFAULTS = { blur: 60, dim: 25, size: 1080 };
const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('gta6-reel-maker') || '{}')); } catch {}

function syncSettings() {
  $('blur').value = settings.blur;
  $('dim').value = settings.dim;
  $('size').value = settings.size;
  $('blurOut').textContent = `${settings.blur}%`;
  $('dimOut').textContent = `${settings.dim}%`;
}
for (const key of ['blur', 'dim', 'size']) {
  $(key).addEventListener('input', () => {
    settings[key] = Number($(key).value);
    syncSettings();
    try { localStorage.setItem('gta6-reel-maker', JSON.stringify(settings)); } catch {}
    for (const job of jobs) if (job.state === 'waiting') drawPoster(job);
  });
}

/* ---------- Drawing one reel frame ---------- */

const canFilter = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.filter = 'blur(2px)';
  return ctx.filter === 'blur(2px)';
})();

// Paints blurred background + the full, uncropped clip. `draw(ctx, x, y, w, h)` paints the source.
class ReelPainter {
  constructor(width, height) {
    this.out = new OffscreenCanvas(width, height);
    this.ctx = this.out.getContext('2d', { alpha: false });
    this.mid = new OffscreenCanvas(270, 480);
    this.midCtx = this.mid.getContext('2d', { alpha: false });
    this.soft = new OffscreenCanvas(270, 480);
    this.softCtx = this.soft.getContext('2d', { alpha: false });
    for (const c of [this.ctx, this.midCtx, this.softCtx]) c.imageSmoothingQuality = 'high';
  }

  paint(draw, sw, sh, { blur, dim }) {
    const { ctx, out, mid, midCtx, soft, softCtx } = this;
    const W = out.width, H = out.height, w = mid.width, h = mid.height;

    // Background: a small copy that fills the frame, blurred, then scaled back up.
    const radius = (blur / 100) * 26;
    const cover = Math.max(w / sw, h / sh);
    draw(midCtx, (w - sw * cover) / 2, (h - sh * cover) / 2, sw * cover, sh * cover);
    if (radius < 0.5) {
      draw(ctx, (W - sw * Math.max(W / sw, H / sh)) / 2, (H - sh * Math.max(W / sw, H / sh)) / 2,
        sw * Math.max(W / sw, H / sh), sh * Math.max(W / sw, H / sh));
    } else {
      // Overscan so the blur's faded edge falls outside the frame.
      const pad = radius * 2.5;
      if (canFilter) {
        softCtx.filter = `blur(${radius}px)`;
        softCtx.drawImage(mid, -pad, -pad, w + pad * 2, h + pad * 2);
        softCtx.filter = 'none';
      } else {
        this.shrinkBlur(radius);
      }
      ctx.drawImage(soft, 0, 0, W, H);
    }
    if (dim > 0) {
      ctx.fillStyle = `rgba(0,0,0,${dim / 100})`;
      ctx.fillRect(0, 0, W, H);
    }

    // Foreground: the whole clip, fitted inside the frame.
    const fit = Math.min(W / sw, H / sh);
    const fw = Math.round((sw * fit) / 2) * 2, fh = Math.round((sh * fit) / 2) * 2;
    draw(ctx, (W - fw) / 2, (H - fh) / 2, fw, fh);
    return out;
  }

  // For browsers without canvas filters (Safari): step down to a tiny copy and back up.
  shrinkBlur(radius) {
    const { mid, soft, softCtx } = this;
    const steps = Math.max(1, Math.round(Math.log2(radius)) + 1);
    this.steps ??= [];
    let src = mid;
    const chain = [];
    for (let i = 0; i < steps; i++) {
      const c = (this.steps[i] ??= new OffscreenCanvas(Math.max(4, mid.width >> (i + 1)), Math.max(8, mid.height >> (i + 1))));
      const cx = c.getContext('2d', { alpha: false });
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(src, 0, 0, c.width, c.height);
      chain.push(c);
      src = c;
    }
    for (let i = chain.length - 2; i >= 0; i--) {
      chain[i].getContext('2d').drawImage(chain[i + 1], 0, 0, chain[i].width, chain[i].height);
    }
    softCtx.drawImage(chain[0], 0, 0, soft.width, soft.height);
  }
}

/* ---------- Reading and converting a clip ---------- */

class UserError extends Error {}

async function openClip(file) {
  const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
  try {
    if (!(await input.canRead())) throw new UserError("This file isn't a video this page can read.");
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new UserError('This file has no video in it.');
    if (!(await video.canDecode())) {
      const codec = (await video.getCodec()) || 'unknown';
      throw new UserError(`This browser can't play this clip's video format (${codec.toUpperCase()}). Try Chrome, Edge or Arc.`);
    }
    return { input, video };
  } catch (err) {
    input.dispose();
    throw err;
  }
}

async function loadPoster(job) {
  const { input, video } = await openClip(job.file);
  try {
    const start = await video.getFirstTimestamp();
    job.duration = (await input.computeDuration()) - start;
    const sample = await new MB.VideoSampleSink(video).getSample(start + Math.min(1, job.duration / 2));
    if (!sample) return;
    const scale = Math.min(1, 960 / Math.max(sample.displayWidth, sample.displayHeight));
    const c = new OffscreenCanvas(Math.round(sample.displayWidth * scale), Math.round(sample.displayHeight * scale));
    sample.draw(c.getContext('2d'), 0, 0, c.width, c.height);
    sample.close();
    job.poster = c;
  } finally {
    input.dispose();
  }
}

// Collects the output in Blob pieces so long clips don't have to sit in one block of memory.
function blobTarget() {
  const pieces = [];
  let blob = new Blob([]);
  const join = () => { blob = new Blob([blob, ...pieces.splice(0)]); };
  let end = 0;
  const writable = new WritableStream({
    write({ data, position }) {
      if (position === end) {
        pieces.push(new Blob([data]));
        end += data.byteLength;
        return;
      }
      join();
      const after = position + data.byteLength;
      blob = new Blob([blob.slice(0, position), data, blob.slice(after)]);
      end = Math.max(end, after);
    },
  });
  return {
    target: new MB.StreamTarget(writable, { chunked: true, chunkSize: 4 * 2 ** 20 }),
    finish() { join(); return new Blob([blob], { type: 'video/mp4' }); },
  };
}

async function convert(job) {
  const opts = { ...settings };
  const W = opts.size, H = (W * 16) / 9;
  const { input, video } = await openClip(job.file);
  try {
    const { averagePacketRate: fps } = await video.computePacketStats(120);
    const perPixel = fps > 40 ? 0.12 : 0.16; // bits per pixel per frame
    const bitrate = Math.round(Math.min(W === 1080 ? 18e6 : 55e6, Math.max(8e6, W * H * Math.min(fps || 30, 60) * perPixel)));
    const quality = new MB.Quality({ bitrate });
    if (!(await MB.canEncodeVideo('avc', { width: W, height: H, quality }))) {
      throw new UserError(W > 1080 ? "This browser can't make 4K reels. Choose 1080 × 1920 and press Redo."
        : "This browser can't make MP4 video. Try Chrome, Edge or Arc.");
    }

    const painter = new ReelPainter(W, H);
    const view = job.el.canvas.getContext('2d');
    let n = 0;
    const out = blobTarget();
    const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'reserve' }), target: out.target });
    const conversion = await MB.Conversion.init({
      input, output, tracks: 'primary', showWarnings: false,
      video: {
        codec: 'avc', quality, forceTranscode: true, allowTransformationMetadata: false, keyFrameInterval: 2,
        processedWidth: W, processedHeight: H,
        process(sample) {
          const frame = painter.paint((ctx, ...box) => sample.draw(ctx, ...box), sample.displayWidth, sample.displayHeight, opts);
          if (n++ % 10 === 0) view.drawImage(frame, 0, 0, view.canvas.width, view.canvas.height);
          return frame;
        },
      },
      // Copies the original sound untouched when it's already AAC (PS5 MP4 clips), else re-encodes it.
      audio: async (track) => {
        if ((await track.getCodec()) === 'aac') return { codec: 'aac' };
        const q = new MB.Quality({ bitrate: 256e3 });
        return (await MB.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000, quality: q }))
          ? { codec: 'aac', numberOfChannels: 2, sampleRate: 48000, quality: q } : {};
      },
    });
    const lost = conversion.discardedTracks.filter((d) => ['video', 'audio'].includes(d.track.type) && d.reason !== 'discarded_by_user');
    if (!conversion.isValid || lost.some((d) => d.track.type === 'video')) throw new UserError("This clip's video couldn't be converted.");
    job.warning = lost.some((d) => d.track.type === 'audio') ? "No sound: this browser couldn't convert the audio." : '';

    conversion.onProgress = (p) => { job.progress = p; showProgress(job); };
    job.cancel = () => conversion.cancel();
    if (job.removed) throw new Error('removed');
    await conversion.execute();
    return out.finish();
  } finally {
    job.cancel = null;
    input.dispose();
  }
}

/* ---------- Queue ---------- */

const jobs = [];
let running = false;

const supported = window.isSecureContext !== false && 'VideoEncoder' in window && 'VideoDecoder' in window && MB;
if (!supported) {
  $('notice').hidden = false;
  $('notice').textContent = MB
    ? "This browser can't convert video. Open this page in an up-to-date Chrome, Edge or Arc."
    : 'mediabunny.min.js is missing. Keep it in the same folder as this page.';
}

const isVideo = (f) => f.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v)$/i.test(f.name);

function addFiles(list) {
  if (!supported) return;
  const files = [...list];
  const videos = files.filter(isVideo);
  const skipped = files.length - videos.length;
  $('notice').hidden = !skipped;
  if (skipped) $('notice').textContent = `Skipped ${skipped} file${skipped > 1 ? 's' : ''} that ${skipped > 1 ? "aren't videos" : "isn't a video"}.`;
  for (const file of videos) {
    const job = { file, state: 'waiting', progress: 0, outName: uniqueName(file.name) };
    buildTile(job);
    jobs.push(job);
  }
  refresh();
  run();
}

function uniqueName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  let out = `${base}-reel.mp4`;
  for (let i = 2; jobs.some((j) => j.outName === out); i++) out = `${base}-reel-${i}.mp4`;
  return out;
}

async function run() {
  if (running) return;
  running = true;
  try {
    for (let job; (job = jobs.find((j) => !j.posterTried) || jobs.find((j) => j.state === 'waiting'));) {
      if (!job.posterTried) {
        job.posterTried = true;
        try { await loadPoster(job); drawPoster(job); } catch (err) { fail(job, err); }
        render(job);
        continue;
      }
      keepAwake();
      job.state = 'working';
      job.progress = 0;
      job.started = performance.now();
      render(job);
      try {
        job.blob = await convert(job);
        job.took = (performance.now() - job.started) / 1000;
        job.state = 'done';
        job.saved = false;
        job.url = URL.createObjectURL(job.blob);
      } catch (err) {
        if (!job.removed) fail(job, err);
      }
      render(job);
    }
  } finally {
    running = false;
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    refresh();
  }
}

function fail(job, err) {
  job.state = 'failed';
  job.error = err instanceof UserError ? err.message : `Couldn't convert this clip: ${err?.message || err}`;
  if (!(err instanceof UserError)) console.error(job.file.name, err);
}

function dropOutput(job) {
  if (job.url) URL.revokeObjectURL(job.url);
  job.url = job.blob = null;
}

function removeJob(job) {
  job.removed = true;
  job.cancel?.();
  dropOutput(job);
  job.el.root.remove();
  jobs.splice(jobs.indexOf(job), 1);
  refresh();
}

function redo(job) {
  dropOutput(job);
  job.state = 'waiting';
  job.error = job.warning = '';
  job.posterTried = !!job.poster;
  if (job.poster) drawPoster(job);
  render(job);
  run();
}

let wakeLock = null;
async function keepAwake() {
  if (wakeLock && !wakeLock.released) return;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (running && !document.hidden) keepAwake(); });

/* ---------- Tiles ---------- */

const posterPainter = new ReelPainter(360, 640);

function drawPoster(job) {
  if (!job.poster) return;
  const p = job.poster;
  const frame = posterPainter.paint((ctx, ...box) => ctx.drawImage(p, ...box), p.width, p.height, settings);
  job.el.canvas.getContext('2d').drawImage(frame, 0, 0);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function buildTile(job) {
  const root = el('li', 'tile');
  const screen = el('div', 'screen');
  const canvas = el('canvas');
  canvas.width = 360; canvas.height = 640;
  const meter = el('div', 'meter');
  const fill = el('i');
  meter.append(fill);
  screen.append(canvas, meter);
  const text = el('div');
  const name = el('div', 'name', job.file.name);
  name.title = job.file.name;
  const meta = el('div', 'meta');
  text.append(name, meta);
  const acts = el('div', 'acts');
  root.append(screen, text, acts);
  job.el = { root, screen, canvas, meter, fill, meta, acts };
  $('grid').append(root);
  render(job);
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const mb = (bytes) => (bytes < 1e9 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : `${(bytes / 1e9).toFixed(1)} GB`);

function showProgress(job) {
  const { fill, meta } = job.el;
  fill.style.width = `${job.progress * 100}%`;
  let left = '';
  const spent = (performance.now() - job.started) / 1000;
  if (job.progress > 0.03 && spent > 1.5) left = `, ${clock(Math.ceil((spent / job.progress) * (1 - job.progress)))} left`;
  meta.textContent = `Making ${Math.floor(job.progress * 100)}%${left}`;
}

function render(job) {
  const { root, screen, meter, meta, acts } = job.el;
  root.dataset.state = job.state;
  meter.hidden = job.state !== 'working';
  screen.querySelector('video, .stamp')?.remove();
  meta.replaceChildren();
  acts.replaceChildren();
  const button = (label, fn, cls = '') => {
    const b = el('button', `btn ${cls}`, label);
    b.setAttribute('aria-label', `${label} ${job.file.name}`);
    b.onclick = fn;
    acts.append(b);
  };

  if (job.state === 'waiting') {
    meta.textContent = `Waiting${job.duration ? `, ${clock(job.duration)}` : ''}`;
    button('Remove', () => removeJob(job));
  } else if (job.state === 'working') {
    showProgress(job);
    button('Cancel', () => removeJob(job));
  } else if (job.state === 'done') {
    meta.append(el('b', '', job.saved ? 'Saved' : 'Ready'), ` ${mb(job.blob.size)}, made in ${clock(job.took)}`);
    if (job.warning) meta.append(el('span', 'warn', job.warning));
    const video = el('video');
    video.src = job.url; video.controls = true; video.playsInline = true; video.preload = 'metadata';
    screen.append(video);
    button('Download', () => download(job), 'main grow');
    button('Redo', () => redo(job));
  } else {
    screen.append(el('div', 'stamp', 'Wasted'));
    meta.textContent = job.error;
    button('Redo', () => redo(job));
    button('Remove', () => removeJob(job));
  }
  refresh();
}

function refresh() {
  const done = jobs.filter((j) => j.state === 'done');
  const failed = jobs.filter((j) => j.state === 'failed').length;
  $('empty').hidden = jobs.length > 0;
  $('work').hidden = jobs.length === 0;
  const left = jobs.length - done.length - failed;
  document.body.classList.toggle('has-clips', jobs.length > 0);
  // Five stars fill up as the batch gets done.
  const lit = jobs.length ? Math.floor((done.length / jobs.length) * 5) : 0;
  [...$('stars').children].forEach((star, i) => star.classList.toggle('on', i < lit));
  let text = left ? `${done.length} of ${jobs.length} ready` : `${done.length} reel${done.length === 1 ? '' : 's'} ready`;
  if (!left && done.length && !failed) text = `Mission passed! ${text}`;
  if (failed) text += `, ${failed} failed`;
  if ($('status').textContent !== text) $('status').textContent = text;
  $('saveAll').disabled = !done.length;
  $('saveAll').textContent = done.length && left ? `Download ${done.length} ready` : 'Download all';
  $('clearDone').hidden = !done.length;
}

/* ---------- Saving ---------- */

function download(job) {
  const a = el('a');
  a.href = job.url;
  a.download = job.outName;
  a.click();
  job.saved = true;
  const label = job.el.meta.querySelector('b');
  if (label) label.textContent = 'Saved';
}

$('saveAll').onclick = async () => {
  const done = jobs.filter((j) => j.state === 'done');
  // With several clips, pick one folder instead of a download prompt per clip (Chrome, Edge, Arc).
  if (done.length > 1 && window.showDirectoryPicker) {
    let dir;
    try { dir = await showDirectoryPicker({ mode: 'readwrite', id: 'reels', startIn: 'downloads' }); } catch (err) {
      if (err.name === 'AbortError') return;
    }
    if (dir) {
      $('saveAll').disabled = true;
      try {
        for (const job of done) {
          if (!job.blob) continue;
          $('saveAll').textContent = `Saving ${job.outName}`;
          const handle = await dir.getFileHandle(await freeName(dir, job.outName), { create: true });
          await job.blob.stream().pipeTo(await handle.createWritable());
          job.saved = true;
          render(job);
          $('saveAll').disabled = true;
        }
      } catch (err) {
        $('notice').hidden = false;
        $('notice').textContent = `Couldn't save to that folder: ${err.message}. Use the Download button on each clip instead.`;
      }
      refresh();
      return;
    }
  }
  for (const job of done) {
    download(job);
    await new Promise((r) => setTimeout(r, 500));
  }
};

// Never overwrite something already in the chosen folder.
async function freeName(dir, name) {
  const base = name.replace(/\.mp4$/, '');
  for (let i = 1; ; i++) {
    const tryName = i === 1 ? name : `${base} (${i}).mp4`;
    try { await dir.getFileHandle(tryName); } catch (err) {
      if (err.name === 'NotFoundError') return tryName;
      throw err;
    }
  }
}

$('clearDone').onclick = () => {
  const done = jobs.filter((j) => j.state === 'done');
  const unsaved = done.filter((j) => !j.saved).length;
  if (unsaved && !confirm(`${unsaved} finished reel${unsaved > 1 ? "s haven't" : " hasn't"} been downloaded. Clear anyway?`)) return;
  done.forEach(removeJob);
};

window.addEventListener('beforeunload', (e) => {
  if (running || jobs.some((j) => j.state === 'done' && !j.saved)) e.preventDefault();
});

/* ---------- Adding files ---------- */

for (const input of document.querySelectorAll('.file-in')) {
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
}
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  addFiles(e.dataTransfer.files);
});

syncSettings();
refresh();
