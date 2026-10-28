import type { CurvePrimitive } from './arcTuneGeometry';
import type { GeometryHost } from './geometryHost';
import { assertArcReadback, inspectArcReadback } from './arcReadback';
import { curveFromEndpoints } from './arcTuneGeometry';
import { parseSourceLog, resolveRecords } from './sourcelog';

export interface CurveTuneWriterRequest {
	net: string;
	layer: number;
	width: number;
	primitives: CurvePrimitive[];
}

export interface CurveTuneCreatedPrimitive {
	type: 'line' | 'arc';
	id: string;
}

export interface CurveTuneWriterResult {
	createdPrimitives: CurveTuneCreatedPrimitive[];
	actualPrimitives: CurvePrimitive[];
}

interface CandidatePrimitive { type: 'line' | 'arc'; id: string | null }

const COORDINATE_TOLERANCE_MIL = 0.001;
// SDK sweep comparison tolerates only floating-point noise; arc direction remains significant.
const SWEEP_TOLERANCE_DEGREES = 1e-8;

function fail(message: string): never {
	throw new Error(`圆弧走线图元写入失败：${message}`);
}

function finite(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		fail(`${name}必须是有限数值`);
	return value;
}

function point(value: unknown, name: string): [number, number] {
	if (!Array.isArray(value) || value.length !== 2)
		fail(`${name}必须是[x,y]`);
	return [finite(value[0], `${name}.x`), finite(value[1], `${name}.y`)];
}

function close(a: number, b: number, tolerance = COORDINATE_TOLERANCE_MIL): boolean {
	return Math.abs(a - b) <= tolerance;
}

function pointsClose(a: [number, number], b: [number, number]): boolean {
	return close(a[0], b[0]) && close(a[1], b[1]);
}

function validateInput(request: CurveTuneWriterRequest): CurvePrimitive[] {
	if (!request || typeof request !== 'object')
		fail('request必须是对象');
	if (typeof request.net !== 'string' || !request.net.trim())
		fail('net必须是非空字符串');
	if (!Number.isInteger(request.layer) || request.layer < 0)
		fail('layer必须是非负整数');
	if (!(finite(request.width, 'width') > 0))
		fail('width必须大于0');
	if (!Array.isArray(request.primitives))
		fail('primitives必须是数组');
	return request.primitives.map((primitive, index) => {
		if (!primitive || typeof primitive !== 'object')
			fail(`primitives[${index}]无效`);
		const a = point(primitive.a, `primitives[${index}].a`);
		const b = point(primitive.b, `primitives[${index}].b`);
		if (a[0] === b[0] && a[1] === b[1])
			fail(`primitives[${index}]长度为零`);
		if (primitive.type === 'line')
			return { type: 'line', a, b };
		if (primitive.type === 'arc') {
			const center = point(primitive.center, `primitives[${index}].center`);
			const radius = finite(primitive.radius, `primitives[${index}].radius`);
			if (!(radius > 0))
				fail(`primitives[${index}].radius必须大于0`);
			const sweepDegrees = finite(primitive.sweepDegrees, `primitives[${index}].sweepDegrees`);
			let derived: Extract<CurvePrimitive, { type: 'arc' }>;
			try {
				derived = curveFromEndpoints(a, b, sweepDegrees);
			}
			catch (error) {
				fail(`primitives[${index}]圆弧参数无效：${error instanceof Error ? error.message : String(error)}`);
			}
			if (!pointsClose(derived.center, center) || !close(derived.radius, radius))
				fail(`primitives[${index}]中心/半径与端点和扫角不一致`);
			return { type: 'arc', a, b, center, radius, sweepDegrees };
		}
		return fail(`primitives[${index}].type必须是line或arc`);
	});
}

function returnedId(value: unknown): string | undefined {
	if (!value || typeof value !== 'object')
		return undefined;
	try {
		const getter = (value as any).getState_PrimitiveId;
		const id = typeof getter === 'function' ? getter.call(value) : undefined;
		return typeof id === 'string' && id.trim() ? id : undefined;
	}
	catch {
		return undefined;
	}
}

function state<T>(object: unknown, getterName: string, label: string): T {
	const getter = (object as any)?.[getterName];
	if (typeof getter !== 'function')
		fail(`${label}缺少${getterName}()`);
	let value: unknown;
	try {
		value = getter.call(object);
	}
	catch (error) {
		fail(`${label}.${getterName}()读取失败：${error instanceof Error ? error.message : String(error)}`);
	}
	return value as T;
}

function numberState(object: unknown, getterName: string, label: string): number {
	return finite(state(object, getterName, label), `${label}.${getterName}()`);
}

function getExpectedType(type: CurvePrimitive['type']): 'Line' | 'Arc' {
	return type === 'line' ? 'Line' : 'Arc';
}

