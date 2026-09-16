// Pitch correction DSP core + AudioWorkletProcessor.
//
// This file is loaded two ways:
//   1) In the browser, via audioContext.audioWorklet.addModule() as a classic
//      (non-module) worklet script, so it must not use import/export syntax.
//   2) In Node, via require(), for unit-testing the pure DSP pieces
//      (smbFft / PhaseVocoderPitchShifter / YinDetector / nearestScaleFrequency)
//      without needing a browser or the AudioWorkletProcessor global.
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------
  // FFT (in-place, radix-2, interleaved real/imag), based on the classic
  // public-domain smbFft routine by Stephan M. Bernsee.
  // fftBuffer length must be 2 * fftFrameSize (power of two).
  // sign: -1 = forward transform, +1 = inverse transform.
  // ---------------------------------------------------------------------
  function smbFft(fftBuffer, fftFrameSize, sign) {
    const n2 = 2 * fftFrameSize;

    // Bit-reversal permutation.
    let j = 0;
    for (let i = 2; i < n2 - 2; i += 2) {
      let bitm;
      j = 0;
      for (bitm = 2; bitm < n2; bitm <<= 1) {
        if (i & bitm) j++;
        j <<= 1;
      }
      if (i < j) {
        let tmp = fftBuffer[i]; fftBuffer[i] = fftBuffer[j]; fftBuffer[j] = tmp;
        tmp = fftBuffer[i + 1]; fftBuffer[i + 1] = fftBuffer[j + 1]; fftBuffer[j + 1] = tmp;
      }
    }

    const numStages = Math.round(Math.log(fftFrameSize) / Math.LN2);
    let le = 2;
    for (let k = 0; k < numStages; k++) {
      le <<= 1;
      const le2 = le >> 1;
      let ur = 1.0;
      let ui = 0.0;
      const arg = Math.PI / (le2 >> 1);
      const wr = Math.cos(arg);
      const wi = sign * Math.sin(arg);
      for (let jj = 0; jj < le2; jj += 2) {
        let p1r = jj, p1i = jj + 1;
        let p2r = p1r + le2, p2i = p1i + le2;
        for (let i = jj; i < n2; i += le) {
          const tr = fftBuffer[p2r] * ur - fftBuffer[p2i] * ui;
          const ti = fftBuffer[p2r] * ui + fftBuffer[p2i] * ur;
          fftBuffer[p2r] = fftBuffer[p1r] - tr;
          fftBuffer[p2i] = fftBuffer[p1i] - ti;
          fftBuffer[p1r] += tr;
          fftBuffer[p1i] += ti;
          p1r += le; p1i += le;
          p2r += le; p2i += le;
        }
        const tr2 = ur * wr - ui * wi;
        ui = ur * wi + ui * wr;
        ur = tr2;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Phase-vocoder pitch shifter (streaming, block-based).
  // Adapted from Stephan M. Bernsee's public-domain smbPitchShift algorithm.
  // Call process() once per audio block; it maintains all state internally
  // so pitchShift may vary smoothly from call to call.
  // ---------------------------------------------------------------------
  class PhaseVocoderPitchShifter {
    constructor(fftFrameSize, oversampling, sampleRate) {
      this.fftFrameSize = fftFrameSize;
      this.oversampling = oversampling;
      this.sampleRate = sampleRate;
      this.stepSize = fftFrameSize / oversampling;
      this.fftFrameSize2 = fftFrameSize >> 1;
      this.freqPerBin = sampleRate / fftFrameSize;
      this.expct = (2 * Math.PI * this.stepSize) / fftFrameSize;
      this.inFifoLatency = fftFrameSize - this.stepSize;
      this.gRover = this.inFifoLatency;

      this.gInFIFO = new Float32Array(fftFrameSize);
      this.gOutFIFO = new Float32Array(fftFrameSize);
      this.gFFTworksp = new Float32Array(2 * fftFrameSize);
      this.gLastPhase = new Float32Array(this.fftFrameSize2 + 1);
      this.gSumPhase = new Float32Array(this.fftFrameSize2 + 1);
      this.gOutputAccum = new Float32Array(2 * fftFrameSize);
      this.gAnaFreq = new Float32Array(fftFrameSize);
      this.gAnaMagn = new Float32Array(fftFrameSize);
      this.gSynFreq = new Float32Array(fftFrameSize);
      this.gSynMagn = new Float32Array(fftFrameSize);

      this.window = new Float32Array(fftFrameSize);
      for (let k = 0; k < fftFrameSize; k++) {
        this.window[k] = -0.5 * Math.cos((2 * Math.PI * k) / fftFrameSize) + 0.5;
      }
    }

    process(indata, outdata, numSamples, pitchShift) {
      const fftFrameSize = this.fftFrameSize;
      const fftFrameSize2 = this.fftFrameSize2;
      const stepSize = this.stepSize;
      const freqPerBin = this.freqPerBin;
      const expct = this.expct;
      const inFifoLatency = this.inFifoLatency;
      const oversampling = this.oversampling;
      const window = this.window;
      const gInFIFO = this.gInFIFO;
      const gOutFIFO = this.gOutFIFO;
      const gFFTworksp = this.gFFTworksp;
      const gLastPhase = this.gLastPhase;
      const gSumPhase = this.gSumPhase;
      const gOutputAccum = this.gOutputAccum;
      const gAnaFreq = this.gAnaFreq;
      const gAnaMagn = this.gAnaMagn;
      const gSynFreq = this.gSynFreq;
      const gSynMagn = this.gSynMagn;

      for (let i = 0; i < numSamples; i++) {
        gInFIFO[this.gRover] = indata[i];
        outdata[i] = gOutFIFO[this.gRover - inFifoLatency];
        this.gRover++;

        if (this.gRover >= fftFrameSize) {
          this.gRover = inFifoLatency;

          for (let k = 0; k < fftFrameSize; k++) {
            gFFTworksp[2 * k] = gInFIFO[k] * window[k];
            gFFTworksp[2 * k + 1] = 0;
          }

          smbFft(gFFTworksp, fftFrameSize, -1);

          for (let k = 0; k <= fftFrameSize2; k++) {
            const real = gFFTworksp[2 * k];
            const imag = gFFTworksp[2 * k + 1];
            const magn = 2 * Math.sqrt(real * real + imag * imag);
            const phase = Math.atan2(imag, real);

            let tmp = phase - gLastPhase[k];
            gLastPhase[k] = phase;
            tmp -= k * expct;

            let qpd = Math.trunc(tmp / Math.PI);
            if (qpd >= 0) qpd += qpd & 1;
            else qpd -= qpd & 1;
            tmp -= Math.PI * qpd;

            tmp = (oversampling * tmp) / (2 * Math.PI);
            tmp = k * freqPerBin + tmp * freqPerBin;

            gAnaMagn[k] = magn;
            gAnaFreq[k] = tmp;
          }

          for (let k = 0; k <= fftFrameSize2; k++) {
            gSynMagn[k] = 0;
            gSynFreq[k] = 0;
          }
          for (let k = 0; k <= fftFrameSize2; k++) {
            const index = Math.trunc(k * pitchShift);
            if (index <= fftFrameSize2) {
              gSynMagn[index] += gAnaMagn[k];
              gSynFreq[index] = gAnaFreq[k] * pitchShift;
            }
          }

          for (let k = 0; k <= fftFrameSize2; k++) {
            const magn = gSynMagn[k];
            let tmp = gSynFreq[k];
            tmp -= k * freqPerBin;
            tmp /= freqPerBin;
            tmp = (2 * Math.PI * tmp) / oversampling;
            tmp += k * expct;
            gSumPhase[k] += tmp;
            const phase = gSumPhase[k];
            gFFTworksp[2 * k] = magn * Math.cos(phase);
            gFFTworksp[2 * k + 1] = magn * Math.sin(phase);
          }
          for (let k = fftFrameSize + 2; k < 2 * fftFrameSize; k++) gFFTworksp[k] = 0;

          smbFft(gFFTworksp, fftFrameSize, 1);

          for (let k = 0; k < fftFrameSize; k++) {
            gOutputAccum[k] += (2 * window[k] * gFFTworksp[2 * k]) / (fftFrameSize2 * oversampling);
          }
          for (let k = 0; k < stepSize; k++) gOutFIFO[k] = gOutputAccum[k];

          gOutputAccum.copyWithin(0, stepSize, stepSize + fftFrameSize);
          gInFIFO.copyWithin(0, stepSize, fftFrameSize);
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // YIN fundamental-frequency estimator.
  // https://www.ircam.fr/anasyn/roebel/aspSignalProcessingProjects/yin.pdf
  // ---------------------------------------------------------------------
  class YinDetector {
    constructor(bufferSize, sampleRate, threshold) {
      this.bufferSize = bufferSize;
      this.halfBufferSize = bufferSize >> 1;
      this.sampleRate = sampleRate;
      this.threshold = threshold || 0.15;
      this.yinBuffer = new Float32Array(this.halfBufferSize);
    }

    // buffer must have length >= this.bufferSize; only the first bufferSize
    // samples are used. Returns estimated frequency in Hz, or -1 if unvoiced.
    detect(buffer) {
      const halfBufferSize = this.halfBufferSize;
      const yinBuffer = this.yinBuffer;

      yinBuffer[0] = 1;
      let runningSum = 0;
      for (let tau = 1; tau < halfBufferSize; tau++) {
        let sum = 0;
        for (let j = 0; j < halfBufferSize; j++) {
          const delta = buffer[j] - buffer[j + tau];
          sum += delta * delta;
        }
        runningSum += sum;
        yinBuffer[tau] = runningSum === 0 ? 1 : (sum * tau) / runningSum;
      }

      let tauEstimate = -1;
      for (let tau = 2; tau < halfBufferSize; tau++) {
        if (yinBuffer[tau] < this.threshold) {
          while (tau + 1 < halfBufferSize && yinBuffer[tau + 1] < yinBuffer[tau]) {
            tau++;
          }
          tauEstimate = tau;
          break;
        }
      }
      if (tauEstimate === -1) return -1;

      let betterTau;
      const x0 = tauEstimate < 1 ? tauEstimate : tauEstimate - 1;
      const x2 = tauEstimate + 1 < halfBufferSize ? tauEstimate + 1 : tauEstimate;
      if (x0 === tauEstimate) {
        betterTau = yinBuffer[tauEstimate] <= yinBuffer[x2] ? tauEstimate : x2;
      } else if (x2 === tauEstimate) {
        betterTau = yinBuffer[tauEstimate] <= yinBuffer[x0] ? tauEstimate : x0;
      } else {
        const s0 = yinBuffer[x0], s1 = yinBuffer[tauEstimate], s2 = yinBuffer[x2];
        const denom = 2 * (2 * s1 - s2 - s0);
        betterTau = denom === 0 ? tauEstimate : tauEstimate + (s2 - s0) / denom;
      }
      if (betterTau <= 0) return -1;
      return this.sampleRate / betterTau;
    }
  }

  // ---------------------------------------------------------------------
  // Given a detected frequency, find the nearest note allowed by a musical
  // scale (key + interval set, both in semitones).
  // ---------------------------------------------------------------------
  function nearestScaleFrequency(freq, keySemitone, scaleIntervals) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const allowed = scaleIntervals.map((iv) => (((keySemitone + iv) % 12) + 12) % 12);
    const centerOctaveBase = Math.round(midi / 12) * 12;

    let best = null;
    let bestDist = Infinity;
    for (let oct = centerOctaveBase - 24; oct <= centerOctaveBase + 24; oct += 12) {
      for (let a = 0; a < allowed.length; a++) {
        const candidate = oct + allowed[a];
        const dist = Math.abs(candidate - midi);
        if (dist < bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }
    }
    const targetFreq = 440 * Math.pow(2, (best - 69) / 12);
    return { targetMidi: best, targetFreq, sourceMidi: midi };
  }

  const DSP = { smbFft, PhaseVocoderPitchShifter, YinDetector, nearestScaleFrequency };

  // Expose for Node-based unit testing.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DSP;
  }
  // Expose on global scope too (useful for quick manual testing in a browser tab).
  if (global) global.PitchCorrectionDSP = DSP;

  // ---------------------------------------------------------------------
  // AudioWorkletProcessor wrapper. Only defined inside an AudioWorklet
  // global scope (absent in Node / normal window scope).
  // ---------------------------------------------------------------------
  if (typeof AudioWorkletProcessor !== 'undefined') {
    class PitchCorrectionProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        const sr = sampleRate; // AudioWorkletGlobalScope global
        const opts = (options && options.processorOptions) || {};
        const light = opts.quality === 'light';

        this.analysisBufferSize = light ? 800 : 1024;
        this.detectInterval = 512;
        this.samplesSinceDetect = 0;
        this._win = new Float32Array(this.analysisBufferSize);

        this.yin = new YinDetector(this.analysisBufferSize, sr, 0.15);

        this.fftFrameSize = 1024;
        this.oversampling = light ? 4 : 8;
        this.shifter = new PhaseVocoderPitchShifter(this.fftFrameSize, this.oversampling, sr);

        this.params = {
          key: 0,
          scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
          correction: 1.0,
          retuneSpeed: 0.4,
          bypass: false,
        };

        this.smoothedRatio = 1.0;
        this.reportCounter = 0;
        this.silenceRms = 0.008;

        this.port.onmessage = (e) => {
          if (e.data && e.data.type === 'params') {
            Object.assign(this.params, e.data.value);
          }
        };
      }

      _pushRing(inputChannel) {
        const N = inputChannel.length;
        const size = this.analysisBufferSize;
        const win = this._win;
        if (N >= size) {
          win.set(inputChannel.subarray(N - size));
        } else {
          win.copyWithin(0, N, size);
          win.set(inputChannel, size - N);
        }
      }

      process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || !output[0]) return true;
        const outCh = output[0];

        if (!input || !input[0]) {
          outCh.fill(0);
          return true;
        }
        const inCh = input[0];
        const N = inCh.length;

        this._pushRing(inCh);
        this.samplesSinceDetect += N;

        if (this.samplesSinceDetect >= this.detectInterval) {
          this.samplesSinceDetect = 0;

          let rms = 0;
          for (let i = 0; i < this._win.length; i++) rms += this._win[i] * this._win[i];
          rms = Math.sqrt(rms / this._win.length);

          let f0 = -1;
          if (rms > this.silenceRms) {
            f0 = this.yin.detect(this._win);
          }

          let targetRatio = 1.0;
          let reportPayload = { voiced: false };

          if (f0 > 0) {
            const { targetMidi, targetFreq, sourceMidi } = nearestScaleFrequency(
              f0,
              this.params.key,
              this.params.scaleIntervals
            );
            const idealRatio = targetFreq / f0;
            targetRatio = 1 + this.params.correction * (idealRatio - 1);
            targetRatio = Math.max(0.5, Math.min(2.0, targetRatio));
            reportPayload = {
              voiced: true,
              f0,
              sourceMidi,
              targetMidi,
              targetFreq,
              cents: 1200 * Math.log2(targetFreq / f0),
            };
          }

          const speed = this.params.retuneSpeed;
          const alpha = 0.05 + speed * 0.9;
          this.smoothedRatio += (targetRatio - this.smoothedRatio) * alpha;

          this.reportCounter++;
          if (this.reportCounter >= 4) {
            this.reportCounter = 0;
            this.port.postMessage(Object.assign({ type: 'pitch', ratio: this.smoothedRatio }, reportPayload));
          }
        }

        if (this.params.bypass) {
          outCh.set(inCh);
        } else {
          this.shifter.process(inCh, outCh, N, this.smoothedRatio);
        }

        return true;
      }
    }

    registerProcessor('pitch-correction-processor', PitchCorrectionProcessor);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
