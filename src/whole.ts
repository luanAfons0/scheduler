/**
 * A file written whole and moved into place, for the jobs file and the state
 * file alike.
 *
 * Each write goes through a file of its own beside the real one, and a rename
 * over the real one is one step, so whoever reads it sees one write or the one
 * before it and never half of either.
 *
 * On Windows a rename fails for a moment when something else holds the file
 * it replaces: an antivirus, the search indexer, an editor with it open. That
 * is not a mistake anybody made, so the move is tried again for about a
 * second before it is a sentence. This is a file being moved, not a Run being
 * retried: a Run still happens once, whatever it ended as.
 */
import { readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** The codes Windows gives a rename over a file that something else holds. */
const HELD = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** How many times a held rename is tried, each wait a little longer. */
const TRIES = 10;
const WAIT_MS = 20;

/** The end of a file a write goes through, before it is moved into place. */
const WRITING = /^\.\d+\.\d+\.writing$/;

let through = 0;

/**
 * Write the text whole beside the file, then move it into place.
 *
 * A write that fails leaves nothing behind: its own file is removed, and the
 * sentence names the file it was for.
 */
export async function writeWhole(file: string, text: string, mode?: number): Promise<void> {
  const path = resolve(file);
  // A file of this write's own, so that two writers never share a half-written
  // one and rename each other's work into place.
  const own = `${path}.${process.pid}.${(through += 1)}.writing`;
  try {
    await writeFile(own, text, mode === undefined ? {} : { mode });
    await move(own, path);
  } catch (fault) {
    await rm(own, { force: true }).catch(() => undefined);
    throw new Error(`The file at ${path} could not be written: ${sentence(fault)}`);
  }
}

/**
 * Remove what a Plugin Server that died halfway through a write left behind.
 *
 * Nothing else writes these files, and at start-up this one has not written
 * yet, so every one found is a leftover. One that cannot be removed now is
 * left for the next start: it is clutter, and not a reason to stay Stopped.
 */
export async function clearLeftovers(files: readonly string[]): Promise<void> {
  for (const file of files) {
    const path = resolve(file);
    const name = basename(path);
    let names: string[];
    try {
      names = await readdir(dirname(path));
    } catch {
      continue;
    }
    for (const one of names) {
      if (!one.startsWith(name) || !WRITING.test(one.slice(name.length))) continue;
      await rm(join(dirname(path), one), { force: true }).catch(() => undefined);
    }
  }
}

async function move(from: string, to: string): Promise<void> {
  for (let tried = 1; ; tried += 1) {
    try {
      await rename(from, to);
      return;
    } catch (fault) {
      const code = (fault as NodeJS.ErrnoException).code ?? '';
      if (tried >= TRIES || !HELD.has(code)) throw fault;
      await sleep(tried * WAIT_MS);
    }
  }
}

function sentence(fault: unknown): string {
  return fault instanceof Error ? fault.message : String(fault);
}
