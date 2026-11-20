// Synthetic 3DS music for tests (test/rommusic.test.mjs): BCSTM streams (DSP-ADPCM or PCM16) with a reference decoder
// written straight from the format description, a BCSAR with stream sounds, ADTS frames, a .cia around an NCCH.

const w16 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >> 8) & 0xff;
};
const w32 = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
};
const ascii = (b, o, s) => {
  for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i);
};

/** A small deterministic random generator (tests must not depend on Math.random). */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/** DSP-ADPCM, decoded the plain way (one frame = header byte + 7 bytes of nibbles, high nibble first). */
export function refDsp(bytes, coefs, hist, n) {
  const out = new Int16Array(n);
  let [y1, y2] = hist;
  let w = 0;
  for (let p = 0; w < n; p += 8) {
    const pred = bytes[p] >> 4;
    const scale = 2 ** (bytes[p] & 15);
    for (let k = 0; k < 14 && w < n; k++) {
      const byte = bytes[p + 1 + Math.floor(k / 2)];
      let nib = k % 2 === 0 ? byte >> 4 : byte & 15;
      if (nib > 7) nib -= 16;
      let v = Math.floor((nib * scale * 2048 + 1024 + coefs[pred * 2] * y1 + coefs[pred * 2 + 1] * y2) / 2048);
      v = Math.max(-32768, Math.min(32767, v));
      y2 = y1;
      y1 = v;
      out[w++] = v;
    }
  }
  return { out, hist: [y1, y2] };
}

/**
 * A BCSTM: `channels`, `rate`, `blocks` blocks of `blockSamples` (a multiple of 14), the last `lastSamples` long,
 * DSP-ADPCM with random frames (seeded) or PCM16 (`format: 'pcm16'`, samples from `pcm(c, i)`), a loop. Returns
 * { file, decoded: Int16Array per channel (the reference decode), info: what the parser must find }.
 */
