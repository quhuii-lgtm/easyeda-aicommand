export type TuneSide = 'auto' | 'left' | 'right';

export interface LengthTuneRequest {
	path: number[][];
	tuneSegmentIndex: number;
	targetLength: number;
	region: { xMin: number; yMin: number; xMax: number; yMax: number };
	side: TuneSide;
	width: number;
	minSelfGap: number;
	lengthTolerance: number;
}

export interface LengthTunePlan {
	changed: boolean;
	originalSelectedLength: number;
	originalLocalLength: number;
	targetLength: number;
	plannedSelectedLength: number;
	plannedLocalLength: number;
	plannedAddedLength: number;
	localPath: number[][];
	replacementPath: number[][];
	selectedSide: 'left' | 'right' | 'none';
	selectedWaveSegments: number;
	normalizedWaveSegments: number;
	minimumSelfGapMil: number | 'not-applicable';
	precisionExplanation: string;
	searchExplanation: string;
}

interface Point { x: number; y: number }
interface Segment { a: Point; b: Point }

const MAX_GEOMETRY_TOLERANCE_MIL = 0.001;

function fail(message: string): never {
	throw new Error(`走线补长规划失败：${message}`);
}

function finite(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		fail(`${name}必须是有限数值`);
	return value;
}

function point(x: number, y: number, name: string): Point {
	finite(x, `${name}.x`);
	finite(y, `${name}.y`);
	return { x, y };
}

function sub(a: Point, b: Point): Point {
	return point(a.x - b.x, a.y - b.y, '坐标差');
}

function add(a: Point, b: Point): Point {
	return point(a.x + b.x, a.y + b.y, '坐标和');
}

function mul(a: Point, k: number): Point {
	return point(a.x * k, a.y * k, '向量积');
}

function dot(a: Point, b: Point): number {
	return finite(a.x * b.x + a.y * b.y, '点积');
}

function cross(a: Point, b: Point): number {
	return finite(a.x * b.y - a.y * b.x, '叉积');
}

function norm(a: Point): number {
	return finite(Math.hypot(a.x, a.y), '长度');
}

function dist(a: Point, b: Point): number {
	return norm(sub(a, b));
}

function orient(a: Point, b: Point, c: Point): number {
	return cross(sub(b, a), sub(c, a));
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
	const v = sub(b, a);
	const vv = dot(v, v);
	if (vv === 0)
		return dist(p, a);
	const t = Math.max(0, Math.min(1, dot(sub(p, a), v) / vv));
	return dist(p, add(a, mul(v, t)));
}

function onSegment(a: Point, b: Point, p: Point, tolerance: number): boolean {
	return Math.abs(orient(a, b, p)) <= tolerance * Math.max(1, dist(a, b))
		&& p.x >= Math.min(a.x, b.x) - tolerance && p.x <= Math.max(a.x, b.x) + tolerance
		&& p.y >= Math.min(a.y, b.y) - tolerance && p.y <= Math.max(a.y, b.y) + tolerance;
}

function intersects(a: Segment, b: Segment, tolerance: number): boolean {
	const la = Math.max(1, dist(a.a, a.b));
	const lb = Math.max(1, dist(b.a, b.b));
	const ea = tolerance * la;
	const eb = tolerance * lb;
	const o1 = orient(a.a, a.b, b.a);
	const o2 = orient(a.a, a.b, b.b);
	const o3 = orient(b.a, b.b, a.a);
	const o4 = orient(b.a, b.b, a.b);
	if (((o1 > ea && o2 < -ea) || (o1 < -ea && o2 > ea)) && ((o3 > eb && o4 < -eb) || (o3 < -eb && o4 > eb)))
		return true;
	return (Math.abs(o1) <= ea && onSegment(a.a, a.b, b.a, tolerance))
		|| (Math.abs(o2) <= ea && onSegment(a.a, a.b, b.b, tolerance))
		|| (Math.abs(o3) <= eb && onSegment(b.a, b.b, a.a, tolerance))
		|| (Math.abs(o4) <= eb && onSegment(b.a, b.b, a.b, tolerance));
}

function segmentDistance(a: Segment, b: Segment, tolerance: number): number {
	if (intersects(a, b, tolerance))
		return 0;
	return Math.min(pointSegmentDistance(a.a, b.a, b.b), pointSegmentDistance(a.b, b.a, b.b), pointSegmentDistance(b.a, a.a, a.b), pointSegmentDistance(b.b, a.a, a.b));
}

