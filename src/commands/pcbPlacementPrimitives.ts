import type { ICommandContext, ICommandDef } from '../engine/types';
import type { ISourceRecord } from '../pcb/sourcelog';
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog';

type Family = 'arcs' | 'fills' | 'regions' | 'polylines' | 'dimensions';
type Primitive = Record<string, any>;
type DimensionSourceRecord = Omit<ISourceRecord<Record<string, unknown>>, 'data'> & { data: Record<string, unknown> };
interface Field { input: string; state: string; sdk: string; numeric?: boolean; boolean?: boolean; array?: boolean; polygon?: boolean; path?: boolean; layerKind?: 'arc' | 'line' | 'fill' | 'region' | 'dimension' }

const families: Record<Family, { api: string; fields: Field[]; required: string[] }> = {
	arcs: { api: 'pcb_PrimitiveArc', fields: [
		{ input: 'net', state: 'Net', sdk: 'net' },
		{ input: 'layer', state: 'Layer', sdk: 'layer', numeric: true, layerKind: 'arc' },
		{ input: 'startX', state: 'StartX', sdk: 'startX', numeric: true },
		{ input: 'startY', state: 'StartY', sdk: 'startY', numeric: true },
		{ input: 'endX', state: 'EndX', sdk: 'endX', numeric: true },
		{ input: 'endY', state: 'EndY', sdk: 'endY', numeric: true },
		{ input: 'arcAngle', state: 'ArcAngle', sdk: 'arcAngle', numeric: true },
		{ input: 'lineWidth', state: 'LineWidth', sdk: 'lineWidth', numeric: true },
		{ input: 'primitiveLock', state: 'PrimitiveLock', sdk: 'primitiveLock', boolean: true },
	], required: ['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'arcAngle'] },
	fills: { api: 'pcb_PrimitiveFill', fields: [
		{ input: 'layer', state: 'Layer', sdk: 'layer', numeric: true, layerKind: 'fill' },
		{ input: 'polygonSource', state: 'ComplexPolygon', sdk: 'complexPolygon', polygon: true },
		{ input: 'net', state: 'Net', sdk: 'net' },
		{ input: 'fillMode', state: 'FillMode', sdk: 'fillMode', numeric: true },
		{ input: 'lineWidth', state: 'LineWidth', sdk: 'lineWidth', numeric: true },
		{ input: 'primitiveLock', state: 'PrimitiveLock', sdk: 'primitiveLock', boolean: true },
	], required: ['layer', 'polygonSource'] },
	regions: { api: 'pcb_PrimitiveRegion', fields: [
		{ input: 'layer', state: 'Layer', sdk: 'layer', numeric: true, layerKind: 'region' },
		{ input: 'polygonSource', state: 'ComplexPolygon', sdk: 'complexPolygon', polygon: true },
		{ input: 'ruleType', state: 'RuleType', sdk: 'ruleType', array: true },
		{ input: 'regionName', state: 'RegionName', sdk: 'regionName' },
		{ input: 'lineWidth', state: 'LineWidth', sdk: 'lineWidth', numeric: true },
		{ input: 'primitiveLock', state: 'PrimitiveLock', sdk: 'primitiveLock', boolean: true },
	], required: ['layer', 'polygonSource'] },
	polylines: { api: 'pcb_PrimitivePolyline', fields: [
		{ input: 'net', state: 'Net', sdk: 'net' },
		{ input: 'layer', state: 'Layer', sdk: 'layer', numeric: true, layerKind: 'line' },
		{ input: 'pathSource', state: 'Polygon', sdk: 'polygon', array: true, path: true },
		{ input: 'lineWidth', state: 'LineWidth', sdk: 'lineWidth', numeric: true },
		{ input: 'primitiveLock', state: 'PrimitiveLock', sdk: 'primitiveLock', boolean: true },
	], required: ['net', 'layer', 'pathSource'] },
	dimensions: { api: 'pcb_PrimitiveDimension', fields: [
		{ input: 'dimensionType', state: 'DimensionType', sdk: 'dimensionType' },
		{ input: 'coordinateSet', state: 'CoordinateSet', sdk: 'coordinateSet', array: true },
		{ input: 'layer', state: 'Layer', sdk: 'layer', numeric: true, layerKind: 'dimension' },
		{ input: 'unit', state: 'Unit', sdk: 'unit' },
		{ input: 'lineWidth', state: 'LineWidth', sdk: 'lineWidth', numeric: true },
		{ input: 'precision', state: 'Precision', sdk: 'precision', numeric: true },
		{ input: 'primitiveLock', state: 'PrimitiveLock', sdk: 'primitiveLock', boolean: true },
	], required: ['dimensionType', 'coordinateSet'] },
};

const metadata = new Set(['__projectUuid', '__docUuid', '__tabId']);

function idOf(item: Primitive): string {
	const value = item?.getState_PrimitiveId?.();
	if (typeof value !== 'string' || !value)
		throw new Error('宿主没有返回有效的图元 ID');
	return value;
}

function propertyValue(field: Field, value: unknown): unknown {
	if (field.polygon || field.path) {
		validatePolygonSource(field.input, value);
		const polygon = eda.pcb_MathPolygon.createPolygon(value as any);
		if (!polygon)
			throw new Error(`${field.input} 不是有效的 SDK 多边形源`);
		return polygon;
	}
	if (field.numeric && (typeof value !== 'number' || !Number.isFinite(value)))
		throw new Error(`${field.input} 必须是有限数值`);
	if (field.boolean && typeof value !== 'boolean')
		throw new Error(`${field.input} 必须是布尔值`);
	if (field.array && !Array.isArray(value))
		throw new Error(`${field.input} 必须是数组`);
	if (field.array && (value as unknown[]).some(item => typeof item === 'number' && !Number.isFinite(item)))
		throw new Error(`${field.input} 不能包含非有限数值`);
	if (field.input === 'coordinateSet' && (value as unknown[]).some(item => typeof item !== 'number' || !Number.isFinite(item)))
		throw new Error('coordinateSet 只能包含数值');
	if (field.input === 'ruleType' && (value as unknown[]).some(item => ![2, 5, 6, 7, 8, 9].includes(item as number)))
		throw new Error('ruleType 只接受官方区域类型编号：2/5/6/7/8/9');
	if (field.input === 'fillMode' && ![0, 1, 2].includes(value as number))
		throw new Error('fillMode 必须是官方填充模式编号 0、1 或 2');
	if (field.input === 'dimensionType' && !['Length Dimension', 'Protractor Dimension', 'Radius Dimension'].includes(String(value)))
		throw new Error('dimensionType 必须是 Length Dimension、Protractor Dimension 或 Radius Dimension');
	if (field.input === 'coordinateSet' && (value as unknown[]).length !== 6 && (value as unknown[]).length !== 8)
		throw new Error('coordinateSet 必须包含 6 个（角度/半径）或 8 个（长度）坐标值');
	if (field.input === 'unit' && !['mm', 'cm', 'inch', 'mil'].includes(String(value)))
		throw new Error('unit 必须为 mm、cm、inch 或 mil');
	if (field.input === 'precision' && (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 4))
		throw new Error('precision 必须为 0 到 4 的整数');
	return value;
}

function layerInType(kind: NonNullable<Field['layerKind']>, value: number): boolean {
	if (typeof value !== 'number' || !Number.isInteger(value))
		return false;
	const copper = value === 1 || value === 2 || (value >= 15 && value <= 46);
	const custom = value >= 71 && value <= 270;
	if (kind === 'arc')
		return copper;
	if (kind === 'region')
		return copper || value === 12;
	if (kind === 'dimension')
		return custom || [3, 4, 13, 14].includes(value);
	if (kind === 'line')
		return copper || custom || [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 56].includes(value);
	return copper || custom || [3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14].includes(value);
}

async function assertLayerSupported(kind: NonNullable<Field['layerKind']>, value: unknown, ctx?: ICommandContext): Promise<void> {
	if (typeof value !== 'number' || !layerInType(kind, value))
		throw new Error(`layer=${String(value)} 不属于 ${kind} 图元的官方图层范围`);
	await assertPcbTarget(ctx);
	const layers = await eda.pcb_Layer.getAllLayers();
	if (!Array.isArray(layers))
		throw new Error('无法读取当前 PCB 的图层清单，未执行写入');
	if (!layers.some(layer => layer?.id === value))
		throw new Error(`当前 PCB 不存在图层 ${value}，未执行写入`);
}

function validateCrossFields(family: Family, params: Record<string, any>, existing?: Primitive): void {
	if (family === 'arcs' && (params.arcAngle === 0 || Math.abs(params.arcAngle) >= 360))
		throw new Error('arcAngle 的有效范围为 -360 < 值 < 360 且不为 0');
	if (family === 'regions' && params.regionName !== undefined) {
		const ruleType = params.ruleType ?? existing?.getState_RuleType?.();
		if (!Array.isArray(ruleType) || !ruleType.includes(9))
			throw new Error('regionName 仅适用于 ruleType 包含 9 的约束区域；禁止区域不保存自定义名称');
	}
	if (family === 'dimensions' && (params.coordinateSet !== undefined || params.dimensionType !== undefined || params.unit !== undefined)) {
		const type = params.dimensionType ?? existing?.getState_DimensionType?.();
		if (!['Length Dimension', 'Protractor Dimension', 'Radius Dimension'].includes(String(type)))
			throw new Error('无法确认 dimensionType，拒绝验证 coordinateSet');
		if (type === 'Protractor Dimension' && params.unit !== undefined)
			throw new Error('角度标注使用度；请省略 unit，不能传入 mm、mil 等长度单位');
		const expectedLength = type === 'Length Dimension' ? 8 : 6;
		const coordinateSet = params.coordinateSet ?? existing?.getState_CoordinateSet?.();
		if (!Array.isArray(coordinateSet) || coordinateSet.length !== expectedLength)
			throw new Error(`${type} 的 coordinateSet 必须有 ${expectedLength} 个坐标值`);
	}
}

function validateFillWrite(params: Record<string, any>, phase: 'place' | 'modify'): void {
	if (phase === 'modify' && params.fillMode !== undefined)
		throw new Error('当前运行时的 Fill.modify 不支持 fillMode，未执行写入');
	if (params.fillMode !== undefined && params.fillMode !== 0)
		throw new Error('当前宿主只支持实心填充 fillMode=0；网格与内电层模式是未实现的 SDK 预留项，未执行写入');
	if (params.lineWidth !== undefined)
		throw new Error('当前宿主的填充线宽固定为默认值，不支持显式设置 lineWidth（包括 0）；请省略该参数，未执行写入');
}

function validateRegionWrite(params: Record<string, any>): void {
	if (params.lineWidth !== undefined)
		throw new Error('区域边框线宽由宿主固定为默认值，lineWidth 仅能读取、不能设置；未执行写入');
}

function validateDimensionWrite(params: Record<string, any>, existing?: Primitive): void {
	const type = params.dimensionType ?? existing?.getState_DimensionType?.();
	if (type === 'Radius Dimension')
		throw new Error('Radius Dimension 当前仅支持读取；半径尺寸写入尚未通过实机验证，未执行写入');
}

function sourceDimensionType(type: unknown): string | undefined {
	if (type === 'Length Dimension')
		return 'LENGTH';
	if (type === 'Protractor Dimension')
		return 'ANGLE';
	if (type === 'Radius Dimension')
		return 'RADIUS';
	return undefined;
}

async function readDimensionSourceRecord(ctx: ICommandContext | undefined, primitiveId: string): Promise<DimensionSourceRecord> {
	await assertPcbTarget(ctx);
	const source = await eda.sys_FileManager.getDocumentSource();
	await assertPcbTarget(ctx);
	if (typeof source !== 'string')
		throw new Error('无法读取当前 PCB 源码中的尺寸记录');
	const document = parseSourceLog(source);
	if (document.docType.toUpperCase() !== 'PCB' || document.uuid !== ctx?.documentTarget?.uuid)
		throw new Error('尺寸源码记录与当前绑定 PCB 不一致');
	const record = resolveRecords<Record<string, unknown>>(document, 'DIMENSION').get(`DIMENSION\0${primitiveId}`);
	if (!record || typeof record.data !== 'object' || record.data === null)
		throw new Error(`当前 PCB 源码中没有 DIMENSION/${primitiveId} 的有效记录`);
	return { ...record, data: record.data as Record<string, unknown> } as DimensionSourceRecord;
}

function dimensionSourceUnit(record: DimensionSourceRecord, sdkUnitGetter: unknown): Record<string, unknown> {
	const sourceType = record.data.type;
	const sourceUnit = record.data.unit;
	if (sourceType === 'ANGLE' && sourceUnit === '')
		return { unit: 'degree', sourceUnit: '', unitSource: 'DIMENSION 源码', sdkUnitGetter };
	if ((sourceType === 'LENGTH' || sourceType === 'RADIUS') && ['mm', 'cm', 'inch', 'mil'].includes(String(sourceUnit)))
		return { unit: sourceUnit, sourceUnit, unitSource: 'DIMENSION 源码', sdkUnitGetter };
	return { unit: 'unknown', sourceUnit: sourceUnit ?? null, unitSource: 'DIMENSION 源码字段未知', sdkUnitGetter };
}

async function dimensionUnitEvidence(ctx: ICommandContext | undefined, item: Primitive): Promise<Record<string, unknown>> {
	const id = idOf(item);
	const record = await readDimensionSourceRecord(ctx, id);
	const expectedSourceType = sourceDimensionType(stateValue(item, families.dimensions.fields[0]));
	if (!expectedSourceType || record.data.type !== expectedSourceType)
		throw new Error(`DIMENSION/${id} 的源码类型与SDK读回类型不一致`);
	return dimensionSourceUnit(record, stateValue(item, families.dimensions.fields.find(field => field.input === 'unit')!));
}

function validatePolygonSource(label: string, value: unknown): asserts value is Array<number | string> {
	if (!Array.isArray(value) || value.length < 3 || value.some(item => typeof item === 'number' ? !Number.isFinite(item) : !['L', 'ARC', 'CARC', 'C', 'R', 'CIRCLE'].includes(String(item))))
		throw new Error(`${label} 必须是 SDK 多边形源数组；支持 L/ARC/CARC/C 或 R/CIRCLE 轮廓，坐标按官方 SVG 约定`);
}

function describeField(field: Field, family?: Family): string {
	const help: Record<string, string> = {
		net: '网络名称；空字符串表示无网络',
		layer: field.layerKind === 'arc' ? '当前 PCB 实际存在的铜层 ID（已验收：非铜层圆弧创建被宿主拒绝）' : '当前 PCB 存在且类型适用的图层 ID',
		startX: '圆弧起点 X，单位 mil',
		startY: '圆弧起点 Y，单位 mil',
		endX: '圆弧终点 X，单位 mil',
		endY: '圆弧终点 Y，单位 mil',
		arcAngle: '圆弧角度，单位度；范围 -360 到 360，不可为 0',
		lineWidth: '线宽，单位 mil',
		primitiveLock: '是否锁定图元',
		polygonSource: 'SDK 多边形源数组：R,x,y,w,h,rotation,roundness 或 CIRCLE,cx,cy,r；路径支持 L/ARC/CARC/C 后接坐标。角度为度，坐标沿用 SDK/SVG 约定（Y 轴向下）。',
		pathSource: 'SDK 路径数组，支持 L/ARC/CARC/C 段及坐标；坐标单位 mil，沿用 SDK/SVG 约定（Y 轴向下）',
		fillMode: '填充模式：当前宿主只支持 0 实心；1 网格和 2 内电层为未实现的 SDK 预留项',
		ruleType: '区域类型编号：2 禁止器件，5 禁止导线，6 禁止填充，7 禁止覆铜，8 禁止内电层，9 遵循区域规则；这是区域类型，不代表完整规则已绑定',
		regionName: '约束区域名称；只对 ruleType 包含 9（遵循区域规则）生效，禁止区域不保存自定义名称',
		dimensionType: '尺寸类型：Length Dimension、Protractor Dimension、Radius Dimension；Radius 当前只读，可列表但不能新建或修改',
		coordinateSet: '尺寸坐标数组；长度尺寸 8 个值，角度/半径尺寸 6 个值，单位 mil',
		unit: '长度标注可设置 mm、cm、inch、mil；半径只读；角度省略 unit，结果为 degree',
		precision: '小数精度位数',
	};
	if (family === 'fills' && field.input === 'lineWidth')
		return '宿主固定为默认线宽；实际值会在回执中返回。显式设置（包括 0）会在写入前拒绝';
	if (family === 'regions' && field.input === 'lineWidth')
		return '宿主固定为默认区域边框线宽；仅在列表/放置回执读取实际值，不能设置';
	return help[field.input] ?? field.input;
}

function stateValue(item: Primitive, field: Field): unknown {
	const getter = item?.[`getState_${field.state}`];
	if (typeof getter !== 'function')
		throw new Error(`宿主对象缺少 ${field.state} 读回`);
	const value = getter.call(item);
	if (value === undefined || value === null)
		return value;
	if (field.polygon)
		return value?.getSource?.() ?? value;
	if (field.path)
		return value?.getSource?.() ?? value;
	return value;
}

function equalValue(field: Field, actual: unknown, expected: unknown): boolean {
	if (field.input === 'net' && expected === '' && actual === null)
		return true;
	return JSON.stringify(actual) === JSON.stringify(expected);
}

async function assertPcbTarget(ctx?: ICommandContext): Promise<void> {
	if (ctx?.documentTarget?.documentType !== 3 || !ctx.assertDocumentTarget)
		throw new Error('缺少当前 PCB 工程与图页身份，拒绝操作');
	await ctx.assertDocumentTarget();
}

function cleanParams(params: Record<string, any>, allowed: string[]): void {
	const unknown = Object.keys(params).filter(key => !metadata.has(key) && key !== 'primitiveId' && !allowed.includes(key));
	if (unknown.length)
		throw new Error(`不支持的参数：${unknown.join(', ')}`);
}

function makePolygon(family: Family, item: Primitive): unknown {
	if (family === 'fills' || family === 'regions')
		return stateValue(item, { input: 'polygonSource', state: 'ComplexPolygon', sdk: 'complexPolygon', polygon: true });
	if (family === 'polylines')
		return stateValue(item, { input: 'pathSource', state: 'Polygon', sdk: 'polygon', path: true });
	return undefined;
}

function summarize(family: Family, item: Primitive): Record<string, unknown> {
	const spec = families[family];
	const result: Record<string, unknown> = { primitiveId: idOf(item) };
	for (const field of spec.fields) {
		const value = stateValue(item, field);
		if (value !== undefined)
			result[field.input] = field.polygon ? makePolygon(family, item) : value;
	}
	return result;
}

function operationError(label: string, error: unknown, details: Record<string, unknown>): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`${label}的实际结果未能确认：${message}`, { cause: { partial: true, retryable: false, writeAttempted: true, ...details } });
}

