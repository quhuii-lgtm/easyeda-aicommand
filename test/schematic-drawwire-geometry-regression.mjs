import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = buildSync({
	stdin: { contents: `import { schematicCommands } from '../src/commands/schematic.ts'; import { registerCommand } from '../src/engine/registry.ts'; export { schematicCommands, registerCommand }`, resolveDir: resolve(root, 'test'), sourcefile: 'schematic-drawwire-geometry-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { schematicCommands, registerCommand } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
for (const command of schematicCommands) registerCommand(command)
const drawWire = schematicCommands.find(item => item.name === 'schematic.drawWire').handler

const props = { color: '#000000', width: 6, type: 0, net: 'SIG' }
const attrsDefault = (wireId = 'wire-old') => [
	{ id: wireId === 'wire-old' ? 'attr-net' : `attr-net-${wireId}`, parentId: wireId, key: 'NET', value: 'SIG', valueVisible: true, x: 1, y: 2, zIndex: 20 },
	{ id: wireId === 'wire-old' ? 'attr-relevance' : `attr-relevance-${wireId}`, parentId: wireId, key: 'Relevance', value: '[]', valueVisible: true, x: 3, y: 4, zIndex: 21 },
]
// Exact NET ATTR data fields read from audit-20261016/v034-a08-unnamed-same-net-request.json (identity is header-only).
const sdkNetAttr = (id, parentId, value) => ({ id, x: 450, y: -600, rotation: null, color: null, fontFamily: null, fontSize: null, fontWeight: null, italic: null, underline: null, align: null, value, keyVisible: false, valueVisible: true, key: 'NET', fillColor: null, parentId, zIndex: 4 })
const sdkRelevanceAttr = (id, parentId) => ({ id, x: null, y: null, rotation: null, color: null, fontFamily: null, fontSize: null, fontWeight: null, italic: null, underline: null, align: null, value: '[]', keyVisible: null, valueVisible: null, key: 'Relevance', fillColor: null, parentId, zIndex: 2 })

function makeHarness({ initialWire, initialWires, onCreate, attrMutation, nonTargetAttrMutation, autoAttrs, extraInitialAttrs = [] } = {}) {
	let calls = 0
	const startingWires = initialWires ?? (initialWire ? [initialWire] : [])
	const wires = new Map(startingWires.map(item => [item.id, structuredClone(item)]))
	let attrs = [...startingWires.flatMap(item => attrsDefault(item.id)), ...structuredClone(extraInitialAttrs)]
	const createWire = item => ({
		getState_PrimitiveId: () => item.id,
		getState_Line: () => item.rawLine,
		getState_Color: () => item.color ?? props.color,
		getState_LineWidth: () => item.lineWidth ?? props.width,
		getState_LineType: () => item.lineType ?? props.type,
		getState_Net: () => Object.hasOwn(item, 'net') ? item.net : props.net,
	})
	const source = () => {
		const rows = [`{"type":"DOCHEAD","ticket":1}||${JSON.stringify({ docType: 'SCH_PAGE', uuid: 'page-1', client: 'test', version: 1 })}`]
		let ticket = 2
		for (const item of wires.values()) {
			rows.push(`${JSON.stringify({ type: 'WIRE', id: item.id, ticket: ticket++ })}||${JSON.stringify({ zIndex: 0, ...(item.sourceDataLine ? { line: item.sourceDataLine } : {}) })}`)
			for (const line of item.sourceLines ?? []) {
				rows.push(`${JSON.stringify({ type: 'LINE', id: line.id, ticket: ticket++ })}||${JSON.stringify({ lineGroup: item.id, startX: line.points[0], startY: -line.points[1], endX: line.points[2], endY: -line.points[3], strokeColor: line.color ?? item.color ?? props.color, strokeWidth: line.width ?? item.lineWidth ?? props.width, strokeStyle: line.style ?? 'SOLID' })}`)
			}
		}
		for (const attr of attrs) {
			const data = { ...attr }
			delete data.id
			rows.push(`${JSON.stringify({ type: 'ATTR', id: attr.id, ticket: ticket++ })}||${JSON.stringify(data)}`)
		}
		return rows.join('\n')
	}
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'page-1' }) },
		sys_FileManager: { getDocumentSource: async () => source() },
		sch_PrimitiveAttribute: { getAll: async () => [] },
		sch_PrimitiveWire: {
			getAll: async () => [...wires.values()].map(createWire),
			create: async (line, net, color, lineWidth, lineType) => {
				calls++
				const result = onCreate({ wires, attrs, calls, line, net, color, lineWidth, lineType, createWire })
				// A newly independent unnamed host wire has an empty-string getter and
				// real automatic fields; named scenarios provide explicit autoAttrs.
				if (!autoAttrs) for (const item of wires.values()) {
					if (attrs.some(attr => attr.parentId === item.id)) continue
					item.net = net ?? ''
					attrs.push(sdkNetAttr(`attr-net-${item.id}`, item.id, item.net), sdkRelevanceAttr(`attr-rel-${item.id}`, item.id))
				}
				if (autoAttrs) attrs = autoAttrs({ attrs, wires, calls })
				if (attrMutation) attrs = attrMutation(attrs)
				if (nonTargetAttrMutation) attrs = nonTargetAttrMutation(attrs)
				return result
			},
		},
	}
	return { wires, get attrs() { return attrs }, get calls() { return calls } }
}

