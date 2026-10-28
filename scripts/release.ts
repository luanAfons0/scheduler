/**
 * The release build: write the files of a Plugin Release into a folder
 * (FirstMate ADR-0033, ADR-0003).
 *
 *   node scripts/release.ts [out]      out defaults to release/
 *
 * `install` fetches this folder as an archive and lands it in the Shelf, so it
 * holds what the Host needs to run the Plugin and nothing else:
 *
 * - `mcp.js`, `mcp.ts` bundled into one file. Not minified, so that a stack
 *   trace in the journal still reads like the source.
 * - `web/`, the Plugin Page, as it is.
 * - `mcp`, the `sh` wrapper of a `wsl` Place, pointed at `mcp.js`.
 *
 * It holds no `mcp.ts` and no `src/`, because the Host starts `mcp.ts` before
 * `mcp.js` (FirstMate ADR-0028), and an archive with both would run the
 * source. It holds no `jobs.json` or `state.json` either: those are this
 * machine's data, and `update` replaces only the files a Plugin Release ships.
 *
 * The repository itself has no build step and still runs from source. This
 * script runs on the publish path alone, from `npm run release`.
 */
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsdown';

const REPOSITORY = dirname(dirname(fileURLToPath(import.meta.url)));

/** The line of the source wrapper that starts the Plugin Server. */
const SOURCE_START = 'exec "$node" "$here/src/main.ts"';

/** The sentence of the source wrapper that explains why a Node 24 is needed. */
const SOURCE_REASON = 'this Plugin is TypeScript that Node runs with no build step';

/**
 * The wrapper of the release: the `mcp` of the repository, which looks for a
 * Node 24 (and honours SCHEDULER_NODE), told to run `mcp.js`. It is derived
 * rather than copied by hand, so there is one place that knows how to find a
 * Node. A line that is not found fails the build, never ships a wrapper that
 * still points at `src/`.
 */
async function releaseWrapper(): Promise<string> {
  const source = await readFile(join(REPOSITORY, 'mcp'), 'utf8');
  for (const part of [SOURCE_START, SOURCE_REASON]) {
    if (!source.includes(part)) {
      throw new Error(`The wrapper mcp no longer holds \`${part}\`; update scripts/release.ts.`);
    }
  }
  return source
    .replace(SOURCE_START, 'exec "$node" "$here/mcp.js"')
    .replace(SOURCE_REASON, 'this Plugin is a bundled program that needs Node 24');
}

/** Build the Plugin Release into `out`, emptied first so that nothing old ships. */
async function release(out: string): Promise<void> {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await build({
    config: false,
    cwd: REPOSITORY,
    entry: { mcp: 'mcp.ts' },
    format: 'esm',
    platform: 'node',
    outDir: out,
    // The Plugin is "type": "module", so .js is already ESM.
    fixedExtension: false,
    clean: false,
    dts: false,
    minify: false,
    sourcemap: false,
    logLevel: 'warn',
  });

  await cp(join(REPOSITORY, 'web'), join(out, 'web'), { recursive: true });
  await writeFile(join(out, 'mcp'), await releaseWrapper());
  await chmod(join(out, 'mcp'), 0o755);
}

try {
  await release(resolve(process.argv[2] ?? join(REPOSITORY, 'release')));
} catch (fault) {
  process.stderr.write(`${fault instanceof Error ? fault.message : String(fault)}\n`);
  process.exitCode = 1;
}
