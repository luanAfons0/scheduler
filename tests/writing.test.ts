/**
 * Making, pausing and removing a Job without opening an editor.
 *
 * The jobs file stays the truth and stays hand-editable; the Page is a second
 * way in, never the only one. So two things are proved together here: that a
 * write from the Page lands in the file whole, and that an edit made by hand
 * is picked up without anyone restarting anything.
 */
import { strict as assert } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startPluginServer, structureOf, type Answer, type Started } from './helpers/plugin.ts';

const TICK_MS = '40';

const WHEN = { every: 'weekdays', at: '09:00', timezone: 'America/Sao_Paulo' };

const JOB = {
  name: 'nexus-skills',
  enabled: true,
  when: WHEN,
  plugin: 'nexus',
  tool: 'list_skills',
  arguments: {},
  missedRunGraceMinutes: 720,
};

type Listed = {
  readonly hash: string;
  readonly problem: string | null;
  readonly jobs: readonly {
    readonly name: string;
    readonly enabled: boolean;
    readonly nextDue: string | null;
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

async function until<T>(get: () => Promise<T | null>, what: string, within = 5000): Promise<T> {
  const deadline = Date.now() + within;
  for (;;) {
    const got = await get();
    if (got !== null) return got;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in ${within} ms.`);
    await new Promise((done) => setTimeout(done, 15));
  }
}

/** A Plugin Server that will not be caught by its own clock during a case. */
async function quiet(t: Parameters<typeof startPluginServer>[0], jobs: unknown[] = []) {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: '30000' },
    files: { 'jobs.json': JSON.stringify({ jobs }, null, 2) },
  });
  await plugin.handshake();
  return plugin;
}

test('a Job added from the Page lands in the jobs file, whole', async (t) => {
  const plugin = await quiet(t);
  const before = await listed(plugin);

  const answer = await plugin.ask('tools/call', {
    name: 'add_job',
    arguments: { job: JOB, ifMatch: before.hash },
  });

  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.deepEqual((await jobsFileOf(plugin)).jobs, [JOB]);
  const after = await listed(plugin);
  assert.equal(after.jobs.length, 1);
  assert.equal(after.jobs[0]?.name, 'nexus-skills');
  assert.notEqual(after.hash, before.hash);
});

test('a Job added from the Page never Runs at once: it takes its next Due time', async (t) => {
  const called: string[] = [];
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    // A state file that remembers this name from before, two days stale. Even
    // so, a Job created now waits for its next Due time.
    files: {
      'jobs.json': JSON.stringify({ jobs: [] }),
      'state.json': JSON.stringify({
        jobs: {
          'nexus-skills': {
            seenAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            lastDue: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            lastStarted: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            runs: [],
          },
        },
      }),
    },
    host: (question) => {
      called.push(String(question.params['name']));
      return { result: { content: [{ type: 'text', text: 'done' }] } };
    },
  });
  await plugin.handshake();

  const before = await listed(plugin);
  await plugin.ask('tools/call', {
    name: 'add_job',
    arguments: { job: { ...JOB, when: { every: 'hourly', timezone: 'UTC' } }, ifMatch: before.hash },
  });
  await new Promise((done) => setTimeout(done, 500));

  assert.deepEqual(called, [], 'a Job created just now ran at once');
});

test('a duplicate Job Name is refused, and nothing is written', async (t) => {
  const plugin = await quiet(t, [JOB]);
  const before = await listed(plugin);

  const answer = await plugin.ask('tools/call', {
    name: 'add_job',
    arguments: { job: { ...JOB, tool: 'show_global_instructions' }, ifMatch: before.hash },
  });

  assert.equal(answer.result, undefined);
  assert.ok(answer.error?.message.includes('nexus-skills'), answer.error?.message);
  assert.deepEqual((await jobsFileOf(plugin)).jobs, [JOB]);
});

test('a Job whose When makes no sense is refused before anything is written', async (t) => {
  const plugin = await quiet(t);
  const before = await listed(plugin);

  const answer = await plugin.ask('tools/call', {
    name: 'add_job',
    arguments: {
      job: { ...JOB, when: { every: '*/5 * * * *', timezone: 'UTC' } },
      ifMatch: before.hash,
    },
  });

  assert.equal(answer.result, undefined);
  assert.ok(answer.error?.message.includes('*/5 * * * *'), answer.error?.message);
  assert.deepEqual((await jobsFileOf(plugin)).jobs, []);
  assert.equal((await listed(plugin)).hash, before.hash);
});

test('a write whose hash no longer matches is refused, and nothing is written', async (t) => {
  const plugin = await quiet(t);
  const stale = (await listed(plugin)).hash;

  // Somebody edits the file by hand, the way the whole design says they may.
  await writeFile(
    join(plugin.directory, 'jobs.json'),
    JSON.stringify({ jobs: [{ ...JOB, name: 'written-by-hand' }] }, null, 2),
  );

  const answer = await plugin.ask('tools/call', {
    name: 'add_job',
    arguments: { job: JOB, ifMatch: stale },
  });

  assert.equal(answer.result, undefined);
  assert.ok(/changed since/i.test(answer.error?.message ?? ''), answer.error?.message);
  const held = await jobsFileOf(plugin);
  assert.equal((held.jobs as { name: string }[])[0]?.name, 'written-by-hand');
  assert.equal(held.jobs.length, 1);
});

test('a Job is turned off and on again from the Page', async (t) => {
  const plugin = await quiet(t, [JOB]);

  const off = await plugin.ask('tools/call', {
    name: 'enable_job',
    arguments: { name: 'nexus-skills', enabled: false, ifMatch: (await listed(plugin)).hash },
  });
  assert.equal(off.error, undefined, JSON.stringify(off.error));
  const paused = await listed(plugin);
  assert.equal(paused.jobs[0]?.enabled, false);
  assert.equal(paused.jobs[0]?.nextDue, null);

  const on = await plugin.ask('tools/call', {
    name: 'enable_job',
    arguments: { name: 'nexus-skills', enabled: true, ifMatch: paused.hash },
  });
  assert.equal(on.error, undefined, JSON.stringify(on.error));
  const running = await listed(plugin);
  assert.equal(running.jobs[0]?.enabled, true);
  assert.notEqual(running.jobs[0]?.nextDue, null);
});

test('a Job is removed from the Page, and the list is the list of what is wanted', async (t) => {
  const plugin = await quiet(t, [JOB, { ...JOB, name: 'other' }]);

  const answer = await plugin.ask('tools/call', {
    name: 'remove_job',
    arguments: { name: 'nexus-skills', ifMatch: (await listed(plugin)).hash },
  });

  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  const after = await listed(plugin);
  assert.deepEqual(
    after.jobs.map((job) => job.name),
    ['other'],
  );
});

test('removing a Job that is not there says so, naming it', async (t) => {
  const plugin = await quiet(t, [JOB]);

  const answer = await plugin.ask('tools/call', {
    name: 'remove_job',
    arguments: { name: 'polish-the-boots', ifMatch: (await listed(plugin)).hash },
  });

  assert.equal(answer.result, undefined);
  assert.ok(answer.error?.message.includes('polish-the-boots'), answer.error?.message);
});

test('a hand edit to the jobs file is picked up on the next tick, with no restart', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: { 'jobs.json': JSON.stringify({ jobs: [JOB] }) },
  });
  await plugin.handshake();
  assert.equal((await listed(plugin)).jobs.length, 1);

  await writeFile(
    join(plugin.directory, 'jobs.json'),
    JSON.stringify({ jobs: [JOB, { ...JOB, name: 'added-by-hand' }] }, null, 2),
  );

  const names = await until(async () => {
    const got = await listed(plugin);
    return got.jobs.length === 2 ? got.jobs.map((job) => job.name) : null;
  }, 'the hand edit was picked up');

  assert.deepEqual(names, ['nexus-skills', 'added-by-hand']);
});

test('a jobs file that goes wrong while the Plugin runs keeps the last good Jobs and says so', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: { 'jobs.json': JSON.stringify({ jobs: [JOB] }) },
  });
  await plugin.handshake();
  assert.equal((await listed(plugin)).problem, null);

  // A typo you are still making. A running clock must not kill itself over it.
  await writeFile(join(plugin.directory, 'jobs.json'), '{ "jobs": [ ');

  const said = await until(async () => (await listed(plugin)).problem, 'the Page was told');

  assert.ok(said.includes('jobs.json'), said);
  const still = await listed(plugin);
  assert.equal(still.jobs.length, 1, 'the last good Jobs were thrown away');
  assert.equal(still.jobs[0]?.name, 'nexus-skills');

  // And the Plugin Server is still up, because this rule belongs to start-up
  // alone.
  const alive = await plugin.ask('tools/list');
  assert.equal(alive.error, undefined);
});

test('naming a Plugin lists its tools, by asking the Host over the Tool Bus', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: '30000' },
    files: { 'jobs.json': JSON.stringify({ jobs: [] }) },
    host: (question) => {
      assert.equal(question.method, 'firstmate/tools/list');
      assert.equal(question.params['plugin'], 'nexus');
      return {
        result: {
          tools: [
            { name: 'list_skills', description: 'Every Skill.', inputSchema: { type: 'object' } },
          ],
        },
      };
    },
  });
  await plugin.handshake();

  const answer = await plugin.ask('tools/call', {
    name: 'list_plugin_tools',
    arguments: { plugin: 'nexus' },
  });

  const got = structureOf(answer) as { tools: { name: string; inputSchema: unknown }[] };
  assert.equal(got.tools.length, 1);
  assert.equal(got.tools[0]?.name, 'list_skills');
  assert.deepEqual(got.tools[0]?.inputSchema, { type: 'object' });
});

test('naming a Plugin the Host will not reach shows the Host’s own sentence, unchanged', async (t) => {
  const refusal = 'The Plugin named scheduler holds no Grant to call the Plugin named nexus.';
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: '30000' },
    files: { 'jobs.json': JSON.stringify({ jobs: [] }) },
    host: () => ({ error: { code: -32602, message: refusal } }),
  });
  await plugin.handshake();

  const answer = await plugin.ask('tools/call', {
    name: 'list_plugin_tools',
    arguments: { plugin: 'nexus' },
  });

  assert.equal(answer.result, undefined);
  assert.equal(answer.error?.message, refusal);
});

test('the jobs file a reader picks up is whole, however hard it is read', async (t) => {
  const plugin = await quiet(t);

  const writes: Promise<Answer>[] = [];
  const reads: Promise<void>[] = [];
  let hash = (await listed(plugin)).hash;
  for (let at = 0; at < 12; at += 1) {
    const answer = await plugin.ask('tools/call', {
      name: 'add_job',
      arguments: { job: { ...JOB, name: `job-${at}` }, ifMatch: hash },
    });
    writes.push(Promise.resolve(answer));
    hash = (await listed(plugin)).hash;
    reads.push(
      readFile(join(plugin.directory, 'jobs.json'), 'utf8').then((text) => {
        JSON.parse(text);
      }),
    );
  }
  await Promise.all(reads);

  for (const write of writes) assert.equal((await write).error, undefined);
  assert.equal((await jobsFileOf(plugin)).jobs.length, 12);
});
