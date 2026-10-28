import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({ stdin: { contents: "import { extractFootprintPadMaskCandidates } from '../src/engine/footprintSilkscreen.ts'; export { extractFootprintPadMaskCandidates }", resolveDir: resolve(root, 'test'), sourcefile: 'silkscreen-mask-null-resolution-entry.ts' }, bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24' })
const { extractFootprintPadMaskCandidates } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

function fixture({ localLayer = 1, componentLayer = 1, top = 3, bottom = 7, getterState } = {}) {
	const componentId = 'component-1'
	const footprintUuid = 'footprint-1'
	const x = 100; const y = 200; const width = 32
	const padData = { num: '1', layerId: localLayer, hole: null, defaultPad: { padType: 'ELLIPSE', width, height: width, radius: 0 }, specialPad: [], padType: 'NORMAL', topSolderExpansion: top, bottomSolderExpansion: bottom, padLen: 0 }
	const doc = [
		{ type: 'DOCHEAD', id: 'doc', ticket: 0, data: { docType: 'FOOTPRINT', uuid: footprintUuid } },
		{ type: 'PAD', id: 'pad-local', ticket: 1, data: padData },
	].map(({ type, id, ticket, data }) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`).join('\n')
	const component = { getState_PrimitiveId: () => componentId }
	const pcbRecords = [
		{ header: { type: 'COMPONENT', id: componentId, ticket: 1 }, data: { layerId: componentLayer, x, y, angle: 0 } },
		{ header: { type: 'ATTR', id: 'fp', ticket: 1 }, data: { key: 'Footprint', parentId: componentId, value: footprintUuid } },
	]
	const localId = 'pad-local'
	const netId = JSON.stringify(['PAD_NET', componentId, '1', localId])
	pcbRecords.push({ header: { type: 'PAD_NET', id: netId, ticket: 1 }, data: { padNet: '', padLen: null, attrsMap: {} } })
	const runtimeLayer = localLayer === 1 ? componentLayer : 3 - componentLayer
	const center = [x + 25, y - 15]
	const padSnapshot = { id: 'runtime-pad-1', componentId, padNumber: '1', layer: runtimeLayer, rotation: 0, shape: 'ELLIPSE', box: { minX: center[0] - width / 2, minY: center[1] - width / 2, maxX: center[0] + width / 2, maxY: center[1] + width / 2 }, ...(getterState !== undefined ? { maskExpansionState: getterState } : {}) }
	const result = extractFootprintPadMaskCandidates({ pcbRecords, components: [component], footprintSources: [{ footprintUuid, documentSource: doc }], projectLibrarySources: [], padSnapshots: [padSnapshot], sourceStable: true })
	return result
}

assert.equal(fixture({ top: 0, bottom: 7 }).candidates[0].sourcePad.solderExpansionMil, 0, 'explicit source zero is retained')
assert.equal(fixture({ top: -2, bottom: 7 }).candidates[0].sourcePad.solderExpansionMil, -2, 'explicit negative source value is retained')

for (const { localLayer, componentLayer, physicalSide } of [
	{ localLayer: 1, componentLayer: 1, physicalSide: 'top' },
	{ localLayer: 1, componentLayer: 2, physicalSide: 'bottom' },
	{ localLayer: 2, componentLayer: 1, physicalSide: 'bottom' },
	{ localLayer: 2, componentLayer: 2, physicalSide: 'top' },
]) {
	const result = fixture({ localLayer, componentLayer, top: localLayer === 1 ? null : 3, bottom: localLayer === 2 ? null : 7, getterState: { status: 'value', value: { topSolderMask: 5, bottomSolderMask: 9 } } })
	assert.equal(result.candidates.length, 1, 'null source resolves from the matching physical getter side')
	const model = result.candidates[0].sourcePad
	assert.equal(model.sourceTopSolderExpansion, localLayer === 1 ? null : 3)
	assert.equal(model.sourceBottomSolderExpansion, localLayer === 2 ? null : 7)
	assert.equal(model.solderExpansionMil, physicalSide === 'top' ? 5 : 9)
	assert.deepEqual(model.expansionResolution, { resolution: 'runtime-effective', sourceValue: null, runtimePadId: 'runtime-pad-1', physicalSide, runtimeField: `${physicalSide}SolderMask`, runtimeValue: physicalSide === 'top' ? 5 : 9 })
}

assert.equal(fixture({ top: undefined, bottom: 7, getterState: { status: 'value', value: { topSolderMask: 5 } } }).candidates.length, 0, 'undefined source is not treated as null')
for (const getterState of [undefined, { status: 'unavailable' }, { status: 'exception', reason: 'getter failed' }, { status: 'value', value: { topSolderMask: Infinity } }, { status: 'value', value: { bottomSolderMask: 9 } }]) {
	const result = fixture({ top: null, bottom: 7, getterState })
	assert.equal(result.candidates.length, 0, 'unavailable, failed, non-finite, or wrong-side getter cannot resolve null')
	assert.equal(result.skipped.length, 1)
}

const explicitEqual = fixture({ top: 5, bottom: 7, getterState: { status: 'value', value: { topSolderMask: 5 } } })
assert.equal(explicitEqual.candidates.length, 1)
assert.equal(explicitEqual.candidates[0].sourcePad.expansionResolution.resolution, 'source-explicit')
assert.equal(explicitEqual.candidates[0].sourcePad.expansionResolution.runtimeValue, 5)
assert.equal(fixture({ top: 3, bottom: 7, getterState: { status: 'exception', reason: 'getter failed' } }).candidates.length, 1, 'getter failure does not invalidate an explicit source value')
const conflict = fixture({ top: 3, bottom: 7, getterState: { status: 'value', value: { topSolderMask: 5 } } })
assert.equal(conflict.candidates.length, 0, 'an explicit source value contradicted by the valid getter is not trusted')
assert.deepEqual(conflict.overrideNeeded[0], { sourceIdentity: { componentId: 'component-1', footprintUuid: 'footprint-1', localPrimitiveId: 'pad-local', source: 'document-embedded' }, componentId: 'component-1', padNumber: '1', runtimePadId: 'runtime-pad-1', physicalSide: 'top', sourceField: 'topSolderExpansion', sourceValue: 3, runtimeField: 'topSolderMask', runtimeValue: 5, state: 'override-needed' })

const nullClosed = fixture({ top: null, bottom: 7, getterState: { status: 'value', value: { topSolderMask: -16 } } })
assert.equal(nullClosed.closed.length, 1)
assert.equal(nullClosed.closed[0].expansionResolution.resolution, 'runtime-effective', 'closed models keep null resolution provenance')

console.log('silkscreen mask null resolution regression passed')
