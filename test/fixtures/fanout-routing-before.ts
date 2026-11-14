// Differential baseline copied from ../../../../fanout-mcu-20261011/129-before/fanout-routing.ts.
// The source file SHA-256 is 7B0B1C1821B173873FFC819A7BC9BDC2F739B3AE1BCC0E9190F55CF48B6F2F0E.
// The source carried no author header; its original implementation is retained below without edits.
export interface Point {
	x: number;
	y: number;
}

interface ObstacleBase {
	net: string;
	trackCollision?: boolean;
}

export interface CircleObstacle extends ObstacleBase {
	type: 'circle';
	center: Point;
	radius: number;
}

export interface SegmentObstacle extends ObstacleBase {
	type: 'segment';
	start: Point;
	end: Point;
	radius: number;
}

export interface PolygonObstacle extends ObstacleBase {
	type: 'polygon';
	points: Point[];
	margin?: number;
	bounds?: Bounds;
}

export type CopperObstacle = CircleObstacle | SegmentObstacle | PolygonObstacle;

export interface RouteRequest {
	start: Point;
	desiredEnd: Point;
	net: string;
	lineWidth: number;
	viaDiameter: number;
	clearance: number;
	maxEndOffset: number;
	obstacles: CopperObstacle[];
	boardPolygons?: Point[][];
	keepoutPolygons?: Point[][];
	checkBudget?: () => void;
	maxCandidates?: number;
	timeLimitMs?: number;
}

export interface RouteResult {
	points: Point[];
	endOffset: number;
	length: number;
}

export interface DetailedRouteResult {
	route: RouteResult | null;
	checkedCandidates: number;
	searchLimited: boolean;
	terminationReason: 'route-found' | 'candidate-limit' | 'candidate-search-exhausted';
}

const DIRECTIONS: Point[] = [
	{ x: 1, y: 0 },
	{ x: Math.SQRT1_2, y: Math.SQRT1_2 },
	{ x: 0, y: 1 },
	{ x: -Math.SQRT1_2, y: Math.SQRT1_2 },
	{ x: -1, y: 0 },
	{ x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
	{ x: 0, y: -1 },
	{ x: Math.SQRT1_2, y: -Math.SQRT1_2 },
];

const EPSILON = 1e-6;
const SEARCH_TIME_LIMIT = Symbol('fanout search time limit');

export interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normalizeDirection(direction: Point): Point {
	const length = Math.hypot(direction.x, direction.y);
	return length <= EPSILON ? { x: 0, y: 0 } : { x: direction.x / length, y: direction.y / length };
}

export function pointAtDistance(start: Point, direction: Point, length: number): Point {
	const unit = normalizeDirection(direction);
	return { x: start.x + unit.x * length, y: start.y + unit.y * length };
}

function dot(a: Point, b: Point): number {
	return a.x * b.x + a.y * b.y;
}

function subtract(a: Point, b: Point): Point {
	return { x: a.x - b.x, y: a.y - b.y };
}

function pointSegmentDistance(point: Point, start: Point, end: Point): number {
	const line = subtract(end, start);
	const lengthSquared = dot(line, line);
	if (lengthSquared <= EPSILON)
		return distance(point, start);
	const t = Math.max(0, Math.min(1, dot(subtract(point, start), line) / lengthSquared));
	return distance(point, { x: start.x + line.x * t, y: start.y + line.y * t });
}

function orientation(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
	const o1 = orientation(a, b, c);
	const o2 = orientation(a, b, d);
	const o3 = orientation(c, d, a);
	const o4 = orientation(c, d, b);
	return ((o1 > EPSILON && o2 < -EPSILON) || (o1 < -EPSILON && o2 > EPSILON))
		&& ((o3 > EPSILON && o4 < -EPSILON) || (o3 < -EPSILON && o4 > EPSILON));
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
	if (segmentsIntersect(a, b, c, d))
		return 0;
	return Math.min(
		pointSegmentDistance(a, c, d),
		pointSegmentDistance(b, c, d),
		pointSegmentDistance(c, a, b),
		pointSegmentDistance(d, a, b),
	);
}

function pointInPolygon(point: Point, polygon: Point[], checkBudget?: () => void): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		checkBudget?.();
		const a = polygon[i];
		const b = polygon[j];
		if (((a.y > point.y) !== (b.y > point.y))
			&& point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) {
			inside = !inside;
		}
	}
	return inside;
}

