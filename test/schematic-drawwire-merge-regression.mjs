import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = buildSync({
	stdin: {
		contents: `import { schematicCommands } from '../src/commands/schematic.ts'; import { executeCommand, registerCommand } from '../src/engine/registry.ts'; export { schematicCommands, executeCommand, registerCommand }`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'schematic-drawwire-merge-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { schematicCommands, executeCommand, registerCommand } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
for (const command of schematicCommands) registerCommand(command)
const drawWire = schematicCommands.find(item => item.name === 'schematic.drawWire').handler

function makeHarness({ initial = [], onCreate, failReadAfterWrite = false, sourceOnlyDrift = false, sourceLineMode, wireLineEvidence = false, sourceStyleOverride = {}, getterStyleOverride = {}, netValueOverride, netDisplayOverride, netParentOverride } = {}) {
	const wires = new Map(initial.map(w => [w.id, { ...w }]))
	let calls = 0
	let readsAfterWrite = 0
	let focusUuid = 'page-1'
	const ids = () => [...wires.keys()]
	const makeWire = item => ({
		getState_PrimitiveId: () => item.id,
		getState_Line: () => item.line,
		getState_Color: () => getterStyleOverride.color ?? item.color,
		getState_LineWidth: () => getterStyleOverride.width ?? item.lineWidth,
		getState_LineType: () => getterStyleOverride.type ?? item.lineType,
		getState_Net: () => item.net ?? '',
	})
	const source = () => {
		const rows = [`{"type":"DOCHEAD","ticket":1}||${JSON.stringify({ docType: 'SCH_PAGE', uuid: 'page-1', client: 'test', version: 1 })}`]
		let ticket = 2
		for (const item of wires.values()) {
			const wireData = { zIndex: item.zIndex ?? 0, ...(wireLineEvidence ? { line: sourceLineMode === 'wire-line-mismatch' ? [item.line[0], -item.line[1], item.line[2] + 1, -item.line[3]] : item.line.flatMap((value, index) => index % 2 === 1 ? [-value] : [value]) } : {}) }
			rows.push(`${JSON.stringify({ type: 'WIRE', id: item.id, ticket: ticket++ })}||${JSON.stringify(wireData)}`)
			if (sourceLineMode !== 'missing') for (let i = 0; i + 3 < item.line.length; i += 2) {
				let startX = item.line[i]
				let endX = item.line[i + 2]
				if (sourceOnlyDrift && calls === 0 && i === 0) endX += 1
				if (sourceLineMode === 'bad-endpoint') endX += 1
				if (sourceLineMode === 'nonfinite') startX = Number.POSITIVE_INFINITY
				rows.push(`${JSON.stringify({ type: 'LINE', id: `line-${item.id}-${i}`, ticket: ticket++ })}||${JSON.stringify({ lineGroup: sourceLineMode === 'missing-group' ? undefined : item.id, startX, startY: -item.line[i + 1], endX, endY: -item.line[i + 3], strokeColor: sourceStyleOverride.color ?? item.color, strokeWidth: sourceStyleOverride.width ?? item.lineWidth, strokeStyle: sourceStyleOverride.type ?? ['SOLID', 'SHORT_DASH', 'DOT'][item.lineType] })}`)
			}
			if (item.net !== undefined && item.net !== null) rows.push(`${JSON.stringify({ type: 'ATTR', id: `net-${item.id}`, ticket: ticket++ })}||${JSON.stringify({ parentId: netParentOverride ?? item.id, key: 'NET', value: netValueOverride ?? item.net, valueVisible: true })}`)
		}
		return rows.join('\n')
	}
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: focusUuid }) },
		sys_FileManager: { getDocumentSource: async () => source() },
		sch_PrimitiveAttribute: { getAll: async () => [] },
		sch_PrimitiveWire: {
			getAll: async () => {
				if (failReadAfterWrite && calls > 0 && ++readsAfterWrite > 0) throw new Error('injected readback failure')
				return [...wires.values()].map(makeWire)
			},
			create: async (line, net, color, lineWidth, lineType) => {
				calls++
				return onCreate({ wires, calls, line, net, color, lineWidth, lineType, makeWire, setFocus: uuid => { focusUuid = uuid } })
			},
		},
	}
	return { wires, get calls() { return calls }, get ids() { return ids() } }
}

