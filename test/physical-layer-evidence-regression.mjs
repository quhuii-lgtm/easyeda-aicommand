import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: { contents: "import { parseSourceLog } from '../src/pcb/sourcelog.ts'; import { buildPhysicalLayerEvidence } from '../src/engine/physicalLayerEvidence.ts'; export { parseSourceLog, buildPhysicalLayerEvidence }", resolveDir: resolve(root, 'test'), sourcefile: 'physical-layer-evidence-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { parseSourceLog, buildPhysicalLayerEvidence } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const row = (type, id, ticket, data) => `${JSON.stringify({ type, id, ticket })}||${data === '' ? '' : JSON.stringify(data)}|`
const physId = id => JSON.stringify(['LAYER_PHYS', id])
const layerId = id => JSON.stringify(['LAYER', id])
function run(rows, layers, editorVersion = '4.1.78') {
	const doc = parseSourceLog([row('DOCHEAD', undefined, undefined, { docType: 'PCB', uuid: 'doc-1' }), ...rows].join('\n'))
	return buildPhysicalLayerEvidence({ document: doc, layers, editorVersion })
}
function runWithDirectThickness(thickness) {
	const doc = parseSourceLog([row('DOCHEAD', undefined, undefined, { docType: 'PCB', uuid: 'doc-1' }), row('LAYER_PHYS', physId(99), 1, { thickness: 1, zIndex: 1 })].join('\n'))
	doc.records.find(record => record.header.type === 'LAYER_PHYS').data.thickness = thickness
	return buildPhysicalLayerEvidence({ document: doc, layers: [], editorVersion: '4.1.78' }).effectiveRecords[0]
}
function sourceLayer(id, overrides = {}) { return { layerId: id, layerType: id >= 361 ? 'SUBSTRATE' : 'SIGNAL', layerName: `Layer-${id}`, use: id >= 361 ? false : true, ...overrides } }
function sdkLayer(id, overrides = {}) { return { id, layerId: id, type: id >= 361 ? 'SUBSTRATE' : 'SIGNAL', layerName: `Layer-${id}`, status: id >= 361 ? 0 : 1, ...overrides } }

const currentRows = [
	row('LAYER', layerId(15), 20, sourceLayer(15)),
	row('LAYER_PHYS', physId(15), 1, { thickness: 9.5, material: 'old', zIndex: 8 }),
	row('LAYER_PHYS', physId(15), 10, { thickness: 59.449, material: 'FR4', permittivity: 4.5, lossTangent: 0, zIndex: 1001 }),
]
const current = run(currentRows, [sdkLayer(15)])
assert.equal(current.effectiveRecords.length, 1)
assert.equal(current.effectiveRecords[0].ticket, 10)
assert.equal(current.effectiveRecords[0].thicknessRaw, 59.449)
assert.equal(current.effectiveRecords[0].thicknessMm, 59.449 * 0.0254)
assert.equal(current.effectiveRecords[0].thicknessValueStatus, 'valid-nonnegative')
assert.equal(current.effectiveRecords[0].material, 'FR4')
assert.equal(current.effectiveRecords[0].thicknessUnitStatus, 'observed-mil-eda-4.1.78')
assert.equal(current.thicknessUnitStatus, 'observed-mil-eda-4.1.78')
assert.match(current.unitEvidence, /原生 UI、源码及保存重开观察/)
assert.deepEqual(current.effectiveRecords[0].rawSourceIdentities.map(item => item.ticket), [10])
assert.equal(current.effectiveRecords[0].identityStatus, 'matched')

const tombstoned = run([
	row('LAYER_PHYS', physId(7), 4, { thickness: 1, zIndex: 1 }),
	row('LAYER_PHYS', physId(7), 5, ''),
], [])
assert.deepEqual(tombstoned.effectiveRecords, [], 'highest-ticket tombstone removes an earlier physical layer')
assert.deepEqual(tombstoned.tombstonedIdentities, [7])
assert.deepEqual(tombstoned.rawSourceIdentities.map(item => item.ticket), [4, 5])

for (const [index, thickness] of [null, '1.2', -1, Number.NaN, Number.POSITIVE_INFINITY, undefined].entries()) {
	const record = run([row('LAYER_PHYS', physId(20 + index), 1, { thickness, zIndex: index })], []).effectiveRecords[0]
	assert.equal(record.thicknessValueStatus, 'invalid')
	assert.equal(Object.hasOwn(record, 'thicknessMm'), false, 'invalid raw values remain unconverted')
	assert.equal(record.thicknessRaw, typeof thickness === 'number' && !Number.isFinite(thickness) ? null : thickness)
}
const zeroThickness = run([row('LAYER_PHYS', physId(30), 1, { thickness: 0, zIndex: 1 })], []).effectiveRecords[0]
assert.equal(zeroThickness.thicknessValueStatus, 'valid-nonnegative')
assert.equal(zeroThickness.thicknessMm, 0)
for (const thickness of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
	const record = runWithDirectThickness(thickness)
	assert.equal(record.thicknessRaw, thickness, 'direct non-finite number survives test construction')
	assert.equal(record.thicknessValueStatus, 'invalid')
	assert.equal(Object.hasOwn(record, 'thicknessMm'), false)
}
for (const [id, mil, expectedMm] of [[31, 47.244, 1.1999976], [32, 2.756, 0.0700024]]) {
	const record = run([row('LAYER_PHYS', physId(id), 1, { thickness: mil, zIndex: id })], []).effectiveRecords[0]
	assert.equal(record.thicknessRaw, mil)
	assert.ok(Math.abs(record.thicknessMm - expectedMm) < 1e-12, `${mil} mil converts to ${expectedMm} mm`)
}
for (const editorVersion of ['', '4.1.77', '4.1.79']) {
	const record = run([row('LAYER_PHYS', physId(40), 1, { thickness: 47.244, zIndex: 1 })], [], editorVersion).effectiveRecords[0]
	assert.equal(record.thicknessUnitStatus, 'unknown', `editor ${JSON.stringify(editorVersion)} has no unit conversion evidence`)
	assert.equal(Object.hasOwn(record, 'thicknessMm'), false)
}
const emptyThickness = run([row('LAYER_PHYS', physId(41), 1, { thickness: '', zIndex: 1 })], []).effectiveRecords[0]
assert.equal(emptyThickness.thicknessRaw, '')
assert.equal(emptyThickness.thicknessValueStatus, 'invalid')
assert.equal(Object.hasOwn(emptyThickness, 'thicknessMm'), false)

const conflict = run([
	row('LAYER_PHYS', physId(8), 6, { thickness: 1, zIndex: 1 }),
	row('LAYER_PHYS', physId(8), 6, { thickness: 2, zIndex: 2 }),
], [])
assert.equal(conflict.effectiveRecords.length, 0, 'different same-highest-ticket records are not selected by source order')
assert.deepEqual(conflict.conflicts, ['LAYER_PHYS:8'])
assert.ok(conflict.unknowns.some(item => item.includes('最高ticket 6 存在不同内容冲突')))

const invalidId = run([row('LAYER_PHYS', '["LAYER_PHYS",0]', 1, { thickness: 1, zIndex: 1 })], [])
assert.equal(invalidId.effectiveRecords.length, 0)
assert.ok(invalidId.unknowns.some(item => item.includes('身份无效')))
const invalidData = run([row('LAYER_PHYS', physId(9), 1, 'unexpected scalar')], [])
assert.equal(invalidData.effectiveRecords.length, 0)
assert.ok(invalidData.unknowns.some(item => item.includes('生效记录结构无效')))

const duplicateZ = run([
	row('LAYER', layerId(15), 1, sourceLayer(15)),
	row('LAYER', layerId(361), 2, sourceLayer(361)),
	row('LAYER_PHYS', physId(361), 3, { thickness: 59.449, material: 'FR4', zIndex: 1001 }),
	row('LAYER_PHYS', physId(15), 4, { thickness: 1.379, material: null, zIndex: 1001 }),
], [sdkLayer(15), sdkLayer(361)])
assert.equal(duplicateZ.orderingStatus, 'unknown')
assert.equal(Object.hasOwn(duplicateZ, 'orderedLayers'), false, 'duplicate zIndex cannot produce a pseudo-ordered stack')
assert.deepEqual(duplicateZ.zIndexGroups.find(group => group.zIndex === 1001), { zIndex: 1001, layerIds: [15, 361], conflict: true })
assert.ok(duplicateZ.unknowns.some(item => item.includes('zIndex 1001 冲突')))
assert.equal(duplicateZ.effectiveRecords.find(layer => layer.layerId === 361).sourceLayer.layerType, 'SUBSTRATE')
assert.equal(duplicateZ.effectiveRecords.find(layer => layer.layerId === 361).sourceLayer.use, false, 'SUBSTRATE use:false is retained as source UI state, not treated as absence')
assert.equal(duplicateZ.effectiveRecords.find(layer => layer.layerId === 361).sdkLayer.status, 0, 'SDK status is preserved separately from physical material presence')

const reopenedOrder = run([1, 361, 15, 362, 16, 363, 2].map((id, index) => row('LAYER_PHYS', physId(id), index + 1, { thickness: index + 1, zIndex: index + 1 })), [])
assert.deepEqual(reopenedOrder.orderedLayers.map(layer => layer.layerId), [1, 361, 15, 362, 16, 363, 2])

const identityMismatch = run([
	row('LAYER', layerId(45), 1, sourceLayer(46)),
	row('LAYER_PHYS', physId(45), 2, { thickness: 0.465, zIndex: 20 }),
], [sdkLayer(45)])
assert.equal(identityMismatch.effectiveRecords[0].identityStatus, 'source-sdk-mismatch')
assert.ok(identityMismatch.unknowns.some(item => item.includes('LAYER_PHYS 45 与生效LAYER数据身份不一致')))
const sdkIdentityMismatch = run([
	row('LAYER', layerId(52), 1, sourceLayer(52)),
	row('LAYER_PHYS', physId(52), 2, { thickness: 0.2, zIndex: 30 }),
], [{ ...sdkLayer(52), id: 52, layerId: 53 }])
assert.equal(sdkIdentityMismatch.effectiveRecords[0].identityStatus, 'source-sdk-mismatch')
assert.ok(sdkIdentityMismatch.unknowns.some(item => item.includes('id/layerId身份冲突')))

const uniquelyOrdered = run([
	row('LAYER', layerId(1), 1, sourceLayer(1)),
	row('LAYER_PHYS', physId(2), 3, { thickness: 0, zIndex: 20 }),
	row('LAYER_PHYS', physId(1), 2, { thickness: 0.035, zIndex: 10 }),
], [sdkLayer(1), sdkLayer(2)], '5.0')
assert.equal(uniquelyOrdered.orderingStatus, 'known-from-unique-source-zIndex')
assert.deepEqual(uniquelyOrdered.orderedLayers.map(layer => layer.layerId), [1, 2], 'unique numeric source zIndex, not raw source line order or layer ID, controls ordering')
assert.equal(uniquelyOrdered.thicknessUnitStatus, 'unknown', 'unsupported editor version does not infer a thickness unit')
assert.equal(uniquelyOrdered.effectiveRecords.find(layer => layer.layerId === 1).thicknessRaw, 0.035)
assert.equal(Object.hasOwn(uniquelyOrdered.effectiveRecords[0], 'thicknessMm'), false)

console.log('physical-layer-evidence regression: PASS')
