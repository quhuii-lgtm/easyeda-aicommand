import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "import { pcbCommands } from '../src/commands/pcb.ts'; export { pcbCommands }",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-pour-fill-status-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { pcbCommands } = await import(moduleUrl)
const listPours = pcbCommands.find(item => item.name === 'pcb.listPours').handler

const validSource = [10, 20, 'L', 30, 20, 30, 40]
const fill = (id, filled, overrides = {}) => ({
	id,
	fill: filled,
	lineWidth: 0.2,
	...(filled ? { path: { getSource: () => validSource } } : {}),
	...overrides,
})

async function readStatus(region, options = {}) {
	const pour = {
		getState_PrimitiveId: () => 'pour-1',
		getState_Net: () => 'GND',
		getState_Layer: () => 1,
		getState_PourName: () => 'GND_TOP',
		getState_PourPriority: () => 0,
		getState_LineWidth: () => 12,
		getState_PourFillMethod: () => 0,
		getState_PrimitiveLock: () => false,
		getCopperRegion: async () => {
			if (options.readError)
				throw options.readError
			return region
		},
	}
	globalThis.eda = { pcb_PrimitivePour: { getAll: async () => [pour] } }
	return (await listPours({ withFill: true }))[0]
}

const cases = [
	{
		name: 'no-associated-region',
		read: () => readStatus(undefined),
		check: result => {
			assert.equal(result.fillStatus, 'empty')
			assert.equal(result.filled, false)
			assert.equal(result.fillRegions, 0)
			assert.equal(result.filledRegions, 0)
		},
	},
	{
		name: 'valid-empty-array',
		read: () => readStatus({ getState_PrimitiveId: () => 'poured-1', getState_PourFills: () => [] }),
		check: result => {
			assert.equal(result.fillStatus, 'empty')
			assert.equal(result.filled, false)
			assert.equal(result.fillRegions, 0)
			assert.equal(result.filledRegions, 0)
		},
	},
	{
		name: 'all-valid-fill-false',
		read: () => readStatus({ getState_PrimitiveId: () => 'poured-1', getState_PourFills: () => [fill('region-0', false), fill('region-1', false)] }),
		check: result => {
			assert.equal(result.fillStatus, 'empty')
			assert.equal(result.filled, false)
			assert.equal(result.fillRegions, 2)
			assert.equal(result.filledRegions, 0)
		},
	},
	{
		name: 'mixed-false-and-valid-true',
		read: () => readStatus({ getState_PrimitiveId: () => 'poured-1', getState_PourFills: () => [fill('region-0', false), fill('region-1', true)] }),
		check: result => {
			assert.equal(result.fillStatus, 'filled')
			assert.equal(result.filled, true)
			assert.equal(result.fillRegions, 2)
			assert.equal(result.filledRegions, 1)
		},
	},
	{
		name: 'missing-fill-field',
		read: () => readStatus({ getState_PrimitiveId: () => 'poured-1', getState_PourFills: () => [{}] }),
		check: result => {
			assert.equal(result.fillStatus, 'unknown')
			assert.equal(result.filled, null)
			assert.equal(result.fillRegions, 1)
			assert.equal(result.fillReadError != null, true)
		},
	},
	{
		name: 'invalid-fill-type',
		read: () => readStatus({ getState_PrimitiveId: () => 'poured-1', getState_PourFills: () => [fill('region-0', false, { fill: 0 })] }),
		check: result => {
			assert.equal(result.fillStatus, 'unknown')
			assert.equal(result.filled, null)
			assert.equal(result.fillRegions, 1)
		},
	},
	{
		name: 'invalid-true-path',
		read: () => readStatus({ getState_PrimitiveId: () => 'poured-1', getState_PourFills: () => [fill('region-0', true, { path: { getSource: () => [] } })] }),
		check: result => {
			assert.equal(result.fillStatus, 'unknown')
			assert.equal(result.filled, null)
			assert.equal(result.fillRegions, 1)
		},
	},
	{
		name: 'throwing-true-path',
		read: () => readStatus({ getState_PrimitiveId: () => 'poured-1', getState_PourFills: () => [fill('region-0', true, { path: { getSource: () => { throw new Error('path read failed') } } })] }),
		check: result => {
			assert.equal(result.fillStatus, 'unknown')
			assert.equal(result.filled, null)
			assert.match(result.fillReadError, /path read failed/)
		},
	},
	{
		name: 'throwing-associated-read',
		read: () => readStatus(undefined, { readError: new Error('region read failed') }),
		check: result => {
			assert.equal(result.fillStatus, 'unknown')
			assert.equal(result.filled, null)
			assert.match(result.fillReadError, /region read failed/)
		},
	},
]

const results = []
for (const item of cases) {
	const result = await item.read()
	try {
		item.check(result)
		results.push({ name: item.name, status: result.fillStatus, passed: true })
	}
	catch (error) {
		results.push({
			name: item.name,
			status: result.fillStatus,
			filled: result.filled,
			fillRegions: result.fillRegions ?? null,
			filledRegions: result.filledRegions ?? null,
			passed: false,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

console.log(JSON.stringify({ cases: results }, null, 2))
assert.equal(results.every(result => result.passed), true, 'listPours must distinguish empty, filled, and unknown fill states')
console.log('PASS pcb.listPours fill-status structural and path regression')
