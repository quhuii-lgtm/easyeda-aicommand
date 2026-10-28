import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { register } from 'node:module'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const loader = `export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith('.') && !/\\.(?:ts|js|mjs|json)$/.test(specifier)) {
		try { return await nextResolve(specifier + '.ts', context) } catch {}
	}
	return nextResolve(specifier, context)
}`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)
const [
	{ prepareDsnWithPouredPlanes },
	{ prepareDsnWithSlotClearances },
	{ comparePcbSourceSnapshots },
	{ pcbCommands },
] = await Promise.all([
	import('../src/pcb/dsnPreparation.ts'),
	import('../src/pcb/dsnSlots.ts'),
	import('../src/pcb/dsnSourceSnapshot.ts'),
	import('../src/commands/pcb.ts'),
])

for (const commandName of ['pcb.exportDsn', 'pcb.autoRouteStart', 'pcb.importAutoRouteSes']) {
	const command = pcbCommands.find(item => item.name === commandName)
	assert.match(command?.returns ?? '', /NORMAL\/mil\/open的显式NET多行TRACK规则/, `${commandName} help documents the confirmed layer-specific rule scope`)
}

function mutateSourceRecord(source, predicate, mutate) {
	let changed = false
	const lines = source.split(/\r?\n/).map(line => {
		if (!line) return line
		const split = line.indexOf('||')
		const header = JSON.parse(line.slice(0, split))
		const data = JSON.parse(line.slice(split + 2).replace(/\|$/, ''))
		if (!changed && predicate(header, data)) {
			mutate(header, data)
			changed = true
		}
		return `${JSON.stringify(header)}||${JSON.stringify(data)}|`
	})
	assert.equal(changed, true, 'the targeted source record exists')
	return lines.join('\n')
}

const baselineSnapshot = await readFile(resolve(root, 'test', 'fixtures', 'ac-v058b-baseline-source.sourcelog'), 'utf8')
const afterDsnSnapshot = await readFile(resolve(root, 'test', 'fixtures', 'ac-v058b-after-dsn-source.sourcelog'), 'utf8')
function docHeadData(source) {
	const line = source.split(/\r?\n/).find(value => value.startsWith('{"type":"DOCHEAD"}'))
	return JSON.parse(line.slice(line.indexOf('||') + 2).replace(/\|$/, ''))
}
const baselineDocHead = docHeadData(baselineSnapshot)
const afterDsnDocHead = docHeadData(afterDsnSnapshot)
for (const field of ['client', 'updateTime', 'version'])
	assert.notEqual(baselineDocHead[field], afterDsnDocHead[field], `the real evidence changes DOCHEAD.${field}`)
const realSnapshotComparison = comparePcbSourceSnapshots(baselineSnapshot, afterDsnSnapshot)
assert.equal(realSnapshotComparison.matches, true, `the real export only changes volatile DOCHEAD fields: ${realSnapshotComparison.reason}`)
const changedDocHeadField = mutateSourceRecord(baselineSnapshot, header => header.type === 'DOCHEAD', (_header, data) => { data.otherField = 'changed' })
const changedUuid = mutateSourceRecord(baselineSnapshot, header => header.type === 'DOCHEAD', (_header, data) => { data.uuid = 'other-board' })
const changedRule = mutateSourceRecord(baselineSnapshot, header => header.type === 'RULE', (_header, data) => { data.auditMutation = true })
const changedGeometry = mutateSourceRecord(baselineSnapshot, header => header.type === 'LINE', (_header, data) => { data.startX += 1 })
const changedTicket = mutateSourceRecord(baselineSnapshot, header => header.type === 'CANVAS', header => { header.ticket += 1 })
for (const [label, changed] of [
	['other DOCHEAD field', changedDocHeadField], ['UUID', changedUuid], ['RULE', changedRule], ['geometry', changedGeometry], ['ticket', changedTicket],
]) {
	const comparison = comparePcbSourceSnapshots(baselineSnapshot, changed)
	assert.equal(comparison.matches, false, `${label} changes must invalidate a snapshot`)
	assert.match(comparison.reason, /第 \d+ 条/)
	assert.ok(Number.isInteger(comparison.recordIndex), `${label} reports the first differing record index`)
	assert.equal(typeof comparison.field, 'string', `${label} reports the first differing field`)
}
const reorderedLines = baselineSnapshot.split(/\r?\n/)
;[reorderedLines[1], reorderedLines[2]] = [reorderedLines[2], reorderedLines[1]]
assert.equal(comparePcbSourceSnapshots(baselineSnapshot, reorderedLines.join('\n')).matches, false, 'record order is significant')
assert.equal(comparePcbSourceSnapshots(baselineSnapshot, `${baselineSnapshot}\n{broken}||{}|`).matches, false, 'damaged source is never accepted')
const damagedFinalRecord = `${baselineSnapshot.slice(0, baselineSnapshot.lastIndexOf('||') + 2)}{broken}`
assert.equal(comparePcbSourceSnapshots(baselineSnapshot, damagedFinalRecord).matches, false, 'a malformed EOF payload is not accepted as the observed missing terminator')

