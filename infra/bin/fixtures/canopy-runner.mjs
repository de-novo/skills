// Exercise the real Canopy entry point with only discovery substituted.
import { fileURLToPath } from 'node:url';
import { runCanopy } from '../../lib/canopy.mjs';
process.exitCode = await runCanopy(process.argv.slice(2), {
  projectsCli: fileURLToPath(new URL('./canopy-projects.mjs', import.meta.url)),
});
