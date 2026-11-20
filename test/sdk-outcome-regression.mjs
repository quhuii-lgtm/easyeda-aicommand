import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `
import { pcbCommands } from '../src/commands/pcb.ts'
import { editorCommands } from '../src/commands/editor.ts'
import { systemCommands } from '../src/commands/system.ts'
import { executeCommand, registerCommand } from '../src/engine/registry.ts'
export { pcbCommands, editorCommands, systemCommands, executeCommand, registerCommand }
`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'sdk-outcome-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { pcbCommands, editorCommands, systemCommands, executeCommand, registerCommand } = await import(moduleUrl)
for (const command of [...pcbCommands, ...editorCommands, ...systemCommands]) registerCommand(command)
let checks = 0

let markerWrites = 0
registerCommand({
	name: 'test.markerWrite', summary: 'marker', params: [], returns: '{}',
	handler: async () => { markerWrites++; return { written: true } },
})

const realSetTimeout = globalThis.setTimeout
const realPerformanceNow = performance.now.bind(performance)
let fakeNow = realPerformanceNow()
async function withFakeTimeouts(fn) {
	let shortFuseIgnored = false
	globalThis.setTimeout = (callback, _ms, ...args) => {
		// registry's outer command fuse is separate from the handler timer; allow the
		// handler's shorter rebuild timer to win so its structured partial result is tested.
		if (_ms > 240000 || (_ms >= 990 && _ms <= 1000 && !shortFuseIgnored)) {
			if (_ms >= 990 && _ms <= 1000) shortFuseIgnored = true
			return 0
		}
		setImmediate(() => callback(...args))
		return 0
	}
	Object.defineProperty(performance, 'now', { configurable: true, value: () => fakeNow })
	try { await fn() }
	finally {
		globalThis.setTimeout = realSetTimeout
		Object.defineProperty(performance, 'now', { configurable: true, value: realPerformanceNow })
	}
}

function fill(id = 'fill-old', regions = [{}]) {
	return {
		getState_PrimitiveId: () => id,
		getState_PourFills: () => regions,
	}
}

function pour(id, { before, after, rebuild } = {}) {
	let reads = 0
	return {
		getState_PrimitiveId: () => id,
		getState_Net: () => 'GND',
		getState_Layer: () => 1,
		getCopperRegion: async () => {
			reads++
			if (typeof after === 'function' && reads > 1) return after()
			return reads === 1 ? before : after
		},
		rebuildCopperRegion: rebuild ?? (async () => fill(`new-${id}`)),
	}
}

async function runMacro(cmd, params, stopOnError = false) {
	markerWrites = 0
	globalThis.eda.dmt_SelectControl ??= { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'doc-pcb' }) }
	return executeCommand({ cmd: 'macro', params: {
		stopOnError,
		steps: [{ cmd, params }, { cmd: 'test.markerWrite' }],
	} })
}

async function check(name, fn) {
	await fn()
	checks++
	console.log(`PASS ${name}`)
}