const dsn = `(pcb demo
  (parser)
  (unit mil)
  (resolution mil 1000)
  (structure (layer TopLayer) (layer Inner1) (layer BottomLayer))
  (network (net GND) (net +5V))
)`
const documentSource = '{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"board-1"}|'

function makeSdk({ version = '4.1.78', pours = [] } = {}) {
	const makeRegion = (pour, fill) => {
		const region = {
			id: `region-${pour.id}`,
			fill,
			path: { getSource: () => fill ? pour.pathSource ?? [[0, 0, 1, 0, 1, 1, 0, 1, 'L']] : [] },
		}
		if (pour.strokeWidthOnly)
			region.strokeWidth = 0
		else if (!pour.missingLineWidth)
			region.lineWidth = 0
		return [region]
	}
	const poured = pours.map(pour => ({
		getState_PrimitiveId: () => `fill-${pour.id}`,
		getState_PourPrimitiveId: () => pour.id,
		getState_PourFills: () => makeRegion(pour, Boolean(pour.fill)),
	}))
	const parents = new Map(pours.map(pour => [pour.id, {
		getState_PrimitiveId: () => pour.id,
		getState_Net: () => pour.net,
		getState_Layer: () => 15,
		getState_ComplexPolygon: () => ({ getSource: () => [0, 0, 10, 0, 10, 10, 0, 10] }),
	}]))
	return {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'board-1' }) },
		sys_FileManager: { getDocumentSource: async () => documentSource },
		sys_Environment: { getEditorCurrentVersion: () => version },
		pcb_Layer: { getAllLayers: async () => [{ id: 15, name: 'Inner1' }] },
		pcb_PrimitivePour: { getAll: async () => [...parents.values()], get: async id => parents.get(id) },
		pcb_PrimitivePoured: { getAll: async () => poured },
	}
}

const accepted = await prepareDsnWithPouredPlanes(makeSdk({ pours: [
	{ id: 'pour-gnd', net: 'GND', fill: true },
	{ id: 'pour-5v', net: '+5V', fill: true },
] }), dsn, 'board-1', documentSource)
assert.equal(accepted.changed, true)
assert.match(accepted.text, /\(plane "GND" \(polygon "Inner1" 0 0 0 10 0 10 10 0 10 0 0\)\)/)
assert.match(accepted.text, /\(plane "\+5V" \(polygon "Inner1" 0 0 0 10 0 10 10 0 10 0 0\)\)/)
assert.equal(accepted.changes.filter(change => change.kind === 'plane').length, 2)

const unknownVersion = await prepareDsnWithPouredPlanes(makeSdk({ version: '4.2.0', pours: [{ id: 'unknown', net: 'GND', fill: true }] }), dsn, 'board-1', documentSource)
assert.equal(unknownVersion.changed, false, 'unknown host versions do not use unverified coordinate conversion')
assert.equal(unknownVersion.text, dsn)
assert.ok(unknownVersion.warnings.some(warning => warning.includes('未验证')))

const complexPath = await prepareDsnWithPouredPlanes(makeSdk({ pours: [{ id: 'complex', net: 'GND', fill: true, pathSource: [[[0, 0, 1, 0, 1, 1, 0, 1, 'L']]] }] }), dsn, 'board-1', documentSource)
assert.equal(complexPath.changed, false, 'only the observed single wrapper is unwrapped')
assert.equal(complexPath.text, dsn)
assert.ok(complexPath.warnings.some(warning => warning.includes('路径/单位未验证')))

const strokeWidthOnly = await prepareDsnWithPouredPlanes(makeSdk({ pours: [{ id: 'stroke-only', net: 'GND', fill: true, strokeWidthOnly: true }] }), dsn, 'board-1', documentSource)
assert.equal(strokeWidthOnly.changed, false, 'strokeWidth is not accepted as a substitute for the SDK lineWidth field')
assert.ok(strokeWidthOnly.warnings.some(warning => warning.includes('lineWidth 未验证为 0')))

