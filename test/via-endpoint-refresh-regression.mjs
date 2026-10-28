import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: { contents: `export * from '../src/engine/viaEndpointRefresh.ts'`, resolveDir: resolve(root, 'test'), sourcefile: 'via-endpoint-refresh-entry.ts' },
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { prepareViaEndpointRefresh, refreshViaEndpointLines } = await import(moduleUrl)

const data = (overrides = {}) => ({ netName: 'N1', layerId: 1, startX: 100, startY: 200, endX: 300, endY: 200, width: 12, locked: false, ...overrides })
const records = [
	{ type: 'DOCHEAD', ticket: 0, data: { docType: 'PCB', uuid: 'pcb-via', client: 'before', updateTime: 1, version: '1', editVersion: 4 } },
	{ type: 'LINE', id: 'line-a', ticket: 1, data: data() },
	{ type: 'LINE', id: 'line-b', ticket: 2, data: data({ startX: 400, endX: 100, startY: 200, endY: 200 }) },
	{ type: 'LINE', id: 'middle', ticket: 3, data: data({ startX: 50, endX: 150 }) },
	{ type: 'LINE', id: 'line-c', ticket: 4, data: data({ startX: 100, startY: 200, endX: 500 }) },
	{ type: 'LINE', id: 'near', ticket: 5, data: data({ startX: 110, startY: 210, endX: 100.001, endY: 200.001 }) },
	{ type: 'LINE', id: 'other-net', ticket: 6, data: data({ netName: 'N2', startX: 110, endX: 100 }) },
	{ type: 'LINE', id: 'status-zero-layer', ticket: 7, data: data({ layerId: 3, startX: 110, endX: 100 }) },
	{ type: 'LINE', id: 'status-two-layer', ticket: 8, data: data({ layerId: 2, startX: 110, endX: 100 }) },
	{ type: 'LINE', id: 'unknown-status-layer', ticket: 9, data: data({ layerId: 4, startX: 110, endX: 100 }) },
	{ type: 'ARC', id: 'arc', ticket: 10, data: data({ startX: 110, endX: 100 }) },
	{ type: 'GROUP', id: 'group-1', ticket: 11, data: { members: ['line-a', 'line-b'] } },
	{ type: 'LOCK', id: 'lock-1', ticket: 12, data: { primitiveId: 'line-a', locked: true } },
	{ type: 'ATTACH', id: 'attach-1', ticket: 13, data: { parent: 'line-b', payload: ['keep'] } },
]
const line = (id, values) => ({
	getState_PrimitiveId: () => id,
	getState_Net: () => values.net,
	getState_Layer: () => values.layer,
	getState_StartX: () => values.startX,
	getState_StartY: () => values.startY,
	getState_EndX: () => values.endX,
	getState_EndY: () => values.endY,
	getState_LineWidth: () => values.lineWidth,
	getState_PrimitiveLock: () => values.locked,
})
const sourceOf = entries => entries.map(record => `${JSON.stringify({ type: record.type, ...(record.id ? { id: record.id } : {}), ticket: record.ticket })}||${JSON.stringify(record.data)}|`).join('\n')
const lineMap = new Map(records.filter(record => record.type === 'LINE').map(record => [record.id, {
	net: record.data.netName,
	layer: record.data.layerId,
	startX: record.data.startX,
	startY: record.data.startY,
	endX: record.data.endX,
	endY: record.data.endY,
	lineWidth: record.data.width,
	locked: record.data.locked,
}]))
const enabledLayers = [
	{ id: 1, type: 'SIGNAL', layerStatus: 1 },
	{ id: 2, type: 'SIGNAL', layerStatus: 2 },
	{ id: 3, type: 'SIGNAL', layerStatus: 0 },
	{ id: 4, type: 'SIGNAL' },
]

