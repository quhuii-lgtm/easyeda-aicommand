import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { analyzeFootprintArcBoardParticipation, analyzeSilkscreenGerber } from '../src/pcb/silkscreenGerber.ts';

const coordinate = mil => String(Math.round(mil * 2540));
const pointAt = (center, radius, degrees) => {
	const angle = degrees * Math.PI / 180;
	return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
};
const arc = (identity = 'arc-1', overrides = {}) => {
	const center = overrides.center ?? { x: 90, y: 50 };
	const radius = overrides.radius ?? 20;
	const startAngle = overrides.startAngle ?? -120;
	const sweepDegrees = overrides.sweepDegrees ?? 240;
	const start = overrides.a ?? pointAt(center, radius, startAngle);
	const end = overrides.b ?? pointAt(center, radius, startAngle + sweepDegrees);
	return {
		confirmed: false,
		sourceIdentity: { componentId: 'C1', footprintUuid: 'FP-1', localPrimitiveId: identity, source: 'document-embedded' },
		local: { a: start, b: end, points: [start, end], segments: [], closed: false, segmentCount: 1, width: overrides.width ?? 4, layerId: 3 },
		global: { a: start, b: end, points: [start, end], segments: [{ type: 'arc', a: start, b: end, center, radius, sweepDegrees }], closed: false, segmentCount: 1, width: overrides.width ?? 4 },
		side: overrides.side ?? 'top', bbox: { minX: 70, minY: 30, maxX: 110, maxY: 70 },
	};
};
const boardRect = (x0, y0, x1, y1) => `G54D10*G01X${coordinate(x0)}Y${coordinate(y0)}D02*G01X${coordinate(x1)}Y${coordinate(y0)}D01*G01X${coordinate(x1)}Y${coordinate(y1)}D01*G01X${coordinate(x0)}Y${coordinate(y1)}D01*G01X${coordinate(x0)}Y${coordinate(y0)}D01*`;
const board = boardRect(0, 0, 100, 100);
function arcRecords(sourceArc, polarity = 'dark') {
	const segment = sourceArc.global.segments[0];
	const offsetI = segment.center.x - segment.a.x;
	const offsetJ = segment.center.y - segment.a.y;
	const plotMode = segment.sweepDegrees > 0 ? 'G03' : 'G02';
	return `${polarity === 'clear' ? '%LPC*%' : '%LPD*%'}G54D10*G01X${coordinate(segment.a.x)}Y${coordinate(segment.a.y)}D02*${plotMode}X${coordinate(segment.b.x)}Y${coordinate(segment.b.y)}I${coordinate(offsetI)}J${coordinate(offsetJ)}D01*`;
}
async function manufacturingZip(gto, { gbo = '', gts = '', completeGto = true, completeGts = true, gko = board } = {}) {
	const header = '%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,0.1016*%\nG75*\n';
	const zip = new JSZip();
	zip.file('Gerber_TopSilkscreenLayer.GTO', `${header}${gto}\n${completeGto ? 'M02*' : ''}`);
	zip.file('Gerber_BottomSilkscreenLayer.GBO', `${header}${gbo}\nM02*`);
	zip.file('Gerber_TopSolderMaskLayer.GTS', `${header}\n${completeGts ? 'M02*' : ''}`);
	zip.file('Gerber_BottomSolderMaskLayer.GBS', `${header}\nM02*`);
	zip.file('Gerber_BoardOutlineLayer.GKO', `${header}${gko}\nM02*`);
	return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}
