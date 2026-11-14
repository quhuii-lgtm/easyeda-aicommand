/** Safe merge helpers for the host's whole-configuration rule writers. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type RulePathChange = { path: string[], value: JsonValue }
export type NetRuleChange = { type: string, name: string, values: Record<string, string | null> }

const forbiddenPathKeys = new Set(['__proto__', 'prototype', 'constructor'])

export function cloneRuleValue<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

export function stableRuleJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableRuleJson).join(',')}]`
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableRuleJson(record[key])}`).join(',')}}`
	}
	return JSON.stringify(value)
}

export function assertJsonValue(value: unknown, label: string, seen = new Set<object>()): asserts value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${label} 必须是有限数值`)
		return
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new Error(`${label} 不能包含循环引用`)
		seen.add(value)
		for (let i = 0; i < value.length; i++) {
			if (!(i in value)) throw new Error(`${label}[${i}] 不能是空项`)
			assertJsonValue(value[i], `${label}[${i}]`, seen)
		}
		seen.delete(value)
		return
	}
	if (typeof value === 'object') {
		const object = value as Record<string, unknown>
		if (seen.has(object)) throw new Error(`${label} 不能包含循环引用`)
		seen.add(object)
		for (const key of Object.keys(object)) {
			if (forbiddenPathKeys.has(key)) throw new Error(`${label} 含有禁止的原型键 ${key}`)
			if (object[key] === undefined) throw new Error(`${label}.${key} 不能是 undefined`)
			assertJsonValue(object[key], `${label}.${key}`, seen)
		}
		seen.delete(object)
		return
	}
	throw new Error(`${label} 必须是 JSON 值（收到 ${typeof value}）`)
}

function objectAtPath(root: Record<string, any>, path: string[]): { parent: Record<string, any>, key: string } {
	if (!Array.isArray(path) || path.length === 0) throw new Error('changes.path 必须是非空字符串数组')
	let current: any = root
	for (let i = 0; i < path.length; i++) {
		const key = path[i]
		if (typeof key !== 'string' || !key.length) throw new Error(`changes.path[${i}] 必须是非空字符串`)
		if (forbiddenPathKeys.has(key)) throw new Error(`changes.path 禁止使用 ${key}`)
		if (Array.isArray(current)) {
			if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error(`changes.path 数组索引无效：${key}`)
			const index = Number(key)
			if (!Number.isSafeInteger(index)) throw new Error(`changes.path 数组索引超出范围：${key}`)
			if (i === path.length - 1) {
				if (index >= current.length || !Object.prototype.hasOwnProperty.call(current, index)) throw new Error(`changes.path 数组叶索引不存在：${path.join('.')}`)
				return { parent: current, key }
			}
			if (index >= current.length || !Object.prototype.hasOwnProperty.call(current, index)) throw new Error(`changes.path 数组父索引不存在：${path.slice(0, i + 1).join('.')}`)
			current = current[index]
			continue
		}
		if (i === path.length - 1) {
			if (!current || typeof current !== 'object') throw new Error(`changes.path 父节点不是对象：${path.slice(0, i).join('.')}`)
			return { parent: current, key }
		}
		if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key))
			throw new Error(`changes.path 父路径不存在：${path.slice(0, i + 1).join('.')}`)
		current = current[key]
	}
	throw new Error('changes.path 无效')
}

export function applyConfigurationChanges(configuration: unknown, changes: RulePathChange[]): { expected: unknown, diff: Array<{ path: string[], before: unknown, after: JsonValue }> } {
	if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('当前规则配置不是对象')
	if (!Array.isArray(changes)) throw new Error('changes 必须是数组')
	const expected: any = cloneRuleValue(configuration as Record<string, any>)
	const diff: Array<{ path: string[], before: unknown, after: JsonValue }> = []
	const seen = new Set<string>()
	for (const [index, change] of changes.entries()) {
		if (!change || typeof change !== 'object') throw new Error(`changes[${index}] 必须是对象`)
		if (!Array.isArray(change.path) || change.path[0] !== 'config' || change.path.length < 2)
			throw new Error(`changes[${index}].path 必须指向 configuration.config 内的字段；外层元数据不可写`)
		assertJsonValue(change.value, `changes[${index}].value`)
		const { parent, key } = objectAtPath(expected, change.path)
		const id = stableRuleJson(change.path)
		if (seen.has(id)) throw new Error(`重复的配置路径：${change.path.join('.')}`)
		seen.add(id)
		if (Object.prototype.hasOwnProperty.call(parent, key) && parent[key] !== null && typeof parent[key] === 'object')
			throw new Error(`配置路径必须指向叶字段；不能整体替换对象：${change.path.join('.')}`)
		const before = Object.prototype.hasOwnProperty.call(parent, key) ? cloneRuleValue(parent[key]) : undefined
		if (stableRuleJson(before) === stableRuleJson(change.value) && before !== undefined) continue
		parent[key] = cloneRuleValue(change.value)
		diff.push({ path: [...change.path], before, after: cloneRuleValue(change.value) })
	}
	return { expected, diff }
}

export function applyNetRuleChanges(netRules: unknown, changes: NetRuleChange[]): { expected: unknown[], diff: Array<{ type: string, name: string, values: Record<string, { before: unknown, after: string | null }>, fromClass?: string }> } {
	if (!Array.isArray(netRules)) throw new Error('当前网络规则未返回数组')
	if (!Array.isArray(changes)) throw new Error('netRuleChanges 必须是数组')
	const expected: any[] = cloneRuleValue(netRules as unknown[])
	const collectRows = (items: unknown[], output: any[] = []): any[] => {
		for (const item of items) {
			if (!item || typeof item !== 'object' || Array.isArray(item)) continue
			output.push(item)
			if (Array.isArray((item as Record<string, unknown>).sub)) collectRows((item as Record<string, unknown>).sub as unknown[], output)
		}
		return output
	}
	const rows = collectRows(expected)
	const original = new Map(rows.map(row => [row, cloneRuleValue(row)]))
	const plan = new Map<any, Map<string, { value: string | null, fromClass?: string }>>()
	const selectors = new Set<string>()
	const selected: Array<{ change: NetRuleChange, row: any }> = []
	for (const [index, change] of changes.entries()) {
		if (!change || typeof change !== 'object' || typeof change.type !== 'string' || !change.type || typeof change.name !== 'string' || !change.name)
			throw new Error(`netRuleChanges[${index}] 必须明确提供 type 和 name`)
		if (!change.values || typeof change.values !== 'object' || Array.isArray(change.values)) throw new Error(`netRuleChanges[${index}].values 必须是对象`)
		for (const [field, value] of Object.entries(change.values)) {
			if (!field || forbiddenPathKeys.has(field)) throw new Error(`网络规则字段名无效：${field}`)
			if (value !== null && typeof value !== 'string') throw new Error(`网络规则值必须是字符串或 null：${change.type}/${change.name}/${field}`)
		}
		const selector = `${change.type}\0${change.name}`
		if (selectors.has(selector)) throw new Error(`重复的网络规则选择器：${change.type}/${change.name}`)
		selectors.add(selector)
		const matches = rows.filter(row => row.type === change.type && row.name === change.name)
		if (matches.length !== 1) throw new Error(`网络规则选择器必须唯一匹配现有行：${change.type}/${change.name}（匹配 ${matches.length} 行）`)
		selected.push({ change, row: matches[0] })
	}
	const assertBinding = (row: any, change: NetRuleChange, field: string): void => {
		if (!field || forbiddenPathKeys.has(field)) throw new Error(`网络规则字段名无效：${field}`)
		if (['type', 'name', 'sub', 'targetNet'].includes(field)) throw new Error(`网络规则身份字段 ${field} 不能通过 values 修改`)
		if (!Object.prototype.hasOwnProperty.call(row, field)) throw new Error(`网络规则字段不存在：${change.type}/${change.name}/${field}`)
		if (row[field] !== null && typeof row[field] !== 'string') throw new Error(`现有网络规则绑定 ${change.type}/${change.name}/${field} 不是字符串或 null；拒绝修改其结构`)
	}
	const setPlanned = (row: any, field: string, value: string | null, fromClass?: string): void => {
		const fields = plan.get(row) ?? new Map<string, { value: string | null, fromClass?: string }>()
		fields.set(field, { value, ...(fromClass ? { fromClass } : {}) })
		plan.set(row, fields)
	}
	const descendants = (row: any): any[] => {
		const output: any[] = []
		const visit = (items: unknown[]): void => {
			for (const item of items) {
				if (!item || typeof item !== 'object' || Array.isArray(item)) continue
				if ((item as any).type === 'net') output.push(item)
				if (Array.isArray((item as any).sub)) visit((item as any).sub)
			}
		}
		if (Array.isArray(row.sub)) visit(row.sub)
		return output
	}
	// Plan every class value first, then explicit NET values. This makes NET precedence
	// independent of the order supplied by the caller.
	for (const { change, row } of selected) {
		if (change.type !== 'netClass') continue
		const members = descendants(row)
		for (const [field, value] of Object.entries(change.values)) {
			assertBinding(row, change, field)
			for (const member of members) assertBinding(member, { type: 'net', name: String(member.name ?? ''), values: change.values }, field)
			setPlanned(row, field, value, undefined)
			for (const member of members) setPlanned(member, field, value, row.name)
		}
	}
	for (const { change, row } of selected) {
		if (change.type === 'netClass') continue
		for (const [field, value] of Object.entries(change.values)) {
			assertBinding(row, change, field)
			setPlanned(row, field, value)
		}
	}
	const diff: Array<{ type: string, name: string, values: Record<string, { before: unknown, after: string | null }>, fromClass?: string }> = []
	for (const row of rows) {
		const plannedFields = plan.get(row)
		if (!plannedFields) continue
		const fields: Record<string, { before: unknown, after: string | null }> = {}
		let inheritedFrom: string | undefined
		for (const [field, planned] of plannedFields) {
			const before = original.get(row)?.[field]
			if (before !== planned.value) fields[field] = { before: cloneRuleValue(before), after: planned.value }
			if (fields[field] && planned.fromClass && !inheritedFrom) inheritedFrom = planned.fromClass
			row[field] = planned.value
		}
		if (Object.keys(fields).length) diff.push({ type: row.type, name: row.name, values: fields, ...(inheritedFrom ? { fromClass: inheritedFrom } : {}) })
	}
	return { expected, diff }
}
