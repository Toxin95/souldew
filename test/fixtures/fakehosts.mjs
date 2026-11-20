// Stand-in hosts for the 3DS player tests: `node -e <script>` in place of ctrhost. Every one of them is ended after
// each test (killFakeHosts in test.afterEach) – also when a test failed half way and never got to ctr.stop(). A stand-in
// that keeps running holds its pipes open, and with them the test file: it would never end, and `npm test` would wait
// for it forever.
import { spawn } from 'node:child_process';

const running = new Set();

/** A CtrSessions `spawn` that starts `script` with the host's arguments (`env`: more environment for it). */
export function fakeHostSpawn(script, env = null) {
  return (cmd, args, o) => {
    const child = spawn(process.execPath, ['-e', script, '--', ...args], env ? { ...o, env: { ...process.env, ...env } } : o);
    running.add(child);
    child.once('exit', () => running.delete(child));
    return child;
  };
}

/** Ends every stand-in that still runs. */
export function killFakeHosts() {
  for (const child of running) child.kill('SIGKILL');
  running.clear();
}
