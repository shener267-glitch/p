// Draws an amplitude-envelope waveform (min/max per pixel column) from a
// Float32Array of mono samples onto a canvas.
(function () {
  'use strict';

  function drawWaveform(canvas, samples, opts) {
    const options = opts || {};
    const color = options.color || 'rgba(154, 163, 178, 0.5)';
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!samples || samples.length === 0) return;

    const mid = h / 2;
    const samplesPerPixel = samples.length / w;
    ctx.fillStyle = color;

    for (let x = 0; x < w; x++) {
      const start = Math.floor(x * samplesPerPixel);
      const end = Math.min(samples.length, Math.floor((x + 1) * samplesPerPixel) || start + 1);
      let min = 1.0;
      let max = -1.0;
      for (let i = start; i < end; i++) {
        const v = samples[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (end <= start) {
        min = samples[start] || 0;
        max = min;
      }
      const y1 = mid - max * mid;
      const y2 = mid - min * mid;
      ctx.fillRect(x, Math.max(0, y1), 1, Math.max(1, y2 - y1));
    }
  }

  const api = { drawWaveform };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Waveform = api;
})();