const base = { color: '#000000', lineWidth: 6, lineType: 0, net: undefined }

async function captureError(fn) {
	try { await fn() }
	catch (error) { return error }
	assert.fail('expected the drawWire operation to fail')
}

{
	const harness = makeHarness({ onCreate: ({ wires, line, color, lineWidth, lineType, makeWire }) => {
		const item = { id: 'wire-new', line, color: color ?? base.color, lineWidth: lineWidth ?? base.lineWidth, lineType: lineType ?? base.lineType }
		wires.set(item.id, item)
		return makeWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]] })
	assert.deepEqual(result.primitiveIds, ['wire-new'])
	assert.deepEqual(result.created, ['wire-new'])
	assert.equal(result.segments, 1)
}

{
	makeHarness({ onCreate: ({ wires, line, makeWire }) => {
		const item = { ...base, id: 'nonzero-y', line }
		wires.set(item.id, item); return makeWire(item)
	} })
	const result = await drawWire({ points: [[0, 25], [10, 25]] })
	assert.deepEqual(result.primitiveIds, ['nonzero-y'], 'native LINE negative-Y coordinates are converted to SDK coordinates')
}

for (const [sourceLineMode, wireLineEvidence, message] of [
	['bad-endpoint', false, 'a LINE endpoint mismatch must fail before writing'],
	['nonfinite', false, 'nonfinite LINE geometry must fail before writing'],
	['missing', false, 'missing associated LINE geometry must fail before writing'],
	['missing-group', false, 'LINE without lineGroup must fail before writing'],
	['wire-line-mismatch', true, 'optional WIRE.line evidence must agree with native LINE geometry'],
]) {
	const harness = makeHarness({ sourceLineMode, wireLineEvidence, initial: [{ ...base, id: `bad-source-${sourceLineMode}`, line: [0, 0, 10, 0] }], onCreate: () => { throw new Error('write must not start') } })
	const error = await captureError(() => drawWire({ points: [[20, 0], [30, 0]] }))
	assert.equal(harness.calls, 0, message)
	assert.match(error.message, /WIRE .* (?:LINE|line)/)
}

{
	const harness = makeHarness({ onCreate: ({ wires, makeWire }) => {
		const item = { ...base, id: 'split-path', line: [0, 0, 5, 0, 10, 0] }
		wires.set(item.id, item)
		return makeWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]] })
	assert.deepEqual(result.primitiveIds, ['split-path'], 'continuous coverage across adjoining source/getter segments is valid')
}

{
	makeHarness({ onCreate: ({ wires, makeWire }) => {
		const first = { ...base, id: 'left-half', line: [0, 0, 5, 0] }
		const second = { ...base, id: 'right-half', line: [5, 0, 10, 0] }
		wires.set(first.id, first); wires.set(second.id, second)
		return makeWire(first)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]] })
	assert.deepEqual(result.primitiveIds, ['left-half', 'right-half'], 'adjacent WIRE IDs may jointly cover one requested segment')
}

{
	makeHarness({ onCreate: ({ wires, calls, line, net, makeWire }) => {
		const item = calls === 1
			? { ...base, id: 'named-merge', line: [0, 0, 20, 0], net }
			: wires.get('named-merge')
		wires.delete('unnamed-old'); wires.set(item.id, item)
		return makeWire(item)
	}, initial: [{ ...base, id: 'unnamed-old', line: [10, 0, 20, 0] }] })
	const result = await drawWire({ points: [[0, 0], [10, 0]], net: 'SIG' })
	assert.deepEqual(result.primitiveIds, ['named-merge'])
	assert.equal(result.readback?.verified, true, 'an explicitly named new segment may legally name a touching unnamed old wire')
}

{
	makeHarness({ initial: [{ ...base, id: 'empty-name-old', line: [10, 0, 20, 0], net: '' }], onCreate: ({ wires, line, net, makeWire }) => {
		const item = { ...base, id: 'empty-name-named', line: [0, 0, 20, 0], net }
		wires.delete('empty-name-old'); wires.set(item.id, item); return makeWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]], net: 'SIG' })
	assert.equal(result.readback?.verified, true, 'an explicit empty NET value is not a conflicting old name')
}

