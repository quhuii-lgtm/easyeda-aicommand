import { buildRoutingNetAliasSnapshot, buildRoutingWidthSnapshot, type RoutingNetAlias } from '../engine/routingWidthRules'
import { readRouteSnapshot } from '../engine/autoRouteSesHost'
import { parseSourceLog, resolveRecords } from './sourcelog'
import { normalizeBoardOutlinePolylines } from './boardOutline'
import { compareDocumentSources } from '../engine/documentRecovery'
import { proveEquivalentPourSafeSelector } from './routingEquivalentPourSafe'
import { sameCopperPath } from './copperShapeReview'

export interface KiRoutingTarget { instanceId: string, projectUuid: string, documentUuid: string, tabId: string }
export interface KiRoutingInput {
	schemaVersion: 1
	units: 'mil'
	target: KiRoutingTarget
	inputDigest: string
	board: { outline: Array<{ a: { x: number, y: number }, b: { x: number, y: number } }>, layers: Array<{ id: number, name: string, type: string, enabled: boolean }> }
	components: Array<Record<string, unknown>>
	nets: Array<{ name: string, pads: Array<Record<string, unknown>> }>
	unconnected_pads: Array<Record<string, unknown>>
	choices: { nets: string[], layers: Array<{ value: string, displayContent: string, layerId: number }>, differentialPairs: Array<Record<string, unknown>>, lengthMatchGroups: Array<Record<string, unknown>>, components: Array<Record<string, unknown>> }
	existing_tracks: Array<Record<string, unknown>>
	existing_vias: Array<Record<string, unknown>>
	existing_arcs: Array<Record<string, unknown>>
	existing_copper_obstacles: Array<Record<string, unknown>>
	routing_config: ReturnType<typeof buildRoutingWidthSnapshot>
	routing_net_aliases: RoutingNetAlias[]
	design_rules: { configuration: unknown, configurationName: string | null, netRules: unknown, sourceRuleRecords: Array<Record<string, unknown>>, unitSemantics: 'sdk-native-unconverted', constraintsComplete: false }
	ruleEvidence: { trackWidth: { status: 'known' | 'unknown', mil: number | null, source: string }, globalClearance: { status: 'known' | 'unknown', mil: number | null, source: string }, boardEdgeClearance: { status: 'known' | 'unknown', mil: number | null, source: string }, via: { status: 'known' | 'unknown', diameterMil: number | null, drillMil: number | null, source: string }, differentialGap: { status: 'known' | 'unknown', mil: number | null, minimumMil: number | null, maximumMil: number | null, source: string }, netTrackWidths: Array<{ net: string, ruleKey: string | null, status: 'known' | 'unknown', layers: Array<{ layerId: number, widthMil: number | null, source: string }> }> }
	baseline: { source: string, documentUuid: string, projectUuid: string, tabId: string }
	coverage: { complete: boolean, unsupported: string[], excludedNonCopper: Array<{ id: string, kind: string, layer: number, layerType: string }>, excludedNonRoutingRegions: Array<{ id: string, layer: number, ruleTypes: number[] }>, routingConstraintsComplete: false }
}

function finite(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`KiRouting 输入 ${name} 不是有限数值`)
	return value
}
function simpleGlobalPolygon(shape: unknown): { polygon?: { coordinateSpace: 'global-mil', points: Array<{ x: number, y: number }> }, unsupported?: string } {
	if (!Array.isArray(shape) || String(shape[0]).toUpperCase() !== 'POLYGON') return {}
	let source = shape[1]
	if (!Array.isArray(source)) return { unsupported: 'POLYGON 源数组格式无法解释' }
	if (source.some(Array.isArray)) {
		if (source.length !== 1 || !Array.isArray(source[0])) return { unsupported: '多轮廓/孔洞多边形尚未转换' }
		source = source[0]
	}
	if (source.length < 8 || typeof source[0] !== 'number' || typeof source[1] !== 'number') return { unsupported: 'POLYGON 源数组格式无法解释' }
	const points: Array<{ x: number, y: number }> = [{ x: source[0], y: source[1] }]
	let index = 2
	if (source[index] !== 'L') return { unsupported: `POLYGON 首段 ${String(source[index] ?? 'missing')} 不是直线` }
	index++
	while (index < source.length) {
		if (source[index] === 'L') index++
		if (index + 1 >= source.length || typeof source[index] !== 'number' || typeof source[index + 1] !== 'number' || !Number.isFinite(source[index]) || !Number.isFinite(source[index + 1])) return { unsupported: 'POLYGON 直线点坐标不完整或非有限数值' }
		points.push({ x: source[index], y: source[index + 1] })
		index += 2
	}
	if (points.length < 4) return { unsupported: 'POLYGON 闭合轮廓少于三个顶点' }
	const first = points[0], last = points[points.length - 1]
	if (first.x !== last.x || first.y !== last.y) return { unsupported: 'POLYGON 轮廓未显式闭合' }
	for (let i = 1; i < points.length - 1; i++) {
		if (points[i].x === points[i - 1].x && points[i].y === points[i - 1].y) return { unsupported: 'POLYGON 含零长度连续边' }
	}
	return { polygon: { coordinateSpace: 'global-mil', points: points.slice(0, -1) } }
}
function state(object: any, method: string, name: string): any {
	const getter = object?.[`getState_${method}`]
	if (typeof getter !== 'function') throw new Error(`KiRouting 输入 ${name} 缺少 getState_${method}`)
	return getter.call(object)
}
function polygonSource(object: any, name: string): unknown[] {
	const polygon = state(object, 'ComplexPolygon', name)
	const source = polygon?.getSource?.()
	if (!Array.isArray(source) || source.length < 3) throw new Error(`KiRouting 输入 ${name} 缺少可解释的复杂多边形源码`)
	return source
}
const POURED_SOURCE_TO_MIL = 10
const POURED_ARC_CHORD_TOLERANCE_MIL = 0.01
function normalizePouredFillPathToMil(source: unknown): Array<Array<{ x: number, y: number }>> {
	if (!Array.isArray(source) || !source.length) throw new Error('实填充源码不是非空路径数组')
	const rawRings = Array.isArray(source[0]) ? source as unknown[][] : [source as unknown[]]
	const point = (x: unknown, y: unknown): { x: number, y: number } => {
		if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) throw new Error('实填充路径含非有限坐标')
		return { x: x * POURED_SOURCE_TO_MIL, y: y * POURED_SOURCE_TO_MIL }
	}
	const rings = rawRings.map((raw, ringIndex) => {
		if (!Array.isArray(raw) || raw.length < 4 || typeof raw[0] !== 'number' || typeof raw[1] !== 'number') throw new Error(`实填充第${ringIndex + 1}环起点无效`)
		const points = [point(raw[0], raw[1])]
		let current = points[0]
		for (let index = 2; index < raw.length;) {
			const token = raw[index]
			if (token === 'L') {
				if (index + 2 >= raw.length) throw new Error(`实填充第${ringIndex + 1}环L缺少终点`)
				current = point(raw[index + 1], raw[index + 2]); points.push(current); index += 3; continue
			}
			if (token === 'ARC') {
				if (index + 3 >= raw.length || typeof raw[index + 1] !== 'number' || !Number.isFinite(raw[index + 1])) throw new Error(`实填充第${ringIndex + 1}环ARC参数无效`)
				const sweepDegrees = raw[index + 1] as number
				const end = point(raw[index + 2], raw[index + 3])
				if (Math.abs(sweepDegrees) < 1e-9 || Math.abs(sweepDegrees) >= 360) throw new Error(`实填充第${ringIndex + 1}环ARC角度无效`)
				const dx = end.x - current.x, dy = end.y - current.y
				const chord = Math.hypot(dx, dy), sweep = sweepDegrees * Math.PI / 180
				const sinHalf = Math.sin(Math.abs(sweep) / 2), tanHalf = Math.tan(sweep / 2)
				if (chord <= 1e-9 || Math.abs(sinHalf) <= 1e-9 || Math.abs(tanHalf) <= 1e-9) throw new Error(`实填充第${ringIndex + 1}环ARC弦长无效`)
				const radius = chord / (2 * sinHalf)
				const offset = chord / (2 * tanHalf)
				const centerX = (current.x + end.x) / 2 - dy / chord * offset
				const centerY = (current.y + end.y) / 2 + dx / chord * offset
				const startAngle = Math.atan2(current.y - centerY, current.x - centerX)
				const maxStep = radius <= POURED_ARC_CHORD_TOLERANCE_MIL
					? Math.PI / 2
					: 2 * Math.acos(Math.max(-1, 1 - POURED_ARC_CHORD_TOLERANCE_MIL / radius))
				const count = Math.max(1, Math.ceil(Math.abs(sweep) / Math.max(maxStep, 1e-6)))
				for (let step = 1; step < count; step++) {
					const angle = startAngle + sweep * step / count
					points.push({ x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle) })
				}
				points.push(end); current = end; index += 4; continue
			}
			if (typeof token === 'number' && typeof raw[index + 1] === 'number') {
				current = point(token, raw[index + 1]); points.push(current); index += 2; continue
			}
			throw new Error(`实填充第${ringIndex + 1}环含未支持路径指令 ${String(token)}`)
		}
		if (Math.hypot(current.x - points[0].x, current.y - points[0].y) > 1e-7) throw new Error(`实填充第${ringIndex + 1}环未闭合`)
		points.pop()
		if (points.length < 3) throw new Error(`实填充第${ringIndex + 1}环少于三个顶点`)
		return points
	})
	return rings
}
function normalizePouredStrokePathToMil(source: unknown): Array<Array<{ x: number, y: number }>> {
	if (!Array.isArray(source) || !source.length) throw new Error('开口实填路径不是非空数组')
	const paths = Array.isArray(source[0]) ? source as unknown[][] : [source as unknown[]]
	return paths.map((raw, pathIndex) => {
		if (!Array.isArray(raw) || raw.length < 5 || typeof raw[0] !== 'number' || typeof raw[1] !== 'number') throw new Error(`开口实填第${pathIndex + 1}路起点无效`)
		const points = [{ x: raw[0] * POURED_SOURCE_TO_MIL, y: raw[1] * POURED_SOURCE_TO_MIL }]
		for (let index = 2; index < raw.length;) {
			if (raw[index] === 'L') index++
			if (index + 1 >= raw.length || typeof raw[index] !== 'number' || !Number.isFinite(raw[index]) || typeof raw[index + 1] !== 'number' || !Number.isFinite(raw[index + 1])) throw new Error(`开口实填第${pathIndex + 1}路含未知指令或无效直线终点`)
			points.push({ x: (raw[index] as number) * POURED_SOURCE_TO_MIL, y: (raw[index + 1] as number) * POURED_SOURCE_TO_MIL })
			index += 2
		}
		if (points.length < 2 || points.every(point => point.x === points[0].x && point.y === points[0].y)) throw new Error(`开口实填第${pathIndex + 1}路没有有效线段`)
		return points
	})
}
async function guarded<T>(ctx: any, action: () => Promise<T>, label: string): Promise<T> {
	ctx.stopSignal?.assertActive()
	if (typeof ctx.assertDocumentTarget !== 'function') throw new Error('KiRouting 缺少文档目标守卫')
	await ctx.assertDocumentTarget()
	const value = await action()
	await ctx.assertDocumentTarget()
	ctx.stopSignal?.assertActive()
	if (value == null) throw new Error(`KiRouting 读取 ${label} 失败`)
	return value
}
async function digest(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value))
	if (!globalThis.crypto?.subtle) throw new Error('当前运行环境缺少 SHA-256，不能为 KiRouting 输入生成身份摘要')
	const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function mmToMil(value: unknown): number | null {
	const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
	return Number.isFinite(numeric) ? numeric * 1000 / 25.4 : null
}

