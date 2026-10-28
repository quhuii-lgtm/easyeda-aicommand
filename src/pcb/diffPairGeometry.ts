export interface DifferentialPairPlan {
	positivePath: number[][]
	negativePath: number[][]
	plannedLengths: {
		positive: number
		negative: number
		positiveMinusNegative: number
		absoluteDifference: number
	}
	minimumCopperGapMil: number
	normalization: string
}

type Point = { x: number; y: number }
type Segment = { a: Point; b: Point }

const MAX_TOLERANCE_MIL = 0.001

function fail(message: string): never {
	throw new Error(`差分对几何规划失败：${message}`)
}

function finite(value: number, label: string): number {
	if (!Number.isFinite(value)) fail(`${label}必须是有限数值`)
	return value
}

function checkedPoint(point: Point, label: string): Point {
	finite(point.x, `${label}.x`)
	finite(point.y, `${label}.y`)
	return point
}

function subtract(a: Point, b: Point): Point {
	return checkedPoint({ x: a.x - b.x, y: a.y - b.y }, '坐标差')
}

function dot(a: Point, b: Point): number {
	return finite(a.x * b.x + a.y * b.y, '点积')
}

function cross(a: Point, b: Point): number {
	return finite(a.x * b.y - a.y * b.x, '叉积')
}

function length(a: Point): number {
	return finite(Math.hypot(a.x, a.y), '线段长度')
}

function orient(a: Point, b: Point, c: Point): number {
	return cross(subtract(b, a), subtract(c, a))
}

function pointSegmentDistance(point: Point, a: Point, b: Point): number {
	const ab = subtract(b, a)
	const denominator = dot(ab, ab)
	if (denominator === 0) return length(subtract(point, a))
	const t = Math.max(0, Math.min(1, dot(subtract(point, a), ab) / denominator))
	return length(subtract(point, { x: a.x + ab.x * t, y: a.y + ab.y * t }))
}

function onSegment(a: Point, b: Point, p: Point, tolerance: number): boolean {
	return Math.abs(orient(a, b, p)) <= tolerance * Math.max(1, length(subtract(b, a)))
		&& p.x >= Math.min(a.x, b.x) - tolerance && p.x <= Math.max(a.x, b.x) + tolerance
		&& p.y >= Math.min(a.y, b.y) - tolerance && p.y <= Math.max(a.y, b.y) + tolerance
}

function segmentsIntersect(s1: Segment, s2: Segment, tolerance: number): boolean {
	const o1 = orient(s1.a, s1.b, s2.a)
	const o2 = orient(s1.a, s1.b, s2.b)
	const o3 = orient(s2.a, s2.b, s1.a)
	const o4 = orient(s2.a, s2.b, s1.b)
	const s1Tolerance = tolerance * Math.max(1, length(subtract(s1.b, s1.a)))
	const s2Tolerance = tolerance * Math.max(1, length(subtract(s2.b, s2.a)))
	if (((o1 > s1Tolerance && o2 < -s1Tolerance) || (o1 < -s1Tolerance && o2 > s1Tolerance))
		&& ((o3 > s2Tolerance && o4 < -s2Tolerance) || (o3 < -s2Tolerance && o4 > s2Tolerance))) return true
	return (Math.abs(o1) <= s1Tolerance && onSegment(s1.a, s1.b, s2.a, tolerance))
		|| (Math.abs(o2) <= s1Tolerance && onSegment(s1.a, s1.b, s2.b, tolerance))
		|| (Math.abs(o3) <= s2Tolerance && onSegment(s2.a, s2.b, s1.a, tolerance))
		|| (Math.abs(o4) <= s2Tolerance && onSegment(s2.a, s2.b, s1.b, tolerance))
}

function segmentDistance(a: Segment, b: Segment, tolerance: number): number {
	if (segmentsIntersect(a, b, tolerance)) return 0
	return Math.min(
		pointSegmentDistance(a.a, b.a, b.b), pointSegmentDistance(a.b, b.a, b.b),
		pointSegmentDistance(b.a, a.a, a.b), pointSegmentDistance(b.b, a.a, a.b),
	)
}

