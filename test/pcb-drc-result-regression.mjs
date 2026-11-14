import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `export { pcbCommands } from '../src/commands/pcb.ts'; export { dfmCommands } from '../src/commands/dfm.ts'`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-drc-result-entry.ts',
	},
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { pcbCommands, dfmCommands } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const runDrc = pcbCommands.find(item => item.name === 'pcb.runDrc').handler
const detailed = pcbCommands.find(item => item.name === 'pcb.runDrcDetailed').handler

let result
let editorVersion = '4.1.78'
let checkCount = 0
globalThis.eda = {
	pcb_Drc: { check: async () => { checkCount++; return result } },
	sys_Environment: { getEditorCurrentVersion: () => editorVersion },
}

result = []
const emptyLegacy = await runDrc({})
assert.equal(emptyLegacy.passed, true)
assert.deepEqual(emptyLegacy.violations, [], 'legacy runDrc violations remains the raw top-level tree')
assert.equal((await detailed({})).passed, true)
assert.equal(checkCount, 2, 'each command invocation runs the official check once')

for (const invalid of [false, undefined, null, { name: 'Connection Error' }]) {
	result = invalid
	await assert.rejects(runDrc({}), /结果不可判定/)
	await assert.rejects(detailed({}), /结果不可判定/)
}

result = [
	{ name: 'Connection Error', list: [{ name: 'GND', list: [
		{ errorType: 'CONNECT', objs: ['pad-r2-2'], net: 'GND', pos: { x: 92.966, y: 30 }, parentId: 'DRCTab|_|Errors|_|Connection Error|_|GND' },
		{ errorType: 'CONNECT', objs: ['pad-r1-2'], net: 'GND', pos: { x: 22.966, y: 30 }, parentId: 'DRCTab|_|Errors|_|Connection Error|_|GND' },
	] }] },
	{ name: 'Empty category', list: [] },
	{ name: 'Warnings', list: [{ errorType: 'CLEARANCE', objs: ['pad-warn'], parentId: 'DRCTab|_|Warnings|_|Clearance' }] },
	{ name: 'Unclassified', list: [{ errorType: 'FUTURE', objs: ['pad-unknown'] }] },
	{ name: 'Unexpected branch', children: [{ anything: true }] },
	{ name: 'Mixed parent', errorType: 'AMBIGUOUS', list: [{ errorType: 'CONNECT', objs: ['mixed-child'], parentId: 'DRCTab|_|Errors|_|Mixed' }] },
]
const mixed = await detailed({})
assert.equal(mixed.totalCount, 5, 'totalCount counts recognized violation leaves, not categories or unknown parent nodes')
assert.equal(mixed.categoryCount, 5)
assert.equal(mixed.errorCount, 3)
assert.equal(mixed.fatalCount, 3, 'fatalCount remains a compatibility alias for errorCount')
assert.equal(mixed.warnCount, 1)
assert.equal(mixed.unknownCount, 1, 'recognized leaves with unknown severity remain counted')
assert.equal(mixed.unrecognizedCount, 2, 'unrecognized branches and mixed parents are separate from violation leaves')
assert.equal(mixed.incomplete, true)
assert.equal(mixed.passed, false)
assert.deepEqual(mixed.rawResult, result, 'the complete tree, including empty groups and unknown nodes, is preserved')
assert.equal(mixed.violations[0].groupPath[1], 'GND')
assert.equal(mixed.violations[0].primitiveId, 'pad-r2-2')
assert.equal(mixed.violations[0].xMil, 929.66)
assert.equal(mixed.violations[0].rawCoordinateUnit, '10mil')
assert.equal(mixed.coverage.ruleCoverage, 'unknown')
assert.equal(mixed.coverage.passedMeaning, 'no-findings-in-returned-results')

let checksFromContext = 0
const context = { assertDocumentTarget: async () => { checksFromContext++ } }
const legacy = await runDrc({}, context)
assert.deepEqual(legacy.violations, result, 'legacy command keeps original raw-tree meaning')
assert.equal(legacy.totalCount, 5)
assert.equal(legacy.unrecognizedCount, 2)
assert.equal(checksFromContext, 2, 'document identity is checked before and after the DRC read')
let driftChecks = 0
await assert.rejects(runDrc({}, { assertDocumentTarget: async () => {
	driftChecks++
	if (driftChecks === 2) throw new Error('document target changed')
} }), /document target changed/)
assert.equal(driftChecks, 2, 'a document switch during the read rejects the stale result')

result = [{ name: 'Only an empty group', list: [] }]
const emptyGroup = await detailed({})
assert.equal(emptyGroup.totalCount, 0, 'empty containers are not violations')
assert.equal(emptyGroup.passed, true)

result = [{ name: 'Physical Error', list: [{ name: 'Track', list: [
	{ errorType: 'Physical Error', objs: ['track-without-explicit-net'], explanation: { errData: { obj1: 'track-without-explicit-net', minWidth: 1.1811 } } },
	{ errorType: 'Physical Error', objs: ['track-with-net'], explanation: { errData: { obj1: 'track-with-net', net: 'B_3V3' } } },
] }] }]
const physicalGroups = await detailed({})
assert.equal(physicalGroups.violations[0].net, undefined, 'object-type group Track must not become an invented electrical net')
assert.equal(physicalGroups.violations[1].net, 'B_3V3', 'explicit error-data net takes precedence over an object-type group')
assert.deepEqual(physicalGroups.violations[0].groupPath, ['Physical Error', 'Track'])

result = JSON.parse(await readFile(resolve(root, 'test/fixtures/official-native-drc-4199.json'), 'utf8'))
editorVersion = '4.1.99'
const host4199 = await detailed({})
assert.equal(host4199.categoryCount, 2)
assert.equal(host4199.totalCount, 4)
assert.equal(host4199.errorCount, 4)
assert.equal(host4199.warnCount, 0)
assert.equal(host4199.unknownCount, 0)
assert.equal(host4199.passed, false)
assert.equal(host4199.rawCoordinateUnit, 'unknown')
assert.equal(host4199.coordinateUnit, 'unknown')
assert.equal(host4199.violations[0].x, 7.792889999999943, 'keep raw host coordinates unchanged')
assert.equal(host4199.violations[0].rawCoordinateUnit, 'unknown')
assert.equal(Object.hasOwn(host4199.violations[0], 'xMil'), false, 'do not extrapolate the 4.1.78 unit evidence')
assert.deepEqual(host4199.rawResult, result)

editorVersion = '4.2.0'
const unknownHost = await detailed({})
assert.equal(unknownHost.violations[0].x, 7.792889999999943)
assert.equal(unknownHost.violations[0].rawCoordinateUnit, 'unknown')
assert.equal(Object.hasOwn(unknownHost.violations[0], 'xMil'), false)

for (const command of dfmCommands) {
	const required = command.params.filter(param => param.required).map(param => param.name)
	for (const name of required)
		assert.ok(Object.hasOwn(command.example.params, name), `${command.name} example lacks ${name}`)
}
console.log('PASS PCB DRC preserves raw trees, counts known/unknown results, and avoids unsupported coordinate conversion')
