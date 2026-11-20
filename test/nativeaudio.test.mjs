// The fast player's / 3DS player's AudioWorklet (web/lib/native-audio-worklet.mjs), run outside a browser: its buffer
// (web/lib/jitterring.mjs – see test/jitterring.test.mjs) with the 3DS page's options, the in-band commands (the 3DS
// host's fast-forward ratio), the tap and the buffer's numbers for the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SR = 32728;
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.posted = [];
    this.port = { postMessage: (m) => this.posted.push(m), onmessage: null };
  }
};
let NativeAudio = null;
globalThis.registerProcessor = (_name, cls) => {
  NativeAudio = cls;
};
await import('../web/lib/native-audio-worklet.mjs');

/** A worklet as a page makes it; `got` collects the commands its mixer receives (in order, with the frame played). */
function worklet(opts = {}) {
  const w = new NativeAudio({ processorOptions: { init: [{ type: 'mode', mode: 'plain' }], ...opts } });
  const got = [];
  const cmd = w.mixer.command.bind(w.mixer);
  w.mixer.command = (m) => {
    got.push({ ...m, at: w.ring.played });
    cmd(m);
  };
  const send = (d) => w.port.onmessage({ data: d });
  /** n frames of a ramp (left = right = start, start+1, … scaled), as the page posts them. */
  const push = (n, start) => {
    const f = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) f[i * 2] = f[i * 2 + 1] = (start + i) / 1e6;
    send(f);
  };
  /** One 128-frame block out. */
  const out = () => {
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    w.process([], [[L, R]]);
    return L;
  };
  return { w, got, send, push, out };
}
const DS = { prime: Math.round(SR * 0.06), primeMax: Math.round(SR * 0.24), trim: Math.round(SR * 0.2), maxLag: Math.round(SR * 0.45) };

test('worklet without options (fast player): plays what is there at once', () => {
  const { push, out } = worklet();
  push(100, 1);
  const a = out();
  assert.ok(a[0] > 0 && a[99] > 0, 'the frames that came play at once');
  assert.ok(a[127] < a[99], 'then the last sample dies away');
});

test('3DS options: waits until `prime` frames are there, then plays them in order', () => {
  const { w, push, out } = worklet({ prime: 1000, maxLag: 8000, trim: 3000 });
  push(500, 1);
  assert.ok(out().every((x) => x === 0), 'not enough yet: silent (priming)');
  push(600, 501);
  out(); // (the fade-in)
  const a = out();
  for (let i = 0; i < 128; i++) assert.equal(Math.round(a[i] * 1e6), 129 + i, 'in order, nothing skipped');
  assert.equal(w.ring.stats.underruns, 0);
});

test('3DS options: a source a little faster than real time stays below the high mark, without jumps', () => {
  const { w, push, out } = worklet(DS);
  // 0.3 % more than real time (the 3DS core paced at 60 fps, before 2.7.3): 128.4 frames per block, for 60 s
  let next = 1;
  let owed = 0;
  let prev = null;
  let maxStep = 0;
  for (let b = 0; b < (60 * SR) / 128; b++) {
    owed += 128 * 1.003;
    const n = Math.floor(owed);
    owed -= n;
    push(n, next);
    next += n;
    const a = out();
    for (const x of a) {
      if (prev !== null && x > 0) maxStep = Math.max(maxStep, Math.abs(x - prev) * 1e6);
      if (x > 0) prev = x;
    }
  }
  assert.ok(w.ring.lag <= w.ring.high + 600, `the delay stays near the high mark (${w.ring.lag})`);
  assert.ok(maxStep < 2, `never a jump, the ramp only runs a little faster (largest step ${maxStep.toFixed(2)}, float32 rounding included)`);
  assert.equal(w.ring.stats.skips, 0);
});

test('tap: records what comes out and sends it with the buffer\'s numbers; the numbers also go out once a second', () => {
  const { w, send, push, out } = worklet();
  send({ type: 'tap', frames: 256 });
  push(300, 1);
  out();
  out();
  const tap = w.posted.find((m) => m.type === 'tap');
  assert.equal(tap.l.length, 256);
  assert.equal(Math.round(tap.l[5] * 1e6), 6);
  assert.equal(tap.ring.underruns, 0);
  for (let k = 0; k < SR / 128; k++) out();
  const ring = w.posted.find((m) => m.type === 'ring');
  assert.ok(ring && ring.ring.underruns === 1 && ring.ring.silent > 0, 'ran dry once since');
});

test('in-band commands take effect when the sound that came after them plays, not when they arrive', () => {
  const { got, send, push, out } = worklet({ prime: 256, maxLag: 8000, trim: 4000, startGrace: 0 });
  push(1000, 1);
  send({ type: 'rate', ratio: 2.5, exact: true, inband: true });
  push(1000, 1001);
  send({ type: 'probe' }); // (not in-band: right away)
  assert.ok(got.some((m) => m.type === 'probe'), 'ordinary commands go straight to the mixer');
  assert.ok(!got.some((m) => m.type === 'rate'), 'the ratio waits for its sound');
  for (let k = 0; k < 7; k++) out(); // 896 frames
  assert.ok(!got.some((m) => m.type === 'rate'));
  out();
  out(); // past frame 1000
  const r = got.find((m) => m.type === 'rate');
  assert.ok(r && r.at >= 1000 && r.at <= 1000 + 128, `applied with the first block that reaches its sound (at ${r?.at})`);
});