{
	makeHarness({ initial: [{ ...base, id: 'right-angle-old', line: [10, 0, 10, 10] }], onCreate: ({ wires, line, net, makeWire }) => {
		const item = { ...base, id: 'right-angle-named', line: [0, 0, 10, 0, 10, 10], net }
		wires.delete('right-angle-old'); wires.set(item.id, item); return makeWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]], net: 'SIG' })
	assert.equal(result.readback?.verified, true, 'a right-angle endpoint is a real connection for legal name inheritance')
}

{
	makeHarness({ initial: [{ ...base, id: 'later-unnamed-old', line: [10, 10, 10, 20] }], onCreate: ({ wires, calls, line, net, makeWire }) => {
		if (calls === 1) {
			const item = { ...base, id: 'first-named', line, net }
			wires.set(item.id, item); return makeWire(item)
		}
		const item = { ...base, id: 'joined-named', line: [0, 0, 10, 0, 10, 10, 10, 20], net: 'SIG' }
		wires.delete('first-named'); wires.delete('later-unnamed-old'); wires.set(item.id, item); return makeWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0], [10, 10]], net: 'SIG' })
	assert.equal(result.readback?.verified, true, 'a later unnamed segment may inherit the already verified target net at a right-angle endpoint')
}

{
	const harness = makeHarness({ onCreate: ({ wires, line, net, makeWire }) => {
		const item = { ...base, id: 'conflicting-merge', line: [0, 0, 20, 0], net }
		wires.delete('named-old'); wires.set(item.id, item)
		return makeWire(item)
	}, initial: [{ ...base, id: 'named-old', line: [10, 0, 20, 0], net: 'OLD' }] })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0], [20, 0]], net: 'SIG' }))
	assert.equal(error.cause?.partial, true, 'a conflicting existing nonempty net cannot be overwritten')
	assert.equal(harness.calls, 1, 'a conflicting net must stop before the second segment write')
}

{
	const harness = makeHarness({ onCreate: ({ wires, calls, line, makeWire }) => {
		const item = { ...base, id: `unnamed-${calls}`, line }
		wires.set(item.id, item)
		return makeWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0], [10, 10]], net: 'SIG' }))
	assert.equal(error.cause?.partial, true, 'a silently ignored first-segment name must be reported as partial')
	assert.equal(harness.calls, 1, 'a later segment must not run before the target net is verified')
}

{
	for (const [params, itemStyle] of [
		[{ color: '#FF0000' }, { color: '#000000' }],
		[{ lineWidth: 8 }, { lineWidth: 6 }],
		[{ lineType: 'dotted' }, { lineType: 0 }],
	]) {
		makeHarness({ onCreate: ({ wires, line, color, lineWidth, lineType, makeWire }) => {
			const item = { ...base, id: 'wrong-style', line, color: itemStyle.color ?? color, lineWidth: itemStyle.lineWidth ?? lineWidth, lineType: itemStyle.lineType ?? lineType }
			wires.set(item.id, item); return makeWire(item)
		} })
		const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]], ...params }))
		assert.equal(error.cause?.partial, true, `explicit styles must be verified against actual new geometry: ${Object.keys(params)[0]}`)
	}
}

{
	makeHarness({ onCreate: ({ wires, line, color, lineWidth, lineType, makeWire }) => {
		const item = { ...base, id: 'styled', line, color, lineWidth, lineType }
		wires.set(item.id, item); return makeWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]], color: '#FF0000', lineWidth: 8, lineType: 'dashed' })
	assert.equal(result.partial, undefined, 'all explicitly requested source/getter styles may verify successfully')
}

{
	makeHarness({ sourceStyleOverride: { color: '#000000' }, onCreate: ({ wires, line, color, makeWire }) => {
		const item = { ...base, id: 'style-source-getter-split', line, color }
		wires.set(item.id, item); return makeWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]], color: '#FF0000' }))
	assert.equal(error.cause?.partial, true, 'source LINE and getter style disagreement must fail verification')
}

{
	makeHarness({ getterStyleOverride: { color: '#000000' }, onCreate: ({ wires, line, color, makeWire }) => {
		const item = { ...base, id: 'style-getter-disagrees', line, color }
		wires.set(item.id, item); return makeWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]], color: '#FF0000' }))
	assert.equal(error.cause?.partial, true, 'getter style disagreement with the source LINE must fail verification')
}

