import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "export { readRouteSnapshot, verifySourceChanges } from '../src/engine/autoRouteSesHost.ts'",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'auto-route-ses-host-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { readRouteSnapshot, verifySourceChanges } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const getters = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [`getState_${key}`, () => value]))
const line = { ...getters({ PrimitiveId: 'line-1', Net: 'N1', Layer: 1, LineWidth: 12, StartX: 100, StartY: 200, EndX: 300, EndY: 400, PrimitiveLock: true }) }
const via = { ...getters({ PrimitiveId: 'via-1', Net: 'N1', X: 300, Y: 400, Diameter: 24, HoleDiameter: 12, ViaType: 0, PrimitiveLock: false }) }
const arc = { ...getters({ PrimitiveId: 'arc-1', Net: 'N1', Layer: 1, LineWidth: 10, StartX: 10, StartY: 20, EndX: 30, EndY: 40, ArcAngle: 90, PrimitiveLock: true }) }
const docSource = (docHead = { type: 'DOCHEAD', ticket: 1, data: { docType: 'PCB', uuid: 'pcb-A', updateTime: 1 } }, recordData = { keep: true }) => [
	`${JSON.stringify(docHead)}||${JSON.stringify(docHead.data)}`,
	`${JSON.stringify({ type: 'COMPONENT', id: 'cmp-1', ticket: 2 })}||${JSON.stringify(recordData)}`,
].join('|\n')

const focusChecks = []
const api = {
	pcb_PrimitiveLine: { getAll: async () => [line] },
	pcb_PrimitiveVia: { getAll: async () => [via] },
	pcb_PrimitiveArc: { getAll: async () => [arc] },
	pcb_Layer: { getAllLayers: async () => [{ id: 1, name: 'TopLayer', type: 'SIGNAL' }] },
	sys_FileManager: { getDocumentSource: async () => docSource() },
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb-A' }) },
}
const snapshot = await readRouteSnapshot(api, async () => { focusChecks.push('focus') })
assert.equal(snapshot.documentUuid, 'pcb-A')
assert.deepEqual(snapshot.lines, [{ id: 'line-1', net: 'N1', layer: 1, widthMil: 12, a: { x: 100, y: 200 }, b: { x: 300, y: 400 }, locked: true }])
assert.equal(snapshot.vias[0].holeDiameterMil, 12)
assert.equal(snapshot.vias[0].viaType, 0)
assert.equal(snapshot.arcs[0].locked, true)
const blindViaSnapshot = await readRouteSnapshot({
	...api,
	pcb_PrimitiveVia: { getAll: async () => [{ ...via, getState_ViaType: () => 1 }] },
}, async () => {})
assert.equal(blindViaSnapshot.vias[0].viaType, 1, 'unrelated baseline blind vias remain representable')
const unknownHoleSnapshot = await readRouteSnapshot({
	...api,
	pcb_PrimitiveVia: { getAll: async () => [{ ...via, getState_HoleDiameter: () => undefined }] },
}, async () => {})
assert.equal('holeDiameterMil' in unknownHoleSnapshot.vias[0], false, 'an unavailable baseline hole diameter remains unknown')
assert.deepEqual(snapshot.layers, [{ id: 1, name: 'TopLayer', type: 'SIGNAL' }])
const layerStatusSnapshot = await readRouteSnapshot({
	...api,
	pcb_Layer: { getAllLayers: async () => [
		{ id: 1, name: 'Top Layer', type: 'SIGNAL', layerStatus: 1 },
		{ id: 15, name: 'Inner1', type: 'SIGNAL', layerStatus: 1 },
		{ id: 16, name: 'Inner2', type: 'SIGNAL', layerStatus: 1 },
		{ id: 17, name: 'Inner3', type: 'SIGNAL', layerStatus: 0 },
	] },
}, async () => {})
assert.deepEqual(layerStatusSnapshot.layers.slice(1), [
	{ id: 15, name: 'Inner1', type: 'SIGNAL', layerStatus: 1 },
	{ id: 16, name: 'Inner2', type: 'SIGNAL', layerStatus: 1 },
	{ id: 17, name: 'Inner3', type: 'SIGNAL', layerStatus: 0 },
], 'snapshot carries enabled-layer state without converting visibility')
assert.equal(focusChecks.length, 12, 'focus is asserted before and after each SDK/source read')

