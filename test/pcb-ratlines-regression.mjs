import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { build } from 'esbuild'

const bundle = await build({
	entryPoints: ['src/commands/pcbRatlines.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false,
})
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
const { pcbRatlineCommands } = await import(moduleUrl)
const command = pcbRatlineCommands.find(item => item.name === 'pcb.listRatlines')
assert.ok(command)

const target = { documentType: 3, uuid: 'pcb-A', tabId: 'tab-A', parentProjectUuid: 'project-A' }
const makeContext = (assertDocumentTarget = async () => {}) => ({
	vars: {},
	documentTarget: target,
	assertDocumentTarget,
	stopSignal: { assertActive() {} },
})
const item = {
	primitiveId: 'ratline-1',
	net: 'N1',
	start: { x: 10, y: 20 },
	end: { x: 30, y: 40 },
	startId: 'pad-1',
	endId: 'pad-2',
	length: 28.284,
	locked: false,
}
let calls = []
let response
const pcbDocument = { getRatlines: async function (options) {
	assert.equal(this, pcbDocument, 'host method must retain pcb_Document as this')
	calls.push(options)
	return response
} }
globalThis.eda = { pcb_Document: pcbDocument }

response = { items: [item], hasMore: false, total: 1 }
const first = await command.handler({}, makeContext())
assert.deepEqual(calls.at(-1), { limit: 200 })
assert.deepEqual(first.items, [item])
assert.equal(first.hasMore, false)
assert.equal(first.total, 1)
console.log('PASS default limit is 200 and one host page is returned without auto-pagination')

response = { items: [item], hasMore: true, nextCursor: 'cursor-2', total: 3 }
const page = await command.handler({ net: ' N1 ', cursor: 'cursor-1', limit: 1 }, makeContext())
assert.deepEqual(calls.at(-1), { net: 'N1', cursor: 'cursor-1', limit: 1 })
assert.equal(page.nextCursor, 'cursor-2')
assert.equal(page.total, 3)
assert.equal(calls.length, 2, 'the command must not request the next page automatically')
console.log('PASS pagination metadata and net/cursor/limit are preserved for caller-controlled paging')

{
	const callCount = calls.length
	await assert.rejects(command.handler({ limit: 0 }, makeContext()), /limit 必须是正整数/)
	await assert.rejects(command.handler({ limit: 1.5 }, makeContext()), /limit 必须是正整数/)
	assert.equal(calls.length, callCount, 'invalid limit must reject before SDK call')
}
console.log('PASS invalid limits are rejected before SDK call')

{
	const callCount = calls.length
	const context = makeContext(async () => { throw new Error('target changed') })
	await assert.rejects(command.handler({}, context), /target changed/)
	assert.equal(calls.length, callCount, 'wrong document target must reject before SDK call')
}
console.log('PASS a target mismatch before the query prevents host access')

{
	const callCount = calls.length
	let checks = 0
	const context = makeContext(async () => { if (++checks === 2) throw new Error('target changed after query') })
	await assert.rejects(command.handler({}, context), /target changed after query/)
	assert.equal(calls.length, callCount + 1, 'one read may occur before focus drift is detected')
}
console.log('PASS a target change during the query rejects the readback')

{
	const callCount = calls.length
	const context = makeContext()
	context.stopSignal.assertActive = () => { throw new Error('stopped') }
	await assert.rejects(command.handler({}, context), /stopped/)
	assert.equal(calls.length, callCount, 'a pre-stopped command must not call the SDK')
}
console.log('PASS stop signal is checked before SDK call')

{
	const malformed = [
		{ items: [{}], hasMore: false },
		{ items: [item], hasMore: true },
		{ items: [item], hasMore: false, total: -1 },
		{ items: 'not-an-array', hasMore: false },
	]
	for (const value of malformed) {
		response = value
		await assert.rejects(command.handler({}, makeContext()), /getRatlines/)
	}
}
console.log('PASS missing fields and malformed pagination are explicit errors, never empty-array success')
