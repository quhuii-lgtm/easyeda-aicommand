import assert from 'node:assert/strict'
import { installVirtualClock } from './virtual-clock.mjs'
import { buildSync } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = buildSync({
	stdin: {
		contents: `import { schematicCommands } from '../src/commands/schematic.ts'; import { registerCommand } from '../src/engine/registry.ts'; export { schematicCommands, registerCommand }`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'schematic-drawwire-lag-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { schematicCommands, registerCommand } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
for (const command of schematicCommands) registerCommand(command)
const drawWireHandler = schematicCommands.find(item => item.name === 'schematic.drawWire').handler
const clock = installVirtualClock()
try {
const drawWire = params => drawWireHandler({ _timeoutMs: 1000, ...params })

function makeHarness({ onCreate, lagReads = 0, persistentLag = false, changeFocusAfterLag = false, wrongGeometry = false, transientSourceReads = 0, transientKind = "geometry", finalDrift, failAfterFirstSample = false, lateSourceMs = 0, lateModelMs = 0 } = {}) {
	const wires = new Map()
	let calls = 0
	let readsAfterWrite = 0
	let sourceReads = 0
	let postSourceReads = 0
	let modelReads = 0
	let focusUuid = 'page-1'
	let transientSamples = 0
	const wire = item => ({
		getState_PrimitiveId: () => item.id,
		getState_Line: () => item.line,
		getState_Color: () => item.color,
		getState_LineWidth: () => item.lineWidth,
		getState_LineType: () => item.lineType,
		getState_Net: () => item.net,
	})
	const source = () => {
 if (finalDrift === 'style' && postSourceReads >= 2) for (const item of wires.values()) item.lineWidth = 99
		const rows = [`{"type":"DOCHEAD","ticket":1}||${JSON.stringify({ docType: 'SCH_PAGE', uuid: 'page-1', client: 'test', version: 1 })}`]
		rows.push('{"type":"TEXT","id":"non-target"}||' + JSON.stringify({text: finalDrift === 'attribute' && postSourceReads >= 2 ? 'changed' : 'original', x:100, y:100}))
		let ticket = 2
		for (const item of wires.values()) {
			rows.push(`${JSON.stringify({ type: 'WIRE', id: item.id, ticket: ticket++ })}||${JSON.stringify({ zIndex: 0 })}`)
			for (let i = 0; i + 3 < item.line.length; i += 2) {
				const transient = calls > 0 && transientSamples < transientSourceReads
				const endX = wrongGeometry || (transient && transientKind === "geometry") ? item.line[i + 2] + 1 : item.line[i + 2]
				rows.push(`${JSON.stringify({ type: 'LINE', id: `line-${item.id}-${i}`, ticket: ticket++ })}||${JSON.stringify({ lineGroup: item.id, startX: item.line[i], startY: -item.line[i + 1], endX, endY: -item.line[i + 3], strokeColor: item.color, strokeWidth: transient && transientKind === 'style' ? 99 : item.lineWidth, strokeStyle: 'SOLID' })}`)
			}
		}
		if (calls > 0 && transientSamples < transientSourceReads) {
			if (transientKind === 'attr') rows.push('{"type":"ATTR","id":"transient-attr"}||{"parentId":"wire-created","key":"Unexpected","value":"lag"}')
			transientSamples++
		}
		return rows.join('\n')
	}
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: focusUuid }) },
		sys_FileManager: { getDocumentSource: async () => {
			sourceReads++
 if(calls > 0) postSourceReads++
 if(failAfterFirstSample && postSourceReads > 1) throw new Error('injected latest capture failure')
			if (calls > 0 && lateSourceMs) await new Promise(resolve => setTimeout(resolve, lateSourceMs))
			return source()
		} },
		sch_PrimitiveAttribute: { getAll: async () => [] },
		sch_PrimitiveWire: {
			getAll: async () => {
				modelReads++
				if (calls > 0 && lateModelMs) await new Promise(resolve => setTimeout(resolve, lateModelMs))
				if (calls > 0 && (persistentLag || readsAfterWrite < lagReads)) {
					readsAfterWrite++
					if (changeFocusAfterLag && readsAfterWrite === 1) focusUuid = 'page-2'
					return []
				}
				return [...wires.values()].map(wire)
			},
			create: async (line, net, color, lineWidth, lineType) => {
				calls++
				return onCreate({ wires, calls, line, net, color, lineWidth, lineType, wire })
			},
		},
	}
	return { wires, get calls() { return calls }, get readsAfterWrite() { return readsAfterWrite }, get sourceReads() { return sourceReads }, get modelReads() { return modelReads } }
}

async function captureError(fn) {
	try { await fn() }
	catch (error) { return error }
	assert.fail('expected drawWire to fail')
}

const standardCreate = ({ wires, line, color, lineWidth, lineType, wire }) => {
	const item = { id: 'wire-created', line, color: color ?? '#000000', lineWidth: lineWidth ?? 6, lineType: lineType ?? 0 }
	wires.set(item.id, item)
	return wire(item)
}

{
	const harness = makeHarness({ lagReads: 1, onCreate: standardCreate })
	const result = await drawWire({ points: [[0, 0], [10, 0]] })
	assert.deepEqual(result.primitiveIds, ['wire-created'], 'one transiently empty SDK enumeration should synchronize through read-only sampling')
	assert.equal(harness.calls, 1, 'resampling must never repeat create')
	assert.equal(harness.readsAfterWrite, 1)
}