const stableFootprint = strokes => ({ strokes, coverage: { sourceStable: true } });
async function analyze(gto, strokes = [arc()], options = {}) {
	const bytes = await manufacturingZip(gto, options);
	let captured;
	const oldReport = await analyzeSilkscreenGerber(bytes, 0);
	const reportWithCapture = await analyzeSilkscreenGerber(bytes, 0, undefined, layers => {
		captured = layers;
		try { layers[0].shapes[0].polarity = 'clear'; } catch { /* snapshots are deeply frozen */ }
		try { layers.push(layers[0]); } catch { /* snapshots are deeply frozen */ }
	});
	assert.deepEqual(reportWithCapture, oldReport, 'the optional capture callback leaves the existing manufacturing report unchanged');
	assert.ok(captured);
	assert.equal(Object.isFrozen(captured), true);
	assert.equal(Object.isFrozen(captured[0].shapes[0]), true);
	return { participation: analyzeFootprintArcBoardParticipation({ layers: captured, footprintSilkscreen: stableFootprint(strokes) }), oldReport, captured };
}

const baselineArc = arc();
const baseline = await analyze(arcRecords(baselineArc));
assert.equal(baseline.participation.available, true);
assert.equal(baseline.participation.complete, false);
assert.equal(baseline.participation.checkedArcCount, 1);
assert.equal(baseline.participation.skipped.length, 0);
assert.equal(baseline.participation.results.length, 1);
const baselineResult = baseline.participation.results[0];
assert.equal(baselineResult.sourceGeometryRelation, 'centerline-crosses-board-edge');
assert.equal(baselineResult.sourceMapping, 'geometry-correlated');
assert.equal(baselineResult.manufacturingContribution, 'verified-at-witnesses');
assert.equal(baselineResult.uniqueSourceAttribution, false);
assert.deepEqual(baselineResult.sourceIntersectionPointsMil, baselineResult.witnesses.map(witness => witness.pointMil), 'source centerline intersections remain separate from manufacturing-contribution witnesses');
assert.deepEqual(baselineResult.witnesses.map(witness => witness.pointMil[0]), [100, 100]);
assert.ok(Math.abs(baselineResult.witnesses[0].pointMil[1] - 32.679491924) < 0.002);
assert.ok(Math.abs(baselineResult.witnesses[1].pointMil[1] - 67.320508076) < 0.002);
assert.ok(baselineResult.witnesses.every(witness => witness.fullLowerContains && !witness.omittedShapeUpperContains && !witness.nearFullLowerBoundary && !witness.nearOmittedUpperBoundary));
assert.deepEqual(baselineResult.matchedManufacturingRefs, [{ layer: 'GTO', fileName: 'Gerber_TopSilkscreenLayer.GTO', contentBytes: baseline.captured[0].contentBytes, shapeIndex: 0 }]);

const shortSweepSource = arc('short-sweep', { startAngle: -80, sweepDegrees: 160 });
const shortSweep = await analyze(arcRecords(shortSweepSource), [shortSweepSource]);
assert.equal(shortSweep.participation.results[0].manufacturingContribution, 'verified-at-witnesses', 'a short arc sweep crossing the same board edge is matched in its directed path');
const clockwiseSource = arc('clockwise-sweep', { startAngle: 80, sweepDegrees: -160 });
const clockwise = await analyze(arcRecords(clockwiseSource), [clockwiseSource]);
assert.equal(clockwise.participation.results[0].manufacturingContribution, 'verified-at-witnesses', 'clockwise direction is matched independently from the counterclockwise long arc');

