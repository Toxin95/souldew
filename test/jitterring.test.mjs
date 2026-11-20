// The sound worklet's jitter buffer (web/lib/jitterring.mjs): the frames come out exactly as they went in at the normal
// fill, gaps fade instead of clicking and make the buffer deeper, excess is read out with a clean (windowed-sinc) speed
// change of at most 0.5 % instead of 2.7.3's linear 129-into-128 fold, far too much is skipped with a crossfade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JitterRing } from '../web/lib/jitterring.mjs';

const SR = 32728;
const ms = (x) => Math.round((SR * x) / 1000);
const DS = { prime: ms(60), primeMax: ms(180), trim: ms(40), maxLag: ms(250) }; // the 3DS page's options (ctrplayer.mjs)
const DS0 = { ...DS, startGrace: 0 }; // (a game's first seconds are a break the player asked for: not here)

/** n frames of a stereo signal f(i) (left), -f(i) (right) from frame `from`, interleaved as the page posts them. */
function frames(f, from, n) {
  const d = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    d[i * 2] = f(from + i);
    d[i * 2 + 1] = -f(from + i);
  }
  return d;
}
/** Runs `blocks` 128-frame blocks; `feed(b)` may push before each. Returns the left channel played. */
function run(ring, blocks, feed = () => {}) {
  const out = new Float32Array(blocks * 128);
  const R = new Float32Array(128);
  for (let b = 0; b < blocks; b++) {
    feed(b);
    const L = out.subarray(b * 128, b * 128 + 128);
    ring.take(L, R, 128);
    for (let i = 0; i < 128; i++) assert.ok(Math.abs(R[i] + L[i]) < 1e-5, 'right is the mirror of left');
  }
  return out;
}
const maxStep = (x, from = 1, to = x.length) => {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};
/** A source that sends `per` frames every `every` blocks (≈ real time when per = 128 · every). */
const steady = (ring, f, per, every) => {
  let at = 0;
  return (b) => {
    if (b % every === 0) {
      ring.push(frames(f, at, per));
      at += per;
    }
  };
};

test('at the normal fill the frames come out exactly as they went in (3DS options)', () => {
  const ring = new JitterRing(SR, DS);
  const f = (i) => Math.sin(i * 0.37) * 0.3 + Math.sin(i * 0.011) * 0.2 + 0.1; // (not 0 at the first frame)
  // a 3DS-like source: 512 frames every 4 blocks
  const out = run(ring, 4000, steady(ring, f, 512, 4));
  const start = out.findIndex((x) => x !== 0);
  assert.ok(start > 0 && start <= ms(60) + 512, 'starts once `prime` is there');
  // after the 128-frame fade-in: bit-exact
  for (let i = start + 128; i < out.length; i++) assert.equal(out[i], Math.fround(f(i - start)));
  assert.deepEqual([ring.stats.underruns, ring.stats.resampled, ring.stats.skips], [0, 0, 0]);
});

test('running dry: no click – the last sample dies away, the sound coming back fades in; the buffer gets deeper', () => {
  const ring = new JitterRing(SR, DS0);
  const f = (i) => 0.5 + 0.2 * Math.sin(i * 0.05); // loud and off-centre: a hard stop would be a big step
  let at = 0;
  const out = run(ring, 600, (b) => {
    // steady, but nothing from block 200 to 260 (a 230 ms stall), then the late sound all at once
    if (b >= 200 && b < 260) return;
    const n = b === 260 ? 512 * 15 + 512 : b % 4 === 0 ? 512 : 0;
    if (!n) return;
    ring.push(frames(f, at, n));
    at += n;
  });
  assert.equal(ring.stats.underruns, 1);
  const first = out.findIndex((x) => x !== 0);
  assert.ok(maxStep(out, first + 1) < 0.03, `no step anywhere (largest ${maxStep(out, first + 1).toFixed(4)})`);
  assert.equal(ring.prime, Math.round(ms(60) * 1.5), 'the next gap waits for half as much again');
});

