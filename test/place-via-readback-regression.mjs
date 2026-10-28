import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `import { pcbCommands } from '../src/commands/pcb.ts'; export { pcbCommands }`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'place-via-readback-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { pcbCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const command = pcbCommands.find(item => item.name === 'pcb.placeVia')

function viaState(overrides = {}) {
	const state = { primitiveId: 'via-new', net: 'N1', x: 100, y: 200, holeDiameter: 12, diameter: 24, viaType: 0, ...overrides }
	return {
		getState_PrimitiveId: () => state.primitiveId,
		getState_Net: () => state.net,
		getState_X: () => state.x,
		getState_Y: () => state.y,
		getState_HoleDiameter: () => state.holeDiameter,
		getState_Diameter: () => state.diameter,
		getState_ViaType: () => state.viaType,
	}
}

function install(options = {}) {
	const calls = { events: [], create: 0, enumerate: 0, freshRead: 0, delete: 0, ratline: 0, source: 0, modifies: [] }
	const created = viaState(options.readback ?? {})
	const originalRecords = [
		{ type: 'DOCHEAD', ticket: 0, data: { docType: 'PCB', uuid: 'pcb-via', client: 'before', updateTime: 1, version: '1', editVersion: 4 } },
		{ type: 'LINE', id: 'line-a', ticket: 1, data: { partitionId: '', groupId: 0, netName: 'N1', layerId: 1, startX: 100, startY: 200, endX: 300, endY: 200, width: 12, locked: false, zIndex: -1 } },
	]
	const sourceOf = rows => rows.map(record => `${JSON.stringify({ type: record.type, ...(record.id ? { id: record.id } : {}), ticket: record.ticket })}||${JSON.stringify(record.data)}|`).join('\n')
	const originalSource = sourceOf(originalRecords)
	const viaRecords = [
		{ ...originalRecords[0], data: { ...originalRecords[0].data, client: 'after-via', updateTime: 2, version: '2' } },
		{ ...originalRecords[1], ticket: 2 },
		{ type: 'VIA', id: 'via-new', ticket: 3, data: { netName: 'N1', layerId: 1, x: 100, y: 200, holeDiameter: 12, diameter: 24 } },
	]
	const viaSource = sourceOf(viaRecords)
	const lineState = {
		getState_PrimitiveId: () => 'line-a', getState_Net: () => 'N1', getState_Layer: () => 1,
		getState_StartX: () => 100, getState_StartY: () => 200, getState_EndX: () => 300, getState_EndY: () => 200,
		getState_LineWidth: () => 12, getState_PrimitiveLock: () => false,
	}
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => { calls.events.push('focus'); return options.focusLost && calls.create > 0 && calls.enumerate === 0 ? { documentType: 3, uuid: 'pcb-other' } : { documentType: 3, uuid: 'pcb-via' } } },
		pcb_Net: { getAllNetsName: async () => { calls.events.push('net'); return options.netMissing ? ['N2'] : ['N1'] } },
		pcb_PrimitiveVia: {
			create: async (...args) => { calls.events.push('create'); calls.create++; calls.args = args; return options.createResult === null ? undefined : { getState_PrimitiveId: () => 'via-new' } },
			getAllPrimitiveId: async () => { calls.events.push('enumerate'); calls.enumerate++; return options.idList ?? ['via-new'] },
			getAll: async () => { calls.events.push('fresh-read'); calls.freshRead++; return options.emptyFresh ? [] : [created] },
			delete: async () => { calls.events.push('delete'); calls.delete++; return true },
		},
		...(options.withEndpointTarget ? { pcb_PrimitiveLine: {
			get: async id => { calls.events.push(`line-get:${id}`); return id === 'line-a' ? lineState : undefined },
			modify: async (id, properties) => {
				calls.events.push(`line-modify:${id}`); calls.modifies.push({ id, properties })
				if (options.modifyThrows) throw new Error('line modify failed')
				if (options.delayModifyMs) await new Promise(resolvePromise => setTimeout(resolvePromise, options.delayModifyMs))
				return options.modifyReturn === 'undefined' ? undefined : options.modifyReturn === 'false' ? false : options.modifyReturn === 'wrong-id' ? { getState_PrimitiveId: () => 'wrong-id' } : { getState_PrimitiveId: () => id }
			},
		} } : {}),
		...(options.withEndpointTarget ? {
			pcb_Layer: { getAllLayers: async () => [{ id: 1, type: 'SIGNAL', layerStatus: 1 }] },
			sys_FileManager: { getDocumentSource: async () => { calls.source++; calls.events.push(`source:${calls.source}`); return calls.create > 0 ? viaSource : originalSource } },
		} : {}),
		pcb_Document: { startCalculatingRatline: async () => { calls.events.push('ratline'); calls.ratline++; if (options.ratlineThrows) throw new Error('ratline failed'); return options.ratlineResult ?? true } },
	}
	return calls
}

