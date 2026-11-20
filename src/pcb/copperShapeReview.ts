export interface Point { x: number; y: number }
export interface Segment { kind: 'line' | 'arc'; start: Point; end: Point; sweepDegrees?: number }
export interface Ring { segments: Segment[]; closed: boolean; signedAreaMil2: number; boundsMil: { minX: number; minY: number; maxX: number; maxY: number } }

const SCALE_TO_MIL = 10;
const EPS = 1e-7;
const FLATNESS_MIL = 0.025;

function finite(n: unknown): n is number {
	return typeof n === 'number' && Number.isFinite(n);
}
/** SourceLog wraps a one-ring fill path in one extra array while SDK readback returns the ring directly. */
export function sameCopperPath(a: unknown, b: unknown): boolean {
	const unwrapSingleRing = (value: unknown): unknown => Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) ? value[0] : value;
	return JSON.stringify(unwrapSingleRing(a)) === JSON.stringify(unwrapSingleRing(b));
}
function point(x: unknown, y: unknown): Point {
	if (!finite(x) || !finite(y))
		throw new Error('轮廓坐标必须是有限数值');
	return { x: x * SCALE_TO_MIL, y: y * SCALE_TO_MIL };
}
function close(a: Point, b: Point): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= EPS;
}

/** Parse the public EasyEDA ComplexPolygon path grammar; unsupported tokens are rejected. */
export function parseCopperPath(source: unknown): Ring[] {
	if (!Array.isArray(source) || source.length < 1)
		throw new Error('填充路径不是非空数组');
	const paths: unknown[][] = Array.isArray(source[0]) ? source as unknown[][] : [source];
	return paths.map((raw) => {
		if (!Array.isArray(raw) || raw.length < 4)
			throw new Error('轮廓路径长度不足');
		let cursor = 2;
		let current = point(raw[0], raw[1]);
		const segments: Segment[] = [];
		while (cursor < raw.length) {
			const token = raw[cursor];
			if (token === 'L') {
				if (cursor + 2 >= raw.length)
					throw new Error('L 线段缺少终点');
				const end = point(raw[cursor + 1], raw[cursor + 2]);
				if (!close(current, end))
					segments.push({ kind: 'line', start: current, end });
				current = end;
				cursor += 3;
			}
			else if (token === 'ARC') {
				if (cursor + 3 >= raw.length || !finite(raw[cursor + 1]))
					throw new Error('ARC 缺少有效角度或终点');
				const end = point(raw[cursor + 2], raw[cursor + 3]);
				const sweepDegrees = raw[cursor + 1] as number;
				if (Math.abs(sweepDegrees) < 1e-9 || Math.abs(sweepDegrees) >= 360)
					throw new Error('ARC 角度必须在 0 到 360 度之间');
				segments.push({ kind: 'arc', start: current, end, sweepDegrees });
				current = end;
				cursor += 4;
			}
			else if (token === 'CARC') {
				throw new Error('CARC 中心圆弧当前没有经验证的填充换算，拒绝猜测');
			}
			else if (finite(token) && finite(raw[cursor + 1])) {
				const end = point(token, raw[cursor + 1]);
				if (!close(current, end))
					segments.push({ kind: 'line', start: current, end });
				current = end;
				cursor += 2;
			}
			else {
				throw new Error(`不支持的铜形路径元素 ${String(token)}`);
			}
			const lastSegment = segments.at(-1);
			if (lastSegment && close(lastSegment.start, lastSegment.end))
				throw new Error('轮廓含零长度边');
		}
		if (!segments.length)
			throw new Error('轮廓没有线段');
		const closed = close(segments.at(-1)!.end, segments[0].start);
		const points = flattenSegments(segments);
		const signedAreaMil2 = closed ? polygonArea(points) : 0;
		if (closed && Math.abs(signedAreaMil2) <= EPS)
			throw new Error('闭合铜形面积为零');
		const xs = points.map(p => p.x);
		const ys = points.map(p => p.y);
		return { segments, closed, signedAreaMil2, boundsMil: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } };
	});
}