{
	const fixture = JSON.parse(readFileSync(resolve(root, 'test/fixtures/a9-v067-host-lines.json'), 'utf8'))
	assert.deepEqual(fixture.layers.slice(0, 2).map(layer => [layer.id, layer.layerStatus]), [[1, 1], [2, 1]], 'the real host top and bottom copper layers both report layerStatus 1')
	const hostSource = sourceOf(fixture.records)
	const hostValues = new Map(fixture.records.filter(record => record.type === 'LINE').map(record => [record.id, {
		net: record.data.netName,
		layer: record.data.layerId,
		startX: record.data.startX,
		startY: record.data.startY,
		endX: record.data.endX,
		endY: record.data.endY,
		lineWidth: record.data.width,
		locked: record.data.locked,
	}]))
	const hostGets = []
	const hostSdk = {
		sys_FileManager: { getDocumentSource: async () => hostSource },
		pcb_Layer: { getAllLayers: async () => fixture.layers },
		pcb_PrimitiveLine: { get: async id => { hostGets.push(id); const values = hostValues.get(id); return values ? line(id, values) : undefined } },
	}
	const plan = await prepareViaEndpointRefresh(hostSdk, fixture.via.net, fixture.via.x, fixture.via.y, async (_label, operation) => operation())
	assert.deepEqual(plan.targets.map(target => target.primitiveId), ['8d096c2e6a78fc16', 'f8b71575c9f99977'], 'the preserved v0.20.67 host fixture selects both touching LINE records')
	assert.deepEqual(plan.targets.map(target => [target.net, target.layer, target.lineWidth]), [['+5V', 1, 10.05], ['+5V', 2, 10.05]], 'native netName/layerId/width fields map to the internal target values')
	assert.deepEqual(hostGets, ['8d096c2e6a78fc16', 'f8b71575c9f99977'], 'a non-endpoint segment and status-zero/unknown layers are rejected before getter reads')
}

function setup({ modifyReturn, driftSource = false, ticketDrift = false, docHeadDrift = false, throwModifyAt, delayAt, focusLostAt, readFailureAt, missingCapability = false } = {}) {
	const calls = { source: 0, gets: [], modifies: [], events: [], focus: 0 }
	const original = sourceOf(records)
	const viaRecords = records.filter(record => record.type !== 'DOCHEAD').map(record => ({ ...record, ticket: record.ticket + 1 }))
	viaRecords.unshift({ ...records[0], ticket: 0, data: { ...records[0].data, client: 'after-via', updateTime: 2, version: '2' } })
	viaRecords.push({ type: 'VIA', id: 'via-new', ticket: 11, data: { net: 'N1', layer: 1, x: 100, y: 200 } })
	let currentSource = sourceOf(viaRecords)
	const sdk = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => { calls.focus++; calls.events.push('focus'); return focusLostAt === calls.focus ? { documentType: 3, uuid: 'pcb-other' } : { documentType: 3, uuid: 'pcb-via' } } },
		pcb_Layer: { getAllLayers: async () => { calls.events.push('layers'); return enabledLayers } },
		pcb_PrimitiveLine: {
			get: async id => { calls.gets.push(id); calls.events.push(`get:${id}`); if (readFailureAt === `get:${id}`) throw new Error('getter read failed'); const value = lineMap.get(id); return value ? line(id, value) : undefined },
			modify: async (id, properties) => {
				calls.modifies.push({ id, properties, keys: Object.keys(properties) })
				calls.events.push(`modify:${id}`)
				if (throwModifyAt === id) throw new Error('modify failed')
				if (delayAt === id) await new Promise(resolvePromise => setTimeout(resolvePromise, 30))
				if (driftSource && id === 'line-a') currentSource += `\n${JSON.stringify({ type: 'RULE', id: 'changed', ticket: 20 })}||${JSON.stringify({ changed: true })}|`
				if (ticketDrift && id === 'line-a') currentSource = sourceOf(viaRecords.map(record => record.type === 'LINE' && record.id === id ? { ...record, ticket: record.ticket + 100 } : record))
				if (docHeadDrift && id === 'line-a') currentSource = currentSource.replace('"uuid":"pcb-via"', '"uuid":"pcb-other"')
				return typeof modifyReturn === 'function' ? modifyReturn(id) : modifyReturn === undefined ? { getState_PrimitiveId: () => id } : modifyReturn
			},
		},
		sys_FileManager: { getDocumentSource: async () => { calls.source++; calls.events.push('source'); if (readFailureAt === `source:${calls.source}`) throw new Error('source read failed'); return calls.source === 1 ? original : currentSource } },
	}
	const read = async (_label, operation) => operation()
	const focusCheck = async () => { const focus = await sdk.dmt_SelectControl.getCurrentDocumentInfo(); if (focus?.documentType !== 3 || focus.uuid !== 'pcb-via') throw new Error('focus lost') }
	return { sdk: missingCapability ? { ...sdk, pcb_Layer: undefined } : sdk, calls, read, focusCheck, original, get currentSource() { return currentSource } }
}

