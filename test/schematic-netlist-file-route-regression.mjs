import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `
import { schematicCommands } from '../src/commands/schematic.ts'
import { setDiagSink } from '../src/engine/diag.ts'
import { executeCommand, registerCommand } from '../src/engine/registry.ts'
export { schematicCommands, setDiagSink, executeCommand, registerCommand }
`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'schematic-netlist-file-route-regression-entry.ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
	target: 'node24',
})
const { schematicCommands, setDiagSink, executeCommand, registerCommand } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const getNetlist = schematicCommands.find(command => command.name === 'schematic.getNetlist').handler
const savedSetTimeout = globalThis.setTimeout
const savedClearTimeout = globalThis.clearTimeout
let timeoutCallback
globalThis.setTimeout = (callback, ms, ...args) => {
	assert.equal(ms, 45000, 'netlist generation and file reading share the existing 45 second budget')
	timeoutCallback = () => callback(...args)
	return 45
}
globalThis.clearTimeout = () => true

function file(text) { return { text } }
async function rejectsPartial(promise, phase) {
	await assert.rejects(promise, error => {
		assert.equal(error.cause?.partial, true)
		assert.equal(error.cause?.retryable, false)
		assert.equal(error.cause?.operation, 'schematic.getNetlist')
		if (phase) assert.equal(error.cause?.phase, phase)
		return true
	})
}

try {
	// JLCEDA must use the manufacturing file route and return its text byte-for-byte as a JS string.
	{
		let files = 0, legacy = 0
		const original = '网表\r\nU1.1 中文 NET\n'
		globalThis.eda = {
			sch_ManufactureData: { getNetlistFile: async (...args) => { files++; assert.deepEqual(args, [undefined, 'JLCEDA']); return file(async () => original) } },
			sch_Netlist: { getNetlist: async () => { legacy++; return 'legacy' } },
		}
		const result = await getNetlist({ netlistType: 'JLCEDA' }, {})
		assert.deepEqual(result, { netlistType: 'JLCEDA', length: original.length, netlist: original })
		assert.equal(files, 1)
		assert.equal(legacy, 0)
	}

	// The default and all non-JLCEDA formats keep using the legacy string API.
	{
		const formats = []
		let files = 0
		globalThis.eda = {
			sch_ManufactureData: { getNetlistFile: async () => { files++; return file(async () => 'wrong route') } },
			sch_Netlist: { getNetlist: async type => { formats.push(type); return `net:${type}` } },
		}
		assert.equal((await getNetlist({}, {})).netlist, 'net:Protel2')
		assert.equal((await getNetlist({ netlistType: 'Protel2' }, {})).netlist, 'net:Protel2')
		assert.equal((await getNetlist({ netlistType: 'PADS' }, {})).netlist, 'net:PADS')
		assert.deepEqual(formats, ['Protel2', 'Protel2', 'PADS'])
		assert.equal(files, 0)
	}

	// Missing file/text, rejected text(), and invalid/empty returned values are uncertain post-call outcomes.
	for (const [name, getFile] of [
		['missing-file', async () => undefined],
		['missing-text', async () => ({})],
		['text-rejected', async () => file(async () => { throw new Error('text failed') })],
		['non-string', async () => file(async () => 42)],
		['empty', async () => file(async () => ' \n\t')],
	]) {
		let files = 0, legacy = 0
		globalThis.eda = {
			sch_ManufactureData: { getNetlistFile: async (...args) => { files++; assert.deepEqual(args, [undefined, 'JLCEDA']); return getFile() } },
			sch_Netlist: { getNetlist: async () => { legacy++; return 'should-not-run' } },
		}
		await rejectsPartial(getNetlist({ netlistType: 'JLCEDA' }, {}))
		assert.equal(files, 1, `${name}: only one file generation call`)
		assert.equal(legacy, 0, `${name}: no legacy fallback`)
	}

	// Timeout during file generation retains the one late result and does not regenerate or retry.
	{
		let calls = 0, finish
		const events = []
		setDiagSink(event => events.push(event))
		globalThis.eda = { sch_ManufactureData: { getNetlistFile: async () => { calls++; return await new Promise(resolve => { finish = () => resolve(file(async () => 'late')) }) } }, sch_Netlist: { getNetlist: async () => assert.fail('legacy fallback') } }
		const pending = getNetlist({ netlistType: 'JLCEDA' }, {})
		for (let i = 0; i < 20 && (!timeoutCallback || !finish); i++) await Promise.resolve()
		assert.equal(calls, 1)
		timeoutCallback()
		await rejectsPartial(pending, 'getNetlistFile-wait-timeout-state-unknown')
		finish()
		for (let i = 0; i < 8; i++) await Promise.resolve()
		assert.equal(calls, 1)
		assert.equal(events.some(event => event.stage === 'fileText.late-settled'), true, 'the original operation may continue from generation into file.text after the wait times out')
		assert.equal(events.some(event => String(event.detail ?? '').includes('late')), false)
		setDiagSink(undefined)
	}

	// Timeout and late rejection during file.text() remain attached to the original promise with no unhandled rejection.
	{
		let calls = 0, reads = 0, finish
		const events = []
		setDiagSink(event => events.push(event))
		globalThis.eda = { sch_ManufactureData: { getNetlistFile: async () => { calls++; return file(async () => { reads++; return await new Promise((_, reject) => { finish = () => reject(new Error('late text rejection')) }) }) } }, sch_Netlist: { getNetlist: async () => assert.fail('legacy fallback') } }
		const pending = getNetlist({ netlistType: 'JLCEDA' }, {})
		for (let i = 0; i < 20 && (!timeoutCallback || !finish); i++) await Promise.resolve()
		assert.equal(calls, 1)
		assert.equal(reads, 1)
		timeoutCallback()
		await rejectsPartial(pending, 'fileText-wait-timeout-state-unknown')
		finish()
		for (let i = 0; i < 8; i++) await Promise.resolve()
		assert.equal(calls, 1)
		assert.equal(reads, 1)
		assert.equal(events.some(event => event.stage === 'fileText.late-rejected'), true)
		setDiagSink(undefined)
	}

	// Registry macro must stop after the partial netlist result even with stopOnError:false.
	{
		globalThis.setTimeout = savedSetTimeout
		globalThis.clearTimeout = savedClearTimeout
		let later = 0
		globalThis.eda = {
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 1, uuid: 'page-1' }) },
			sch_ManufactureData: { getNetlistFile: async () => undefined },
			sch_Netlist: { getNetlist: async () => assert.fail('legacy fallback') },
		}
		registerCommand(schematicCommands.find(command => command.name === 'schematic.getNetlist'))
		registerCommand({ name: 'test.netlistFileLater', summary: 'marker', params: [], handler: async () => { later++; return { later } } })
		const result = await executeCommand({ cmd: 'macro', params: { stopOnError: false, steps: [
			{ cmd: 'schematic.getNetlist', params: { netlistType: 'JLCEDA' } },
			{ cmd: 'test.netlistFileLater', params: {} },
		] } })
		assert.equal(result.ok, false)
		assert.equal(result.error?.cause?.partial, true)
		assert.equal(result.data?.stoppedReason, 'partial')
		assert.equal(result.data?.unexecutedSteps, 1)
		assert.equal(later, 0)
	}
}
finally {
	globalThis.setTimeout = savedSetTimeout
	globalThis.clearTimeout = savedClearTimeout
	setDiagSink(undefined)
}

console.log('schematic-netlist-file-route-regression: passed')
