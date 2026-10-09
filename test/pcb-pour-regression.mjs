import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `
import { pcbCommands } from '../src/commands/pcb.ts'
import { executeCommand, registerCommand } from '../src/engine/registry.ts'
export { pcbCommands, executeCommand, registerCommand }
`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-pour-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { pcbCommands, executeCommand, registerCommand } = await import(moduleUrl)
for (const command of pcbCommands) registerCommand(command)

const command = name => pcbCommands.find(item => item.name === name)
const record = (type, id, data, ticket = 1) => `${JSON.stringify({ type, ticket, id })}||${JSON.stringify(data)}`
const source = (pours, uuid = 'pcb-test') => [
	record('DOCHEAD', undefined, { docType: 'PCB', uuid, client: 'mock' }).replace('"id":"undefined",', ''),
	...pours.map((pour, index) => record('POUR', pour.id, pour, 100 + index)),
].join('\n')
const pour = (id, layerId, order, overrides = {}) => ({
	id, partitionId: '', groupId: 0, netName: 'GND', layerId, width: 0.2, name: `POUR_${id}`, order,
	path: [['R', 0, 0, 10, 10, 0, 0]], pourType: { pourType: 'SOLID', fineness: 8 },
	keepIsland: false, locked: false, zIndex: 1, ...overrides,
})
const sourcePriority = item => item.order

// In-memory equivalent of the reported host behavior: a positive value selects
// a same-layer anchor at index value - 1, then places target immediately after it.
function hostSetOrder(pours, id, value) {
	const target = pours.find(item => item.id === id)
	const sameLayer = pours.filter(item => item.layerId === target.layerId).sort((a, b) => a.order - b.order)
	if (value === 0) { target.order = 0; return }
	const anchor = sameLayer[Math.min(value - 1, sameLayer.length - 1)]
	target.order = anchor.order + 1
}

function install({ pours = [pour('target', 2, 0)], apiPriority = 0, modify, sourceRead, focusRead } = {}) {
	const docs = structuredClone(pours)
	const stats = { writes: [], sourceReads: 0 }
	let focus = { documentType: 3, uuid: 'pcb-test' }
	let focusReads = 0
	const setFocus = next => { focus = next }
	const readFocus = async () => {
		focusReads++
		if (focusRead) focusRead(focusReads, setFocus)
		return { ...focus }
	}
	const pourObj = item => ({
		getState_PrimitiveId: () => item.id,
		getState_Net: () => item.netName,
		getState_Layer: () => item.layerId,
		getState_PourName: () => item.name,
		getState_PourPriority: () => typeof apiPriority === 'function' ? apiPriority(item) : apiPriority,
		getState_LineWidth: () => item.width,
	})
	globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: readFocus },
		sys_FileManager: {
			getDocumentSource: async () => {
				stats.sourceReads++
				if (sourceRead) return sourceRead(stats.sourceReads, docs, setFocus)
				return source(docs)
			},
		},
		pcb_PrimitivePour: {
			modify: async (id, props) => {
				stats.writes.push({ id, props: { ...props } })
				if (modify) return modify({ id, props, docs, stats })
				const item = docs.find(value => value.id === id)
				const map = { net: 'netName', layer: 'layerId', pourName: 'name', lineWidth: 'width' }
				if ('pourPriority' in props) hostSetOrder(docs, id, props.pourPriority)
				else for (const [key, value] of Object.entries(props)) item[map[key]] = value
				return pourObj(item)
			},
			getAll: async () => docs.map(pourObj),
		},
		pcb_Layer: { selectLayer: async layer => { stats.selectedLayer = layer; return true } },
	}
	return { docs, stats, setFocus }
}

async function withClock(fn) {
	const realNow = performance.now.bind(performance)
	let now = 0
	Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
	try { await fn(ms => { now += ms }) }
	finally { Object.defineProperty(performance, 'now', { configurable: true, value: realNow }) }
}