function readPath(input: number[][], checkBudget?: () => void): Point[] {
	if (!Array.isArray(input) || input.length < 2)
		fail('path至少需要两个点');
	const result: Point[] = [];
	for (let i = 0; i < input.length; i++) {
		checkBudget?.();
		const item = input[i];
		if (!Array.isArray(item) || item.length !== 2)
			fail(`path[${i}]必须是[x,y]`);
		const p = point(finite(item[0], `path[${i}].x`), finite(item[1], `path[${i}].y`), `path[${i}]`);
		if (i > 0 && dist(p, result[i - 1]) === 0)
			fail(`path第 ${i} 段长度为零`);
		result.push(p);
	}
	return result;
}

function polylineLength(path: Point[], checkBudget?: () => void): number {
	let total = 0;
	for (let i = 0; i < path.length - 1; i++) {
		checkBudget?.();
		total = finite(total + dist(path[i], path[i + 1]), 'path总长');
	}
	return total;
}

function inRegion(p: Point, region: LengthTuneRequest['region'], margin: number, tolerance: number): boolean {
	return p.x >= region.xMin + margin - tolerance && p.x <= region.xMax - margin + tolerance
		&& p.y >= region.yMin + margin - tolerance && p.y <= region.yMax - margin + tolerance;
}

function connectionOnly(shared: Point, candidateOther: Point, existingA: Point, existingB: Point, tolerance: number): boolean {
	const candidate = sub(candidateOther, shared);
	const existing = dist(shared, existingA) <= tolerance
		? sub(existingB, shared)
		: dist(shared, existingB) <= tolerance ? sub(existingA, shared) : null;
	if (!existing)
		return false;
	const scale = Math.max(1, norm(candidate), norm(existing));
	if (Math.abs(cross(candidate, existing)) > tolerance * scale)
		return true;
	return dot(candidate, existing) < 0;
}

function makeWave(start: Point, end: Point, m: number, amplitude: number, side: 'left' | 'right', checkBudget?: () => void): Point[] {
	const vector = sub(end, start);
	const baseLength = norm(vector);
	const tangent = { x: vector.x / baseLength, y: vector.y / baseLength };
	const sign = side === 'left' ? 1 : -1;
	const normal = { x: -tangent.y * sign, y: tangent.x * sign };
	const step = baseLength / m;
	const result: Point[] = [];
	for (let i = 0; i <= m; i++) {
		checkBudget?.();
		const height = i === 0 || i === m ? 0 : (i % 2 === 1 ? (i === m - 1 ? amplitude : amplitude) : 2 * amplitude);
		const along = i === m ? baseLength : i * step;
		const p = add(start, add(mul(tangent, along), mul(normal, height)));
		result.push(i === 0 ? start : i === m ? end : p);
	}
	return result;
}

function normalizeWave(wave: Point[], m: number, checkBudget?: () => void): Point[] {
	if (m < 4)
		return wave;
	const result: Point[] = [];
	for (let i = 0; i < wave.length; i++) {
		checkBudget?.();
		if (i === 1 || i === m - 1)
			continue;
		result.push(wave[i]);
	}
	return result;
}

interface CandidateCheck {
	ok: boolean;
	minimumGap: number | 'not-applicable';
}

function validateCandidate(
	wave: Point[],
	path: Point[],
	segmentIndex: number,
	region: LengthTuneRequest['region'],
	width: number,
	minSelfGap: number,
	tolerance: number,
	checkBudget?: () => void,
): CandidateCheck {
	for (let i = 0; i < wave.length; i++) {
		checkBudget?.();
		if (!inRegion(wave[i], region, width / 2, tolerance))
			return { ok: false, minimumGap: 'not-applicable' };
	}
	const segments: Segment[] = [];
	for (let i = 0; i < wave.length - 1; i++) {
		checkBudget?.();
		const segment = { a: wave[i], b: wave[i + 1] };
		if (dist(segment.a, segment.b) < 1)
			return { ok: false, minimumGap: 'not-applicable' };
		segments.push(segment);
	}
	let minimumGap = Number.POSITIVE_INFINITY;
	let checkedPair = false;
	for (let i = 0; i < segments.length; i++) {
		for (let j = i + 2; j < segments.length; j++) {
			checkBudget?.();
			checkedPair = true;
			const distance = segmentDistance(segments[i], segments[j], tolerance);
			minimumGap = Math.min(minimumGap, distance - width);
			if (distance <= width + tolerance || distance + tolerance < width + minSelfGap)
				return { ok: false, minimumGap };
		}
	}
	for (let i = 0; i < segments.length; i++) {
		for (let j = 0; j < path.length - 1; j++) {
			checkBudget?.();
			if (j === segmentIndex)
				continue;
			const existing = { a: path[j], b: path[j + 1] };
			const allowedJoint = (j === segmentIndex - 1 && i === 0 && connectionOnly(wave[0], wave[1], existing.a, existing.b, tolerance))
				|| (j === segmentIndex + 1 && i === segments.length - 1 && connectionOnly(wave[wave.length - 1], wave[wave.length - 2], existing.a, existing.b, tolerance));
			const distance = segmentDistance(segments[i], existing, tolerance);
			if (allowedJoint) {
				continue;
			}
			checkedPair = true;
			minimumGap = Math.min(minimumGap, distance - width);
			if (distance <= width + tolerance || distance + tolerance < width + minSelfGap)
				return { ok: false, minimumGap };
		}
	}
	return { ok: true, minimumGap: checkedPair ? minimumGap : 'not-applicable' };
}