await withFakeTimeouts(async () => {
	await check('unsupported system.eval is absent while task status commands remain', async () => {
		assert.equal(systemCommands.some(command => command.name === 'system.eval'), false)
		assert.deepEqual(systemCommands.map(command => command.name), ['task.get', 'task.list'])
	})
	await check('single-pour timeout is partial and blocks macro continuation', async () => {
		const p = pour('pour-1', { rebuild: () => new Promise(() => {}) })
		globalThis.eda = { pcb_PrimitivePour: { get: async () => p } }
		const result = await runMacro('pcb.rebuildPour', { primitiveId: 'pour-1' })
		const failure = result.data.steps[0]
		assert.equal(result.ok, false)
		assert.equal(failure.ok, false)
		assert.equal(failure.error.cause?.partial, true, JSON.stringify(failure))
		assert.equal(failure.error.cause.result.status, 'timeout')
		assert.equal(markerWrites, 0)
	})

	await check('static whole-board timeout is partial and blocks macro continuation', async () => {
		const old = fill()
		globalThis.eda = {
			pcb_PrimitivePoured: { getAll: async () => [old] },
			pcb_PrimitivePour: { getAll: async () => [], rebuildCopperRegions: () => new Promise(() => {}) },
		}
		const result = await runMacro('pcb.rebuildPour', {})
		const failure = result.data.steps[0]
		assert.equal(failure.ok, false)
		assert.equal(failure.error.cause.partial, true)
		assert.equal(failure.error.cause.result.status, 'timeout')
		assert.equal(markerWrites, 0)
	})

	await check('invalid _timeoutMs values reject before any SDK write', async () => {
		for (const timeout of [Number.NaN, Number.POSITIVE_INFINITY, 2147483648]) {
			let writeCalls = 0
			globalThis.eda = {
				pcb_PrimitivePour: { get: async () => { writeCalls++; return undefined } },
				pcb_PrimitivePoured: { getAll: async () => [] },
				dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3 }) },
			}
			const result = await executeCommand({ cmd: 'pcb.rebuildPour', params: { _timeoutMs: timeout, primitiveId: 'pour-1' } })
			assert.equal(result.ok, false)
			assert.match(result.error.message, /_timeoutMs/)
			assert.equal(writeCalls, 0)
		}
	})

	await check('fallback timeout stops before rebuilding later pours', async () => {
		let secondCalls = 0
		const first = pour('pour-1', { rebuild: () => new Promise(() => {}) })
		const second = pour('pour-2', { rebuild: async () => { secondCalls++; return fill('new-2') } })
		globalThis.eda = {
			pcb_PrimitivePoured: { getAll: async () => [] },
			pcb_PrimitivePour: { getAll: async () => [first, second] },
		}
		const result = await runMacro('pcb.rebuildPour', {})
		const failure = result.data.steps[0]
		assert.equal(failure.error.cause.partial, true)
		assert.equal(failure.error.cause.result.status, 'timeout')
		assert.equal(secondCalls, 0)
		assert.equal(markerWrites, 0)
	})

	await check('fallback cumulative deadline and short _timeoutMs prevent a late second write', async () => {
		let secondCalls = 0
		const first = pour('pour-1', { rebuild: async () => { fakeNow += 1100; return fill('new-1') } })
		const second = pour('pour-2', { rebuild: async () => { secondCalls++; return fill('new-2') } })
		globalThis.eda = {
			pcb_PrimitivePoured: { getAll: async () => [] },
			pcb_PrimitivePour: { getAll: async () => [first, second] },
		}
		const result = await runMacro('pcb.rebuildPour', { _timeoutMs: 1000 })
		const failure = result.data.steps[0]
		assert.equal(failure.ok, false)
		assert.equal(failure.error.cause.partial, true)
		assert.equal(failure.error.cause.result.status, 'timeout')
		assert.equal(secondCalls, 0)
		assert.equal(markerWrites, 0)
	})

	await check('rejected single-pour write with an old fill remains failure and preserves SDK error', async () => {
		const old = fill()
		const p = pour('pour-1', { before: old, after: old, rebuild: async () => { throw new Error('SDK write rejected') } })
		globalThis.eda = { pcb_PrimitivePour: { get: async () => p } }
		const result = await runMacro('pcb.rebuildPour', { primitiveId: 'pour-1' })
		const failure = result.data.steps[0]
		assert.equal(failure.ok, false)
		assert.equal(failure.error.cause.partial, true)
		assert.match(failure.error.message, /SDK write rejected/)
		assert.equal(failure.data, undefined)
		assert.equal(markerWrites, 0)
	})

	await check('rejected static rebuild with old fills remains failure', async () => {
		const old = fill()
		globalThis.eda = {
			pcb_PrimitivePoured: { getAll: async () => [old] },
			pcb_PrimitivePour: { getAll: async () => [], rebuildCopperRegions: async () => { throw new Error('static SDK rejection') } },
		}
		const result = await runMacro('pcb.rebuildPour', {})
		const failure = result.data.steps[0]
		assert.equal(failure.ok, false)
		assert.equal(failure.error.cause.partial, true)
		assert.match(failure.error.message, /static SDK rejection/)
		assert.equal(markerWrites, 0)
	})

	await check('readback failure after a successful write is partial and blocks macro continuation', async () => {
		const p = pour('pour-1', { after: () => { throw new Error('readback unavailable') } })
		globalThis.eda = { pcb_PrimitivePour: { get: async () => p } }
		const result = await runMacro('pcb.rebuildPour', { primitiveId: 'pour-1' })
		const failure = result.data.steps[0]
		assert.equal(failure.ok, false)
		assert.equal(failure.error.cause.partial, true)
		assert.match(failure.error.message, /readback unavailable/)
		assert.equal(markerWrites, 0)
	})

	await check('valid single-pour completion and healthy macro continuation are preserved', async () => {
		const p = pour('pour-1', { before: undefined, after: fill('new-fill') })
		globalThis.eda = { pcb_PrimitivePour: { get: async () => p } }
		const result = await runMacro('pcb.rebuildPour', { primitiveId: 'pour-1' })
		assert.equal(result.ok, true)
		assert.equal(result.data.steps[0].data.status, 'completed')
		assert.equal(result.data.steps[0].data.freshnessVerified, false)
		assert.equal(markerWrites, 1)
	})

	await check('UUID close accepts the documented editor tree and confirms explicit absence', async () => {
		let reads = 0
		globalThis.eda = { dmt_EditorControl: {
			getSplitScreenTree: async () => ++reads === 1
				? { id: 'editor-window-main', tabs: [{ tabId: 'doc-1@project-1' }] }
				: { id: 'editor-window-main', tabs: [] },
			closeDocument: async tabId => { assert.equal(tabId, 'doc-1@project-1'); return true },
		} }
		const result = await executeCommand({ cmd: 'editor.closeDocument', params: { uuid: 'doc-1' } })
		assert.equal(result.ok, true)
		assert.deepEqual(result.data, { tabId: 'doc-1@project-1', closed: true, sdkResult: true })
	})

	await check('unknown close readback is partial and blocks macro continuation', async () => {
		let reads = 0
		globalThis.eda = { dmt_EditorControl: {
			closeDocument: async () => true,
			getSplitScreenTree: async () => ++reads === 1 ? { id: 'editor-window-main', tabs: [{ tabId: 'doc-1@project-1' }] } : undefined,
		} }
		const result = await runMacro('editor.closeDocument', { tabId: 'doc-1@project-1' })
		const failure = result.data.steps[0]
		assert.equal(failure.ok, false)
		assert.equal(failure.error.cause.partial, true)
		assert.equal(markerWrites, 0)
	})

	await check('rejected and malformed close trees all remain partial', async () => {
		const unknownTrees = [
			async () => { throw new Error('tree read rejected') },
			async () => undefined,
			async () => null,
			async () => ({}),
			async () => ({ id: 'editor-window-main', tabs: null }),
		]
		for (const getSplitScreenTree of unknownTrees) {
			globalThis.eda = { dmt_EditorControl: { closeDocument: async () => true, getSplitScreenTree } }
			const result = await runMacro('editor.closeDocument', { tabId: 'doc-1@project-1' })
			const failure = result.data.steps[0]
			assert.equal(failure.ok, false)
			assert.equal(failure.error.cause.partial, true)
			assert.equal(markerWrites, 0)
		}
	})

	await check('SDK false with a valid tree still containing the tab fails immediately without partial write protection', async () => {
		let reads = 0
		globalThis.eda = { dmt_EditorControl: {
			closeDocument: async () => false,
			getSplitScreenTree: async () => { reads++; return { id: 'editor-window-main', tabs: [{ tabId: 'doc-1@project-1' }] } },
		} }
		const result = await executeCommand({ cmd: 'editor.closeDocument', params: { tabId: 'doc-1@project-1', _timeoutMs: 2000 } })
		assert.equal(result.ok, false)
		assert.equal(result.error.cause.partial, false)
		assert.deepEqual(result.error.cause.result, { tabId: 'doc-1@project-1', closed: false, sdkResult: false, treeContainsTab: true })
		assert.equal(reads, 1)
	})

	await check('SDK false with a valid tree already missing the tab satisfies the postcondition and macro continues', async () => {
		markerWrites = 0
		globalThis.eda = { dmt_EditorControl: {
			closeDocument: async () => false,
			getSplitScreenTree: async () => ({ id: 'editor-window-main', tabs: [] }),
		} }
		const result = await runMacro('editor.closeDocument', { tabId: 'doc-1@project-1' })
		assert.equal(result.ok, true)
		assert.deepEqual(result.data.steps[0].data, { tabId: 'doc-1@project-1', closed: true, sdkResult: false })
		assert.equal(markerWrites, 1)
	})

	await check('SDK true waits for the tab to disappear and calls closeDocument once', async () => {
		const startFakeNow = fakeNow
		const realTimer = globalThis.setTimeout
		let reads = 0
		let closeCalls = 0
		globalThis.setTimeout = (callback, delay, ...args) => {
			if (delay >= 2000)
				return realTimer(callback, delay, ...args)
			setImmediate(() => { fakeNow += delay; callback(...args) })
			return 0
		}
		globalThis.eda = { dmt_EditorControl: {
			closeDocument: async () => { closeCalls++; return true },
			getSplitScreenTree: async () => ++reads === 1
				? { id: 'editor-window-main', tabs: [{ tabId: 'doc-1@project-1' }] }
				: { id: 'editor-window-main', tabs: [] },
		} }
		try {
			const result = await editorCommands.find(command => command.name === 'editor.closeDocument').handler({ tabId: 'doc-1@project-1', _timeoutMs: 2000 })
			assert.deepEqual(result, { tabId: 'doc-1@project-1', closed: true, sdkResult: true })
			assert.equal(reads, 2)
			assert.equal(closeCalls, 1)
		}
		finally {
			fakeNow = startFakeNow
			globalThis.setTimeout = realTimer
		}
	})

	await check('UUID lookup and SDK close duration consume the same handler-start budget', async () => {
		const startFakeNow = fakeNow
		let reads = 0
		let closeCalls = 0
		globalThis.eda = { dmt_EditorControl: {
			getSplitScreenTree: async () => {
				reads++
				fakeNow = startFakeNow + 1200
				return { id: 'editor-window-main', tabs: [{ tabId: 'doc-1@project-1' }] }
			},
			closeDocument: async () => { closeCalls++; fakeNow = startFakeNow + 2100; return true },
		} }
		try {
			const result = await executeCommand({ cmd: 'editor.closeDocument', params: { uuid: 'doc-1', _timeoutMs: 2000 } })
			assert.equal(result.ok, false)
			assert.equal(result.error.cause.partial, true)
			assert.equal(result.error.cause.result.closed, 'unknown')
			assert.equal(reads, 1)
			assert.equal(closeCalls, 1)
		}
		finally {
			fakeNow = startFakeNow
		}
	})
})