test('`prime` grows with every gap up to `primeMax` (180 ms) and comes back down to its base once the gaps stop', () => {
  const ring = new JitterRing(SR, DS0);
  const f = () => 0.1;
  let at = 0;
  for (let gap = 0; gap < 6; gap++) {
    run(ring, 200, (b) => {
      if (b < 100) {
        ring.push(frames(f, at, 128));
        at += 128;
      }
    });
  }
  assert.equal(ring.prime, ms(180), 'capped');
  assert.equal(ring.stats.underruns, 6);
  // repeated gaps: it shrinks more slowly (6 s, doubled per recent gap – three at most), and one is forgiven per 30 s
  run(ring, Math.ceil((6.5 * SR) / 128), steady(ring, f, 128, 1));
  assert.equal(ring.prime, ms(180), 'not after 6 s yet, after six gaps in a row');
  run(ring, Math.ceil((50 * SR) / 128), steady(ring, f, 128, 1));
  assert.ok(ring.prime < ms(180), `smaller within a minute (${ring.prime})`);
  run(ring, Math.ceil((90 * SR) / 128), steady(ring, f, 128, 1));
  assert.equal(ring.prime, ms(60), 'back at its base within ~2.5 minutes of six gaps (until 2.8.2: ~3 min from 240 ms)');
  // one gap: back within ~20 s
  run(ring, 200, (b) => {
    if (b < 100) {
      ring.push(frames(f, at, 128));
      at += 128;
    }
  });
  assert.equal(ring.prime, ms(90));
  run(ring, Math.ceil((13 * SR) / 128), steady(ring, f, 128, 1));
  assert.equal(ring.prime, ms(63), 'one gap: smaller after 12 s');
  run(ring, Math.ceil((13 * SR) / 128), steady(ring, f, 128, 1));
  assert.equal(ring.prime, ms(60));
});

test('too much buffered: read up to 0.5 % faster with a clean interpolator until back in range, then exact again', () => {
  const ring = new JitterRing(SR, DS0);
  const f = (i) => Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.4;
  let at = 0;
  let maxRatio = 1;
  const out = run(ring, Math.ceil((120 * SR) / 128), (b) => {
    // 200 ms arrive at once at the start (as after a stall), then real time
    const n = b === 0 ? ms(200) : 128;
    ring.push(frames(f, at, n));
    at += n;
    maxRatio = Math.max(maxRatio, ring.ratio);
  });
  assert.ok(maxRatio > 1.004 && maxRatio <= 1.005 + 1e-9, `at most 0.5 % faster (${maxRatio})`);
  assert.ok(ring.lag <= ring.high, `back below the high mark (${ring.lag})`);
  assert.equal(ring.ratio, 1);
  assert.equal(ring.frac, 0, 'landed on a whole frame: the frames come out exactly again');
  assert.equal(ring.stats.skips, 0, 'nothing skipped');
  assert.ok(maxStep(out, 200) < 0.08, 'no jump (a 1 kHz tone at 0.4 moves at most 0.077 per frame)');
});

/**
 * Signal-to-error (dB) of a tone read `ratio` times faster by `read(src, ratio, n)`: the output against the best-fitting
 * tone at ratio × the frequency (amplitude and phase fitted by least squares).
 */
