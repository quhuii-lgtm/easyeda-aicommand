import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const built = await build({
	stdin: {
		contents: `export { pcbCommands } from '../src/commands/pcb.ts'; export { dfmCommands } from '../src/commands/dfm.ts'; export { parseDrcResult } from '../src/pcb/drcResult.ts'`,
		resolveDir: resolve(root, 'test'),
		sourcefile: 'pcb-drc-result-entry.ts',
	},
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
})
const { pcbCommands, dfmCommands, parseDrcResult } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
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
assert.equal(mixed.violations[0].x, 92.966)
assert.equal(mixed.violations[0].rawCoordinateUnit, 'unknown', 'a pos-only tree leaf does not prove coordinate units')
assert.equal(Object.hasOwn(mixed.violations[0], 'xMil'), false)
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

const getRevision = pcbCommands.find(item => item.name === 'pcb.getRevision').handler
const makeSource = (x, ruleWidth = 10) => [
	'{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"pcb-1"}|',
	`{"type":"LINE","id":"line-1"}||{"startX":${x}}|`,
	`{"type":"RULE","id":"rule-1"}||{"width":${ruleWidth}}|`,
].join('\n')
let source = makeSource(0)
let configuration = { type: 'default', width: 10 }
globalThis.eda.sys_FileManager = { getDocumentSource: async () => source }
globalThis.eda.pcb_Drc.getCurrentRuleConfiguration = async () => configuration
const boundContext = { ...context, documentTarget: { uuid: 'pcb-1', documentType: 3, parentProjectUuid: 'project-1', tabId: 'pcb-1@project-1' } }
const bound = await detailed({}, boundContext)
assert.equal(bound.revision.freshness, 'current')
assert.equal(bound.revision.ruleExecutionCoverage, 'unknown')
assert.deepEqual(bound.revision.target, boundContext.documentTarget)
assert.equal((await getRevision({ expectedDigest: bound.revision.after }, boundContext)).freshness, 'current')
configuration = { type: 'default', width: 11 }
assert.equal((await getRevision({ expectedDigest: bound.revision.after, expectedRulesDigest: bound.revision.rulesAfter }, boundContext)).freshness, 'stale')
configuration = undefined
assert.equal((await getRevision({ expectedDigest: bound.revision.after, expectedRulesDigest: bound.revision.rulesAfter }, boundContext)).freshness, 'unknown')
configuration = { type: 'default', width: 10 }
source = makeSource(1)
assert.equal((await getRevision({ expectedDigest: bound.revision.after }, boundContext)).freshness, 'stale')
source = makeSource(0, 11)
assert.equal((await getRevision({ expectedDigest: bound.revision.after }, boundContext)).freshness, 'stale')
const originalCheck = globalThis.eda.pcb_Drc.check
globalThis.eda.pcb_Drc.check = async () => { source = makeSource(2); return [] }
assert.equal((await detailed({}, boundContext)).revision.freshness, 'stale')
globalThis.eda.pcb_Drc.check = originalCheck
source = undefined
assert.equal((await detailed({}, boundContext)).revision.freshness, 'unknown')

