import type { LengthTuneRequest } from './lengthTuneGeometry.ts';

export type Point = [number, number];
export type CurvePrimitive
	= | { type: 'line'; a: Point; b: Point }
		| { type: 'arc'; a: Point; b: Point; center: Point; radius: number; sweepDegrees: number };

export interface ArcLengthTuneRequest extends LengthTuneRequest {
	bendRadius: number;
}
export interface ArcLengthTunePlan {
	changed: boolean;
	originalSelectedLength: number;
	originalLocalLength: number;
	plannedSelectedLength: number;
	plannedLocalLength: number;
	plannedAddedLength: number;
	localPrimitives: CurvePrimitive[];
	replacement: CurvePrimitive[];
	selectedSide: 'left' | 'right' | 'none';
	unitCount: number;
	selfGapLowerBoundMil: number | 'not-applicable';
	samples: { points: Point[]; edgePrimitiveIndices: number[]; maxSagittaMil: number };
	precisionExplanation: string;
}

const EPS = Number.EPSILON;
const SAMPLE_SAGITTA = 0.0001;
function fail(message: string): never {
	throw new Error(`圆弧走线补长失败：${message}`);
}
function finite(n: unknown, name: string): number {
	if (typeof n !== 'number' || !Number.isFinite(n))
		fail(`${name}必须是有限数值`);
	return n;
}
function distance(a: Point, b: Point): number {
	return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
function clone(p: Point): Point {
	return [p[0], p[1]];
}

export function curveFromEndpoints(a: Point, b: Point, sweepDegrees: number): Extract<CurvePrimitive, { type: 'arc' }> {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 2 || b.length !== 2)
		fail('圆弧端点必须为[x,y]');
	const ax = finite(a[0], 'a.x');
	const ay = finite(a[1], 'a.y');
	const bx = finite(b[0], 'b.x');
	const by = finite(b[1], 'b.y');
	const sweep = finite(sweepDegrees, 'sweepDegrees');
	if (Math.abs(sweep) <= 0 || Math.abs(sweep) >= 360)
		fail('圆弧角度必须在0至360度之间');
	const chord = Math.hypot(bx - ax, by - ay);
	const theta = sweep * Math.PI / 180;
	if (!(chord > 0))
		fail('圆弧端点不能重合');
	const radius = chord / (2 * Math.abs(Math.sin(theta / 2)));
	const offset = chord / (2 * Math.tan(theta / 2));
	const mx = (ax + bx) / 2;
	const my = (ay + by) / 2;
	const center: Point = [mx - (by - ay) / chord * offset, my + (bx - ax) / chord * offset];
	if (![radius, ...center].every(Number.isFinite))
		fail('圆弧中心或半径溢出');
	return { type: 'arc', a: [ax, ay], b: [bx, by], center, radius, sweepDegrees: sweep };
}

export function curveLength(curve: CurvePrimitive): number {
	if (curve.type === 'line')
		return distance(curve.a, curve.b);
	return finite(curve.radius * Math.abs(curve.sweepDegrees) * Math.PI / 180, '圆弧长度');
}
function angleOnSweep(angle: number, start: number, sweep: number): boolean {
	const tau = Math.PI * 2;
	const mod = (v: number) => ((v % tau) + tau) % tau;
	return sweep >= 0 ? mod(angle - start) <= sweep + 1e-12 : mod(start - angle) <= -sweep + 1e-12;
}
export function curveBounds(curve: CurvePrimitive): { xMin: number; yMin: number; xMax: number; yMax: number } {
	const points: Point[] = [curve.a, curve.b];
	if (curve.type === 'arc') {
		const start = Math.atan2(curve.a[1] - curve.center[1], curve.a[0] - curve.center[0]);
		const sweep = curve.sweepDegrees * Math.PI / 180;
		for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
			if (angleOnSweep(angle, start, sweep))
				points.push([curve.center[0] + curve.radius * Math.cos(angle), curve.center[1] + curve.radius * Math.sin(angle)]);
		}
	}
	return { xMin: Math.min(...points.map(p => p[0])), yMin: Math.min(...points.map(p => p[1])), xMax: Math.max(...points.map(p => p[0])), yMax: Math.max(...points.map(p => p[1])) };
}

