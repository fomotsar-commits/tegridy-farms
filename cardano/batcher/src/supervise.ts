// The container's process (docker-entrypoint.sh starts it). It runs the batcher (src/main.ts) as a
// child, and starts it again whenever it exits 3: EMURGO's library broke, and only a fresh process
// mends it. Railway's own restarts are few (railway.json) and kept for real crashes; a stranger's
// UTxO that breaks the library must not use them up. The batcher keeps what broke it beside its
// key, and the next one never reads it again, so each restart is progress. Several in a row with
// little time between them wait longer each time (1 s, doubling, up to 5 minutes). Any other exit
// is the container's. A stop signal goes to the batcher, which stops cleanly; none of EMURGO's
// library is loaded here.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** A batcher that ran this long before breaking was making progress: the wait starts again at 1 s. */
const SETTLED_MS = 600_000;
const FIRST_WAIT_MS = 1_000;
const LONGEST_WAIT_MS = 300_000;

export async function supervise(opts: { script: string; argv: readonly string[]; env: NodeJS.ProcessEnv; onStop: (stop: (signal: NodeJS.Signals) => void) => void; log: (line: string) => void; now?: () => number; firstWaitMs?: number }): Promise<number> {
  const now = opts.now ?? Date.now;
  const first = opts.firstWaitMs ?? FIRST_WAIT_MS;
  let child: ChildProcess | null = null;
  let stopping = false;
  let wake: (() => void) | null = null;
  opts.onStop((signal) => {
    stopping = true;
    child?.kill(signal);
    wake?.();
  });
  let wait = 0;
  for (;;) {
    const started = now();
    child = spawn(process.execPath, [opts.script, ...opts.argv], { env: opts.env, stdio: 'inherit' });
    const code = await new Promise<number>((resolve) => child!.once('exit', (c) => resolve(c ?? 1)));
    child = null;
    // Asked to stop: whatever the batcher ended with, the container is done (Railway is replacing it).
    if (stopping) return 0;
    if (code !== 3) return code;
    wait = wait === 0 || now() - started >= SETTLED_MS ? first : Math.min(wait * 2, LONGEST_WAIT_MS);
    opts.log(`${JSON.stringify({ at: new Date().toISOString(), kind: 'restarting', after: 'EMURGO\'s library broke (exit 3)', waitMs: wait })}\n`);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    wake = null;
    if (stopping) return 0;
  }
}

if (import.meta.main) {
  process.exitCode = await supervise({
    script: fileURLToPath(new URL('./main.ts', import.meta.url)),
    argv: process.argv.slice(2),
    env: process.env,
    onStop: (stop) => {
      process.on('SIGINT', () => stop('SIGINT'));
      process.on('SIGTERM', () => stop('SIGTERM'));
    },
    log: (line) => process.stdout.write(line),
  });
}
