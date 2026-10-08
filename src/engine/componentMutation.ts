type ComponentApi = {
	sch_PrimitiveComponent: {
		get(id: string): Promise<any>
		modify(id: string, property: Record<string, unknown>): Promise<any>
	}
	dmt_SelectControl: {
		getCurrentDocumentInfo(): Promise<any>
	}
}

export const componentModifyFields = [
	'x', 'y', 'rotation', 'mirror', 'addIntoBom', 'addIntoPcb', 'designator', 'name', 'uniqueId',
	'manufacturer', 'manufacturerId', 'supplier', 'supplierId', 'otherProperty',
] as const

const numericFields = new Set(['x', 'y', 'rotation'])
const booleanFields = new Set(['mirror', 'addIntoBom', 'addIntoPcb'])
const nullableStringFields = new Set(['designator', 'name', 'uniqueId', 'manufacturer', 'manufacturerId', 'supplier', 'supplierId'])

function fail(message: string, partial = false): never {
	const error = new Error(message) as Error & { partial: boolean, retryable: boolean }
	error.partial = partial
	error.retryable = false
	error.cause = { partial, retryable: false }
	throw error
}

function validateFullProperty(property: unknown): asserts property is Record<string, unknown> {
	if (!property || typeof property !== 'object' || Array.isArray(property))
		fail('property 必须是包含全部 14 个官方字段的对象')
	const p = property as Record<string, unknown>
	const missing = componentModifyFields.filter(key => !Object.prototype.hasOwnProperty.call(p, key) || p[key] === undefined)
	const unknown = Object.keys(p).filter(key => !(componentModifyFields as readonly string[]).includes(key))
	if (missing.length || unknown.length)
		fail(`property 字段无效；缺少/undefined: ${missing.join(', ') || '无'}；未知字段: ${unknown.join(', ') || '无'}`)
	for (const field of componentModifyFields) {
		const value = p[field]
		if (numericFields.has(field) && (typeof value !== 'number' || !Number.isFinite(value)))
			fail(`${field} 必须是有限数值`)
		if (booleanFields.has(field) && typeof value !== 'boolean')
			fail(`${field} 必须是布尔值`)
		if (nullableStringFields.has(field) && value !== null && typeof value !== 'string')
			fail(`${field} 必须是字符串或 null`)
	}
	const other = p.otherProperty
	if (!other || typeof other !== 'object' || Array.isArray(other))
		fail('otherProperty 必须是非数组对象')
	for (const [key, value] of Object.entries(other as Record<string, unknown>)) {
		if (typeof value !== 'string' && typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value)))
			fail(`otherProperty.${key} 必须是字符串、布尔值或有限数值`)
	}
}

function focusIdentity(info: any): string {
	return `${String(info?.uuid ?? '')}\u0000${String(info?.parentProjectUuid ?? '')}`
}

async function requireFocus(api: ComponentApi, before: any, stage: string, partial = false): Promise<void> {
	const current = await api.dmt_SelectControl.getCurrentDocumentInfo()
	if (current?.documentType !== 1 || !current?.uuid || focusIdentity(current) !== focusIdentity(before))
		fail(`${stage}时焦点原理图页或所属工程已变化；禁止继续操作`, partial)
}

function safeState(component: any, getter: string): unknown {
	const fn = component?.[getter]
	if (typeof fn !== 'function')
		throw new Error(`当前 SDK 器件对象缺少 ${getter}`)
	return fn.call(component)
}

function sameValue(actual: unknown, wanted: unknown): boolean {
	if (wanted === null)
		return actual === null || actual === undefined || actual === ''
	return actual === wanted
}

function deepCopy<T>(value: T): T {
	if (Array.isArray(value))
		return value.map(item => deepCopy(item)) as T
	if (value && typeof value === 'object') {
		const copy: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value as Record<string, unknown>))
			copy[key] = deepCopy(item)
		return copy as T
	}
	return value
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b)
		return true
	if (!a || !b || typeof a !== 'object' || typeof b !== 'object')
		return false
	if (Array.isArray(a) || Array.isArray(b))
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))
	const ao = a as Record<string, unknown>
	const bo = b as Record<string, unknown>
	const keys = Object.keys(ao)
	return keys.length === Object.keys(bo).length && keys.every(key => Object.prototype.hasOwnProperty.call(bo, key) && deepEqual(ao[key], bo[key]))
}

function diagnosticValue(value: unknown): Record<string, unknown> {
	if (value === undefined)
		return { type: 'undefined' }
	if (value === null)
		return { type: 'null', value: null }
	if (Array.isArray(value))
		return { type: 'array', value: value.map(item => diagnosticValue(item)) }
	if (typeof value === 'object') {
		const encoded: Record<string, unknown> = {}
		for (const [key, item] of Object.entries(value as Record<string, unknown>))
			encoded[key] = diagnosticValue(item)
		return { type: 'object', value: encoded }
	}
	return { type: typeof value, value }
}

