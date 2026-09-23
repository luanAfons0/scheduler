/* The Scheduler Plugin Page. Vanilla JavaScript, no build step and no
   framework, talking to one same-origin address. Everything it shows it
   learned by asking its own Plugin Server; it assumes nothing.

   The jobs file is the truth and stays hand-editable. This page is a second
   way in, never the only one, so every write it makes carries the hash of the
   file it last read and is refused if somebody else got there first. */
'use strict';

// The one address this page talks to: its own Plugin's tools, relative to
// /p/scheduler/. FirstMate admits the page with a cookie it set on the first
// navigation, so nothing here carries a token and no address is built by hand.
const RPC = 'rpc';

// What the Host answers when it cannot reach the Plugin Server at all. An
// empty page would leave either one a mystery, so each becomes a sentence.
const STOPPED = 503;
const NO_PLUGIN_SERVER = 501;

let counter = 0;
/** The hash of the jobs file as this page last read it. Every write carries it. */
let hash = null;

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children || []) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const byId = (id) => document.getElementById(id);

/** One tool call on this Plugin's own Plugin Server. */
async function call(name, args) {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: (counter += 1),
      method: 'tools/call',
      params: { name: name, arguments: args || {} },
    }),
  });

  if (response.status === STOPPED) {
    throw new Error(
      'The Scheduler’s Plugin Server is Stopped, so no Job is running. ' +
        'The reason is in the journal: journalctl --user -u firstmate -f. ' +
        'The Host never starts it again on its own, so restart the Host once it is fixed.',
    );
  }
  if (response.status === NO_PLUGIN_SERVER) {
    throw new Error('This Plugin ships no Plugin Server, so it has no clock.');
  }
  if (!response.ok) {
    throw new Error('The Host answered ' + response.status + ' for this call.');
  }

  const answered = await response.json();
  if (answered.error) throw new Error(answered.error.message);
  return answered.result.structuredContent;
}

// --- saying what is wrong -------------------------------------------------

function say(text) {
  const banner = byId('banner');
  banner.textContent = text;
  banner.hidden = text === null || text === '';
}

function show(node, text, kind) {
  node.className = 'card ' + (kind || 'empty');
  node.textContent = text;
}

// --- the table ------------------------------------------------------------

/** A moment, read on the clock of the zone that Job records. */
function moment(when, at) {
  if (at === null || at === undefined) return null;
  return new Date(at).toLocaleString('en-GB', {
    timeZone: when.timezone,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** The last Run, as the two cells that say whether it worked. */
function result(job) {
  const run = job.lastRun;
  if (run === null) {
    return [
      el('td', { class: 'next', text: 'never' }),
      el('td', { class: 'dim', text: 'nothing has run yet' }),
    ];
  }
  return [
    el('td', { class: 'next' }, [
      moment(job.when, run.started),
      // A Late Run is one that started after its Due time, because the Host
      // was not up when the time arrived. Saying so is what makes a 23:40 Run
      // of a 09:00 Job explain itself.
      run.late ? el('span', { class: 'late', text: 'Late' }) : null,
    ]),
    el('td', {}, [
      // The Outcome is a word before it is a colour, so it reads the same
      // without one. `timed-out` is not a failure: the tool may still be
      // running, and the sentence beside it says so.
      el('span', { class: 'outcome ' + run.outcome, text: run.outcome }),
      ' ',
      el('span', { class: 'said', text: run.said }),
    ]),
  ];
}

function button(text, kind, onClick) {
  const node = el('button', { class: 'act ' + (kind || ''), type: 'button', text: text });
  node.addEventListener('click', onClick);
  return node;
}

/** One write, with the page put back the way it was if it is refused. */
async function write(node, busy, work) {
  const was = node.textContent;
  node.disabled = true;
  node.textContent = busy;
  say(null);
  try {
    await work();
    await load();
  } catch (fault) {
    node.disabled = false;
    node.textContent = was;
    say(fault.message);
  }
}

function row(job) {
  const next = moment(job.when, job.nextDue);
  return el('tr', {}, [
    el('td', { class: 'name', text: job.name }),
    el('td', { text: job.whenSaid }),
    el('td', { class: 'calls', text: job.plugin + ' / ' + job.tool }),
    el('td', {}, [
      // The word carries the state, so nothing here is readable by colour
      // alone, and pressing it is how a Job is paused without retyping it.
      button(job.enabled ? 'on' : 'off', job.enabled ? 'on' : 'off', (event) =>
        write(event.currentTarget, '…', () =>
          call('enable_job', { name: job.name, enabled: !job.enabled, ifMatch: hash }),
        ),
      ),
    ]),
    ...result(job),
    el('td', { class: 'next', text: next === null ? 'never, while it is off' : next }),
    el('td', { class: 'acts' }, [
      button('Run now', null, (event) =>
        write(event.currentTarget, 'running…', () => call('run_job', { name: job.name })),
      ),
      button('Remove', null, (event) =>
        write(event.currentTarget, '…', () =>
          call('remove_job', { name: job.name, ifMatch: hash }),
        ),
      ),
    ]),
  ]);
}

/** Draw the Jobs, whatever they turned out to be. */
function draw(listed) {
  const node = byId('jobs');
  hash = listed.hash;
  // A jobs file that went wrong while the Plugin is running keeps the last
  // good Jobs. The Page is where that is said, because the Plugin Server did
  // not stop and the journal has nothing new in it.
  say(listed.problem);

  if (listed.jobs.length === 0) {
    show(node, 'There are no Jobs yet.');
    return;
  }
  node.className = 'card';
  node.replaceChildren(
    el('table', { class: 'jobs' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Job' }),
          el('th', { text: 'When' }),
          el('th', { text: 'Calls' }),
          el('th', { text: 'Enabled' }),
          el('th', { text: 'Last run' }),
          el('th', { text: 'Result' }),
          el('th', { text: 'Next run' }),
          el('th', { text: '' }),
        ]),
      ]),
      el('tbody', {}, listed.jobs.map(row)),
    ]),
  );
}

