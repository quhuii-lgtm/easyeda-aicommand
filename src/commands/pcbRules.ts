import type { ICommandContext, ICommandDef } from '../engine/types'
import { applyConfigurationChanges, applyNetRuleChanges, assertJsonValue, cloneRuleValue, stableRuleJson, type NetRuleChange, type RulePathChange } from '../pcb/ruleEditing'
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog'

export type PcbDesignRuleSnapshot = {
	document: { documentType: number, uuid: string, tabId?: string, parentProjectUuid?: string }
	configuration: unknown
	configurationName?: string
	netRules: unknown[]
}

export type PcbRuleUpdateParams = {
	changes?: RulePathChange[]
	netRuleChanges?: NetRuleChange[]
	dryRun?: boolean
	__docUuid?: string
	__projectUuid?: string
}

export type PcbRuleUpdateResult = {
	dryRun: boolean
	document: PcbDesignRuleSnapshot['document']
	configuration: { status: string, diff: unknown[], sdkResult?: unknown, sdkError?: string, sdkWarning?: string, metadata?: Record<string, unknown>, normalizations?: unknown[], sourceRuleChanges?: unknown[] }
	netRules: { status: string, diff: unknown[], sdkResult?: unknown, sdkError?: string, sdkWarning?: string }
	verified: boolean
}

type RuleSnapshot = { document: PcbDesignRuleSnapshot['document'], configuration: any, configurationName?: string, netRules: unknown[], source: string }

function fail(message: string, details: Record<string, unknown>): Error {
	return new Error(message, { cause: { ...details, partial: Boolean(details.partial), retryable: false } })
}

async function assertTarget(ctx: ICommandContext | undefined, target: RuleSnapshot['document']): Promise<void> {
	ctx?.stopSignal?.assertActive()
	if (ctx?.assertDocumentTarget) {
		await ctx.assertDocumentTarget()
	}
	else {
		const focus = await eda.dmt_SelectControl.getCurrentDocumentInfo()
		if (focus?.documentType !== 3 || focus.uuid !== target.uuid)
			throw new Error(`PCB 目标已变化：期望 ${target.uuid}，当前 ${focus?.uuid ?? '未知'}`)
		if (typeof focus.tabId !== 'string' || !focus.tabId.trim() || typeof focus.parentProjectUuid !== 'string' || !focus.parentProjectUuid.trim())
			throw new Error('独立执行缺少有效 PCB 标签页或所属工程身份')
		if ((target.tabId && focus.tabId !== target.tabId) || (target.parentProjectUuid && focus.parentProjectUuid !== target.parentProjectUuid))
			throw new Error(`PCB 标签页或所属工程已变化：目标 ${target.parentProjectUuid ?? '未知'}/${target.tabId ?? '未知'}，当前 ${focus.parentProjectUuid}/${focus.tabId}`)
	}
	ctx?.stopSignal?.assertActive()
}

async function readSnapshot(ctx?: ICommandContext): Promise<RuleSnapshot> {
	const document = await eda.dmt_SelectControl.getCurrentDocumentInfo()
	if (document?.documentType !== 3 || typeof document.uuid !== 'string' || !document.uuid.trim()) throw new Error('当前文档不是有效 PCB')
	const target = cloneRuleValue(document)
	await assertTarget(ctx, target)
	const configuration = await eda.pcb_Drc.getCurrentRuleConfiguration()
	await assertTarget(ctx, target)
	const netRules = await eda.pcb_Drc.getNetRules()
	await assertTarget(ctx, target)
	const configurationName = await eda.pcb_Drc.getCurrentRuleConfigurationName()
	await assertTarget(ctx, target)
	const source = await eda.sys_FileManager.getDocumentSource()
	await assertTarget(ctx, target)
	if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('当前设计规则配置未返回有效对象')
	if (!Object.prototype.hasOwnProperty.call(configuration, 'config') || !configuration.config || typeof configuration.config !== 'object' || Array.isArray(configuration.config))
		throw new Error('当前设计规则 getter 未返回有效 configuration.config；拒绝执行规则覆盖写入')
	if (!Array.isArray(netRules)) throw new Error('当前网络规则未返回数组')
	// Validate before JSON cloning: stringify would otherwise silently drop undefined fields or turn NaN into null.
	// This check has no mutation side effects and keeps unknown getter fields intact rather than normalizing them.
	assertJsonValue(configuration, '当前规则配置')
	assertJsonValue(netRules, '当前网络规则')
	if (typeof source !== 'string' || !source) throw new Error('无法读取当前 PCB 源码，规则写入结果不得判通过')
	const parsedSource = parseSourceLog(source)
	if (parsedSource.docType !== 'PCB' || parsedSource.uuid !== target.uuid) throw new Error('规则快照的 PCB 源码身份与焦点不符')
	if (configurationName !== undefined && typeof configurationName !== 'string') throw new Error('规则配置名称 getter 返回了非字符串值')
	if (configurationName !== undefined && (configuration as Record<string, any>).name !== configurationName) throw new Error('规则配置名称 getter 与配置对象名称不一致')
	return { document: target, configuration: cloneRuleValue(configuration), configurationName, netRules: cloneRuleValue(netRules), source }
}