function toneSnr(hz, ratio, read) {
  const n = 16384;
  const src = new Float32Array(n + 256);
  for (let i = 0; i < src.length; i++) src[i] = Math.sin((2 * Math.PI * hz * i) / SR);
  const out = read(src, ratio, n - 512);
  const w = (2 * Math.PI * hz * ratio) / SR;
  let ss = 0, cc = 0, sc = 0, ys = 0, yc = 0; // prettier-ignore
  for (let i = 512; i < out.length; i++) {
    const s = Math.sin(w * i);
    const c = Math.cos(w * i);
    ss += s * s;
    cc += c * c;
    sc += s * c;
    ys += out[i] * s;
    yc += out[i] * c;
  }
  const det = ss * cc - sc * sc;
  const a = (ys * cc - yc * sc) / det;
  const b = (yc * ss - ys * sc) / det;
  let sig = 0;
  let err = 0;
  for (let i = 512; i < out.length; i++) {
    const fit = a * Math.sin(w * i) + b * Math.cos(w * i);
    sig += fit * fit;
    err += (out[i] - fit) ** 2;
  }
  return 10 * Math.log10(sig / err);
}
/** The ring held at `ratio` (its speed control off). */
const viaRing = (src, ratio, n) => {
  const ring = new JitterRing(SR, { trim: 1, maxLag: 30000 });
  ring.push(frames((i) => src[i], 0, src.length));
  ring.read = 15; // (the interpolator reads 15 frames back)
  ring.ratio = ratio;
  ring.frac = 1e-9;
  ring.steer = () => {};
  const out = new Float32Array(n);
  const R = new Float32Array(128);
  for (let b = 0; b + 128 <= n; b += 128) ring.take(out.subarray(b, b + 128), R, 128);
  return out;
};
/** 2.7.3's fold: 129 frames linearly into each 128-frame block. */
const fold273 = (src, _ratio, n) => {
  const out = new Float32Array(n);
  let r = 0;
  for (let b = 0; b + 128 <= n; b += 128) {
    for (let i = 0; i < 128; i++) {
      const p = (i * 129) / 128;
      const k = Math.floor(p);
      out[b + i] = src[r + k] + (src[r + k + 1] - src[r + k]) * (p - k);
    }
    r += 129;
  }
  return out;
};

test('the speed change is clean: a tone keeps 60+ dB to its error up to 10 kHz (2.7.3: 25 dB at 6 kHz, 14 at 10 kHz)', () => {
  // both read 129/128 times faster here – 2.7.3's step (the ring itself never goes past 0.5 %)
  for (const hz of [440, 3000, 6000, 10000]) {
    const now = toneSnr(hz, 129 / 128, viaRing);
    const old = toneSnr(hz, 129 / 128, fold273);
    assert.ok(now > 60, `${hz} Hz: ${now.toFixed(1)} dB`);
    if (hz >= 6000) assert.ok(old < 30, `2.7.3 at ${hz} Hz: ${old.toFixed(1)} dB`);
  }
});

test('far too much: skips ahead to the middle of the range with a crossfade, no click', () => {
  const ring = new JitterRing(SR, DS0);
  const f = (i) => 0.3 * Math.sin(i * 0.02) + 0.3;
  let at = 0;
  const out = run(ring, 800, (b) => {
    const n = b === 300 ? ms(600) : b % 4 === 0 ? 512 : 0; // a burst of 600 ms on top of the normal fill
    if (!n) return;
    ring.push(frames(f, at, n));
    at += n;
  });
  assert.equal(ring.stats.skips, 1);
  assert.ok(ring.stats.dropped > ms(400), `skipped ${ring.stats.dropped} frames`);
  const first = out.findIndex((x) => x !== 0);
  assert.ok(maxStep(out, first + 1) < 0.03, `no click (largest step ${maxStep(out, first + 1).toFixed(4)})`);
});

test('fast player (no options): plays what is there at once, fades instead of clicking when dry, skips to half of 4096', () => {
  const ring = new JitterRing(SR);
  ring.push(frames(() => 0.5, 0, 100));
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  ring.take(L, R, 128);
  assert.ok(L[0] > 0 && L[99] > 0, 'the frames that came play at once');
  assert.ok(L[100] > 0 && L[100] < 0.5 && L[127] < L[100], 'then the last sample dies away');
  ring.push(frames(() => 0.5, 0, 5000));
  ring.take(L, R, 128);
  assert.ok(Math.abs(ring.lag - (2048 - 128)) <= 1, `overfull: back to half the limit (${ring.lag})`);
  assert.equal(ring.stats.skips, 1);
});

test('clear: nothing left, waits for `prime` again, `played` catches up with `pushed`', () => {
  const ring = new JitterRing(SR, DS);
  ring.push(frames(() => 0.2, 0, 5000));
  run(ring, 10);
  ring.clear();
  assert.equal(ring.lag, 0);
  assert.equal(ring.played, ring.pushed);
  assert.ok(ring.priming);
});