function listDefinition(family: Family): ICommandDef {
	const spec = families[family];
	const typeLabel = { arcs: '圆弧', fills: '填充区域', regions: '禁止/约束区域', polylines: '折线', dimensions: '尺寸标注' }[family];
	return {
		name: `pcb.list${family[0].toUpperCase()}${family.slice(1)}`,
		summary: `列出 PCB ${typeLabel}及属性；坐标单位 mil`,
		params: [],
		returns: `{ items:[{primitiveId,...properties}], count }；区域属性为图元轮廓、层和区域类型，不代表其外部规则已绑定。`,
		example: { cmd: `pcb.list${family[0].toUpperCase()}${family.slice(1)}` },
		handler: async (_params, ctx) => {
			await assertPcbTarget(ctx);
			const items = await (eda as any)[spec.api].getAll();
			if (!Array.isArray(items))
				throw new Error(`读取${typeLabel}失败`);
			await assertPcbTarget(ctx);
			const summarized: Record<string, unknown>[] = [];
			for (const item of items) {
				const result = summarize(family, item);
				if (family === 'dimensions')
					Object.assign(result, await dimensionUnitEvidence(ctx, item));
				summarized.push(result);
			}
			await assertPcbTarget(ctx);
			return { items: summarized, count: items.length };
		},
	};
}

