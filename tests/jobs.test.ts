/**
 * A Job is data in a file, and the file is read whole or not at all.
 *
 * A jobs file that is wrong when the Plugin Server starts is one sentence on
 * stderr and a non-zero exit: the Index Page shows the Plugin Stopped and the
 * reason is in the journal. A half-loaded jobs file is the thing none of this
 * allows, so every case here asserts that nothing at all was scheduled.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { startPluginServer, structureOf } from './helpers/plugin.ts';

/** The Job the spec is written around, as a file. */
const NEXUS_SKILLS = {
  name: 'nexus-skills',
  enabled: true,
  when: { every: 'weekdays', at: '09:00', timezone: 'America/Sao_Paulo' },
  plugin: 'nexus',
  tool: 'list_skills',
  arguments: {},
  missedRunGraceMinutes: 720,
};

function jobsFile(...jobs: unknown[]): Record<string, string> {
  return { 'jobs.json': JSON.stringify({ jobs }, null, 2) };
}

/** Start against a jobs file that should stop the Plugin Server, and say why. */
async function refusedFile(
  t: Parameters<typeof startPluginServer>[0],
  content: string,
): Promise<{ code: number | null; said: string }> {
  const plugin = await startPluginServer(t, { files: { 'jobs.json': content } });
  const ending = await plugin.ended();
  return { code: ending.code, said: plugin.output() };
}

test('a Job is read from the jobs file with every field it carries', async (t) => {
  const plugin = await startPluginServer(t, { files: jobsFile(NEXUS_SKILLS) });
  await plugin.handshake();

  const answer = await plugin.ask('tools/call', { name: 'list_jobs', arguments: {} });

  const { jobs } = structureOf(answer) as { jobs: Record<string, unknown>[] };
  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.equal(job['name'], 'nexus-skills');
  assert.equal(job['enabled'], true);
  assert.deepEqual(job['when'], NEXUS_SKILLS.when);
  assert.equal(job['plugin'], 'nexus');
  assert.equal(job['tool'], 'list_skills');
  assert.deepEqual(job['arguments'], {});
  assert.equal(job['missedRunGraceMinutes'], 720);
});

test('a missing jobs file is a Plugin with no Jobs, not an error', async (t) => {
  const plugin = await startPluginServer(t);
  await plugin.handshake();

  const answer = await plugin.ask('tools/call', { name: 'list_jobs', arguments: {} });

  assert.deepEqual((structureOf(answer) as { jobs: unknown[] }).jobs, []);
  assert.equal(plugin.output(), '');
});

test('a jobs file that is not valid JSON stops the Plugin Server with a sentence naming it', async (t) => {
  const { code, said } = await refusedFile(t, '{ "jobs": [ ');

  assert.notEqual(code, 0);
  assert.ok(said.includes('jobs.json'), said);
  assert.ok(/not valid JSON/i.test(said), said);
});

test('a Job missing a field stops the Plugin Server with a sentence naming the Job and the field', async (t) => {
  const { name: _dropped, ...withoutName } = NEXUS_SKILLS;
  const missingTool = { ...NEXUS_SKILLS, tool: undefined };

  const noTool = await refusedFile(t, JSON.stringify({ jobs: [missingTool] }));
  assert.notEqual(noTool.code, 0);
  assert.ok(noTool.said.includes('nexus-skills'), noTool.said);
  assert.ok(noTool.said.includes('tool'), noTool.said);

  const noName = await refusedFile(t, JSON.stringify({ jobs: [withoutName] }));
  assert.notEqual(noName.code, 0);
  assert.ok(noName.said.includes('name'), noName.said);
});

test('a Job Name used twice stops the Plugin Server, because the name is the key to everything', async (t) => {
  const { code, said } = await refusedFile(
    t,
    JSON.stringify({ jobs: [NEXUS_SKILLS, { ...NEXUS_SKILLS, tool: 'show_global_instructions' }] }),
  );

  assert.notEqual(code, 0);
  assert.ok(said.includes('nexus-skills'), said);
  assert.ok(/twice|already|more than once/i.test(said), said);
});