function polygonBounds(polygon: Point[]): Bounds {
	return polygon.reduce<Bounds>((bounds, point) => ({
		minX: Math.min(bounds.minX, point.x),
		minY: Math.min(bounds.minY, point.y),
		maxX: Math.max(bounds.maxX, point.x),
		maxY: Math.max(bounds.maxY, point.y),
	}), {
		minX: Number.POSITIVE_INFINITY,
		minY: Number.POSITIVE_INFINITY,
		maxX: Number.NEGATIVE_INFINITY,
		maxY: Number.NEGATIVE_INFINITY,
	});
}

function getPolygonBounds(obstacle: PolygonObstacle): Bounds {
	if (!obstacle.bounds)
		obstacle.bounds = polygonBounds(obstacle.points);
	return obstacle.bounds;
}

function segmentBounds(start: Point, end: Point, margin: number): Bounds {
	return {
		minX: Math.min(start.x, end.x) - margin,
		minY: Math.min(start.y, end.y) - margin,
		maxX: Math.max(start.x, end.x) + margin,
		maxY: Math.max(start.y, end.y) + margin,
	};
}

function circleBounds(center: Point, radius: number): Bounds {
	return {
		minX: center.x - radius,
		minY: center.y - radius,
		maxX: center.x + radius,
		maxY: center.y + radius,
	};
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
	return a.minX <= b.maxX + EPSILON
		&& a.maxX + EPSILON >= b.minX
		&& a.minY <= b.maxY + EPSILON
		&& a.maxY + EPSILON >= b.minY;
}

function segmentHitsPolygon(start: Point, end: Point, polygon: Point[], margin: number, checkBudget?: () => void): boolean {
	if (polygon.length < 3)
		return false;
	if (!boundsOverlap(segmentBounds(start, end, margin), polygonBounds(polygon)))
		return false;
	if (pointInPolygon(start, polygon, checkBudget) || pointInPolygon(end, polygon, checkBudget))
		return true;
	for (let i = 0; i < polygon.length; i++) {
		checkBudget?.();
		if (segmentDistance(start, end, polygon[i], polygon[(i + 1) % polygon.length]) <= margin + EPSILON)
			return true;
	}
	return false;
}

function circleHitsPolygon(center: Point, radius: number, polygon: Point[], checkBudget?: () => void): boolean {
	if (polygon.length < 3)
		return false;
	if (!boundsOverlap(circleBounds(center, radius), polygonBounds(polygon)))
		return false;
	if (pointInPolygon(center, polygon, checkBudget))
		return true;
	for (let i = 0; i < polygon.length; i++) {
		checkBudget?.();
		if (pointSegmentDistance(center, polygon[i], polygon[(i + 1) % polygon.length]) <= radius + EPSILON)
			return true;
	}
	return false;
}

function pointDistanceToPolygonEdges(point: Point, polygon: Point[], checkBudget?: () => void): number {
	if (polygon.length < 2)
		return Number.POSITIVE_INFINITY;
	let minimum = Number.POSITIVE_INFINITY;
	for (let i = 0; i < polygon.length; i++) {
		checkBudget?.();
		minimum = Math.min(minimum, pointSegmentDistance(point, polygon[i], polygon[(i + 1) % polygon.length]));
	}
	return minimum;
}

function segmentIntersectsPolygonEdges(start: Point, end: Point, polygon: Point[], checkBudget?: () => void): boolean {
	for (let i = 0; i < polygon.length; i++) {
		checkBudget?.();
		if (segmentsIntersect(start, end, polygon[i], polygon[(i + 1) % polygon.length]))
			return true;
	}
	return false;
}

function pointIsInsideAnyBoard(point: Point, radius: number, boardPolygons?: Point[][], checkBudget?: () => void): boolean {
	if (!boardPolygons || boardPolygons.length === 0)
		return true;
	return boardPolygons.some((polygon) => {
		checkBudget?.();
		return pointInPolygon(point, polygon, checkBudget) && pointDistanceToPolygonEdges(point, polygon, checkBudget) + EPSILON >= radius;
	});
}

