import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { analyzeManufacturingMaskOverlapParticipation, analyzeSilkscreenGerber } from '../src/pcb/silkscreenGerber.ts';

const coordinate = mil => String(Math.round(mil * 2540));
const rectangle = (x0, y0, x1, y1) => `G54D10*G01X${coordinate(x0)}Y${coordinate(y0)}D02*G01X${coordinate(x1)}Y${coordinate(y0)}D01*G01X${coordinate(x1)}Y${coordinate(y1)}D01*G01X${coordinate(x0)}Y${coordinate(y1)}D01*G01X${coordinate(x0)}Y${coordinate(y0)}D01*`;
const flash = (centerX, centerY) => `G54D11*G01X${coordinate(centerX)}Y${coordinate(centerY)}D03*`;
const polarityFlash = (centerX, centerY, polarity, aperture = 11) => `${polarity === 'clear' ? '%LPC*%' : '%LPD*%'}G54D${aperture}*G01X${coordinate(centerX)}Y${coordinate(centerY)}D03*`;
function header(apertures = '%ADD11R,0.762X0.762*%') { return `%FSLAX45Y45*%\n%MOMM*%\n%ADD10C,0.1016*%\n${apertures}\nG75*\n`; }
async function makeZip({ gto = '', gbo = '', gts = '', gbs = '', gko = rectangle(0, 0, 100, 100), apertures } = {}) {
	const prefix = header(apertures);
	const zip = new JSZip();
	zip.file('Gerber_TopSilkscreenLayer.GTO', `${prefix}${gto}\nM02*`);
	zip.file('Gerber_BottomSilkscreenLayer.GBO', `${prefix}${gbo}\nM02*`);
	zip.file('Gerber_TopSolderMaskLayer.GTS', `${prefix}${gts}\nM02*`);
	zip.file('Gerber_BottomSolderMaskLayer.GBS', `${prefix}${gbs}\nM02*`);
	zip.file('Gerber_BoardOutlineLayer.GKO', `${prefix}${gko}\nM02*`);
	return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}
async function analyzeZip(bytes, clearance = 0) {
	let parsedLayers;
	const manufacturing = await analyzeSilkscreenGerber(bytes, clearance, undefined, layers => { parsedLayers = layers; });
	assert.ok(parsedLayers);
	return { manufacturing, parsedLayers };
}
const completeOverlapZip = await makeZip({
	gto: flash(45, 45),
	gts: flash(55, 55),
});
const { manufacturing: originalManufacturing, parsedLayers } = await analyzeZip(completeOverlapZip);
const originalManufacturingBefore = JSON.stringify(originalManufacturing);
assert.equal(originalManufacturing.complete, true);
assert.equal(originalManufacturing.confirmedConflicts.filter(conflict => conflict.category === 'silk-to-mask-opening').length, 1);
const parsedLayersBefore = JSON.stringify(parsedLayers);
const primary = analyzeManufacturingMaskOverlapParticipation({ layers: parsedLayers, manufacturing: originalManufacturing });
assert.equal(primary.available, true);
assert.equal(primary.complete, false);
assert.equal(primary.results.length, 1);
const verified = primary.results[0];
assert.equal(verified.conflictBucket, 'confirmed');
assert.equal(verified.conflictIndex, 0);
assert.equal(verified.areaIndex, 0);
assert.equal(verified.locationTruncated, false);
assert.equal(verified.witnessCandidateEnumerationComplete, true);
assert.equal(verified.uniqueSourceAttribution, false);
assert.equal(verified.contactEnumerationComplete, false);
assert.equal(verified.manufacturingContribution, 'verified-at-witnesses');
assert.ok(verified.witness);
assert.deepEqual(verified.witness.pointMil, [50, 50]);
assert.ok(verified.witness.overlapLowerContains && verified.witness.silkLowerContains && verified.witness.maskLowerContains);
assert.ok(verified.witness.overlapBoundaryMarginMil > 0.01);
assert.ok(verified.witness.silkLowerBoundaryMarginMil > 0.01);
assert.ok(verified.witness.maskLowerBoundaryMarginMil > 0.01);
assert.equal(verified.witness.silk.darkUpperCandidateCount, 1);
assert.equal(verified.witness.mask.darkUpperCandidateCount, 1);
assert.equal(verified.witness.silk.uniqueDarkCoverage, true);
assert.equal(verified.witness.mask.uniqueDarkCoverage, true);
assert.equal(verified.witness.silk.necessaryContribution, true);
assert.equal(verified.witness.mask.necessaryContribution, true);
assert.deepEqual(verified.witness.silk.darkUpperCandidates[0].reference, {
	layer: 'GTO', fileName: 'Gerber_TopSilkscreenLayer.GTO', contentBytes: parsedLayers[0].contentBytes, shapeIndex: 0,
});
assert.deepEqual(verified.witness.mask.darkUpperCandidates[0].reference, {
	layer: 'GTS', fileName: 'Gerber_TopSolderMaskLayer.GTS', contentBytes: parsedLayers[2].contentBytes, shapeIndex: 0,
});
assert.equal(JSON.stringify(parsedLayers), parsedLayersBefore, 'mask participation analysis does not mutate parsed layers');
assert.equal(JSON.stringify(originalManufacturing), originalManufacturingBefore, 'mask participation analysis leaves the original report unchanged');