function verifyAttributes(
	object: unknown,
	candidateId: string,
	primitive: CurvePrimitive,
	request: CurveTuneWriterRequest,
): CurvePrimitive {
	const label = `${primitive.type} ${candidateId}`;
	const actualId = state<string>(object, 'getState_PrimitiveId', label);
	if (actualId !== candidateId)
		fail(`${label}读回ID为${String(actualId)}`);
	const actualType = state<string>(object, 'getState_PrimitiveType', label);
	if (actualType !== getExpectedType(primitive.type))
		fail(`${label}类型应为${getExpectedType(primitive.type)}，实际为${String(actualType)}`);
	const net = state<string>(object, 'getState_Net', label);
	const layer = numberState(object, 'getState_Layer', label);
	const width = numberState(object, 'getState_LineWidth', label);
	if (net !== request.net || layer !== request.layer || !close(width, request.width))
		fail(`${label}的net/layer/width读回不符`);
	const actualA: [number, number] = [numberState(object, 'getState_StartX', label), numberState(object, 'getState_StartY', label)];
	const actualB: [number, number] = [numberState(object, 'getState_EndX', label), numberState(object, 'getState_EndY', label)];
	if (primitive.type === 'line') {
		const direct = pointsClose(actualA, primitive.a) && pointsClose(actualB, primitive.b);
		const reversed = pointsClose(actualA, primitive.b) && pointsClose(actualB, primitive.a);
		if (!direct && !reversed)
			fail(`${label}端点读回不符`);
		return { type: 'line', a: direct ? actualA : actualB, b: direct ? actualB : actualA };
	}
	const actualSweep = numberState(object, 'getState_ArcAngle', label);
	const direct = pointsClose(actualA, primitive.a) && pointsClose(actualB, primitive.b)
		&& close(actualSweep, primitive.sweepDegrees, SWEEP_TOLERANCE_DEGREES);
	const reversed = pointsClose(actualA, primitive.b) && pointsClose(actualB, primitive.a)
		&& close(actualSweep, -primitive.sweepDegrees, SWEEP_TOLERANCE_DEGREES);
	if (!direct && !reversed)
		fail(`${label}端点/扫角方向读回不等价`);
	let actualArc: Extract<CurvePrimitive, { type: 'arc' }>;
	try {
		actualArc = curveFromEndpoints(actualA, actualB, actualSweep);
	}
	catch (error) {
		fail(`${label}实际圆弧无法重建：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!pointsClose(actualArc.center, primitive.center) || !close(actualArc.radius, primitive.radius))
		fail(`${label}重建的圆心或半径与规划不符`);
	if (direct)
		return actualArc;
	try {
		return curveFromEndpoints(actualB, actualA, -actualSweep);
	}
	catch (error) {
		fail(`${label}实际圆弧反向归一化失败：${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function writeTuneCurves(host: GeometryHost, request: CurveTuneWriterRequest): Promise<CurveTuneWriterResult> {
	if (!host || typeof host.write !== 'function' || typeof host.read !== 'function' || typeof host.checkBudget !== 'function')
		fail('host必须是有效GeometryHost');
	const primitives = validateInput(request);
	const createdPrimitives: CurveTuneCreatedPrimitive[] = [];
	const actualPrimitives: CurvePrimitive[] = [];
	let candidatePrimitive: CandidatePrimitive | undefined;
	const partial = (error: unknown): never => host.fail(error, {
		createdPrimitives: [...createdPrimitives],
		actualPrimitives: [...actualPrimitives],
		candidatePrimitive,
	});

	for (let index = 0; index < primitives.length; index++) {
		const primitive = primitives[index];
		const type = primitive.type;
		let rawCreated: unknown;
		try {
			host.checkBudget();
			rawCreated = await host.write(`创建${type === 'line' ? '直线' : '圆弧'} ${index + 1}/${primitives.length}`, async () => {
				candidatePrimitive = { type, id: null };
				const result = type === 'line'
					? await host.sdk.pcb_PrimitiveLine.create(request.net, request.layer, primitive.a[0], primitive.a[1], primitive.b[0], primitive.b[1], request.width, false)
					: await host.sdk.pcb_PrimitiveArc.create(request.net, request.layer, primitive.a[0], primitive.a[1], primitive.b[0], primitive.b[1], primitive.sweepDegrees, request.width, 1, false);
				rawCreated = result;
				return result;
			});
			const id = returnedId(rawCreated);
			candidatePrimitive = { type, id: id ?? null };
			if (!id)
				fail(`${type} SDK返回对象缺少有效图元ID`);
			host.recordCreated(id);

			const primitiveSdk = type === 'line' ? host.sdk.pcb_PrimitiveLine : host.sdk.pcb_PrimitiveArc;
			const fresh = await host.read(`按ID读回${type} ${id}`, () => primitiveSdk.get(id));
			if (!fresh)
				fail(`${type}候选ID ${id}读回为空`);
			const listedIds = await host.read(`枚举核对${type} ${id}`, () => primitiveSdk.getAllPrimitiveId());
			if (!Array.isArray(listedIds) || listedIds.some(value => typeof value !== 'string' || !value.trim()))
				fail(`${type} getAllPrimitiveId 返回非法`);
			if (!listedIds.includes(id))
				fail(`${type}候选ID ${id}未出现在最新图元枚举中，可能发生合并`);
			let actual: CurvePrimitive;
			if (primitive.type === 'arc') {
				const sourceText = await host.read(`读取ARC ${id}源码`, () => host.sdk.sys_FileManager.getDocumentSource());
				if (typeof sourceText !== 'string')
					fail(`ARC ${id}源码读回无效`);
				const document = parseSourceLog(sourceText);
				if (document.uuid !== host.documentUuid || document.docType.toUpperCase() !== 'PCB')
					fail(`ARC ${id}源码文档身份不符`);
				const sourceRecord = resolveRecords(document, 'ARC').get(`ARC\0${id}`);
				if (!sourceRecord)
					fail(`ARC ${id}未出现在当前源码记录中`);
				const evidence = inspectArcReadback(fresh, sourceRecord, { id, net: request.net, layer: request.layer, width: request.width, curve: primitive }, 'fresh-getter');
				actual = assertArcReadback(evidence);
			}
			else {
				actual = verifyAttributes(fresh, id, primitive, request);
			}
			createdPrimitives.push({ type, id });
			actualPrimitives.push(actual);
			host.recordVerified(id);
			candidatePrimitive = undefined;
		}
		catch (error) {
			const candidateId = returnedId(rawCreated);
			if (candidateId) {
				candidatePrimitive = { type, id: candidateId };
				host.recordCreated(candidateId);
			}
			return partial(error);
		}
	}
	return { createdPrimitives, actualPrimitives };
}
