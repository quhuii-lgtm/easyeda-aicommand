import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "import { pcbCommands } from '../src/commands/pcb.ts'; export { pcbCommands }",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-pour-modify-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { pcbCommands } = await import(moduleUrl)
const modifyPour = pcbCommands.find(item => item.name === 'pcb.modifyPour').handler

const makeRecord = (type, id, data, ticket) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}`
const pourData = (id, overrides = {}) => ({
	id, partitionId: '', groupId: 0, netName: 'GND', layerId: 2, width: 0.2,
	name: `POUR_${id}`, order: 0, path: [['R', 0, 0, 10, 10, 0, 0]],
	pourType: { pourType: 'SOLID', fineness: 8 }, keepIsland: false, locked: false,
	zIndex: 1, ...overrides,
})

function install({ net = 'GND', sourceNet = net, objectNet = net, sourceName = 'POUR_target', objectName = sourceName, omitNameGetter = false, modifyMutation, pouredId = 'poured-1' } = {}) {
	const focus = { documentType: 3, uuid: 'pcb-pour-network-policy' }
	const target = pourData('target', { netName: sourceNet, name: sourceName })
	const other = pourData('other', { layerId: 15, netName: 'OTHER_NET', order: 4 })
	const docs = [target, other]
	const counts = { get: 0, toAsync: 0, setter: 0, done: 0, staticModify: 0, sourceReads: 0, netLookups: 0, creates: 0 }
	const pouredRecords = [{ id: pouredId, data: { pourPrimitiveId: 'target', source: 'retain-me', order: 1 } }]
	const source = () => [
		makeRecord('DOCHEAD', 'head', { docType: 'PCB', uuid: focus.uuid, client: 'fixture' }, 1),
		...pouredRecords.map((item, index) => makeRecord('POURED', item.id, item.data, index + 2)),
		...docs.map((item, index) => makeRecord('POUR', item.id, item, index + 3)),
	].join('\n')
	const sdkPour = item => ({
		getState_PrimitiveId: () => item.id,
		getState_Net: () => item.id === 'target' ? objectNet : item.netName,
		getState_Layer: () => item.layerId,
		...(!omitNameGetter ? { getState_PourName: () => item.id === 'target' ? objectName : item.name } : {}),
		getState_PourPriority: () => item.order,
		getState_LineWidth: () => item.width,
		getState_PourFillMethod: () => item.pourType,
		getState_PreserveSilos: () => item.keepIsland,
		getState_PrimitiveLock: () => item.locked,
		toAsync() {
			counts.toAsync++
			const asyncObject = {
				setState_Net(value) {
					counts.setter++
					asyncObject.pendingNet = value
					return asyncObject
				},
				async done() {
					counts.done++
					return sdkPour(item)
				},
			}
			return asyncObject
		},
	})
	globalThis.eda = {
		pcb_Net: { getAllNetsName: async () => { counts.netLookups++; return ['GND'] } },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ ...focus }) },
		sys_FileManager: { getDocumentSource: async () => { counts.sourceReads++; return source() } },
		pcb_PrimitivePour: {
			create: async () => { counts.creates++; return sdkPour(target) },
			get: async id => { counts.get++; return docs.find(item => item.id === id) ? sdkPour(docs.find(item => item.id === id)) : undefined },
			getAll: async () => docs.map(sdkPour),
			modify: async (id, props) => {
				counts.staticModify++
				const item = docs.find(value => value.id === id)
				const fieldMap = { net: 'netName', layer: 'layerId', pourName: 'name', lineWidth: 'width', complexPolygon: 'path' }
				for (const [key, value] of Object.entries(props)) {
					if (key === 'pourPriority') item.order = value
					else if (key === 'complexPolygon') item.path = value.getSource()
					else item[fieldMap[key]] = value
				}
				if (modifyMutation === 'poured-removed') pouredRecords.length = 0
				if (modifyMutation === 'poured-changed') pouredRecords[0].data.source = 'changed'
				return sdkPour(item)
			},
		},
	pcb_MathPolygon: { createPolygon: source => ({ getSource: () => source }) },
	pcb_Layer: { selectLayer: async () => true },
	}
	return { docs, counts, pouredRecords }
}

const originalStructuredClone = globalThis.structuredClone
try {
	delete globalThis.structuredClone
	// Any actual net change is refused in preflight before all write APIs.
	{
		const f = install()
		await assert.rejects(() => modifyPour({ primitiveId: 'target', net: 'VCC' }), /已有铺铜改网已停用/)
		assert.equal(f.docs[0].netName, 'GND')
		assert.deepEqual(f.counts, { get: 1, toAsync: 0, setter: 0, done: 0, staticModify: 0, sourceReads: 1, netLookups: 0, creates: 0 })
	}

	// Same value in both authoritative source and live getter is a true no-op.
	{
		const f = install({ net: 'GND', objectNet: 'GND' })
		const result = await modifyPour({ primitiveId: 'target', net: 'GND' })
		assert.equal(result.modified, false)
		assert.deepEqual(result.noOpFields, ['net'])
		assert.equal(result.readback.net, 'GND')
		assert.deepEqual(f.counts, { get: 1, toAsync: 0, setter: 0, done: 0, staticModify: 0, sourceReads: 1, netLookups: 0, creates: 0 })
	}

	// A stale/disagreeing source and fresh getter is refused before any write,
	// even when the request matches one of them.
	{
		const f = install({ net: 'GND', objectNet: 'OTHER' })
		await assert.rejects(() => modifyPour({ primitiveId: 'target', net: 'GND' }), /网络源码与当前 API 读回不一致/)
		assert.equal(f.counts.toAsync, 0)
		assert.equal(f.counts.setter, 0)
		assert.equal(f.counts.done, 0)
		assert.equal(f.counts.staticModify, 0)
		assert.equal(f.counts.netLookups, 0)
		assert.equal(f.counts.creates, 0)
	}

	// A mixed network change is refused before the other requested field can write.
	{
		const f = install()
		await assert.rejects(() => modifyPour({ primitiveId: 'target', net: 'VCC', pourName: 'must-not-run' }), /已有铺铜改网已停用/)
		assert.equal(f.counts.sourceReads, 1)
		assert.equal(f.counts.get, 1)
		assert.equal(f.counts.toAsync, 0)
		assert.equal(f.counts.setter, 0)
		assert.equal(f.counts.done, 0)
		assert.equal(f.counts.staticModify, 0)
		assert.equal(f.counts.netLookups, 0)
		assert.equal(f.counts.creates, 0)
	}

	// Renames are refused in preflight for a standalone or mixed request.
	for (const extra of [{}, { layer: 'top' }, { lineWidth: 0.35 }, { layer: 'top', lineWidth: 0.35 }]) {
		const f = install()
		await assert.rejects(() => modifyPour({ primitiveId: 'target', pourName: 'RENAMED', ...extra }), /已有铺铜改名已停用/)
		assert.equal(f.counts.get, 1)
		assert.equal(f.counts.toAsync, 0)
		assert.equal(f.counts.setter, 0)
		assert.equal(f.counts.done, 0)
		assert.equal(f.counts.staticModify, 0)
	}

	// Name source/API mismatch and a missing getter both refuse before writes.
	for (const options of [{ objectName: 'OTHER' }, { omitNameGetter: true }]) {
		const f = install(options)
		await assert.rejects(() => modifyPour({ primitiveId: 'target', pourName: 'POUR_target', layer: 'top' }), /名称/)
		assert.equal(f.counts.staticModify, 0)
		assert.equal(f.counts.toAsync, 0)
	}

	// A confirmed same name is a no-op; together with same-net and priority it
	// still permits the requested priority field through the existing path.
	{
		const f = install()
		const result = await modifyPour({ primitiveId: 'target', pourName: 'POUR_target' })
		assert.equal(result.modified, false)
		assert.deepEqual(result.noOpFields, ['pourName'])
		assert.equal(f.counts.staticModify, 0)
		assert.equal(f.counts.toAsync, 0)
	}
	{
		const f = install({ net: 'GND', objectNet: 'GND' })
		const result = await modifyPour({ primitiveId: 'target', net: 'GND', pourName: 'POUR_target', pourPriority: 1 })
		assert.equal(result.modified, true)
		assert.deepEqual(result.noOpFields, ['net', 'pourName'])
		assert.equal(result.readback.net, 'GND')
		assert.equal(result.readback.pourName, 'POUR_target')
		assert.equal(f.counts.staticModify, 1)
		assert.equal(f.counts.toAsync, 0)
	}

	// Asking for a new net name is also refused without creating a network or
	// reaching any setter/static write path.
	{
		const f = install()
		await assert.rejects(() => modifyPour({ primitiveId: 'target', net: 'NEW_NET', layer: 'top' }), /已有铺铜改网已停用/)
		assert.equal(f.counts.toAsync, 0)
		assert.equal(f.counts.setter, 0)
		assert.equal(f.counts.done, 0)
		assert.equal(f.counts.staticModify, 0)
	}

	// Same-net does not permit a simultaneous rename to reach other writes.
	{
		const f = install({ net: 'GND', objectNet: 'GND' })
		await assert.rejects(() => modifyPour({ primitiveId: 'target', net: 'GND', pourName: 'RENAMED', lineWidth: 0.35 }), /已有铺铜改名已停用/)
		assert.equal(f.counts.get, 1)
		assert.equal(f.counts.toAsync, 0)
		assert.equal(f.counts.setter, 0)
		assert.equal(f.counts.done, 0)
		assert.equal(f.counts.staticModify, 0)
	}

	// Existing POURED content is still guarded against side effects from allowed
	// non-network properties.
	for (const [modifyMutation, difference] of [['poured-removed', 'removed'], ['poured-changed', 'changed']]) {
		const f = install({ modifyMutation })
		const error = await modifyPour({ primitiveId: 'target', net: 'GND', lineWidth: 0.35 }).then(() => undefined, caught => caught)
		assert.equal(error?.cause?.partial, true)
		assert.equal(error?.cause?.retryable, false)
		assert.deepEqual(error?.cause?.attemptedFields, ['lineWidth'])
		assert.equal(error?.cause?.pouredRecordsChange?.[difference]?.length, 1)
		assert.equal(f.counts.staticModify, 1)
		assert.equal(f.counts.toAsync, 0)
	}

	// Existing non-net fields continue through the static API in their prior
	// order and remain source-verified.
	for (const [field, value] of [['layer', 'top'], ['pourPriority', 3], ['lineWidth', 0.35]]) {
		const f = install()
		const result = await modifyPour({ primitiveId: 'target', [field]: value })
		assert.equal(result.readback.verified, true, `${field} remains source-verified`)
		assert.equal(f.counts.staticModify, 1, `${field} retains the static modify path`)
		assert.equal(f.counts.setter, 0, `${field} does not invoke the net setter`)
	}

	// Concave, simple straight-edge polygons can replace the path and are checked
	// against the persisted POUR source before the command reports success.
	{
		const vertices = [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 60 }, { x: 10, y: 60 }]
		const expected = [10, 10, 'L', 50, 10, 50, 30, 30, 30, 30, 60, 10, 60, 10, 10]
		const f = install()
		const result = await modifyPour({ primitiveId: 'target', vertices, __docUuid: 'pcb-pour-network-policy', __projectUuid: 'project-fixture', __tabId: 'tab-fixture' })
		assert.equal(result.readback.verified, true)
		assert.deepEqual(f.docs[0].path, expected)
		assert.deepEqual(result.readback.complexPolygon, expected)
		assert.equal(f.counts.staticModify, 1)
	}
	{
		const f = install()
		await assert.rejects(() => modifyPour({ primitiveId: 'target', vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }] }), /自相交|面积为零/)
		await assert.rejects(() => modifyPour({ primitiveId: 'target', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 10 }] }), /重叠回折/)
		await assert.rejects(() => modifyPour({ primitiveId: 'target', vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], layer: 'top' }), /不能与其他铺铜属性混合/)
		assert.equal(f.counts.staticModify, 0)
	}
	{
		const vertices = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]
		const fixture = install()
		eda.pcb_MathPolygon.createPolygon = source => ({ getSource: () => source.map((v, i) => i === 3 ? v + 1 : v) })
		await assert.rejects(() => modifyPour({ primitiveId: 'target', vertices }), /构造的铺铜轮廓与请求顶点不一致/)
		assert.equal(fixture.counts.staticModify, 0)
		install({ modifyMutation: 'poured-removed', pouredId: JSON.stringify(['POURED', 'target']) })
		assert.equal((await modifyPour({ primitiveId: 'target', vertices })).fillInvalidated, true)
		install({ modifyMutation: 'poured-removed', pouredId: JSON.stringify(['POURED', 'other']) })
		await assert.rejects(() => modifyPour({ primitiveId: 'target', vertices }), /同时新增、删除或修改了有效 POURED/)
	}
}
finally {
	if (originalStructuredClone === undefined) delete globalThis.structuredClone
	else globalThis.structuredClone = originalStructuredClone
}

console.log('PASS pcb.modifyPour network-change preflight, same-net no-op, static fields, and polygon path replacement')