function assertExistingOtherProperties(property: Record<string, unknown>, component: any): void {
	const current = safeState(component, 'getState_OtherProperty') as Record<string, unknown> | undefined
	const supplied = property.otherProperty as Record<string, unknown>
	const missing = Object.keys(current ?? {}).filter(key => !Object.prototype.hasOwnProperty.call(supplied, key))
	if (missing.length)
		fail(`otherProperty 未包含器件现有键：${missing.join(', ')}`)
}

/** Execute one complete official component modify and verify every requested field. */
export async function modifyComponentSafely(api: ComponentApi, primitiveId: string, property: unknown) {
	validateFullProperty(property)
	const expected = deepCopy(property)
	const sdkProperty = deepCopy(expected)
	const beforeFocus = await api.dmt_SelectControl.getCurrentDocumentInfo()
	if (beforeFocus?.documentType !== 1 || !beforeFocus?.uuid)
		fail('焦点文档不是有效的原理图页；已拒绝修改')
	const current = await api.sch_PrimitiveComponent.get(primitiveId)
	if (!current)
		fail(`当前原理图页找不到器件 ${primitiveId}`)
	assertExistingOtherProperties(expected, current)
	await requireFocus(api, beforeFocus, '调用 modify 前')
	let attempted = false
	let result: any
	try {
		attempted = true
		result = await api.sch_PrimitiveComponent.modify(primitiveId, sdkProperty)
		await requireFocus(api, beforeFocus, 'modify 后读回前', true)
		const readback = await api.sch_PrimitiveComponent.get(primitiveId)
		if (!readback)
			fail(`器件 ${primitiveId} modify 后无法读回`, true)
		const fields: Record<string, string> = {
			x: 'getState_X', y: 'getState_Y', rotation: 'getState_Rotation', mirror: 'getState_Mirror',
			addIntoBom: 'getState_AddIntoBom', addIntoPcb: 'getState_AddIntoPcb', designator: 'getState_Designator',
			name: 'getState_Name', uniqueId: 'getState_UniqueId', manufacturer: 'getState_Manufacturer',
			manufacturerId: 'getState_ManufacturerId', supplier: 'getState_Supplier', supplierId: 'getState_SupplierId',
		}
		const values: Record<string, unknown> = {}
		const mismatches: string[] = []
		for (const [field, getter] of Object.entries(fields)) {
			const actual = safeState(readback, getter)
			values[field] = actual ?? null
			if (!sameValue(actual, expected[field]))
				mismatches.push(`${field} (want ${JSON.stringify(expected[field])}, got ${JSON.stringify(actual)})`)
		}
		const actualOther = safeState(readback, 'getState_OtherProperty') as Record<string, unknown> | undefined
		values.otherProperty = actualOther ?? null
		const wantedOther = expected.otherProperty as Record<string, unknown>
		for (const [key, value] of Object.entries(wantedOther)) {
			if (!actualOther || !Object.prototype.hasOwnProperty.call(actualOther, key) || !sameValue(actualOther[key], value))
				mismatches.push(`otherProperty.${key} (want ${JSON.stringify(value)}, got ${JSON.stringify(actualOther?.[key])})`)
		}
		if (actualOther && Object.keys(actualOther).some(key => !Object.prototype.hasOwnProperty.call(wantedOther, key)))
			mismatches.push('otherProperty 含未请求的额外键')
		await requireFocus(api, beforeFocus, '读回结束时', true)
		if (mismatches.length)
			fail(`器件 ${primitiveId} modify 后读回不匹配：${mismatches.join('; ')}`, true)
		return { modified: Boolean(result), readback: { ...values, verified: true } }
	}
	catch (error) {
		if (attempted) {
			const wrapped = error instanceof Error ? error as Error & { partial?: boolean, retryable?: boolean } : new Error(String(error)) as Error & { partial?: boolean, retryable?: boolean }
			wrapped.partial = true
			wrapped.retryable = false
			wrapped.cause = { partial: true, retryable: false, operationError: wrapped.message }
			throw wrapped
		}
		throw error
	}
}

const preservedFields: Record<string, string> = {
	x: 'getState_X', y: 'getState_Y', rotation: 'getState_Rotation', mirror: 'getState_Mirror',
	primitiveType: 'getState_PrimitiveType', componentType: 'getState_ComponentType', component: 'getState_Component',
	symbol: 'getState_Symbol', footprint: 'getState_Footprint', subPartName: 'getState_SubPartName',
	addIntoBom: 'getState_AddIntoBom', addIntoPcb: 'getState_AddIntoPcb', net: 'getState_Net',
	designator: 'getState_Designator', name: 'getState_Name', uniqueId: 'getState_UniqueId',
	manufacturer: 'getState_Manufacturer', manufacturerId: 'getState_ManufacturerId', supplier: 'getState_Supplier',
	supplierId: 'getState_SupplierId', otherProperty: 'getState_OtherProperty',
}

