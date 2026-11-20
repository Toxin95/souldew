// The running ROM's own data from the server (server/lib/romloc.mjs, GET /api/rom/locations) – asked again while the
// server couldn't read the file (web/views/location.mjs loadRomLocations).

/** Waits before asking again for a ROM's data the server couldn't read (its own retry comes after 30 s). */
export const ROMDATA_RETRY_MS = [35000, 90000, 240000];

/**
 * The ROM's data for `src` to `apply(answer)`: the first answer, and while the server couldn't read the file – no answer,
 * or no header at all (every game file has one) – asked again a few times, applied once it has one. A 3DS game a virus
 * scanner held for a moment read as "nothing", and the place sign stayed away for the whole session (ticket #21).
 * Stops once `current()` is false (another game). `wait(ms)` and `get(src)` are for tests.
 */
export async function watchRomData(src, apply, { retry = ROMDATA_RETRY_MS, wait = (ms) => new Promise((r) => setTimeout(r, ms)), get = defaultGet, current = () => true } = {}) {
  let j = await get(src);
  if (!current()) return;
  apply(j);
  for (let i = 0; !j?.header && i < retry.length; i++) {
    await wait(retry[i]);
    if (!current()) return;
    j = await get(src);
    if (!current()) return;
    if (j?.header) apply(j);
  }
}
const defaultGet = (src) => fetch(`/api/rom/locations?src=${encodeURIComponent(src)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