function segmentIsInsideAnyBoard(start: Point, end: Point, margin: number, boardPolygons?: Point[][], checkBudget?: () => void): boolean {
	if (!boardPolygons || boardPolygons.length === 0)
		return true;
	const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
	return boardPolygons.some((polygon) => {
		checkBudget?.();
		if (!pointInPolygon(start, polygon, checkBudget) || !pointInPolygon(end, polygon, checkBudget) || !pointInPolygon(midpoint, polygon, checkBudget) || segmentIntersectsPolygonEdges(start, end, polygon, checkBudget))
			return false;
		let minimum = Number.POSITIVE_INFINITY;
		for (let i = 0; i < polygon.length; i++) {
			checkBudget?.();
			minimum = Math.min(minimum, segmentDistance(start, end, polygon[i], polygon[(i + 1) % polygon.length]));
		}
		return minimum + EPSILON >= margin;
	});
}

function pointAvoidsKeepouts(point: Point, radius: number, keepoutPolygons?: Point[][], checkBudget?: () => void): boolean {
	if (!keepoutPolygons || keepoutPolygons.length === 0)
		return true;
	return !keepoutPolygons.some((polygon) => {
		checkBudget?.();
		return pointInPolygon(point, polygon, checkBudget) || pointDistanceToPolygonEdges(point, polygon, checkBudget) <= radius + EPSILON;
	});
}

function segmentAvoidsKeepouts(start: Point, end: Point, margin: number, keepoutPolygons?: Point[][], checkBudget?: () => void): boolean {
	if (!keepoutPolygons || keepoutPolygons.length === 0)
		return true;
	return !keepoutPolygons.some((polygon) => {
		checkBudget?.();
		return segmentHitsPolygon(start, end, polygon, margin, checkBudget);
	});
}

function isRelevant(obstacle: CopperObstacle, net: string): boolean {
	return net.length === 0 || obstacle.net !== net;
}

function segmentIsClear(start: Point, end: Point, request: RouteRequest): boolean {
	const routeRadius = request.lineWidth / 2;
	if (!segmentIsInsideAnyBoard(start, end, routeRadius + request.clearance, request.boardPolygons, request.checkBudget))
		return false;
	if (!segmentAvoidsKeepouts(start, end, routeRadius + request.clearance, request.keepoutPolygons, request.checkBudget))
		return false;
	for (const obstacle of request.obstacles) {
		request.checkBudget?.();
		if (!isRelevant(obstacle, request.net))
			continue;
		if (obstacle.trackCollision === false)
			continue;
		if (obstacle.type === 'circle') {
			if (pointSegmentDistance(obstacle.center, start, end) <= routeRadius + obstacle.radius + request.clearance)
				return false;
		}
		else if (obstacle.type === 'segment') {
			if (segmentDistance(start, end, obstacle.start, obstacle.end) <= routeRadius + obstacle.radius + request.clearance)
				return false;
		}
		else if (
			boundsOverlap(segmentBounds(start, end, routeRadius + (obstacle.margin ?? 0) + request.clearance), getPolygonBounds(obstacle))
			&& segmentHitsPolygon(start, end, obstacle.points, routeRadius + (obstacle.margin ?? 0) + request.clearance, request.checkBudget)
		) {
			return false;
		}
	}
	return true;
}

const COLLINEAR_POINT_TOLERANCE = 1e-6;

export function normalizeRoute(points: Point[], request: RouteRequest): { points: Point[]; safeToExecute: boolean } {
	const normalized = [...points];
	let safeToExecute = true;
	let index = 1;
	while (index < normalized.length - 1) {
		request.checkBudget?.();
		const start = normalized[index - 1];
		const bend = normalized[index];
		const end = normalized[index + 1];
		const first = subtract(bend, start);
		const second = subtract(end, bend);
		const direct = subtract(end, start);
		const directLength = Math.hypot(direct.x, direct.y);
		const firstLength = Math.hypot(first.x, first.y);
		const secondLength = Math.hypot(second.x, second.y);
		const projection = directLength > COLLINEAR_POINT_TOLERANCE ? dot(first, direct) / (directLength * directLength) : -1;
		const perpendicularDistance = directLength > COLLINEAR_POINT_TOLERANCE
			? Math.abs(first.x * direct.y - first.y * direct.x) / directLength
			: Number.POSITIVE_INFINITY;
		const liesBetweenForwardEndpoints = projection > 0 && projection < 1 && dot(first, second) > 0;
		if (firstLength <= COLLINEAR_POINT_TOLERANCE
			|| secondLength <= COLLINEAR_POINT_TOLERANCE
			|| perpendicularDistance > COLLINEAR_POINT_TOLERANCE
			|| !liesBetweenForwardEndpoints) {
			index++;
			continue;
		}
		if (!segmentIsClear(start, end, request)) {
			safeToExecute = false;
			index++;
			continue;
		}
		normalized.splice(index, 1);
		if (index > 1)
			index--;
	}
	return { points: normalized, safeToExecute };
}

