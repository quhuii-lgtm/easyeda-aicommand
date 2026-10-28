import type { CurvePrimitive, Point } from './arcTuneGeometry';
import type { ISourceRecord } from './sourcelog';
import { curveFromEndpoints } from './arcTuneGeometry';

export interface ArcReadbackExpectation {
	id: string;
	net: string;
	layer: number;
	width: number;
	curve: Extract<CurvePrimitive, { type: 'arc' }>;
}

export interface ArcReadbackEvidence {
	readbackMode: 'fresh-getter' | 'final-sdk';
	endpointMode: 'within-0.001' | 'sdk-0.1-projection' | 'mismatch';
	expected: ArcReadbackExpectation;
	rawSDK: Record<string, unknown>;
	source: Record<string, unknown>;
	differences: string[];
	actualCurve?: Extract<CurvePrimitive, { type: 'arc' }>;
}

function state(object: unknown, name: string, differences: string[]): unknown {
	const getterName = `getState_${name}`;
	const getter = (object as any)?.[getterName];
	if (typeof getter !== 'function') {
		differences.push(`SDK缺少${getterName}()`);
		return undefined;
	}
	try {
		return getter.call(object);
	}
	catch (error) {
		differences.push(`${getterName}读取失败：${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function near(a: number, b: number, tolerance: number): boolean {
	return Math.abs(a - b) <= tolerance;
}

function pointsNear(a: Point, b: Point, tolerance: number): boolean {
	return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
}

function unambiguousTenthProjection(source: number): number | undefined {
	const scaled = source * 10;
	const fraction = scaled - Math.floor(scaled);
	// Source coordinates are stored to four decimals. A source value within half
	// that quantum of a .05 boundary cannot identify which tenth the SDK projected.
	if (Math.abs(fraction - 0.5) <= 0.0005 + Number.EPSILON * Math.abs(scaled))
		return undefined;
	return Math.round(scaled) / 10;
}

function endpointMatch(sdk: number, source: number): 'within-0.001' | 'sdk-0.1-projection' | undefined {
	if (near(sdk, source, 0.001))
		return 'within-0.001';
	const projection = unambiguousTenthProjection(source);
	if (projection !== undefined && near(sdk, projection, 1e-9))
		return 'sdk-0.1-projection';
	return undefined;
}

function endpointPointMode(sdk: Point, source: Point): 'within-0.001' | 'sdk-0.1-projection' | undefined {
	if (pointsNear(sdk, source, 0.001))
		return 'within-0.001';
	const modes = [endpointMatch(sdk[0], source[0]), endpointMatch(sdk[1], source[1])];
	if (modes.every(Boolean) && modes.includes('sdk-0.1-projection'))
		return 'sdk-0.1-projection';
	return undefined;
}

function sourceCurve(record: ISourceRecord, differences: string[]): { data: Record<string, unknown>; curve?: Extract<CurvePrimitive, { type: 'arc' }> } {
	const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
	if (record.header.type !== 'ARC')
		differences.push(`源码类型应为ARC，实际为${record.header.type}`);
	if (typeof record.header.id !== 'string' || record.header.id === '')
		differences.push('源码ID无效');
	if (data.arcType !== 'DOT')
		differences.push(`源码arcType应为DOT，实际为${String(data.arcType)}`);
	if (typeof data.netName !== 'string')
		differences.push('源码netName无效');
	if (!Number.isInteger(data.layerId))
		differences.push('源码layerId无效');
	if (!finite(data.width) || data.width <= 0)
		differences.push('源码width无效');
	if (![data.startX, data.startY, data.endX, data.endY, data.angle].every(finite)) {
		differences.push('源码端点或angle缺失/非有限数值');
		return { data };
	}
	try {
		return { data, curve: curveFromEndpoints([data.startX as number, data.startY as number], [data.endX as number, data.endY as number], data.angle as number) };
	}
	catch (error) {
		differences.push(`源码ARC几何无法重建：${error instanceof Error ? error.message : String(error)}`);
		return { data };
	}
}

function orientSourceCurve(source: Extract<CurvePrimitive, { type: 'arc' }>, expected: Extract<CurvePrimitive, { type: 'arc' }>): Extract<CurvePrimitive, { type: 'arc' }> | undefined {
	if (pointsNear(source.a, expected.a, 0.001) && pointsNear(source.b, expected.b, 0.001)
		&& source.sweepDegrees === expected.sweepDegrees) {
		return source;
	}
	if (pointsNear(source.a, expected.b, 0.001) && pointsNear(source.b, expected.a, 0.001)
		&& source.sweepDegrees === -expected.sweepDegrees) {
		try {
			return curveFromEndpoints(source.b, source.a, -source.sweepDegrees);
		}
		catch {
			return undefined;
		}
	}
	return undefined;
}

/** Compare a fresh SDK getter with the same-ID source ARC and its plan. */
export function inspectArcReadback(
	object: unknown,
	record: ISourceRecord,
	expected: ArcReadbackExpectation,
	readbackMode: ArcReadbackEvidence['readbackMode'],
): ArcReadbackEvidence {
	const differences: string[] = [];
	const rawSDK: Record<string, unknown> = {};
	for (const name of ['PrimitiveId', 'PrimitiveType', 'Net', 'Layer', 'LineWidth', 'StartX', 'StartY', 'EndX', 'EndY', 'ArcAngle'])
		rawSDK[name] = state(object, name, differences);
	const parsed = sourceCurve(record, differences);
	const data = parsed.data;
	const source = {
		id: record.header.id,
		type: record.header.type,
		arcType: data.arcType,
		net: data.netName,
		layer: data.layerId,
		width: data.width,
		start: [data.startX, data.startY],
		end: [data.endX, data.endY],
		sweepDegrees: data.angle,
		curve: parsed.curve,
	};
	if (record.header.id !== expected.id)
		differences.push(`源码ID ${String(record.header.id)} 与预期 ${expected.id} 不符`);
	if (data.netName !== expected.net)
		differences.push('源码net与规划不符');
	if (data.layerId !== expected.layer)
		differences.push('源码layer与规划不符');
	if (data.width !== expected.width)
		differences.push('源码width与规划不符');
	const plannedCurve = parsed.curve && orientSourceCurve(parsed.curve, expected.curve);
	if (parsed.curve && !plannedCurve)
		differences.push('源码ARC端点/signed sweep与规划不符');
	if (parsed.curve && (!pointsNear(parsed.curve.center, expected.curve.center, 0.001)
		|| !near(parsed.curve.radius, expected.curve.radius, 0.001))) {
		differences.push('源码ARC圆心/半径与规划偏差超过0.001mil');
	}

	if (rawSDK.PrimitiveId !== expected.id)
		differences.push('SDK PrimitiveId与目标ID不符');
	if (rawSDK.PrimitiveType !== 'Arc')
		differences.push(`SDK PrimitiveType应为Arc，实际为${String(rawSDK.PrimitiveType)}`);
	if (rawSDK.Net !== expected.net)
		differences.push('SDK Net与规划不符');
	if (rawSDK.Layer !== expected.layer)
		differences.push('SDK Layer与规划不符');
	if (!finite(rawSDK.LineWidth))
		differences.push('SDK线宽无效');
	else if (rawSDK.LineWidth !== expected.width)
		differences.push('SDK LineWidth与规划不符');

	let endpointMode: ArcReadbackEvidence['endpointMode'] = 'mismatch';
	if ([rawSDK.StartX, rawSDK.StartY, rawSDK.EndX, rawSDK.EndY, rawSDK.ArcAngle].every(finite) && parsed.curve) {
		const sdkA: Point = [rawSDK.StartX as number, rawSDK.StartY as number];
		const sdkB: Point = [rawSDK.EndX as number, rawSDK.EndY as number];
		const checks = (a: Point, b: Point, sourceA: Point, sourceB: Point) => [endpointPointMode(a, sourceA), endpointPointMode(b, sourceB)];
		const directModes = checks(sdkA, sdkB, parsed.curve.a, parsed.curve.b);
		const reversedModes = checks(sdkA, sdkB, parsed.curve.b, parsed.curve.a);
		const direct = directModes.every(Boolean) && near(rawSDK.ArcAngle as number, parsed.curve.sweepDegrees, 1e-8);
		const reversed = reversedModes.every(Boolean) && near(rawSDK.ArcAngle as number, -parsed.curve.sweepDegrees, 1e-8);
		if (direct || reversed) {
			const modes = direct ? directModes : reversedModes;
			endpointMode = modes.includes('sdk-0.1-projection') ? 'sdk-0.1-projection' : 'within-0.001';
		}
		else {
			differences.push('SDK端点/signed sweep与同ID源码不等价');
		}
	}
	else {
		differences.push('SDK端点或ArcAngle缺失/非有限数值');
	}
	return { readbackMode, endpointMode, expected: { ...expected }, rawSDK, source, differences, ...(plannedCurve ? { actualCurve: plannedCurve } : {}) };
}

export function assertArcReadback(evidence: ArcReadbackEvidence): Extract<CurvePrimitive, { type: 'arc' }> {
	if (evidence.differences.length || !evidence.actualCurve) {
		const expected = evidence.expected;
		const expectedRaw = { id: expected.id, type: 'ARC', net: expected.net, layer: expected.layer, width: expected.width, start: expected.curve.a, end: expected.curve.b, angle: expected.curve.sweepDegrees };
		const actualRaw = { id: evidence.rawSDK.PrimitiveId, type: evidence.rawSDK.PrimitiveType, net: evidence.rawSDK.Net, layer: evidence.rawSDK.Layer, width: evidence.rawSDK.LineWidth, start: [evidence.rawSDK.StartX, evidence.rawSDK.StartY], end: [evidence.rawSDK.EndX, evidence.rawSDK.EndY], angle: evidence.rawSDK.ArcAngle };
		throw Object.assign(new Error(`ARC ${String(evidence.source.id)} 读回不符：${evidence.differences.join('；') || '无法恢复源码几何'}；expected=${JSON.stringify(expectedRaw)}；actual=${JSON.stringify(actualRaw)}`), {
			cause: { expected: evidence.expected, source: evidence.source, actual: evidence.rawSDK, readbackMode: evidence.readbackMode, endpointMode: evidence.endpointMode, differences: evidence.differences },
		});
	}
	return evidence.actualCurve;
}
