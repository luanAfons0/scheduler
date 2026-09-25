/**
 * The Plugin Page, as the bytes a browser is served.
 *
 * The Host returns a Plugin's `web/` directory unchanged (FirstMate ADR-0008),
 * so what this test reads off disk is exactly what a browser gets. It asserts
 * the two things the Host will not check for you and that break a Page after
 * it is registered: a path that is not relative, and an asset that is not
 * there.
 */
import { strict as assert } from 'node:assert';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
const WEB = join(REPOSITORY, 'web');

/** Every `href` and `src` the page names, in the order it names them. */
function pathsIn(html: string): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]*)"/g)].map((found) => found[1] ?? '');
}

test('the Plugin Page is one page, served as index.html', async (t) => {
  const page = await stat(join(WEB, 'index.html'));

  assert.ok(page.isFile());
});

test('every path in the Page is relative, so nothing assumes an address it does not own', async (t) => {
  const html = await readFile(join(WEB, 'index.html'), 'utf8');

  for (const path of pathsIn(html)) {
    if (path.startsWith('data:')) continue;
    assert.ok(!path.startsWith('/'), `${path} assumes it is served from the root`);
    assert.ok(!path.startsWith('//'), `${path} assumes a host`);
    assert.ok(!/^[a-z]+:/i.test(path), `${path} reaches outside the Plugin`);
  }
});

test('every asset the Page names is beside it in web/, because there is no build step', async (t) => {
  const html = await readFile(join(WEB, 'index.html'), 'utf8');

  for (const path of pathsIn(html)) {
    if (path.startsWith('data:') || path.startsWith('#')) continue;
    const asset = await stat(join(WEB, path));
    assert.ok(asset.isFile(), `${path} is named by the Page and is not in web/`);
  }
});

test('every element the script reaches for is one the markup declares', async (t) => {
  // The Page is the one part of this Plugin no test can drive, so this is the
  // mistake worth catching without a browser: a renamed id leaves the script
  // reading null and the Page blank, and nothing else would say so.
  const html = await readFile(join(WEB, 'index.html'), 'utf8');
  const script = await readFile(join(WEB, 'app.js'), 'utf8');

  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((found) => found[1]));
  const wanted = new Set([...script.matchAll(/byId\('([^']+)'\)/g)].map((found) => found[1]));

  assert.ok(wanted.size > 0, 'the script asks for no element at all, which cannot be right');
  for (const id of wanted) {
    assert.ok(declared.has(id), `the script reads "${id}", which is not in the page`);
  }
});

test('the Page claims nothing about Jobs before it has asked', async (t) => {
  const html = await readFile(join(WEB, 'index.html'), 'utf8');

  assert.ok(
    !/no Jobs/i.test(html),
    'the served markup already says there are no Jobs, which it cannot know until it has called list_jobs',
  );
});

test('every Job card offers a Change, and a change goes through change_job', async (t) => {
  // No test drives a browser, so this reads the script the browser is served:
  // the card draws the control, and the form sends what change_job takes.
  const script = await readFile(join(WEB, 'app.js'), 'utf8');

  assert.ok(script.includes("button('Change'"), 'no Job card offers a Change');
  assert.ok(script.includes("call('change_job'"), 'the form never calls change_job');
});
