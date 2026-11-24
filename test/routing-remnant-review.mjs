import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const args = process.argv.slice(2);
const files = await build({
	stdin: {
		contents: `
export { routingRemnantSource } from '../src/pcb/routingRemnantSource.ts';
export { analyzeRoutingRemnants } from '../src/pcb/routingRemnantAnalysis.ts';
export { routingRemnantCommands } from '../src/commands/routingRemnants.ts';
export { analyzeDetourBoard } from '../src/commands/routingDetours.ts';
export { routingDetourSource } from '../src/pcb/routingDetourSource.ts';
export { parseSourceLog, resolveRecords } from '../src/pcb/sourcelog.ts';
		`,
		resolveDir: import.meta.dirname,
		loader: 'ts',
	},
	bundle: true,
	write: false,
	platform: 'node',
	format: 'esm',
});
const { routingRemnantSource, analyzeRoutingRemnants, routingRemnantCommands, analyzeDetourBoard, routingDetourSource, parseSourceLog, resolveRecords }
	= await import(`data:text/javascript;base64,${Buffer.from(files.outputFiles[0].text).toString('base64')}`);
// Keep failures readable when a bundled function appears in an error stack.
Error.prepareStackTrace = (error, frames) => [error.toString(), ...frames.slice(0, 8).map(frame =>
	`    at ${frame.getFileName()?.startsWith('data:') ? 'bundled review' : frame.getFileName()}:${frame.getLineNumber()}`,
)].join('\n');

const body = (type, id, data) => `${JSON.stringify({ type, id, ticket: 1 })}||${JSON.stringify(data)}|`;
const uuid = '97c5fabb2b4ecf53';
const fixture = [
	body('DOCHEAD', 'head', { uuid, docType: 'PCB' }),
	body('LAYER', 'top', { layerId: 1, layerType: 'TOP', use: true }),
	body('LAYER', 'bottom', { layerId: 2, layerType: 'BOTTOM', use: true }),
	body('LINE', 'stub', { netName: 'SIG', layerId: 1, startX: 0, startY: 0, endX: 25, endY: 0, width: 4 }),
	body('VIA', 'unknown-span', { netName: 'SIG', centerX: 25, centerY: 0, viaType: 'BLIND', holeDiameter: 10, viaDiameter: 20 }),
	body('POUR', 'pour', { netName: 'SIG', layerId: 2, path: [[0, 0, 'L', 10, 0, 10, 10, 0, 0]] }),
	body('PAD_NET', '["PAD_NET","comp","1","pin"]', { padNet: 'SIG' }),
].join('\n');
const capture = routingRemnantSource(fixture);
assert.equal(capture.uuid, uuid);
assert.deepEqual(capture.layers.map(layer => layer.id), [1, 2]);
assert.equal(capture.vias[0].layers, null);
assert.equal(capture.copper.length, 0, 'pour boundary is never treated as actual copper');
assert.equal(capture.issues.length, 3, 'missing fill, pad geometry and unknown via span are reported');

let reads = 0;
let changed = false;
globalThis.eda = {
	sys_FileManager: {
		getDocumentSource: async () => {
			reads++;
			return changed && reads % 2 === 0 ? fixture.replace('"width":4', '"width":5') : fixture;
		},
	},
	pcb_PrimitivePad: { getAll: async () => [] },
	pcb_PrimitiveComponent: { getAll: async () => [] },
};
const command = routingRemnantCommands[0];
assert.equal(command.name, 'pcb.reviewRoutingRemnants');
const ctx = { documentTarget: { uuid, documentType: 3 }, assertDocumentTarget: async () => {} };
await assert.rejects(command.handler({ nets: [] }, ctx), /nets/);
await assert.rejects(command.handler({}, { ...ctx, documentTarget: { uuid: 'wrong', documentType: 3 } }), /身份|UUID/);
await assert.rejects(command.handler({ nets: ['TYPO'] }, ctx), /未找到指定网络/);
reads = 0;
const online = await command.handler({}, ctx);
assert.equal(online.scope, 'whole-board');
assert.equal(online.safety.deletionAuthorized, false);
assert.equal(reads, 2);
changed = true;
await assert.rejects(command.handler({}, ctx), /改变|失效/);
console.log('PASS scan entry, PCB identity, missing pad/fill/span evidence, and stale board rejection');