const missingLineWidth = await prepareDsnWithPouredPlanes(makeSdk({ pours: [{ id: 'no-line-width', net: 'GND', fill: true, missingLineWidth: true }] }), dsn, 'board-1', documentSource)
assert.equal(missingLineWidth.changed, false, 'missing lineWidth prevents plane generation')
assert.ok(missingLineWidth.warnings.some(warning => warning.includes('lineWidth 未验证为 0')))

const noFilledRegion = await prepareDsnWithPouredPlanes(makeSdk({ pours: [{ id: 'empty', net: 'GND', fill: false }] }), dsn, 'board-1', documentSource)
assert.equal(noFilledRegion.changed, false, 'an empty fill never synthesizes a plane from the boundary')
assert.equal(noFilledRegion.text, dsn)
assert.ok(noFilledRegion.warnings.some(warning => warning.includes('没有提供 plane 多边形')))

const slotSource = [
	'{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"board-1","client":"one"}|',
	'{"type":"CANVAS","id":"CANVAS"}||{"unit":"mil"}|',
	'{"type":"RULE","id":"[\\"RULE\\",\\"SAFE\\",\\"copperThickness1oz\\"]","ticket":1}||{"ruleState":"DEFAULT","ruleContext":{"unit":"mil","isForAll":"ALL"}}|',
	'{"type":"PAD_NET","id":"padnet1","ticket":2}||{"padNet":"+5V"}|',
	'{"type":"PAD_NET","id":"padnet2","ticket":3}||{"padNet":"ACE_VIA"}|',
	'{"type":"RULE_SELECTOR","id":"[\\"RULE_SELECTOR\\",[\\"NET\\",\\"+5V\\"]]","ticket":4}||{"ruleOrder":4,"ruleKeyValue":{"TRACK":"ACE_POWER20"},"copperValue":{},"innerPlaneValue":{},"parent":null}|',
	'{"type":"RULE_SELECTOR","id":"[\\"RULE_SELECTOR\\",[\\"NET\\",\\"ACE_VIA\\"]]","ticket":5}||{"ruleOrder":4,"ruleKeyValue":{},"copperValue":{},"innerPlaneValue":{},"parent":null}|',
	'{"type":"FILL","id":"slot1","ticket":6}||{"layerId":12,"netName":"","path":[["R",690,200,135,45,0,0]]}|',
	'{"type":"FILL","id":"filled-copper","ticket":7}||{"layerId":1,"netName":"","path":[["R",100,200,135,45,0,0]]}|',
].join('\n')
const slotDsn = `(pcb demo
 (parser)
 (resolution mil 1000)
 (unit mil)
 (structure (boundary (path signal 0 0 0 0 1000 0 1000 1000 0 1000 0 0))
  (layer TopLayer (type signal)) (layer Inner1 (type signal)) (layer Inner2 (type signal)) (layer BottomLayer (type signal)))
 (placement (component u1 (place u1 0 0 front 0)))
 (library (image u1 (pin ps-slot slot1 757.5 177.5))
  (padstack ps-slot
   (shape (polygon TopLayer 0 -67.5 -22.5 -67.5 22.5 67.5 22.5 67.5 -22.5 -67.5 -22.5))
   (shape (polygon Inner1 0 -67.5 -22.5 -67.5 22.5 67.5 22.5 67.5 -22.5 -67.5 -22.5))
   (shape (polygon Inner2 0 -67.5 -22.5 -67.5 22.5 67.5 22.5 67.5 -22.5 -67.5 -22.5))
   (shape (polygon BottomLayer 0 -67.5 -22.5 -67.5 22.5 67.5 22.5 67.5 -22.5 -67.5 -22.5)))
 )
  (network (net +5V (pins)) (net ACE_VIA (pins)))
)`
const safeRule = ({ clearance = 11.811, unit = 'mil', rows = ['Track', 'Pad', 'Via', 'Copper Region', 'Hole', 'Board Outline', 'Keepout', 'Slot Region'], columns = ['Track', 'Pad'], isSetDefault = true, status = 0, tables = { '1': { status: 1, content: rows.map((_, index) => index === rows.indexOf('Slot Region') ? [clearance, clearance] : [6, 6]) } } } = {}) => ({
	config: {
		Spacing: {
			'Safe Spacing': {
				copperThickness1oz: {
					isSetDefault,
					unit,
					row: rows,
					column: columns,
					status,
					tables,
				},
			},
		},
	},
})
const observedNetRule = (name, safeSpacing = 'default', targetNet = null, type = 'net') => ({
	type, name, 'Safe Spacing': safeSpacing, 'Copper Safe Spacing': null, 'Plane Safe Spacing': null,
	Track: 'default', 'Net Length Range': 'default', 'Net Length Tolerance': null, 'Blind/Buried Via': 'default',
	'Via Size': 'default', 'Plane Zone': 'default', 'Copper Zone': 'default', 'Solder Mask Expansion': 'default',
	'Paste Mask Expansion': 'default', 'Creepage Distance': null, targetNet,
})
const defaultNetRules = [observedNetRule('+5V'), observedNetRule('ACE_VIA')]
const regionSelector = '{"type":"RULE_SELECTOR","id":"[\\"RULE_SELECTOR\\",[\\"REGION\\",\\"region-test\\"]]","ticket":8}||{"ruleOrder":4,"ruleKeyValue":{"SAFE":"copperThickness2oz"},"copperValue":{},"innerPlaneValue":{},"parent":null}|'
const selectorSource = (selectorRecords = []) => `${slotSource}${selectorRecords.length ? `\n${selectorRecords.join('\n')}` : ''}`
function slotSdk({ rules = safeRule(), netRules = defaultNetRules, changeSourceAfterRead = false, sourceOverride = slotSource } = {}) {
	let reads = 0
	const source = () => {
		reads++
		const docHead = `{"type":"DOCHEAD"}||${JSON.stringify({ docType: 'PCB', uuid: 'board-1', client: `client-${reads}` })}|`
		return sourceOverride.replace(/^\{"type":"DOCHEAD"\}[^\n]*/u, docHead)
	}
	return {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'board-1' }) },
		sys_FileManager: { getDocumentSource: async () => changeSourceAfterRead && reads >= 1 ? sourceOverride.replace('690,200', '691,200') : source() },
		pcb_Drc: { getCurrentRuleConfiguration: async () => rules, getNetRules: async () => netRules },
	}
}
const slotInput = { originalText: slotDsn, text: slotDsn, changed: false, changes: [], warnings: [], limitations: [] }
const clearance11811 = await prepareDsnWithSlotClearances(slotSdk(), slotInput, 'board-1', slotSource)
assert.equal(clearance11811.slotClearance?.clearanceMil, 11.811)
assert.deepEqual(clearance11811.slotClearance?.appliedSlotIds, ['slot1'])
assert.equal(clearance11811.slotClearance?.conservativeDefaultClass, true)
assert.equal(clearance11811.slotClearance?.planeSlotEquivalent, false)
assert.match(clearance11811.text, /clearance_class aceslotslot1/)
const reorderedSlotRules = safeRule({ clearance: 25, rows: ['Slot Region', 'Track', 'Pad'], columns: ['Pad', 'Track'] })
const clearance25 = await prepareDsnWithSlotClearances(slotSdk({ rules: reorderedSlotRules }), slotInput, 'board-1', slotSource)
assert.equal(clearance25.slotClearance?.clearanceMil, 25, 'the matrix is resolved by labels after row and column order changes')
assert.match(clearance25.text, /\(clearance 25 \(type default_aceslotslot1\)\)/)
const clearanceMm = await prepareDsnWithSlotClearances(slotSdk({ rules: safeRule({ clearance: 0.2999994, unit: 'mm' }) }), slotInput, 'board-1', slotSource)
assert.ok(Math.abs(clearanceMm.slotClearance?.clearanceMil - 11.811) < 0.001, 'verified mm scalar converts to mil')
const unknownSlotUnit = await prepareDsnWithSlotClearances(slotSdk({ rules: safeRule({ unit: 'milimeters' }) }), slotInput, 'board-1', slotSource)
assert.equal(unknownSlotUnit.changed, false, 'unknown SAFE units never create a guessed DSN clearance')
assert.ok(unknownSlotUnit.warnings.some(warning => warning.includes('已验证 profile')))
const customSlotSelector = await prepareDsnWithSlotClearances(slotSdk({ netRules: [observedNetRule('+5V', 'ACE_POWER20'), observedNetRule('ACE_VIA')] }), slotInput, 'board-1', slotSource)
assert.equal(customSlotSelector.changed, false, 'an observed-schema custom Safe Spacing selector prevents global slot augmentation')
const missingNetRule = await prepareDsnWithSlotClearances(slotSdk({ netRules: [observedNetRule('+5V')] }), slotInput, 'board-1', slotSource)
assert.equal(missingNetRule.changed, false, 'every DSN network must have exactly one getNetRules entry')
const duplicateNetRule = await prepareDsnWithSlotClearances(slotSdk({ netRules: [...defaultNetRules, observedNetRule('+5V')] }), slotInput, 'board-1', slotSource)
assert.equal(duplicateNetRule.changed, false, 'duplicate getNetRules entries are ambiguous')
const unknownTypeNetRule = await prepareDsnWithSlotClearances(slotSdk({ netRules: [defaultNetRules[0], observedNetRule('ACE_VIA', 'default', null, 'unknown')] }), slotInput, 'board-1', slotSource)
assert.equal(unknownTypeNetRule.changed, false, 'unknown getNetRules record types never pass the verified schema')
const missingNameNetRule = { ...observedNetRule('ACE_VIA') }
delete missingNameNetRule.name
const unknownNameNetRule = await prepareDsnWithSlotClearances(slotSdk({ netRules: [defaultNetRules[0], missingNameNetRule] }), slotInput, 'board-1', slotSource)
assert.equal(unknownNameNetRule.changed, false, 'a getNetRules entry without name makes network mapping ambiguous')
const scopedNetRule = await prepareDsnWithSlotClearances(slotSdk({ netRules: [defaultNetRules[0], observedNetRule('ACE_VIA', 'default', '+5V')] }), slotInput, 'board-1', slotSource)
assert.equal(scopedNetRule.changed, false, 'a net rule with non-null targetNet can have unknown regional scope')
const unknownScopedNetRule = { ...observedNetRule('ACE_VIA'), targetRegion: 'region-1' }
const unknownScopeNetRule = await prepareDsnWithSlotClearances(slotSdk({ netRules: [defaultNetRules[0], unknownScopedNetRule] }), slotInput, 'board-1', slotSource)
assert.equal(unknownScopeNetRule.changed, false, 'unrecognized rule scope fields require conservative skip')
const statusNetRule = await prepareDsnWithSlotClearances(slotSdk({ rules: safeRule({ status: 1 }) }), slotInput, 'board-1', slotSource)
assert.equal(statusNetRule.changed, false, 'unverified rule status is rejected')
const extraTables = { '1': safeRule().config.Spacing['Safe Spacing'].copperThickness1oz.tables['1'], '2': { status: 1, content: [[99]] } }
const extraTableRule = await prepareDsnWithSlotClearances(slotSdk({ rules: safeRule({ tables: extraTables }) }), slotInput, 'board-1', slotSource)
assert.equal(extraTableRule.changed, false, 'additional spacing tables cannot be ignored')
const duplicateSlotLabelRule = await prepareDsnWithSlotClearances(slotSdk({ rules: safeRule({ rows: ['Track', 'Slot Region', 'Slot Region'] }) }), slotInput, 'board-1', slotSource)
assert.equal(duplicateSlotLabelRule.changed, false, 'duplicate Slot Region labels are ambiguous')
const duplicateTrackLabelRule = await prepareDsnWithSlotClearances(slotSdk({ rules: safeRule({ columns: ['Track', 'Track'] }) }), slotInput, 'board-1', slotSource)
assert.equal(duplicateTrackLabelRule.changed, false, 'duplicate Track labels are ambiguous')
const secondConfiguredDefault = safeRule()
secondConfiguredDefault.config.Spacing['Safe Spacing'].otherSafeSpacing = { isSetDefault: true, status: 0, unit: 'mil', row: ['Slot Region'], column: ['Track'], tables: { '1': { status: 1, content: [[20]] } } }
const multipleConfigurationDefaults = await prepareDsnWithSlotClearances(slotSdk({ rules: secondConfiguredDefault }), slotInput, 'board-1', slotSource)
assert.equal(multipleConfigurationDefaults.changed, false, 'multiple configured default SAFE rules are ambiguous')
const secondSourceDefault = `${slotSource}\n{"type":"RULE","id":"[\\"RULE\\",\\"SAFE\\",\\"otherSafeSpacing\\"]","ticket":9}||{"ruleState":"DEFAULT","ruleContext":{"unit":"mil","isForAll":"ALL"}}|`
const multipleSourceDefaults = await prepareDsnWithSlotClearances(slotSdk({ sourceOverride: secondSourceDefault }), slotInput, 'board-1', secondSourceDefault)
assert.equal(multipleSourceDefaults.changed, false, 'multiple effective source DEFAULT SAFE rules are ambiguous')
const regionRuleSelectorSource = selectorSource([regionSelector])
const regionRuleSelector = await prepareDsnWithSlotClearances(slotSdk({ sourceOverride: regionRuleSelectorSource }), slotInput, 'board-1', regionRuleSelectorSource)
assert.equal(regionRuleSelector.changed, false, 'a REGION selector with a non-default SAFE reference must block slot compensation')
assert.ok(regionRuleSelector.warnings.some(warning => warning.includes('未应用')))
const netByNetSelector = '{"type":"RULE_SELECTOR","id":"[\\"RULE_SELECTOR\\",[\\"NET_BY_NET\\",\\"+5V\\"]]","ticket":8}||{"ruleOrder":4,"ruleKeyValue":{"SAFE":"default"},"copperValue":{},"innerPlaneValue":{},"parent":null}|'
const netByNetSelectorSource = selectorSource([netByNetSelector])
const netByNetSelectorResult = await prepareDsnWithSlotClearances(slotSdk({ sourceOverride: netByNetSelectorSource }), slotInput, 'board-1', netByNetSelectorSource)
assert.equal(netByNetSelectorResult.changed, false, 'a NET_BY_NET selector is outside the validated selector shape')
assert.ok(netByNetSelectorResult.warnings.some(warning => warning.includes('未应用')))
const badSelectorId = '{"type":"RULE_SELECTOR","id":"not-json","ticket":8}||{"ruleOrder":4,"ruleKeyValue":{},"copperValue":{},"innerPlaneValue":{},"parent":null}|'
const badSelectorIdSource = selectorSource([badSelectorId])
const badRuleSelector = await prepareDsnWithSlotClearances(slotSdk({ sourceOverride: badSelectorIdSource }), slotInput, 'board-1', badSelectorIdSource)
assert.equal(badRuleSelector.changed, false, 'an unparseable selector ID must block slot compensation')
const wrongSafeSelector = '{"type":"RULE_SELECTOR","id":"[\\"RULE_SELECTOR\\",[\\"NET\\",\\"+5V\\"]]","ticket":4}||{"ruleOrder":4,"ruleKeyValue":{"SAFE":"copperThickness2oz"},"copperValue":{},"innerPlaneValue":{},"parent":null}|'
const wrongSafeSelectorSource = `${slotSource.replace(/\{"type":"RULE_SELECTOR"[^\n]*\+5V[^\n]*/u, '')}\n${wrongSafeSelector}`
const nonDefaultSafeSelector = await prepareDsnWithSlotClearances(slotSdk({ sourceOverride: wrongSafeSelectorSource }), slotInput, 'board-1', wrongSafeSelectorSource)
assert.equal(nonDefaultSafeSelector.changed, false, 'a NET selector with non-default SAFE reference must block slot compensation')
assert.ok(nonDefaultSafeSelector.warnings.some(warning => warning.includes('未应用')))
const extraNetSelector = '{"type":"RULE_SELECTOR","id":"[\\"RULE_SELECTOR\\",[\\"NET\\",\\"not-in-dsn\\"]]","ticket":8}||{"ruleOrder":4,"ruleKeyValue":{},"copperValue":{},"innerPlaneValue":{},"parent":null}|'
const extraNetSelectorSource = selectorSource([extraNetSelector])
const extraNetSelectorResult = await prepareDsnWithSlotClearances(slotSdk({ sourceOverride: extraNetSelectorSource }), slotInput, 'board-1', extraNetSelectorSource)
assert.equal(extraNetSelectorResult.changed, false, 'selectors outside the DSN network set make scope ambiguous')
const scopedSafeSource = slotSource.replace('"isForAll":"ALL"', '"isForAll":"NETS"')
const scopedSafeSdk = { ...slotSdk(), sys_FileManager: { getDocumentSource: async () => scopedSafeSource } }
const scopedSafe = await prepareDsnWithSlotClearances(scopedSafeSdk, slotInput, 'board-1', scopedSafeSource)
assert.equal(scopedSafe.changed, false, 'a source SAFE rule with explicit non-global scope keeps the DSN unchanged')
const netBoundSlotDsn = slotDsn.replace('(net +5V (pins))', '(net +5V (pins u1-slot1))')
const netBoundSlot = await prepareDsnWithSlotClearances(slotSdk(), { ...slotInput, originalText: netBoundSlotDsn, text: netBoundSlotDsn }, 'board-1', slotSource)
assert.equal(netBoundSlot.changed, false, 'a DSN pin already assigned to a net is not treated as an unconnected slot')
assert.ok(netBoundSlot.slotClearance?.skippedSlots.some(slot => slot.reason.includes('列入 DSN network')))
const unstableSlot = await prepareDsnWithSlotClearances(slotSdk({ changeSourceAfterRead: true }), slotInput, 'board-1', slotSource)
assert.equal(unstableSlot.changed, false, 'unstable source snapshots keep the original DSN')
const invalidSlotShape = slotSource.replace('["R",690,200,135,45,0,0]', '["R",690,200,135,45,90,0]')
const invalidSlotResult = await prepareDsnWithSlotClearances({ ...slotSdk(), sys_FileManager: { getDocumentSource: async () => invalidSlotShape } }, slotInput, 'board-1', invalidSlotShape)
assert.equal(invalidSlotResult.changed, false, 'rotated or otherwise mismatched slot rectangles are not inferred')
const realSlotDsnFixture = await readFile(resolve(import.meta.dirname, 'fixtures/ac-v059-reopened-slot.dsn'), 'utf8')
const realDsnProfile = await prepareDsnWithSlotClearances(slotSdk(), { ...slotInput, originalText: realSlotDsnFixture, text: realSlotDsnFixture }, 'board-1', slotSource)
assert.ok(realDsnProfile.slotClearance, 'the real DSN fixture with `(string_quote ")` reaches verified slot diagnostics')
assert.ok(!realDsnProfile.warnings.some(warning => warning.includes('已验证 profile')), 'the real DSN fixture retains the verified default profile')
for (const [label, skipped] of [
	['custom SAFE selector', customSlotSelector], ['missing network rule', missingNetRule], ['duplicate network rule', duplicateNetRule],
	['unknown rule type', unknownTypeNetRule], ['missing network name', unknownNameNetRule], ['targetNet scope', scopedNetRule],
	['unknown region scope', unknownScopeNetRule], ['wrong status', statusNetRule], ['extra table', extraTableRule],
	['duplicate row label', duplicateSlotLabelRule], ['duplicate column label', duplicateTrackLabelRule],
	['multiple configured defaults', multipleConfigurationDefaults], ['multiple source defaults', multipleSourceDefaults],
	['REGION selector', regionRuleSelector], ['malformed selector ID', badRuleSelector],
	['non-default SAFE selector', nonDefaultSafeSelector],
]) {
	assert.equal(skipped.changed, false, `${label} must keep the DSN unchanged`)
	assert.ok(skipped.warnings.length > 0, `${label} must report why slot injection was skipped`)
}

