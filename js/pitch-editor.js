(function (global) {
  'use strict';

  // =======================================================================
  // Pure logic (no DOM). Exported for Node-based unit testing as well as
  // for the browser UI code further below in this same file.
  // =======================================================================

  function freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440);
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // contour: array of { time, f0 } where f0 is Hz or null (unvoiced).
  // Splits into runs of consecutive frames that round to the same semitone,
  // separated by unvoiced gaps or a change of semitone. Short/noisy runs are
  // dropped. Returns [{ startTime, endTime, originalMidi }], targetMidi is
  // NOT set here (callers initialize it, typically to originalMidi).
  function segmentPitchContour(contour, opts) {
    const options = opts || {};
    const minDuration = options.minDuration != null ? options.minDuration : 0.06;
    const frameDuration = options.frameDuration || 0;

    const raw = [];
    let cur = null;

    for (let i = 0; i < contour.length; i++) {
      const point = contour[i];
      if (point.f0 == null || point.f0 <= 0) {
        if (cur) { raw.push(cur); cur = null; }
        continue;
      }
      const midi = freqToMidi(point.f0);
      const rounded = Math.round(midi);
      if (!cur) {
        cur = { startTime: point.time, endTime: point.time, rounded, midiValues: [midi] };
      } else if (rounded === cur.rounded) {
        cur.endTime = point.time;
        cur.midiValues.push(midi);
      } else {
        raw.push(cur);
        cur = { startTime: point.time, endTime: point.time, rounded, midiValues: [midi] };
      }
    }
    if (cur) raw.push(cur);

    return raw
      .filter((s) => s.endTime - s.startTime + frameDuration >= minDuration)
      .map((s) => {
        const avg = s.midiValues.reduce((a, b) => a + b, 0) / s.midiValues.length;
        return { startTime: s.startTime, endTime: s.endTime + frameDuration, originalMidi: avg };
      });
  }

  // Builds a Float32Array of one pitch-shift ratio per render block (default
  // 1.0 = no shift everywhere), applying each edited segment's ratio across
  // its time span with a short linear (in semitone space) ramp at its edges
  // so the shift doesn't click in/out abruptly.
  function buildRatioTimeline(segments, opts) {
    const options = opts || {};
    const sampleRate = options.sampleRate;
    const blockSize = options.blockSize || 128;
    const totalSamples = options.totalSamples;
    const rampSeconds = options.rampSeconds != null ? options.rampSeconds : 0.012;

    const numBlocks = Math.max(1, Math.ceil(totalSamples / blockSize));
    const ratios = new Float32Array(numBlocks).fill(1.0);

    const active = segments.filter((s) => s.targetMidi !== s.originalMidi);
    if (active.length === 0) return ratios;

    const rampBlocks = Math.max(1, Math.round((rampSeconds * sampleRate) / blockSize));

    for (const seg of active) {
      const startBlock = Math.floor((seg.startTime * sampleRate) / blockSize);
      const endBlock = Math.ceil((seg.endTime * sampleRate) / blockSize);
      const shift = seg.targetMidi - seg.originalMidi;

      for (let b = Math.max(0, startBlock); b < Math.min(numBlocks, endBlock); b++) {
        const fromStart = b - startBlock;
        const fromEnd = endBlock - 1 - b;
        let mix = 1.0;
        if (fromStart < rampBlocks) mix = Math.min(mix, (fromStart + 1) / rampBlocks);
        if (fromEnd < rampBlocks) mix = Math.min(mix, (fromEnd + 1) / rampBlocks);
        ratios[b] = Math.pow(2, (shift * mix) / 12);
      }
    }
    return ratios;
  }

  const CoreAPI = { freqToMidi, midiToFreq, segmentPitchContour, buildRatioTimeline };

  if (typeof module !== 'undefined' && module.exports) module.exports = CoreAPI;
  if (global) global.PitchEditorCore = CoreAPI;

  // =======================================================================
  // Browser UI. Skipped entirely outside a document context (Node tests).
  // =======================================================================
  if (typeof document === 'undefined') return;

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const BLACK_KEY_PC = new Set([1, 3, 6, 8, 10]);

  function midiToName(midi) {
    const r = Math.round(midi);
    const name = NOTE_NAMES[((r % 12) + 12) % 12];
    const octave = Math.floor(r / 12) - 1;
    return name + octave;
  }

  function el(id) { return document.getElementById(id); }

  const fileInput = el('mediaFileInput');
  const fileNameEl = el('mediaFileName');
  const loadStatusEl = el('loadStatus');
  const progressBar = el('analysisProgress');
  const editorSection = el('editorSection');
  const originalAudio = el('originalAudio');
  const keysCanvas = el('keysCanvas');
  const rulerCanvas = el('rulerCanvas');
  const waveformCanvas = el('waveformCanvas');
  const notesCanvas = el('notesCanvas');
  const scrollContainer = el('editorScroll');
  const resetBtn = el('resetEditsBtn');
  const renderBtn = el('renderBtn');
  const renderStatusEl = el('renderStatus');
  const correctedAudio = el('correctedAudio');
  const downloadLink = el('downloadLink');
  const fullscreenBtn = el('fullscreenBtn');
  const zoomInHBtn = el('zoomInH');
  const zoomOutHBtn = el('zoomOutH');
  const zoomInVBtn = el('zoomInV');
  const zoomOutVBtn = el('zoomOutV');
  const scaleKeySelect = el('scaleKeySelect');
  const scaleTypeSelect = el('scaleTypeSelect');

  if (!fileInput) return; // page section not present

  if (!window.PitchCorrectionDSP) {
    loadStatusEl.textContent = 'DSPモジュールの読み込みに失敗しました。ページを再読み込みしてください。';
    return;
  }

  const hasOfflineAudio = !!(window.OfflineAudioContext || window.webkitOfflineAudioContext);
  const hasAudioWorklet = !!window.AudioWorkletNode;
  if (!hasOfflineAudio || !hasAudioWorklet) {
    const unsupportedText = el('unsupportedText');
    if (unsupportedText) unsupportedText.classList.remove('hidden');
    fileInput.disabled = true;
    return;
  }

  const BASE_PIXELS_PER_SECOND = 70;
  const BASE_PIXELS_PER_SEMITONE = 24;
  const H_ZOOM_MIN = 0.25;
  const H_ZOOM_MAX = 10;
  const V_ZOOM_MIN = 0.5;
  const V_ZOOM_MAX = 3;
  const ZOOM_STEP = Math.SQRT2;
  const NOTE_BLOCK_HEIGHT_RATIO = 0.72;
  const WAVEFORM_HEIGHT = 64;
  const KEYS_GUTTER_WIDTH = 44;
  const RULER_HEIGHT = 22;

  const KEY_NAMES = NOTE_NAMES;
  const SCALES = {
    none: { label: 'スケール: なし', intervals: null },
    chromatic: { label: 'クロマチック', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    major: { label: 'メジャー', intervals: [0, 2, 4, 5, 7, 9, 11] },
    minor: { label: 'ナチュラルマイナー', intervals: [0, 2, 3, 5, 7, 8, 10] },
    majorPenta: { label: 'メジャーペンタトニック', intervals: [0, 2, 4, 7, 9] },
    minorPenta: { label: 'マイナーペンタトニック', intervals: [0, 3, 5, 7, 10] },
  };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  const state = {
    sampleRate: 0,
    samples: null, // Float32Array mono
    duration: 0,
    segments: [], // { startTime, endTime, originalMidi, targetMidi }
    midiMin: 55,
    midiMax: 79,
    hZoom: 1,
    vZoom: 1,
    pixelsPerSecond: BASE_PIXELS_PER_SECOND,
    pixelsPerSemitone: BASE_PIXELS_PER_SEMITONE,
    canvasWidth: 0,
    canvasHeight: 0,
    isFullscreen: false,
    scaleKey: 0,
    scaleType: 'none',
    drag: null, // { segment, startPointerY, startTargetMidi }
  };

  // ---- WAV encoding --------------------------------------------------
  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  function encodeMonoWav(samples, sampleRate) {
    const numFrames = samples.length;
    const dataSize = numFrames * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buf);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ---- File decoding (audio directly, video via capture+record) -------
  function looksLikeVideo(file) {
    return file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i.test(file.name);
  }

  async function extractAudioFromVideo(file, onStatus) {
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement('video');
      video.src = url;
      video.playsInline = true;
      video.preload = 'auto';

      await new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', () => reject(new Error('動画を読み込めませんでした')), { once: true });
      });

      const captureFn = video.captureStream || video.mozCaptureStream;
      if (!captureFn) throw new Error('このブラウザは動画からの音声抽出に対応していません');
      const stream = captureFn.call(video);
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) throw new Error('この動画ファイルに音声トラックが見つかりませんでした');
      if (typeof MediaRecorder === 'undefined') throw new Error('このブラウザは動画からの音声抽出に対応していません');

      const audioOnlyStream = new MediaStream(audioTracks);
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      const mimeType = candidates.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(audioOnlyStream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const recordingDone = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));

      if (onStatus) onStatus('動画を再生して音声を抽出中…（音が流れます）');
      recorder.start();
      await video.play();
      await new Promise((resolve) => video.addEventListener('ended', resolve, { once: true }));
      recorder.stop();
      await recordingDone;

      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      return await decodeViaWebAudio(arrayBuffer);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Decodes with decodeAudioData, trying an OfflineAudioContext first (no
  // audible side effects) and falling back to a real AudioContext, since
  // some browsers (notably older Safari) are inconsistent about decoding
  // via an offline context.
  async function decodeViaWebAudio(arrayBuffer) {
    const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    try {
      const offlineCtx = new OfflineCtor(1, 1, 44100);
      return await offlineCtx.decodeAudioData(arrayBuffer.slice(0));
    } catch (offlineErr) {
      const AudioCtxCtor = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtxCtor();
      try {
        return await ctx.decodeAudioData(arrayBuffer.slice(0));
      } finally {
        ctx.close();
      }
    }
  }

  async function decodeAudioFromFile(file, onStatus) {
    const arrayBuffer = await file.arrayBuffer();

    // Try decoding directly first, regardless of file extension/MIME type:
    // this covers plain audio files whose container happens to share an
    // extension with video (e.g. .3gp / .mp4 voice recordings), which is
    // far more common than an actual video file decoding as audio-only.
    let decodeErr = null;
    try {
      return await decodeViaWebAudio(arrayBuffer);
    } catch (err) {
      decodeErr = err;
    }

    if (looksLikeVideo(file)) {
      return extractAudioFromVideo(file, onStatus);
    }

    throw new Error(
      '音声として読み込めませんでした（' + (decodeErr && decodeErr.message ? decodeErr.message : decodeErr) + '）。対応形式: wav / mp3 / m4a など'
    );
  }

  function downmixToMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0).slice();
    const n = audioBuffer.numberOfChannels;
    const out = new Float32Array(audioBuffer.length);
    for (let c = 0; c < n; c++) {
      const chan = audioBuffer.getChannelData(c);
      for (let i = 0; i < chan.length; i++) out[i] += chan[i] / n;
    }
    return out;
  }

  // ---- Chunked pitch analysis (keeps the UI thread responsive) --------
  async function analyzePitchContour(samples, sampleRate, onProgress) {
    const hop = 512;
    const winSize = 1024;
    const yin = new window.PitchCorrectionDSP.YinDetector(winSize, sampleRate, 0.15);
    const win = new Float32Array(winSize);
    const contour = [];
    const total = samples.length;
    const silenceRms = 0.008;
    let i = 0;
    let sinceYield = 0;

    while (i + winSize <= total) {
      win.set(samples.subarray(i, i + winSize));
      let rms = 0;
      for (let k = 0; k < winSize; k++) rms += win[k] * win[k];
      rms = Math.sqrt(rms / winSize);

      let f0 = null;
      if (rms > silenceRms) {
        const detected = yin.detect(win);
        if (detected > 0) f0 = detected;
      }
      contour.push({ time: i / sampleRate, f0 });

      i += hop;
      sinceYield++;
      if (sinceYield >= 300) {
        sinceYield = 0;
        if (onProgress) onProgress(Math.min(1, i / total));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
    if (onProgress) onProgress(1);
    return { contour, hop };
  }

  // ---- Layout / rendering ---------------------------------------------
  function computeMidiRange(segments) {
    if (!segments.length) return { min: 55, max: 79 };
    let min = Infinity, max = -Infinity;
    for (const s of segments) {
      const lo = Math.min(s.originalMidi, s.targetMidi);
      const hi = Math.max(s.originalMidi, s.targetMidi);
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
    return { min: Math.floor(min) - 3, max: Math.ceil(max) + 3 };
  }

  function timeToX(t) { return t * state.pixelsPerSecond; }
  function midiToY(midi) {
    return (state.midiMax - midi) * state.pixelsPerSemitone;
  }

  function layoutCanvases() {
    const { min, max } = computeMidiRange(state.segments);
    state.midiMin = min;
    state.midiMax = max;

    state.pixelsPerSecond = BASE_PIXELS_PER_SECOND * state.hZoom;
    state.pixelsPerSemitone = BASE_PIXELS_PER_SEMITONE * state.vZoom;

    state.canvasWidth = Math.max(1, Math.ceil(state.duration * state.pixelsPerSecond));
    state.canvasHeight = Math.max(1, (max - min + 1) * state.pixelsPerSemitone);

    waveformCanvas.width = state.canvasWidth;
    waveformCanvas.height = WAVEFORM_HEIGHT;
    waveformCanvas.style.width = state.canvasWidth + 'px';
    waveformCanvas.style.height = WAVEFORM_HEIGHT + 'px';

    notesCanvas.width = state.canvasWidth;
    notesCanvas.height = state.canvasHeight;
    notesCanvas.style.width = state.canvasWidth + 'px';
    notesCanvas.style.height = state.canvasHeight + 'px';

    keysCanvas.width = KEYS_GUTTER_WIDTH;
    keysCanvas.height = state.canvasHeight;
    keysCanvas.style.width = KEYS_GUTTER_WIDTH + 'px';
    keysCanvas.style.height = state.canvasHeight + 'px';

    rulerCanvas.width = state.canvasWidth;
    rulerCanvas.height = RULER_HEIGHT;
    rulerCanvas.style.width = state.canvasWidth + 'px';
    rulerCanvas.style.height = RULER_HEIGHT + 'px';
  }

  function inScalePitchClass(pc) {
    if (state.scaleType === 'none') return false;
    const intervals = SCALES[state.scaleType].intervals;
    if (!intervals) return false;
    const allowed = intervals.map((iv) => ((state.scaleKey + iv) % 12 + 12) % 12);
    return allowed.includes(pc);
  }

  function chooseTickStep(pixelsPerSecond) {
    const minPxBetweenTicks = 46;
    const raw = minPxBetweenTicks / pixelsPerSecond;
    const niceSteps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900];
    for (const s of niceSteps) if (s >= raw) return s;
    return niceSteps[niceSteps.length - 1];
  }

  function formatTime(t) {
    if (t < 60) {
      const rounded = Math.round(t * 10) / 10;
      return (Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)) + 's';
    }
    const m = Math.floor(t / 60);
    const s = Math.round(t - m * 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  function drawRuler() {
    const ctx = rulerCanvas.getContext('2d');
    const w = rulerCanvas.width, h = rulerCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);

    const step = chooseTickStep(state.pixelsPerSecond);
    ctx.strokeStyle = '#3a4152';
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'top';
    for (let t = 0; t <= state.duration + step; t += step) {
      const x = timeToX(t);
      if (x > w + 5) break;
      ctx.beginPath();
      ctx.moveTo(x, h - 7);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillText(formatTime(t), x + 3, 2);
    }
  }

  function drawKeys() {
    const ctx = keysCanvas.getContext('2d');
    ctx.clearRect(0, 0, keysCanvas.width, keysCanvas.height);
    const rowH = state.pixelsPerSemitone;
    for (let midi = state.midiMin; midi <= state.midiMax; midi++) {
      const y = midiToY(midi);
      const pc = ((midi % 12) + 12) % 12;
      ctx.fillStyle = BLACK_KEY_PC.has(pc) ? '#0b0d12' : '#171a21';
      ctx.fillRect(0, y - rowH, KEYS_GUTTER_WIDTH, rowH);
      if (inScalePitchClass(pc)) {
        ctx.fillStyle = 'rgba(30,197,194,0.22)';
        ctx.fillRect(0, y - rowH, KEYS_GUTTER_WIDTH, rowH);
      }
      if (pc === 0) {
        ctx.strokeStyle = '#3a4152';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(KEYS_GUTTER_WIDTH, y);
        ctx.stroke();
      }
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(midiToName(midi), 4, y - rowH / 2);
    }
  }

  function drawNotes() {
    const ctx = notesCanvas.getContext('2d');
    const w = notesCanvas.width, h = notesCanvas.height;
    const rowH = state.pixelsPerSemitone;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#12151c';
    ctx.fillRect(0, 0, w, h);

    for (let midi = state.midiMin; midi <= state.midiMax; midi++) {
      const y = midiToY(midi);
      const pc = ((midi % 12) + 12) % 12;
      if (BLACK_KEY_PC.has(pc)) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(0, y - rowH, w, rowH);
      }
      if (inScalePitchClass(pc)) {
        ctx.fillStyle = 'rgba(30,197,194,0.10)';
        ctx.fillRect(0, y - rowH, w, rowH);
      }
      ctx.strokeStyle = 'rgba(58,65,82,0.5)';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    for (const seg of state.segments) {
      const x1 = timeToX(seg.startTime);
      const x2 = Math.max(x1 + 2, timeToX(seg.endTime));
      const edited = seg.targetMidi !== seg.originalMidi;

      // Faint marker at the original detected pitch, for reference.
      if (edited) {
        const oy = midiToY(seg.originalMidi);
        ctx.strokeStyle = 'rgba(154,163,178,0.5)';
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(x1, oy);
        ctx.lineTo(x2, oy);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const cy = midiToY(seg.targetMidi);
      const blockH = rowH * NOTE_BLOCK_HEIGHT_RATIO;
      const y1 = cy - rowH / 2 + (rowH - blockH) / 2;

      ctx.fillStyle = edited ? '#1ec5c2' : '#5b6478';
      ctx.strokeStyle = seg === (state.drag && state.drag.segment) ? '#ffffff' : 'rgba(0,0,0,0.3)';
      ctx.lineWidth = seg === (state.drag && state.drag.segment) ? 2 : 1;

      const r = 4;
      ctx.beginPath();
      ctx.moveTo(x1 + r, y1);
      ctx.arcTo(x2, y1, x2, y1 + blockH, r);
      ctx.arcTo(x2, y1 + blockH, x1, y1 + blockH, r);
      ctx.arcTo(x1, y1 + blockH, x1, y1, r);
      ctx.arcTo(x1, y1, x2, y1, r);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  function redraw() {
    drawKeys();
    drawNotes();
    drawRuler();
  }

  // ---- Drag interaction (pointer events: mouse + touch + pen) ---------
  function hitTestSegment(x, y) {
    const rowH = state.pixelsPerSemitone;
    for (let i = state.segments.length - 1; i >= 0; i--) {
      const seg = state.segments[i];
      const x1 = timeToX(seg.startTime);
      const x2 = Math.max(x1 + 2, timeToX(seg.endTime));
      const cy = midiToY(seg.targetMidi);
      const blockH = rowH * NOTE_BLOCK_HEIGHT_RATIO;
      const y1 = cy - rowH / 2 + (rowH - blockH) / 2;
      if (x >= x1 && x <= x2 && y >= y1 && y <= y1 + blockH) return seg;
    }
    return null;
  }

  notesCanvas.addEventListener('pointerdown', (e) => {
    const rect = notesCanvas.getBoundingClientRect();
    const scaleX = notesCanvas.width / rect.width;
    const scaleY = notesCanvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const seg = hitTestSegment(x, y);
    if (!seg) return;
    e.preventDefault();
    notesCanvas.setPointerCapture(e.pointerId);
    state.drag = { segment: seg, startClientY: e.clientY, startTargetMidi: seg.targetMidi, scaleY };
    redraw();
  });

  notesCanvas.addEventListener('pointermove', (e) => {
    if (!state.drag) return;
    e.preventDefault();
    const deltaYCanvas = (e.clientY - state.drag.startClientY) * state.drag.scaleY;
    const semitoneDelta = -Math.round(deltaYCanvas / state.pixelsPerSemitone);
    state.drag.segment.targetMidi = state.drag.startTargetMidi + semitoneDelta;
    redraw();
  });

  function endDrag(e) {
    if (!state.drag) return;
    try { notesCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
    state.drag = null;
    layoutCanvases();
    redraw();
    drawWaveformIfReady();
  }
  notesCanvas.addEventListener('pointerup', endDrag);
  notesCanvas.addEventListener('pointercancel', endDrag);

  function drawWaveformIfReady() {
    if (state.samples) window.Waveform.drawWaveform(waveformCanvas, state.samples);
  }

  function relayout() {
    if (!state.samples) return;
    layoutCanvases();
    redraw();
    drawWaveformIfReady();
  }

  // ---- Fullscreen / zoom / scale-highlight controls ----------------------
  fullscreenBtn.addEventListener('click', () => {
    state.isFullscreen = !state.isFullscreen;
    editorSection.classList.toggle('is-fullscreen', state.isFullscreen);
    document.body.classList.toggle('editor-fullscreen-active', state.isFullscreen);
    fullscreenBtn.textContent = state.isFullscreen ? '×' : '⛶';
    fullscreenBtn.setAttribute('aria-label', state.isFullscreen ? '全画面を閉じる' : '全画面表示');
  });

  zoomInHBtn.addEventListener('click', () => {
    state.hZoom = clamp(state.hZoom * ZOOM_STEP, H_ZOOM_MIN, H_ZOOM_MAX);
    relayout();
  });
  zoomOutHBtn.addEventListener('click', () => {
    state.hZoom = clamp(state.hZoom / ZOOM_STEP, H_ZOOM_MIN, H_ZOOM_MAX);
    relayout();
  });
  zoomInVBtn.addEventListener('click', () => {
    state.vZoom = clamp(state.vZoom * ZOOM_STEP, V_ZOOM_MIN, V_ZOOM_MAX);
    relayout();
  });
  zoomOutVBtn.addEventListener('click', () => {
    state.vZoom = clamp(state.vZoom / ZOOM_STEP, V_ZOOM_MIN, V_ZOOM_MAX);
    relayout();
  });

  KEY_NAMES.forEach((k, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = k;
    scaleKeySelect.appendChild(opt);
  });
  Object.keys(SCALES).forEach((id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = SCALES[id].label;
    scaleTypeSelect.appendChild(opt);
  });
  scaleTypeSelect.value = 'none';
  scaleKeySelect.disabled = true;

  function onScaleChange() {
    state.scaleKey = parseInt(scaleKeySelect.value, 10);
    state.scaleType = scaleTypeSelect.value;
    scaleKeySelect.disabled = state.scaleType === 'none';
    redraw();
  }
  scaleKeySelect.addEventListener('change', onScaleChange);
  scaleTypeSelect.addEventListener('change', onScaleChange);

  // ---- Reset / render ---------------------------------------------------
  resetBtn.addEventListener('click', () => {
    for (const seg of state.segments) seg.targetMidi = seg.originalMidi;
    relayout();
  });

  renderBtn.addEventListener('click', async () => {
    renderBtn.disabled = true;
    renderStatusEl.textContent = '書き出し中…';
    correctedAudio.classList.add('hidden');
    downloadLink.classList.add('hidden');
    try {
      const rendered = await renderCorrectedAudio(state.samples, state.sampleRate, state.segments);
      const mono = rendered.getChannelData(0);
      const blob = encodeMonoWav(mono, rendered.sampleRate);
      const url = URL.createObjectURL(blob);
      correctedAudio.src = url;
      correctedAudio.classList.remove('hidden');
      downloadLink.href = url;
      downloadLink.download = 'corrected.wav';
      downloadLink.classList.remove('hidden');
      renderStatusEl.textContent = '完了しました。';
    } catch (err) {
      renderStatusEl.textContent = '書き出しに失敗しました: ' + (err && err.message ? err.message : err);
    } finally {
      renderBtn.disabled = false;
    }
  });

  async function renderCorrectedAudio(samples, sampleRate, segments) {
    const blockSize = 128;
    const tailPad = 4096;
    const totalSamples = samples.length;
    const renderLength = totalSamples + tailPad;

    const ratios = window.PitchEditorCore.buildRatioTimeline(segments, {
      sampleRate,
      blockSize,
      totalSamples,
      rampSeconds: 0.012,
    });
    const numBlocksNeeded = Math.ceil(renderLength / blockSize);
    let fullRatios = ratios;
    if (ratios.length < numBlocksNeeded) {
      fullRatios = new Float32Array(numBlocksNeeded).fill(1.0);
      fullRatios.set(ratios);
    }

    const DecodeCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const renderCtx = new DecodeCtor(1, renderLength, sampleRate);
    await renderCtx.audioWorklet.addModule('js/pitch-worklet.js');

    const buffer = renderCtx.createBuffer(1, totalSamples, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = renderCtx.createBufferSource();
    source.buffer = buffer;

    const workletNode = new AudioWorkletNode(renderCtx, 'ratio-pitch-shift-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      outputChannelCount: [1],
      processorOptions: { ratios: fullRatios },
    });

    source.connect(workletNode).connect(renderCtx.destination);
    source.start(0);

    return renderCtx.startRendering();
  }

  // ---- File input wiring -------------------------------------------------
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    fileNameEl.textContent = file.name;
    editorSection.classList.add('hidden');
    correctedAudio.classList.add('hidden');
    downloadLink.classList.add('hidden');
    renderStatusEl.textContent = '';
    progressBar.value = 0;
    progressBar.classList.remove('hidden');
    fileInput.disabled = true;
    loadStatusEl.textContent = '読み込み中…';

    try {
      const decoded = await decodeAudioFromFile(file, (msg) => { loadStatusEl.textContent = msg; });
      const mono = downmixToMono(decoded);

      state.sampleRate = decoded.sampleRate;
      state.samples = mono;
      state.duration = mono.length / decoded.sampleRate;

      originalAudio.src = URL.createObjectURL(encodeMonoWav(mono, decoded.sampleRate));
      originalAudio.classList.remove('hidden');

      loadStatusEl.textContent = 'ピッチを解析中…';
      const { contour, hop } = await analyzePitchContour(mono, decoded.sampleRate, (p) => {
        progressBar.value = p;
      });

      const segments = window.PitchEditorCore.segmentPitchContour(contour, {
        minDuration: 0.06,
        frameDuration: hop / decoded.sampleRate,
      }).map((s) => ({ ...s, targetMidi: s.originalMidi }));

      state.segments = segments;
      state.hZoom = 1;
      state.vZoom = 1;

      progressBar.classList.add('hidden');
      loadStatusEl.textContent = segments.length
        ? `解析完了: ${segments.length}個の音符を検出しました。ドラッグしてピッチを編集できます。`
        : '解析完了しましたが、はっきりした音程を検出できませんでした。';

      editorSection.classList.remove('hidden');
      layoutCanvases();
      redraw();
      drawWaveformIfReady();

      // Minimal read-only debug surface, used by automated tests to locate
      // note blocks on the canvas without hardcoding layout assumptions.
      window.PitchEditorDebug = {
        getSegments: () => state.segments.map((s) => ({ ...s })),
        getMidiRange: () => ({ min: state.midiMin, max: state.midiMax }),
        getPixelsPerSecond: () => state.pixelsPerSecond,
        getPixelsPerSemitone: () => state.pixelsPerSemitone,
        getZoom: () => ({ h: state.hZoom, v: state.vZoom }),
        isFullscreen: () => state.isFullscreen,
        midiToY,
        timeToX,
      };
    } catch (err) {
      loadStatusEl.textContent = '読み込みに失敗しました: ' + (err && err.message ? err.message : err);
      progressBar.classList.add('hidden');
    } finally {
      fileInput.disabled = false;
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
