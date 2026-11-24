import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function main() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const compiled = await build({
		stdin: { contents: 'export { auditPanelAssembly } from \'./src/pcb/panelDfmAssembly.ts\'', resolveDir: root, loader: 'ts' },
		bundle: true,
		write: false,
		platform: 'node',
		format: 'esm',
	});
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`;
	const { auditPanelAssembly } = await import(moduleUrl);
	const encode = text => Buffer.from(text, 'utf8').toString('base64');
	const bom = encode('Designator,Quantity,Footprint,LCSC Part #\nR1,1,R0603,C111\nJ1,1,J2,C222\n');
	const placement = encode('Designator,Mid X,Mid Y,Layer,Rotation,Footprint\nR1,0mm,0mm,Top,0,R0603\nJ1,5mm,0mm,Top,0,J2\n');

	const simple = auditPanelAssembly({ bomBase64: bom, placementBase64: placement });
	assert.equal(simple.complete, true);
	assert.deepEqual(simple.assemblyCounts, {
		topSmt: 2,
		bottomSmt: 0,
		manual: null,
		omit: null,
		basis: 'BOM and placement designators match; manual/omit classification unavailable',
	});
	assert.equal(simple.materialTraceability[0].partNumber, 'C111');

	const extraBottom = encode('Designator,Mid X,Mid Y,Layer,Rotation\nR1,0mm,0mm,Top,0\nJ1,5mm,0mm,Top,0\nR2,9mm,2mm,Bottom,90\n');
	const incomplete = auditPanelAssembly({ bomBase64: bom, placementBase64: extraBottom });
	assert.equal(incomplete.complete, false);
	assert.deepEqual(incomplete.reconciliation.unexpectedPlacement, ['R2']);
	assert.equal(incomplete.inputCounts.placement, 3);

	const assignment = encode('Unit,Original,Panel,Assembly\nM,R1,R1,SMT\nM,J1,J1,Manual\n');
	const mapped = auditPanelAssembly({ bomBase64: bom, placementBase64: placement, assignmentBase64: assignment });
	assert.equal(mapped.complete, false);
	assert.deepEqual(mapped.reconciliation.unexpectedBom, ['J1']);
	assert.deepEqual(mapped.reconciliation.unexpectedPlacement, ['J1']);
	assert.equal(mapped.assemblyCounts.manual, 1);
	assert.equal(mapped.materialTraceability[0].unit, 'M');

	const bodyBom = encode('Designator,Quantity,Footprint,LCSC Part #\nC9,1,C0402,C131394\nU3,1,SOP-8,C111332\nC1019,1,C0603,C21122\n');
	const bodyPlacement = encode('Designator,Mid X,Mid Y,Layer,Rotation,Footprint\nC9,0mm,0mm,Top,0,C0402\nU3,0mm,2.87mm,Top,0,SO8\nC1019,0.861mm,0mm,Top,0,C0603\n');
	const bodyAssignment = encode('Unit,Original,Panel,Assembly\nM,C9,C9,SMT\nM,U3,U3,SMT\nS,C19,C1019,SMT\n');
	const geometry = auditPanelAssembly({
		bomBase64: bodyBom,
		placementBase64: bodyPlacement,
		assignmentBase64: bodyAssignment,
		bodyDimensions: [
			{ designator: 'C9', partNumber: 'C131394', source: 'C9 manufacturer nominal body dimensions', widthMm: 1, lengthMm: 0.5 },
			{ designator: 'U3', partNumber: 'C111332', source: 'U3 manufacturer nominal body dimensions', widthMm: 1.6, lengthMm: 4.9 },
			{ designator: 'C1019', partNumber: 'C21122', source: 'C1019 manufacturer nominal body dimensions', widthMm: 0.8, lengthMm: 0.4 },
		],
		minimumBodyClearanceMm: 0.2,
		minimumBodyToEdgeMm: 0.5,
		outlineSegments: [
			{ scope: 'unit', unitDesignator: 'S', side: 'top', id: 'route-edge-left', a: { x: 0, y: -2 }, b: { x: 0, y: 2 } },
		],
	});
	const spacing = geometry.bodyGeometry.intercomponent.items.find(item => item.first === 'C9' && item.second === 'U3');
	assert.ok(Math.abs(spacing.distanceMm - 0.17) < 1e-9);
	assert.equal(spacing.status, 'below-threshold');
	const c1019Edge = geometry.boardEdge.measurements.items.find(item => item.designator === 'C1019');
	assert.ok(Math.abs(c1019Edge.distanceMm - 0.461) < 1e-9);
	assert.equal(c1019Edge.status, 'below-threshold');

	const actualPanelPlacement = encode('Designator,Mid X,Mid Y,Layer,Rotation\nC9,57.038mm,36.630mm,Top,0\nU3,59.500mm,39.500mm,Top,90\nC1019,99.361mm,25.901mm,Top,90\n');
	const actualGeometry = auditPanelAssembly({
		bomBase64: bodyBom,
		placementBase64: actualPanelPlacement,
		assignmentBase64: bodyAssignment,
		bodyDimensions: [
			{ designator: 'C9', partNumber: 'C131394', source: 'C9 manufacturer nominal body dimensions', widthMm: 1, lengthMm: 0.5 },
			{ designator: 'U3', partNumber: 'C111332', source: 'U3 manufacturer nominal body dimensions', widthMm: 4.9, lengthMm: 3.9 },
			{ designator: 'C1019', partNumber: 'C21122', source: 'C1019 manufacturer nominal body dimensions', widthMm: 1.6, lengthMm: 0.8 },
		],
		minimumBodyClearanceMm: 0.2,
		minimumBodyToEdgeMm: 0.5,
		outlineSegments: [{ scope: 'unit', unitDesignator: 'S', side: 'top', id: 'C19-left-route', a: { x: 98.5, y: 24 }, b: { x: 98.5, y: 28 } }],
	});
	const actualSpacing = actualGeometry.bodyGeometry.intercomponent.items.find(item => item.first === 'C9' && item.second === 'U3');
	assert.ok(Math.abs(actualSpacing.distanceMm - 0.1704) < 0.001);
	const actualEdge = actualGeometry.boardEdge.measurements.items.find(item => item.designator === 'C1019');
	assert.ok(Math.abs(actualEdge.distanceMm - 0.461) < 1e-9);

	const containmentBom = encode('Designator,Quantity,Footprint,LCSC Part #\nR1,1,R0603,CR1\nR2,1,R0603,CR2\n');
	const containmentPlacement = encode('Designator,Mid X,Mid Y,Layer,Rotation\nR1,0mm,0mm,Top,0\nR2,0mm,0mm,Top,0\n');
	const containment = auditPanelAssembly({
		bomBase64: containmentBom,
		placementBase64: containmentPlacement,
		bodyDimensions: [
			{ designator: 'R1', partNumber: 'CR1', source: 'outline sample', widthMm: 4, lengthMm: 4 },
			{ designator: 'R2', partNumber: 'CR2', source: 'outline sample', widthMm: 1, lengthMm: 1 },
		],
		minimumBodyClearanceMm: 0.1,
		minimumBodyToEdgeMm: 0.1,
		outlineSegments: [{ scope: 'panel', side: 'top', id: 'internal-slot', a: { x: -0.1, y: 0 }, b: { x: 0.1, y: 0 } }],
	});
	assert.equal(containment.bodyGeometry.intercomponent.items[0].distanceMm, 0);
	assert.equal(containment.boardEdge.measurements.items[0].distanceMm, 0);

	const missingSource = auditPanelAssembly({
		bomBase64: bodyBom,
		placementBase64: bodyPlacement,
		assignmentBase64: bodyAssignment,
		bodyDimensions: [{ designator: 'C9', partNumber: 'wrong-part', source: 'unrelated model', widthMm: 1, lengthMm: 1 }],
	});
	assert.equal(missingSource.bodyGeometry.unverified.items.some(item => item.designator === 'C9'), true);
	assert.ok(missingSource.boardEdge.measurements.items.every(item => item.status === 'unverified'));

	if (process.argv[2]) {
		const folder = process.argv[2];
		const file = name => readFile(path.join(folder, name)).then(bytes => bytes.toString('base64'));
		const [panelBom, panelPlacement] = await Promise.all([
			file('拼板-SMT-BOM.csv'),
			file('拼板-SMT-坐标.csv'),
		]);
		const panelAssignment = await file('拼板位号与手焊对照.csv');
		const panel = auditPanelAssembly({ bomBase64: panelBom, placementBase64: panelPlacement, assignmentBase64: panelAssignment });
		assert.equal(panel.complete, true, JSON.stringify(panel.reconciliation));
		assert.equal(panel.inputCounts.bom, 535);
		assert.equal(panel.inputCounts.placement, 535);
		assert.equal(panel.assemblyCounts.topSmt, 535);
		assert.equal(panel.assemblyCounts.bottomSmt, 0);
		assert.equal(panel.inputCounts.assignment, 595);
		assert.deepEqual([panel.assemblyCounts.manual, panel.assemblyCounts.topSmt, panel.assemblyCounts.bottomSmt], [60, 535, 0]);
		console.log('PASS SP-01 panel BOM and placement reconcile: 535 top, 0 bottom');
		if (process.argv[3]) {
			const spFile = name => readFile(path.join(process.argv[3], name)).then(bytes => bytes.toString('base64'));
			const [spBom, spPlacement] = await Promise.all([
				spFile('SP-01-经济型顶面贴装-BOM.tsv'),
				spFile('SP-01-U2两孔之间-经济型顶面贴装-坐标.tsv'),
			]);
			const singleBoard = auditPanelAssembly({ bomBase64: spBom, placementBase64: spPlacement });
			assert.equal(singleBoard.complete, true, JSON.stringify(singleBoard.reconciliation));
			assert.equal(singleBoard.inputCounts.bom, 93);
			assert.equal(singleBoard.inputCounts.placement, 93);
			assert.deepEqual([singleBoard.assemblyCounts.topSmt, singleBoard.assemblyCounts.bottomSmt], [93, 0]);
			assert.equal(singleBoard.materialTraceability[0].partSource, 'Supplier Part');
			console.log('PASS SP-01 single-board BOM and native T/B placement reconcile: 93 top, 0 bottom');
		}
	}

	console.log('PASS panel assembly reconciliation and source-bound rotated-body geometry');
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