export function sampleCurves(primitives: CurvePrimitive[], maxSagittaMil: number, checkBudget?: () => void): { points: Point[]; edgePrimitiveIndices: number[]; maxSagittaMil: number } {
	const sagitta = finite(maxSagittaMil, 'maxSagittaMil');
	if (!(sagitta > 0))
		fail('maxSagittaMil必须大于0');
	const points: Point[] = [];
	const edgePrimitiveIndices: number[] = [];
	for (let i = 0; i < primitives.length; i++) {
		checkBudget?.();
		const curve = primitives[i];
		const startIndex = points.length;
		if (startIndex > 0 && distance(points[startIndex - 1], curve.a) > 0.001)
			fail('相邻曲线端点不连续');
		let steps = 1;
		if (curve.type === 'arc') {
			const step = 4 * Math.asin(Math.sqrt(Math.min(1, sagitta / (2 * curve.radius))));
			if (!(step > 0))
				fail('圆弧采样步长无法表示');
			steps = Math.max(1, Math.ceil(Math.abs(curve.sweepDegrees * Math.PI / 180) / step));
		}
		if (i === 0)
			points.push(clone(curve.a));
		for (let k = 1; k <= steps; k++) {
			checkBudget?.();
			if (curve.type === 'line') {
				points.push(clone(curve.b));
			}
			else if (k === steps) {
				points.push(clone(curve.b));
			}
			else {
				const start = Math.atan2(curve.a[1] - curve.center[1], curve.a[0] - curve.center[0]);
				const angle = start + curve.sweepDegrees * Math.PI / 180 * k / steps;
				points.push([curve.center[0] + curve.radius * Math.cos(angle), curve.center[1] + curve.radius * Math.sin(angle)]);
			}
			edgePrimitiveIndices.push(i);
		}
	}
	return { points, edgePrimitiveIndices, maxSagittaMil: sagitta };
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
	const cross = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
	const orient = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)];
	const within = (p: Point, q: Point, r: Point) => q[0] >= Math.min(p[0], r[0]) && q[0] <= Math.max(p[0], r[0])
		&& q[1] >= Math.min(p[1], r[1]) && q[1] <= Math.max(p[1], r[1]);
	const intersects = (orient[0] === 0 && within(a, c, b)) || (orient[1] === 0 && within(a, d, b))
		|| (orient[2] === 0 && within(c, a, d)) || (orient[3] === 0 && within(c, b, d))
		|| (orient[0] * orient[1] < 0 && orient[2] * orient[3] < 0);
	if (intersects)
		return 0;
	const pointDistance = (p: Point, x: Point, y: Point) => {
		const dx = y[0] - x[0];
		const dy = y[1] - x[1];
		if (dx === 0 && dy === 0)
			return distance(p, x);
		const t = Math.max(0, Math.min(1, ((p[0] - x[0]) * dx + (p[1] - x[1]) * dy) / (dx * dx + dy * dy)));
		return Math.hypot(p[0] - x[0] - t * dx, p[1] - x[1] - t * dy);
	};
	return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b));
}
function localPattern(length: number, radius: number, rise: number, span: number): CurvePrimitive[] {
	const arc = (a: Point, b: Point, sweep: number) => curveFromEndpoints(a, b, sweep);
	const p0: Point = [0, 0];
	const p1: Point = [radius, radius];
	const p2: Point = [radius, radius + rise];
	const p3: Point = [2 * radius, 2 * radius + rise];
	const p4: Point = [length - 2 * radius, 2 * radius + rise];
	const p5: Point = [length - radius, radius + rise];
	const p6: Point = [length - radius, radius];
	const p7: Point = [length, 0];
	const output: CurvePrimitive[] = [arc(p0, p1, 90)];
	if (rise)
		output.push({ type: 'line', a: p1, b: p2 });
	output.push(arc(p2, p3, -90));
	if (span)
		output.push({ type: 'line', a: p3, b: p4 });
	output.push(arc(p4, p5, -90));
	if (rise)
		output.push({ type: 'line', a: p5, b: p6 });
	output.push(arc(p6, p7, 90));
	return output;
}
function transform(curve: CurvePrimitive, start: Point, ux: number, uy: number, side: number): CurvePrimitive {
	const map = ([x, y]: Point): Point => [start[0] + x * ux - y * uy * side, start[1] + x * uy + y * ux * side];
	if (curve.type === 'line')
		return { type: 'line', a: map(curve.a), b: map(curve.b) };
	return curveFromEndpoints(map(curve.a), map(curve.b), curve.sweepDegrees * side);
}
function inside(curve: CurvePrimitive, region: ArcLengthTuneRequest['region'], margin: number, tolerance: number): boolean {
	const b = curveBounds(curve);
	return b.xMin >= region.xMin + margin - tolerance && b.xMax <= region.xMax - margin + tolerance
		&& b.yMin >= region.yMin + margin - tolerance && b.yMax <= region.yMax - margin + tolerance;
}