const bboxOnlyZip = await makeZip({ gto: flash(35, 45), gts: flash(65, 55) });
const bboxOnlyInput = await analyzeZip(bboxOnlyZip);
const bboxOnlyReport = structuredClone(bboxOnlyInput.manufacturing);
bboxOnlyReport.confirmedConflicts.push({
	category: 'silk-to-mask-opening', layer: 'top', thresholdMil: 0, distanceLowerBoundMil: 0, distanceUpperBoundMil: 0,
	status: 'confirmed', confirmed: true, method: 'polygon-inner-outer-bounds', locationBoundsMil: [{ minX: 40, minY: 40, maxX: 60, maxY: 60 }],
});
const bboxOnly = analyzeManufacturingMaskOverlapParticipation({ layers: bboxOnlyInput.parsedLayers, manufacturing: bboxOnlyReport });
assert.equal(bboxOnly.results.at(-1).manufacturingContribution, 'not-verified', 'bbox overlap without lower geometry overlap cannot create a witness');
assert.equal(bboxOnly.results.at(-1).witness, undefined);
assert.match(bboxOnly.results.at(-1).reason, /没有正面积/u);

const holedZip = await makeZip({
	gto: polarityFlash(50, 50, 'dark'),
	gts: `${polarityFlash(50, 50, 'dark')}${polarityFlash(50, 50, 'clear', 12)}`,
	apertures: '%ADD11R,1.016X1.016*%\n%ADD12R,0.508X0.508*%',
});
const holeInput = await analyzeZip(holedZip);
const holeManufacturing = structuredClone(holeInput.manufacturing);
holeManufacturing.confirmedConflicts = [{
	category: 'silk-to-mask-opening', layer: 'top', thresholdMil: 0, distanceLowerBoundMil: 0, distanceUpperBoundMil: 0,
	status: 'confirmed', confirmed: true, method: 'polygon-inner-outer-bounds', locationBoundsMil: [{ minX: 45, minY: 45, maxX: 55, maxY: 55 }],
}];
const holeResult = analyzeManufacturingMaskOverlapParticipation({ layers: holeInput.parsedLayers, manufacturing: holeManufacturing });
assert.equal(holeResult.results[0].manufacturingContribution, 'not-verified', 'a bounding box entirely inside a clear-paint hole cannot yield an internal witness');
assert.equal(holeResult.results[0].witness, undefined);

const clearErasedZip = await makeZip({
	gto: `${polarityFlash(45, 45, 'dark')}${polarityFlash(45, 45, 'clear')}`,
	gts: flash(55, 55),
});
const clearErasedInput = await analyzeZip(clearErasedZip);
const clearErasedManufacturing = structuredClone(clearErasedInput.manufacturing);
clearErasedManufacturing.confirmedConflicts = [{
	category: 'silk-to-mask-opening', layer: 'top', thresholdMil: 0, distanceLowerBoundMil: 0, distanceUpperBoundMil: 0,
	status: 'confirmed', confirmed: true, method: 'polygon-inner-outer-bounds', locationBoundsMil: [{ minX: 40, minY: 40, maxX: 60, maxY: 60 }],
}];
const clearErased = analyzeManufacturingMaskOverlapParticipation({ layers: clearErasedInput.parsedLayers, manufacturing: clearErasedManufacturing });
assert.equal(clearErased.results[0].manufacturingContribution, 'not-verified', 'a clear stroke that removes the final silk prevents a positive-overlap witness');

const redrawnZip = await makeZip({
	gto: `${polarityFlash(50, 50, 'dark')}${polarityFlash(50, 50, 'clear', 12)}${polarityFlash(50, 50, 'dark', 12)}`,
	gts: flash(50, 50), apertures: '%ADD11R,1.016X1.016*%\n%ADD12R,0.508X0.508*%',
});
const redrawnInput = await analyzeZip(redrawnZip);
const redrawnManufacturing = structuredClone(redrawnInput.manufacturing);
redrawnManufacturing.confirmedConflicts = [{
	category: 'silk-to-mask-opening', layer: 'top', thresholdMil: 0, distanceLowerBoundMil: 0, distanceUpperBoundMil: 0,
	status: 'confirmed', confirmed: true, method: 'polygon-inner-outer-bounds', locationBoundsMil: [{ minX: 40, minY: 40, maxX: 60, maxY: 60 }],
}];
const redrawn = analyzeManufacturingMaskOverlapParticipation({ layers: redrawnInput.parsedLayers, manufacturing: redrawnManufacturing });
assert.equal(redrawn.results[0].manufacturingContribution, 'verified-at-witnesses', 'the later dark shape can be proved necessary even when an earlier dark upper also overlaps before clear');
assert.equal(redrawn.results[0].witness.silk.darkUpperCandidateCount, 2);
assert.equal(redrawn.results[0].witness.silk.uniqueDarkCoverage, false, 'raw upper coverage remains explicitly non-unique');
assert.equal(redrawn.results[0].witness.silk.necessaryContributorCount, 1);
assert.equal(redrawn.results[0].witness.silk.necessaryContributorRefs[0].shapeIndex, 2);

