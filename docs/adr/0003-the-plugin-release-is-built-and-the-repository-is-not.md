# The Plugin Release is built, and the repository is not

`firstmate install scheduler` fetches a Plugin Release (FirstMate ADR-0033), so
the Scheduler ships one: `npm run release` bundles `mcp.ts` into one `mcp.js`
with `tsdown`, not minified, and writes it into `release/` with `web/` and an
`mcp` wrapper that runs `mcp.js`. The release holds no `mcp.ts` and no `src/`,
because the Host starts `mcp.ts` before `mcp.js` (FirstMate ADR-0028), and it
holds no `jobs.json` or `state.json`, so `update` never touches a Job or a Run.
The repository itself keeps its rule from ADR-0001: Node runs the TypeScript
with no build step. `tsdown` is a dev dependency and runs on the publish path
only; the Plugin still has no runtime dependency. A tag `vMAJOR.MINOR.PATCH`
calls FirstMate's `plugin-release.yml` with this repository's test and build.
