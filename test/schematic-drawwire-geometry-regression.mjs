import assert from 'node:assert/strict'
import { installVirtualClock } from './virtual-clock.mjs'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = buildSync({
	stdin: { contents: `import { schematicCommands } from '../src/commands/schematic.ts'; import { registerCommand } from '../src/engine/registry.ts'; export { schematicCommands, registerCommand }`, resolveDir: resolve(root, 'test'), sourcefile: 'schematic-drawwire-geometry-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { schematicCommands, registerCommand } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
for (const command of schematicCommands) registerCommand(command)
const drawWireHandler = schematicCommands.find(item => item.name === 'schematic.drawWire').handler
const clock = installVirtualClock()
try {
const drawWire = params => drawWireHandler({ _timeoutMs: 1000, ...params })

const props = { color: '#000000', width: 6, type: 0, net: 'SIG' }
const attrsDefault = (wireId = 'wire-old') => [
	{ id: `attr-net-${wireId}`, parentId: wireId, key: 'NET', value: 'SIG', visible: true, x: 1, y: 2, zIndex: 20 },
	{ id: `attr-relevance-${wireId}`, parentId: wireId, key: 'Relevance', value: '1', visible: true, x: 3, y: 4, zIndex: 21 },
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
		getState_LineType: () => item.throwLineTypeGetter ? (() => { throw new Error('getter unavailable') })() : Object.hasOwn(item, 'lineType') ? item.lineType : props.type,
		getState_Net: () => Object.hasOwn(item, 'net') ? item.net : props.net,
	})
	const source = () => {
		const rows = [`{"type":"DOCHEAD","ticket":1}||${JSON.stringify({ docType: 'SCH_PAGE', uuid: 'page-1', client: 'test', version: 1 })}`]
		let ticket = 2
		for (const item of wires.values()) {
			rows.push(`${JSON.stringify({ type: 'WIRE', id: item.id, ticket: ticket++ })}||${JSON.stringify({ zIndex: 0, ...(item.sourceDataLine ? { line: item.sourceDataLine } : {}) })}`)
			for (const line of item.sourceLines ?? []) {
			rows.push(`${JSON.stringify({ type: 'LINE', id: line.id, ticket: ticket++ })}||${JSON.stringify({ lineGroup: item.id, startX: line.points[0], startY: -line.points[1], endX: line.points[2], endY: -line.points[3], strokeColor: Object.hasOwn(line, 'color') ? line.color : item.color ?? props.color, strokeWidth: Object.hasOwn(line, 'width') ? line.width : item.lineWidth ?? props.width, strokeStyle: Object.hasOwn(line, 'style') ? line.style : 'SOLID' })}`)
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
	const harness = makeHarness({ onCreate: ({ wires, createWire }) => {
		const item = { id: 'wire-default-null-style', rawLine: [0, 0, 10, 0], sourceLines: [{ id: 'line-null-style', points: [0, 0, 10, 0], style: null }], color: '#000000', lineWidth: 6, lineType: null, net: '' }
		wires.set(item.id, item)
		return createWire(item)
	} })
	const result = await drawWire({ points: [[0, 0], [10, 0]] })
	assert.deepEqual(result.primitiveIds, ['wire-default-null-style'], 'a successful null lineType getter and null source style are a valid default style')
	assert.equal(harness.calls, 1)
}

{
	const harness = makeHarness({ onCreate: ({ wires, createWire }) => {
		const item = { id: 'wire-failed-style-getter', rawLine: [0, 0, 10, 0], sourceLines: [{ id: 'line-failed-style', points: [0, 0, 10, 0], style: null }], color: '#000000', lineWidth: 6, lineType: null, throwLineTypeGetter: true, net: '' }
		wires.set(item.id, item)
		return createWire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]] }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true, 'a throwing getter must not be confused with a valid null style')
}

{
	const noNet = { ...props, net: undefined }
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
	const existingPoint = { id: 'wire-existing-point', rawLine: [5, 5, 5, 5], sourceLines: [{ id: 'line-existing-point', points: [5, 5, 5, 5] }], ...props }
	const harness = makeHarness({ initialWire: existingPoint, onCreate: ({ wires, createWire }) => {
		const item = { id: 'wire-separate-from-point', rawLine: [20, 20, 30, 20], sourceLines: [{ id: 'line-separate-from-point', points: [20, 20, 30, 20] }], ...props }
		wires.set(item.id, item)
		return createWire(item)
	} })
	const result = await drawWire({ points: [[20, 20], [30, 20]] })
	assert.deepEqual(result.primitiveIds, ['wire-separate-from-point'], 'an unrelated existing zero-length point must be preserved exactly')
}

{
	const existing = { id: 'wire-index-normalization', rawLine: [100, 100, 110, 100], sourceLines: [{ id: 'line-index-normalization', points: [100, 100, 110, 100] }], ...props }
	const harness = makeHarness({ initialWire: existing, attrMutation: attrs => attrs.map(attr => attr.parentId === existing.id ? { ...attr, zIndex: attr.zIndex + 2 } : attr), onCreate: ({ wires, createWire }) => {
		const item = { id: 'wire-index-trigger', rawLine: [200, 200, 210, 200], sourceLines: [{ id: 'line-index-trigger', points: [200, 200, 210, 200] }], ...props }
		wires.set(item.id, item)
		return createWire(item)
	} })
	const result = await drawWire({ points: [[200, 200], [210, 200]] })
	assert.deepEqual(result.primitiveIds, ['wire-index-trigger'], 'a valid unrelated display-index shift is not an electrical mismatch')
	assert.deepEqual(result.drawingOrderChanges.map(change => [change.before, change.after]), [[20, 22], [21, 23]])
}

{
	const existing = { id: 'wire-label-recreated', rawLine: [100, 100, 110, 100], sourceLines: [{ id: 'line-label-recreated-old', points: [100, 100, 110, 100] }], ...props }
	const harness = makeHarness({ initialWire: existing, onCreate: ({ wires, attrs, createWire }) => {
		const item = wires.get(existing.id)
		item.rawLine = [100, 100, 110, 100, 120, 100]
		item.sourceLines = [
			{ id: 'line-label-recreated-old', points: [100, 100, 110, 100] },
			{ id: 'line-label-recreated-new', points: [110, 100, 120, 100] },
		]
		const oldIndex = attrs.findIndex(attr => attr.parentId === existing.id && attr.key === 'NET')
		if (oldIndex >= 0) attrs.splice(oldIndex, 1, { id: 'attr-net-recreated-old', x: 105, y: -100, rotation: null, color: null, fontFamily: null, fontSize: null, fontWeight: null, italic: null, underline: null, align: null, value: 'SIG', keyVisible: false, valueVisible: true, key: 'NET', fillColor: null, parentId: existing.id, zIndex: 24 })
		return createWire(item)
	} })
	const result = await drawWire({ points: [[110, 100], [120, 100]] })
	assert.deepEqual(result.primitiveIds, [existing.id], 'an unchanged inherited NET may be recreated on the affected wire')
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
	assert.deepEqual(result.drawingOrderChanges.map(change => [change.wireId, change.after - change.before]), [['wire-old', 2], ['wire-old', 2], ['wire-second', 1], ['wire-second', 1]], 'drawing order follows each wire\'s final per-ATTR zIndex regardless of page-wide LINE count')
}

{
	const harness = makeHarness({ initialWire: { id: 'wire-old', rawLine: [400, 600, 500, 600], sourceLines: [{ id: 'line-old', points: [400, 600, 500, 600] }], ...props }, onCreate: ({ wires, attrs, createWire }) => {
		const item = wires.get('wire-old')
		item.rawLine = [400, 600, 500, 600, 500, 700, 500, 600]
		item.sourceLines.push({ id: 'line-added', points: [500, 600, 500, 700] })
		attrs.push({ id: 'attr-net-duplicate', parentId: 'wire-old', key: 'NET', value: 'SIG', zIndex: 24 })
		return createWire(item)
	} })
	const result = await drawWire({ points: [[500, 600], [500, 700]], net: 'SIG' })
	assert.equal(result.primitiveIds.includes('wire-old'), true, 'duplicate same-parent NET value remains a legal repeated record')
}

{
	const harness = makeHarness({ initialWire: { id: 'wire-old', rawLine: [400, 600, 500, 600], sourceLines: [{ id: 'line-old', points: [400, 600, 500, 600] }], ...props }, onCreate: ({ wires, createWire }) => { const item = wires.get('wire-old'); item.rawLine = [400, 600, 500, 600, 500, 700, 500, 600]; item.sourceLines.push({ id: 'line-added', points: [500, 600, 500, 700] }); return createWire(item) }, attrMutation: attrs => attrs.map(attr => attr.key === 'NET' ? { ...attr, zIndex: attr.zIndex + 2 } : attr) })
	const result = await drawWire({ points: [[500, 600], [500, 700]] })
	assert.deepEqual(result.drawingOrderChanges.map(change => [change.id, change.before, change.after]), [['attr-net-wire-old', 20, 22]], 'one ATTR zIndex may move while sibling ATTR remains unchanged')
	assert.equal(harness.calls, 1)
}

for (const damage of ['delete', 'value', 'parentId', 'added']) {
	const harness = makeHarness({ initialWires: [{ id: 'wire-old', rawLine: [400, 600, 500, 600], sourceLines: [{ id: 'line-old', points: [400, 600, 500, 600] }], ...props }, { id: 'wire-dummy', rawLine: [700, 0, 800, 0], sourceLines: [{ id: 'line-dummy', points: [700, 0, 800, 0] }], ...props }],
		extraInitialAttrs: [{ id: 'attr-custom', parentId: 'wire-dummy', key: 'Custom', value: 'keep-me', visible: true, x: 8, y: 9, zIndex: 30 }],
		onCreate: ({ wires, attrs, createWire }) => {
			const item = wires.get('wire-old')
			item.rawLine = [400, 600, 500, 600, 500, 700, 500, 600]
			item.sourceLines.push({ id: 'line-added', points: [500, 600, 500, 700] })
			wires.delete('wire-dummy')
			const carrier = { id: 'wire-carrier', rawLine: [700, 0, 800, 0], sourceLines: [{ id: 'line-carrier', points: [700, 0, 800, 0] }], ...props }
			wires.set(carrier.id, carrier)
			for (const attr of attrs.filter(record => record.parentId === 'wire-dummy' && ['NET', 'Relevance'].includes(record.key))) attr.parentId = carrier.id
			const custom = attrs.find(attr => attr.id === 'attr-custom')
			if (damage === 'parentId') custom.parentId = carrier.id
			else if (damage === 'value') custom.value = 'corrupted'
			else if (damage === 'delete') attrs.splice(attrs.indexOf(custom), 1)
			else attrs.push({ id: 'attr-custom-new', parentId: carrier.id, key: 'Custom', value: 'unexpected', visible: true, x: 1, y: 2, zIndex: 31 })
			return createWire(item)
		},
	})
	const error = await drawWire({ points: [[500, 600], [500, 700]] }).then(() => undefined, caught => caught)
	assert.ok(error, 'deleting a WIRE must not silently accept custom ATTR damage')
	assert.ok(/普通导线ATTR/.test(error.cause?.result?.partial?.reason ?? ''), 'the dedicated ordinary WIRE ATTR guard rejects the corruption despite a geometrically preserved carrier')
	assert.equal(harness.calls, 1)
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

const appendPolylineToOld = ({ wires, line, createWire, calls }) => {
	const item = wires.get('wire-old')
	if (!Array.isArray(line) || !Array.isArray(item.rawLine)) throw new Error(`bad polyline test input at ${calls}: line=${JSON.stringify(line)} raw=${JSON.stringify(item.rawLine)}`)
	item.rawLine = [...item.rawLine, ...line]
	item.sourceLines.push({ id: `line-added-${calls}`, points: line })
	return createWire(item)
}

{
	const harness = makeHarness({ initialWire: initial(), onCreate: appendPolylineToOld, attrMutation: attrs => attrs.map(attr => attr.parentId === 'wire-old' ? { ...attr, zIndex: attr.zIndex + 1 } : attr) })
	const result = await drawWire({ points: [[500, 600], [510, 600], [520, 600]] })
	assert.deepEqual(result.drawingOrderChanges.map(change => [change.id, change.before, change.after]), [
		['attr-net-wire-old', 20, 22], ['attr-relevance-wire-old', 21, 23],
	], 'the report uses the net change from the initial ATTR snapshot after repeated reindexing')
	assert.equal(harness.calls, 2)
}

{
	let mutationCount = 0
	const harness = makeHarness({ initialWire: initial(), onCreate: appendPolylineToOld, attrMutation: attrs => { mutationCount++; return attrs.map(attr => attr.parentId === 'wire-old' ? { ...attr, zIndex: attr.zIndex + (mutationCount === 1 ? 1 : -1) } : attr) } })
	const result = await drawWire({ points: [[500, 600], [510, 600], [520, 600]] })
	assert.equal(Object.hasOwn(result, 'drawingOrderChanges'), false, 'reindexing back to the initial values produces no report')
}

{
	let mutationCount = 0
	const harness = makeHarness({ onCreate: ({ wires, line, createWire }) => {
		let item = wires.get('wire-created-for-order')
		if (!item) {
			item = { id: 'wire-created-for-order', rawLine: line, sourceLines: [{ id: 'line-created-1', points: line }], net: '' }
			wires.set(item.id, item)
		}
		else {
			item.rawLine = [...item.rawLine, ...line]
			item.sourceLines.push({ id: 'line-created-2', points: line })
		}
		return createWire(item)
	}, autoAttrs: ({ attrs, wires }) => {
		const item = wires.get('wire-created-for-order')
		if (!item || attrs.some(attr => attr.parentId === item.id)) return attrs
		return [...attrs, sdkNetAttr('attr-net-created-for-order', item.id, ''), sdkRelevanceAttr('attr-relevance-created-for-order', item.id)]
	}, attrMutation: attrs => { mutationCount++; return mutationCount === 2 ? attrs.map(attr => attr.parentId === 'wire-created-for-order' ? { ...attr, zIndex: attr.zIndex + 1 } : attr) : attrs } })
	const result = await drawWire({ points: [[0, 0], [10, 0], [20, 0]] })
	assert.equal(Object.hasOwn(result, 'drawingOrderChanges'), false, 'ATTRs created during this command are not initial-to-final changes')
	assert.equal(harness.calls, 2)
}

{
	let mutationCount = 0
	const harness = makeHarness({ initialWire: initial(), onCreate: ({ wires, attrs, line, createWire, calls }) => {
		const result = appendPolylineToOld({ wires, line, createWire, calls })
		if (calls === 2) {
			const index = attrs.findIndex(attr => attr.parentId === 'wire-old' && attr.key === 'NET')
			attrs.splice(index, 1, { ...sdkNetAttr('attr-net-rebuilt-after-write', 'wire-old', 'SIG'), zIndex: attrs[index].zIndex + 1 })
		}
		return result
	}, attrMutation: attrs => { mutationCount++; return mutationCount === 1 ? attrs.map(attr => attr.parentId === 'wire-old' && attr.key === 'NET' ? { ...attr, zIndex: attr.zIndex + 1 } : attr) : attrs } })
	const result = await drawWire({ points: [[500, 600], [510, 600], [520, 600]] })
	assert.equal(Object.hasOwn(result, 'drawingOrderChanges'), false, 'a removed or recreated ATTR ID is not reported as a surviving initial-to-final change')
}

{
	const harness = makeHarness({ initialWire: initial(), onCreate: args => appendToOld({ ...args, rawLine: [500, 600, 400, 600, 500, 700, 500, 600] }), attrMutation: attrs => attrs.map(attr => ({ ...attr, zIndex: attr.zIndex + 1 })) })
	const result = await drawWire({ points: [[500, 600], [500, 700]] })
	assert.deepEqual(result.primitiveIds, ['wire-old'], 'the real eight-number SDK representation must resolve as independent four-tuples')
	assert.deepEqual(result.drawingOrderChanges, [
		{ id: 'attr-net-wire-old', before: 20, after: 21, wireId: 'wire-old' },
		{ id: 'attr-relevance-wire-old', before: 21, after: 22, wireId: 'wire-old' },
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
	attrs => attrs.map(attr => attr.key === 'NET' ? { ...attr, x: attr.x + 1 } : attr),
	attrs => attrs.map(attr => attr.key === 'NET' ? { ...attr, visible: false } : attr),
	attrs => attrs.map(attr => attr.key === 'Relevance' ? { ...attr, value: '2' } : attr),
	attrs => attrs.map(attr => attr.key === 'NET' ? { ...attr, parentId: 'wire-moved' } : attr),
]) {
	const harness = makeHarness({ initialWire: initial(), onCreate: appendToOld, attrMutation: mutation })
	const error = await captureError(() => drawWire({ points: [[500, 600], [500, 700]] }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true, 'all ATTR data except the narrowly allowed zIndex offset must remain exact')
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
	if (change.newLine) {
		const result = await drawWire({ points: [[500, 600], [500, 700]] })
		assert.equal(result.primitiveIds.length, 1, 'pure legal display reindexing is independent of added LINE count')
	}
	else {
		const error = await captureError(() => drawWire({ points: [[500, 600], [500, 700]] }))
		assert.equal(error.cause?.partial, true, 'zIndex drift cannot substitute for the requested geometry')
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
		extraInitialAttrs: [{ id: 'attr-other', parentId: 'another-wire', key: 'Relevance', value: '1', visible: true, zIndex: 8 }],
		onCreate: appendToOld,
		nonTargetAttrMutation: attrs => attrs.map(attr => attr.id === 'attr-other' ? { ...attr, zIndex: attr.zIndex + 1 } : attr),
	})
	const error = await captureError(() => drawWire({ points: [[500, 600], [500, 700]] }))
	assert.equal(error.cause?.partial, true, 'zIndex changes on non-target WIRE attributes must remain strictly rejected')
}

{
	const harness = makeHarness({ initialWire: initial(), onCreate: appendToOld, attrMutation: attrs => [...attrs].reverse().map(attr => ({ ...attr, zIndex: attr.zIndex + 1 })) })
	const result = await drawWire({ points: [[500, 600], [500, 700]] })
	assert.equal(result.primitiveIds[0], 'wire-old', 'source log record ordering alone must not alter ATTR validation')
}

{
 const harness = makeHarness({
  initialWire: {id:'old-owner',rawLine:[0,0,10,0],sourceLines:[{id:'old-line',points:[0,0,10,0]}],...props},
  extraInitialAttrs:[{id:'ordinary-attr',parentId:'old-owner',key:'Custom',value:'keep'}],
  onCreate:({wires,createWire})=>{ wires.clear();const item={id:'new-owner',rawLine:[0,0,20,0],sourceLines:[{id:'new-line',points:[0,0,20,0]}],...props};wires.set(item.id,item);return createWire(item) },
  nonTargetAttrMutation:attrs=>attrs.map(a=>({...a,parentId:a.id==='ordinary-attr'?'component-foreign':'new-owner'}))
 })
 let error
 try { await drawWire({points:[[10,0],[20,0]]}) } catch(e) {error=e}
 assert.equal(error?.cause?.partial,true,'a merge must reject an old WIRE attribute reparented onto a non-wire object')
 assert.equal(harness.calls,1)
 assert.match(error.cause.result.partial.reason,/改归属|非导线/)
}
console.log('schematic-drawwire-geometry-regression: PASS')

} finally { clock.restore() }