const point = (x, y) => ({ x, y });
const rect = (left, bottom, right, top) => [point(left, bottom), point(right, bottom), point(right, top), point(left, top)];
const controlled = analyzeRoutingRemnants({
	tracks: [
		{ id: 'first', net: 'SIG', layer: 1, width: 4, a: point(0, 0), b: point(25, 0) },
		{ id: 'exact-repeat', net: 'SIG', layer: 1, width: 4, a: point(25, 0), b: point(0, 0) },
		{ id: 'end-contact', net: 'SIG', layer: 1, width: 4, a: point(25, 0), b: point(40, 0) },
		{ id: 'partial-a', net: 'PARTIAL', layer: 1, width: 4, a: point(0, 50), b: point(25, 50) },
		{ id: 'partial-b', net: 'PARTIAL', layer: 1, width: 4, a: point(10, 50), b: point(35, 50) },
	],
	vias: [
		{ id: 'plane-stitch', net: 'GND', x: 6, y: 6, diameter: 4, hole: 2, layers: [1, 2] },
		{ id: 'in-hole', net: 'GND', x: 20, y: 20, diameter: 4, hole: 2, layers: [1, 2] },
		{ id: 'span-unknown', net: 'GND', x: 25, y: 24, diameter: 4, hole: 2, layers: null },
		{ id: 'unpainted-stroke-interior', net: 'OPEN', x: 24, y: 16, diameter: 4, hole: 2, layers: [1, 2] },
	],
	pads: [],
	copper: [
		{ id: 'top', net: 'GND', layer: 1, rings: [rect(0, 0, 40, 40), rect(15, 15, 25, 25)] },
		{ id: 'bottom', net: 'GND', layer: 2, rings: [rect(0, 0, 12, 12)] },
		{ id: 'open-stroke', net: 'OPEN', layer: 1, rings: [[point(10, 10), point(30, 10), point(30, 30)]], stroke: 2 },
	],
});
const overlaps = controlled.candidates.filter(item => item.kind === 'collinear-overlap');
assert.equal(overlaps.length, 2);
assert.deepEqual([...overlaps.find(item => item.net === 'SIG').objectIds].sort(), ['exact-repeat', 'first']);
assert.deepEqual([...overlaps.find(item => item.net === 'PARTIAL').objectIds].sort(), ['partial-a', 'partial-b']);
assert.ok(!controlled.candidates.some(item => item.objectIds.includes('span-unknown')));
assert.ok(!controlled.candidates.some(item => item.objectIds.includes('plane-stitch')), 'preserve a via which joins the two real copper layers');
assert.ok(controlled.candidates.some(item => item.kind === 'via-connectivity' && item.objectIds.includes('in-hole')), 'a cutout is not conductive');
assert.equal(controlled.viaConnectivity.find(via => via.id === 'unpainted-stroke-interior').classification, 'isolated');
assert.ok(controlled.coverage.unknownViaSpanIds.includes('span-unknown'));
assert.ok(controlled.candidates.every(item => item.requiresHumanReview));
console.log('PASS exact duplicate, endpoint exclusion, unknown-span exclusion and mandatory human review');

function boundPads(source) {
	const records = [...resolveRecords(parseSourceLog(source)).values()];
	const components = new Map();
	const pins = new Map();
	for (const { header, data } of records) {
		if (header.type === 'COMPONENT') components.set(header.id, data);
		if (header.type === 'PAD_NET') {
			const [, owner, number, pin] = JSON.parse(header.id);
			pins.set(owner + pin, { owner, number, net: data.padNet });
		}
	}
	return { components, pins };
}

function projectSavedPads(pads, old, current) {
	return pads.flatMap(pad => {
		const originalPin = old.pins.get(pad.padId);
		const currentPin = current.pins.get(pad.padId);
		if (!originalPin || !currentPin || currentPin.owner !== originalPin.owner
			|| [originalPin, currentPin].some(pin => pin.number !== pad.padNumber || pin.net !== pad.net))
			return [];
		const a = old.components.get(originalPin.owner);
		const b = current.components.get(currentPin.owner);
		if (!a || !b || a.layerId !== b.layerId || ![a.x, a.y, a.angle, b.x, b.y, b.angle].every(Number.isFinite))
			return [];
		const rotation = b.angle - a.angle;
		const radians = rotation * Math.PI / 180;
		const dx = pad.x - a.x, dy = pad.y - a.y;
		return [{
			id: pad.padId, net: pad.net, layer: pad.layer, shape: pad.shape,
			rotation: pad.rotation + rotation,
			x: b.x + dx * Math.cos(radians) - dy * Math.sin(radians),
			y: b.y + dx * Math.sin(radians) + dy * Math.cos(radians),
		}];
	});
}

