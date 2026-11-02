// Headless runner for the same suite tests.html runs: `node src/run-tests-node.js`
import { runAll } from './tests.js';

const results = await runAll();
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  [${r.group}] ${r.name}${r.pass ? '' : `\n      → ${r.error}`}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