function idParts(value: unknown): unknown[] {
	if (typeof value !== 'string') return []
	try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}

interface ResolvedNetRuleRows { valid: boolean, safeSpacingDefault: boolean, viaDefault: boolean, rows: Array<Record<string, any>>, byNet: Map<string, Record<string, any>>, groups: Map<string, Set<string>> }

function isStrictEmptySelector(record: Record<string, unknown>): boolean {
	if (typeof record.id !== 'string') return false
	const data = record.data as any
	if (!data || typeof data !== 'object' || Array.isArray(data)
		|| Object.keys(data).sort().join(',') !== 'copperValue,innerPlaneValue,parent,ruleKeyValue,ruleOrder'
		|| data.ruleOrder !== 4 || data.parent !== null) return false
	const empty = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
	return empty(data.ruleKeyValue) && empty(data.copperValue) && empty(data.innerPlaneValue)
}

function isStrictEmptyUnconnectedNetSelector(record: Record<string, unknown>): boolean {
	if (typeof record.id !== 'string') return false
	const parts = idParts(record.id), scope = parts[1] as unknown[] | undefined, data = record.data as any
	if (parts.length !== 2 || parts[0] !== 'RULE_SELECTOR' || !Array.isArray(scope) || scope.length !== 2 || scope[0] !== 'NET' || scope[1] !== '') return false
	if (!data || typeof data !== 'object' || Array.isArray(data)
		|| Object.keys(data).sort().join(',') !== 'copperValue,innerPlaneValue,parent,ruleKeyValue,ruleOrder'
		|| data.ruleOrder !== 4 || data.parent !== null) return false
	const empty = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
	const lengthDefault = data.ruleKeyValue !== null && typeof data.ruleKeyValue === 'object' && !Array.isArray(data.ruleKeyValue)
		&& Object.keys(data.ruleKeyValue).length === 1 && Object.keys(data.ruleKeyValue)[0] === 'NET_LENGTH_TOLERANCE'
		&& Array.isArray(data.ruleKeyValue.NET_LENGTH_TOLERANCE) && data.ruleKeyValue.NET_LENGTH_TOLERANCE.length === 2
		&& data.ruleKeyValue.NET_LENGTH_TOLERANCE[0] === 'default' && data.ruleKeyValue.NET_LENGTH_TOLERANCE[1] === null
	return (empty(data.ruleKeyValue) || lengthDefault) && empty(data.copperValue) && empty(data.innerPlaneValue)
}

function resolveNetRuleRows(netRules: unknown, sourceRuleRecords: Array<Record<string, unknown>>, ruleToSourceNet?: Map<string, string>): ResolvedNetRuleRows {
	const rows = Array.isArray(netRules) ? netRules as Array<Record<string, any>> : []
	const byNet = new Map<string, Record<string, any>>()
	const groups = new Map<string, Set<string>>()
	let valid = Array.isArray(netRules)
	let safeSpacingDefault = true, viaDefault = true
	const sourceNets = new Map<string, string | null>()
	for (const record of sourceRuleRecords.filter(record => record.type === 'NET')) {
		const parts = idParts(record.id)
		const name = parts.length === 2 && parts[0] === 'NET' && typeof parts[1] === 'string' ? parts[1] : undefined
		const data = record.data as any
		if (name === undefined || (name !== '' && !name.trim()) || sourceNets.has(name) || !data || typeof data !== 'object' || Array.isArray(data)) { valid = false; continue }
		const groupName = data.equalLengthGroupName
		if (groupName !== null && (typeof groupName !== 'string' || !groupName.trim())) { valid = false; continue }
		sourceNets.set(name, groupName)
		if (groupName) {
			const members = groups.get(groupName) ?? new Set<string>()
			members.add(name)
			groups.set(groupName, members)
		}
	}
	const groupSelectors = new Map<string, Record<string, unknown>[]>(), unexpectedGroupSelector = { value: false }
	for (const record of sourceRuleRecords.filter(record => record.type === 'RULE_SELECTOR')) {
		const parts = idParts(record.id), scope = parts[1]
		if (!Array.isArray(scope) || scope[0] !== 'EQ_LEN_GRP') continue
		const groupName = typeof scope[1] === 'string' ? scope[1] : ''
		if (parts.length !== 2 || !groupName.trim() || typeof record.id !== 'string') { unexpectedGroupSelector.value = true; continue }
		const list = groupSelectors.get(groupName) ?? []
		list.push(record)
		groupSelectors.set(groupName, list)
	}
	if ([...groupSelectors.keys()].some(name => !groups.has(name)) || groupSelectors.size !== groups.size) valid = false
	for (const [name, members] of groups) {
		if (members.size < 2 || !groupSelectors.has(name) || groupSelectors.get(name)!.length !== 1 || !isStrictEmptySelector(groupSelectors.get(name)![0])) valid = false
	}
	if (unexpectedGroupSelector.value) valid = false
	const sdkGroups = rows.filter(row => row?.type === 'equalLengthGroup')
	const sdkGroupNames = sdkGroups.map(group => group?.name)
	if (sdkGroups.length !== groups.size || sdkGroups.some(group => typeof group?.name !== 'string' || !group.name.trim() || !Array.isArray(group.sub))
		|| new Set(sdkGroupNames).size !== sdkGroupNames.length || sdkGroupNames.some(name => !groups.has(name))) valid = false
	const seenMembers = new Set<string>()
	const inspectDefaults = (row: any): void => {
		if (row?.['Safe Spacing'] !== 'default') safeSpacingDefault = false
		if (row?.['Via Size'] !== 'default') viaDefault = false
	}
	for (const group of sdkGroups) {
		if (typeof group?.name !== 'string' || !group.name.trim() || !Array.isArray(group.sub) || !groups.has(group.name)) { valid = false; continue }
		inspectDefaults(group)
		const children = group.sub
		const childNames: string[] = []
		for (const child of children) {
			if (child?.type !== 'net' || typeof child.name !== 'string' || !child.name.trim() || child.sub !== undefined) { valid = false; continue }
			inspectDefaults(child)
			const sourceName = ruleToSourceNet?.get(child.name) ?? child.name
			childNames.push(sourceName)
			if (seenMembers.has(sourceName) || byNet.has(sourceName)) valid = false
			seenMembers.add(sourceName)
			byNet.set(sourceName, child)
		}
		if (new Set(childNames).size !== childNames.length || JSON.stringify([...childNames].sort()) !== JSON.stringify([...(groups.get(group.name) ?? [])].sort())) valid = false
	}
	for (const row of rows.filter(item => item?.type === 'net')) {
		if (typeof row.name !== 'string' || !row.name.trim() || row.sub !== undefined) { valid = false; continue }
		inspectDefaults(row)
		const sourceName = ruleToSourceNet?.get(row.name) ?? row.name
		if (byNet.has(sourceName) || seenMembers.has(sourceName)) valid = false
		const sourceGroup = sourceNets.get(sourceName)
		if (sourceGroup !== null || !sourceNets.has(sourceName)) valid = false
		byNet.set(sourceName, row)
	}
	for (const [name, groupName] of sourceNets) {
		if (name === '') { if (!isStrictEmptyUnconnectedNetScope(sourceRuleRecords, netRules)) valid = false; continue }
		if (groupName === null && !byNet.has(name)) valid = false
		if (groupName !== null && !seenMembers.has(name)) valid = false
	}
	if ([...byNet.keys()].some(name => !sourceNets.has(name))) valid = false
	return { valid, safeSpacingDefault, viaDefault, rows, byNet, groups }
}

function isStrictEmptyUnconnectedNetScope(sourceRuleRecords: Array<Record<string, unknown>>, netRules: unknown): boolean {
	const nets = sourceRuleRecords.filter(record => record.type === 'NET' && idParts(record.id).length === 2 && idParts(record.id)[0] === 'NET' && idParts(record.id)[1] === '')
	const selectors = sourceRuleRecords.filter(record => {
		const parts = idParts(record.id), scope = parts[1] as unknown[] | undefined
		return record.type === 'RULE_SELECTOR' && parts.length === 2 && parts[0] === 'RULE_SELECTOR' && Array.isArray(scope) && scope[0] === 'NET' && scope[1] === ''
	})
	if (nets.length !== 1 || selectors.length !== 1 || !isStrictEmptyUnconnectedNetSelector(selectors[0])) return false
	const net = nets[0].data as any
	if (typeof nets[0].id !== 'string' || !net || typeof net !== 'object' || Array.isArray(net)
		|| Object.keys(net).sort().join(',') !== 'differentialName,equalLengthGroupName,isPositiveNet,netType,retLine,specialColor'
		|| net.netType !== null || net.differentialName !== null || net.equalLengthGroupName !== null || net.isPositiveNet !== false || net.retLine !== true || net.specialColor !== null) return false
	const rows = Array.isArray(netRules) ? netRules as any[] : []
	let valid = Array.isArray(netRules)
	const inspect = (items: any[]): void => { for (const row of items) {
		if (row?.type === 'net' && (typeof row.name !== 'string' || !row.name.trim() || row.sub !== undefined)) valid = false
		if (row?.sub !== undefined) { if (Array.isArray(row.sub)) inspect(row.sub); else valid = false }
	} }
	inspect(rows)
	return valid
}

