# The clock lives in the Plugin

The machine already runs systemd, and `OnCalendar=Mon-Fri 09:00` with
`Persistent=true` would give us the whole clock — a calendar, catch-up after a
shutdown, and survival across suspend — older and better tested than anything
written here. We put the clock inside the Plugin Server anyway, and the
Plugin Server is a resident process the Host already holds for its own
lifetime, so the clock is a sixty-second tick against the wall clock and
nothing more.

## Considered Options

**A `systemd --user` timer for each Job.** A timer holds no end of the pipe the
Tool Bus runs on, and the Tool Bus is on that pipe precisely so that no Plugin
ever holds a port or a token (FirstMate ADR-0009). A timer would need the thing
that ADR refused to hand out, or a new command in the Host to hand it out for
it. A timer's output is also the journal, and what was asked for is a page.

The deciding argument is smaller than either. A person creates a Job on the
Plugin Page, and a Job created by a click would have to be written out as a
unit file and followed by `systemctl --user daemon-reload`. The time a Job runs
at would then live in a generated file rather than in `jobs.json`, and there
would be two places to look when a Job does not run.

**A long `setTimeout` to the next Due time.** Node's timers run on a monotonic
clock that does not advance while the machine is suspended, and this Host runs
in WSL2, where Windows suspends the whole virtual machine. A timer set for
09:00 wakes three hours late after a three-hour sleep. The tick reads the wall
clock on every wake, so suspend, an NTP step, a manual clock change and a DST
shift are all the same case and none of them has code of its own.

## Consequences

The clock is portable because Node is. A contributor running FirstMate on
macOS or on native Windows needs nothing from us: no launchd job, no Task
Scheduler entry, no second implementation of a calendar.

Worst-case lateness is sixty seconds. A Job that needs a time more exact than
that wants something other than this Plugin.
