# A Job changes in place, under its name

The README once said a Job could not be changed in place: remove it and add it,
or edit the file. No reason was written down, and moving a Job from 13:00 to
15:00 meant editing `jobs.json` by hand. We let the Plugin Page change a Job,
through a `change_job` tool that takes the whole Job, as `add_job` does, and
passes it through the same check, so both refuse the same bad Job in the same
sentences.

A change keeps the Job Name. The name is the key to a Job's state and its Run
history, so a rename would have to carry both across or lose them; a Job with
another name is another Job, and is removed and added. A change keeps
`enabled` from the file too, so `enable_job` stays the one way to turn a Job
on or off, and a change never wakes a Job somebody turned off.

A change never makes a Run. Like a Job just added, a changed Job takes its next
Due time from now. A Run that is going when the change lands finishes as it
was.

## Consequences

A hand edit of `jobs.json` does not behave the same way. The file is re-read
on every tick and nothing is freshened, so moving a 15:00 Job to 13:00 by hand
at 14:00 makes it Due at once, and its Grace decides whether it Runs Late or is
Skipped. From the Page, the same change waits until 13:00 tomorrow. The file
stays the truth; the Page is the careful way to write it.
