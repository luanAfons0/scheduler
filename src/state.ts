/**
 * The Runs this Plugin remembers, in a file of its own beside the Jobs.
 *
 * It is written whole and moved into place, the way the Host writes its
 * Registry, so whoever reads it sees one state or the one before it and never
 * half of either.
 *
 * The next Due time is never in here. It is derived on read, because a stored
 * one goes stale the moment a clock moves, and a stale time on the Page is
 * worse than no time at all.
 *
 * The Job Name is the key, the same key the jobs file uses. Renaming a Job is
 * a new Job with a fresh history, which is the truth.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The state file, in the Plugin's own directory, which is where it is started. */
export const STATE_FILE = 'state.json';

/** What a Run ended as. A `timed-out` Run is not a failed one. */
export type Outcome = 'ok' | 'failed' | 'timed-out' | 'skipped';

/** One attempt to call a Job's tool. */
export type Run = {
  readonly started: string;
  readonly finished: string;
  readonly outcome: Outcome;
  /** One sentence of what the tool answered, or of why it did not. */
  readonly said: string;
  /**
   * Whether this Run started after its Due time, because the Host was not up
   * when the time arrived. A 23:40 Run of a 09:00 Job explains itself.
   */
  readonly late: boolean;
};

export type JobState = {
  /**
   * When this Plugin first saw the Job. A Job it has never seen does not Run
   * at once, so creating four Jobs at midnight starts nothing at midnight.
   */
  readonly seenAt: string;
  /**
   * The most recent Due time this Plugin has already acted on, by Running the
   * Job or by Skipping it.
   *
   * It is what makes a Job Run once however many Due times passed while the
   * Host was down: three days off is one Due time newer than this one, not
   * three Runs. A Run by hand never moves it, because running a Job now does
   * not change when it was next going to happen.
   */
  readonly lastDue: string | null;
  /** When the last Run started. Written before the call goes out, never after. */
  readonly lastStarted: string | null;
  readonly runs: readonly Run[];
};

/** How many Runs of each Job are kept. Fixed, so there is nothing to rotate. */
export const RUNS_KEPT = 10;

export type State = { readonly jobs: Readonly<Record<string, JobState>> };

/** A Plugin that has run nothing yet. */
export const NOTHING_YET: State = { jobs: {} };

/**
 * The state file.
 *
 * A missing one means every Job is new, which is what a Scheduler that has
 * just been registered is. One that cannot be read is a sentence and nothing
 * else: guessing would throw away a history, and deleting the file is the
 * documented way to start over.
 */
export async function readState(file: string = STATE_FILE): Promise<State> {
  const path = resolve(file);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (fault) {
    if ((fault as NodeJS.ErrnoException).code === 'ENOENT') return NOTHING_YET;
    throw new Error(`The state file at ${path} could not be read: ${sentence(fault)}`);
  }

  let held: unknown;
  try {
    held = JSON.parse(text);
  } catch (fault) {
    throw new Error(
      `The state file at ${path} is not valid JSON: ${sentence(fault)} ` +
        'Deleting it starts the history over and loses nothing but the history.',
    );
  }

  const jobs = (held as { jobs?: unknown } | null)?.jobs;
  if (typeof jobs !== 'object' || jobs === null || Array.isArray(jobs)) {
    throw new Error(
      `The state file at ${path} needs a "jobs" object. ` +
        'Deleting it starts the history over and loses nothing but the history.',
    );
  }
  return { jobs: jobs as Record<string, JobState> };
}

/** One write at a time, so no two of them share the file they write through. */
let writing: Promise<void> = Promise.resolve();

/**
 * Write the state whole, then move it into place.
 *
 * The move is what makes a reader safe: a rename over an existing file is one
 * step, so nobody ever opens this file and finds half a write.
 *
 * The writes are serialised, and each goes through a file of its own. A Run
 * writes its start and its Outcome while the tick may be writing too, and two
 * writers sharing one half-written file would lose one of them — which, for
 * the write that records a Run's start, would mean running that Job twice.
 */
export function writeState(state: State, file: string = STATE_FILE): Promise<void> {
  const next = writing.then(
    () => put(state, file),
    () => put(state, file),
  );
  writing = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

let through = 0;

async function put(state: State, file: string): Promise<void> {
  const path = resolve(file);
  const own = `${path}.${process.pid}.${(through += 1)}.writing`;
  await writeFile(own, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(own, path);
}

function sentence(fault: unknown): string {
  return fault instanceof Error ? fault.message : String(fault);
}
