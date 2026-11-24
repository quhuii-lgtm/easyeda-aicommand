import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: 'export { inspectDrillPasteOverlaps, identifyMouseBiteCandidates } from \'../src/pcb/panelDfmHoles.ts\'',
			resolveDir: resolve(root, 'test'),
			sourcefile: 'panel-dfm-holes-regression-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const temporaryDirectory = await mkdtemp(join(tmpdir(), 'panel-dfm-holes-'));
	const temporaryModule = join(temporaryDirectory, 'panel-dfm-holes.mjs');
	await writeFile(temporaryModule, built.outputFiles[0].text);
	const api = await import(pathToFileURL(temporaryModule).href);
	const { inspectDrillPasteOverlaps, identifyMouseBiteCandidates } = api;

	const mmToMil = value => value * 1000 / 25.4;
	function square(left, bottom, right, top) {
		return [[[
			[mmToMil(left), mmToMil(bottom)],
			[mmToMil(right), mmToMil(bottom)],
			[mmToMil(right), mmToMil(top)],
			[mmToMil(left), mmToMil(top)],
			[mmToMil(left), mmToMil(bottom)],
		]]];
	}
	function pasteLayer(layer, shapes, { lowerEmpty = false, complete = true } = {}) {
		return {
			layer,
			fileName: `${layer}.gbr`,
			contentBytes: 10,
			complete,
			format: { coordinateFormat: 'FSLA45', absolute: true, sourceUnits: 'mm' },
			counts: { draws: 0, moves: 0, flashes: shapes.length, regions: 0, regionContours: 0, dark: shapes.length, clear: 0 },
			arcApproximation: { arcCount: 0, maxRadiusResidualMil: 0, maxSagittaMil: 0, maxEnvelopeErrorMil: 0 },
			shapes: shapes.map((geometry, index) => ({
				kind: 'region',
				polarity: 'dark',
				apertureId: index,
				geometryLower: lowerEmpty ? [] : geometry,
				geometryUpper: geometry,
			})),
			boardOutline: [],
			unknowns: [],
			unsupported: [],
			usedMacros: [],
			arcApproximationLimited: false,
			apertures: [],
		};
	}

	const top = pasteLayer('GTP', [square(9, 9, 11, 11)]);
	const bottom = pasteLayer('GBP', [square(19, 19, 21, 21)]);
	const result = inspectDrillPasteOverlaps({
		drillHits: [
			{ id: 'hole-top', xMm: 10, yMm: 10, diameterMm: 0.3048, plating: 'PLATED' },
			{ id: 'hole-bottom', xMm: 20, yMm: 20, diameterMm: 0.3048, plating: 'NON_PLATED' },
			{ id: 'clear', xMm: 30, yMm: 30, diameterMm: 0.3048, plating: 'NON_PLATED' },
		],
		pasteLayers: [top, bottom],
		pasteBasis: 'artwork',
	});
	assert.equal(result.complete, true);
	assert.deepEqual(result.results.map(hit => [hit.drillId, hit.layer, hit.intersection]), [
		['hole-top', 'GTP', 'confirmed'],
		['hole-bottom', 'GBP', 'confirmed'],
	]);
	assert.equal(result.manufacturingStencil, 'not-provided');
	assert.equal(inspectDrillPasteOverlaps({
		drillHits: [{ id: 'uncertain', xMm: 10, yMm: 10, diameterMm: 0.3048, plating: 'NON_PLATED' }],
		pasteLayers: [pasteLayer('GTP', [square(9, 9, 11, 11)], { lowerEmpty: true }), bottom],
		pasteBasis: 'stencil-file',
	}).results[0].intersection, 'possible');
	const incomplete = inspectDrillPasteOverlaps({
		drillHits: [{ id: 'missing-layer', xMm: 10, yMm: 10, diameterMm: 0.3, plating: 'NON_PLATED' }],
		pasteLayers: [top],
		pasteBasis: 'artwork',
	});
	assert.equal(incomplete.complete, false);
	assert.ok(incomplete.skipped.length > 0);
	const noPaste = inspectDrillPasteOverlaps({
		drillHits: [{ id: 'no-layers', xMm: 10, yMm: 10, diameterMm: 0.3, plating: 'NON_PLATED' }],
		pasteLayers: [],
		pasteBasis: 'artwork',
	});
	assert.equal(noPaste.checkedDrillCount, 0);
	assert.deepEqual(noPaste.checkedDrillCountByLayer, { GTP: 0, GBP: 0 });
	const onePaste = inspectDrillPasteOverlaps({
		drillHits: [{ id: 'one-layer', xMm: 10, yMm: 10, diameterMm: 0.3, plating: 'NON_PLATED' }],
		pasteLayers: [top],
		pasteBasis: 'artwork',
	});
	assert.equal(onePaste.checkedDrillCount, 1);
	assert.deepEqual(onePaste.checkedDrillCountByLayer, { GTP: 1, GBP: 0 });
	console.log('PASS drill/paste overlap geometry, polarity confidence, explicit stencil provenance, and incomplete-layer reporting');

	const drillHits = [];
	const outline = [{ id: 'panel-outline', pointsMm: [[0, 0], [200, 0], [200, 120], [0, 120], [0, 0]] }];
	for (let row = 0; row < 18; row++) {
		const y = 3 + row * 6;
		const x = 5 + (row % 5) * 7;
		outline.push({ id: `unit-edge-left-${row}`, pointsMm: [[x - 1.1, y - 0.1], [x - 0.9, y - 0.1], [x - 0.9, y + 0.1], [x - 1.1, y + 0.1], [x - 1.1, y - 0.1]] });
		outline.push({ id: `unit-edge-right-${row}`, pointsMm: [[x + 4.9, y - 0.1], [x + 5.1, y - 0.1], [x + 5.1, y + 0.1], [x + 4.9, y + 0.1], [x + 4.9, y - 0.1]] });
		for (let column = 0; column < 5; column++)
			drillHits.push({ id: `mb-${row}-${column}`, xMm: x + column, yMm: y, diameterMm: 0.6, plating: 'NON_PLATED' });
	}
	for (const [index, point] of [[2.5, 2.5], [198.039, 2.5], [198.039, 115.02], [7.5, 115.02]].entries())
		drillHits.push({ id: `mount-${index}`, xMm: point[0], yMm: point[1], diameterMm: 2, plating: 'NON_PLATED' });
	const copper = ['GTL', 'GBL', 'G1', 'G2'].map(layer => pasteLayer(layer, []));
	const bites = identifyMouseBiteCandidates({ drillHits, boardOutlineMm: outline, copperLayers: copper });
	const found = bites.candidates.flatMap(row => row.drillIds);
	assert.equal(found.length, 90);
	assert.equal(new Set(found).size, 90);
	assert.equal(bites.unclassifiedNonPlated.length, 4);
	assert.equal(bites.candidates.length, 18);
	assert.ok(bites.candidates.every(row => row.endpointDistancesToPanelOrBoardEdgeMm.every(distance => Math.abs(distance - 0.9) < 1e-6)));
	assert.ok(bites.candidates.every(row => row.maximumDistanceToPanelOrBoardEdgeMm > 2));
	assert.ok(bites.candidates.every(row => row.classification === 'periodic-npth-row-near-edge-candidate'));
	assert.ok(bites.candidates.every(row => row.status === 'candidate-awaiting-review'
		&& row.drills.length === 5 && row.drills.every(drill => drill.id && drill.centerMm.length === 2 && drill.diameterMm === 0.6)));
	assert.equal(bites.complete, false);
	const mixedDiameter = identifyMouseBiteCandidates({
		drillHits: drillHits.map(hit => hit.id === 'mb-0-2' ? { ...hit, diameterMm: 0.7 } : hit),
		boardOutlineMm: outline,
		copperLayers: copper,
	});
	assert.equal(mixedDiameter.candidates.length, 17);
	const unevenPitch = identifyMouseBiteCandidates({
		drillHits: drillHits.map(hit => hit.id === 'mb-1-2' ? { ...hit, xMm: hit.xMm + 0.2 } : hit),
		boardOutlineMm: outline,
		copperLayers: copper,
	});
	assert.equal(unevenPitch.candidates.length, 17);
	const distantEnds = identifyMouseBiteCandidates({
		drillHits,
		boardOutlineMm: outline.map(path => path.id.startsWith('unit-edge-')
			? { ...path, pointsMm: path.pointsMm.map(([x, y]) => [x, y + 2]) }
			: path),
		copperLayers: copper,
		maximumEdgeDistanceMm: 1.2,
	});
	assert.equal(distantEnds.candidates.length, 0);
	const copperOverlap = identifyMouseBiteCandidates({
		drillHits,
		boardOutlineMm: outline,
		copperLayers: [pasteLayer('GTL', [square(5, 2.5, 6, 3.5)]), ...copper.slice(1)],
	});
	assert.ok(copperOverlap.candidates.some(row => row.status === 'review-copper-overlap' && row.copperOverlapIds.length > 0));
	const innerOnlyCopper = identifyMouseBiteCandidates({ drillHits, boardOutlineMm: outline, copperLayers: copper.slice(2) });
	assert.equal(innerOnlyCopper.candidates.length, 18);
	assert.ok(innerOnlyCopper.candidates.every(row => row.status === 'copper-coverage-incomplete'));
	assert.equal(identifyMouseBiteCandidates({ drillHits, boardOutlineMm: [], copperLayers: copper }).candidates.length, 0);
	console.log('PASS 18 periodic NPTH rows identify all 90 holes from endpoint proximity, preserve 4 mounting holes, and reject rows with distant endpoints');
	await rm(temporaryDirectory, { recursive: true, force: true });
}

main();
