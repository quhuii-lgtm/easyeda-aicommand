import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const built = await build({
	stdin: { contents: "export { planSesImport } from '../src/engine/autoRouteSes.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'ses-subtract-line-numeric-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
});
const { planSesImport } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const line = (a, b) => ({ net: 'N1', layer: 1, widthMil: 8, a: { x: a, y: 0 }, b: { x: b, y: 0 }, locked: false });
const plan = (expected, existing) => planSesImport({ lines: expected, vias: [], coordinateMapping: 'test', toleranceMil: 0.001, holeDiameterStatus: 'not-specified-by-ses' }, { documentUuid: 'numeric-board', lines: existing, vias: [] }, 'append');

const short = line(200, 200.000001);
const noCoverage = plan([short], []);
assert.equal(noCoverage.deltaLines.length, 1);
assert.equal(noCoverage.deltaLines[0], short, 'uncovered real short line is returned unchanged');

const extension = line(-0.0000001, 100);
const extensionPlan = plan([extension], [line(0, 100)]);
assert.equal(extensionPlan.deltaLines.length, 1);
assert.equal(extensionPlan.deltaLines[0].a.x, -0.0000001, 'meaningful 1e-7 mil extension survives endpoint snapping');
assert.equal(extensionPlan.deltaLines[0].b.x, 0);

const gapPlan = plan([line(0, 100)], [line(0, 49.99), line(50.01, 100)]);
assert.equal(gapPlan.deltaLines.length, 1);
assert.ok(Math.abs((gapPlan.deltaLines[0].b.x - gapPlan.deltaLines[0].a.x) - 0.02) < 1e-10, 'real 0.02 mil uncovered gap remains in the delta');

const repeat = plan([line(0, 100)], [line(0, 40), line(40, 100)]);
assert.equal(repeat.deltaLines.length, 0, 'a complete retained path is idempotent without tiny residual segments');
assert.equal(repeat.alreadyPresent, true);

console.log('ses-subtract-line-numeric-regression: PASS');
