/**
 * When a Job next comes Due, read on its own clock.
 *
 * Every case names the moment it asks from, so that a Due time is a fact about
 * a calendar rather than a fact about the day this suite happens to run. That
 * is what `asOf` is for: it makes the clock's behaviour on a March Sunday
 * provable in September, with the real clock and no branch that exists only
 * for a test.
 *
 * The expected moments here come from the zone rules themselves — the United
 * States moves its clocks on the second Sunday of March and the first of
 * November — and were checked against this machine's own zone database, not
 * against the code under test.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { startPluginServer, structureOf } from './helpers/plugin.ts';

type Listed = {
  readonly asOf: string;
  readonly jobs: readonly {
    readonly name: string;
    readonly whenSaid: string;
    readonly nextDue: string | null;
  }[];
};

const JOB = {
  name: 'a-job',
  enabled: true,
  plugin: 'nexus',
  tool: 'list_skills',
  arguments: {},
  missedRunGraceMinutes: 720,
};

/** Start with these Jobs, and ask when each is next Due as of a named moment. */
async function dueAt(
  t: Parameters<typeof startPluginServer>[0],
  jobs: readonly unknown[],
  asOf: string,
): Promise<Listed> {
  const plugin = await startPluginServer(t, {
    files: { 'jobs.json': JSON.stringify({ jobs }) },
  });
  await plugin.handshake();
  const answer = await plugin.ask('tools/call', { name: 'list_jobs', arguments: { asOf } });
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  return structureOf(answer) as Listed;
}

test('the next Due time is read on the Job’s own clock, not the machine’s', async (t) => {
  // 09:00 in Sao Paulo is 12:00 UTC. The same time of day in UTC is 09:00 UTC.
  // One When, two zones, two different moments: that is the whole point of
  // recording the zone on the Job.
  const listed = await dueAt(
    t,
    [
      { ...JOB, name: 'in-sao-paulo', when: { every: 'daily', at: '09:00', timezone: 'America/Sao_Paulo' } },
      { ...JOB, name: 'in-utc', when: { every: 'daily', at: '09:00', timezone: 'UTC' } },
    ],
    '2026-09-23T00:00:00Z',
  );

  assert.equal(listed.jobs[0]?.nextDue, '2026-09-23T12:00:00.000Z');
  assert.equal(listed.jobs[1]?.nextDue, '2026-09-23T09:00:00.000Z');
});

test('a daily Job whose time has passed today is Due tomorrow', async (t) => {
  const listed = await dueAt(
    t,
    [{ ...JOB, when: { every: 'daily', at: '09:00', timezone: 'UTC' } }],
    '2026-09-23T10:00:00Z',
  );

  assert.equal(listed.jobs[0]?.nextDue, '2026-09-24T09:00:00.000Z');
});

test('asking at the very minute a Job is Due answers with the next one', async (t) => {
  const listed = await dueAt(
    t,
    [{ ...JOB, when: { every: 'daily', at: '09:00', timezone: 'UTC' } }],
    '2026-09-23T09:00:00Z',
  );

  assert.equal(listed.jobs[0]?.nextDue, '2026-09-24T09:00:00.000Z');
});

test('a weekdays Job asked on a Friday evening is Due on Monday', async (t) => {
  // 2026-09-25 is a Friday and 2026-09-28 is the Monday after it.
  const listed = await dueAt(
    t,
    [{ ...JOB, when: { every: 'weekdays', at: '09:00', timezone: 'UTC' } }],
    '2026-09-25T20:00:00Z',
  );

  assert.equal(listed.jobs[0]?.nextDue, '2026-09-28T09:00:00.000Z');
});

test('a weekly Job is Due on its own day and no other', async (t) => {
  // Asked on a Wednesday, a Monday Job waits for the Monday.
  const listed = await dueAt(
    t,
    [{ ...JOB, when: { every: 'weekly', day: 'monday', at: '09:00', timezone: 'UTC' } }],
    '2026-09-23T00:00:00Z',
  );

  assert.equal(listed.jobs[0]?.nextDue, '2026-09-28T09:00:00.000Z');
});

test('an hourly Job is Due on the next hour', async (t) => {
  const listed = await dueAt(
    t,
    [{ ...JOB, when: { every: 'hourly', timezone: 'UTC' } }],
    '2026-09-23T10:17:00Z',
  );

  assert.equal(listed.jobs[0]?.nextDue, '2026-09-23T11:00:00.000Z');
});

test('a time that does not exist on the day a clock goes forward happens at the next minute that does', async (t) => {
  // New York moves 02:00 EST straight to 03:00 EDT on 2026-03-08, so 02:30
  // never happens that day. The Job comes Due at 03:00 EDT, which is 07:00 UTC.
  const listed = await dueAt(
    t,
    [{ ...JOB, when: { every: 'daily', at: '02:30', timezone: 'America/New_York' } }],
    '2026-03-07T12:00:00Z',
  );

  assert.equal(listed.jobs[0]?.nextDue, '2026-03-08T07:00:00.000Z');
});

test('the hour a clock repeats going back is one Due time, not two', async (t) => {
  // New York reads 01:30 twice on 2026-11-01, once at 05:30 UTC on EDT and
  // again at 06:30 UTC on EST. A Job comes Due at the first, and once.
  const listed = await dueAt(
    t,
    [{ ...JOB, when: { every: 'daily', at: '01:30', timezone: 'America/New_York' } }],
    '2026-10-31T12:00:00Z',
  );

  assert.equal(listed.jobs[0]?.nextDue, '2026-11-01T05:30:00.000Z');
});

test('a disabled Job never comes Due', async (t) => {
  const listed = await dueAt(
    t,
    [{ ...JOB, enabled: false, when: { every: 'daily', at: '09:00', timezone: 'UTC' } }],
    '2026-09-23T00:00:00Z',
  );

  assert.equal(listed.jobs[0]?.nextDue, null);
});

test('every Job carries its When as a sentence, because that is what the Page shows', async (t) => {
  const listed = await dueAt(
    t,
    [
      { ...JOB, name: 'by-the-hour', when: { every: 'hourly', timezone: 'UTC' } },
      { ...JOB, name: 'by-the-day', when: { every: 'daily', at: '09:00', timezone: 'UTC' } },
      { ...JOB, name: 'on-weekdays', when: { every: 'weekdays', at: '09:00', timezone: 'America/Sao_Paulo' } },
      { ...JOB, name: 'on-mondays', when: { every: 'weekly', day: 'monday', at: '18:30', timezone: 'UTC' } },
    ],
    '2026-09-23T00:00:00Z',
  );

  assert.equal(listed.jobs[0]?.whenSaid, 'every hour, on the hour (UTC)');
  assert.equal(listed.jobs[1]?.whenSaid, 'every day at 09:00 (UTC)');
  assert.equal(listed.jobs[2]?.whenSaid, 'every weekday at 09:00 (America/Sao_Paulo)');
  assert.equal(listed.jobs[3]?.whenSaid, 'every Monday at 18:30 (UTC)');
});

test('a moment that is not a moment is refused with a sentence naming it', async (t) => {
  const plugin = await startPluginServer(t);
  await plugin.handshake();

  const answer = await plugin.ask('tools/call', {
    name: 'list_jobs',
    arguments: { asOf: 'next tuesday' },
  });

  assert.equal(answer.result, undefined);
  assert.ok(answer.error?.message.includes('next tuesday'), answer.error?.message);
});
