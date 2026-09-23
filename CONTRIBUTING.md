# Contributing to Scheduler

Scheduler is a FirstMate Plugin that calls one tool of another Plugin at a
time you choose, and shows you what happened. A Job calls that tool as the
person who owns the machine, with no one watching, so a mistake here does
something nobody asked for, or quietly fails to do what they did.

## Read these first

- [`CONTEXT.md`](CONTEXT.md) defines every word this repo uses — Job, When,
  Due, Grace, Run, Outcome, Late, Skipped — and the synonyms to avoid. The
  FirstMate words it borrows (Host, Plugin, Plugin Page, Plugin Server, Tool
  Bus, Grant, Stopped) are defined in
  [FirstMate's `CONTEXT.md`](https://github.com/luanAfons0/FirstMate/blob/main/CONTEXT.md).
  Use these words in code, in comments, in tests, in issues and in commit
  messages.
- [`docs/adr/`](docs/adr) holds the decisions that are expensive to reverse.
  Read the ADR that covers the area you are about to change. If your change
  contradicts one, say so in the pull request instead of overriding it
  quietly.
- The "What it will not do" part of [`README.md`](README.md). Those refusals
  are decisions, not gaps.
- [`AGENTS.md`](AGENTS.md) is the same ground in short form, for coding
  agents.

## What you need

Node 24 or newer, npm and Git. Node runs the TypeScript directly, so there is
nothing to build. For changes to the Page, a running
[FirstMate](https://github.com/luanAfons0/FirstMate) too.

The Scheduler is developed and tested on WSL Debian, where FirstMate runs. The
clock is plain Node (ADR-0001), so macOS and native Windows are untried rather
than unsupported. If you run it there, open an issue with what breaks.

## Get the code

```bash
git clone https://github.com/luanAfons0/scheduler.git
cd scheduler
npm install
npm test
```

Run every command from the repository root.

## Run the tests

```bash
npm test            # node --test: every test
npm run typecheck   # tsc --noEmit
```

Both must pass. The `Check` workflow runs both on `ubuntu-latest` for every
pull request.

Every test spawns the real Plugin Server, through `mcp`, against a temporary
Plugin directory, and speaks MCP to it exactly as the Host does. Two
properties keep that honest, and a change must keep both:

- **No test imports a module of `src/`.** The seam is
  `tests/helpers/plugin.ts`: JSON-RPC lines on stdout, diagnostics on stderr,
  the exit code, and the files the Plugin writes into its own directory.
- **Time is moved, not waited for.** `SCHEDULER_TICK_MS` and
  `SCHEDULER_CALL_MS` make a sixty-second tick and a five-minute Run take
  milliseconds, and a tool call can take an `asOf` moment.

A test name is a sentence about behaviour, not about code:
`'a Job Due while the Plugin was down Runs once, however many Due times passed'`.

## Try a change by hand, safely

Never point a half-finished change at your real Jobs. The Plugin reads and
writes `jobs.json` and `state.json` in the directory it runs in, so register a
clone somewhere else:

1. Install FirstMate: <https://github.com/luanAfons0/FirstMate>.
2. From the FirstMate repository, register your clone and let it call a
   Plugin: `node src/cli.ts add scheduler-dev /absolute/path/to/your/clone`,
   then `node src/cli.ts grant scheduler-dev nexus`.
3. Restart the Host and open `http://127.0.0.1:4747/p/scheduler-dev/`.

The Host serves `web/` from the clone you registered, so an edit to the Page
is one reload away. A change to `src/` needs the Host restarted, because the
Host starts a Plugin Server once and never again on its own.

## How the code is written

- A file starts with a header comment: what it is, then why it is that way.
  Every exported name carries a one-line `/** … */`.
- Plain functions and object literals. No classes, no default exports, no
  framework, `readonly` on every field of an exported type.
- Single quotes, semicolons, two-space indent, lines under 100 columns. There
  is no formatter; match the file you are in.
- **No new dependencies**, at runtime or for development, without an issue
  first.
- Comments say **why**, in the project's words, and name the ADR when a
  decision is behind the code (`(ADR-0001)`).
- Errors are sentences a person can act on, and name the file, the Job and the
  field. Fail early and loudly; say nothing when nothing is wrong.

Properties that a change may not weaken, however good the reason looks:

- **Nothing is ever retried.** Whatever a Run ended as, the next thing that
  happens to that Job is its next Due time.
- A Job the Host was off for Runs **once**, Late, or is Skipped past its Grace.
  Never once per missed Due time.
- A Skipped Job is recorded, never silent.
- `timed-out` is not `failed`. The tool may still be running.
- The jobs file is the truth and stays hand-editable. Every write from the Page
  carries the hash it last read and is refused if the file moved under it.
- A jobs file that goes wrong while the Plugin runs keeps the last good Jobs.
- Another Plugin is reached only over the Tool Bus, under a Grant
  (FirstMate ADR-0009).

## Commits

One imperative sentence in the project's own words, with no prefix, no scope
and no ticket number, the way FirstMate writes them:

```
Call one tool of another Plugin on a clock
Show the Jobs as a timetable, and the next day as a ruler
```

One commit is one whole, working change: code, tests and docs together. No
attribution, co-author or "generated by" lines.

## Pull requests

1. Branch from `main`. Name it after the issue: `issue-12-weekly-in-dst`.
2. Leave `npm test` and `npm run typecheck` green.
3. Update `README.md` when you change a field of a Job, a tool, an Outcome or
   an environment variable.
4. Open the pull request with `gh pr create --base main`, and write
   `Closes #<issue>` in the body.
5. Say in the description which ADR covers what you changed, and whether you
   contradict one.

Small, obvious fixes do not need an issue first. Anything that changes the
shape of `jobs.json` or `state.json`, a tool, or one of the properties above
does: open an issue and let it be discussed before you write the code.

## Issues

Issues live in GitHub Issues for `luanAfons0/scheduler`. A bug report is most
useful with the Job as it is in `jobs.json`, its Runs, the `scheduler:` lines
from the journal, and whether the machine slept around the Due time.

Triage uses five labels: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human` and `wontfix`. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md). A new issue
gets `needs-triage` and a maintainer sorts it from there.

Security problems do not belong in an issue. See [`SECURITY.md`](SECURITY.md).
