import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: { contents: 'export { analyzeLocalRouting } from \'../src/pcb/localRoutingReview.ts\'; export { reviewLocalRouting } from \'../src/commands/localRoutingReview.ts\'', resolveDir: resolve(root, 'test'), sourcefile: 'local-routing-review-entry.ts' },
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
	});
	const { analyzeLocalRouting, reviewLocalRouting } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

	const basic = analyzeLocalRouting({
		nets: ['A', 'B'],
		lines: [
			{ id: 'a1', net: 'A', layer: 1, width: 10, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
			{ id: 'b1', net: 'B', layer: 1, width: 10, start: { x: 0, y: 30 }, end: { x: 100, y: 30 } },
		],
	});
	assert.equal(basic.minimumTraceClearance.byLayer[0].clearanceMil, 20);
	assert.equal(basic.tracks.fullNetConnectivityVerified, false);

	const withArcPadAndVia = analyzeLocalRouting({
		nets: ['A', 'B'],
		lines: [{ id: 'route', net: 'A', layer: 1, width: 10, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }],
		arcs: [{ id: 'arc', net: 'B', layer: 1, width: 10, start: { x: 0, y: 100 }, end: { x: 100, y: 100 }, sweepDegrees: 90 }],
		pads: [
			{ id: 'pad-circle', net: 'B', layer: 1, x: 50, y: 30, rotation: 0, shape: ['ELLIPSE', 20, 20] },
			{ id: 'pad-complex', net: 'B', layer: 1, x: 50, y: 40, rotation: 0, shape: ['POLYGON', []] },
			{ id: 'pad-drill', net: 'B', layer: 12, x: 50, y: 50, rotation: 0, shape: ['ELLIPSE', 40, 40], hole: ['ROUND', 20] },
		],
		vias: [
			{ id: 'through-via', net: 'B', x: 50, y: 60, diameter: 20, holeDiameter: 10, viaType: 0 },
			{ id: 'blind-via', net: 'B', x: 50, y: 70, diameter: 20, holeDiameter: 10, viaType: 1 },
		],
	});
	assert.equal(withArcPadAndVia.tracks.arcCount, 1);
	assert.ok(withArcPadAndVia.minimumTraceClearance.byLayer[0].clearanceMil < 20);
	assert.ok(withArcPadAndVia.minimumTraceClearance.byLayer[0].pair.includes('pad-circle'));
	assert.ok(withArcPadAndVia.objects.unsupportedPadIds.includes('pad-complex'));
	assert.ok(withArcPadAndVia.objects.unsupportedPadIds.includes('pad-drill'), 'a drill void is not treated as solid copper');
	assert.ok(withArcPadAndVia.objects.unsupportedViaIds.includes('blind-via'), 'unknown blind-via span stays unsupported');
	assert.equal(withArcPadAndVia.coverage.crossLayerRouting, 'unknown');
	assert.equal(withArcPadAndVia.tracks.fullNetConnectivityVerified, false);

	const sameNetPad = analyzeLocalRouting({
		nets: ['A'],
		lines: [{ id: 'route-to-pad', net: 'A', layer: 1, width: 10, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } }],
		pads: [{ id: 'pad', net: 'A', layer: 1, x: 100, y: 0, rotation: 0, shape: ['ELLIPSE', 20, 20] }],
	});
	assert.equal(sameNetPad.contacts.sameNetRouteToSupportedPadShapeCandidates.length, 1);
	assert.equal(sameNetPad.contacts.electricalConnectivityProven, false);

	function roundedRectInput(round) {
		return {
			nets: ['A'],
			lines: [{ id: 'corner-trace', net: 'A', layer: 1, width: 0.2, start: { x: -49, y: 19.5 }, end: { x: -49, y: 19.8 } }],
			pads: [{ id: 'rect', net: 'B', layer: 1, x: 0, y: 0, rotation: 0, shape: ['RECT', 100, 40, round], special: [] }],
		};
	}
	const squareCorner = analyzeLocalRouting(roundedRectInput(0));
	const roundedCorner = analyzeLocalRouting(roundedRectInput(20));
	assert.ok(squareCorner.minimumTraceClearance.byLayer[0].centerlineClearanceMil < 0, 'zero round remains a square corner');
	assert.ok(roundedCorner.minimumTraceClearance.byLayer[0].centerlineClearanceMil > 0, 'SDK round=20 means a 4mil radius at 100x40mil, not 20mil');

	const unknownGeometry = analyzeLocalRouting({
		nets: ['A'],
		lines: [
			{ id: 'known-route', net: 'A', layer: 1, width: 5, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
			{ id: 'unknown-net-line', net: '', layer: 1, width: 5, start: { x: 0, y: 15 }, end: { x: 100, y: 15 } },
			{ id: 'zero-width', net: 'A', layer: 1, width: 0, start: { x: 0, y: 10 }, end: { x: 100, y: 10 } },
		],
		pads: [{ id: 'unsupported-layer-pad', net: 'B', layer: 15, x: 50, y: 30, rotation: 0, shape: ['ELLIPSE', 10, 10], special: [] }],
	});
	assert.equal(unknownGeometry.objects.unsupportedTraceIds.includes('zero-width'), true);
	assert.equal(unknownGeometry.objects.unsupportedPadLayerIds.includes('unsupported-layer-pad'), true);
	assert.equal(unknownGeometry.unknownNetGeometry.nearestByLayer[0].objectId, 'unknown-net-line');
	assert.equal(unknownGeometry.unknownNetGeometry.includedInMinimumClearance, false);
	assert.equal(unknownGeometry.coverage.geometryCompleteness, 'partial');

	function sourceFor(uuid, revision) {
		return [
			`${JSON.stringify({ type: 'DOCHEAD', ticket: 0 })}||${JSON.stringify({ docType: 'PCB', uuid, client: 'fixture' })}|`,
			`${JSON.stringify({ type: 'TRACK', id: 'source-track' })}||${JSON.stringify({ width: revision })}|`,
		].join('\n');
	}
	function sdkPad(id) {
		return {
			getState_PrimitiveId: () => id,
			getState_Net: () => 'B',
			getState_Rotation: () => 0,
			getState_Pad: () => ['ELLIPSE', 20, 20],
			getState_Hole: () => null,
			getState_SpecialPad: () => [],
			getState_Layer: () => 1,
			getState_X: () => 20,
			getState_Y: () => 10,
		};
	}
	function sdkLine() {
		return {
			getState_PrimitiveId: () => 'runtime-line',
			getState_Net: () => 'A',
			getState_Layer: () => 1,
			getState_LineWidth: () => 5,
			getState_StartX: () => 0,
			getState_StartY: () => 0,
			getState_EndX: () => 100,
			getState_EndY: () => 0,
		};
	}
	const target = { documentType: 3, uuid: 'fixture-pcb', tabId: 'fixture-tab', projectUuid: 'fixture-project' };
	let sourceRevision = 1;
	globalThis.eda = {
		sys_FileManager: { getDocumentSource: async () => sourceFor(target.uuid, sourceRevision) },
		pcb_PrimitiveLine: { getAll: async () => {
			sourceRevision++;
			return [sdkLine()];
		} },
		pcb_PrimitiveArc: { getAll: async () => [] },
		pcb_PrimitiveVia: { getAll: async () => [] },
		pcb_PrimitivePad: { getAll: async () => [sdkPad('pin-1')] },
		pcb_PrimitiveComponent: { getAll: async () => [{ getState_PrimitiveId: () => 'component-1', getAllPins: async () => [sdkPad('pin-1')] }] },
	};
	const context = { documentTarget: target, assertDocumentTarget: async () => {} };
	const staleReport = await reviewLocalRouting({ nets: ['A'] }, context);
	assert.equal(staleReport.freshness.status, 'stale', 'source revision changes during category reads must mark the result stale');
	assert.equal(staleReport.resultStatus, 'stale');
	assert.equal(staleReport.readStatus.pads.count, 1, 'independent pad and component pin copies deduplicate by primitive ID');
	assert.equal(staleReport.geometryCompleteness.status, 'partial');

	globalThis.eda = {
		sys_FileManager: { getDocumentSource: async () => { throw new Error('source unavailable'); } },
		pcb_PrimitiveLine: { getAll: async () => [sdkLine()] },
		pcb_PrimitiveArc: { getAll: async () => { throw new Error('arc category unavailable'); } },
		pcb_PrimitiveVia: { getAll: async () => [] },
		pcb_PrimitivePad: { getAll: async () => [] },
		pcb_PrimitiveComponent: { getAll: async () => [] },
	};
	const incompleteReport = await reviewLocalRouting({ nets: ['A'] }, context);
	assert.equal(incompleteReport.freshness.status, 'unknown');
	assert.equal(incompleteReport.readStatus.arcs.status, 'unknown');
	assert.equal(incompleteReport.coverage.categoryReadCompleteness.arcs, 'unknown');
	assert.equal(incompleteReport.resultStatus, 'unknown');
	assert.equal(incompleteReport.geometryCompleteness.status, 'partial');

	console.log('PASS line/arc/pad/via estimates, rounded-RECT SDK percent conversion, unsupported-layer and unknown-net reporting, read-category failure, stale revision binding, and deduplicated component pins');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