{
	const test = setup()
	const plan = await prepareViaEndpointRefresh(test.sdk, 'N1', 100 + Number.EPSILON * 100, 200, test.read)
	assert.equal(plan.status, 'ready')
	assert.deepEqual(plan.targets.map(target => target.primitiveId), ['line-a', 'line-b', 'line-c', 'status-two-layer'], 'only same-net SIGNAL LINE endpoints in status 1 or 2 layers are selected')
	assert.equal(test.calls.gets.includes('middle'), false, 'a via in the middle of a LINE does not select it')
	assert.equal(test.calls.gets.includes('near'), false, '0.001 mil is not treated as endpoint equality')
	assert.equal(test.calls.gets.includes('other-net'), false, 'a nearby line on another net is excluded')
	assert.equal(test.calls.gets.includes('status-zero-layer'), false, 'layerStatus 0 is excluded')
	assert.equal(test.calls.gets.includes('unknown-status-layer'), false, 'missing layerStatus is excluded')
	assert.equal(test.calls.gets.includes('status-two-layer'), true, 'layerStatus 2 is accepted')
	assert.equal(test.calls.gets.includes('arc'), false, 'arcs are excluded')
}

{
	const test = setup()
	const plan = await prepareViaEndpointRefresh(test.sdk, 'N1', 100, 200, test.read)
	const result = await refreshViaEndpointLines(test.sdk, plan, 'via-new', 'N1', 100, 200, test.focusCheck, test.read)
	assert.equal(result.attempted, true)
	assert.deepEqual(result.completedLineIds, ['line-a', 'line-b', 'line-c', 'status-two-layer'], 'LINE refreshes are serial and preserve candidate order')
	assert.deepEqual(test.calls.modifies.map(call => call.id), ['line-a', 'line-b', 'line-c', 'status-two-layer'], 'each selected LINE receives exactly one modify')
	assert.equal(result.creationTicketChanges.length, records.length - 1, 'ticket changes from the via creation are recorded')
	for (const call of test.calls.modifies) {
		assert.deepEqual(call.keys, ['startX', 'startY', 'endX', 'endY'])
		assert.deepEqual(call.properties, { startX: lineMap.get(call.id).startX, startY: lineMap.get(call.id).startY, endX: lineMap.get(call.id).endX, endY: lineMap.get(call.id).endY })
	}
	assert.ok(test.calls.events.indexOf('modify:line-a') < test.calls.events.indexOf('get:line-a', test.calls.events.indexOf('modify:line-a') + 1))
	for (const row of records.filter(record => ['GROUP', 'LOCK', 'ATTACH'].includes(record.type))) assert.ok(test.currentSource.includes(JSON.stringify(row.data)), 'group, lock, and attachment source records remain present')
}

