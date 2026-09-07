// Exercise the real Canopy entry point with public CLI fixtures substituted.
import { fileURLToPath } from 'node:url';
import { runCanopy } from '../../lib/canopy.mjs';
process.exitCode = await runCanopy(process.argv.slice(2), {
  ...(process.env.CANOPY_TEST_SCREEN === '1' ? { cli: fileURLToPath(new URL('./canopy-projects.mjs', import.meta.url)) } : {}),
  projectsCli: fileURLToPath(new URL('./canopy-projects.mjs', import.meta.url)),
});