function placeDefinition(family: Family): ICommandDef {
	const spec = families[family];
	const typeLabel = { arcs: '圆弧', fills: '填充区域', regions: '禁止/约束区域', polylines: '折线', dimensions: '尺寸标注' }[family];
	const placeFields = family === 'regions' ? spec.fields.filter(field => field.input !== 'lineWidth') : spec.fields;
	const allowed = placeFields.map(field => field.input);
	return {
		name: `pcb.place${family[0].toUpperCase()}${family.slice(1, -1)}`,
		summary: `放置 PCB ${typeLabel}，创建后按属性读回核对；坐标单位 mil${family === 'dimensions' ? '；Radius Dimension 当前只读' : ''}`,
		params: placeFields.map(field => ({ name: field.input, type: field.array || field.polygon ? 'array' : field.numeric ? 'number' : field.boolean ? 'boolean' : 'string', required: spec.required.includes(field.input), description: describeField(field, family) })),
		returns: '{ primitiveId, readbackVerified:true, properties }；调用已发出但回执/读回不确定时 error.cause={partial:true,retryable:false,writeAttempted:true}',
		example: { cmd: `pcb.place${family[0].toUpperCase()}${family.slice(1, -1)}`, params: {} },
		handler: async (params, ctx) => {
			if (family === 'regions')
				validateRegionWrite(params);
			cleanParams(params, allowed);
			if (family === 'fills')
				validateFillWrite(params, 'place');
			for (const key of spec.required) {
				if (params[key] === undefined)
					throw new Error(`缺少参数 ${key}`);
			}
			if (family === 'dimensions')
				validateDimensionWrite(params);
			const values = new Map(placeFields.filter(field => params[field.input] !== undefined).map(field => [field.input, propertyValue(field, params[field.input])]));
			validateCrossFields(family, params);
			for (const field of spec.fields.filter(field => field.layerKind && params[field.input] !== undefined))
				await assertLayerSupported(field.layerKind!, params[field.input], ctx);
			await assertPcbTarget(ctx);
			let attempted = false;
			let createdPrimitiveId: string | undefined;
			try {
				attempted = true;
				const sdk = (eda as any)[spec.api];
				let result: Primitive | undefined;
				switch (family) {
					case 'arcs':
						result = await sdk.create(params.net, params.layer, params.startX, params.startY, params.endX, params.endY, params.arcAngle, params.lineWidth, 1, params.primitiveLock);
						break;
					case 'fills':
						result = await sdk.create(params.layer, values.get('polygonSource'), params.net, params.fillMode, params.lineWidth, params.primitiveLock);
						break;
					case 'regions':
						result = await sdk.create(params.layer, values.get('polygonSource'), params.ruleType, params.regionName, params.lineWidth, params.primitiveLock);
						break;
					case 'polylines':
						result = await sdk.create(params.net, params.layer, values.get('pathSource'), params.lineWidth, params.primitiveLock);
						break;
					case 'dimensions':
						result = await sdk.create(params.dimensionType, params.coordinateSet, params.layer, params.unit, params.lineWidth, params.precision, params.primitiveLock);
						break;
				}
				if (!result)
					throw new Error('宿主返回空对象');
				const primitiveId = idOf(result);
				createdPrimitiveId = primitiveId;
				await assertPcbTarget(ctx);
				const readback = await sdk.get(primitiveId);
				if (!readback || idOf(readback) !== primitiveId)
					throw new Error('新图元无法按 ID 读回');
				const properties: Record<string, unknown> = {};
				for (const field of spec.fields) {
					if (family === 'dimensions' && field.input === 'unit')
						continue;
					if (!values.has(field.input) && !((family === 'fills' || family === 'regions') && ['fillMode', 'lineWidth'].includes(field.input)))
						continue;
					const actual = stateValue(readback, field);
					if (values.has(field.input)) {
						const expected = values.get(field.input);
						const expectedComparable = field.polygon || field.path ? (expected as any)?.getSource?.() ?? expected : expected;
						if (!equalValue(field, actual, expectedComparable))
							throw new Error(`属性 ${field.input} 读回不一致`);
					}
					properties[field.input] = actual;
				}
				if (family === 'dimensions') {
					const unitEvidence = await dimensionUnitEvidence(ctx, readback);
					if (params.unit !== undefined && unitEvidence.sourceUnit !== params.unit)
						throw new Error(`尺寸单位源码读回不一致：请求 ${params.unit}，源码为 ${String(unitEvidence.sourceUnit)}`);
					Object.assign(properties, unitEvidence);
				}
				return { primitiveId, readbackVerified: true, properties };
			}
			catch (error) {
				if (attempted)
					throw operationError(`放置${typeLabel}`, error, { phase: 'place', primitiveId: createdPrimitiveId });
				throw error;
			}
		},
	};
}

