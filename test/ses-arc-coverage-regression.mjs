import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const built = await build({
	stdin: { contents: "export { buildSesRouteBaseline, assertSesRouteBaselineMatchesDsn, resolveSesArcCoverage } from '../src/pcb/sesArcCoverage.ts'; export { parseAutoRouteSes } from '../src/engine/autoRouteSes.ts'", resolveDir: resolve(root, 'test'), sourcefile: 'ses-arc-coverage-regression-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false, target: 'node24',
});
const { buildSesRouteBaseline, assertSesRouteBaselineMatchesDsn, resolveSesArcCoverage, parseAutoRouteSes } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const evidence = resolve(root, '..', 'b5-oval-arc-20261026', 'evidence');
const [dsn, sesText, wrappedSource] = await Promise.all([
	readFile(resolve(evidence, 'v114-combo-native.dsn'), 'utf8'),
	readFile(resolve(evidence, 'v114-combo-result.ses'), 'utf8'),
	readFile(resolve(evidence, 'v114-combo-before-source.json'), 'utf8'),
]);
const source = JSON.parse(wrappedSource).result.data.source;
const docHead = JSON.parse(source.split(/\r?\n/).find(line => line.startsWith('{"type":"DOCHEAD"}')).split('||')[1].replace(/\|$/, ''));
const baseline = buildSesRouteBaseline(docHead.uuid, source, dsn);
assert.equal(baseline.status, 'complete', JSON.stringify(baseline.issues));
assert.equal(baseline.arcs.length, 3);
assert.equal(baseline.protectedWires.length, 3);
assert.equal(new Set(baseline.protectedWires.map(item => item.dsnWireIndex)).size, 3, 'each ARC must bind to one unique actual DSN wire');
assertSesRouteBaselineMatchesDsn(baseline, docHead.uuid, source, dsn);
{
	const withUnrelatedWire = dsn.replace('(wiring', '(wiring\n    (wire(path TopLayer 20 1000 1000 1010 1000 )(net EXTRA)(type protect))');
	const shifted = buildSesRouteBaseline(docHead.uuid, source, withUnrelatedWire);
	assert.equal(shifted.status, 'complete');
	assert.notDeepEqual(shifted.protectedWires.map(item => item.dsnWireIndex), baseline.protectedWires.map(item => item.dsnWireIndex), 'unrelated wire shifts DSN indices');
	assertSesRouteBaselineMatchesDsn(baseline, docHead.uuid, source, withUnrelatedWire);
}
const model = parseAutoRouteSes(sesText);
const currentArcs = baseline.arcs.map(item => ({ id: item.id, header: item.header, data: item.data }));
const layerNames = new Map([[1, 'TopLayer'], [2, 'BottomLayer']]);
const coverage = resolveSesArcCoverage(model.wires, baseline, baseline.documentUuid, currentArcs, layerNames);
assert.equal(coverage.existingArcCoverage.length, 3);
assert.deepEqual(coverage.existingArcCoverage.map(item => item.segmentCount).sort((a, b) => a - b), [18, 18, 53]);
assert.ok(coverage.existingArcCoverage.every(item => item.status === 'verified' && Number.isInteger(item.dsnWireIndex) && Number.isInteger(item.sesWireIndex) && ['same', 'reverse'].includes(item.direction)));
assert.equal(coverage.existingArcCoverage.reduce((sum, item) => sum + item.segmentCount, 0), 89);
assert.equal(coverage.consumedWireIndices.length, 3);
{
	const ticketsChanged = currentArcs.map(arc => ({ ...arc, header: { ...arc.header, ticket: Number(arc.header.ticket) + 10 } }));
	const ticketCoverage = resolveSesArcCoverage(model.wires, baseline, baseline.documentUuid, ticketsChanged, layerNames);
	assert.equal(ticketCoverage.existingArcCoverage.length, 3, 'ARC tickets may change while ARC identity and data remain exact');
	const sourceTicketChanged = source.split(/\r?\n/).map(line => {
		const split = line.indexOf('||');
		if (split < 0) return line;
		const header = JSON.parse(line.slice(0, split));
		if (header.type === 'ARC') header.ticket = Number(header.ticket) + 10;
		return `${JSON.stringify(header)}${line.slice(split)}`;
	}).join('\n');
	assertSesRouteBaselineMatchesDsn(baseline, docHead.uuid, sourceTicketChanged, dsn);
	for (const mutate of [
		(header, _data) => { header.auditFlag = true; },
		(header, _data) => { header.id = 'different-arc-id'; },
		(header, _data) => { header.type = 'LINE'; },
		(_header, data) => { data.startX += 0.001; },
	]) {
		const changed = ticketsChanged.map(arc => ({ ...arc, header: { ...arc.header } }));
		changed[0].data = structuredClone(changed[0].data);
		mutate(changed[0].header, changed[0].data);
		assert.throws(() => resolveSesArcCoverage(model.wires, baseline, baseline.documentUuid, changed, layerNames), /源码记录已变化或缺失/);
	}
	for (const mutate of [
		(header, _data) => { header.auditFlag = true; },
		(header, _data) => { header.id = 'different-arc-id'; },
		(header, _data) => { header.type = 'LINE'; },
		(_header, data) => { data.startX += 0.001; },
	]) {
		const changedSource = source.split(/\r?\n/).map(line => {
			const split = line.indexOf('||');
			if (split < 0) return line;
			const header = JSON.parse(line.slice(0, split));
			const data = JSON.parse(line.slice(split + 2).replace(/\|$/, ''));
			if (header.type === 'ARC') mutate(header, data);
			return `${JSON.stringify(header)}||${JSON.stringify(data)}|`;
		}).join('\n');
		assert.throws(() => assertSesRouteBaselineMatchesDsn(baseline, docHead.uuid, changedSource, dsn), /无法完整关联ARC保护wire|完整ARC保护wire不匹配/);
	}
}
{
	const mixedPathWires = structuredClone(model.wires);
	const arcWire = mixedPathWires.find(wire => wire.wireIndex === coverage.existingArcCoverage[0].sesWireIndex);
	mixedPathWires.push({ ...structuredClone(arcWire), pathIndex: (arcWire.pathIndex ?? 0) + 1, layerName: 'Inner2', widthMil: 10, points: [{ xMil: 2000, yMil: 2000 }, { xMil: 2010, yMil: 2000 }] });
	assert.throws(() => resolveSesArcCoverage(mixedPathWires, baseline, baseline.documentUuid, currentArcs, layerNames), /包含多个path.*写入前拒绝/);
	const ordinaryMultiPath = structuredClone(mixedPathWires);
	const noArcBaseline = resolveSesArcCoverage(ordinaryMultiPath, undefined, baseline.documentUuid, [], layerNames);
	assert.equal(noArcBaseline.remainingWires, ordinaryMultiPath, 'ordinary no-ARC manual SES keeps multi-path wires in the existing path');
}
{
	const reversed = structuredClone(model.wires);
	const wire = reversed.find(item => item.wireIndex === coverage.existingArcCoverage[0].sesWireIndex);
	wire.points.reverse();
	const reverseCoverage = resolveSesArcCoverage(reversed, baseline, baseline.documentUuid, currentArcs, layerNames);
	assert.equal(reverseCoverage.existingArcCoverage.find(item => item.arcId === coverage.existingArcCoverage[0].arcId).direction, 'reverse');
}
{
	const sparse = structuredClone(baseline);
	const protectedWire = sparse.protectedWires[0];
	protectedWire.points = [protectedWire.points[0], protectedWire.points[Math.floor(protectedWire.points.length / 2)], protectedWire.points.at(-1)];
	assert.throws(() => assertSesRouteBaselineMatchesDsn(sparse, docHead.uuid, source, dsn), /完整ARC保护wire不匹配/);
}

for (const mutate of [
	data => { data.startX += 0.001; },
	data => { data.netName = 'OTHER'; },
	data => { data.layerId = 1; },
	data => { data.width += 0.001; },
]) {
	const changed = currentArcs.map(item => ({ ...item, data: structuredClone(item.data) }));
	mutate(changed[0].data);
	assert.throws(() => resolveSesArcCoverage(model.wires, baseline, baseline.documentUuid, changed, layerNames), /源码记录已变化或缺失/);
}
{
	const changedId = currentArcs.map(item => ({ ...item }));
	changedId[0].id = 'renamed-arc';
	assert.throws(() => resolveSesArcCoverage(model.wires, baseline, baseline.documentUuid, changedId, layerNames), /源码记录已变化或缺失/);
}

const firstBaseline = baseline.protectedWires[0];
const firstSes = model.wires.find(wire => wire.net === firstBaseline.net && wire.layerName === firstBaseline.layerName && wire.widthMil === firstBaseline.widthMil && wire.points.length === firstBaseline.points.length && wire.points.every((point, index) => point.xMil === firstBaseline.points[index].xMil && point.yMil === firstBaseline.points[index].yMil));
assert.ok(firstSes, 'real SES must contain exact complete protected path');
for (const mutate of [
	wire => { wire.points[1].xMil += 0.001; },
	wire => { wire.widthMil += 0.001; },
	wire => { wire.net = 'OTHER'; },
	wire => { wire.layerName = 'TopLayer'; },
	wire => { wire.type = 'route'; },
]) {
	const changedWires = structuredClone(model.wires);
	mutate(changedWires.find(wire => wire.wireIndex === firstSes.wireIndex));
	assert.throws(() => resolveSesArcCoverage(changedWires, baseline, baseline.documentUuid, currentArcs, layerNames), /完整且唯一匹配/);
}
{
	const duplicated = structuredClone(model.wires);
	const duplicate = structuredClone(firstSes);
	duplicate.wireIndex = Math.max(...duplicated.map(wire => wire.wireIndex)) + 1;
	duplicated.push(duplicate);
	assert.throws(() => resolveSesArcCoverage(duplicated, baseline, baseline.documentUuid, currentArcs, layerNames), /完整且唯一匹配/);
}
{
	const split = structuredClone(model.wires);
	const targetIndex = split.findIndex(wire => wire.wireIndex === firstSes.wireIndex);
	const original = split.splice(targetIndex, 1)[0];
	const mid = Math.floor(original.points.length / 2);
	const nextIndex = Math.max(...split.map(wire => wire.wireIndex)) + 1;
	split.push({ ...original, wireIndex: nextIndex, points: original.points.slice(0, mid + 1) });
	split.push({ ...original, wireIndex: nextIndex + 1, points: original.points.slice(mid) });
	assert.throws(() => resolveSesArcCoverage(split, baseline, baseline.documentUuid, currentArcs, layerNames), /完整且唯一匹配/);
}
{
	const incomplete = structuredClone(baseline);
	incomplete.protectedWires.pop();
	assert.throws(() => resolveSesArcCoverage(model.wires, incomplete, baseline.documentUuid, currentArcs, layerNames), /完整一对一关联/);
}
{
	const duplicate = structuredClone(baseline);
	duplicate.protectedWires.push({ ...structuredClone(duplicate.protectedWires[0]), dsnWireIndex: Math.max(...duplicate.protectedWires.map(item => item.dsnWireIndex)) + 1 });
	assert.throws(() => resolveSesArcCoverage(model.wires, duplicate, baseline.documentUuid, currentArcs, layerNames), /未形成完整一对一关联/);
}
{
	const conflictingRecords = [...currentArcs, { type: 'LINE', id: baseline.arcs[0].id, data: {} }];
	assert.throws(() => resolveSesArcCoverage(model.wires, baseline, baseline.documentUuid, currentArcs, layerNames, conflictingRecords), /存在重复ID/);
}
{
	assert.throws(() => resolveSesArcCoverage(model.wires, undefined, baseline.documentUuid, currentArcs, layerNames), /未提供导出DSN routeBaseline/);
	const manualWires = coverage.remainingWires;
	const manual = resolveSesArcCoverage(manualWires, undefined, baseline.documentUuid, currentArcs, layerNames);
	assert.equal(manual.remainingWires, manualWires, 'ordinary manual SES without an ARC protect chain keeps prior behavior');
}

console.log('ses-arc-coverage-regression: PASS (v114 fixture: 3 ARC, 89 protected segments)');
