import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: { contents: "export { diffPairCommands } from '../src/commands/diffPair.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'diff-pair-command-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { diffPairCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const command = diffPairCommands.find(item => item.name === 'pcb.routeDiffPair')
assert.ok(command?.handler)

// Expose the real private helper only in the esbuild test input; do not duplicate its implementation.
const diffPairSource = await readFile(resolve(root, 'src/commands/diffPair.ts'), 'utf8')
assert.ok(diffPairSource.includes('function normalizeAttributeClips('), 'the private source-clipping helper exists')
const helperBuild = await build({
	stdin: { contents: diffPairSource.replace('function normalizeAttributeClips(', 'export function normalizeAttributeClips('),
		resolveDir: resolve(root, 'src/commands'), sourcefile: 'diffPair-helper-test-entry.ts', loader: 'ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { normalizeAttributeClips } = await import(`data:text/javascript;base64,${Buffer.from(helperBuild.outputFiles[0].text).toString('base64')}`)
assert.equal(typeof normalizeAttributeClips, 'function')

const helperLine = (net, a, b) => ({ net, layer: 1, widthMil: 6, a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } })
{
	const clipped = normalizeAttributeClips([helperLine('same-token', [0, 0], [10, 0]), helperLine('same-token', [9.9995, 0], [20, 0])], () => {})
	assert.equal(clipped.length, 1, 'same-token seam overlap of 0.0005 is normalized within existing tolerance')
	assert.ok(Math.abs(clipped[0].b.x - 20) <= 1e-12)
}
{
	assert.throws(() => normalizeAttributeClips([helperLine('same-token', [0, 0], [10, 0]), helperLine('same-token', [9.998, 0], [20, 0])], () => {}),
		/超出读回容差的重复线段/, 'same-token repeated coverage above 0.001 is rejected')
}
{
	const clipped = normalizeAttributeClips([helperLine('token-a', [0, 0], [10, 0]), helperLine('token-b', [9.9995, 0], [20, 0])], () => {})
	assert.equal(clipped.length, 2, 'clips with different attribute tokens are not merged')
	assert.deepEqual(new Set(clipped.map(line => line.net)), new Set(['token-a', 'token-b']))
}

const uuid = 'diff-pair-board'
const row = (type, id, ticket, data) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`
const docHead = () => row('DOCHEAD', undefined, undefined, { docType: 'PCB', uuid, client: 'fixture', version: '1' })
const initialNet = () => row('NET', 'net-record-1', 1, { name: 'P', netName: 'P', retained: true })
const initialSource = (initialLines = []) => [docHead(), initialNet(), ...initialLines.map((line, index) => row('LINE', line.id, index + 2, line.data))].join('\n')
const lineData = (netName, layerId, width, a, b) => ({ netName, layerId, width, startX: a[0], startY: a[1], endX: b[0], endY: b[1], locked: false })
const mutateFirstLine = (source, mutate) => source.replace(/(\{"type":"LINE","id":"[^"]+","ticket":\d+\}\|\|)([^\n|]+)\|/, (_match, header, payload) => `${header}${JSON.stringify(mutate(JSON.parse(payload)))}|`)
const sourceLinesById = source => {
	const lines = new Map()
	for (const text of source.split(/\r?\n/)) {
		const separator = text.indexOf('||')
		if (separator < 0) continue
		const header = JSON.parse(text.slice(0, separator))
		if (header.type !== 'LINE') continue
		const payload = text.slice(separator + 2).replace(/\|$/, '')
		if (payload === '') lines.delete(header.id)
		else lines.set(header.id, JSON.parse(payload))
	}
	return lines
}

function install(options = {}) {
	let source = options.source ?? initialSource(options.initialLines)
	let nextId = 0
	let nextTicket = 10
	let sourceReads = 0
	let ruleReads = 0
	let focusReads = 0
	let names = options.nets ?? ['P', 'N']
	let rules = { clearance: 8, width: 4 }
	const calls = { create: [], sourceReads: 0, ruleReads: 0, focusReads: 0 }
	const actualLines = new Map((options.initialLines ?? []).map(line => [line.id, { ...line.data }]))
	const mkLine = (id, data) => ({
		getState_PrimitiveId: () => id,
		getState_Net: () => data.netName,
		getState_Layer: () => data.layerId,
		getState_StartX: () => data.startX,
		getState_StartY: () => data.startY,
		getState_EndX: () => data.endX,
		getState_EndY: () => data.endY,
		getState_LineWidth: () => data.width,
	})
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => {
			focusReads++; calls.focusReads++
			if (options.advanceClockAtFocus === focusReads) options.advanceClock?.()
			if (options.focusErrorAt === focusReads) throw new Error('mock focus failure')
			return { documentType: 3, uuid: options.focusWrongAt === focusReads ? 'other-board' : uuid }
		} },
		pcb_Net: { getAllNetsName: async () => names },
		pcb_Layer: { getAllLayers: async () => options.layers ?? [{ id: 1, type: 'SIGNAL', layerStatus: 1, status: 1 }] },
		pcb_Drc: { getCurrentRuleConfiguration: async () => {
			ruleReads++; calls.ruleReads++
			if (options.rulesChangeAtRead === ruleReads) rules = { clearance: 9, width: 4 }
			return { ...rules }
		} },
		sys_FileManager: { getDocumentSource: async () => {
			sourceReads++; calls.sourceReads++
			if (options.sourceChangeAtRead === sourceReads) source += '\n' + row('NET', 'external-net', 2, { name: 'X', netName: 'X' })
			if (sourceReads >= 3 && options.finalSourceMutation) source = options.finalSourceMutation(source)
			return source
		} },
		pcb_PrimitiveLine: {
			getAllPrimitiveId: async () => [...actualLines.keys()],
			get: async id => actualLines.has(id) ? mkLine(id, actualLines.get(id)) : undefined,
			create: async (net, layer, x1, y1, x2, y2, width) => {
				const index = calls.create.length + 1
				calls.create.push({ net, layer, a: [x1, y1], b: [x2, y2], width, index })
				if (options.createFailureAt === index) throw new Error('mock create failure')
				if (options.createDelayAt === index) await new Promise(resolve => setTimeout(resolve, options.createDelayMs ?? 1100))
				let a = [x1, y1], b = [x2, y2]
				if (options.reverseCreate) [a, b] = [b, a]
				if (options.advanceClockAtCreate === index) options.advanceClock?.()
				const id = `line-${++nextId}`
				const data = lineData(net, layer, width + (options.widthDelta ?? 0), a, b)
				if (options.mergeAtCreate === index) {
					const oldId = options.mergeOldId
					const oldData = actualLines.get(oldId)
					assert.ok(oldData, 'merge fixture target exists in initial SDK snapshot')
					const merged = { ...oldData, startX: options.mergedA?.[0] ?? x1, startY: options.mergedA?.[1] ?? y1,
						endX: options.mergedB?.[0] ?? x2, endY: options.mergedB?.[1] ?? y2 }
					actualLines.set(oldId, merged)
					source += '\n' + row('LINE', oldId, ++nextTicket, merged)
					return mkLine(id, data)
				}
				actualLines.set(id, data)
				source += '\n' + row('LINE', id, ++nextTicket, data)
				return mkLine(id, data)
			},
		},
	}
	return { calls, get source() { return source }, get focusReads() { return focusReads }, get sourceReads() { return sourceReads } }
}

const base = (overrides = {}) => ({ pair: { positiveNet: 'P', negativeNet: 'N' }, path: [[0, 0], [100, 0]], width: 4, gap: 2, _timeoutMs: 5000, ...overrides })
const run = params => command.handler(params)
async function rejected(params) {
	try { await run(params) }
	catch (error) { return error }
	assert.fail('expected routeDiffPair to reject')
}
function assertNoWrites(mock, error) {
	assert.ok(error instanceof Error)
	assert.equal(mock.calls.create.length, 0)
}

{
	const mock = install()
	const result = await run(base({ dryRun: true }))
	assert.equal(result.dryRun, true)
	assert.equal(result.created, false)
	assert.equal(mock.calls.create.length, 0, 'dryRun never creates route segments')
}
for (const [label, params, opts] of [
	['same network names', base({ pair: { positiveNet: 'P', negativeNet: 'P' } }), {}],
	['missing negative network', base(), { nets: ['P'] }],
	['disabled copper layer', base(), { layers: [{ id: 1, type: 'SIGNAL', layerStatus: 0, status: 0 }] }],
	['non-copper layer', base(), { layers: [{ id: 1, type: 'PLANE', layerStatus: 1, status: 1 }] }],
	['source changed during preflight', base(), { sourceChangeAtRead: 2 }],
	['rules changed during preflight', base(), { rulesChangeAtRead: 2 }],
]) {
	const mock = install(opts)
	const error = await rejected(params)
	assertNoWrites(mock, error)
}

for (const [label, path] of [
	['straight', [[0, 0], [100, 0]]],
	['45-degree', [[0, 0], [100, 100]]],
]) {
	const mock = install()
	const result = await run(base({ path }))
	assert.equal(result.created, true, `${label}: command succeeds`)
	assert.equal(result.readbackVerified, true)
	assert.equal(result.sourceCoverage.verified, true)
	assert.equal(Object.keys(result.sides).length, 2)
	assert.ok(result.sides.positive.segmentIds.length > 0)
	assert.ok(result.sides.negative.segmentIds.length > 0)
	assert.equal(mock.calls.create.length, 2, `${label}: both nets are routed serially`)
	assert.deepEqual(mock.calls.create.map(call => call.net), ['P', 'N'])
	assert.ok(mock.calls.create.every(call => call.layer === 1 && call.width === 4))
}

{
	const mock = install({ reverseCreate: true })
	const result = await run(base())
	assert.equal(result.created, true, 'endpoint-reversed SDK readback and source geometry are accepted')
	assert.equal(result.sourceCoverage.verified, true)
}

{
	const params = base({ path: [[0, 0], [100, 0], [100, 100]], width: 6, gap: 2 })
	const planned = await run({ ...params, dryRun: true })
	const [start, finish] = planned.positivePath
	const split = [start[0] + (finish[0] - start[0]) * 0.4, start[1] + (finish[1] - start[1]) * 0.4]
	const initial = { id: 'locked-positive-first', data: lineData('P', 1, 6, start, split) }
	initial.data.locked = true
	initial.data.routeOrigin = 'existing-locked-line'
	const mock = install({ initialLines: [initial], mergeAtCreate: 1, mergeOldId: initial.id, mergedA: start, mergedB: finish })
	const result = await run(params)
	assert.equal(result.created, true, 'a locked existing segment may merge with the first positive-side segment')
	assert.equal(result.sourceCoverage.verified, true, 'different locked metadata across same-side source rows does not reject valid coverage')
	assert.ok(result.sides.positive.segmentIds.includes(initial.id), 'the merged locked source line remains the confirmed segment')
	const latest = sourceLinesById(mock.source)
	assert.equal(latest.get(initial.id).locked, true, 'merged old segment retains locked=true')
	const secondId = result.sides.positive.segmentIds.find(id => id !== initial.id)
	assert.ok(secondId, 'the second positive segment was newly created')
	assert.equal(latest.get(secondId).locked, false, 'the second new segment remains locked=false')
}

{
	const mock = install({ widthDelta: 0.0005 })
	const result = await run(base({ width: 6 }))
	assert.equal(result.created, true, 'host source width 6.0005 is within the route writer 0.001 tolerance for requested width 6')
	assert.equal(result.sourceCoverage.verified, true)
}

{
	const params = base({ width: 6, gap: 2 })
	const planned = await run({ ...params, dryRun: true })
	const [start, finish] = planned.positivePath
	const oldA = [start[0] + (finish[0] - start[0]) * 0.4, start[1] + (finish[1] - start[1]) * 0.4]
	const oldB = [start[0] + (finish[0] - start[0]) * 0.7, start[1] + (finish[1] - start[1]) * 0.7]
	const initial = { id: 'horizontal-partial-old', data: { ...lineData('P', 1, 6, oldA, oldB), locked: true, note: 'retain-me' } }
	const mock = install({ initialLines: [initial], mergeAtCreate: 1, mergeOldId: initial.id, mergedA: start, mergedB: finish })
	const result = await run(params)
	assert.equal(result.created, true, 'a horizontal requested segment may legally merge across an old partial overlap')
	assert.equal(result.sourceCoverage.verified, true)
	assert.ok(result.sides.positive.segmentIds.includes(initial.id))
}

{
	const malformedLine = { id: 'old-bad-line', data: { netName: 'P', layerId: 1, width: 6, startX: 0, startY: 0, endX: 10, locked: true } }
	const mock = install({ initialLines: [malformedLine] })
	const error = await rejected(base({ width: 6 }))
	assertNoWrites(mock, error)
	assert.match(error.message, /LINE old-bad-line 源码无法确认/)
}

{
	const mock = install({ createFailureAt: 2 })
	const error = await rejected(base())
	assert.equal(mock.calls.create.length, 2)
	assert.equal(error.cause?.partial, true)
	assert.equal(error.cause?.activeSide, 'negative')
	assert.ok(error.cause.completedSides.positive, 'completed positive side is retained')
	assert.equal(error.cause.failedSideEvidence?.failedSegmentIndex, 1)
	assert.equal(error.cause.failedSideEvidence?.failedSegmentAttempted, true)
}

{
	const mock = install({ focusErrorAt: 24 })
	const error = await rejected(base())
	assert.equal(error.cause?.activeSide, 'negative', 'negative-side first focus error is attributed to that side')
	assert.ok(error.cause?.completedSides.positive)
	assert.equal(mock.calls.create.length, 1, 'negative first-focus failure sends no negative write')
}

{
	const mock = install({ focusWrongAt: 24 })
	const error = await rejected(base())
	assert.equal(error.cause?.activeSide, 'negative', 'a focus change at the negative-side boundary is attributed to that side')
	assert.ok(error.cause?.completedSides.positive)
	assert.equal(mock.calls.create.length, 1, 'the shared PCB binding prevents a negative-side write on another document')
}

{
	const mockOptions = {}
	const mock = install(mockOptions)
	const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance')
	let virtualNow = 0
	mockOptions.advanceClockAtFocus = 24
	mockOptions.advanceClock = () => { virtualNow = 1001 }
	Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => virtualNow } })
	try {
		const error = await rejected(base({ _timeoutMs: 1000 }))
		assert.equal(error.cause?.activeSide, 'negative')
		assert.equal(mock.calls.create.length, 1, 'the second side does not receive a fresh per-side deadline')
	}
	finally {
		if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance)
		else delete globalThis.performance
	}
}

{
	const mock = install({ createDelayAt: 1, createDelayMs: 1100 })
	const error = await rejected(base({ _timeoutMs: 1000 }))
	assert.equal(error.cause?.activeSide, 'positive')
	await new Promise(resolve => setTimeout(resolve, 180))
	assert.equal(mock.calls.create.length, 1, 'late first-side completion cannot trigger later writes')
}

for (const [label, mutate] of [
	['source geometry stretched', source => mutateFirstLine(source, data => ({ ...data, endX: data.endX + 500 }))],
	['source segment missing', source => {
		const match = source.match(/(\{"type":"LINE","id":"line-1","ticket":\d+\}||\{[^\n]+\})/)
		assert.ok(match, 'fixture has first created source line')
		return source.replace(match[0], row('LINE', 'line-1', ++nextFixtureTicket, ''))
	}],
	['source duplicate segment', source => {
		const match = source.match(/\{"type":"LINE","id":"line-1","ticket":\d+\}||([^\n|]+)\|/)
		assert.ok(match)
		return source + '\n' + row('LINE', 'unexpected-copy', 99, JSON.parse(match[1]))
	}],
	['source endpoint mismatch', source => mutateFirstLine(source, data => ({ ...data, startX: data.startX + 500 }))],
	['source network mismatch', source => mutateFirstLine(source, data => ({ ...data, netName: 'X' }))],
	['source width mismatch', source => mutateFirstLine(source, data => ({ ...data, width: data.width + 4 }))],
]) {
	let nextFixtureTicket = 90
	const mock = install({ finalSourceMutation: mutate })
	const error = await rejected(base())
	assert.equal(mock.calls.create.length, 2, `${label}: SDK getters remain correct through both writes`)
	assert.equal(error.cause?.partial, true)
}

{
	const mock = install({ finalSourceMutation: source => source.replace(/\{"type":"NET","id":"net-record-1","ticket":1\}\|\|[^\n]+/, row('NET', 'net-record-1', 98, { name: 'P', netName: 'P', retained: false })) })
	const error = await rejected(base())
	assert.equal(mock.calls.create.length, 2)
	assert.equal(error.cause?.partial, true)
	assert.match(error.message, /原有记录 NET/)
}

{
	const params = base({ path: [[0, 0], [100, 0], [100, 100]], width: 6, gap: 2 })
	const planned = await run({ ...params, dryRun: true })
	const [start, finish] = planned.positivePath
	const split = [start[0] + (finish[0] - start[0]) * 0.4, start[1] + (finish[1] - start[1]) * 0.4]
	const initial = { id: 'old-token-line', data: { ...lineData('P', 1, 6, start, split), locked: true, vendorFlag: 'original' } }
	const mock = install({ initialLines: [initial], mergeAtCreate: 1, mergeOldId: initial.id, mergedA: start, mergedB: finish,
		finalSourceMutation: source => {
			const latest = sourceLinesById(source).get('old-token-line')
			return source + '\n' + row('LINE', 'old-token-line', 999, { ...latest, vendorFlag: 'changed' })
		},
	})
	const error = await rejected(params)
	assert.equal(mock.calls.create.length, 4, 'both route sides complete before detecting an unknown old-line attribute change')
	assert.equal(error.cause?.partial, true)
	assert.match(error.message, /最终走线源码覆盖不符|共线重叠/)
}

console.log('diff-pair-command-regression: all checks passed')