function modifyDefinition(family: Family): ICommandDef {
	const spec = families[family];
	const typeLabel = { arcs: '圆弧', fills: '填充区域', regions: '禁止/约束区域', polylines: '折线', dimensions: '尺寸标注' }[family];
	const editableFields = family === 'fills' ? spec.fields.filter(field => field.input !== 'fillMode') : family === 'regions' ? spec.fields.filter(field => field.input !== 'lineWidth') : spec.fields;
	const allowed = editableFields.map(field => field.input);
	return {
		name: `pcb.modify${family[0].toUpperCase()}${family.slice(1, -1)}`,
		summary: `只修改指定 PCB ${typeLabel}属性，并按 ID 读回核对${family === 'dimensions' ? '；Radius Dimension 当前只读' : ''}`,
		params: [{ name: 'primitiveId', type: 'string', required: true, description: '目标图元 ID' }, ...editableFields.map(field => ({ name: field.input, type: field.array || field.polygon ? 'array' : field.numeric ? 'number' : field.boolean ? 'boolean' : 'string', description: describeField(field, family) }))],
		returns: '{ primitiveId, modified:true, readbackVerified:true, properties }；结果未知时 error.cause={partial:true,retryable:false,writeAttempted:true}',
		example: { cmd: `pcb.modify${family[0].toUpperCase()}${family.slice(1, -1)}`, params: { primitiveId: '图元ID' } },
		handler: async (params, ctx) => {
			if (family === 'fills')
				validateFillWrite(params, 'modify');
			if (family === 'regions')
				validateRegionWrite(params);
			cleanParams(params, allowed);
			if (family === 'dimensions' && params.dimensionType !== undefined)
				validateDimensionWrite(params);
			if (typeof params.primitiveId !== 'string' || !params.primitiveId)
				throw new Error('primitiveId 必须是非空字符串');
			const supplied = editableFields.filter(field => params[field.input] !== undefined);
			if (!supplied.length)
				throw new Error('至少提供一个要修改的属性');
			const values = new Map(supplied.map(field => [field.input, propertyValue(field, params[field.input])]));
			await assertPcbTarget(ctx);
			const sdk = (eda as any)[spec.api];
			const before = await sdk.get(params.primitiveId);
			if (!before || idOf(before) !== params.primitiveId)
				throw new Error(`找不到目标${typeLabel} ${params.primitiveId}`);
			if (family === 'dimensions')
				validateDimensionWrite(params, before);
			validateCrossFields(family, params, before);
			for (const field of supplied.filter(field => field.layerKind))
				await assertLayerSupported(field.layerKind!, params[field.input], ctx);
			await assertPcbTarget(ctx);
			const property = Object.fromEntries(supplied.map(field => [field.sdk, values.get(field.input)]));
			let attempted = false;
			try {
				attempted = true;
				const result = await sdk.modify(params.primitiveId, property);
				if (!result)
					throw new Error('宿主返回空对象');
				await assertPcbTarget(ctx);
				const readback = await sdk.get(params.primitiveId);
				if (!readback || idOf(readback) !== params.primitiveId)
					throw new Error('目标图元无法按 ID 重新读取');
				const properties: Record<string, unknown> = {};
				for (const field of supplied) {
					if (family === 'dimensions' && field.input === 'unit')
						continue;
					const expected = values.get(field.input);
					const actual = stateValue(readback, field);
					const expectedComparable = field.polygon || field.path ? (expected as any)?.getSource?.() ?? expected : expected;
					if (!equalValue(field, actual, expectedComparable))
						throw new Error(`属性 ${field.input} 读回不一致`);
					properties[field.input] = actual;
				}
				if (family === 'dimensions') {
					const unitEvidence = await dimensionUnitEvidence(ctx, readback);
					if (params.unit !== undefined && unitEvidence.sourceUnit !== params.unit)
						throw new Error(`尺寸单位源码读回不一致：请求 ${params.unit}，源码为 ${String(unitEvidence.sourceUnit)}`);
					Object.assign(properties, unitEvidence);
				}
				return { primitiveId: params.primitiveId, modified: true, readbackVerified: true, properties };
			}
			catch (error) {
				if (attempted)
					throw operationError(`修改${typeLabel}`, error, { phase: 'modify', primitiveId: params.primitiveId });
				throw error;
			}
		},
	};
}

