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

// --- time -----------------------------------------------------------------

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The last list_jobs answer, so the clock can redraw it without asking again. */
let listed = null;

/** A moment's parts, read on the clock of the zone that Job records. */
function parts(at, timezone, options) {
  const out = {};
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, ...options });
  for (const part of format.formatToParts(new Date(at))) out[part.type] = part.value;
  return out;
}

/** 09:00, on the Job's own clock. */
function clock(at, timezone) {
  const p = parts(at, timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return p.hour + ':' + p.minute;
}

/** Wed 23 Sep, on the Job's own clock. */
function day(at, timezone) {
  const p = parts(at, timezone, { weekday: 'short', day: 'numeric', month: 'short' });
  return p.weekday + ' ' + p.day + ' ' + p.month;
}

/** How far a moment is from now, in the two largest units that matter. */
function until(at) {
  const left = new Date(at).getTime() - Date.now();
  if (left <= 0) return 'Due now';
  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  const minutes = Math.ceil((left % HOUR) / MINUTE);
  if (days > 0) return 'in ' + days + 'd ' + hours + 'h';
  if (hours > 0) return 'in ' + hours + 'h ' + minutes + 'm';
  return 'in ' + minutes + 'm';
}

// --- up next: the ruler ---------------------------------------------------

/** The machine's own zone. The ruler is read on it, because it is one clock. */
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** How many rows the tick labels may stack into before they give up. */
const LANES = 3;

function drawAhead() {
  const node = byId('ahead');
  const note = byId('ahead-note');
  if (listed === null || listed.jobs.length === 0) {
    node.hidden = true;
    note.textContent = '';
    return;
  }
  node.hidden = false;
  note.textContent = 'the next 24 hours, ' + HERE;

  const now = Date.now();
  const coming = listed.jobs
    .filter((job) => job.nextDue !== null)
    .map((job) => ({ job: job, at: new Date(job.nextDue).getTime() }))
    .sort((a, b) => a.at - b.at);
  const inside = coming.filter((one) => one.at - now < DAY);
  const later = coming.filter((one) => one.at - now >= DAY);

  const where = (at) => Math.min(100, Math.max(0, ((at - now) / DAY) * 100));

  // Hour marks every three hours of this machine's clock, and the midnight
  // one named by its day, so a tick past it says tomorrow without a word.
  const hours = [];
  const first = new Date(now);
  first.setMinutes(0, 0, 0);
  for (let at = first.getTime() + HOUR; at < now + DAY; at += HOUR) {
    const hour = new Date(at).getHours();
    if (hour % 3 !== 0) continue;
    const midnight = hour === 0;
    const mark = el('span', {
      class: 'hour' + (midnight ? ' midnight' : ''),
      text: midnight ? day(at, HERE) : clock(at, HERE),
    });
    mark.style.left = where(at) + '%';
    hours.push(mark);
  }

  // A label goes on the lowest lane where it does not run into the one
  // before it. Past the last lane it shares, which is rare and still legible.
  // A label's width is guessed from its letters, as a share of the ruler, so
  // a phone stacks labels that a wide window sets side by side.
  const across = Math.max(1, node.clientWidth - 36);
  const ends = new Array(LANES).fill(-Infinity);
  const ticks = inside.map((one) => {
    const x = where(one.at);
    const flip = x > 60;
    const wide = ((one.job.name.length + 6) * 7.5 + 16) / across * 100;
    let lane = ends.findIndex((end) => (flip ? x - wide : x) > end);
    if (lane === -1) lane = LANES - 1;
    ends[lane] = flip ? x : x + wide;
    const tick = el('div', { class: 'tick' + (flip ? ' flip' : ''), title: one.job.whenSaid }, [
      el('span', { class: 'tick-label' }, [
        el('b', { text: clock(one.at, HERE) }),
        one.job.name,
      ]),
    ]);
    tick.style.left = x + '%';
    tick.style.setProperty('--lane', String(lane));
    return tick;
  });
  const used = Math.max(1, ...ends.map((end, lane) => (end === -Infinity ? 0 : lane + 1)));

  const ruler = el('div', { class: 'ruler', role: 'img' }, [
    el('div', { class: 'ruler-axis' }),
    ...hours,
    ...ticks,
    el('span', { class: 'now-line', title: 'now' }),
  ]);
  ruler.style.setProperty('--lanes', String(used));
  ruler.setAttribute(
    'aria-label',
    inside.length === 0
      ? 'Nothing comes Due in the next 24 hours.'
      : inside.map((one) => one.job.name + ' at ' + clock(one.at, HERE)).join(', '),
  );

  const children = [ruler];
  if (inside.length === 0) {
    children.push(el('p', { class: 'ahead-later', text: 'Nothing comes Due in the next 24 hours.' }));
  } else if (later.length > 0) {
    children.push(
      el('p', { class: 'ahead-later' }, [
        'Later: ',
        ...later.flatMap((one, index) => [
          index > 0 ? ', ' : '',
          el('b', { text: one.job.name }),
          ' ' + day(one.at, one.job.when.timezone) + ' ' + clock(one.at, one.job.when.timezone),
        ]),
      ]),
    );
  }
  node.replaceChildren(...children);
}

// --- the Jobs -------------------------------------------------------------

function button(text, kind, onClick) {
  const node = el('button', { class: 'act ' + (kind || ''), type: 'button', text: text });
  node.addEventListener('click', onClick);
  return node;
}

/** Whether a write is in flight, so the clock does not redraw under it. */
let busy = false;

/** One write, with the page put back the way it was if it is refused. */
async function write(node, doing, work) {
  const was = node.textContent;
  node.disabled = true;
  node.textContent = doing;
  busy = true;
  say(null);
  try {
    await work();
    await load();
  } catch (fault) {
    node.disabled = false;
    node.textContent = was;
    say(fault.message);
  } finally {
    busy = false;
  }
}

/** The one Remove that is asking to be pressed again, if any. */
let armed = null;

/** Remove asks once more before it removes, and forgets it asked after a while. */
function removeButton(job) {
  const node = button('Remove', 'danger', () => {
    if (armed !== node) {
      disarm();
      armed = node;
      node.classList.add('armed');
      node.textContent = 'Remove ' + job.name + '?';
      node.dataset.timer = String(setTimeout(disarm, 4000));
      return;
    }
    clearTimeout(Number(node.dataset.timer));
    armed = null;
    write(node, 'removing…', () => call('remove_job', { name: job.name, ifMatch: hash }));
  });
  node.addEventListener('blur', () => {
    if (armed === node) disarm();
  });
  return node;
}

function disarm() {
  if (armed === null) return;
  clearTimeout(Number(armed.dataset.timer));
  armed.classList.remove('armed');
  armed.textContent = 'Remove';
  armed = null;
}

/** When the Job next comes Due, big, on the Job's own clock. */
function due(job) {
  if (job.nextDue === null) {
    return el('div', { class: 'due' }, [
      el('span', { class: 'due-time', text: '--:--' }),
      el('span', { class: 'due-day', text: 'off, so never' }),
    ]);
  }
  return el('div', { class: 'due' }, [
    el('span', { class: 'due-time', text: clock(job.nextDue, job.when.timezone) }),
    el('span', { class: 'due-day', text: day(job.nextDue, job.when.timezone) }),
    el('span', { class: 'due-in', 'data-at': job.nextDue, text: until(job.nextDue) }),
  ]);
}

/** The last Run, as the sentence that says whether it worked. */
function last(job) {
  const run = job.lastRun;
  if (run === null) return el('div', { class: 'last said', text: 'Nothing has Run yet.' });
  const zone = job.when.timezone;
  return el('div', { class: 'last' }, [
    // The Outcome is a word before it is a colour, so it reads the same
    // without one. `timed-out` is not a failure: the tool may still be
    // running, and the sentence beside it says so.
    el('span', { class: 'outcome ' + run.outcome, text: run.outcome }),
    el('span', { class: 'last-at', text: day(run.started, zone) + ', ' + clock(run.started, zone) }),
    // A Late Run is one that started after its Due time, because the Host
    // was not up when the time arrived. Saying so is what makes a 23:40 Run
    // of a 09:00 Job explain itself.
    run.late ? el('span', { class: 'late', text: 'Late' }) : null,
    el('span', { class: 'said', text: run.said }),
  ]);
}

/** Every Run kept, oldest first, one mark each, with the sentence on hover. */
function history(job) {
  const runs = job.runs || [];
  if (runs.length < 2) return null;
  const zone = job.when.timezone;
  return el('ol', { class: 'runs', 'aria-label': 'The last ' + runs.length + ' Runs' }, [
    ...runs.map((run) =>
      el('li', {
        class: run.outcome,
        title:
          day(run.started, zone) + ' ' + clock(run.started, zone) + ' · ' + run.outcome +
          (run.late ? ' · Late' : '') + ' · ' + run.said,
      }),
    ),
    el('span', { class: 'runs-label', text: 'last ' + runs.length + ' Runs' }),
  ]);
}

function card(job) {
  return el('article', { class: 'job' + (job.enabled ? '' : ' off') }, [
    due(job),
    el('div', { class: 'body' }, [
      el('div', { class: 'job-hd' }, [
        el('h3', { class: 'name', text: job.name }),
        // The word carries the state, so nothing here is readable by colour
        // alone, and pressing it is how a Job is paused without retyping it.
        (() => {
          const node = el('button', {
            class: 'switch',
            type: 'button',
            role: 'switch',
            'aria-checked': String(job.enabled),
            'aria-label': 'Let ' + job.name + ' Run',
            text: job.enabled ? 'On' : 'Off',
          });
          node.addEventListener('click', () =>
            write(node, '…', () =>
              call('enable_job', { name: job.name, enabled: !job.enabled, ifMatch: hash }),
            ),
          );
          return node;
        })(),
      ]),
      el('p', { class: 'meta' }, [
        job.whenSaid + ' · calls ',
        el('code', { text: job.plugin + ' / ' + job.tool }),
      ]),
      last(job),
      history(job),
    ]),
    el('div', { class: 'acts' }, [
      button('Run now', null, (event) =>
        write(event.currentTarget, 'running…', () => call('run_job', { name: job.name })),
      ),
      button('Change', null, () => change(job)),
      removeButton(job),
    ]),
  ]);
}

/** Draw the Jobs, whatever they turned out to be. */
function draw(answer) {
  const node = byId('jobs');
  listed = answer;
  hash = answer.hash;
  armed = null;
  // A jobs file that went wrong while the Plugin is running keeps the last
  // good Jobs. The Page is where that is said, because the Plugin Server did
  // not stop and the journal has nothing new in it.
  say(answer.problem);
  drawAhead();

  const count = answer.jobs.length;
  const on = answer.jobs.filter((job) => job.enabled).length;
  byId('jobs-count').textContent =
    count === 0 ? '' : count + (count === 1 ? ' Job' : ' Jobs') + ', ' + on + ' on';

  if (count === 0) {
    show(node, 'There are no Jobs yet. Press New Job to add one, or write it into jobs.json.');
    return;
  }
  // Sorted by what comes Due first, the way a timetable is read. A Job that
  // is off has no time and goes last.
  const order = [...answer.jobs].sort((a, b) => {
    if (a.nextDue === null) return b.nextDue === null ? 0 : 1;
    if (b.nextDue === null) return -1;
    return new Date(a.nextDue).getTime() - new Date(b.nextDue).getTime();
  });
  node.className = 'card';
  node.replaceChildren(...order.map(card));
}

async function load() {
  try {
    draw(await call('list_jobs', {}));
  } catch (fault) {
    listed = null;
    drawAhead();
    show(byId('jobs'), fault.message, 'wrong');
  }
}

/** The page's own second hand: the countdowns and the ruler move with now. */
function tick() {
  byId('now').textContent = 'now ' + clock(Date.now(), HERE) + ' · ' + HERE;
  for (const node of document.querySelectorAll('.due-in[data-at]')) {
    node.textContent = until(node.dataset.at);
  }
  drawAhead();
}

/**
 * Ask again once a minute while the page is in view, so a Run the clock made
 * shows up without a reload. Never under a write, and never under a Remove
 * that is waiting to be pressed again.
 */
function refresh() {
  if (document.hidden || busy || armed !== null) return;
  load();
}

// --- the form -------------------------------------------------------------

/** The tools the Plugin named in the form last said it had. */
let offered = [];

/**
 * The Job the form is changing, and the hash of the file it was read from, or
 * null while the form adds. The hash is the one the form was filled from, not
 * the newest one: a refresh under an open form must not let a change overwrite
 * a hand edit nobody saw (ADR-0002).
 */
let changing = null;

/** Only the fields this When actually has are on the form. */
function shapeWhen() {
  const every = byId('f-every').value;
  byId('f-day').hidden = every !== 'weekly';
  byId('f-at').hidden = every === 'hourly';
  byId('f-at-word').hidden = every === 'hourly';
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
    offer(offered);
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

async function submit(event) {
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

  if (changing !== null) {
    await write(byId('f-add'), 'changing…', async () => {
      await call('change_job', { job: job, ifMatch: changing.hash });
      compose(false);
    });
    return;
  }
  await write(byId('f-add'), 'adding…', async () => {
    await call('add_job', { job: job, ifMatch: hash });
    byId('f-name').value = '';
    byId('f-args').value = '{}';
    compose(false);
  });
}

/** Offer exactly these tools, with the one named selected. */
function offer(tools, selected) {
  const select = byId('f-tool');
  select.disabled = tools.length === 0;
  select.replaceChildren(
    ...tools.map((tool) => el('option', { value: tool.name, text: tool.label || tool.name })),
  );
  if (selected !== undefined) select.value = selected;
  showSchema();
}

/**
 * Open the form on one Job, filled with what it is now. The name is the key
 * to the Job's history and `enabled` belongs to the switch, so the form
 * offers neither (ADR-0002).
 */
function change(job) {
  changing = { job: job, hash: hash };
  say(null);
  byId('add-hd').textContent = 'Change ' + job.name;
  byId('f-add').textContent = 'Change';
  byId('f-name').value = job.name;
  byId('f-name').readOnly = true;
  byId('f-enabled-box').hidden = true;
  byId('f-every').value = job.when.every;
  byId('f-at').value = job.when.at || '09:00';
  byId('f-day').value = job.when.day || 'monday';
  byId('f-zone').value = job.when.timezone;
  shapeWhen();
  byId('f-plugin').value = job.plugin;
  offered = [];
  offer([{ name: job.tool }], job.tool);
  byId('f-args').value = JSON.stringify(job.arguments, null, 2);
  byId('f-grace').value = String(job.missedRunGraceMinutes);
  compose(true);
  toolsFor(job, changing);
}

/** A few words beside the tool select, or none. */
function toolNote(text) {
  const node = byId('f-tool-note');
  node.textContent = text;
  node.hidden = text === '';
}

/**
 * Ask the Job's Plugin for its tools as the change starts, so another tool is
 * one choice away. The form holds the current tool meanwhile and can be sent,
 * because a change of time must not wait on another Plugin.
 */
async function toolsFor(job, mine) {
  toolNote('asking…');
  // An answer that comes back after the form moved on is about a form nobody
  // is looking at, or about a Plugin the field no longer names.
  const stale = () => changing !== mine || byId('f-plugin').value.trim() !== job.plugin;
  try {
    const answer = await call('list_plugin_tools', { plugin: job.plugin });
    if (stale()) return;
    offered = answer.tools || [];
    if (offered.some((tool) => tool.name === job.tool)) {
      offer(offered, job.tool);
      return;
    }
    // Kept, and chosen, so nothing about the Job changes unless a person
    // chooses another tool.
    offer([...offered, { name: job.tool, label: job.tool + ' (not offered now)' }], job.tool);
    say('The Plugin named ' + job.plugin + ' no longer offers the tool ' + job.tool + '.');
  } catch (fault) {
    // The Host's own sentence, unchanged, and the current tool kept, so the
    // Job's time can still be changed while its Plugin is away.
    if (!stale()) say(fault.message);
  } finally {
    if (changing === mine) toolNote('');
  }
}

/** Put the form back to adding, empty, as the markup declares it. */
function adding() {
  changing = null;
  byId('form').reset();
  byId('add-hd').textContent = 'Add a Job';
  byId('f-name').readOnly = false;
  byId('f-enabled-box').hidden = false;
  toolNote('');
  byId('f-zone').value = HERE;
  shapeWhen();
  offered = [];
  const select = byId('f-tool');
  select.disabled = true;
  select.replaceChildren(el('option', { value: '', text: 'List a Plugin’s tools first' }));
  showSchema();
}

/**
 * Show or hide the form. A Job added or changed, or a Cancel, puts it away
 * again; a change also puts it back to adding, so the next New Job is empty.
 */
function compose(open) {
  if (!open) {
    if (changing !== null) adding();
    // A write that put the form away leaves its button busy, and no redraw
    // replaces it the way one replaces a card's, so it is made ready here.
    byId('f-add').disabled = false;
    byId('f-add').textContent = 'Add Job';
  }
  byId('add').hidden = !open;
  byId('new-job').hidden = open;
  byId('new-job').setAttribute('aria-expanded', String(open));
  if (open) {
    byId('add').scrollIntoView({ block: 'start' });
    // A name being changed is read-only, so the When is where a change starts.
    byId(changing === null ? 'f-name' : 'f-every').focus({ preventScroll: true });
  } else {
    byId('new-job').focus({ preventScroll: true });
  }
}

function start() {
  // The machine's own zone is the one a person means when they do not say.
  byId('f-zone').value = HERE;
  byId('f-every').addEventListener('change', shapeWhen);
  byId('f-tool').addEventListener('change', showSchema);
  byId('f-ask').addEventListener('click', (event) => askForTools(event.currentTarget));
  byId('form').addEventListener('submit', submit);
  byId('new-job').addEventListener('click', () => compose(true));
  byId('f-cancel').addEventListener('click', () => compose(false));
  byId('form').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') compose(false);
  });
  shapeWhen();
  tick();
  load();
  setInterval(tick, 15 * 1000);
  setInterval(refresh, 60 * 1000);
  document.addEventListener('visibilitychange', refresh);
}

start();
