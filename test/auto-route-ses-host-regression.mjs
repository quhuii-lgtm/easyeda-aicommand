import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "export { canonicalizeSourceVias, readRouteSnapshot, verifySourceChanges } from '../src/engine/autoRouteSesHost.ts'; export { verifySesImport } from '../src/engine/autoRouteSes.ts'",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'auto-route-ses-host-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { canonicalizeSourceVias, readRouteSnapshot, verifySourceChanges, verifySesImport } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const getters = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [`getState_${key}`, () => value]))
const line = { ...getters({ PrimitiveId: 'line-1', Net: 'N1', Layer: 1, LineWidth: 12, StartX: 100, StartY: 200, EndX: 300, EndY: 400, PrimitiveLock: true }) }
const via = { ...getters({ PrimitiveId: 'via-1', Net: 'N1', X: 300, Y: 400, Diameter: 24, HoleDiameter: 12, ViaType: 0, PrimitiveLock: false }) }
const arc = { ...getters({ PrimitiveId: 'arc-1', Net: 'N1', Layer: 1, LineWidth: 10, StartX: 10, StartY: 20, EndX: 30, EndY: 40, ArcAngle: 90, PrimitiveLock: true }) }
const sourceVia = { type: 'VIA', id: 'via-1', ticket: 3, data: { netName: 'N1', centerX: 300, centerY: 400, viaDiameter: 24, holeDiameter: 12, viaType: 'NORMAL', locked: false } }
const docSource = (docHead = { type: 'DOCHEAD', ticket: 1, data: { docType: 'PCB', uuid: 'pcb-A', updateTime: 1 } }, recordData = { keep: true }, vias = [sourceVia]) => [
	`${JSON.stringify(docHead)}||${JSON.stringify(docHead.data)}`,
	`${JSON.stringify({ type: 'COMPONENT', id: 'cmp-1', ticket: 2 })}||${JSON.stringify(recordData)}`,
	...vias.map(record => `${JSON.stringify({ type: record.type, id: record.id, ticket: record.ticket })}||${JSON.stringify(record.data)}`),
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

const routeRecord = (type, id, ticket, data) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`
const u4LocalVias = [
	{ id: 'e61', centerX: -19.68, centerY: 19.68 },
	{ id: 'e62', centerX: 19.69, centerY: 19.68 },
	{ id: 'e63', centerX: -19.68, centerY: -19.69 },
	{ id: 'e64', centerX: 19.69, centerY: -19.69 },
]
const u4FootprintUuid = '2f9fbbbd847cf8eb'
const u4FootprintSource = [
	routeRecord('DOCHEAD', undefined, undefined, { docType: 'FOOTPRINT', uuid: u4FootprintUuid }),
	routeRecord('CANVAS', 'CANVAS', 1, { unit: 'mm' }),
	...u4LocalVias.map((item, index) => routeRecord('VIA', item.id, index + 2, { groupId: 0, netName: '', centerX: item.centerX, centerY: item.centerY, holeDiameter: 12, viaDiameter: 24, viaType: 'NORMAL', locked: false })),
].join('\n')
const u4PcbSource = (footprintUuid = u4FootprintUuid, padNet = 'N_GND', includePrefixDecoy = false) => [
	routeRecord('DOCHEAD', undefined, undefined, { docType: 'PCB', uuid: 'pcb-U4' }),
	...(includePrefixDecoy ? [
		routeRecord('COMPONENT', 'e1', 2, { layerId: 2, x: 1, y: 2, angle: 0, locked: true, footprintPrimitives: false }),
		routeRecord('ATTR', 'e2', 3, { parentId: 'e1', key: 'Footprint', value: 'decoy-footprint' }),
	] : []),
	routeRecord('COMPONENT', 'e139', 2, { layerId: 1, x: 730.9455, y: -41.4545, angle: 90, locked: true, footprintPrimitives: true }),
	routeRecord('ATTR', 'e140', 4, { parentId: 'e139', key: 'Footprint', value: footprintUuid }),
	...u4LocalVias.map((item, index) => routeRecord('PAD_NET', JSON.stringify(['PAD_NET', 'e139', item.id, item.id]), index + 5, { padNet, padLen: null, attrsMap: null })),
].join('\n')
const u4SdkVias = [
	{ id: 'e139e61', x: 711.2655, y: -61.1345 },
	{ id: 'e139e62', x: 711.2655, y: -21.7645 },
	{ id: 'e139e63', x: 750.6355, y: -61.1345 },
	{ id: 'e139e64', x: 750.6355, y: -21.7645 },
].map(item => ({ ...getters({ PrimitiveId: item.id, Net: 'N_GND', X: item.x, Y: item.y, Diameter: 24, HoleDiameter: 12, ViaType: 0, PrimitiveLock: false }) }))
const footprintRequests = []
const u4Api = {
	...api,
	pcb_PrimitiveVia: { getAll: async () => u4SdkVias },
	sys_FileManager: { getDocumentSource: async () => u4PcbSource(u4FootprintUuid, 'N_GND', true) },
	lib_LibrariesList: { getProjectLibraryUuid: async () => 'project' },
	lib_Footprint: { getDocumentSource: async footprintUuid => { footprintRequests.push(footprintUuid); return u4FootprintSource } },
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb-U4' }) },
}
const u4Snapshot = await readRouteSnapshot(u4Api, async () => {})
assert.equal(u4Snapshot.vias.length, 4, 'all four existing footprint-local NORMAL vias remain routing obstacles')
assert.deepEqual(u4Snapshot.vias.map(item => item.id), u4SdkVias.map(item => item.getState_PrimitiveId()))
assert.ok(u4Snapshot.vias.every(item => item.net === 'N_GND' && item.diameterMil === 24 && item.holeDiameterMil === 12 && item.locked === false), 'net comes from the board PAD_NET/SDK binding and lock comes from the via itself, not the locked parent component')
assert.equal(u4Snapshot.sourceRecords.filter(record => record.type === 'VIA').length, 0, 'derived footprint VIA proof never fabricates board source records')
assert.deepEqual(footprintRequests, [u4FootprintUuid], 'e1 is only a textual UUID prefix collision and is not treated as the via owner')
const extraSdkVia = { ...getters({ PrimitiveId: 'e139e65', Net: 'N_GND', X: 712, Y: -62, Diameter: 24, HoleDiameter: 12, ViaType: 0, PrimitiveLock: false }) }
await assert.rejects(() => readRouteSnapshot({ ...u4Api, pcb_PrimitiveVia: { getAll: async () => [...u4SdkVias, extraSdkVia] } }, async () => {}), /源记录与 SDK ID 集合不一致/)
const wrongViaIdSdk = u4SdkVias.map((item, index) => index === 0 ? { ...item, getState_PrimitiveId: () => 'e139e99' } : item)
await assert.rejects(() => readRouteSnapshot({ ...u4Api, pcb_PrimitiveVia: { getAll: async () => wrongViaIdSdk } }, async () => {}), /源记录与 SDK ID 集合不一致/)
await assert.rejects(() => readRouteSnapshot({ ...u4Api, sys_FileManager: { getDocumentSource: async () => u4PcbSource('wrong-footprint') } }, async () => {}), /来源不可用于过孔核对|UUID 不匹配/)
const bottomU4Source = u4PcbSource().replace('"layerId":1,"x":730.9455', '"layerId":2,"x":730.9455')
await assert.rejects(() => readRouteSnapshot({ ...u4Api, sys_FileManager: { getDocumentSource: async () => bottomU4Source } }, async () => {}), /位于非顶层.*变换尚未验证/)
await assert.rejects(() => readRouteSnapshot({ ...u4Api, pcb_PrimitiveVia: { getAll: async () => u4SdkVias.map((item, index) => index === 0 ? { ...item, getState_X: () => 711.2675 } : item) } }, async () => {}), /坐标与组件顶面变换不一致/)
await assert.rejects(() => readRouteSnapshot({ ...u4Api, pcb_PrimitiveVia: { getAll: async () => u4SdkVias.map((item, index) => index === 0 ? { ...item, getState_HoleDiameter: () => 10 } : item) } }, async () => {}), /孔径与SDK读回不一致/)
await assert.rejects(() => readRouteSnapshot({ ...u4Api, pcb_PrimitiveVia: { getAll: async () => u4SdkVias.map((item, index) => index === 0 ? { ...item, getState_ViaType: () => 1 } : item) } }, async () => {}), /SDK viaType 与 NORMAL 源记录不一致/)
await assert.rejects(() => readRouteSnapshot({ ...u4Api, sys_FileManager: { getDocumentSource: async () => u4PcbSource(u4FootprintUuid, '') } }, async () => {}), /PAD_NET 网络为空或不可判定/)
assert.throws(() => canonicalizeSourceVias([{ type: 'VIA', id: 'added-via', data: { netName: 'N1', centerX: 1, centerY: 2, viaDiameter: 24, viaType: 'NORMAL', locked: false } }], [{ id: 'added-via', net: 'N1', x: 1, y: 2, diameterMil: 24, viaType: 0, locked: false }], true), /新建读回缺少可核验的 holeDiameter/)
const precisionData = { netName: 'CSI_CLK_N', centerX: 783.4646, centerY: -600.3937, viaDiameter: 23.623, holeDiameter: 11.812, viaType: 'NORMAL', locked: false }
const precisionSdkVia = { ...getters({ PrimitiveId: '66ca3101727f356d', Net: 'CSI_CLK_N', X: 783.464566929134, Y: -600.3937007874016, Diameter: 23.6, HoleDiameter: 11.8, ViaType: 0, PrimitiveLock: false }) }
const precisionApi = {
	...api,
	pcb_PrimitiveVia: { getAll: async () => [precisionSdkVia] },
	sys_FileManager: { getDocumentSource: async () => docSource(undefined, undefined, [{ type: 'VIA', id: '66ca3101727f356d', ticket: 3, data: precisionData }]) },
}
const preciseSnapshot = await readRouteSnapshot(precisionApi, async () => {})
assert.equal(preciseSnapshot.vias[0].diameterMil, 23.623, 'one-decimal SDK projection is canonicalized to precise VIA source')
assert.equal(preciseSnapshot.vias[0].holeDiameterMil, 11.812)
assert.equal(preciseSnapshot.vias[0].x, 783.4646, 'source coordinates are retained within the existing 0.001 mil allowance')
const rejectPrecision = async (sourceData, sdkFields = {}) => assert.rejects(() => readRouteSnapshot({
	...precisionApi,
	pcb_PrimitiveVia: { getAll: async () => [{ ...precisionSdkVia, ...getters({ ...{
		Net: precisionData.netName, X: precisionSdkVia.getState_X(), Y: precisionSdkVia.getState_Y(), Diameter: 23.6, HoleDiameter: 11.8, ViaType: 0, PrimitiveLock: false,
	}, ...sdkFields }) }] },
	sys_FileManager: { getDocumentSource: async () => docSource(undefined, undefined, [{ type: 'VIA', id: '66ca3101727f356d', ticket: 3, data: { ...precisionData, ...sourceData } }]) },
}, async () => {}))
await rejectPrecision({ netName: 'OTHER' })
await rejectPrecision({}, { ViaType: 1 })
await rejectPrecision({}, { PrimitiveLock: true })
await rejectPrecision({ holeDiameter: 23.623 })
const sameTenthWrongSource = await readRouteSnapshot({
	...precisionApi,
	sys_FileManager: { getDocumentSource: async () => docSource(undefined, undefined, [{ type: 'VIA', id: '66ca3101727f356d', ticket: 3, data: { ...precisionData, viaDiameter: 23.64 } }]) },
}, async () => {})
const precisePlanVia = { net: 'CSI_CLK_N', x: 783.4646, y: -600.3937, diameterMil: 23.623, holeDiameterMil: 11.812, viaType: 0 }
const sourceBucketMismatch = verifySesImport({ before: { documentUuid: 'pcb-A' }, expected: { vias: [precisePlanVia] }, targetLines: [], targetVias: [precisePlanVia] }, { documentUuid: 'pcb-A', lines: [], vias: sameTenthWrongSource.vias })
assert.equal(sourceBucketMismatch.verified, false, 'source 23.64 remains exact and fails the 23.623 plan even though the SDK projection is 23.6')
await assert.rejects(() => readRouteSnapshot({ ...precisionApi, sys_FileManager: { getDocumentSource: async () => docSource(undefined, undefined, []) } }, async () => {}), /源记录与 SDK ID 集合不一致/)
await assert.rejects(() => readRouteSnapshot({ ...precisionApi, pcb_PrimitiveVia: { getAll: async () => [precisionSdkVia, precisionSdkVia] } }, async () => {}), /SDK 过孔 ID .*重复或无效/)
const blindViaSnapshot = await readRouteSnapshot({
	...api,
	pcb_PrimitiveVia: { getAll: async () => [{ ...via, getState_ViaType: () => 1 }] },
}, async () => {}, docSource(undefined, undefined, [{ ...sourceVia, data: { ...sourceVia.data, viaType: 'BLIND' } }]))
assert.equal(blindViaSnapshot.vias[0].viaType, 1, 'existing non-through vias retain SDK-only snapshot behavior')
await assert.rejects(() => readRouteSnapshot({
	...api,
	pcb_PrimitiveVia: { getAll: async () => [{ ...via, getState_HoleDiameter: () => undefined }] },
}, async () => {}), /holeDiameter 读回不是有限数|holeDiameter 缺失状态冲突|孔径与源码或 SDK 一位小数投影不一致/)
const unknownHoleSnapshot = await readRouteSnapshot({
	...api,
	pcb_PrimitiveVia: { getAll: async () => [{ ...via, getState_HoleDiameter: () => undefined }] },
	sys_FileManager: { getDocumentSource: async () => docSource(undefined, undefined, [{ ...sourceVia, data: { ...sourceVia.data, holeDiameter: undefined } }]) },
}, async () => {})
assert.equal('holeDiameterMil' in unknownHoleSnapshot.vias[0], false, 'legacy unknown drills remain explicitly unknown when both source and SDK omit them')
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
	pcb_PrimitiveVia: { getAll: async () => [] },
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
