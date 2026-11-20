export type CopperVertex = { x: number; y: number };
export type CopperPolygonSource = Array<number | 'L'>;

const EPSILON = 1e-9;

function samePoint(a: CopperVertex, b: CopperVertex): boolean {
	return Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
}

function cross(a: CopperVertex, b: CopperVertex, c: CopperVertex): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: CopperVertex, b: CopperVertex, p: CopperVertex): boolean {
	return Math.abs(cross(a, b, p)) <= EPSILON
		&& p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON
		&& p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
}

function segmentsIntersect(a: CopperVertex, b: CopperVertex, c: CopperVertex, d: CopperVertex): boolean {
	const abC = cross(a, b, c);
	const abD = cross(a, b, d);
	const cdA = cross(c, d, a);
	const cdB = cross(c, d, b);
	if (((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
		&& ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON)))
		return true;
	return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/** Validate a simple straight-edge ring and return the SDK's documented L source form. */
export function copperPolygonSource(vertices: unknown): CopperPolygonSource {
	if (!Array.isArray(vertices))
		throw new Error('vertices 必须是由 {x,y} 坐标组成的数组')
	let points: CopperVertex[] = vertices.map((point, index) => {
		if (!point || typeof point !== 'object' || Array.isArray(point))
			throw new Error(`vertices[${index}] 必须是 {x,y} 对象`)
		const { x, y } = point as CopperVertex
		if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y))
			throw new Error(`vertices[${index}] 的 x/y 必须是有限数值`)
		return { x, y }
	})
	if (points.length > 1 && samePoint(points[0], points.at(-1)!))
		points = points.slice(0, -1)
	if (points.length < 3)
		throw new Error('多边形至少需要 3 个不同顶点')
	for (let index = 0; index < points.length; index++) {
		if (samePoint(points[index], points[(index + 1) % points.length]))
			throw new Error(`相邻顶点重复：vertices[${index}]`)
		const previous = points[(index - 1 + points.length) % points.length]
		const current = points[index]
		const next = points[(index + 1) % points.length]
		const incomingX = previous.x - current.x
		const incomingY = previous.y - current.y
		const outgoingX = next.x - current.x
		const outgoingY = next.y - current.y
		if (Math.abs(cross(previous, current, next)) <= EPSILON && incomingX * outgoingX + incomingY * outgoingY > EPSILON)
			throw new Error(`多边形相邻边重叠回折：vertices[${index}]`)
	}
	let twiceArea = 0
	for (let index = 0; index < points.length; index++) {
		const a = points[index]
		const b = points[(index + 1) % points.length]
		twiceArea += a.x * b.y - b.x * a.y
	}
	if (Math.abs(twiceArea) <= EPSILON)
		throw new Error('多边形面积为零或过小')
	for (let first = 0; first < points.length; first++) {
		const firstNext = (first + 1) % points.length
		for (let second = first + 1; second < points.length; second++) {
			const secondNext = (second + 1) % points.length
			if (first === second || firstNext === second || secondNext === first)
				continue
			if (segmentsIntersect(points[first], points[firstNext], points[second], points[secondNext]))
				throw new Error(`多边形轮廓自相交：边 ${first} 与边 ${second}`)
		}
	}
	const first = points[0]
	return [first.x, first.y, 'L', ...points.slice(1).flatMap(point => [point.x, point.y]), first.x, first.y]
}

/** Unwrap the SDK/source-log single-ring wrapper while preserving every source token. */
export function normalizeCopperPolygonSource(raw: unknown): unknown {
	let candidate = raw
	if (Array.isArray(candidate) && candidate.length === 1 && Array.isArray(candidate[0]))
		candidate = candidate[0]
	return candidate
}

export function isSupportedCopperPolygonSource(raw: unknown): boolean {
	const candidate = normalizeCopperPolygonSource(raw)
	if (!Array.isArray(candidate)) return false
	if (candidate[0] === 'R')
		return candidate.length === 7 && candidate.slice(1).every(value => typeof value === 'number' && Number.isFinite(value))
			&& Number(candidate[3]) > 0 && Number(candidate[4]) > 0
	if (candidate.length < 7 || typeof candidate[0] !== 'number' || !Number.isFinite(candidate[0])
		|| typeof candidate[1] !== 'number' || !Number.isFinite(candidate[1]) || candidate[2] !== 'L'
		|| (candidate.length - 3) % 2 !== 0)
		return false
	return candidate.slice(3).every(value => typeof value === 'number' && Number.isFinite(value))
}

export function sameCopperPolygonSource(actual: unknown, expected: CopperPolygonSource): boolean {
	const normalized = normalizeCopperPolygonSource(actual)
	if (!Array.isArray(normalized)) return false
	const actualIsL = normalized[2] === 'L'
	const expectedIsL = expected[2] === 'L'
	if (!actualIsL && !expectedIsL)
		return normalized.length === expected.length && normalized.every((value, index) => value === expected[index])
	if (!actualIsL || !expectedIsL) return false
	const ring = (path: unknown[]): CopperVertex[] => {
		if (path[2] !== 'L' || path.length < 7 || (path.length - 3) % 2 !== 0) return []
		const points: CopperVertex[] = [{ x: Number(path[0]), y: Number(path[1]) }]
		for (let index = 3; index < path.length; index += 2)
			points.push({ x: Number(path[index]), y: Number(path[index + 1]) })
		if (points.length > 1 && samePoint(points[0], points.at(-1)!)) points.pop()
		return points
	}
	const actualRing = ring(normalized)
	const expectedRing = ring(expected)
	if (!actualRing.length || actualRing.length !== expectedRing.length) return false
	const sameAt = (start: number, direction: 1 | -1) => expectedRing.every((point, index) => {
		const actualIndex = (start + direction * index + actualRing.length * 2) % actualRing.length
		return samePoint(point, actualRing[actualIndex])
	})
	return actualRing.some((_point, start) => sameAt(start, 1) || sameAt(start, -1))
}
