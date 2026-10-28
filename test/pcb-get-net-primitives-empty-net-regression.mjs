import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: "import { pcbCommands } from '../src/commands/pcb.ts'; export { pcbCommands }",
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-get-net-primitives-empty-net-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
const { pcbCommands } = await import(moduleUrl)
const command = pcbCommands.find(item => item.name === 'pcb.getNetPrimitives')
assert.ok(command, 'pcb.getNetPrimitives remains registered')
assert.equal(command.params.find(param => param.name === 'net').required, true)
assert.match(command.params.find(param => param.name === 'net').description, /允许空字符串/u)
assert.match(command.returns, /空字符串.*SDK决定/u)

const calls = []
const normalResult = [{ globalIndex: 'pad-1' }]
globalThis.eda = {
	pcb_Net: {
		async getAllPrimitivesByNet(net) {
			calls.push(net)
			if (net === 'SDK_ERROR') throw sdkError
			return net === '' ? [] : normalResult
		},
	},
}
const sdkError = new Error('SDK query failed')

assert.deepEqual(await command.handler({ net: '' }), [], 'explicit empty string is passed through and the SDK result is returned as-is')
assert.equal(await command.handler({ net: '+5V' }), normalResult, 'nonempty net retains its value and SDK result')
assert.deepEqual(calls, ['', '+5V'], 'each accepted request makes exactly one SDK call with the original string')

for (const [label, params] of [
	['missing', {}],
	['undefined', { net: undefined }],
	['null', { net: null }],
	['array', { net: [] }],
	['number', { net: 0 }],
	['object', { net: {} }],
]) {
	await assert.rejects(command.handler(params), /参数 net 必须显式提供字符串/u, `${label} net is rejected before SDK access`)
	assert.deepEqual(calls, ['', '+5V'], `${label} net does not cause an SDK call`)
}

await assert.rejects(command.handler({ net: 'SDK_ERROR' }), error => error === sdkError, 'SDK errors propagate unchanged')
assert.deepEqual(calls, ['', '+5V', 'SDK_ERROR'], 'SDK failure adds only its one attempted call and triggers no fallback')
console.log('pcb.getNetPrimitives empty-net regression passed')
