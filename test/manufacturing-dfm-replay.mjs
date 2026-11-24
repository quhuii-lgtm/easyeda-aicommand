import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const [panelDir, spDir, evidence] = process.argv.slice(2);
	assert.ok(panelDir && spDir, 'Provide the panel and SP-01 saved sample directories');
	const read = (folder, file) => readFile(resolve(folder, file));
	const encode = async (folder, file) => (await read(folder, file)).toString('base64');
	const bundle = await build({
		stdin: { resolveDir: resolve(import.meta.dirname, '..'), loader: 'ts', contents: `
export { manufacturingDfmCommands } from './src/commands/manufacturingDfm'
export { registerCommand, executeCommand } from './src/engine/registry'
export { parseSourceLog, resolveRecords } from './src/pcb/sourcelog'
` },
		bundle: true,
		write: false,
		platform: 'node',
		format: 'esm',
	});
	const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
	for (const def of api.manufacturingDfmCommands) api.registerCommand(def);
	const run = async (params) => {
		const outcome = await api.executeCommand({ cmd: 'dfm.inspectManufacturingFiles', params });
		assert.equal(outcome.ok, true, outcome.error?.message);
		return outcome.data;
	};
	const tol = (actual, expected, epsilon) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} vs ${expected}`);
	const source = await read(spDir, '57x35-U2移至XT30两孔之间-重开.epru');
	const saved = api.parseSourceLog(source.toString('utf8'));
	const savedRecords = [...api.resolveRecords(saved).values()];
	const attrs = savedRecords.filter(({ header, data }) => header.type === 'ATTR' && data.key === 'Designator');
	assert.equal(saved.uuid, '5e462f083548f1d1');
	assert.ok(['C15', 'C22', 'C29'].every(ref => attrs.some(({ data }) => data.value === ref && data.layerId === 4)));
	const reference = 'SP-01打板预检';
	const panel = await run({
		object: 'panel',
		gerberBase64: await encode(panelDir, 'M1-定位6-SP01-拼板-Gerber.zip'),
		artworkPasteBase64: await encode(panelDir, '仅供对照-原生拼板锡膏层-含手焊位开口.zip'),
		minimumMaskBridgeMm: 0.1,
		assembly: {
			bomBase64: await encode(panelDir, '拼板-SMT-BOM.csv'),
			placementBase64: await encode(panelDir, '拼板-SMT-坐标.csv'),
			assignmentBase64: await encode(panelDir, '拼板位号与手焊对照.csv'),
			bodyDimensions: [
				{ designator: 'C9', partNumber: 'C131394', widthMm: 1, lengthMm: 0.5, source: 'Yageo CC0402KRX7R9BB104 p1' },
				{ designator: 'U3', partNumber: 'C111332', widthMm: 4.9, lengthMm: 3.9, source: 'Belling BL24C512A SOP-8 nominal body' },
				{ designator: 'C1019', partNumber: 'C21122', widthMm: 1.6, lengthMm: 0.8, source: 'Samsung CL10B223KB8NNN Body Dimensions' },
			],
			minimumBodyClearanceMm: 0.2,
			minimumBodyToEdgeMm: 0.5,
		},
	});
	const single = await run({
		object: 'single-board',
		minimumMaskBridgeMm: 0.1,
		gerberBase64: await encode(spDir, `${reference}/SP-01-U2移至XT30两孔之间-Gerber.zip`),
		assembly: {
			bomBase64: await encode(spDir, `${reference}/SP-01-经济型顶面贴装-BOM.tsv`),
			placementBase64: await encode(spDir, `${reference}/SP-01-U2两孔之间-经济型顶面贴装-坐标.tsv`),
		},
	});
	if (evidence) {
		await writeFile(evidence, JSON.stringify({ panel, single, spSavedSource: {
			uuid: saved.uuid,
			sha256: createHash('sha256').update(source).digest('hex'),
		} }, null, 2));
	}
	assert.equal(panel.assembly.complete, true, JSON.stringify(panel.assembly.reconciliation));
	assert.deepEqual([panel.assembly.assemblyCounts.topSmt, panel.assembly.assemblyCounts.bottomSmt, panel.assembly.assemblyCounts.manual], [535, 0, 60]);
	assert.equal(single.assembly.complete, true, JSON.stringify(single.assembly.reconciliation));
	assert.deepEqual([single.assembly.assemblyCounts.topSmt, single.assembly.assemblyCounts.bottomSmt], [93, 0]);
	for (const ref of ['C15', 'C22', 'C29'])
		assert.ok(single.assembly.materialTraceability.every(item => item.designator !== ref));
	for (const board of [panel, single]) {
		const mask = board.mask.layers.find(layer => layer.side === 'top');
		assert.equal(mask.complete, true, JSON.stringify(mask.uncertainties));
		tol(mask.closestPair.lowerBoundMil * 0.0254, 0.0652, 0.001);
		assert.ok(mask.findings.length >= 8);
	}
	assert.equal(panel.outline.rings.length, 19);
	const c9u3 = panel.assembly.bodyGeometry.intercomponent.items.find(item => [item.first, item.second].sort().join('/') === 'C9/U3');
	const c19Edge = panel.assembly.boardEdge.measurements.items.find(item => item.designator === 'C1019');
	tol(c9u3?.distanceMm, 0.17, 0.002);
	tol(c19Edge?.distanceMm, 0.461, 0.002);
	assert.deepEqual([panel.drill.total, panel.drill.plated, panel.drill.nonPlated], [1362, 1268, 94]);
	assert.equal(new Set(panel.mouseBites.candidates.flatMap(row => row.drillIds)).size, 90);
	assert.equal(panel.mouseBites.unclassifiedNonPlated.length, 4);
	const pasteReference = JSON.parse((await read(panelDir, '拼板SMT散热孔与锡膏开口抽核.json')).toString('utf8'));
	let matchedThermalHoles = 0;
	for (const row of pasteReference.exposedPadDrillCrosscheck) {
		const placement = panel.assembly.materialTraceability.find(item => item.designator === row.ref)?.placement;
		assert.ok(placement, row.ref);
		for (const [dx, dy, diameter] of row.overlapNativePasteBoundingBoxes) {
			assert.ok(panel.paste.artwork?.results.some(hit => hit.intersection === 'confirmed' && hit.plating === 'PLATED'
				&& Math.hypot(hit.centerMm[0] - placement.x - dx, hit.centerMm[1] - placement.y - dy) < 0.003
				&& Math.abs(hit.diameterMm - diameter) < 0.001), `${row.ref}: ${dx},${dy}`);
			matchedThermalHoles++;
		}
	}
	assert.ok(matchedThermalHoles > 60);
	assert.equal(panel.paste.stencil, null);
	console.log(JSON.stringify({ panelAssembly: panel.assembly.assemblyCounts, spAssembly: single.assembly.assemblyCounts,	maskMm: panel.mask.layers.find(layer => layer.side === 'top').closestPair.lowerBoundMil * 0.0254,	maskFindings: panel.mask.layers.find(layer => layer.side === 'top').findings.length,	c9u3: c9u3.distanceMm, c19Edge: c19Edge.distanceMm, plated: panel.drill.plated, nonPlated: panel.drill.nonPlated,	mouseBiteCount: new Set(panel.mouseBites.candidates.flatMap(row => row.drillIds)).size,	artworkOverlaps: panel.paste.artwork.results.length, matchedThermalHoles, actualStencil: panel.paste.stencilStatus }));
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