function placeLineDefinition(): ICommandDef {
	const fields: Field[] = [
		{ input: 'net', state: 'Net', sdk: 'net' },
		{ input: 'layer', state: 'Layer', sdk: 'layer', numeric: true, layerKind: 'line' },
		{ input: 'startX', state: 'StartX', sdk: 'startX', numeric: true },
		{ input: 'startY', state: 'StartY', sdk: 'startY', numeric: true },
		{ input: 'endX', state: 'EndX', sdk: 'endX', numeric: true },
		{ input: 'endY', state: 'EndY', sdk: 'endY', numeric: true },
		{ input: 'lineWidth', state: 'LineWidth', sdk: 'lineWidth', numeric: true },
		{ input: 'primitiveLock', state: 'PrimitiveLock', sdk: 'primitiveLock', boolean: true },
	];
	const command: ICommandDef = {
		name: 'pcb.placeLine',
		summary: '在非铜层放置两点式文档直线；实际创建为 PCB Polyline 图元。铜层电气布线请使用 pcb.routeTrack',
		params: fields.map(field => ({ name: field.input, type: field.numeric ? 'number' : field.boolean ? 'boolean' : 'string', required: ['layer', 'startX', 'startY', 'endX', 'endY'].includes(field.input), description: describeField(field) })),
		returns: '{ primitiveId, primitiveType:"Polyline", readbackVerified:true, properties }；结果未知时 error.cause={partial:true,retryable:false,writeAttempted:true}',
		example: { cmd: 'pcb.placeLine', params: { layer: 3, startX: 1000, startY: 1000, endX: 1500, endY: 1000, lineWidth: 10 } },
		handler: async (params, ctx) => {
			cleanParams(params, fields.map(field => field.input));
			for (const field of fields) {
				if (params[field.input] !== undefined)
					propertyValue(field, params[field.input]);
			}
			for (const required of ['layer', 'startX', 'startY', 'endX', 'endY']) {
				if (params[required] === undefined)
					throw new Error(`缺少参数 ${required}`);
			}
			if (params.startX === params.endX && params.startY === params.endY)
				throw new Error('直线起点和终点不能重合');
			if (params.layer === 1 || params.layer === 2 || (params.layer >= 15 && params.layer <= 46))
				throw new Error('pcb.placeLine 仅用于非铜层文档线；铜层电气布线请使用 pcb.routeTrack 以执行既有约束检查');
			await assertLayerSupported('line', params.layer, ctx);
			await assertPcbTarget(ctx);
			const pathSource = [params.startX, params.startY, 'L', params.endX, params.endY];
			const polygon = eda.pcb_MathPolygon.createPolygon(pathSource as any);
			if (!polygon)
				throw new Error('无法创建两点式折线路径，未执行写入');
			let primitiveId: string | undefined;
			let attempted = false;
			try {
				await assertPcbTarget(ctx);
				attempted = true;
				const created = await eda.pcb_PrimitivePolyline.create(params.net ?? '', params.layer, polygon, params.lineWidth, params.primitiveLock);
				if (!created)
					throw new Error('宿主返回空对象');
				primitiveId = idOf(created);
				await assertPcbTarget(ctx);
				const readback = await eda.pcb_PrimitivePolyline.get(primitiveId);
				if (!readback || idOf(readback) !== primitiveId)
					throw new Error('新折线无法按 ID 读回');
				const properties: Record<string, unknown> = {};
				const verifyFields = families.polylines.fields;
				const expectedValues: Record<string, unknown> = {
					net: params.net ?? '',
					layer: params.layer,
					pathSource,
					...(params.lineWidth === undefined ? {} : { lineWidth: params.lineWidth }),
					...(params.primitiveLock === undefined ? {} : { primitiveLock: params.primitiveLock }),
				};
				for (const field of verifyFields) {
					if (expectedValues[field.input] === undefined)
						continue;
					const expected = expectedValues[field.input];
					const actual = stateValue(readback, field);
					if (!equalValue(field, actual, expected))
						throw new Error(`属性 ${field.input} 读回不一致`);
					properties[field.input] = actual;
				}
				return { primitiveId, primitiveType: 'Polyline', readbackVerified: true, properties };
			}
			catch (error) {
				if (attempted)
					throw operationError('放置直线', error, { phase: 'place', primitiveId });
				throw error;
			}
		},
	};
	return command;
}

const familiesToExpose: Family[] = ['arcs', 'fills', 'regions', 'polylines', 'dimensions'];
export const pcbPlacementPrimitiveCommands: ICommandDef[] = [...familiesToExpose.flatMap(family => [listDefinition(family), placeDefinition(family), modifyDefinition(family)]), placeLineDefinition()];