test('paused: running dry is no gap – `prime` stays, and the sound after the pause starts as at the beginning', () => {
  const ring = new JitterRing(SR, DS);
  ring.push(frames(() => 0.2, 0, ms(100)));
  run(ring, 10);
  ring.paused = true;
  run(ring, 40); // the page sends nothing while paused
  assert.equal(ring.stats.underruns, 0);
  assert.equal(ring.prime, ms(60));
  assert.ok(ring.priming);
  ring.paused = false;
  ring.push(frames(() => 0.2, 0, ms(70)));
  const out = run(ring, 4);
  assert.ok(out[200] > 0.19, 'plays again once `prime` is there');
});

/**
 * The 3DS host at 1× as the page receives it: 547 frames per emulated frame (59.83 fps), each a few ms late, now and
 * then held back 20–35 ms behind a big picture and then arriving together. `stalls`: [start, seconds] where the core
 * stands still (the host then catches up at most 100 ms, as ctrhost.c does). Returns feed(b) for run().
 */
function host3ds(ring, { seed = 1, stalls = [] } = {}) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const q = []; // deliveries [at (s), frames]
  let next = 0; // the host's next frame (s)
  let held = 0; // a big picture holds the socket until then
  let at = 0;
  return (b) => {
    const t = (b * 128) / SR;
    while (stalls.length && stalls[0][0] <= t) {
      const [from, len] = stalls.shift();
      next = Math.max(next, from + len - 0.1); // (frozen; then it catches up at most 100 ms)
    }
    if (rnd() < 0.004) held = Math.max(held, t + 0.02 + rnd() * 0.015);
    for (; next <= t; next += 1 / 59.83) q.push([Math.max(next + 0.003 + rnd() * 0.006, held), 547]);
    q.sort((x, y) => x[0] - y[0]);
    while (q.length && q[0][0] <= t) {
      const [, n] = q.shift();
      ring.push(frames((i) => 0.2 * Math.sin(i * 0.03), at, n));
      at += n;
    }
  };
}

test('1× for 10 minutes with a 3DS-like delivery: no gap, the delay stays at its base (~60 ms), nothing resampled or skipped', () => {
  const ring = new JitterRing(SR, DS);
  const feed = host3ds(ring, { seed: 3 });
  const lags = [];
  run(ring, Math.ceil((600 * SR) / 128), (b) => {
    feed(b);
    if (b % 64 === 0 && b > (5 * SR) / 128) lags.push(ring.lag);
  });
  const mean = lags.reduce((x, y) => x + y, 0) / lags.length;
  assert.equal(ring.stats.underruns, 0);
  assert.equal(ring.prime, ms(60));
assert.ok(mean > ms(50) && mean < ms(75), `the delay averages ${((mean / SR) * 1000).toFixed(0)} ms`);
  assert.equal(ring.stats.skips, 0);
});

test('real gaps (the core stalls 150 ms): `prime` grows, then the delay is back at its base within a minute, not minutes', () => {
  const ring = new JitterRing(SR, DS);
  // three stalls 10, 12 and 14 s in (after the game's first seconds), then none
  const feed = host3ds(ring, { seed: 5, stalls: [[10, 0.15], [12, 0.15], [14, 0.15]] });
  const at = (s) => Math.ceil((s * SR) / 128);
  let peak = 0;
  run(ring, at(15), (b) => {
    feed(b);
    peak = Math.max(peak, ring.prime);
  });
  assert.ok(ring.stats.underruns >= 2, `the stalls are gaps (${ring.stats.underruns}; the deeper buffer may cover the last)`);
  assert.ok(peak >= ms(90) && peak <= ms(180), `the buffer got deeper (${((peak / SR) * 1000).toFixed(0)} ms, at most 180; until 2.8.2: 240)`);
  const lags = [];
  // (two gaps close together: each step back down waits longer – 24 s, then 12 s, then 12 s)
  run(ring, at(60), (b) => {
    feed(at(15) + b);
    if (b > at(50) && b % 32 === 0) lags.push(ring.lag);
  });
  const mean = lags.reduce((x, y) => x + y, 0) / lags.length;
  assert.equal(ring.prime, ms(60), 'back at its base');
  assert.ok(mean < ms(72), `the delay is back near 60 ms ~50 s after the last gap (${((mean / SR) * 1000).toFixed(0)} ms)`);
});

