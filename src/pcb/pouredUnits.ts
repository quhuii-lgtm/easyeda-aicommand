export type PouredPathCoordinateUnit = 'mil' | 'unknown'

export interface PouredPathNormalization {
	status: 'normalized' | 'unsupported'
	coordinateUnit: PouredPathCoordinateUnit
	normalization: string
	editorVersion: string | null
	conversionFactor: number | null
	normalizedPathMil?: unknown
}

export interface MatchedSolidPouredPathNormalization {
	status: 'normalized' | 'unsupported'
	normalization: 'source-matched-solid-poured-raw-x10' | string
	conversionFactor: 10 | null
	copperMarginMil: number | null
	normalizedPathMil?: Array<number | 'L'>
}

export function readEditorVersion(sdk: any): string | null {
	try {
		const value = sdk?.sys_Environment?.getEditorCurrentVersion?.()
		return typeof value === 'string' && value.length > 0 ? value : null
	}
	catch {
		return null
	}
}

function finite(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function isSimpleLinePolygon(source: unknown): source is Array<number | 'L'> {
	if (!Array.isArray(source) || source.length < 7 || source.some(Array.isArray))
		return false
	let points = 0
	let lineMarkers = 0
	for (let index = 0; index < source.length;) {
		if (finite(source[index]) && finite(source[index + 1])) {
			points++
			index += 2
			continue
		}
		if (source[index] === 'L') {
			lineMarkers++
			index++
			continue
		}
		return false
	}
	return points >= 3 && lineMarkers === 1
}

function flattenSinglePath(source: unknown): unknown {
	if (!Array.isArray(source))
		return source;
	if (Array.isArray(source[0]))
		return source.length === 1 ? source[0] : undefined;
	return source;
}

function closedSimpleStraightPath(source: unknown): source is Array<number | 'L'> {
	const path = flattenSinglePath(source);
	if (!Array.isArray(path) || path.length < 9 || path[2] !== 'L' || (path.length - 3) % 2 !== 0)
		return false;
	const coordinates = [path[0], path[1], ...path.slice(3)];
	if (!coordinates.every(finite))
		return false;
	const points: Array<[number, number]> = [];
	for (let index = 0; index < coordinates.length; index += 2)
		points.push([coordinates[index] as number, coordinates[index + 1] as number]);
	const first = points[0];
	const last = points.at(-1)!;
	if (first[0] !== last[0] || first[1] !== last[1])
		return false;
	const vertices = points.slice(0, -1);
	if (vertices.length < 3 || new Set(vertices.map(point => `${point[0]},${point[1]}`)).size !== vertices.length)
		return false;
	let twiceArea = 0;
	for (let index = 0; index < vertices.length; index++) {
		const a = vertices[index];
		const b = vertices[(index + 1) % vertices.length];
		if (a[0] === b[0] && a[1] === b[1])
			return false;
		twiceArea += a[0] * b[1] - a[1] * b[0];
	}
	if (!Number.isFinite(twiceArea) || twiceArea === 0)
		return false;
	const cross = (a: [number, number], b: [number, number], c: [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	const onSegment = (p: [number, number], a: [number, number], b: [number, number]) => p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
	const intersects = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean | null => {
		const abc = cross(a, b, c);
		const abd = cross(a, b, d);
		const cda = cross(c, d, a);
		const cdb = cross(c, d, b);
		if (![abc, abd, cda, cdb].every(Number.isFinite))
			return null;
		if (((abc > 0 && abd < 0) || (abc < 0 && abd > 0)) && ((cda > 0 && cdb < 0) || (cda < 0 && cdb > 0)))
			return true;
		return (abc === 0 && onSegment(c, a, b)) || (abd === 0 && onSegment(d, a, b)) || (cda === 0 && onSegment(a, c, d)) || (cdb === 0 && onSegment(b, c, d));
	};
	for (let index = 0; index < vertices.length; index++) {
		const previous = vertices[(index + vertices.length - 1) % vertices.length];
		const current = vertices[index];
		const next = vertices[(index + 1) % vertices.length];
		const turn = cross(previous, current, next);
		const overlap = (previous[0] - current[0]) * (next[0] - current[0]) + (previous[1] - current[1]) * (next[1] - current[1]);
		if (!Number.isFinite(turn) || !Number.isFinite(overlap) || (turn === 0 && overlap > 0))
			return false;
	}
	for (let firstEdge = 0; firstEdge < vertices.length; firstEdge++) {
		for (let secondEdge = firstEdge + 1; secondEdge < vertices.length; secondEdge++) {
			if (secondEdge === firstEdge + 1 || (firstEdge === 0 && secondEdge === vertices.length - 1))
				continue;
			const result = intersects(vertices[firstEdge], vertices[(firstEdge + 1) % vertices.length], vertices[secondEdge], vertices[(secondEdge + 1) % vertices.length]);
			if (result !== false)
				return false;
		}
	}
	return path.every(value => value === 'L' || finite(value));
}

export function isClosedSimplePouredPathSource(source: unknown): boolean {
	return closedSimpleStraightPath(source);
}

/**
 * Normalize a simple, closed SOLID POURED ring only after the caller has matched
 * its fresh SDK geometry to the current POUR/POURED source records. Calibration
 * evidence supports multiplying the reported coordinates by 10 to obtain mil
 * geometry for both tested fineness values; it is not an official unit declaration.
 */
export function normalizeMatchedSolidPouredPathSource(source: unknown, options: {
	sourceMatched: boolean
	fill: unknown
	lineWidth: unknown
	fineness: unknown
}): MatchedSolidPouredPathNormalization {
	const unsupported = (): MatchedSolidPouredPathNormalization => ({ status: 'unsupported', normalization: 'source-match-or-solid-polygon-unverified', conversionFactor: null, copperMarginMil: null });
	const path = flattenSinglePath(source);
	if (!options.sourceMatched || options.fill !== true || options.lineWidth !== 0 || !finite(options.fineness) || options.fineness < 0 || !closedSimpleStraightPath(path))
		return unsupported();
	const normalizedPathMil = (path as Array<number | 'L'>).map(value => value === 'L' ? value : value * 10);
	if (!normalizedPathMil.every(value => value === 'L' || Number.isFinite(value)))
		return unsupported();
	return { status: 'normalized', normalization: 'source-matched-solid-poured-raw-x10', conversionFactor: 10, copperMarginMil: options.fineness / 2, normalizedPathMil };
}

/**
 * Normalize only the experimentally confirmed EDA 4.1.78 zero-width straight
 * fill path. The marker, raw values, and conversion provenance remain visible
 * to callers; no coordinate-range heuristic is used.
 */
export function normalizePouredPathSource(source: unknown, options: {
	fill: unknown
	lineWidth: unknown
	editorVersion: unknown
	declaredCoordinateUnit?: unknown
}): PouredPathNormalization {
	const editorVersion = typeof options.editorVersion === 'string' && options.editorVersion.length > 0 ? options.editorVersion : null
	const unsupported = (normalization: string): PouredPathNormalization => ({
		status: 'unsupported',
		coordinateUnit: options.declaredCoordinateUnit === 'mil' ? 'mil' : 'unknown',
		normalization,
		editorVersion,
		conversionFactor: null,
		...(options.declaredCoordinateUnit === 'mil' && isSimpleLinePolygon(source) ? { normalizedPathMil: [...source] } : {}),
	})
	if (options.fill !== true)
		return unsupported('not-filled')
	if (!finite(options.lineWidth) || options.lineWidth !== 0)
		return unsupported('nonzero-or-unknown-line-width')
	if (!isSimpleLinePolygon(source))
		return unsupported('unsupported-path-shape')
	if (options.declaredCoordinateUnit === 'mil')
		return { status: 'normalized', coordinateUnit: 'mil', normalization: 'explicit-mil-no-conversion', editorVersion, conversionFactor: 1, normalizedPathMil: [...source] }
	if (editorVersion !== '4.1.78')
		return unsupported(editorVersion ? 'host-version-unverified-for-conversion' : 'host-version-unknown')
	const normalizedPathMil = source.map(value => value === 'L' ? value : value * 10)
	return { status: 'normalized', coordinateUnit: 'mil', normalization: 'eda-4.1.78-zero-width-fill-path-10mil-to-mil', editorVersion, conversionFactor: 10, normalizedPathMil }
}