globalThis.eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'board-1' }) },
	pcb_ManufactureData: { getDsnFile: async () => new Blob([dsn], { type: 'application/dsn' }) },
}
const exportDsn = pcbCommands.find(command => command.name === 'pcb.exportDsn').handler
const exported = await exportDsn({})
assert.equal(exported.original.base64, Buffer.from(dsn).toString('base64'))
assert.equal(exported.widthRuleComparison.status, 'incomplete', 'missing PCB source and layer evidence cannot be reported as a width match')
assert.ok(exported.widthRuleComparison.unknowns.length > 0)
const exportedText = Buffer.from(exported.base64, 'base64').toString('utf8')
assert.match(exportedText, /\(string_quote "\)/, 'missing snapshot support still retains the established quote repair')
assert.doesNotMatch(exportedText, /\(plane /, 'missing snapshot support does not write a plane')
assert.ok(exported.conversion.warnings.some(warning => warning.includes('getDocumentSource')))
assert.ok(exported.conversion.limitations.some(item => item.includes('源码快照不可用')))
assert.equal(new Set(exported.conversion.changes.map(change => JSON.stringify(change))).size, exported.conversion.changes.length, 'fallback does not duplicate quote changes')

const unmatchedDsn = dsn.replace('(network (net GND) (net +5V))', "(network (net GND) (net +5V) (class demo 'MISSING'))")
const volatileHeaderSdk = makeSdk({ pours: [{ id: 'gnd', net: 'GND', fill: true }] })
let exportSnapshotRead = 0
volatileHeaderSdk.sys_FileManager.getDocumentSource = async () => {
	exportSnapshotRead++
	return `{"type":"DOCHEAD"}||${JSON.stringify({ docType: 'PCB', client: `client-${exportSnapshotRead}`, uuid: 'board-1', updateTime: exportSnapshotRead, version: String(exportSnapshotRead) })}|`
}
globalThis.eda = {
	...volatileHeaderSdk,
	pcb_ManufactureData: { getDsnFile: async () => new Blob([unmatchedDsn], { type: 'application/dsn' }) },
}
const stableExport = await exportDsn({})
assert.ok(exportSnapshotRead >= 4, 'export compares source snapshots before and after preparation')
assert.ok(stableExport.conversion.warnings.every(warning => !warning.includes('快照不匹配')))
assert.ok(stableExport.conversion.changes.some(change => change.kind === 'plane'))
assert.equal(stableExport.widthRuleComparison.status, 'incomplete', 'a stable but rule-incomplete source does not claim DSN width equivalence')
assert.ok(stableExport.conversion.warnings.some(warning => warning.includes('未匹配')), 'plane preparation retains quote-stage network-identity warnings')
assert.equal(stableExport.original.base64, Buffer.from(unmatchedDsn).toString('base64'))

const actualWidthFixture = JSON.parse(await readFile(resolve(import.meta.dirname, 'fixtures/routing-width-real-host.json'), 'utf8'))
const multiWidthRows = [
	{ layerId: 1, stroMin: 5, stroDef: 20, stroMax: 100 },
	{ layerId: 2, stroMin: 25, stroDef: 30, stroMax: 35 },
	{ layerId: 15, stroMin: 5, stroDef: 20, stroMax: 100 },
	{ layerId: 16, stroMin: 5, stroDef: 20, stroMax: 100 },
]
const actualWidthRuleSource = mutateSourceRecord(actualWidthFixture.source, header => header.type === 'RULE' && header.id === '["RULE","TRACK","ACE_POWER20"]', (_header, data) => { data.ruleContext.track.content = multiWidthRows })
const actualWidthSource = `{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"board-1"}|\n${actualWidthRuleSource}`
let actualWidthSourceReads = 0
globalThis.eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: 'board-1' }) },
	sys_FileManager: { getDocumentSource: async () => { actualWidthSourceReads++; return actualWidthSource } },
	sys_Environment: { getEditorCurrentVersion: () => '4.1.78' },
	pcb_Layer: { getAllLayers: async () => [
		{ id: 1, name: 'TopLayer', type: 'SIGNAL', layerStatus: 1 },
		{ id: 2, name: 'BottomLayer', type: 'SIGNAL', layerStatus: 2 },
		{ id: 15, name: 'Inner1', type: 'SIGNAL', layerStatus: 2 },
		{ id: 16, name: 'Inner2', type: 'SIGNAL', layerStatus: 2 },
	] },
	pcb_Drc: { getNetRules: async () => [{ type: 'net', name: '+5V', Track: 'ACE_POWER20' }] },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitivePoured: { getAll: async () => [] },
	pcb_ManufactureData: { getDsnFile: async () => new Blob([actualWidthFixture.dsn], { type: 'application/dsn' }) },
}
const actualWidthExport = await exportDsn({})
assert.equal(actualWidthExport.widthRuleComparison.defaultRule.status, 'mismatch', 'actual DSN global width 10.05 is reported against EDA preferred width 10')
const actualMultiNet = actualWidthExport.widthRuleComparison.nets.find(entry => entry.net === '+5V')
assert.equal(actualMultiNet?.status, 'mismatch', 'actual +5V DSN width 20 differs from the layer-specific bottom preference')
assert.equal(actualMultiNet?.layers?.find(layer => layer.layerId === 2)?.deviationFromPreferredMil, -10)
assert.equal(actualMultiNet?.layers?.find(layer => layer.layerId === 2)?.withinEdaBounds, false)
assert.equal(actualWidthExport.routingConstraintsComplete, false)