function viaIsClear(end: Point, request: RouteRequest): boolean {
	const radius = request.viaDiameter / 2;
	if (!pointIsInsideAnyBoard(end, radius + request.clearance, request.boardPolygons, request.checkBudget))
		return false;
	if (!pointAvoidsKeepouts(end, radius + request.clearance, request.keepoutPolygons, request.checkBudget))
		return false;
	for (const obstacle of request.obstacles) {
		request.checkBudget?.();
		if (!isRelevant(obstacle, request.net))
			continue;
		if (obstacle.type === 'circle') {
			if (distance(end, obstacle.center) <= radius + obstacle.radius + request.clearance)
				return false;
		}
		else if (obstacle.type === 'segment') {
			if (pointSegmentDistance(end, obstacle.start, obstacle.end) <= radius + obstacle.radius + request.clearance)
				return false;
		}
		else if (
			boundsOverlap(circleBounds(end, radius + (obstacle.margin ?? 0) + request.clearance), getPolygonBounds(obstacle))
			&& circleHitsPolygon(end, radius + (obstacle.margin ?? 0) + request.clearance, obstacle.points, request.checkBudget)
		) {
			return false;
		}
	}
	return true;
}

function segmentsAreClear(points: Point[], request: RouteRequest, checkSegment: (start: Point, end: Point) => boolean): boolean {
	request.checkBudget?.();
	for (let i = 1; i < points.length; i++) {
		request.checkBudget?.();
		if (!checkSegment(points[i - 1], points[i]))
			return false;
	}
	return true;
}

function pathLength(points: Point[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++)
		total += distance(points[i - 1], points[i]);
	return total;
}

function deduplicatePoints(points: Point[]): Point[] {
	return points.filter((point, index) => index === 0 || distance(point, points[index - 1]) > EPSILON);
}

function rayIntersection(start: Point, startDirection: Point, end: Point, endDirection: Point): Point | null {
	const determinant = startDirection.x * endDirection.y - startDirection.y * endDirection.x;
	if (Math.abs(determinant) <= EPSILON)
		return null;
	const delta = subtract(end, start);
	const t = (delta.x * endDirection.y - delta.y * endDirection.x) / determinant;
	const u = (delta.x * startDirection.y - delta.y * startDirection.x) / determinant;
	if (t <= EPSILON || u >= -EPSILON)
		return null;
	return { x: start.x + startDirection.x * t, y: start.y + startDirection.y * t };
}

function twoSegmentPaths(start: Point, end: Point, checkBudget?: () => void): Point[][] {
	const paths: Point[][] = [];
	for (const firstDirection of DIRECTIONS) {
		checkBudget?.();
		for (const secondDirection of DIRECTIONS) {
			checkBudget?.();
			const bend = rayIntersection(start, firstDirection, end, secondDirection);
			if (bend)
				paths.push([start, bend, end]);
		}
	}
	return paths;
}

function isOctilinear(start: Point, end: Point): boolean {
	const dx = Math.abs(end.x - start.x);
	const dy = Math.abs(end.y - start.y);
	return dx <= EPSILON || dy <= EPSILON || Math.abs(dx - dy) <= EPSILON;
}

function routeCandidates(start: Point, end: Point, step: number, maxOffset: number, checkBudget?: () => void, includeDirect = true): Point[][] {
	const candidates: Point[][] = [];
	checkBudget?.();
	if (includeDirect && isOctilinear(start, end))
		candidates.push([start, end]);
	candidates.push(...twoSegmentPaths(start, end, checkBudget));
	const offsetSteps = Math.max(1, Math.ceil(maxOffset / step));
	for (let i = 1; i <= offsetSteps; i++) {
		checkBudget?.();
		const offset = Math.min(maxOffset, i * maxOffset / offsetSteps);
		for (const direction of DIRECTIONS) {
			checkBudget?.();
			const firstBend = pointAtDistance(start, direction, offset);
			for (const tail of twoSegmentPaths(firstBend, end, checkBudget))
				candidates.push(deduplicatePoints([start, ...tail]));
		}
	}
	return candidates;
}

