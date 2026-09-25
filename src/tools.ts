/**
 * The tools this Plugin ships: one for each thing a person, a Page or another
 * Plugin can ask the Scheduler to do.
 *
 * Every tool answers the same data twice — as text, for whoever reads it in a
 * terminal, and as structure, for the Page, which draws it. `list_jobs`
 * carries everything the Page draws, so the Page makes one request and renders
 * once.
 *
 * Every tool that writes carries the hash of the jobs file the Page last read.
 * The file is hand-editable by design, so a click must never quietly overwrite
 * an edit somebody made somewhere else: a write whose hash no longer matches
 * is refused with a sentence, and nothing is written.
 */
import { listPluginTools } from './bus.ts';
import type { Clock } from './clock.ts';
import type { Config } from './config.ts';
import { nextDue, said } from './due.ts';
import type { Held } from './held.ts';
import { checkJob, hashOfJobs, readJobs, writeJobs, type Job } from './jobs.ts';
import type { Tool, ToolResult } from './mcp.ts';
import type { Run, State } from './state.ts';

/**
 * How long the Page waits to be told another Plugin's tools. A person is
 * waiting on this one, unlike a Run, so it keeps a page's patience.
 */
const LISTING_MS = 30_000;

const NAME = { type: 'string', description: 'The Job Name.' };
const IF_MATCH = {
  type: 'string',
  description: 'The hash of the jobs file this page last read, from list_jobs.',
};