{
	const test = setup({ modifyReturn: id => id === 'line-a' ? { getState_PrimitiveId: () => id } : id === 'line-b' ? null : { getState_PrimitiveId: () => id } })
	const plan = await prepareViaEndpointRefresh(test.sdk, 'N1', 100, 200, test.read)
	await assert.rejects(refreshViaEndpointLines(test.sdk, plan, 'via-new', 'N1', 100, 200, test.focusCheck, test.read), error => {
		assert.deepEqual(error.endpointRefresh.completedLineIds, ['line-a'])
		assert.deepEqual(error.endpointRefresh.results.map(row => row.rawReturnKind), ['object', 'null'])
		return true
	})
	assert.deepEqual(test.calls.modifies.map(call => call.id), ['line-a', 'line-b'], 'a null return stops before the third eligible target')
}

{
	const test = setup({ driftSource: true })
	const plan = await prepareViaEndpointRefresh(test.sdk, 'N1', 100, 200, test.read)
	await assert.rejects(refreshViaEndpointLines(test.sdk, plan, 'via-new', 'N1', 100, 200, test.focusCheck, test.read), error => {
		assert.equal(error.endpointRefresh.completedLineIds.length, 0)
		assert.equal(error.endpointRefresh.results[0].sourcePreserved, false)
		return true
	})
	assert.deepEqual(test.calls.modifies.map(call => call.id), ['line-a'], 'any non-DOCHEAD source change stops subsequent LINE writes')
}

for (const [name, modifyReturn] of [
	['undefined', () => undefined],
	['false', () => false],
	['wrong ID', id => ({ getState_PrimitiveId: () => `${id}-wrong` })],
]) {
	const test = setup({ modifyReturn })
	const plan = await prepareViaEndpointRefresh(test.sdk, 'N1', 100, 200, test.read)
	await assert.rejects(refreshViaEndpointLines(test.sdk, plan, 'via-new', 'N1', 100, 200, test.focusCheck, test.read), error => {
		assert.equal(error.endpointRefresh.completedLineIds.length, 0, `${name} raw return does not complete a line`)
		assert.equal(error.endpointRefresh.results[0].readbackVerified, false)
		return true
	})
	assert.deepEqual(test.calls.modifies.map(call => call.id), ['line-a'], `${name} stops before later endpoint writes`)
}

{
	const test = setup({ throwModifyAt: 'line-a' })
	const plan = await prepareViaEndpointRefresh(test.sdk, 'N1', 100, 200, test.read)
	await assert.rejects(refreshViaEndpointLines(test.sdk, plan, 'via-new', 'N1', 100, 200, test.focusCheck, test.read), error => {
		assert.equal(error.endpointRefresh.results[0].rawReturnKind, 'throw')
		assert.equal(error.endpointRefresh.completedLineIds.length, 0)
		return true
	})
	assert.deepEqual(test.calls.modifies.map(call => call.id), ['line-a'], 'a thrown modify does not proceed to later targets')
}

for (const options of [{ ticketDrift: true }, { docHeadDrift: true }]) {
	const test = setup(options)
	const plan = await prepareViaEndpointRefresh(test.sdk, 'N1', 100, 200, test.read)
	await assert.rejects(refreshViaEndpointLines(test.sdk, plan, 'via-new', 'N1', 100, 200, test.focusCheck, test.read), error => {
		assert.equal(error.endpointRefresh.results[0].sourcePreserved, false, 'refresh-time source comparisons reject ticket or identity changes')
		return true
	})
	assert.deepEqual(test.calls.modifies.map(call => call.id), ['line-a'], 'refresh-time source drift stops later writes')
}

{
	const test = setup({ focusLostAt: 2 })
	const plan = await prepareViaEndpointRefresh(test.sdk, 'N1', 100, 200, test.read)
	await assert.rejects(refreshViaEndpointLines(test.sdk, plan, 'via-new', 'N1', 100, 200, test.focusCheck, test.read), /focus lost/)
	assert.equal(test.calls.modifies.length, 0, 'a focus mismatch prevents all endpoint writes')
}

{
	const test = setup({ missingCapability: true })
	const plan = await prepareViaEndpointRefresh(test.sdk, 'N1', 100, 200, test.read)
	assert.equal(plan.status, 'skipped')
	assert.match(plan.reason, /缺少源码/)
}

console.log('via-endpoint-refresh-regression: all checks passed')
