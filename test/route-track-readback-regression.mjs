import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `import { pcbCommands, executeRouteTrack } from '../src/commands/pcb.ts'; export { pcbCommands, executeRouteTrack }`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'route-track-readback-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { pcbCommands, executeRouteTrack } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const routeTrack = pcbCommands.find(command => command.name === 'pcb.routeTrack').handler

function stateLine({ id = 'line-1', net = 'N1', layer = 1, a = [0, 0], b = [100, 0], width = 10 } = {}) {
	return {
		getState_PrimitiveId: () => id,
		getState_Net: () => net,
		getState_Layer: () => layer,
		getState_StartX: () => a[0],
		getState_StartY: () => a[1],
		getState_EndX: () => b[0],
		getState_EndY: () => b[1],
		getState_LineWidth: () => width,
	}
}

function install(options = {}) {
const calls = { create: [], get: [], enumerate: 0, focus: 0, net: 0 }
	const stored = new Map()
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => {
			calls.focus++
			return { documentType: 3, uuid: calls.focus === options.focusSwitchAt ? 'pcb-other' : (options.documentUuid ?? 'pcb-route-track') }
		} },
		pcb_Net: { getAllNetsName: async () => { calls.net++; return ['N1'] } },
		pcb_PrimitiveLine: {
			create: async (...args) => {
				calls.create.push(args)
				const [net, layer, x1, y1, x2, y2, width] = args
				const id = `candidate-${calls.create.length}`
				const desired = options.createdLine?.(calls.create.length, { id, net, layer, a: [x1, y1], b: [x2, y2], width })
				const item = stateLine({ id, net, layer, a: [x1, y1], b: [x2, y2], width, ...desired })
				if (options.mergedLine) {
					for (const removeId of options.mergedLine.removeIds ?? []) stored.delete(removeId)
					for (const line of options.mergedLine.lines ?? []) stored.set(line.id, stateLine(line))
				}
				else if (options.storeCreated !== false)
					stored.set(id, item)
				return { getState_PrimitiveId: () => id }
			},
			get: async id => {
				calls.get.push(id)
				if (options.getNeverResolves)
					return new Promise(() => {})
				if (options.getThrows)
					throw new Error('readback get failed')
				return options.getOverride ? options.getOverride(id, stored.get(id)) : stored.get(id)
			},
			getAllPrimitiveId: async () => {
				calls.enumerate++
				if (options.enumThrows && calls.create.length)
					throw new Error('ID enumeration failed')
				if (options.enumNeverResolves && calls.create.length)
					return new Promise(() => {})
				return options.enumOverride && calls.create.length ? options.enumOverride([...stored.keys()]) : [...stored.keys()]
			},
		},
	}
	for (const line of options.initialLines ?? [])
		stored.set(line.id, stateLine(line))
	return calls
}

async function rejectedTrack(calls, points = [[0, 0], [100, 0], [200, 0]]) {
	let error
	try { await routeTrack({ net: 'N1', points, width: 10, _timeoutMs: 1000 }) }
	catch (caught) { error = caught }
	assert.ok(error, 'the routeTrack operation should fail')
	assert.equal(error.cause?.partial, true)
	assert.equal(error.cause?.retryable, false)
	return error
}

for (const [label, options] of [
	['get-empty', { storeCreated: false }],
	['enum-missing-id', { enumOverride: () => [] }],
	['enum-dirty-id', { enumOverride: () => ['candidate-1', null] }],
	['get-throws', { getThrows: true }],
	['enum-throws', { enumThrows: true }],
]) {
	const calls = install(options)
	const error = await rejectedTrack(calls)
	assert.equal(error.cause.failedPrimitiveId, 'candidate-1', `${label}: retain uncertain candidate ID separately`)
	assert.deepEqual(error.cause.segmentIds, [], `${label}: an unverified candidate is not reported as successful`)
	assert.equal(error.cause.failedSegmentAttempted, true)
	assert.equal(error.cause.unprocessedSegments, 1)
	assert.equal(calls.create.length, 1, `${label}: do not issue later segments`)
}

