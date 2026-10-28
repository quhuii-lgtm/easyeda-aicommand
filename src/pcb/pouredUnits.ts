export type PouredPathCoordinateUnit = 'mil' | 'unknown'

export interface PouredPathNormalization {
	status: 'normalized' | 'unsupported'
	coordinateUnit: PouredPathCoordinateUnit
	normalization: string
	editorVersion: string | null
	conversionFactor: number | null
	normalizedPathMil?: unknown
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
