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

console.log('PASS ID-directed net-label attachment, unknown/partial stop, ghost adoption, and noVerify semantics')
