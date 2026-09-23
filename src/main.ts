/**
 * Start-up: read the Jobs and the Runs, start the clock, serve the tools.
 *
 * There is nothing to open and nothing to configure. The Host spawned this
 * process, holds both ends of its pipe, and started it in the Plugin's own
 * directory, so every file this Plugin owns is one relative path away.
 *
 * It says nothing on the way up. A Plugin Server that started is what the
 * Index Page shows; the journal is for what went wrong.
 */
import { receive } from './bus.ts';
import { startClock } from './clock.ts';
import { readConfig } from './config.ts';
import { hold } from './held.ts';
import { readJobs } from './jobs.ts';
import { sentenceFor, serve } from './mcp.ts';
import { readState } from './state.ts';
import { toolsFor } from './tools.ts';

// A jobs file, a state file or an environment variable that is wrong when the
// Plugin Server starts is one sentence and a non-zero exit: the Index Page
// shows the Plugin Stopped and the journal carries the reason. A clock that
// half started is the one thing this must never be.
//
// The same jobs file going wrong later is not this rule. It keeps the last
// good Jobs and puts its sentence on the Page, because a running clock must
// not kill itself over a typo somebody is still making.
function stop(fault: unknown): never {
  process.stderr.write(`scheduler: ${sentenceFor(fault)}\n`);
  return process.exit(1);
}

const config = (() => {
  try {
    return readConfig();
  } catch (fault) {
    return stop(fault);
  }
})();

const held = hold(await readJobs().catch(stop));
const clock = startClock(held, await readState().catch(stop), config);

serve(toolsFor(held, clock, config), { onAnswer: receive });