const savePcb = pcbCommands.find(item => item.name === 'pcb.save').handler
const targetTab = boundContext.documentTarget.tabId
let opened = true
let focusedDocument = { documentType: 3, uuid: 'pcb-1', parentProjectUuid: 'project-1', tabId: targetTab }
let savedCount = 0
let acceptsSave = false
let acceptClose = true
let reopenSource
let editAfterSave
globalThis.eda.pcb_Document = { save: async () => { savedCount++; if (editAfterSave) source = editAfterSave; return acceptsSave } }
globalThis.eda.dmt_Project = { getCurrentProjectInfo: async () => ({ uuid: 'project-1', data: [{ uuid: 'pcb-1' }] }) }
globalThis.eda.dmt_SelectControl = { getCurrentDocumentInfo: async () => focusedDocument }
globalThis.eda.dmt_EditorControl = {
	getSplitScreenTree: async () => ({ tabs: opened ? [{ tabId: targetTab }] : [] }),
	closeDocument: async tab => {
		assert.equal(tab, targetTab)
		if (acceptClose) {
			opened = false
			focusedDocument = undefined
		}
		return acceptClose
	},
	openDocument: async uuid => {
		assert.equal(uuid, 'pcb-1')
		opened = true
		focusedDocument = { documentType: 3, uuid, parentProjectUuid: 'project-1', tabId: targetTab }
		if (reopenSource) source = reopenSource
		return targetTab
	},
	activateDocument: async () => true,
}
const saveContext = { ...boundContext, assertDocumentTarget: async () => assert.equal(opened, true) }
source = makeSource(0)
const saveDigest = (await getRevision({}, saveContext)).digest
await assert.rejects(savePcb({ verifyReopen: true, expectedDigest: 'wrong' }, saveContext), /修订与预期不一致/)
assert.equal(savedCount, 0)
await assert.rejects(savePcb({ verifyReopen: true, expectedDigest: saveDigest }, saveContext), err => err.cause.phase === 'save' && err.cause.phases.saved === false)
assert.equal(opened, true)
acceptsSave = true
acceptClose = false
await assert.rejects(savePcb({ verifyReopen: true, expectedDigest: saveDigest }, saveContext), err => err.cause.phase === 'close')
acceptClose = true
editAfterSave = makeSource(3)
await assert.rejects(savePcb({ verifyReopen: true, expectedDigest: saveDigest }, saveContext), /保存后当前 PCB 内容已变化/)
assert.equal(opened, true)
editAfterSave = undefined
source = makeSource(0)
assert.equal((await savePcb({ verifyReopen: true, expectedDigest: saveDigest }, saveContext)).persistenceVerified, true)
reopenSource = makeSource(1)
await assert.rejects(savePcb({ verifyReopen: true, expectedDigest: saveDigest }, saveContext), err => err.cause.phase === 'compare' && err.cause.phases.comparison.equal === false)

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

const nativeLeaf = (overrides = {}) => ({
	errorType: 'Physical Error',
	objs: ['source-1'],
	globalIndex: 'err-1',
	pos: { x: 12.5, y: -4.25 },
	parentId: 'DRCTab|_|Errors|_|Physical Error|_|Track',
	explanation: { errData: { obj1: 'source-1', globalIndex: 'err-1', position: { x: 12.5, y: -4.25 } } },
	...overrides,
})
const parseOne = (leaf, version = '4.1.99') => parseDrcResult([{ name: 'Physical Error', list: [{ name: 'Track', list: [leaf] }] }], version)
const verifiedNative = parseOne(nativeLeaf()).violations[0]
assert.deepEqual([verifiedNative.x, verifiedNative.y], [12.5, -4.25], 'raw native coordinates remain unchanged')
assert.deepEqual([verifiedNative.xMil, verifiedNative.yMil], [125, -42.5])
assert.equal(verifiedNative.coordinateUnit, 'mil')
assert.equal(verifiedNative.coordinateBasis, 'data-origin')
assert.equal(verifiedNative.coordinateConversionFactor, 10)
assert.equal(verifiedNative.coordinateEvidence, 'native-drc-verbose-position-source-association-empirical')
assert.equal(parseOne(nativeLeaf(), '4.1.78').violations[0].xMil, 125, 'legacy version argument does not control native evidence recognition')
assert.equal(parseOne({ errorType: 'CONNECT', objs: ['pad-plain'], pos: { x: 12.5, y: -4.25 } }, '4.1.78').violations[0].xMil, undefined, 'the former whitelisted version does not convert plain positions')

for (const malformed of [
	nativeLeaf({ pos: undefined }),
	nativeLeaf({ pos: { x: 12.5, y: -4.25 }, explanation: { errData: { obj1: 'source-1', globalIndex: 'err-1', position: { x: 12.6, y: -4.25 } } } }),
	nativeLeaf({ objs: ['different-source'] }),
	nativeLeaf({ globalIndex: 'different-index' }),
	nativeLeaf({ pos: { x: Number.NaN, y: -4.25 }, explanation: { errData: { obj1: 'source-1', globalIndex: 'err-1', position: { x: Number.NaN, y: -4.25 } } } }),
	nativeLeaf({ pos: { x: Number.MAX_VALUE, y: -4.25 }, explanation: { errData: { obj1: 'source-1', globalIndex: 'err-1', position: { x: Number.MAX_VALUE, y: -4.25 } } } }),
]) {
	const malformedRaw = [{ name: 'Physical Error', list: [{ name: 'Track', list: [malformed] }] }]
	const parsed = parseDrcResult(malformedRaw, '4.1.99')
	assert.equal(parsed.violations[0].rawCoordinateUnit, 'unknown')
	assert.equal(Object.hasOwn(parsed.violations[0], 'xMil'), false, 'incomplete or conflicting source evidence must not produce a mil location')
	assert.deepEqual(parsed.rawResult, malformedRaw, 'coordinate classification leaves the native tree untouched')
	assert.equal(parsed.coordinateUnit, 'unknown')
}

