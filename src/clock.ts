/**
 * The clock, and the one runner behind it.
 *
 * The Plugin Server is already resident for the life of the Host, so the clock
 * is a tick against the wall clock and nothing more: every sixty seconds it
 * wakes, reads the wall clock, and compares it with every Job (ADR-0001).
 *
 * A tick, never a long timer. Node's timers run on a clock that does not
 * advance while the machine is suspended, and this Host runs in WSL2, where
 * Windows suspends the whole virtual machine. Reading the wall clock on every
 * wake makes a suspend, an NTP step, a manual clock change and a DST shift one
 * case with no code of its own. Worst-case lateness is one tick.
 *
 * The first wake is never at start-up. The Host starts every Plugin Server at
 * once, and a target is only reachable once its own handshake has finished, so
 * a call fired at t=0 would be told the target is Stopped when it is merely
 * still starting. The tick provides that delay for free.
 *
 * One Run at a time, across every Job. Two Jobs Due in the same minute Run one
 * after the other, in the order the jobs file lists them. The tick itself is
 * not in that queue: it keeps waking while a Run is going, which is how a Job
 * that comes Due during its own Run is seen at all.
 *
 * Nothing is ever retried. Whatever a Run ended as, the Job's next Due time is
 * the next thing that happens to it.
 */
import { callPlugin, type BusResult } from './bus.ts';
import type { Config } from './config.ts';
import { previousDue } from './due.ts';
import type { Held } from './held.ts';
import type { Job } from './jobs.ts';
import { writeState, RUNS_KEPT, type JobState, type Run, type State } from './state.ts';

/** How much of what a tool answered is kept as the Run's one sentence. */
const SENTENCE_LIMIT = 300;

const MINUTE = 60_000;

export type Clock = {
  /** The state as it stands, for whatever draws it. */
  now(): State;
  /** Run one Job now, through the same runner and as the same kind of Run. */
  runNow(name: string): Promise<Run>;
  /**
   * Let this Job take its next Due time rather than its last one.
   *
   * A Job created just now must not Run at once, even where the state file
   * still remembers a Job of that name from before. Its history is kept: only
   * the Due time it is measured against moves.
   */
  freshen(name: string): Promise<void>;
  /** Stop waking. The Host closing stdin is what ends the process. */
  stop(): void;
};