for (const sweepDegrees of [179.9999, 180, 180.0001, -180]) {
	const halfCircleSource = arc(`half-${sweepDegrees}`, { center: { x: 0, y: 0 }, radius: 10, startAngle: 0, sweepDegrees });
	const halfCircle = await analyze(arcRecords(halfCircleSource), [halfCircleSource], { gko: boardRect(0, -20, 20, 20) });
	const expectedY = sweepDegrees < 0 ? -10 : 10;
	assert.equal(halfCircle.participation.results[0].manufacturingContribution, 'verified-at-witnesses', `directed half-circle ${sweepDegrees} degrees matches and contributes`);
	assert.equal(halfCircle.participation.results[0].sourceIntersectionPointsMil.length, 1);
	assert.ok(Math.abs(halfCircle.participation.results[0].sourceIntersectionPointsMil[0][0]) < 1e-9);
	assert.ok(Math.abs(halfCircle.participation.results[0].sourceIntersectionPointsMil[0][1] - expectedY) < 0.001);
}
const upperHalf = arc('upper-half', { center: { x: 0, y: 0 }, radius: 10, startAngle: 0, sweepDegrees: 180 });
const reverseHalfManufacturing = arc('reverse-half-manufacturing', { center: { x: 0, y: 0 }, radius: 10, startAngle: 0, sweepDegrees: -180 });
const reverseHalf = await analyze(arcRecords(reverseHalfManufacturing), [upperHalf], { gko: boardRect(0, -20, 20, 20) });
assert.equal(reverseHalf.participation.results[0].sourceMapping, 'not-matched', 'the reverse half-circle cannot claim the source arc that crosses the other board-edge witness');
const nearBranchSource = arc('near-branch-source', { center: { x: 0, y: 0 }, radius: 10, startAngle: 0, sweepDegrees: 179.9999 });
const nearBranchManufacturing = arc('near-branch-gerber', { center: { x: 0, y: 0 }, radius: 10, startAngle: 0, sweepDegrees: 180.0001 });
const withinSweepQuantum = await analyze(arcRecords(nearBranchManufacturing), [nearBranchSource], { gko: boardRect(0, -20, 20, 20) });
assert.equal(withinSweepQuantum.participation.results[0].sourceMapping, 'geometry-correlated', 'sweep differences inside the derived quantization bound can still match');
const beyondSweepQuantum = await analyze(arcRecords(arc('far-branch-gerber', { center: { x: 0, y: 0 }, radius: 10, startAngle: 0, sweepDegrees: 180.1 })), [nearBranchSource], { gko: boardRect(0, -20, 20, 20) });
assert.equal(beyondSweepQuantum.participation.results[0].sourceMapping, 'not-matched', 'sweep differences beyond the endpoint/sweep quantization bound are rejected');

const quantizedInside = arc('within-q', { center: { x: 90 + 0.0005, y: 50 } });
const withinTolerance = await analyze(arcRecords(baselineArc), [quantizedInside]);
assert.equal(withinTolerance.participation.results[0].sourceMapping, 'geometry-correlated', 'source center differences within the 4.5 coordinate quantization bound still match');
const quantizedOutside = arc('outside-q', { center: { x: 90 + 0.002, y: 50 } });
const outsideTolerance = await analyze(arcRecords(baselineArc), [quantizedOutside]);
assert.equal(outsideTolerance.participation.results[0].sourceMapping, 'not-matched', 'source center differences beyond the derived quantization bound do not match');
const uncertainLayerSnapshot = structuredClone(baseline.captured);
uncertainLayerSnapshot[0].shapes[0].arcApproximation.sweepDegrees = 0;
const branchUncertain = analyzeFootprintArcBoardParticipation({ layers: uncertainLayerSnapshot, footprintSilkscreen: stableFootprint([baselineArc]) });
assert.equal(branchUncertain.results[0].sourceMapping, 'geometry-match-uncertain', 'a matching manufacturing record at the zero-degree numeric branch is not silently excluded');
assert.equal(branchUncertain.results[0].manufacturingContribution, 'not-verified');
assert.equal(branchUncertain.results[0].uncertainManufacturingRefs.length, 1);

