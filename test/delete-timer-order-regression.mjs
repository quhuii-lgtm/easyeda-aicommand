import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `
import { schematicCommands } from '../src/commands/schematic.ts'
export { schematicCommands }
`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'delete-timer-order-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { schematicCommands } = await import(moduleUrl)
const command = schematicCommands.find(item => item.name === 'schematic.delete').handler

async function withCoalescedTimers(fn) {
	const originalSetTimeout = globalThis.setTimeout
	const originalClearTimeout = globalThis.clearTimeout
	const originalDateNow = Date.now
	const originalPerformanceNow = performance.now
	const timers = new Map()
	let now = 0
	let nextId = 1
	let deleteCalls = 0
	globalThis.setTimeout = (callback, ms = 0, ...args) => {
		const due = deleteCalls >= 4 ? Math.ceil((now + ms) / 60000) * 60000 : now + ms
		const id = nextId++
		timers.set(id, { id, due, callback: () => callback(...args) })
		return id
	}
	globalThis.clearTimeout = id => timers.delete(id)
	Date.now = () => now
	performance.now = () => now
	const fireNext = async () => {
		const next = [...timers.values()].sort((a, b) => a.due - b.due || a.id - b.id)[0]
		if (!next) return false
		timers.delete(next.id)
		now = next.due
		next.callback()
		await Promise.resolve()
		await new Promise(resolve => originalSetTimeout(resolve, 0))
		await Promise.resolve()
		return true
	}
	try { await fn({ timers, fireNext, get now() { return now }, countDelete: () => ++deleteCalls }) }
	finally {
		globalThis.setTimeout = originalSetTimeout
		globalThis.clearTimeout = originalClearTimeout
		Date.now = originalDateNow
		performance.now = originalPerformanceNow
	}
}

function makeEda({ hangFourth = false, throwPostDeleteReadback = false, disappearOnDelayedReadback = false } = {}) {
	const wires = new Set(['wire-1', 'wire-2', 'wire-3', 'wire-4', 'wire-5'])
	let deletes = 0
	let wireReadbacksAfterDelete = 0
	let probeCreates = 0
	globalThis.eda = {
		sys_FileManager: { getDocumentSource: async () => '|' },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'doc-A' }) },
		sch_PrimitiveComponent: { getAllPrimitiveId: async () => [], delete: async () => true },
		sch_PrimitiveWire: {
			getAllPrimitiveId: async () => {
				if (throwPostDeleteReadback && deletes > 0) throw new Error('post-delete readback failed')
				if (disappearOnDelayedReadback && deletes > 0 && ++wireReadbacksAfterDelete >= 2) return []
				return [...wires]
			},
			delete: async ids => {
				deletes++
				globalThis.__timerDeleteCounter()
				if (!disappearOnDelayedReadback || deletes > 1)
					for (const id of ids) wires.delete(id)
				if (hangFourth && deletes === 4) return new Promise(() => {})
				return true
			},
			create: async () => { probeCreates++; throw new Error('probe must not run after unknown write') },
		},
		sch_PrimitiveText: { getAllPrimitiveId: async () => [] },
		sch_PrimitiveRectangle: { getAllPrimitiveId: async () => [], delete: async () => true },
		sch_PrimitiveAttribute: { getAllPrimitiveId: async () => [], getAll: async () => [], get: async () => undefined },
	}
	return { get deletes() { return deletes }, get probeCreates() { return probeCreates }, wires }
}

async function driveUntilSettled(promise, fireNext, limit = 250) {
	let settled = false
	let value
	let error
	promise.then(result => { settled = true; value = result }, cause => { settled = true; error = cause })
	for (let i = 0; i < limit && !settled; i++) {
		await Promise.resolve()
		await new Promise(resolve => setImmediate(resolve))
		if (!settled && !(await fireNext()))
			break
	}
	assert.equal(settled, true, 'delete command should settle while virtual timers are advanced')
	if (error) throw error
	return value
}

await withCoalescedTimers(async ({ timers, fireNext, countDelete }) => {
	globalThis.__timerDeleteCounter = countDelete
	const state = makeEda()
	const result = await driveUntilSettled(command({ primitiveIds: [...state.wires] }, {}), fireNext)
	assert.deepEqual(result.deleted, ['wire-1', 'wire-2', 'wire-3', 'wire-4', 'wire-5'])
	assert.deepEqual(result.failed, [])
	assert.equal(state.deletes, 5)
	assert.equal(timers.size, 0, 'successful item timers and withTimeout timers are cleared')
})

await withCoalescedTimers(async ({ timers, fireNext, countDelete }) => {
	globalThis.__timerDeleteCounter = countDelete
	const state = makeEda({ disappearOnDelayedReadback: true })
	const result = await driveUntilSettled(command({ primitiveIds: ['wire-1'] }, {}), fireNext)
	assert.deepEqual(result.deleted, ['wire-1'], 'a present immediate readback is rechecked after the existing delay')
	assert.equal(result.outcomeBy['wire-1'], 'directDeleted')
	assert.equal(state.deletes, 1)
	assert.equal(timers.size, 0)
})

await withCoalescedTimers(async ({ timers, fireNext, countDelete }) => {
	globalThis.__timerDeleteCounter = countDelete
	const state = makeEda({ hangFourth: true })
	let error
	try { await driveUntilSettled(command({ primitiveIds: [...state.wires] }, {}), fireNext) }
	catch (cause) { error = cause }
	assert.ok(error, 'a genuinely hung fourth SDK delete remains unknown')
	assert.equal(error.cause?.result?.outcomeBy?.['wire-4'], 'unknown')
	assert.deepEqual(error.cause?.result?.deleted, ['wire-1', 'wire-2', 'wire-3'])
	assert.deepEqual(error.cause?.result?.unprocessed, ['wire-5'])
	assert.equal(state.deletes, 4, 'the fifth delete must not be issued after a hung fourth write')
	assert.equal(state.probeCreates, 0, 'unknown write skips the health probe write')
	assert.equal(timers.size, 0, 'timeout and withTimeout timers are cleared after partial completion')
})

await withCoalescedTimers(async ({ timers, fireNext, countDelete }) => {
	globalThis.__timerDeleteCounter = countDelete
	const state = makeEda({ throwPostDeleteReadback: true })
	let error
	try { await driveUntilSettled(command({ primitiveIds: [...state.wires] }, {}), fireNext) }
	catch (cause) { error = cause }
	assert.ok(error, 'post-delete readback exceptions remain unknown')
	assert.equal(error.cause?.result?.outcomeBy?.['wire-1'], 'unknown')
	assert.equal(state.deletes, 1, 'readback uncertainty stops following deletes')
	assert.equal(state.probeCreates, 0, 'readback uncertainty skips probe writes')
	assert.equal(timers.size, 0)
})

console.log('PASS merged-timer fourth delete ordering, hung-write stop, readback uncertainty, and timer cleanup')
