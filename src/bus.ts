/**
 * The Tool Bus, from this end of the pipe.
 *
 * A Plugin Server calls another Plugin's tool by writing one JSON-RPC request
 * on its own stdout and reading the answer by the id it sent (FirstMate
 * ADR-0009). There is no token and no port here, and there is nothing for this
 * Plugin to leak: the Host spawned this process and owns both ends.
 *
 * The one thing this file exists to be honest about is what a timeout means.
 * When the Scheduler stops waiting, nothing is cancelled: the target Plugin
 * Server keeps working and its late answer is dropped on arrival. So a call
 * that ran out of time is its own answer, never a failure and never a retry.
 */
import { reply } from './mcp.ts';

/**
 * How much longer than this end will wait the Host is asked to wait.
 *
 * The Scheduler's own timer has to be the one that fires, because the Outcome
 * is the Scheduler's to decide and a race between two timers decides nothing.
 * If an operator sets the Host's ceiling below what the Scheduler waits, the
 * Host's sentence arrives first and the Run is `failed` — which is honest, and
 * says the Plugin Server did not answer.
 */
const HOST_MARGIN_MS = 5_000;

/** What came back from the Host, as one of three things and never two. */
export type BusResult =
  | { readonly kind: 'answered'; readonly result: unknown }
  | { readonly kind: 'refused'; readonly said: string }
  | { readonly kind: 'timed-out' };

/** Whoever here is waiting for the Host, by the id it asked with. */
const owed = new Map<string, (answer: Answered) => void>();
let counter = 0;

type Answered = {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

/**
 * Hand the Host's answer to whoever asked for it.
 *
 * An answer nobody is owed is dropped without a word. That is the late answer
 * to a call this end has already given up on, and saying anything about it
 * would put a line in the journal for something that is working as intended.
 */
export function receive(message: Readonly<Record<string, unknown>>): void {
  const answered = owed.get(String(message['id']));
  if (answered === undefined) return;
  owed.delete(String(message['id']));
  answered(message as Answered);
}

/** Ask the Host to call one tool of another Plugin, under a Grant. */
export function callPlugin(
  plugin: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
  waitMs: number,
): Promise<BusResult> {
  return ask('firstmate/tools/call', { plugin, name, arguments: args }, waitMs);
}

/**
 * Ask the Host which tools another Plugin has, under a Grant.
 *
 * This is how the form on the Page offers a list to choose from rather than a
 * box to mistype a tool name into.
 */
export function listPluginTools(plugin: string, waitMs: number): Promise<BusResult> {
  return ask('firstmate/tools/list', { plugin }, waitMs);
}

function ask(
  method: string,
  params: Readonly<Record<string, unknown>>,
  waitMs: number,
): Promise<BusResult> {
  const id = `scheduler-${(counter += 1)}`;
  return new Promise<BusResult>((done) => {
    const timer = setTimeout(() => {
      // Stop waiting, and drop the answer if it ever turns up. Nothing about
      // this reaches the target: it is still working.
      owed.delete(id);
      done({ kind: 'timed-out' });
    }, waitMs);

    owed.set(id, (answer) => {
      clearTimeout(timer);
      if (answer.error !== undefined) done({ kind: 'refused', said: answer.error.message });
      else done({ kind: 'answered', result: answer.result });
    });

    reply({
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, timeoutMs: waitMs + HOST_MARGIN_MS },
    });
  });
}