export function planArcLengthTune(request: ArcLengthTuneRequest, checkBudget?: () => void): ArcLengthTunePlan {
	if (!request || typeof request !== 'object')
		fail('request必须为对象');
	if (!Array.isArray(request.path) || request.path.length < 2)
		fail('path至少需要两个坐标点');
	const points = request.path.map((item, i): Point => {
		if (!Array.isArray(item) || item.length !== 2)
			fail(`path[${i}]必须为[x,y]`);
		return [finite(item[0], `path[${i}].x`), finite(item[1], `path[${i}].y`)];
	});
	const index = finite(request.tuneSegmentIndex, 'tuneSegmentIndex');
	if (!Number.isInteger(index) || index < 0 || index >= points.length - 1)
		fail('tuneSegmentIndex无效');
	const width = finite(request.width, 'width');
	const gap = finite(request.minSelfGap, 'minSelfGap');
	const tolerance = finite(request.lengthTolerance, 'lengthTolerance');
	const radius = finite(request.bendRadius, 'bendRadius');
	const target = finite(request.targetLength, 'targetLength');
	if (!(width > 0 && radius > 0 && target > 0 && tolerance > 0) || gap < 0)
		fail('width、bendRadius、targetLength、lengthTolerance必须为正，minSelfGap不得小于0');
	if (request.side !== 'auto' && request.side !== 'left' && request.side !== 'right')
		fail('side必须为auto/left/right');
	const r = request.region;
	if (!r || ![r.xMin, r.yMin, r.xMax, r.yMax].every(Number.isFinite) || !(r.xMin < r.xMax && r.yMin < r.yMax))
		fail('region无效');
	let total = 0;
	let coordinateScale = Math.max(width, gap, target, radius);
	for (const p of points)
		coordinateScale = Math.max(coordinateScale, Math.abs(p[0]), Math.abs(p[1]));
	for (let i = 0; i < points.length - 1; i++) {
		checkBudget?.();
		const length = distance(points[i], points[i + 1]);
		if (!(length > 0))
			fail(`path第${i}段长度为零`);
		total += length;
	}
	const originalLocalLength = distance(points[index], points[index + 1]);
	const delta = target - total;
	const precision = 128 * EPS * coordinateScale;
	if (precision > Math.min(0.001, width * 1e-6))
		fail('坐标精度不足以确认线宽几何');
	const localLine: CurvePrimitive = { type: 'line', a: clone(points[index]), b: clone(points[index + 1]) };
	if (Math.abs(delta) <= tolerance) {
		const replacement = points.slice(1).map((b, i): CurvePrimitive => ({ type: 'line', a: clone(points[i]), b: clone(b) }));
		const samples = sampleCurves([localLine], SAMPLE_SAGITTA, checkBudget);
		return { changed: false, originalSelectedLength: total, originalLocalLength, plannedSelectedLength: total, plannedLocalLength: originalLocalLength, plannedAddedLength: 0, localPrimitives: [localLine], replacement, selectedSide: 'none', unitCount: 0, selfGapLowerBoundMil: 'not-applicable', samples, precisionExplanation: `坐标误差估计${precision}mil；路径真实直线长，当前总长已在显式lengthTolerance内。` };
	}
	if (delta < 0)
		fail('只能补长，targetLength小于当前整链长度');
	const vx = points[index + 1][0] - points[index][0];
	const vy = points[index + 1][1] - points[index][1];
	const D = originalLocalLength;
	const factor = 2 * Math.PI - 4;
	const allowableZero = precision * 8;
	if (Math.PI * radius / 2 < 1)
		fail('半径导致四分之一圆弧长度小于1mil');
	const maxUnits = Math.floor(Math.min((D + allowableZero) / (4 * radius), (delta + allowableZero) / (factor * radius)));
	if (!Number.isSafeInteger(maxUnits) || maxUnits < 1)
		fail('半径和补长量没有自然单位可行界限');
	const sides = request.side === 'auto' ? [1, -1] : request.side === 'left' ? [1] : [-1];
	for (let units = 1; units <= maxUnits; units++) {
		checkBudget?.();
		const unitSpan = D / units;
		const straightRise = (delta / units - factor * radius) / 2;
		const topSpan = unitSpan - 4 * radius;
		if (straightRise < -allowableZero || topSpan < -allowableZero)
			continue;
		if ((straightRise > allowableZero && straightRise < 1) || (topSpan > allowableZero && topSpan < 1))
			continue;
		const local: CurvePrimitive[] = [];
		const cos = vx / D;
		const sin = vy / D;
		for (const side of sides) {
			local.length = 0;
			const boundaries = Array.from({ length: units + 1 }, (_, unit): Point => {
				if (unit === 0)
					return clone(points[index]);
				if (unit === units)
					return clone(points[index + 1]);
				return [points[index][0] + cos * unit * unitSpan, points[index][1] + sin * unit * unitSpan];
			});
			for (let unit = 0; unit < units; unit++) {
				checkBudget?.();
				const pattern = localPattern(unitSpan, radius, Math.max(0, straightRise) <= allowableZero ? 0 : straightRise, Math.max(0, topSpan) <= allowableZero ? 0 : topSpan);
				const transformed = pattern.map(curve => transform(curve, boundaries[unit], cos, sin, side));
				const first = transformed[0];
				first.a = clone(boundaries[unit]);
				if (first.type === 'arc')
					Object.assign(first, curveFromEndpoints(first.a, first.b, first.sweepDegrees));
				const last = transformed.at(-1)!;
				last.b = clone(boundaries[unit + 1]);
				if (last.type === 'arc')
					Object.assign(last, curveFromEndpoints(last.a, last.b, last.sweepDegrees));
				local.push(...transformed);
			}
			if (local.some(curve => !inside(curve, r, width / 2, precision)))
				continue;
			if (local.some(curve => curve.type === 'arc' ? curveLength(curve) < 1 : curveLength(curve) > 0 && curveLength(curve) < 1))
				continue;
			const analyticGap = 2 * radius - width;
			if (analyticGap <= 0 || analyticGap + precision < gap)
				continue;
			const sample = sampleCurves(local, SAMPLE_SAGITTA, checkBudget);
			let minimum = analyticGap;
			let collision = false;
			for (let old = 0; old < points.length - 1; old++) {
				if (old === index || old === index - 1 || old === index + 1)
					continue;
				for (let i = 0; i < sample.edgePrimitiveIndices.length; i++) {
					checkBudget?.();
					const d = segmentDistance(sample.points[i], sample.points[i + 1], points[old], points[old + 1]) - SAMPLE_SAGITTA - width;
					minimum = Math.min(minimum, d);
					if (d <= 0 || d + precision < gap)
						collision = true;
				}
			}
			if (collision)
				continue;
			const plannedLocalLength = local.reduce((sum, curve) => sum + curveLength(curve), 0);
			const plannedTotal = total - D + plannedLocalLength;
			if (Math.abs(plannedTotal - target) > tolerance)
				continue;
			const replacement: CurvePrimitive[] = [];
			for (let i = 0; i < points.length - 1; i++) replacement.push(...(i === index ? local : [{ type: 'line', a: clone(points[i]), b: clone(points[i + 1]) } as CurvePrimitive]));
			return { changed: true, originalSelectedLength: total, originalLocalLength, plannedSelectedLength: plannedTotal, plannedLocalLength, plannedAddedLength: plannedTotal - total, localPrimitives: local, replacement, selectedSide: side === 1 ? 'left' : 'right', unitCount: units, selfGapLowerBoundMil: minimum, samples: sample, precisionExplanation: `圆弧按真实弧长计算；内部四分之一弯折间距按2r-width解析，下界${analyticGap}mil；与非相邻原直线的间距用最大弓高${SAMPLE_SAGITTA}mil的采样估计，坐标误差估计${precision}mil。` };
		}
	}
	fail('指定半径、区域和铜间距下没有可行的四分之一圆弧组合');
}
