import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
async function main() {
	const built = await build({
		stdin: {
			contents: `export { repairDsnClassNetReferences, augmentDsnPlanes } from '../src/engine/dsnExport.ts'`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'dsn-export-regression-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { repairDsnClassNetReferences, augmentDsnPlanes } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

	const samplePath = resolve(root, 'test', 'fixtures', 'dsn-host-class-quotes.dsn');
	const sample = await readFile(samplePath, 'utf8');
	const repaired = repairDsnClassNetReferences(sample);
	assert.equal(repaired.changed, true, JSON.stringify(repaired.warnings));
	assert.equal(repaired.originalText, sample, 'the original export remains available unchanged');
	assert.match(repaired.text, /\(string_quote "\)/);
	assert.match(repaired.text, /\(space_in_quoted_tokens on\)/);
	for (const net of ['ACE_IN_A', 'ACE_OUT_A', 'ACE_IN_B', 'ACE_OUT_B', '$1N1', '$1N4']) {
		assert.ok(sample.includes(`'${net}'`), `source sample has expected broken reference ${net}`);
		assert.ok(repaired.text.includes(`"${net}"`), `reference ${net} converted to DSN double-quoted token`);
	}
	assert.match(repaired.text, /\(class\s+''\s/);
	assert.ok(repaired.warnings.some(warning => warning.includes('空名 class')));
	assert.equal(repaired.changes.filter(change => change.kind === 'class-net-reference').length, 6);
	assert.ok(repaired.limitations.some(item => item.includes('电源平面')));
	assert.equal(repairDsnClassNetReferences(repaired.text).changed, false, 'repair is idempotent');

	const punctuationName = `NET (A)"'B`;
	const namesWithPunctuation = `(PCB demo
  (parser)
  (network
    (net ${JSON.stringify(punctuationName)} (pins U1-1))
    (class C '${punctuationName}'
      (circuit (use_via via0))
    )
    (class empty '' (rule (width 10)))
  )
)`;
	const punctuationResult = repairDsnClassNetReferences(namesWithPunctuation);
	assert.equal(punctuationResult.changed, true);
	const punctuationDsnToken = `"${punctuationName.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
	assert.ok(punctuationResult.text.includes(`(class C ${punctuationDsnToken}`));
	assert.ok(punctuationResult.text.includes(`(net ${punctuationDsnToken}`));
	assert.match(punctuationResult.text, /\(class empty ''/);
	assert.equal(repairDsnClassNetReferences(punctuationResult.text).changed, false, 'quoted punctuation survives a parse-and-repair round trip');

	const legalSingleQuoteReference = `(PCB demo
  (parser (string_quote '))
  (network (net NET_A (pins U1-1)) (class C 'NET_A' (rule (width 10))))
)`;
	const legalResult = repairDsnClassNetReferences(legalSingleQuoteReference);
	assert.equal(legalResult.changed, false, 'a declared non-double quote dialect is left intact');
	assert.ok(legalResult.warnings.some(warning => warning.includes('非双引号')));

	const quoteParser = '(parser (string_quote ") (space_in_quoted_tokens on))';
	const ambiguousQuoteIdentity = `(PCB demo
  ${quoteParser}
  (network
    (net SIG (pins U1-1))
    (net 'SIG' (pins U1-2))
    (class C 'SIG' (rule (width 10)))
  )
)`;
	const ambiguousIdentityResult = repairDsnClassNetReferences(ambiguousQuoteIdentity);
	assert.equal(ambiguousIdentityResult.changed, false, 'original net identity wins over quote-stripping normalization');
	assert.ok(ambiguousIdentityResult.text.includes('(class C \'SIG\''));
	assert.ok(ambiguousIdentityResult.warnings.some(warning => warning.includes('网络身份歧义')));

	const singleQuotedNetIdentity = `(PCB demo
  ${quoteParser}
  (network
    (net 'SIG' (pins U1-1))
    (class C 'SIG' (rule (width 10)))
  )
)`;
	const singleQuotedIdentityResult = repairDsnClassNetReferences(singleQuotedNetIdentity);
	assert.equal(singleQuotedIdentityResult.changed, false, 'a net whose declared name includes apostrophes remains unchanged');
	assert.ok(singleQuotedIdentityResult.text.includes('(class C \'SIG\''));

	const falseReference = `(PCB demo
  (parser)
  (network (net REAL_NET (pins U1-1)) (class C 'NOT_A_NET' (rule (width 10))))
)`;
	const falseResult = repairDsnClassNetReferences(falseReference);
	assert.equal(falseResult.changed, true, 'only parser settings may be added');
	assert.match(falseResult.text, /'NOT_A_NET'/, 'unmatched token is not changed');
	assert.ok(falseResult.warnings.some(warning => warning.includes('未匹配')));

	const malformed = repairDsnClassNetReferences('(PCB demo (parser) (network (net NET_A)');
	assert.equal(malformed.changed, false);
	assert.equal(malformed.text, '(PCB demo (parser) (network (net NET_A)');
	assert.ok(malformed.warnings.some(warning => warning.includes('解析失败')));

	const planeSource = `(PCB demo
  (parser)
  (resolution mil 1000)
  (network (net GND) (net +5V))
  (structure
    (layer TopLayer (type signal))
    (layer Inner1 (type signal))
    (layer Inner2 (type signal))
    (layer BottomLayer (type signal))
  )
)`;
	const square = x => [{ x, y: 0 }, { x: x + 10, y: 0 }, { x: x + 10, y: 10 }, { x, y: 10 }, { x, y: 0 }];
	const planeRegions = [
		{ id: 'gnd-inner1', net: 'GND', layerName: 'Inner1', pointsMil: square(0) },
		{ id: '5v-inner1', net: '+5V', layerName: 'Inner1', pointsMil: square(20) },
	];
	const planesAdded = augmentDsnPlanes(planeSource, planeRegions);
	assert.equal(planesAdded.changed, true);
	assert.equal(planesAdded.originalText, planeSource);
	assert.ok(planesAdded.text.includes('(plane "GND" (polygon "Inner1" 0 0 0 10 0 10 10 0 10 0 0))'));
	assert.ok(planesAdded.text.includes('(plane "+5V" (polygon "Inner1" 0 20 0 30 0 30 10 20 10 20 0))'));
	assert.equal(planesAdded.changes.filter(change => change.kind === 'plane').length, 2);
	assert.match(planesAdded.text, /\(string_quote "\)/);
	assert.ok(planesAdded.limitations.some(item => item.includes('槽孔')));
	const existingPlaneSource = planesAdded.text.replace(/\n {4}\(plane "\+5V"[^\n]+/, '');
	const duplicatePlane = augmentDsnPlanes(existingPlaneSource, [planeRegions[0]]);
	assert.equal(duplicatePlane.changed, false, 'an exact existing plane is not duplicated');
	assert.ok(duplicatePlane.warnings.some(warning => warning.includes('跳过重复')));
	assert.equal(augmentDsnPlanes(planeSource, [{ ...planeRegions[0], net: 'MISSING' }]).changed, false, 'unknown network is rejected');
	assert.equal(augmentDsnPlanes(planeSource, [{ ...planeRegions[0], layerName: 'BottomLayer' }]).changed, false, 'outer layer is rejected');
	assert.equal(augmentDsnPlanes(planeSource, [{ ...planeRegions[0], pointsMil: square(0).slice(0, -1) }]).changed, false, 'unclosed polygon is rejected');
	const crossing = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 0 }];
	assert.equal(augmentDsnPlanes(planeSource, [{ ...planeRegions[0], pointsMil: crossing }]).changed, false, 'self-crossing polygon is rejected');
	assert.equal(augmentDsnPlanes(planeSource.replace('(resolution mil 1000)', '(resolution mm 1000)'), [planeRegions[0]]).changed, false, 'unknown units are rejected');
	assert.equal(augmentDsnPlanes(planeSource.replace('(network (net GND) (net +5V))', '(network (net GND))'), [planeRegions[1]]).changed, false, 'missing network declaration is rejected');

	console.log(JSON.stringify({
		fixtureClassNetReferencesRepaired: repaired.changes.filter(change => change.kind === 'class-net-reference').length,
		emptyClassPreservedWithWarning: true,
		punctuationRoundTrip: true,
		validAlternateQuoteLeftUntouched: true,
		quotedNetIdentityPreserved: true,
		ambiguousQuotedNetIdentityWarned: true,
		unmatchedReferenceLeftUntouched: true,
		malformedInputReturnedUnchanged: true,
		twoInnerPlanesAdded: true,
		duplicatePlaneSkipped: true,
		invalidPlaneInputsRejected: true,
	}));
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
