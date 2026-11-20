import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: { contents: "export { normalizePouredPathSource, normalizeMatchedSolidPouredPathSource, readEditorVersion } from '../src/pcb/pouredUnits.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'poured-units-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { normalizePouredPathSource, normalizeMatchedSolidPouredPathSource, readEditorVersion } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const firstRaw = [29.6, 10.4, 'L', 10.399999999999995, 10.4, 10.4, 19.6, 29.60000000000001, 19.6, 29.6, 10.4]
const secondRaw = [89.6, 10.399999999999999, 'L', 60.39999999999999, 10.4, 60.4, 24.6, 89.6, 24.6, 89.6, 10.399999999999999]
const normalize = (pathSource, options = {}) => normalizePouredPathSource(pathSource, { fill: true, lineWidth: 0, editorVersion: '4.1.78', ...options })
const first = normalize(firstRaw)
assert.equal(first.status, 'normalized')
assert.equal(first.coordinateUnit, 'mil')
assert.equal(first.normalization, 'eda-4.1.78-zero-width-fill-path-10mil-to-mil')
assert.equal(first.conversionFactor, 10)
assert.equal(firstRaw[0], 29.6, 'raw evidence remains unchanged')
assert.equal(first.normalizedPathMil[0], 296)
assert.equal(first.normalizedPathMil[2], 'L')
assert.ok(Math.abs(first.normalizedPathMil[3] - 103.99999999999994) < 1e-10)
const second = normalize(secondRaw)
assert.equal(second.normalizedPathMil[0], 896)
assert.equal(second.normalizedPathMil[3], 603.9999999999999)

const translatedOldExample = normalize([44.6, 35.4, 'L', 25.4, 35.4, 25.4, 44.6, 44.6, 44.6, 44.6, 35.4])
assert.deepEqual(translatedOldExample.normalizedPathMil.slice(0, 5), [446, 354, 'L', 254, 354])
const negative = normalize([-9.6, 10.4, 'L', -19.6, 10.4, -19.6, 19.6, -9.6, 19.6])
assert.deepEqual(negative.normalizedPathMil, [-96, 104, 'L', -196, 104, -196, 196, -96, 196])

const explicitlyMil = normalize([296, 104, 'L', 104, 104, 104, 196, 296, 196], { declaredCoordinateUnit: 'mil' })
assert.deepEqual(explicitlyMil.normalizedPathMil, [296, 104, 'L', 104, 104, 104, 196, 296, 196])
assert.equal(explicitlyMil.conversionFactor, 1, 'explicit mil input is never multiplied by ten')
assert.equal(normalize(firstRaw, { editorVersion: '4.2.0' }).status, 'unsupported', 'EDA 4.2 has no conversion evidence')
assert.equal(normalize(firstRaw, { editorVersion: null }).status, 'unsupported', 'unknown EDA versions are not guessed')
assert.equal(normalize(firstRaw, { lineWidth: 0.1 }).status, 'unsupported', 'nonzero stroke geometry is not claimed as supported')
assert.equal(normalize(firstRaw, { fill: false }).status, 'unsupported', 'unfilled regions are not normalized')
assert.equal(normalize([0, 0, 'L', 10, 0, 'C', 10, 10]).status, 'unsupported', 'arc path commands remain unsupported')
assert.equal(normalize([[0, 0, 'L', 10, 0, 10, 10], [1, 1, 'L', 2, 1, 2, 2]]).status, 'unsupported', 'unknown subpaths and holes remain unsupported')
assert.equal(readEditorVersion({ sys_Environment: { getEditorCurrentVersion: () => '4.1.78' } }), '4.1.78')
assert.equal(readEditorVersion({ sys_Environment: { getEditorCurrentVersion: () => { throw new Error('unavailable') } } }), null)

const matched8 = normalizeMatchedSolidPouredPathSource([[74.6, 50.4, 'L', 65.4, 50.4, 65.4, 59.6, 74.6, 59.6, 74.6, 50.4]], { sourceMatched: true, fill: true, lineWidth: 0, fineness: 8 })
assert.equal(matched8.status, 'normalized')
assert.equal(matched8.normalization, 'source-matched-solid-poured-raw-x10')
assert.equal(matched8.conversionFactor, 10)
assert.equal(matched8.copperMarginMil, 4)
assert.deepEqual(matched8.normalizedPathMil, [746, 504, 'L', 654, 504, 654, 596, 746, 596, 746, 504])
const matched0 = normalizeMatchedSolidPouredPathSource([15, 77, 'L', 35, 77, 35, 65, 15, 65, 15, 77], { sourceMatched: true, fill: true, lineWidth: 0, fineness: 0 })
assert.equal(matched0.status, 'normalized', 'zero fineness is valid')
assert.equal(matched0.copperMarginMil, 0)
assert.deepEqual(matched0.normalizedPathMil, [150, 770, 'L', 350, 770, 350, 650, 150, 650, 150, 770])
for (const options of [
	{ sourceMatched: false, fill: true, lineWidth: 0, fineness: 8 },
	{ sourceMatched: true, fill: false, lineWidth: 0, fineness: 8 },
	{ sourceMatched: true, fill: true, lineWidth: 0.1, fineness: 8 },
	{ sourceMatched: true, fill: true, lineWidth: 0, fineness: -1 },
	{ sourceMatched: true, fill: true, lineWidth: 0, fineness: Number.NaN },
])
	assert.equal(normalizeMatchedSolidPouredPathSource(matched8.normalizedPathMil, options).status, 'unsupported')
for (const path of [
	[0, 0, 'L', 10, 0, 10, 10, 0, 10], // open
	[0, 0, 'L', 10, 0, 'ARC', 10, 10, 0, 0], // curve
	[0, 0, 'L', 10, 10, 0, 10, 10, 0, 0, 0], // self-crossing
	[[0, 0, 'L', 10, 0], [1, 1, 'L', 2, 1]], // multiple rings / holes
])
	assert.equal(normalizeMatchedSolidPouredPathSource(path, { sourceMatched: true, fill: true, lineWidth: 0, fineness: 8 }).status, 'unsupported')

console.log('PASS legacy pour normalization remains unchanged and source-matched SOLID POURED paths use calibrated x10 geometry plus fineness/2 edge margin')
