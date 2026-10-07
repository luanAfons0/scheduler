/**
 * The entry point the Host runs: its own Node, given `mcp.ts`, in the Plugin
 * directory, with no shell (FirstMate ADR-0028). It works the same on every
 * system the App runs on, because it is a Node program and not a script for
 * one shell.
 *
 * It is a pointer and nothing else. The Plugin Server is `src/main.ts`, and the
 * `sh` wrapper `mcp` stays for a `wsl` Place, where the Host starts `./mcp`.
 */
import './src/main.ts';