const copperBefore = { items: [], total: 0, hasMore: false }
const copperAfter = {
	items: [{
		primitiveId: 'rate590e885e14',
		net: 'N_3V3',
		start: { x: 1201.2783, y: 17.1347 },
		end: { x: 1310, y: -242.04 },
		startId: 'e590',
		endId: 'e885e14',
		length: 281.05503583992237,
		locked: false,
	}],
	total: 1,
	hasMore: false,
}

function copperHost(before, after) {
	let writes = 0
	let ratlineReads = 0
	const rebuilt = fill('fill-after', [{ fill: true }])
	const p = pour('pour-1', { before: rebuilt, after: rebuilt, rebuild: async () => { writes++; return rebuilt } })
	globalThis.eda = {
		pcb_Net: { getAllNetsName: async () => ['N_3V3', 'N_GND', 'N_BOOT0'] },
		pcb_Document: { getRatlines: async options => {
			ratlineReads++
			const value = writes === 0 ? before : after
			return typeof value === 'function' ? value(options) : value
		} },
		pcb_PrimitivePour: { getAll: async () => [p], get: async () => p },
		pcb_PrimitivePoured: { getAll: async () => [rebuilt] },
	}
	return { get writes() { return writes }, get ratlineReads() { return ratlineReads } }
}

