import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "export { parseSourceLine, parseSourceLog, extractFootprintGeometry, transformFootprintBBox } from '../src/pcb/sourcelog.ts'",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'sourcelog-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { parseSourceLine, parseSourceLog, extractFootprintGeometry, transformFootprintBBox } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const fixture = readFileSync(resolve(root, 'test/fixtures/ac-a16-explicit-project-footprint-source.sourcelog'), 'utf8')
const document = parseSourceLog(fixture)
assert.equal(document.docType, 'FOOTPRINT')
assert.equal(document.uuid, 'b11cd6ee16e22f94')
assert.equal(document.records.length, 143)
const emptyLayers = document.records.filter(record => record.header.type === 'LAYER' && record.data === '')
assert.equal(emptyLayers.length, 97, 'valid project footprint source uses empty data for layer deletion records')
assert.ok(emptyLayers.every(record => record.header.id?.startsWith('["LAYER",')))
assert.doesNotThrow(() => extractFootprintGeometry(fixture))

const eccentric = { minX: 10, minY: 20, maxX: 30, maxY: 60 }
const closeBBox = (actual, expected, label) => {
	for (const edge of ['minX', 'minY', 'maxX', 'maxY'])
		assert.ok(Math.abs(actual[edge] - expected[edge]) < 1e-9, `${label} ${edge}: expected ${expected[edge]}, got ${actual[edge]}`)
}
closeBBox(transformFootprintBBox(eccentric, 100, 200, 0, false), { minX: 110, minY: 220, maxX: 130, maxY: 260 }, 'top 0°')
closeBBox(transformFootprintBBox(eccentric, 100, 200, 90, false), { minX: 40, minY: 210, maxX: 80, maxY: 230 }, 'top 90°')
closeBBox(transformFootprintBBox(eccentric, 100, 200, 37, false), { minX: 71.87745371135003, minY: 221.99086043246635, maxX: 111.92276483837782, maxY: 265.972581297399 }, 'top 37°')
closeBBox(transformFootprintBBox(eccentric, 100, 200, 0, true), { minX: 110, minY: 140, maxX: 130, maxY: 180 }, 'bottom 0°')
closeBBox(transformFootprintBBox(eccentric, 100, 200, 90, true), { minX: 120, minY: 210, maxX: 160, maxY: 230 }, 'bottom 90°')
closeBBox(transformFootprintBBox(eccentric, 100, 200, 37, true), { minX: 120.0226555635139, minY: 158.1000196286829, maxX: 160.06796669054168, maxY: 202.08174049361557 }, 'bottom 37°')

const emptyRecord = parseSourceLine('{"type":"LAYER","ticket":16,"id":"[\\"LAYER\\",15]"}|||', 7)
assert.equal(emptyRecord?.data, '')
assert.equal(emptyRecord?.line, 7)
assert.equal(parseSourceLine('  \t', 8), null)
assert.throws(() => parseSourceLine('{"type":"LAYER"}||', 10), /缺少末尾 \| 分隔符/)
assert.equal(parseSourceLine('{"type":"LAYER"}|||', 11)?.data, '', 'a complete triple-pipe tombstone is a valid empty-data record')
assert.throws(() => parseSourceLine('{"type":"LAYER"}||{broken}|', 12), /JSON|Unexpected/)
assert.throws(() => parseSourceLine('{"type":"LAYER"}{broken}', 13), /缺少 \|\| 分隔符/)
assert.deepEqual(parseSourceLine('{"type":"META"}||{"title":"valid final record"}', 14)?.data, { title: 'valid final record' }, 'the final non-empty JSON record may omit the inter-record trailing pipe')

console.log('PASS source log parsing and footprint bbox transforms preserve all four edges across top/bottom 0°, 90° and 37° poses')
