import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const bundlePath = resolve(root, 'test/.pcb-placement-primitives-regression-bundle.mjs');
async function main() {
	await build({ entryPoints: [resolve(root, 'src/commands/pcbPlacementPrimitives.ts')], outfile: bundlePath, bundle: true, platform: 'node', format: 'esm' });
	const { pcbPlacementPrimitiveCommands } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
	const defs = new Map(pcbPlacementPrimitiveCommands.map(def => [def.name, def]));
	assert.equal(defs.size, 16);
	for (const name of [
		'pcb.listArcs',
		'pcb.placeArc',
		'pcb.modifyArc',
		'pcb.listFills',
		'pcb.placeFill',
		'pcb.modifyFill',
		'pcb.listRegions',
		'pcb.placeRegion',
		'pcb.modifyRegion',
		'pcb.listPolylines',
		'pcb.placePolyline',
		'pcb.modifyPolyline',
		'pcb.listDimensions',
		'pcb.placeDimension',
		'pcb.modifyDimension',
		'pcb.placeLine',
	]) assert.ok(defs.has(name), `missing ${name}`);

	const state = { items: new Map(), writes: 0, nextId: 0, failReadback: false, mismatchReadback: false, changeTarget: false, createArgs: [], emptyNetReadback: 'null', failPolygonConstruction: false };
	const getterFields = ['Net', 'Layer', 'StartX', 'StartY', 'EndX', 'EndY', 'ArcAngle', 'LineWidth', 'PrimitiveLock', 'ComplexPolygon', 'FillMode', 'RuleType', 'RegionName', 'Polygon', 'DimensionType', 'CoordinateSet', 'Unit', 'Precision'];
	function makeItem(id, values) {
		const item = { getState_PrimitiveId: () => id };
		for (const suffix of getterFields) {
			const key = suffix[0].toLowerCase() + suffix.slice(1);
			if (Object.hasOwn(values, key)) {
				item[`getState_${suffix}`] = () => {
					if (state.mismatchReadback && suffix === 'LineWidth')
						return Number(values[key]) + 1;
					if (suffix === 'Unit' && values.dimensionType !== undefined)
						return 'mil';
					if (suffix === 'Net' && values[key] === '' && state.emptyNetReadback === 'null')
						return null;
					if (suffix === 'Net' && values[key] === '' && state.emptyNetReadback === 'undefined')
						return undefined;
					return values[key];
				};
			}
		}
		return item;
	}
	function createApi(family) {
		const collection = () => [...state.items.values()].filter(item => item.family === family).map(item => item.object);
		return {
			create: async (...args) => {
				state.writes++;
				state.createArgs.push({ family, args });
				const id = `p${++state.nextId}`;
				const keys = {
					arcs: ['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'arcAngle', 'lineWidth', null, 'primitiveLock'],
					fills: ['layer', 'complexPolygon', 'net', 'fillMode', 'lineWidth', 'primitiveLock'],
					regions: ['layer', 'complexPolygon', 'ruleType', 'regionName', 'lineWidth', 'primitiveLock'],
					polylines: ['net', 'layer', 'polygon', 'lineWidth', 'primitiveLock'],
					dimensions: ['dimensionType', 'coordinateSet', 'layer', 'unit', 'lineWidth', 'precision', 'primitiveLock'],
					lines: ['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'lineWidth', 'primitiveLock'],
				}[family];
				const value = Object.fromEntries(keys.flatMap((key, index) => typeof key === 'string' ? [[key, args[index]]] : []));
				if (family === 'fills' || family === 'regions')
					value.complexPolygon = args[1];
				if (family === 'fills') {
					value.fillMode ??= 0;
					value.lineWidth ??= 0.2;
				}
				if (family === 'regions')
					value.lineWidth ??= 0.2;
				if (family === 'polylines')
					value.polygon = args[2];
				const object = makeItem(id, value);
				state.items.set(id, { family, value, object });
				return object;
			},
			get: async id => state.failReadback ? undefined : state.items.get(id)?.object,
			getAll: async () => collection(),
			modify: async (id, patch) => {
				state.writes++;
				const current = state.items.get(id);
				if (!current)
					return undefined;
				Object.assign(current.value, patch);
				current.object = makeItem(id, current.value);
				return current.object;
			},
		};
	}
	const api = {
		pcb_PrimitiveArc: createApi('arcs'),
		pcb_PrimitiveFill: createApi('fills'),
		pcb_PrimitiveRegion: createApi('regions'),
		pcb_PrimitivePolyline: createApi('polylines'),
		pcb_PrimitiveDimension: createApi('dimensions'),
		pcb_PrimitiveLine: createApi('lines'),
		pcb_MathPolygon: { createPolygon: (source) => {
			if (state.failPolygonConstruction)
				throw new Error('polygon constructor failed');
			return { getSource: () => source };
		} },
		pcb_Layer: { getAllLayers: async () => [{ id: 1 }, { id: 3 }, { id: 11 }, { id: 12 }, { id: 15 }, { id: 71 }] },
		sys_FileManager: {
			getDocumentSource: async () => {
				const head = { type: 'DOCHEAD' };
				const docHeadData = { docType: 'PCB', uuid: 'pcb-test' };
				const dimensions = [...state.items.entries()].filter(([, item]) => item.family === 'dimensions').map(([id, item], index) => {
					const value = item.value;
					const type = value.dimensionType === 'Length Dimension' ? 'LENGTH' : value.dimensionType === 'Protractor Dimension' ? 'ANGLE' : 'RADIUS';
					return `${JSON.stringify({ type: 'DIMENSION', id, ticket: index + 1 })}||${JSON.stringify({ type, unit: value.unit ?? (type === 'ANGLE' ? '' : 'mil'), layerId: value.layer, coords: value.coordinateSet })}`;
				});
				return `${[`${JSON.stringify(head)}||${JSON.stringify(docHeadData)}`, ...dimensions].join('|\n')}|`;
			},
		},
	};
	globalThis.eda = api;
	let targetChecks = 0;
	const ctx = { documentTarget: { documentType: 3, uuid: 'pcb-test' }, assertDocumentTarget: async () => {
		targetChecks++;
		if (state.changeTarget)
			throw new Error('target changed');
	} };
	async function run(name, params = {}, context = ctx) {
		return await defs.get(name).handler(params, context);
	}

	const arc = await run('pcb.placeArc', { net: '', layer: 1, startX: 10, startY: 20, endX: 30, endY: 40, arcAngle: 90, lineWidth: 8 });
	assert.equal(state.createArgs.at(-1).args[8], 1, 'arc must explicitly pass TWO_POINT_ARC');
	assert.equal(arc.readbackVerified, true);
	assert.equal((await run('pcb.listArcs')).count, 1);
	await run('pcb.modifyArc', { primitiveId: arc.primitiveId, lineWidth: 9 });
	state.mismatchReadback = true;
	await assert.rejects(run('pcb.modifyArc', { primitiveId: arc.primitiveId, lineWidth: 10 }), error => error.cause?.partial === true && error.cause?.retryable === false && error.cause?.writeAttempted === true);
	state.mismatchReadback = false;

	const path = [0, 0, 'L', 100, 0, 'ARC', 100, 100, 50, 50, 0, 1, 1];
	const fill = await run('pcb.placeFill', { layer: 12, polygonSource: path });
	assert.equal(fill.readbackVerified, true);
	assert.equal(fill.properties.fillMode, 0);
	assert.equal(fill.properties.lineWidth, 0.2);
	await run('pcb.modifyFill', { primitiveId: fill.primitiveId, primitiveLock: true });
	const beforeInvalidRegionName = state.writes;
	await assert.rejects(run('pcb.placeRegion', { layer: 12, polygonSource: ['R', 0, 0, 100, 50, 0, 0], ruleType: [2, 5, 7], regionName: 'no-components' }), /禁止区域不保存自定义名称/);
	assert.equal(state.writes, beforeInvalidRegionName, 'prohibited regions do not accept a custom name');
	const region = await run('pcb.placeRegion', { layer: 12, polygonSource: ['R', 0, 0, 100, 50, 0, 0], ruleType: [9], regionName: 'constraint' });
	assert.equal(region.readbackVerified, true);
	assert.equal(region.properties.lineWidth, 0.2);
	const polyline = await run('pcb.placePolyline', { net: '', layer: 11, pathSource: path, lineWidth: 8 });
	assert.equal(polyline.readbackVerified, true);
	await run('pcb.modifyPolyline', { primitiveId: polyline.primitiveId, lineWidth: 10 });
	const dimension = await run('pcb.placeDimension', { dimensionType: 'Length Dimension', coordinateSet: [0, 0, 0, -10, 100, -10, 100, 0], layer: 3, unit: 'mm', precision: 2 });
	assert.equal(dimension.readbackVerified, true);
	assert.equal(dimension.properties.unit, 'mm', 'source unit wins over misleading SDK getter');
	assert.equal(dimension.properties.sdkUnitGetter, 'mil', 'misleading getter retained as diagnostic evidence');
	const beforeRadiusCreate = state.writes;
	await assert.rejects(run('pcb.placeDimension', { dimensionType: 'Radius Dimension', coordinateSet: [900, 200, 1100, 350, 141], layer: 13, unit: 'mil' }), /半径尺寸写入尚未通过实机验证/);
	assert.equal(state.writes, beforeRadiusCreate, 'radius creation is rejected before SDK write');
	const beforeInvalidDimensionType = state.writes;
	await assert.rejects(run('pcb.modifyDimension', { primitiveId: dimension.primitiveId, dimensionType: 'Radius Dimension' }), /半径尺寸写入尚未通过实机验证/);
	assert.equal(state.writes, beforeInvalidDimensionType, 'incompatible dimension type must be rejected before write');
	await run('pcb.modifyDimension', { primitiveId: dimension.primitiveId, coordinateSet: [0, 0, 0, -10, 120, -10, 120, 0] });
	const angle = await run('pcb.placeDimension', { dimensionType: 'Protractor Dimension', coordinateSet: [0, 0, 100, 0, 100, 100], layer: 3, precision: 1 });
	assert.equal(angle.properties.unit, 'degree');
	assert.equal(angle.properties.sourceUnit, '');
	const dimensions = await run('pcb.listDimensions');
	assert.equal(dimensions.items.find(item => item.primitiveId === dimension.primitiveId).unit, 'mm');
	assert.equal(dimensions.items.find(item => item.primitiveId === angle.primitiveId).unit, 'degree');
	const legacyRadiusId = 'legacy-radius';
	const legacyRadiusValue = { dimensionType: 'Radius Dimension', coordinateSet: [900, 200, 1100, 350, 141], layer: 13, unit: 'mil', lineWidth: 11500, precision: 1, primitiveLock: false };
	state.items.set(legacyRadiusId, { family: 'dimensions', value: legacyRadiusValue, object: makeItem(legacyRadiusId, legacyRadiusValue) });
	const beforeRadiusModify = state.writes;
	await assert.rejects(run('pcb.modifyDimension', { primitiveId: legacyRadiusId, primitiveLock: true }), /半径尺寸写入尚未通过实机验证/);
	assert.equal(state.writes, beforeRadiusModify, 'existing radius modification is rejected before SDK write');
	assert.equal((await run('pcb.listDimensions')).items.find(item => item.primitiveId === legacyRadiusId).unit, 'mil', 'legacy radius remains readable');
	const beforeInvalidAngleUnit = state.writes;
	await assert.rejects(run('pcb.placeDimension', { dimensionType: 'Protractor Dimension', coordinateSet: [0, 0, 100, 0, 100, 100], layer: 3, unit: 'mm' }), /角度标注使用度/);
	assert.equal(state.writes, beforeInvalidAngleUnit);
	const line = await run('pcb.placeLine', { layer: 3, startX: 1, startY: 2, endX: 101, endY: 2, lineWidth: 8 });
	assert.equal(line.readbackVerified, true);
	assert.equal(line.primitiveType, 'Polyline');
	state.emptyNetReadback = 'undefined';
	await assert.rejects(run('pcb.placeLine', { layer: 3, startX: 1, startY: 3, endX: 101, endY: 3, lineWidth: 8 }), error => error.cause?.partial === true && error.cause?.retryable === false);
	state.emptyNetReadback = 'null';

	const beforeInvalid = state.writes;
	await assert.rejects(run('pcb.placeArc', { net: '', layer: 1, startX: Number.NaN, startY: 20, endX: 30, endY: 40, arcAngle: 90 }), /有限数值/);
	await assert.rejects(run('pcb.placePolyline', { net: '', layer: 11, pathSource: [0, 0, 'BOGUS', 2, 2] }), /多边形源数组/);
	await assert.rejects(run('pcb.placeArc', { net: '', layer: 1, startX: 10, startY: 20, endX: 30, endY: 40, arcAngle: 90, mystery: 1 }), /不支持的参数/);
	await assert.rejects(run('pcb.modifyFill', { primitiveId: fill.primitiveId, fillMode: 1 }), /Fill\.modify 不支持 fillMode/);
	await assert.rejects(run('pcb.placeFill', { layer: 12, polygonSource: path, fillMode: 1 }), /宿主只支持实心填充/);
	await assert.rejects(run('pcb.placeFill', { layer: 12, polygonSource: path, lineWidth: 10 }), /不支持显式设置 lineWidth/);
	await assert.rejects(run('pcb.placeFill', { layer: 12, polygonSource: path, lineWidth: 0 }), /不支持显式设置 lineWidth/);
	await assert.rejects(run('pcb.modifyFill', { primitiveId: fill.primitiveId, lineWidth: 10 }), /不支持显式设置 lineWidth/);
	await assert.rejects(run('pcb.modifyFill', { primitiveId: fill.primitiveId, lineWidth: 0 }), /不支持显式设置 lineWidth/);
	await assert.rejects(run('pcb.placeRegion', { layer: 12, polygonSource: ['R', 0, 0, 100, 50, 0, 0], ruleType: [7], lineWidth: 1.5 }), /区域边框线宽.*不能设置/);
	await assert.rejects(run('pcb.modifyRegion', { primitiveId: region.primitiveId, lineWidth: 1.5 }), /区域边框线宽.*不能设置/);
	await assert.rejects(run('pcb.placeLine', { layer: 1, startX: 1, startY: 2, endX: 3, endY: 4 }), /pcb\.routeTrack/);
	await assert.rejects(run('pcb.placeArc', { net: '', layer: 3, startX: 10, startY: 20, endX: 30, endY: 40, arcAngle: 90 }), /官方图层范围/);
	state.failPolygonConstruction = true;
	await assert.rejects(run('pcb.placeLine', { layer: 3, startX: 3, startY: 4, endX: 20, endY: 4 }), /polygon constructor failed/);
	state.failPolygonConstruction = false;
	assert.equal(state.writes, beforeInvalid, 'invalid inputs must be rejected before SDK writes');

	const beforeWrongTarget = state.writes;
	state.changeTarget = true;
	await assert.rejects(run('pcb.placeLine', { layer: 3, startX: 1, startY: 2, endX: 3, endY: 4 }, ctx));
	state.changeTarget = false;
	assert.equal(state.writes, beforeWrongTarget, 'target mismatch must prevent SDK write');

	const beforeMismatch = state.writes;
	state.failReadback = true;
	await assert.rejects(run('pcb.placeArc', { net: '', layer: 1, startX: 11, startY: 20, endX: 30, endY: 40, arcAngle: 90 }), error => error.cause?.partial === true && error.cause?.retryable === false && error.cause?.writeAttempted === true && typeof error.cause?.primitiveId === 'string');
	state.failReadback = false;
	assert.equal(state.writes, beforeMismatch + 1);
	assert.ok(targetChecks > 10, 'target guard should run at command boundaries');
	console.log('pcb placement primitive regression: PASS');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