{
	const groups = Array.from({ length: 7 }, (_, index) => [index * 10, 0, (index + 1) * 10, 0])
	const sourceLines = groups.map((points, index) => ({ id: `line-${index}`, points }))
	const harness = makeHarness({ onCreate: ({ wires, createWire }) => {
		const item = { id: 'wire-seven-groups', rawLine: groups, sourceLines, ...props }
		wires.set(item.id, item)
		return createWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [70, 0]] })
	assert.deepEqual(result.primitiveIds, ['wire-seven-groups'], 'seven four-number groups should resolve without a fixed candidate-count limit')
}

{
	const noNet = { ...props, net: '' }
	const harness = makeHarness({ onCreate: ({ wires, createWire }) => {
		const item = { id: 'wire-auto-relevance', rawLine: [0, 0, 10, 0], sourceLines: [{ id: 'line-auto-relevance', points: [0, 0, 10, 0] }], ...noNet }
		wires.set(item.id, item)
		return createWire(item)
	}, autoAttrs: ({ attrs, wires }) => {
		const wireId = 'wire-auto-relevance'
		if (!wires.has(wireId) || attrs.some(attr => attr.parentId === wireId)) return attrs
		return [...attrs, { id: 'attr-auto-relevance', x: null, y: null, rotation: null, color: null, fontFamily: null, fontSize: null, fontWeight: null, italic: null, underline: null, align: null, value: '[]', keyVisible: null, valueVisible: null, key: 'Relevance', fillColor: null, parentId: wireId, zIndex: 1 }]
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]] })
	assert.deepEqual(result.primitiveIds, ['wire-auto-relevance'], 'new WIRE automatic Relevance ATTR is allowed with no net')
}

{
	const existing = { id: 'wire-existing-sig', rawLine: [100, 100, 110, 100], sourceLines: [{ id: 'line-existing-sig', points: [100, 100, 110, 100] }], ...props }
	const harness = makeHarness({ initialWire: existing, onCreate: ({ wires, createWire, net }) => {
		assert.equal(net, undefined, 'same-net separated segment must be created without a duplicate label')
		const item = { ...props, id: 'wire-separated-unnamed', rawLine: [0, 0, 10, 0], sourceLines: [{ id: 'line-separated-unnamed', points: [0, 0, 10, 0] }], net: '' }
		wires.set(item.id, item)
		return createWire(item)
	}, autoAttrs: ({ attrs, wires }) => {
		const item = wires.get('wire-separated-unnamed')
		if (!item || attrs.some(attr => attr.parentId === item.id)) return attrs
		return [...attrs, sdkNetAttr('attr-empty-net', item.id, ''), sdkRelevanceAttr('attr-empty-rel', item.id)]
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]], net: 'SIG' })
	assert.equal(result.named, false)
	assert.deepEqual(result.primitiveIds, ['wire-separated-unnamed'])
	assert.equal(harness.calls, 1)
}