for (const [label, mutate] of [
	['wrong-width', fields => ({ ...fields, width: 10.05 })],
	['wrong-readback-id', fields => ({ ...fields, id: 'different-id' })],
	['wrong-endpoint', fields => ({ ...fields, b: [100.01, 0] })],
	['wrong-net', fields => ({ ...fields, net: 'N2' })],
	['wrong-layer', fields => ({ ...fields, layer: 2 })],
	['zero-length-readback', fields => ({ ...fields, b: fields.a })],
]) {
	const calls = install({ createdLine: (_index, fields) => mutate(fields) })
	const error = await rejectedTrack(calls, [[0, 0], [100, 0]])
	assert.equal(error.cause.failedPrimitiveId, 'candidate-1', `${label}: identify the unconfirmed candidate`)
	assert.deepEqual(error.cause.segmentIds, [], `${label}: do not report mismatched geometry as written`)
}

for (const [label, points] of [
	['long-line', [[10, 20], [110, 20]]],
	['minimum-line', [[0, 0], [1, 0]]],
]) {
	const calls = install({ createdLine: (_index, fields) => ({ a: [...fields.b], b: [...fields.a] }) })
	const result = await routeTrack({ net: 'N1', points, width: 10, _timeoutMs: 1000 })
	assert.deepEqual(result.segmentIds, ['candidate-1'], `${label}: a confirmed segment is reported successful`)
	assert.equal(calls.create.length, 1)
	assert.deepEqual(calls.get, ['candidate-1'])
}

{
	const calls = install()
	let error
	try { await routeTrack({ net: 'N1', points: [[0, 0], [50, 0], [50.5, 0]], width: 10, _timeoutMs: 1000 }) }
	catch (caught) { error = caught }
	assert.ok(error, 'all short routeTrack segments are rejected before touching the SDK')
	assert.match(error.message, /相邻段 2/)
	assert.match(error.message, /0\.5 mil 小于最低允许 1 mil/)
	assert.equal(calls.focus, 0, 'minimum-length validation precedes PCB focus reads')
	assert.equal(calls.net, 0, 'minimum-length validation precedes network reads')
	assert.equal(calls.create.length, 0, 'minimum-length validation performs no write')
}

{
	const calls = install()
	const result = await routeTrack({ net: 'N1', points: [[0, 0], [100, 0]], currentA: 1, _timeoutMs: 1000 })
	assert.equal(result.width, 12, 'currentA-derived width is reported')
	assert.deepEqual(calls.create[0].slice(0, 7), ['N1', 1, 0, 0, 100, 0, 12])
	const wrongCurrentWidth = install({ createdLine: (_index, fields) => ({ width: fields.width + 0.05 }) })
	let error
	try { await routeTrack({ net: 'N1', points: [[0, 0], [100, 0]], currentA: 1, _timeoutMs: 1000 }) }
	catch (caught) { error = caught }
	assert.ok(error)
	assert.equal(error.cause.failedPrimitiveId, 'candidate-1')
}

{
	const calls = install({ createdLine: (_index, fields) => ({ width: fields.width }) })
	const result = await routeTrack({ net: 'N1', points: [[0, 0], [100, 0]], _timeoutMs: 1000 })
	assert.deepEqual(result.segmentIds, ['candidate-1'], 'when width is omitted, any finite positive SDK width is accepted without guessing a default')
}

{
	const calls = install({ createdLine: (index, fields) => index === 2 ? { width: 10.05 } : undefined })
	const error = await rejectedTrack(calls, [[0, 0], [100, 0], [200, 0], [300, 0]])
	assert.deepEqual(error.cause.segmentIds, ['candidate-1'], 'only the first verified segment is successful')
	assert.equal(error.cause.failedSegmentIndex, 2)
	assert.equal(error.cause.failedPrimitiveId, 'candidate-2')
	assert.equal(error.cause.unprocessedSegments, 1)
	assert.equal(calls.create.length, 2, 'later segments are not attempted after an unverified second segment')
}

{
	const calls = install({ focusSwitchAt: 3 })
	const error = await rejectedTrack(calls)
	assert.equal(error.cause.failedSegmentIndex, 1)
	assert.equal(error.cause.failedSegmentAttempted, false)
	assert.equal(error.cause.unprocessedSegments, 2)
	assert.deepEqual(error.cause.segmentIds, [])
	assert.equal(error.cause.failedPrimitiveId, undefined)
	assert.equal(calls.create.length, 0, 'a focus rejection immediately before create sends no SDK write')
}

{
	const calls = install({ focusSwitchAt: 9 })
	const error = await rejectedTrack(calls, [[0, 0], [100, 0], [200, 0], [300, 0]])
	assert.equal(error.cause.failedSegmentIndex, 2)
	assert.equal(error.cause.failedSegmentAttempted, false)
	assert.equal(error.cause.unprocessedSegments, 2)
	assert.deepEqual(error.cause.segmentIds, ['candidate-1'])
	assert.equal(error.cause.failedPrimitiveId, undefined)
	assert.equal(calls.create.length, 1, 'a focus rejection before second create preserves the first segment only')
}