test('in-band commands still arrive after a clear (a loaded state) – nothing is left to wait for', () => {
  const { got, send, push } = worklet({ prime: 256 });
  push(1000, 1);
  send({ type: 'rate', ratio: 3, exact: true, inband: true });
  send('clear');
  assert.ok(got.some((m) => m.type === 'rate' && m.ratio === 3));
});

test('the 3DS host’s own fast-forward sound goes straight to the mixer’s recording, split into channels – not into the buffer', () => {
  const { w, send } = worklet({ prime: 256 });
  send({ type: 'mode', mode: 'music' }); // (the helper starts in "plain")
  const seen = [];
  w.mixer.ffSound = (l, r, n) => seen.push({ l: Array.from(l.subarray(0, n)), r: Array.from(r.subarray(0, n)) });
  const pushed = w.ring.pushed;
  send({ type: 'ffsound', f: Float32Array.from([0.1, -0.1, 0.2, -0.2, 0.3, -0.3]) });
  assert.equal(w.ring.pushed, pushed, 'nothing in the buffer: it is not played as it is');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].l.map((x) => +x.toFixed(3)), [0.1, 0.2, 0.3]);
  assert.deepEqual(seen[0].r.map((x) => +x.toFixed(3)), [-0.1, -0.2, -0.3]);
  // "plain" leaves the mixer out: nothing for it to record; a mixer that fails is reported and left alone
  send({ type: 'mode', mode: 'plain' });
  send({ type: 'ffsound', f: new Float32Array(4) });
  assert.equal(seen.length, 1);
  send({ type: 'mode', mode: 'music' });
  w.mixer.ffSound = () => {
    throw new Error('boom');
  };
  send({ type: 'ffsound', f: new Float32Array(4) });
  assert.ok(w.broken && w.posted.some((m) => m.type === 'mixer' && m.e.type === 'error'));
});

test('3DS session: 10 speed toggles, loaded states, a pause and a mode change – the delay is back at ~60 ms within a second each time, none of them counts as a gap', () => {
  // the page's options (ctrplayer.mjs ringFor)
  const { w, send } = worklet({ prime: Math.round(SR * 0.06), primeMax: Math.round(SR * 0.12), trim: Math.round(SR * 0.04), maxLag: Math.round(SR * 0.25) });
  send({ type: 'paused', paused: false });
  send({ type: 'speed', ratio: 1 });
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  // the host: at 1× a frame's sound (547 frames) every 1/59.83 s; fast-forwarding, the sped-up sound in 180-frame pieces
  // at real time, after the queue's start (ffsound.h: here 150 ms of nothing). Each arrives 3–9 ms late.
  const q = [];
  let speed = 1;
  let next = 0; // the host's next 1× frame / fast-forward piece (s)
  let frozen = 0; // the host stands still until then (loading a state)
  const deliver = (at, n) => q.push([at + 0.003 + rnd() * 0.006, n]);
  const host = (t) => {
    if (t < frozen) return;
    const per = speed === 1 ? 1 / 59.83 : 180 / SR;
    for (; next <= t; next += per) deliver(next, speed === 1 ? 547 : 180);
  };
  // the session (s): 10 speed steps (turbo off after 1–2×, 4×), 3 loaded states, a pause, a sound-mode change
  const steps = [2, 1, 4, 1, 'load', 4, 1, 'mode', 2, 1, 'load', 4, 'pause', 1, 2, 1, 'load'];
  const plan = steps.map((s, i) => ({ at: 6 + i * 5, s }));
  const end = plan.at(-1).at + 10;
  const lags = []; // [t, lag ms]
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  let resumeAt = 0;
  for (let b = 0, t = 0; t < end; b++, t = (b * 128) / SR) {
    while (plan.length && plan[0].at <= t) {
      const { s } = plan.shift();
      if (s === 'load') {
        send('clear');
        send({ type: 'cut' });
        frozen = t + 0.15; // unserializing; then it catches up 100 ms (ctrhost.c's limit)
        next = t + 0.05;
      } else if (s === 'mode') send({ type: 'mode', mode: 'original' });
      else if (s === 'pause') {
        send({ type: 'paused', paused: true });
        frozen = t + 1;
        resumeAt = t + 1;
      } else {
        const was = speed;
        send({ type: 'speed', ratio: s });
        speed = s;
        // fast-forward starts: its queue fills first; back to 1×: the first frames come 80 ms late (the gap a Windows
        // player's 3DS session showed on every turbo → 1× edge)
        next = t + (s > 1 ? 0.15 : was > 1 ? 0.08 : 0);
      }
    }
    if (resumeAt && t >= resumeAt) {
      send({ type: 'paused', paused: false });
      next = t;
      resumeAt = 0;
    }
    host(t);
    q.sort((x, y) => x[0] - y[0]);
    while (q.length && q[0][0] <= t) send(new Float32Array(q.shift()[1] * 2).fill(0.1));
    w.process([], [[L, R]]);
    lags.push([t, (w.ring.lag / SR) * 1000]);
  }
  const mean = (a, b) => {
    const v = lags.filter(([t]) => t >= a && t < b).map(([, x]) => x);
    return v.reduce((x, y) => x + y, 0) / v.length;
  };
  for (let i = 0; i < steps.length; i++) {
    const at = 6 + i * 5 + (steps[i] === 'pause' ? 1 : 0);
    const after = mean(at + 1, at + 1.5);
    assert.ok(after > 40 && after < 75, `${steps[i]} at ${at} s: ${after.toFixed(0)} ms behind a second later`);
  }
  assert.ok(mean(end - 5, end) < 70, 'and still there at the end');
  assert.equal(w.ring.stats.underruns, 0, 'none of them counted as a gap');
  assert.ok(w.ring.stats.breaks >= 8, `(they ran dry ${w.ring.stats.breaks} times, as breaks)`);
  assert.equal(w.ring.prime, Math.round(SR * 0.06), '`prime` still at its base (until 2.8.2: 240 ms after such a session)');
});