export function extractRuleEvidence(configuration: any, netRules: any, netNames: string[], sourceRuleRecords: Array<Record<string, unknown>>, routingConfig: ReturnType<typeof buildRoutingWidthSnapshot>, netAliases: RoutingNetAlias[]) {
	const config = configuration?.config
	const spacingProfiles = config?.Spacing?.['Safe Spacing']
	const activeSpacingProfiles = Object.entries(spacingProfiles ?? {}).filter(([, profile]: [string, any]) => profile?.isSetDefault === true && profile?.unit === 'mm')
	const spacing = activeSpacingProfiles.length === 1 ? activeSpacingProfiles[0][1] as any : undefined
	const table = spacing?.tables?.['1']
	const rows: string[] = Array.isArray(spacing?.row) ? spacing.row : []
	const columns: string[] = Array.isArray(spacing?.column) ? spacing.column : []
	const matrix = Array.isArray(table?.content) ? table.content.map((row: unknown) => Array.isArray(row) ? row.map(Number) : typeof row === 'string' ? row.trim().split(/\s+/).map(Number) : []) : []
	const getSpacing = (rowName: string, columnName: string): number | null => {
		const row = rows.indexOf(rowName), column = columns.indexOf(columnName)
		if (row < 0 || column < 0 || !Number.isFinite(row) || !Number.isFinite(column)) return null
		const values = matrix[Math.max(row, column)]
		const value = values?.[Math.min(row, column)]
		return mmToMil(value)
	}
	const ruleToSourceNet = new Map(netAliases.filter(alias => alias.status === 'known' && alias.ruleNet && alias.sourceNet).map(alias => [alias.ruleNet!, alias.sourceNet!]))
	const resolvedNetRules = resolveNetRuleRows(netRules, sourceRuleRecords, ruleToSourceNet)
	const sourceNetNames = new Set(sourceRuleRecords.filter(record => record.type === 'NET').map(record => idParts(record.id)[1]).filter((name): name is string => typeof name === 'string'))
	const safeRuleDefaults = sourceRuleRecords.filter(record => {
		const parts = idParts(record.id)
		return record.type === 'RULE' && parts[0] === 'RULE' && parts[1] === 'SAFE' && (record.data as any)?.ruleState === 'DEFAULT'
	})
	const activeSpacingName = String(spacing?.editName ?? activeSpacingProfiles[0]?.[0] ?? '')
	const boundSafeRule = activeSpacingProfiles.length === 1 && safeRuleDefaults.length === 1 && idParts(safeRuleDefaults[0].id)[2] === activeSpacingName
		&& (safeRuleDefaults[0].data as any)?.ruleContext?.unit === 'mm'
	const netRulesDefault = resolvedNetRules.valid && resolvedNetRules.safeSpacingDefault && resolvedNetRules.byNet.size > 0 && [...resolvedNetRules.byNet.keys()].every(name => sourceNetNames.has(name))
	const sourceNameByGeometry = new Map(netAliases.filter(alias => alias.status === 'known' && alias.sourceNet).map(alias => [alias.geometryNet, alias.sourceNet!]))
	const netRuleRowsExist = resolvedNetRules.valid && netNames.every(name => {
		const sourceName = sourceNameByGeometry.get(name) ?? name
		return resolvedNetRules.byNet.has(sourceName) && resolvedNetRules.byNet.get(sourceName)?.['Safe Spacing'] === 'default'
	})
	const sourceNetClasses = new Set(sourceRuleRecords.filter(record => record.type === 'NET').map(record => (record.data as any)?.netType).filter((name): name is string => typeof name === 'string' && name.length > 0))
	const selectedScopes = new Set([...sourceNetNames, ...sourceNetClasses])
	const sourceSafeOverridesClear = sourceRuleRecords.filter(record => record.type === 'RULE_SELECTOR').every(record => {
		const parts = idParts(record.id), scope = parts[1]
		if (Array.isArray(scope) && scope[0] === 'EQ_LEN_GRP') return parts.length === 2 && typeof scope[1] === 'string' && resolvedNetRules.valid && resolvedNetRules.groups.has(scope[1]) && isStrictEmptySelector(record)
		if (Array.isArray(scope) && scope[0] === 'NET' && scope[1] === '') return isStrictEmptyUnconnectedNetScope(sourceRuleRecords, netRules)
		if (Array.isArray(scope) && scope[0] === 'POUR') return proveEquivalentPourSafeSelector(record as any, sourceRuleRecords as any, configuration).verified
		const data = record.data as any
		if (!data || typeof data !== 'object' || Array.isArray(data)) return false
		const ruleKeys = data.ruleKeyValue
		const empty = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
		if (!ruleKeys || typeof ruleKeys !== 'object' || Array.isArray(ruleKeys)) return false
		const selectedSafe = ruleKeys.SAFE
		const safeIsEmpty = selectedSafe === undefined || empty(selectedSafe)
		const copperIsEmpty = empty(data.copperValue) || data.copperValue == null
		const planeIsEmpty = empty(data.innerPlaneValue) || data.innerPlaneValue == null
		if (safeIsEmpty && copperIsEmpty && planeIsEmpty) return true
		if (!Array.isArray(scope) || scope.length !== 2 || !['NET', 'NET_CLASS'].includes(String(scope[0])) || !selectedScopes.has(String(scope[1]))) return false
		const safeMatchesDefault = selectedSafe === undefined || empty(selectedSafe) || selectedSafe === activeSpacingName
		return safeMatchesDefault && copperIsEmpty && planeIsEmpty && data.ruleOrder === 4 && data.parent === null
	})
	const spacingDefaultBound = Boolean(boundSafeRule && netRulesDefault && netRuleRowsExist && sourceSafeOverridesClear)
	const classes = ['Track', 'SMD Pad', 'TH Pad', 'Via', 'Fill Region/Teardrop', 'Copper/Plane Zone']
	const spacings = classes.flatMap((row, rowIndex) => classes.slice(0, rowIndex + 1).map(column => getSpacing(row, column))).filter((value): value is number => value !== null)
	const clearance = spacings.length === classes.length * (classes.length + 1) / 2 ? Math.max(...spacings) : null
	const boardEdge = getSpacing('Board Outline', 'Track')
	const trackRule = config?.Physics?.Track
	const trackProfile = Object.values(trackRule ?? {}).find((profile: any) => profile?.isSetDefault === true && profile?.unit === 'mm') as any
	const trackTable = trackProfile?.form?.data?.['1']
	const trackWidth = mmToMil(trackTable?.defaultValue)
	const viaRule = config?.Physics?.['Via Size']?.viaSize
	const viaProfile = viaRule?.isSetDefault === true && viaRule?.unit === 'mm' ? viaRule?.form : undefined
	const viaDiameter = mmToMil(viaProfile?.viaOuterdiameterDefault)
	const viaDrill = mmToMil(viaProfile?.viaInnerdiameterDefault)
	const ruleNameByGeometry = new Map(netAliases.filter(alias => alias.status === 'known' && alias.ruleNet).map(alias => [alias.geometryNet, alias.ruleNet!]))
	const allSelectedWidths = netNames.map(name => routingConfig.nets.find(item => item.net === (ruleNameByGeometry.get(name) ?? name)))
	const selectedWidthsKnown = allSelectedWidths.length > 0 && allSelectedWidths.every(item => item?.status === 'known' && item.layers.length > 0 && item.layers.every(layer => layer.status === 'known'))
	const netTrackWidths = allSelectedWidths.map((item, index) => ({ net: netNames[index], ruleKey: item?.ruleKey ?? null, status: (item?.status === 'known' ? 'known' : 'unknown') as 'known' | 'unknown', layers: (item?.layers ?? []).map(layer => ({ layerId: layer.layerId, widthMil: Number.isFinite(layer.preferredMil) ? layer.preferredMil : null, source: `routingWidthSnapshot RULE TRACK ${item?.ruleKey ?? 'unknown'}` })) }))
	const selectedWidthValues = selectedWidthsKnown ? [...new Set(allSelectedWidths.flatMap(item => item!.layers.map(layer => layer.preferredMil)))] : []
	const oneUniformSelectedWidth = selectedWidthValues.length === 1
	const widthKnown = selectedWidthsKnown && oneUniformSelectedWidth && routingConfig.defaultRule.status === 'known'
	const viaRuleRecords = sourceRuleRecords.filter(record => record.type === 'RULE' && idParts(record.id)[0] === 'RULE' && idParts(record.id)[1] === 'RADIUS' && idParts(record.id)[2] === 'viaSize' && (record.data as any)?.ruleState === 'DEFAULT')
	const viaSourceBound = viaRuleRecords.length === 1 && resolvedNetRules.valid && resolvedNetRules.viaDefault
	const spacingKnown = spacingDefaultBound && clearance !== null && boardEdge !== null
	const viaDimensionsValid = viaDiameter !== null && viaDrill !== null && viaDrill > 0 && viaDiameter > viaDrill
	const viaKnown = spacingKnown && viaSourceBound && viaDimensionsValid
	const diffRule = config?.Physics?.['Differential Pair']?.differentialPair
	const diffSpacing = diffRule?.form?.diffPairSpacingTables
	const diffValues = diffSpacing?.data && typeof diffSpacing.data === 'object' ? Object.values(diffSpacing.data) as any[] : []
	const diffDefaults = diffValues.map(table => mmToMil(table?.defaultValue))
	const diffProfileName = String(diffRule?.editName ?? 'differentialPair')
	const diffSourceRules = sourceRuleRecords.filter(record => record.type === 'RULE' && idParts(record.id)[0] === 'RULE' && idParts(record.id)[1] === 'DIFFER_ENTAIL' && idParts(record.id)[2] === diffProfileName && (record.data as any)?.ruleState === 'DEFAULT')
	const diffSelectorOverrides = sourceRuleRecords.filter(record => record.type === 'RULE_SELECTOR').some(record => {
		const parts = idParts(record.id), scope = parts[1]
		if (!Array.isArray(scope) || scope.length !== 2) return true
		const data = record.data as any
		const keys = data?.ruleKeyValue && typeof data.ruleKeyValue === 'object' ? Object.keys(data.ruleKeyValue) : []
		return keys.some(key => ['DIFFER_ENTAIL', 'DIFFERENTIAL_PAIR', 'DIFF_PAIR'].includes(key))
	})
	const diffKnown = diffRule?.isSetDefault === true && diffRule?.unit === 'mm' && diffSpacing?.status === 1 && diffDefaults.length > 0 && diffDefaults.every(value => value !== null && value === diffDefaults[0]) && diffSourceRules.length === 1 && (diffSourceRules[0].data as any)?.ruleContext?.unit === 'mm' && !diffSelectorOverrides
	const differentialStatus: 'known' | 'unknown' = diffKnown ? 'known' : 'unknown'
	const source = 'pcb_Drc.getCurrentRuleConfiguration; SDK output unit:mm converted to mil (1 mm = 1000/25.4 mil)'
	const trackWidthStatus: 'known' | 'unknown' = widthKnown ? 'known' : 'unknown'
	const clearanceStatus: 'known' | 'unknown' = spacingKnown ? 'known' : 'unknown'
	const edgeStatus: 'known' | 'unknown' = spacingKnown ? 'known' : 'unknown'
	const viaStatus: 'known' | 'unknown' = viaKnown ? 'known' : 'unknown'
	return {
		trackWidth: { status: trackWidthStatus, mil: widthKnown ? selectedWidthValues[0] : null, source: widthKnown ? 'routingWidthSnapshot verified selected net/layer RULE TRACK widths' : 'selected net/layer TRACK rule binding is unknown or widths differ; use netTrackWidths for per-net handling' },
		globalClearance: { status: clearanceStatus, mil: clearanceStatus === 'known' ? clearance : null, source: clearanceStatus === 'known' ? `${source}; active SAFE DEFAULT profile source-bound; conservative maximum of Track/SMD Pad/TH Pad/Via/Fill/Copper-plane matrix pairs` : 'active SAFE profile/source/net-selector binding or full mapped matrix could not be proven' },
		boardEdgeClearance: { status: edgeStatus, mil: edgeStatus === 'known' ? boardEdge : null, source: edgeStatus === 'known' ? `${source}; active SAFE DEFAULT profile source-bound; Board Outline↔Track matrix cell` : 'active SAFE profile/source/net-selector binding could not be proven' },
		via: { status: viaStatus, diameterMil: viaDiameter, drillMil: viaDrill, source: viaKnown ? `${source}; source RULE RADIUS viaSize DEFAULT and SDK per-net Via Size default; validated diameter > drill > 0` : !viaDimensionsValid && viaDiameter !== null && viaDrill !== null ? `invalid active Via Size dimensions from source-bound SDK configuration: diameter ${viaDiameter} mil, drill ${viaDrill} mil; required diameter > drill > 0; raw configuration and source records retained in design_rules` : 'active via size rule could not be source-bound or complete' },
		differentialGap: { status: differentialStatus, mil: diffKnown ? diffDefaults[0] : null, minimumMil: diffKnown ? mmToMil(diffValues[0]?.minValue) : null, maximumMil: diffKnown ? mmToMil(diffValues[0]?.maxValue) : null, source: diffKnown ? `${source}; SDK Differential Pair spacing DEFAULT bound to source RULE DIFFER_ENTAIL DEFAULT` : 'active differential-pair gap profile/source selector binding could not be proven' },
		netTrackWidths,
	}
}