{
	const calls = install({ focusSwitchAt: 5 })
	const error = await rejectedTrack(calls, [[0, 0], [100, 0], [200, 0]])
	assert.match(error.message, /焦点已变化/)
	assert.equal(error.cause.failedPrimitiveId, 'candidate-1')
	assert.deepEqual(error.cause.segmentIds, [])
	assert.equal(calls.get.length, 0, 'do not read or continue on a different focused PCB')
	assert.equal(calls.create.length, 1, 'do not create later lines after focus changes')
}

{
	const calls = install({
		initialLines: [{ id: 'old-plus5v', net: 'N1', layer: 1, a: [100, 600], b: [300, 600], width: 10.05 }],
		mergedLine: { removeIds: ['old-plus5v'], lines: [{ id: 'merged-plus5v', net: 'N1', layer: 1, a: [500, 600], b: [100, 600], width: 10.05 }] },
	})
	const result = await routeTrack({ net: 'N1', points: [[300, 600], [500, 600]], width: 10.05, _timeoutMs: 1000 })
	assert.deepEqual(result.segmentIds, ['merged-plus5v'], 'report actual merged geometry IDs instead of the vanished candidate')
	assert.deepEqual(result.mergeNotes, [{ segmentIndex: 1, candidateId: 'candidate-1', actualIds: ['merged-plus5v'] }])
}

{
	const calls = install({
		initialLines: [{ id: 'old-segment', net: 'N1', layer: 1, a: [100, 600], b: [300, 600], width: 10.05 }],
		mergedLine: { removeIds: ['old-segment'], lines: [
			{ id: 'split-left', net: 'N1', layer: 1, a: [100, 600], b: [250, 600], width: 10.05 },
			{ id: 'split-right', net: 'N1', layer: 1, a: [250, 600], b: [500, 600], width: 10.05 },
		] },
	})
	const result = await routeTrack({ net: 'N1', points: [[300, 600], [500, 600]], width: 10.05, _timeoutMs: 1000 })
	assert.deepEqual(result.segmentIds, ['split-left', 'split-right'], 'a split replacement is accepted only when both old and requested intervals are continuously covered')
}

for (const [label, actualLines] of [
	['duplicated-merged-interval', [
		{ id: 'merged-a', net: 'N1', layer: 1, a: [0, 0], b: [200, 0], width: 10 },
		{ id: 'merged-b', net: 'N1', layer: 1, a: [0, 0], b: [200, 0], width: 10 },
	]],
	['overextended-merged-interval', [
		{ id: 'merged-wide', net: 'N1', layer: 1, a: [-500, 0], b: [500, 0], width: 10 },
	]],
]) {
	const calls = install({
		initialLines: [{ id: 'old-touching', net: 'N1', layer: 1, a: [0, 0], b: [100, 0], width: 10 }],
		mergedLine: { removeIds: ['old-touching'], lines: actualLines },
	})
	const error = await rejectedTrack(calls, [[100, 0], [200, 0]])
	assert.match(error.cause.operationError, /无法验证等价合并结果/)
	assert.deepEqual(error.cause.segmentIds, [], `${label}: duplicated or out-of-bounds geometry must not be reported as verified`)
}

{
	const calls = install({
		initialLines: [
			{ id: 'old-local-width-10', net: 'N1', layer: 1, a: [0, 0], b: [100, 0], width: 10 },
			{ id: 'remote-width-20', net: 'N1', layer: 1, a: [1000, 0], b: [1100, 0], width: 20 },
		],
		mergedLine: { removeIds: ['old-local-width-10'], lines: [{ id: 'merged-local-width-10', net: 'N1', layer: 1, a: [0, 0], b: [200, 0], width: 10 }] },
	})
	const result = await routeTrack({ net: 'N1', points: [[100, 0], [200, 0]], width: 10, _timeoutMs: 1000 })
	assert.deepEqual(result.segmentIds, ['merged-local-width-10'], 'remote same-net collinear lines with another width stay outside the merge target')
}

