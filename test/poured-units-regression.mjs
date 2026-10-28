import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: { contents: "export { normalizePouredPathSource, readEditorVersion } from '../src/pcb/pouredUnits.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'poured-units-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { normalizePouredPathSource, readEditorVersion } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

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
console.log('PASS poured path units preserve raw input and narrowly normalize confirmed EDA 4.1.78 zero-width line polygons')
