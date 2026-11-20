export const MIN_ROUTE_SEGMENT_LENGTH_MIL = 1

export interface RouteSegmentPoint { x: number; y: number }
export interface RouteSegment { net: string; layer: number | string; a: RouteSegmentPoint; b: RouteSegmentPoint }
export interface ShortRouteSegment extends RouteSegment { lineIndex: number; lengthMil: number }

export function assertMinimumRouteSegmentLength(a: RouteSegmentPoint, b: RouteSegmentPoint, label: string): void {
	const lengthMil = Math.hypot(b.x - a.x, b.y - a.y)
	if (lengthMil < MIN_ROUTE_SEGMENT_LENGTH_MIL)
		throw new Error(`${label}长度 ${lengthMil} mil 小于最低允许 ${MIN_ROUTE_SEGMENT_LENGTH_MIL} mil`)
}

export function findShortRouteSegments(lines: RouteSegment[]): ShortRouteSegment[] {
	const shortSegments: ShortRouteSegment[] = []
	for (const [index, line] of lines.entries()) {
		const lengthMil = Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y)
		if (lengthMil < MIN_ROUTE_SEGMENT_LENGTH_MIL)
			shortSegments.push({ ...line, a: { ...line.a }, b: { ...line.b }, lineIndex: index + 1, lengthMil })
	}
	return shortSegments
}