for (const [label, options] of [
	['gap', { initialLines: [{ id: 'old', net: 'N1', layer: 1, a: [100, 600], b: [300, 600], width: 10.05 }], mergedLine: { removeIds: ['old'], lines: [{ id: 'broken', net: 'N1', layer: 1, a: [500, 600], b: [301, 600], width: 10.05 }] } }],
	['wrong-net', { initialLines: [{ id: 'old', net: 'N1', layer: 1, a: [100, 600], b: [300, 600], width: 10.05 }], mergedLine: { removeIds: ['old'], lines: [{ id: 'wrong', net: 'N2', layer: 1, a: [500, 600], b: [100, 600], width: 10.05 }] } }],
	['wrong-width', { initialLines: [{ id: 'old', net: 'N1', layer: 1, a: [100, 600], b: [300, 600], width: 10.05 }], mergedLine: { removeIds: ['old'], lines: [{ id: 'wrong', net: 'N1', layer: 1, a: [500, 600], b: [100, 600], width: 12 }] } }],
]) {
	const calls = install(options)
	const error = await rejectedTrack(calls, [[300, 600], [500, 600]])
	assert.match(error.cause.operationError, /无法验证等价合并结果/)
	assert.deepEqual(error.cause.segmentIds, [], `${label}: an unverified merged result is not reported as successful`)
}

{
	const calls = install({
		initialLines: [
			{ id: 'old-target', net: 'N1', layer: 1, a: [100, 600], b: [300, 600], width: 10.05 },
			{ id: 'non-target', net: 'N2', layer: 1, a: [100, 650], b: [300, 650], width: 10.05 },
		],
		mergedLine: { removeIds: ['old-target', 'non-target'], lines: [{ id: 'merged', net: 'N1', layer: 1, a: [500, 600], b: [100, 600], width: 10.05 }] },
	})
	let error
	try { await routeTrack({ net: 'N1', points: [[300, 600], [500, 600]], width: 10.05, _timeoutMs: 1000 }) }
	catch (caught) { error = caught }
	assert.ok(error)
	assert.equal(error.cause?.partial, true)
	assert.match(error.cause.operationError, /非目标原有线段 non-target 消失/)
	assert.deepEqual(error.cause.segmentIds, [])
}

for (const [label, options] of [
	['get-timeout', { getNeverResolves: true }],
	['enum-timeout', { enumNeverResolves: true }],
]) {
	const calls = install(options)
	const error = await rejectedTrack(calls, [[0, 0], [100, 0], [200, 0]])
	assert.match(error.message, /超出 pcb.routeTrack 共享总时限/)
	assert.equal(error.cause.failedPrimitiveId, 'candidate-1', `${label}: retain the possible write ID`)
	assert.equal(calls.create.length, 1, `${label}: timeout stops later create calls`)
}

{
	const calls = install({ documentUuid: 'pcb-other' })
	let error
	try {
		await executeRouteTrack({ net: 'N1', points: [[0, 0], [100, 0]], width: 10, _timeoutMs: 1000 }, { documentUuid: 'pcb-route-track', deadline: performance.now() + 1000 })
	}
	catch (caught) { error = caught }
	assert.ok(error, 'a directly supplied shared document binding rejects a different initial PCB')
	assert.match(error.message, /初始 PCB 与共享文档不匹配/)
	assert.equal(calls.create.length, 0, 'a mismatched shared PCB is rejected before the first write')
}

{
	const calls = install()
	let error
	try {
		await executeRouteTrack({ net: 'N1', points: [[0, 0], [100, 0]], width: 10, _timeoutMs: 1000 }, { documentUuid: 'pcb-route-track', deadline: performance.now() - 1 })
	}
	catch (caught) { error = caught }
	assert.ok(error, 'an already exhausted shared deadline rejects')
	assert.equal(calls.create.length, 0, 'an exhausted shared deadline sends no write')
}

{
	const calls = install()
	const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance')
	let virtualNow = 0
	Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => virtualNow } })
	try {
		const shared = { documentUuid: 'pcb-route-track', deadline: 100 }
		const first = await executeRouteTrack({ net: 'N1', points: [[0, 0], [100, 0]], width: 10, _timeoutMs: 1000 }, shared)
		assert.deepEqual(first.segmentIds, ['candidate-1'], 'the first side uses the caller supplied shared deadline')
		virtualNow = shared.deadline + 1
		let error
		try { await executeRouteTrack({ net: 'N1', points: [[200, 0], [300, 0]], width: 10, _timeoutMs: 1000 }, shared) }
		catch (caught) { error = caught }
		assert.ok(error, 'the second side observes the same exhausted shared deadline')
		assert.equal(calls.create.length, 1, 'the second side does not reset its timeout and write after the shared deadline')
	}
	finally {
		if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance)
		else delete globalThis.performance
	}
}

console.log('route-track-readback-regression: all checks passed')