{
	makeHarness({ initial: [{ ...base, id: 'unrelated-diagonal', line: [20, 20, 30, 30] }], onCreate: ({ wires, line, makeWire }) => {
		const item = { ...base, id: 'new-axis', line }
		wires.set(item.id, item); return makeWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]] })
	assert.deepEqual(result.primitiveIds, ['new-axis'], 'an unrelated diagonal old WIRE is preserved by exact geometry equality')
}

{
	const harness = makeHarness({ initial: [{ ...base, id: 'wire-old', line: [0, 0, 10, 0] }], onCreate: ({ wires, makeWire }) => {
		const item = wires.get('wire-old')
		item.line = [0, 0, 20, 0]
		return makeWire(item)
	} })
	const result = await drawWire({ points: [[10, 0], [20, 0]] })
	assert.deepEqual(result.primitiveIds, ['wire-old'], 'the final surviving merged wire ID must be returned')
	assert.deepEqual(result.reused, ['wire-old'])
	assert.deepEqual(result.created, [])
	assert.equal(result.partial, undefined)
}

{
	const harness = makeHarness({ initial: [{ ...base, id: 'wire-old', line: [0, 0, 10, 0] }], onCreate: ({ wires, calls, makeWire }) => {
		const item = wires.get('wire-old')
		item.line = [0, 0, 20, 0]
		item.color = '#FF0000'
		return makeWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[10, 0], [20, 0], [20, 10]] }))
	assert.equal(harness.calls, 1, 'later segments must stop after an old wire changes style during merge')
	assert.equal(error.cause?.partial, true)
	assert.equal(error.cause?.retryable, false)
	assert.equal(error.cause?.result?.partial?.state, 'partial')
	assert.deepEqual(error.cause?.result?.primitiveIds, ['wire-old'])
}

{
	const harness = makeHarness({ onCreate: ({ wires, calls, line, makeWire }) => {
		if (calls === 1) {
			const item = { ...base, id: 'intermediate', line }
			wires.set(item.id, item)
			return makeWire(item)
		}
		const first = wires.get('intermediate')
		wires.delete('intermediate')
		const survivor = { ...first, id: 'survivor', line: [0, 0, 10, 0, 10, 10] }
		wires.set(survivor.id, survivor)
		return makeWire(first)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0], [10, 10]] })
	assert.deepEqual(result.primitiveIds, ['survivor'], 'a stale intermediate SDK ID must not escape final readback')
	assert.deepEqual(result.removed, ['intermediate'])
	assert.equal(harness.calls, 2)
}

for (const mode of ['empty', 'throw']) {
	const harness = makeHarness({ onCreate: ({ wires, line, makeWire }) => {
		const item = { ...base, id: `written-${mode}`, line }
		wires.set(item.id, item)
		if (mode === 'throw') throw new Error('injected create failure after write')
		return undefined
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0], [10, 10]] }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true)
	assert.equal(error.cause?.retryable, false)
	assert.deepEqual(error.cause?.result?.primitiveIds, [`written-${mode}`], 'unknown create outcome still needs readback reconciliation')
	assert.equal(error.cause?.result?.partial?.state, 'unknown')
}

{
	const harness = makeHarness({ failReadAfterWrite: true, onCreate: ({ wires, line, makeWire }) => {
		const item = { ...base, id: 'written-read-failure', line }
		wires.set(item.id, item)
		return makeWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0], [10, 10]] }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true)
	assert.deepEqual(error.cause?.result?.primitiveIds, [])
	assert.equal(error.cause?.result?.partial?.state, 'unknown')
	assert.match(error.cause?.result?.partial?.reason, /读回失败/)
	assert.equal(error.cause?.result?.verification?.sourceAndModelReadback, false)
	assert.equal(error.cause?.result?.verification?.lastVerifiedPhase, 'pre-write')
}

{
	const harness = makeHarness({ initial: [{ ...base, id: 'overlap', line: [0, 0, 10, 0] }], onCreate: ({ wires }) => {
		wires.get('overlap').color = '#FF00FF'
		return { getState_PrimitiveId: () => 'overlap' }
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]] }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true, 'full-overlap style mutation is still a partial write')
}