export function makeCstm({ channels = 2, rate = 32728, blockSamples = 14 * 64, blocks = 6, lastSamples = 14 * 20, loop = 'auto', format = 'dsp', seed = 7, pcm = null, seek = true } = {}) {
  const r = rng(seed);
  const samples = (blocks - 1) * blockSamples + lastSamples;
  if (loop === 'auto') loop = { start: blockSamples * 2 + 70, end: samples };
  const dsp = format === 'dsp';
  const bytesFor = (n) => (dsp ? Math.ceil(n / 14) * 8 : n * 2);
  const blockSize = bytesFor(blockSamples);
  const lastSize = bytesFor(lastSamples);
  const lastPadded = Math.ceil(lastSize / 32) * 32;
  // coefficients like real ones: a stable second-order predictor per index
  const coefs = Array.from({ length: channels }, () => {
    const k = new Int16Array(16);
    for (let i = 0; i < 8; i++) {
      k[i * 2] = Math.round((0.5 + r()) * 2048);
      k[i * 2 + 1] = Math.round((-0.6 * r()) * 2048);
    }
    return k;
  });
  const hist0 = Array.from({ length: channels }, () => [Math.round((r() - 0.5) * 2000), Math.round((r() - 0.5) * 2000)]);
  // channel data per block
  const data = [];
  const decoded = Array.from({ length: channels }, () => new Int16Array(samples));
  const seekHist = [];
  const hist = hist0.map((h) => [...h]);
  for (let i = 0; i < blocks; i++) {
    const n = i === blocks - 1 ? lastSamples : blockSamples;
    const row = [];
    const sh = [];
    for (let c = 0; c < channels; c++) {
      const b = new Uint8Array(i === blocks - 1 ? lastPadded : blockSize);
      if (dsp) {
        for (let f = 0; f < Math.ceil(n / 14); f++) {
          b[f * 8] = (Math.floor(r() * 8) << 4) | Math.floor(r() * 10);
          for (let k = 1; k < 8; k++) b[f * 8 + k] = Math.floor(r() * 256);
        }
        sh.push([...hist[c]]);
        const d = refDsp(b, coefs[c], hist[c], n);
        decoded[c].set(d.out, i * blockSamples);
        hist[c] = d.hist;
      } else {
        for (let k = 0; k < n; k++) {
          const v = pcm ? pcm(c, i * blockSamples + k) : Math.round((r() - 0.5) * 60000);
          w16(b, k * 2, v);
          decoded[c][i * blockSamples + k] = v;
        }
      }
      row.push(b);
    }
    data.push(row);
    seekHist.push(sh);
  }
  // layout: header 0x40, INFO, SEEK, DATA
  const infoAt = 0x40;
  const si = infoAt + 8 + 0x18; // stream info right after the three references
  const chTable = si + 0x38;
  const chInfo = chTable + 4 + channels * 8;
  const dspInfo = chInfo + channels * 8;
  const infoEnd = Math.ceil((dspInfo + channels * 0x2e) / 32) * 32;
  const seekAt = infoEnd;
  const seekLen = 8 + blocks * channels * 4;
  const dataAt = Math.ceil((seekAt + seekLen) / 32) * 32;
  const sampleOff = 0x18; // from DATA + 8 (0x20 into the block: aligned)
  const dataLen = 8 + sampleOff + (blocks - 1) * blockSize * channels + lastPadded * channels;
  const file = new Uint8Array(dataAt + dataLen);
  ascii(file, 0, 'CSTM');
  w16(file, 4, 0xfeff);
  w16(file, 6, 0x40);
  w32(file, 8, 0x02030100);
  w32(file, 12, file.length);
  w16(file, 0x10, 3);
  const ref = (o, type, off, size) => {
    w16(file, o, type);
    w32(file, o + 4, off);
    w32(file, o + 8, size);
  };
  ref(0x14, 0x4000, infoAt, infoEnd - infoAt);
  ref(0x20, 0x4001, seek ? seekAt : 0xffffffff, seek ? seekLen : 0);
  ref(0x2c, 0x4002, dataAt, dataLen);
  ascii(file, infoAt, 'INFO');
  w32(file, infoAt + 4, infoEnd - infoAt);
  const body = infoAt + 8;
  w16(file, body, 0x4100);
  w32(file, body + 4, si - body);
  w16(file, body + 8, 0);
  w32(file, body + 12, 0xffffffff); // no track info
  w16(file, body + 16, 0x0101);
  w32(file, body + 20, chTable - body);
  file[si] = dsp ? 2 : 1;
  file[si + 1] = loop ? 1 : 0;
  file[si + 2] = channels;
  w32(file, si + 4, rate);
  w32(file, si + 8, loop ? loop.start : 0);
  w32(file, si + 0x0c, loop ? loop.end : samples); // (the stream's length: the loop end when it loops)
  w32(file, si + 0x10, blocks);
  w32(file, si + 0x14, blockSize);
  w32(file, si + 0x18, blockSamples);
  w32(file, si + 0x1c, lastSize);
  w32(file, si + 0x20, lastSamples);
  w32(file, si + 0x24, lastPadded);
  w32(file, si + 0x28, 4);
  w32(file, si + 0x2c, blockSamples);
  w16(file, si + 0x30, 0x1f00);
  w32(file, si + 0x34, sampleOff);
  w32(file, chTable, channels);
  for (let c = 0; c < channels; c++) {
    w16(file, chTable + 4 + c * 8, 0x4102);
    w32(file, chTable + 4 + c * 8 + 4, chInfo + c * 8 - chTable);
    w16(file, chInfo + c * 8, dsp ? 0x0300 : 0);
    w32(file, chInfo + c * 8 + 4, dsp ? dspInfo + c * 0x2e - (chInfo + c * 8) : 0xffffffff);
    if (dsp) {
      for (let i = 0; i < 16; i++) w16(file, dspInfo + c * 0x2e + i * 2, coefs[c][i]);
      w16(file, dspInfo + c * 0x2e + 0x22, hist0[c][0]);
      w16(file, dspInfo + c * 0x2e + 0x24, hist0[c][1]);
    }
  }
  if (seek) {
    ascii(file, seekAt, 'SEEK');
    w32(file, seekAt + 4, seekLen);
    for (let i = 0; i < blocks; i++) for (let c = 0; c < channels; c++) {
      const h = dsp ? seekHist[i][c] : [0, 0];
      w16(file, seekAt + 8 + (i * channels + c) * 4, h[0]);
      w16(file, seekAt + 8 + (i * channels + c) * 4 + 2, h[1]);
    }
  }
  ascii(file, dataAt, 'DATA');
  w32(file, dataAt + 4, dataLen);
  const first = dataAt + 8 + sampleOff;
  for (let i = 0; i < blocks; i++) for (let c = 0; c < channels; c++) file.set(data[i][c], first + i * blockSize * channels + c * (i === blocks - 1 ? lastPadded : blockSize));
  const samplesField = loop ? loop.end : samples;
  return { file, decoded, info: { channels, rate, samples: samplesField, blockSize, blockSamples, blocks, dataStart: first, loop } };
}

