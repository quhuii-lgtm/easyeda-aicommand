import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const evidence = resolve(root, '..', 'b5-oval-arc-20261026', 'evidence');
const [dsnText, sesText, wrappedSource, wrappedAfterSource, wrappedResult, wrappedReopenedSource] = await Promise.all([
	readFile(resolve(evidence, 'v115-combo-native.dsn'), 'utf8'),
	readFile(resolve(evidence, 'v115-combo-result.ses'), 'utf8'),
	readFile(resolve(evidence, 'v115-combo-before-source.json'), 'utf8'),
	readFile(resolve(evidence, 'v115-after-import-source.json'), 'utf8'),
	readFile(resolve(evidence, 'v115-combo-result.json'), 'utf8'),
	readFile(resolve(evidence, 'v115-reopened-source.json'), 'utf8'),
]);
const source = JSON.parse(wrappedSource).result.data.source;
const sourceAfterImport = JSON.parse(wrappedAfterSource).result.data.source;
const importedResultBaseline = JSON.parse(wrappedResult).result.data.routeBaseline;
const sourceAfterReopen = JSON.parse(wrappedReopenedSource).result.data.source;
const docHead = JSON.parse(source.split(/\r?\n/).find(line => line.startsWith('{"type":"DOCHEAD"}')).split('||')[1].replace(/\|$/, ''));
const built = await build({
	stdin: { contents: "export { pcbCommands } from '../src/commands/pcb.ts'; export { parseAutoRouteSes, mapSesRoutes, planSesImport } from '../src/engine/autoRouteSes.ts'; export { buildSesRouteBaseline, resolveSesArcCoverage } from '../src/pcb/sesArcCoverage.ts'; export { parseSourceLog, resolveRecords } from '../src/pcb/sourcelog.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'ses-arc-coverage-command-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
});
const { pcbCommands, parseAutoRouteSes, mapSesRoutes, planSesImport, buildSesRouteBaseline, resolveSesArcCoverage, parseSourceLog, resolveRecords } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
try {
const command = name => pcbCommands.find(item => item.name === name);
const arcRecords = [...resolveRecords(parseSourceLog(source)).values()].filter(record => record.header.type === 'ARC');
assert.equal(arcRecords.length, 3, 'v114 source has the three live ARC records');
const currentArcs = arcRecords.map(record => ({ id: record.header.id, header: record.header, data: record.data }));
const layers = [{ id: 1, name: 'TopLayer', type: 'SIGNAL', layerStatus: 1 }, { id: 2, name: 'BottomLayer', type: 'SIGNAL', layerStatus: 1 }, { id: 15, name: 'Inner1', type: 'SIGNAL', layerStatus: 1 }, { id: 16, name: 'Inner2', type: 'SIGNAL', layerStatus: 1 }];
const layerNames = new Map(layers.map(layer => [layer.id, layer.name]));
let focusUuid = docHead.uuid;
let sourceNow = source;
let freshDsnText = dsnText;
let changeFocusAfterExport = false;
let changeSourceAfterExport = false;
let lineWrites = 0;
let viaWrites = 0;
let nativeWrites = 0;
let freshDsnReads = 0;
let rows = { lines: [], vias: [], arcs: [] };
const getter = values => Object.fromEntries(Object.entries(values).map(([key, value]) => [`getState_${key}`, () => value]));
const lineItem = line => getter({ PrimitiveId: line.id, Net: line.net, Layer: line.layer, LineWidth: line.widthMil, StartX: line.a.x, StartY: line.a.y, EndX: line.b.x, EndY: line.b.y, PrimitiveLock: line.locked });
const viaItem = via => getter({ PrimitiveId: via.id, Net: via.net, X: via.x, Y: via.y, Diameter: via.diameterMil, HoleDiameter: via.holeDiameterMil, ViaType: via.viaType, PrimitiveLock: via.locked });
const arcItem = arc => getter({ PrimitiveId: arc.id, Net: arc.net, Layer: arc.layer, LineWidth: arc.widthMil, StartX: arc.start.x, StartY: arc.start.y, EndX: arc.end.x, EndY: arc.end.y, ArcAngle: arc.angle, PrimitiveLock: arc.locked });
function routeObjectsFromSource(sourceText) {
	const records = [...resolveRecords(parseSourceLog(sourceText)).values()];
	const lines = records.filter(record => record.header.type === 'LINE').map(record => ({ id: record.header.id, net: record.data.netName, layer: record.data.layerId, widthMil: record.data.width, a: { x: record.data.startX, y: record.data.startY }, b: { x: record.data.endX, y: record.data.endY }, locked: record.data.locked === true }));
	const vias = records.filter(record => record.header.type === 'VIA').map(record => ({ id: record.header.id, net: record.data.netName, x: record.data.centerX, y: record.data.centerY, diameterMil: record.data.viaDiameter, holeDiameterMil: record.data.holeDiameter ?? undefined, viaType: record.data.viaType === 'NORMAL' ? 0 : 1, locked: record.data.locked === true }));
	const arcs = records.filter(record => record.header.type === 'ARC').map(record => ({ id: record.header.id, net: record.data.netName, layer: record.data.layerId, widthMil: record.data.width, start: { x: record.data.startX, y: record.data.startY }, end: { x: record.data.endX, y: record.data.endY }, angle: record.data.angle, locked: record.data.locked === true }));
	return { lines, vias, arcs };
}
const stableFile = () => new Blob([freshDsnText], { type: 'application/dsn' });
globalThis.eda = {
	sys_Environment: { getEditorCurrentVersion: () => '4.1.78' },
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: 3, uuid: focusUuid }) },
	sys_FileManager: { getDocumentSource: async () => sourceNow },
	pcb_Layer: { getAllLayers: async () => layers },
	pcb_PrimitivePour: { getAll: async () => [] },
	pcb_PrimitivePoured: { getAll: async () => [] },
	pcb_PrimitiveLine: { getAll: async () => rows.lines.map(lineItem), getAllPrimitiveId: async () => rows.lines.map(line => line.id), create: async () => { lineWrites++; throw new Error('unexpected line write in coverage-only case'); }, delete: async () => true, modify: async () => { lineWrites++; throw new Error('unexpected line modify'); } },
	pcb_PrimitiveVia: { getAll: async () => rows.vias.map(viaItem), getAllPrimitiveId: async () => rows.vias.map(via => via.id), create: async () => { viaWrites++; throw new Error('unexpected via write in coverage-only case'); }, delete: async () => true },
	pcb_PrimitiveArc: { getAll: async () => rows.arcs.map(arcItem), getAllPrimitiveId: async () => rows.arcs.map(arc => arc.id), delete: async () => true },
	pcb_ManufactureData: { getDsnFile: async () => {
		freshDsnReads++;
		if (changeFocusAfterExport) focusUuid = `${docHead.uuid}-other`;
		if (changeSourceAfterExport) sourceNow = sourceNow.replace(/"startX":([^,}]+)/, (_match, value) => `"startX":${Number(value) + 0.01}`);
		const file = stableFile();
		Object.defineProperty(file, 'name', { value: 'v114.dsn' });
		return file;
	} },
	pcb_Drc: { getCurrentRuleConfiguration: async () => ({}), getNetRules: async () => [], check: async () => [] },
	pcb_Document: { importAutoRouteSesFile: async () => { nativeWrites++; throw new Error('unexpected native write in coverage-only case'); }, save: async () => true },
	sys_Storage: { setExtensionUserConfig: async (key, value) => { storage.set(key, value); return true; }, getExtensionUserConfig: key => storage.get(key) },
};
const storage = new Map();