{
	makeHarness({ initial: [{ ...base, id: 'unrelated', line: [50, 50, 60, 50] }], onCreate: ({ wires, line, makeWire }) => {
		const item = { ...base, id: 'requested', line }
		wires.set(item.id, item)
		wires.get('unrelated').color = '#AA0000'
		return makeWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]] }))
	assert.equal(error.cause?.partial, true, 'non-target style changes must stop the drawing operation')
}

{
	const harness = makeHarness({ initial: [{ ...base, id: 'old-id', line: [0, 0, 10, 0] }], onCreate: ({ wires, makeWire }) => {
		wires.delete('old-id')
		const survivor = { ...base, id: 'new-id', line: [0, 0, 20, 0] }
		wires.set(survivor.id, survivor)
		return makeWire(survivor)
	} })
	const result = await drawWire({ points: [[10, 0], [20, 0]] })
	assert.deepEqual(result.primitiveIds, ['new-id'])
	assert.deepEqual(result.removed, ['old-id'])
}

{
	const harness = makeHarness({ initial: [{ ...base, id: 'drifted', line: [20, 20, 30, 20] }], sourceOnlyDrift: true, onCreate: () => { throw new Error('write must not start') } })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]] }))
	assert.equal(harness.calls, 0)
	assert.equal(error.cause?.partial, undefined, 'pre-write source/getter disagreement is not a write-unknown outcome')
}

{
	const harness = makeHarness({ onCreate: ({ wires, calls, line, makeWire, setFocus }) => {
		const item = { ...base, id: `wire-${calls}`, line }
		wires.set(item.id, item)
		setFocus('page-2')
		return makeWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0], [10, 10]] }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true)
	assert.match(error.cause?.result?.partial?.reason, /焦点原理图已变化/)
}

{
	const harness = makeHarness({ onCreate: ({ wires, calls, line, makeWire }) => {
		if (calls === 1) {
			const first = { ...base, id: 'first', line }
			wires.set(first.id, first)
			return makeWire(first)
		}
		wires.delete('first')
		const second = { ...base, id: 'second', line }
		wires.set(second.id, second)
		return makeWire(second)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0], [10, 10]] }))
	assert.equal(harness.calls, 2)
	assert.equal(error.cause?.partial, true)
	assert.match(error.cause?.result?.partial?.reason, /原几何范围未完整保留/)
}

{
	const harness = makeHarness({ netValueOverride: '', netDisplayOverride: 'SIG', onCreate: ({ wires, line, net, makeWire }) => {
		const item = { ...base, id: 'named', line, net }
		wires.set(item.id, item)
		return makeWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]], net: 'SIG' }))
	assert.equal(error.cause?.partial, true, 'display text must not substitute for the effective NET value')
	assert.match(error.cause?.result?.partial?.reason, /NET value\/parentId/)
}

{
	makeHarness({ netParentOverride: 'wrong-parent', onCreate: ({ wires, line, net, makeWire }) => {
		const item = { ...base, id: 'wrong-parent-net', line, net }
		wires.set(item.id, item)
		return makeWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]], net: 'SIG' }))
	assert.equal(error.cause?.partial, true, 'NET must belong to the surviving wire by parentId')
}

{
	let laterWrites = 0
	registerCommand({ name: 'test.afterDrawWire', summary: 'test marker', params: [], returns: 'void', handler: async () => { laterWrites++; return true } })
	makeHarness({ initial: [{ ...base, id: 'wire-old', line: [0, 0, 10, 0] }], onCreate: ({ wires, makeWire }) => {
		const item = wires.get('wire-old')
		item.color = '#FF0000'
		item.line = [0, 0, 20, 0]
		return makeWire(item)
	} })
	const macro = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
		{ id: 'wire', cmd: 'schematic.drawWire', params: { points: [[10, 0], [20, 0]] } },
		{ id: 'later', cmd: 'test.afterDrawWire' },
	] } })
	assert.equal(macro.ok, false)
	assert.equal(macro.data?.stoppedReason, 'partial')
	assert.equal(macro.error?.cause?.partial, true)
	assert.equal(laterWrites, 0, 'macro must not execute after a drawWire partial write')
}

console.log('schematic-drawwire-merge-regression: all checks passed')
