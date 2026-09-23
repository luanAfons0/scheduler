# Scheduler

Scheduler is a FirstMate Plugin. It calls one tool of another Plugin at a time
you choose, and shows you what happened. It is a Plugin Server with a clock in
it, a jobs file a person may edit by hand, and a Plugin Page.

Read [`CONTEXT.md`](CONTEXT.md) first. It defines every word this repo uses —
Job, When, Due, Grace, Run, Outcome, Late, Skipped — and the synonyms to
avoid. It borrows FirstMate's words (Host, Plugin, Plugin Page, Plugin Server,
Tool Bus, Grant, Stopped) unchanged, from
[FirstMate's `CONTEXT.md`](https://github.com/luanAfons0/FirstMate/blob/main/CONTEXT.md).
Use those words in code, in comments, in tests, in issues and in commit
messages.

Read the ADR that covers the area you are about to change:
[`docs/adr/`](docs/adr), and FirstMate's own where the Host is involved. If
your change contradicts one, say so out loud instead of overriding it quietly.

## Commands

Run every command from the repository root.

| Command                          | What it does                               |
| -------------------------------- | ------------------------------------------ |
| `node --test`                    | Every test. This is the whole suite.       |
| `node --test tests/due.test.ts`  | One test file, while you work on it.       |
| `npm install && npx tsc --noEmit` | Check the types. `npm run typecheck` is the same. |
| `./mcp`                          | The Plugin Server, as the Host runs it.    |

Two environment variables move the clock, and both exist so a test can prove
it in milliseconds: `SCHEDULER_TICK_MS` (default `60000`) and
`SCHEDULER_CALL_MS` (default `300000`). `SCHEDULER_NODE` names the Node that
`mcp` runs, when the Host's `PATH` has none new enough.

`npm test` and `npm run typecheck` must both pass before you call work done.

## Tech stack

- **Node 24**, which runs TypeScript with no build step. No bundler, no
  transpiler, no watcher.
- **TypeScript 5.8**, `strict`, `noUncheckedIndexedAccess`,
  `erasableSyntaxOnly`. `typescript` is a dev dependency, used only to check
  the types.
- **No runtime dependency.** MCP over stdio is the Plugin's own JSON-RPC
  (`src/mcp.ts`), and the Tool Bus is the same pipe (`src/bus.ts`).
- **The Page** is plain HTML, CSS and JavaScript in `web/`, served by the Host
  byte for byte (FirstMate ADR-0008). No framework, no web font.

## Project structure

```
mcp          the executable the Host runs: find a Node 24, run src/main.ts.
src/         the Plugin Server. Every file is one job.
  main.ts    start-up: read the Jobs and the Runs, start the clock, serve.
  config.ts  the two numbers that move the clock, and nothing else.
  jobs.ts    a Job, read from and written to jobs.json.
  held.ts    the Jobs as currently held, and the sentence when the file broke.
  due.ts     when a When next comes Due, on the clock of the Job's own zone.
  clock.ts   the sixty-second tick, and the one runner behind it.
  state.ts   the Runs this Plugin remembers, in state.json.
  tools.ts   the tools this Plugin ships, for the Page and other Plugins.
  bus.ts     the Tool Bus, from this end of the pipe.
  mcp.ts     the one connection to the Host: MCP over stdio.
web/         the Plugin Page: index.html, app.css, app.js.
tests/       one file per behaviour, plus helpers/plugin.ts.
docs/adr/    the decisions that are expensive to reverse.
docs/agents/ how an agent works in this repo. See "Agent skills" below.
```

`jobs.json` and `state.json` are this machine's Jobs and Runs, not the
project's. Git ignores both.

## Code style

- A file starts with a header comment: what this file is, then why it is that
  way. Every exported name carries a one-line `/** … */`.
- Comments say **why**, in the project's words, and name the ADR when a
  decision is behind the code (`(ADR-0001)`, `(FirstMate ADR-0009)`).
- Plain functions and object literals. No classes, no default exports, no
  inheritance, no framework.
- `readonly` on every field of an exported type. Data in, data out.
- Node built-ins carry the `node:` prefix. Local imports carry the `.ts`
  extension, because Node runs the TypeScript directly.
- Single quotes, semicolons, two-space indent, lines under 100 columns. There
  is no formatter config; match the file you are in.
- Errors are sentences a person can act on, naming the file, the Job and the
  field. Fail loudly and early; say nothing when nothing is wrong.

## Testing

`node --test`. Every test spawns the real Plugin Server against a temporary
Plugin directory and speaks to it exactly as the Host does.

- **No test imports a module of `src/`.** The one seam is
  `tests/helpers/plugin.ts`. A test sees what the Host sees: JSON-RPC lines on
  stdout, diagnostics on stderr, the exit code, and the files the Plugin
  writes.
- `tests/page.test.ts` reads `web/` off disk, because no test drives a
  browser. Keep every path in the Page relative and every `byId` declared.
- A test name is a sentence about behaviour:
  `'a Job Due while the Plugin was down Runs once, however many Due times passed'`.

## Git workflow

- Branch `main`. The remote is GitHub: `luanAfons0/scheduler`, so use `gh`.
- A commit subject is one imperative sentence in the project's own words, with
  no prefix, no scope and no ticket number, the way FirstMate writes them:
  `Call one tool of another Plugin on a clock`.
- One commit is one whole, working change: code, tests and docs together.
- Never add attribution, co-author or "generated by" lines.

## Boundaries

✅ **Always**

- Read `CONTEXT.md` and the ADRs of the area first, and use their words.
- Keep tests black-box, through `tests/helpers/plugin.ts`.
- Update `README.md` when you change a field of a Job, a tool, an Outcome or
  an environment variable.
- Leave `npm test` and `npm run typecheck` green.

⚠️ **Ask first**

- Any `git add`, `git commit`, `git push`, or anything that opens a PR.
- Adding a dependency of any kind.
- Changing the shape of `jobs.json` or `state.json`, or the name, input or
  output of a tool.
- Anything that reverses an ADR.
- Anything that writes inside `~/.firstmate`, or restarts the Host.

🚫 **Never**

- Retry a Run, or Run a Job more than once for Due times missed while the Host
  was off. A missed Due time Runs once, Late, or is Skipped.
- Add cron, RRULE, or a subset of either. The fields are the grammar.
- Store the next Due time. It is derived on read.
- Call another Plugin except over the Tool Bus, under a Grant
  (FirstMate ADR-0009). This Plugin holds no port and no token.
- Move the clock out of the Plugin Server (ADR-0001).
- Print or commit a real `jobs.json`, `state.json`, FirstMate's token or
  `runtime.json`.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `luanAfons0/scheduler`, driven by the `gh`
CLI. See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).

### Triage labels

The five canonical triage roles, each label string equal to its name. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

### Domain docs

Single-context: one `CONTEXT.md` and one `docs/adr/` at the repo root. See
[`docs/agents/domain.md`](docs/agents/domain.md).
