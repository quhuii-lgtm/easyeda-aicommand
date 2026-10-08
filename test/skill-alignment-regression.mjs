import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `
import { pcbCommands } from '../src/commands/pcb.ts'
import { libCommands } from '../src/commands/lib.ts'
import { executeCommand, registerCommand } from '../src/engine/registry.ts'
export { pcbCommands, libCommands, executeCommand, registerCommand }
`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'skill-alignment-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { pcbCommands, libCommands, executeCommand, registerCommand } = await import(moduleUrl)
const handler = name => pcbCommands.find(command => command.name === name).handler
const call = (name, params = {}) => handler(name)(params, { vars: {} })
const state = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [`getState_${key}`, () => value]))
const pourHandler = handler('pcb.listPours')

function withFakeTimers(fn) {
	const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now, performance: Object.getOwnPropertyDescriptor(globalThis, 'performance') }
	let nextId = 0
	let now = 100_000
	const timers = new Map()
	globalThis.setTimeout = (callback, ms) => { const id = ++nextId; timers.set(id, { callback, ms }); return id }
	globalThis.clearTimeout = id => timers.delete(id)
	Date.now = () => now
	Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } })
	return Promise.resolve().then(() => fn({ timers, advance: ms => { now += ms }, fire: id => { const timer = timers.get(id); assert.ok(timer, `timer ${id} exists`); timers.delete(id); now += timer.ms; timer.callback() } })).finally(() => {
		globalThis.setTimeout = saved.setTimeout
		globalThis.clearTimeout = saved.clearTimeout
		Date.now = saved.now
		Object.defineProperty(globalThis, 'performance', saved.performance)
	})
}

async function check(name, fn) {
	try { await fn(); console.log(`PASS ${name}`) }
	catch (error) { console.error(`FAIL ${name}:`, error); process.exitCode = 1 }
}

await check('R1 deviceCreate marks symbolUuid required', async () => {
	const parameter = libCommands.find(command => command.name === 'lib.deviceCreate').params.find(param => param.name === 'symbolUuid')
	assert.equal(parameter.required, true)
})

await check('R2 filled, empty object, absent object, and unknown fill readback', async () => {
	const pours = [
		{ getCopperRegion: async () => ({ getState_PrimitiveId: () => 'fill-1', getState_PourFills: () => [{}] }) },
		{ getCopperRegion: async () => ({ getState_PrimitiveId: () => 'fill-empty', getState_PourFills: () => [] }) },
		{ getCopperRegion: async () => null },
		{ getCopperRegion: async () => { throw new Error('read rejected') } },
		{ getCopperRegion: async () => ({}) },
	]
	globalThis.eda = { pcb_PrimitivePour: { getAll: async () => pours } }
	const rows = await pourHandler({ withFill: true }, { vars: {} })
	assert.deepEqual(rows.map(row => [row.filled, row.fillStatus, row.fillRegions]), [
		[true, 'filled', 1], [false, 'empty', 0], [false, 'empty', 0], [null, 'unknown', undefined], [null, 'unknown', undefined],
	])
	assert.match(rows[3].fillReadError, /read rejected/)
	assert.ok(rows[1].fillPrimitiveId === 'fill-empty')
})

await check('R2 fill timeout and invalid fills become unknown and clear the local timer', async () => {
	await withFakeTimers(async ({ timers, fire }) => {
		globalThis.eda = { pcb_PrimitivePour: { getAll: async () => [
			{ getCopperRegion: () => new Promise(() => {}) },
			{ getCopperRegion: async () => ({ getState_PrimitiveId: () => 'bad', getState_PourFills: () => null }) },
		] } }
		const pending = pourHandler({ withFill: true }, { vars: {} })
		await new Promise(resolve => setImmediate(resolve))
		assert.equal(timers.size, 1)
		fire([...timers.keys()][0])
		const rows = await pending
		assert.equal(rows[0].fillStatus, 'unknown')
		assert.match(rows[0].fillReadError, /超时/)
		assert.equal(rows[1].fillStatus, 'unknown')
		assert.equal(timers.size, 0)
	})
})

await check('R3 rotated rectangular pads, round pads, ellipse and oval use conservative extents', async () => {
	const component = { ...state({ Designator: 'U1', PrimitiveId: 'u1', Layer: 1 }) }
	const pad = (shape, rotation = 0, x = 0, y = 0) => ({ ...state({ X: x, Y: y, Rotation: rotation, Pad: shape }) })
	const pads = [
		pad(['RECT', 20, 10], 45), pad(['RECT', 20, 10], 90, 100, 0), pad(['RECT', 20, 10], 180, 200, 0),
		pad(['RECT', 20, 10], -45, 300, 0), pad(['ELLIPSE', 10, 10], 30, 400, 0),
		pad(['ELLIPSE', 20, 10], 45, 500, 0), pad(['OVAL', 20, 10], 90, 600, 0),
		pad(['OVAL', 10, 20], 0, 800, 0), pad(['OVAL', 10, 20], 45, 900, 0), pad(['NGON', 20, 6], 23, 1000, 0),
	]
	globalThis.eda = { pcb_PrimitiveComponent: { getAll: async () => [component], getAllPinsByPrimitiveId: async () => pads } }
	const result = await call('pcb.checkPlacement')
	assert.equal(result.complete, true)
	assert.equal(result.components.length, 1)
	const bbox = result.components[0].bbox
	assert.ok(bbox.x2 >= 1010 && bbox.x1 <= -10.6, JSON.stringify(bbox))
})

