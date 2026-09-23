/**
 * Late, Skipped, and the last ten Runs.
 *
 * A Job that was Due while the Host was down still happens — once, and only if
 * it is not too late. Everything here falls out of two things the Plugin
 * already writes down: the Due time it last acted on, and the Job's Grace.
 *
 * Every case seeds the state file with a past Run rather than waiting. The
 * clock, the code and the wall clock are all the real ones.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startPluginServer, structureOf, type Answer, type Question } from './helpers/plugin.ts';

const TICK_MS = '40';
const DAY = 24 * 60 * 60 * 1000;

/** An hourly Job: its most recent Due time is never more than an hour ago. */
const HOURLY = {
  name: 'nexus-skills',
  enabled: true,
  when: { every: 'hourly', timezone: 'UTC' },
  plugin: 'nexus',
  tool: 'list_skills',
  arguments: {},
  missedRunGraceMinutes: 720,
};

/** A daily Job at midnight: its most recent Due time is up to a day ago. */
const DAILY = { ...HOURLY, when: { every: 'daily', at: '00:00', timezone: 'UTC' } };

function state(jobs: Record<string, unknown>): string {
  return JSON.stringify({ jobs }, null, 2);
}

/** A Job last dealt with two days ago, so its most recent Due time is newer. */
function dealtWithLongAgo(): Record<string, unknown> {
  const then = new Date(Date.now() - 2 * DAY).toISOString();
  return { 'nexus-skills': { seenAt: then, lastDue: then, lastStarted: then, runs: [] } };
}