function arcCenter(segment: Segment): { center: Point; radius: number; sweep: number } {
	const sweep = segment.sweepDegrees! * Math.PI / 180;
	const { start: a, end: b } = segment;
	const chord = Math.hypot(b.x - a.x, b.y - a.y);
	const sinHalf = Math.sin(Math.abs(sweep) / 2);
	if (chord <= EPS || Math.abs(sinHalf) <= EPS)
		throw new Error('ARC 弦长或角度无效');
	const radius = chord / (2 * sinHalf);
	const offset = chord / (2 * Math.tan(sweep / 2));
	const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	const left = { x: -(b.y - a.y) / chord, y: (b.x - a.x) / chord };
	return { center: { x: midpoint.x + left.x * offset, y: midpoint.y + left.y * offset }, radius, sweep };
}

function flattenSegments(segments: Segment[]): Point[] {
	const result: Point[] = [];
	for (const segment of segments) {
		if (segment.kind === 'line') {
			result.push(segment.start);
			continue;
		}
		const { center, radius, sweep } = arcCenter(segment);
		const maxStep = radius <= FLATNESS_MIL ? Math.PI / 2 : 2 * Math.acos(Math.max(-1, 1 - FLATNESS_MIL / radius));
		const count = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(maxStep, 1e-4)));
		const startAngle = Math.atan2(segment.start.y - center.y, segment.start.x - center.x);
		for (let i = 0; i < count; i++) {
			const angle = startAngle + sweep * i / count;
			result.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
		}
	}
	if (segments.length)
		result.push(segments.at(-1)!.end);
	return result;
}

function polygonArea(points: Point[]): number {
	let twice = 0;
	for (let i = 0; i < points.length - 1; i++) twice += points[i].x * points[i + 1].y - points[i + 1].x * points[i].y;
	return twice / 2;
}

function perimeter(ring: Ring): number {
	return ring.segments.reduce((sum, segment) => {
		if (segment.kind === 'line')
			return sum + Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
		const { radius, sweep } = arcCenter(segment);
		return sum + radius * Math.abs(sweep);
	}, 0);
}

function pointInRing(p: Point, ring: Ring): boolean {
	let crossings = 0;
	for (const segment of ring.segments) {
		if (segment.kind === 'line') {
			const a = segment.start;
			const b = segment.end;
			if ((a.y > p.y) !== (b.y > p.y)) {
				const x = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
				if (x > p.x)
					crossings++;
			}
			continue;
		}
		const { center, radius, sweep } = arcCenter(segment);
		const dy = p.y - center.y;
		if (Math.abs(dy) > radius + EPS)
			continue;
		const ratio = Math.max(-1, Math.min(1, dy / radius));
		const base = Math.asin(ratio);
		const start = Math.atan2(segment.start.y - center.y, segment.start.x - center.x);
		for (const rawAngle of [base, Math.PI - base]) {
			const low = Math.min(start, start + sweep);
			const high = Math.max(start, start + sweep);
			const k0 = Math.floor((low - rawAngle) / (2 * Math.PI)) - 1;
			const k1 = Math.ceil((high - rawAngle) / (2 * Math.PI)) + 1;
			for (let k = k0; k <= k1; k++) {
				const angle = rawAngle + k * 2 * Math.PI;
				const t = (angle - start) / sweep;
				if (t < -EPS || t > 1 + EPS)
					continue;
				const verticalDirection = radius * Math.cos(angle) * sweep;
				if (Math.abs(verticalDirection) <= 1e-10)
					continue; // horizontal tangent does not cross the ray.
				// Match the line-edge half-open rule: lower endpoints count, upper endpoints do not.
				if (t <= EPS && verticalDirection < 0)
					continue;
				if (t >= 1 - EPS && verticalDirection > 0)
					continue;
				const x = center.x + radius * Math.cos(angle);
				if (x > p.x)
					crossings++;
			}
		}
	}
	return crossings % 2 === 1;
}