const artHeader = JSON.stringify({ type: 'DOCHEAD', ticket: 1, data: { docType: 'PCB', uuid: 'pcb-A' } })
const artSource = `${artHeader}||${JSON.stringify({ docType: 'PCB', uuid: 'pcb-A' })}|\n${JSON.stringify({ type: 'LINE', id: 'art-line', ticket: 2 })}||${JSON.stringify({ layer: 3, text: 'keep artwork' })}|\n${JSON.stringify({ type: 'ARC', id: 'art-arc', ticket: 3 })}||${JSON.stringify({ layer: 4, text: 'keep arc' })}`
const artwork = await readRouteSnapshot({
	...api,
	pcb_PrimitiveLine: { getAll: async () => [{ getState_PrimitiveId: () => 'art-line', getState_Layer: () => 3 }] },
	pcb_PrimitiveArc: { getAll: async () => [{ getState_PrimitiveId: () => 'art-arc', getState_Layer: () => 4 }] },
	pcb_Layer: { getAllLayers: async () => [
		{ id: 1, name: 'TopLayer', type: 'SIGNAL' },
		{ id: 3, name: 'TopSilkLayer', type: 'DOCUMENT' },
		{ id: 4, name: 'MechanicalLayer', type: 'DOCUMENT' },
	] },
	sys_FileManager: { getDocumentSource: async () => artSource },
}, async () => {})
assert.deepEqual(artwork.lines, [], 'non-SIGNAL lines are not classified as route geometry')
assert.deepEqual(artwork.arcs, [], 'non-SIGNAL arcs are not classified as route geometry')
assert.equal(verifySourceChanges(artwork, { ...artwork, sourceRecords: artwork.sourceRecords.filter(record => record.id !== 'art-line') }, [], []).verified, false, 'non-SIGNAL artwork remains protected by source comparison')

for (const locked of [undefined, null]) {
	await assert.rejects(
		() => readRouteSnapshot({ ...api, pcb_PrimitiveLine: { getAll: async () => [{ ...line, getState_PrimitiveLock: () => locked }] } }, async () => {}),
		/锁定状态不可判定/,
	)
}
await assert.rejects(
	() => readRouteSnapshot({ ...api, pcb_PrimitiveLine: { getAll: async () => [{ ...line, getState_PrimitiveId: () => undefined }] } }, async () => {}),
	/缺少有效 primitive ID/,
)
await assert.rejects(
	() => readRouteSnapshot({ ...api, pcb_PrimitiveLine: { getAll: async () => [{ ...line, getState_Net: () => undefined }] } }, async () => {}),
	/网络名不可判定/,
)

const afterDynamicHead = await readRouteSnapshot({
	...api,
	sys_FileManager: { getDocumentSource: async () => docSource({ type: 'DOCHEAD', ticket: 8, data: { docType: 'PCB', uuid: 'pcb-A', updateTime: 2 } }) },
}, async () => {})
assert.deepEqual(verifySourceChanges(snapshot, afterDynamicHead, [], []), { verified: true, differences: [] }, 'dynamic DOCHEAD changes are ignored')

const withAllowedRoutes = { ...afterDynamicHead, sourceRecords: [...afterDynamicHead.sourceRecords, { type: 'LINE', id: 'line-new', data: { geometry: 'new route' } }] }
assert.equal(verifySourceChanges(snapshot, withAllowedRoutes, [], [{ type: 'LINE', id: 'line-new' }]).verified, true)
assert.equal(verifySourceChanges(snapshot, withAllowedRoutes, [], []).verified, false, 'unplanned route additions are rejected')

const changedNonRoute = { ...afterDynamicHead, sourceRecords: [{ type: 'COMPONENT', id: 'cmp-1', data: { keep: false } }] }
assert.equal(verifySourceChanges(snapshot, changedNonRoute, [], []).verified, false, 'non-route source changes are rejected')
console.log('PASS autoRouteSesHost snapshots SDK routes, layers, source records, and checks allowed source changes')
