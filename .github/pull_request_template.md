<!--
Thank you. Keep this short: one whole, working change is easier to read than a
long description of a partial one. Delete any line that does not apply.
-->

## What this changes

<!-- One or two sentences, in the project's own words. See CONTEXT.md. -->

Closes #

## Why

<!-- The problem it solves, from the side of the person who owns the Jobs. -->

## Decisions it touches

<!--
Name the ADR that covers the area you changed (docs/adr/, or FirstMate's). If
this change contradicts one, say so here and say why it is worth reopening. An
ADR that is quietly overridden is worse than one that is argued with.
-->

## Checks

- [ ] `npm test` and `npm run typecheck` both pass locally.
- [ ] New behaviour has a test in `tests/`, driven through
      `tests/helpers/plugin.ts` and not by importing a module of `src/`.
- [ ] A change to `web/` was tried by hand in a running FirstMate, against a
      jobs file that is not my real one.
- [ ] `README.md` is updated, if a field of a Job, a tool, an Outcome or an
      environment variable changed.
- [ ] No new dependency, no retry, no cron or RRULE, and nothing that calls
      another Plugin except over the Tool Bus under a Grant.
