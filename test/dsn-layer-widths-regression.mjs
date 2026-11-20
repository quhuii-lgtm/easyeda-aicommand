import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'

const loader = `export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith('.') && !/\\.(?:ts|js|mjs|json)$/.test(specifier)) {
		try { return await nextResolve(specifier + '.ts', context) } catch {}
	}
	return nextResolve(specifier, context)
}`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)
const [{ applyDsnLayerWidthRules }, { buildRoutingWidthSnapshot, checkSesWidthRules, compareDsnWidthRules, resolveDsnLayerId, dsnLayerNameMatchesSdk }] = await Promise.all([
	import('../src/engine/dsnLayerWidths.ts'),
	import('../src/engine/routingWidthRules.ts'),
])

assert.equal(resolveDsnLayerId('TopLayer'), 1)
assert.equal(resolveDsnLayerId('BottomLayer'), 2)
assert.equal(resolveDsnLayerId('Inner2'), 16)
assert.equal(resolveDsnLayerId('Top Layer'), undefined)
assert.equal(dsnLayerNameMatchesSdk('Top Layer', 'TopLayer', 1), true)
assert.equal(dsnLayerNameMatchesSdk('Inner 2', 'Inner2', 16), true)

const snapshot = () => ({
	schemaVersion: 1,
	editorVersion: '4.1.78',
	sourceUnit: 'mil',
	unitAssumption: 'mil',
	globalStatus: 'known',
	defaultRule: {
		layerId: 1, name: 'Top Layer', minMil: 10, preferredMil: 15, maxMil: 30, status: 'known', ruleKey: 'DEFAULT',
		layers: [
			{ layerId: 1, name: 'Top Layer', minMil: 10, preferredMil: 15, maxMil: 30, status: 'known' },
			{ layerId: 2, name: 'Bottom Layer', minMil: 20, preferredMil: 25, maxMil: 40, status: 'known' },
		],
	},
	nets: ['TopNet', 'BottomNet'].map(net => ({
		net, ruleKey: 'CLASS20', status: 'known', layers: [
			{ layerId: 1, name: 'Top Layer', minMil: 10, preferredMil: 20, maxMil: 35, status: 'known' },
			{ layerId: 2, name: 'Bottom Layer', minMil: 20, preferredMil: 30, maxMil: 45, status: 'known' },
		],
	})),
	unknowns: [],
	routingConstraintsComplete: false,
})

const fixture = `(PCB probe
  ; keep comments, quote delimiters, and original whitespace
  (parser (string_quote ") (space_in_quoted_tokens on))
  (resolution mil 1000)
  (structure
    (boundary (path signal 0 0 0 0 1000 800 1000 800 0 0 0))
    (via via0)
    (layer TopLayer (type signal))
    (layer BottomLayer (type signal))
    (rule (width 15))
  )
  (network
    (net TopNet (pins U1-1 U2-1))
    (net BottomNet (pins U3-1 U4-1))
    (class TopClass TopNet (circuit (use_via via0)) (rule (width 20) (clearance 4)))
    (class BottomClass BottomNet (circuit (use_via via0)) (rule (width 20) (clearance 4)))
  )
)`

