/**
 * The two numbers that move the clock, and nothing else.
 *
 * Both come from the environment, and both exist as variables for the same
 * reason the Host's handshake does: they are the seam a test proves the clock
 * through in milliseconds rather than in minutes. Nobody is expected to change
 * either on a real machine.
 */

/** How often the Plugin Server wakes and looks at the wall clock. */
export const TICK_VARIABLE = 'SCHEDULER_TICK_MS';

/** How long one Run may take before the Scheduler stops waiting for it. */
export const CALL_VARIABLE = 'SCHEDULER_CALL_MS';

/** A minute. Worst-case lateness is one tick, and a minute is close enough. */
export const DEFAULT_TICK_MS = 60_000;

/**
 * Five minutes, which is under the Host's own ten-minute ceiling, so the
 * Scheduler's timer is the one that decides and the Host's is the backstop.
 */
export const DEFAULT_CALL_MS = 300_000;

export type Config = {
  readonly tickMs: number;
  readonly callMs: number;
};

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    tickMs: milliseconds(env, TICK_VARIABLE, DEFAULT_TICK_MS),
    callMs: milliseconds(env, CALL_VARIABLE, DEFAULT_CALL_MS),
  };
}

function milliseconds(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const given = env[name];
  if (given === undefined || given === '') return fallback;
  const value = Number(given);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} is ${JSON.stringify(given)}. It must be a whole number of milliseconds above zero.`,
    );
  }
  return value;
}
