/**
 * Run a Job now.
 *
 * It is the same runner and the same kind of Run, so the feedback loop on a
 * Job you have just written is seconds rather than a day. What makes it worth
 * its own file is what it must *not* do: move the Job's clock, turn a Job that
 * is off back on, or run beside anything else.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startPluginServer, structureOf, type Answer, type Question } from './helpers/plugin.ts';

const DAY = 24 * 60 * 60 * 1000;

const JOB = {
  name: 'nexus-skills',
  enabled: true,
  when: { every: 'hourly', timezone: 'UTC' },
  plugin: 'nexus',
  tool: 'list_skills',
  arguments: {},
  missedRunGraceMinutes: 720,
};

/** A Job the clock will not touch on its own during a test this short. */
function settled(): string {
  const now = new Date().toISOString();
  return JSON.stringify({
    jobs: { 'nexus-skills': { seenAt: now, lastDue: now, lastStarted: now, runs: [] } },
  });
}

function answered(text: string): Answer {
  return { result: { content: [{ type: 'text', text }] } };
}

type Ran = { readonly name: string; readonly run: { outcome: string; said: string; late: boolean } };

test('run_job runs the Job at once and answers with the Run it made', async (t) => {
  const asked: Question[] = [];
  const plugin = await startPluginServer(t, {
    // A tick far longer than this test, so nothing here is the clock's doing.
    env: { SCHEDULER_TICK_MS: '30000' },
    files: { 'jobs.json': JSON.stringify({ jobs: [JOB] }), 'state.json': settled() },
    host: (question) => {
      asked.push(question);
      return answered('37 Installed Skills.');
    },
  });
  await plugin.handshake();

  const answer = await plugin.ask('tools/call', {
    name: 'run_job',
    arguments: { name: 'nexus-skills' },
  });

  const ran = structureOf(answer) as Ran;
  assert.equal(ran.run.outcome, 'ok');
  assert.equal(ran.run.said, '37 Installed Skills.');
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.params['name'], 'list_skills');
});

test('a Run by hand is neither Late nor skipped', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: '30000' },
    files: { 'jobs.json': JSON.stringify({ jobs: [JOB] }), 'state.json': settled() },
    host: () => answered('done'),
  });
  await plugin.handshake();

  const answer = await plugin.ask('tools/call', {
    name: 'run_job',
    arguments: { name: 'nexus-skills' },
  });

  const ran = structureOf(answer) as Ran;
  assert.equal(ran.run.late, false);
  assert.equal(ran.run.outcome, 'ok');
});

test('a Run by hand does not move the Job’s clock', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: '30000' },
    files: { 'jobs.json': JSON.stringify({ jobs: [JOB] }), 'state.json': settled() },
    host: () => answered('done'),
  });
  await plugin.handshake();
  const before = JSON.parse(await readFile(join(plugin.directory, 'state.json'), 'utf8'));

  await plugin.ask('tools/call', { name: 'run_job', arguments: { name: 'nexus-skills' } });

  const after = JSON.parse(await readFile(join(plugin.directory, 'state.json'), 'utf8'));
  assert.equal(after.jobs['nexus-skills'].lastDue, before.jobs['nexus-skills'].lastDue);
  // It is still a Run, so the Job did start.
  assert.notEqual(after.jobs['nexus-skills'].lastStarted, before.jobs['nexus-skills'].lastStarted);
});

test('a Job that is off can still be run by hand, and stays off', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: '30000' },
    files: {
      'jobs.json': JSON.stringify({ jobs: [{ ...JOB, enabled: false }] }),
      'state.json': settled(),
    },
    host: () => answered('done'),
  });
  await plugin.handshake();

  const answer = await plugin.ask('tools/call', {
    name: 'run_job',
    arguments: { name: 'nexus-skills' },
  });
  assert.equal((structureOf(answer) as Ran).run.outcome, 'ok');

  const listed = await plugin.ask('tools/call', { name: 'list_jobs', arguments: {} });
  const job = (structureOf(listed) as { jobs: { enabled: boolean; nextDue: string | null }[] })
    .jobs[0];
  assert.equal(job?.enabled, false);
  assert.equal(job?.nextDue, null);
});

test('a Job Name that is not in the jobs file answers with a sentence naming it', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: '30000' },
    files: { 'jobs.json': JSON.stringify({ jobs: [JOB] }) },
  });
  await plugin.handshake();

  const answer = await plugin.ask('tools/call', {
    name: 'run_job',
    arguments: { name: 'polish-the-boots' },
  });

  assert.equal(answer.result, undefined);
  assert.ok(answer.error?.message.includes('polish-the-boots'), answer.error?.message);
});

test('two Runs by hand wait their turn rather than running beside each other', async (t) => {
  let inFlight = 0;
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: '30000' },
    files: {
      'jobs.json': JSON.stringify({ jobs: [JOB, { ...JOB, name: 'other' }] }),
      'state.json': settled(),
    },
    host: async () => {
      inFlight += 1;
      assert.equal(inFlight, 1, 'two Runs were in flight at once');
      await new Promise((done) => setTimeout(done, 80));
      inFlight -= 1;
      return answered('done');
    },
  });
  await plugin.handshake();

  const both = await Promise.all([
    plugin.ask('tools/call', { name: 'run_job', arguments: { name: 'nexus-skills' } }),
    plugin.ask('tools/call', { name: 'run_job', arguments: { name: 'other' } }),
  ]);

  for (const answer of both) assert.equal((structureOf(answer) as Ran).run.outcome, 'ok');
});

test('a Job that comes Due while its own Run is still going is Skipped, and never queued', async (t) => {
  const asked: Question[] = [];
  const plugin = await startPluginServer(t, {
    // The tick comes round twice while the Run by hand is still going.
    env: { SCHEDULER_TICK_MS: '250' },
    files: {
      'jobs.json': JSON.stringify({ jobs: [JOB] }),
      // Two days since this Job was last dealt with, so the clock has a Due
      // time for it that is newer than anything it has acted on.
      'state.json': JSON.stringify({
        jobs: {
          'nexus-skills': {
            seenAt: new Date(Date.now() - 2 * DAY).toISOString(),
            lastDue: new Date(Date.now() - 2 * DAY).toISOString(),
            lastStarted: new Date(Date.now() - 2 * DAY).toISOString(),
            runs: [],
          },
        },
      }),
    },
    host: async (question) => {
      asked.push(question);
      await new Promise((done) => setTimeout(done, 900));
      return answered('the long one');
    },
  });
  await plugin.handshake();

  // Start it by hand, and let the clock find it Due while it is still going.
  const byHand = plugin.ask('tools/call', { name: 'run_job', arguments: { name: 'nexus-skills' } });
  assert.equal((structureOf(await byHand) as Ran).run.outcome, 'ok');

  const listed = await plugin.ask('tools/call', { name: 'list_jobs', arguments: {} });
  const runs = (structureOf(listed) as { jobs: { runs: { outcome: string; said: string }[] }[] })
    .jobs[0]?.runs;

  const skipped = (runs ?? []).filter((run) => run.outcome === 'skipped');
  assert.equal(skipped.length, 1, JSON.stringify(runs));
  assert.ok(/previous Run was still going/i.test(skipped[0]?.said ?? ''), skipped[0]?.said);
  // Skipped, never queued: the tool was called once, by the hand that asked.
  assert.equal(asked.length, 1, `the tool was called ${asked.length} times`);
});