test('a core that stalls 90 ms every 10 s (5 min): a gap at the first stall or two, not at every one – the buffer stays as deep as needed', () => {
  // the review of 2.8.2: 20 gaps in 5 min (2.8.1: 2) – `prime` shrank back 6 s after each gap, in time for the next stall
  const ring = new JitterRing(SR, DS);
  const stalls = Array.from({ length: 29 }, (_, i) => [10 + i * 10, 0.09]);
  const feed = host3ds(ring, { seed: 7, stalls });
  const lags = [];
  run(ring, Math.ceil((300 * SR) / 128), (b) => {
    feed(b);
    if (b % 64 === 0 && b > (60 * SR) / 128) lags.push(ring.lag);
  });
  lags.sort((x, y) => x - y);
  const median = (lags[lags.length >> 1] / SR) * 1000;
  assert.ok(ring.stats.underruns <= 3, `${ring.stats.underruns} gaps`);
  assert.ok(median < 130, `the delay: ${median.toFixed(0)} ms (as deep as the stalls need, not more)`);
});

test('toggling the speed again and again (rebase each time) leaves `prime` at its base and the delay at ~60 ms', () => {
  const ring = new JitterRing(SR, DS);
  const feed = host3ds(ring, { seed: 11 });
  const at = (s) => Math.ceil((s * SR) / 128);
  // a speed step every 4 s for a minute: each one a break – the host's sound from before it runs out, it catches up
  let b0 = 0;
  for (let i = 0; i < 15; i++) {
    run(ring, at(4), (b) => feed(b0 + b));
    b0 += at(4);
    ring.rebase();
    assert.equal(ring.prime, ms(60));
  }
  const lags = [];
  run(ring, at(30), (b) => {
    feed(b0 + b);
    if (b > at(5) && b % 64 === 0) lags.push(ring.lag);
  });
  const mean = lags.reduce((x, y) => x + y, 0) / lags.length;
  assert.equal(ring.stats.underruns, 0, 'no step counted as a gap');
  assert.equal(ring.prime, ms(60), 'prime at its base (2.8.2 beta 2: 135 ms after two toggles, for ~3 min)');
  assert.ok(mean < ms(72), `the delay: ${((mean / SR) * 1000).toFixed(0)} ms`);
});

test('breaks the player asked for (rebase: speed step, loaded state, pause, sound mode) are no gaps: `prime` back to its base, what piled up skipped', () => {
  const ring = new JitterRing(SR, DS0);
  const f = (i) => 0.3 * Math.sin(i * 0.02);
  let at = 0;
  const push = (n) => {
    ring.push(frames(f, at, n));
    at += n;
  };
  // a deep buffer from earlier gaps
  ring.prime = ms(120);
  run(ring, 400, (b) => b % 4 === 0 && push(512));
  ring.rebase(); // e.g. turbo off
  assert.equal(ring.prime, ms(60));
  // the sound from before the step runs out (nothing for 150 ms) – no gap; then the host catches up 100 ms at once
  const before = ring.stats.underruns;
  run(ring, 40);
  push(ms(100));
  const out = run(ring, 200, (b) => b % 4 === 0 && push(512));
  assert.equal(ring.stats.underruns, before, 'running dry right after it is no gap');
  assert.ok(ring.stats.breaks >= 1);
  assert.equal(ring.prime, ms(60), 'and `prime` stays at its base');
  assert.ok(ring.lag <= ms(60) + 512, `what piled up is skipped: ${((ring.lag / SR) * 1000).toFixed(0)} ms left`);
  assert.ok(maxStep(out, 140) < 0.03, 'crossfaded, no click');
  // after GRACE a gap counts again
  run(ring, 400, (b) => b % 4 === 0 && push(512));
  run(ring, 60);
  assert.equal(ring.stats.underruns, before + 1);
});

test('a game’s first seconds: running dry while it loads is no gap', () => {
  const ring = new JitterRing(SR, DS);
  const feed = host3ds(ring, { seed: 9, stalls: [[1, 0.2], [2, 0.15]] });
  run(ring, Math.ceil((8 * SR) / 128), feed);
  assert.equal(ring.stats.underruns, 0);
  assert.equal(ring.prime, ms(60));
  assert.ok(ring.stats.breaks >= 1);
});