/** The tools, over the Jobs and the Runs this Plugin Server holds. */
export function toolsFor(held: Held, clock: Clock, config: Config): readonly Tool[] {
  /** One write at a time, so two of them cannot both pass the same hash. */
  let writes: Promise<unknown> = Promise.resolve();

  async function writing<T>(
    ifMatch: unknown,
    work: (jobs: readonly Job[]) => Promise<T>,
  ): Promise<T> {
    if (typeof ifMatch !== 'string' || ifMatch === '') {
      throw new Error(
        'This write needs "ifMatch", the hash of the jobs file this page last read. ' +
          'list_jobs answers with it.',
      );
    }
    const next = writes.then(async () => {
      if ((await hashOfJobs()) !== ifMatch) {
        throw new Error(
          'The jobs file changed since this page read it, so nothing was written. ' +
            'Reload the page and try again.',
        );
      }
      const done = await work(await readJobs());
      await held.reread();
      return done;
    });
    // Whatever this write ended as, the next one still gets its turn.
    writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return [
    {
      name: 'list_jobs',
      description:
        'Every Job, with its When, what it calls, its Runs, its next Due time, and the hash ' +
        'a write must carry.',
      inputSchema: {
        type: 'object',
        properties: {
          asOf: {
            type: 'string',
            description:
              'The moment to answer as of, as ISO 8601. The default is now. Naming one is how ' +
              'a caller asks what a Job would do on a day other than today.',
          },
        },
        required: [],
      },
      call: async (given) =>
        told({
          ...listing(held.jobs(), clock.now(), given),
          hash: await hashOfJobs(),
          // What is wrong with the jobs file, for the Page to show. A Plugin
          // Server that is running has kept the last good Jobs regardless.
          problem: held.problem(),
        }),
    },

    {
      name: 'run_job',
      description:
        'Run one Job now, through the same runner and as the same kind of Run. It does not ' +
        'move the Job’s next Due time, and a Job that is off can still be run this way.',
      inputSchema: { type: 'object', properties: { name: NAME }, required: ['name'] },
      call: async (given) => {
        const name = given['name'];
        if (typeof name !== 'string' || name === '') {
          throw new Error('run_job needs the Job Name of the Job to run.');
        }
        return told({ name, run: await clock.runNow(name) });
      },
    },

    {
      name: 'add_job',
      description: 'Add one Job to the jobs file. It takes its next Due time; it never Runs now.',
      inputSchema: {
        type: 'object',
        properties: {
          job: {
            type: 'object',
            description:
              'The whole Job: name, enabled, when, plugin, tool, arguments, ' +
              'missedRunGraceMinutes.',
          },
          ifMatch: IF_MATCH,
        },
        required: ['job', 'ifMatch'],
      },
      call: async (given) => {
        // Checked before the hash is even looked at, so a Job that makes no
        // sense is refused without touching the file.
        const job = checkJob(given['job']);
        return writing(given['ifMatch'], async (jobs) => {
          if (jobs.some((one) => one.name === job.name)) {
            throw new Error(
              `A Job named "${job.name}" is already in the jobs file. A Job Name is the key ` +
                'to its state and its history, so it belongs to one Job.',
            );
          }
          await writeJobs([...jobs, job]);
          // A Job created now takes its next Due time, even where the state
          // file remembers a Job of this name from before.
          await clock.freshen(job.name);
          return told({ added: job.name });
        });
      },
    },

    {
      name: 'change_job',
      description:
        'Change one Job in the jobs file, under its Job Name. It keeps its Runs and whether it ' +
        'is on; it takes its next Due time from now, and never Runs because of the change.',
      inputSchema: {
        type: 'object',
        properties: {
          job: {
            type: 'object',
            description:
              'The whole Job, as add_job takes it. The name says which Job to change, and ' +
              'enabled is ignored: enable_job turns a Job on or off.',
          },
          ifMatch: IF_MATCH,
        },
        required: ['job', 'ifMatch'],
      },
      call: async (given) => {
        // The same check as add_job, before the hash, so both refuse the same
        // bad Job in the same sentence and neither touches the file (ADR-0002).
        const job = checkJob(given['job']);
        return writing(given['ifMatch'], async (jobs) => {
          const was = jobs.find((one) => one.name === job.name);
          if (was === undefined) {
            throw new Error(`No Job named "${job.name}" is in the jobs file.`);
          }
          // The name is the key to the Job's history, so it never changes, and
          // a change never wakes a Job somebody turned off (ADR-0002).
          const changed = { ...job, enabled: was.enabled };
          await writeJobs(jobs.map((one) => (one.name === job.name ? changed : one)));
          // Like a Job just added, it takes its next Due time from now, so a
          // When moved to a time already past today does not Run at once.
          await clock.freshen(job.name);
          return told({ changed: job.name });
        });
      },
    },

    {
      name: 'enable_job',
      description: 'Turn one Job on or off. Off means it never comes Due.',
      inputSchema: {
        type: 'object',
        properties: {
          name: NAME,
          enabled: { type: 'boolean', description: 'true to let it Run, false to leave it off.' },
          ifMatch: IF_MATCH,
        },
        required: ['name', 'enabled', 'ifMatch'],
      },
      call: async (given) => {
        const name = given['name'];
        const enabled = given['enabled'];
        if (typeof name !== 'string' || name === '') {
          throw new Error('enable_job needs the Job Name of the Job to turn on or off.');
        }
        if (typeof enabled !== 'boolean') {
          throw new Error('enable_job needs "enabled" as true or false.');
        }
        return writing(given['ifMatch'], async (jobs) => {
          if (!jobs.some((one) => one.name === name)) {
            throw new Error(`No Job named "${name}" is in the jobs file.`);
          }
          await writeJobs(jobs.map((one) => (one.name === name ? { ...one, enabled } : one)));
          return told({ name, enabled });
        });
      },
    },

    {
      name: 'remove_job',
      description: 'Take one Job out of the jobs file, so the list stays the list of what is wanted.',
      inputSchema: {
        type: 'object',
        properties: { name: NAME, ifMatch: IF_MATCH },
        required: ['name', 'ifMatch'],
      },
      call: async (given) => {
        const name = given['name'];
        if (typeof name !== 'string' || name === '') {
          throw new Error('remove_job needs the Job Name of the Job to remove.');
        }
        return writing(given['ifMatch'], async (jobs) => {
          if (!jobs.some((one) => one.name === name)) {
            throw new Error(`No Job named "${name}" is in the jobs file.`);
          }
          await writeJobs(jobs.filter((one) => one.name !== name));
          return told({ removed: name });
        });
      },
    },

    {
      name: 'list_plugin_tools',
      description:
        'The tools of another Plugin, so a Job can be pointed at one of them rather than at a ' +
        'name somebody typed.',
      inputSchema: {
        type: 'object',
        properties: { plugin: { type: 'string', description: 'The Plugin Name.' } },
        required: ['plugin'],
      },
      call: async (given) => {
        const plugin = given['plugin'];
        if (typeof plugin !== 'string' || plugin === '') {
          throw new Error('list_plugin_tools needs the Plugin Name of the Plugin to ask about.');
        }
        const answer = await listPluginTools(plugin, LISTING_MS);
        if (answer.kind === 'timed-out') {
          throw new Error(`The Host did not answer in ${LISTING_MS} ms.`);
        }
        // The Host's own sentence, unchanged: no Grant, not registered,
        // Stopped, or no Plugin Server. It already says exactly what is wrong.
        if (answer.kind === 'refused') throw new Error(answer.said);
        return told(answer.result);
      },
    },
  ];
}

/** Everything the Page draws, in one answer. */
function listing(
  jobs: readonly Job[],
  state: State,
  given: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const asOf = momentOf(given['asOf']);
  return {
    asOf: new Date(asOf).toISOString(),
    jobs: jobs.map((job) => {
      const runs = state.jobs[job.name]?.runs ?? [];
      return {
        name: job.name,
        enabled: job.enabled,
        when: job.when,
        whenSaid: said(job.when),
        plugin: job.plugin,
        tool: job.tool,
        arguments: job.arguments,
        missedRunGraceMinutes: job.missedRunGraceMinutes,
        // A disabled Job never comes Due, so it has no next Due time to show.
        // Deriving one anyway would put a time on the Page that will not happen.
        nextDue: job.enabled ? new Date(nextDue(job.when, asOf)).toISOString() : null,
        lastRun: lastOf(runs),
        runs,
      };
    }),
  };
}

function lastOf(runs: readonly Run[]): Run | null {
  return runs.length === 0 ? null : (runs[runs.length - 1] ?? null);
}

/** The moment a caller asked about, or now. */
function momentOf(given: unknown): number {
  if (given === undefined) return Date.now();
  if (typeof given !== 'string') {
    throw new Error('asOf is a moment, written as ISO 8601.');
  }
  const moment = Date.parse(given);
  if (Number.isNaN(moment)) {
    throw new Error(
      `asOf is ${JSON.stringify(given)}, which is not a moment. Write one as ISO 8601, ` +
        'like "2026-09-23T09:00:00Z".',
    );
  }
  return moment;
}

/** One answer, in both the shapes MCP offers, from one value. */
export function told(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