async function until<T>(get: () => Promise<T | null>, what: string, within = 5000): Promise<T> {
  const deadline = Date.now() + within;
  for (;;) {
    const got = await get();
    if (got !== null) return got;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in ${within} ms.`);
    await new Promise((done) => setTimeout(done, 15));
  }
}

type Run = { readonly outcome: string; readonly said: string; readonly late: boolean };
type Listed = { readonly jobs: readonly { readonly name: string; readonly runs: readonly Run[] }[] };

function runsOf(
  plugin: { ask(method: string, params?: unknown): Promise<Answer> },
  name: string,
): () => Promise<readonly Run[] | null> {
  return async () => {
    const answer = await plugin.ask('tools/call', { name: 'list_jobs', arguments: {} });
    const runs = (structureOf(answer) as Listed).jobs.find((job) => job.name === name)?.runs ?? [];
    return runs.length === 0 ? null : runs;
  };
}

function answered(text: string): Answer {
  return { result: { content: [{ type: 'text', text }] } };
}

test('a Job Due while the Plugin was down Runs once, however many Due times passed', async (t) => {
  const asked: Question[] = [];
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: {
      'jobs.json': JSON.stringify({ jobs: [HOURLY] }),
      // Two days down is forty-eight missed Due times for an hourly Job.
      'state.json': state(dealtWithLongAgo()),
    },
    host: (question) => {
      asked.push(question);
      return answered('37 Installed Skills.');
    },
  });
  await plugin.handshake();
  await until(runsOf(plugin, 'nexus-skills'), 'the Job ran');
  await new Promise((done) => setTimeout(done, 400));

  assert.equal(asked.length, 1, `the Job was called ${asked.length} times, not once`);
});

test('a Run that started after its Due time is marked Late, so the Page can explain it', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: {
      'jobs.json': JSON.stringify({ jobs: [HOURLY] }),
      'state.json': state(dealtWithLongAgo()),
    },
    host: () => answered('done'),
  });
  await plugin.handshake();

  const runs = await until(runsOf(plugin, 'nexus-skills'), 'the Job ran');

  assert.equal(runs[0]?.outcome, 'ok');
  assert.equal(runs[0]?.late, true);
});

test('a Job Due longer ago than its Grace is Skipped, not Run, and says how late it was', async (t) => {
  const asked: Question[] = [];
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: {
      // Midnight UTC, with no Grace at all: by any hour of any day this Job is
      // Due later than it is allowed to be.
      'jobs.json': JSON.stringify({ jobs: [{ ...DAILY, missedRunGraceMinutes: 0 }] }),
      'state.json': state(dealtWithLongAgo()),
    },
    host: (question) => {
      asked.push(question);
      return answered('done');
    },
  });
  await plugin.handshake();

  const runs = await until(runsOf(plugin, 'nexus-skills'), 'the Job was decided about');

  assert.equal(asked.length, 0, 'a Job past its Grace was called anyway');
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.outcome, 'skipped');
  assert.ok(/past its Grace/i.test(runs[0]?.said ?? ''), runs[0]?.said);
  assert.ok(/came Due/i.test(runs[0]?.said ?? ''), runs[0]?.said);
  assert.equal(runs[0]?.late, false);
});

test('the same Job inside its Grace Runs instead, which is what the Grace is for', async (t) => {
  const asked: Question[] = [];
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: {
      // A whole day of Grace covers a Job that comes Due once a day.
      'jobs.json': JSON.stringify({ jobs: [{ ...DAILY, missedRunGraceMinutes: 1440 }] }),
      'state.json': state(dealtWithLongAgo()),
    },
    host: (question) => {
      asked.push(question);
      return answered('done');
    },
  });
  await plugin.handshake();

  const runs = await until(runsOf(plugin, 'nexus-skills'), 'the Job ran');

  assert.equal(asked.length, 1);
  assert.equal(runs[0]?.outcome, 'ok');
  assert.equal(runs[0]?.late, true);
});

test('a Job the state file has never seen does not Run at start, and is not Late', async (t) => {
  const asked: Question[] = [];
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    // No state file at all: every Job is new, and a new Job never had a Due
    // time to miss.
    files: { 'jobs.json': JSON.stringify({ jobs: [HOURLY] }) },
    host: (question) => {
      asked.push(question);
      return answered('done');
    },
  });
  await plugin.handshake();
  await new Promise((done) => setTimeout(done, 500));

  assert.equal(asked.length, 0, 'a Job the Plugin had never seen ran at start');

  // It took its next Due time and waits: the state file now knows it.
  const held = JSON.parse(await readFile(join(plugin.directory, 'state.json'), 'utf8'));
  assert.ok(typeof held.jobs['nexus-skills']?.seenAt === 'string');
  assert.equal(held.jobs['nexus-skills']?.lastStarted, null);
});

test('each Job keeps its last ten Runs and no more', async (t) => {
  const then = new Date(Date.now() - 2 * DAY).toISOString();
  const already = Array.from({ length: 12 }, (_, at) => ({
    started: then,
    finished: then,
    outcome: 'ok',
    said: `run ${at}`,
    late: false,
  }));
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: {
      'jobs.json': JSON.stringify({ jobs: [HOURLY] }),
      'state.json': state({
        'nexus-skills': { seenAt: then, lastDue: then, lastStarted: then, runs: already },
      }),
    },
    host: () => answered('the newest one'),
  });
  await plugin.handshake();

  const runs = await until(async () => {
    const got = await runsOf(plugin, 'nexus-skills')();
    return got !== null && got[got.length - 1]?.said === 'the newest one' ? got : null;
  }, 'the Job ran');

  assert.equal(runs.length, 10);
  assert.equal(runs[runs.length - 1]?.said, 'the newest one');
  // The nine kept beside it are the nine most recent, not the nine oldest.
  assert.equal(runs[0]?.said, 'run 3');
});

test('a state file that cannot be read stops the Plugin Server, and says how to start over', async (t) => {
  const plugin = await startPluginServer(t, {
    files: {
      'jobs.json': JSON.stringify({ jobs: [HOURLY] }),
      'state.json': '{ "jobs": ',
    },
  });

  const ending = await plugin.ended();

  assert.notEqual(ending.code, 0);
  assert.ok(plugin.output().includes('state.json'), plugin.output());
  assert.ok(/deleting it/i.test(plugin.output()), plugin.output());
});