function normalizePath(input: number[][], checkBudget?: () => void): { path: Point[]; removedDuplicates: number; removedCollinear: number } {
	if (!Array.isArray(input) || input.length < 2) fail('path至少需要两个二维点')
	const raw: Point[] = input.map((entry, index) => {
		checkBudget?.()
		if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'number' || typeof entry[1] !== 'number') fail(`path[${index}]必须是[x,y]`)
		return checkedPoint({ x: entry[0], y: entry[1] }, `path[${index}]`)
	})
	const path: Point[] = []
	let removedDuplicates = 0
	for (const point of raw) {
		checkBudget?.()
		const previous = path[path.length - 1]
		if (previous && point.x === previous.x && point.y === previous.y) removedDuplicates++
		else path.push(point)
	}
	let removedCollinear = 0
	for (let i = 1; i < path.length - 1;) {
		checkBudget?.()
		const before = subtract(path[i], path[i - 1])
		const after = subtract(path[i + 1], path[i])
		if (cross(before, after) === 0 && dot(before, after) > 0) {
			path.splice(i, 1)
			removedCollinear++
		} else i++
	}
	if (path.length < 2) fail('规范化后不足两个不同点')
	return { path, removedDuplicates, removedCollinear }
}

function offsetPath(path: Point[], distance: number, side: 1 | -1, tolerance: number, checkBudget?: () => void): Point[] {
	const directions: Point[] = []
	const normals: Point[] = []
	for (let i = 0; i < path.length - 1; i++) {
		checkBudget?.()
		const delta = subtract(path[i + 1], path[i])
		const size = length(delta)
		if (!(size > 0)) fail(`输入线段 ${i + 1} 长度无法表示`)
		directions.push({ x: delta.x / size, y: delta.y / size })
		normals.push({ x: -delta.y / size * distance * side, y: delta.x / size * distance * side })
	}
	const output: Point[] = [checkedPoint({ x: path[0].x + normals[0].x, y: path[0].y + normals[0].y }, '偏移起点')]
	for (let i = 1; i < path.length - 1; i++) {
		checkBudget?.()
		const prev = directions[i - 1]
		const next = directions[i]
		const prevStart = { x: path[i].x + normals[i - 1].x, y: path[i].y + normals[i - 1].y }
		const nextStart = { x: path[i].x + normals[i].x, y: path[i].y + normals[i].y }
		const denominator = cross(prev, next)
		if (denominator === 0) fail(`第 ${i + 1} 个拐点无法可靠求交`)
		const t = cross(subtract(nextStart, prevStart), next) / denominator
		const intersection = checkedPoint({ x: prevStart.x + prev.x * t, y: prevStart.y + prev.y * t }, `第 ${i + 1} 个偏移交点`)
		const scale = Math.max(1, Math.abs(intersection.x), Math.abs(intersection.y), Math.abs(prevStart.x), Math.abs(prevStart.y), Math.abs(nextStart.x), Math.abs(nextStart.y))
		const residualLimit = finite(64 * Number.EPSILON * scale, '求交误差界')
		if (residualLimit > tolerance
			|| Math.abs(cross(subtract(intersection, prevStart), prev)) > tolerance
			|| Math.abs(cross(subtract(intersection, nextStart), next)) > tolerance) fail(`第 ${i + 1} 个拐点求交结果数值不可靠`)
		output.push(intersection)
	}
	const end = path[path.length - 1]
	const lastNormal = normals[normals.length - 1]
	output.push(checkedPoint({ x: end.x + lastNormal.x, y: end.y + lastNormal.y }, '偏移终点'))
	return output
}