const repaired = applyDsnLayerWidthRules(snapshot(), fixture)
const repairedWithMmDisplayMarker = applyDsnLayerWidthRules({ ...snapshot(), sourceUnit: 'mm' }, fixture)
assert.equal(repairedWithMmDisplayMarker.text, repaired.text, 'mm is retained as the design-rule display marker while DSN widths continue to use raw mil values')
assert.deepEqual(repairedWithMmDisplayMarker.changes, repaired.changes, 'accepting an mm display marker does not convert raw mil values twice')
assert.equal(repaired.changed, true)
assert.equal(repaired.warnings.length, 0)
assert.equal(repaired.changes.length, 3)
assert.deepEqual(repaired.changes.filter(change => change.kind === 'default-layer-width').map(change => ({ layer: change.layer, from: change.from, to: change.to })), [
	{ layer: 'BottomLayer', from: '15 mil', to: '25 mil' },
])
assert.equal(Object.keys(repaired.changes.find(change => change.kind === 'default-layer-width')).sort().join(','), 'from,kind,layer,line,to', 'default-layer change does not invent numeric or net/class fields')
assert.deepEqual(repaired.changes.filter(change => change.kind === 'layer-width').map(change => ({ kind: change.kind, net: change.net, className: change.className, layerId: change.layerId, layerName: change.layerName, fromWidthMil: change.fromWidthMil, toWidthMil: change.toWidthMil })), [
	{ kind: 'layer-width', net: 'TopNet', className: 'TopClass', layerId: 2, layerName: 'BottomLayer', fromWidthMil: 20, toWidthMil: 30 },
	{ kind: 'layer-width', net: 'BottomNet', className: 'BottomClass', layerId: 2, layerName: 'BottomLayer', fromWidthMil: 20, toWidthMil: 30 },
])
assert.match(repaired.text, /\(class TopClass TopNet \(circuit \(use_via via0\)\) \(rule \(width 20\) \(clearance 4\)\) \(layer_rule BottomLayer \(rule \(width 30\)\)\)\)/)
assert.match(repaired.text, /; keep comments, quote delimiters, and original whitespace/)
assert.match(repaired.text, /\(string_quote "\)/)
assert.equal(repaired.text.replaceAll(' (layer_rule BottomLayer (rule (width 30)))', '').replace(' (rule (width 25))', ''), fixture, 'only layer-local insertions change the original DSN bytes')
for (const editorVersion of ['4.1.93', '9.9.9', '']) {
	assert.deepEqual(applyDsnLayerWidthRules({ ...snapshot(), editorVersion }, fixture), repaired, `DSN conversion is independent of diagnostic editorVersion ${JSON.stringify(editorVersion)}`)
}
const repeated = applyDsnLayerWidthRules(snapshot(), repaired.text)
assert.equal(repeated.changed, false, 'an exact existing class layer_rule is idempotent')
assert.equal(repeated.text, repaired.text)

const fourSnapshot = () => {
	const value = snapshot()
	value.defaultRule = { ...value.defaultRule, layers: [
		{ layerId: 1, name: 'Top Layer', minMil: 10, preferredMil: 15, maxMil: 30, status: 'known' },
		{ layerId: 15, name: 'Inner1', minMil: 10, preferredMil: 27, maxMil: 30, status: 'known' },
		{ layerId: 16, name: 'Inner2', minMil: 10, preferredMil: 27, maxMil: 30, status: 'known' },
		{ layerId: 2, name: 'Bottom Layer', minMil: 20, preferredMil: 27, maxMil: 40, status: 'known' },
	] }
	value.nets = value.nets.map(net => ({ ...net, layers: [
		{ layerId: 1, name: 'Top Layer', minMil: 10, preferredMil: 20, maxMil: 35, status: 'known' },
		{ layerId: 15, name: 'Inner1', minMil: 10, preferredMil: 20, maxMil: 35, status: 'known' },
		{ layerId: 16, name: 'Inner2', minMil: 10, preferredMil: 20, maxMil: 35, status: 'known' },
		{ layerId: 2, name: 'Bottom Layer', minMil: 20, preferredMil: 30, maxMil: 45, status: 'known' },
	] }))
	return value
}
const fourFixture = fixture
	.replace('(resolution mil 1000)', '(resolution mil 1000)')
	.replace('(layer TopLayer (type signal))', '(layer TopLayer (type signal))\n    (layer Inner1 (type signal))\n    (layer Inner2 (type signal))')
	.replace('(rule (width 15))', '(rule (clearance 6))\n    (rule (width 15.05))\n    (rule (clearance 8 (type default_smd)))')
const fourLayerResult = applyDsnLayerWidthRules(fourSnapshot(), fourFixture)
assert.equal(fourLayerResult.changes.filter(change => change.kind === 'default-layer-width').length, 4)
assert.equal(fourLayerResult.changes.filter(change => change.kind === 'layer-width').length, 2)
assert.deepEqual(fourLayerResult.changes.filter(change => change.kind === 'default-layer-width').map(change => [change.layer, change.from, change.to]), [
	['TopLayer', '15.05 mil', '15 mil'], ['Inner1', '15.05 mil', '27 mil'], ['Inner2', '15.05 mil', '27 mil'], ['BottomLayer', '15.05 mil', '27 mil'],
])
assert.equal(fourLayerResult.text.includes('(layer_rule TopLayer'), false, 'default layer rules use the structure layer scope')
assert.equal(applyDsnLayerWidthRules(fourSnapshot(), fourLayerResult.text).changed, false, 'default and class layer insertions are idempotent')
const noBaseFixture = fixture.replace('(rule (width 15))', '')
const noBaseResult = applyDsnLayerWidthRules(snapshot(), noBaseFixture)
assert.deepEqual(noBaseResult.changes.filter(change => change.kind === 'default-layer-width').map(change => [change.layer, change.from, change.to]), [
	['TopLayer', '未提供structure base width', '15 mil'], ['BottomLayer', '未提供structure base width', '25 mil'],
], 'a complete SDK layer snapshot emits explicit defaults when DSN has no structure base')
assert.match(noBaseResult.text, /\(layer TopLayer \(type signal\) \(rule \(width 15\)\)\)/)
assert.match(noBaseResult.text, /\(layer BottomLayer \(type signal\) \(rule \(width 25\)\)\)/)
assert.match(noBaseResult.text, /\(class TopClass TopNet[^\n]*\(layer_rule BottomLayer \(rule \(width 30\)\)\)/, 'class width keeps priority with no structure base')
assert.equal(applyDsnLayerWidthRules(snapshot(), noBaseResult.text).changed, false, 'fully explicit no-base layer rules are idempotent')
assert.throws(() => applyDsnLayerWidthRules(snapshot(), noBaseFixture.replace('(layer BottomLayer (type signal))', '')), undefined, 'a no-base DSN missing an enabled signal layer remains rejected')
assert.throws(() => applyDsnLayerWidthRules(snapshot(), noBaseFixture.replace('(layer BottomLayer (type signal))', '(layer BottomLayer (type signal) (rule (width 24)))')), undefined, 'a conflicting existing no-base layer width remains rejected')
assert.throws(() => applyDsnLayerWidthRules(snapshot(), noBaseFixture.replace('(layer BottomLayer (type signal))', '(layer BottomLayer (type signal) (rule (width 25)) (rule (width 25))')), undefined, 'duplicate existing no-base layer widths remain rejected')
const classClearanceFixture = fixture.replace('(rule (width 20) (clearance 4)))\n    (class BottomClass', '(rule (width 20) (clearance 4)) (layer_rule BottomLayer (rule (width 30) (clearance 6))))\n    (class BottomClass')
const classClearanceResult = applyDsnLayerWidthRules(snapshot(), classClearanceFixture)
assert.equal(classClearanceResult.changes.filter(change => change.kind === 'layer-width').length, 1, 'an existing class layer width with valid clearance is retained')
assert.match(classClearanceResult.text, /\(layer_rule BottomLayer \(rule \(width 30\) \(clearance 6\)\)\)/)

const nativeFixture = fixture
	.replace('(net TopNet (pins U1-1 U2-1))', '(net +5V (pins U1-1 U2-1))')
	.replace('(net BottomNet (pins U3-1 U4-1))\n', '')
	.replace('(class TopClass TopNet', '(class +5V "+5V"')
	.replace(/    \(class BottomClass[^\n]*\n/, '')
const nativeSnapshot = { ...snapshot(), nets: snapshot().nets.slice(0, 1).map(net => ({ ...net, net: '+5V' })) }
const nativeResult = applyDsnLayerWidthRules(nativeSnapshot, nativeFixture)
assert.equal(nativeResult.changes.filter(change => change.kind === 'layer-width').length, 1, 'native class name plus quoted net member is accepted')
assert.equal(nativeResult.changes.find(change => change.kind === 'layer-width').net, '+5V')

function rejected(label, modifyDsn = text => text, modifySnapshot = value => value) {
	assert.throws(() => applyDsnLayerWidthRules(modifySnapshot(snapshot()), modifyDsn(fixture)), undefined, label)
}
rejected('wrong DSN resolution', text => text.replace('(resolution mil 1000)', '(resolution mil 500)'))
rejected('wrong DSN unit', text => text.replace('(resolution mil 1000)', '(resolution mm 1000)'))
rejected('invalid structure base width', text => text.replace('(rule (width 15))', '(rule (width 0))'))
rejected('multiple structure base widths', text => text.replace('(rule (width 15))', '(rule (width 15)) (rule (width 16))'))
rejected('unknown source unit', text => text, value => ({ ...value, sourceUnit: 'inch' }))
rejected('unknown global evidence', text => text, value => ({ ...value, globalStatus: 'unknown' }))
rejected('unknown target net', text => text, value => ({ ...value, nets: value.nets.map(net => net.net === 'TopNet' ? { ...net, status: 'unknown' } : net) }))
rejected('unknown layer preference', text => text, value => ({ ...value, nets: value.nets.map(net => net.net === 'TopNet' ? { ...net, layers: net.layers.map(layer => layer.layerId === 2 ? { ...layer, status: 'unknown' } : layer) } : net) }))
rejected('ambiguous layer mapping', text => text, value => ({ ...value, defaultRule: { ...value.defaultRule, layers: [...value.defaultRule.layers, { ...value.defaultRule.layers[1], name: 'Bottom duplicate' }] } }))
rejected('unmapped DSN copper layer', text => text.replace('(layer BottomLayer (type signal))', '(layer MidLayer (type signal))'))
rejected('duplicate DSN copper layer', text => text.replace('(layer BottomLayer (type signal))', '(layer TopLayer (type signal))'))
rejected('extra DSN signal layer', text => text.replace('(layer TopLayer (type signal))', '(layer TopLayer (type signal))\n    (layer Inner1 (type signal))'))
rejected('unowned target net', text => text.replace('(class BottomClass BottomNet', '(class BottomClass OtherNet'))
rejected('class with multiple members', text => text.replace('TopNet (circuit', 'TopNet BottomNet (circuit'))
rejected('net-scoped override', text => text.replace('(net BottomNet (pins U3-1 U4-1))', '(net BottomNet (pins U3-1 U4-1) (rule (width 21)))'))
rejected('structure layer override', text => text.replace('(layer BottomLayer (type signal))', '(layer BottomLayer (type signal) (rule (width 21)))'))
rejected('conflicting existing class layer_rule', text => text.replace('(rule (width 20) (clearance 4)))\n    (class BottomClass', '(rule (width 20) (clearance 4)) (layer_rule BottomLayer (rule (width 31))))\n    (class BottomClass'))
rejected('duplicate existing class layer_rule', text => text.replace('(rule (width 20) (clearance 4)))\n    (class BottomClass', '(rule (width 20) (clearance 4)) (layer_rule BottomLayer (rule (width 30))) (layer_rule BottomLayer (rule (width 30))))\n    (class BottomClass'))
rejected('unsupported layer rule field', text => text.replace('(layer BottomLayer (type signal))', '(layer BottomLayer (type signal))').replace('(rule (width 20) (clearance 4)))\n    (class BottomClass', '(rule (width 20) (clearance 4)) (layer_rule BottomLayer (rule (width 30) (unknown 1))))\n    (class BottomClass'))
rejected('default preferred equal to base still rejects conflicting existing layer rule', text => text.replace('(layer TopLayer (type signal))', '(layer TopLayer (type signal) (rule (width 16)))'))
rejected('duplicate default layer rules', text => text.replace('(layer TopLayer (type signal))', '(layer TopLayer (type signal) (rule (width 15)) (rule (width 15))'))
rejected('duplicate default width fields', text => text.replace('(layer TopLayer (type signal))', '(layer TopLayer (type signal) (rule (width 15) (width 15))'))
rejected('unknown default width field', text => text.replace('(layer TopLayer (type signal))', '(layer TopLayer (type signal) (rule (width 15) (extra 1))'))
rejected('non-positive default width', text => text.replace('(layer TopLayer (type signal))', '(layer TopLayer (type signal) (rule (width 0))'))
rejected('non-signal structure layer override', text => text.replace('(layer BottomLayer (type signal))', '(layer BottomLayer (type signal))\n    (layer MysteryPlane (type power) (rule (width 99)))'))
rejected('class precheck failure rejects all planned default changes', text => text.replace('(rule (width 20) (clearance 4)))\n    (class BottomClass', '(rule (width 20) (clearance 4)) (layer_rule BottomLayer (rule (width 31))))\n    (class BottomClass'))

const manifest = JSON.parse(readFileSync(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'))
const readFixture = name => {
	const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
	const entry = manifest.entries.find(item => item.fixture === name)
	assert.ok(entry, `${name} is registered in fixture manifest`)
	assert.equal(bytes.length, entry.bytes, `${name} fixture byte count matches manifest`)
	assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.fixtureSha256, `${name} fixture hash matches manifest`)
	return JSON.parse(bytes.toString('utf8'))
}
const hostDiffPair = readFixture('host-differential-empty-pair-selector.json')
const hostDiffPairSnapshot = buildRoutingWidthSnapshot({ source: hostDiffPair.source, layers: hostDiffPair.layers, netRules: hostDiffPair.netRules })
assert.equal(hostDiffPairSnapshot.globalStatus, 'known', JSON.stringify(hostDiffPairSnapshot.unknowns))
assert.deepEqual(hostDiffPairSnapshot.defaultRule.layers.map(layer => [layer.layerId, layer.minMil, layer.preferredMil, layer.maxMil]), [[1, 5, 10, 100], [2, 5, 10, 100]])
assert.ok(hostDiffPairSnapshot.nets.every(net => net.status === 'known'))
assert.ok(hostDiffPairSnapshot.nets.every(net => net.layers.map(layer => [layer.layerId, layer.minMil, layer.preferredMil, layer.maxMil]).every((bounds, index) => JSON.stringify(bounds) === JSON.stringify([[1, 5, 10, 100], [2, 5, 10, 100]][index]))))
assert.deepEqual(checkSesWidthRules(hostDiffPairSnapshot, [{ net: hostDiffPairSnapshot.nets[0].net, layer: 1, widthMil: 101 }]).status, 'violation', 'the confirmed empty DIFF_PAIR selector does not weaken existing out-of-range SES checks')
const mutateSourceRecord = (source, type, predicate, transform) => source.split(/\r?\n/).map(line => {
	const split = line.indexOf('||'); if (split < 0) return line
	try {
		const header = JSON.parse(line.slice(0, split)); const data = JSON.parse(line.slice(split + 2).replace(/\|$/, ''))
		if (header.type !== type || !predicate(header, data)) return line
		return `${JSON.stringify(header)}||${JSON.stringify(transform(data, header))}|`
	} catch { return line }
}).join('\n')
const diffSelector = (header, data) => {
	if (header.type !== 'RULE_SELECTOR') return false
	try { const id = JSON.parse(header.id); return id[0] === 'RULE_SELECTOR' && id[1]?.[0] === 'DIFF_PAIR' } catch { return false }
}
const expectDiffPairUnknown = (label, source) => {
	const result = buildRoutingWidthSnapshot({ source, layers: hostDiffPair.layers, netRules: hostDiffPair.netRules })
	assert.equal(result.globalStatus, 'unknown', `${label}: ${JSON.stringify(result.unknowns)}`)
}
for (const [label, transform] of [
	['nonempty TRACK override', data => ({ ...data, ruleKeyValue: { TRACK: 'customTrack' } })],
	['nonempty copper override', data => ({ ...data, copperValue: { TRACK: 10 } })],
	['nonempty inner-plane override', data => ({ ...data, innerPlaneValue: { TRACK: 10 } })],
	['missing required field', data => { const { innerPlaneValue, ...rest } = data; return rest }],
	['extra field', data => ({ ...data, note: 'unexpected' })],
	['wrong order', data => ({ ...data, ruleOrder: 5 })],
	['unexpected parent', data => ({ ...data, parent: 'parent' })],
]) expectDiffPairUnknown(label, mutateSourceRecord(hostDiffPair.source, 'RULE_SELECTOR', diffSelector, transform))
expectDiffPairUnknown('missing pair NET membership', mutateSourceRecord(hostDiffPair.source, 'NET', (_, data) => data.differentialName === 'ACE_TEST_PAIR', data => ({ ...data, differentialName: null })))
expectDiffPairUnknown('duplicate polarity', mutateSourceRecord(hostDiffPair.source, 'NET', (_, data) => data.differentialName === 'ACE_TEST_PAIR', data => ({ ...data, isPositiveNet: true })))
expectDiffPairUnknown('no positive polarity', mutateSourceRecord(hostDiffPair.source, 'NET', (_, data) => data.differentialName === 'ACE_TEST_PAIR', data => ({ ...data, isPositiveNet: false })))
expectDiffPairUnknown('third pair member', `${hostDiffPair.source}\n${JSON.stringify({ type: 'NET', ticket: 999, id: '["NET","EXTRA_PAIR_NET"]' })}||${JSON.stringify({ differentialName: 'ACE_TEST_PAIR', isPositiveNet: true })}|`)
expectDiffPairUnknown('duplicate semantic selector', `${hostDiffPair.source}\n${JSON.stringify({ type: 'RULE_SELECTOR', ticket: 999, id: '["RULE_SELECTOR", ["DIFF_PAIR", "ACE_TEST_PAIR"]]' })}||${JSON.stringify({ ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null })}|`)
const sameTicketPairSelectorLine = hostDiffPair.source.split(/\r?\n/).find(line => {
	const split = line.indexOf('||'); if (split < 0) return false
	try {
		const header = JSON.parse(line.slice(0, split))
		const id = typeof header.id === 'string' ? JSON.parse(header.id) : []
		return header.type === 'RULE_SELECTOR' && id[0] === 'RULE_SELECTOR' && id[1]?.[0] === 'DIFF_PAIR' && id[1]?.[1] === 'ACE_TEST_PAIR'
	} catch { return false }
})
assert.ok(sameTicketPairSelectorLine, 'same-ticket conflict fixture locates the real DIFF_PAIR selector line')
expectDiffPairUnknown('unresolved same-ticket selector history', `${hostDiffPair.source}\n${sameTicketPairSelectorLine}`)

const core0219 = readFixture('installed-0219-multilayer-widths.json')
const core0219Snapshot = buildRoutingWidthSnapshot({ source: core0219.source, editorVersion: core0219.editorVersion, layers: core0219.layers, netRules: core0219.netRules })
assert.equal(core0219Snapshot.sourceUnit, 'mm')
assert.deepEqual(core0219Snapshot.defaultRule.layers.map(layer => [layer.layerId, layer.minMil, layer.preferredMil, layer.maxMil]), [[1, 10, 20, 60], [2, 15, 26, 35]])
assert.equal(core0219Snapshot.defaultRule.status, 'known')
assert.equal(core0219Snapshot.globalStatus, 'known', 'the empty DIFF_PAIR selector is ignored after strict source proof')
assert.ok(core0219Snapshot.unknowns.some(reason => reason.includes('CFG_WIDTH_CLASS') && reason.includes('TRACK继承')))
assert.equal(core0219Snapshot.nets.find(net => net.net === 'CFG_TMIN')?.status, 'unknown', 'unproven NET_CLASS TRACK inheritance remains unknown')
assert.ok(core0219Snapshot.nets.filter(net => net.net !== 'CFG_TMIN').every(net => net.status === 'known'))
assert.throws(() => applyDsnLayerWidthRules(core0219Snapshot, core0219.rawDsn), /CFG_TMIN|网络/, 'Core DSN rewriting stays blocked by the concrete unresolved NET_CLASS inheritance')

const concave0219 = readFixture('installed-0219-concave-widths.json')
const concave0219Snapshot = buildRoutingWidthSnapshot({ source: concave0219.source, editorVersion: concave0219.editorVersion, layers: concave0219.layers, netRules: concave0219.netRules })
assert.equal(concave0219Snapshot.sourceUnit, 'mm')
assert.equal(concave0219Snapshot.globalStatus, 'known', JSON.stringify(concave0219Snapshot.unknowns))
assert.deepEqual(concave0219Snapshot.defaultRule.layers.map(layer => [layer.layerId, layer.minMil, layer.preferredMil, layer.maxMil]), [[1, 5, 10, 100], [2, 5, 10, 100]])
assert.ok(concave0219Snapshot.nets.every(net => net.status === 'known'))
const concave0219Repair = applyDsnLayerWidthRules(concave0219Snapshot, concave0219.rawDsn)
assert.equal(concave0219Repair.changed, true)
assert.match(concave0219Repair.text, /layer TopLayer[\s\S]{0,100}\(rule \(width 10\)\)/)
assert.match(concave0219Repair.text, /layer BottomLayer[\s\S]{0,100}\(rule \(width 10\)\)/)
const concave0219Restored = concave0219Repair.text
	.replaceAll('(type signal)\n     (rule (width 10)))', '(type signal)\n    )')
assert.equal(concave0219Restored, concave0219.rawDsn, 'removing only the two default layer insertions recovers every original DSN byte')
assert.ok(concave0219Repair.changes.every(change => change.kind === 'default-layer-width'), 'only the mismatching DSN default layer widths are corrected')
assert.deepEqual(concave0219Repair.changes.map(change => [change.layer, change.from, change.to]), [
	['TopLayer', '10.05 mil', '10 mil'], ['BottomLayer', '10.05 mil', '10 mil'],
])
const concave0219Comparison = compareDsnWidthRules(concave0219Snapshot, concave0219Repair.text)
assert.equal(concave0219Comparison.status, 'matched', JSON.stringify(concave0219Comparison))
assert.equal(concave0219Comparison.defaultRule.dsnWidthMil, 10)
assert.equal(concave0219Comparison.defaultRule.eda?.preferredMil, 10)
assert.deepEqual(concave0219Comparison.unknowns, [], 'the unrelated captured concave-board comparison has no unknowns')
assert.equal(applyDsnLayerWidthRules(concave0219Snapshot, concave0219Repair.text).changed, false, 'real mm-marked DSN repair is idempotent')
console.log('dsn-layer-widths regression: PASS')
