import type { TuneContact } from './lengthTuneTargets';
import { curveBounds, type Point as CurvePoint, type CurvePrimitive } from './arcTuneGeometry';

export type BranchCapsuleContact = {
	id: string;
	net: string;
	layers: number[] | null;
	kind: 'capsule';
	center: CurvePoint;
	width: number;
	height: number;
	rotation: number;
};
export type BranchArcContact = {
	id: string;
	net: string;
	layers: number[] | null;
	kind: 'arc';
	curve: Extract<CurvePrimitive, { type: 'arc' }>;
	width: number;
};
export type BranchContact = TuneContact | BranchCapsuleContact | BranchArcContact;
export type BranchDistanceInterval = [number, number];

const EPS = 1e-9;
const ANGLE_EPS = 1e-10;
const add = (a: CurvePoint, b: CurvePoint): CurvePoint => [a[0] + b[0], a[1] + b[1]];
const sub = (a: CurvePoint, b: CurvePoint): CurvePoint => [a[0] - b[0], a[1] - b[1]];
const scale = (a: CurvePoint, k: number): CurvePoint => [a[0] * k, a[1] * k];
const dot = (a: CurvePoint, b: CurvePoint): number => a[0] * b[0] + a[1] * b[1];
const cross = (a: CurvePoint, b: CurvePoint): number => a[0] * b[1] - a[1] * b[0];
const length = (a: CurvePoint): number => Math.hypot(a[0], a[1]);
const distance = (a: CurvePoint, b: CurvePoint): number => length(sub(a, b));

function pointSegmentDistance(point: CurvePoint, a: CurvePoint, b: CurvePoint): number {
	const vector = sub(b, a);
	const squared = dot(vector, vector);
	if (!squared)
		return distance(point, a);
	const t = Math.max(0, Math.min(1, dot(sub(point, a), vector) / squared));
	return distance(point, add(a, scale(vector, t)));
}

function onSweep(angle: number, start: number, sweepDegrees: number): boolean {
	const tau = 2 * Math.PI;
	const mod = (value: number) => ((value % tau) + tau) % tau;
	const sweep = sweepDegrees * Math.PI / 180;
	return sweep >= 0 ? mod(angle - start) <= sweep + ANGLE_EPS : mod(start - angle) <= -sweep + ANGLE_EPS;
}

function pointArcDistance(point: CurvePoint, curve: Extract<CurvePrimitive, { type: 'arc' }>): number {
	const relative = sub(point, curve.center);
	const angle = Math.atan2(relative[1], relative[0]);
	if (onSweep(angle, Math.atan2(curve.a[1] - curve.center[1], curve.a[0] - curve.center[0]), curve.sweepDegrees))
		return Math.abs(length(relative) - curve.radius);
	return Math.min(distance(point, curve.a), distance(point, curve.b));
}