function checkOutput(path: Point[], original: Point[], side: string, tolerance: number, width: number, checkBudget?: () => void): Segment[] {
	const segments: Segment[] = []
	for (let i = 0; i < path.length - 1; i++) {
		checkBudget?.()
		const segment = { a: path[i], b: path[i + 1] }
		const vector = subtract(segment.b, segment.a)
		const base = subtract(original[i + 1], original[i])
		if (dot(vector, base) <= 0) fail(`${side}侧第 ${i + 1} 段偏移方向反转`)
		const segmentLength = length(vector)
		if (segmentLength < 1) fail(`${side}侧第 ${i + 1} 段长度 ${segmentLength} mil 小于最低允许 1 mil`)
		segments.push(segment)
	}
	for (let i = 0; i < segments.length; i++) {
		for (let j = i + 2; j < segments.length; j++) {
			checkBudget?.()
			if (segmentDistance(segments[i], segments[j], tolerance) <= width + tolerance) fail(`${side}侧第 ${i + 1} 与第 ${j + 1} 段铜自交或触碰`)
		}
	}
	return segments
}

function pathLength(path: Point[], checkBudget?: () => void): number {
	let total = 0
	for (let i = 0; i < path.length - 1; i++) {
		checkBudget?.()
		total = finite(total + length(subtract(path[i + 1], path[i])), '路径总长')
	}
	return total
}

function coordinates(path: Point[], checkBudget?: () => void): number[][] {
	const result: number[][] = []
	for (const point of path) {
		checkBudget?.()
		result.push([point.x, point.y])
	}
	return result
}

export function planDifferentialPair(
	request: { path: number[][]; width: number; gap: number },
	checkBudget?: () => void,
): DifferentialPairPlan {
	if (!request || typeof request !== 'object') fail('请求必须是对象')
	const width = finite(request.width, 'width')
	const gap = finite(request.gap, 'gap')
	if (!(width > 0) || !(gap > 0)) fail('width和gap必须为正数（单位mil）')
	const half = finite((width + gap) / 2, '偏移距离')
	if (!(half > 0)) fail('偏移距离不能可靠表示')
	const normalized = normalizePath(request.path, checkBudget)
	let scale = Math.max(1, width, gap)
	for (const point of normalized.path) {
		checkBudget?.()
		scale = Math.max(scale, Math.abs(point.x), Math.abs(point.y))
	}
	const tolerance = finite(128 * Number.EPSILON * scale, '数值容差')
	const allowedTolerance = Math.min(MAX_TOLERANCE_MIL, gap * 1e-6, width * 1e-6)
	if (tolerance > allowedTolerance) fail(`坐标精度不足以确认几何关系（误差界 ${tolerance} mil 超过允许值 ${allowedTolerance} mil）`)
	checkBudget?.()
	const positive = offsetPath(normalized.path, half, 1, tolerance, checkBudget)
	const negative = offsetPath(normalized.path, half, -1, tolerance, checkBudget)
	const positiveSegments = checkOutput(positive, normalized.path, '正', tolerance, width, checkBudget)
	const negativeSegments = checkOutput(negative, normalized.path, '负', tolerance, width, checkBudget)
	const target = finite(width + gap, '目标铜间距')
	let minimumCopperGapMil = Number.POSITIVE_INFINITY
	for (let i = 0; i < positiveSegments.length; i++) {
		for (let j = 0; j < negativeSegments.length; j++) {
			checkBudget?.()
			const distance = segmentDistance(positiveSegments[i], negativeSegments[j], tolerance)
			if (distance + tolerance < target) fail(`正负侧第 ${i + 1}/${j + 1} 段铜间距不足：${distance - width} mil，小于 gap ${gap} mil`)
			minimumCopperGapMil = Math.min(minimumCopperGapMil, distance - width)
		}
	}
	const positiveLength = pathLength(positive, checkBudget)
	const negativeLength = pathLength(negative, checkBudget)
	const delta = finite(positiveLength - negativeLength, '路径长度差')
	return {
		positivePath: coordinates(positive, checkBudget),
		negativePath: coordinates(negative, checkBudget),
		plannedLengths: { positive: positiveLength, negative: negativeLength, positiveMinusNegative: delta, absoluteDifference: Math.abs(delta) },
		minimumCopperGapMil: finite(minimumCopperGapMil, '最小铜间距'),
		normalization: `仅移除连续重复点 ${normalized.removedDuplicates} 个、同向共线中间点 ${normalized.removedCollinear} 个；返回规范化路径。未吸附、拉长或调整路径。`,
	}
}
