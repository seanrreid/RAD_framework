// Warns, once per run, when a token budget is armed but a wave reports no usage:
// the cumulative breaker can only count what the agent command reports, so a
// command that reports nothing leaves the budget unable to trip.

/** Env var arming the spine's token breaker (same variable cli.js parses). */
const TOKEN_BUDGET_ENV = 'RAD_TOKEN_BUDGET';

/** The wave id as the command adapter names it. */
function waveLabel(wave) {
  return wave?.n ?? wave?.number ?? wave?.id ?? '?';
}

function unmeteredMessage(wave) {
  return (
    `rad deliver: wave ${waveLabel(wave)} reported no token usage, so ${TOKEN_BUDGET_ENV} cannot trip; ` +
    `use an agent command that emits a RAD_USAGE line (see docs/rad-wave-contract.md)\n`
  );
}

/**
 * Decorate `runWave` so the first usage-less result writes one warning line.
 * Unarmed: returns `runWave` itself. Armed: the result object is returned
 * unchanged and a thrown error propagates untouched.
 *
 * @param {Function} runWave - (wave, planCtx) => Promise<result>
 * @param {{ armed: boolean, write: (line: string) => void }} opts
 * @returns {Function}
 */
export function warnOnUnmeteredBudget(runWave, { armed, write }) {
  if (!armed) return runWave;
  let warned = false;
  return async function runWaveWatchingUsage(wave, ...rest) {
    const result = await runWave(wave, ...rest);
    if (!warned && (result?.usage === undefined || result.usage === null)) {
      warned = true;
      write(unmeteredMessage(wave));
    }
    return result;
  };
}
