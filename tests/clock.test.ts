/**
 * The clock: the Plugin Server wakes on its own, sees a Job is Due, calls that
 * Job's tool on another Plugin over the Tool Bus, and writes down what
 * happened.
 *
 * Every case here drives the real clock. The tick interval comes from the
 * environment, so a test runs it in milliseconds; a Job is made Due by seeding
 * the state file with a start in the past, never by waiting a minute and never
 * by a fake clock. The Host at the other end of the pipe is this test, which
 * answers `firstmate/tools/call` with whatever the case is about.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { startPluginServer, structureOf, type Answer, type Question } from './helpers/plugin.ts';

/** A tick a test does not have to wait for. */
const TICK_MS = '40';

// Hourly on purpose. The most recent Due time of an hourly Job is at most an
// hour ago, so a Grace of 720 minutes always covers it and these cases mean
// the same thing at every hour of the day.
const JOB = {
  name: 'nexus-skills',
  enabled: true,
  when: { every: 'hourly', timezone: 'UTC' },
  plugin: 'nexus',
  tool: 'list_skills',
  arguments: {},
  missedRunGraceMinutes: 720,
};

/** A state file that says these Jobs were last dealt with two days ago. */
function longAgo(...names: string[]): string {
  const then = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const jobs: Record<string, unknown> = {};
  for (const name of names) {
    jobs[name] = { seenAt: then, lastDue: then, lastStarted: then, runs: [] };
  }
  return JSON.stringify({ jobs }, null, 2);
}

function filesFor(jobs: readonly unknown[], state: string): Record<string, string> {
  return { 'jobs.json': JSON.stringify({ jobs }), 'state.json': state };
}

/** Wait for something the clock does on its own, rather than guessing a delay. */
async function until<T>(get: () => Promise<T | null>, what: string, within = 5000): Promise<T> {
  const deadline = Date.now() + within;
  for (;;) {
    const got = await get();
    if (got !== null) return got;
    if (Date.now() > deadline) throw new Error(`${what} did not happen in ${within} ms.`);
    await new Promise((done) => setTimeout(done, 15));
  }
}

type Run = {
  readonly started: string;
  readonly finished: string;
  readonly outcome: string;
  readonly said: string;
};

type Listed = { readonly jobs: readonly { readonly name: string; readonly lastRun: Run | null }[] };

/** The last Run of a Job, as the Page reads it, or null while there is none. */
function lastRunOf(
  plugin: { ask(method: string, params?: unknown): Promise<Answer> },
  name: string,
): () => Promise<Run | null> {
  return async () => {
    const answer = await plugin.ask('tools/call', { name: 'list_jobs', arguments: {} });
    const listed = structureOf(answer) as Listed;
    return listed.jobs.find((job) => job.name === name)?.lastRun ?? null;
  };
}

/** An answer a tool would give. */
function answered(text: string): Answer {
  return { result: { content: [{ type: 'text', text }] } };
}

test('a Job that is Due calls its tool on another Plugin, and the Run says ok', async (t) => {
  const asked: Question[] = [];
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: filesFor([JOB], longAgo('nexus-skills')),
    host: (question) => {
      asked.push(question);
      return answered('37 Installed Skills.');
    },
  });
  await plugin.handshake();

  const run = await until(lastRunOf(plugin, 'nexus-skills'), 'the Job ran');

  assert.equal(run.outcome, 'ok');
  assert.equal(run.said, '37 Installed Skills.');
  assert.ok(Date.parse(run.started) <= Date.parse(run.finished));

  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.method, 'firstmate/tools/call');
  assert.equal(asked[0]?.params['plugin'], 'nexus');
  assert.equal(asked[0]?.params['name'], 'list_skills');
  assert.deepEqual(asked[0]?.params['arguments'], {});
});

test('the start of a Run is written before the call goes out, never after', async (t) => {
  let startedWhenAsked: string | null | undefined;
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: filesFor([JOB], longAgo('nexus-skills')),
    host: async () => {
      // The Host is being asked right now, so the state file on disk must
      // already say this Run started. A Run written afterwards would be
      // re-decided and run again if this process died here.
      const state = JSON.parse(await readFile(join(plugin.directory, 'state.json'), 'utf8'));
      startedWhenAsked = state.jobs['nexus-skills']?.lastStarted;
      return answered('done');
    },
  });
  await plugin.handshake();

  await until(lastRunOf(plugin, 'nexus-skills'), 'the Job ran');

  assert.ok(typeof startedWhenAsked === 'string', 'no start was on disk when the call went out');
  assert.ok(Date.now() - Date.parse(startedWhenAsked as string) < 5000);
});

test('a tool that answers with an error is a failed Run carrying its own sentence', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: filesFor([JOB], longAgo('nexus-skills')),
    host: () => ({ error: { code: -32000, message: 'another change is already running' } }),
  });
  await plugin.handshake();

  const run = await until(lastRunOf(plugin, 'nexus-skills'), 'the Job ran');

  assert.equal(run.outcome, 'failed');
  assert.ok(run.said.includes('another change is already running'), run.said);
});

test('a Host that refuses the call is a failed Run carrying the Host’s own sentence', async (t) => {
  const refusals = [
    'The Plugin named scheduler holds no Grant to call the Plugin named nexus.',
    'No Plugin named nexus is in the Registry.',
    'The Plugin named nexus is Stopped.',
    'The Plugin named nexus ships no Plugin Server.',
  ];

  for (const refusal of refusals) {
    const plugin = await startPluginServer(t, {
      env: { SCHEDULER_TICK_MS: TICK_MS },
      files: filesFor([JOB], longAgo('nexus-skills')),
      host: () => ({ error: { code: -32602, message: refusal } }),
    });
    await plugin.handshake();

    const run = await until(lastRunOf(plugin, 'nexus-skills'), `the Job ran for: ${refusal}`);

    assert.equal(run.outcome, 'failed', refusal);
    assert.ok(run.said.includes(refusal), `${run.said} did not carry: ${refusal}`);
  }
});