for (const scenario of [
	{ label: 'getter has a nonempty NET', getterNet: 'OTHER', attrParent: 'wire-case', attrValue: '' },
	{ label: 'wrong NET parent', getterNet: '', attrParent: 'wire-existing-sig', attrValue: '' },
	{ label: 'wrong nonempty NET value', getterNet: 'OTHER', attrParent: 'wire-case', attrValue: 'OTHER' },
]) {
	const existing = { id: 'wire-existing-sig', rawLine: [100, 100, 110, 100], sourceLines: [{ id: 'line-existing-sig', points: [100, 100, 110, 100] }], ...props }
	const harness = makeHarness({ initialWire: existing, onCreate: ({ wires, createWire }) => {
		const item = { ...props, id: 'wire-case', rawLine: [0, 0, 10, 0], sourceLines: [{ id: 'line-case', points: [0, 0, 10, 0] }], net: scenario.getterNet }
		wires.set(item.id, item)
		return createWire(item)
	}, autoAttrs: ({ attrs, wires }) => attrs.some(attr => attr.id === 'attr-case-net') ? attrs : [...attrs, sdkNetAttr('attr-case-net', scenario.attrParent, scenario.attrValue)] })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]], net: 'SIG' }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true, `${scenario.label} must fail`) 
}

{
	const harness = makeHarness({ onCreate: ({ wires, createWire }) => {
		const item = { ...props, id: 'wire-named-but-empty', rawLine: [0, 0, 10, 0], sourceLines: [{ id: 'line-named-but-empty', points: [0, 0, 10, 0] }], net: '' }
		wires.set(item.id, item)
		return createWire(item)
	}, autoAttrs: ({ attrs, wires }) => attrs.some(attr => attr.parentId === 'wire-named-but-empty') ? attrs : [...attrs, sdkNetAttr('attr-named-empty', 'wire-named-but-empty', '')] })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]], net: 'SIG' }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true, 'an actually named segment may not read back an empty NET')
}

{
	const existing = { id: 'wire-existing-sig', rawLine: [0, 0, 5, 0], sourceLines: [{ id: 'line-existing-sig', points: [0, 0, 5, 0] }], ...props }
	const harness = makeHarness({ initialWire: existing, onCreate: ({ wires, createWire }) => {
		const item = wires.get('wire-existing-sig')
		item.rawLine = [0, 0, 5, 0, 5, 0, 10, 0]
		item.sourceLines.push({ id: 'line-old-extended', points: [5, 0, 10, 0] })
		item.net = ''
		return createWire(item)
	}, attrMutation: attrs => attrs.map(attr => attr.key === 'NET' ? { ...attr, value: '' } : attr) })
	const error = await captureError(() => drawWire({ points: [[5, 0], [10, 0]], net: 'SIG' }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true, 'an existing named WIRE may not be silently converted to empty NET')
}

{
	const harness = makeHarness({ onCreate: ({ wires, createWire, calls, net }) => {
		const id = calls === 1 ? 'wire-first-named' : 'wire-second-unnamed'
		const line = calls === 1 ? [0, 0, 10, 0] : [10, 0, 10, 10]
		const item = { ...props, id, rawLine: line, sourceLines: [{ id: `line-${id}`, points: line }], net: calls === 1 ? net : '' }
		wires.set(id, item)
		return createWire(item)
	}, autoAttrs: ({ attrs, wires }) => {
		const additions = []
		for (const item of wires.values()) {
			if (attrs.some(attr => attr.parentId === item.id)) continue
			additions.push(sdkNetAttr(`attr-net-${item.id}`, item.id, item.net ?? ''), sdkRelevanceAttr(`attr-rel-${item.id}`, item.id))
		}
		return [...attrs, ...additions]
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0], [10, 10]], net: 'SIG' })
	assert.equal(harness.calls, 2)
	assert.equal(result.named, true, 'first segment naming remains reported while second segment is checked as unnamed')
}