function polylinesIntersect(a: Point[], b: Point[]): boolean {
	const orient = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
	const on = (p: Point, q: Point, r: Point) => r.x >= Math.min(p.x, q.x) - EPS && r.x <= Math.max(p.x, q.x) + EPS && r.y >= Math.min(p.y, q.y) - EPS && r.y <= Math.max(p.y, q.y) + EPS;
	for (let i = 0; i < a.length - 1; i++) {
		for (let j = 0; j < b.length - 1; j++) {
			const p = a[i];
			const q = a[i + 1];
			const r = b[j];
			const s = b[j + 1];
			const o1 = orient(p, q, r);
			const o2 = orient(p, q, s);
			const o3 = orient(r, s, p);
			const o4 = orient(r, s, q);
			const oppositeFirst = (o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS);
			const oppositeSecond = (o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS);
			if (oppositeFirst && oppositeSecond)
				return true;
			if ((Math.abs(o1) <= EPS && on(p, q, r)) || (Math.abs(o2) <= EPS && on(p, q, s)) || (Math.abs(o3) <= EPS && on(r, s, p)) || (Math.abs(o4) <= EPS && on(r, s, q)))
				return true;
		}
	}
	return false;
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	if (len2 <= EPS * EPS)
		return Math.hypot(p.x - a.x, p.y - a.y);
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
	return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function angleOnArc(angle: number, start: number, sweep: number): boolean {
	const tau = Math.PI * 2;
	const mod = (n: number) => ((n % tau) + tau) % tau;
	return sweep >= 0 ? mod(angle - start) <= sweep + 1e-10 : mod(start - angle) <= -sweep + 1e-10;
}

function pointArcDistance(p: Point, segment: Segment): number {
	const { center, radius, sweep } = arcCenter(segment);
	const angle = Math.atan2(p.y - center.y, p.x - center.x);
	const startAngle = Math.atan2(segment.start.y - center.y, segment.start.x - center.x);
	if (angleOnArc(angle, startAngle, sweep))
		return Math.abs(Math.hypot(p.x - center.x, p.y - center.y) - radius);
	return Math.min(Math.hypot(p.x - segment.start.x, p.y - segment.start.y), Math.hypot(p.x - segment.end.x, p.y - segment.end.y));
}

function pointSegmentLikeDistance(p: Point, segment: Segment): number {
	return segment.kind === 'line' ? pointSegmentDistance(p, segment.start, segment.end) : pointArcDistance(p, segment);
}

function addCircleRoots(events: number[], origin: Point, direction: Point, center: Point, radius: number): void {
	const qx = origin.x - center.x;
	const qy = origin.y - center.y;
	const aa = direction.x ** 2 + direction.y ** 2;
	const bb = 2 * (qx * direction.x + qy * direction.y);
	const cc = qx ** 2 + qy ** 2 - radius ** 2;
	const disc = bb ** 2 - 4 * aa * cc;
	if (disc < -EPS)
		return;
	const root = Math.sqrt(Math.max(0, disc));
	for (const t of [(-bb - root) / (2 * aa), (-bb + root) / (2 * aa)]) {
		if (t >= -EPS && t <= 1 + EPS)
			events.push(Math.max(0, Math.min(1, t)));
	}
}

function addLineIntersection(events: number[], origin: Point, direction: Point, a: Point, b: Point): void {
	const edge = { x: b.x - a.x, y: b.y - a.y };
	const cross = (u: Point, v: Point) => u.x * v.y - u.y * v.x;
	const denominator = cross(direction, edge);
	const delta = { x: a.x - origin.x, y: a.y - origin.y };
	if (Math.abs(denominator) <= EPS) {
		if (Math.abs(cross(delta, direction)) > EPS)
			return;
		const len2 = direction.x ** 2 + direction.y ** 2;
		for (const p of [a, b]) {
			const t = ((p.x - origin.x) * direction.x + (p.y - origin.y) * direction.y) / len2;
			if (t >= -EPS && t <= 1 + EPS)
				events.push(Math.max(0, Math.min(1, t)));
		}
		return;
	}
	const t = cross(delta, edge) / denominator;
	const u = cross(delta, direction) / denominator;
	if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS)
		events.push(Math.max(0, Math.min(1, t)));
}

