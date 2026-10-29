import assert from 'node:assert/strict'
import { register } from 'node:module'

const loader = `export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith('.') && !/\\.(?:ts|js|mjs|json)$/.test(specifier)) {
		try { return await nextResolve(specifier + '.ts', context) } catch {}
	}
	return nextResolve(specifier, context)
}`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)
const [{ applyDsnLayerWidthRules }, { resolveDsnLayerId, dsnLayerNameMatchesSdk }] = await Promise.all([
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
rejected('wrong source unit', text => text, value => ({ ...value, sourceUnit: 'mm' }))
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
console.log('dsn-layer-widths regression: PASS')
