# Security

## What is at stake

The Scheduler runs as you, inside FirstMate, and calls another Plugin's tool
with arguments from a file, at a time nobody is watching. Anything that can
add a Job, change one, or change what a Job calls can make another Plugin act
on your behalf. That is the interesting part of this project's attack surface.

It writes two files, `jobs.json` and `state.json`, in its own Plugin
directory, and reaches other Plugins only over FirstMate's Tool Bus, under a
Grant.

Bugs worth reporting privately:

- A way to add, change or remove a Job without going through its tools or the
  jobs file: from another Plugin's Page, from another origin, or from a
  request that FirstMate should have refused.
- A Job that reaches a Plugin it holds no Grant for, or that reaches a Plugin
  by any path other than the Tool Bus.
- A Job name, a Plugin name, a tool name or an argument that is evaluated as
  code, or that makes the Plugin read or write outside its own directory.
- A Run that happens when it should not: more than once for missed Due times,
  past its Grace, or for a Job that is off.
- A Run's sentence, or a Job's arguments, drawn into the Plugin Page as
  markup rather than as text.

## Supported versions

`main` only. The Scheduler is installed from its git URL, so the fix for any
problem is the next commit on `main`.

## How to report

Use GitHub's private vulnerability reporting: open the
[Security tab](https://github.com/luanAfons0/scheduler/security/advisories) of
`luanAfons0/scheduler` and choose **Report a vulnerability**. That opens a
private advisory that only the maintainers can read.

Do not open a public issue for a security problem.

Please include the Job, the steps, and what an attacker gets out of it. A
patch is welcome but not expected. This is a one-maintainer project with no
service behind it and no bounty: you get an answer as soon as the maintainer
reads the advisory, and a fix on `main` once the report is confirmed.

## Out of scope

- A tool you scheduled doing something you did not want. The Scheduler calls
  the tool you named; it does not review what that tool does.
- Anything in FirstMate itself: the Host, its checks, its token or its Tool
  Bus. Report those to
  [FirstMate](https://github.com/luanAfons0/FirstMate/blob/main/SECURITY.md).
- Anything that needs an attacker who can already run commands as you, or
  write your `jobs.json`. At that point your Jobs are theirs anyway.
