import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const rulesBundle = await build({ entryPoints: ['src/engine/routingWidthRules.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const rules = await import(`data:text/javascript;base64,${Buffer.from(rulesBundle.outputFiles[0].text).toString('base64')}`)
const { buildRoutingNetAliasSnapshot, checkSesWidthRules } = rules
const collectorBundle = await build({ entryPoints: ['src/pcb/kiroutingInput.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const collector = await import(`data:text/javascript;base64,${Buffer.from(collectorBundle.outputFiles[0].text).toString('base64')}`)
const { extractRuleEvidence } = collector

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/kirouting/host-ulx3s-net-aliases.json'), 'utf8'))
const geometry = fixture.nets.map(net => ({ name: net.name, padIds: net.pads.map(pad => pad.id) }))
const records = fixture.design_rules.sourceRuleRecords
const aliases = buildRoutingNetAliasSnapshot(geometry, records, fixture.routing_config, fixture.design_rules.netRules)
assert.equal(aliases.length, 329, 'all ULX geometry nets get a separate name proof')
assert.equal(aliases.filter(alias => alias.status === 'known').length, 329, 'the known ULX geometry-to-rule aliases remain unique')
assert.equal(aliases.find(alias => alias.geometryNet === '/analog/AUDIO_L')?.ruleNet, '/ANALOG/AUDIO_L')
assert.equal(fixture.nets[1].name, '/analog/AUDIO_L', 'geometry/export net name is not rewritten')

const evidence = extractRuleEvidence(fixture.design_rules.configuration, fixture.design_rules.netRules, geometry.map(net => net.name), records, fixture.routing_config, aliases)
assert.equal(evidence.trackWidth.status, 'known')
assert.equal(evidence.trackWidth.mil, 10)
assert.equal(evidence.globalClearance.status, 'known')
assert.ok(Math.abs(evidence.globalClearance.mil - 10) < 1e-8, `SAFE clearance stays 10 mil, got ${evidence.globalClearance.mil}`)
assert.equal(evidence.boardEdgeClearance.status, 'known')
assert.ok(Math.abs(evidence.boardEdgeClearance.mil - 11.8) < 1e-8, `board-edge clearance stays 11.8 mil, got ${evidence.boardEdgeClearance.mil}`)
assert.equal(evidence.netTrackWidths.length, 329)
assert.ok(evidence.netTrackWidths.every(net => net.status === 'known' && net.layers.length === 4 && net.layers.every(layer => layer.widthMil === 10)))

const baseSnapshot = {
	...fixture.routing_config,
	nets: [{ net: 'FOO', ruleKey: 'DEFAULT', status: 'known', layers: [{ layerId: 1, minMil: 5, preferredMil: 10, maxMil: 100, status: 'known' }] }],
}
const smallRecords = (names, selectorNames = names, padNet = 'foo') => [
	...names.map(name => ({ type: 'NET', id: JSON.stringify(['NET', name]), data: {} })),
	...selectorNames.map(name => ({ type: 'RULE_SELECTOR', id: JSON.stringify(['RULE_SELECTOR', ['NET', name]]), data: {} })),
	{ type: 'PAD_NET', id: JSON.stringify(['PAD_NET', 'C1', '1', 'P1']), data: { padNet } },
]
const geom = [{ name: 'foo', padIds: ['C1P1'] }]
const sdkRows = [{ type: 'net', name: 'FOO', Track: 'default' }]
const aliasProof = (source = smallRecords(['FOO']), snapshot = baseSnapshot, rules = sdkRows) => buildRoutingNetAliasSnapshot(geom, source, snapshot, rules)
const validAlias = aliasProof()
assert.deepEqual(validAlias.map(alias => [alias.geometryNet, alias.ruleNet, alias.status]), [['foo', 'FOO', 'known']])
assert.equal(checkSesWidthRules(baseSnapshot, [{ net: 'foo', layer: 1, widthMil: 10 }], validAlias, sdkRows).status, 'compliant')
assert.equal(checkSesWidthRules(baseSnapshot, [{ net: 'foo', layer: 1, widthMil: 4 }], validAlias, sdkRows).status, 'violation', 'the alias does not weaken the original minimum')

const collision = aliasProof(smallRecords(['foo', 'FOO']))
assert.equal(collision[0].status, 'unknown', 'case-fold collisions across source NET names are rejected')
assert.equal(checkSesWidthRules(baseSnapshot, [{ net: 'foo', layer: 1, widthMil: 10 }], collision, sdkRows).status, 'unknown')
const geometryCollision = buildRoutingNetAliasSnapshot([{ name: 'foo', padIds: ['C1P1'] }, { name: 'FOO', padIds: ['C1P1'] }], smallRecords(['FOO']), baseSnapshot, sdkRows)
assert.equal(geometryCollision.find(alias => alias.geometryNet === 'foo')?.status, 'unknown', 'case-fold collisions block the geometry alias')
assert.equal(geometryCollision.find(alias => alias.geometryNet === 'FOO')?.ruleNet, 'FOO', 'the exact-name route retains priority')
assert.equal(aliasProof(smallRecords(['FOO'], ['OTHER']))[0].status, 'unknown', 'selector/source disagreement is rejected')
assert.equal(aliasProof(smallRecords(['FOO'], ['FOO', 'foo']))[0].status, 'unknown', 'case-fold collisions across selectors are rejected')
assert.equal(aliasProof(smallRecords(['FOO'], ['FOO'], 'FOO'))[0].status, 'unknown', 'PAD_NET must prove the raw geometry-net owner')
assert.equal(aliasProof(smallRecords(['FOO']).filter(record => record.type !== 'PAD_NET'))[0].status, 'unknown', 'missing PAD_NET owner is rejected')
assert.equal(aliasProof(smallRecords(['FOO']), { ...baseSnapshot, nets: [] })[0].status, 'unknown', 'missing SDK rule entry is rejected')
assert.equal(aliasProof(smallRecords(['FOO']), { ...baseSnapshot, nets: [baseSnapshot.nets[0], baseSnapshot.nets[0]] })[0].status, 'unknown', 'duplicate SDK rule entries are rejected')

const targetHostRule = fixture.design_rules.netRules.find(row => row.type === 'net' && row.name === '/ANALOG/AUDIO_L')
assert.ok(targetHostRule, 'fixture contains the original SDK net row for the real aliased net')
const missingHostRows = fixture.design_rules.netRules.filter(row => row !== targetHostRule)
const duplicateHostRows = [{ ...targetHostRule, Track: 'DOES_NOT_EXIST' }, ...fixture.design_rules.netRules]
const hostGeometryAlias = geometry.find(net => net.name === '/analog/AUDIO_L')
assert.equal(buildRoutingNetAliasSnapshot([hostGeometryAlias], records, fixture.routing_config, missingHostRows)[0].status, 'unknown', 'missing original SDK net row blocks alias creation')
assert.equal(buildRoutingNetAliasSnapshot([hostGeometryAlias], records, fixture.routing_config, duplicateHostRows)[0].status, 'unknown', 'duplicate original SDK rows with conflicting Track block alias creation')
const knownHostAlias = aliases.find(alias => alias.geometryNet === '/analog/AUDIO_L')
const hostSesLine = [{ net: '/analog/AUDIO_L', layer: 1, widthMil: 10 }]
assert.equal(checkSesWidthRules(fixture.routing_config, hostSesLine, [knownHostAlias], fixture.design_rules.netRules).status, 'compliant')
assert.equal(checkSesWidthRules(fixture.routing_config, hostSesLine, [knownHostAlias], missingHostRows).status, 'unknown', 'import readback SDK row deletion invalidates the old alias proof')
assert.equal(checkSesWidthRules(fixture.routing_config, hostSesLine, [knownHostAlias], duplicateHostRows).status, 'unknown', 'import readback SDK row duplication invalidates the old alias proof')

const exactName = buildRoutingNetAliasSnapshot([{ name: 'FOO', padIds: [] }], [], baseSnapshot)
assert.equal(exactName[0].status, 'known', 'exact snapshot names retain the legacy path without PAD_NET evidence')
assert.equal(checkSesWidthRules(baseSnapshot, [{ net: 'FOO', layer: 1, widthMil: 10 }]).status, 'compliant', 'callers without aliases retain exact-name behavior')

console.log('routing net alias regression passed')
