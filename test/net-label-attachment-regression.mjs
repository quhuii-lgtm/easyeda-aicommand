import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `
import { schematicCommands } from '../src/commands/schematic.ts'
import { executeCommand, registerCommand } from '../src/engine/registry.ts'
export { schematicCommands, executeCommand, registerCommand }
`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'net-label-attachment-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { schematicCommands, executeCommand, registerCommand } = await import(moduleUrl)
const commandDef = schematicCommands.find(item => item.name === 'schematic.placeNetLabel')
const placeNetLabel = commandDef.handler
const batchWire = schematicCommands.find(item => item.name === 'schematic.batchWire').handler
const labelWire = schematicCommands.find(item => item.name === 'schematic.labelWire').handler

const makeAttr = ({ id = 'label-1', key = 'NET', value = 'SIG', parentId = 'wire-parent', x = 10, y = 20 } = {}) => ({
	getState_PrimitiveId: () => id,
	getState_Key: () => key,
	getState_Value: () => value,
	getState_ParentPrimitiveId: () => parentId,
	getState_X: () => x,
	getState_Y: () => y,
})
const makeWire = (id = 'wire-parent', net = 'OLD_NET') => ({
	getState_PrimitiveId: () => id,
	getState_Net: () => net,
	getState_Line: () => [0, 20, 40, 20],
})

function installEda({
	parentId = 'wire-parent',
	listedParentId = parentId,
	createdId = 'label-1',
	labelId = 'label-1',
	key = 'NET',
	value = 'SIG',
	wireId = 'wire-parent',
	createReturnsNull = false,
	missingParentAttr = false,
	throwGet = false,
	noCreateLabel = false,
} = {}) {
	let createCalls = 0
	let getByIdCalls = 0
	const attr = makeAttr({ id: labelId, parentId, key, value })
	const createdAttr = makeAttr({ id: createdId, parentId, key, value })
	const listedAttr = makeAttr({ id: labelId, parentId: listedParentId, key, value })
	const wire = makeWire(wireId)
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'doc-A' }) },
		sch_PrimitiveAttribute: {
			createNetLabel: async () => {
				createCalls++
				return createReturnsNull ? undefined : (noCreateLabel ? undefined : createdAttr)
			},
			get: async id => {
				getByIdCalls++
				if (throwGet) throw new Error('attribute get failed')
				return id === 'label-1' ? attr : undefined
			},
			getAll: async parent => {
				if (parent === parentId) return missingParentAttr ? [] : [listedAttr]
				return []
			},
		},
		sch_PrimitiveWire: {
			getAll: async () => [wire],
			get: async id => id === parentId ? wire : undefined,
		},
	}
	return { get createCalls() { return createCalls }, get getByIdCalls() { return getByIdCalls } }
}

async function withInstantTimers(fn) {
	const originalSetTimeout = globalThis.setTimeout
	const originalClearTimeout = globalThis.clearTimeout
	globalThis.setTimeout = (callback, _ms, ...args) => { queueMicrotask(() => callback(...args)); return 1 }
	globalThis.clearTimeout = () => {}
	try { await fn() }
	finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout }
}

async function captureError(fn) {
	try { await fn() }
	catch (error) { return error }
	assert.fail('expected the label operation to fail')
}

