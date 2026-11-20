import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

async function main() {
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/copper-shape-review.json');
const fixtures = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
const bundle = await build({ entryPoints: [path.join(repo, 'src/pcb/copperShapeReview.ts')], bundle: true, platform: 'node', format: 'iife', globalName: 'shapeModule', write: false });
const sandbox = { exports: {}, module: { exports: {} } };
vm.runInNewContext(bundle.outputFiles[0].text, sandbox);
const { analyzeCopperShape, parseCopperPath, sameCopperPath } = sandbox.shapeModule;

const commandBundle = await build({ entryPoints: [path.join(repo, 'src/commands/copperShapeReview.ts')], bundle: true, platform: 'node', format: 'iife', globalName: 'commandModule', write: false });
const commandSandbox = { exports: {}, module: { exports: {} }, eda: {} };
vm.runInNewContext(commandBundle.outputFiles[0].text, commandSandbox);

const rectangle = analyzeCopperShape({ filledPaths: fixtures.rectangularFill.paths, fineness: fixtures.rectangularFill.fineness, crossSections: [fixtures.rectangularFill.crossSection] });
assert.ok(Math.abs(rectangle.crossSections[0].copperSpansMil[0] - fixtures.rectangularFill.expectedWidthMil) < 1e-8);

const donut = analyzeCopperShape({ filledPaths: fixtures.donutFill.paths, fineness: fixtures.donutFill.fineness, crossSections: [fixtures.donutFill.crossSection] });
assert.deepEqual(Array.from(donut.crossSections[0].copperSpansMil), fixtures.donutFill.expectedSpansMil);
assert.equal(donut.regions[0].netContourAreaMil2, fixtures.donutFill.expectedNetAreaMil2);
assert.equal(donut.coverage.islands, 'unknown');

const exact45 = analyzeCopperShape({ filledPaths: [{ id: 'exact-45-triangle', fill: true, lineWidth: 0, path: [[0, 0, 'L', 10, 0, 5, 5, 0, 0]] }], fineness: 0 });
assert.equal(exact45.regions[0].sharpCornerCandidates.length, 0, 'an exact 45 degree corner is not a candidate');

const arc = parseCopperPath(fixtures.dShape.path);
assert.equal(arc[0].segments.filter(segment => segment.kind === 'arc').length, 1);
assert.equal(arc[0].segments.find(segment => segment.kind === 'arc').sweepDegrees, 180);
const leadingZeroLine = parseCopperPath([[0, 0, 'L', 0, 0, 'L', 10, 0, 10, 10, 0, 0]]);
assert.equal(leadingZeroLine[0].closed, true, 'a zero-length leading L should be skipped safely');
const dShape = [{ id: 'D-shape', fill: true, lineWidth: 0, path: fixtures.dShape.path }];
const diameter = analyzeCopperShape({ filledPaths: dShape, fineness: 0, crossSections: [fixtures.dShape.diameterCrossSection] });
assert.ok(Math.abs(diameter.crossSections[0].copperSpansMil[0] - fixtures.dShape.expectedDiameterCopperMil) < 1e-8);
const outside = analyzeCopperShape({ filledPaths: dShape, fineness: 0, crossSections: [fixtures.dShape.outsideCrossSection] });
assert.equal(outside.crossSections[0].copperSpansMil.length, 0);

for (const sample of fixtures.nearTangentCircle.sections) {
	const result = analyzeCopperShape({ filledPaths: [{ id: 'circle', fill: true, lineWidth: 0, path: fixtures.nearTangentCircle.path }], fineness: 0, crossSections: [{ id: `y-${sample.y}`, start: { x: -15, y: sample.y }, end: { x: 15, y: sample.y } }] });
	assert.equal(result.crossSections[0].copperSpansMil.length, 1);
	assert.ok(Math.abs(result.crossSections[0].copperSpansMil[0] - sample.expectedWidthMil) < 1e-5);
}

const open = analyzeCopperShape({ filledPaths: fixtures.openStroke.paths, fineness: fixtures.openStroke.fineness, crossSections: [fixtures.openStroke.crossSection] });
assert.equal(open.openStrokes[0].lineWidthMil, fixtures.openStroke.expectedLineWidthMil);
assert.ok(Math.abs(open.crossSections[0].copperSpansMil[0] - fixtures.openStroke.expectedCopperSpanMil) < 1e-8, 'open stroke must not receive the fill fineness allowance');
assert.equal(Object.hasOwn(open.crossSections[0], 'contourInteriorSpansMil'), false);

assert.equal(sameCopperPath([[0, 0, 'L', 1, 0]], [0, 0, 'L', 1, 0]), true);
assert.equal(sameCopperPath([['R', 520, 5810, 510, 410, 0, 0]], ['R', 520, 5810, 510, 410, 0, 0]), true);
assert.equal(sameCopperPath([[0, 0, 'L', 1, 0]], [0, 0, 'L', 1, 0]), true);
assert.equal(sameCopperPath([[[0, 0, 'L', 1, 0]]], [0, 0, 'L', 1, 0]), false, 'do not normalize an extra wrapper');
assert.equal(sameCopperPath([[[0, 0, 'L', 1, 0]], [[2, 0, 'L', 3, 0]]], [0, 0, 'L', 1, 0]), false, 'only a single-ring wrapper may be normalized');

const target = { documentType: 3, uuid: 'test-board' };
const context = { documentTarget: target, assertDocumentTarget: async () => undefined };
commandSandbox.eda.pcb_PrimitivePour = { get: async () => ({ getState_PrimitiveId: () => 'different-id' }) };
await assert.rejects(commandSandbox.commandModule.reviewCopperShape({ primitiveId: 'requested-id' }, context), /返回了不同图元/);
commandSandbox.eda.pcb_PrimitivePour = { get: async () => ({ getState_PrimitiveId: () => 'requested-id', getState_Net: () => 'GND', getState_Layer: () => false }) };
await assert.rejects(commandSandbox.commandModule.reviewCopperShape({ primitiveId: 'requested-id' }, context), /覆铜层 不是有限数值/);

assert.throws(() => parseCopperPath([[0, 0, 'Q', 2, 2]]), /不支持的铜形路径元素/);
assert.throws(() => parseCopperPath(fixtures.unsupportedCarc), /CARC.*没有经验证/);
assert.throws(() => analyzeCopperShape({ filledPaths: [{ id: 'bad', fill: true, lineWidth: 1, path: fixtures.rectangularFill.paths[0].path }], fineness: 8 }), /线宽需为零/);
assert.throws(() => analyzeCopperShape({ filledPaths: [{ id: 'open-fill', fill: true, lineWidth: 0, path: [[0, 0, 'L', 2, 0]] }], fineness: 0 }), /未闭合轮廓/);

console.log(JSON.stringify({ passed: true, fixtureCases: 7, handlerGuards: 2, holeSpansMil: donut.crossSections[0].copperSpansMil, openStrokeSpanMil: open.crossSections[0].copperSpansMil[0], pathWrapperNormalization: true }));
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