test('one bad Job means no Job is scheduled', async (t) => {
  const { code, said } = await refusedFile(
    t,
    JSON.stringify({ jobs: [NEXUS_SKILLS, { ...NEXUS_SKILLS, name: 'broken', plugin: 42 }] }),
  );

  assert.notEqual(code, 0);
  assert.ok(said.includes('broken'), said);
});

test('hourly needs no time, and a When that carries one is refused', async (t) => {
  const plugin = await startPluginServer(t, {
    files: jobsFile({
      ...NEXUS_SKILLS,
      when: { every: 'hourly', timezone: 'America/Sao_Paulo' },
    }),
  });
  await plugin.handshake();
  const answer = await plugin.ask('tools/call', { name: 'list_jobs', arguments: {} });
  assert.equal((structureOf(answer) as { jobs: unknown[] }).jobs.length, 1);

  const mixed = await refusedFile(
    t,
    JSON.stringify({
      jobs: [{ ...NEXUS_SKILLS, when: { every: 'hourly', at: '09:00', timezone: 'UTC' } }],
    }),
  );
  assert.notEqual(mixed.code, 0);
  assert.ok(mixed.said.includes('hourly'), mixed.said);
});

test('weekly carries a day, and a When without one is refused', async (t) => {
  const plugin = await startPluginServer(t, {
    files: jobsFile({
      ...NEXUS_SKILLS,
      when: { every: 'weekly', day: 'monday', at: '09:00', timezone: 'America/Sao_Paulo' },
    }),
  });
  await plugin.handshake();
  const answer = await plugin.ask('tools/call', { name: 'list_jobs', arguments: {} });
  assert.equal((structureOf(answer) as { jobs: unknown[] }).jobs.length, 1);

  const noDay = await refusedFile(
    t,
    JSON.stringify({
      jobs: [{ ...NEXUS_SKILLS, when: { every: 'weekly', at: '09:00', timezone: 'UTC' } }],
    }),
  );
  assert.notEqual(noDay.code, 0);
  assert.ok(noDay.said.includes('day'), noDay.said);
});

test('a day that only a weekly Job may carry is refused on every other When', async (t) => {
  const { code, said } = await refusedFile(
    t,
    JSON.stringify({
      jobs: [
        { ...NEXUS_SKILLS, when: { every: 'daily', day: 'monday', at: '09:00', timezone: 'UTC' } },
      ],
    }),
  );

  assert.notEqual(code, 0);
  assert.ok(said.includes('day'), said);
});

test('an every that is not one of the four is refused by name', async (t) => {
  const { code, said } = await refusedFile(
    t,
    JSON.stringify({
      jobs: [{ ...NEXUS_SKILLS, when: { every: '*/5 * * * *', timezone: 'UTC' } }],
    }),
  );

  assert.notEqual(code, 0);
  assert.ok(said.includes('*/5 * * * *'), said);
  assert.ok(said.includes('hourly'), said);
});

test('a time zone that is not a zone is refused by name', async (t) => {
  const { code, said } = await refusedFile(
    t,
    JSON.stringify({
      jobs: [{ ...NEXUS_SKILLS, when: { every: 'daily', at: '09:00', timezone: 'Mars/Olympus' } }],
    }),
  );

  assert.notEqual(code, 0);
  assert.ok(said.includes('Mars/Olympus'), said);
});

test('a time that is not a time of day is refused by name', async (t) => {
  const { code, said } = await refusedFile(
    t,
    JSON.stringify({
      jobs: [{ ...NEXUS_SKILLS, when: { every: 'daily', at: '9am', timezone: 'UTC' } }],
    }),
  );

  assert.notEqual(code, 0);
  assert.ok(said.includes('9am'), said);
});

test('a jobs file whose jobs are not a list is refused, naming the file', async (t) => {
  const { code, said } = await refusedFile(t, JSON.stringify({ jobs: { 'nexus-skills': {} } }));

  assert.notEqual(code, 0);
  assert.ok(said.includes('jobs.json'), said);
  assert.ok(said.includes('jobs'), said);
});