await withInstantTimers(async () => {
	// The old nearby-wire heuristic accepted a new root-owned label as attached when force bypassed the guard.
	{
		const state = installEda({ parentId: '$$root' })
		const error = await captureError(() => placeNetLabel({ net: 'SIG', x: 10, y: 20, force: true }, {}))
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause?.primitiveId, 'label-1')
		assert.equal(error.cause?.parentId, '$$root')
		assert.equal(error.cause?.usedX, 10)
		assert.equal(state.createCalls, 1)
	}
	// Partial label creation must stop a real macro even when stopOnError is false.
	{
		const state = installEda({ parentId: '$$root' })
		registerCommand(commandDef)
		let laterWrites = 0
		registerCommand({ name: 'test.afterFloatingLabel', summary: 'marker', params: [], returns: '', handler: async () => { laterWrites++; return true } })
		const result = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
			{ cmd: 'schematic.placeNetLabel', params: { net: 'SIG', x: 10, y: 20, force: true } },
			{ cmd: 'test.afterFloatingLabel' },
		] } })
		assert.equal(result.ok, false)
		assert.equal(result.error?.cause?.partial, true)
		assert.equal(result.data?.stoppedReason, 'partial')
		assert.equal(laterWrites, 0, JSON.stringify(result))
		assert.equal(state.createCalls, 1)
	}
	// A stale old wire.net does not matter when the same label ID and parent relation read back consistently.
	{
		installEda({ parentId: 'wire-parent' })
		const result = await placeNetLabel({ net: 'SIG', x: 10, y: 20, force: true }, {})
		assert.equal(result.attached, true)
		assert.equal(result.wireId, 'wire-parent')
	}
	// Missing parent attributes and failed direct reads are unknown and keep partial evidence.
	for (const options of [{ missingParentAttr: true }, { throwGet: true }]) {
		installEda(options)
		const error = await captureError(() => placeNetLabel({ net: 'SIG', x: 10, y: 20, force: true }, {}))
		assert.equal(error.cause?.partial, true)
		assert.match(error.message, /未知/)
	}
	// Contradictory ID/key/value/wire/parent readbacks are unknown partial outcomes and stop macro writes.
	{
		registerCommand(commandDef)
		let laterWrites = 0
		registerCommand({ name: 'test.afterContradictoryLabel', summary: 'marker', params: [], returns: '', handler: async () => { laterWrites++; return true } })
		const contradictoryCases = [
			{ label: 'label ID mismatch', options: { labelId: 'different-label', createdId: 'label-1' } },
			{ label: 'label key mismatch', options: { key: 'Name' } },
			{ label: 'label value mismatch', options: { value: 'OTHER' } },
			{ label: 'parent wire ID mismatch', options: { wireId: 'different-wire' } },
			{ label: 'parent relation mismatch', options: { listedParentId: 'different-parent' } },
		]
		for (const { label, options } of contradictoryCases) {
			installEda(options)
			const result = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
				{ cmd: 'schematic.placeNetLabel', params: { net: 'SIG', x: 10, y: 20, force: true } },
				{ cmd: 'test.afterContradictoryLabel' },
			] } })
			assert.equal(result.ok, false, `${label} must fail the macro`)
			assert.equal(result.error?.cause?.partial, true, `${label} remains partial`)
			assert.equal(result.data?.stoppedReason, 'partial', `${label} stops on partial even with stopOnError=false`)
			assert.equal(result.data?.steps?.[0]?.error?.cause?.partial, true, `${label} preserves the command partial cause`)
		}
		assert.equal(laterWrites, 0, 'no macro write may follow contradictory attachment evidence')
	}
	// A null create result may find a ghost; it uses the same ID-directed verifier.
	{
		const state = installEda({ createReturnsNull: true })
		const result = await placeNetLabel({ net: 'SIG', x: 10, y: 20, force: true }, {})
		assert.equal(result.primitiveId, 'label-1')
		assert.equal(result.attached, true)
		assert.equal(result.wireId, 'wire-parent')
		assert.equal(state.createCalls, 1, 'the existing ghost is adopted before retrying another coordinate')
	}
	// noVerify explicitly skips the attachment verifier in both normal and ghost adoption paths.
	{
		const normal = installEda()
		const normalResult = await placeNetLabel({ net: 'SIG', x: 10, y: 20, force: true, noVerify: true }, {})
		assert.equal(normalResult.attached, undefined)
		assert.equal(normal.getByIdCalls, 0)
	}
	{
		const ghost = installEda({ createReturnsNull: true })
		const ghostResult = await placeNetLabel({ net: 'SIG', x: 10, y: 20, force: true, noVerify: true }, {})
		assert.equal(ghostResult.attached, undefined)
		assert.equal(ghost.getByIdCalls, 0)
	}
})