const mixedCoordinateTree = [{ name: 'Physical Error', list: [{ name: 'Track', list: [nativeLeaf(), { errorType: 'CONNECT', objs: ['pos-only'], pos: { x: 3, y: 4 } }] }] }]
const mixedCoordinateResult = parseDrcResult(mixedCoordinateTree, '4.1.99')
assert.equal(mixedCoordinateResult.violations[0].xMil, 125, 'verified leaves remain usable in mixed results')
assert.equal(mixedCoordinateResult.violations[1].xMil, undefined)
assert.equal(mixedCoordinateResult.coordinateUnit, 'unknown', 'aggregate unit becomes unknown when any positioned leaf lacks evidence')
assert.deepEqual(mixedCoordinateResult.rawResult, mixedCoordinateTree)

const realCoordinateFixture = JSON.parse(await readFile(resolve(root, 'test/fixtures/native-drc-coordinate-4199.json'), 'utf8'))
editorVersion = '4.1.99'
result = realCoordinateFixture.rawResult
const realCoordinates = await detailed({})
assert.equal(realCoordinates.totalCount, 6)
assert.equal(realCoordinates.rawCoordinateUnit, '10mil')
assert.equal(realCoordinates.coordinateUnit, 'mil')
for (const [id, expected] of Object.entries(realCoordinateFixture.expectedPositionsMil)) {
	const locations = realCoordinates.violations.filter(item => item.primitiveId === id)
	assert.ok(locations.length > 0, `native fixture should include source ${id}`)
	for (const location of locations) {
		assert.deepEqual([location.xMil, location.yMil], [expected.x, expected.y], `native host coordinate conversion for ${id}`)
		assert.equal(location.coordinateBasis, 'data-origin')
	}
}
assert.deepEqual(realCoordinates.rawResult, realCoordinateFixture.rawResult, 'actual 4.1.99 native DRC tree is preserved')
result = realCoordinateFixture.shiftedOriginRawResult
const shiftedRealCoordinates = await detailed({})
assert.deepEqual(shiftedRealCoordinates.violations.map(item => [item.primitiveId, item.x, item.y, item.xMil, item.yMil]), realCoordinates.violations.map(item => [item.primitiveId, item.x, item.y, item.xMil, item.yMil]), 'changing canvas origin did not alter native DRC coordinates')

result = JSON.parse(await readFile(resolve(root, 'test/fixtures/official-native-drc-4199.json'), 'utf8'))
editorVersion = '4.1.99'
const host4199 = await detailed({})
assert.equal(host4199.categoryCount, 2)
assert.equal(host4199.totalCount, 4)
assert.equal(host4199.errorCount, 4)
assert.equal(host4199.warnCount, 0)
assert.equal(host4199.unknownCount, 0)
assert.equal(host4199.passed, false)
assert.equal(host4199.rawCoordinateUnit, '10mil')
assert.equal(host4199.coordinateUnit, 'mil')
assert.equal(host4199.violations[0].x, 7.792889999999943, 'keep raw host coordinates unchanged')
assert.equal(host4199.violations[0].rawCoordinateUnit, '10mil')
assert.equal(host4199.violations[0].xMil, 77.92889999999943, 'associated native verbose evidence supports unit normalization')
assert.deepEqual(host4199.rawResult, result)

editorVersion = '4.2.0'
const unknownHost = await detailed({})
assert.equal(unknownHost.violations[0].x, 7.792889999999943)
assert.equal(unknownHost.violations[0].rawCoordinateUnit, '10mil', 'runtime version does not override source-associated evidence')
assert.equal(unknownHost.violations[0].xMil, 77.92889999999943)

for (const command of dfmCommands) {
	const required = command.params.filter(param => param.required).map(param => param.name)
	for (const name of required)
		assert.ok(Object.hasOwn(command.example.params, name), `${command.name} example lacks ${name}`)
}
console.log('PASS PCB DRC preserves raw trees, counts known/unknown results, and avoids unsupported coordinate conversion')
