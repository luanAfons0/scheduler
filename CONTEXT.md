# Scheduler

Scheduler is a FirstMate Plugin. It calls one tool of another Plugin at a time
you choose, and shows you what happened.

It is a Plugin like any other, so it borrows FirstMate's words unchanged —
Host, Plugin, Plugin Page, Plugin Server, Tool Bus, Grant, Stopped. They are
defined once, in [`~/.first-mate/CONTEXT.md`](../.first-mate/CONTEXT.md), and
this file never redefines one.

## Language

### A job

**Job**:
A name, a time, and one tool of one Plugin to call at that time. It is the only
thing a person creates here.
_Avoid_: task, automation, rule, entry, cron job

**When**:
The part of a Job that says at which times it is Due: every hour, every day,
every weekday or one day a week, at a time in a named zone.
_Avoid_: schedule, trigger, timer, cron, recurrence

**Due**:
The state of a Job whose next time has arrived. A Job is Due until it Runs or
is Skipped.
_Avoid_: pending, ready, scheduled, queued

**Grace**:
How long after a Due time a Job may still Run Late. Past it, the Job is
Skipped instead.
_Avoid_: window, tolerance, backfill window, slack

### A run

**Run**:
One attempt to call a Job's tool. A Run belongs to exactly one Job and keeps
what the tool answered, in one sentence.
_Avoid_: execution, invocation, trigger, job run

**Outcome**:
What a Run ended as: `ok`, `failed`, `timed-out` or `skipped`. A `timed-out`
Run is not a failed one — the Host stopped waiting, and the tool it called may
still be working.
_Avoid_: status, state, result, exit code

**Late**:
A Run that started after its Due time, because the Host was not up when the
time arrived. A Late Run happens once, however many times the Job was Due while
the Host was off.
_Avoid_: catch-up, backfill, missed run, retry

**Skipped**:
A Job that came Due and was not Run: its Grace had passed, or its previous Run
was still going. A Skipped Job is recorded, never silent.
_Avoid_: cancelled, dropped, ignored, failed