function capturePartial(error) {
	assert.equal(error?.cause?.partial, true, 'uncertain or incomplete write is marked partial')
	assert.deepEqual(error.cause.verifiedFields, error.cause.verifiedFields.filter(field => error.cause.attemptedFields.includes(field)), 'verified fields were attempted')
	assert.ok(Array.isArray(error.cause.notAttemptedFields))
	return error.cause
}

// P7: wide parser for declared layers while preserving old aliases and blank behavior.
{
	const f = install()
	for (const [value, expected] of [['inner2', 16], ['inner32', 46], ['custom1', 71], ['custom200', 270], [15, 15], ['15', 15], ['top', 1], ['t', 1], ['T', 1], ['bottom', 2], ['b', 2], [' b ', 2], ['', 1], ['   ', 1]]) {
		const result = await command('pcb.selectLayer').handler({ layer: value })
		assert.equal(result.selected, true)
		assert.equal(f.stats.selectedLayer, expected, `selectLayer resolves ${JSON.stringify(value)}`)
	}
	await assert.rejects(command('pcb.selectLayer').handler({ layer: 'inner33' }), /不认识的层/)
	await assert.rejects(command('pcb.selectLayer').handler({ layer: 'inner0' }), /不认识的层/)
	await assert.rejects(command('pcb.selectLayer').handler({ layer: 'custom201' }), /不认识的层/)
	await assert.rejects(command('pcb.selectLayer').handler({ layer: 'typo' }), /不认识的层/)
	await assert.rejects(command('pcb.selectLayer').handler({ layer: null }), /缺少参数 layer/)
	assert.equal(f.stats.selectedLayer, 1, 'rejected layer values do not call the SDK')
}

// P8: source order zero is authoritative even if the API getter falls back to a nonzero value.
{
	install({ apiPriority: 7 })
	const result = await command('pcb.modifyPour').handler({ primitiveId: 'target', pourPriority: 0 })
	assert.equal(result.readback.verified, true)
	assert.equal(result.readback.pourPriority, 0)
	assert.equal(result.sourceOrder, 0)
	assert.equal(result.apiPriority, 7)
}

// P8: reproduces the host's positive priority anchor behavior: source order 3 stays 3 for request 1.
{
	const docs = [pour('e797', 2, 2), pour('e790', 2, 3)]
	hostSetOrder(docs, 'e790', 1)
	assert.equal(sourcePriority(docs.find(item => item.id === 'e790')), 3)
	install({ pours: [pour('e797', 2, 2), pour('e790', 2, 3)] })
	const error = await command('pcb.modifyPour').handler({ primitiveId: 'e790', pourPriority: 1 }).then(() => undefined, caught => caught)
	const cause = capturePartial(error)
	assert.deepEqual(cause.requested, { pourPriority: 1 })
	assert.deepEqual(cause.attemptedFields, ['pourPriority'])
	assert.deepEqual(cause.verifiedFields, [])
	assert.equal(cause.sourceMismatch.actual, 3)
	assert.match(error.message, /请检查后决定是否再次操作/)
}

// P8: an earlier field succeeds, a priority mismatch stops before lineWidth.
{
	install({ pours: [pour('target', 2, 3), pour('other', 2, 2)] })
	const error = await command('pcb.modifyPour').handler({ primitiveId: 'target', layer: 'top', pourPriority: 1, lineWidth: 0.35 }).then(() => undefined, caught => caught)
	const cause = capturePartial(error)
	assert.deepEqual(cause.attemptedFields, ['layer', 'pourPriority'])
	assert.deepEqual(cause.verifiedFields, ['layer'])
	assert.deepEqual(cause.notAttemptedFields, ['lineWidth'])
	assert.equal(globalThis.eda.pcb_PrimitivePour ? true : false, true)
}

