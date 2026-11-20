import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const bundle = 'test/.schematic-autolayout-topology-regression-bundle.mjs'

function pin(number, x, y) {
	return {
		getState_PinNumber: () => String(number),
		getState_X: () => x,
		getState_Y: () => y,
	}
}

function component(designator, primitiveId, pinNumber, x, y) {
	const state = {
		x, y, rotation: 0, mirror: false, primitiveType: 'Component', componentType: 'part',
		component: {}, symbol: {}, footprint: {}, subPartName: undefined, addIntoBom: true, addIntoPcb: true,
		net: undefined, designator, name: designator, uniqueId: primitiveId, manufacturer: undefined,
		manufacturerId: undefined, supplier: undefined, supplierId: undefined, otherProperty: {},
	}
	const suffixes = {
		x: 'X', y: 'Y', rotation: 'Rotation', mirror: 'Mirror', primitiveType: 'PrimitiveType',
		componentType: 'ComponentType', component: 'Component', symbol: 'Symbol', footprint: 'Footprint',
		subPartName: 'SubPartName', addIntoBom: 'AddIntoBom', addIntoPcb: 'AddIntoPcb', net: 'Net',
		designator: 'Designator', name: 'Name', uniqueId: 'UniqueId', manufacturer: 'Manufacturer',
		manufacturerId: 'ManufacturerId', supplier: 'Supplier', supplierId: 'SupplierId', otherProperty: 'OtherProperty',
	}
	const sdk = { getState_PrimitiveId: () => primitiveId }
	for (const [field, suffix] of Object.entries(suffixes)) sdk[`getState_${suffix}`] = () => state[field]
	sdk.toAsync = () => {
		const draft = { ...state }
		draft.setState_X = value => { draft.x = value; return draft }
		draft.setState_Y = value => { draft.y = value; return draft }
		draft.setState_Rotation = value => { draft.rotation = value; return draft }
		draft.setState_Mirror = value => { draft.mirror = value; return draft }
		draft.done = async () => { state.x = draft.x; state.y = draft.y; state.rotation = draft.rotation; state.mirror = draft.mirror; return sdk }
		return draft
	}
	return { sdk, state, pin: pin(pinNumber, x, y) }
}

function wire(id, line) {
	return {
		getState_PrimitiveId: () => id,
		getState_Line: () => line,
	}
}

async function runFixture({ failPinsFor = [], designators, targetRefs, netRows, wireRows }) {
	const components = designators.map(([ref, id, number, x, y]) => component(ref, id, number, x, y))
	const wires = new Map(wireRows.map(([id, line]) => [id, wire(id, line)]))
	const deleted = []
	const batchCalls = []
	const moveCalls = []
	const netlist = { components: {} }
	for (const [ref, id, number, net] of netRows)
		netlist.components[id] = { props: { Designator: ref }, pinInfoMap: { [number]: { net } } }
	globalThis.eda = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: 'page-a', documentType: 1, parentProjectUuid: 'project-a' }) },
		sch_ManufactureData: { getNetlistFile: async () => new Blob([JSON.stringify(netlist)]) },
		sch_Netlist: { getNetlist: async () => '' },
		sch_PrimitiveComponent: {
			getAll: async () => components.map(item => item.sdk),
			get: async id => {
				const item = components.find(entry => entry.sdk.getState_PrimitiveId() === id)
				if (item) moveCalls.push(id)
				return item?.sdk
			},
			getAllPinsByPrimitiveId: async id => {
				const item = components.find(entry => entry.sdk.getState_PrimitiveId() === id)
				if (failPinsFor.includes(item?.sdk.getState_Designator())) throw new Error('injected pin read failure')
				return item ? [item.pin] : []
			},
		},
		sch_PrimitiveWire: {
			getAll: async () => [...wires.values()],
			delete: async ids => { for (const id of ids) { deleted.push(id); wires.delete(id) } return true },
		},
		sch_PrimitiveAttribute: { getAll: async () => [], getAllPrimitiveId: async () => [], get: async () => [] },
	}
	const autoLayout = globalThis.__autoLayout
	const mod = globalThis.__schematicModule
	const batch = mod.schematicCommands.find(item => item.name === 'schematic.batchWire')
	const drc = mod.schematicCommands.find(item => item.name === 'schematic.runDrc')
	const priorBatch = batch.handler
	const priorDrc = drc.handler
	batch.handler = async params => { batchCalls.push(params); return { items: params.items.map(item => ({ item, ok: true })), audit: [] } }
	drc.handler = async () => ({ passed: true, fatalCount: 0, totalCount: 0 })
	try {
		return {
			result: await autoLayout({ designators: targetRefs, dryRun: false, rewire: true, template: { origin: { x: 300, y: 300 }, maxCols: 2 } }),
			components,
			wires,
			deleted,
			batchCalls,
			moveCalls,
		}
	}
	finally {
		batch.handler = priorBatch
		drc.handler = priorDrc
	}
}