/**
 * A BCSAR with stream sounds (X/Y's layout): [{ path, loop: { start, end } | null, name }] – their files external
 * ("stream/…"), the sound and file tables in INFO, labels in STRG (`strings: false`: none, as Sun's archive).
 */
export function makeBcsar(sounds, { strings = true, extraSeq = 2 } = {}) {
  const parts = [];
  // INFO body: refs → sound table (0x2100), file table (0x2106)
  const nSounds = extraSeq + sounds.length; // a few non-stream sounds first (sequences: type 0x2203)
  const info = new Uint8Array(0x10000);
  const body = 8;
  let o = body + 8 * 8;
  const soundTable = o;
  o += 4 + nSounds * 8;
  const fileTable = o;
  o += 4 + (sounds.length + 1) * 8;
  w16(info, body, 0x2100);
  w32(info, body + 4, soundTable - body);
  w16(info, body + 8, 0x2106);
  w32(info, body + 12, fileTable - body);
  w32(info, soundTable, nSounds);
  w32(info, fileTable, sounds.length + 1);
  // file 0: an internal one (a wave archive) – not a stream
  const f0 = o;
  w16(info, f0, 0x220c);
  w32(info, f0 + 4, 8);
  o += 16;
  w16(info, fileTable + 4, 0x220d);
  w32(info, fileTable + 8, f0 - fileTable);
  sounds.forEach((s, i) => {
    const e = o;
    w16(info, e, 0x220d);
    w32(info, e + 4, 8);
    ascii(info, e + 8, s.path);
    o = Math.ceil((e + 8 + s.path.length + 1) / 4) * 4;
    w16(info, fileTable + 4 + (i + 1) * 8, 0x220d);
    w32(info, fileTable + 4 + (i + 1) * 8 + 4, e - fileTable);
  });
  for (let i = 0; i < nSounds; i++) {
    const e = o;
    const stream = i >= extraSeq;
    const s = stream ? sounds[i - extraSeq] : null;
    w32(info, e, stream ? i - extraSeq + 1 : 0);
    w32(info, e + 4, 0);
    info[e + 8] = 100;
    w16(info, e + 0x0c, stream ? 0x2201 : 0x2203);
    w32(info, e + 0x10, 0x3c);
    const ss = e + 0x3c;
    if (stream) {
      if (s.loop) {
        w32(info, ss + 0x14, s.loop.start);
        w32(info, ss + 0x18, s.loop.end);
        w32(info, ss + 0x1c, 1);
      } else {
        w32(info, ss + 0x14, 1); // (the next reference there, as X/Y's non-looping sounds have it)
        w32(info, ss + 0x18, 0x220e);
        w32(info, ss + 0x1c, 1);
      }
    }
    o = ss + 0x40;
    w16(info, soundTable + 4 + i * 8, 0x2200);
    w32(info, soundTable + 4 + i * 8 + 4, e - soundTable);
  }
  const infoLen = Math.ceil(o / 4) * 4;
  ascii(info, 0, 'INFO');
  w32(info, 4, infoLen);
  parts.push(info.subarray(0, infoLen));
  // STRG: labels in sound order
  let strg = null;
  if (strings) {
    const names = [...Array(extraSeq)].map((_, i) => `SEQ_${i}`).concat(sounds.map((s) => s.name || ''));
    strg = new Uint8Array(0x10000);
    const sb = 8;
    w16(strg, sb, 0x2400);
    w32(strg, sb + 4, 0x10);
    const t = sb + 0x10;
    w32(strg, t, names.length);
    let so = 4 + names.length * 12;
    names.forEach((n, i) => {
      w16(strg, t + 4 + i * 12, 0x1f01);
      w32(strg, t + 4 + i * 12 + 4, so);
      w32(strg, t + 4 + i * 12 + 8, n.length + 1);
      ascii(strg, t + so, n);
      so += n.length + 1;
    });
    const len = Math.ceil((t + so) / 4) * 4;
    ascii(strg, 0, 'STRG');
    w32(strg, 4, len);
    strg = strg.subarray(0, len);
  }
  const head = 0x40;
  const strgAt = head;
  const infoAt = strg ? strgAt + strg.length : head;
  const fileAt = infoAt + infoLen;
  const out = new Uint8Array(fileAt + 0x40);
  ascii(out, 0, 'CSAR');
  w16(out, 4, 0xfeff);
  w16(out, 6, 0x40);
  w32(out, 12, out.length);
  w16(out, 0x10, 3);
  const ref = (k, type, off, size) => {
    w16(out, 0x14 + k * 12, type);
    w32(out, 0x18 + k * 12, off);
    w32(out, 0x1c + k * 12, size);
  };
  ref(0, 0x2000, strg ? strgAt : 0xffffffff, strg ? strg.length : 0xffffffff);
  ref(1, 0x2001, infoAt, infoLen);
  ref(2, 0x2002, fileAt, 0x40);
  if (strg) out.set(strg, strgAt);
  out.set(info.subarray(0, infoLen), infoAt);
  ascii(out, fileAt, 'FILE');
  return out;
}

