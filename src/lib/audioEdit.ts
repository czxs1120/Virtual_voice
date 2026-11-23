/** Per-bucket min/max of the first channel, for drawing a waveform. */
export function computePeaks(buffer: AudioBuffer, buckets: number): Float32Array {
  const data = buffer.getChannelData(0);
  const out = new Float32Array(buckets * 2);
  const step = data.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * step);
    const end = Math.min(data.length, Math.max(start + 1, Math.floor((b + 1) * step)));
    let min = 1;
    let max = -1;
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

/**
 * Find where audible content starts/ends (in seconds), using a short-window
 * RMS against `thresholdDb`. Pads both ends so word onsets aren't clipped.
 */
export function detectSilenceBounds(
  buffer: AudioBuffer,
  thresholdDb = -45,
  padSeconds = 0.08,
): { start: number; end: number } {
  const sr = buffer.sampleRate;
  const win = Math.max(1, Math.floor(sr * 0.01));
  const threshold = Math.pow(10, thresholdDb / 20);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
    buffer.getChannelData(c),
  );
  const frames = buffer.length;

  const rmsAt = (offset: number) => {
    let sum = 0;
    let n = 0;
    for (const ch of channels) {
      for (let i = offset; i < Math.min(frames, offset + win); i++) {
        sum += ch[i] * ch[i];
        n++;
      }
    }
    return n ? Math.sqrt(sum / n) : 0;
  };

  let first = -1;
  for (let o = 0; o < frames; o += win) {
    if (rmsAt(o) >= threshold) {
      first = o;
      break;
    }
  }
  if (first < 0) return { start: 0, end: buffer.duration };

  let last = first;
  for (let o = frames - win; o >= first; o -= win) {
    if (rmsAt(o) >= threshold) {
      last = o + win;
      break;
    }
  }

  return {
    start: Math.max(0, first / sr - padSeconds),
    end: Math.min(buffer.duration, last / sr + padSeconds),
  };
}

export function sliceBuffer(buffer: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
  const sr = buffer.sampleRate;
  const from = Math.max(0, Math.floor(startSec * sr));
  const to = Math.min(buffer.length, Math.ceil(endSec * sr));
  const length = Math.max(1, to - from);
  const out = new AudioBuffer({
    length,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: sr,
  });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(buffer.getChannelData(c).subarray(from, from + length), c);
  }
  return out;
}