const duplicateZip = await makeZip({ gto: `${flash(45, 45)}${flash(45, 45)}`, gts: flash(55, 55) });
const duplicateInput = await analyzeZip(duplicateZip);
const duplicate = analyzeManufacturingMaskOverlapParticipation({ layers: duplicateInput.parsedLayers, manufacturing: duplicateInput.manufacturing });
assert.equal(duplicate.results[0].manufacturingContribution, 'not-verified');
assert.equal(duplicate.results[0].witness.silk.darkUpperCandidateCount, 2);
assert.equal(duplicate.results[0].witness.silk.necessaryContributorCount, 0, 'overlapping dark duplicates are not individually necessary');
assert.deepEqual(duplicate.results[0].witness.silk.darkUpperCandidates.map(item => item.reference.shapeIndex), [0, 1]);

const narrowZip = await makeZip({
	gto: `${polarityFlash(35, 50, 'dark', 12)}`,
	gts: `${polarityFlash(44.995, 50, 'dark', 12)}`,
	apertures: '%ADD11R,0.254X0.254*%\n%ADD12R,0.254X0.254*%',
});
const narrowInput = await analyzeZip(narrowZip);
assert.equal(narrowInput.manufacturing.confirmedConflicts.filter(item => item.category === 'silk-to-mask-opening').length, 1, 'narrow strip is still positive-area overlap');
const narrow = analyzeManufacturingMaskOverlapParticipation({ layers: narrowInput.parsedLayers, manufacturing: narrowInput.manufacturing });
assert.equal(narrow.results[0].manufacturingContribution, 'not-verified', 'overlap narrower than the existing numeric margin has no strict interior witness');
assert.equal(narrow.results[0].witness, undefined);
assert.match(narrow.results[0].reason, /0.01mil/u);

const incompleteLayers = structuredClone(parsedLayers);
incompleteLayers.find(layer => layer.layer === 'GTS').complete = false;
const incomplete = analyzeManufacturingMaskOverlapParticipation({ layers: incompleteLayers, manufacturing: originalManufacturing });
assert.equal(incomplete.results[0].manufacturingContribution, 'not-verified');
assert.match(incomplete.results[0].reason, /GTS/u);
const noManufacturing = analyzeManufacturingMaskOverlapParticipation({ layers: [], manufacturing: { complete: false, unavailableReason: 'missing Gerber API' } });
assert.equal(noManufacturing.available, false);
assert.equal(noManufacturing.unavailableReason, 'missing Gerber API');
const noLocation = analyzeManufacturingMaskOverlapParticipation({
	layers: parsedLayers,
	manufacturing: { confirmedConflicts: [{ category: 'silk-to-mask-opening', layer: 'top', thresholdMil: 0, status: 'confirmed', confirmed: true, method: 'polygon-inner-outer-bounds' }] },
});
assert.equal(noLocation.results.length, 0);
assert.match(noLocation.skipped[0].reason, /省略了location bounds/u);

const multiSideZip = await makeZip({ gto: flash(45, 45), gbo: flash(45, 45), gts: flash(55, 55), gbs: flash(55, 55) });
const multiSideInput = await analyzeZip(multiSideZip);
assert.equal(multiSideInput.manufacturing.confirmedConflicts.filter(item => item.category === 'silk-to-mask-opening').length, 2);
const multiSide = analyzeManufacturingMaskOverlapParticipation({ layers: multiSideInput.parsedLayers, manufacturing: multiSideInput.manufacturing });
assert.deepEqual(multiSide.results.map(result => result.layer), ['top', 'bottom']);
assert.deepEqual(multiSide.results.map(result => result.witness.silk.darkUpperCandidates[0].reference.layer), ['GTO', 'GBO']);
assert.deepEqual(multiSide.results.map(result => result.witness.mask.darkUpperCandidates[0].reference.layer), ['GTS', 'GBS']);

let budgetCalls = 0;
assert.throws(() => analyzeManufacturingMaskOverlapParticipation({ layers: parsedLayers, manufacturing: originalManufacturing, checkBudget: () => { if (++budgetCalls === 12) throw new Error('mask-participation-budget-stop'); } }), /mask-participation-budget-stop/u);
console.log('ok silkscreen mask overlap participation');