// P8: a write that mutates then throws preserves the thrown Error and never advances.
{
	const original = new Error('SDK threw after applying')
	const f = install({
		pours: [pour('target', 2, 0)],
		modify: ({ props, docs }) => { docs[0].name = props.pourName; throw original },
	})
	const error = await command('pcb.modifyPour').handler({ primitiveId: 'target', pourName: 'changed', lineWidth: 0.4 }).then(() => undefined, caught => caught)
	assert.equal(error, original)
	const cause = capturePartial(error)
	assert.equal(cause.writeError, 'SDK threw after applying')
	assert.deepEqual(cause.attemptedFields, ['pourName'])
	assert.deepEqual(cause.verifiedFields, ['pourName'], 'source readback confirms a field even though the SDK call threw')
	assert.deepEqual(cause.notAttemptedFields, ['lineWidth'])
	assert.equal(f.stats.sourceReads, 2, 'a thrown write gets one source readback before stopping')
}

// P8: a source pre-read failure is a preflight error, with no partial marker and no write.
{
	const f = install({ sourceRead: async () => { throw new Error('pre-source unavailable') } })
	await assert.rejects(command('pcb.modifyPour').handler({ primitiveId: 'target', net: 'VCC' }), error => {
		assert.match(error.message, /pre-source unavailable/)
		assert.equal(error.cause?.partial, undefined)
		return true
	})
	assert.equal(f.stats.writes.length, 0)
}

// A page switch while source retrieval is pending prevents the initial write.
{
	const f = install({ sourceRead: async (_reads, docs, setFocus) => { const result = source(docs); setFocus({ documentType: 3, uuid: 'pcb-other' }); return result } })
	await assert.rejects(command('pcb.modifyPour').handler({ primitiveId: 'target', net: 'VCC' }), /文档已变化/)
	assert.equal(f.stats.writes.length, 0)
}

// A page switch between successful field steps prevents the next write.
{
	const f = install({ focusRead: (count, setFocus) => { if (count === 7) setFocus({ documentType: 3, uuid: 'pcb-other' }) } })
	const error = await command('pcb.modifyPour').handler({ primitiveId: 'target', net: 'VCC', pourName: 'next' }).then(() => undefined, caught => caught)
	const cause = capturePartial(error)
	assert.deepEqual(cause.attemptedFields, ['net'])
	assert.deepEqual(cause.notAttemptedFields, ['pourName'])
	assert.equal(f.stats.writes.length, 1)
	assert.equal(cause.readbackStatus, 'lastKnown')
}

// A post-write source read failure makes all prior verification stale.
{
	const f = install({
		pours: [pour('target', 2, 0)],
		modify: ({ props, docs }) => {
			if (props.net) docs[0].netName = props.net
			if (props.layer) { docs[0].layerId = props.layer; docs[0].netName = 'SIDE_EFFECT' }
			return { ok: true }
		},
		sourceRead: async (reads, docs) => { if (reads === 3) throw new Error('post-source unavailable'); return source(docs) },
	})
	const error = await command('pcb.modifyPour').handler({ primitiveId: 'target', net: 'VCC', layer: 'top' }).then(() => undefined, caught => caught)
	const cause = capturePartial(error)
	assert.deepEqual(cause.attemptedFields, ['net', 'layer'])
	assert.deepEqual(cause.verifiedFields, [])
	assert.deepEqual(cause.unverifiedFields, ['net', 'layer'])
	assert.equal(cause.readbackStatus, 'lastKnown')
	assert.equal(f.stats.writes.length, 2)
}