const exported = await command('pcb.exportDsn').handler({}, {});
assert.equal(exported.routeBaseline?.status, 'complete', 'registered exportDsn returns a complete routeBaseline from the actual final DSN bytes');
assert.equal(exported.routeBaseline.arcs.length, 3);
assert.equal(exported.routeBaseline.protectedWires.length, 3);
assert.deepEqual(exported.routeBaseline, importedResultBaseline, 'the registered export matches the actual v115 result baseline');
const model = parseAutoRouteSes(sesText);
const seedCoverage = resolveSesArcCoverage(model.wires, exported.routeBaseline, docHead.uuid, currentArcs, layerNames);
assert.equal(seedCoverage.existingArcCoverage.length, 3);
assert.equal(seedCoverage.existingArcCoverage.reduce((sum, item) => sum + item.segmentCount, 0), 89);
const seeded = mapSesRoutes({ ...model, wires: seedCoverage.remainingWires }, layers);
assert.ok(seeded.lines.length > 0 && seeded.vias.length > 0, 'the complete SES leaves its ordinary route and via geometry after ARC chain removal');
const originalRoutes = routeObjectsFromSource(source);
const deltaPlan = planSesImport(seeded, { documentUuid: docHead.uuid, lines: originalRoutes.lines, vias: originalRoutes.vias }, 'append');
assert.equal(deltaPlan.deltaLines.length, 9, 'v114 source leaves nine real SES line additions');
assert.equal(deltaPlan.deltaVias.length, 3, 'v114 source leaves three real SES via additions');
const initialRoutes = routeObjectsFromSource(source);
const afterRoutes = routeObjectsFromSource(sourceAfterImport);
assert.equal(afterRoutes.lines.length, initialRoutes.lines.length + deltaPlan.deltaLines.length);
assert.equal(afterRoutes.vias.length, initialRoutes.vias.length + deltaPlan.deltaVias.length);
const beforeArcs = [...resolveRecords(parseSourceLog(source)).values()].filter(record => record.header.type === 'ARC');
const afterArcs = [...resolveRecords(parseSourceLog(sourceAfterImport)).values()].filter(record => record.header.type === 'ARC');
assert.deepEqual(beforeArcs.map(item => item.header.ticket), [171, 172, 173]);
assert.deepEqual(afterArcs.map(item => item.header.ticket), [174, 175, 176]);
assert.deepEqual(afterArcs.map(item => item.data), beforeArcs.map(item => item.data), 'v115 real after-import source preserves exact ARC data while replacing tickets');
sourceNow = sourceAfterImport;
rows = routeObjectsFromSource(sourceNow);
const importedSource = sourceNow;
assert.equal(rows.lines.length, originalRoutes.lines.length + deltaPlan.deltaLines.length, 'SDK mock lines are derived from real after-import source IDs');
assert.equal(rows.vias.length, originalRoutes.vias.length + deltaPlan.deltaVias.length, 'SDK mock vias are derived from real after-import source IDs');
const importCommand = command('pcb.importAutoRouteSes');
const success = await importCommand.handler({ base64: Buffer.from(sesText).toString('base64'), routeBaseline: exported.routeBaseline }, {});
assert.equal(success.alreadyPresent, true, 'complete original SES succeeds after exact ARC coverage is removed');
assert.equal(success.existingArcCoverage.length, 3);
assert.equal(success.existingArcCoverage.reduce((sum, item) => sum + item.segmentCount, 0), 89);
assert.equal(lineWrites + viaWrites + nativeWrites, 0, 'coverage-only import performs no route or native writes');
const repeated = await importCommand.handler({ base64: Buffer.from(sesText).toString('base64'), routeBaseline: exported.routeBaseline }, {});
assert.equal(repeated.alreadyPresent, true, 'repeated complete SES remains a zero-write no-op');
assert.equal(lineWrites + viaWrites + nativeWrites, 0);
sourceNow = sourceAfterReopen;
rows = routeObjectsFromSource(sourceNow);
const reopenedArcs = [...resolveRecords(parseSourceLog(sourceAfterReopen)).values()].filter(record => record.header.type === 'ARC');
assert.deepEqual(reopenedArcs.map(record => record.data), afterArcs.map(record => record.data), 'save/reopen source preserves exact ARC data');
assert.deepEqual(reopenedArcs.map(record => record.header.ticket), [174, 175, 176], 'save/reopen may keep the changed ARC tickets');
const reopenedRepeat = await importCommand.handler({ base64: Buffer.from(sesText).toString('base64'), routeBaseline: importedResultBaseline }, {});
assert.equal(reopenedRepeat.alreadyPresent, true, 'saved and reopened v115 source still accepts the original result baseline');
assert.equal(lineWrites + viaWrites + nativeWrites, 0, 'saved/reopened repeat remains zero-write');

