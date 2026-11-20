export type DrcSeverity = 'error' | 'warn' | 'unknown'

export interface DrcViolation extends Record<string, unknown> {
	type: DrcSeverity
	raw: unknown
}

export interface DrcResult {
	rawResult: unknown[]
	violations: DrcViolation[]
	totalCount: number
	errorCount: number
	fatalCount: number
	warnCount: number
	unknownCount: number
	categoryCount: number
	unrecognizedCount: number
	unrecognizedNodes: Array<{ path: string[]; raw: unknown }>
	passed: boolean
	incomplete: boolean
	coverage: {
		source: 'pcb_Drc.check(true,false,true)'
		ruleCoverage: 'unknown'
		result: 'returned'
		passedMeaning: 'no-findings-in-returned-results'
	}
	rawCoordinateUnit: '10mil' | 'unknown'
	coordinateUnit: 'mil' | 'unknown'
}

const asRecord = (value: unknown): Record<string, any> | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, any>
		: undefined

const getSeverity = (node: Record<string, any>, groupPath: string[]): DrcSeverity => {
	const parentId = String(node.parentId ?? '')
	if (/\|_\|Errors\|_\|/i.test(parentId))
		return 'error'
	if (/\|_\|Warnings\|_\|/i.test(parentId))
		return 'warn'
	const groups = groupPath.join('/')
	if (/(^|\/)Errors(\/|$)/i.test(groups))
		return 'error'
	if (/(^|\/)Warnings(\/|$)/i.test(groups))
		return 'warn'
	return 'unknown'
}

const isRecognizedLeaf = (node: Record<string, any>): boolean =>
	node.errData != null || node.objs != null || node.errorType != null

