import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/engine/tasks.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.ES2022,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
const { beginTask, finishTask, failTask } = await import(moduleUrl)

const sameFirst = beginTask('same-params', { count: 2, config: { width: 1, enabled: true } })
const sameAgain = beginTask('same-params', { config: { enabled: true, width: 1 }, count: 2 })
assert.equal(sameFirst.existing, false, 'first request creates a task')
assert.equal(sameAgain.existing, true, 'object key order does not affect a running task fingerprint')
assert.equal(sameAgain.task.id, sameFirst.task.id, 'same running request returns the same task')

const wireForward = beginTask('batchWire', { items: [{ type: 'link', pins: ['U1.1', 'U1.2'] }] })
const wireReverse = beginTask('batchWire', { items: [{ type: 'link', pins: ['U1.2', 'U1.1'] }] })
assert.equal(wireForward.existing, false)
assert.equal(wireReverse.existing, false, 'pin order is part of batchWire request identity')
assert.notEqual(wireReverse.task.id, wireForward.task.id, 'reversed pins create a distinct task')

const macroPathForward = beginTask('macro', { steps: [{ cmd: 'place', params: { at: [10, 20] } }, { cmd: 'place', params: { at: [30, 40] } }] })
const macroPathReversed = beginTask('macro', { steps: [{ cmd: 'place', params: { at: [30, 40] } }, { cmd: 'place', params: { at: [10, 20] } }] })
assert.equal(macroPathForward.existing, false)
assert.equal(macroPathReversed.existing, false, 'macro step and coordinate order is significant')
assert.notEqual(macroPathReversed.task.id, macroPathForward.task.id, 'reordered macro path creates a distinct task')

const macroPointsForward = beginTask('macro', { steps: [{ cmd: 'drawPath', params: { points: [[10, 20], [30, 40]] } }], stopOnError: true })
const macroPointsReversed = beginTask('macro', { steps: [{ cmd: 'drawPath', params: { points: [[20, 10], [30, 40]] } }], stopOnError: true })
assert.equal(macroPointsForward.existing, false)
assert.equal(macroPointsReversed.existing, false, 'same macro step with reordered coordinates is a distinct request')
assert.notEqual(macroPointsReversed.task.id, macroPointsForward.task.id, 'reordered macro coordinates create a distinct task')

const sortedDeleteFirst = beginTask('schematic.delete', { primitiveIds: ['a', 'b'].sort() })
const sortedDeleteAgain = beginTask('schematic.delete', { primitiveIds: ['b', 'a'].sort() })
assert.equal(sortedDeleteFirst.existing, false)
assert.equal(sortedDeleteAgain.existing, true, 'caller-pre-sorted primitiveIds still deduplicate')
assert.equal(sortedDeleteAgain.task.id, sortedDeleteFirst.task.id)

finishTask(sameFirst.task, { ok: true })
const afterFinish = beginTask('same-params', { count: 2, config: { enabled: true, width: 1 } })
assert.equal(afterFinish.existing, false, 'finished tasks do not suppress a new identical request')
assert.notEqual(afterFinish.task.id, sameFirst.task.id)

failTask(afterFinish.task, new Error('expected failure'))
const afterFail = beginTask('same-params', { count: 2, config: { enabled: true, width: 1 } })
assert.equal(afterFail.existing, false, 'failed tasks do not suppress a new identical request')
assert.notEqual(afterFail.task.id, afterFinish.task.id)

console.log('task dedupe order regression passed: same-running reuse, key normalization, ordered arrays, caller sorting, terminal restart')