try {
	await build({
		stdin: {
			contents: `import { schematicCommands } from '../src/commands/schematic.ts'; export { schematicCommands }`,
			resolveDir: resolve(ROOT, 'test'),
			sourcefile: '.schematic-autolayout-topology-entry.ts',
		},
		outfile: bundle,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node24',
	})
	const mod = await import(pathToFileURL(resolve(bundle)).href)
	globalThis.__schematicModule = mod
	globalThis.__autoLayout = mod.schematicCommands.find(item => item.name === 'schematic.autoLayout').handler

	const protectedCase = await runFixture({
		failPinsFor: ['J1'],
		targetRefs: ['C1', 'C2'],
		designators: [
			['C1', 'component-c1', '1', 0, 0], ['J1', 'component-j1', '1', 20, 0],
			['C2', 'component-c2', '1', 100, 0], ['J2', 'component-j2', '1', 120, 0],
		],
		netRows: [['C1', 'component-c1', '1', 'N_BAD'], ['J1', 'component-j1', '1', 'N_BAD'], ['C2', 'component-c2', '1', 'N_SAFE'], ['J2', 'component-j2', '1', 'N_SAFE']],
		wireRows: [['bad-wire', [0, 0, 20, 0]], ['safe-wire', [100, 0, 120, 0]]],
	})
	assert.deepEqual(protectedCase.result.moved.map(item => item.designator), ['C2'], 'unaffected target proceeds while the branch with an unread external pin stays stationary')
	assert.equal(protectedCase.components.find(item => item.sdk.getState_Designator() === 'C1').state.x, 0, 'target on the protected branch did not move')
	assert.ok(protectedCase.wires.has('bad-wire'), 'wire on the branch with an unread external pin was not deleted')
	assert.deepEqual(protectedCase.deleted, ['safe-wire'], 'only the fully evidenced, unaffected branch was eligible for deletion')
	assert.deepEqual(protectedCase.result.protectedBranches.map(item => item.net), ['N_BAD'], 'result identifies the protected net')
	assert.deepEqual(protectedCase.batchCalls.flatMap(call => call.items).map(item => item.pins?.join(',') ?? item.pin), ['C2.1,J2.1'], 'only unaffected net membership is submitted for reconstruction')

	const normalCase = await runFixture({
		targetRefs: ['C3'],
		designators: [['C3', 'component-c3', '1', 0, 0], ['J3', 'component-j3', '1', 20, 0]],
		netRows: [['C3', 'component-c3', '1', 'N_OK'], ['J3', 'component-j3', '1', 'N_OK']],
		wireRows: [['normal-wire', [0, 0, 20, 0]]],
	})
	assert.deepEqual(normalCase.result.moved.map(item => item.designator), ['C3'], 'normal path still moves the target')
	assert.deepEqual(normalCase.deleted, ['normal-wire'], 'normal path still removes the old incident wire after movement')
	assert.deepEqual(normalCase.batchCalls.flatMap(call => call.items).map(item => item.pins?.join(',') ?? item.pin), ['C3.1,J3.1'], 'normal path rebuilds the complete net')
	console.log('PASS schematic auto-layout topology regression (protected partial reads and normal path)')
}
finally {
	delete globalThis.__schematicModule
	delete globalThis.__autoLayout
	await rm(resolve(ROOT, bundle), { force: true })
}
