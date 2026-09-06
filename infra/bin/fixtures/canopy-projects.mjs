// Temporary public-CLI seam while dryad projects is developed independently.
// This fixture emits only the agreed shape; it never reads a registry.
if (process.argv.slice(2).join(' ') !== 'dryad projects --json') throw new Error('unexpected fixture command');
console.log(JSON.stringify({ projects: JSON.parse(process.env.CANOPY_TEST_PROJECTS ?? '[]') }));