{
	const harness = makeHarness({ onCreate: ({ wires, createWire }) => {
		const item = {
			id: 'wire-nonzero-y-line-field', rawLine: [0, 0, 0, -5],
			sourceDataLine: [0, 0, 0, 5],
			sourceLines: [{ id: 'line-y', points: [0, 0, 0, -5] }], ...props,
		}
		wires.set(item.id, item)
		return createWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [0, -5]] })
	assert.deepEqual(result.primitiveIds, ['wire-nonzero-y-line-field'], 'optional WIRE.line source coordinates must convert to SDK coordinates before matching')
}

{
	const first = { id: 'wire-old', rawLine: [0, 0, 3, 0], sourceLines: [{ id: 'line-old', points: [0, 0, 3, 0] }], ...props }
	const second = { id: 'wire-second', rawLine: [5, 0, 7, 0], sourceLines: [{ id: 'line-second', points: [5, 0, 7, 0] }], ...props }
	const harness = makeHarness({ initialWires: [first, second], onCreate: ({ wires, createWire }) => {
		for (const [wireId, additions, rawLine] of [
			['wire-old', [['line-old-new-a', 3, 4], ['line-old-new-b', 4, 5]], [0, 0, 3, 0, 4, 0, 5, 0]],
			['wire-second', [['line-second-new', 7, 10]], [5, 0, 7, 0, 10, 0]],
		]) {
			const wire = wires.get(wireId)
			wire.sourceLines.push(...additions.map(([lineId, a, b]) => ({ id: lineId, points: [a, 0, b, 0] })))
			wire.rawLine = rawLine
		}
		return createWire(wires.get('wire-old'))
	}, attrMutation: attrs => attrs.map(attr => ({ ...attr, zIndex: attr.zIndex + (attr.parentId === 'wire-old' ? 2 : 1) })) })
	const result = await drawWire({ points: [[0, 0], [10, 0]] })
	assert.equal(result.primitiveIds.length, 2, 'both existing WIREs should retain their requested portions')
	assert.deepEqual(result.drawingOrderChanges.map(change => [change.wireId, change.after - change.before]), [['wire-old', 2], ['wire-old', 2], ['wire-second', 1], ['wire-second', 1]], 'report each real display-index change independently of new LINE count')
}

async function captureError(fn) {
	try { await fn() }
	catch (error) { return error }
	assert.fail('expected drawWire to fail')
}

for (const [sourceLines, shouldPass, label] of [
	[[{ id: 'line-overlap-a', points: [0, 0, 10, 0] }, { id: 'line-overlap-b', points: [5, 0, 15, 0] }], true, 'same covered geometry with different segment decomposition'],
	[[{ id: 'line-overlap-a', points: [0, 0, 10, 0] }, { id: 'line-overlap-b', points: [5, 0, 14, 0] }], false, 'different endpoint'],
	[[{ id: 'line-overlap-a', points: [0, 0, 4, 0] }, { id: 'line-overlap-b', points: [6, 0, 15, 0] }], false, 'real gap'],
]) {
	const harness = makeHarness({ onCreate: ({ wires, createWire }) => {
		const item = { id: `wire-${label.replaceAll(' ', '-')}`, rawLine: [0, 0, 10, 0, 5, 0, 15, 0], sourceDataLine: [0, 0, 10, 0, 5, 0, 15, 0], sourceLines, ...props }
		wires.set(item.id, item)
		return createWire(item)
	} })
	if (shouldPass) {
		const result = await drawWire({ points: [[0, 0], [15, 0]] })
		assert.equal(result.primitiveIds.length, 1, label)
	} else {
		const error = await captureError(() => drawWire({ points: [[0, 0], [15, 0]] }))
		assert.equal(harness.calls, 1)
		assert.equal(error.cause?.partial, true, label)
	}
}