/** Normalize one returned DRC tree without treating malformed or unclassified data as a pass. */
export const parseDrcResult = (value: unknown, editorVersion?: string): DrcResult => {
	if (!Array.isArray(value))
		throw new Error(`PCB DRC 结果不可判定：官方返回 ${value === null ? 'null' : typeof value}，预期为违规数组；不能按 0 项通过处理`)

	const rawResult = value
	const violations: DrcViolation[] = []
	const unrecognizedNodes: DrcResult['unrecognizedNodes'] = []
	const categories = new Set<string>()
	let positionedLeafCount = 0
	let unknownPositionedLeafCount = 0
	// Retained only for compatibility with existing callers. Coordinate recognition is
	// based on the returned native record structure, never an editor-version whitelist.
	void editorVersion
	const walk = (node: unknown, groupPath: string[]) => {
		if (Array.isArray(node)) {
			for (const child of node)
				walk(child, groupPath)
			return
		}
		const record = asRecord(node)
		if (!record) {
			unrecognizedNodes.push({ path: groupPath, raw: node })
			return
		}
		if (Array.isArray(record.list)) {
			// A mixed node is not safely classifiable as either a group or a violation leaf.
			// Retain and report the parent while still walking every child.
			if (isRecognizedLeaf(record))
				unrecognizedNodes.push({ path: groupPath, raw: node })
			const name = record.name == null ? undefined : String(record.name)
			const nextPath = name ? [...groupPath, name] : groupPath
			if (groupPath.length === 0 && name)
				categories.add(name)
			for (const child of record.list)
				walk(child, nextPath)
			return
		}
		if (!isRecognizedLeaf(record)) {
			unrecognizedNodes.push({ path: groupPath, raw: node })
			return
		}

		const explanation = asRecord(record.explanation) ?? {}
		const errData = asRecord(record.errData) ?? asRecord(explanation.errData) ?? {}
		const recordPosition = asRecord(record.pos)
		const rawPosition = recordPosition ?? asRecord(errData.position) ?? {}
		const nativeErrData = asRecord(explanation.errData)
		const nativePosition = asRecord(nativeErrData?.position)
		const severity = getSeverity(record, groupPath)
		const objectIds = Array.isArray(record.objs)
			? record.objs.map(String)
			: errData.obj1 != null ? [String(errData.obj1)] : []
		const hasPosition = rawPosition.x != null || rawPosition.y != null
		const finitePosition = (position: Record<string, any> | undefined): position is Record<string, number> =>
			typeof position?.x === 'number' && Number.isFinite(position.x)
			&& typeof position?.y === 'number' && Number.isFinite(position.y)
		const positionsAgree = finitePosition(recordPosition) && finitePosition(nativePosition)
			&& recordPosition.x === nativePosition.x && recordPosition.y === nativePosition.y
		const nativeObj1 = nativeErrData?.obj1 == null ? undefined : String(nativeErrData.obj1)
		const nativeIndex = nativeErrData?.globalIndex == null ? undefined : String(nativeErrData.globalIndex)
		const recordIndex = record.globalIndex == null ? undefined : String(record.globalIndex)
		const hasNativeParent = /^DRCTab\|_\|(?:Errors|Warnings)\|_\|/i.test(String(record.parentId ?? ''))
		const objectsContainNativeObj = nativeObj1 !== undefined
			&& Array.isArray(record.objs)
			&& record.objs.some((id: unknown) => String(id) === nativeObj1)
		const nativePositionEvidence = positionsAgree
			&& nativeIndex !== undefined && nativeIndex.length > 0 && nativeIndex === recordIndex
			&& hasNativeParent && objectsContainNativeObj
		const convertedX = nativePositionEvidence ? rawPosition.x * 10 : undefined
		const convertedY = nativePositionEvidence ? rawPosition.y * 10 : undefined
		const convertedPosition = Number.isFinite(convertedX) && Number.isFinite(convertedY)
		if (hasPosition) {
			positionedLeafCount++
			if (!convertedPosition)
				unknownPositionedLeafCount++
		}
		const category = groupPath[0]
		violations.push({
			type: severity,
			...(category ? { category } : {}),
			...(groupPath.length ? { rule: groupPath[0] } : (record.ruleName != null ? { rule: String(record.ruleName) } : {})),
			...(record.ruleName != null ? { ruleName: String(record.ruleName) } : {}),
			...(record.errorType != null || errData.errorType != null ? { errorType: String(errData.errorType ?? record.errorType) } : {}),
			...(explanation.str != null ? { message: String(explanation.str), ...(explanation.param ? { messageParams: explanation.param } : {}) } : {}),
			// Groups such as Physical Error / Track classify objects rather than electrical nets.
			...(record.net != null ? { net: String(record.net) } : (errData.net != null ? { net: String(errData.net) } : {})),
			...(objectIds.length ? { primitiveId: objectIds[0], primitiveIds: objectIds } : {}),
			...(record.errorObjType != null || errData.obj1Type != null ? { objectType: String(record.errorObjType ?? errData.obj1Type) } : {}),
			...(errData.obj1Suffix != null ? { objectName: String(errData.obj1Suffix) } : {}),
			...(rawPosition.x != null ? { x: rawPosition.x } : {}),
			...(rawPosition.y != null ? { y: rawPosition.y } : {}),
			...(hasPosition ? {
				rawCoordinateUnit: convertedPosition ? '10mil' : 'unknown',
				...(convertedPosition ? {
					xMil: convertedX,
					yMil: convertedY,
					coordinateUnit: 'mil',
					coordinateBasis: 'data-origin',
					coordinateConversionFactor: 10,
					coordinateEvidence: 'native-drc-verbose-position-source-association-empirical',
				} : {}),
			} : {}),
			...(Array.isArray(errData.layerIds) ? { layerIds: errData.layerIds } : {}),
			groupPath,
			raw: node,
		})
	}
	for (const item of rawResult)
		walk(item, [])

	const errorCount = violations.filter(item => item.type === 'error').length
	const warnCount = violations.filter(item => item.type === 'warn').length
	const unknownCount = violations.filter(item => item.type === 'unknown').length
	const incomplete = unknownCount > 0 || unrecognizedNodes.length > 0
	return {
		rawResult,
		violations,
		totalCount: violations.length,
		errorCount,
		fatalCount: errorCount,
		warnCount,
		unknownCount,
		categoryCount: categories.size,
		unrecognizedCount: unrecognizedNodes.length,
		unrecognizedNodes,
		passed: violations.length === 0 && unrecognizedNodes.length === 0,
		incomplete,
		coverage: {
			source: 'pcb_Drc.check(true,false,true)',
			ruleCoverage: 'unknown',
			result: 'returned',
			passedMeaning: 'no-findings-in-returned-results',
		},
		rawCoordinateUnit: positionedLeafCount > 0 && unknownPositionedLeafCount === 0 ? '10mil' : 'unknown',
		coordinateUnit: positionedLeafCount > 0 && unknownPositionedLeafCount === 0 ? 'mil' : 'unknown',
	}
}
