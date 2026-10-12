/**
 * Process-group control for spawned agent CLIs, shared by the command and ACP
 * adapters.
 *
 * An agent routinely forks helpers (shells, test runners, `sleep &`). Signalling
 * only the child pid leaves those grandchildren running — editing the tree after
 * the harness has declared the wave dead. So on POSIX the agent is spawned
 * `detached` (its own process group, pgid === pid) and every kill targets the
 * negative pid, which reaches the whole group.
 *
 * Platform behavior: Windows has no process groups or negative-pid signals, so on
 * `win32` this module falls back to signalling the child pid only — no
 * `detached`, no negative pid. Grandchildren may survive there (docs/rad-cli.md).
 *
 * A detached group no longer receives the terminal's Ctrl-C, so live groups are
 * tracked and killed when the harness itself gets SIGINT/SIGTERM or exits.
 */

const WIN32 = 'win32';
const REPORTED_SIGNALS = ['SIGINT', 'SIGTERM'];
const NO_SUCH_PROCESS = 'ESRCH';

/** Children whose groups must die with the harness. Handlers exist only while non-empty. */
const live = new Set();

const isWindows = () => process.platform === WIN32;

/** spawn() options that put the agent in its own process group (POSIX only). */
export function spawnOptions() {
  return isWindows() ? {} : { detached: true };
}

/** Signal the pid or group; ESRCH (already gone) is silent, anything else is logged. */
function sendSignal(child, signal) {
  const target = isWindows() ? child.pid : -child.pid;
  try {
    process.kill(target, signal);
  } catch (err) {
    if (err?.code === NO_SUCH_PROCESS) return;
    process.stderr.write(
      `process-group: failed to send ${signal} to agent pid ${child.pid}: ${err?.message ?? err}\n`,
    );
  }
}

/**
 * Send `signal` to the child's whole process group (child pid only on win32).
 * A child that already exited, or never spawned, is skipped.
 */
export function signalGroup(child, signal) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  sendSignal(child, signal);
}

/** SIGKILL every tracked group, including ones whose leader already exited. */
function killAllLive() {
  for (const child of live) if (child.pid !== undefined) sendSignal(child, 'SIGKILL');
}

/** On a fatal signal: kill the groups, step aside, re-raise so the exit status is the signal's. */
function onFatalSignal(signal) {
  killAllLive();
  removeHandlers();
  process.kill(process.pid, signal);
}

const signalListeners = new Map(REPORTED_SIGNALS.map((sig) => [sig, () => onFatalSignal(sig)]));

function installHandlers() {
  for (const [sig, listener] of signalListeners) process.on(sig, listener);
  process.on('exit', killAllLive);
}

function removeHandlers() {
  for (const [sig, listener] of signalListeners) process.removeListener(sig, listener);
  process.removeListener('exit', killAllLive);
}

/** Register a spawned child; the first live group installs the process handlers. */
export function trackGroup(child) {
  if (live.has(child)) return;
  if (live.size === 0) installHandlers();
  live.add(child);
}

/** Forget a child; the last one out removes the process handlers. */
export function untrackGroup(child) {
  if (!live.delete(child)) return;
  if (live.size === 0) removeHandlers();
}