test('a call that runs out of time is timed-out, and says the tool may still be running', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS, SCHEDULER_CALL_MS: '150' },
    files: filesFor([JOB], longAgo('nexus-skills')),
    // The Host never answers. The target keeps working; the Scheduler stops
    // waiting. Those are two different things, and the Outcome says so.
    host: () => new Promise<Answer>(() => {}),
  });
  await plugin.handshake();

  const run = await until(lastRunOf(plugin, 'nexus-skills'), 'the Job timed out');

  assert.equal(run.outcome, 'timed-out');
  assert.ok(/may still be running/i.test(run.said), run.said);
});

test('nothing is retried: a Run that was not ok happens once and no more', async (t) => {
  const asked: Question[] = [];
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: filesFor([JOB], longAgo('nexus-skills')),
    host: (question) => {
      asked.push(question);
      return { error: { code: -32000, message: 'it broke' } };
    },
  });
  await plugin.handshake();
  await until(lastRunOf(plugin, 'nexus-skills'), 'the Job ran');

  // Long enough for a dozen more ticks to have come and gone.
  await new Promise((done) => setTimeout(done, 600));

  assert.equal(asked.length, 1, `the Job was called ${asked.length} times`);
});

test('two Jobs Due at once Run one after the other, in the order the jobs file lists them', async (t) => {
  const order: string[] = [];
  let inFlight = 0;
  const first = { ...JOB, name: 'first' };
  const second = { ...JOB, name: 'second', tool: 'show_global_instructions' };
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: filesFor([first, second], longAgo('first', 'second')),
    host: async (question) => {
      inFlight += 1;
      assert.equal(inFlight, 1, 'two Runs were in flight at once');
      order.push(String(question.params['name']));
      await new Promise((done) => setTimeout(done, 60));
      inFlight -= 1;
      return answered('done');
    },
  });
  await plugin.handshake();

  await until(lastRunOf(plugin, 'second'), 'the second Job ran');

  assert.deepEqual(order, ['list_skills', 'show_global_instructions']);
});

test('a Run that was not ok leaves exactly one line in the journal', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: filesFor([JOB], longAgo('nexus-skills')),
    host: () => ({ error: { code: -32000, message: 'it broke' } }),
  });
  await plugin.handshake();
  await until(lastRunOf(plugin, 'nexus-skills'), 'the Job ran');
  await new Promise((done) => setTimeout(done, 300));

  const lines = plugin.output().split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 1, plugin.output());
  assert.ok(lines[0]?.includes('nexus-skills'), lines[0]);
  assert.ok(lines[0]?.includes('it broke'), lines[0]);
});

test('a Run that was ok leaves nothing in the journal', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: filesFor([JOB], longAgo('nexus-skills')),
    host: () => answered('37 Installed Skills.'),
  });
  await plugin.handshake();
  await until(lastRunOf(plugin, 'nexus-skills'), 'the Job ran');
  await new Promise((done) => setTimeout(done, 300));

  assert.equal(plugin.output(), '');
});

test('the first wake is never at start-up', async (t) => {
  const asked: Question[] = [];
  const plugin = await startPluginServer(t, {
    // A tick far longer than the moment a test looks. Nothing may have been
    // called before the first one comes round: the other Plugin Servers are
    // still finishing their own handshake at t=0.
    env: { SCHEDULER_TICK_MS: '3000' },
    files: filesFor([JOB], longAgo('nexus-skills')),
    host: (question) => {
      asked.push(question);
      return answered('done');
    },
  });
  await plugin.handshake();

  await new Promise((done) => setTimeout(done, 700));

  assert.equal(asked.length, 0, 'a call went out before the first tick');
});

test('a disabled Job never Runs, however long it has been Due', async (t) => {
  const asked: Question[] = [];
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: filesFor([{ ...JOB, enabled: false }], longAgo('nexus-skills')),
    host: (question) => {
      asked.push(question);
      return answered('done');
    },
  });
  await plugin.handshake();

  await new Promise((done) => setTimeout(done, 400));

  assert.equal(asked.length, 0, 'a disabled Job was called');
});

test('the state file a reader picks up is whole, and is valid JSON at every moment', async (t) => {
  const plugin = await startPluginServer(t, {
    env: { SCHEDULER_TICK_MS: TICK_MS },
    files: filesFor([JOB], longAgo('nexus-skills')),
    host: () => answered('done'),
  });
  await plugin.handshake();

  // Read it hard while the clock is writing it. A file written whole and moved
  // into place is never caught half written; one written in place is.
  const reads: Promise<void>[] = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    reads.push(
      readFile(join(plugin.directory, 'state.json'), 'utf8')
        .then((text) => {
          JSON.parse(text);
        })
        .catch((fault: NodeJS.ErrnoException) => {
          // Not being there yet is fine. Being there and half written is not.
          if (fault.code !== 'ENOENT') throw fault;
        }),
    );
    await new Promise((done) => setTimeout(done, 5));
  }
  await Promise.all(reads);

  const run = await until(lastRunOf(plugin, 'nexus-skills'), 'the Job ran');
  assert.equal(run.outcome, 'ok');
});