// batchWire forwards stubLen and labelWire rejects a candidate that only touches another net at its endpoint.
{
	let sourceRows = [
		`{"type":"DOCHEAD"}||${JSON.stringify({ docType: 'SCH_PAGE', uuid: 'doc-A' })}`,
		`{"type":"WIRE","id":"wire-other"}||${JSON.stringify({ line: [30, 0, 40, 0] })}`,
		`{"type":"LINE","id":"line-other"}||${JSON.stringify({ lineGroup: 'wire-other', startX: 30, startY: 0, endX: 40, endY: 0, strokeColor: '#000000', strokeWidth: 6, strokeStyle: 'SOLID' })}`,
	].join('\n')
	const pin = {
		getState_PinNumber: () => '1', getState_X: () => 0, getState_Y: () => 0,
		getState_Rotation: () => 0, getState_PinLength: () => 10, getState_NoConnected: () => false,
	}
	const component = { getState_PrimitiveId: () => 'component-1', getState_Designator: () => 'U1', getState_X: () => 0, getState_Y: () => 0 }
	const otherWire = { getState_PrimitiveId: () => 'wire-other', getState_Net: () => 'OTHER', getState_Line: () => [30, 0, 40, 0] }
	let createdStub
	let stubSourceReads = 0
	let neverSync = false
	let createCount = 0
	const stubWire = { getState_PrimitiveId:()=>"stub-new",getState_Net:()=>"TARGET",getState_Line:()=>createdStub }
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'doc-A' }) },
		sys_FileManager: { getDocumentSource: async () => {
 if (!createdStub || neverSync || ++stubSourceReads <= 2) return sourceRows
 return sourceRows+'\n'+JSON.stringify({type:'WIRE',id:'stub-new'})+'||{}\n'+JSON.stringify({type:'LINE',id:'stub-line'})+'||'+JSON.stringify({lineGroup:'stub-new',startX:createdStub[0],startY:-createdStub[1],endX:createdStub[2],endY:-createdStub[3]})
 } },
		sch_PrimitiveComponent: { getAll: async () => [component], getAllPinsByPrimitiveId: async () => [pin] },
		sch_PrimitiveWire: {
			getAll: async () => createdStub ? [otherWire,stubWire] : [otherWire],
			create: async line => { createCount++; createdStub = line; return { getState_PrimitiveId: () => 'stub-new' } },
		},
		sch_PrimitiveAttribute: {
			createNetLabel: async () => ({ getState_PrimitiveId: () => 'label-new' }),
		},
	}
	const result = await batchWire({ items: [{ type: 'label', pin: 'U1.1', net: 'TARGET', stubLen: 30 }], skipAudit: true })
	assert.equal(result.items[0].ok, true, JSON.stringify(result))
	assert.deepEqual(createdStub, [0, 0, 0, 30], 'the default +X route touches a different-net endpoint, so the next +Y candidate is selected')
	assert.equal(result.items[0].data.stubReadbackVerified, true, 'batch item waits through two missing-source samples')
	assert.ok(stubSourceReads >= 3)
	assert.equal(result.items[0].data.stubLen, 30, 'batchWire passes explicit stubLen through to labelWire')
	sourceRows = [
 '{"type":"DOCHEAD"}||{"docType":"SCH_PAGE","uuid":"doc-A"}',
 '{"type":"WIRE","id":"wire-other"}||{}',
 ...[[-20,0,-10,0],[10,0,20,0]].map((p,i)=>JSON.stringify({type:'LINE',id:'gap-'+i})+'||'+JSON.stringify({lineGroup:'wire-other',startX:p[0],startY:-p[1],endX:p[2],endY:-p[3]}))
 ].join('\n')
 createdStub = undefined; stubSourceReads = 0
 otherWire.getState_Line = () => [-20,0,-10,0,10,0,20,0]
 const gapResult = await labelWire({ pin:'U1.1',net:'TARGET',stubLen:30 })
 assert.equal(gapResult.alreadyConnected, undefined, 'disconnected LINE segments cannot create a phantom wire through the pin')
 assert.deepEqual(createdStub,[0,0,0,30], 'real segments still reject crossing routes')
 createdStub = undefined; stubSourceReads = 0; neverSync = true
 const beforeCreates = createCount
 let batchError
 try { await batchWire({ items:[{type:'label',pin:'U1.1',net:'TARGET',stubLen:31},{type:'label',pin:'U1.1',net:'OTHER',stubLen:31}],skipAudit:true,continueOnError:true }) } catch(e) { batchError = e }
 assert.equal(batchError?.cause?.partial,true,'unconfirmed previous item stops even continueOnError')
 assert.equal(createCount,beforeCreates+1,'a missing-source stub must never start the following item')
 createdStub=undefined; sourceRows=sourceRows.replace('doc-A','wrong-source')
 const beforeIdentityCheck=createCount
 await assert.rejects(()=>labelWire({pin:'U1.1',net:'TARGET',stubLen:30}),/源码不是当前原理图页/)
 assert.equal(createCount,beforeIdentityCheck,'wrong-source UUID stops before any write')
 assert.equal(await labelWire({ pin: 'U1.1', net: 'TARGET', stubLen: 0 }).then(() => false, () => true), true, 'invalid per-item length is rejected before creating a wire')
}

console.log('PASS ID-directed attachment, partial stop, batch stubLen=30 forwarding, and different-net endpoint collision avoidance')