const initial = () => ({ id: 'wire-old', rawLine: [400, 600, 500, 600], sourceLines: [{ id: 'line-old', points: [400, 600, 500, 600] }], ...props })
const appendToOld = ({ wires, attrs, line, createWire, rawLine }) => {
	const item = wires.get('wire-old')
	item.rawLine = rawLine ?? [500, 600, 400, 600, 500, 700, 500, 600]
	item.sourceLines.push({ id: 'line-added', points: [500, 600, 500, 700] })
	return createWire(item)
}

{
	const harness = makeHarness({ initialWire: initial(), onCreate: args => appendToOld({ ...args, rawLine: [500, 600, 400, 600, 500, 700, 500, 600] }), attrMutation: attrs => attrs.map(attr => ({ ...attr, zIndex: attr.zIndex + 1 })) })
	const result = await drawWire({ points: [[500, 600], [500, 700]] })
	assert.deepEqual(result.primitiveIds, ['wire-old'], 'the real eight-number SDK representation must resolve as independent four-tuples')
	assert.deepEqual(result.drawingOrderChanges, [
		{ id: 'attr-net', before: 20, after: 21, wireId: 'wire-old' },
		{ id: 'attr-relevance', before: 21, after: 22, wireId: 'wire-old' },
	])
}

for (const [rawLine, lines, description] of [
	[[0, 0, 5, 0, 10, 0], [{ id: 'line-a', points: [0, 0, 5, 0] }, { id: 'line-b', points: [5, 0, 10, 0] }], 'six-number continuous polyline'],
	[[[0, 0, 5, 0], [5, 0, 10, 0]], [{ id: 'line-a', points: [0, 0, 5, 0] }, { id: 'line-b', points: [5, 0, 10, 0] }], 'two-dimensional path groups'],
	[[10, 0, 5, 0, 5, 0, 0, 0], [{ id: 'line-a', points: [0, 0, 5, 0] }, { id: 'line-b', points: [5, 0, 10, 0] }], 'reversed and reordered independent segments'],
]) {
	const harness = makeHarness({ onCreate: ({ wires, line, createWire }) => {
		const item = { id: 'wire-new', rawLine, sourceLines: lines, ...props }
		wires.set(item.id, item)
		return createWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]] })
	assert.deepEqual(result.primitiveIds, ['wire-new'], `${description} should match source geometry without connecting independent groups`)
	assert.equal(harness.calls, 1)
}

{
	const unrelated = { id: 'wire-unrelated', rawLine: [[20, 20, 25, 20], [40, 40, 40, 45]], sourceLines: [
		{ id: 'line-unrelated-a', points: [20, 20, 25, 20] },
		{ id: 'line-unrelated-b', points: [40, 40, 40, 45] },
	], ...props }
	const harness = makeHarness({ initialWire: unrelated, onCreate: ({ wires, line, createWire }) => {
		const item = { id: 'wire-target', rawLine: line, sourceLines: [{ id: 'line-target', points: line }], ...props }
		wires.set(item.id, item)
		return createWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]] })
	assert.deepEqual(result.primitiveIds, ['wire-target'], 'separate 2D SDK groups must not be connected by flattening')
	assert.equal(harness.calls, 1)
}

for (const [badRaw, badLines, description] of [
	[[500, 600, 400, 600, 500, 700, 500, 600], [{ id: 'line-a', points: [400, 600, 500, 600] }], 'a missing segment'],
	[[500, 600, 400, 600, 500, 700, 500, 600], [{ id: 'line-a', points: [400, 600, 500, 600] }, { id: 'line-b', points: [500, 600, 500, 700] }, { id: 'line-diagonal', points: [400, 600, 500, 700] }], 'an extra diagonal segment'],
	[[500, 600, 400, 600, 500, 700, 500, 600], [{ id: 'line-a', points: [400, 600, 499, 600] }, { id: 'line-b', points: [500, 600, 500, 700] }], 'a wrong endpoint'],
]) {
	const harness = makeHarness({ onCreate: ({ wires, createWire }) => {
		const item = { id: 'wire-bad', rawLine: badRaw, sourceLines: badLines, ...props }
		wires.set(item.id, item)
		return createWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[400, 600], [500, 600]] }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true, `${description} must fail strict source/getter agreement`)
}