function segmentSegmentDistance(a: CurvePoint, b: CurvePoint, c: CurvePoint, d: CurvePoint): number {
	const ab = sub(b, a);
	const cd = sub(d, c);
	const ac = sub(c, a);
	const den = cross(ab, cd);
	if (Math.abs(den) > EPS) {
		const t = cross(ac, cd) / den;
		const u = cross(ac, ab) / den;
		if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS)
			return 0;
	}
	else if (Math.abs(cross(ac, ab)) <= EPS && [a, b, c, d].every(p => Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
		const denominator = dot(ab, ab);
		if (denominator > 0) {
			const tc = dot(sub(c, a), ab) / denominator;
			const td = dot(sub(d, a), ab) / denominator;
			if (Math.max(Math.min(tc, td), 0) <= Math.min(Math.max(tc, td), 1) + EPS)
				return 0;
		}
	}
	return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

function capsuleAxis(contact: BranchCapsuleContact): [CurvePoint, CurvePoint, number] {
	const majorIsHorizontal = contact.width >= contact.height;
	const halfAxis = Math.abs(contact.width - contact.height) / 2;
	const angle = (contact.rotation + (majorIsHorizontal ? 0 : 90)) * Math.PI / 180;
	const unit: CurvePoint = [Math.cos(angle), Math.sin(angle)];
	return [sub(contact.center, scale(unit, halfAxis)), add(contact.center, scale(unit, halfAxis)), Math.min(contact.width, contact.height) / 2];
}

function pointCapsuleDistance(point: CurvePoint, contact: BranchCapsuleContact): number {
	const [a, b, radius] = capsuleAxis(contact);
	return Math.max(0, pointSegmentDistance(point, a, b) - radius);
}

function segmentArcDistance(a: CurvePoint, b: CurvePoint, curve: Extract<CurvePrimitive, { type: 'arc' }>): number {
	const vector = sub(b, a);
	const squared = dot(vector, vector);
	const candidates = [pointArcDistance(a, curve), pointArcDistance(b, curve), pointSegmentDistance(curve.a, a, b), pointSegmentDistance(curve.b, a, b)];
	if (!squared)
		return candidates[0];
	const t = Math.max(0, Math.min(1, dot(sub(curve.center, a), vector) / squared));
	const perpendicular = add(a, scale(vector, t));
	const relative = sub(perpendicular, curve.center);
	const angle = Math.atan2(relative[1], relative[0]);
	const start = Math.atan2(curve.a[1] - curve.center[1], curve.a[0] - curve.center[0]);
	if (onSweep(angle, start, curve.sweepDegrees))
		candidates.push(Math.abs(length(relative) - curve.radius));
	// A segment/circle crossing on the signed sweep has exactly zero centerline gap.
	if (circleIntersectionParameters(a, b, curve.center, curve.radius).some(u => {
		const p = add(a, scale(vector, u));
		const theta = Math.atan2(p[1] - curve.center[1], p[0] - curve.center[0]);
		return onSweep(theta, start, curve.sweepDegrees);
	}))
		return 0;
	return Math.min(...candidates);
}

export function branchPointContactDistance(point: CurvePoint, contact: BranchContact): number {
	if (contact.kind === 'capsule')
		return pointCapsuleDistance(point, contact);
	if (contact.kind === 'arc')
		return Math.max(0, pointArcDistance(point, contact.curve) - contact.width / 2);
	if (contact.kind === 'circle')
		return Math.max(0, distance(point, contact.center) - contact.radius);
	if (contact.kind === 'rect') {
		const angle = -contact.rotation * Math.PI / 180;
		const dx = point[0] - contact.center[0];
		const dy = point[1] - contact.center[1];
		const x = dx * Math.cos(angle) - dy * Math.sin(angle);
		const y = dx * Math.sin(angle) + dy * Math.cos(angle);
		return Math.hypot(Math.max(Math.abs(x) - contact.width / 2, 0), Math.max(Math.abs(y) - contact.height / 2, 0));
	}
	return Infinity;
}

export function branchSegmentContactDistance(a: CurvePoint, b: CurvePoint, contact: BranchContact): number {
	if (contact.kind === 'capsule') {
		const [c, d, radius] = capsuleAxis(contact);
		return Math.max(0, segmentSegmentDistance(a, b, c, d) - radius);
	}
	if (contact.kind === 'arc')
		return Math.max(0, segmentArcDistance(a, b, contact.curve) - contact.width / 2);
	if (contact.kind === 'circle')
		return Math.max(0, pointSegmentDistance(contact.center, a, b) - contact.radius);
	if (contact.kind === 'rect') {
		const angle = -contact.rotation * Math.PI / 180;
		const transform = (p: CurvePoint): CurvePoint => {
			const x = p[0] - contact.center[0];
			const y = p[1] - contact.center[1];
			return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)];
		};
		const p = transform(a);
		const q = transform(b);
		if ([p, q].some(x => Math.abs(x[0]) <= contact.width / 2 && Math.abs(x[1]) <= contact.height / 2))
			return 0;
		const corners: CurvePoint[] = [[-contact.width / 2, -contact.height / 2], [contact.width / 2, -contact.height / 2], [contact.width / 2, contact.height / 2], [-contact.width / 2, contact.height / 2]];
		return Math.min(...corners.map((corner, i) => segmentSegmentDistance(p, q, corner, corners[(i + 1) % corners.length])));
	}
	return Infinity;
}

