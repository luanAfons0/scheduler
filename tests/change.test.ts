/**
 * Changing a Job in place, under its name (ADR-0002).
 *
 * A change is a write like `add_job`, through the same check and the same
 * hash, but it keeps what a person did not ask to change: the Job Name, which
 * is the key to the Job's history, and `enabled`, which only `enable_job`
 * moves. And like a Job just added, a changed Job takes its next Due time
 * from now, so a change never makes a Run.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startPluginServer, structureOf, type Answer, type Started } from './helpers/plugin.ts';

const HOUR = 60 * 60 * 1000;

const JOB = {
  name: 'daily-cycle',
  enabled: true,
  when: { every: 'daily', at: '13:00', timezone: 'UTC' },
  plugin: 'nexus',
  tool: 'list_skills',
  arguments: {},
  missedRunGraceMinutes: 720,
};

type Listed = {
  readonly hash: string;
  readonly jobs: readonly {
    readonly name: string;
    readonly enabled: boolean;
    readonly when: unknown;
    readonly tool: string;
    readonly nextDue: string | null;
    readonly runs: readonly unknown[];
  }[];
};

async function listed(plugin: Started): Promise<Listed> {
  const answer = await plugin.ask('tools/call', { name: 'list_jobs', arguments: {} });
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  return structureOf(answer) as Listed;
}

async function jobsFileOf(plugin: Started): Promise<{ jobs: unknown[] }> {
  return JSON.parse(await readFile(join(plugin.directory, 'jobs.json'), 'utf8'));
}

function answered(text: string): Answer {
  return { result: { content: [{ type: 'text', text }] } };
}

/** The time of day `offset` from now, in UTC, the way a When writes it. */
function atFromNow(offset: number): string {
  return new Date(Date.now() + offset).toISOString().slice(11, 16);
}

/** A Plugin Server that will not be caught by its own clock during a case. */
async function quiet(t: Parameters<typeof startPluginServer>[0], jobs: unknown[]) {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: '30000' },
    files: { 'jobs.json': JSON.stringify({ jobs }, null, 2) },
    host: () => answered('done'),
  });
  await plugin.handshake();
  return plugin;
}

async function change(plugin: Started, job: unknown): Promise<Answer> {
  return plugin.ask('tools/call', {
    name: 'change_job',
    arguments: { job, ifMatch: (await listed(plugin)).hash },
  });
}

test('a change of When shows the new When and next Due time, and keeps the Runs', async (t) => {
  const plugin = await quiet(t, [JOB]);
  await plugin.ask('tools/call', { name: 'run_job', arguments: { name: 'daily-cycle' } });
  assert.equal((await listed(plugin)).jobs[0]?.runs.length, 1);

  const moved = { ...JOB, when: { every: 'daily', at: '15:00', timezone: 'UTC' } };
  const answer = await change(plugin, moved);

  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.deepEqual((await jobsFileOf(plugin)).jobs, [moved]);
  const after = await listed(plugin);
  assert.deepEqual(after.jobs[0]?.when, moved.when);
  assert.ok(after.jobs[0]?.nextDue?.endsWith('T15:00:00.000Z'), after.jobs[0]?.nextDue ?? 'null');
  assert.equal(after.jobs[0]?.runs.length, 1, 'the change lost the Run history');
});

test('a change can point a Job at another tool, with other arguments and Grace', async (t) => {
  const plugin = await quiet(t, [JOB, { ...JOB, name: 'other' }]);

  const changed = {
    ...JOB,
    plugin: 'firstmate',
    tool: 'check_skills',
    arguments: { quiet: true },
    missedRunGraceMinutes: 30,
  };
  const answer = await change(plugin, changed);

  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.deepEqual((await jobsFileOf(plugin)).jobs, [changed, { ...JOB, name: 'other' }]);
});

test('a change and an add refuse the same bad Job in the same sentence', async (t) => {
  const plugin = await quiet(t, [JOB]);
  const before = await listed(plugin);
  const bad = { ...JOB, when: { every: '*/5 * * * *', timezone: 'UTC' } };

  const changed = await change(plugin, bad);
  const added = await plugin.ask('tools/call', {
    name: 'add_job',
    arguments: { job: { ...bad, name: 'daily-cycle' }, ifMatch: before.hash },
  });

  assert.equal(changed.result, undefined);
  assert.ok(changed.error?.message.includes('*/5 * * * *'), changed.error?.message);
  assert.equal(changed.error?.message, added.error?.message);
  assert.deepEqual((await jobsFileOf(plugin)).jobs, [JOB]);
  assert.equal((await listed(plugin)).hash, before.hash);
});

test('a change of a Job that is not in the file says so, naming it', async (t) => {
  const plugin = await quiet(t, [JOB]);

  const answer = await change(plugin, { ...JOB, name: 'polish-the-boots' });

  assert.equal(answer.result, undefined);
  assert.equal(answer.error?.message, 'No Job named "polish-the-boots" is in the jobs file.');
  assert.deepEqual((await jobsFileOf(plugin)).jobs, [JOB]);
});

test('a change keeps enabled from the file, whatever the change says', async (t) => {
  const plugin = await quiet(t, [{ ...JOB, enabled: false }]);

  const answer = await change(plugin, { ...JOB, enabled: true, tool: 'check_skills' });

  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.deepEqual((await jobsFileOf(plugin)).jobs, [
    { ...JOB, enabled: false, tool: 'check_skills' },
  ]);
});

test('a change whose hash no longer matches is refused, and nothing is written', async (t) => {
  const plugin = await quiet(t, [JOB]);

  const answer = await plugin.ask('tools/call', {
    name: 'change_job',
    arguments: { job: { ...JOB, tool: 'check_skills' }, ifMatch: 'a-hash-from-before' },
  });

  assert.equal(answer.result, undefined);
  assert.ok(/changed since/i.test(answer.error?.message ?? ''), answer.error?.message);
  assert.deepEqual((await jobsFileOf(plugin)).jobs, [JOB]);
});

test('a change never makes a Run, even to a time already past today', async (t) => {
  const called: string[] = [];
  const now = Date.now();
  const before = { ...JOB, when: { every: 'daily', at: atFromNow(3 * HOUR), timezone: 'UTC' } };
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: '40' },
    files: {
      'jobs.json': JSON.stringify({ jobs: [before] }),
      // Last Due two hours ago. Read against that, a time one hour ago would
      // be Due at once; a change must take its next Due time from now instead.
      'state.json': JSON.stringify({
        jobs: {
          'daily-cycle': {
            seenAt: new Date(now - 48 * HOUR).toISOString(),
            lastDue: new Date(now - 2 * HOUR).toISOString(),
            lastStarted: null,
            runs: [],
          },
        },
      }),
    },
    host: (question) => {
      called.push(String(question.params['name']));
      return answered('done');
    },
  });
  await plugin.handshake();
  await plugin.ask('tools/call', { name: 'run_job', arguments: { name: 'daily-cycle' } });
  assert.equal(called.length, 1);

  const answer = await change(plugin, {
    ...before,
    when: { every: 'daily', at: atFromNow(-HOUR), timezone: 'UTC' },
  });
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  await new Promise((done) => setTimeout(done, 500));

  assert.equal(called.length, 1, 'the change made a Run');
  assert.equal((await listed(plugin)).jobs[0]?.runs.length, 1);
});
