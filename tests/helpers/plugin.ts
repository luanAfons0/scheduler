/**
 * The one test seam: the real Plugin Server, spawned against a temporary
 * Plugin directory, spoken to exactly as the Host speaks to it.
 *
 * Nothing here imports a module of the Plugin. What a test may see is what the
 * Host may see: the JSON-RPC lines on stdout, the diagnostics on stderr, the
 * exit code, and the files the Plugin writes into its own directory. That is
 * what lets the whole inside of this Plugin be rewritten without touching a
 * test.
 *
 * The Host starts a Plugin Server in the Plugin's own directory, so a test
 * gives it a temporary one. The code still comes from this repository; only
 * the directory the Plugin reads and writes its files in is temporary.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

const TESTS = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY = dirname(TESTS);

/** The `mcp` executable the Host would run. Tests run the same file. */
export const EXECUTABLE = join(REPOSITORY, 'mcp');

/** The protocol version the Host sends in its handshake. */
export const PROTOCOL_VERSION = '2025-06-18';

/** How long a test waits for one answer before it gives up. */
const ANSWER_TIMEOUT_MS = 10_000;

/** One answer to one JSON-RPC request: exactly one of these two is there. */
export type Answer = {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

/**
 * What the Host would answer a question the Plugin Server asks on its own
 * account — `firstmate/tools/call` and `firstmate/tools/list`. A test that
 * proves the clock sets one; a test that only drives the Plugin's own tools
 * never needs it, and the default refusal keeps a stray call visible.
 */
export type HostAnswer = (question: Question) => Answer | Promise<Answer>;

export type Question = {
  readonly method: string;
  readonly params: Record<string, unknown>;
};

export type StartOptions = {
  /** Added to the Plugin Server's environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Files written into the temporary Plugin directory before it starts. */
  readonly files?: Readonly<Record<string, string>>;
  /** How the Host answers what this Plugin Server asks. */
  readonly host?: HostAnswer;
};

export type Started = {
  /** The temporary Plugin directory the Plugin Server runs in. */
  readonly directory: string;
  /** Send the handshake the Host sends, and hand back its answer. */
  handshake(): Promise<Answer>;
  /** One JSON-RPC request, answered by the id it was sent with. */
  ask(method: string, params?: unknown): Promise<Answer>;
  /** One JSON-RPC notification, which is never answered. */
  notify(method: string, params?: unknown): void;
  /**
   * One line written byte for byte. A test needs this where the Host would
   * never write such a line but something else might: a line that is not JSON
   * at all, which the transport has to survive.
   */
  raw(line: string): void;
  /** Every line the Plugin Server has written on stdout, as it wrote it. */
  lines(): readonly string[];
  /** Everything the Plugin Server has written on stderr. */
  output(): string;
  /**
   * What the Plugin Server exited as, once it has. A Plugin Server that stays
   * up is a failure with a sentence rather than a test that hangs: the whole
   * point of these cases is that a wrong jobs file stops it.
   */
  ended(within?: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Close stdin, which is how the Host asks a Plugin Server to stop. */
  stop(): void;
};

/** A temporary Plugin directory for one test, removed when the test ends. */
export async function makeDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'scheduler-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Start the real Plugin Server against a temporary Plugin directory. It is
 * stopped and the directory removed when the test ends, whatever the test did.
 */
export async function startPluginServer(
  t: TestContext,
  options: StartOptions = {},
): Promise<Started> {
  const directory = await makeDirectory(t);
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await writeFile(join(directory, name), content);
  }

  const child = spawn(EXECUTABLE, [], {
    cwd: directory,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const lines: string[] = [];
  let output = '';
  let pending = '';
  let counter = 0;
  /** Whoever here is waiting for the Plugin Server, by the id it was asked with. */
  const owed = new Map<string, (answer: Answer) => void>();

  let ending: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    // A Plugin Server the Host cannot run at all is the mistake that costs an
    // afternoon, so it fails here as a sentence rather than as a stack trace.
    child.once('error', (fault) => (output += `the Plugin Server could not be run: ${fault.message}\n`));
    child.once('exit', (code, signal) => {
      ending = { code, signal };
      // Nobody is going to answer now. Fail the waiting tests rather than
      // leave them hanging until the whole suite times out.
      for (const [id, answered] of owed) {
        answered({ error: { code: 0, message: `the Plugin Server exited before answering ${id}` } });
      }
      owed.clear();
      done(ending);
    });
  });

  const send = (message: unknown): void => {
    child.stdin!.write(`${JSON.stringify(message)}\n`);
  };

  const host = options.host ?? refuseEverything;

  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    pending += chunk;
    for (;;) {
      const end = pending.indexOf('\n');
      if (end < 0) break;
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim() === '') continue;
      lines.push(line);
      receive(line);
    }
  });

  /**
   * One line from the Plugin Server. A message that names no method is an
   * answer to something a test asked; everything else is the Plugin Server
   * asking the Host. It is the rule the Host uses too.
   */
  function receive(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not JSON. A test reads it off `lines()` and says so itself.
      return;
    }
    if (message['method'] === undefined) {
      const answered = owed.get(String(message['id']));
      if (answered === undefined) return;
      owed.delete(String(message['id']));
      answered(message as Answer);
      return;
    }
    if (message['id'] === undefined || message['id'] === null) return;
    void Promise.resolve(
      host({
        method: String(message['method']),
        params: (message['params'] as Record<string, unknown>) ?? {},
      }),
    ).then((answer) => send({ jsonrpc: '2.0', id: message['id'], ...answer }));
  }

  t.after(async () => {
    child.stdin!.end();
    child.kill('SIGTERM');
    if (ending === null) await ended;
  });

  return {
    directory,
    handshake: async () => {
      const answer = await askFor('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { experimental: { firstmate: { toolBus: {} } } },
        clientInfo: { name: 'firstmate', version: '1.0.0' },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return answer;
    },
    ask: askFor,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    raw: (line) => child.stdin!.write(`${line}\n`),
    lines: () => lines,
    output: () => output,
    ended: (within = ANSWER_TIMEOUT_MS) =>
      Promise.race([
        ended,
        new Promise<never>((_, fail) =>
          setTimeout(
            () => fail(new Error(`the Plugin Server was still up after ${within} ms.\n${output}`)),
            within,
          ).unref(),
        ),
      ]),
    stop: () => child.stdin!.end(),
  };

  function askFor(method: string, params?: unknown): Promise<Answer> {
    const id = `test-${(counter += 1)}`;
    return new Promise<Answer>((answered, fail) => {
      const timer = setTimeout(() => {
        owed.delete(id);
        fail(new Error(`the Plugin Server did not answer ${method} in ${ANSWER_TIMEOUT_MS} ms.\n${output}`));
      }, ANSWER_TIMEOUT_MS);
      owed.set(id, (answer) => {
        clearTimeout(timer);
        answered(answer);
      });
      send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }
}

/** The Host a test did not arrange: it carries nothing, so it refuses. */
const refuseEverything: HostAnswer = (question) => ({
  error: { code: -32601, message: `this test arranged no Host answer for ${question.method}` },
});

/** The text of an MCP result, which is where every tool's answer is. */
export function textOf(answer: Answer): string {
  const result = answer.result as { content?: { type: string; text: string }[] } | undefined;
  return (result?.content ?? []).map((part) => part.text).join('');
}

/** The structured half of an MCP result, parsed. */
export function structureOf(answer: Answer): unknown {
  const result = answer.result as { structuredContent?: unknown } | undefined;
  return result?.structuredContent;
}

/** Wait for a child to be gone, for a test that stops one itself. */
export function once(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((done) => child.once('exit', () => done()));
}