/** ADTS AAC-LC frames (random payloads – only the headers matter here): `frames` of the given byte lengths. */
export function makeAdts(lengths, { rate = 48000, channels = 2 } = {}) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const total = lengths.reduce((a, b) => a + b, 0);
  const b = new Uint8Array(total);
  let o = 0;
  for (const len of lengths) {
    b[o] = 0xff;
    b[o + 1] = 0xf1; // MPEG-4, layer 0, no CRC
    b[o + 2] = (1 << 6) | (rates.indexOf(rate) << 2) | (channels >> 2); // profile LC (1 = profile 2 − 1)
    b[o + 3] = ((channels & 3) << 6) | ((len >> 11) & 3);
    b[o + 4] = (len >> 3) & 0xff;
    b[o + 5] = ((len & 7) << 5) | 0x1f;
    b[o + 6] = 0xfc; // one raw data block
    for (let k = 7; k < len; k++) b[o + k] = (k * 37) & 0xff;
    o += len;
  }
  return b;
}

/** A .cia around an NCCH (content 0 unencrypted): header, certs, ticket, TMD (RSA-2048), the NCCH, a meta block. */
export function ciaAround(ncch) {
  const align = (n) => Math.ceil(n / 64) * 64;
  const certSize = 0xa00;
  const ticketSize = 0x350;
  const tmdSize = 0x140 + 0xc4 + 0x900 + 0x30;
  const tmdOff = align(0x2020) + align(certSize) + align(ticketSize);
  const contentOff = tmdOff + align(tmdSize);
  const b = new Uint8Array(contentOff + align(ncch.length) + 0x3ac0);
  w32(b, 0, 0x2020);
  w32(b, 0x08, certSize);
  w32(b, 0x0c, ticketSize);
  w32(b, 0x10, tmdSize);
  w32(b, 0x14, 0x3ac0); // a meta block (after the contents)
  b[tmdOff] = 0x00;
  b[tmdOff + 1] = 0x01;
  b[tmdOff + 2] = 0x00;
  b[tmdOff + 3] = 0x04; // RSA-2048 SHA-256
  b.set(ncch, contentOff);
  return b;
}