/** Collect a target-bound, mil-unit read-only routing snapshot. Missing geometry is reported and blocks start. */
export async function collectKiRoutingInput(api: any, ctx: any, target: KiRoutingTarget): Promise<KiRoutingInput> {
	const sourceBeforeRouteRead = String(await guarded(ctx, () => api.sys_FileManager.getDocumentSource(), '采集开始源码基线'))
	const route = await readRouteSnapshot(api, () => ctx.assertDocumentTarget())
	const routeSourceComparison = compareDocumentSources(sourceBeforeRouteRead, route.source)
	if (!routeSourceComparison.equal) throw new Error(`KiRouting 读取线路/图层期间 PCB 源码发生变化，拒绝生成混合输入：${routeSourceComparison.difference ?? '源码不匹配'}`)
	if (route.documentUuid !== target.documentUuid) throw new Error('KiRouting 焦点 PCB UUID 与目标不一致')
	const rawLines = await guarded(ctx, () => api.pcb_PrimitiveLine.getAll(), '所有 PCB 线段（含内电层）')
	const rawArcs = await guarded(ctx, () => api.pcb_PrimitiveArc.getAll(), '所有 PCB 圆弧（含内电层）')
	const componentsRaw = await guarded(ctx, () => api.pcb_PrimitiveComponent.getAll(), 'PCB 器件')
	const padsRaw = await guarded(ctx, () => api.pcb_PrimitivePad.getAll(), 'PCB 焊盘')
	const outlineRaw = await guarded(ctx, () => api.pcb_PrimitivePolyline.getAll(), 'PCB 板框折线')
	const fills = await guarded(ctx, () => api.pcb_PrimitiveFill.getAll(), 'PCB 填充障碍')
	const pours = await guarded(ctx, () => api.pcb_PrimitivePour.getAll(), 'PCB 覆铜边框关联')
	const poured = await guarded(ctx, () => api.pcb_PrimitivePoured.getAll(), 'PCB 实际覆铜填充')
	const regions = await guarded(ctx, () => api.pcb_PrimitiveRegion.getAll(), 'PCB 禁布/约束区域')
	if (![rawLines, rawArcs, componentsRaw, padsRaw, outlineRaw, fills, pours, poured, regions].every(Array.isArray)) throw new Error('KiRouting SDK 未返回完整线路/区域/器件/焊盘/板框/铜障碍数组')
	const outline = normalizeBoardOutlinePolylines(outlineRaw as any[])
	if (outline.issues.length || outline.lines.length < 3) throw new Error(`KiRouting 无法确认闭合板框：${outline.issues.join('; ') || '板框边数不足'}`)
	const unsupported: string[] = []
	const components = (componentsRaw as any[]).map((component: any) => {
		const id = String(state(component, 'PrimitiveId', '器件'))
		const footprint = state(component, 'Footprint', `器件 ${id}`)
		if (!footprint?.uuid) throw new Error(`KiRouting 器件 ${id} 缺少封装身份`)
		const summaries = component.getState_Pads?.()
		return {
			id,
			designator: String(state(component, 'Designator', `器件 ${id}`) ?? ''),
			name: String(state(component, 'Name', `器件 ${id}`) ?? ''),
			footprint: { uuid: String(footprint.uuid), name: String(footprint.name ?? '') },
			x: finite(state(component, 'X', `器件 ${id}`), `${id}.x`),
			y: finite(state(component, 'Y', `器件 ${id}`), `${id}.y`),
			rotation: finite(state(component, 'Rotation', `器件 ${id}`), `${id}.rotation`),
			layer: finite(state(component, 'Layer', `器件 ${id}`), `${id}.layer`),
			mirror: Boolean(component.getState_Mirror?.() ?? false),
			pads: Array.isArray(summaries) ? summaries.map((pad: any) => ({ id: String(pad.primitiveId), padNumber: String(pad.padNumber), net: String(pad.net ?? '') })) : null,
		}
	})
	const sourceComponentById = new Map<string, Record<string, any>>(route.sourceRecords.filter(record => record.type === 'COMPONENT').map(record => [record.id, record.data as Record<string, any>]))
	const componentObjectById = new Map<string, any>((componentsRaw as any[]).map(component => [String(state(component, 'PrimitiveId', '器件')), component]))
	const componentByPad = new Map<string, string>()
	const actualComponentPins = new Map<string, any>()
	const padsArray = padsRaw as any[]
	const sdkPadById = new Map<string, any>(padsArray.map((pad: any) => [String(pad.getState_PrimitiveId?.() ?? ''), pad]))
	for (const component of components) {
		if (typeof api.pcb_PrimitiveComponent.getAllPinsByPrimitiveId !== 'function') continue
		const pins = await guarded(ctx, async () => await api.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(String(component.id)) ?? [], `器件 ${String(component.id)} 的实际焊盘`)
		if (!Array.isArray(pins)) { unsupported.push(`component ${String(component.id)}: getAllPinsByPrimitiveId 未返回数组`); continue }
		for (const pin of pins) {
			const id = String(state(pin, 'PrimitiveId', `器件 ${String(component.id)} 焊盘`))
			const parent = String(state(pin, 'ParentComponentPrimitiveId', `器件焊盘 ${id}`))
			if (parent !== String(component.id)) { unsupported.push(`component pad ${id}: parent component id 不匹配`); continue }
			componentByPad.set(id, parent)
			actualComponentPins.set(id, pin)
			if (!sdkPadById.has(id)) sdkPadById.set(id, pin)
		}
	}
	for (const component of components) {
		const actualPins = [...actualComponentPins.entries()].filter(([, pin]) => String(pin.getState_ParentComponentPrimitiveId?.() ?? '') === String(component.id)).map(([id, pin]) => ({ id, padNumber: String(pin.getState_PadNumber?.() ?? ''), net: String(pin.getState_Net?.() ?? '') }))
		if (actualPins.length) component.pads = actualPins
		else {
			const summaries = (component.pads as Array<{ id: string, padNumber?: string, net?: string }> | null) ?? []
			const resolved: Array<{ id: string, padNumber: string, net: string }> = []
			for (const summary of summaries) {
				const matches = padsArray.filter((item: any) => String(item.getState_PrimitiveId?.() ?? '').endsWith(summary.id) && (!summary.padNumber || String(item.getState_PadNumber?.() ?? '') === String(summary.padNumber)) && (!summary.net || String(item.getState_Net?.() ?? '') === String(summary.net)))
				if (matches.length === 1) {
					const fullId = String(matches[0].getState_PrimitiveId())
					componentByPad.set(fullId, String(component.id))
					resolved.push({ id: fullId, padNumber: String(matches[0].getState_PadNumber?.() ?? summary.padNumber ?? ''), net: String(matches[0].getState_Net?.() ?? summary.net ?? '') })
				} else unsupported.push(`component ${String(component.id)} pad ${summary.id}: short id cannot be matched uniquely to full PCB pad id`)
			}
			component.pads = resolved
		}
	}
	const byDesignator = new Map<string, string>(components.map((component: any) => [String(component.designator), String(component.id)]))
	for (const record of route.sourceRecords) {
		if (record.type !== 'PAD') continue
		const data = record.data as any
		const id = String(record.id)
		const parent = data?.componentId ?? data?.componentPrimitiveId ?? data?.parentComponentId ?? data?.parentPrimitiveId ?? data?.parentId
		if (!componentByPad.has(id)) {
			if (typeof parent === 'string' && parent) componentByPad.set(id, parent)
			else if (typeof data?.designator === 'string' && byDesignator.has(data.designator)) componentByPad.set(id, byDesignator.get(data.designator) as string)
		}
	}
	const nets = new Map<string, Array<Record<string, unknown>>>()
	const unconnectedPads: Array<Record<string, unknown>> = []
	const excludedNonCopper: Array<{ id: string, kind: string, layer: number, layerType: string }> = []
	const layerType = (layerId: number): string | undefined => route.layers.find(layer => layer.id === layerId)?.type.toUpperCase()
	const copperLayer = (layerId: number, type: string | undefined): boolean => layerId === 12 || type === 'SIGNAL' || type === 'PLANE'
	const knownNonCopperLayer = (type: string | undefined): boolean => ['SILKSCREEN', 'SOLDER_MASK', 'PASTE_MASK', 'ASSEMBLY'].includes(type ?? '')
	const padsWithOffset = padsArray.filter((pad: any) => {
		const hole = state(pad, 'Hole', `焊盘 ${String(pad.getState_PrimitiveId?.() ?? '')}`)
		return hole && (finite(state(pad, 'HoleOffsetX', '焊盘孔偏移X'), 'holeOffsetX') !== 0 || finite(state(pad, 'HoleOffsetY', '焊盘孔偏移Y'), 'holeOffsetY') !== 0)
	})
	const footprintPadSources = new Map<string, Map<string, { source: string, data: Record<string, any> }>>()
	const uncertainEmbeddedFootprints = new Set<string>()
	if (padsWithOffset.length) {
		const embedded = typeof api.sys_FileManager?.getDocumentFootprintSources === 'function'
			? await guarded(ctx, () => api.sys_FileManager.getDocumentFootprintSources(), '偏孔焊盘关联封装精确来源')
			: undefined
		const grouped = new Map<string, Array<{ source: string, pads: Map<string, { source: string, data: Record<string, any> }> }>>()
		const seenFootprintUuids = new Set<string>()
		const declaredEmbeddedFootprints = new Set<string>()
		const addFootprintSource = (uuid: string, source: string): void => {
			try {
				const document = parseSourceLog(source)
				if (document.docType !== 'FOOTPRINT' || document.uuid !== uuid) return
				seenFootprintUuids.add(uuid)
				const conflictIds = new Set<string>()
				let invalidPadRecord = false
				const seenTickets = new Map<string, { ticket: number, data: string }>()
				for (const record of document.records.filter(record => record.header.type === 'PAD')) {
					const id = record.header.id
					const ticket = record.header.ticket
					if (typeof id !== 'string' || !id || !Number.isSafeInteger(ticket) || Number(ticket) < 0) { invalidPadRecord = true; if (typeof id === 'string') conflictIds.add(id); continue }
					const encoded = JSON.stringify(record.data)
					const previous = seenTickets.get(id)
					if (previous && previous.ticket === ticket && previous.data !== encoded) conflictIds.add(id)
					if (!previous || Number(ticket) >= previous.ticket) seenTickets.set(id, { ticket: Number(ticket), data: encoded })
				}
				if (invalidPadRecord) return
				const records = resolveRecords(document, 'PAD')
				const groupedByNumber = new Map<string, Array<{ source: string, data: Record<string, any> }>>()
				for (const record of records.values()) {
					if (conflictIds.has(String(record.header.id ?? ''))) continue
					const data = record.data as Record<string, any>
					if (data && typeof data === 'object' && !Array.isArray(data) && data.num !== undefined) {
						const number = String(data.num)
						const list = groupedByNumber.get(number) ?? []
						list.push({ source: record.header.id ?? '', data }); groupedByNumber.set(number, list)
					}
				}
				const byNumber = new Map([...groupedByNumber].filter(([, list]) => list.length === 1).map(([number, list]) => [number, list[0]]))
				const list = grouped.get(uuid) ?? []
				list.push({ source, pads: byNumber }); grouped.set(uuid, list)
			}
			catch { /* invalid or unrelated footprint source remains unavailable */ }
		}
		if (Array.isArray(embedded)) {
			for (const item of embedded) {
				if (!item || typeof item.footprintUuid !== 'string' || !item.footprintUuid) continue
				const uuid = item.footprintUuid
				declaredEmbeddedFootprints.add(uuid)
				if (typeof item.documentSource !== 'string') { uncertainEmbeddedFootprints.add(uuid); continue }
				try {
					const document = parseSourceLog(item.documentSource)
					if (document.docType !== 'FOOTPRINT' || document.uuid !== uuid) { uncertainEmbeddedFootprints.add(uuid); continue }
					addFootprintSource(uuid, item.documentSource)
				}
				catch { uncertainEmbeddedFootprints.add(uuid) }
			}
		}
		const requiredFootprints = new Set<string>()
		for (const pad of padsWithOffset) {
			const id = String(state(pad, 'PrimitiveId', '偏孔焊盘'))
			const parent = componentByPad.get(id)
			const componentObject = parent ? componentObjectById.get(parent) : undefined
			const footprint = componentObject ? state(componentObject, 'Footprint', `器件 ${parent}`) : undefined
			if (typeof footprint?.uuid === 'string' && footprint.uuid) requiredFootprints.add(footprint.uuid)
		}
		const fallbackFootprints = [...requiredFootprints].filter(uuid => !seenFootprintUuids.has(uuid) && !declaredEmbeddedFootprints.has(uuid))
		if (fallbackFootprints.length && typeof api.lib_LibrariesList?.getProjectLibraryUuid === 'function' && typeof api.lib_Footprint?.getDocumentSource === 'function') {
			const libraryUuid = await guarded(ctx, async () => {
				try { return await api.lib_LibrariesList.getProjectLibraryUuid() } catch { return undefined }
			}, '读取偏孔焊盘封装所属工程库')
			if (typeof libraryUuid === 'string' && libraryUuid.trim()) {
				for (const uuid of fallbackFootprints) {
					const source = await guarded(ctx, async () => {
						try { return await api.lib_Footprint.getDocumentSource(uuid, libraryUuid.trim()) } catch { return undefined }
					}, `读取工程库封装 ${uuid} 精确来源`)
					if (typeof source === 'string' && source.trim()) addFootprintSource(uuid, source)
				}
			}
		}
		for (const [uuid, variants] of grouped) {
			if (uncertainEmbeddedFootprints.has(uuid)) continue
			if (new Set(variants.map(item => item.source)).size !== 1) continue
			footprintPadSources.set(uuid, variants[0].pads)
		}
	}
	for (const pad of sdkPadById.values()) {
		const id = String(state(pad, 'PrimitiveId', '焊盘'))
		const componentId = componentByPad.get(id)
		const net = String(state(pad, 'Net', `焊盘 ${id}`) ?? '')
		const shape = state(pad, 'Pad', `焊盘 ${id}`)
		if (!Array.isArray(shape)) { unsupportedPad(id, '外形不可解释'); continue }
		const polygonGeometry = simpleGlobalPolygon(shape)
		if (polygonGeometry.unsupported) unsupportedPad(id, polygonGeometry.unsupported)
		let rectangleCorner: { cornerRadiusMil: number, cornerRadiusSource: string } | undefined
		if (['RECT', 'RECTANGLE'].includes(String(shape[0]).toUpperCase())) {
			const width = shape[1], height = shape[2], round = shape[3]
			if (shape.length !== 4 || typeof width !== 'number' || !Number.isFinite(width) || width <= 0
				|| typeof height !== 'number' || !Number.isFinite(height) || height <= 0
				|| typeof round !== 'number' || !Number.isFinite(round) || round < 0 || round > 100) {
				unsupportedPad(id, `矩形焊盘圆角字段无效（width=${String(width)}, height=${String(height)}, round=${String(round)}；要求宽高为正有限数且 round 在 0..100）`)
			} else {
				rectangleCorner = { cornerRadiusMil: Math.min(width, height) * round / 200, cornerRadiusSource: 'sdk-rect-half-min-side-percent' }
			}
		}
		const hole = state(pad, 'Hole', `焊盘 ${id}`)
		const specialShape = pad.getState_SpecialPad?.() ?? null
		const holeOffsetX = hole ? finite(state(pad, 'HoleOffsetX', `焊盘 ${id}`), `${id}.holeOffsetX`) : 0
		const holeOffsetY = hole ? finite(state(pad, 'HoleOffsetY', `焊盘 ${id}`), `${id}.holeOffsetY`) : 0
		const holeRotation = hole ? finite(state(pad, 'HoleRotation', `焊盘 ${id}`), `${id}.holeRotation`) : 0
		if (Array.isArray(specialShape) && specialShape.length) unsupportedPad(id, '按铜层区分的 specialPad 外形尚未转换')
		const holeType = Array.isArray(hole) ? String(hole[0]).toUpperCase() : ''
		if (String(shape[0]).toUpperCase() === 'POLYGON' && hole) unsupportedPad(id, '带钻孔的 POLYGON 焊盘尚未转换')
		if (holeType && holeType !== 'ROUND') unsupportedPad(id, `钻孔类型 ${holeType} 尚未转换`)
		if (holeType && holeType !== 'ROUND' && holeRotation !== 0) unsupportedPad(id, `非圆孔旋转尚未转换 (rotation=${holeRotation})`)
		const padLayer = finite(state(pad, 'Layer', `焊盘 ${id}`), `${id}.layer`)
		const padLayerInfo = route.layers.find(layer => layer.id === padLayer)
		const padLayerType = padLayerInfo?.type.toUpperCase()
		const copperPadLayer = padLayer === 12 || padLayerType === 'SIGNAL' || padLayerType === 'PLANE'
		const knownNonCopperPadLayer = ['SILKSCREEN', 'SOLDER_MASK', 'PASTE_MASK', 'ASSEMBLY'].includes(padLayerType ?? '')
		if (!copperPadLayer && !knownNonCopperPadLayer) unsupportedPad(id, `焊盘层 ${padLayer} 类型 ${padLayerType ?? 'unknown'} 不能判定为铜层或明确非铜层`)
		if (knownNonCopperPadLayer && !hole) {
			excludedNonCopper.push({ id, kind: 'pad', layer: padLayer, layerType: padLayerType! })
			continue
		}
		let x = finite(state(pad, 'X', `焊盘 ${id}`), `${id}.x`), y = finite(state(pad, 'Y', `焊盘 ${id}`), `${id}.y`)
		let rotation = finite(state(pad, 'Rotation', `焊盘 ${id}`), `${id}.rotation`)
		let outputShape = shape
		let outputHole = Array.isArray(hole) ? hole : null
		let holeCenterX: number | undefined, holeCenterY: number | undefined
		let sourceHoleOffsetX = holeOffsetX, sourceHoleOffsetY = holeOffsetY
		if (hole && (holeOffsetX !== 0 || holeOffsetY !== 0)) {
			const padNumber = String(state(pad, 'PadNumber', `焊盘 ${id}`))
			const componentSource = componentId ? sourceComponentById.get(componentId) : undefined
			const componentObject = componentId ? componentObjectById.get(componentId) : undefined
			const footprint = componentObject ? state(componentObject, 'Footprint', `器件 ${componentId}`) : undefined
			const sourcePad = footprint?.uuid ? footprintPadSources.get(String(footprint.uuid))?.get(padNumber) : undefined
			const sourceIdentityUnknown = typeof footprint?.uuid === 'string' && uncertainEmbeddedFootprints.has(footprint.uuid)
			const sourceData = sourcePad?.data
			const sourceShape = sourceData?.defaultPad
			const sourceHole = sourceData?.hole
			const sourceNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
			const holeDimensions = Array.isArray(sourceHole) && String(sourceHole[0]).toUpperCase() === 'ROUND' && sourceNumber(sourceHole[1]) !== undefined && sourceNumber(sourceHole[2]) !== undefined
				? { type: 'ROUND', width: sourceHole[1], height: sourceHole[2] }
				: sourceHole && typeof sourceHole === 'object' && String(sourceHole.holeType ?? sourceHole.type ?? '').toUpperCase() === 'ROUND' && sourceNumber(sourceHole.width) !== undefined && sourceNumber(sourceHole.height) !== undefined
					? { type: 'ROUND', width: sourceHole.width, height: sourceHole.height }
					: undefined
			const sourcePadLayer = sourceNumber(sourceData?.layerId)
			const sourceComponentX = sourceNumber(componentSource?.x)
			const sourceComponentY = sourceNumber(componentSource?.y)
			const sourceComponentAngle = sourceNumber(componentSource?.angle)
			const sourceLayer = sourceNumber(componentSource?.layerId)
			const sourceCenterX = sourceNumber(sourceData?.centerX)
			const sourceCenterY = sourceNumber(sourceData?.centerY)
			const sourcePadAngle = sourceNumber(sourceData?.padAngle)
			const sourceOffsetX = sourceNumber(sourceData?.padOffsetX)
			const sourceOffsetY = sourceNumber(sourceData?.padOffsetY)
			const localShape = sourceShape && typeof sourceShape === 'object' && !Array.isArray(sourceShape) ? sourceShape : undefined
			const sourceWidth = sourceNumber(localShape?.width), sourceHeight = sourceNumber(localShape?.height)
			const sourceDiameter = localShape?.padType === 'ELLIPSE' && sourceWidth !== undefined && sourceWidth > 0 && sourceHeight === sourceWidth ? sourceWidth : undefined
			const sdkWidth = sourceNumber(shape[1]), sdkHeight = sourceNumber(shape[2])
			const sdkDiameter = String(shape[0]).toUpperCase() === 'ELLIPSE' && sdkWidth !== undefined && sdkWidth > 0 && sdkHeight === sdkWidth ? sdkWidth : undefined
			const plated = Boolean(pad.getState_Metallization?.())
			const sdkRotation = finite(state(pad, 'Rotation', `焊盘 ${id}`), `${id}.rotation`)
			const sdkHoleDiameter = Array.isArray(hole) ? sourceNumber(hole[1]) : undefined
			if (!sourcePad || !sourceData || !componentSource || sourcePadLayer === undefined || sourceComponentX === undefined || sourceComponentY === undefined || sourceComponentAngle === undefined || sourceLayer === undefined || sourceCenterX === undefined || sourceCenterY === undefined || sourcePadAngle === undefined || sourceOffsetX === undefined || sourceOffsetY === undefined
				|| String(sourceData.padType ?? '').toUpperCase() !== 'NORMAL' || !Array.isArray(sourceData.specialPad) || sourceData.specialPad.length !== 0
				|| !holeDimensions || !(holeDimensions.width > 0) || holeDimensions.width !== holeDimensions.height || !sdkHoleDiameter || Math.abs(holeDimensions.width - sdkHoleDiameter) > 0.051 || !sourceDiameter || !sdkDiameter || Math.abs(sourceDiameter - sdkDiameter) > 0.051
				|| sourcePadLayer !== 12 || sourceLayer !== 1 || padLayer !== 12 || state(componentObject, 'Layer', `器件 ${componentId}`) !== 1 || Boolean(componentObject?.getState_Mirror?.())
				|| !plated || sourceData.plated !== true || holeRotation !== 0 || sourceData.relativeAngle != null && sourceData.relativeAngle !== 0
				|| sourceOffsetX !== holeOffsetX || sourceOffsetY !== holeOffsetY || !Array.isArray(sourceHole) && (!sourceHole || typeof sourceHole !== 'object')) {
				unsupportedPad(id, sourceIdentityUnknown
					? '偏孔封装来源不确定：嵌入项声明的封装 UUID 与 DOCHEAD 不一致或无法解析，已禁止回退到工程库来源'
					: '偏孔只支持来源明确、未镜像顶层器件上的金属化圆形焊盘及 ROUND 圆孔，且焊盘编号、形状、尺寸、偏移必须与封装源码一致')
			}
			else {
				const copperAngle = sourceComponentAngle
				const padAngle = sourceComponentAngle + sourcePadAngle
				const copperRadians = copperAngle * Math.PI / 180
				const copperCos = Math.cos(copperRadians), copperSin = Math.sin(copperRadians)
				const padRadians = padAngle * Math.PI / 180
				const padCos = Math.cos(padRadians), padSin = Math.sin(padRadians)
				const sourceX = sourceComponentX! + sourceCenterX! * copperCos - sourceCenterY! * copperSin
				const sourceY = sourceComponentY! + sourceCenterX! * copperSin + sourceCenterY! * copperCos
				const sdkX = finite(state(pad, 'X', `焊盘 ${id}`), `${id}.x`), sdkY = finite(state(pad, 'Y', `焊盘 ${id}`), `${id}.y`)
				const angleDifference = Math.abs(((sdkRotation - padAngle + 540) % 360) - 180)
				if (Math.abs(sourceX - sdkX) > 0.051 || Math.abs(sourceY - sdkY) > 0.051 || angleDifference > 0.051) unsupportedPad(id, `偏孔精确封装中心与 SDK 焊盘读回无法对应（source=${sourceX},${sourceY},${padAngle}；sdk=${sdkX},${sdkY},${sdkRotation}）`)
				else {
					x = sourceX; y = sourceY; rotation = padAngle
					outputShape = ['ELLIPSE', sourceDiameter, sourceDiameter]
					outputHole = ['ROUND', holeDimensions.width, holeDimensions.height]
					sourceHoleOffsetX = sourceOffsetX!; sourceHoleOffsetY = sourceOffsetY!
					holeCenterX = sourceX + sourceOffsetX! * padCos - sourceOffsetY! * padSin
					holeCenterY = sourceY + sourceOffsetX! * padSin + sourceOffsetY! * padCos
				}
			}
		}
		const item = { id, componentId: componentId ?? null, padNumber: String(state(pad, 'PadNumber', `焊盘 ${id}`)), x, y, rotation, layer: padLayer, shape: outputShape, ...(rectangleCorner ?? {}), ...(polygonGeometry.polygon ? { polygon: polygonGeometry.polygon } : {}), specialShape, hole: outputHole, holeOffsetX: sourceHoleOffsetX, holeOffsetY: sourceHoleOffsetY, holeRotation, plated: Boolean(pad.getState_Metallization?.()), ...(holeCenterX !== undefined && holeCenterY !== undefined ? { holeCenterX, holeCenterY, holeCenterSource: 'bound-footprint-source', holeOffsetSource: 'bound-footprint-source' } : {}) }
		if (knownNonCopperPadLayer && hole) { unconnectedPads.push({ ...item, net: net || '', obstacleOnly: true }); continue }
		if (!net) { unconnectedPads.push(item); continue }
		const list = nets.get(net) ?? []
		list.push(item)
		nets.set(net, list)
	}
	function unsupportedPad(id: string, reason: string): void { unsupported.push(`pad ${id}: ${reason}`) }
	const existingCopperObstacles: Array<Record<string, unknown>> = []
	for (const arc of route.arcs) unsupported.push(`existing arc ${arc.id}: 当前路由引擎输入未声明与 EDA 弧线角度一致的几何转换`)
	const snapshotLineIds = new Set(route.lines.map(line => line.id))
	const planeLines: Array<Record<string, unknown>> = []
	for (const item of rawLines as any[]) {
		const id = String(state(item, 'PrimitiveId', '走线'))
		const layer = finite(state(item, 'Layer', `走线 ${id}`), `${id}.layer`)
		const type = layerType(layer)
		if (type === 'SIGNAL') {
			if (!snapshotLineIds.has(id)) unsupported.push(`line ${id}: SIGNAL铜线未进入route snapshot，拒绝静默丢线`)
			continue
		}
		if (type === 'PLANE') {
			planeLines.push({ id, net: String(state(item, 'Net', `走线 ${id}`) ?? ''), layer, widthMil: finite(state(item, 'LineWidth', `走线 ${id}`), `${id}.lineWidth`), a: { x: finite(state(item, 'StartX', `走线 ${id}`), `${id}.startX`), y: finite(state(item, 'StartY', `走线 ${id}`), `${id}.startY`) }, b: { x: finite(state(item, 'EndX', `走线 ${id}`), `${id}.endX`), y: finite(state(item, 'EndY', `走线 ${id}`), `${id}.endY`) }, locked: Boolean(item.getState_PrimitiveLock?.()) })
			continue
		}
		if (layer === 12) { unsupported.push(`line ${id}: layer 12 是 MULTI 跨层语义，不能作为单一物理走线层导入`); continue }
		if (!knownNonCopperLayer(type)) unsupported.push(`line ${id}: layer ${layer} type ${type ?? 'unknown'} 不能判定为非铜对象`)
	}
	for (const item of rawArcs as any[]) {
		const id = String(state(item, 'PrimitiveId', '圆弧'))
		const layer = finite(state(item, 'Layer', `圆弧 ${id}`), `${id}.layer`)
		const type = layerType(layer)
		if (type === 'PLANE') unsupported.push(`plane arc ${id}: 当前输入链尚未支持PLANE圆弧几何`)
		else if (layer === 12) unsupported.push(`arc ${id}: layer 12 是 MULTI 跨层语义，不能作为单一物理层转换`)
		else if (type !== 'SIGNAL' && !knownNonCopperLayer(type)) unsupported.push(`arc ${id}: layer ${layer} type ${type ?? 'unknown'} 不能判定`)
	}
	const excludedNonRoutingRegions: Array<{ id: string, layer: number, ruleTypes: number[] }> = []
	for (const region of regions as any[]) {
		const id = String(state(region, 'PrimitiveId', '区域'))
		const layer = finite(state(region, 'Layer', `区域 ${id}`), `${id}.layer`)
		const ruleTypes = state(region, 'RuleType', `区域 ${id}`)
		if (!Array.isArray(ruleTypes) || !ruleTypes.every(type => typeof type === 'number')) { unsupported.push(`region ${id}: 区域规则类型无法识别`); continue }
		if (!ruleTypes.length) { unsupported.push(`region ${id}: 区域规则类型为空，作用未确认`); continue }
		for (const ruleType of ruleTypes) {
			if (ruleType === 5) unsupported.push(`region ${id}: NO_WIRES(5) 禁止布线区域，尚未转换几何`)
			else if (ruleType === 9) unsupported.push(`region ${id}: FOLLOW_REGION_RULE(9) 约束区域规则未映射`)
			else if ([2, 6, 7, 8].includes(ruleType)) {
				if (!excludedNonRoutingRegions.some(item => item.id === id)) excludedNonRoutingRegions.push({ id, layer, ruleTypes: ruleTypes.filter((value: number) => [2, 6, 7, 8].includes(value)) })
			}
			else unsupported.push(`region ${id}: 未知规则类型 ${ruleType}`)
		}
	}
	for (const [kind, objects] of [['fill', fills]] as const) {
		for (const item of objects as any[]) {
			try {
				const id = String(state(item, 'PrimitiveId', kind))
				const layer = finite(state(item, 'Layer', kind), `${kind}.layer`)
				const type = layerType(layer)
				if (knownNonCopperLayer(type)) { excludedNonCopper.push({ id, kind, layer, layerType: type! }); continue }
				if (!copperLayer(layer, type)) { unsupported.push(`${kind} ${id}: 图层 ${layer} 类型 ${type ?? 'unknown'} 不能判定为铜层或明确非铜层`); continue }
				existingCopperObstacles.push({ kind, id, net: String(item.getState_Net?.() ?? ''), layer, polygon: polygonSource(item, `${kind} ${id}`) })
			}
			catch (error) { unsupported.push(`${kind} ${String(item?.getState_PrimitiveId?.() ?? '(unknown id)')}: ${String((error as any)?.message ?? error)}`) }
		}
	}
	const pourById = new Map((pours as any[]).map(item => [String(item.getState_PrimitiveId?.() ?? ''), item]))
	const sourcePouredFills = new Map<string, { parentId: string, data: Record<string, any> }>()
	const conflictingSourcePouredFills = new Set<string>()
	const sourcePouredParents = new Map<string, Set<string>>()
	const invalidSourcePouredParents = new Set<string>()
	const duplicateSourcePouredParents = new Set<string>()
	try {
		const sourcePouredRecords = [...resolveRecords(parseSourceLog(route.source)).values()].filter(record => record.header.type === 'POURED')
		for (const record of sourcePouredRecords) {
			const identity = idParts(record.header.id)
			if (identity.length !== 2 || identity[0] !== 'POURED' || typeof identity[1] !== 'string') {
				unsupported.push('POURED 源记录身份无法解析，铜区实填覆盖未确认')
				continue
			}
			const parentId = identity[1]
			if (sourcePouredParents.has(parentId)) duplicateSourcePouredParents.add(parentId)
			if (!Array.isArray((record.data as any)?.pourFill)) {
				invalidSourcePouredParents.add(parentId)
				continue
			}
			const parentFills = sourcePouredParents.get(parentId) ?? new Set<string>()
			for (const fill of (record.data as any).pourFill) {
				const fillId = typeof fill?.id === 'string' ? fill.id : undefined
				if (!fillId) { invalidSourcePouredParents.add(parentId); continue }
				if (parentFills.has(fillId)) invalidSourcePouredParents.add(parentId)
				parentFills.add(fillId)
				if (sourcePouredFills.has(fillId)) { conflictingSourcePouredFills.add(fillId); sourcePouredFills.delete(fillId); continue }
				if (!conflictingSourcePouredFills.has(fillId)) sourcePouredFills.set(fillId, { parentId, data: fill })
			}
			sourcePouredParents.set(parentId, parentFills)
		}
	}
	catch { unsupported.push('POURED 当前源码无法解析，实填几何与来源无法绑定') }
	const sdkPouredParents = new Map<string, Set<string>>()
	const invalidSdkPouredParents = new Set<string>()
	for (const item of poured as any[]) {
		const parentId = String(state(item, 'PourPrimitiveId', '实际覆铜'))
		const parts = state(item, 'PourFills', `poured ${parentId}`)
		if (!Array.isArray(parts)) { invalidSdkPouredParents.add(parentId); continue }
		const ids = sdkPouredParents.get(parentId) ?? new Set<string>()
		for (const part of parts) {
			const id = typeof part?.id === 'string' && part.id.length ? part.id : undefined
			if (!id || ids.has(id)) { invalidSdkPouredParents.add(parentId); continue }
			ids.add(id)
		}
		sdkPouredParents.set(parentId, ids)
	}
	const sourceOrSdkPouredParentIds = new Set([...sourcePouredParents.keys(), ...sdkPouredParents.keys()])
	for (const parentId of sourceOrSdkPouredParentIds) {
		const pour = pourById.get(parentId)
		if (!pour) {
			unsupported.push(`pour ${parentId}: POURED 源或 SDK 存在实填子项，但 SDK 未返回覆铜边框，实铜覆盖未确认`)
			continue
		}
		const layer = finite(pour.getState_Layer?.(), `pour ${parentId}.layer`)
		if (!copperLayer(layer, layerType(layer))) continue
		const sourceIds = sourcePouredParents.get(parentId)
		const sdkIds = sdkPouredParents.get(parentId)
		if (!sourceIds || !sdkIds || invalidSourcePouredParents.has(parentId) || invalidSdkPouredParents.has(parentId) || duplicateSourcePouredParents.has(parentId)) {
			unsupported.push(`pour ${parentId}: POURED 源与 SDK 子填充记录缺失、重复或无效，实铜覆盖未确认`)
			continue
		}
		for (const id of sourceIds) if (!sdkIds.has(id)) unsupported.push(`pour ${parentId} fill ${id}: 当前 POURED 源有实铜子项，但 SDK 未返回，实铜覆盖未确认`)
		for (const id of sdkIds) if (!sourceIds.has(id)) unsupported.push(`pour ${parentId} fill ${id}: SDK 子项在当前 POURED 源中不存在，实铜覆盖未确认`)
	}
	for (const parentId of sourcePouredParents.keys()) if (!pourById.has(parentId)) unsupported.push(`pour ${parentId}: 当前 POURED 源存在，但 SDK 未返回覆铜边框，实铜覆盖未确认`)
	for (const item of poured as any[]) {
		const pourId = String(state(item, 'PourPrimitiveId', '实际覆铜'))
		const pour = pourById.get(pourId)
		if (!pour) { unsupported.push(`poured ${String(item.getState_PrimitiveId?.() ?? '(unknown id)')}: 关联覆铜边框 ${pourId} 不存在`); continue }
		const parts = state(item, 'PourFills', `poured ${pourId}`)
		if (!Array.isArray(parts)) { unsupported.push(`poured ${pourId}: 覆铜区域数组不可读`); continue }
		for (const part of parts as any[]) {
			try {
				const path = part?.path?.getSource?.()
				if (!Array.isArray(path)) throw new Error('覆铜区域路径没有可解释的 polygon source')
				const id = String(part.id ?? '')
				const fill = part.fill
				const strokeWidth = part.lineWidth
				const layer = finite(pour.getState_Layer?.(), `poured ${pourId}.layer`)
				const type = layerType(layer)
				if (knownNonCopperLayer(type)) { excludedNonCopper.push({ id, kind: 'poured-fill', layer, layerType: type! }); continue }
				if (!copperLayer(layer, type)) { unsupported.push(`poured ${pourId} fill ${id}: 图层 ${layer} 类型 ${type ?? 'unknown'} 不能判定为铜层或明确非铜层`); continue }
				const sourceFill = sourcePouredFills.get(id)
				if (!sourceFill || conflictingSourcePouredFills.has(id) || sourceFill.parentId !== pourId || sourceFill.data.fill !== fill || sourceFill.data.strokeWidth !== strokeWidth || !sameCopperPath(sourceFill.data.path, path)) {
					unsupported.push(`poured ${pourId} fill ${id}: SDK填充状态、线宽或路径与当前POURED源码无法一一对应`)
					existingCopperObstacles.push({ kind: 'poured-fill', id, pourId, net: String(pour.getState_Net?.() ?? ''), layer, fill, strokeWidth, sourcePath: path, geometryNormalization: { status: 'unsupported', reason: 'sdk-source-fill-mismatch' } })
					continue
				}
				if (typeof fill !== 'boolean' || typeof strokeWidth !== 'number' || !Number.isFinite(strokeWidth) || strokeWidth < 0) {
					unsupported.push(`poured ${pourId} fill ${id}: fill或strokeWidth无效`)
					existingCopperObstacles.push({ kind: 'poured-fill', id, pourId, net: String(pour.getState_Net?.() ?? ''), layer, fill, strokeWidth, sourcePath: path, geometryNormalization: { status: 'unsupported', reason: 'invalid-fill-metadata' } })
					continue
				}
				if (fill) {
					if (strokeWidth !== 0) {
						unsupported.push(`poured ${pourId} fill ${id}: 闭合填充带非零边线宽，尚未转换边界并集`)
						existingCopperObstacles.push({ kind: 'poured-fill', id, pourId, net: String(pour.getState_Net?.() ?? ''), layer, fill, strokeWidth, sourcePath: path, geometryNormalization: { status: 'unsupported', reason: 'filled-outline-has-stroke' } })
						continue
					}
					const rings = normalizePouredFillPathToMil(path)
					existingCopperObstacles.push({ kind: 'poured-fill', id, pourId, net: String(pour.getState_Net?.() ?? ''), layer, fill, strokeWidth, sourcePath: path, polygon: { coordinateSpace: 'global-mil', rings }, geometryNormalization: { status: 'normalized', source: 'exact-current-POURED-fill-match', sourceCoordinateFactor: POURED_SOURCE_TO_MIL, arcChordToleranceMil: POURED_ARC_CHORD_TOLERANCE_MIL, runnerBufferMil: POURED_ARC_CHORD_TOLERANCE_MIL, serializationToleranceMil: 0.001, totalMaxErrorMil: POURED_ARC_CHORD_TOLERANCE_MIL * 2 + 0.001 } })
				}
				else {
					if (strokeWidth <= 0) {
						unsupported.push(`poured ${pourId} fill ${id}: 未填充实填路径需要正线宽`)
						existingCopperObstacles.push({ kind: 'poured-fill', id, pourId, net: String(pour.getState_Net?.() ?? ''), layer, fill, strokeWidth, sourcePath: path, geometryNormalization: { status: 'unsupported', reason: 'open-stroke-width-not-positive' } })
						continue
					}
					const paths = normalizePouredStrokePathToMil(path)
					const strokeWidthMil = strokeWidth * POURED_SOURCE_TO_MIL
					existingCopperObstacles.push({ kind: 'poured-fill', id, pourId, net: String(pour.getState_Net?.() ?? ''), layer, fill, strokeWidth, sourcePath: path, stroke: { coordinateSpace: 'global-mil', paths, widthMil: strokeWidthMil, cap: 'round' }, geometryNormalization: { status: 'normalized', source: 'exact-current-POURED-stroke-match-and-Gerber-D11', sourceCoordinateFactor: POURED_SOURCE_TO_MIL, strokeWidthMil, cap: 'round' } })
				}
			}
			catch (error) { unsupported.push(`poured ${pourId} fill ${String(part?.id ?? '(unknown id)')}: ${String((error as any)?.message ?? error)}`) }
		}
	}
	const layers = route.layers.filter(layer => ['SIGNAL', 'PLANE'].includes(layer.type.toUpperCase())).map(layer => ({ id: layer.id, name: layer.name, type: layer.type.toUpperCase(), enabled: layer.layerStatus == null ? true : layer.layerStatus !== 0 }))
	const signalLayers = layers.filter(layer => layer.type === 'SIGNAL')
	if (!signalLayers.length) unsupported.push('没有可确认的 SIGNAL 铜层')
	const netRules = await guarded(ctx, () => api.pcb_Drc.getNetRules(), '网络设计规则') as any[]
	const configuration = await guarded(ctx, () => api.pcb_Drc.getCurrentRuleConfiguration(), 'PCB 当前规则配置')
	const configurationName = await guarded(ctx, () => api.pcb_Drc.getCurrentRuleConfigurationName(), 'PCB 当前规则方案名称')
	const editorVersion = api.sys_Environment.getEditorCurrentVersion?.() ?? ''
	const routingConfig = buildRoutingWidthSnapshot({ source: route.source, layers: route.layers.map(layer => ({ id: layer.id, layerId: layer.id, name: layer.name, layerName: layer.name, type: layer.type, status: layer.layerStatus, layerStatus: layer.layerStatus })), netRules, editorVersion: String(editorVersion) })
	const sourceDocument = parseSourceLog(route.source)
	const sourceRecords = resolveRecords(sourceDocument)
	const netSourceRecords = [...sourceRecords.values()].filter(record => record.header.type === 'NET' || record.header.type === 'PAD_NET').length
	if (!netSourceRecords && padsArray.length) unsupported.push('有效网络/PAD_NET 源码记录为空，无法绑定网络身份')
	for (const component of components) if (component.pads === null) component.pads = [...sdkPadById.keys()].filter(id => componentByPad.get(id) === String(component.id)).map(id => ({ id, padNumber: String(sdkPadById.get(id)?.getState_PadNumber?.() ?? ''), net: String(sdkPadById.get(id)?.getState_Net?.() ?? '') }))
	const differentialPairsRaw = await guarded(ctx, () => api.pcb_Drc.getAllDifferentialPairs(), '差分对规则')
	const lengthGroupsRaw = await guarded(ctx, () => api.pcb_Drc.getAllEqualLengthNetGroups(), '等长组规则')
	const differentialPairItems = Array.isArray(differentialPairsRaw) ? differentialPairsRaw : differentialPairsRaw && typeof differentialPairsRaw === 'object' ? Object.values(differentialPairsRaw) : undefined
	const differentialPairs = differentialPairItems?.filter((pair: any) => pair && typeof pair.name === 'string' && typeof pair.positiveNet === 'string' && typeof pair.negativeNet === 'string').map((pair: any) => ({ name: pair.name, positiveNet: pair.positiveNet, negativeNet: pair.negativeNet })) ?? []
	const lengthMatchGroups = Array.isArray(lengthGroupsRaw) ? lengthGroupsRaw.map(group => ({ name: group.name, nets: Array.isArray(group.nets) ? group.nets : [] })) : []
	if (!differentialPairItems || differentialPairs.length !== differentialPairItems.length) unsupported.push('差分对 SDK 读取结果含无法解释的记录')
	if (!Array.isArray(lengthGroupsRaw)) unsupported.push('等长组 SDK 读取未返回数组')
	const sourceRuleRecords = [...sourceRecords.values()].filter(record => ['RULE', 'RULE_SELECTOR', 'RULE_TEMPLATE', 'PAD_NET', 'NET', 'POUR'].includes(record.header.type)).map(record => ({ type: record.header.type, id: record.header.id, data: record.data }))
	const routingNetAliases = buildRoutingNetAliasSnapshot([...nets].map(([name, pads]) => ({ name, padIds: pads.map(pad => String(pad.id)) })), sourceRuleRecords, routingConfig, netRules)
	const ruleEvidence = extractRuleEvidence(configuration, netRules, [...nets.keys()], sourceRuleRecords, routingConfig, routingNetAliases)
	const postCollectionSource = String(await guarded(ctx, () => api.sys_FileManager.getDocumentSource(), '采集结束源码基线'))
	const baselineComparison = compareDocumentSources(sourceBeforeRouteRead, postCollectionSource)
	if (!baselineComparison.equal) throw new Error(`KiRouting 采集期间 PCB 源码发生变化，拒绝生成混合输入：${baselineComparison.difference ?? '源码不匹配'}`)
	for (const record of route.sourceRecords) {
		if ((record.type === 'LINE' || record.type === 'ARC') && Number((record.data as any)?.layerId ?? (record.data as any)?.layer) === 11)
			unsupported.push(`board outline ${record.type} ${record.id}: 发现不能由闭合多边形收集器解释的板边图元`)
	}
	const input: Omit<KiRoutingInput, 'inputDigest'> = {
		schemaVersion: 1,
		units: 'mil',
		target,
		board: { outline: outline.lines.map(line => ({ a: { x: line.getState_StartX(), y: line.getState_StartY() }, b: { x: line.getState_EndX(), y: line.getState_EndY() } })), layers },
		components,
		nets: [...nets].map(([name, pins]) => ({ name, pads: pins })),
		unconnected_pads: unconnectedPads,
		choices: { nets: [...nets.keys()].sort(), layers: signalLayers.filter(layer => layer.enabled).map(layer => ({ value: String(layer.id), displayContent: layer.name, layerId: layer.id })), differentialPairs, lengthMatchGroups, components: components.map(component => ({ id: component.id, designator: component.designator, name: component.name })) },
		existing_tracks: [...route.lines.map(line => ({ id: line.id, net: line.net, layer: line.layer, widthMil: line.widthMil, a: line.a, b: line.b, locked: line.locked })), ...planeLines],
		existing_vias: route.vias.map(via => ({ id: via.id, net: via.net, x: via.x, y: via.y, diameterMil: via.diameterMil, holeDiameterMil: via.holeDiameterMil ?? null, viaType: via.viaType, locked: via.locked })),
		existing_arcs: route.arcs.map(arc => ({ id: arc.id, net: arc.net, layer: arc.layer, widthMil: arc.widthMil, start: arc.start, end: arc.end, angle: arc.angle, locked: arc.locked })),
		existing_copper_obstacles: existingCopperObstacles,
		routing_config: routingConfig,
		routing_net_aliases: routingNetAliases,
		design_rules: { configuration, configurationName: typeof configurationName === 'string' ? configurationName : null, netRules, sourceRuleRecords, unitSemantics: 'sdk-native-unconverted', constraintsComplete: false },
		baseline: { source: route.source, documentUuid: target.documentUuid, projectUuid: target.projectUuid, tabId: target.tabId },
		coverage: { complete: unsupported.length === 0, unsupported, excludedNonCopper, excludedNonRoutingRegions, routingConstraintsComplete: false },
		ruleEvidence,
	}
	const inputDigest = await digest(input)
	await ctx.assertDocumentTarget()
	return { ...input, inputDigest }
}
