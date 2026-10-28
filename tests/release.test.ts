/**
 * The Plugin Release is the Plugin built for `install`: `mcp.js`, the Page and
 * the `sh` wrapper, with none of the source (FirstMate ADR-0033, ADR-0003).
 *
 * The build runs once, into a temporary folder, by the same command the
 * release workflow runs. Each test then starts the built Plugin Server in a
 * copy of that folder, with the Host's own Node and no shell, the way a Plugin
 * Release lands in the Shelf.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strict as assert } from 'node:assert';
import test, { before, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startPluginServer } from './helpers/plugin.ts';

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));
let work: string;
let release: string;

before(() => {
  // Built outside the repository so that no test depends on, or clobbers, a
  // `release/` somebody built by hand.
  return mkdtemp(join(tmpdir(), 'scheduler-release-')).then((folder) => {
    work = folder;
    release = join(folder, 'release');
    execFileSync(process.execPath, [join(REPOSITORY, 'scripts', 'release.ts'), release], {
      cwd: REPOSITORY,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
});

after(() => rm(work, { recursive: true, force: true }));

test('the release build writes mcp.js, the Page and the wrapper, and nothing else', async () => {
  assert.deepEqual((await readdir(release)).sort(), ['mcp', 'mcp.js', 'web']);
  assert.deepEqual((await readdir(join(release, 'web'))).sort(), ['app.css', 'app.js', 'index.html']);
});

test('the Page in the release is the Page in the source, byte for byte', async () => {
  for (const name of await readdir(join(REPOSITORY, 'web'))) {
    assert.deepEqual(
      await readFile(join(release, 'web', name)),
      await readFile(join(REPOSITORY, 'web', name)),
    );
  }
});

test('the release holds no mcp.ts and no src, because the Host starts mcp.ts first', async () => {
  const names = await readdir(release);
  assert.ok(!names.includes('mcp.ts'), 'mcp.ts is in the release');
  assert.ok(!names.includes('src'), 'src/ is in the release');
});

test('mcp.js is not minified, so that a stack trace stays readable', async () => {
  const code = await readFile(join(release, 'mcp.js'), 'utf8');
  assert.ok(code.split('\n').length > 200, 'mcp.js is a handful of lines');
});

test('release/mcp.js answers initialize and tools/list as mcp.ts does', async (t) => {
  const built = await startPluginServer(t, { release });
  const source = await startPluginServer(t);

  const builtHandshake = await built.handshake();
  const sourceHandshake = await source.handshake();
  const builtTools = await built.ask('tools/list');
  const sourceTools = await source.ask('tools/list');

  assert.equal(builtHandshake.error, undefined, built.output());
  assert.deepEqual(builtHandshake, sourceHandshake);
  assert.deepEqual(builtTools, sourceTools);
  assert.equal(built.output(), '');
});

// The `sh` wrapper is what a `wsl` Place runs. Windows has no `sh` to run it.
test(
  'the release wrapper `mcp` finds a Node 24 through SCHEDULER_NODE and runs mcp.js',
  {
    skip: process.platform === 'win32' && 'the wrapper is `sh`, and a `wsl` Place runs it in Linux',
  },
  async (t) => {
    const bin = await mkdtemp(join(tmpdir(), 'scheduler-bin-'));
    t.after(() => rm(bin, { recursive: true, force: true }));
    const dirnamePath = execFileSync('which', ['dirname'], { encoding: 'utf8' }).trim();
    await symlink(dirnamePath, join(bin, 'dirname'));
    const plugin = await startPluginServer(t, {
      release,
      wrapper: true,
      env: { PATH: bin, HOME: bin, SCHEDULER_NODE: process.execPath },
    });

    const answer = await plugin.handshake();

    assert.equal(answer.error, undefined, plugin.output());
    assert.equal((answer.result as { serverInfo: { name: string } }).serverInfo.name, 'scheduler');
  },
);

test(
  'the release wrapper can be run: it has the executable bit',
  { skip: process.platform === 'win32' && 'Windows has no executable bit' },
  async () => {
    assert.ok(((await stat(join(release, 'mcp'))).mode & 0o111) !== 0);
  },
);