function addArcIntersection(events: number[], origin: Point, direction: Point, segment: Segment): void {
	const { center, radius } = arcCenter(segment);
	const startAngle = Math.atan2(segment.start.y - center.y, segment.start.x - center.x);
	const aa = direction.x ** 2 + direction.y ** 2;
	const q = { x: origin.x - center.x, y: origin.y - center.y };
	const bb = 2 * (q.x * direction.x + q.y * direction.y);
	const cc = q.x ** 2 + q.y ** 2 - radius ** 2;
	const disc = bb ** 2 - 4 * aa * cc;
	if (disc < -EPS)
		return;
	for (const t of [(-bb - Math.sqrt(Math.max(0, disc))) / (2 * aa), (-bb + Math.sqrt(Math.max(0, disc))) / (2 * aa)]) {
		if (t < -EPS || t > 1 + EPS)
			continue;
		const clamped = Math.max(0, Math.min(1, t));
		const p = { x: origin.x + clamped * direction.x, y: origin.y + clamped * direction.y };
		if (angleOnArc(Math.atan2(p.y - center.y, p.x - center.x), startAngle, segment.sweepDegrees! * Math.PI / 180))
			events.push(clamped);
	}
}

function addCapsuleEvents(events: number[], origin: Point, direction: Point, segment: Segment, radius: number): void {
	if (segment.kind === 'line') {
		const dx = segment.end.x - segment.start.x;
		const dy = segment.end.y - segment.start.y;
		const length = Math.hypot(dx, dy);
		const normal = { x: -dy / length, y: dx / length };
		for (const side of [-radius, radius]) {
			const denominator = normal.x * direction.x + normal.y * direction.y;
			if (Math.abs(denominator) > EPS) {
				const t = (side - normal.x * (origin.x - segment.start.x) - normal.y * (origin.y - segment.start.y)) / denominator;
				if (t >= -EPS && t <= 1 + EPS) {
					const p = { x: origin.x + t * direction.x, y: origin.y + t * direction.y };
					const along = (p.x - segment.start.x) * (dx / length) + (p.y - segment.start.y) * (dy / length);
					if (along >= -EPS && along <= length + EPS)
						events.push(Math.max(0, Math.min(1, t)));
				}
			}
		}
		addCircleRoots(events, origin, direction, segment.start, radius);
		addCircleRoots(events, origin, direction, segment.end, radius);
		return;
	}
	const { center, radius: arcRadius } = arcCenter(segment);
	for (const boundaryRadius of [arcRadius - radius, arcRadius + radius]) {
		if (boundaryRadius > EPS) {
			const before = events.length;
			addCircleRoots(events, origin, direction, center, boundaryRadius);
			// Extra circle roots outside the finite angular sweep do not change coverage,
			// because every resulting interval is classified by exact distance-to-arc.
			void before;
		}
	}
	addCircleRoots(events, origin, direction, segment.start, radius);
	addCircleRoots(events, origin, direction, segment.end, radius);
	// Split where radial sector sides cross the finite probe.
	const { sweep } = arcCenter(segment);
	const startAngle = Math.atan2(segment.start.y - center.y, segment.start.x - center.x);
	const endAngle = startAngle + sweep;
	for (const angle of [startAngle, endAngle]) {
		const ray = { x: Math.cos(angle), y: Math.sin(angle) };
		const den = direction.x * ray.y - direction.y * ray.x;
		if (Math.abs(den) <= EPS)
			continue;
		const delta = { x: center.x - origin.x, y: center.y - origin.y };
		const t = (delta.x * ray.y - delta.y * ray.x) / den;
		const u = (delta.x * direction.y - delta.y * direction.x) / den;
		if (t >= -EPS && t <= 1 + EPS && u >= arcRadius - radius - EPS && u <= arcRadius + radius + EPS)
			events.push(Math.max(0, Math.min(1, t)));
	}
}

