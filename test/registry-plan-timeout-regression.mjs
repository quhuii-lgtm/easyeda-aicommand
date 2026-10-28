import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'

// Run the actual registry without SDK calls, timers firing, or writes to the live proxy.
const source = fs.readFileSync(new URL('../src/engine/registry.ts', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const timers = []
let sdkCalls = 0
let taskId = 0
const context = { exports: {}, require(name) {
 if (name === './diag') return { diag() {} }
 if (name === './tasks') return {
  beginTask() { return { task: { id: `test-${++taskId}` }, existing: false } },
  failTask() {}, finishTask() {}, taskProgress() {},
 }
 throw new Error(`Unexpected dependency: ${name}`)
}, eda: { dmt_SelectControl: { async getCurrentDocumentInfo() { sdkCalls++; return { documentType: 1, uuid: 'test-page' } } } }, setTimeout(_fn, ms) { timers.push(ms); return 1 }, clearTimeout() {}, Date, console }
vm.runInNewContext(code, context)
const { registerCommand, executeCommand } = context.exports
let calls = 0
registerCommand({ name: 'test.echo', summary: '', params: [], returns: '', handler: async params => { calls++; return params } })
registerCommand({ name: 'schematic.testTimeout', summary: '', params: [], returns: '', handler: async () => { calls++; return true } })
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/auto-copper-host-plan.json', import.meta.url)))
let result = await executeCommand({ cmd: 'test.echo', params: { plan: fixture } })
assert.equal(result.ok, true)
assert.equal(JSON.stringify(result.data.plan), JSON.stringify(fixture))
assert.equal(calls, 1)
for (const literal of ['$1N1', '$1N1:1', '$23N7:46']) {
 result = await executeCommand({ cmd: 'test.echo', params: { net: literal } })
 assert.equal(result.ok, true); assert.equal(result.data.net, literal)
}
for (const [input, output] of [['$$literal', '$literal'], ['$step.field', 8], ['$list[0].x', 4], ['$step.plan', fixture]]) {
 result = await executeCommand({ cmd: 'test.echo', params: { value: input } }, { vars: { step: { field: 8, plan: fixture }, list: [{ x: 4 }] } })
 assert.equal(result.ok, true); assert.equal(JSON.stringify(result.data.value), JSON.stringify(output))
}
for (const value of ['$missing.field', '$step.absent', '$1N1:bad', '$step[0'].values()) {
 const before = calls
 result = await executeCommand({ cmd: 'test.echo', params: { value } }, { vars: { step: {} } })
 assert.equal(result.ok, false); assert.equal(calls, before)
}
for (const value of ['invalid', 'Infinity', Infinity, NaN, 2_147_483_648]) {
 const before = calls; const timerCount = timers.length
 result = await executeCommand({ cmd: 'test.echo', params: { _timeoutMs: value } })
 assert.equal(result.ok, false); assert.equal(calls, before); assert.equal(timers.length, timerCount)
 assert.match(result.error.message, /_timeoutMs/)
 assert.equal(result.error.cause?.partial, undefined)
 const sdkBefore = sdkCalls
 result = await executeCommand({ cmd: 'schematic.testTimeout', params: { _timeoutMs: value } })
 assert.equal(result.ok, false); assert.equal(sdkCalls, sdkBefore); assert.equal(calls, before)
}
for (const [value, expected] of [[undefined, 290000], [null, 290000], [0, 1000], [500, 1000], ['2000', 2000], [2_147_483_647, 2_147_483_647]]) {
 result = await executeCommand({ cmd: 'test.echo', params: { _timeoutMs: value } })
 assert.equal(result.ok, true); assert.equal(timers.at(-1), expected)
}
result = await executeCommand({ cmd: 'macro', params: { steps: [
 { id: 'first', cmd: 'test.echo', params: { plan: fixture } },
 { cmd: 'test.echo', params: { plan: '$first.plan' } },
] } })
assert.equal(result.ok, true)
assert.equal(JSON.stringify(result.data.steps[1].data.plan), JSON.stringify(fixture))
const beforeMacro = calls
result = await executeCommand({ cmd: 'macro', params: { steps: [
 { cmd: 'test.echo', params: { _timeoutMs: 'invalid' } },
 { cmd: 'test.echo', params: { mustNotExecute: true } },
] } })
assert.equal(result.ok, false); assert.equal(calls, beforeMacro)
console.log('PASS actual registry: unmodified host copper plan, automatic net layer keys, macro references and timeout validation before handlers')
