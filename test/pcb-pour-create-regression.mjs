import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "import { pcbCommands } from '../src/commands/pcb.ts'; export { pcbCommands }",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-pour-create-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { pcbCommands } = await import(moduleUrl)
const pourCommand = pcbCommands.find(item => item.name === 'pcb.pourCopper')
const createPour = pourCommand.handler
const record = (type, id, data, ticket) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}`
const expectedPath = ['R', 10, 35, 20, 30, 0, 0]

function install({ preserveGetter, sourceKeepIsland, getterPath, sourcePath, focusUuid = 'pcb-pour-create', sourceUuid = focusUuid, netLookup, sourceRead, createDelay, afterCreateSource } = {}) {
	const state = { created: [], sourceReads: 0, netReads: 0, rebuildCalls: 0, getReads: 0, args: undefined, candidate: undefined }
	const focus = { uuid: focusUuid }
	const baseline = [
		record('DOCHEAD', 'head', { docType: 'PCB', uuid: sourceUuid, client: 'fixture' }, 1),
		record('POURED', 'fill-1', { pourPrimitiveId: 'old-pour', sourceKeep: 'unchanged' }, 2),
		record('POUR', 'old-pour', { netName: 'GND', layerId: 2, keepIsland: false, order: 0, path: [['R', 1, 1, 2, 2, 0, 0]], untouched: 'old' }, 3),
	].join('\n')
	let currentSource = baseline
	const expectedArgs = expectedPath
	const polygon = { getSource: () => expectedArgs }
	const createObject = id => ({
		getState_PrimitiveId: () => id,
	})
	const freshObject = item => ({
		getState_PrimitiveId: () => item.id,
		getState_Net: () => item.netName,
		getState_Layer: () => item.layerId,
		getState_PreserveSilos: () => preserveGetter ?? item.keepIsland,
		getState_ComplexPolygon: () => ({ getSource: () => getterPath ?? item.path }),
	})
	globalThis.eda = {
		pcb_Net: { getAllNetsName: async () => { state.netReads++; return netLookup ? netLookup(focus) : ['GND', 'VCC'] } },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: focus.uuid }) },
		sys_FileManager: { getDocumentSource: async () => { state.sourceReads++; return sourceRead ? sourceRead(state.sourceReads, currentSource) : currentSource } },
		pcb_MathPolygon: { createPolygon: source => { assert.deepEqual(source, expectedArgs); return polygon } },
		pcb_PrimitivePour: {
			create: async (...args) => {
				state.created.push(args)
				state.args = args
				const item = {
					id: `new-pour-${state.created.length}`,
					netName: args[0],
					layerId: args[1],
					path: expectedArgs,
					keepIsland: args.length >= 5 ? args[4] : false,
				}
				state.candidate = item
				const sourceKeep = sourceKeepIsland === undefined ? item.keepIsland : sourceKeepIsland
				currentSource = `${baseline}\n${record('POUR', item.id, { netName: item.netName, layerId: item.layerId, keepIsland: sourceKeep, order: 1, path: sourcePath ?? item.path, untouched: 'candidate' }, 4)}`
				if (afterCreateSource) currentSource = afterCreateSource({ currentSource, baseline, item })
				if (createDelay) await createDelay(item)
				return createObject(item.id)
			},
			get: async id => { state.getReads++; return id === state.candidate?.id ? freshObject(state.candidate) : undefined },
			getAll: async () => [],
			rebuildCopperRegions: async () => { state.rebuildCalls++; return [] },
		},
	}
	return { state, baseline }
}

async function withClock(fn) {
	const realNow = performance.now.bind(performance)
	let now = 0
	Object.defineProperty(performance, 'now', { configurable: true, value: () => now })
	try { await fn(ms => { now += ms }) }
	finally { Object.defineProperty(performance, 'now', { configurable: true, value: realNow }) }
}

function rewriteSource(source, transform) {
	return source.split('\n').map(line => {
		const split = line.indexOf('||')
		const header = JSON.parse(line.slice(0, split))
		const data = JSON.parse(line.slice(split + 2))
		return transform(header, data)
	}).join('\n')
}

assert.equal(pourCommand.params.find(item => item.name === 'preserveSilos')?.type, 'boolean', 'metadata declares the optional strict boolean parameter')

// Omitted parameter preserves the original exact three-argument SDK call.
{
	const f = install()
	const result = await createPour({ net: 'GND', layer: 'bottom', x: 10, y: 5, width: 20, height: 30 })
	assert.deepEqual(f.state.args.slice(0, 2), ['GND', 2])
	assert.equal(f.state.args.length, 3)
	assert.deepEqual(f.state.args[2].getSource(), ['R', 10, 35, 20, 30, 0, 0])
	assert.equal(result.readback.verified, true)
	assert.equal(result.readback.preserveSilos, false)
	assert.equal(result.primitiveId, 'new-pour-1')
	assert.equal(f.state.rebuildCalls, 0, 'creating the outline does not trigger a copper rebuild')
	assert.equal(f.state.sourceReads, 2, 'creation is checked against the complete before and after source')
}

for (const preserveSilos of [true, false]) {
	const f = install({ preserveGetter: preserveSilos, sourceKeepIsland: preserveSilos })
	const result = await createPour({ net: 'GND', layer: 'bottom', x: 10, y: 5, width: 20, height: 30, preserveSilos })
	assert.equal(f.state.args.length, 5)
	assert.equal(f.state.args[0], 'GND')
	assert.equal(f.state.args[1], 2)
	assert.equal(f.state.args[3], undefined)
	assert.equal(f.state.args[4], preserveSilos)
	assert.equal(result.readback.preserveSilos, preserveSilos)
	assert.equal(f.state.rebuildCalls, 0)
}

// A single legal R rectangle may be exposed flat by the getter and wrapped
// once by the source, or wrapped once by both readback paths.
for (const [getterPath, sourcePath] of [
	[['R', 10, 35, 20, 30, 0, 0], [['R', 10, 35, 20, 30, 0, 0]]],
	[[['R', 10, 35, 20, 30, 0, 0]], [['R', 10, 35, 20, 30, 0, 0]]],
]) {
	const f = install({ getterPath, sourcePath })
	const result = await createPour({ net: 'GND', layer: 'bottom', x: 10, y: 5, width: 20, height: 30 })
	assert.equal(result.readback.verified, true)
	assert.equal(f.state.created.length, 1)
}

// Invalid values are rejected before even the network lookup, and therefore
// before polygon creation or the write API.
for (const preserveSilos of [null, 'true', 1]) {
	const f = install()
	await assert.rejects(() => createPour({ net: 'GND', x: 10, y: 5, width: 20, height: 30, preserveSilos }), /preserveSilos 必须是布尔值/)
	assert.equal(f.state.netReads, 0)
	assert.equal(f.state.created.length, 0)
	assert.equal(f.state.sourceReads, 0)
}

for (const _timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
	const f = install()
	await assert.rejects(() => createPour({ net: 'GND', x: 10, y: 5, width: 20, height: 30, _timeoutMs }), /_timeoutMs 必须是有限/)
	assert.equal(f.state.netReads, 0)
	assert.equal(f.state.created.length, 0)
}

// A mismatch is returned as an uncertain, non-retryable candidate outcome;
// the command neither retries creation nor runs rebuild.
{
	const f = install({ preserveGetter: true, sourceKeepIsland: false })
	const error = await createPour({ net: 'GND', layer: 'bottom', x: 10, y: 5, width: 20, height: 30, preserveSilos: true }).then(() => undefined, caught => caught)
	assert.equal(error?.cause?.partial, true)
	assert.equal(error?.cause?.retryable, false)
	assert.equal(error?.cause?.candidateId, 'new-pour-1')
	assert.equal(f.state.created.length, 1)
	assert.equal(f.state.rebuildCalls, 0)
}

// Wrong-page source identity is caught before the create call.
{
	const f = install({ focusUuid: 'pcb-active', sourceUuid: 'pcb-other' })
	await assert.rejects(() => createPour({ net: 'GND', x: 10, y: 5, width: 20, height: 30, preserveSilos: true }), /源码身份与当前 PCB 不符/)
	assert.equal(f.state.created.length, 0)
}

// A page switch while the first network-existence await is pending stays in preflight.
{
	const f = install({ netLookup: focus => { focus.uuid = 'pcb-other'; return ['GND'] } })
	await assert.rejects(() => createPour({ net: 'GND', x: 10, y: 5, width: 20, height: 30 }), /焦点已变化/)
	assert.equal(f.state.created.length, 0)
	assert.equal(f.state.sourceReads, 0)
}

// DOCHEAD metadata, record order, tickets, and JSON object-key order are log encoding details.
{
	const f = install({ afterCreateSource: ({ currentSource }) => rewriteSource(currentSource, (header, data) => {
		header.ticket = Number(header.ticket ?? 0) + 20
		if (header.type === 'DOCHEAD') data.updatedAt = 'later'
		const reordered = data && typeof data === 'object' && !Array.isArray(data)
			? Object.fromEntries(Object.entries(data).reverse()) : data
		return `${JSON.stringify(header)}||${JSON.stringify(reordered)}`
	}).split('\n').reverse().join('\n') })
	const result = await createPour({ net: 'GND', layer: 'bottom', x: 10, y: 5, width: 20, height: 30 })
	assert.equal(result.readback.verified, true)
	assert.equal(f.state.created.length, 1)
}

// Effective old records remain strict: changing prior POUReD or POUR data is partial.
for (const targetType of ['POURED', 'POUR']) {
	const f = install({ afterCreateSource: ({ currentSource }) => rewriteSource(currentSource, (header, data) => {
		if (header.type === targetType && header.id === (targetType === 'POURED' ? 'fill-1' : 'old-pour')) data.untouched = 'changed'
		return `${JSON.stringify(header)}||${JSON.stringify(data)}`
	}) })
	const error = await createPour({ net: 'GND', layer: 'bottom', x: 10, y: 5, width: 20, height: 30 }).then(() => undefined, caught => caught)
	assert.equal(error?.cause?.partial, true)
	assert.equal(error?.cause?.retryable, false)
	assert.equal(error?.cause?.candidateId, 'new-pour-1')
	assert.equal(f.state.created.length, 1)
}

// Every R tuple field, including rotation/corner parameters, is compared
// exactly for both API getter and source readback.
for (const channel of ['getter', 'source']) {
	for (let index = 1; index < 7; index++) {
		const changed = [...expectedPath]
		changed[index] += 1
		const f = install(channel === 'getter' ? { getterPath: changed } : { sourcePath: [changed] })
		const error = await createPour({ net: 'GND', layer: 'bottom', x: 10, y: 5, width: 20, height: 30 }).then(() => undefined, caught => caught)
		assert.equal(error?.cause?.partial, true)
		assert.equal(error?.cause?.retryable, false)
		assert.equal(error?.cause?.candidateId, 'new-pour-1')
		assert.equal(error?.cause?.pathComparison?.comparison?.[`${channel}MatchesExpected`], false)
		assert.equal(f.state.created.length, 1)
	}
}

// Multiple contours (including hole/multi-ring shapes) and extra nesting are
// outside the one-R rectangle contract and must remain a candidate failure.
const invalidPaths = [
	['multiple rings or hole', [expectedPath, ['R', 11, 36, 19, 29, 0, 0]]],
	['extra nesting', [[expectedPath]]],
]
for (const channel of ['getter', 'source']) {
	for (const [label, invalid] of invalidPaths) {
		const f = install(channel === 'getter' ? { getterPath: invalid } : { sourcePath: invalid })
		const error = await createPour({ net: 'GND', layer: 'bottom', x: 10, y: 5, width: 20, height: 30 }).then(() => undefined, caught => caught)
		assert.equal(error?.cause?.partial, true, label)
		assert.equal(error?.cause?.retryable, false)
		assert.equal(error?.cause?.candidateId, 'new-pour-1')
		assert.equal(error?.cause?.pathComparison?.comparison?.[`${channel}MatchesExpected`], false)
		assert.equal(f.state.created.length, 1)
	}
}

// Expired preflight reads do not start the create call.
for (const phase of ['net', 'source']) {
	await withClock(async advance => {
		const options = phase === 'net'
			? { netLookup: async () => { advance(1001); return ['GND'] } }
			: { sourceRead: async (_reads, source) => { advance(1001); return source } }
		const f = install(options)
		await assert.rejects(() => createPour({ net: 'GND', x: 10, y: 5, width: 20, height: 30, _timeoutMs: 1000 }), /超出单指令时间预算/)
		assert.equal(f.state.created.length, 0, `${phase} timeout must not create`)
		assert.equal(f.state.getReads, 0)
	})
}

// A late create result is unknown/partial, keeps its returned candidate ID,
// and causes no readback or retry.
{
	await withClock(async advance => {
		const f = install({ createDelay: async () => { advance(1001) } })
		const error = await createPour({ net: 'GND', x: 10, y: 5, width: 20, height: 30, _timeoutMs: 1000 }).then(() => undefined, caught => caught)
		assert.equal(error?.cause?.partial, true)
		assert.equal(error?.cause?.retryable, false)
		assert.equal(error?.cause?.candidateId, 'new-pour-1')
		assert.equal(f.state.created.length, 1)
		assert.equal(f.state.sourceReads, 1)
		assert.equal(f.state.getReads, 0)
		assert.equal(f.state.rebuildCalls, 0)
	})
}

// Named internal layers must be identical to the already accepted numeric IDs.
for (const [layer, expected] of [['inner1', 15], ['inner2', 16], ['15', 15], [15, 15], [undefined, 1], ['', 1]]) {
	const f = install()
	const result = await createPour({ net: 'GND', layer, x: 10, y: 5, width: 20, height: 30 })
	assert.equal(f.state.args[1], expected)
	assert.equal(result.readback.layer, expected)
	assert.equal(result.readback.verified, true)
}
{
	const f = install()
	await assert.rejects(() => createPour({ net: 'GND', layer: 'unknown-inner', x: 10, y: 5, width: 20, height: 30 }), /不认识的层/)
	assert.equal(f.state.created.length, 0)
}
console.log('PASS pcb.pourCopper preserveSilos, layer names, exact SDK arity, source readback, and no-rebuild behavior')