if (args.length) {
	assert.ok(args.length === 2 || args.length === 4, 'Pass before and after PCB source paths, optionally followed by pad snapshot and its paired PCB source');
	const [before, after, padFile, padSource] = args;
	const pads = padFile ? Object.values(JSON.parse((await readFile(padFile, 'utf8')).replace(/^\uFEFF/, ''))).flat() : undefined;
	const original = padSource ? boundPads(await readFile(padSource, 'utf8')) : undefined;
	const reports = [];
	for (const file of [before, after]) {
		const source = await readFile(file, 'utf8');
		const projected = pads ? projectSavedPads(pads, original, boundPads(source)) : undefined;
		const input = routingRemnantSource(source, projected);
		const result = analyzeRoutingRemnants({
			...input,
			issues: input.issues.map(issue => ({ objectId: issue.id, net: issue.net, code: 'source-coverage', message: issue.reason })),
		});
		const detour = analyzeDetourBoard(routingDetourSource(source, projected));
		reports.push({ file, layerIds: input.layers.map(layer => layer.id), tracks: input.tracks.length, vias: input.vias.length,
			copper: input.copper.length, projectedPads: projected?.length ?? 0,
			projectedVbatPads: projected?.filter(pad => pad.net === 'VBAT').length ?? 0, missingInput: input.issues.length,
			sourceSha256: createHash('sha256').update(source).digest('hex'), result,
			detour: {
				pathCount: detour.paths.length, previewCount: detour.geometryPreviews.length, candidateCount: detour.candidates.length,
				coverage: detour.coverage, rules: detour.rules,
				paths: detour.paths.map(path => ({ net: path.net, start: path.start, end: path.end, trackIds: path.trackIds, viaIds: path.viaIds,
					status: path.status, shortening: path.shortening.status, lengthMil: path.lengthMil, turns: path.turnCount,
					vias: path.viaCount, foldbacks: path.foldbackCount })),
			} });
	}
	console.log(JSON.stringify(reports));
	if (padFile && before.endsWith('57x35-五路摆放与余线最终复核-重开.epru')) {
		const expected = [
			'23d2cc538d2cdebe', 'bd56989f6d991063', '362b20faea260517', '49a7625b3b30a0ba', '64a1090ca13a3541',
			'a047904ec1b34e5d', 'c4eb95fbe1848d66', 'f4e85c373076573c', '1d33f7ed7ea65bea', 'e5d227fc7201ccbb',
			'd7d6bd370e25efc7', 'f3b7cd5e2ed47342',
		];
		for (const report of reports) {
			assert.deepEqual(report.layerIds, [1, 2, 15, 16]);
			assert.equal(report.projectedPads, 329);
			assert.equal(report.projectedVbatPads, 29);
			const path = report.detour.paths.find(item => item.viaIds.includes('03e4c4a66f4cedf9')
				&& item.trackIds.includes('345e21368775e309'));
			assert.equal(path?.net, 'GND');
			assert.deepEqual(path.trackIds, ['345e21368775e309', 'e8160ce7a7407a38', 'e983f6cd8eb2b75a']);
			const lengthFromSavedEndpoints = Math.hypot(8.4079, 8.4079) + (3440.7 - 3353.0347);
			assert.ok(Math.abs(path.lengthMil - lengthFromSavedEndpoints) < 0.001);
			assert.deepEqual([path.turns, path.vias, path.foldbacks], [1, 1, 0]);
			assert.equal(report.detour.candidateCount, 0, 'SP-01 source-only replay cannot verify current live shortening rules');
		}
		const candidateIds = report => new Set(report.result.candidates.filter(item => item.net === 'VBAT').flatMap(item => item.objectIds));
		const [oldCandidates, currentCandidates] = reports.map(candidateIds);
		assert.deepEqual(expected.filter(id => !oldCandidates.has(id)), [], 'SP-01: expected VBAT objects missing from the pre-cleanup candidates');
		assert.deepEqual(expected.filter(id => currentCandidates.has(id)), [], 'SP-01: removed objects persisted in post-cleanup candidates');
	}
}