function endpointRings(desiredEnd: Point, step: number, maxOffset: number, checkBudget?: () => void): Array<{ end: Point; offset: number }> {
	const result = [{ end: desiredEnd, offset: 0 }];
	const ringCount = Math.ceil(maxOffset / step);
	for (let ring = 1; ring <= ringCount; ring++) {
		checkBudget?.();
		const offset = Math.min(maxOffset, ring * maxOffset / ringCount);
		for (const direction of DIRECTIONS) {
			checkBudget?.();
			result.push({ end: pointAtDistance(desiredEnd, direction, offset), offset });
		}
	}
	return result;
}

export function planRouteDetailed(request: RouteRequest): DetailedRouteResult {
	const step = Math.max(request.clearance, request.lineWidth, 1);
	const deadline = request.timeLimitMs == null ? Number.POSITIVE_INFINITY : Date.now() + request.timeLimitMs;
	const maxCandidates = request.maxCandidates ?? Number.POSITIVE_INFINITY;
	let checkedCandidates = 0;
	let bestRoute: RouteResult | null = null;
	const segmentClearCache = new Map<string, boolean>();
	const checkSearchBudget = () => {
		request.checkBudget?.();
		if (Date.now() > deadline)
			throw SEARCH_TIME_LIMIT;
	};
	const searchRequest = { ...request, checkBudget: checkSearchBudget };
	const cachedSegmentIsClear = (start: Point, end: Point): boolean => {
		const key = `${start.x},${start.y}>${end.x},${end.y}`;
		const cached = segmentClearCache.get(key);
		if (cached !== undefined) {
			checkSearchBudget();
			return cached;
		}
		const clear = segmentIsClear(start, end, searchRequest);
		segmentClearCache.set(key, clear);
		return clear;
	};
	try {
		checkSearchBudget();
		for (const endpoint of endpointRings(request.desiredEnd, step, request.maxEndOffset, checkSearchBudget)) {
			let best: RouteResult | null = null;
			bestRoute = null;
			checkSearchBudget();
			if (!viaIsClear(endpoint.end, searchRequest))
				continue;
			const directCandidate = isOctilinear(request.start, endpoint.end);
			const directPoints = directCandidate ? deduplicatePoints([request.start, endpoint.end]) : [];
			const directTested = directPoints.length === 2;
			if (directTested) {
				if (checkedCandidates >= maxCandidates)
					return { route: null, checkedCandidates, searchLimited: true, terminationReason: 'candidate-limit' };
				checkedCandidates++;
				if (segmentsAreClear(directPoints, searchRequest, cachedSegmentIsClear)) {
					return { route: { points: directPoints, endOffset: endpoint.offset, length: pathLength(directPoints) }, checkedCandidates, searchLimited: false, terminationReason: 'route-found' };
				}
			}
			checkSearchBudget();
			if (checkedCandidates >= maxCandidates)
				return { route: best, checkedCandidates, searchLimited: true, terminationReason: 'candidate-limit' };
			for (const candidate of routeCandidates(request.start, endpoint.end, step, request.maxEndOffset, checkSearchBudget, !directTested)) {
				checkSearchBudget();
				if (checkedCandidates >= maxCandidates)
					return { route: best, checkedCandidates, searchLimited: true, terminationReason: 'candidate-limit' };
				const points = deduplicatePoints(candidate);
				if (points.length < 2 || points.length > 4)
					continue;
				checkedCandidates++;
				if (!segmentsAreClear(points, searchRequest, cachedSegmentIsClear))
					continue;
				const route = { points, endOffset: endpoint.offset, length: pathLength(points) };
				if (!best || route.length < best.length || (Math.abs(route.length - best.length) <= EPSILON && route.points.length < best.points.length))
					best = route;
				bestRoute = best;
			}
			if (best)
				return { route: best, checkedCandidates, searchLimited: false, terminationReason: 'route-found' };
		}
	}
	catch (error) {
		if (error === SEARCH_TIME_LIMIT)
			return { route: bestRoute, checkedCandidates, searchLimited: true, terminationReason: 'candidate-limit' };
		throw error;
	}
	return { route: null, checkedCandidates, searchLimited: false, terminationReason: 'candidate-search-exhausted' };
}

export function planRoute(request: RouteRequest): RouteResult | null {
	return planRouteDetailed(request).route;
}