let unstableWidthSourceReads = 0
const unstableWidthSource = `${actualWidthSource}\n{"type":"POURED","id":"width-source-drift"}||{"net":"GND","layer":15}|`
globalThis.eda = {
	...globalThis.eda,
	sys_FileManager: { getDocumentSource: async () => {
		unstableWidthSourceReads++
		return unstableWidthSourceReads >= actualWidthSourceReads ? unstableWidthSource : actualWidthSource
	} },
}
const unstableWidthExport = await exportDsn({})
assert.equal(unstableWidthExport.widthRuleComparison.status, 'incomplete', 'a source drift after width reads invalidates the comparison result')
assert.equal(unstableWidthExport.widthRuleComparison.defaultRule.status, 'unknown', 'a stale default mismatch is not retained as a current-board conclusion')
assert.ok(unstableWidthExport.widthRuleComparison.unknowns.some(item => item.includes('不再代表当前 PCB')))
assert.equal(unstableWidthExport.widthRuleComparison.nets.find(entry => entry.net === '+5V')?.layers, undefined, 'invalidated width comparison drops stale per-layer comparisons')

globalThis.eda = {
	...slotSdk(),
	pcb_Layer: { getAllLayers: async () => [] },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitivePoured: { getAll: async () => [] },
	pcb_ManufactureData: { getDsnFile: async () => new Blob([slotDsn], { type: 'application/dsn' }) },
}
const slotExported = await exportDsn({})
assert.deepEqual(slotExported.conversion.slotClearance.appliedSlotIds, ['slot1'], 'pcb.exportDsn applies the verified slot stage')
assert.match(Buffer.from(slotExported.base64, 'base64').toString('utf8'), /clearance_class aceslotslot1/)
assert.equal(slotExported.routingConstraintsComplete, false)

console.log('DSN export command regression passed: normalized inner fills, width-field validation, unknown host, empty fill, and missing snapshot fallback')

