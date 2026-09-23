/**
 * The Jobs as this Plugin currently holds them, and the sentence for when the
 * file they came from has gone wrong.
 *
 * The jobs file is re-read on every tick rather than watched. Watching a file
 * is a second way for the truth to arrive and a third state to get wrong; the
 * tick is already there, and a change that takes up to a minute to be noticed
 * is a change noticed soon enough.
 *
 * The rule that makes this a file of its own: a jobs file that is wrong when
 * the Plugin Server *starts* stops it, and a jobs file that goes wrong while
 * it is *running* does not. A running clock must not kill itself over a typo
 * somebody is still in the middle of making, so the last good Jobs stay, and
 * the sentence goes to the Page instead.
 */
import { readJobs, type Job } from './jobs.ts';

export type Held = {
  /** The last Jobs that were read whole and made sense. */
  jobs(): readonly Job[];
  /** What is wrong with the jobs file, or null when nothing is. */
  problem(): string | null;
  /** Read the file again. The last good Jobs survive a read that fails. */
  reread(): Promise<void>;
};

export function hold(initial: readonly Job[]): Held {
  let jobs = initial;
  let problem: string | null = null;

  return {
    jobs: () => jobs,
    problem: () => problem,
    reread: async () => {
      try {
        jobs = await readJobs();
        problem = null;
      } catch (fault) {
        problem = fault instanceof Error ? fault.message : String(fault);
      }
    },
  };
}