const defaultParams = { net: 'N1', x: 100, y: 200, holeDiameter: 12, diameter: 24 }
async function assertPartialReadbackFailure(readback, params = defaultParams, message = 'readback mismatch is partial and non-retryable') {
	const calls = install({ readback })
	await assert.rejects(command.handler(params), error => {
		assert.equal(error.cause?.partial, true, message)
		assert.equal(error.cause?.retryable, false, message)
		assert.equal(error.cause?.primitiveId, 'via-new', message)
		assert.match(error.message, /不要重试/)
		return true
	})
	assert.equal(calls.create, 1, 'a failed readback does not retry via creation')
	assert.equal(calls.delete, 0, 'a failed readback does not delete the candidate or any prior via')
	assert.equal(calls.ratline, 0, 'a failed readback stops before connectivity recalculation')
}

{
const calls = install()
	const result = await command.handler({ net: 'N1', x: 100, y: 200, holeDiameter: 12, diameter: 24 })
	assert.deepEqual(calls.args, ['N1', 100, 200, 12, 24, 0], 'create requests a through via explicitly')
	assert.equal(calls.create, 1, 'create is called exactly once')
	assert.ok(calls.events.indexOf('net') < calls.events.indexOf('create'))
	assert.ok(calls.events.indexOf('enumerate') < calls.events.indexOf('fresh-read'))
	assert.ok(calls.events.indexOf('fresh-read') < calls.events.indexOf('ratline'))
	assert.deepEqual(result, { primitiveId: 'via-new', readbackVerified: true, ratlineCalculation: { requested: true, accepted: true }, endpointRefresh: { attempted: false, skipped: true, reason: '缺少源码、铜层或按 ID 读回能力', completedLineIds: [], results: [] }, connectivityVerified: false })
	assert.equal(command.returns.includes('connectivityVerified:false'), true)
}

{
const calls = install({ withEndpointTarget: true })
	const result = await command.handler(defaultParams)
	assert.deepEqual(result.endpointRefresh.completedLineIds, ['line-a'], 'the real command refreshes a preselected same-net endpoint LINE')
	assert.equal(result.endpointRefresh.attempted, true)
	assert.deepEqual(calls.modifies, [{ id: 'line-a', properties: { startX: 100, startY: 200, endX: 300, endY: 200 } }])
	assert.equal(result.connectivityVerified, false, 'a successful refresh does not claim connectivity verification')
	assert.ok(calls.events.indexOf('ratline') < calls.events.indexOf('line-modify:line-a'))
}

{
	const calls = install({ withEndpointTarget: true, delayModifyMs: 1300 })
	await assert.rejects(command.handler({ ...defaultParams, _timeoutMs: 1000 }), error => {
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause?.retryable, false)
		assert.equal(error.cause?.primitiveId, 'via-new')
		assert.deepEqual(error.cause?.ratlineCalculation, { requested: true, accepted: true })
		assert.deepEqual(error.cause?.endpointRefresh?.completedLineIds, [])
		return true
	})
	assert.deepEqual(calls.modifies.map(call => call.id), ['line-a'])
	await new Promise(resolvePromise => setTimeout(resolvePromise, 400))
	assert.deepEqual(calls.modifies.map(call => call.id), ['line-a'], 'late modify completion after shared deadline does not trigger another LINE write')
	assert.equal(calls.events.some(event => event.startsWith('line-get:')), true, 'readback happened only before the timed-out write')
	assert.equal(calls.events.filter(event => event.startsWith('line-get:')).length, 2, 'the two pre-write getters ran, but late raw return does not continue to fresh getter verification')
}

