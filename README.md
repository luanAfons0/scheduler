# Scheduler

A FirstMate Plugin that calls one tool of another Plugin at a time you choose,
and shows you what happened.

FirstMate deliberately owns no scheduler
([ADR-0004](https://github.com/luanAfons0/FirstMate/blob/main/docs/adr/0004-the-host-owns-no-scheduler.md)).
This Plugin brings its own: a list of Jobs, a clock that wakes every sixty
seconds, and a page that answers "did it work" without anyone reading a log.

Read [`CONTEXT.md`](CONTEXT.md) for the words this project uses — Job, When,
Due, Grace, Run, Outcome, Late, Skipped — and
[`docs/adr/0001-the-clock-lives-in-the-plugin.md`](docs/adr/0001-the-clock-lives-in-the-plugin.md)
for why the clock is here rather than in a systemd timer.

## Install it

One command, from its git URL. The files land in the Shelf, the Plugin is
registered in the same step, and nothing it ships is run:

```sh
firstmate install https://github.com/luanAfons0/scheduler.git scheduler
systemctl --user restart firstmate
```

To let it call another Plugin, record a Grant and restart again. A Grant is one
way and covers one pair:

```sh
firstmate grant scheduler nexus
systemctl --user restart firstmate
```

Then open the Index Page, find `scheduler`, and open its Plugin Page.

Developing it instead? Register the directory where it already lives:

```sh
node src/cli.ts add scheduler /absolute/path/to/scheduler
```

## The worked example

The Job this Plugin was built for: every weekday morning, ask Nexus which
Installed Skills upstream has moved on from, and mark them so a glance says
which Update buttons are worth pressing.

```json
{
  "jobs": [
    {
      "name": "nexus-skills",
      "enabled": true,
      "when": { "every": "weekdays", "at": "09:00", "timezone": "America/Sao_Paulo" },
      "plugin": "nexus",
      "tool": "check_skills",
      "arguments": {},
      "missedRunGraceMinutes": 720
    }
  ]
}
```

The Page makes this Job without an editor: name it, pick a When, name the
Plugin, press **List its tools**, choose one, press **Add**. The file stays the
truth either way.

A Job changes in place too, under its name: press **Change** on its card, and
the same form opens, filled, and asks the Plugin for its tools. Behind it,
`change_job` takes the whole Job, as `add_job` does, and keeps its Runs and
whether it is on. A changed Job takes its next Due time from now, so a change
never makes a Run (ADR-0002). A Job with another name is another Job: remove it
and add it.

Leave the machine off overnight and nothing is lost. The Job comes Due at 09:00,
the Host comes back at 11:00, the Job Runs once and is marked **Late**. Come
back on Monday after a long weekend and it Runs once, not three times — and if
you are outside its Grace of 720 minutes, it is recorded **Skipped** instead,
because Friday's Job firing on Tuesday while pretending to be this morning is
worse than it not firing at all.

## A Job

A Job is data in a plain file you can edit by hand, `jobs.json`, in the
Plugin's own directory. It is re-read on every tick, so a hand edit costs
nothing and needs no restart.

| Field                   | What it is                                                     |
| ----------------------- | -------------------------------------------------------------- |
| `name`                  | Unique, non-empty. The key to its state and its history.        |
| `enabled`               | `false` means it never comes Due. Off means off.                |
| `when.every`            | `hourly`, `daily`, `weekdays` or `weekly`.                      |
| `when.at`               | `HH:MM`. Every When but `hourly`, which comes Due on the hour.  |
| `when.day`              | The day of the week. `weekly` only.                             |
| `when.timezone`         | An IANA zone, so the time means the same after a clock changes. |
| `plugin`                | The Plugin Name whose tool this Job calls.                      |
| `tool`                  | One tool of that Plugin.                                        |
| `arguments`             | A JSON object. A tool that takes none still takes `{}`.         |
| `missedRunGraceMinutes` | How late it may still Run before it is Skipped instead.         |

**There is no cron and no RRULE, and there will not be a subset of one.** The
fields are the grammar, so there is no expression language to get subtly wrong.
A cron subset would look like cron until the day real cron silently did
something else.

A jobs file that is wrong when the Plugin Server **starts** stops it: one
sentence naming the file, the Job and the field goes to the journal, and the
Index Page says Stopped. The same file going wrong **while it is running** keeps
the last good Jobs and puts the sentence on the Page instead, because a running
clock must not kill itself over a typo you are still making.

## What it writes down

`state.json`, beside the jobs file: per Job, when it was first seen, the Due
time it last acted on, when its last Run started, and its last ten Runs. Written
whole and moved into place, so a reader sees one state or the one before it.

To start the history over, delete it. Nothing but the history is lost.

The next Due time is never stored. It is derived on read, because a stored one
goes stale the moment a clock moves.

## Outcomes

| Outcome     | What it means                                                       |
| ----------- | ------------------------------------------------------------------- |
| `ok`        | The tool answered. Nothing goes in the journal.                     |
| `failed`    | The tool, or the Host, said why. One line in the journal.           |
| `timed-out` | The Scheduler stopped waiting. **The tool may still be running.**   |
| `skipped`   | It came Due past its Grace, or its own previous Run was still going. |

`timed-out` is not a failure. The Host's timeout cancels nothing: when it stops
waiting, the target keeps working and its late answer is dropped on arrival. So
a timed-out Run says the tool may still be running, and is never retried.

**Nothing is ever retried.** Whatever a Run ended as, the next thing that
happens to that Job is its next Due time.

## Running it

| Command             | What it does                        |
| ------------------- | ----------------------------------- |
| `node --test`       | Every test. This is the whole suite. |
| `npx tsc --noEmit`  | Check the types.                     |

Two environment variables move the clock, and both exist so a test can prove it
in milliseconds rather than in minutes:

- `SCHEDULER_TICK_MS` — how often it wakes. Default `60000`.
- `SCHEDULER_CALL_MS` — how long one Run may take. Default `300000`, which is
  under the Host's own ten-minute ceiling, so the Scheduler's timer decides and
  the Host's is the backstop.

Node 24 and TypeScript, no runtime dependencies, no build step, no framework.

## What it will not do

Cron expressions, RRULE, or a subset of either. A form generated from a tool's
input schema. More than one tool call in a Job, or conditions between Jobs.
Retries of any kind. Notifications: the Page is where a Run lands, and it lands
inside FirstMate's own window with the Plugin list one click away.

Run history beyond the last ten Runs of each Job. The cap is fixed, so there is
nothing to rotate and no log to grow.