const wrongCenter = await analyze(arcRecords(baselineArc), [arc('wrong-center', { center: { x: 90.01, y: 50 } })]);
assert.equal(wrongCenter.participation.results[0].sourceMapping, 'not-matched');
assert.equal(wrongCenter.participation.results[0].sourceIntersectionPointsMil.length, 2, 'source crossings are retained when no manufacturing arc matches');
const wrongSweepManufacturingArc = arc('wrong-sweep-manufacturing', { startAngle: -100, sweepDegrees: 200 });
const wrongSweep = await analyze(arcRecords(wrongSweepManufacturingArc), [baselineArc]);
assert.equal(wrongSweep.participation.results[0].sourceMapping, 'not-matched');
const wrongWidth = await analyze(arcRecords(baselineArc), [arc('wrong-width', { width: 3.999 })]);
assert.equal(wrongWidth.participation.results[0].sourceMapping, 'not-matched');
const widthRoundingOnly = await analyze(arcRecords(baselineArc), [arc('width-rounding-only', { width: 4 + Number.EPSILON * 4 })]);
assert.equal(widthRoundingOnly.participation.results[0].sourceMapping, 'geometry-correlated', 'width comparison allows only the machine-rounding difference of unit conversion');
const widthBeyondRounding = await analyze(arcRecords(baselineArc), [arc('width-beyond-rounding', { width: 4 + 1e-12 })]);
assert.equal(widthBeyondRounding.participation.results[0].sourceMapping, 'not-matched', 'width comparison rejects differences larger than floating-point conversion noise');
const wrongSide = await analyze(arcRecords(baselineArc), [arc('wrong-side', { side: 'bottom' })]);
assert.equal(wrongSide.participation.results[0].sourceMapping, 'not-matched');

const duplicateManufacturing = await analyze(`${arcRecords(baselineArc)}${arcRecords(baselineArc)}`);
assert.equal(duplicateManufacturing.participation.results[0].sourceMapping, 'ambiguous-manufacturing-match');
assert.equal(duplicateManufacturing.participation.results[0].matchedManufacturingRefs.length, 2, 'all duplicate geometry matches are disclosed without selecting one');
assert.equal(duplicateManufacturing.participation.results[0].sourceIntersectionPointsMil.length, 2, 'source crossings remain visible when manufacturing matching is ambiguous');
const duplicateSources = await analyze(arcRecords(baselineArc), [baselineArc, arc('arc-2')]);
assert.equal(duplicateSources.participation.results.length, 2, 'each source arc gets its own bounded result');
assert.ok(duplicateSources.participation.results.every(result => result.manufacturingContribution === 'verified-at-witnesses' && result.uniqueSourceAttribution === false));

const darkThenClear = await analyze(`${arcRecords(baselineArc)}${arcRecords(baselineArc, 'clear')}`);
assert.equal(darkThenClear.participation.results[0].sourceMapping, 'geometry-correlated');
assert.equal(darkThenClear.participation.results[0].manufacturingContribution, 'not-verified', 'a later clear stroke that removes the witness ink blocks the contribution claim');
const darkClearDark = await analyze(`${arcRecords(baselineArc)}${arcRecords(baselineArc, 'clear')}${arcRecords(baselineArc)}`);
assert.equal(darkClearDark.participation.results[0].sourceMapping, 'ambiguous-manufacturing-match', 're-darkening leaves multiple possible dark source shapes unresolved');
const overlappingDark = await analyze(`${arcRecords(baselineArc)}${arcRecords(baselineArc)}`);
assert.equal(overlappingDark.participation.results[0].manufacturingContribution, 'not-verified');

