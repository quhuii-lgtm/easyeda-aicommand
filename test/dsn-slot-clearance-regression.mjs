import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: 'export { augmentDsnSlotClearances, repairDsnClassNetReferences } from \'../src/engine/dsnExport.ts\'; export { slotClearanceFromRuleConfiguration } from \'../src/pcb/dsnSlots.ts\'',
			resolveDir: resolve(root, 'test'),
			sourcefile: 'dsn-slot-clearance-regression-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { augmentDsnSlotClearances, repairDsnClassNetReferences, slotClearanceFromRuleConfiguration } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
	const composition = JSON.parse(readFileSync(resolve(root, 'test/fixtures/routing-slot-class-real-host.json'), 'utf8'));
	const compositionSource = composition.source;
	const compositionSdk = composition.netRules;
	const nestedAccepted = slotClearanceFromRuleConfiguration(composition.rules, compositionSource, composition.dsn, compositionSdk);
	assert.ok(nestedAccepted, 'actual four-net composition snapshot and fanout baseline rules accept exact class/net default SAFE mapping');
	const assertRejectsComposition = (sourceText = compositionSource, sdkRules = compositionSdk) => {
		assert.equal(slotClearanceFromRuleConfiguration(composition.rules, sourceText, composition.dsn, sdkRules), undefined);
	};
	const sdkWith = mutate => {
		const copy = structuredClone(compositionSdk);
		mutate(copy.find(row => row.type === 'netClass'));
		return copy;
	};
	assertRejectsComposition(compositionSource, sdkWith(row => { row['Safe Spacing'] = 20; }));
	assertRejectsComposition(compositionSource, sdkWith(row => { row.sub[0]['Safe Spacing'] = 20; }));
	assertRejectsComposition(compositionSource.replace('"netType":"ACE_TEST_CLASS"', '"netType":null'));
	assertRejectsComposition(compositionSource.replace(/\n(\{"type":"RULE_SELECTOR","ticket":\d+,"id":"\[\\"RULE_SELECTOR\\",\[\\"NET_CLASS\\",\\"ACE_TEST_CLASS\\"\]\]"\}[^\n]*)/u, '\n$1\n$1'));
	assertRejectsComposition(compositionSource.replace('"parent":null}', '"parent":"ACE_TEST_CLASS"}'));
	assertRejectsComposition(compositionSource.replace('"innerPlaneValue":{}', '"innerPlaneValue":{"SAFE":"default"}'));
	assertRejectsComposition(compositionSource.replace('"ruleKeyValue":{"TRACK":"ACE_CLASS30"}', '"ruleKeyValue":{"TRACK":"ACE_CLASS30","EXTRA":"x"}'));
	assertRejectsComposition(compositionSource.replace('"parent":null}', '"parent":null,"extra":true}'));
	const flatSelectorOnly = compositionSource.split('\n').filter(line => {
		const separator = line.indexOf('||');
		if (separator < 0) return true;
		try {
			const header = JSON.parse(line.slice(0, separator));
			if (header.type !== 'RULE_SELECTOR') return true;
			const key = JSON.parse(header.id);
			return key[1]?.[0] !== 'NET_CLASS';
		} catch { return true; }
	}).join('\n');
	assertRejectsComposition(flatSelectorOnly);
	const editPads = edit => compositionSource.split('\n').map(line => {
		const separator = line.indexOf('||');
		if (separator < 0) return line;
		let header; let data;
		try { header = JSON.parse(line.slice(0, separator)); data = JSON.parse(line.slice(separator + 2).replace(/\|$/u, '')); } catch { return line; }
		if (header.type !== 'PAD' || !['ACE113_P', 'ACE113_N'].includes(data.netName)) return line;
		const result = edit({ header, data, line });
		return result === true ? line : result;
	}).filter(Boolean).join('\n');
	const withoutIndependentNet = name => compositionSource.split('\n').filter(line => {
		const separator = line.indexOf('||');
		if (separator < 0) return true;
		try { return !(JSON.parse(line.slice(0, separator)).type === 'PAD' && JSON.parse(line.slice(separator + 2).replace(/\|$/u, '')).netName === name); } catch { return true; }
	}).join('\n');
	for (const name of ['ACE113_P', 'ACE113_N'])
		assertRejectsComposition(withoutIndependentNet(name), compositionSdk);
	assertRejectsComposition(editPads(({ data }) => data.netName === 'ACE113_P' ? `{"type":"PAD","ticket":200,"id":"bad-net"}||${JSON.stringify({ ...data, netName: '' })}|` : true));
	assertRejectsComposition(editPads(({ data }) => data.netName === 'ACE113_P' ? `{"type":"PAD","ticket":200,"id":"bad-type"}||${JSON.stringify({ ...data, padType: 'HOLE' })}|` : true));
	assertRejectsComposition(editPads(({ data }) => data.netName === 'ACE113_P' ? `{"type":"PAD","ticket":200,"id":"bad-layer"}||${JSON.stringify({ ...data, layerId: 13 })}|` : true));
	assertRejectsComposition(editPads(({ data }) => data.netName === 'ACE113_P' ? `{"type":"PAD","ticket":200,"id":"bad-parent"}||${JSON.stringify({ ...data, parentId: 'component' })}|` : true));
	assertRejectsComposition(editPads(({ data }) => data.netName === 'ACE113_P' ? `{"type":"PAD","ticket":200,"id":"bad-shape"}||${JSON.stringify({ ...data, defaultPad: { ...data.defaultPad, width: 0 } })}|` : true));
	assertRejectsComposition(editPads(({ data }) => data.netName === 'ACE113_P' ? `{"type":"PAD","ticket":200,"id":"bad-name-type"}||${JSON.stringify({ ...data, netName: 5 })}|` : true));
	assertRejectsComposition(editPads(({ data }) => data.netName === 'ACE113_P' ? `{"type":"PAD","ticket":200,"id":"other-net"}||${JSON.stringify({ ...data, netName: 'ACE113_N' })}|` : true));
	const ace113Pad = compositionSource.split('\n').find(line => line.includes('"type":"PAD"') && line.includes('"netName":"ACE113_P"'));
	const ace113PadParts = ace113Pad.split('||');
	const conflictingPad = `${ace113PadParts[0]}||${JSON.stringify({ ...JSON.parse(ace113PadParts[1].replace(/\|$/u, '')), netName: 'ACE113_N' })}|`;
	assertRejectsComposition(`${compositionSource}\n${conflictingPad}`);
	assertRejectsComposition(compositionSource.replace(ace113Pad, `${conflictingPad}\n${ace113Pad}`));
	const ace113Net = compositionSource.split('\n').find(line => {
		const separator = line.indexOf('||');
		if (separator < 0) return false;
		try { const header = JSON.parse(line.slice(0, separator)); return header.type === 'NET' && JSON.parse(header.id)[1] === 'ACE113_P'; } catch { return false; }
	});
	const conflictingNet = ace113Net.replace('"netType":null', '"netType":"ACE_TEST_CLASS"');
	assertRejectsComposition(`${compositionSource}\n${conflictingNet}`);
	assertRejectsComposition(compositionSource.replace(ace113Net, `${conflictingNet}\n${ace113Net}`));
	const flatNetRules = compositionSdk.flatMap(row => row.type === 'netClass' ? row.sub : [row]);
	const flatSource = compositionSource.split('\n').map(line => {
		const separator = line.indexOf('||');
		if (separator < 0) return line;
		try {
			const header = JSON.parse(line.slice(0, separator));
			if (header.type === 'RULE_SELECTOR' && JSON.parse(header.id)[1]?.[0] === 'NET_CLASS') return '';
			if (header.type === 'NET') {
				const data = JSON.parse(line.slice(separator + 2).replace(/\|$/u, ''));
				data.netType = null;
				return `${line.slice(0, separator)}||${JSON.stringify(data)}|`;
			}
			if (header.type === 'RULE_SELECTOR') {
				const key = JSON.parse(header.id);
				if (key[1]?.[0] === 'NET' && key[1][1] === 'ACE113_P') {
					const data = JSON.parse(line.slice(separator + 2).replace(/\|$/u, ''));
					data.ruleKeyValue = { SAFE: 'default', CUSTOM: 'retained-flat-key' };
					return `${line.slice(0, separator)}||${JSON.stringify(data)}|`;
				}
			}
		} catch { return line; }
		return line;
	}).filter(Boolean).join('\n');
	assert.ok(slotClearanceFromRuleConfiguration(composition.rules, flatSource, composition.dsn, flatNetRules), 'legacy flat NET path retains its prior SAFE=default and otherwise uninspected ruleKeyValue behavior');
	const classWithEmptySelectorAndDefaultSdk = compositionSource.replace('"ruleKeyValue":{"TRACK":"ACE_CLASS30"}', '"ruleKeyValue":{}');
	const defaultSdkClass = sdkWith(row => { row.Track = 'default'; });
	assertRejectsComposition(classWithEmptySelectorAndDefaultSdk, defaultSdkClass);
	const duplicateIndependentPad = compositionSource.replace(/(\{"type":"PAD","ticket":163[^\n]*\|)/u, '$1\n{"type":"PAD","ticket":200,"id":"extra-pad"}||' + JSON.stringify({ ...JSON.parse(compositionSource.split('\n').find(line => line.startsWith('{"type":"PAD","ticket":163')).split('||')[1].replace(/\|$/u, '')), netName: 'ACE113_P' }) + '|');
	assert.ok(slotClearanceFromRuleConfiguration(composition.rules, duplicateIndependentPad, composition.dsn, compositionSdk), 'two independent NORMAL pads on one net count as one confirmed coverage entry');

	const source = readFileSync(resolve(root, 'test/fixtures/ac-v059-reopened-slot.dsn'), 'utf8');
	const slot = { id: '21abb4263d4bd871', x: 690, y: 200, width: 135, height: 45 };
	const clearance = 6.03;
	const className = `aceslot${slot.id}`;
	const defaultType = `default_${className}`;
	const pinBinding = `(pin ${slot.id} (clearance_class ${className}))`;
	const globalRule = `(rule (clearance ${clearance} (type ${defaultType})))`;

	const result = augmentDsnSlotClearances(source, [slot], clearance, 'SAFE:verified; unit:mil');
	assert.equal(result.changed, true, JSON.stringify(result.warnings));
	assert.equal(result.originalText, source);
	assert.equal(result.text.split(pinBinding).length - 1, 1);
	assert.equal(result.text.split(globalRule).length - 1, 1);
	assert.ok(result.text.includes('(string_quote ")'));
	assert.ok(result.text.includes('(plane "ACE_VIA"'));
	assert.ok(result.text.includes('(net +5V'));
	assert.deepEqual(result.slotClearance, {
		appliedSlotIds: [slot.id],
		skippedSlots: [],
		clearanceMil: clearance,
		conservativeDefaultClass: true,
		planeSlotEquivalent: false,
		provenance: 'SAFE:verified; unit:mil',
	});
	assert.ok(result.limitations.some(item => item.includes('via/pad')));
	assert.ok(result.limitations.some(item => item.includes('不等价于 plane slot')));
	const quoteRepair = repairDsnClassNetReferences(source);
	assert.ok(quoteRepair.limitations.some(item => item.includes('本引号修补阶段不添加或修复电源平面')));
	assert.equal(result.changes.filter(change => change.kind === 'slot-clearance').length, 1);
	const restored = result.text.replace(pinBinding, '').replace(`\n    ${globalRule}`, '');
	assert.equal(restored, source, 'the helper inserts only the placement pin binding and its global default rule');

	const repeated = augmentDsnSlotClearances(result.text, [slot], clearance);
	assert.equal(repeated.changed, false, 'existing placement binding is preserved on repeat calls');
	assert.ok(repeated.slotClearance.skippedSlots[0].reason.includes('已有绑定'), JSON.stringify(repeated.slotClearance.skippedSlots));
	assert.equal(repeated.text, result.text);

	const rejectsWithoutChanges = (mutatedSource, reason, suppliedSlot = slot) => {
		const rejected = augmentDsnSlotClearances(mutatedSource, [suppliedSlot], clearance);
		assert.equal(rejected.changed, false, reason);
		assert.equal(rejected.text, mutatedSource, `${reason}: source remains unchanged`);
		assert.equal(rejected.slotClearance.appliedSlotIds.length, 0);
		assert.ok(rejected.warnings.length > 0);
		return rejected;
	};

	rejectsWithoutChanges(source.replace('(pin p21abb4263d4bd871 21abb4263d4bd871 757.5 177.5)', '(pin p21abb4263d4bd871 missing-slot-id 757.5 177.5)'), 'missing one-to-one named pin is rejected');
	rejectsWithoutChanges(source.replace('(pin p21abb4263d4bd871 21abb4263d4bd871 757.5 177.5)', '(pin p21abb4263d4bd871 21abb4263d4bd871 700 177.5)'), 'center mismatch is rejected');
	rejectsWithoutChanges(source.replace('(pin p21abb4263d4bd871 21abb4263d4bd871 757.5 177.5)', '(pin p21abb4263d4bd871 21abb4263d4bd871 757.5 177.5 (rotate 90))'), 'an image pin with an extra transform list is rejected');
	rejectsWithoutChanges(source.replace('(pin p21abb4263d4bd871 21abb4263d4bd871 757.5 177.5)', '(pin p21abb4263d4bd871 21abb4263d4bd871 757.5 177.5 unknown)'), 'an image pin with an extra token is rejected');
	rejectsWithoutChanges(source.replace('(pin p21abb4263d4bd871 21abb4263d4bd871 757.5 177.5)', '(pin p3577d6c78f47fc5b 21abb4263d4bd871 757.5 177.5)'), 'shared padstack is rejected');
	const sharedPadstack = source.replace(
		'(pin p21abb4263d4bd871 21abb4263d4bd871 757.5 177.5)',
		'(pin p21abb4263d4bd871 21abb4263d4bd871 757.5 177.5)\n      (pin p21abb4263d4bd871 extra-pin 800 177.5)',
	);
	rejectsWithoutChanges(sharedPadstack, 'a second pin sharing the slot padstack is rejected');
	rejectsWithoutChanges(source.replace('(shape(polygon TopLayer 0.1 -67.5', '(shape(polygon TopLayer 0.1 -60'), 'non-rectangle or wrong-sized padstack is rejected');
	rejectsWithoutChanges(source.replace('(resolution mil 1000)', '(resolution mm 1000)'), 'non-mil resolution is rejected');
	rejectsWithoutChanges(source.replace('    (layer Inner2\n      (type signal)\n    )\n', ''), 'missing copper layer is rejected');
	rejectsWithoutChanges(source.replace('(place u1 0 0 front 0', '(place u1 0 0 back 0'), 'back-side placement is rejected');
	rejectsWithoutChanges(source.replace('(place u1 0 0 front 0', '(place u1 0 0 front 90'), 'rotated placement is rejected');
	rejectsWithoutChanges(source.replace('(class +5V "+5V"', `(class ${className} "")\n    (class +5V "+5V"`), 'class-name collision is rejected');
	rejectsWithoutChanges(source.replace('(place u1 0 0 front 0\n', `(place u1 0 0 front 0\n        (pin ${slot.id} (clearance_class prior))\n`), 'an existing slot binding is not overwritten');
	rejectsWithoutChanges(source.replace('u1-3577d6c78f47fc5b)', `u1-3577d6c78f47fc5b u1-${slot.id})`), 'network-connected slot pins are rejected');
	rejectsWithoutChanges(source, 'invalid dimensions are rejected', { ...slot, width: 0 });

	const unsupportedList = augmentDsnSlotClearances(source, [{ ...slot, id: 'slot_id' }], clearance);
	assert.equal(unsupportedList.changed, false, 'IDs that would introduce underscores into class names are rejected');
	assert.ok(unsupportedList.slotClearance.skippedSlots[0].reason.includes('字母数字串'));
	const invalidClearance = augmentDsnSlotClearances(source, [slot], 0);
	assert.equal(invalidClearance.changed, false);
	assert.ok(invalidClearance.warnings.some(warning => warning.includes('有限正数')));

	console.log('PASS conservative DSN slot clearance matching, geometry, scope, collision, and preservation checks');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