for (const params of [
	{ net: 'N1', x: NaN, y: 200, holeDiameter: 12, diameter: 24 },
	{ net: 'N1', x: 100, y: Infinity, holeDiameter: 12, diameter: 24 },
	{ net: 'N1', x: 100, y: 200, holeDiameter: 24, diameter: 24 },
]) {
	const calls = install()
	await assert.rejects(command.handler(params), /有限数值|小于 diameter/)
	assert.equal(calls.create, 0, 'invalid numeric input is rejected before create')
}

for (const { params, readback } of [
	{ params: { ...defaultParams, x: 962.648, y: 292.917 }, readback: { x: 962.6480000000001, y: 292.9169999999999 } },
	{ params: { ...defaultParams, x: 962.648 }, readback: { x: 962.6480000000001 } },
	{ params: { ...defaultParams, y: 292.917 }, readback: { y: 292.9169999999999 } },
	{ params: { ...defaultParams, holeDiameter: 12 }, readback: { holeDiameter: 12.000000000000002 } },
	{ params: { ...defaultParams, diameter: 24 }, readback: { diameter: 24.000000000000004 } },
]) {
	const calls = install({ readback })
	const result = await command.handler(params)
	assert.equal(result.readbackVerified, true, 'binary floating-point roundtrip noise is accepted for numeric geometry only')
	assert.equal(calls.ratline, 1)
}

for (const field of ['x', 'y', 'holeDiameter', 'diameter']) {
	for (const difference of [0.001, -0.001, 2e-9]) {
		const params = { ...defaultParams }
		params[field] += 0
		const readback = { [field]: params[field] + difference }
		await assertPartialReadbackFailure(readback, params, `${field} mismatch ${difference} is partial and non-retryable`)
	}
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '12']) {
		const params = { ...defaultParams }
		await assertPartialReadbackFailure({ [field]: value }, params, `${field} nonnumeric or nonfinite readback is rejected`)
	}
}

for (const readback of [{ primitiveId: 'different-id' }, { net: 'N2' }, { viaType: 1 }])
	await assertPartialReadbackFailure(readback, defaultParams, 'primitive ID, network, and via type remain strict comparisons')

{
	const calls = install({ focusLost: true })
	await assert.rejects(command.handler({ net: 'N1', x: 100, y: 200, holeDiameter: 12, diameter: 24 }), error => {
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause?.primitiveId, 'via-new')
		assert.deepEqual(error.cause?.ratlineCalculation, { requested: false, accepted: false })
		return true
	})
	assert.equal(calls.ratline, 0, 'a changed PCB focus prevents recalculation')
}

{
	const calls = install({ idList: ['different-via-id'] })
	await assert.rejects(command.handler({ net: 'N1', x: 100, y: 200, holeDiameter: 12, diameter: 24 }), error => {
		assert.equal(error.cause?.primitiveId, 'via-new')
		assert.equal(error.cause?.readbackVerified, undefined)
		return true
	})
	assert.equal(calls.freshRead, 0, 'a missing candidate ID fails before fresh object readback')
	assert.equal(calls.ratline, 0)
}

for (const options of [{ ratlineResult: false }, { ratlineThrows: true }]) {
	const calls = install(options)
	await assert.rejects(command.handler({ net: 'N1', x: 100, y: 200, holeDiameter: 12, diameter: 24 }), error => {
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause?.retryable, false)
		assert.equal(error.cause?.primitiveId, 'via-new', 'retain the created via ID when ratline calculation fails')
		assert.equal(error.cause?.readbackVerified, true)
		assert.deepEqual(error.cause?.ratlineCalculation, { requested: true, accepted: false })
		return true
	})
	assert.equal(calls.create, 1)
	assert.equal(calls.ratline, 1, 'each failure path makes one calculation request only')
}

{
	const calls = install({ netMissing: true })
	await assert.rejects(command.handler({ net: 'N1', x: 100, y: 200, holeDiameter: 12, diameter: 24 }), /当前 PCB 中不存在/)
	assert.equal(calls.create, 0, 'missing net is rejected before create')
}

console.log('place-via-readback-regression: all checks passed')