for (const mutation of [
	attrs => attrs.map(attr => attr.key === 'NET' ? { ...attr, value: 'OTHER' } : attr),
	attrs => attrs.map(attr => attr.key === 'Relevance' ? { ...attr, value: '2' } : attr),
	attrs => attrs.map(attr => attr.key === 'NET' ? { ...attr, parentId: 'wire-moved' } : attr),
]) {
	const harness = makeHarness({ initialWire: initial(), onCreate: appendToOld, attrMutation: mutation })
	const error = await captureError(() => drawWire({ points: [[500, 600], [500, 700]] }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true, 'net value, ownership and Relevance semantics remain protected')
}

for (const change of [
	{ delta: 1, newLine: false },
	{ delta: 2, newLine: true },
]) {
	const harness = makeHarness({ initialWire: initial(), onCreate: ({ wires, createWire }) => {
		const item = wires.get('wire-old')
		if (change.newLine) {
			item.rawLine = [400, 600, 500, 600, 500, 700, 500, 600]
			item.sourceLines.push({ id: 'line-added', points: [500, 600, 500, 700] })
		}
		return createWire(item)
	}, attrMutation: attrs => attrs.map(attr => ({ ...attr, zIndex: attr.zIndex + change.delta })) })
	if (change.newLine) await drawWire({ points: [[500, 600], [500, 700]] })
	else {
		const error = await captureError(() => drawWire({ points: [[500, 600], [500, 700]] }))
		assert.equal(error.cause?.partial, true, 'missing requested geometry must still fail')
	}
	assert.equal(harness.calls, 1)
}

{
	const harness = makeHarness({ initialWire: initial(), onCreate: appendToOld, nonTargetAttrMutation: attrs => [...attrs, { id: 'attr-unrelated', parentId: 'unrelated', key: 'NET', value: 'X', zIndex: 1 }] })
	const error = await captureError(() => drawWire({ points: [[500, 600], [500, 700]] }))
	assert.equal(error.cause?.partial, true, 'a non-target ATTR addition must remain strictly rejected')
}

{
	const harness = makeHarness({
		initialWire: initial(),
		extraInitialAttrs: [{ id: 'attr-other', parentId: 'another-wire', key: 'Relevance', value: '[]', valueVisible: true, zIndex: 8 }],
		onCreate: appendToOld,
		nonTargetAttrMutation: attrs => attrs.map(attr => attr.id === 'attr-other' ? { ...attr, zIndex: attr.zIndex + 1 } : attr),
	})
	const error = await captureError(() => drawWire({ points: [[500, 600], [500, 700]] }))
	assert.equal(error.cause?.partial, true, 'attribute referencing a nonexistent wire cannot use display normalization')
}

{
	const harness = makeHarness({ initialWire: initial(), onCreate: appendToOld, attrMutation: attrs => [...attrs].reverse().map(attr => ({ ...attr, zIndex: attr.zIndex + 1 })) })
	const result = await drawWire({ points: [[500, 600], [500, 700]] })
	assert.equal(result.primitiveIds[0], 'wire-old', 'source log record ordering alone must not alter ATTR validation')
}

console.log('schematic-drawwire-geometry-regression: PASS')

for (const field of ['x', 'valueVisible']) {
 const harness = makeHarness({initialWire:initial(),onCreate:appendToOld,attrMutation:attrs=>attrs.map(a=>a.key==='NET'?{...a,[field]:field==='x'?a.x+1:false}:a)})
 await drawWire({points:[[500,600],[500,700]]})
 assert.equal(harness.calls,1,'affected automatic label display can be normalized')
}