function resolvedSource(source: string) {
	return resolveRecords(parseSourceLog(source))
}

function sourceRecordMapKey(type: string, id: unknown): string {
	return `${type}\0${String(id)}`
}

function flattenLeaves(value: unknown, path: string[] = [], output = new Map<string, unknown>()): Map<string, unknown> {
	if (value && typeof value === 'object') {
		const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value as Record<string, unknown>)
		if (!entries.length) output.set(stableRuleJson(path), value)
		else for (const [key, item] of entries) flattenLeaves(item, [...path, key], output)
	}
	else output.set(stableRuleJson(path), value)
	return output
}

function rawRuleDiff(before: RuleSnapshot, after: RuleSnapshot, changes: RulePathChange[], netChanges: NetRuleChange[], phase: string, sourceRuleChanges: unknown[]): string[] {
	const left = resolvedSource(before.source), right = resolvedSource(after.source)
	const allowedTrackFields = new Map<string, Map<string, { fields: Map<string, RulePathChange>, row?: RulePathChange }>>()
	for (const change of changes) {
		const leafMatch = /^config\.Physics\.Track\.([^.]+)\.form\.data\.([^.]+)\.(minValue|defaultValue|maxValue)$/.exec(change.path.join('.'))
		const rowMatch = /^config\.Physics\.Track\.([^.]+)\.form\.data\.([^.]+)$/.exec(change.path.join('.'))
		if (!leafMatch && !rowMatch) continue
		const rule = (leafMatch ?? rowMatch)![1]
		const layer = (leafMatch ?? rowMatch)![2]
		const key = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', rule]))
		const byLayer = allowedTrackFields.get(key) ?? new Map<string, { fields: Map<string, RulePathChange>, row?: RulePathChange }>()
		const selected = byLayer.get(layer) ?? { fields: new Map<string, RulePathChange>() }
		if (leafMatch) selected.fields.set(leafMatch[3], change)
		else selected.row = change
		byLayer.set(layer, selected)
		allowedTrackFields.set(key, byLayer)
	}
	const allowedKeys = new Set([...left.keys(), ...right.keys()])
	const differences: string[] = []
	const stripTicket = (record: any) => {
		const copy = cloneRuleValue(record)
		delete copy.header.ticket
		return copy
	}
	const deepDiff = (a: any, b: any, path: string, result: string[]) => {
		if (stableRuleJson(a) === stableRuleJson(b)) return
		if (a === undefined && b && typeof b === 'object') {
			for (const [key, value] of Object.entries(b)) deepDiff(undefined, value, `${path}.${key}`, result)
			return
		}
		if (b === undefined && a && typeof a === 'object') {
			for (const [key, value] of Object.entries(a)) deepDiff(value, undefined, `${path}.${key}`, result)
			return
		}
		if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
			const keys = new Set([...Object.keys(a), ...Object.keys(b)])
			for (const key of keys) deepDiff(a[key], b[key], `${path}.${key}`, result)
			return
		}
		result.push(path)
	}
	for (const key of allowedKeys) {
		const a = left.get(key), b = right.get(key)
		if (!a || !b) {
			if (phase === 'configuration' && key.startsWith('RULE\0')) {
				sourceRuleChanges.push({ record: key, before: a?.data ?? null, after: b?.data ?? null, rawSourceFullyMapped: false, reason: '完整配置 getter 已核对；SDK 序列化的原始规则结构未作全字段映射' })
			}
			else differences.push(`record ${key} added or removed`)
			continue
		}
		if (stableRuleJson(stripTicket(a)) === stableRuleJson(stripTicket(b))) continue
		if (key === 'RULE_TEMPLATE\0RULE_TEMPLATE') {
			const strippedA = stripTicket(a), strippedB = stripTicket(b)
			const da = { ...strippedA.data }, db = { ...strippedB.data }
			delete da.name; delete db.name
			if (stableRuleJson({ header: strippedA.header, data: da }) !== stableRuleJson({ header: strippedB.header, data: db })) differences.push(`record ${key} changed outside generated name`)
			continue
		}
		if (phase === 'netRules' && key.startsWith('RULE_SELECTOR\0')) {
			let selector: unknown
			try { selector = JSON.parse(key.slice(key.indexOf('\0') + 1)) } catch {}
			const tuple = Array.isArray(selector) && selector.length === 2 && selector[0] === 'RULE_SELECTOR' && Array.isArray(selector[1]) ? selector[1] : undefined
			const scope = tuple?.[0] === 'NET' ? 'net' : tuple?.[0] === 'NET_CLASS' ? 'netclass' : undefined
			// The full typed getter comparison above validates selected binding fields and every other
			// row. Keep source checking scoped to the exact selected selector identity; the SDK's
			// selector serialization has several field families, so do not guess mappings here.
			if (netChanges.some(change => change.type.replace(/_/g, '').toLowerCase() === scope && change.name === tuple?.[1])) {
				const leftRecord = stripTicket(a), rightRecord = stripTicket(b)
				if (stableRuleJson(leftRecord.header) !== stableRuleJson(rightRecord.header)) differences.push(`record ${key} header changed outside ticket`)
				sourceRuleChanges.push({ record: key, before: a.data, after: b.data, rawSourceFullyMapped: false, reason: '所选网络绑定由完整 netRules getter 读回确认；RULE_SELECTOR 内部字段映射未展开' })
				continue
			}
		}
		const perRule = allowedTrackFields.get(key)
		if (!perRule && phase === 'configuration' && key.startsWith('RULE\0')) {
			const leftRecord = stripTicket(a), rightRecord = stripTicket(b)
			if (stableRuleJson(leftRecord.header) !== stableRuleJson(rightRecord.header)) differences.push(`record ${key} header changed outside ticket`)
			// The getter covers the complete writable configuration, but its group names do not map
			// mechanically to source-log rule families. Report SDK rule serialization without inventing
			// that mapping; every non-rule record and every getter field remains checked independently.
			sourceRuleChanges.push({ record: key, before: a.data, after: b.data, rawSourceFullyMapped: false, reason: '完整配置 getter 已核对；SDK 序列化的原始规则结构未作全字段映射' })
			continue
		}
		if (!perRule) {
			const leftRecord = stripTicket(a), rightRecord = stripTicket(b)
			if (stableRuleJson({ header: leftRecord.header, data: leftRecord.data }) !== stableRuleJson({ header: rightRecord.header, data: rightRecord.data })) differences.push(`record ${key} changed`)
			continue
		}
		const aCopy = stripTicket(a), bCopy = stripTicket(b)
		const rawDiffs: string[] = []
		deepDiff(aCopy.data, bCopy.data, 'data', rawDiffs)
		for (const path of rawDiffs) {
			const match = /^data\.ruleContext\.track\.content\.(\d+)\.(layerId|stroMin|stroDef|stroMax)$/.exec(path)
			if (!match) { differences.push(`record ${key} changed at ${path}`); continue }
			const [, row, field] = match
			const rowBefore = aCopy.data?.ruleContext?.track?.content?.[Number(row)]
			const rowAfter = bCopy.data?.ruleContext?.track?.content?.[Number(row)]
			const layerId = rowAfter?.layerId ?? rowBefore?.layerId
			const configField = ({ stroMin: 'minValue', stroDef: 'defaultValue', stroMax: 'maxValue' } as Record<string, string>)[field]
			const request = perRule.get(String(layerId))
			const leafRequest = configField ? request?.fields.get(configField) : undefined
			const rowRequest = request?.row
			if (field === 'layerId') {
				if (!rowRequest || rowBefore || String(rowAfter?.layerId) !== String(rowRequest.path[6])) differences.push(`record ${key} changed layer selector at ${path}`)
			}
			else {
				const selectedChange = leafRequest ?? (rowRequest && rowRequest.value && typeof rowRequest.value === 'object' ? { value: (rowRequest.value as Record<string, unknown>)[configField] } : undefined)
				let ruleName: string | undefined
				try { const sourceId = JSON.parse(key.slice(key.indexOf('\0') + 1)); if (Array.isArray(sourceId) && sourceId[0] === 'RULE' && sourceId[1] === 'TRACK') ruleName = sourceId[2] } catch {}
				const unit = ruleName ? before.configuration.config?.Physics?.Track?.[ruleName]?.unit : undefined
				const expectedMil = selectedChange && typeof selectedChange.value === 'number' && (unit === 'mm' || unit === 'mil')
					? Math.round(selectedChange.value * (unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4 : undefined
				if (expectedMil === undefined || rowAfter?.[field] !== expectedMil || (rowRequest && rowBefore)) differences.push(`record ${key} changed target field to an unrequested value at ${path}`)
			}
		}
	}
	return differences
}

function milEquivalent(a: unknown, b: unknown, unit: unknown): boolean {
	if (typeof a !== 'number' || !Number.isFinite(a) || typeof b !== 'number' || !Number.isFinite(b)) return false
	if (unit !== 'mm' && unit !== 'mil') return false
	const scale = unit === 'mm' ? 1 / 0.0254 : 1
	return Math.round(a * scale * 1e4) === Math.round(b * scale * 1e4)
}

function existingTrackQuantization(change: RulePathChange, snapshot: RuleSnapshot): Record<string, unknown> | undefined {
	const match = /^config\.Physics\.Track\.([^.]+)\.form\.data\.([^.]+)\.(minValue|defaultValue|maxValue)$/.exec(change.path.join('.'))
	if (!match || typeof change.value !== 'number') return undefined
	const [, rule, layer, field] = match
	const configRule = snapshot.configuration.config?.Physics?.Track?.[rule]
	const actual = configRule?.form?.data?.[layer]?.[field]
	if (Object.is(change.value, actual) || !milEquivalent(change.value, actual, configRule?.unit)) return undefined
	const raw = resolvedSource(snapshot.source).get(sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', rule])))
	const rawField = ({ minValue: 'stroMin', defaultValue: 'stroDef', maxValue: 'stroMax' } as Record<string, string>)[field]
	const rows = raw?.data?.ruleContext?.track?.content
	if (!Array.isArray(rows)) return undefined
	const matched = rows.filter((row: any) => String(row.layerId) === layer)
	if (matched.length !== 1) return undefined
	const normalizedMil = Math.round(change.value * (configRule.unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4
	if (matched[0][rawField] !== normalizedMil || matched[0][rawField] !== Math.round((actual as number) * (configRule.unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4) return undefined
	return { path: change.path, requested: change.value, actual, normalizedMil, sourceVerified: true }
}

function expandExistingTrackRows(changes: RulePathChange[], configuration: unknown): RulePathChange[] {
	const output: RulePathChange[] = []
	for (const change of changes) {
		const match = /^config\.Physics\.Track\.([^.]+)\.form\.data\.([^.]+)$/.exec(change.path.join('.'))
		if (!match || !change.value || typeof change.value !== 'object' || Array.isArray(change.value)) { output.push(change); continue }
		let current: any = configuration
		for (const key of change.path) {
			if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, key)) { current = undefined; break }
			current = current[key]
		}
		if (!current || typeof current !== 'object' || Array.isArray(current)) { output.push(change); continue }
		for (const [field, value] of Object.entries(change.value)) output.push({ path: [...change.path, field], value: value as RulePathChange['value'] })
	}
	return output
}

function allowedGetterDifference(path: string[], expectedValue: unknown, actual: unknown, changes: RulePathChange[], expectedConfiguration: any, before: RuleSnapshot, after: RuleSnapshot): Record<string, unknown> | undefined {
	const key = stableRuleJson(path)
	let requested = changes.find(change => stableRuleJson(change.path) === key)
	if (!requested) {
		const row = changes.find(change => change.path.length + 1 === path.length && change.path.every((part, index) => part === path[index])
			&& change.value && typeof change.value === 'object' && !Array.isArray(change.value)
			&& Object.prototype.hasOwnProperty.call(change.value, path[path.length - 1]))
		if (row) requested = { path, value: (row.value as Record<string, RulePathChange['value']>)[path[path.length - 1]] }
	}
	const track = /^config\.Physics\.Track\.([^.]+)\.form\.data\.([^.]+)\.(minValue|defaultValue|maxValue)$/.exec(path.join('.'))
	if (track && requested) {
		const [, rule, layer, field] = track
		const unit = expectedConfiguration.config?.Physics?.Track?.[rule]?.unit
		const beforeRows = resolvedSource(before.source), afterRows = resolvedSource(after.source)
		const recordKeyValue = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'TRACK', rule]))
		const beforeRecord = beforeRows.get(recordKeyValue), afterRecord = afterRows.get(recordKeyValue)
		if (!beforeRecord || !afterRecord || !milEquivalent(requested.value, actual, unit)) return undefined
		const rawField = ({ minValue: 'stroMin', defaultValue: 'stroDef', maxValue: 'stroMax' } as Record<string, string>)[field]
		const rows = afterRecord.data?.ruleContext?.track?.content
		if (!Array.isArray(rows)) return undefined
		const matches = rows.filter((row: any) => String(row.layerId) === layer)
		if (matches.length !== 1 || matches[0][rawField] !== Math.round((requested.value as number) * (unit === 'mm' ? 1 / 0.0254 : 1) * 1e4) / 1e4) return undefined
		const beforeRow = beforeRecord.data?.ruleContext?.track?.content?.find((row: any) => String(row.layerId) === layer)
		const originalValue = beforeRow?.[rawField]
		if (originalValue === matches[0][rawField]) return undefined
		return { path, requested: requested.value, actual, normalizedMil: matches[0][rawField], sourceVerified: true }
	}
	const safe = /^config\.Spacing\.Safe Spacing\.([^.]+)\.tables\.([^.]*)\.content\.(\d+)\.(\d+)$/.exec(path.join('.'))
	if (!safe || requested) return undefined
	const [, rule, , row, column] = safe
	const unit = expectedConfiguration.config?.Spacing?.['Safe Spacing']?.[rule]?.unit
	const beforeRows = resolvedSource(before.source), afterRows = resolvedSource(after.source)
	const recordKeyValue = sourceRecordMapKey('RULE', JSON.stringify(['RULE', 'SAFE', rule]))
	const beforeRecord = beforeRows.get(recordKeyValue), afterRecord = afterRows.get(recordKeyValue)
	if (unit !== 'mm' || !beforeRecord || !afterRecord || stableRuleJson(beforeRecord.data) !== stableRuleJson(afterRecord.data) || !milEquivalent(expectedValue, actual, unit)) return undefined
	return { path, requested: expectedValue, actual, normalizedMil: Math.round((actual as number) / 0.0254 * 1e4) / 1e4, sourceVerified: true }
}

function requireExpected(current: RuleSnapshot, expected: Pick<RuleSnapshot, 'configuration' | 'netRules'>, phase: string, changes: RulePathChange[], netChanges: NetRuleChange[], before: RuleSnapshot): { normalizations: unknown[], sourceRuleChanges: unknown[] } {
	const normalizations: unknown[] = []
	const sourceRuleChanges: unknown[] = []
	const actual = cloneRuleValue(current.configuration), wanted = cloneRuleValue(expected.configuration)
	if (current.configurationName !== undefined && actual.name !== current.configurationName) throw new Error(`${phase}配置名称 getter 与配置对象名称不一致`)
	// The SDK promotes a selected built-in template to a generated custom configuration name.
	// Name is reported as SDK metadata and is never treated as a writeable design-rule field.
	if (actual.name !== wanted.name && (typeof current.configurationName !== 'string' || actual.name !== current.configurationName || typeof before.configurationName !== 'string' || before.configuration.name !== before.configurationName))
		throw new Error(`${phase}配置名称变化未由官方配置名称 getter 确认`)
	delete actual.name; delete wanted.name
	const expectedLeaves = flattenLeaves(wanted), actualLeaves = flattenLeaves(actual)
	const keys = new Set([...expectedLeaves.keys(), ...actualLeaves.keys()])
	for (const pathKey of keys) {
		if (expectedLeaves.has(pathKey) && actualLeaves.has(pathKey) && stableRuleJson(expectedLeaves.get(pathKey)) === stableRuleJson(actualLeaves.get(pathKey))) continue
		const path = JSON.parse(pathKey) as string[]
		const accepted = allowedGetterDifference(path, expectedLeaves.get(pathKey), actualLeaves.get(pathKey), changes, wanted, before, current)
		if (!accepted) throw new Error(`${phase}读回与预期不符：${path.join('.')}`)
		normalizations.push(accepted)
	}
	if (stableRuleJson(current.netRules) !== stableRuleJson(expected.netRules)) throw new Error(`${phase}网络规则读回与预期不符`)
	const sourceDifferences = rawRuleDiff(before, current, changes, netChanges, phase, sourceRuleChanges)
	if (sourceDifferences.length) throw new Error(`${phase}源码存在未授权变化：${sourceDifferences.slice(0, 8).join('; ')}`)
	return { normalizations, sourceRuleChanges }
}

function requirePreWriteSnapshot(current: RuleSnapshot, expectedConfiguration: any, expectedConfigurationName: string | undefined, expectedNetRules: unknown[], before: RuleSnapshot): void {
	if (current.configurationName !== expectedConfigurationName || stableRuleJson(current.netRules) !== stableRuleJson(expectedNetRules))
		throw new Error('规则快照已变化；拒绝覆盖用户新修改')
	const actual = cloneRuleValue(current.configuration), wanted = cloneRuleValue(expectedConfiguration)
	if (actual.name !== wanted.name || (current.configurationName !== undefined && actual.name !== current.configurationName))
		throw new Error('规则配置名称已变化；拒绝覆盖用户新修改')
	delete actual.name
	delete wanted.name
	const expectedLeaves = flattenLeaves(wanted), actualLeaves = flattenLeaves(actual)
	const keys = new Set([...expectedLeaves.keys(), ...actualLeaves.keys()])
	for (const pathKey of keys) {
		if (expectedLeaves.has(pathKey) && actualLeaves.has(pathKey) && stableRuleJson(expectedLeaves.get(pathKey)) === stableRuleJson(actualLeaves.get(pathKey))) continue
		const path = JSON.parse(pathKey) as string[]
		if (!allowedGetterDifference(path, expectedLeaves.get(pathKey), actualLeaves.get(pathKey), [], wanted, before, current))
			throw new Error(`规则快照已变化；拒绝覆盖用户新修改：${path.join('.')}`)
	}
	const differences = rawRuleDiff(before, current, [], [], 'prewrite', [])
	if (differences.length) throw new Error(`规则原始快照已变化；拒绝覆盖用户新修改：${differences.slice(0, 8).join('; ')}`)
}

function phaseFailure(phase: string, state: PcbRuleUpdateResult, error: unknown, outcome: 'unknown' | 'mismatch'): Error {
	const message = String((error as any)?.message ?? error)
	return fail(`${phase}写入已发出，但无法确认设计规则结果：${message}`, {
		// A dispatched write with failed/incomplete readback is itself partial, even if this was stage one.
		partial: true,
		outcome,
		phase,
		writeAttempted: true,
		stages: { configuration: state.configuration, netRules: state.netRules },
	})
}

async function updateDesignRules(params: PcbRuleUpdateParams, ctx?: ICommandContext): Promise<PcbRuleUpdateResult> {
	if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean') throw new Error('dryRun 必须是 boolean')
	if (params.__docUuid !== undefined && (typeof params.__docUuid !== 'string' || !params.__docUuid.trim())) throw new Error('__docUuid 必须是非空字符串')
	if (params.__projectUuid !== undefined && (typeof params.__projectUuid !== 'string' || !params.__projectUuid.trim())) throw new Error('__projectUuid 必须是非空字符串')
	const dryRun = params.dryRun !== false
	const snapshot = await readSnapshot(ctx)
	if (params.__docUuid && params.__docUuid !== snapshot.document.uuid) throw new Error(`请求目标 PCB UUID 不符：${params.__docUuid}`)
	if (params.__projectUuid && params.__projectUuid !== snapshot.document.parentProjectUuid) throw new Error(`请求目标工程 UUID 不符：${params.__projectUuid}`)
	const candidateConfigChanges = expandExistingTrackRows(params.changes ?? [], snapshot.configuration)
	const initialNormalizations = candidateConfigChanges.map(change => existingTrackQuantization(change, snapshot)).filter((item): item is Record<string, unknown> => Boolean(item))
	const normalizedPaths = new Set(initialNormalizations.map(item => stableRuleJson(item.path)))
	const effectiveConfigChanges = candidateConfigChanges.filter(change => !normalizedPaths.has(stableRuleJson(change.path)))
	const configPlan = applyConfigurationChanges(snapshot.configuration, effectiveConfigChanges)
	const netPlan = applyNetRuleChanges(snapshot.netRules, params.netRuleChanges ?? [])
	const resolvedNetChanges: NetRuleChange[] = netPlan.diff.map(change => ({
		type: change.type,
		name: change.name,
		values: Object.fromEntries(Object.entries(change.values).map(([field, value]) => [field, value.after])),
	}))
	const state: PcbRuleUpdateResult = {
		dryRun,
		document: snapshot.document,
		configuration: { status: configPlan.diff.length ? (dryRun ? 'planned' : 'pending') : 'skipped', diff: configPlan.diff },
		netRules: { status: netPlan.diff.length ? (dryRun ? 'planned' : 'pending') : 'skipped', diff: netPlan.diff },
		verified: dryRun || (!configPlan.diff.length && !netPlan.diff.length),
	}
	if (initialNormalizations.length) state.configuration.normalizations = initialNormalizations
	if (dryRun || (!configPlan.diff.length && !netPlan.diff.length)) return state

	const phases: Array<'configuration' | 'netRules'> = ['configuration', 'netRules']
	let sourceBaseline = snapshot
	for (const phase of phases) {
		const diff = phase === 'configuration' ? configPlan.diff : netPlan.diff
		if (!diff.length) continue
		const expectedBefore = phase === 'configuration'
			? { configuration: snapshot.configuration, netRules: snapshot.netRules }
			: { configuration: sourceBaseline.configuration, netRules: snapshot.netRules }
		const expectedBeforeName = phase === 'configuration' ? snapshot.configurationName : sourceBaseline.configurationName
		const expectedAfter = phase === 'configuration'
			? { configuration: configPlan.expected, netRules: snapshot.netRules }
			: { configuration: sourceBaseline.configuration, netRules: netPlan.expected }
		try {
			const latest = await readSnapshot(ctx)
			if (latest.document.uuid !== snapshot.document.uuid || stableRuleJson(latest.document) !== stableRuleJson(snapshot.document))
				throw new Error('PCB 工程或文档身份发生变化')
			requirePreWriteSnapshot(latest, expectedBefore.configuration, expectedBeforeName, expectedBefore.netRules, sourceBaseline)
			await assertTarget(ctx, snapshot.document)
		}
		catch (error) {
			const priorApplied = state.configuration.status === 'applied' || state.netRules.status === 'applied'
			if (priorApplied)
				throw fail(`${phase}阶段未写入；前一阶段已应用，后续阶段停止：${String((error as any)?.message ?? error)}`, {
					partial: true, outcome: 'not_started', phase, writeAttempted: false,
					stages: { configuration: state.configuration, netRules: state.netRules },
				})
			throw error
		}
		state[phase].status = 'writing'
		let sdkResult: unknown
		let sdkError: string | undefined
		try {
			if (phase === 'configuration') sdkResult = await eda.pcb_Drc.overwriteCurrentRuleConfiguration((configPlan.expected as Record<string, any>).config)
			else sdkResult = await eda.pcb_Drc.overwriteNetRules(netPlan.expected as Record<string, any>[])
		}
		catch (error) { sdkError = String((error as any)?.message ?? error) }
		let after: RuleSnapshot
		try {
			after = await readSnapshot(ctx)
			const verification = requireExpected(after, expectedAfter, phase, phase === 'configuration' ? effectiveConfigChanges : [], phase === 'netRules' ? resolvedNetChanges : [], sourceBaseline)
			state.configuration.normalizations = [...(state.configuration.normalizations ?? []), ...verification.normalizations]
			state.configuration.sourceRuleChanges = [...(state.configuration.sourceRuleChanges ?? []), ...verification.sourceRuleChanges]
			if (phase === 'configuration') {
				state.configuration.metadata = {
					configurationNameBefore: snapshot.configurationName,
					getterNameBefore: snapshot.configurationName,
					configurationNameAfter: after.configurationName,
					getterNameAfter: after.configurationName,
					nameIsSdkGeneratedMetadata: snapshot.configurationName !== after.configurationName,
				}
			}
		}
		catch (error) {
			state[phase].sdkResult = sdkResult
			if (sdkError) state[phase].sdkError = sdkError
			state[phase].status = 'outcomeunknown'
			throw phaseFailure(phase, state, error, 'unknown')
		}
		state[phase].status = 'applied'
		state[phase].sdkResult = sdkResult
		if (sdkError) state[phase].sdkError = sdkError
		if (sdkResult === false || sdkError) state[phase].sdkWarning = sdkError ?? 'SDK 返回 false，但完整读回与预期相符'
		sourceBaseline = after
		try {
			ctx?.stopSignal?.assertActive()
			await assertTarget(ctx, snapshot.document)
		}
		catch (error) {
			const nextPhase = phase === 'configuration' && netPlan.diff.length ? 'netRules' : undefined
			throw fail(`${phase}阶段读回已确认，但停止信号或目标复核阻止后续写入`, {
				partial: Boolean(nextPhase), outcome: nextPhase ? 'not_started' : 'verified', phase: nextPhase ?? phase,
				writeAttempted: false, blocker: String((error as any)?.message ?? error),
				stages: { configuration: state.configuration, netRules: state.netRules },
			})
		}
	}
	state.verified = true
	return state
}

export const pcbRuleCommands: ICommandDef[] = [
	{
		name: 'pcb.getDesignRules',
		summary: '读取当前 PCB 的完整设计规则配置和网络规则绑定',
		params: [],
		returns: '{ document, configuration, configurationName, netRules }',
		example: { cmd: 'pcb.getDesignRules' },
		handler: async (_params, ctx) => {
			const snapshot = await readSnapshot(ctx)
			return { document: snapshot.document, configuration: snapshot.configuration, configurationName: snapshot.configurationName, netRules: snapshot.netRules }
		},
	},
	{
		name: 'pcb.updateDesignRules',
		summary: '按明确字段修改当前 PCB 设计规则；默认仅预览差异',
		params: [
			{ name: 'changes', type: 'array', required: false, description: '配置字段补丁 [{path: string[], value: JSON}]；path 必须以 config 开头并指向 getter 的 configuration.config 内字段；外层 name 等元数据不可写。只改一个叶字段，可新增末级叶，父路径必须已存在。数值按该规则当前 unit 提供，不自动换算。' },
			{ name: 'netRuleChanges', type: 'array', required: false, description: '网络绑定补丁 [{type, name, values}]；从 getter 原样选取 type/name，精确且唯一匹配现有行（包括 sub 中的网络）。网络类赋值按界面语义同时分配到其成员；同批显式网络值优先，与输入顺序无关。预览列出全部实际变化，成员项标明 fromClass。values 仅更新已有绑定字段，值须为规则名字符串或 null；保留行身份及分组结构。' },
			{ name: 'dryRun', type: 'boolean', required: false, description: '严格 boolean；省略时默认 true，只返回差异，不写入。明确传 false 才执行。' },
		],
		returns: '{ dryRun, document, configuration, netRules, verified }；configuration.sourceRuleChanges 单列已变更的原始规则记录；未完整映射的原始字段会标明，完整 getter 读回不代表隐藏源字段均已映射。每个写入阶段都复核写前快照；未知结果停止后续阶段，不自动回滚或重试。Track:"default" 表示跟随默认方案；宿主保存时可能把指向当前默认方案名称的绑定转成 default，不能据此保证该名称在以后切换默认方案时仍被固定绑定。verified 为即时读回，持久性须保存重开核对',
		example: { cmd: 'pcb.updateDesignRules', params: { changes: [{ path: ['config', 'Physics', 'Track', 'copperThickness1oz', 'form', 'data', '1', 'defaultValue'], value: 0.2 }] } },
		handler: async (params, ctx) => updateDesignRules(params as PcbRuleUpdateParams, ctx),
	},
]

export const pcbRuleUpdateHandler = updateDesignRules
