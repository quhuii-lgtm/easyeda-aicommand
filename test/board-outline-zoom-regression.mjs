import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: { contents: "export { editorCommands } from '../src/commands/editor.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'board-outline-zoom-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { editorCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const command = editorCommands.find(item => item.name === 'pcb.zoomToBoardOutline')
assert.ok(command)
let calls = 0
let fallbackCalls = 0
let sdkResult = true
let sdkEffect = () => {}
let current = 'pcb-a'
globalThis.eda = {
	pcb_Document: { async zoomToBoardOutline() { calls++; await sdkEffect(); return sdkResult } },
	dmt_EditorControl: { async zoomToAllPrimitives() { fallbackCalls++; return true } },
}
const ctx = {
	vars: {}, documentTarget: { documentType: 3, uuid: 'pcb-a', parentProjectUuid: 'project-a', tabId: 'pcb-a@project-a' },
	async assertDocumentTarget() { if (current !== 'pcb-a') throw new Error('target changed') },
}
const result = await command.handler({}, ctx)
assert.equal(result.zoomed, true)
assert.equal(result.method, 'native-board-outline')
assert.equal(result.visualVerified, false)
assert.equal(result.document, ctx.documentTarget)
assert.equal(calls, 1)
for (const value of [false, undefined, null]) {
	sdkResult = value
	await assert.rejects(command.handler({}, ctx), /未确认适应板框成功/)
}
const beforeMismatch = calls
current = 'pcb-b'
await assert.rejects(command.handler({}, ctx), /target changed/)
assert.equal(calls, beforeMismatch, 'initial mismatch must not call SDK')
current = 'pcb-a'
sdkResult = true
sdkEffect = () => { current = 'pcb-b' }
await assert.rejects(command.handler({}, ctx), error => {
	assert.equal(error.cause.sdkInvoked, true)
	assert.equal(error.cause.sdkResult, true)
	assert.equal(error.cause.designModified, false)
	assert.match(error.message, /已调用.*目标复核失败/)
	return true
})
current = 'pcb-a'
sdkEffect = () => { throw new Error('native failure') }
await assert.rejects(command.handler({}, ctx), error => {
	assert.equal(error.cause.sdkInvoked, true)
	assert.equal(error.cause.designModified, false)
	assert.match(error.message, /native failure/)
	return true
})
assert.equal(fallbackCalls, 0, 'never silently replace board fit with all-primitives fit')
console.log('PASS native board-outline zoom: normal, false/unknown, pre/post target checks, SDK failure, no fallback')