await check('R3 unknown geometry, null and non-finite data skip the component', async () => {
	const component = { ...state({ Designator: 'U2', PrimitiveId: 'u2', Layer: 1 }) }
	const pads = [
		{ ...state({ X: 0, Y: 0, Rotation: 0, Pad: ['RECT', 10, 10] }) },
		{ ...state({ X: null, Y: 0, Rotation: 0, Pad: ['RECT', 10, 10] }) },
	]
	globalThis.eda = { pcb_PrimitiveComponent: { getAll: async () => [component], getAllPinsByPrimitiveId: async () => pads } }
	const result = await call('pcb.checkPlacement')
	assert.equal(result.complete, false)
	assert.equal(result.components.length, 0)
	assert.equal(result.skippedUnsupported[0].designator, 'U2')
	assert.match(result.skippedUnsupported[0].reason, /坐标/)
})

await check('R3 fractional 0.1 mil overlap is reported without rounding it to zero', async () => {
	const components = [
		{ ...state({ Designator: 'R1', PrimitiveId: 'r1', Layer: 1 }) },
		{ ...state({ Designator: 'R2', PrimitiveId: 'r2', Layer: 1 }) },
	]
	const byId = {
		r1: [{ ...state({ X: 0, Y: 0, Rotation: 0, Pad: ['RECT', 1, 1] }) }],
		r2: [{ ...state({ X: 0.9, Y: 0, Rotation: 0, Pad: ['RECT', 1, 1] }) }],
	}
	globalThis.eda = { pcb_PrimitiveComponent: { getAll: async () => components, getAllPinsByPrimitiveId: async id => byId[id] } }
	const result = await call('pcb.checkPlacement')
	assert.equal(result.overlaps.length, 1)
	assert.ok(Math.abs(result.overlaps[0].overlapX - 0.1) < 1e-9, JSON.stringify(result.overlaps[0]))
})

await check('R3 NGON edge count and non-positive dimensions are unsupported', async () => {
	const component = { ...state({ Designator: 'U3', PrimitiveId: 'u3', Layer: 1 }) }
	const pads = [
		{ ...state({ X: 0, Y: 0, Rotation: 0, Pad: ['NGON', 10, 2] }) },
	]
	globalThis.eda = { pcb_PrimitiveComponent: { getAll: async () => [component], getAllPinsByPrimitiveId: async () => pads } }
	const result = await call('pcb.checkPlacement')
	assert.equal(result.complete, false)
	assert.match(result.skippedUnsupported[0].reason, /NGON 边数/)
})

function routeMock(outcomes) {
	let createCount = 0
	let resolvePending
	globalThis.eda = {
		pcb_Net: { getAllNetsName: async () => ['N'] },
		pcb_PrimitiveLine: { create: (...args) => {
			assert.equal(args[0], 'N')
			const outcome = outcomes[createCount++]
			if (outcome === 'hang') return new Promise(() => {})
			if (outcome === 'deferred') return new Promise(resolve => { resolvePending = resolve })
			if (outcome instanceof Error) return Promise.reject(outcome)
			if (outcome === null) return Promise.resolve(null)
			if (outcome === 'missing') return Promise.resolve({ getState_PrimitiveId: () => undefined })
			if (typeof outcome === 'function') return outcome()
			return Promise.resolve({ getState_PrimitiveId: () => outcome ?? `seg-${createCount}` })
		} },
	}
	const count = () => createCount
	count.resolvePending = value => resolvePending?.({ getState_PrimitiveId: () => value })
	return count
}
const routeParams = { net: 'N', points: [[0, 0], [1, 0], [2, 0], [3, 0]], width: 1 }

await check('R4 routeTrack success returns all IDs and preserves width', async () => {
	const count = routeMock(['a', 'b', 'c'])
	assert.deepEqual(await call('pcb.routeTrack', routeParams), { segmentIds: ['a', 'b', 'c'], width: 1 })
	assert.equal(count(), 3)
})

await check('R4 first, middle, and final rejected writes preserve partial evidence and stop', async () => {
	for (const [outcomes, failedIndex, unprocessed, ids] of [
		[[new Error('first')], 1, 2, []],
		[['one', new Error('middle')], 2, 1, ['one']],
		[['one', 'two', new Error('last')], 3, 0, ['one', 'two']],
	]) {
		const count = routeMock(outcomes)
		await assert.rejects(call('pcb.routeTrack', routeParams), error => {
			assert.equal(error.cause.partial, true)
			assert.equal(error.cause.retryable, false)
			assert.equal(error.cause.failedSegmentIndex, failedIndex)
			assert.equal(error.cause.unprocessedSegments, unprocessed)
			assert.deepEqual(error.cause.segmentIds, ids)
			return true
		})
		assert.equal(count(), failedIndex)
	}
})

