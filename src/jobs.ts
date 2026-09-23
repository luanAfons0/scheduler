/**
 * A Job, read from and written to the jobs file.
 *
 * The file is the truth and a person may edit it by hand, so it is read whole
 * or not at all: one Job with a field that makes no sense means no Job is
 * scheduled. There is no half-loaded jobs file, because a clock that runs
 * three of your four Jobs is worse than one that will not start.
 *
 * Every refusal names the file, the Job and the field. That is what someone
 * halfway through an edit needs, and it is the whole of what the journal will
 * carry when the Index Page says Stopped.
 *
 * A Job is data. There is no cron, no RRULE and no expression language here:
 * the fields are the grammar, so there is nothing to parse and nothing to get
 * subtly wrong.
 */
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DAYS, EVERY, isTimeOfDay, knowsZone, type Day, type Every, type When } from './due.ts';

/** The jobs file, in the Plugin's own directory, which is where it is started. */
export const JOBS_FILE = 'jobs.json';

/** A name, a When, and one tool of one Plugin to call at that time. */
export type Job = {
  /** Unique, non-empty, and the same key in the state file and the history. */
  readonly name: string;
  readonly enabled: boolean;
  readonly when: When;
  /** The Plugin Name whose tool this Job calls. */
  readonly plugin: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** How long after a Due time this Job may still Run Late. */
  readonly missedRunGraceMinutes: number;
};

/**
 * Every Job in the jobs file.
 *
 * A missing file is not an error: it is a Plugin with no Jobs, which is what
 * a Scheduler that has just been registered is. Anything else that is wrong
 * throws a sentence.
 */