function addSecondPathToWire(text, targetWireIndex) {
	const openings = [...text.matchAll(/\(wire\b/g)];
	const match = openings[targetWireIndex];
	assert.ok(match, `SES wire ${targetWireIndex} exists`);
	let depth = 0;
	let closeIndex = -1;
	for (let index = match.index; index < text.length; index++) {
		if (text[index] === '(') depth++;
		else if (text[index] === ')' && --depth === 0) { closeIndex = index; break; }
	}
	assert.ok(closeIndex > match.index, 'target SES wire closes');
	return `${text.slice(0, closeIndex)}\n(path Inner2 10000 2000000 2000000 2010000 2000000)\n${text.slice(closeIndex)}`;
}
const arcSesWire = success.existingArcCoverage[0].sesWireIndex;
const mixedSes = addSecondPathToWire(sesText, arcSesWire);
const beforeMixedWrite = lineWrites + viaWrites + nativeWrites;
await assert.rejects(() => importCommand.handler({ base64: Buffer.from(mixedSes).toString('base64'), routeBaseline: exported.routeBaseline }, {}), /包含多个path.*写入前拒绝/);
assert.equal(lineWrites + viaWrites + nativeWrites, beforeMixedWrite, 'ARC wire with an additional path is refused before line, via, or native writes');

function mutateArcStartX(value) {
	return value.split(/\r?\n/).map(line => {
		const split = line.indexOf('||');
		if (split < 0 || !line.slice(0, split).includes('"ARC"')) return line;
		const header = JSON.parse(line.slice(0, split));
		const data = JSON.parse(line.slice(split + 2).replace(/\|$/, ''));
		if (header.type === 'ARC') data.startX += 0.01;
		return `${JSON.stringify(header)}||${JSON.stringify(data)}|`;
	}).join('\n');
}
sourceNow = mutateArcStartX(importedSource);
const beforeChangedArcWrite = lineWrites + viaWrites + nativeWrites;
await assert.rejects(() => importCommand.handler({ base64: Buffer.from(sesText).toString('base64'), routeBaseline: exported.routeBaseline }, {}), /源码记录已变化或缺失/);
assert.equal(lineWrites + viaWrites + nativeWrites, beforeChangedArcWrite, 'changed exact ARC source record rejects the stale baseline before writes');
sourceNow = importedSource;

const originalGetDsnFile = globalThis.eda.pcb_ManufactureData.getDsnFile;
const firstProtected = exported.routeBaseline.protectedWires[0];
const originalPath = `(wire(path ${firstProtected.layerName} ${firstProtected.widthMil} ${firstProtected.points.flatMap(point => [point.xMil, point.yMil]).join(' ')} )`;
assert.ok(dsnText.includes(originalPath), 'first baseline protect chain has a directly editable native DSN path');
freshDsnText = dsnText.replace(originalPath, originalPath.replace(`${firstProtected.points[0].xMil}`, `${firstProtected.points[0].xMil + 0.01}`));
const beforeBadDsn = lineWrites + viaWrites + nativeWrites;
await assert.rejects(() => importCommand.handler({ base64: Buffer.from(sesText).toString('base64'), routeBaseline: exported.routeBaseline }, {}), /重新导出的native DSN完整ARC保护wire不匹配|无法完整关联ARC保护wire/);
assert.equal(lineWrites + viaWrites + nativeWrites, beforeBadDsn, 'fresh DSN point mismatch is rejected before writes');

freshDsnText = dsnText;
changeSourceAfterExport = true;
const beforeSourceChange = lineWrites + viaWrites + nativeWrites;
await assert.rejects(() => importCommand.handler({ base64: Buffer.from(sesText).toString('base64'), routeBaseline: exported.routeBaseline }, {}), /PCB 源码快照已变化/);
assert.equal(lineWrites + viaWrites + nativeWrites, beforeSourceChange, 'source mutation during native DSN export is rejected before writes');
changeSourceAfterExport = false;
sourceNow = importedSource;

changeFocusAfterExport = true;
const beforeFocusChange = lineWrites + viaWrites + nativeWrites;
await assert.rejects(() => importCommand.handler({ base64: Buffer.from(sesText).toString('base64'), routeBaseline: exported.routeBaseline }, {}), /PCB 焦点已变化/);
assert.equal(lineWrites + viaWrites + nativeWrites, beforeFocusChange, 'focus mutation during native DSN export is rejected before writes');
changeFocusAfterExport = false;
focusUuid = docHead.uuid;
globalThis.eda.pcb_ManufactureData.getDsnFile = originalGetDsnFile;

console.log('ses-arc-coverage-command-regression: PASS (registered export/import handlers; 3 ARC, 89 segments; fresh DSN/source/focus guards are zero-write)');
} catch (error) {
	console.error(`${error instanceof Error ? error.name : 'Error'}: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
