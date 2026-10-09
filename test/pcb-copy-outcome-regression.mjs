import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `
import { projectCommands } from '../src/commands/project.ts'
import { executeCommand, registerCommand } from '../src/engine/registry.ts'
export { projectCommands, executeCommand, registerCommand }
`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-copy-outcome-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { projectCommands, executeCommand, registerCommand } = await import(moduleUrl)
for (const command of projectCommands) registerCommand(command)
const copyPcb = projectCommands.find(command => command.name === 'project.copyPcb')
assert.ok(copyPcb)

let markerWrites = 0
registerCommand({
	name: 'test.markerWrite', summary: 'marker', params: [], returns: '{}',
	handler: async () => { markerWrites++; return { written: true } },
})

async function rejectsUnknown(params, configureSdk, label, expectedBoardName) {
	let copies = 0
	let extraApiCalls = 0
	let copySideEffects = 0
	globalThis.eda = {
		dmt_Pcb: {
			copyPcb: async (...args) => {
				copies++
				assert.deepEqual(args, ['source-pcb', expectedBoardName])
				return configureSdk(() => { copySideEffects++ })
			},
			getAllPcbsInfo: async () => { extraApiCalls++; return [] },
		},
		dmt_Project: { getCurrentProjectInfo: async () => { extraApiCalls++; return {} } },
	}
	await assert.rejects(copyPcb.handler(params), error => {
		assert.equal(error.cause?.partial, true, label)
		assert.equal(error.cause?.retryable, false, label)
		assert.equal(error.cause?.result?.sourcePcbUuid, 'source-pcb', label)
		assert.equal(error.cause?.result?.requestedBoardName, expectedBoardName ?? null, label)
		assert.equal(error.cause?.result?.pcbUuid, 'unknown', label)
		assert.match(error.message, /结果未知/)
		assert.match(error.message, /project\.getInfo \/ project\.listPcbs/)
		assert.match(error.message, /不要自动重试/)
		if (label === 'SDK throw' || label === 'SDK throw after write')
			assert.match(error.message, /SDK copy rejected|SDK threw after creating copy/, label)
		else
			assert.equal(error.cause?.operationError, 'SDK 返回空值', label)
		return true
	})
	assert.equal(copies, 1, `${label}: SDK copy called once`)
	assert.equal(extraApiCalls, 0, `${label}: no other SDK calls or implicit readback`)
	assert.equal(copySideEffects, label === 'SDK throw after write' ? 1 : 0, `${label}: simulated SDK side effect is tracked independently from calls`)
}

{
	let copies = 0
	let otherWrites = 0
	globalThis.eda = {
		dmt_Pcb: {
			copyPcb: async (...args) => { copies++; assert.deepEqual(args, ['source-pcb', 'BoardTarget']); return 'copy-pcb' },
			getAllPcbsInfo: async () => { otherWrites++; return [] },
		},
		dmt_Project: { getCurrentProjectInfo: async () => { otherWrites++; return {} } },
	}
	assert.deepEqual(await copyPcb.handler({ pcbUuid: 'source-pcb', boardName: 'BoardTarget' }), { pcbUuid: 'copy-pcb' })
	assert.equal(copies, 1)
	assert.equal(otherWrites, 0)
}

{
	let copies = 0
	let otherWrites = 0
	globalThis.eda = {
		dmt_Pcb: {
			copyPcb: async (...args) => { copies++; assert.deepEqual(args, ['source-pcb', undefined]); return 'loose-copy' },
			getAllPcbsInfo: async () => { otherWrites++; return [] },
		},
		dmt_Project: { getCurrentProjectInfo: async () => { otherWrites++; return {} } },
	}
	assert.deepEqual(await copyPcb.handler({ pcbUuid: 'source-pcb' }), { pcbUuid: 'loose-copy' })
	assert.equal(copies, 1)
	assert.equal(otherWrites, 0)
}

await rejectsUnknown({ pcbUuid: 'source-pcb', boardName: 'BoardTarget' }, () => undefined, 'empty SDK return', 'BoardTarget')
await rejectsUnknown({ pcbUuid: 'source-pcb' }, () => { throw new Error('SDK copy rejected') }, 'SDK throw', undefined)
await rejectsUnknown({ pcbUuid: 'source-pcb', boardName: 'BoardTarget' }, recordWrite => {
	recordWrite()
	throw new Error('SDK threw after creating copy')
}, 'SDK throw after write', 'BoardTarget')


async function checkMacroStopsAfterUnknown(configureSdk, label) {
	let copies = 0
	let markerWrites = 0
	let extraApiCalls = 0
	globalThis.eda = {
		dmt_Pcb: {
			copyPcb: async () => { copies++; return configureSdk() },
			getAllPcbsInfo: async () => { extraApiCalls++; return [] },
		},
		dmt_Project: { getCurrentProjectInfo: async () => { extraApiCalls++; return {} } },
	}
	registerCommand({
		name: 'test.markerWrite', summary: 'marker', params: [], returns: '{}',
		handler: async () => { markerWrites++; return { written: true } },
	})
	const result = await executeCommand({ cmd: 'macro', params: {
		stopOnError: false,
		steps: [{ cmd: 'project.copyPcb', params: { pcbUuid: 'source-pcb' } }, { cmd: 'test.markerWrite' }],
	} })
	assert.equal(result.ok, false, `${label}: macro reports the failed copy`)
	assert.equal(result.data.steps[0].error.cause.partial, true, `${label}: partial error reaches registry result`)
	if (label === 'SDK throw')
		assert.equal(result.data.steps[0].error.cause.operationError, 'SDK copy rejected')
	assert.equal(markerWrites, 0, `${label}: partial copy result blocks dependent macro write`)
	assert.equal(copies, 1, `${label}: copy is invoked once`)
	assert.equal(extraApiCalls, 0, `${label}: no implicit readback or extra API call`)
}

await checkMacroStopsAfterUnknown(() => undefined, 'empty SDK result')
await checkMacroStopsAfterUnknown(() => { throw new Error('SDK copy rejected') }, 'SDK throw')

{
	let copies = 0
	let extraApiCalls = 0
	globalThis.eda = {
		dmt_Pcb: {
			copyPcb: async () => { copies++; return undefined },
			getAllPcbsInfo: async () => { extraApiCalls++; return [] },
		},
		dmt_Project: { getCurrentProjectInfo: async () => { extraApiCalls++; return {} } },
	}
	await assert.rejects(copyPcb.handler({ pcbUuid: 'source-pcb' }), /结果未知.*SDK 返回空值/)
	assert.equal(copies, 1)
	assert.equal(extraApiCalls, 0)
}

console.log('pcb-copy-outcome-regression: 7 scenarios passed')