function ringPoints(ring: Ring): Point[] {
	return flattenSegments(ring.segments);
}

export interface CopperCrossSection { id: string; start: Point; end: Point }

export function analyzeCopperShape(input: {
	filledPaths: Array<{ id: string; path: unknown; fill: boolean; lineWidth: number }>;
	fineness: number;
	crossSections?: CopperCrossSection[];
}) {
	if (!finite(input.fineness) || input.fineness < 0)
		throw new Error('fineness 必须为非负有限数值');
	const filled = input.filledPaths.filter(item => item.fill);
	if (!filled.length)
		throw new Error('没有可分析的实心填充');
	const regions = filled.map((item) => {
		if (!finite(item.lineWidth) || item.lineWidth !== 0)
			throw new Error(`实心区域 ${item.id} 线宽需为零，才能套用标定`);
		const rings = parseCopperPath(item.path);
		if (rings.some(ring => !ring.closed))
			throw new Error(`实心区域 ${item.id} 含未闭合轮廓`);
		const points = rings.map(ringPoints);
		for (let i = 1; i < points.length; i++) {
			if (!pointInRing(points[i][0], rings[0]))
				throw new Error(`区域 ${item.id} 的内环不在外环内，孔洞拓扑无法确认`);
		}
		for (let i = 0; i < points.length; i++) {
			for (let j = i + 1; j < points.length; j++) {
				if (polylinesIntersect(points[i], points[j]))
					throw new Error(`区域 ${item.id} 的轮廓相交或接触，孔洞拓扑无法确认`);
			}
		}
		const area = rings.reduce((sum, ring, index) => {
			const depth = rings.reduce((count, other, otherIndex) => count + (index !== otherIndex && pointInRing(points[index][0], other) ? 1 : 0), 0);
			return sum + (depth % 2 === 0 ? 1 : -1) * Math.abs(ring.signedAreaMil2);
		}, 0);
		if (area <= 0)
			throw new Error(`区域 ${item.id} 的净面积非正数`);
		const flatnessToleranceMil = FLATNESS_MIL;
		const areaErrorBoundMil2 = rings.reduce((sum, ring) => sum + perimeter(ring) * flatnessToleranceMil + Math.PI * flatnessToleranceMil ** 2, 0);
		const sharpCornerCandidates = rings.slice(0, 1).flatMap((ring) => {
			const results: Array<{ at: Point; interiorAngleDegrees: number }> = [];
			const orientation = Math.sign(ring.signedAreaMil2) || 1;
			for (let i = 0; i < ring.segments.length; i++) {
				const previous = ring.segments[(i + ring.segments.length - 1) % ring.segments.length];
				const current = ring.segments[i];
				if (previous.kind !== 'line' || current.kind !== 'line' || !close(previous.end, current.start))
					continue;
				const incoming = { x: current.start.x - previous.start.x, y: current.start.y - previous.start.y };
				const outgoing = { x: current.end.x - current.start.x, y: current.end.y - current.start.y };
				const turn = Math.atan2(incoming.x * outgoing.y - incoming.y * outgoing.x, incoming.x * outgoing.x + incoming.y * outgoing.y) * 180 / Math.PI;
				const interiorAngleDegrees = 180 - orientation * turn;
				if (interiorAngleDegrees < 45 - 1e-9)
					results.push({ at: current.start, interiorAngleDegrees });
			}
			return results;
		});
		return { id: item.id, rings, areaMil2: area, areaErrorBoundMil2, flatnessToleranceMil, sharpCornerCandidates, bbox: rings[0].boundsMil };
	});
	const openStrokes = input.filledPaths.filter(item => !item.fill).map((item) => {
		if (!finite(item.lineWidth) || item.lineWidth <= 0)
			throw new Error(`开放铜线 ${item.id} 缺少正线宽`);
		const rings = parseCopperPath(item.path);
		if (rings.some(ring => ring.closed))
			throw new Error(`开放铜线 ${item.id} 意外形成闭合轮廓`);
		return { id: item.id, lineWidthMil: item.lineWidth * SCALE_TO_MIL, segments: rings.flatMap(r => r.segments) };
	});
	const cuts = (input.crossSections ?? []).map((cut) => {
		if (!cut.id || ![cut.start?.x, cut.start?.y, cut.end?.x, cut.end?.y].every(finite) || close(cut.start, cut.end))
			throw new Error(`截面 ${cut.id || '(未命名)'} 坐标无效`);
		const a = cut.start;
		const b = cut.end;
		const direction = { x: b.x - a.x, y: b.y - a.y };
		const length = Math.hypot(direction.x, direction.y);
		const events = [0, 1];
		const contourSegments = regions.flatMap(region => region.rings.flatMap(ring => ring.segments));
		for (const segment of contourSegments) {
			if (segment.kind === 'line')
				addLineIntersection(events, a, direction, segment.start, segment.end);
			else addArcIntersection(events, a, direction, segment);
			addCapsuleEvents(events, a, direction, segment, input.fineness / 2);
		}
		for (const stroke of openStrokes) {
			for (const segment of stroke.segments) addCapsuleEvents(events, a, direction, segment, stroke.lineWidthMil / 2);
		}
		events.sort((x, y) => x - y);
		const split = events.filter((t, index) => index === 0 || t - events[index - 1] > 1e-9);
		const hasCopper = (p: Point) => {
			const core = regions.some((region) => {
				let inside = false;
				for (const ring of region.rings) {
					if (pointInRing(p, ring))
						inside = !inside;
				}
				return inside;
			});
			return core || contourSegments.some(segment => pointSegmentLikeDistance(p, segment) <= input.fineness / 2 + EPS)
				|| openStrokes.some(stroke => stroke.segments.some(segment => pointSegmentLikeDistance(p, segment) <= stroke.lineWidthMil / 2 + EPS));
		};
		const intervals: Array<[number, number]> = [];
		for (let i = 0; i + 1 < split.length; i++) {
			const lo = split[i];
			const hi = split[i + 1];
			if (hi - lo <= 1e-9)
				continue;
			const mid = (lo + hi) / 2;
			if (!hasCopper({ x: a.x + direction.x * mid, y: a.y + direction.y * mid }))
				continue;
			const last = intervals.at(-1);
			if (last && Math.abs(last[1] - lo) <= 1e-9)
				last[1] = hi;
			else intervals.push([lo, hi]);
		}
		const spans = intervals.map(([lo, hi]) => (hi - lo) * length);
		return { id: cut.id, copperSpansMil: spans, eventIntervalCount: split.length - 1, finenessEdgeAllowanceMilPerSide: input.fineness / 2, method: 'finite line/arc intersections plus exact line-segment and finite-arc stroke distance intervals', interpretation: '只测用户指定截面；不代表整区最窄铜颈' };
	});
	return {
		unitEvidence: { coordinateUnit: 'mil', conversionFactor: SCALE_TO_MIL, basis: 'CP66 ACE_CP66_COPPER_VALIDATION_20261118 fresh SDK fill path matched segment-by-segment against same-copy native top copper Gerber; arc angles remain degrees', universalHostGuarantee: false },
		regions: regions.map(region => ({ id: region.id, rings: region.rings.map(r => ({ closed: r.closed, signedContourAreaMil2: r.signedAreaMil2, boundsMil: r.boundsMil, segmentCount: r.segments.length, arcCount: r.segments.filter(s => s.kind === 'arc').length })), netContourAreaMil2: region.areaMil2, areaErrorBoundMil2: region.areaErrorBoundMil2, arcFlatteningToleranceMil: region.flatnessToleranceMil, sharpCornerCandidates: region.sharpCornerCandidates, boundsMil: region.bbox })),
		openStrokes,
		crossSections: cuts,
		coverage: { entireRegionMinimumNeckVerified: false, electricalConnectivity: 'unknown', islands: 'unknown', unsupported: [] as string[], holesInterpreted: 'nested paths inside one fill are treated as holes only when contained by the first ring' },
	};
}