await check('CP66 repour replay stops a following write when 3.3 V breaks', async () => {
	const host = copperHost(copperBefore, copperAfter)
	const result = await runMacro('pcb.rebuildPour', { protectNets: ['N_3V3', 'N_GND'] })
	const failure = result.data.steps[0]
	assert.equal(result.ok, false)
	assert.equal(failure.error.cause.partial, true)
	assert.equal(failure.error.cause.connectivity.status, 'new-ratlines')
	assert.equal(failure.error.cause.connectivity.addedRatlines[0].endId, 'e885e14')
	assert.equal(host.writes, 1)
	assert.equal(markerWrites, 0)
})

await check('unchanged protected endpoint pair survives new ID, swapped endpoints and unrelated signal flyline', async () => {
	const item = copperAfter.items[0]
	const flipped = { ...item, primitiveId: 'replacement', startId: item.endId, endId: item.startId, start: item.end, end: item.start }
	const after = ({ cursor }) => cursor === 'page-2'
		? { items: [{ ...item, net: 'N_BOOT0' }], total: 2, hasMore: false }
		: { items: [flipped], total: 2, hasMore: true, nextCursor: 'page-2' }
	const host = copperHost(copperAfter, after)
	const result = await runMacro('pcb.rebuildPour', { protectNets: ['N_3V3'], primitiveId: 'pour-1' })
	assert.equal(result.ok, true)
	assert.equal(result.data.steps[0].data.connectivity.status, 'no-new-ratlines')
	assert.equal(host.writes, 1)
	assert.equal(host.ratlineReads, 3)
	assert.equal(markerWrites, 1)
})

await check('bad read before repour makes zero writes, bad read after stops dependent writes', async () => {
	const bad = { items: [], total: 1, hasMore: false }
	const before = copperHost(bad, copperBefore)
	const refused = await runMacro('pcb.rebuildPour', { protectNets: ['N_3V3'] }, true)
	assert.equal(refused.ok, false)
	assert.equal(before.writes, 0)
	const after = copperHost(copperBefore, bad)
	const partial = await runMacro('pcb.rebuildPour', { protectNets: ['N_3V3'] })
	assert.equal(partial.data.steps[0].error.cause.phase, 'copper-connectivity-after')
	assert.equal(after.writes, 1)
	assert.equal(markerWrites, 0)
})

await check('unknown protection network rejected before rebuild', async () => {
	const host = copperHost(copperBefore, copperAfter)
	const result = await runMacro('pcb.rebuildPour', { protectNets: ['TYPO'] }, true)
	assert.equal(result.ok, false)
	assert.equal(host.writes, 0)
})

console.log(`sdk-outcome-regression: ${checks} checks passed`)