await check('R4 empty and missing-ID results are partial and halt subsequent writes', async () => {
	for (const [outcome, expectedCount] of [[null, 1], ['missing', 1]]) {
		const count = routeMock([outcome, 'should-not-run'])
		await assert.rejects(call('pcb.routeTrack', routeParams), error => error.cause?.partial === true)
		assert.equal(count(), expectedCount)
	}
})

await check('R4 local timeout rejects a pending segment, keeps timer cleanup and prevents late continuation', async () => {
	await withFakeTimers(async ({ timers, fire }) => {
		const count = routeMock(['one', 'hang', 'should-not-run'])
		const pending = call('pcb.routeTrack', { ...routeParams, _timeoutMs: 1000 })
		await new Promise(resolve => setImmediate(resolve))
		await new Promise(resolve => setImmediate(resolve))
		assert.equal(count(), 2)
		const timerId = [...timers.keys()][0]
		fire(timerId)
		await assert.rejects(pending, error => error.cause?.partial === true && error.cause.segmentIds[0] === 'one')
		assert.equal(count(), 2)
		assert.equal(timers.size, 0)
	})
})

await check('R4 handler deadline consumed by read-only net check prevents the first write', async () => {
	await withFakeTimers(async ({ timers, advance }) => {
		let creates = 0
		globalThis.eda = {
			pcb_Net: { getAllNetsName: async () => { advance(1000); return ['N'] } },
			pcb_PrimitiveLine: { create: async () => { creates++; return { getState_PrimitiveId: () => 'late' } } },
		}
		await assert.rejects(call('pcb.routeTrack', { ...routeParams, _timeoutMs: 1000 }), /写入前超出总时限/)
		assert.equal(creates, 0)
		assert.equal(timers.size, 0)
	})
})

await check('R4 a returned ID is retained when the deadline expires during readback and no next segment starts', async () => {
	await withFakeTimers(async ({ advance }) => {
		let creates = 0
		globalThis.eda = {
			pcb_Net: { getAllNetsName: async () => ['N'] },
			pcb_PrimitiveLine: { create: async () => { creates++; return { getState_PrimitiveId: () => { advance(1000); return 'known-first' } } } },
		}
		await assert.rejects(call('pcb.routeTrack', { ...routeParams, _timeoutMs: 1000 }), error => {
			assert.deepEqual(error.cause.segmentIds, ['known-first'])
			assert.equal(error.cause.failedSegmentIndex, 1)
			return error.cause.partial === true
		})
		assert.equal(creates, 1)
	})
})

await check('R4 registry outer fuse and handler timer both halt later segment writes', async () => {
	for (const timeoutChoice of ['outer', 'handler']) {
		await withFakeTimers(async ({ timers, fire }) => {
			const count = routeMock(['one', 'deferred', 'should-not-run'])
			globalThis.eda.dmt_SelectControl = { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb' }) }
			registerCommand(pcbCommands.find(command => command.name === 'pcb.routeTrack'))
			const pending = executeCommand({ cmd: 'pcb.routeTrack', params: { ...routeParams, _timeoutMs: 1000 } })
			for (let i = 0; i < 4 && count() < 2; i++) await new Promise(resolve => setImmediate(resolve))
			assert.equal(count(), 2)
			const timerEntries = [...timers.entries()]
			const timerId = timeoutChoice === 'outer' ? timerEntries[0]?.[0] : timerEntries.at(-1)?.[0]
			fire(timerId)
			const result = await pending
			assert.equal(result.ok, false)
			if (timeoutChoice === 'outer') {
				count.resolvePending('late-second')
				await new Promise(resolve => setImmediate(resolve))
			}
			await new Promise(resolve => setImmediate(resolve))
			assert.equal(count(), 2)
		})
	}
})

await check('R4 partial routeTrack stops real macro even when stopOnError is false', async () => {
	const count = routeMock(['one', new Error('middle')])
	globalThis.eda.dmt_SelectControl = { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'pcb' }) }
	registerCommand(pcbCommands.find(command => command.name === 'pcb.routeTrack'))
	let writes = 0
	registerCommand({ name: 'test.markerWrite', summary: 'test', params: [], returns: '', handler: async () => { writes++; return true } })
	const result = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
		{ cmd: 'pcb.routeTrack', params: routeParams }, { cmd: 'test.markerWrite' },
	] } })
	assert.equal(result.ok, false)
	assert.equal(result.error.cause.partial, true)
	assert.equal(result.data.stoppedReason, 'partial')
	assert.equal(result.data.unexecutedSteps, 1)
	assert.equal(count(), 2)
	assert.equal(writes, 0)
})

if (process.exitCode) process.exit(process.exitCode)
console.log('PASS skill alignment R1-R4 handler and shared macro regressions')