// Time budget checks reject delayed source and write completions without follow-up calls.
{
	await withClock(async advance => {
		const f = install({ sourceRead: async (_reads, docs) => { const result = source(docs); advance(1001); return result } })
		await assert.rejects(command('pcb.modifyPour').handler({ primitiveId: 'target', net: 'VCC', _timeoutMs: 1000 }), error => {
			assert.equal(error.cause?.partial, undefined, 'pre-write timeout is not partial')
			return /超出单指令时间预算/.test(error.message)
		})
		assert.equal(f.stats.writes.length, 0)
	})
	for (const mode of ['resolve', 'reject']) {
		await withClock(async advance => {
			const original = new Error('delayed SDK rejection')
			const f = install({
				modify: ({ docs, props }) => {
					if (props.net) docs[0].netName = props.net
					advance(1001)
					if (mode === 'reject') throw original
					return { ok: true }
				},
			})
			const error = await command('pcb.modifyPour').handler({ primitiveId: 'target', net: 'VCC', pourName: 'later', _timeoutMs: 1000 }).then(() => undefined, caught => caught)
			const cause = capturePartial(error)
			assert.deepEqual(cause.attemptedFields, ['net'])
			assert.deepEqual(cause.notAttemptedFields, ['pourName'])
			assert.equal(cause.verifiedFields.length, 0)
			assert.equal(cause.readbackStatus, 'lastKnown')
			assert.equal(f.stats.sourceReads, 1, 'late write result does not trigger source reads')
			assert.equal(f.stats.writes.length, 1, 'late write result does not trigger a next write')
			if (mode === 'reject') assert.equal(cause.priorCause, original)
		})
	}
	await withClock(async advance => {
		const f = install({
			modify: ({ docs, props, stats }) => {
				if (props.net) docs[0].netName = props.net
				if (stats.writes.length === 2) advance(1001)
				return { ok: true }
			},
		})
		const error = await command('pcb.modifyPour').handler({ primitiveId: 'target', net: 'VCC', pourName: 'late', _timeoutMs: 1000 }).then(() => undefined, caught => caught)
		const cause = capturePartial(error)
		assert.deepEqual(cause.attemptedFields, ['net', 'pourName'])
		assert.deepEqual(cause.verifiedFields, [])
		assert.deepEqual(cause.unverifiedFields, ['net', 'pourName'])
		assert.equal(cause.readbackStatus, 'lastKnown')
		assert.equal(f.stats.sourceReads, 2, 'late second write result does not trigger another source read')
		assert.equal(f.stats.writes.length, 2, 'late second write result stops the sequence')
	})
	await withClock(async advance => {
		const f = install({ focusRead: count => { if (count === 7) advance(1001) } })
		const error = await command('pcb.modifyPour').handler({ primitiveId: 'target', net: 'VCC', pourName: 'later', _timeoutMs: 1000 }).then(() => undefined, caught => caught)
		const cause = capturePartial(error)
		assert.deepEqual(cause.attemptedFields, ['net'])
		assert.deepEqual(cause.notAttemptedFields, ['pourName'])
		assert.equal(f.stats.writes.length, 1)
	})
}

// P8: same-layer source order snapshots include all and only that layer's pours.
{
	install({ pours: [pour('target', 2, 0), pour('same-a', 2, 2), pour('other-layer', 15, 1)] })
	const result = await command('pcb.modifyPour').handler({ primitiveId: 'target', net: 'VCC' })
	assert.deepEqual(result.sourceOrders.before.map(item => item.primitiveId), ['same-a', 'target'])
	assert.deepEqual(result.sourceOrders.after.map(item => item.primitiveId), ['same-a', 'target'])
}

// P8: macro must stop after partial failure even when stopOnError is false.
{
	install({ pours: [pour('e797', 2, 2), pour('e790', 2, 3)] })
	let markerWrites = 0
	registerCommand({ name: 'test.afterPour', summary: 'marker', params: [], returns: '{}', handler: async () => { markerWrites++; return { written: true } } })
	const result = await executeCommand({ cmd: 'macro', params: {
		stopOnError: false,
		steps: [{ cmd: 'pcb.modifyPour', params: { primitiveId: 'e790', pourPriority: 1 } }, { cmd: 'test.afterPour' }],
	} })
	assert.equal(markerWrites, 0)
	assert.equal(result.data?.failed, 1)
}

console.log('PASS pcb.selectLayer wide layer aliases and modifyPour source readback, partial stop, ordering and macro behavior')