test('3DS save states: the host stops 0.4 s for each (the play view’s resume state) – with the page’s { type: \'stall\' } none counts as a gap or grows the delay; without it each did', () => {
  const run = (tell) => {
    const { w, send } = worklet({ prime: Math.round(SR * 0.06), primeMax: Math.round(SR * 0.18), trim: Math.round(SR * 0.04), maxLag: Math.round(SR * 0.25) });
    send({ type: 'paused', paused: false });
    send({ type: 'speed', ratio: 1 });
    const q = [];
    let next = 0;
    let frozen = 0;
    const saves = [10, 30, 50, 70];
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    const lags = [];
    for (let b = 0, t = 0; t < 85; b++, t = (b * 128) / SR) {
      if (saves.length && saves[0] <= t) {
        saves.shift();
        if (tell) send({ type: 'stall' });
        frozen = t + 0.02 + 0.4; // the next frame boundary, then 0.4 s copying (an older core on a Windows PC)
      }
      if (t >= frozen) {
        if (next < t - 0.1) next = t; // (ctrhost.c: no racing to catch up more than 100 ms)
        for (; next <= t; next += 1 / 59.83) q.push([next + 0.004, 547]);
      }
      while (q.length && q[0][0] <= t) send(new Float32Array(q.shift()[1] * 2).fill(0.1));
      w.process([], [[L, R]]);
      lags.push([t, (w.ring.lag / SR) * 1000]);
    }
    const after = lags.filter(([t]) => t >= 72 && t < 85).map(([, x]) => x);
    return { w, after: after.reduce((x, y) => x + y, 0) / after.length };
  };
  const told = run(true);
  assert.equal(told.w.ring.stats.underruns, 0, 'no gap counted');
  assert.equal(told.w.ring.prime, Math.round(SR * 0.06), '`prime` stays at its base');
  assert.ok(told.after < 75, `${told.after.toFixed(0)} ms behind afterwards`);
  const untold = run(false);
  assert.ok(untold.w.ring.stats.underruns >= 3 && untold.w.ring.prime > told.w.ring.prime, `(without it: ${untold.w.ring.stats.underruns} gaps, prime ${Math.round((untold.w.ring.prime / SR) * 1000)} ms – the 2-minute hole a Windows player saw, with the delay growing each time)`);
});

test('quiet moments: { type: \'quiet\', id, ms } is answered once `ms` in a row came out nearly silent – not during the music, once only, and not after a cancel', () => {
  const { w, send, out } = worklet();
  const loud = (n) => send(new Float32Array(n * 2).fill(0.2));
  const quiet = (n) => send(new Float32Array(n * 2).fill(0.002));
  send({ type: 'quiet', id: 7, ms: 200 });
  for (let i = 0; i < 100; i++) {
    loud(128);
    out();
  }
  assert.equal(w.posted.filter((m) => m.type === 'quiet').length, 0, 'music: no quiet moment');
  for (let i = 0; i < 30; i++) {
    quiet(128);
    out();
  }
  assert.equal(w.posted.filter((m) => m.type === 'quiet').length, 0, '~120 ms quiet: not yet');
  for (let i = 0; i < 40; i++) {
    quiet(128);
    out();
  }
  assert.deepEqual(w.posted.filter((m) => m.type === 'quiet'), [{ type: 'quiet', id: 7 }], '200 ms quiet: told, once');
  send({ type: 'quiet', id: 8, ms: 200 });
  send({ type: 'quiet', cancel: true });
  for (let i = 0; i < 100; i++) {
    quiet(128);
    out();
  }
  assert.equal(w.posted.filter((m) => m.type === 'quiet').length, 1, 'cancelled: not told');
});