function circleIntersectionParameters(a: CurvePoint, b: CurvePoint, center: CurvePoint, radius: number): number[] {
	const v = sub(b, a);
	const f = sub(a, center);
	const segmentLength = length(v);
	if (!segmentLength)
		return [];
	const unit = scale(v, 1 / segmentLength);
	const along = dot(sub(center, a), unit);
	const perpendicular = cross(unit, sub(center, a));
	let radialSquared = radius * radius - perpendicular * perpendicular;
	const localTolerance = 64 * Number.EPSILON * Math.max(radius * radius, perpendicular * perpendicular, Number.MIN_VALUE);
	if (radialSquared < -localTolerance)
		return [];
	if (radialSquared < 0)
		radialSquared = 0;
	const halfChord = Math.sqrt(radialSquared);
	return [(along - halfChord) / segmentLength, (along + halfChord) / segmentLength]
		.filter(t => t >= -EPS && t <= 1 + EPS).map(t => Math.max(0, Math.min(1, t)));
}

function lineIntersectionParameter(a: CurvePoint, b: CurvePoint, c: CurvePoint, d: CurvePoint): number[] {
	const route = sub(b, a);
	const edge = sub(d, c);
	const denom = cross(route, edge);
	const offset = sub(c, a);
	if (Math.abs(denom) <= EPS) {
		if (Math.abs(cross(offset, route)) > EPS || dot(route, route) <= EPS)
			return [];
		const squared = dot(route, route);
		return [dot(sub(c, a), route) / squared, dot(sub(d, a), route) / squared].filter(t => t >= -EPS && t <= 1 + EPS).map(t => Math.max(0, Math.min(1, t)));
	}
	const t = cross(offset, edge) / denom;
	const u = cross(offset, route) / denom;
	return t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS ? [Math.max(0, Math.min(1, t))] : [];
}

function addCircleBoundaryEvents(events: number[], a: CurvePoint, b: CurvePoint, center: CurvePoint, radius: number): void {
	if (radius < 0)
		return;
	events.push(...circleIntersectionParameters(a, b, center, radius));
}

function capsuleBoundaryEvents(events: number[], a: CurvePoint, b: CurvePoint, contact: BranchCapsuleContact, limit: number): void {
	const [axisA, axisB, radius] = capsuleAxis(contact);
	const axis = sub(axisB, axisA);
	const axisLength = length(axis);
	addCircleBoundaryEvents(events, a, b, axisA, radius + limit);
	if (axisLength > EPS)
		addCircleBoundaryEvents(events, a, b, axisB, radius + limit);
	if (axisLength <= EPS)
		return;
	const unit = scale(axis, 1 / axisLength);
	const normal: CurvePoint = [-unit[1], unit[0]];
	const route = sub(b, a);
	const denominator = dot(normal, route);
	if (Math.abs(denominator) <= EPS)
		return;
	for (const side of [-1, 1]) {
		const t = (side * (radius + limit) - dot(normal, sub(a, axisA))) / denominator;
		if (t < -EPS || t > 1 + EPS)
			continue;
		const p = add(a, scale(route, t));
		const along = dot(sub(p, axisA), unit);
		if (along >= -EPS && along <= axisLength + EPS)
			events.push(Math.max(0, Math.min(1, t)));
	}
}