async function load() {
  try {
    draw(await call('list_jobs', {}));
  } catch (fault) {
    show(byId('jobs'), fault.message, 'wrong');
  }
}

// --- the form -------------------------------------------------------------

/** The tools the Plugin named in the form last said it had. */
let offered = [];

/** Only the fields this When actually has are on the form. */
function shapeWhen() {
  const every = byId('f-every').value;
  byId('f-day').hidden = every !== 'weekly';
  byId('f-at').hidden = every === 'hourly';
}

function showSchema() {
  const tool = offered.find((one) => one.name === byId('f-tool').value);
  byId('f-schema').textContent =
    tool === undefined
      ? 'Choose a tool to see what it expects.'
      : JSON.stringify(tool.inputSchema, null, 2);
}

async function askForTools(node) {
  const plugin = byId('f-plugin').value.trim();
  if (plugin === '') {
    say('Name the Plugin whose tool this Job should call.');
    return;
  }
  const was = node.textContent;
  node.disabled = true;
  node.textContent = 'asking…';
  say(null);
  try {
    const answer = await call('list_plugin_tools', { plugin: plugin });
    offered = answer.tools || [];
    const select = byId('f-tool');
    select.disabled = offered.length === 0;
    select.replaceChildren(
      ...offered.map((tool) => el('option', { value: tool.name, text: tool.name })),
    );
    showSchema();
    if (offered.length === 0) say('The Plugin named ' + plugin + ' has no tools.');
  } catch (fault) {
    // The Host's own sentence, unchanged: no Grant, not registered, Stopped,
    // or no Plugin Server. It already says exactly what is wrong and what to
    // do about it.
    say(fault.message);
  } finally {
    node.disabled = false;
    node.textContent = was;
  }
}

function whenFromForm() {
  const every = byId('f-every').value;
  const when = { every: every, timezone: byId('f-zone').value.trim() };
  if (every !== 'hourly') when.at = byId('f-at').value;
  if (every === 'weekly') when.day = byId('f-day').value;
  return when;
}

async function add(event) {
  event.preventDefault();
  say(null);

  let args;
  try {
    // Refused before anything is written, because a page that sends a broken
    // argument and lets the Plugin Server explain it is a slower way to say
    // the same thing.
    args = JSON.parse(byId('f-args').value);
  } catch (fault) {
    say('The arguments are not valid JSON: ' + fault.message);
    return;
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    say('The arguments are a JSON object. A tool that takes none still takes {}.');
    return;
  }

  const job = {
    name: byId('f-name').value.trim(),
    enabled: byId('f-enabled').checked,
    when: whenFromForm(),
    plugin: byId('f-plugin').value.trim(),
    tool: byId('f-tool').value,
    arguments: args,
    missedRunGraceMinutes: Number(byId('f-grace').value),
  };

  await write(byId('f-add'), 'adding…', async () => {
    await call('add_job', { job: job, ifMatch: hash });
    byId('f-name').value = '';
    byId('f-args').value = '{}';
  });
}

function start() {
  // The machine's own zone is the one a person means when they do not say.
  byId('f-zone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  byId('f-every').addEventListener('change', shapeWhen);
  byId('f-tool').addEventListener('change', showSchema);
  byId('f-ask').addEventListener('click', (event) => askForTools(event.currentTarget));
  byId('form').addEventListener('submit', add);
  shapeWhen();
  load();
}

start();