{
	const harness = makeHarness({ persistentLag: true, onCreate: standardCreate })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0], [10, 10]], _timeoutMs: 1000 }))
	assert.equal(harness.calls, 1, 'persistent ID mismatch must stop before the next segment write')
	assert.equal(error.cause?.partial, true)
	assert.equal(error.cause?.retryable, false)
	assert.deepEqual(error.cause?.result?.partial?.wireIdSync?.sourceWireIds, ['wire-created'])
	assert.deepEqual(error.cause?.result?.partial?.wireIdSync?.sdkWireIds, [])
	assert.equal(typeof error.cause?.result?.partial?.wireIdSync?.sampledAt, 'string')
}

{
	const harness = makeHarness({ lagReads: 1, changeFocusAfterLag: true, onCreate: standardCreate })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0], [10, 10]] }))
	assert.equal(harness.calls, 1, 'focus change during synchronization must stop immediately without another create')
	assert.equal(error.cause?.partial, true)
	assert.match(error.cause?.result?.partial?.reason ?? '', /焦点/)
}

{
	const harness = makeHarness({ wrongGeometry: true, onCreate: standardCreate })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0]] }))
	assert.equal(harness.calls, 1)
	assert.equal(error.cause?.partial, true, 'aligned IDs must still undergo the original complete geometry validation')
	assert.match(error.cause?.result?.partial?.reason ?? error.message, /几何/)
}

for (const delayedRead of ['source', 'model']) {
	const harness = makeHarness({
		...(delayedRead === 'source' ? { lateSourceMs: 650 } : { lateModelMs: 650 }),
		onCreate: standardCreate,
	})
	const result = await drawWire({ points: [[0, 0], [10, 0]], _timeoutMs: 5000 })
	assert.deepEqual(result.primitiveIds, ['wire-created'], `${delayedRead} read delayed by 650ms should complete within the total deadline`)
	assert.equal(harness.calls, 1, `${delayedRead} recovery is read-only and must not repeat create`)
}

for (const delayedRead of ['source', 'model']) {
	const harness = makeHarness({
		...(delayedRead === 'source' ? { lateSourceMs: 1100 } : { lateModelMs: 1100 }),
		onCreate: standardCreate,
	})
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0], [10, 10]], _timeoutMs: 1000 }))
	assert.equal(harness.calls, 1, `${delayedRead} read timeout must not permit a following segment write`)
	assert.equal(error.cause?.partial, true)
	const readsAtFailure = { source: harness.sourceReads, model: harness.modelReads }
	await new Promise(resolve => setTimeout(resolve, 500))
	assert.equal(harness.calls, 1, `${delayedRead} late completion must not resume the command`)
	assert.deepEqual({ source: harness.sourceReads, model: harness.modelReads }, readsAtFailure, `${delayedRead} late completion must not start subsequent reads`)
}

{
	const harness = makeHarness({ lateSourceMs: 900, onCreate: async ({ wires, line, color, lineWidth, lineType, wire }) => {
		await new Promise(resolve => setTimeout(resolve, 400))
		const item = { id: 'wire-created', line, color: color ?? '#000000', lineWidth: lineWidth ?? 6, lineType: lineType ?? 0 }
		wires.set(item.id, item)
		return wire(item)
	} })
	const error = await captureError(() => drawWire({ points: [[0, 0], [10, 0], [10, 10]], _timeoutMs: 1500 }))
	assert.equal(harness.calls, 1, 'first segment consuming the shared deadline must stop before the second segment create')
	assert.equal(error.cause?.partial, true)
}

for (const transientKind of ['geometry', 'style', 'attr']) {
 const harness = makeHarness({ transientSourceReads: 2, transientKind, onCreate: standardCreate })
 const result = await drawWire({ points: [[0, 0], [10, 0]], lineWidth: 6 })
 assert.deepEqual(result.primitiveIds, ['wire-created'], transientKind + ' must converge through full read-only validation with unchanged IDs')
 assert.equal(harness.calls, 1, 'full convergence must not repeat create')
 assert.deepEqual(result.drawingOrderChanges ?? [], [], 'rejected samples cannot publish changes')
}
for (const finalDrift of ['style', 'attribute']) {
 const harness = makeHarness({ finalDrift, onCreate: standardCreate })
 const error = await captureError(() => drawWire({ points: [[0,0],[10,0]] }))
 assert.equal(error.cause?.partial, true, finalDrift + ' final drift must fail')
 assert.equal(error.cause?.result?.verification?.lastVerifiedPhase, 'post-write', 'rejected final sample is not verified')
 assert.equal(harness.calls, 1)
}
{
 const harness = makeHarness({ wrongGeometry: true, failAfterFirstSample: true, onCreate: standardCreate })
 const error = await captureError(() => drawWire({ points: [[0,0],[10,0],[10,10]] }))
 assert.equal(error.cause?.result?.partial?.state, 'unknown', 'latest capture failure must not inherit older complete validation classification')
 assert.equal(harness.calls, 1)
}
console.log('schematic-drawwire-lag-regression: PASS')

} finally { clock.restore() }