function replaceSegment(path: Point[], index: number, local: Point[], checkBudget?: () => void): Point[] {
	const result: Point[] = [];
	for (let i = 0; i < index; i++) {
		checkBudget?.();
		result.push(path[i]);
	}
	for (const p of local) {
		checkBudget?.();
		result.push(p);
	}
	for (let i = index + 2; i < path.length; i++) {
		checkBudget?.();
		result.push(path[i]);
	}
	return result;
}

function toArrays(points: Point[], checkBudget?: () => void): number[][] {
	const result: number[][] = [];
	for (const p of points) {
		checkBudget?.();
		result.push([p.x, p.y]);
	}
	return result;
}

export function planLengthTune(request: LengthTuneRequest, checkBudget?: () => void): LengthTunePlan {
	if (!request || typeof request !== 'object')
		fail('request必须是对象');
	const path = readPath(request.path, checkBudget);
	const index = finite(request.tuneSegmentIndex, 'tuneSegmentIndex');
	if (!Number.isInteger(index) || index < 0 || index >= path.length - 1)
		fail('tuneSegmentIndex必须指向path中的有效线段');
	const target = finite(request.targetLength, 'targetLength');
	const width = finite(request.width, 'width');
	const minSelfGap = finite(request.minSelfGap, 'minSelfGap');
	const lengthTolerance = finite(request.lengthTolerance, 'lengthTolerance');
	if (!(target > 0) || !(width > 0) || minSelfGap < 0 || !(lengthTolerance > 0))
		fail('targetLength、width必须大于0，minSelfGap必须大于等于0，lengthTolerance必须大于0');
	if (request.side !== 'auto' && request.side !== 'left' && request.side !== 'right')
		fail('side必须是auto、left或right');
	const r = request.region;
	if (!r || typeof r !== 'object')
		fail('region必须是对象');
	const region = {
		xMin: finite(r.xMin, 'region.xMin'),
		yMin: finite(r.yMin, 'region.yMin'),
		xMax: finite(r.xMax, 'region.xMax'),
		yMax: finite(r.yMax, 'region.yMax'),
	};
	if (!(region.xMin < region.xMax) || !(region.yMin < region.yMax))
		fail('region边界无效');
	const total = polylineLength(path, checkBudget);
	const selected = dist(path[index], path[index + 1]);
	const delta = target - total;
	if (!Number.isFinite(delta))
		fail('目标补长量溢出');
	const precisionScale = Math.max(1, width, minSelfGap, target, total);
	let coordinateScale = precisionScale;
	for (const p of path) {
		checkBudget?.();
		coordinateScale = Math.max(coordinateScale, Math.abs(p.x), Math.abs(p.y));
	}
	const numericTolerance = finite(128 * Number.EPSILON * coordinateScale, '几何数值容差');
	const allowedNumericTolerance = Math.min(MAX_GEOMETRY_TOLERANCE_MIL, Math.max(Number.MIN_VALUE, width * 1e-6));
	if (numericTolerance > allowedNumericTolerance)
		fail(`坐标精度不足以确认线宽几何（误差界 ${numericTolerance} mil 超过允许值 ${allowedNumericTolerance} mil）`);
	const lengthErrorBound = finite(32 * Number.EPSILON * Math.max(coordinateScale, total) * (path.length + 4), '累计长度误差界');
	if (lengthTolerance < lengthErrorBound)
		fail(`lengthTolerance小于累计长度数值误差界 ${lengthErrorBound} mil`);
	if (Math.abs(delta) <= lengthTolerance) {
		return {
			changed: false,
			originalSelectedLength: total,
			originalLocalLength: selected,
			targetLength: target,
			plannedSelectedLength: total,
			plannedLocalLength: selected,
			plannedAddedLength: 0,
			localPath: [[path[index].x, path[index].y], [path[index + 1].x, path[index + 1].y]],
			replacementPath: toArrays(path, checkBudget),
			selectedSide: 'none',
			selectedWaveSegments: 0,
			normalizedWaveSegments: 0,
			minimumSelfGapMil: 'not-applicable',
			precisionExplanation: `几何数值容差 ${numericTolerance} mil；路径累计长度误差界 ${lengthErrorBound} mil，lengthTolerance ${lengthTolerance} mil。`,
			searchExplanation: '目标长度已在lengthTolerance内，未修改路径。',
		};
	}
	if (delta < 0)
		fail(`只能补长；当前总长 ${total} mil，目标 ${target} mil 小于当前路径`);
	const start = path[index];
	const end = path[index + 1];
	const vx = end.x - start.x;
	const vy = end.y - start.y;
	const D = finite(Math.hypot(vx, vy), '调节段长度');
	const margin = width / 2;
	if (!inRegion(start, region, margin, numericTolerance) || !inRegion(end, region, margin, numericTolerance))
		fail('目标段端点未完整落入region收缩width/2后的区域；此蛇形族无法规划');
	const localLength = finite(D + delta, '调节段目标长度');
	const maxSegments = Math.floor(localLength);
	if (maxSegments > Number.MAX_SAFE_INTEGER)
		fail('目标长度对应的自然波数上界超过可精确表示的整数范围');
	if (maxSegments < 2)
		fail('此蛇形族没有满足最低1 mil段长的可行波数');
	const sides: Array<'left' | 'right'> = request.side === 'auto' ? ['left', 'right'] : [request.side];
	for (let m = 2; m <= maxSegments; m += 2) {
		checkBudget?.();
		const amplitude = finite(Math.sqrt(((localLength - D) / m) * ((localLength + D) / m)), '蛇形振幅');
		for (const side of sides) {
			checkBudget?.();
			const generated = makeWave(start, end, m, amplitude, side, checkBudget);
			const local = normalizeWave(generated, m, checkBudget);
			const checked = validateCandidate(local, path, index, region, width, minSelfGap, numericTolerance, checkBudget);
			if (!checked.ok)
				continue;
			const replacement = replaceSegment(path, index, local, checkBudget);
			const plannedSelectedLength = polylineLength(local, checkBudget);
			const plannedTotal = polylineLength(replacement, checkBudget);
			const outputLengthErrorBound = finite(32 * Number.EPSILON * Math.max(coordinateScale, plannedTotal) * (replacement.length + 4), '输出累计长度误差界');
			if (lengthTolerance < outputLengthErrorBound)
				fail(`lengthTolerance小于输出路径累计长度误差估计 ${outputLengthErrorBound} mil`);
			if (Math.abs(plannedTotal - target) > lengthTolerance)
				fail(`生成路径总长误差 ${Math.abs(plannedTotal - target)} mil 超过 lengthTolerance ${lengthTolerance} mil`);
			return {
				changed: true,
				originalSelectedLength: total,
				originalLocalLength: selected,
				targetLength: target,
				plannedSelectedLength: plannedTotal,
				plannedLocalLength: plannedSelectedLength,
				plannedAddedLength: plannedTotal - total,
				localPath: toArrays(local, checkBudget),
				replacementPath: toArrays(replacement, checkBudget),
				selectedSide: side,
				selectedWaveSegments: m,
				normalizedWaveSegments: local.length - 1,
				minimumSelfGapMil: checked.minimumGap,
				precisionExplanation: `几何数值容差 ${numericTolerance} mil；输入路径累计长度误差估计 ${lengthErrorBound} mil；输出路径累计长度误差估计 ${outputLengthErrorBound} mil；目标比较容差为显式 lengthTolerance ${lengthTolerance} mil。`,
				searchExplanation: `按偶数波段数从2开始逐一搜索，首个可行候选生成 ${m} 段、${side}侧；移除构造恒等的首尾共线内部点后输出 ${local.length - 1} 段，路径总长 ${plannedTotal} mil。只规划局部链，不验证阻抗或整板避障。`,
			};
		}
	}
	fail('此蛇形族在目标region和铜间距条件下没有可行方案');
}