const tangentSource = arc('tangent', { center: { x: 80, y: 50 }, radius: 20 });
const tangent = await analyze(arcRecords(tangentSource), [tangentSource]);
assert.equal(tangent.participation.results.length, 0);
assert.match(tangent.participation.skipped[0].reason, /切点|端点|交点/u, 'tangent/boundary ambiguity is reported as skipped, not clean');
const endpointSource = arc('endpoint-contact', { center: { x: 90, y: 50 }, radius: 10, startAngle: 0, sweepDegrees: 120 });
const endpointContact = await analyze(arcRecords(endpointSource), [endpointSource]);
assert.equal(endpointContact.participation.results.length, 0);
assert.ok(endpointContact.participation.skipped.length > 0, 'arc-endpoint contact remains an explicit uncovered record');
const partialEndpointSource = arc('partial-endpoint-contact', { startAngle: -100, sweepDegrees: 160 });
const partialEndpoint = await analyze(arcRecords(partialEndpointSource), [partialEndpointSource]);
assert.equal(partialEndpoint.participation.results[0].witnesses.length, 1, 'the unambiguous interior crossing is retained');
assert.equal(partialEndpoint.participation.results[0].contactEnumerationComplete, false);
assert.match(partialEndpoint.participation.results[0].unresolvedContactReason, /端点|顶点/u);
assert.ok(partialEndpoint.participation.skipped.some(item => item.sourceIdentity.localPrimitiveId === 'partial-endpoint-contact'), 'the additional endpoint contact is disclosed as unresolved');
const vertexSource = arc('board-vertex-contact', { center: { x: 80, y: 80 }, radius: Math.sqrt(800), startAngle: -50, sweepDegrees: 100 });
const vertexContact = await analyze(arcRecords(vertexSource), [vertexSource]);
assert.equal(vertexContact.participation.results[0].witnesses.length, 1, 'the separate interior crossing remains a valid witness');
assert.match(vertexContact.participation.results[0].unresolvedContactReason, /顶点/u, 'a simultaneous GKO corner contact is kept unresolved');
const branchSource = arc('branch-zero', { sweepDegrees: 0.000001 });
const branch = await analyze(arcRecords(branchSource), [branchSource]);
assert.equal(branch.participation.results.length, 0);
assert.match(branch.participation.skipped[0].reason, /0\/360度分支边界/u);
const fullCircleNearBranch = arc('branch-360', { sweepDegrees: 359.999999 });
const fullCircleBranch = await analyze(arcRecords(fullCircleNearBranch), [fullCircleNearBranch]);
assert.equal(fullCircleBranch.participation.results.length, 0);
assert.match(fullCircleBranch.participation.skipped[0].reason, /0\/360度分支边界/u);

const incompleteSilk = await analyze(arcRecords(baselineArc), [baselineArc], { completeGto: false });
assert.equal(incompleteSilk.participation.available, true, 'a complete GKO with incomplete GTO is reported as a skipped side-specific source');
assert.equal(incompleteSilk.participation.results.length, 0);
assert.equal(incompleteSilk.participation.skipped.length, 1);
assert.match(incompleteSilk.participation.skipped[0].reason, /缺失、不完整/u);
const incompleteMask = await analyze(arcRecords(baselineArc), [baselineArc], { completeGts: false });
assert.equal(incompleteMask.participation.results[0].manufacturingContribution, 'verified-at-witnesses', 'unrelated solder-mask incompleteness does not block same-side arc participation evidence');
assert.equal(incompleteMask.participation.complete, false);
const invalidBoard = await analyze(arcRecords(baselineArc), [baselineArc], { gko: `G54D10*G01X0Y0D02*G01X${coordinate(100)}Y${coordinate(100)}D01*` });
assert.equal(invalidBoard.participation.available, false, 'a missing/non-closed GKO never produces edge-participation evidence');
assert.match(invalidBoard.participation.availableReason, /唯一、完整/u);
const unstable = analyzeFootprintArcBoardParticipation({ layers: baseline.captured, footprintSilkscreen: { ...stableFootprint([baselineArc]), coverage: { sourceStable: false } } });
assert.equal(unstable.available, false);
assert.equal(unstable.results.length, 0);
assert.equal(unstable.skipped.length, 1);

const inputLayersBefore = JSON.stringify(baseline.captured);
const inputFootprintBefore = JSON.stringify(stableFootprint([baselineArc]));
const budgetCallsBefore = { count: 0 };
assert.throws(() => analyzeFootprintArcBoardParticipation({ layers: baseline.captured, footprintSilkscreen: stableFootprint([baselineArc]), checkBudget: () => { if (++budgetCallsBefore.count === 4) throw new Error('participation-budget-stop'); } }), /participation-budget-stop/u);
assert.equal(JSON.stringify(baseline.captured), inputLayersBefore, 'participation analysis does not mutate captured manufacturing geometry');
assert.equal(JSON.stringify(stableFootprint([baselineArc])), inputFootprintBefore, 'participation analysis does not mutate footprint source input');

console.log('ok silkscreen arc-board participation');
