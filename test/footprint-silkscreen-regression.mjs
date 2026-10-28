import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const engineExports = 'analyzeFootprintSilkscreen, compareFootprintSourceSummaries, findMissingProjectLibraryFootprintUuids, invalidateFootprintSilkscreenSource, projectComponentFootprintSilkUnsupported, readEmbeddedFootprintSources, readProjectLibraryFootprintSource, readProjectLibrarySources, summarizeEmbeddedFootprintSources, summarizeFootprintSourceSet, unavailableFootprintSilkscreen';
const bundled = await build({ stdin: { contents: `import { ${engineExports} } from '../src/engine/footprintSilkscreen.ts'; export { ${engineExports} }`, resolveDir: import.meta.dirname, sourcefile: 'footprint-silkscreen-regression-entry.ts' }, bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24' });
const { analyzeFootprintSilkscreen, compareFootprintSourceSummaries, findMissingProjectLibraryFootprintUuids, invalidateFootprintSilkscreenSource, projectComponentFootprintSilkUnsupported, readEmbeddedFootprintSources, readProjectLibraryFootprintSource, readProjectLibrarySources, summarizeEmbeddedFootprintSources, summarizeFootprintSourceSet, unavailableFootprintSilkscreen } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const evidenceRoot = resolve(import.meta.dirname, 'fixtures');
const record = (type, id, ticket, data) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`;
const head = uuid => `${JSON.stringify({ type: 'DOCHEAD', ticket: 0 })}||${JSON.stringify({ docType: 'PCB', uuid })}|`;
const fpHead = uuid => `${JSON.stringify({ type: 'DOCHEAD', ticket: 0 })}||${JSON.stringify({ docType: 'FOOTPRINT', uuid })}|`;
const comp = (id, { x = 0, y = 0, angle = 0, layerId = 1, footprint = 'FP-1' } = {}) => record('COMPONENT', id, 1, { x, y, angle, layerId });
const attr = (id, parentId, footprint, ticket = 2) => record('ATTR', id, ticket, { parentId, key: 'Footprint', value: footprint });
const designator = (id, parentId, value, ticket = 2) => record('ATTR', id, ticket, { parentId, key: 'Designator', value });
const poly = (id, ticket = 1, data = { layerId: 3, width: 2, path: [0, 0, 'L', 10, 0] }) => record('POLY', id, ticket, data);
function componentObject(id, values = {}) {
	return {
		getState_PrimitiveId: () => id,
		getState_Footprint: () => ({ uuid: values.footprint ?? 'FP-1' }),
		getState_X: () => values.x ?? 0,
		getState_Y: () => values.y ?? 0,
		getState_Rotation: () => values.angle ?? 0,
		getState_Layer: () => values.layerId ?? 1,
	};
}
const sourceText = ({ uuid = 'FP-1', polies = [poly('local-1')] } = {}) => [fpHead(uuid), ...polies].join('\n');
const boardText = ({ id = 'C1', x = 0, y = 0, angle = 0, layerId = 1, fp = 'FP-1', attrId = 'A1', extra = [] } = {}) => [head('PCB-1'), comp(id, { x, y, angle, layerId }), attr(attrId, id, fp), ...extra].join('\n');
function parseRecords(source) {
	return source.split(/\r?\n/).filter(Boolean).map((line, i) => {
		const p = line.indexOf('||');
		let data = line.slice(p + 2);
		if (data.endsWith('|'))
			data = data.slice(0, -1);
		return { header: JSON.parse(line.slice(0, p)), data: JSON.parse(data), line: i + 1 };
	});
}
function run({ pcb = boardText(), fpSources = [{ footprintUuid: 'FP-1', documentSource: sourceText() }], projectSources = [], components = [componentObject('C1')], checkedObjects = [], minClearance = 0, checkBudget } = {}) {
	return analyzeFootprintSilkscreen({ pcbRecords: parseRecords(pcb), components, footprintSources: fpSources, projectLibrarySources: projectSources, checkedObjects, minClearance, checkBudget });
}

const basic = run();
assert.equal(basic.strokes.length, 1);
assert.equal(basic.strokes[0].sourceIdentity.componentId, 'C1');
assert.equal(basic.strokes[0].sourceIdentity.localPrimitiveId, 'local-1');
assert.deepEqual(basic.strokes[0].global, { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], segments: [{ type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], closed: false, segmentCount: 1, width: 2 });
assert.deepEqual(basic.strokes[0].local, { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], segments: [{ type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], closed: false, segmentCount: 1, width: 2, layerId: 3 });
assert.deepEqual(basic.strokes[0].bbox, { minX: -1, minY: -1, maxX: 11, maxY: 1 });
assert.equal(basic.strokes[0].confirmed, false);
assert.equal(basic.coverage.complete, false);
const mappedWithoutStrokes = run({ fpSources: [{ footprintUuid: 'FP-1', documentSource: sourceText({ polies: [] }) }] });
assert.equal(mappedWithoutStrokes.coverage.mappedComponentCount, 1, 'valid instance/source mapping counts even when the footprint has no supported strokes');
assert.equal(mappedWithoutStrokes.unsupported.some(item => item.type === 'component-footprint-silk'), false, 'a mapped zero-stroke component has no generic mapping unsupported entry');
const emptyBoard = run({ pcb: head('PCB-1'), fpSources: [], components: [] });
assert.equal(emptyBoard.strokes.length, 0, 'empty source and zero-component input remains a valid empty result');
assert.equal(emptyBoard.coverage.complete, false);

const twoSameFootprintsBoard = `${boardText()}\n${comp('C2', { x: 20 })}\n${attr('A2', 'C2', 'FP-1', 3)}`;
const twoSameFootprintsComponents = [componentObject('C1'), componentObject('C2', { x: 20 })];
assert.deepEqual(findMissingProjectLibraryFootprintUuids(parseRecords(twoSameFootprintsBoard), twoSameFootprintsComponents, []), ['FP-1'], 'same-footprint components produce one project source query target');
assert.deepEqual(findMissingProjectLibraryFootprintUuids(parseRecords(twoSameFootprintsBoard), twoSameFootprintsComponents, [{ footprintUuid: 'FP-1', documentSource: 'broken but claimed' }]), [], 'an embedded UUID claim, even invalid, blocks project-library override');
const projectSource = { footprintUuid: 'FP-1', libraryUuid: 'actual-project-library', status: 'found', documentSource: sourceText() };
const projectFallback = run({ fpSources: [], projectSources: [projectSource] });
assert.equal(projectFallback.strokes.length, 1);
assert.equal(projectFallback.strokes[0].sourceIdentity.source, 'project-library');
assert.equal(projectFallback.strokes[0].sourceIdentity.libraryUuid, 'actual-project-library');
assert.equal(projectFallback.coverage.sources[0].source, 'project-library');
const noOverrideConflict = run({ fpSources: [{ footprintUuid: 'FP-1', documentSource: sourceText() }, { footprintUuid: 'FP-1', documentSource: sourceText({ polies: [poly('other')] }) }], projectSources: [projectSource] });
assert.equal(noOverrideConflict.strokes.length, 0, 'project library cannot replace conflicting embedded entries');
assert.equal(compareFootprintSourceSummaries(summarizeFootprintSourceSet([], [projectSource]), summarizeFootprintSourceSet([], [{ ...projectSource, libraryUuid: 'other-project-library' }])), false, 'source stability includes actual library identity');
const changedProjectSource = { ...projectSource, documentSource: sourceText({ polies: [poly('local-1', 1, { layerId: 3, width: 2, path: [0, 0, 'L', 20, 0] })] }) };
assert.equal(compareFootprintSourceSummaries(summarizeFootprintSourceSet([], [projectSource]), summarizeFootprintSourceSet([], [changedProjectSource])), false, 'source stability includes effective project-library source data');
assert.equal(compareFootprintSourceSummaries(summarizeFootprintSourceSet([], [projectSource]), summarizeFootprintSourceSet([{ footprintUuid: 'FP-1', documentSource: sourceText() }], [projectSource])), false, 'source stability detects a switch from project-library to document-embedded channel');
assert.equal(compareFootprintSourceSummaries(summarizeFootprintSourceSet([], [projectSource]), summarizeFootprintSourceSet([], [{ ...projectSource, status: 'missing', documentSource: undefined }])), false, 'source stability detects a missing project-library source');
const claimedOtherInvalid = [{ footprintUuid: 'OTHER', documentSource: 7 }];
const claimedFpInvalid = [{ footprintUuid: 'FP-1', documentSource: 7 }];
assert.equal(compareFootprintSourceSummaries(summarizeFootprintSourceSet(claimedOtherInvalid, [projectSource]), summarizeFootprintSourceSet(claimedFpInvalid, [projectSource])), false, 'source stability detects changed UUID claims even when both embedded items are invalid');
assert.equal(run({ fpSources: claimedFpInvalid, projectSources: [projectSource] }).strokes.length, 0, 'an invalid embedded claim prevents project-library fallback for that UUID');
const invalidated = run({ projectSources: [projectSource] });
invalidateFootprintSilkscreenSource(invalidated, [{ componentId: 'C1', designator: 'R1' }], 'source changed');
assert.equal(invalidated.strokes.length, 0);
assert.equal(invalidated.potentialConflicts.length, 0);
assert.ok(projectComponentFootprintSilkUnsupported(invalidated.unsupported).some(item => item.componentId === 'C1' && item.designator === 'R1'));
assert.ok(projectComponentFootprintSilkUnsupported(invalidated.unsupported).some(item => item.componentId === 'C1' && item.reason.startsWith('来源映射未确认：') && item.reason.includes('预检期间')));
assert.equal(invalidated.coverage.checkedStrokeCount, 0);
assert.equal(invalidated.coverage.excludedOutOfScopePolyCount, 0);

const top90 = run({ pcb: boardText({ angle: 90 }), components: [componentObject('C1', { angle: 90 })] });
assert.ok(Math.abs(top90.strokes[0].global.b.x) < 1e-12);
assert.ok(Math.abs(top90.strokes[0].global.b.y - 10) < 1e-12, 'top uses saved +90 degree rotation');
const bottom0 = run({ pcb: boardText({ layerId: 2 }), components: [componentObject('C1', { layerId: 2 })] });
assert.deepEqual(bottom0.strokes[0].global, { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], segments: [{ type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }], closed: false, segmentCount: 1, width: 2 });
const bottom37 = run({ pcb: boardText({ x: 800, y: 700, angle: 37, layerId: 2 }), components: [componentObject('C1', { x: 800, y: 700, angle: 37, layerId: 2 })] });
assert.ok(Math.abs(bottom37.strokes[0].global.b.x - (800 + 10 * Math.cos(37 * Math.PI / 180))) < 1e-12);
assert.ok(Math.abs(bottom37.strokes[0].global.b.y - (700 + 10 * Math.sin(37 * Math.PI / 180))) < 1e-12);

const unknown = (...args) => assert.equal(run(...args).strokes.length, 0);
unknown({ fpSources: [] });
unknown({ fpSources: [{ footprintUuid: 'FP-1', documentSource: sourceText() }, { footprintUuid: 'FP-1', documentSource: sourceText({ polies: [poly('other')] }) }] });
unknown({ fpSources: [{ footprintUuid: 'FP-1', documentSource: sourceText({ uuid: 'OTHER' }) }] });
unknown({ components: [componentObject('C1', { angle: 90 })] });
unknown({ components: [componentObject('C1', { footprint: 'OTHER' })] });
unknown({ pcb: boardText({ extra: [record('COMPONENT', 'C1', 1, { x: 20, y: 0, angle: 0, layerId: 1 }), attr('A2', 'C1', 'FP-1', 3)] }) });

const malformed = run({ fpSources: [{ footprintUuid: 'FP-1', documentSource: `${sourceText()}\nnot a source record` }] });
assert.equal(malformed.strokes.length, 0);
assert.ok(malformed.unsupported.some(item => /行格式非法/.test(item.reason)));
const malformedWithDesignator = run({ pcb: `${boardText()}\n${designator('D1', 'C1', 'R1')}`, fpSources: [{ footprintUuid: 'FP-1', documentSource: `${sourceText()}\nnot a source record` }] });
assert.ok(malformedWithDesignator.unsupported.some(item => item.type === 'component-footprint-silk' && item.componentId === 'C1' && item.designator === 'R1' && item.reason.startsWith('来源映射未确认：')), 'unconfirmed observed component gets its legacy unsupported entry with an explicit mapping prefix');
const repeatedSources = [{ footprintUuid: 'FP-1', documentSource: sourceText() }, { footprintUuid: 'FP-1', documentSource: sourceText() }];
const splitSources = [...repeatedSources, { footprintUuid: 'FP-1', documentSource: sourceText({ polies: [poly('local-1', 1, { layerId: 3, width: 3, path: [0, 0, 'L', 10, 0] })] }) }];
assert.equal(compareFootprintSourceSummaries(summarizeEmbeddedFootprintSources(repeatedSources), summarizeEmbeddedFootprintSources(splitSources)), false, 'source summary detects a new conflicting source variant');
assert.equal(compareFootprintSourceSummaries(summarizeEmbeddedFootprintSources(repeatedSources), summarizeEmbeddedFootprintSources([...repeatedSources, { malformed: true }])), false, 'source summary detects appended invalid source items');
assert.equal(run({ fpSources: splitSources }).strokes.length, 0, 'conflicting source variants invalidate candidate strokes');
const tombstoned = run({ fpSources: [{ footprintUuid: 'FP-1', documentSource: `${fpHead('FP-1')}\n${poly('local-1', 5)}\n${record('POLY', 'local-1', 6, '')}` }] });
assert.equal(tombstoned.strokes.length, 0, 'higher-ticket deletion remains effective even if source rows are out of order');
const staleWins = run({ fpSources: [{ footprintUuid: 'FP-1', documentSource: `${fpHead('FP-1')}\n${record('POLY', 'local-1', 2, { layerId: 3, width: 2, path: [0, 0, 'L', 10, 0] })}\n${record('POLY', 'local-1', 1, { layerId: 3, width: 2, path: [0, 0, 'L', 20, 0] })}` }] });
assert.equal(staleWins.strokes[0].global.b.x, 10);
unknown({ fpSources: [{ footprintUuid: 'FP-1', documentSource: `${fpHead('FP-1')}\n${poly('local-1', 2)}\n${poly('local-1', 2, { layerId: 3, width: 3, path: [0, 0, 'L', 10, 0] })}` }] });

const edgeCases = run({ fpSources: [{ footprintUuid: 'FP-1', documentSource: sourceText({ polies: [
	poly('complex', 1, { layerId: 3, width: 2, path: [0, 0, 'A', 10, 10] }),
	poly('zero-width', 2, { layerId: 3, width: 0, path: [0, 0, 'L', 10, 0] }),
	poly('bad-width', 3, { layerId: 3, width: Number.NaN, path: [0, 0, 'L', 10, 0] }),
	poly('bad-layer', 4, { layerId: null, width: 2, path: [0, 0, 'L', 10, 0] }),
	poly('missing-layer', 7, { width: 2, path: [0, 0, 'L', 10, 0] }),
	poly('nonfinite-layer', 8, { layerId: Number.NaN, width: 2, path: [0, 0, 'L', 10, 0] }),
	poly('out-of-scope', 6, { layerId: 48, width: 0, path: ['bad'] }),
	poly('local-bottom', 5, { layerId: 4, width: 2, path: [0, 0, 'L', 10, 0] }),
] }) }] });
assert.equal(edgeCases.strokes.length, 1, 'local layer 4 is supported once the component-side transform maps it');
assert.equal(edgeCases.strokes[0].side, 'bottom');
for (const id of ['complex', 'zero-width', 'bad-width', 'bad-layer', 'missing-layer', 'nonfinite-layer']) assert.ok(edgeCases.unsupported.some(item => item.localPrimitiveId === id));
assert.equal(edgeCases.coverage.excludedOutOfScopePolyCount, 1, 'finite non-silkscreen layer POLY is counted and skipped before path/width checks');
assert.ok(!edgeCases.unsupported.some(item => item.localPrimitiveId === 'out-of-scope'));
const invalidPaths = [
	['odd', [0, 0, 'L', 1]],
	['nan', [0, 0, 'L', Number.NaN, 1]],
	['missing-pair', [0, 0, 'L', 1, 2, 'L', 3]],
	['unknown-middle', [0, 0, 'L', 1, 2, 'A', 3, 4]],
	['unknown-first', [0, 0, 'A', 1, 2]],
	['carc', [0, 0, 'CARC', 90, 5, 5]],
	['bezier', [0, 0, 'C', 1, 2, 3, 4]],
	['arc-missing-angle', [0, 0, 'ARC', 5, 5]],
	['arc-zero', [0, 0, 'ARC', 0, 5, 5]],
	['arc-360', [0, 0, 'ARC', 360, 5, 5]],
	['arc-negative-360', [0, 0, 'ARC', -360, 5, 5]],
	['arc-same-endpoint', [0, 0, 'ARC', 90, 0, 0]],
	['arc-overflow', [-1e308, 0, 'ARC', 90, 1e308, 0]],
];
for (const [id, path] of invalidPaths) {
	const invalidPathResult = run({ fpSources: [{ footprintUuid: 'FP-1', documentSource: sourceText({ polies: [poly(id, 1, { layerId: 3, width: 2, path })] }) }] });
	assert.equal(invalidPathResult.strokes.length, 0, `${id} is rejected as a whole instead of preserving a partial prefix`);
	assert.ok(invalidPathResult.unsupported.some(item => item.localPrimitiveId === id));
}
const multiClosed = run({ fpSources: [{ footprintUuid: 'FP-1', documentSource: sourceText({ polies: [poly('closed', 1, { layerId: 3, width: 4, path: [-20, 100, 'L', 20, 100, 20, 120, -20, 120, -20, 100] })] }) }] });
assert.equal(multiClosed.strokes.length, 1);
assert.equal(multiClosed.strokes[0].global.segmentCount, 4);
assert.equal(multiClosed.strokes[0].global.closed, true);
assert.deepEqual(multiClosed.strokes[0].bbox, { minX: -22, minY: 98, maxX: 22, maxY: 122 });
const mixedPrefixInvalid = run({ fpSources: [{ footprintUuid: 'FP-1', documentSource: sourceText({ polies: [poly('mixed-invalid', 1, { layerId: 3, width: 2, path: [0, 0, 'L', 5, 0, 'ARC', 0, 10, 10] })] }) }] });
assert.equal(mixedPrefixInvalid.strokes.length, 0, 'an invalid arc rejects the whole path including a valid line prefix');

// Actual imported B2 source and five-pose line/arc-to-manufacturing match evidence.
const arcPcbEvidence = readFileSync(resolve(evidenceRoot, 'footprint-v094-board.sourcelog'), 'utf8');
const arcFpEvidence = readFileSync(resolve(evidenceRoot, 'footprint-v094-library.sourcelog'), 'utf8');
const arcVerification = JSON.parse(readFileSync(resolve(evidenceRoot, 'footprint-v094-arc-oracle.json'), 'utf8'));
const arcBoardRecords = parseRecords(arcPcbEvidence);
const arcGetData = (type, id) => arcBoardRecords.filter(row => row.header.type === type && row.header.id === id).at(-1)?.data;
const arcComponentIds = [...new Set(arcVerification.observations.map(item => item.componentId))];
const arcRuntime = arcComponentIds.map(id => {
	const source = arcGetData('COMPONENT', id); const fp = arcBoardRecords.find(row => row.header.type === 'ATTR' && row.data.parentId === id && row.data.key === 'Footprint')?.data.value;
	return componentObject(id, { x: source.x, y: source.y, angle: source.angle, layerId: source.layerId, footprint: fp });
});
const arcResult = run({ pcb: arcPcbEvidence, fpSources: [{ footprintUuid: 'b11cd6ee16e22f94', documentSource: arcFpEvidence }], components: arcRuntime });
assert.equal(arcVerification.observations.length, 25);
assert.equal(arcVerification.matchedArcs, 25);
assert.equal(arcVerification.matchedExtraLines, 10);
assert.equal(arcResult.strokes.length, 65, 'the original 40 paths plus 25 arc-containing paths remain one candidate each');
assert.equal(arcResult.strokes.reduce((count, stroke) => count + stroke.global.segmentCount, 0), 95);
assert.equal(arcResult.strokes.reduce((count, stroke) => count + stroke.global.segments.filter(segment => segment.type === 'arc').length, 0), 25);
assert.equal(arcResult.strokes.reduce((count, stroke) => count + stroke.global.segments.filter(segment => segment.type === 'line').length, 0), 70);
assert.ok(arcResult.strokes.every(stroke => stroke.confirmed === false));
assert.equal(arcResult.coverage.complete, false);
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1e-9, `${label}: ${actual} != ${expected}`);
for (const observation of arcVerification.observations) {
	const stroke = arcResult.strokes.find(item => item.sourceIdentity.componentId === observation.componentId && item.sourceIdentity.localPrimitiveId === observation.localPrimitiveId);
	assert.ok(stroke, `missing arc-evidence path ${observation.componentId}/${observation.localPrimitiveId}`);
	assert.equal(stroke.side, observation.layer === 'GTO' ? 'top' : 'bottom');
	assert.equal(stroke.local.layerId, observation.localLayerId);
	assert.equal(stroke.global.width, observation.widthMil);
	assert.equal(stroke.global.segments.length, observation.segments.length);
	assert.deepEqual(stroke.local.points, [observation.segments[0].local.a, ...observation.segments.map(segment => segment.local.b)].map(([x, y]) => ({ x, y })));
	assert.equal(stroke.local.closed, stroke.global.closed);
	assert.equal(stroke.global.closed, stroke.global.points[0].x === stroke.global.points.at(-1).x && stroke.global.points[0].y === stroke.global.points.at(-1).y);
	const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
	for (let index = 0; index < observation.segments.length; index++) {
		const expected = observation.segments[index]; const local = stroke.local.segments[index]; const global = stroke.global.segments[index];
		assert.equal(local.type, expected.local.type);
		assert.equal(global.type, expected.global.type);
		for (const [actual, coords, label] of [[local.a, expected.local.a, 'local a'], [local.b, expected.local.b, 'local b'], [global.a, expected.global.a, 'global a'], [global.b, expected.global.b, 'global b']]) {
			near(actual.x, coords[0], `${observation.localPrimitiveId} ${label}.x`);
			near(actual.y, coords[1], `${observation.localPrimitiveId} ${label}.y`);
		}
		if (expected.local.type === 'arc') {
			for (const [actual, coords, label] of [[local.center, expected.local.center, 'local center'], [global.center, expected.global.center, 'global center']]) {
				near(actual.x, coords[0], `${observation.localPrimitiveId} ${label}.x`);
				near(actual.y, coords[1], `${observation.localPrimitiveId} ${label}.y`);
			}
			near(local.radius, expected.local.radius, `${observation.localPrimitiveId} local radius`);
			near(global.radius, expected.global.radius, `${observation.localPrimitiveId} global radius`);
			near(local.sweepDegrees, expected.local.sweepDegrees, `${observation.localPrimitiveId} local sweep`);
			near(global.sweepDegrees, expected.global.sweepDegrees, `${observation.localPrimitiveId} global sweep`);
		}
		bounds.minX = Math.min(bounds.minX, expected.bounds.xMin); bounds.minY = Math.min(bounds.minY, expected.bounds.yMin);
		bounds.maxX = Math.max(bounds.maxX, expected.bounds.xMax); bounds.maxY = Math.max(bounds.maxY, expected.bounds.yMax);
	}
	const halfWidth = observation.widthMil / 2;
	near(stroke.bbox.minX, bounds.minX - halfWidth, `${observation.localPrimitiveId} bbox.minX`);
	near(stroke.bbox.minY, bounds.minY - halfWidth, `${observation.localPrimitiveId} bbox.minY`);
	near(stroke.bbox.maxX, bounds.maxX + halfWidth, `${observation.localPrimitiveId} bbox.maxX`);
	near(stroke.bbox.maxY, bounds.maxY + halfWidth, `${observation.localPrimitiveId} bbox.maxY`);
}
const longSweep = arcResult.strokes.find(stroke => stroke.sourceIdentity.localPrimitiveId === 'e95' && stroke.sourceIdentity.componentId === '51611a06d7952274');
assert.ok(longSweep.bbox.minY < Math.min(longSweep.global.segments[0].a.y, longSweep.global.segments[0].b.y) - longSweep.global.width / 2, '270 degree arc bounds include swept extrema beyond endpoints');
const mirrored37 = arcVerification.observations.find(item => item.localPrimitiveId === 'e93' && arcGetData('COMPONENT', item.componentId).layerId === 2 && arcGetData('COMPONENT', item.componentId).angle === 37);
assert.ok(mirrored37, 'fixture includes a bottom-side 37 degree arc instance');
const mirrored37Stroke = arcResult.strokes.find(item => item.sourceIdentity.componentId === mirrored37.componentId && item.sourceIdentity.localPrimitiveId === 'e93');
assert.ok(mirrored37Stroke);
assert.ok(Math.sign(mirrored37Stroke.global.segments[0].sweepDegrees) === -Math.sign(mirrored37Stroke.local.segments[0].sweepDegrees), 'bottom-side mirror reverses signed sweep');
const arcProjectFallback = run({ pcb: arcPcbEvidence, fpSources: [], projectSources: [{ footprintUuid: 'b11cd6ee16e22f94', libraryUuid: 'actual-project-library', status: 'found', documentSource: arcFpEvidence }], components: arcRuntime });
assert.equal(arcProjectFallback.strokes.length, 65, 'project-library fallback retains the complete validated line/arc subset');
assert.ok(arcProjectFallback.strokes.every(stroke => stroke.sourceIdentity.source === 'project-library' && stroke.sourceIdentity.libraryUuid === 'actual-project-library'));
assert.deepEqual(arcProjectFallback.strokes.map(stroke => ({ local: stroke.local, global: stroke.global, bbox: stroke.bbox })), arcResult.strokes.map(stroke => ({ local: stroke.local, global: stroke.global, bbox: stroke.bbox })), 'project-library fallback retains identical validated geometry');

const sourceStroke = basic.strokes[0];
const peers = run({
	pcb: `${boardText()}\n${comp('C2', { x: 11, y: 0 })}\n${attr('A2', 'C2', 'FP-1', 3)}`,
	components: [componentObject('C1'), componentObject('C2', { x: 11, y: 0 })],
	checkedObjects: [
		{ id: 'text-near', type: 'text', layer: 'top', box: { minX: 10, minY: -1, maxX: 12, maxY: 1 } },
		{ id: 'same-component-designator', type: 'designator', componentId: 'C1', layer: 'top', box: sourceStroke.bbox },
		{ id: 'opposite-side', type: 'component-pad', componentId: 'C3', layer: 'bottom', box: sourceStroke.bbox },
		{ id: 'unknown-sdk-polyline', type: 'silk-polyline', layer: 'top', box: sourceStroke.bbox },
		{ id: 'far-text', type: 'text', layer: 'top', box: { minX: 100, minY: 100, maxX: 110, maxY: 110 } },
	],
	minClearance: 0,
});
assert.ok(peers.potentialConflicts.some(item => item.b.id === 'text-near' && item.confirmed === false));
assert.ok(peers.potentialConflicts.some(item => item.a.sourceIdentity?.componentId === 'C1' && item.b.sourceIdentity?.componentId === 'C2'));
assert.equal(peers.potentialConflicts.some(item => item.a.sourceIdentity?.componentId === 'C1' && item.b.id === 'same-component-designator'), false);
assert.equal(peers.potentialConflicts.some(item => ['opposite-side', 'unknown-sdk-polyline', 'far-text'].includes(item.b.id)), false);
assert.equal(compareFootprintSourceSummaries(basic.sourceSummary, basic.sourceSummary), true);
assert.equal(compareFootprintSourceSummaries(basic.sourceSummary, run({ fpSources: [{ footprintUuid: 'FP-1', documentSource: sourceText({ polies: [poly('local-1', 1, { layerId: 3, width: 2, path: [0, 0, 'L', 11, 0] })] }) }] }).sourceSummary), false);
assert.equal(unavailableFootprintSilkscreen('missing').coverage.complete, false);
const projectedLegacy = projectComponentFootprintSilkUnsupported([
	{ type: 'component-footprint-silk', componentId: 'C1', designator: 'R1', reason: 'source unavailable' },
	{ type: 'footprint-poly', componentId: 'C1', reason: 'unsupported geometry' },
]);
assert.deepEqual(projectedLegacy, [{ type: 'component-footprint-silk', componentId: 'C1', designator: 'R1', reason: 'source unavailable' }], 'command top-level projection keeps legacy per-component fields and excludes unrelated channel unsupported entries');
const checkCommandSource = readFileSync(new URL('../src/commands/silkscreenCheck.ts', import.meta.url), 'utf8');
assert.match(checkCommandSource, /returns: '.*sourceIdentity/s);
assert.match(checkCommandSource, /returns: '.*sourceStable/s);
assert.match(checkCommandSource, /returns: '.*confirmed=false/s);
assert.match(checkCommandSource, /returns: '.*coverage\.complete 固定 false/s);
assert.match(checkCommandSource, /returns: '.*局部 layer 3\/4/s);
assert.match(checkCommandSource, /returns: '.*\["ARC",signedSweepDegrees,x,y\]/s);
assert.match(checkCommandSource, /returns: '.*路径节点，不是弧采样/s);
let budgetCalls = 0;
assert.throws(() => run({ checkBudget: () => {
	if (++budgetCalls > 5)
		throw new Error('shared budget exhausted');
} }), /shared budget exhausted/, 'source synchronization obeys shared budget');
budgetCalls = 0;
assert.throws(() => run({ checkedObjects: Array.from({ length: 50 }, (_, i) => ({ id: `near-${i}`, type: 'text', layer: 'top', box: { minX: 0, minY: 0, maxX: 5, maxY: 5 } })), checkBudget: () => {
	if (++budgetCalls > 20)
		throw new Error('neighbor budget exhausted');
} }), /neighbor budget exhausted/, 'near-neighbor scan obeys shared budget and aborts');

const guardedRead = async (sdk, behavior) => readEmbeddedFootprintSources({ sdk, read: async (_label, fn) => behavior ? behavior(fn) : fn() }, 'test footprint source read');
const sourceReadFailure = await guardedRead({ sys_FileManager: { getDocumentFootprintSources: async () => { throw new Error('mock source failure'); } } });
assert.equal(sourceReadFailure.available, false, 'SDK source API errors become channel-level unknown');
assert.match(sourceReadFailure.reason, /mock source failure/);
for (const failure of [new Error('焦点已离开 PCB'), new Error('超过共享剩余预算')]) {
	let laterReadStarted = false;
	await assert.rejects(async () => {
		await guardedRead({ sys_FileManager: { getDocumentFootprintSources: async () => [] } }, async () => { throw failure; });
		laterReadStarted = true;
	}, new RegExp(failure.message));
	assert.equal(laterReadStarted, false, 'host.read focus/budget failures propagate and stop subsequent reads');
}

const projectCalls = [];
const projectHost = {
	sdk: {
		lib_LibrariesList: { getProjectLibraryUuid: async () => { projectCalls.push('project-library'); return 'actual-project-library'; } },
		lib_Footprint: { getDocumentSource: async (uuid, libraryUuid) => { projectCalls.push([uuid, libraryUuid]); return sourceText({ uuid }); } },
	},
	read: async (_label, fn) => fn(),
};
const projectReads = await readProjectLibrarySources(projectHost, ['FP-1', 'FP-1', 'FP-2'], 'test project fallback');
const projectReadsAfter = await readProjectLibrarySources(projectHost, ['FP-1', 'FP-1', 'FP-2'], 'test project fallback end');
assert.deepEqual(projectCalls, ['project-library', ['FP-1', 'actual-project-library'], ['FP-2', 'actual-project-library'], 'project-library', ['FP-1', 'actual-project-library'], ['FP-2', 'actual-project-library']], 'two rounds read the project identity once and each unique UUID once per round');
assert.deepEqual(projectReads.map(item => item.status), ['found', 'found']);
assert.deepEqual(projectReadsAfter.map(item => item.status), ['found', 'found']);
const wrongProjectUuid = await readProjectLibraryFootprintSource({ sdk: { lib_Footprint: { getDocumentSource: async () => sourceText({ uuid: 'WRONG' }) } }, read: async (_label, fn) => fn() }, 'FP-1', 'actual-project-library', 'wrong uuid');
assert.equal(wrongProjectUuid.status, 'invalid', 'wrong project-source UUID remains unknown');
const unsupportedProjectFormat = await readProjectLibraryFootprintSource({ sdk: { lib_Footprint: { getDocumentSource: async () => 'unsupported source format' } }, read: async (_label, fn) => fn() }, 'FP-1', 'actual-project-library', 'unsupported format');
assert.equal(unsupportedProjectFormat.status, 'invalid', 'unsupported project-library source format remains unknown');
const emptyProjectSource = await readProjectLibraryFootprintSource({ sdk: { lib_Footprint: { getDocumentSource: async () => '' } }, read: async (_label, fn) => fn() }, 'FP-1', 'actual-project-library', 'empty source');
assert.equal(emptyProjectSource.status, 'missing');
const projectSdkFailure = await readProjectLibraryFootprintSource({ sdk: { lib_Footprint: { getDocumentSource: async () => { throw new Error('mock project library failure'); } } }, read: async (_label, fn) => fn() }, 'FP-1', 'actual-project-library', 'SDK failure');
assert.equal(projectSdkFailure.status, 'sdk-error');
await assert.rejects(() => readProjectLibrarySources({
	sdk: { lib_LibrariesList: { getProjectLibraryUuid: async () => 'actual-project-library' }, lib_Footprint: { getDocumentSource: async () => sourceText() } },
	read: async () => { throw new Error('shared host budget expired'); },
}, ['FP-1'], 'host guard'), /shared host budget expired/, 'host.read budget/focus failures propagate instead of becoming SDK unknown');

// Real source and Gerber-path evidence from the accepted B2 fixture (read-only).
const pcbEvidence = readFileSync(resolve(evidenceRoot, 'footprint-v093-board.sourcelog'), 'utf8');
const fpEvidence = readFileSync(resolve(evidenceRoot, 'footprint-v093-library.sourcelog'), 'utf8');
const transformEvidence = JSON.parse(readFileSync(resolve(evidenceRoot, 'footprint-v093-path-oracle.json'), 'utf8'));
const evidenceRecords = parseRecords(pcbEvidence);
const getData = (type, id) => evidenceRecords.filter(row => row.header.type === type && row.header.id === id).at(-1)?.data;
const runtime = [...new Set(transformEvidence.observations.map(({ componentId }) => componentId))].map(id => {
	const source = getData('COMPONENT', id); const fp = evidenceRecords.find(row => row.header.type === 'ATTR' && row.data.parentId === id && row.data.key === 'Footprint')?.data.value;
	return componentObject(id, { x: source.x, y: source.y, angle: source.angle, layerId: source.layerId, footprint: fp });
});
const evidenceResult = run({ pcb: pcbEvidence, fpSources: [{ footprintUuid: 'b11cd6ee16e22f94', documentSource: fpEvidence }], components: runtime });
assert.equal(transformEvidence.pathObjects, 40);
assert.equal(transformEvidence.centerlineSegments, 60);
assert.equal(evidenceResult.strokes.length, transformEvidence.pathObjects, 'all 40 source path objects map as one candidate each');
assert.equal(evidenceResult.strokes.reduce((count, stroke) => count + stroke.global.segmentCount, 0), transformEvidence.centerlineSegments);
for (const observation of transformEvidence.observations) {
	const stroke = evidenceResult.strokes.find(item => item.sourceIdentity.componentId === observation.componentId && item.sourceIdentity.localPrimitiveId === observation.localPrimitiveId);
	assert.ok(stroke, `missing mapped path ${observation.componentId}/${observation.localPrimitiveId}`);
	assert.equal(stroke.side, observation.gerberLayer === 'GTO' ? 'top' : 'bottom', `wrong side for ${observation.componentId}/${observation.localPrimitiveId}`);
	assert.equal(stroke.local.layerId, observation.localLayerId);
	assert.equal(stroke.global.points.length, observation.globalPoints.length);
	assert.equal(stroke.local.closed, observation.closed);
	for (let point = 0; point < observation.localPoints.length; point++) {
		assert.deepEqual(stroke.local.points[point], { x: observation.localPoints[point][0], y: observation.localPoints[point][1] });
		assert.ok(Math.abs(stroke.global.points[point].x - observation.globalPoints[point][0]) <= transformEvidence.maxEndpointErrorMil + 1e-9);
		assert.ok(Math.abs(stroke.global.points[point].y - observation.globalPoints[point][1]) <= transformEvidence.maxEndpointErrorMil + 1e-9);
	}
	const xs = observation.globalPoints.map(point => point[0]); const ys = observation.globalPoints.map(point => point[1]); const half = observation.widthMil / 2;
	assert.ok(Math.abs(stroke.bbox.minX - (Math.min(...xs) - half)) < 1e-9);
	assert.ok(Math.abs(stroke.bbox.minY - (Math.min(...ys) - half)) < 1e-9);
	assert.ok(Math.abs(stroke.bbox.maxX - (Math.max(...xs) + half)) < 1e-9);
	assert.ok(Math.abs(stroke.bbox.maxY - (Math.max(...ys) + half)) < 1e-9);
}
for (const [id, expectedSide, localLayerId, width, expectedPoints, closed] of [
	['e90', 'bottom', 4, 3, [[0, 70], [25, 70], [25, 85]], false],
	['e91', 'top', 3, 4, [[-20, 100], [20, 100], [20, 120], [-20, 120], [-20, 100]], true],
]) {
	const observation = transformEvidence.observations.find(item => item.localPrimitiveId === id);
	const stroke = evidenceResult.strokes.find(item => item.sourceIdentity.localPrimitiveId === id && item.sourceIdentity.componentId === observation.componentId);
	assert.ok(stroke, `missing asymmetric path ${id}`);
	assert.equal(stroke.side, expectedSide);
	assert.equal(stroke.local.layerId, localLayerId);
	assert.equal(stroke.global.width, width);
	assert.deepEqual(stroke.local.points, expectedPoints.map(([x, y]) => ({ x, y })));
	assert.equal(stroke.local.closed, closed);
}
assert.ok(evidenceResult.strokes.every(stroke => stroke.confirmed === false));
assert.equal(evidenceResult.coverage.complete, false);
const evidenceProjectFallback = run({
	pcb: pcbEvidence,
	fpSources: [],
	projectSources: [{ footprintUuid: 'b11cd6ee16e22f94', libraryUuid: 'actual-project-library', status: 'found', documentSource: fpEvidence }],
	components: runtime,
});
assert.equal(evidenceProjectFallback.strokes.length, transformEvidence.pathObjects, 'project-library fallback reproduces the validated embedded-source path subset');
assert.ok(evidenceProjectFallback.strokes.every(stroke => stroke.sourceIdentity.source === 'project-library' && stroke.sourceIdentity.libraryUuid === 'actual-project-library'));

console.log('footprint-silkscreen regression: PASS');
