(function () {
  'use strict';

  const el = (id) => document.getElementById(id);
  const fileInput = el('audioFileInput');
  const fileNameEl = el('audioFileName');
  const processBtn = el('processFileBtn');
  const fileStatusEl = el('fileStatus');
  const previewAudio = el('filePreviewAudio');
  const downloadLink = el('fileDownloadLink');

  if (!fileInput) return; // section not present in the page

  // Extra silent padding (in samples) rendered after the file's own audio so
  // the phase-vocoder pitch shifter's internal FIFO can fully flush its last
  // buffered frames instead of truncating the tail of the corrected audio.
  const TAIL_PAD_SAMPLES = 4096;

  let selectedFile = null;

  const hasOfflineAudio = !!(window.OfflineAudioContext || window.webkitOfflineAudioContext);
  if (!hasOfflineAudio) {
    fileStatusEl.textContent = 'このブラウザはファイルからの補正に対応していません。';
    fileInput.disabled = true;
    processBtn.disabled = true;
    return;
  }

  fileInput.addEventListener('change', () => {
    selectedFile = (fileInput.files && fileInput.files[0]) || null;
    fileNameEl.textContent = selectedFile ? selectedFile.name : '';
    processBtn.disabled = !selectedFile;
    fileStatusEl.textContent = '';
    previewAudio.classList.add('hidden');
    downloadLink.classList.add('hidden');
  });

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  // Encodes a (mono) AudioBuffer as a 16-bit PCM WAV Blob.
  function audioBufferToWavBlob(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numFrames = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const arrBuf = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrBuf);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) channelData.push(buffer.getChannelData(ch));

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channelData[ch][i];
        sample = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([arrBuf], { type: 'audio/wav' });
  }

  function deriveDownloadName(originalName) {
    const dot = originalName.lastIndexOf('.');
    const base = dot > 0 ? originalName.slice(0, dot) : originalName;
    return base + '_corrected.wav';
  }

  async function processSelectedFile() {
    if (!selectedFile) return;
    processBtn.disabled = true;
    fileInput.disabled = true;
    previewAudio.classList.add('hidden');
    downloadLink.classList.add('hidden');
    fileStatusEl.textContent = '読み込み中…';

    let previousUrl = downloadLink.href;

    try {
      const arrayBuffer = await selectedFile.arrayBuffer();
      const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;

      // A minimal offline context is enough to decode; its own render length
      // is irrelevant to decodeAudioData.
      const decodeCtx = new OfflineCtor(1, 1, 44100);
      const decoded = await decodeCtx.decodeAudioData(arrayBuffer);

      fileStatusEl.textContent = '補正処理中…';

      const sr = decoded.sampleRate;
      const renderLength = decoded.length + TAIL_PAD_SAMPLES;
      const renderCtx = new OfflineCtor(1, renderLength, sr);
      await renderCtx.audioWorklet.addModule('js/pitch-worklet.js');

      const source = renderCtx.createBufferSource();
      source.buffer = decoded;

      // Params are passed via processorOptions (available synchronously at
      // construction) rather than postMessage: OfflineAudioContext rendering
      // can begin processing blocks before a same-tick postMessage would be
      // delivered to the processor, which would silently process with the
      // default (unset) params instead of the user's chosen key/scale.
      const workletNode = new AudioWorkletNode(renderCtx, 'pitch-correction-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        outputChannelCount: [1],
        processorOptions: {
          quality: window.PitchApp.getQuality(),
          params: window.PitchApp.getCurrentParams(),
        },
      });

      source.connect(workletNode).connect(renderCtx.destination);
      source.start(0);

      const rendered = await renderCtx.startRendering();

      const blob = audioBufferToWavBlob(rendered);
      const url = URL.createObjectURL(blob);

      previewAudio.src = url;
      previewAudio.classList.remove('hidden');
      downloadLink.href = url;
      downloadLink.download = deriveDownloadName(selectedFile.name);
      downloadLink.classList.remove('hidden');

      if (previousUrl) URL.revokeObjectURL(previousUrl);

      fileStatusEl.textContent = '完了しました。プレビュー再生またはダウンロードできます。';
    } catch (err) {
      fileStatusEl.textContent = '処理に失敗しました: ' + (err && err.message ? err.message : err);
    } finally {
      processBtn.disabled = !selectedFile;
      fileInput.disabled = false;
    }
  }

  processBtn.addEventListener('click', processSelectedFile);
})();