export function startClock(held: Held, remembered: State, config: Config): Clock {
  let state = remembered;
  /** One Run at a time, across every Job and whoever asked for one. */
  let queue: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  /** The Jobs with a Run in flight, each by the Due time it is Running for. */
  const inFlight = new Map<string, number>();

  function through<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    // Whatever this Run ended as, the next one still gets its turn.
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function remember(name: string, changed: Partial<JobState>): void {
    const was = state.jobs[name];
    const now = new Date().toISOString();
    state = {
      jobs: {
        ...state.jobs,
        [name]: {
          seenAt: was?.seenAt ?? now,
          lastDue: was?.lastDue ?? null,
          lastStarted: was?.lastStarted ?? null,
          runs: was?.runs ?? [],
          ...changed,
        },
      },
    };
  }

  /** Keep this Run, and the nine before it. The cap is fixed; nothing rotates. */
  function keep(name: string, run: Run): void {
    const runs = [...(state.jobs[name]?.runs ?? []), run];
    remember(name, { runs: runs.slice(-RUNS_KEPT) });
  }

  /**
   * One Run of one Job.
   *
   * `due` is the Due time this Run answers, or null when a person asked for it
   * by hand: a Run by hand does not move the Job's next Due time.
   */
  async function run(job: Job, due: number | null, late: boolean): Promise<Run> {
    const started = Date.now();

    // Written before the call goes out, never after. A Run that kills this
    // process must not be re-decided as Due and run a second time on restart.
    remember(job.name, {
      lastStarted: new Date(started).toISOString(),
      ...(due === null ? {} : { lastDue: new Date(due).toISOString() }),
    });
    await writeState(state);

    const answer = await callPlugin(job.plugin, job.tool, job.arguments, config.callMs);
    const done = runOf(started, Date.now(), answer, config.callMs, late);
    keep(job.name, done);
    await writeState(state);

    // A Run that is not ok leaves exactly one line, so a failure is findable.
    // A Run that is ok leaves none, so the journal stays worth reading.
    if (done.outcome !== 'ok') {
      process.stderr.write(`scheduler: the Job ${job.name} ${done.outcome}: ${done.said}\n`);
    }
    return done;
  }

  /** One wake: read the wall clock, and act on every Job it has caught up to. */
  async function tick(): Promise<void> {
    // The jobs file is read again here, so a hand edit costs nothing and needs
    // no restart. A file that has gone wrong leaves the last good Jobs in
    // place and puts its sentence on the Page.
    await held.reread();

    const now = Date.now();
    let moved = false;

    for (const job of held.jobs()) {
      if (!job.enabled) continue;

      const held = state.jobs[job.name];
      if (held === undefined) {
        // A Job this Plugin has never seen takes its next Due time and waits.
        // It never had a Due time to miss, so it is not Late either.
        remember(job.name, { seenAt: new Date(now).toISOString() });
        moved = true;
        continue;
      }

      const due = previousDue(job.when, now);
      if (due === null) continue;
      if (due <= Date.parse(held.lastDue ?? held.seenAt)) continue;

      const running = inFlight.get(job.name);
      if (running !== undefined) {
        // Already being Run for this Due time, or waiting its turn for it.
        if (due <= running) continue;
        // A newer Due time arrived while the Job's own Run was still going. It
        // is Skipped and never queued, so a slow Job cannot pile up a backlog.
        remember(job.name, { lastDue: new Date(due).toISOString() });
        keep(job.name, skipped(now, 'its previous Run was still going.'));
        moved = true;
        continue;
      }

      const lateBy = now - due;
      if (lateBy > job.missedRunGraceMinutes * MINUTE) {
        // Past its Grace. Friday's Job must not fire on Tuesday pretending to
        // be this morning, so it is recorded rather than run, and recorded
        // rather than forgotten.
        remember(job.name, { lastDue: new Date(due).toISOString() });
        keep(
          job.name,
          skipped(
            now,
            `it came Due ${minutesOf(lateBy)} ago, which is past its Grace of ` +
              `${job.missedRunGraceMinutes} minutes.`,
          ),
        );
        moved = true;
        continue;
      }

      // Later than one tick after its Due time means the Host was not up when
      // the time arrived. Within one tick is simply the clock doing its job.
      inFlight.set(job.name, due);
      void through(() => run(job, due, lateBy > config.tickMs)).finally(() =>
        inFlight.delete(job.name),
      );
    }

    if (moved) await writeState(state);
  }

  function wake(): void {
    timer = setTimeout(() => {
      void tick().finally(wake);
    }, config.tickMs);
    // The tick must never be the reason this process stays up. The Host
    // closing stdin is what ends it.
    timer.unref();
  }

  wake();

  return {
    now: () => state,
    freshen: async (name) => {
      remember(name, { seenAt: new Date().toISOString(), lastDue: null });
      await writeState(state);
    },
    runNow: (name) => {
      const job = held.jobs().find((one) => one.name === name);
      if (job === undefined) {
        return Promise.reject(new Error(`No Job named "${name}" is in the jobs file.`));
      }
      // A Run by hand is in flight like any other, marked with the Due time
      // the Job has already been decided about, so a newer one arriving while
      // it is going is Skipped rather than queued behind it.
      const was = state.jobs[job.name];
      inFlight.set(job.name, Date.parse(was?.lastDue ?? was?.seenAt ?? '') || 0);
      return through(() => run(job, null, false)).finally(() => inFlight.delete(job.name));
    },
    stop: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** A Job that came Due and was not Run. It is recorded, never silent. */
function skipped(at: number, why: string): Run {
  const when = new Date(at).toISOString();
  return {
    started: when,
    finished: when,
    outcome: 'skipped',
    said: `This Job was not Run because ${why}`,
    late: false,
  };
}

/** What a Run ended as, from what came back. */
function runOf(
  started: number,
  finished: number,
  answer: BusResult,
  waitMs: number,
  late: boolean,
): Run {
  const when = {
    started: new Date(started).toISOString(),
    finished: new Date(finished).toISOString(),
    late,
  };

  if (answer.kind === 'timed-out') {
    return {
      ...when,
      outcome: 'timed-out',
      said:
        `The Scheduler stopped waiting after ${waitMs} ms. Nothing was cancelled, so the ` +
        'tool it called may still be running. This Run is not repeated.',
    };
  }
  if (answer.kind === 'refused') {
    return { ...when, outcome: 'failed', said: answer.said };
  }

  const result = answer.result as
    | { content?: { type: string; text?: string }[]; isError?: boolean }
    | undefined;
  const said = sentenceOf(result?.content);
  // A tool that answered, and said in its answer that it failed, failed.
  if (result?.isError === true) {
    return { ...when, outcome: 'failed', said: said === '' ? 'The tool reported an error.' : said };
  }
  return { ...when, outcome: 'ok', said: said === '' ? 'The tool answered nothing.' : said };
}

/** How late something was, in words a person reads rather than milliseconds. */
function minutesOf(span: number): string {
  const minutes = Math.floor(span / MINUTE);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.floor(hours / 24)} days`;
}

/** One sentence of what a tool answered, which is all the Page has room for. */
function sentenceOf(content: readonly { type: string; text?: string }[] | undefined): string {
  const said = (content ?? [])
    .map((part) => part.text ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return said.length <= SENTENCE_LIMIT ? said : `${said.slice(0, SENTENCE_LIMIT - 1)}…`;
}