function snapshotPreservedState(component: any): Record<string, unknown> {
	return deepCopy(Object.fromEntries(Object.entries(preservedFields).map(([field, getter]) => [field, safeState(component, getter)])))
}

/** Move/rotate/mirror through async state setters, preserving and checking all non-geometric state. */
export async function moveComponentSafely(api: ComponentApi, primitiveId: string, requested: Record<string, unknown>, expectedFocus?: any) {
	const allowed = new Set(['x', 'y', 'rotation', 'mirror'])
	const keys = Object.keys(requested)
	if (!keys.length || keys.some(key => !allowed.has(key)))
		fail('至少提供一个且只能提供 x / y / rotation / mirror')
	for (const key of keys) {
		const value = requested[key]
		if (key === 'mirror' ? typeof value !== 'boolean' : typeof value !== 'number' || !Number.isFinite(value))
			fail(`${key} 的类型或数值无效`)
	}
	const beforeFocus = await api.dmt_SelectControl.getCurrentDocumentInfo()
	if (beforeFocus?.documentType !== 1 || !beforeFocus?.uuid)
		fail('焦点文档不是有效的原理图页；已拒绝移动')
	if (expectedFocus && focusIdentity(beforeFocus) !== focusIdentity(expectedFocus))
		fail('原理图规划期间焦点页或所属工程已变化；已拒绝移动')
	const current = await api.sch_PrimitiveComponent.get(primitiveId)
	if (!current)
		fail(`当前原理图页找不到器件 ${primitiveId}`)
	const original = snapshotPreservedState(current)
	await requireFocus(api, beforeFocus, '安全移动前')
	let doneAttempted = false
	const stateDifferences: Array<Record<string, unknown>> = []
	try {
		const asyncComponent = current.toAsync()
		if (requested.x !== undefined) asyncComponent.setState_X(requested.x)
		if (requested.y !== undefined) asyncComponent.setState_Y(requested.y)
		if (requested.rotation !== undefined) asyncComponent.setState_Rotation(requested.rotation)
		if (requested.mirror !== undefined) asyncComponent.setState_Mirror(requested.mirror)
		doneAttempted = true
		await asyncComponent.done()
		await requireFocus(api, beforeFocus, '移动后读回前')
		const back = await api.sch_PrimitiveComponent.get(primitiveId)
		if (!back)
			fail(`器件 ${primitiveId} 移动后无法读回`, true)
		const readback: Record<string, unknown> = {}
		const mismatches: string[] = []
		const geometry: Record<string, string> = { x: 'getState_X', y: 'getState_Y', rotation: 'getState_Rotation', mirror: 'getState_Mirror' }
		for (const [field, getter] of Object.entries(geometry)) {
			if (requested[field] === undefined) continue
			const actual = safeState(back, getter)
			readback[field] = actual
			if (actual !== requested[field]) {
				mismatches.push(`${field} (want ${JSON.stringify(requested[field])}, got ${JSON.stringify(actual)})`)
				stateDifferences.push({ field, before: diagnosticValue(original[field]), expected: diagnosticValue(requested[field]), after: diagnosticValue(actual), actual: diagnosticValue(actual) })
			}
		}
		const actualPreserved = snapshotPreservedState(back)
		readback.preserved = actualPreserved
		for (const [field, value] of Object.entries(original)) {
			if (['x', 'y', 'rotation', 'mirror'].includes(field) && requested[field] !== undefined)
				continue
			if (!deepEqual(actualPreserved[field], value)) {
				mismatches.push(`${field} 状态改变`)
				stateDifferences.push({ field, before: diagnosticValue(value), expected: diagnosticValue(value), after: diagnosticValue(actualPreserved[field]), actual: diagnosticValue(actualPreserved[field]) })
			}
		}
		await requireFocus(api, beforeFocus, '安全移动读回结束时', true)
		if (mismatches.length)
			fail(`器件 ${primitiveId} 移动后状态校验失败：${mismatches.join('; ')}`, true)
		return { modified: true, readback: { ...readback, verified: true } }
	}
	catch (error) {
		if (doneAttempted) {
			const wrapped = error instanceof Error ? error as Error & { partial?: boolean, retryable?: boolean } : new Error(String(error)) as Error & { partial?: boolean, retryable?: boolean }
			wrapped.partial = true
			wrapped.retryable = false
			const priorCause = wrapped.cause && typeof wrapped.cause === 'object' ? wrapped.cause as Record<string, unknown> : {}
			wrapped.cause = {
				...priorCause,
				partial: true,
				retryable: false,
				operation: 'moveComponentSafely',
				primitiveId,
				documentUuid: beforeFocus.uuid,
				requested: diagnosticValue(requested),
				stateDifferences,
				operationError: wrapped.message,
			}
			throw wrapped
		}
		throw error
	}
}
