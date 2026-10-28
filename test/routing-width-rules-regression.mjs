import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildRoutingWidthSnapshot, checkSesWidthRules, compareDsnWidthRules } from '../src/engine/routingWidthRules.ts';

const record = (type, id, data, ticket) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`;
const selectorId = (scope, name) => JSON.stringify(['RULE_SELECTOR', [scope, name]]);
const src = [
	'{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"fixture"}|',
	record('RULE', '["RULE","TRACK","default"]', { ruleState: 'DEFAULT', ruleContext: { unit: 'mm', track: { isOpen: true, content: [{ layerId: 1, stroMin: 5, stroDef: 10, stroMax: 100 }] } } }, 1),
	record('RULE', '["RULE","TRACK","POWER20"]', { ruleState: 'NORMAL', ruleContext: { unit: 'mm', track: { isOpen: true, content: [{ layerId: 1, stroMin: 5, stroDef: 20, stroMax: 100 }] } } }, 2),
	record('NET', '["NET","+5V"]', { netType: null }, 3),
	record('NET', '["NET","GND"]', { netType: null }, 4),
	record('RULE_SELECTOR', '["RULE_SELECTOR",["NET","+5V"]]', { ruleOrder: 4, ruleKeyValue: { TRACK: 'POWER20' }, parent: null }, 5),
].join('\n');
const layers = [{ layerId: 1, type: 'SIGNAL', status: 1, layerName: 'Top Layer' }, { layerId: 2, type: 'SIGNAL', status: 2, layerName: 'Bottom Layer' }, { layerId: 12, type: 'OTHER', status: 1, layerName: 'Multi-Layer' }];
const dsn = (unit = 'mil') => `(PCB x (resolution ${unit} 1000) (structure (rule (width ${unit === 'mil' ? '10.05' : '0.25527'}))) (network (net +5V) (net GND) (class +5V "+5V" (rule (width ${unit === 'mil' ? '20' : '0.508'}))) (class GND GND (rule (width ${unit === 'mil' ? '10' : '0.254'})))) )`;
const trackRow = (preferredMil, overrides = {}) => ({ layerId: 1, stroMin: 5, stroDef: preferredMil, stroMax: 100, ...overrides });
const fullLayers = [
	{ layerId: 1, id: 1, type: 'SIGNAL', status: 1, layerName: 'Top Layer' },
	{ layerId: 15, id: 15, type: 'SIGNAL', status: 1, layerName: 'Inner Layer 1' },
	{ layerId: 16, id: 16, type: 'SIGNAL', status: 1, layerName: 'Inner Layer 2' },
	{ layerId: 2, id: 2, type: 'SIGNAL', status: 2, layerName: 'Bottom Layer' },
];
const fourRows = (bounds = [[25, 30, 35], [5, 15, 100], [5, 15, 100], [5, 15, 100]]) => bounds.map(([stroMin, stroDef, stroMax], index) => ({ layerId: fullLayers[index].layerId, stroMin, stroDef, stroMax }));
const trackSelector = (track) => ({ ruleOrder: 4, ruleKeyValue: { TRACK: track }, copperValue: {}, innerPlaneValue: {}, parent: null });
function explicitClassInput(options = {}) {
	const netName = options.netName ?? '+5V';
	const className = options.className ?? 'ACE_TEST_CLASS';
	const netTrack = options.netTrack ?? 'ACE_POWER20';
	const classTrack = options.classTrack ?? 'ACE_CLASS30';
	const sdkNetTrack = options.sdkNetTrack ?? netTrack;
	const sdkClassTrack = options.sdkClassTrack ?? classTrack;
	const classRow = { type: 'netClass', name: className, Track: sdkClassTrack, sub: [
		{ type: 'net', name: netName, Track: sdkNetTrack },
		{ type: 'net', name: 'ACE_VIA', Track: 'default' },
	] };
	return {
		source: [
			'{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"class-fixture"}|',
			record('RULE', '["RULE","TRACK","default"]', { ruleState: options.defaultRuleState ?? 'DEFAULT', ruleContext: { unit: options.defaultUnit ?? 'mil', track: { isOpen: options.defaultOpen ?? true, content: options.defaultRuleRows ?? [trackRow(10)] } } }, 1),
			record('RULE', '["RULE","TRACK","ACE_POWER20"]', { ruleState: options.netRuleState ?? 'NORMAL', ruleContext: { unit: options.netRuleUnit ?? 'mil', track: { isOpen: options.netRuleOpen ?? true, content: options.netRuleRows ?? [trackRow(20)] } } }, 2),
			record('RULE', '["RULE","TRACK","ACE_CLASS30"]', { ruleState: options.classRuleState ?? 'NORMAL', ruleContext: { unit: options.classRuleUnit ?? 'mil', track: { isOpen: true, content: options.classRuleRows ?? [trackRow(30)] } } }, 3),
			record('NET', JSON.stringify(['NET', netName]), { netType: options.netType === undefined ? className : options.netType }, 4),
			record('NET', '["NET","ACE_VIA"]', { netType: className }, 5),
			record('RULE_SELECTOR', options.classSelectorId ?? JSON.stringify(['RULE_SELECTOR', ['NET_CLASS', className]]), options.classSelector ?? trackSelector(classTrack), 6),
			record('RULE_SELECTOR', options.netSelectorId ?? JSON.stringify(['RULE_SELECTOR', ['NET', netName]]), options.netSelector ?? trackSelector(netTrack), 7),
			record('RULE_SELECTOR', '["RULE_SELECTOR",["NET","ACE_VIA"]]', { ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null }, 8),
			...(options.extraSourceRecords ?? []),
		].join('\n'),
		editorVersion: options.editorVersion ?? '4.1.78',
		layers: options.layers ?? layers,
		netRules: options.netRules ?? [classRow],
	};
}
const emptyNetSelector = () => ({ ruleOrder: 4, ruleKeyValue: {}, copperValue: {}, innerPlaneValue: {}, parent: null });
const emptyNetSelectorInput = (options = {}) => explicitClassInput({
	netName: 'SYN_DEFAULT_NET', netTrack: 'default', sdkNetTrack: 'default', netSelector: emptyNetSelector(), ...options,
});
const safeTrackRows = () => Array.from({ length: 13 }, (_, row) => Array.from({ length: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11, 12][row] }, () => 6));
const safeTrackRule = (name = 'SAFE_PROFILE') => ({ ruleState: 'NORMAL', ruleContext: {
	unit: 'mil', isForAll: 'ALL', safeSpacing: [{ layerId: 1, isOpen: true, content: safeTrackRows(), columnNames: [] }],
} });
function safeTrackInput(options = {}) {
	const netName = options.netName ?? 'SAFE_TRACK_NET';
	const safeName = options.safeName ?? 'SAFE_PROFILE';
	const trackName = options.trackName ?? 'ACE_POWER20';
	const base = explicitClassInput({ ...options, netName, netType: options.unclassed ? null : options.netType, netTrack: options.netTrack ?? trackName, sdkNetTrack: options.sdkNetTrack ?? trackName });
	const mixedSelector = { ruleOrder: 4, ruleKeyValue: { SAFE: safeName, TRACK: trackName }, copperValue: {}, innerPlaneValue: {}, parent: null, ...options.selector };
	const selector = record('RULE_SELECTOR', selectorId('NET', netName), mixedSelector, 9);
	base.source = `${base.source}${options.omitSafe ? '' : `\n${record('RULE', JSON.stringify(['RULE', 'SAFE', safeName]), options.safeRule ?? safeTrackRule(safeName), options.safeTicket ?? 10)}`}${options.safeHistoryRecords?.length ? `\n${options.safeHistoryRecords.join('\n')}` : ''}\n${selector}`;
	const row = { type: 'net', name: netName, Track: options.sdkTrack ?? trackName, 'Safe Spacing': options.sdkSafeSpacing ?? safeName };
	if (options.omitSdkSafeSpacing)
		delete row['Safe Spacing'];
	base.netRules = options.unclassed ? [row] : [{ type: 'netClass', name: 'ACE_TEST_CLASS', Track: 'ACE_CLASS30', sub: [row] }];
	if (options.duplicateSdkNet)
		(options.unclassed ? base.netRules : base.netRules[0].sub).push({ ...row });
	if (options.extraSelector)
		base.source += `\n${record('RULE_SELECTOR', selectorId('NET', `${netName}_EXTRA`), mixedSelector, 11)}`;
	if (options.duplicateSelector)
		base.source += `\n${record('RULE_SELECTOR', `[\"RULE_SELECTOR\", [\"NET\", ${JSON.stringify(netName)}]]`, mixedSelector, 11)}`;
	return base;
}
function safeClassTrackInput(options = {}) {
	const netName = options.netName ?? '+5V';
	const className = options.className ?? 'ACE_TEST_CLASS';
	const safeName = options.safeName ?? 'CLASS_SAFE_PROFILE';
	const netSafeName = options.netSafeName ?? options.netSelector?.ruleKeyValue?.SAFE ?? safeName;
	const mixedClassSelector = {
		ruleOrder: 4, ruleKeyValue: { SAFE: safeName, TRACK: options.classTrack ?? 'ACE_CLASS30' },
		copperValue: {}, innerPlaneValue: {}, parent: null, ...options.classSelector,
	};
	const base = explicitClassInput({
		...options, netName, className, netTrack: 'ACE_POWER20', sdkNetTrack: options.sdkNetTrack ?? 'ACE_POWER20',
		classTrack: 'ACE_CLASS30', sdkClassTrack: 'ACE_CLASS30', classSelector: mixedClassSelector,
		layers: options.layers ?? fullLayers,
		netRuleRows: options.netRuleRows ?? fourRows([[5, 20, 100], [5, 20, 100], [5, 20, 100], [25, 30, 35]]),
		classRuleRows: options.classRuleRows ?? fourRows([[25, 30, 35], [5, 30, 100], [5, 30, 100], [5, 30, 100]]),
	});
	base.source += `\n${record('RULE', JSON.stringify(['RULE', 'SAFE', safeName]), options.safeRule ?? safeTrackRule(safeName), options.safeTicket ?? 10)}${options.safeHistoryRecords?.length ? `\n${options.safeHistoryRecords.join('\n')}` : ''}`;
	if (options.netSelector?.ruleKeyValue && typeof options.netSelector.ruleKeyValue.SAFE === 'string' && options.netSelector.ruleKeyValue.SAFE !== safeName)
		base.source += `\n${record('RULE', JSON.stringify(['RULE', 'SAFE', options.netSelector.ruleKeyValue.SAFE]), safeTrackRule(options.netSelector.ruleKeyValue.SAFE), 11)}${options.netSafeHistoryRecords?.length ? `\n${options.netSafeHistoryRecords.join('\n')}` : ''}`;
	const classRow = {
		type: 'netClass', name: className, Track: options.sdkClassTrack ?? 'ACE_CLASS30',
		...(options.omitSdkClassSafe ? {} : { 'Safe Spacing': options.sdkClassSafeSpacing ?? safeName }),
		sub: [
			{ type: 'net', name: netName, Track: options.sdkNetTrack ?? 'ACE_POWER20', 'Safe Spacing': options.sdkNetSafeSpacing ?? (options.netSelector?.ruleKeyValue?.SAFE ? netSafeName : 'default') },
			{ type: 'net', name: 'ACE_VIA', Track: 'ACE_POWER20', 'Safe Spacing': 'default' },
		],
	};
	base.netRules = [classRow];
	if (options.duplicateSdkClass)
		base.netRules.push({ ...classRow });
	return base;
}
const snapshot = buildRoutingWidthSnapshot({ source: src, editorVersion: '4.1.78', layers });
const assertClassUnknown = (input, net = '+5V') => {
	const result = buildRoutingWidthSnapshot(input);
	assert.equal(result.nets.find(item => item.net === net)?.status, 'unknown');
	return result;
};
assert.equal(snapshot.defaultRule.status, 'known');
assert.equal(snapshot.defaultRule.minMil, 5);
assert.equal(snapshot.defaultRule.maxMil, 100);
assert.equal(snapshot.defaultRule.layers.length, 2, 'single public row maps to all enabled signal layers under the 4.1.78 profile');
assert.equal(snapshot.globalStatus, 'known');
assert.equal(snapshot.routingConstraintsComplete, false);
assert.equal(snapshot.nets.find(n => n.net === '+5V').layers[0].preferredMil, 20);
assert.equal(snapshot.nets.find(n => n.net === 'GND').layers[0].preferredMil, 10);

const safeTrackSnapshot = buildRoutingWidthSnapshot(safeTrackInput());
assert.equal(safeTrackSnapshot.nets.find(net => net.net === 'SAFE_TRACK_NET').status, 'known', 'the observed SAFE+TRACK NET selector profile binds only with matching unique source and SDK evidence');
assert.equal(safeTrackSnapshot.nets.find(net => net.net === 'SAFE_TRACK_NET').ruleKey, 'ACE_POWER20');
const safeTrackFourLayerInput = safeTrackInput({
	layers: fullLayers,
	netRuleRows: fourRows([[5, 20, 100], [5, 20, 100], [5, 20, 100], [25, 30, 35]]),
});
const safeTrackFourLayer = buildRoutingWidthSnapshot(safeTrackFourLayerInput);
const safeTrackFourLayerNet = safeTrackFourLayer.nets.find(net => net.net === 'SAFE_TRACK_NET');
assert.equal(safeTrackFourLayerNet.status, 'known', 'SAFE+TRACK multi-layer NET binding is confirmed through the same selected rule identity');
assert.deepEqual(safeTrackFourLayerNet.layers.map(({ layerId, minMil, preferredMil, maxMil }) => [layerId, minMil, preferredMil, maxMil]), [
	[1, 5, 20, 100], [15, 5, 20, 100], [16, 5, 20, 100], [2, 25, 30, 35],
]);
const safeTrackFourLayerSdkConflict = buildRoutingWidthSnapshot(safeTrackInput({
	layers: fullLayers,
	netRuleRows: fourRows([[5, 20, 100], [5, 20, 100], [5, 20, 100], [25, 30, 35]]),
	sdkSafeSpacing: 'CONFLICTING_SAFE',
}));
assert.equal(safeTrackFourLayerSdkConflict.nets.find(net => net.net === 'SAFE_TRACK_NET').status, 'unknown', 'four-layer SAFE+TRACK SDK Safe Spacing conflict remains unknown');
const safeHistoryRows = fourRows([[5, 20, 100], [5, 20, 100], [5, 20, 100], [25, 30, 35]]);
const safeId = '["RULE","SAFE","SAFE_PROFILE"]';
const safeHistoryKnown = (safeTicket, history) => buildRoutingWidthSnapshot(safeTrackInput({
	layers: fullLayers, netRuleRows: safeHistoryRows, safeTicket, safeHistoryRecords: history,
})).nets.find(net => net.net === 'SAFE_TRACK_NET');
const assertSafeHistoryKnown = (net, label) => {
	assert.equal(net.status, 'known', label);
	assert.deepEqual(net.layers.map(({ layerId, minMil, preferredMil, maxMil }) => [layerId, minMil, preferredMil, maxMil]), [
		[1, 5, 20, 100], [15, 5, 20, 100], [16, 5, 20, 100], [2, 25, 30, 35],
	]);
};
assertSafeHistoryKnown(safeHistoryKnown(10, [record('RULE', safeId, safeTrackRule(), 20)]), 'SAFE history resolves ticket 10 to ticket 20');
assertSafeHistoryKnown(safeHistoryKnown(20, [record('RULE', safeId, safeTrackRule(), 10)]), 'SAFE history chooses the maximum ticket independent of source order');
assertSafeHistoryKnown(safeHistoryKnown(10, [record('RULE', safeId, '', 20), record('RULE', safeId, safeTrackRule(), 30)]), 'a valid rebuild after an earlier deletion resolves');
assertSafeHistoryKnown(safeHistoryKnown(20, [record('RULE', safeId, { ruleState: 'BROKEN' }, 10)]), 'an older profile-invalid SAFE record does not block the valid latest record');
assert.equal(safeHistoryKnown(10, [record('RULE', safeId, '', 20)]).status, 'unknown', 'the latest SAFE deletion does not fall back to an older entity');
assert.equal(safeHistoryKnown(10, [record('RULE', safeId, '', 20), record('RULE', safeId, { ruleState: 'NORMAL' }, 30)]).status, 'unknown', 'a profile-invalid SAFE rebuild does not fall back');
assert.equal(safeHistoryKnown(5, [record('RULE', safeId, safeTrackRule(), 10), record('RULE', safeId, safeTrackRule(), 10), record('RULE', safeId, safeTrackRule(), 20)]).status, 'unknown', 'duplicate earlier SAFE ticket remains ambiguous even with one latest ticket');
assert.equal(buildRoutingWidthSnapshot(safeTrackInput({
	safeHistoryRecords: [record('RULE', safeId, '', 20), record('RULE', safeId, safeTrackRule(), 30)],
	extraSourceRecords: [record('RULE', '["RULE","SAFE","UNREFERENCED_SAFE"]', '', 25)],
})).nets.find(net => net.net === 'SAFE_TRACK_NET').status, 'unknown', 'a resolved referenced SAFE rebuild does not consume an unreferenced SAFE deletion');
for (const duplicateHistory of [
	[record('RULE', safeId, safeTrackRule(), 10)],
    [record('RULE', safeId, safeTrackRule(), 20), record('RULE', safeId, safeTrackRule(), 20)],
])
	assert.equal(safeHistoryKnown(10, duplicateHistory).status, 'unknown', 'any repeated SAFE ticket remains ambiguous');
for (const invalidTicket of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '15']) {
	const raw = JSON.stringify({ type: 'RULE', id: safeId, ticket: invalidTicket }) + `||${JSON.stringify(safeTrackRule())}|`;
	assert.equal(safeHistoryKnown(10, [raw]).status, 'unknown', `invalid SAFE ticket ${String(invalidTicket)} remains unknown`);
}
assert.equal(safeHistoryKnown(10, [record('RULE', '[ "RULE", "SAFE", "SAFE_PROFILE" ]', safeTrackRule(), 20)]).status, 'unknown', 'semantically equal SAFE IDs with different raw strings remain ambiguous');
for (const unrelatedTombstone of [
	record('RULE', '["RULE","TRACK","OTHER_TRACK"]', '', 20),
	record('NET', '["NET","OTHER_NET"]', '', 20),
	record('RULE_SELECTOR', '["RULE_SELECTOR",["NET","OTHER_NET"]]', '', 20),
	record('RULE', '["RULE","SAFE","UNREFERENCED_SAFE"]', '', 20),
]) {
	assert.equal(buildRoutingWidthSnapshot(safeTrackInput({ extraSourceRecords: [unrelatedTombstone] })).nets.find(net => net.net === 'SAFE_TRACK_NET').status, 'unknown', 'an unrelated deletion remains unresolved for mixed SAFE+TRACK');
}
const unclassedSafeTrack = safeTrackInput({ unclassed: true });
assert.equal(buildRoutingWidthSnapshot(unclassedSafeTrack).nets.find(net => net.net === 'SAFE_TRACK_NET').status, 'known', 'a single-row mixed NET without a class stays known when its evidence is clean');
assert.equal(buildRoutingWidthSnapshot(safeTrackInput({ unclassed: true, extraSourceRecords: [record('RULE', '["RULE","SAFE","UNREFERENCED_SAFE"]', '', 20)] })).nets.find(net => net.net === 'SAFE_TRACK_NET').status, 'unknown', 'single-row mixed NET without a class cannot bypass an unreferenced SAFE deletion');
assert.equal(buildRoutingWidthSnapshot(safeTrackInput({ layers: fullLayers, netRuleRows: safeHistoryRows, extraSourceRecords: [record('RULE', '["RULE","SAFE","UNREFERENCED_SAFE"]', '', 20)] })).nets.find(net => net.net === 'SAFE_TRACK_NET').status, 'unknown', 'four-layer mixed NET cannot bypass an unreferenced SAFE deletion');
const renamedSafeTrackSnapshot = buildRoutingWidthSnapshot(safeTrackInput({ netName: 'RENAMED_NET', safeName: 'RENAMED_SAFE' }));
assert.equal(renamedSafeTrackSnapshot.nets.find(net => net.net === 'RENAMED_NET').status, 'known', 'SAFE source, selector, and SDK names may be renamed together');
const assertSafeTrackUnknown = (options, label) => {
	const result = buildRoutingWidthSnapshot(safeTrackInput(options));
	assert.equal(result.nets.find(net => net.net === (options.netName ?? 'SAFE_TRACK_NET'))?.status, 'unknown', label);
};
assertSafeTrackUnknown({ omitSafe: true }, 'missing SAFE rule remains unknown');
assertSafeTrackUnknown({ selector: { ruleKeyValue: { SAFE: 'MISSING_SAFE', TRACK: 'ACE_POWER20' } } }, 'missing referenced SAFE rule remains unknown');
assert.equal(buildRoutingWidthSnapshot(safeTrackInput({ safeHistoryRecords: [record('RULE', '["RULE","SAFE","SAFE_PROFILE"]', safeTrackRule(), 11)] })).nets.find(net => net.net === 'SAFE_TRACK_NET').status, 'known', 'a same-ID SAFE update selects the highest ticket');
assertSafeTrackUnknown({ sdkSafeSpacing: 'conflicting-safe' }, 'SDK SAFE reference conflict remains unknown');
assertSafeTrackUnknown({ omitSdkSafeSpacing: true }, 'missing SDK SAFE evidence remains unknown');
assertSafeTrackUnknown({ duplicateSdkNet: true }, 'duplicate SDK NET rows remain unknown');
assertSafeTrackUnknown({ duplicateSelector: true }, 'duplicate NET selectors remain unknown');
assertSafeTrackUnknown({ selector: { extra: true } }, 'extra mixed selector field remains unknown');
assertSafeTrackUnknown({ selector: { parent: 'parent-rule' } }, 'non-null SAFE+TRACK parent remains unknown');
assertSafeTrackUnknown({ safeRule: { ...safeTrackRule(), extra: true } }, 'extra SAFE data field remains unknown');
assertSafeTrackUnknown({ safeRule: { ruleState: 'NORMAL', ruleContext: { ...safeTrackRule().ruleContext, extra: true } } }, 'extra SAFE context field remains unknown');
assertSafeTrackUnknown({ selector: { ruleKeyValue: { SAFE: 'OTHER_SAFE', TRACK: 'ACE_POWER20' } } }, 'SAFE selector reference without exact matching rule ID remains unknown');
assertSafeTrackUnknown({ safeRule: { ...safeTrackRule(), ruleState: 'DEFAULT' } }, 'non-NORMAL SAFE rule remains unknown');
assertSafeTrackUnknown({ safeRule: { ...safeTrackRule(), ruleContext: { ...safeTrackRule().ruleContext, safeSpacing: [{ ...safeTrackRule().ruleContext.safeSpacing[0], extra: true }] } } }, 'extra SAFE row field remains unknown');
assertSafeTrackUnknown({ safeRule: { ...safeTrackRule(), ruleContext: { ...safeTrackRule().ruleContext, safeSpacing: [] } } }, 'missing SAFE spacing row remains unknown');
assertSafeTrackUnknown({ safeRule: { ...safeTrackRule(), ruleContext: { ...safeTrackRule().ruleContext, safeSpacing: [{ ...safeTrackRule().ruleContext.safeSpacing[0], content: [[0], ...safeTrackRows().slice(1)] }] } } }, 'zero SAFE matrix value remains unknown');
assertSafeTrackUnknown({ safeRule: { ...safeTrackRule(), ruleContext: { ...safeTrackRule().ruleContext, safeSpacing: [{ ...safeTrackRule().ruleContext.safeSpacing[0], content: safeTrackRows().map((row, index) => index === 0 ? [6, 6] : row) }] } } }, 'unsupported SAFE matrix shape remains unknown');
assertSafeTrackUnknown({ editorVersion: '4.1.79' }, 'SAFE+TRACK profile remains version-gated');
assertSafeTrackUnknown({ classSelector: { ruleOrder: 4, ruleKeyValue: { SAFE: 'SAFE_PROFILE', TRACK: 'ACE_CLASS30' }, copperValue: {}, innerPlaneValue: {}, parent: null } }, 'NET_CLASS SAFE+TRACK selector is not enabled');

const mixedClassInput = safeClassTrackInput();
const mixedClassSnapshot = buildRoutingWidthSnapshot(mixedClassInput);
const mixedClassNet = mixedClassSnapshot.nets.find(net => net.net === '+5V');
assert.equal(mixedClassNet.status, 'known', 'confirmed NET TRACK plus NET_CLASS SAFE+TRACK binds against the class SDK row');
assert.equal(mixedClassNet.ruleKey, 'ACE_POWER20', 'mixed class rule does not replace the explicit NET TRACK selection');
assert.deepEqual(mixedClassNet.layers.map(({ layerId, minMil, preferredMil, maxMil }) => [layerId, minMil, preferredMil, maxMil]), [
	[1, 5, 20, 100], [15, 5, 20, 100], [16, 5, 20, 100], [2, 25, 30, 35],
]);
const doubleMixedClassInput = safeClassTrackInput({
	netSelector: { ruleOrder: 4, ruleKeyValue: { SAFE: 'NET_SAFE_PROFILE', TRACK: 'ACE_POWER20' }, copperValue: {}, innerPlaneValue: {}, parent: null },
	netSafeName: 'NET_SAFE_PROFILE',
});
const doubleMixedClassSnapshot = buildRoutingWidthSnapshot(doubleMixedClassInput);
const doubleMixedClassNet = doubleMixedClassSnapshot.nets.find(net => net.net === '+5V');
assert.equal(doubleMixedClassNet.status, 'known', 'NET POWER20 and class CLASS30 mixed SAFE+TRACK selectors agree with their distinct SDK rows');
assert.equal(doubleMixedClassNet.ruleKey, 'ACE_POWER20', 'NET mixed selector retains priority over its owning class TRACK');
assert.deepEqual(doubleMixedClassNet.layers.map(({ layerId, minMil, preferredMil, maxMil }) => [layerId, minMil, preferredMil, maxMil]), [
	[1, 5, 20, 100], [15, 5, 20, 100], [16, 5, 20, 100], [2, 25, 30, 35],
], 'different NET and CLASS TRACK rows retain NET per-layer ranges');
const renamedMixedClass = buildRoutingWidthSnapshot(safeClassTrackInput({ className: 'RENAMED_CLASS', safeName: 'RENAMED_CLASS_SAFE' }));
assert.equal(renamedMixedClass.nets.find(net => net.net === '+5V').status, 'known', 'SAFE source, class selector, and class SDK Safe Spacing may be renamed together');
const assertMixedClassUnknown = (options, label) => {
	const result = buildRoutingWidthSnapshot(safeClassTrackInput(options));
	assert.equal(result.nets.find(net => net.net === '+5V')?.status, 'unknown', label);
};
assertMixedClassUnknown({ omitSdkClassSafe: true }, 'missing class SDK Safe Spacing remains unknown');
assertMixedClassUnknown({ sdkClassSafeSpacing: 'CONFLICTING_SAFE' }, 'class SDK Safe Spacing conflict remains unknown');
assertMixedClassUnknown({ sdkClassTrack: 'CONFLICTING_TRACK' }, 'class SDK Track conflict remains unknown');
assertMixedClassUnknown({ duplicateSdkClass: true }, 'duplicate SDK class rows remain unknown');
assertMixedClassUnknown({ classSelector: { parent: 'parent-rule' } }, 'non-null mixed class parent remains unknown');
assertMixedClassUnknown({ classSelector: { extra: true } }, 'extra mixed class selector field remains unknown');
assertMixedClassUnknown({ classSelector: { ruleKeyValue: { SAFE: 'CLASS_SAFE_PROFILE', TRACK: 'ACE_CLASS30', EXTRA: 'x' } } }, 'extra class SAFE/TRACK key remains unknown');
assertMixedClassUnknown({ classSelector: { copperValue: { NET: 'x' } } }, 'mixed class copper override remains unknown');
assertMixedClassUnknown({ classSelector: { ruleOrder: 3 } }, 'mixed class rule order remains unknown');
assertMixedClassUnknown({ safeRule: { ...safeTrackRule('CLASS_SAFE_PROFILE'), ruleState: 'DEFAULT' } }, 'bad referenced class SAFE profile remains unknown');
assertMixedClassUnknown({ safeHistoryRecords: [record('RULE', '["RULE","SAFE","CLASS_SAFE_PROFILE"]', '', 20), record('RULE', '["RULE","SAFE","CLASS_SAFE_PROFILE"]', safeTrackRule('CLASS_SAFE_PROFILE'), 30)] }, 'class SAFE historical deletion is not exempted by the global tombstone gate');
const classNoNetSelector = safeClassTrackInput();
classNoNetSelector.source = classNoNetSelector.source.replace(record('RULE_SELECTOR', selectorId('NET', '+5V'), trackSelector('ACE_POWER20'), 7), '');
assert.equal(buildRoutingWidthSnapshot(classNoNetSelector).nets.find(net => net.net === '+5V').status, 'unknown', 'mixed class does not bind when NET TRACK selector is missing');
const classNoClassSelector = safeClassTrackInput();
classNoClassSelector.source = classNoClassSelector.source.replace(record('RULE_SELECTOR', selectorId('NET_CLASS', 'ACE_TEST_CLASS'), {
	ruleOrder: 4, ruleKeyValue: { SAFE: 'CLASS_SAFE_PROFILE', TRACK: 'ACE_CLASS30' }, copperValue: {}, innerPlaneValue: {}, parent: null,
}, 6), '');
assert.equal(buildRoutingWidthSnapshot(classNoClassSelector).nets.find(net => net.net === '+5V').status, 'unknown', 'mixed class binding requires its exact class selector');
const classAssociationConflict = safeClassTrackInput();
classAssociationConflict.netRules.push({ type: 'netClass', name: 'OTHER_CLASS', Track: 'ACE_CLASS30', 'Safe Spacing': 'CLASS_SAFE_PROFILE', sub: [
	{ type: 'net', name: '+5V', Track: 'ACE_POWER20', 'Safe Spacing': 'default' },
] });
assert.equal(buildRoutingWidthSnapshot(classAssociationConflict).nets.find(net => net.net === '+5V').status, 'unknown', 'conflicting SDK NET class ownership remains unknown');
assertMixedClassUnknown({ netSelector: emptyNetSelector(), sdkNetTrack: 'default' }, 'mixed class does not replace a NET default selector');
const bothMixedNetSelector = { ...trackSelector('ACE_CLASS30'), ruleKeyValue: { SAFE: 'NET_SAFE_PROFILE', TRACK: 'ACE_CLASS30' } };
const bothMixedSnapshot = buildRoutingWidthSnapshot(safeClassTrackInput({ netSelector: bothMixedNetSelector, sdkNetTrack: 'ACE_CLASS30', sdkNetSafeSpacing: 'NET_SAFE_PROFILE' }));
const bothMixedNet = bothMixedSnapshot.nets.find(net => net.net === '+5V');
assert.equal(bothMixedNet.status, 'known', 'both NET and NET_CLASS SAFE+TRACK bind when each SAFE reference matches its own SDK row');
assert.equal(bothMixedNet.ruleKey, 'ACE_CLASS30');
assert.deepEqual(bothMixedNet.layers.map(({ layerId, minMil, preferredMil, maxMil }) => [layerId, minMil, preferredMil, maxMil]), [
	[1, 25, 30, 35], [15, 5, 30, 100], [16, 5, 30, 100], [2, 5, 30, 100],
]);
const sameReferenceBothMixedNetSelector = { ...trackSelector('ACE_CLASS30'), ruleKeyValue: { SAFE: 'CLASS_SAFE_PROFILE', TRACK: 'ACE_CLASS30' } };
assert.equal(buildRoutingWidthSnapshot(safeClassTrackInput({
	netSelector: sameReferenceBothMixedNetSelector, sdkNetTrack: 'ACE_CLASS30', sdkNetSafeSpacing: 'CLASS_SAFE_PROFILE',
})).nets.find(net => net.net === '+5V').status, 'known', 'the persisted host pairing with one SAFE reference on both selectors is supported');
const bothMixedWithTombstone = buildRoutingWidthSnapshot(safeClassTrackInput({
	netSelector: bothMixedNetSelector, sdkNetTrack: 'ACE_CLASS30', sdkNetSafeSpacing: 'NET_SAFE_PROFILE',
	safeHistoryRecords: [record('RULE', '["RULE","SAFE","CLASS_SAFE_PROFILE"]', '', 20), record('RULE', '["RULE","SAFE","CLASS_SAFE_PROFILE"]', safeTrackRule('CLASS_SAFE_PROFILE'), 30)],
}));
assert.equal(bothMixedWithTombstone.nets.find(net => net.net === '+5V').status, 'unknown', 'both mixed selectors do not bypass global tombstone protection');
assert.equal(buildRoutingWidthSnapshot(safeClassTrackInput({ safeHistoryRecords: [record('RULE', '["RULE","SAFE","CLASS_SAFE_PROFILE"]', safeTrackRule('CLASS_SAFE_PROFILE'), 20)] })).nets.find(net => net.net === '+5V').status, 'known', 'class SAFE resolver accepts an unambiguous same-ID update');

const comparison = compareDsnWidthRules(snapshot, dsn());
assert.equal(comparison.defaultRule.status, 'mismatch', '10.05 DSN default differs from preferred 10 mil');
assert.equal(comparison.defaultRule.withinEdaBounds, true);
assert.equal(comparison.nets.find(n => n.net === '+5V').status, 'matched');
assert.equal(comparison.nets.find(n => n.net === 'GND').status, 'matched');
assert.equal(comparison.status, 'mismatch');
assert.equal(compareDsnWidthRules(snapshot, dsn('mm')).nets.find(n => n.net === '+5V').dsnWidthMil, 20);

// The selectors and SDK rows below are reduced fixtures from v090-rule20/30 source.json and netrules.json.
const explicit20 = buildRoutingWidthSnapshot(explicitClassInput({ netTrack: 'ACE_POWER20', sdkNetTrack: 'ACE_POWER20', classTrack: 'ACE_CLASS30', sdkClassTrack: 'ACE_CLASS30' }));
assert.equal(explicit20.globalStatus, 'known');
assert.equal(explicit20.nets.find(net => net.net === '+5V').status, 'known', 'matching explicit NET override is confirmed when both class and net selectors agree with unique SDK records');
assert.equal(explicit20.nets.find(net => net.net === '+5V').layers[0].preferredMil, 20);
assert.equal(explicit20.nets.find(net => net.net === 'ACE_VIA').status, 'known', 'exact empty NET selector confirms the SDK default independently of the explicit +5V class selection');
assert.equal(explicit20.nets.find(net => net.net === 'ACE_VIA').ruleKey, explicit20.defaultRule.ruleKey);

const classMultiRows = fourRows();
const defaultRows = fourRows([[5, 15, 100], [22, 27, 38], [22, 27, 38], [22, 27, 38]]);
const classMulti = buildRoutingWidthSnapshot(explicitClassInput({ layers: fullLayers, netTrack: 'ACE_CLASS30', sdkNetTrack: 'ACE_CLASS30', classRuleRows: classMultiRows, netRuleRows: classMultiRows }));
const classMultiNet = classMulti.nets.find(net => net.net === '+5V');
assert.equal(classMultiNet.status, 'known', 'NET and CLASS selectors plus SDK membership can bind matching multi-layer NORMAL rules');
assert.deepEqual(classMultiNet.layers.map(layer => [layer.layerId, layer.minMil, layer.preferredMil, layer.maxMil]), [[1, 25, 30, 35], [15, 5, 15, 100], [16, 5, 15, 100], [2, 5, 15, 100]]);
const classMultiSes = checkSesWidthRules(classMulti, [
	{ net: '+5V', layer: 1, widthMil: 20 }, { net: '+5V', layer: 1, widthMil: 40 },
	{ net: '+5V', layer: 2, widthMil: 20 }, { net: '+5V', layer: 2, widthMil: 40 }, { net: '+5V', layer: 2, widthMil: 30 },
]);
assert.equal(classMultiSes.status, 'violation');
assert.deepEqual(classMultiSes.violations.map(item => [item.widthMil, item.minMil, item.maxMil]), [[20, 25, 35], [40, 25, 35]], 'only Top bounds reject widths 20 and 40; Bottom retains 5-100');

const emptyNetClassMulti = buildRoutingWidthSnapshot(explicitClassInput({
	layers: fullLayers,
	defaultRuleRows: defaultRows,
	netTrack: 'default', sdkNetTrack: 'default', netSelector: emptyNetSelector(),
	classRuleRows: classMultiRows,
}));
assert.equal(emptyNetClassMulti.nets.find(net => net.net === '+5V').status, 'known', 'empty NET selector confirms DEFAULT only with complete multi-layer CLASS, SDK and source binding evidence');
assert.deepEqual(emptyNetClassMulti.nets.find(net => net.net === '+5V').layers.map(layer => layer.layerId), [1, 15, 16, 2]);
assert.deepEqual(emptyNetClassMulti.defaultRule.layers.map(layer => [layer.minMil, layer.preferredMil, layer.maxMil]), [[5, 15, 100], [22, 27, 38], [22, 27, 38], [22, 27, 38]]);
for (const invalidSelector of [
	{ ...emptyNetSelector(), parent: 'complex' },
	{ ...emptyNetSelector(), copperValue: { layer: 15 } },
	{ ...emptyNetSelector(), ruleKeyValue: { TRACK: 'default', SAFE: 'SAFE_TRACK' } },
]) {
	const unknown = buildRoutingWidthSnapshot(explicitClassInput({ layers: fullLayers, defaultRuleRows: defaultRows, netTrack: 'default', sdkNetTrack: 'default', netSelector: invalidSelector, classRuleRows: classMultiRows }));
	assert.equal(unknown.nets.find(net => net.net === '+5V').status, 'unknown', 'complex, parented or copper-scoped selectors remain unresolved');
}
const emptyNetClassSdkConflict = buildRoutingWidthSnapshot(explicitClassInput({ layers: fullLayers, defaultRuleRows: defaultRows, netTrack: 'default', sdkNetTrack: 'OTHER', netSelector: emptyNetSelector(), classRuleRows: classMultiRows }));
assert.equal(emptyNetClassSdkConflict.nets.find(net => net.net === '+5V').status, 'unknown', 'SDK binding conflict remains unknown');
const emptyNetClassMissingRow = buildRoutingWidthSnapshot(explicitClassInput({ layers: fullLayers, defaultRuleRows: defaultRows, netTrack: 'default', sdkNetTrack: 'default', netSelector: emptyNetSelector(), classRuleRows: classMultiRows.slice(1) }));
assert.equal(emptyNetClassMissingRow.nets.find(net => net.net === '+5V').status, 'unknown', 'missing CLASS layer row is not accepted by empty NET branch');
const emptyNetClassDuplicateRow = buildRoutingWidthSnapshot(explicitClassInput({ layers: fullLayers, defaultRuleRows: [...defaultRows, { ...defaultRows[0] }], netTrack: 'default', sdkNetTrack: 'default', netSelector: emptyNetSelector(), classRuleRows: classMultiRows }));
assert.equal(emptyNetClassDuplicateRow.nets.find(net => net.net === '+5V').status, 'unknown', 'duplicate DEFAULT layer row is not accepted by empty NET branch');
const emptyNetClassDuplicateClassRow = buildRoutingWidthSnapshot(explicitClassInput({ layers: fullLayers, defaultRuleRows: defaultRows, netTrack: 'default', sdkNetTrack: 'default', netSelector: emptyNetSelector(), classRuleRows: [...classMultiRows, { ...classMultiRows[0] }] }));
assert.equal(emptyNetClassDuplicateClassRow.nets.find(net => net.net === '+5V').status, 'unknown', 'duplicate CLASS layer row is not accepted by empty NET branch');

const powerRows = fourRows([[5, 20, 100], [5, 20, 100], [5, 20, 100], [5, 20, 100]]);
const netPriority = buildRoutingWidthSnapshot(explicitClassInput({ layers: fullLayers, classRuleRows: classMultiRows, netRuleRows: powerRows }));
const netPriorityNet = netPriority.nets.find(net => net.net === '+5V');
assert.equal(netPriorityNet.status, 'known', 'an explicit POWER20 NET rule keeps precedence over distinct CLASS multi-layer bounds');
assert.ok(netPriorityNet.layers.every(layer => layer.preferredMil === 20));

for (const mutation of [
	rows => rows.slice(1),
	rows => [...rows, { ...rows[0] }],
	rows => [{ ...rows[0], layerId: 1.5 }, ...rows.slice(1)],
]) {
	assertClassUnknown(explicitClassInput({ layers: fullLayers, netTrack: 'ACE_CLASS30', sdkNetTrack: 'ACE_CLASS30', classRuleRows: mutation(classMultiRows), netRuleRows: mutation(classMultiRows) }));
}
assertClassUnknown(explicitClassInput({ layers: fullLayers.map((layer, index) => index ? layer : { ...layer, id: 99 }), netTrack: 'ACE_CLASS30', sdkNetTrack: 'ACE_CLASS30', classRuleRows: classMultiRows, netRuleRows: classMultiRows }));
assertClassUnknown(explicitClassInput({ layers: fullLayers, netTrack: 'ACE_CLASS30', sdkNetTrack: 'ACE_CLASS30', classRuleRows: classMultiRows, netRuleRows: classMultiRows, classSelector: { ...trackSelector('ACE_CLASS30'), parent: 'complex' } }));
assertClassUnknown(explicitClassInput({ layers: fullLayers, netTrack: 'ACE_CLASS30', sdkNetTrack: 'ACE_CLASS30', sdkClassTrack: 'OTHER_CLASS', classRuleRows: classMultiRows, netRuleRows: classMultiRows }));
assertClassUnknown(explicitClassInput({ layers: fullLayers, editorVersion: '4.1.79', netTrack: 'ACE_CLASS30', sdkNetTrack: 'ACE_CLASS30', classRuleRows: classMultiRows, netRuleRows: classMultiRows }));
assertClassUnknown(explicitClassInput({ layers: fullLayers, netTrack: 'ACE_CLASS30', sdkNetTrack: 'ACE_CLASS30', classRuleUnit: 'mm', classRuleRows: classMultiRows, netRuleRows: classMultiRows }));

const defaultMultiSource = [
	'{"type":"DOCHEAD"}||{"docType":"PCB","uuid":"default-multi"}|',
	record('RULE', '["RULE","TRACK","default"]', { ruleState: 'DEFAULT', ruleContext: { unit: 'mil', track: { isOpen: true, content: defaultRows } } }, 1),
	record('NET', '["NET","NO_CLASS"]', { netType: null }, 2),
	record('RULE_SELECTOR', selectorId('NET', 'NO_CLASS'), emptyNetSelector(), 3),
].join('\n');
const defaultMulti = buildRoutingWidthSnapshot({ source: defaultMultiSource, editorVersion: '4.1.78', layers: fullLayers, netRules: [{ type: 'net', name: 'NO_CLASS', Track: 'default' }] });
assert.equal(defaultMulti.defaultRule.status, 'known');
assert.deepEqual(defaultMulti.defaultRule.layers.map(layer => [layer.layerId, layer.minMil, layer.preferredMil, layer.maxMil]), [[1, 5, 15, 100], [15, 22, 27, 38], [16, 22, 27, 38], [2, 22, 27, 38]], 'DEFAULT rows retain each layer bound; Top is not copied over the other enabled layers');
assert.equal(defaultMulti.nets.find(net => net.net === 'NO_CLASS').status, 'known', 'DEFAULT multi-layer evidence applies to a no-class NET with confirmed default SDK binding');
assert.deepEqual(defaultMulti.nets.find(net => net.net === 'NO_CLASS').layers.map(layer => layer.layerId), [1, 15, 16, 2]);
const defaultMultiSes = checkSesWidthRules(defaultMulti, [{ net: 'NO_CLASS', layer: 1, widthMil: 20 }, { net: 'NO_CLASS', layer: 1, widthMil: 40 }, { net: 'NO_CLASS', layer: 15, widthMil: 20 }, { net: 'NO_CLASS', layer: 15, widthMil: 27 }]);
assert.deepEqual(defaultMultiSes.violations.map(item => [item.widthMil, item.minMil, item.maxMil]), [[20, 22, 38]], 'DEFAULT bounds are evaluated against the actual line layer');
const buildDefaultMulti = (rows = defaultRows, editorVersion = '4.1.78', unit = 'mil', sdkLayers = fullLayers) => buildRoutingWidthSnapshot({
	source: defaultMultiSource.replace(JSON.stringify(defaultRows), JSON.stringify(rows)).replace('"unit":"mil"', `"unit":"${unit}"`),
	editorVersion, layers: sdkLayers, netRules: [{ type: 'net', name: 'NO_CLASS', Track: 'default' }],
});
assert.equal(buildDefaultMulti(defaultRows.slice(1)).defaultRule.status, 'unknown', 'DEFAULT rejects a missing enabled-layer row');
assert.equal(buildDefaultMulti([...defaultRows, { ...defaultRows[0] }]).defaultRule.status, 'unknown', 'DEFAULT rejects duplicate rows');
assert.equal(buildDefaultMulti([{ ...defaultRows[0], layerId: 1.5 }, ...defaultRows.slice(1)]).defaultRule.status, 'unknown', 'DEFAULT rejects noninteger layer IDs');
assert.equal(buildDefaultMulti(defaultRows, '4.1.79').defaultRule.status, 'unknown', 'DEFAULT multilayer evidence is version-gated');
assert.equal(buildDefaultMulti(defaultRows, '4.1.78', 'mm').defaultRule.status, 'unknown', 'DEFAULT multilayer evidence is mil-only');
assert.equal(buildDefaultMulti(defaultRows, '4.1.78', 'mil', fullLayers.map((layer, index) => index ? layer : { ...layer, id: 99 })).defaultRule.status, 'unknown', 'DEFAULT multilayer evidence rejects SDK ID alias conflicts');
assert.equal(explicit20.routingConstraintsComplete, false);
assert.equal(compareDsnWidthRules(explicit20, dsn()).defaultRule.status, 'mismatch', '10.05 mil DSN default remains different from the 10 mil EDA default');
const explicit30 = buildRoutingWidthSnapshot(explicitClassInput({ netTrack: 'ACE_CLASS30', sdkNetTrack: 'ACE_CLASS30', classTrack: 'ACE_CLASS30', sdkClassTrack: 'ACE_CLASS30' }));
assert.equal(explicit30.nets.find(net => net.net === '+5V').status, 'known', 'matching NET and class Track values are confirmed');

const multiRows = [
	{ layerId: 2, stroMin: 25, stroDef: 30, stroMax: 35 },
	{ layerId: 16, stroMin: 5, stroDef: 20, stroMax: 100 },
	{ layerId: 1, stroMin: 5, stroDef: 20, stroMax: 100 },
	{ layerId: 15, stroMin: 5, stroDef: 20, stroMax: 100 },
];
const multiLayers = [
	{ layerId: 1, type: 'SIGNAL', status: 1, layerName: 'Top Layer' },
	{ layerId: 2, type: 'SIGNAL', status: 2, layerName: 'Bottom Layer' },
	{ layerId: 15, type: 'SIGNAL', status: 2, layerName: 'Inner 1' },
	{ layerId: 16, type: 'SIGNAL', status: 2, layerName: 'Inner 2' },
];
const multiNetInput = () => explicitClassInput({ netRuleRows: multiRows, layers: multiLayers });
const multiNetSnapshot = buildRoutingWidthSnapshot(multiNetInput());
const multiNet = multiNetSnapshot.nets.find(net => net.net === '+5V');
assert.equal(multiNet.status, 'known', 'explicit NORMAL NET multi-row mil rule is confirmed against every enabled SIGNAL layer');
assert.deepEqual(multiNet.layers.map(layer => [layer.layerId, layer.preferredMil]), [[1, 20], [2, 30], [15, 20], [16, 20]], 'rows are mapped by SDK layer ID rather than source row order');
assert.equal(multiNetSnapshot.routingConstraintsComplete, false);
const multiComparison = compareDsnWidthRules(multiNetSnapshot, dsn());
const multiEntry = multiComparison.nets.find(entry => entry.net === '+5V');
assert.equal(multiEntry.status, 'mismatch', 'non-first layer mismatch contributes to aggregate NET result');
assert.equal(multiEntry.eda, undefined, 'different per-layer bounds do not expose a misleading aggregate EDA bound');
assert.equal(multiEntry.deviationFromPreferredMil, undefined);
assert.equal(multiEntry.withinEdaBounds, undefined);
assert.deepEqual(multiEntry.layers.map(layer => [layer.layerId, layer.status]), [[1, 'matched'], [2, 'mismatch'], [15, 'matched'], [16, 'matched']]);
const bottomDiff = multiEntry.layers.find(layer => layer.layerId === 2);
assert.equal(bottomDiff.dsnWidthMil, 20);
assert.equal(bottomDiff.deviationFromPreferredMil, -10);
assert.equal(bottomDiff.withinEdaBounds, false);
assert.equal(checkSesWidthRules(multiNetSnapshot, [{ net: '+5V', layer: 2, widthMil: 20 }]).violations[0].minMil, 25);
assert.equal(checkSesWidthRules(multiNetSnapshot, [{ net: '+5V', layer: 2, widthMil: 30 }, { net: '+5V', layer: 1, widthMil: 20 }]).status, 'compliant');
assert.equal(checkSesWidthRules(multiNetSnapshot, [{ net: '+5V', layer: 2, widthMil: 40 }]).violations[0].maxMil, 35);
const sameBoundsInput = explicitClassInput({ netRuleRows: multiRows.map(row => ({ ...row, stroMin: 5, stroDef: 20, stroMax: 100 })), layers: multiLayers });
const sameBoundsEntry = compareDsnWidthRules(buildRoutingWidthSnapshot(sameBoundsInput), dsn()).nets.find(entry => entry.net === '+5V');
assert.equal(sameBoundsEntry.layers, undefined, 'identical per-layer bounds preserve the prior comparison shape');
assert.equal(sameBoundsEntry.eda.preferredMil, 20);

const multiUnknown = (options = {}) => assertClassUnknown(explicitClassInput({ netRuleRows: multiRows, layers: multiLayers, ...options }));
for (const [name, rows] of [
	['missing layer row', multiRows.slice(1)],
	['duplicate source layer ID', [...multiRows, { ...multiRows[0] }]],
	['extra source layer ID', [...multiRows, { layerId: 99, stroMin: 1, stroDef: 2, stroMax: 3 }]],
	['string source layer ID', multiRows.map((row, index) => index ? row : { ...row, layerId: '2' })],
	['fractional source layer ID', multiRows.map((row, index) => index ? row : { ...row, layerId: 2.5 })],
	['NaN source bound', multiRows.map((row, index) => index ? row : { ...row, stroMin: Number.NaN })],
	['string source bound', multiRows.map((row, index) => index ? row : { ...row, stroDef: '30' })],
	['negative source bound', multiRows.map((row, index) => index ? row : { ...row, stroMin: -1 })],
	['reversed source bounds', multiRows.map((row, index) => index ? row : { ...row, stroMin: 40, stroDef: 30, stroMax: 35 })],
	['extra row field', multiRows.map((row, index) => index ? row : { ...row, layerName: 'Bottom' })],
]) {
	assert.ok(multiUnknown({ netRuleRows: rows }).nets.find(net => net.net === '+5V')?.status === 'unknown', `${name} leaves the whole NET rule unknown`);
}
assertClassUnknown(explicitClassInput({ netRuleRows: multiRows, layers: [...multiLayers, { layerId: 2, type: 'SIGNAL', status: 2, layerName: 'Duplicate Bottom' }] }));
assertClassUnknown(explicitClassInput({ netRuleRows: multiRows, layers: multiLayers.map(layer => layer.layerId === 2 ? { ...layer, layerId: '2' } : layer) }));
assertClassUnknown(explicitClassInput({ netRuleRows: multiRows, layers: multiLayers.map(layer => layer.layerId === 2 ? { ...layer, layerId: 2.5 } : layer) }));
multiUnknown({ netRuleState: 'DEFAULT' });
assertClassUnknown(explicitClassInput({ netRuleRows: multiRows, netRuleOpen: false, layers: multiLayers }));
const multiMmInput = explicitClassInput({ netRuleRows: multiRows, netRuleUnit: 'mm', layers: multiLayers });
assert.equal(JSON.parse(multiMmInput.source.split('\n').find(line => line.includes('ACE_POWER20')).split('||')[1].replace(/\|$/, '')).ruleContext.unit, 'mm');
assertClassUnknown(multiMmInput);
const classOnlyMulti = buildRoutingWidthSnapshot(explicitClassInput({ classRuleRows: multiRows, netTrack: 'ACE_CLASS30', sdkNetTrack: 'ACE_CLASS30', classTrack: 'ACE_CLASS30', sdkClassTrack: 'ACE_CLASS30', layers: multiLayers }));
assert.equal(classOnlyMulti.nets.find(net => net.net === '+5V').status, 'known', 'a unique matching CLASS multilayer rule is recognized when source, NET and SDK bindings agree');
multiUnknown({ netSelector: { ...trackSelector('ACE_POWER20'), parent: 'parent' } });
multiUnknown({ netSelector: { ...trackSelector('ACE_POWER20'), copperValue: { layer: 2 } } });
multiUnknown({ netSelector: { ...trackSelector('ACE_POWER20'), innerPlaneValue: { layer: 15 } } });
multiUnknown({ sdkNetTrack: 'OTHER_TRACK' });
multiUnknown({ netSelector: trackSelector('ACE_CLASS30') });
const unclassifiedMultiFixture = multiNetInput();
const unclassifiedSource = unclassifiedMultiFixture.source.split('\n').filter(line => !line.includes('["RULE_SELECTOR",["NET_CLASS"')).filter(line => !line.includes('["NET","ACE_VIA"]')).join('\n').replace('"netType":"ACE_TEST_CLASS"', '"netType":null');
const unclassifiedMulti = buildRoutingWidthSnapshot({ source: unclassifiedSource, editorVersion: '4.1.78', layers: multiLayers, netRules: [{ type: 'net', name: '+5V', Track: 'ACE_POWER20' }] });
assert.equal(unclassifiedMulti.nets.find(net => net.net === '+5V').status, 'known', 'multi-row NET binding is independently confirmed for a net without a class');
const contradictoryUnclassified = buildRoutingWidthSnapshot({ source: unclassifiedSource, editorVersion: '4.1.78', layers: multiLayers, netRules: [{ type: 'netClass', name: 'OTHER_CLASS', Track: 'ACE_CLASS30', sub: [{ type: 'net', name: '+5V', Track: 'ACE_POWER20' }] }] });
assert.equal(contradictoryUnclassified.nets.find(net => net.net === '+5V').status, 'unknown', 'SDK class membership cannot be ignored when the source NET has no class');
multiUnknown({ extraSourceRecords: [record('RULE_SELECTOR', selectorId('NET', '+5V'), trackSelector('ACE_POWER20'), 7)] });
multiUnknown({ netRules: [
	{ type: 'netClass', name: 'ACE_TEST_CLASS', Track: 'ACE_CLASS30', sub: [{ type: 'net', name: '+5V', Track: 'ACE_POWER20' }, { type: 'net', name: 'ACE_VIA', Track: 'default' }] },
	{ type: 'net', name: '+5V', Track: 'ACE_POWER20' },
] });
const defaultNetMulti = buildRoutingWidthSnapshot(explicitClassInput({ defaultRuleRows: multiRows, layers: multiLayers }));
assert.equal(defaultNetMulti.defaultRule.status, 'known', 'a complete exact DEFAULT multilayer row set is accepted');
assertClassUnknown(explicitClassInput({ netRuleRows: multiRows, editorVersion: '4.1.79', layers: multiLayers }));

const emptyDefaultInput = emptyNetSelectorInput();
const emptyDefaultSnapshot = buildRoutingWidthSnapshot(emptyDefaultInput);
const emptyDefaultNet = emptyDefaultSnapshot.nets.find(net => net.net === 'SYN_DEFAULT_NET');
assert.equal(emptyDefaultNet.status, 'known', 'exact empty NET selector plus unique SDK Track=default confirms the existing DEFAULT rule');
assert.equal(emptyDefaultNet.ruleKey, 'default', 'effective selectedKey is the DEFAULT rule key');
assert.equal(emptyDefaultNet.layers[0].minMil, 5);
assert.equal(emptyDefaultNet.layers[0].preferredMil, 10);
assert.equal(emptyDefaultNet.layers[0].maxMil, 100);
const alternateDefaultSnapshot = buildRoutingWidthSnapshot(emptyNetSelectorInput({ defaultRuleRows: [trackRow(17, { stroMin: 11, stroMax: 24 })] }));
assert.deepEqual(alternateDefaultSnapshot.nets.find(net => net.net === 'SYN_DEFAULT_NET').layers[0], { layerId: 1, name: 'Top Layer', minMil: 11, preferredMil: 17, maxMil: 24, status: 'known' }, 'the strict branch follows other valid DEFAULT bounds without hardcoded fixture widths');
assertClassUnknown(emptyNetSelectorInput({ defaultRuleRows: [trackRow(27, { layerId: 999 })] }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ defaultRuleRows: [trackRow(27, { layerId: 1.5 })] }), 'SYN_DEFAULT_NET');
const defaultOnDisabledLayer = emptyNetSelectorInput({ defaultRuleRows: [trackRow(27, { layerId: 17 })], layers: [...layers, { layerId: 17, type: 'SIGNAL', status: 0, layerName: 'Inactive' }] });
assertClassUnknown(defaultOnDisabledLayer, 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ netSelector: { ...emptyNetSelector(), ruleKeyValue: { TRACK: 'default' } } }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ netSelector: { ...emptyNetSelector(), ruleKeyValue: { TRACK: '' } } }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ netSelector: undefined }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ netSelector: { ...emptyNetSelector(), extra: true } }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ defaultOpen: false }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ defaultRuleState: 'NORMAL' }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ defaultUnit: 'mm' }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ defaultRuleRows: [] }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ defaultRuleRows: [trackRow(17, { stroMin: 18 })] }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ classSelector: {} }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ classSelector: { ...trackSelector('ACE_CLASS30'), extra: true } }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ classRuleRows: [] }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ classRuleState: 'DEFAULT' }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ editorVersion: '4.1.79' }), 'SYN_DEFAULT_NET');
const missingEmptySelector = emptyNetSelectorInput();
missingEmptySelector.source = missingEmptySelector.source.split('\n').filter(line => !line.includes('SYN_DEFAULT_NET') || !line.includes('RULE_SELECTOR')).join('\n');
assertClassUnknown(missingEmptySelector, 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ extraSourceRecords: [record('RULE_SELECTOR', selectorId('NET', 'SYN_DEFAULT_NET'), emptyNetSelector(), 7)] }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ extraSourceRecords: [record('RULE_SELECTOR', selectorId('NET', 'SYN_DEFAULT_NET'), '', 7)] }), 'SYN_DEFAULT_NET');
assertClassUnknown(emptyNetSelectorInput({ extraSourceRecords: [record('NET', JSON.stringify(['NET', 'SYN_DEFAULT_NET']), { netType: 'OTHER_CLASS' }, 4)] }), 'SYN_DEFAULT_NET');
const duplicateDefaultSdkNet = emptyNetSelectorInput();
duplicateDefaultSdkNet.netRules = [...duplicateDefaultSdkNet.netRules, { type: 'netClass', name: 'OTHER_CLASS', Track: 'ACE_CLASS30', sub: [{ type: 'net', name: 'SYN_DEFAULT_NET', Track: 'default' }] }];
assertClassUnknown(duplicateDefaultSdkNet, 'SYN_DEFAULT_NET');
const duplicateDefaultSdkClass = emptyNetSelectorInput();
duplicateDefaultSdkClass.netRules = [...duplicateDefaultSdkClass.netRules, { type: 'netClass', name: 'ACE_TEST_CLASS', Track: 'ACE_CLASS30', sub: [] }];
assertClassUnknown(duplicateDefaultSdkClass, 'SYN_DEFAULT_NET');
const limitedDefaultSnapshot = buildRoutingWidthSnapshot(emptyNetSelectorInput({ defaultRuleRows: [trackRow(27, { stroMin: 22, stroMax: 38 })] }));
const defaultSes = checkSesWidthRules(limitedDefaultSnapshot, [
	{ net: 'SYN_DEFAULT_NET', layer: 1, widthMil: 20 }, { net: 'SYN_DEFAULT_NET', layer: 1, widthMil: 40 },
]);
assert.equal(defaultSes.status, 'violation');
assert.deepEqual(defaultSes.violations.map(item => item.widthMil), [20, 40]);
const compliantDefaultSes = checkSesWidthRules(limitedDefaultSnapshot, [
	{ net: 'SYN_DEFAULT_NET', layer: 1, widthMil: 22 }, { net: 'SYN_DEFAULT_NET', layer: 1, widthMil: 27 }, { net: 'SYN_DEFAULT_NET', layer: 1, widthMil: 38 },
]);
assert.equal(compliantDefaultSes.status, 'compliant');

const renamedInput = explicitClassInput({ netName: 'RENAMED_NET', className: 'RENAMED_CLASS' });
const renamed = buildRoutingWidthSnapshot(renamedInput);
assert.equal(renamed.nets.find(net => net.net === 'RENAMED_NET').status, 'known', 'matching renamed NET/class names remain explicitly associated');
assertClassUnknown(explicitClassInput({ netRules: [] }));
assertClassUnknown(explicitClassInput({ sdkClassTrack: 'OTHER_TRACK' }));
assertClassUnknown(explicitClassInput({ sdkNetTrack: 'OTHER_TRACK' }));
assertClassUnknown(explicitClassInput({ classRuleState: 'DEFAULT' }));
assertClassUnknown(explicitClassInput({ netRuleState: 'DEFAULT' }));
assertClassUnknown(explicitClassInput({ classRuleRows: [] }));
assertClassUnknown(explicitClassInput({ defaultRuleRows: [] }));
assertClassUnknown(explicitClassInput({ classSelector: { ...trackSelector('ACE_CLASS30'), extra: true } }));
assertClassUnknown(explicitClassInput({ netSelector: { ...trackSelector('ACE_POWER20'), ruleKeyValue: {} } }));
assertClassUnknown(explicitClassInput({ netSelector: { ...trackSelector('ACE_POWER20'), ruleKeyValue: { TRACK: 'ACE_POWER20', EXTRA: 'other' } } }));
assertClassUnknown(explicitClassInput({ netSelector: { ...trackSelector('ACE_POWER20'), ruleOrder: 3 } }));
assertClassUnknown(explicitClassInput({ netSelector: { ...trackSelector('ACE_POWER20'), parent: 'parent-rule' } }));
assertClassUnknown(explicitClassInput({ classSelector: { ...trackSelector('ACE_CLASS30'), parent: 'parent-rule' } }));
assertClassUnknown(explicitClassInput({ classSelector: { ...trackSelector('ACE_CLASS30'), ruleOrder: 3 } }));
assertClassUnknown(explicitClassInput({ classSelector: { ...trackSelector('ACE_CLASS30'), copperValue: [] } }));
assertClassUnknown(explicitClassInput({ classSelector: { ...trackSelector('ACE_CLASS30'), ruleKeyValue: { TRACK: '' } } }));
assertClassUnknown(explicitClassInput({ classSelector: { ...trackSelector('ACE_CLASS30'), ruleKeyValue: { TRACK: 30 } } }));
assertClassUnknown(explicitClassInput({ netSelectorId: '["RULE_SELECTOR",["NET","+5V","extra"]]' }));
assertClassUnknown(explicitClassInput({ classSelectorId: '["RULE_SELECTOR",["NET_CLASS","ACE_TEST_CLASS","extra"]]' }));
const nonStringSelectorId = `${JSON.stringify({ type: 'RULE_SELECTOR', ticket: 20, id: ['RULE_SELECTOR', ['NET', '+5V']] })}||${JSON.stringify(trackSelector('ACE_POWER20'))}|`;
assertClassUnknown(explicitClassInput({ extraSourceRecords: [nonStringSelectorId] }));
assertClassUnknown(explicitClassInput({ netRuleRows: [trackRow(20, { stroMin: 21 })] }));
assertClassUnknown(explicitClassInput({ classRuleRows: [trackRow(30, { stroMax: 29 })] }));
const inactiveSignalLayers = [...layers, { layerId: 17, type: 'SIGNAL', status: 0, layerName: 'Inactive Signal' }];
for (const invalidLayerId of [99, 17, '1', 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
	assertClassUnknown(explicitClassInput({ netRuleRows: [trackRow(20, { layerId: invalidLayerId })], layers: inactiveSignalLayers }), '+5V');
	assertClassUnknown(explicitClassInput({ classRuleRows: [trackRow(30, { layerId: invalidLayerId })], layers: inactiveSignalLayers }), '+5V');
}
assert.equal(buildRoutingWidthSnapshot(explicitClassInput({ layers: inactiveSignalLayers })).nets.find(net => net.net === '+5V').status, 'known', 'enabled numeric SIGNAL layer 1 remains eligible');
const duplicateSdkNet = explicitClassInput();
duplicateSdkNet.netRules = [duplicateSdkNet.netRules[0], { type: 'netClass', name: 'OTHER_CLASS', Track: 'ACE_CLASS30', sub: [{ type: 'net', name: '+5V', Track: 'ACE_POWER20' }] }];
assertClassUnknown(duplicateSdkNet);
const wrongSdkOwner = explicitClassInput();
wrongSdkOwner.netRules = [{ type: 'netClass', name: 'OTHER_CLASS', Track: 'ACE_CLASS30', sub: [{ type: 'net', name: '+5V', Track: 'ACE_POWER20' }] }];
assertClassUnknown(wrongSdkOwner);
const duplicateSdkClass = explicitClassInput();
duplicateSdkClass.netRules = [duplicateSdkClass.netRules[0], { type: 'netClass', name: 'ACE_TEST_CLASS', Track: 'ACE_CLASS30', sub: [] }];
assertClassUnknown(duplicateSdkClass);
const duplicateSourceNet = explicitClassInput({ extraSourceRecords: [record('NET', '["NET", "+5V" ]', { netType: 'ACE_TEST_CLASS' }, 20)] });
assertClassUnknown(duplicateSourceNet);
const duplicateNetSelector = explicitClassInput({ extraSourceRecords: [record('RULE_SELECTOR', '["RULE_SELECTOR", ["NET", "+5V" ]]', trackSelector('ACE_POWER20'), 20)] });
assertClassUnknown(duplicateNetSelector);
const duplicateClassSelector = explicitClassInput({ extraSourceRecords: [record('RULE_SELECTOR', '["RULE_SELECTOR", ["NET_CLASS", "ACE_TEST_CLASS" ]]', trackSelector('ACE_CLASS30'), 20)] });
assertClassUnknown(duplicateClassSelector);
const sourceConflict = explicitClassInput({ extraSourceRecords: [record('RULE_SELECTOR', '["RULE_SELECTOR",["NET","+5V"]]', trackSelector('OTHER_TRACK'), 7)] });
assertClassUnknown(sourceConflict);
const sourceTombstone = explicitClassInput({ extraSourceRecords: [record('RULE_SELECTOR', '["RULE_SELECTOR",["NET_CLASS","ACE_TEST_CLASS"]]', '', 20)] });
assertClassUnknown(sourceTombstone);
const malformedSource = explicitClassInput({ extraSourceRecords: ['not-a-record'] });
assertClassUnknown(malformedSource);
const illegalNetTrack = explicitClassInput({ netSelector: { ...trackSelector('ACE_POWER20'), ruleKeyValue: { TRACK: 'UNKNOWN_TRACK' } } });
assertClassUnknown(illegalNetTrack);
const outOfRange = checkSesWidthRules(explicit20, [{ net: '+5V', layer: 1, widthMil: 100.1 }]);
assert.equal(outOfRange.status, 'violation');
assert.equal(outOfRange.violations.length, 1, 'class-inheritance confirmation does not change SES min/max violation behavior');
const noLayers = buildRoutingWidthSnapshot({ source: src, editorVersion: '4.1.78', layers: [] });
assert.doesNotThrow(() => compareDsnWidthRules(noLayers, dsn()));
assert.equal(compareDsnWidthRules(noLayers, dsn()).status, 'incomplete');
assert.deepEqual(compareDsnWidthRules(noLayers, dsn()).nets.map(entry => entry.status), ['unknown', 'unknown']);
const quoteConfigDsn = '(PCB test (parser (string_quote ") (space_in_quoted_tokens on)) (resolution mil 1000) (structure (rule (width 10))) (network (net +5V) (class +5V "+5V" (rule (width 20))) (net GND) (class GND GND (rule (width 10)))))';
assert.equal(compareDsnWidthRules(snapshot, quoteConfigDsn).nets.find(n => n.net === '+5V').dsnWidthMil, 20, 'DSN string_quote delimiter is a bare token');
const classNetSource = src.replace('"netType":null', '"netType":"CLASS30"');
const classSnapshot = buildRoutingWidthSnapshot({ source: classNetSource, editorVersion: '4.1.78', layers });
assert.equal(classSnapshot.nets.find(n => n.net === '+5V').status, 'unknown', 'NET_CLASS inheritance remains explicitly unresolved');
assert.equal(compareDsnWidthRules(classSnapshot, dsn()).nets.find(n => n.net === '+5V').status, 'unknown', 'DSN match must not override an unknown EDA net rule');
assert.equal(checkSesWidthRules(classSnapshot, [{ net: 'GND', layer: 1, widthMil: 10 }]).status, 'compliant', 'unrelated NET_CLASS uncertainty does not block a known delta line');
const classCheck = checkSesWidthRules(classSnapshot, [{ net: '+5V', layer: 1, widthMil: 10 }]);
assert.equal(classCheck.status, 'unknown', 'a changed line on unresolved NET_CLASS remains unknown');
assert.deepEqual(classCheck.violations, [], 'unknown NET_CLASS rules must not produce a violation');
assert.match(classCheck.unknowns[0], /网络 \+5V/);
assert.match(classCheck.unknowns[0], /网络类CLASS30的TRACK继承关系未确认/);
assert.doesNotMatch(classCheck.unknowns[0], /网络 GND/);
const mixedViolationUnknown = checkSesWidthRules(classSnapshot, [
	{ net: 'GND', layer: 1, widthMil: 100.1 },
	{ net: '+5V', layer: 1, widthMil: 10 },
]);
assert.equal(mixedViolationUnknown.status, 'violation', 'a confirmed violation takes precedence while unresolved network diagnostics remain visible');
assert.equal(mixedViolationUnknown.violations.length, 1);
assert.deepEqual(mixedViolationUnknown.violations[0], { lineIndex: 0, net: 'GND', widthMil: 100.1, minMil: 5, maxMil: 100 }, 'confirmed violation details remain unchanged');
assert.ok(mixedViolationUnknown.unknowns.some(reason => reason.includes('网络类CLASS30的TRACK继承关系未确认')));

assert.equal(checkSesWidthRules(snapshot, [{ net: '+5V', layer: 1, widthMil: 7.536 }, { net: '+5V', layer: 2, widthMil: 10.05 }]).status, 'compliant', 'preferred-width deviation is allowed inside min/max');
const lower = checkSesWidthRules(snapshot, [{ net: '+5V', layer: 1, widthMil: 4.9 }]);
assert.equal(lower.status, 'violation');
assert.equal(lower.violations[0].minMil, 5);
const upper = checkSesWidthRules(snapshot, [{ net: 'GND', layer: 1, widthMil: 100.1 }]);
assert.equal(upper.status, 'violation');
assert.equal(upper.violations[0].maxMil, 100);
const noVersion = buildRoutingWidthSnapshot({ source: src, editorVersion: '', layers });
const noVersionCheck = checkSesWidthRules(noVersion, [{ net: '+5V', layer: 1, widthMil: 4.9 }]);
assert.equal(noVersionCheck.status, 'unknown');
assert.deepEqual(noVersionCheck.violations, []);
assert.match(noVersionCheck.unknowns[0], /未验证editorVersion\/ruleContext\.unit组合/);
const unknownLayer = checkSesWidthRules(snapshot, [{ net: '+5V', layer: 77, widthMil: 4.9 }]);
assert.equal(unknownLayer.status, 'unknown');
assert.deepEqual(unknownLayer.violations, []);
assert.match(unknownLayer.unknowns[0], /图层 77/);
assert.match(unknownLayer.unknowns[0], /启用SIGNAL图层/);
const unknownNet = checkSesWidthRules(snapshot, [{ net: 'NOT_IN_SOURCE', layer: 1, widthMil: 4.9 }]);
assert.equal(unknownNet.status, 'unknown');
assert.deepEqual(unknownNet.violations, []);
assert.match(unknownNet.unknowns[0], /网络 NOT_IN_SOURCE/);
assert.match(unknownNet.unknowns[0], /缺少网络 NOT_IN_SOURCE/);
const invalidSesWidth = checkSesWidthRules(snapshot, [{ net: '+5V', layer: 1, widthMil: Number.NaN }]);
assert.equal(invalidSesWidth.status, 'unknown');
assert.deepEqual(invalidSesWidth.violations, []);
assert.match(invalidSesWidth.unknowns[0], /不是有限数值/);
const multipleSesUnknowns = checkSesWidthRules(classSnapshot, [{ net: '+5V', layer: 77, widthMil: Number.POSITIVE_INFINITY }]);
assert.equal(multipleSesUnknowns.status, 'unknown');
assert.deepEqual(multipleSesUnknowns.violations, []);
assert.match(multipleSesUnknowns.unknowns[0], /网络类CLASS30的TRACK继承关系未确认/);
assert.match(multipleSesUnknowns.unknowns[0], /图层 77/);
assert.match(multipleSesUnknowns.unknowns[0], /不是有限数值/);
const globalAndOtherNetUnknownSnapshot = buildRoutingWidthSnapshot({ source: `${classNetSource}\nnot-a-record`, editorVersion: '4.1.78', layers });
const globalAndOtherNetUnknown = checkSesWidthRules(globalAndOtherNetUnknownSnapshot, [{ net: 'GND', layer: 1, widthMil: 10 }]);
assert.equal(globalAndOtherNetUnknown.status, 'unknown');
assert.deepEqual(globalAndOtherNetUnknown.violations, []);
assert.match(globalAndOtherNetUnknown.unknowns[0], /源码第 \d+ 行格式无法解析/);
assert.doesNotMatch(globalAndOtherNetUnknown.unknowns[0], /网络 \+5V/);
const deletedOtherNetSnapshot = buildRoutingWidthSnapshot({ source: `${src}\n${record('NET', '["NET","OTHER"]', '', 6)}`, editorVersion: '4.1.78', layers });
const deletedOtherNetCheck = checkSesWidthRules(deletedOtherNetSnapshot, [{ net: 'GND', layer: 1, widthMil: 10 }]);
assert.equal(deletedOtherNetCheck.status, 'unknown');
assert.deepEqual(deletedOtherNetCheck.violations, []);
assert.doesNotMatch(deletedOtherNetCheck.unknowns[0], /OTHER/);
const onlyOtherNetTombstone = structuredClone(snapshot);
onlyOtherNetTombstone.globalStatus = 'unknown';
onlyOtherNetTombstone.unknowns = ['NET OTHER存在删除记录'];
const onlyOtherNetTombstoneCheck = checkSesWidthRules(onlyOtherNetTombstone, [{ net: 'GND', layer: 1, widthMil: 10 }]);
assert.equal(onlyOtherNetTombstoneCheck.status, 'unknown');
assert.deepEqual(onlyOtherNetTombstoneCheck.violations, []);
assert.match(onlyOtherNetTombstoneCheck.unknowns[0], /全局TRACK规则状态未知/);
assert.doesNotMatch(onlyOtherNetTombstoneCheck.unknowns[0], /OTHER/);
const unknownLayerWidthSnapshot = structuredClone(snapshot);
unknownLayerWidthSnapshot.nets.find(net => net.net === '+5V').layers[0].status = 'unknown';
const unknownLayerWidth = checkSesWidthRules(unknownLayerWidthSnapshot, [{ net: '+5V', layer: 1, widthMil: 10 }]);
assert.equal(unknownLayerWidth.status, 'unknown');
assert.deepEqual(unknownLayerWidth.violations, []);
assert.match(unknownLayerWidth.unknowns[0], /图层 1 的有效宽度规则状态为 unknown/);
const lengthOnlyData = (overrides = {}) => ({ ruleOrder: 4, ruleKeyValue: { NET_LENGTH_TOLERANCE: ['LENGTH_DEFAULT', null] }, copperValue: {}, innerPlaneValue: {}, parent: null, ...overrides });
const blankLengthSelector = record('RULE_SELECTOR', selectorId('NET', ''), lengthOnlyData(), 6);
const blankLengthSnapshot = buildRoutingWidthSnapshot({ source: `${src}\n${blankLengthSelector}`, editorVersion: '4.1.78', layers });
assert.equal(blankLengthSnapshot.globalStatus, 'known', 'confirmed blank-name length-only selector does not poison global TRACK width status');
assert.equal(blankLengthSnapshot.unknowns.some(x => x.includes('网络名为空的TRACK选择器')), false);
assert.equal(blankLengthSnapshot.nets.find(n => n.net === '+5V').status, 'known');
assert.equal(blankLengthSnapshot.nets.find(n => n.net === '+5V').layers[0].preferredMil, 20);
const namedLengthSelector = record('RULE_SELECTOR', selectorId('NET', 'GND'), lengthOnlyData({ ruleKeyValue: { NET_LENGTH_TOLERANCE: ['LENGTH_DEFAULT', 'GND'] } }), 6);
const namedLengthSource = `${src}\n${namedLengthSelector}`;
const namedLengthSnapshot = buildRoutingWidthSnapshot({ source: namedLengthSource, editorVersion: '4.1.78', layers });
assert.equal(namedLengthSnapshot.globalStatus, 'known');
assert.equal(namedLengthSnapshot.nets.find(n => n.net === 'GND').status, 'known');
assert.equal(namedLengthSnapshot.nets.find(n => n.net === 'GND').ruleKey, 'default', 'named length-only selector must leave TRACK selection at the default');
assert.equal(namedLengthSnapshot.nets.find(n => n.net === 'GND').layers[0].preferredMil, 10);
function assertBlankSelectorRemainsProtected(data, message = 'invalid shape') {
	const protectedSnapshot = buildRoutingWidthSnapshot({ source: `${src}\n${record('RULE_SELECTOR', selectorId('NET', ''), data, 6)}`, editorVersion: '4.1.78', layers });
	assert.equal(protectedSnapshot.globalStatus, 'unknown', `${message}: global TRACK status remains protected`);
	assert.ok(protectedSnapshot.unknowns.some(x => x.includes('网络名为空的TRACK选择器')), `${message}: blank selector warning remains`);
}
assertBlankSelectorRemainsProtected({ ...lengthOnlyData(), ruleKeyValue: { NET_LENGTH_TOLERANCE: ['LENGTH_DEFAULT', null], EXTRA: 'x' } }, 'unknown rule key');
assertBlankSelectorRemainsProtected(lengthOnlyData({ parent: 'parent-rule' }), 'non-null parent');
assertBlankSelectorRemainsProtected(lengthOnlyData({ copperValue: { NET: 'x' } }), 'non-empty copper value');
assertBlankSelectorRemainsProtected(lengthOnlyData({ copperValue: [] }), 'array copper value');
const missingCopperValue = lengthOnlyData();
delete missingCopperValue.copperValue;
assertBlankSelectorRemainsProtected(missingCopperValue, 'missing copper value');
assertBlankSelectorRemainsProtected(lengthOnlyData({ innerPlaneValue: { NET: 'x' } }), 'non-empty inner-plane value');
assertBlankSelectorRemainsProtected(lengthOnlyData({ innerPlaneValue: [] }), 'array inner-plane value');
const missingInnerPlaneValue = lengthOnlyData();
delete missingInnerPlaneValue.innerPlaneValue;
assertBlankSelectorRemainsProtected(missingInnerPlaneValue, 'missing inner-plane value');
assertBlankSelectorRemainsProtected(lengthOnlyData({ ruleOrder: 3 }), 'rule order mismatch');
assertBlankSelectorRemainsProtected({ ...lengthOnlyData(), ruleKeyValue: [] }, 'array ruleKeyValue');
assertBlankSelectorRemainsProtected({ ...lengthOnlyData(), ruleKeyValue: 'NET_LENGTH_TOLERANCE' }, 'non-object ruleKeyValue');
assertBlankSelectorRemainsProtected({ ...lengthOnlyData(), ruleKeyValue: { NET_LENGTH_TOLERANCE: [''] } }, 'malformed length value');
assertBlankSelectorRemainsProtected({ ...lengthOnlyData(), ruleKeyValue: { NET_LENGTH_TOLERANCE: ['LENGTH_DEFAULT', null, 'extra'] } }, 'overlong length value');
assertBlankSelectorRemainsProtected({ ...lengthOnlyData(), ruleKeyValue: { NET_LENGTH_TOLERANCE: [5, null] } }, 'non-string rule name');
assertBlankSelectorRemainsProtected({ ...lengthOnlyData(), ruleKeyValue: { NET_LENGTH_TOLERANCE: ['LENGTH_DEFAULT', 5] } }, 'non-string target');
const nonNetLengthSelector = buildRoutingWidthSnapshot({ source: `${src}\n${record('RULE_SELECTOR', selectorId('NET_CLASS', ''), lengthOnlyData(), 6)}`, editorVersion: '4.1.78', layers });
assert.equal(nonNetLengthSelector.globalStatus, 'unknown', 'non-NET selector scope is not skipped');
assert.ok(nonNetLengthSelector.unknowns.some(x => x.includes('NET_CLASS')));
const malformedSelectorId = buildRoutingWidthSnapshot({ source: `${src}\n${record('RULE_SELECTOR', '["RULE_SELECTOR",["NET",null]]', lengthOnlyData(), 6)}`, editorVersion: '4.1.78', layers });
assert.equal(malformedSelectorId.globalStatus, 'unknown', 'malformed selector ID is not skipped');
const malformedHeaderId = `${JSON.stringify({ type: 'RULE_SELECTOR', ticket: 6, id: ['RULE_SELECTOR', ['NET', '']] })}||${JSON.stringify(lengthOnlyData())}|`;
const malformedHeaderIdSnapshot = buildRoutingWidthSnapshot({ source: `${src}\n${malformedHeaderId}`, editorVersion: '4.1.78', layers });
assert.equal(malformedHeaderIdSnapshot.globalStatus, 'unknown', 'non-string selector ID is not treated as confirmed');
const conflictingBlankSelectors = `${src}\n${record('RULE_SELECTOR', selectorId('NET', ''), lengthOnlyData(), 6)}\n${record('RULE_SELECTOR', selectorId('NET', ''), lengthOnlyData(), 6)}`;
const conflictingBlankSnapshot = buildRoutingWidthSnapshot({ source: conflictingBlankSelectors, editorVersion: '4.1.78', layers });
assert.equal(conflictingBlankSnapshot.globalStatus, 'unknown', 'same-ticket conflict remains unknown instead of being suppressed');
assert.ok(conflictingBlankSnapshot.unknowns.some(x => x.includes('相同最新ticket的冲突记录')));
const deletedBlankSnapshot = buildRoutingWidthSnapshot({ source: `${src}\n${record('RULE_SELECTOR', selectorId('NET', ''), '', 6)}`, editorVersion: '4.1.78', layers });
assert.equal(deletedBlankSnapshot.globalStatus, 'known', 'existing blank-selector deletion behavior is unchanged');
assert.equal(deletedBlankSnapshot.unknowns.some(x => x.includes('网络名为空的TRACK选择器')), false);
const wrongVersionBlankSnapshot = buildRoutingWidthSnapshot({ source: `${src}\n${blankLengthSelector}`, editorVersion: '4.1.79', layers });
assert.equal(wrongVersionBlankSnapshot.globalStatus, 'unknown', 'selector exception is version-gated');
assert.ok(wrongVersionBlankSnapshot.unknowns.some(x => x.includes('网络名为空的TRACK选择器')));
const mixedLayerSnapshot = buildRoutingWidthSnapshot({ source: src, editorVersion: '4.1.78', layers: [
	{ layerId: 1, type: 'SIGNAL', status: 1, layerName: 'Top Layer' },
	{ layerId: 2, type: 'SIGNAL', status: 2, layerName: 'Bottom Layer' },
	{ layerId: 17, type: 'SIGNAL', status: 0, layerName: 'Unused Inner Layer' },
] });
assert.equal(mixedLayerSnapshot.defaultRule.layers.length, 2, 'explicitly unused SIGNAL layers are excluded while enabled layers remain');
assert.equal(mixedLayerSnapshot.unknowns.some(x => x.includes('第3项')), false, 'unused layer must not be reported as unknown');
assert.equal(mixedLayerSnapshot.unknowns.some(x => x.includes('没有可确认的启用SIGNAL图层')), false);
const allUnusedLayers = buildRoutingWidthSnapshot({ source: src, editorVersion: '4.1.78', layers: [
	{ layerId: 17, type: 'SIGNAL', status: 0, layerName: 'Unused Inner Layer 1' },
	{ layerId: 18, type: 'SIGNAL', layerStatus: 0, layerName: 'Unused Inner Layer 2' },
] });
assert.ok(allUnusedLayers.unknowns.some(x => x.includes('没有可确认的启用SIGNAL图层')), 'all-unused layers must still leave enabled-layer state unknown');
assert.ok(!allUnusedLayers.unknowns.some(x => x.includes('第1项') || x.includes('第2项')), 'explicitly unused layers are not malformed');
assert.equal(checkSesWidthRules(allUnusedLayers, [{ net: '+5V', layer: 1, widthMil: 4.9 }]).status, 'unknown');
for (const invalidStatus of [undefined, null, -1, 3, '0', '1']) {
	const invalidLayer = { layerId: 1, type: 'SIGNAL', layerName: 'Unknown Status' };
	if (invalidStatus !== undefined)
		invalidLayer.status = invalidStatus;
	const invalidLayerSnapshot = buildRoutingWidthSnapshot({ source: src, editorVersion: '4.1.78', layers: [invalidLayer] });
	assert.ok(invalidLayerSnapshot.unknowns.some(x => x.includes('不是可确认的启用SIGNAL图层')), `status ${String(invalidStatus)} remains unknown`);
}
const unsupported = buildRoutingWidthSnapshot({ source: src, editorVersion: '5.0', layers });
assert.ok(unsupported.unknowns.some(x => x.includes('unit')));
const missing = buildRoutingWidthSnapshot({ source: src.replace('stroMax":100', 'missing":100'), editorVersion: '4.1.78', layers });
assert.equal(missing.defaultRule.status, 'unknown');
const conflictSrc = `${src}\n${record('RULE_SELECTOR', '["RULE_SELECTOR",["NET","+5V"]]', { ruleKeyValue: { TRACK: 'OTHER' } }, 5)}`;
assert.ok(buildRoutingWidthSnapshot({ source: conflictSrc, editorVersion: '4.1.78', layers }).unknowns.some(x => x.includes('冲突')));
assert.equal(checkSesWidthRules(buildRoutingWidthSnapshot({ source: conflictSrc, editorVersion: '4.1.78', layers }), [{ net: '+5V', layer: 1, widthMil: 4.9 }]).status, 'unknown');
assert.deepEqual(checkSesWidthRules(buildRoutingWidthSnapshot({ source: conflictSrc, editorVersion: '4.1.78', layers }), [{ net: '+5V', layer: 1, widthMil: 4.9 }]).violations, []);
const selectorParent = src.replace('"parent":null', '"parent":"parent-rule"');
const parentSnapshot = buildRoutingWidthSnapshot({ source: selectorParent, editorVersion: '4.1.78', layers });
assert.equal(parentSnapshot.nets.find(net => net.net === '+5V').status, 'unknown');
assert.equal(checkSesWidthRules(parentSnapshot, [{ net: '+5V', layer: 1, widthMil: 4.9 }]).status, 'unknown');
assert.deepEqual(checkSesWidthRules(parentSnapshot, [{ net: '+5V', layer: 1, widthMil: 4.9 }]).violations, []);
const selectedUnitSource = src.replace('"ruleState":"NORMAL","ruleContext":{"unit":"mm","track":{"isOpen":true,"content":[{"layerId":1,"stroMin":5,"stroDef":20,"stroMax":100}]}', '"ruleState":"NORMAL","ruleContext":{"unit":"inch","track":{"isOpen":true,"content":[{"layerId":1,"stroMin":5,"stroDef":20,"stroMax":100}]}');
const selectedUnitSnapshot = buildRoutingWidthSnapshot({ source: selectedUnitSource, editorVersion: '4.1.78', layers });
assert.equal(selectedUnitSnapshot.nets.find(net => net.net === '+5V').status, 'unknown');
assert.equal(checkSesWidthRules(selectedUnitSnapshot, [{ net: '+5V', layer: 1, widthMil: 4.9 }]).status, 'unknown');
assert.deepEqual(checkSesWidthRules(selectedUnitSnapshot, [{ net: '+5V', layer: 1, widthMil: 4.9 }]).violations, []);
const malformed = buildRoutingWidthSnapshot({ source: `${src}\nnot-a-record`, editorVersion: '4.1.78', layers });
assert.equal(checkSesWidthRules(malformed, [{ net: '+5V', layer: 1, widthMil: 4.9 }]).status, 'unknown');
assert.deepEqual(checkSesWidthRules(malformed, [{ net: '+5V', layer: 1, widthMil: 4.9 }]).violations, []);
const selectorTombstone = `${src}\n${record('RULE_SELECTOR', '["RULE_SELECTOR",["NET","+5V"]]', '', 6)}`;
assert.equal(checkSesWidthRules(buildRoutingWidthSnapshot({ source: selectorTombstone, editorVersion: '4.1.78', layers }), [{ net: '+5V', layer: 1, widthMil: 4.9 }]).status, 'unknown');
assert.deepEqual(checkSesWidthRules(buildRoutingWidthSnapshot({ source: selectorTombstone, editorVersion: '4.1.78', layers }), [{ net: '+5V', layer: 1, widthMil: 4.9 }]).violations, []);
const apiConflict = buildRoutingWidthSnapshot({ source: src, editorVersion: '4.1.78', layers, netRules: [{ type: 'net', name: '+5V', Track: 'NOT_POWER20' }] });
assert.equal(checkSesWidthRules(apiConflict, [{ net: '+5V', layer: 1, widthMil: 4.9 }]).status, 'unknown');
assert.deepEqual(checkSesWidthRules(apiConflict, [{ net: '+5V', layer: 1, widthMil: 4.9 }]).violations, []);
assert.equal(compareDsnWidthRules(snapshot, dsn().replace('(width 10.05)', '(width 10.05) (width 9)')).status, 'incomplete');
const badMembershipDsn = dsn().replace('(class +5V "+5V"', '(class +5V "MISSING"');
assert.equal(compareDsnWidthRules(snapshot, badMembershipDsn).nets.find(net => net.net === '+5V').status, 'unknown');
assert.equal(compareDsnWidthRules(globalAndOtherNetUnknownSnapshot, dsn()).nets.find(net => net.net === '+5V').status, 'unknown', 'a DSN match cannot make a net determinate when global EDA rules are unknown');
const scalarOnlyDsn = dsn().replace(/\(structure .*?\) \(network/s, '(network');
assert.equal(compareDsnWidthRules(snapshot, scalarOnlyDsn).nets.find(net => net.net === '+5V').dsnWidthMil, 20, 'a reduced class scalar remains comparable without structure layer declarations');
const layerRuleDsn = dsn().replace('(structure (rule', '(structure (layer_rule TopLayer (rule (width 8))) (rule');
assert.equal(compareDsnWidthRules(snapshot, layerRuleDsn).nets.find(net => net.net === '+5V').status, 'unknown');
const structureLayerRuleDsn = dsn().replace('(structure (rule (width 10.05))', '(structure (layer TopLayer (rule (width 20))) (rule (width 10.05))');
assert.equal(compareDsnWidthRules(snapshot, structureLayerRuleDsn).nets.find(net => net.net === '+5V').status, 'unknown');
const classLayerRuleDsn = dsn().replace('(class +5V "+5V" (rule', '(class +5V "+5V" (layer_rule TopLayer (rule (width 20))) (rule');
assert.equal(compareDsnWidthRules(snapshot, classLayerRuleDsn).nets.find(net => net.net === '+5V').status, 'unknown');
const mappedLayerDsn = dsn().replace('(structure (rule (width 10.05))', '(structure (layer TopLayer (type signal)) (layer BottomLayer (type signal)) (rule (width 10.05))');
const mappedClassLayerDsn = mappedLayerDsn.replace('(class +5V "+5V" (rule', '(class +5V "+5V" (layer_rule TopLayer (rule (width 20))) (rule');
assert.equal(compareDsnWidthRules(snapshot, mappedClassLayerDsn).nets.find(net => net.net === '+5V').status, 'matched', 'an equivalent class layer_rule uses exact DSN layer name and SDK layer ID evidence');
const duplicateSignalLayerDsn = mappedClassLayerDsn.replace('(layer BottomLayer (type signal))', '(layer TopLayer (type signal))');
assert.equal(compareDsnWidthRules(snapshot, duplicateSignalLayerDsn).nets.find(net => net.net === '+5V').status, 'unknown', 'duplicate mapped signal layers are rejected when a class layer_rule is present');
const unknownSignalLayerDsn = mappedClassLayerDsn.replace('(layer BottomLayer (type signal))', '(layer UnknownCopper (type signal))');
assert.equal(compareDsnWidthRules(snapshot, unknownSignalLayerDsn).nets.find(net => net.net === '+5V').status, 'unknown', 'unknown signal layer names are rejected when a class layer_rule is present');
const extraSignalLayerDsn = mappedClassLayerDsn.replace('(structure (layer TopLayer', '(structure (layer Inner1 (type signal)) (layer TopLayer');
assert.equal(compareDsnWidthRules(snapshot, extraSignalLayerDsn).nets.find(net => net.net === '+5V').status, 'unknown', 'extra signal layers outside the SDK enabled set are rejected for class layer_rule');
const changedClassLayerDsn = mappedLayerDsn.replace('(class +5V "+5V" (rule (width 20))', '(class +5V "+5V" (rule (width 20)) (layer_rule BottomLayer (rule (width 30)))');
const changedClassLayerEntry = compareDsnWidthRules(snapshot, changedClassLayerDsn).nets.find(net => net.net === '+5V');
assert.equal(changedClassLayerEntry.status, 'mismatch', 'class layer_rule is compared against the preferred width on its named layer');
assert.deepEqual(changedClassLayerEntry.layers.map(layer => [layer.name, layer.dsnWidthMil, layer.status]), [['Top Layer', 20, 'matched'], ['Bottom Layer', 30, 'mismatch']]);

const real = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/routing-width-real-host.json'), 'utf8'));
const realSnapshot = buildRoutingWidthSnapshot({ source: real.source, editorVersion: real.editorVersion, layers });
const realComparison = compareDsnWidthRules(realSnapshot, real.dsn);
assert.equal(realComparison.defaultRule.status, 'mismatch', 'actual DSN global width is 10.05 while EDA preferred default is 10');
assert.equal(realComparison.defaultRule.withinEdaBounds, true);
assert.equal(realComparison.nets.find(n => n.net === '+5V').status, 'matched', 'actual power-net class width is 20');
assert.equal(realComparison.nets.find(n => n.net === 'ACE_VIA').status, 'matched', 'actual default-net class width is 10');
const defaultLayerDsn = `(PCB x (resolution mil 1000) (structure
 (rule (width 15.05))
 (layer TopLayer (type signal) (rule (width 15)))
 (layer Inner1 (type signal) (rule (width 27)))
 (layer Inner2 (type signal) (rule (width 27)))
 (layer BottomLayer (type signal) (rule (width 27))))
 (network (net +5V) (class +5V "+5V" (rule (width 20)) (layer_rule BottomLayer (rule (width 30))))) )`;
const layerAwareSnapshot = {
	...realSnapshot,
	defaultRule: { ...realSnapshot.defaultRule, layers: [
		{ layerId: 1, name: 'Top Layer', minMil: 10, preferredMil: 15, maxMil: 35, status: 'known' },
		{ layerId: 15, name: 'Inner Layer 1', minMil: 10, preferredMil: 27, maxMil: 35, status: 'known' },
		{ layerId: 16, name: 'Inner Layer 2', minMil: 10, preferredMil: 27, maxMil: 35, status: 'known' },
		{ layerId: 2, name: 'Bottom Layer', minMil: 20, preferredMil: 27, maxMil: 40, status: 'known' },
	] },
	nets: [{ ...realSnapshot.nets.find(net => net.net === '+5V'), layers: [
		{ layerId: 1, name: 'Top Layer', minMil: 10, preferredMil: 20, maxMil: 35, status: 'known' },
		{ layerId: 15, name: 'Inner Layer 1', minMil: 10, preferredMil: 20, maxMil: 35, status: 'known' },
		{ layerId: 16, name: 'Inner Layer 2', minMil: 10, preferredMil: 20, maxMil: 35, status: 'known' },
		{ layerId: 2, name: 'Bottom Layer', minMil: 20, preferredMil: 30, maxMil: 40, status: 'known' },
	] }],
};
const layerAwareComparison = compareDsnWidthRules(layerAwareSnapshot, defaultLayerDsn);
assert.equal(layerAwareComparison.defaultRule.status, 'matched', 'default-layer width overrides compare against each SDK layer');
assert.deepEqual(layerAwareComparison.defaultRule.layers.map(layer => [layer.layerId, layer.dsnWidthMil, layer.status]), [
	[1, 15, 'matched'], [15, 27, 'matched'], [16, 27, 'matched'], [2, 27, 'matched'],
]);
assert.deepEqual(layerAwareComparison.nets[0].layers.map(layer => [layer.layerId, layer.dsnWidthMil, layer.status]), [
	[1, 20, 'matched'], [15, 20, 'matched'], [16, 20, 'matched'], [2, 30, 'matched'],
], 'explicit class base and layer_rule keep precedence over structure default layers');
const classLayerClearanceComparison = compareDsnWidthRules(layerAwareSnapshot, defaultLayerDsn.replace('(rule (width 30))', '(rule (width 30) (clearance 6))'));
assert.equal(classLayerClearanceComparison.nets[0].status, 'matched', 'class layer_rule with a supported clearance remains comparable');
const noBaseDefaultDsn = defaultLayerDsn.replace('(rule (width 15.05))', '');
const noBaseComparison = compareDsnWidthRules(layerAwareSnapshot, noBaseDefaultDsn);
assert.equal(noBaseComparison.defaultRule.status, 'matched', 'complete exact default layer overrides determine DEFAULT when structure base width is absent');
assert.deepEqual(noBaseComparison.defaultRule.layers.map(layer => [layer.layerId, layer.dsnWidthMil, layer.status]), [
	[1, 15, 'matched'], [15, 27, 'matched'], [16, 27, 'matched'], [2, 27, 'matched'],
]);
assert.deepEqual(noBaseComparison.nets[0].layers.map(layer => [layer.layerId, layer.dsnWidthMil, layer.status]), [
	[1, 20, 'matched'], [15, 20, 'matched'], [16, 20, 'matched'], [2, 30, 'matched'],
], 'class rules remain effective when DEFAULT has no structure base');
for (const [label, malformedBase] of [
	['zero', '(rule (width 0))'],
	['duplicate', '(rule (width 20)) (rule (width 21))'],
	['extra field', '(rule (width 20) (extra 1))'],
]) {
	const invalidBaseDsn = defaultLayerDsn.replace('(rule (width 15.05))', malformedBase);
	const invalidBaseComparison = compareDsnWidthRules(layerAwareSnapshot, invalidBaseDsn);
	assert.equal(invalidBaseComparison.defaultRule.status, 'unknown', `${label} structure base is invalid even with complete exact layer overrides`);
	assert.equal(invalidBaseComparison.status, 'incomplete', `${label} structure base keeps the overall result unknown`);
	assert.equal(invalidBaseComparison.nets[0].status, 'matched', `${label} default base does not hide the independently valid class result`);
}
const noBaseMissingLayerDefault = compareDsnWidthRules(layerAwareSnapshot, noBaseDefaultDsn.replace('(layer Inner2 (type signal) (rule (width 27)))', '(layer Inner2 (type signal))'));
assert.equal(noBaseMissingLayerDefault.defaultRule.status, 'unknown', 'a missing explicit default layer rule cannot fall back to an implicit base');
const noBaseNoLayerDefaults = noBaseDefaultDsn
	.replace('(layer TopLayer (type signal) (rule (width 15)))', '(layer TopLayer (type signal))')
	.replace('(layer Inner1 (type signal) (rule (width 27)))', '(layer Inner1 (type signal))')
	.replace('(layer Inner2 (type signal) (rule (width 27)))', '(layer Inner2 (type signal))')
	.replace('(layer BottomLayer (type signal) (rule (width 27)))', '(layer BottomLayer (type signal))');
assert.equal(compareDsnWidthRules(layerAwareSnapshot, noBaseNoLayerDefaults).defaultRule.status, 'unknown', 'no base and no explicit default layer rules remain unknown');
const sameBoundsDefaultSnapshot = {
	...layerAwareSnapshot,
	defaultRule: { ...layerAwareSnapshot.defaultRule, layers: layerAwareSnapshot.defaultRule.layers.map(layer => ({ ...layer, minMil: 5, preferredMil: 15, maxMil: 35 })) },
};
const oneDefaultLayerMismatchDsn = defaultLayerDsn
	.replace('(layer Inner1 (type signal) (rule (width 27)))', '(layer Inner1 (type signal) (rule (width 15)))')
	.replace('(layer Inner2 (type signal) (rule (width 27)))', '(layer Inner2 (type signal) (rule (width 16)))')
	.replace('(layer BottomLayer (type signal) (rule (width 27)))', '(layer BottomLayer (type signal) (rule (width 15)))');
const oneDefaultLayerMismatch = compareDsnWidthRules(sameBoundsDefaultSnapshot, oneDefaultLayerMismatchDsn);
assert.equal(oneDefaultLayerMismatch.defaultRule.status, 'mismatch');
assert.equal(oneDefaultLayerMismatch.defaultRule.layers.length, 4, 'a differing width on one DSN layer prevents scalar collapsing even when EDA bounds match');
assert.deepEqual(oneDefaultLayerMismatch.defaultRule.layers.map(layer => layer.status), ['matched', 'matched', 'mismatch', 'matched']);
const reopenedB6 = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/routing-width-empty-net-real-host.json'), 'utf8'));
const reopenedB6Snapshot = buildRoutingWidthSnapshot({ source: reopenedB6.source, editorVersion: reopenedB6.editorVersion, layers: reopenedB6.layers, netRules: reopenedB6.netRules });
const reopenedB6DefaultNet = reopenedB6Snapshot.nets.find(net => net.net === 'ACE_VIA');
assert.equal(reopenedB6DefaultNet.status, 'known', 'real reopened v0.96 source, SDK class association, and DEFAULT selector confirm the default-net rule');
assert.equal(reopenedB6DefaultNet.ruleKey, reopenedB6Snapshot.defaultRule.ruleKey);
assert.deepEqual({ minMil: reopenedB6DefaultNet.layers[0].minMil, preferredMil: reopenedB6DefaultNet.layers[0].preferredMil, maxMil: reopenedB6DefaultNet.layers[0].maxMil }, { minMil: 22, preferredMil: 27, maxMil: 38 });
assert.equal(reopenedB6Snapshot.nets.find(net => net.net === '+5V').layers[0].preferredMil, 30, 'the explicit class-selected net remains on its class rule');
const reopenedB6DsnComparison = compareDsnWidthRules(reopenedB6Snapshot, reopenedB6.dsn);
assert.equal(reopenedB6DsnComparison.nets.find(net => net.net === 'ACE_VIA').status, 'matched', 'the actual reopened DSN net width 27 matches the confirmed DEFAULT preferred width');
assert.equal(reopenedB6DsnComparison.nets.find(net => net.net === '+5V').status, 'matched', 'the actual reopened DSN net width 30 remains matched to its class-selected rule');
console.log('routing-width-rules regression: PASS');