function arcBoundaryEvents(events: number[], a: CurvePoint, b: CurvePoint, contact: BranchArcContact, limit: number): void {
	const curve = contact.curve;
	const outer = curve.radius + contact.width / 2 + limit;
	const inner = curve.radius - contact.width / 2 - limit;
	addCircleBoundaryEvents(events, a, b, curve.center, outer);
	if (inner > EPS)
		addCircleBoundaryEvents(events, a, b, curve.center, inner);
	const startAngle = Math.atan2(curve.a[1] - curve.center[1], curve.a[0] - curve.center[0]);
	const endAngle = startAngle + curve.sweepDegrees * Math.PI / 180;
	for (const angle of [startAngle, endAngle]) {
		const unit: CurvePoint = [Math.cos(angle), Math.sin(angle)];
		const c = add(curve.center, scale(unit, Math.max(0, inner)));
		const d = add(curve.center, scale(unit, outer));
		events.push(...lineIntersectionParameter(a, b, c, d));
	}
	addCircleBoundaryEvents(events, a, b, curve.a, contact.width / 2 + limit);
	addCircleBoundaryEvents(events, a, b, curve.b, contact.width / 2 + limit);
}

function mergeIntervals(intervals: BranchDistanceInterval[]): BranchDistanceInterval[] {
	intervals.sort((a, b) => a[0] - b[0]);
	const merged: BranchDistanceInterval[] = [];
	for (const interval of intervals) {
		const last = merged.at(-1);
		if (last && interval[0] <= last[1] + EPS)
			last[1] = Math.max(last[1], interval[1]);
		else
			merged.push([...interval]);
	}
	return merged;
}

/** Return every connected interval on a straight path segment within a capsule/arc clearance envelope. */
export function branchSegmentContactIntervals(a: CurvePoint, b: CurvePoint, contact: BranchCapsuleContact | BranchArcContact, limit: number, checkBudget?: () => void): BranchDistanceInterval[] {
	if (!Number.isFinite(limit) || limit < 0)
		throw new Error('分支接触距离阈值必须为有限非负数');
	const segmentLength = distance(a, b);
	if (segmentLength <= EPS)
		return branchPointContactDistance(a, contact) <= limit + EPS ? [[0, 0]] : [];
	const events = [0, 1];
	if (contact.kind === 'capsule')
		capsuleBoundaryEvents(events, a, b, contact, limit);
	else
		arcBoundaryEvents(events, a, b, contact, limit);
	events.sort((x, y) => x - y);
	const cuts: number[] = [];
	for (const t of events) {
		const previous = cuts.at(-1);
		// Keep every distinct representable event. A tolerance in normalized t
		// grows with segment length and can erase a real, short contact interval.
		if (previous === undefined || t !== previous)
			cuts.push(t);
	}
	const at = (t: number): CurvePoint => add(a, scale(sub(b, a), t));
	const inside = (t: number) => branchPointContactDistance(at(t), contact) <= limit + EPS;
	const pieces: BranchDistanceInterval[] = [];
	for (let i = 0; i + 1 < cuts.length; i++) {
		checkBudget?.();
		const left = cuts[i];
		const right = cuts[i + 1];
		if (inside((left + right) / 2))
			pieces.push([left * segmentLength, right * segmentLength]);
	}
	for (const t of cuts) {
		checkBudget?.();
		if (inside(t) && !pieces.some(([lo, hi]) => t * segmentLength >= lo - EPS && t * segmentLength <= hi + EPS))
			pieces.push([t * segmentLength, t * segmentLength]);
	}
	return mergeIntervals(pieces);
}

export function branchPathContactIntervals(path: CurvePoint[], contact: BranchCapsuleContact | BranchArcContact, limit: number, checkBudget?: () => void): BranchDistanceInterval[] {
	const intervals: BranchDistanceInterval[] = [];
	let offset = 0;
	for (let i = 0; i + 1 < path.length; i++) {
		checkBudget?.();
		const a = path[i];
		const b = path[i + 1];
		for (const [start, end] of branchSegmentContactIntervals(a, b, contact, limit, checkBudget))
			intervals.push([offset + start, offset + end]);
		offset += distance(a, b);
	}
	return mergeIntervals(intervals);
}

export function branchContactBounds(contact: BranchArcContact): { xMin: number; yMin: number; xMax: number; yMax: number } {
	const bounds = curveBounds(contact.curve);
	const margin = contact.width / 2;
	return { xMin: bounds.xMin - margin, xMax: bounds.xMax + margin, yMin: bounds.yMin - margin, yMax: bounds.yMax + margin };
}