export async function readJobs(file: string = JOBS_FILE): Promise<readonly Job[]> {
  const path = resolve(file);
  const where = `The jobs file at ${path} is wrong. `;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (fault) {
    if ((fault as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`The jobs file at ${path} could not be read: ${sentence(fault)}`);
  }

  let held: unknown;
  try {
    held = JSON.parse(text);
  } catch (fault) {
    throw new Error(`The jobs file at ${path} is not valid JSON: ${sentence(fault)}`);
  }

  const listed = (held as { jobs?: unknown } | null)?.jobs;
  if (!Array.isArray(listed)) {
    throw new Error(`The jobs file at ${path} needs a "jobs" array.`);
  }

  const jobs: Job[] = [];
  const taken = new Set<string>();
  for (const one of listed) {
    const job = jobOf(where, one);
    if (taken.has(job.name)) {
      throw new Error(
        `${where}It names the Job "${job.name}" twice. A Job Name is the key to its state ` +
          'and its history, so it belongs to one Job.',
      );
    }
    taken.add(job.name);
    jobs.push(job);
  }
  return jobs;
}

/** One Job, checked exactly as strictly as the file is. */
export function checkJob(held: unknown): Job {
  return jobOf('', held);
}

/**
 * The sha256 of the jobs file as it stands.
 *
 * Every write from the Page carries the one the Page last read, so a click
 * cannot quietly overwrite an edit made somewhere else. A file that is not
 * there hashes as nothing, which is a hash a first write can carry.
 */
export async function hashOfJobs(file: string = JOBS_FILE): Promise<string> {
  const path = resolve(file);
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch (fault) {
    if ((fault as NodeJS.ErrnoException).code === 'ENOENT') {
      return createHash('sha256').update('').digest('hex');
    }
    throw new Error(`The jobs file at ${path} could not be read: ${sentence(fault)}`);
  }
}

/**
 * Write the Jobs whole, then move them into place.
 *
 * The move is what makes a reader safe: a rename over an existing file is one
 * step, so nobody ever opens this file and finds half a write.
 */
export async function writeJobs(jobs: readonly Job[], file: string = JOBS_FILE): Promise<void> {
  const path = resolve(file);
  // A file of this write's own, so that two writers never share a half-written
  // one and rename each other's work into place.
  const own = `${path}.${process.pid}.${(through += 1)}.writing`;
  await writeFile(own, `${JSON.stringify({ jobs }, null, 2)}\n`);
  await rename(own, path);
}

let through = 0;

function jobOf(where: string, held: unknown): Job {
  const given = asObject(held);
  if (given === null) throw new Error(`${where}A Job is not an object.`);

  const name = given['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`${where}A Job has no "name", or its name is empty.`);
  }

  const wrong = (rest: string): Error => new Error(`${where}The Job named "${name}" ${rest}`);

  const enabled = given['enabled'];
  if (typeof enabled !== 'boolean') {
    throw wrong('has no "enabled". Write true to let it Run, or false to leave it off.');
  }

  const plugin = given['plugin'];
  if (typeof plugin !== 'string' || plugin === '') {
    throw wrong('has no "plugin". It is the Plugin Name whose tool this Job calls.');
  }

  const tool = given['tool'];
  if (typeof tool !== 'string' || tool === '') {
    throw wrong('has no "tool". It is one tool of that Plugin.');
  }

  const args = asObject(given['arguments']);
  if (args === null) {
    throw wrong('has no "arguments". A tool that takes none still takes {}.');
  }

  const grace = given['missedRunGraceMinutes'];
  if (typeof grace !== 'number' || !Number.isInteger(grace) || grace < 0) {
    throw wrong(
      'has no "missedRunGraceMinutes". It is whole minutes, and it is how late this Job may ' +
        'still Run before it is Skipped instead.',
    );
  }

  return {
    name,
    enabled,
    when: whenOf(wrong, given['when']),
    plugin,
    tool,
    arguments: args,
    missedRunGraceMinutes: grace,
  };
}

function whenOf(wrong: (rest: string) => Error, held: unknown): When {
  const given = asObject(held);
  if (given === null) {
    throw wrong('has no "when". It is what says at which times the Job is Due.');
  }

  const every = given['every'];
  if (typeof every !== 'string' || !(EVERY as readonly string[]).includes(every)) {
    throw wrong(
      `has a "when.every" of ${JSON.stringify(every)}. It must be ${EVERY.join(', ')} — ` +
        'there is no cron here.',
    );
  }

  const timezone = given['timezone'];
  if (typeof timezone !== 'string' || !knowsZone(timezone)) {
    throw wrong(
      `has a "when.timezone" of ${JSON.stringify(timezone)}, which is not a time zone this ` +
        'machine knows. Write one the IANA database names, like "America/Sao_Paulo".',
    );
  }

  const at = given['at'];
  if (every === 'hourly') {
    if (at !== undefined) {
      throw wrong(
        'is hourly and carries a "when.at". An hourly Job comes Due on the hour, so it has ' +
          'no time of day.',
      );
    }
  } else if (typeof at !== 'string' || !isTimeOfDay(at)) {
    throw wrong(`has a "when.at" of ${JSON.stringify(at)}. A time of day is written "09:00".`);
  }

  const day = given['day'];
  if (every === 'weekly') {
    if (typeof day !== 'string' || !(DAYS as readonly string[]).includes(day)) {
      throw wrong(
        `has a "when.day" of ${JSON.stringify(day)}. A weekly Job needs the day it comes Due ` +
          `on: ${DAYS.join(', ')}.`,
      );
    }
  } else if (day !== undefined) {
    throw wrong(
      `is ${every} and carries a "when.day". Only a weekly Job comes Due on one day of the week.`,
    );
  }

  return {
    every: every as Every,
    timezone,
    ...(every === 'hourly' ? {} : { at: at as string }),
    ...(every === 'weekly' ? { day: day as Day } : {}),
  };
}

function asObject(held: unknown): Record<string, unknown> | null {
  if (typeof held !== 'object' || held === null || Array.isArray(held)) return null;
  return held as Record<string, unknown>;
}

/** Whatever was thrown, as a sentence rather than as a stack trace. */
function sentence(fault: unknown): string {
  return fault instanceof Error ? fault.message : String(fault);
}
