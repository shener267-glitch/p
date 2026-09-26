(function (global) {
  'use strict';

  // =======================================================================
  // Standard MIDI File (SMF) parser — pure logic, no DOM. Extracts a
  // per-track list of {startTime, endTime, midi} notes in real seconds,
  // resolving the file's tempo map (only PPQN division is supported; SMPTE
  // time-code division is rare in practice for exported backing tracks and
  // is rejected with a clear error instead of silently misreading times).
  // =======================================================================

  const DRUM_CHANNEL = 9; // General MIDI: channel 10 (0-indexed 9) is percussion

  function readVarLen(bytes, pos) {
    let value = 0;
    let b;
    do {
      b = bytes[pos.i++];
      value = (value << 7) | (b & 0x7f);
    } while (b & 0x80);
    return value >>> 0;
  }

  function readUint32(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function readUint16(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
  }

  function readChunkId(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  // Parses raw SMF bytes into { division, tracks: [{ rawEvents, channelOfNotes }] }
  // where rawEvents is a flat list of { absTick, type, channel, note, velocity }
  // (type: 'noteOn' | 'noteOff' | 'tempo', tempo events carry `microsecondsPerQuarter`).
  function parseRawEvents(bytes) {
    if (readChunkId(bytes, 0) !== 'MThd') throw new Error('MThdヘッダーが見つかりません（MIDIファイルではない可能性があります）');
    const headerLen = readUint32(bytes, 4);
    const format = readUint16(bytes, 8);
    const numTracks = readUint16(bytes, 10);
    const division = readUint16(bytes, 12);
    if (division & 0x8000) {
      throw new Error('SMPTEタイムコード形式のMIDIファイルには対応していません');
    }

    let offset = 8 + headerLen;
    const tracks = [];

    for (let t = 0; t < numTracks && offset < bytes.length; t++) {
      const chunkId = readChunkId(bytes, offset);
      const chunkLen = readUint32(bytes, offset + 4);
      const trackStart = offset + 8;
      const trackEnd = trackStart + chunkLen;
      if (chunkId !== 'MTrk') {
        offset = trackEnd;
        continue;
      }

      const pos = { i: trackStart };
      let absTick = 0;
      let runningStatus = null;
      const events = [];

      while (pos.i < trackEnd) {
        const delta = readVarLen(bytes, pos);
        absTick += delta;

        let statusByte = bytes[pos.i];
        if (statusByte & 0x80) {
          pos.i++;
          if (statusByte < 0xf0) runningStatus = statusByte;
        } else {
          statusByte = runningStatus; // running status: reuse previous status byte
        }

        if (statusByte === 0xff) {
          const metaType = bytes[pos.i++];
          const len = readVarLen(bytes, pos);
          if (metaType === 0x51 && len === 3) {
            const mpq = (bytes[pos.i] << 16) | (bytes[pos.i + 1] << 8) | bytes[pos.i + 2];
            events.push({ absTick, type: 'tempo', microsecondsPerQuarter: mpq });
          }
          pos.i += len;
        } else if (statusByte === 0xf0 || statusByte === 0xf7) {
          const len = readVarLen(bytes, pos);
          pos.i += len;
        } else if (statusByte == null) {
          // Malformed stream with no prior status byte to fall back on; bail
          // out of this track rather than reading garbage indefinitely.
          break;
        } else {
          const hi = statusByte & 0xf0;
          const channel = statusByte & 0x0f;
          if (hi === 0x90) {
            const note = bytes[pos.i++];
            const velocity = bytes[pos.i++];
            events.push({ absTick, type: velocity > 0 ? 'noteOn' : 'noteOff', channel, note, velocity });
          } else if (hi === 0x80) {
            const note = bytes[pos.i++];
            const velocity = bytes[pos.i++];
            events.push({ absTick, type: 'noteOff', channel, note, velocity });
          } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
            pos.i += 2; // aftertouch / control change / pitch bend: 2 data bytes
          } else if (hi === 0xc0 || hi === 0xd0) {
            pos.i += 1; // program change / channel pressure: 1 data byte
          } else {
            break; // unrecognized status; stop parsing this track defensively
          }
        }
      }

      tracks.push({ events });
      offset = trackEnd;
    }

    return { division, format, tracks };
  }

  // Builds a tick -> seconds converter from every Set Tempo event across all
  // tracks (SMF ticks are on one global timeline shared by every track, so a
  // tempo change in any track applies to all of them from that tick onward).
  function buildTickToSeconds(tracks, division) {
    const tempoEvents = [];
    for (const track of tracks) {
      for (const ev of track.events) {
        if (ev.type === 'tempo') tempoEvents.push({ tick: ev.absTick, mpq: ev.microsecondsPerQuarter });
      }
    }
    tempoEvents.sort((a, b) => a.tick - b.tick);
    if (tempoEvents.length === 0 || tempoEvents[0].tick > 0) {
      tempoEvents.unshift({ tick: 0, mpq: 500000 }); // default 120 BPM
    }

    return function tickToSeconds(tick) {
      let seconds = 0;
      for (let i = 0; i < tempoEvents.length; i++) {
        const segStart = tempoEvents[i].tick;
        const segEnd = i + 1 < tempoEvents.length ? tempoEvents[i + 1].tick : Infinity;
        if (tick <= segStart) break;
        const segTicks = Math.min(tick, segEnd) - segStart;
        seconds += (segTicks * tempoEvents[i].mpq) / division / 1e6;
        if (tick <= segEnd) break;
      }
      return seconds;
    };
  }

  // Pairs noteOn/noteOff events (FIFO per channel+pitch, so a re-triggered
  // note before its predecessor's release still closes the older one first)
  // into { startTime, endTime, midi } notes in real seconds.
  function extractTrackNotes(track, tickToSeconds) {
    const open = new Map(); // key: channel*128+note -> queue of absTick starts
    const notes = [];
    let channelUsed = null;

    for (const ev of track.events) {
      if (ev.type !== 'noteOn' && ev.type !== 'noteOff') continue;
      const key = ev.channel * 128 + ev.note;
      if (ev.type === 'noteOn') {
        if (!open.has(key)) open.set(key, []);
        open.get(key).push(ev.absTick);
        channelUsed = ev.channel;
      } else {
        const queue = open.get(key);
        if (queue && queue.length) {
          const startTick = queue.shift();
          if (ev.absTick > startTick) {
            notes.push({
              startTime: tickToSeconds(startTick),
              endTime: tickToSeconds(ev.absTick),
              midi: ev.note,
            });
          }
        }
      }
    }
    notes.sort((a, b) => a.startTime - b.startTime);
    return { notes, channel: channelUsed };
  }

  // Heuristic score for "is this track a usable, mostly-monophonic melody in
  // a human vocal range" — used to auto-pick a sensible default track so the
  // user isn't forced to know which track number holds the melody.
  function scoreMelodyTrack(notes) {
    if (notes.length < 3) return -Infinity;
    let overlapCount = 0;
    for (let i = 1; i < notes.length; i++) {
      if (notes[i].startTime < notes[i - 1].endTime - 0.01) overlapCount++;
    }
    const overlapRatio = overlapCount / notes.length;
    let sum = 0;
    for (const n of notes) sum += n.midi;
    const avgMidi = sum / notes.length;
    const inVocalRange = avgMidi >= 40 && avgMidi <= 88;

    let score = notes.length;
    score -= overlapRatio * notes.length * 1.5; // penalize chords/polyphony heavily
    score += inVocalRange ? 20 : 0;
    return score;
  }

  function parseMidiFile(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const { division, tracks: rawTracks } = parseRawEvents(bytes);
    const tickToSeconds = buildTickToSeconds(rawTracks, division);

    const tracks = rawTracks.map((track, index) => {
      const { notes, channel } = extractTrackNotes(track, tickToSeconds);
      return {
        index,
        channel,
        notes,
        noteCount: notes.length,
        isDrumChannel: channel === DRUM_CHANNEL,
        score: channel === DRUM_CHANNEL ? -Infinity : scoreMelodyTrack(notes),
      };
    });

    let bestIndex = -1;
    let bestScore = -Infinity;
    tracks.forEach((t) => {
      if (t.score > bestScore) {
        bestScore = t.score;
        bestIndex = t.index;
      }
    });
    // Fall back to the track with the most notes if nothing scored above the
    // "unusable" floor (e.g. every track is a dense chordal pad).
    if (bestIndex === -1 || bestScore === -Infinity) {
      let maxNotes = -1;
      tracks.forEach((t) => {
        if (!t.isDrumChannel && t.noteCount > maxNotes) {
          maxNotes = t.noteCount;
          bestIndex = t.index;
        }
      });
    }

    return { tracks: tracks.filter((t) => t.noteCount > 0), suggestedTrackIndex: bestIndex };
  }

  const MidiParserAPI = { parseMidiFile };
  if (typeof module !== 'undefined' && module.exports) module.exports = MidiParserAPI;
  if (global) global.MidiParser = MidiParserAPI;
})(typeof globalThis !== 'undefined' ? globalThis : this);
