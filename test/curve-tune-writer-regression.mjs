import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const tsUrl = pathToFileURL(require.resolve('typescript')).href;
const loaderSource = `
import { readFile } from 'node:fs/promises';
import ts from '${tsUrl}';
export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith('.') && !/\\.[a-zA-Z0-9]+$/.test(specifier)) {
		try { return await nextResolve(specifier + '.ts', context); } catch {}
	}
	return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
	if (!url.endsWith('.ts')) return nextLoad(url, context);
	const source = await readFile(new URL(url), 'utf8');
	return {
		format: 'module',
		source: ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText,
		shortCircuit: true,
	};
}
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, import.meta.url);
let curveFromEndpoints;
let writeTuneCurves;
let createGeometryHost;

function source() {
	return [
		`${JSON.stringify({ type: 'DOCHEAD', id: 'head' })}||${JSON.stringify({ docType: 'PCB', uuid: 'pcb-A', client: 'test' })}`,
		`${JSON.stringify({ type: 'TRACK', id: 'track-1' })}||{}|`,
	].join('\n');
}

function sourceRow(type, id, ticket, data) {
	return `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}|`;
}

function fixture(options = {}) {
	const state = {
		focus: { uuid: 'pcb-A', documentType: 3 },
		source: source(),
		rules: { width: 8, spacing: 6 },
		primitives: [],
		calls: [],
		sdkCalls: [],
		createCalls: [],
		enumerations: 0,
		gets: 0,
		createCount: 0,
		now: 0,
		...options,
	};
	const createdObject = record => ({
		getState_PrimitiveId: () => record.id,
		getState_PrimitiveType: () => record.type,
		getState_Net: () => record.net,
		getState_Layer: () => record.layer,
		getState_StartX: () => record.startX,
		getState_StartY: () => record.startY,
		getState_EndX: () => record.endX,
		getState_EndY: () => record.endY,
		getState_LineWidth: () => record.width,
		getState_ArcAngle: () => record.arcAngle,
	});
	const add = async (type, args) => {
		state.createCount++;
		state.sdkCalls.push(`create-${type.toLowerCase()}`);
		state.createCalls.push({ type, args });
		if (state.throwOnCreate === state.createCount)
			throw new Error('mock create failure');
		if (state.emptyReturnAt === state.createCount)
			return undefined;
		if (state.advanceOnCreate)
			await new Promise(resolve => setTimeout(resolve, state.advanceOnCreate));
		let [net, layer, startX, startY, endX, endY] = args;
		const [sourceBaseStartX, sourceBaseStartY, sourceBaseEndX, sourceBaseEndY] = args.slice(2, 6);
		const arcAngle = type === 'Arc' ? args[6] : undefined;
		if (state.reverseArc && type === 'Arc') {
			[startX, endX] = [endX, startX];
			[startY, endY] = [endY, startY];
			const offset = state.readbackOffset ?? 0;
			startX += offset;
			startY += offset;
			endX += offset;
			endY += offset;
		}
		if (state.reverseLine && type === 'Line') {
			[startX, endX] = [endX, startX];
			[startY, endY] = [endY, startY];
		}
		const actualAngle = type === 'Arc'
			? state.reverseArc === 'reverse-negate' ? -arcAngle : arcAngle
			: undefined;
		const record = {
			id: `${type.toLowerCase()}-${state.createCount}`,
			type,
			net,
			layer,
			startX,
			startY,
			endX,
			endY,
			width: type === 'Arc' ? args[7] : args[6],
			arcAngle: actualAngle,
		};
		state.primitives.push(record);
		const quantize4 = value => Math.round(value * 10000) / 10000;
		let [sourceStartX, sourceStartY, sourceEndX, sourceEndY] = [sourceBaseStartX, sourceBaseStartY, sourceBaseEndX, sourceBaseEndY];
		if (state.sourceOffset) {
			sourceStartX += state.sourceOffset;
			sourceStartY += state.sourceOffset;
			sourceEndX += state.sourceOffset;
			sourceEndY += state.sourceOffset;
		}
		if (state.sourceQuantize4) {
			sourceStartX = quantize4(sourceStartX);
			sourceStartY = quantize4(sourceStartY);
			sourceEndX = quantize4(sourceEndX);
			sourceEndY = quantize4(sourceEndY);
		}
		let sourceAngle = state.sourceAngle ?? arcAngle;
		if (type === 'Arc' && state.sourceReverse) {
			[sourceStartX, sourceEndX] = [sourceEndX, sourceStartX];
			[sourceStartY, sourceEndY] = [sourceEndY, sourceStartY];
			if (!state.sourceKeepAngle)
				sourceAngle *= -1;
		}
		if (type === 'Arc' && state.freshProjection) {
			const project = value => Math.round(value * 10) / 10 + (state.freshProjectionNoise ?? 0);
			record.startX = project(sourceStartX);
			record.startY = project(sourceStartY);
			record.endX = project(sourceEndX);
			record.endY = project(sourceEndY);
		}
		if (type === 'Arc' && state.freshWrongProjection)
			record.startX = sourceStartX + 0.1;
		if (type === 'Arc' && state.freshAngleOverride !== undefined)
			record.arcAngle = state.freshAngleOverride;
		if (type === 'Arc' && state.freshAngleOffset)
			record.arcAngle += state.freshAngleOffset;
		const sourceData = type === 'Arc'
			? { netName: net, layerId: layer, width: args[7], startX: sourceStartX, startY: sourceStartY, endX: sourceEndX, endY: sourceEndY, angle: sourceAngle, arcType: state.sourceArcType ?? 'DOT' }
			: { netName: net, layerId: layer, width: args[6], startX: sourceStartX, startY: sourceStartY, endX: sourceEndX, endY: sourceEndY };
		if (type === 'Arc' && state.sourceAngleOffset)
			sourceData.angle += state.sourceAngleOffset;
		state.source += `\n${sourceRow(type.toUpperCase(), record.id, state.primitives.length + 1, sourceData)}`;
		if (state.changeFocusAfterCreate)
			state.focus = { uuid: 'pcb-B', documentType: 3 };
		return createdObject(record);
	};
	const manager = type => ({
		create: async (...args) => add(type, args),
		get: async (id) => {
			state.sdkCalls.push(`get-${type.toLowerCase()}`);
			state.gets++;
			if (state.advanceOnGet)
				await new Promise(resolve => setTimeout(resolve, state.advanceOnGet));
			const record = state.primitives.find(item => item.id === id);
			return record ? createdObject(record) : undefined;
		},
		getAllPrimitiveId: async () => {
			state.sdkCalls.push(`ids-${type.toLowerCase()}`);
			state.enumerations++;
			const ids = state.primitives.filter(item => item.type === type).map(item => item.id);
			return state.omitEnumeratedId ? ids.filter(id => id !== state.omitEnumeratedId) : ids;
		},
	});
	const sdk = {
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ ...state.focus }) },
		sys_FileManager: { getDocumentSource: async () => state.source },
		pcb_Drc: { getCurrentRuleConfiguration: async () => state.rules },
		pcb_PrimitiveLine: manager('Line'),
		pcb_PrimitiveArc: manager('Arc'),
	};
	return { state, sdk, writeTuneCurves, createGeometryHost };
}

async function hostFor(f, timeoutMs = 10_000) {
	return f.createGeometryHost(f.sdk, { __docUuid: 'pcb-A', _timeoutMs: timeoutMs });
}

function assertPartial(error, candidate) {
	assert.equal(error.cause?.partial, true);
	assert.equal(error.cause?.retryable, false);
	assert.equal(error.cause?.saved, false);
	assert.deepEqual(error.cause?.candidatePrimitive, candidate);
}

async function main() {
	({ curveFromEndpoints } = await import('../src/pcb/arcTuneGeometry.ts'));
	({ writeTuneCurves } = await import('../src/pcb/curveTuneWriter.ts'));
	({ createGeometryHost } = await import('../src/pcb/geometryHost.ts'));

	const arcs = [
		curveFromEndpoints([10, 0], [0, 10], 90),
		curveFromEndpoints([20, 0], [0, 20], 90),
		curveFromEndpoints([30, 0], [0, 30], 90),
		curveFromEndpoints([40, 0], [0, 40], 90),
	];
	const lines = [
		{ type: 'line', a: [-20, 0], b: [-10, 0] },
		{ type: 'line', a: [50, 0], b: [60, 0] },
		{ type: 'line', a: [70, 0], b: [80, 0] },
	];

	{
		const f = fixture();
		const host = await hostFor(f);
		const result = await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [...arcs.slice(0, 2), lines[0], arcs[2], lines[1], arcs[3], lines[2]] });
		assert.equal(result.createdPrimitives.length, 7);
		assert.deepEqual(result.createdPrimitives.map(item => item.type), ['arc', 'arc', 'line', 'arc', 'line', 'arc', 'line']);
		assert.equal(result.actualPrimitives.length, 7);
		assert.equal(result.actualPrimitives.filter(item => item.type === 'arc').length, 4);
		assert.equal(result.actualPrimitives.filter(item => item.type === 'line').length, 3);
		assert.ok(result.actualPrimitives.every(item => item.type !== 'arc' || item.radius > 0));
		assert.deepEqual(f.state.createCalls[0].args, ['N1', 1, 10, 0, 0, 10, 90, 2, 1, false]);
		assert.deepEqual(f.state.createCalls[2].args, ['N1', 1, -20, 0, -10, 0, 2, false]);
		assert.deepEqual(f.state.sdkCalls, Array.from({ length: 7 }, (_, i) => {
			const type = ['arc', 'arc', 'line', 'arc', 'line', 'arc', 'line'][i];
			return [`create-${type}`, `get-${type}`, `ids-${type}`];
		}).flat());
		assert.equal(f.state.enumerations, 7);
		assert.equal(f.state.gets, 7);
	}

	{
		const f = fixture({ reverseArc: 'reverse-negate', readbackOffset: 0.0005 });
		const host = await hostFor(f);
		const connectedArc = curveFromEndpoints(arcs[0].b, [10, 20], 90);
		const result = await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [arcs[0], connectedArc] });
		assert.deepEqual(result.createdPrimitives, [{ type: 'arc', id: 'arc-1' }, { type: 'arc', id: 'arc-2' }]);
		assert.deepEqual(result.actualPrimitives[0].a, arcs[0].a, 'actual geometry is taken from source, not rounded getter data');
		assert.deepEqual(result.actualPrimitives[0].b, arcs[0].b, 'actual geometry is taken from source, not rounded getter data');
		assert.deepEqual(result.actualPrimitives[1].a, result.actualPrimitives[0].b);
		assert.deepEqual(result.actualPrimitives[1].b, connectedArc.b);
		assert.equal(result.actualPrimitives[0].sweepDegrees, arcs[0].sweepDegrees);
		assert.equal(result.actualPrimitives[1].sweepDegrees, connectedArc.sweepDegrees);
	}

	{
		const expected = curveFromEndpoints([10.0089, 0], [0, 10.0089], 90);
		const f = fixture({ freshProjection: true, sourceQuantize4: true });
		const host = await hostFor(f);
		const result = await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [expected] });
		assert.deepEqual(result.actualPrimitives, [expected], 'fresh SDK tenths projection is accepted while actual geometry remains the source ARC');
	}
	{
		const expected = curveFromEndpoints([10.0089, 0], [0, 10.0089], 90);
		const f = fixture({ freshProjection: true, freshProjectionNoise: 5e-10, sourceQuantize4: true });
		const host = await hostFor(f);
		const result = await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [expected] });
		assert.deepEqual(result.actualPrimitives, [expected], 'only machine-sized noise around the exact tenth projection is allowed');
	}

	for (const sdkReverse of [false, true]) {
		const expected = arcs[0];
		const f = fixture({ sourceReverse: true, ...(sdkReverse ? { reverseArc: 'reverse-negate' } : {}) });
		const host = await hostFor(f);
		const result = await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [expected] });
		assert.deepEqual(result.actualPrimitives, [expected], 'source B→A/-sweep and SDK in either equivalent direction normalize to plan A→B');
	}

	{
		const f = fixture({ sourceReverse: true, sourceKeepAngle: true });
		const host = await hostFor(f);
		await assert.rejects(f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [arcs[0]] }), /源码ARC端点\/signed sweep与规划不符/);
	}

	{
		const expected = curveFromEndpoints([10.0089, 0], [0, 10.0089], 90);
		const f = fixture({ freshWrongProjection: true, sourceQuantize4: true });
		const host = await hostFor(f);
		await assert.rejects(f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [expected] }), (error) => {
			assert.match(error.message, /SDK端点\/signed sweep与同ID源码不等价/);
			assert.equal(error.cause?.expected.curve.sweepDegrees, 90);
			assert.equal(error.cause?.actual.ArcAngle, 90);
			assert.deepEqual(error.cause?.source.start, [10.0089, 0]);
			return true;
		});
	}

	{
		const expected = curveFromEndpoints([10, 0], [0, -10], 270);
		const f = fixture({ freshProjection: true, sourceQuantize4: true });
		const host = await hostFor(f);
		const result = await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [expected] });
		assert.equal(result.actualPrimitives[0].sweepDegrees, 270, 'large positive sweep direction is retained through endpoint projection');
	}

	for (const options of [
		{ sourceOffset: 0.005, sourceQuantize4: true },
		{ sourceArcType: 'ARC', sourceQuantize4: true },
	]) {
		const expected = arcs[0];
		const f = fixture(options);
		const host = await hostFor(f);
		await assert.rejects(f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [expected] }));
	}

	{
		const expected = arcs[0];
		const f = fixture({ freshAngleOffset: 5e-9 });
		const host = await hostFor(f);
		const result = await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [expected] });
		assert.deepEqual(result.actualPrimitives, [expected], 'floating point sweep residue is accepted without weakening direction checks');
	}

	{
		const expected = curveFromEndpoints([10.05, 0], [0, 10.05], 90);
		const f = fixture({ freshProjection: true, sourceQuantize4: true });
		const host = await hostFor(f);
		await assert.rejects(f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [expected] }), /SDK端点\/signed sweep与同ID源码不等价/);
	}

	{
		const f = fixture({ reverseArc: 'reverse-with-same-angle' });
		const host = await hostFor(f);
		let error;
		try {
			await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [arcs[0], lines[0]] });
		}
		catch (caught) {
			error = caught;
		}
		assert.match(error.message, /SDK端点\/signed sweep与同ID源码不等价/);
		assertPartial(error, { type: 'arc', id: 'arc-1' });
		assert.equal(f.state.createCount, 1, 'wrong-direction readback stops before the next create');
	}

	{
		const f = fixture({ reverseLine: true });
		const host = await hostFor(f);
		const result = await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [lines[0]] });
		assert.deepEqual(result.actualPrimitives, [lines[0]]);
	}

	{
		const f = fixture();
		const host = await hostFor(f);
		await assert.rejects(f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [{ type: 'line', a: [0, 0], b: [Number.NaN, 1] }] }), /有限数值/);
		await assert.rejects(f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [{ type: 'line', a: [0, 0], b: [0, 0] }] }), /长度为零/);
		assert.equal(f.state.createCount, 0);
	}

	{
		const f = fixture({ emptyReturnAt: 1 });
		const host = await hostFor(f);
		let error;
		try {
			await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [lines[0], lines[1]] });
		}
		catch (caught) {
			error = caught;
		}
		assert.match(error.message, /缺少有效图元ID/);
		assertPartial(error, { type: 'line', id: null });
		assert.equal(f.state.enumerations, 0);
		assert.equal(f.state.createCount, 1);
	}

	{
		const f = fixture({ omitEnumeratedId: 'line-1' });
		const host = await hostFor(f);
		let error;
		try {
			await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [lines[0], lines[1]] });
		}
		catch (caught) {
			error = caught;
		}
		assert.match(error.message, /未出现在最新图元枚举/);
		assertPartial(error, { type: 'line', id: 'line-1' });
		assert.equal(f.state.createCount, 1);
	}

	{
		const f = fixture({ throwOnCreate: 2 });
		const host = await hostFor(f);
		let error;
		try {
			await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [lines[0], arcs[0], lines[1]] });
		}
		catch (caught) {
			error = caught;
		}
		assertPartial(error, { type: 'arc', id: null });
		assert.deepEqual(error.cause.createdPrimitives, [{ type: 'line', id: 'line-1' }]);
		assert.equal(f.state.createCount, 2, 'failed second create stops the remaining sequence');
	}

	{
		const f = fixture({ changeFocusAfterCreate: true });
		const host = await hostFor(f);
		let error;
		try {
			await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [lines[0], lines[1]] });
		}
		catch (caught) {
			error = caught;
		}
		assert.match(error.message, /焦点已离开/);
		assertPartial(error, { type: 'line', id: 'line-1' });
		assert.equal(f.state.gets, 0, 'focus loss after a write stops readback and future SDK calls');
		assert.equal(f.state.createCount, 1);
	}

	{
		const f = fixture({ advanceOnCreate: 600, advanceOnGet: 500 });
		const host = await hostFor(f, 1000);
		let error;
		try {
			await f.writeTuneCurves(host, { net: 'N1', layer: 1, width: 2, primitives: [lines[0], lines[1]] });
		}
		catch (caught) {
			error = caught;
		}
		assert.match(error.message, /共享.*预算/);
		assertPartial(error, { type: 'line', id: 'line-1' });
		assert.equal(f.state.enumerations, 0, 'the shared budget blocks later reads after the slow get');
		assert.equal(f.state.createCount, 1);
	}

	console.log('curve-tune-writer-regression: all assertions passed');
}

main().catch((error) => {
	console.error(error);
	throw error;
});
