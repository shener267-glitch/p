(function () {
  'use strict';

  const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  const SCALES = {
    chromatic: { label: 'クロマチック（半音・ロボ声向き）', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    major: { label: 'メジャー', intervals: [0, 2, 4, 5, 7, 9, 11] },
    minor: { label: 'ナチュラルマイナー', intervals: [0, 2, 3, 5, 7, 8, 10] },
    majorPenta: { label: 'メジャーペンタトニック', intervals: [0, 2, 4, 7, 9] },
    minorPenta: { label: 'マイナーペンタトニック', intervals: [0, 3, 5, 7, 10] },
  };

  const el = (id) => document.getElementById(id);

  const toggleBtn = el('toggleBtn');
  const statusText = el('statusText');
  const unsupportedText = el('unsupportedText');
  const keySelect = el('keySelect');
  const scaleSelect = el('scaleSelect');
  const correctionSlider = el('correctionSlider');
  const correctionValue = el('correctionValue');
  const speedSlider = el('speedSlider');
  const speedValue = el('speedValue');
  const volumeSlider = el('volumeSlider');
  const volumeValue = el('volumeValue');
  const qualitySelect = el('qualitySelect');
  const bypassToggle = el('bypassToggle');
  const detectedNoteEl = el('detectedNote');
  const targetNoteEl = el('targetNote');
  const meterCanvas = el('meterCanvas');
  const installHint = el('installHint');
  const meterCtx = meterCanvas.getContext('2d');

  // ---- Populate selects -------------------------------------------------
  KEYS.forEach((k) => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = k;
    if (k === 'C') opt.selected = true;
    keySelect.appendChild(opt);
  });

  Object.keys(SCALES).forEach((id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = SCALES[id].label;
    if (id === 'major') opt.selected = true;
    scaleSelect.appendChild(opt);
  });

  // ---- Feature detection --------------------------------------------------
  const hasGetUserMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const hasAudioWorklet = !!(window.AudioContext || window.webkitAudioContext) &&
    !!(window.AudioWorkletNode);

  if (!hasGetUserMedia || !hasAudioWorklet) {
    unsupportedText.classList.remove('hidden');
    toggleBtn.disabled = true;
    toggleBtn.textContent = '利用不可';
  }

  // ---- Audio graph state --------------------------------------------------
  let audioCtx = null;
  let micStream = null;
  let sourceNode = null;
  let workletNode = null;
  let gainNode = null;
  let running = false;
  let meterState = { voiced: false, cents: 0 };
  let meterAnimHandle = null;

  function midiToNoteName(midi) {
    const rounded = Math.round(midi);
    const name = KEYS[((rounded % 12) + 12) % 12];
    const octave = Math.floor(rounded / 12) - 1;
    return name + octave;
  }

  function sendParams() {
    if (!workletNode) return;
    workletNode.port.postMessage({
      type: 'params',
      value: {
        key: KEYS.indexOf(keySelect.value),
        scaleIntervals: SCALES[scaleSelect.value].intervals,
        correction: parseInt(correctionSlider.value, 10) / 100,
        retuneSpeed: parseInt(speedSlider.value, 10) / 100,
        bypass: bypassToggle.checked,
      },
    });
  }

  function updateGain() {
    if (gainNode) {
      gainNode.gain.value = parseInt(volumeSlider.value, 10) / 100;
    }
  }

  async function start() {
    toggleBtn.disabled = true;
    statusText.textContent = 'マイクへのアクセスを確認中…';
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      statusText.textContent = 'マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。';
      toggleBtn.disabled = false;
      return;
    }

    try {
      const AudioCtxCtor = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AudioCtxCtor();
      await audioCtx.audioWorklet.addModule('js/pitch-worklet.js');

      sourceNode = audioCtx.createMediaStreamSource(micStream);
      workletNode = new AudioWorkletNode(audioCtx, 'pitch-correction-processor', {
        processorOptions: { quality: qualitySelect.value },
      });
      workletNode.port.onmessage = (e) => {
        if (e.data && e.data.type === 'pitch') onPitchReport(e.data);
      };

      gainNode = audioCtx.createGain();
      updateGain();

      sourceNode.connect(workletNode);
      workletNode.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      sendParams();

      running = true;
      toggleBtn.textContent = 'マイク停止';
      toggleBtn.classList.add('running');
      statusText.textContent = '動作中（イヤホン推奨）';
      qualitySelect.disabled = true;
      startMeterLoop();
    } catch (err) {
      statusText.textContent = '初期化に失敗しました: ' + (err && err.message ? err.message : err);
      cleanup();
    } finally {
      toggleBtn.disabled = false;
    }
  }

  function cleanup() {
    if (sourceNode) { try { sourceNode.disconnect(); } catch (e) {} }
    if (workletNode) { try { workletNode.disconnect(); } catch (e) {} }
    if (gainNode) { try { gainNode.disconnect(); } catch (e) {} }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
    sourceNode = null;
    workletNode = null;
    gainNode = null;
    micStream = null;
    audioCtx = null;
  }

  function stop() {
    cleanup();
    running = false;
    toggleBtn.textContent = 'マイク開始';
    toggleBtn.classList.remove('running');
    statusText.textContent = '待機中';
    qualitySelect.disabled = false;
    meterState = { voiced: false, cents: 0 };
    stopMeterLoop();
    drawMeter();
    detectedNoteEl.textContent = '—';
    targetNoteEl.textContent = '—';
  }

  function onPitchReport(data) {
    if (data.voiced) {
      meterState = {
        voiced: true,
        cents: Math.max(-50, Math.min(50, data.cents || 0)),
      };
      detectedNoteEl.textContent = midiToNoteName(data.sourceMidi);
      targetNoteEl.textContent = midiToNoteName(data.targetMidi);
    } else {
      meterState = { voiced: false, cents: 0 };
      detectedNoteEl.textContent = '—';
      targetNoteEl.textContent = '—';
    }
  }

  function startMeterLoop() {
    const loop = () => {
      drawMeter();
      meterAnimHandle = requestAnimationFrame(loop);
    };
    meterAnimHandle = requestAnimationFrame(loop);
  }

  function stopMeterLoop() {
    if (meterAnimHandle) cancelAnimationFrame(meterAnimHandle);
    meterAnimHandle = null;
  }

  function drawMeter() {
    const w = meterCanvas.width;
    const h = meterCanvas.height;
    const ctx = meterCtx;
    ctx.clearRect(0, 0, w, h);

    const midY = h / 2;

    // Background zones
    ctx.fillStyle = '#12151c';
    ctx.fillRect(0, 0, w, h);

    // Center "in tune" band (+-10 cents)
    const bandHalfWidth = (w / 2) * (10 / 50);
    ctx.fillStyle = 'rgba(55, 197, 138, 0.18)';
    ctx.fillRect(w / 2 - bandHalfWidth, 0, bandHalfWidth * 2, h);

    // Center line
    ctx.strokeStyle = '#3a4152';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();

    // Tick marks at +-25, +-50 cents
    ctx.strokeStyle = '#262b36';
    [-50, -25, 25, 50].forEach((c) => {
      const x = w / 2 + (c / 50) * (w / 2);
      ctx.beginPath();
      ctx.moveTo(x, h * 0.3);
      ctx.lineTo(x, h * 0.7);
      ctx.stroke();
    });

    if (meterState.voiced) {
      const x = w / 2 + (meterState.cents / 50) * (w / 2);
      const inTune = Math.abs(meterState.cents) <= 10;
      ctx.fillStyle = inTune ? '#37c58a' : '#e0556f';
      ctx.beginPath();
      ctx.arc(x, midY, 10, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = ctx.fillStyle;
      ctx.fillRect(Math.min(x, w / 2), midY - 3, Math.abs(x - w / 2), 6);
    } else {
      ctx.fillStyle = '#4a5165';
      ctx.beginPath();
      ctx.arc(w / 2, midY, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- Event wiring ---------------------------------------------------
  toggleBtn.addEventListener('click', () => {
    if (running) stop();
    else start();
  });

  [keySelect, scaleSelect, bypassToggle].forEach((elm) => {
    elm.addEventListener('change', sendParams);
  });

  correctionSlider.addEventListener('input', () => {
    correctionValue.textContent = correctionSlider.value + '%';
    sendParams();
  });
  speedSlider.addEventListener('input', () => {
    speedValue.textContent = speedSlider.value + '%';
    sendParams();
  });
  volumeSlider.addEventListener('input', () => {
    volumeValue.textContent = volumeSlider.value + '%';
    updateGain();
  });

  window.addEventListener('pagehide', () => {
    if (running) stop();
  });

  // ---- PWA install hint / service worker -------------------------------
  if (window.matchMedia && !window.matchMedia('(display-mode: standalone)').matches) {
    installHint.classList.remove('hidden');
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  drawMeter();
})();
