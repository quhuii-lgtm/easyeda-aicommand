/**
 * 原理图类指令
 *
 * 注意：原理图坐标单位为 10mil
 */
import type { ICommandDef } from '../engine/types'
import { modifyComponentSafely, moveComponentSafely } from '../engine/componentMutation'
import { getProjectFootprintDiagnostic, placeDeviceSafely } from '../engine/componentPlacement'
import { assertSnapshotFocused, captureDocumentSnapshot, compareDocumentSources, withDocumentRecovery } from '../engine/documentRecovery'
import { fileToResult } from './util'
import { beginTask, failTask, finishTask, taskProgress } from '../engine/tasks'
import { serializeErrorDetail } from '../engine/registry'
import { diag } from '../engine/diag'
import { isEda42OrNewer, requireEda42 } from '../engine/edaVersion'
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog'

/** 0.10.42：给无保护 await 加超时（官方偶发永不 resolve，曾致整批删除挂死 300s 无结果） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label}超时（>${ms / 1000}s，官方无响应）`)), ms)
		Promise.resolve(p).then(
			value => { clearTimeout(timer); resolve(value) },
			error => { clearTimeout(timer); reject(error) },
		)
	})
}

function checkedSchematicDrcEntries(value: unknown): Array<any> {
	if (!Array.isArray(value))
		throw new Error(`原理图 DRC 结果不可判定：官方返回 ${value === null ? 'null' : typeof value}，预期为违规数组；不能按 0 项通过处理`)
	for (const [index, entry] of value.entries()) {
		const detailed = entry && typeof entry === 'object'
			&& typeof entry.type === 'string' && typeof entry.rule === 'string'
			&& Array.isArray(entry.primitives)
		const aggregated = entry && typeof entry === 'object'
			&& typeof entry.type === 'string' && Number.isSafeInteger(entry.count)
			&& entry.count >= 0 && entry.primitives == null
		if (!detailed && !aggregated)
			throw new Error(`原理图 DRC 结果不可判定：第 ${index + 1} 项不是已知的逐条或聚合结构；不能按检查通过处理`)
	}
	return value
}

function describeBomFile(result: { base64: string }, fileType: 'xlsx' | 'csv') {
	const head = atob(result.base64.slice(0, 4096))
	if (fileType === 'xlsx') {
		if (head.startsWith('PK\u0003\u0004'))
			return { format: 'xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
		return { format: 'unknown', note: '请求 XLSX，但文件头不是 ZIP；请检查返回文件' }
	}
	const utf16 = head.charCodeAt(0) === 0xFF && head.charCodeAt(1) === 0xFE
	const utf8Bom = head.charCodeAt(0) === 0xEF && head.charCodeAt(1) === 0xBB && head.charCodeAt(2) === 0xBF
	const encoding = utf16 ? 'utf-16le' : utf8Bom ? 'utf-8' : 'unconfirmed'
	const sample = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(Uint8Array.from(head, c => c.charCodeAt(0)))
	const header = sample.split(/\r?\n/, 1)[0]
	const tabs = (header.match(/\t/g) ?? []).length
	const commas = (header.match(/,/g) ?? []).length
	const delimiter = tabs > commas ? '\t' : commas > tabs ? ',' : undefined
	if (!delimiter)
		return { format: 'unknown', encoding, note: '无法从 BOM 表头确认分隔符；请检查原始文件' }
	return {
		format: delimiter === '\t' ? 'tsv' : 'csv',
		encoding,
		delimiter,
		mimeType: `${delimiter === '\t' ? 'text/tab-separated-values' : 'text/csv'}${encoding === 'unconfirmed' ? '' : `; charset=${encoding}`}`,
	}
}

/** 防御性读取图元状态方法（不同图元类型支持的方法不同） */
function safeState<T>(obj: any, method: string): T | undefined {
	try {
		const fn = obj?.[method]
		if (typeof fn === 'function')
			return fn.call(obj) as T
	}
	catch {
		// 忽略不支持的状态读取
	}
	return undefined
}

function readState<T>(obj: any, method: string): { ok: true, value: T } | { ok: false, error: string } {
	try {
		const fn = obj?.[method]
		if (typeof fn !== 'function')
			return { ok: false, error: `${method} 不存在` }
		return { ok: true, value: fn.call(obj) as T }
	}
	catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}

/** Net-only mutation: preserve native geometry/style and allow only the target NET/Name attributes to change. */
async function setWireNetPreservingState(wireId: string, targetNet: string, options: { requireUnnamed?: boolean } = {}) {
	let writeAttempted = false
	let sdkResult: unknown
	let lastFailure = ''
	const normalize = (value: any): any => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object'
		? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
	const stable = (value: unknown) => JSON.stringify(normalize(value))
	const content = (record: any, omitValue = false) => {
		const { ticket: _ticket, ...header } = record.header
		const data = omitValue && record.data && typeof record.data === 'object' && !Array.isArray(record.data)
			? { ...record.data } : record.data
		if (omitValue && data && typeof data === 'object') delete data.value
		return stable({ header, data })
	}
	const read = async (expectedUuid?: string) => {
		const focus = await eda.dmt_SelectControl.getCurrentDocumentInfo()
		if (focus?.documentType !== 1 || !focus.uuid || expectedUuid && focus.uuid !== expectedUuid)
			throw new Error('导线改名前后焦点不是同一原理图页', { cause: { focusChanged: true } })
		const source = await eda.sys_FileManager.getDocumentSource()
		if (typeof source !== 'string' || !source.trim()) throw new Error('原理图源码读取失败')
		const parsed = parseSourceLog(source)
		if (parsed.docType !== 'SCH_PAGE' || parsed.uuid !== focus.uuid) throw new Error('导线源码与当前原理图身份不符', { cause: { focusChanged: true } })
		const records = resolveRecords(parsed)
		const wires = await eda.sch_PrimitiveWire.getAll()
		if (!Array.isArray(wires)) throw new Error('无法枚举原理图导线')
		const wire = wires.find(item => safeState<string>(item, 'getState_PrimitiveId') === wireId)
		if (!wire) throw new Error(`导线 ${wireId} 不存在或尚未同步`)
		const values: Record<string, any> = {}
		for (const [field, getter] of Object.entries({ net: 'getState_Net', color: 'getState_Color', lineWidth: 'getState_LineWidth', lineType: 'getState_LineType' })) {
			const state = readState<any>(wire, getter)
			if (!state.ok || state.value === undefined) throw new Error(`导线 ${wireId} 的 ${field} getter 不可确认`)
			values[field] = state.value
		}
		if (typeof values.net !== 'string' || values.lineType !== null && ![0, 1, 2].includes(values.lineType)) throw new Error('导线网络或线型读回非法')
		if (!records.has(`WIRE\u0000${wireId}`)) throw new Error('源码缺少目标WIRE')
		const lines = [...records.values()].filter(record => record.header.type === 'LINE' && (record.data as any)?.lineGroup === wireId)
		if (!lines.length) throw new Error('源码缺少目标LINE')
		for (const record of lines) {
			const data = record.data as any
			const type = values.lineType === null ? null : ['SOLID', 'SHORT_DASH', 'DOT'][values.lineType]
			if (![data.startX, data.startY, data.endX, data.endY].every(value => typeof value === 'number' && Number.isFinite(value))
				|| data.strokeColor !== values.color || data.strokeWidth !== values.lineWidth || data.strokeStyle !== type)
				throw new Error('目标LINE的几何或样式与getter不一致')
		}
		const attrs = new Map([...records.entries()].filter(([, record]) => record.header.type === 'ATTR'
			&& (record.data as any)?.parentId === wireId && ['NET', 'Name'].includes((record.data as any)?.key)))
		if ([...attrs.values()].some(record => typeof (record.data as any).value !== 'string' || (record.data as any).value !== values.net))
			throw new Error('目标NET/Name与getter网络不一致')
		const finalFocus = await eda.dmt_SelectControl.getCurrentDocumentInfo()
		if (finalFocus?.documentType !== 1 || finalFocus.uuid !== focus.uuid) throw new Error('读取导线期间焦点改变', { cause: { focusChanged: true } })
		const unkeyed = parsed.records.filter(record => record.header.type !== 'DOCHEAD' && record.header.id == null).map(record => content(record))
		return { uuid: focus.uuid, records, attrs, values, unkeyed }
	}
	const compareUnchanged = (before: Awaited<ReturnType<typeof read>>, after: Awaited<ReturnType<typeof read>>) => {
		if (stable(before.unkeyed) !== stable(after.unkeyed)) throw new Error('非请求的无ID源码记录发生变化')
		for (const key of new Set([...before.records.keys(), ...after.records.keys()])) {
			const a = before.records.get(key), b = after.records.get(key)
			if (a?.header.type === 'DOCHEAD' || b?.header.type === 'DOCHEAD' || before.attrs.has(key) || after.attrs.has(key)) continue
			if (!a || !b || content(a) !== content(b)) throw new Error(`非请求源码记录发生变化：${key.replace('\u0000', ':')}`)
		}
	}
	try {
		const before = await read()
		if (options.requireUnnamed && before.values.net !== '') throw new Error(`导线 ${wireId} 不是无名导线，未执行收养`)
		const check = await read(before.uuid)
		compareUnchanged(before, check)
		if (stable([...before.attrs].map(([key, record]) => [key, content(record)])) !== stable([...check.attrs].map(([key, record]) => [key, content(record)]))) throw new Error('写前目标网络属性已变化')
		const { color, lineWidth, lineType } = before.values
		writeAttempted = true
		sdkResult = await eda.sch_PrimitiveWire.modify(wireId, { color, lineWidth, lineType, net: targetNet } as any)
		for (const waitMs of [300, 500, 800]) {
			await new Promise(resolve => setTimeout(resolve, waitMs))
			try {
				const after = await read(before.uuid)
				compareUnchanged(before, after)
				if (after.values.net !== targetNet || ['color', 'lineWidth', 'lineType'].some(field => after.values[field] !== before.values[field])) throw new Error('网络或原样式未在同次采样中读回')
				if (!after.attrs.size) throw new Error('写后缺少目标网络属性')
				if (before.attrs.size) {
					for (const key of before.attrs.keys()) {
						if (!after.attrs.has(key) && after.records.has(key)) throw new Error('旧网络属性未删除而被改为非目标记录')
					}
					for (const [key, record] of after.attrs) {
						const original = before.attrs.get(key)
						if (!original || content(original, true) !== content(record, true)) throw new Error('网络属性身份或非value字段发生变化')
					}
					if (after.attrs.size !== before.attrs.size && after.attrs.size !== 1) throw new Error('重复网络属性未完整保留或收敛为一个原有属性')
				}
				else {
					if (after.attrs.size !== 1) throw new Error('无名导线新增了多个网络属性')
					const [key, record] = [...after.attrs][0]
					const data = record.data as any
					const fields = ['id', 'x', 'y', 'rotation', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'italic', 'underline', 'align', 'value', 'keyVisible', 'valueVisible', 'key', 'fillColor', 'parentId', 'zIndex']
					if (before.records.has(key) || typeof record.header.id !== 'string' || !record.header.id.trim()
						|| !Object.keys(data).every(field => fields.includes(field))
						|| (data.id != null && data.id !== record.header.id)
						|| !['x', 'y'].every(field => data[field] == null || typeof data[field] === 'number' && Number.isFinite(data[field]))
						|| !['keyVisible', 'valueVisible'].every(field => data[field] == null || typeof data[field] === 'boolean')
						|| !(data.zIndex == null || Number.isSafeInteger(data.zIndex))
						|| !Object.keys(data).filter(field => !['id', 'x', 'y', 'keyVisible', 'valueVisible', 'key', 'parentId', 'value', 'zIndex'].includes(field)).every(field => data[field] == null))
						throw new Error('新增网络属性结构不可确认或挪用了原有非目标记录')
				}
				if (!sdkResult) throw new Error('修改接口返回空/false，效果证据不能代替明确应答')
				return { primitiveId: wireId, net: targetNet, readback: { net: targetNet, verified: true, sourceGeometryVerified: true, styleVerified: true, nonTargetSourceVerified: true }, duplicateRemaining: Math.max(0, after.attrs.size - 1) }
			}
			catch (error) {
				if ((error as any)?.cause?.focusChanged) throw error
				lastFailure = String((error as any)?.message ?? error)
			}
		}
		throw new Error(lastFailure || '完整改网读回未确认')
	}
	catch (error) {
		if (!writeAttempted) throw error
		throw new Error(`导线 ${wireId} 的网络写入结果或完整保留未确认`, { cause: { partial: true, retryable: false, operation: 'schematic.setWireNet', primitiveId: wireId, phase: 'post-write-verification', result: { targetNet, sdkReturned: Boolean(sdkResult), failedCheck: String((error as any)?.message ?? error) } } })
	}
}

interface ITextSourceDeleteOptions {
	beforeWrite?: () => void
	shouldStop?: () => boolean
	onWriteStart?: () => void
	timeoutMs?: number
}

/** Remove exact live TEXT source rows and verify both effective source and model before reporting success. */
async function deleteTextFromSourceSnapshot(ids: Array<string>, options: ITextSourceDeleteOptions = {}) {
	const startedAt = performance.now()
	const budgetMs = Math.min(290_000, Math.max(1000, Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 290_000))
	const steps: Array<string> = []
	let writeAttempted = false
	const stopped = () => options.shouldStop?.() === true
	const budgetExpired = () => performance.now() - startedAt >= budgetMs
	const stableJson = (value: unknown): string => {
		if (Array.isArray(value))
			return `[${value.map(stableJson).join(',')}]`
		if (value && typeof value === 'object') {
			const object = value as Record<string, unknown>
			return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
		}
		return JSON.stringify(value)
	}
	const comparableHeader = (header: unknown): unknown => {
		if (!header || typeof header !== 'object' || Array.isArray(header))
			return header
		const { ticket: _ticket, ...content } = header as Record<string, unknown>
		return content
	}
	const sourceContentKey = (header: unknown, data: unknown): string => `${stableJson(comparableHeader(header))}||${stableJson(data)}`
	const awaitWithinBudget = async <T>(promise: Promise<T>, label: string): Promise<T> => {
		const remaining = budgetMs - (performance.now() - startedAt)
		if (remaining <= 0)
			throw new Error(`${label}前单指令时间预算已到期（${budgetMs}ms）`)
		let timer: ReturnType<typeof setTimeout> | undefined
		let result: T
		try {
			result = await Promise.race([
				promise,
				new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超出单指令时间预算（${budgetMs}ms）；原调用可能仍在后台执行`)), remaining) }),
			])
		}
		finally {
			if (timer !== undefined)
				clearTimeout(timer)
		}
		if (stopped())
			throw new Error(`${label}返回后删除流程已停止，禁止继续依赖迟到结果`)
		return result
	}
	try {
		if (stopped())
			throw new Error('前序写入状态不确定或时间预算到期，停止 typed TEXT 删除')
		const focus = await awaitWithinBudget(eda.dmt_SelectControl.getCurrentDocumentInfo(), '读取焦点文档')
		if (focus?.documentType !== 1 || typeof focus?.uuid !== 'string' || !focus.uuid.trim())
			throw new Error(`焦点文档不是有效原理图（documentType=${focus?.documentType ?? '未知'}, uuid=${focus?.uuid ?? '无'}）`)
		const source = await awaitWithinBudget(eda.sys_FileManager.getDocumentSource(), '读取原理图源码')
		if (typeof source !== 'string' || !source.trim())
			throw new Error('getDocumentSource 返回空或非法值')
		const before = parseSourceLog(source)
		if (before.docType !== 'SCH_PAGE' || before.uuid !== focus.uuid)
			throw new Error(`源码身份与当前原理图不符（docType=${before.docType}, 源码 UUID=${before.uuid}, 焦点 UUID=${focus.uuid}）`)
		const effectiveBefore = resolveRecords(before)
		const liveText = new Map(Array.from(resolveRecords(before, 'TEXT'), ([key, record]) => [key.slice('TEXT\u0000'.length), record] as const))
		const modelIdsValue = await awaitWithinBudget(eda.sch_PrimitiveText.getAllPrimitiveId(), '读取 TEXT 模型')
		if (!Array.isArray(modelIdsValue) || modelIdsValue.some(id => typeof id !== 'string'))
			throw new Error('TEXT 模型枚举返回非法结构')
		const modelBefore = new Set<string>(modelIdsValue)
		for (const [id] of liveText) {
			if (!modelBefore.has(id))
				throw new Error(`源码存在有效 TEXT ${id}，但模型枚举中缺失；拒绝基于不一致状态写入`)
		}
		for (const id of modelBefore) {
			if (!liveText.has(id))
				throw new Error(`模型存在 TEXT ${id}，但有效源码中缺失；拒绝基于不一致状态写入`)
		}
		const deleted: Array<string> = []
		const skipped: Array<string> = []
		for (const id of ids) {
			const matchingRecords = before.records.filter(record => record.header.type === 'TEXT' && String(record.header.id ?? '') === id)
			if (matchingRecords.length > 1)
				throw new Error(`目标 TEXT ${id} 在源码中有 ${matchingRecords.length} 条同 ID 记录，快照删除存在歧义`)
			const live = liveText.get(id)
			if (!live) {
				skipped.push(id)
				steps.push(`${id}: 有效源码与模型均无现存 TEXT，跳过（已删除或从未存在）`)
				continue
			}
			const record = matchingRecords[0]
			if (!record || record.data === '')
				throw new Error(`目标 TEXT ${id} 的有效记录无法唯一映射到源码行`)
			deleted.push(id)
			steps.push(`${id}: 已将有效 TEXT 源码行 ${record.line} 唯一映射为 typed delete 目标`)
		}
		if (!deleted.length)
			return { deleted, skipped, strategy: 'typed-api' as const, steps, sourceVerified: true as const, modelVerified: true as const, persistenceVerified: false as const, modelGone: Object.fromEntries(ids.map(id => [id, true])), note: '没有现存 TEXT 需要移除' }
		if (stopped())
			throw new Error('typed TEXT 删除前流程已停止')
		options.beforeWrite?.()
		if (budgetExpired())
			throw new Error(`typed TEXT 删除前单指令时间预算已到期（${budgetMs}ms）`)
		const latestFocus = await awaitWithinBudget(eda.dmt_SelectControl.getCurrentDocumentInfo(), '写入前复核焦点文档')
		if (latestFocus?.documentType !== 1 || latestFocus?.uuid !== focus.uuid)
			throw new Error(`typed TEXT 删除前焦点文档已变化（原页=${focus.uuid}, 当前=${latestFocus?.uuid ?? '未知'}）`)
		if (stopped() || budgetExpired())
			throw new Error('typed TEXT 删除前流程已停止')
		options.beforeWrite?.()
		if (stopped() || budgetExpired())
			throw new Error('typed TEXT 删除前流程已停止或时间预算到期')
		writeAttempted = true
		options.onWriteStart?.()
		let deleteResult: unknown
		let deleteError: unknown
		let deleteThrew = false
		try {
			deleteResult = await awaitWithinBudget(eda.sch_PrimitiveText.delete(deleted), 'sch_PrimitiveText.delete')
		}
		catch (error) {
			deleteError = error
			deleteThrew = true
		}
		steps.push(!deleteThrew ? `sch_PrimitiveText.delete 返回 ${JSON.stringify(deleteResult)}` : `sch_PrimitiveText.delete 结果未知：${String((deleteError as any)?.message ?? deleteError)}`)
		const backValue = await awaitWithinBudget(eda.sys_FileManager.getDocumentSource(), '读取写后源码')
		if (typeof backValue !== 'string' || !backValue.trim())
			throw new Error('写后 getDocumentSource 返回空或非法值')
		const back = parseSourceLog(backValue)
		if (back.docType !== before.docType || back.uuid !== before.uuid)
			throw new Error(`写后源码身份改变（docType=${back.docType}, uuid=${back.uuid}）`)
		const effectiveAfter = resolveRecords(back)
		const textAfter = new Map(Array.from(resolveRecords(back, 'TEXT'), ([key, record]) => [key.slice('TEXT\u0000'.length), record] as const))
		for (const id of deleted) {
			if (textAfter.has(id))
				throw new Error(`目标 TEXT ${id} 的有效源码仍存在（快照移除未生效）`)
			if (effectiveAfter.has(`TEXT\u0000${id}`))
				throw new Error(`目标 TEXT ${id} 仍是有效源码记录（快照移除未生效）`)
		}
		const deletedSet = new Set(deleted)
		const sourceRows = (records: typeof before.records) => records.filter(record => record.header.type !== 'DOCHEAD' && !(record.header.type === 'TEXT' && deletedSet.has(String(record.header.id ?? ''))))
		const expectedRows = new Map<string, number>()
		for (const record of sourceRows(before.records)) {
			const key = sourceContentKey(record.header, record.data)
			expectedRows.set(key, (expectedRows.get(key) ?? 0) + 1)
		}
		const actualRows = new Map<string, number>()
		for (const record of back.records.filter(record => record.header.type !== 'DOCHEAD')) {
			const key = sourceContentKey(record.header, record.data)
			actualRows.set(key, (actualRows.get(key) ?? 0) + 1)
		}
		if (expectedRows.size !== actualRows.size || [...expectedRows].some(([key, count]) => actualRows.get(key) !== count))
			throw new Error('写后完整源码中非目标记录发生变化（包含无图元 ID 的记录）')
		const expectedOther = new Map(effectiveBefore)
		for (const id of deleted)
			expectedOther.delete(`TEXT\u0000${id}`)
		if (expectedOther.size !== effectiveAfter.size)
			throw new Error(`写后有效源码记录数变化（预期 ${expectedOther.size}，实际 ${effectiveAfter.size}）`)
		for (const [key, record] of expectedOther) {
			const actual = effectiveAfter.get(key)
			if (!actual || stableJson(comparableHeader(record.header)) !== stableJson(comparableHeader(actual.header)) || stableJson(record.data) !== stableJson(actual.data))
				throw new Error(`写后非目标有效源码记录发生变化：${key.replace('\u0000', ':')}`)
		}
		steps.push('有效源码读回确认目标已移除且非目标记录未变')
		const modelAfterValue = await awaitWithinBudget(eda.sch_PrimitiveText.getAllPrimitiveId(), '读取写后 TEXT 模型')
		if (!Array.isArray(modelAfterValue) || modelAfterValue.some(id => typeof id !== 'string'))
			throw new Error('写后 TEXT 模型枚举返回非法结构')
		const modelAfter = new Set<string>(modelAfterValue)
		const expectedModel = new Set(modelBefore)
		for (const id of deleted)
			expectedModel.delete(id)
		if (expectedModel.size !== modelAfter.size || [...expectedModel].some(id => !modelAfter.has(id)))
			throw new Error('写后 TEXT 模型内容与预期不符（目标须消失且非目标 ID 保持不变）')
		const modelGone = Object.fromEntries(deleted.map(id => [id, !modelAfter.has(id)]))
		steps.push('TEXT 模型读回确认目标消失且非目标 ID 未变')
		if (deleteThrew || deleteResult !== true)
			throw new Error(`typed delete 未返回明确 true（结果=${JSON.stringify(deleteResult)}${deleteThrew ? `，异常=${String((deleteError as any)?.message ?? deleteError)}` : ''}）；已只读记录写后源码和模型状态，不执行补偿写入`)
		return { deleted, skipped, strategy: 'typed-api' as const, steps, sourceVerified: true as const, modelVerified: true as const, persistenceVerified: false as const, modelGone }
	}
	catch (cause) {
		const error = new Error(`TEXT 源码删除失败：${String((cause as any)?.message ?? cause)}`)
		;(error as any).cause = { partial: writeAttempted, operation: 'schematic.delete', writeAttempted, steps: [...steps], error: String((cause as any)?.message ?? cause) }
		throw error
	}
}

/**
 * 0.10.48（GPT KIMI-EDA-20261002-07 R2）：官方 create 拒绝（throw "create failed!" 等）时标注失败阶段。
 * 前缀 [阶段] 到 message，原始错误挂 cause，原始堆栈追加在包装堆栈之后——registry 统一回传 name+stack。
 */
function stageError(stage: string, err: unknown): Error {
	const orig = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err))
	const wrapped = new Error(`[${stage}] ${orig.message}`)
	wrapped.name = orig.name
	;(wrapped as any).cause = err
	;(wrapped as any).stage = stage
	if (orig.stack)
		wrapped.stack = `${wrapped.stack}\n--- 原始堆栈 ---\n${orig.stack}`
	return wrapped
}
async function withStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
	try {
		return await fn()
	}
	catch (err) {
		throw stageError(stage, err)
	}
}

/**
 * 检查网络名是否已存在于当前图页（命名导线或网络标签）。
 * 智能命名用：同一网络只命名一次，其余段画无名，
 * 避免段合并后 NET 属性叠加产生"导线有多个网络名"警告（官方 modify 删不掉重复属性）。
 */
async function netExistsOnPage(net: string): Promise<boolean> {
	try {
		// 注意：getAll(net) 的过滤参数在运行时不可靠（实测返回空），
		// 必须全量取回后按 getState_Net() 手动过滤
		const wires = await eda.sch_PrimitiveWire.getAll()
		for (const w of wires ?? []) {
			if (safeState<string>(w, 'getState_Net') === net)
				return true
		}
	}
	catch {
		// 查询失败按不存在处理，退化为直接命名
	}
	try {
		const attrs = await eda.sch_PrimitiveAttribute.getAll()
		for (const a of attrs ?? []) {
			const key = safeState<string>(a, 'getState_Key') ?? ''
			if (key.includes('NET') && safeState<string>(a, 'getState_Value') === net)
				return true
		}
	}
	catch {
		// 同上
	}
	return false
}

/**
 * 把折点序列拆成简单两点段：去零长、去重（归一方向）、跳过非水平/垂直段。
 * 官方一次创建多分支折线会被拒（返回空），逐段创建则由官方自动合并相连段；
 * 斜线段多为官方折线数据里 T 形分支编码的伪段（端点必被正交段连通），安全跳过。
 */
function splitToSimpleSegments(pts: Array<[number, number]>): {
	segments: Array<[number, number, number, number]>
	skippedDiagonal: number
} {
	const seen = new Set<string>()
	const segments: Array<[number, number, number, number]> = []
	let skippedDiagonal = 0
	for (let i = 0; i + 1 < pts.length; i++) {
		const [x1, y1] = pts[i]
		const [x2, y2] = pts[i + 1]
		if (x1 === x2 && y1 === y2)
			continue
		if (x1 !== x2 && y1 !== y2) {
			skippedDiagonal += 1
			continue
		}
		const key = `${Math.min(x1, x2)},${Math.min(y1, y2)},${Math.max(x1, x2)},${Math.max(y1, y2)}`
		if (seen.has(key))
			continue
		seen.add(key)
		segments.push([x1, y1, x2, y2])
	}
	return { segments, skippedDiagonal }
}

/** 解析 "U1.5" 或 {designator, pin} 为引脚世界坐标（含器件锚点、引脚朝向和长度，用于短桩方向；noConnected 为 NC 未连接标识） */
async function resolvePinPoint(ref: string): Promise<{ x: number, y: number, compX: number, compY: number, designator: string, pin: string, rot: number, pinLen: number, noConnected: boolean }> {
	const m = /^([A-Za-z]+\d+)\.(.+)$/.exec(ref.trim())
	if (!m)
		throw new Error(`引脚引用格式错误："${ref}"（应为 "位号.引脚号"，如 U1.5）`)
	const [, designator, pin] = m
	const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
	const comp = comps.find(c => safeState<string>(c, 'getState_Designator') === designator)
	if (!comp)
		throw new Error(`找不到器件 ${designator}（用 schematic.listComponents 查位号）`)
	const primitiveId = safeState<string>(comp, 'getState_PrimitiveId')
	const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(String(primitiveId))
	const hit = (pins ?? []).find(p => String(p.getState_PinNumber?.()) === pin)
	if (!hit)
		throw new Error(`${designator} 没有引脚 ${pin}（用 schematic.listPins 查引脚号）`)
	return {
		x: hit.getState_X?.() ?? 0,
		y: hit.getState_Y?.() ?? 0,
		compX: safeState<number>(comp, 'getState_X') ?? 0,
		compY: safeState<number>(comp, 'getState_Y') ?? 0,
		designator,
		pin,
		rot: hit.getState_Rotation?.() ?? 0,
		pinLen: hit.getState_PinLength?.() ?? 10,
		noConnected: Boolean(hit.getState_NoConnected?.()),
	}
}

/** NC（未连接）引脚预检：官方禁止在 NC 引脚上接线（create 直接抛原始错误），提前给出中文提示 */
function assertPinConnectable(p: { designator: string, pin: string, noConnected: boolean }): void {
	if (p.noConnected)
		throw new Error(`引脚 ${p.designator}.${p.pin} 为 NC 未连接引脚，官方禁止接线。请改用有电气连接的引脚，或先在器件属性中取消该引脚的 NC 标识`)
}

/** 收集当前页全部器件引脚坐标（短桩防撞用） */
async function collectAllPinPoints(): Promise<Array<{ x: number, y: number }>> {
	const pts: Array<{ x: number, y: number }> = []
	const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
	for (const c of comps) {
		const id = safeState<string>(c, 'getState_PrimitiveId')
		if (!id)
			continue
		const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(id)
		for (const p of pins ?? []) {
			const x = p.getState_X?.()
			const y = p.getState_Y?.()
			if (x != null && y != null)
				pts.push({ x, y })
		}
	}
	return pts
}

/** 共线重叠检测（水平/垂直段） */
function segCollinearOverlap(a: [number, number, number, number], b: [number, number, number, number]): boolean {
	if (a[1] === a[3] && b[1] === b[3] && a[1] === b[1])
		return Math.max(Math.min(a[0], a[2]), Math.min(b[0], b[2])) < Math.min(Math.max(a[0], a[2]), Math.max(b[0], b[2]))
	if (a[0] === a[2] && b[0] === b[2] && a[0] === b[0])
		return Math.max(Math.min(a[1], a[3]), Math.min(b[1], b[3])) < Math.min(Math.max(a[1], a[3]), Math.max(b[1], b[3]))
	return false
}

/** 现有导线的全部正交段（错层/防撞查询用） */
async function collectWireSegsByNet(): Promise<Array<{ id: string, net: string, segment: [number, number, number, number] }>> {
	const focus = await eda.dmt_SelectControl.getCurrentDocumentInfo()
	if (focus?.documentType !== 1 || !focus.uuid) throw new Error('无法确认当前原理图身份，拒绝读取导线段')
	const source = await eda.sys_FileManager.getDocumentSource()
	if (typeof source !== 'string' || !source.trim())
		throw new Error('无法读取原理图源码，拒绝使用未经核实的导线段作为避让依据')
	const parsed = parseSourceLog(source)
	if (parsed.docType !== 'SCH_PAGE' || parsed.uuid !== focus.uuid)
		throw new Error('源码不是当前原理图页，无法读取真实导线段')
	const wires = await eda.sch_PrimitiveWire.getAll()
	const after = await eda.dmt_SelectControl.getCurrentDocumentInfo()
	if (after?.documentType !== 1 || after.uuid !== focus.uuid) throw new Error('读取导线段期间焦点已改变')
	if (!Array.isArray(wires)) throw new Error('无法枚举原理图导线，拒绝使用未经核实的网络归属')
	const wireNets = new Map<string, string>()
	for (const wire of wires) {
		const id = readState<string>(wire, 'getState_PrimitiveId')
		const net = readState<string>(wire, 'getState_Net')
		if (!id.ok || !id.value || !net.ok || typeof net.value !== 'string')
			throw new Error('导线 ID 或网络 getter 读取失败，拒绝判断接触是否会串网')
		wireNets.set(id.value, net.value)
	}
	const segs: Array<{ id: string, net: string, segment: [number, number, number, number] }> = []
	for (const record of resolveRecords(parsed, 'LINE').values()) {
		const data = record.data as Record<string, unknown>
		if (data?.lineGroup == null) continue
		const id = String(data.lineGroup)
		const net = wireNets.get(id)
		if (net == null) throw new Error(`LINE ${String(record.header.id)} 引用的 WIRE ${id} 未在 SDK 导线模型中读回`)
		const values = [data.startX, data.startY, data.endX, data.endY]
		if (!values.every(value => typeof value === 'number' && Number.isFinite(value)))
			throw new Error(`LINE ${String(record.header.id)} 几何读回非法，拒绝继续布线`)
		const segment = [values[0] as number, -(values[1] as number), values[2] as number, -(values[3] as number)] as [number, number, number, number]
		if (segment[0] !== segment[2] || segment[1] !== segment[3]) segs.push({ id, net, segment })
	}
	return segs
}

async function collectWireSegs(): Promise<Array<[number, number, number, number]>> {
	return (await collectWireSegsByNet()).map(item => item.segment)
}

function segmentsIntersectOrTouch(a: [number, number, number, number], b: [number, number, number, number]): boolean {
	const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
		(bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
	const on = (x: number, y: number, seg: [number, number, number, number]) =>
		Math.abs(orient(seg[0], seg[1], seg[2], seg[3], x, y)) < 1e-8
		&& x >= Math.min(seg[0], seg[2]) - 1e-8 && x <= Math.max(seg[0], seg[2]) + 1e-8
		&& y >= Math.min(seg[1], seg[3]) - 1e-8 && y <= Math.max(seg[1], seg[3]) + 1e-8
	const o1 = orient(a[0], a[1], a[2], a[3], b[0], b[1])
	const o2 = orient(a[0], a[1], a[2], a[3], b[2], b[3])
	const o3 = orient(b[0], b[1], b[2], b[3], a[0], a[1])
	const o4 = orient(b[0], b[1], b[2], b[3], a[2], a[3])
	return (o1 * o2 < 0 && o3 * o4 < 0)
		|| Math.abs(o1) < 1e-8 && on(b[0], b[1], a)
		|| Math.abs(o2) < 1e-8 && on(b[2], b[3], a)
		|| Math.abs(o3) < 1e-8 && on(a[0], a[1], b)
		|| Math.abs(o4) < 1e-8 && on(a[2], a[3], b)
}

/** 查询某个坐标点已被哪些网络的导线占用（点在导线任意段上即算占用；无名导线记为 "(无名)"） */
async function findWireNetsAtPoint(x: number, y: number): Promise<Array<string>> {
	const nets = new Set<string>()
	for (const { net, segment } of await collectWireSegsByNet()) {
		if (segmentsIntersectOrTouch(segment, [x, y, x, y]))
			nets.add(net || '(无名)')
	}
	return [...nets]
}

/**
 * 网表 JSON 里取器件位号：实测官方 getNetlistFile 导出的 components 以 "gge1" 这类 uuid 为键，
 * 位号在 c.props.Designator（不在顶层 designator）——0.10.9 之前三处审计都取错键导致 "gge1.1" 式 key 全对不上。
 */
function netlistRefOf(c: any, key: string): string {
	return String(c?.designator ?? c?.props?.Designator ?? c?.props?.designator ?? c?.refDes ?? c?.name ?? key)
}

/** 网表 pinInfoMap 的引脚号：键一般是引脚号字符串，稳妥起见优先取条目内 number 字段 */
function netlistPinOf(pinKey: string, info: any): string {
	return String(info?.number ?? info?.pin ?? pinKey)
}

/** 点到线段距离（0.10.26：labelWire 短桩全程避引脚用——0.10.24 终验实锤只查端点会让短桩横穿第三方引脚中段） */
function pointToSegDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
	const dx = x2 - x1
	const dy = y2 - y1
	if (dx === 0 && dy === 0)
		return Math.hypot(px - x1, py - y1)
	const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
	return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * 导出当前页「位号.引脚号 → 网络名」映射（0.10.19 autoLayout 用，与 batchWire 审计同款逻辑）：
 * 位号键在 c.props.Designator，引脚号优先 pinInfoMap 条目 number 字段。失败返回 undefined。
 */
async function exportSchematicPinNetMap(): Promise<Map<string, string> | undefined> {
	try {
		const file = await eda.sch_ManufactureData.getNetlistFile()
		if (!file)
			return undefined
		const data = JSON.parse(await (file as File).text())
		const comps = data.components ?? {}
		const entries: Array<[string, any]> = Array.isArray(comps)
			? comps.map((c: any) => [c?.uuid ?? c?.id ?? '?', c])
			: Object.entries(comps)
		const map = new Map<string, string>()
		for (const [key, c] of entries) {
			const ref = netlistRefOf(c, key)
			const pim = c?.pinInfoMap ?? c?.pins ?? {}
			const pe: Array<[string, any]> = Array.isArray(pim)
				? pim.map((p: any, idx: number) => [String(p?.pin ?? idx), p])
				: Object.entries(pim)
			for (const [pin, info] of pe) {
				const n = info?.net ?? info?.netName
				if (n)
					map.set(`${ref}.${netlistPinOf(pin, info)}`, String(n))
			}
		}
		return map
	}
	catch {
		return undefined
	}
}

/**
 * 文本网表（PADS 格式）解析「位号.引脚号 → 网络名」映射（0.10.45，GPT KIMI-EDA-20261002-05）：
 * PADS 文本结构为 `*SIGNAL* <网名>` 行后跟 `R1.1 R2.1` 成员行——实测 4.1.60 可用。
 * 官方 sch_Netlist.getNetlist 在 JLCEDA/EasyEDA 格式上有宿主级缺陷（JLCEDA 挂起>120s / EasyEDA 返空，
 * 你方现场 JLCEDA 报 "i is not iterable"），故回退路径只用已实测可用的格式。
 */
async function pinNetMapFromPadsText(): Promise<Map<string, string> | undefined> {
	try {
		const text = await withTimeout(eda.sch_Netlist.getNetlist('PADS' as any), 45000, 'getNetlist(PADS)')
		if (typeof text !== 'string' || !text.includes('*SIGNAL*'))
			return undefined
		const map = new Map<string, string>()
		let net: string | undefined
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim()
			const sig = /^\*SIGNAL\*\s+(.+)$/.exec(line)
			if (sig) {
				net = sig[1].trim()
				continue
			}
			if (!net || line.startsWith('*') || !line)
				continue
			for (const token of line.split(/\s+/)) {
				const m = /^(.+?)\.(\d+)$/.exec(token)
				if (m)
					map.set(`${m[1]}.${m[2]}`, net)
			}
		}
		return map.size ? map : undefined
	}
	catch {
		return undefined
	}
}

/**
 * 带回退的「位号.引脚号 → 网络名」映射（0.10.45）：
 * 首选 getNetlistFile（JSON，信息最全），官方返空/抛错（如器件缺封装——04 实测因果）时
 * 回退 sch_Netlist.getNetlist('PADS') 文本解析（官方 @deprecated 但可用、与前者独立实现）。
 * 两条都失败才返回 undefined。batchWire 终审 / repairNet / autoLayout 共用，保证缺封装工程上
 * 接线工具的占用预检与最终审计仍有已验证的网表读取路径（GPT -05 诉求）。
 */
async function pinNetMapRobust(): Promise<Map<string, string> | undefined> {
	return await exportSchematicPinNetMap() ?? await pinNetMapFromPadsText()
}

/** 电源网基名（buildBlock/autoLayout 共享）：0.10.18 起允许全大写后缀（VDD_T/VOUT_5V），小写后缀视为信号不误判 */
const POWER_BASE_RE = /^(GND|AGND|DGND|PGND|VCC|VDD|VDDIO|VIN|VOUT|3V3|3\.3V|5V|12V|24V|VBAT|VBUS)$/i
function isPowerNetName(name: string): boolean {
	return POWER_BASE_RE.test(String(name).replace(/(_[A-Z0-9]+)+$/, ''))
}

/**
 * 通用源码扫描（0.10.17 fixNetLabels 用）：枚举全部网络标签类 ATTR（key 为 NET/Name/_NETLABEL_），
 * 附旋转角度与归属（parentId：导线 ID 或 $$root 浮空），并解析 LINE 记录给出所属导线几何（源码坐标系，Y 与 API 相反）。
 * ⚠️ 探针实锤：镜像标志 isMirror 只存在于 COMPONENT 记录，ATTR（标签）记录里没有 mirror 字段——
 * 标签"镜像反字"在源码里只能以 rotation 异常（90/180/270）形式观察到。
 */
async function scanNetLabelAttrsFromSource(): Promise<{
	labels: Array<{ primitiveId: string, net: string, x?: number, y?: number, rotation?: number, parentId?: string }>
	wireLines: Map<string, Array<[number, number, number, number]>>
}> {
	const source = await eda.sys_FileManager.getDocumentSource()
	if (!source)
		throw new Error('读取文档源码失败（请确认有原理图页处于激活状态）')
	const labels: Array<{ primitiveId: string, net: string, x?: number, y?: number, rotation?: number, parentId?: string }> = []
	const wireLines = new Map<string, Array<[number, number, number, number]>>()
	const tokens = String(source).split(/[|\n]+/)
	let pendingAttrId: string | undefined
	for (const tok of tokens) {
		if (!tok.startsWith('{'))
			continue
		let rec: any
		try {
			rec = JSON.parse(tok)
		}
		catch {
			continue
		}
		if (rec.type === 'ATTR' && rec.id) {
			pendingAttrId = String(rec.id)
			continue
		}
		if (pendingAttrId && /^(NET|Name|_NETLABEL_)$/i.test(String(rec.key ?? ''))) {
			labels.push({
				primitiveId: pendingAttrId,
				net: String(rec.value ?? ''),
				x: typeof rec.x === 'number' ? rec.x : undefined,
				y: typeof rec.y === 'number' ? rec.y : undefined,
				rotation: typeof rec.rotation === 'number' ? rec.rotation : undefined,
				parentId: rec.parentId != null ? String(rec.parentId) : undefined,
			})
		}
		pendingAttrId = undefined
		// 导线几何在独立 LINE 记录里（lineGroup = 导线 ID，源码坐标）
		if (rec.type === undefined && typeof rec.startX === 'number' && rec.lineGroup) {
			const g = String(rec.lineGroup)
			const arr = wireLines.get(g) ?? []
			arr.push([Number(rec.startX), Number(rec.startY), Number(rec.endX), Number(rec.endY)])
			wireLines.set(g, arr)
		}
	}
	return { labels, wireLines }
}

/**
 * 枚举浮空网络标签（官方 sch_PrimitiveAttribute.getAll 不枚举 parentId=$$root 的浮空标签，API 盲区）。
 * 绕行：读文档源码（sys_FileManager.getDocumentSource），解析 ATTR 记录中 key=_NETLABEL_ 且 parentId=$$root 的项。
 */
async function scanFloatingNetLabels(): Promise<Array<{ primitiveId: string, net: string, x?: number, y?: number }>> {
	const source = await eda.sys_FileManager.getDocumentSource()
	if (!source)
		throw new Error('读取文档源码失败（请确认有原理图页处于激活状态）')
	const out: Array<{ primitiveId: string, net: string, x?: number, y?: number }> = []
	// 源码是按 | 分隔的 JSON 片段流，ATTR 记录为 {head}||{body} 两段
	const tokens = String(source).split(/[|\n]+/)
	let pendingAttrId: string | undefined
	for (const tok of tokens) {
		if (!tok.startsWith('{'))
			continue
		let rec: any
		try {
			rec = JSON.parse(tok)
		}
		catch {
			continue
		}
		if (rec.type === 'ATTR' && rec.id) {
			pendingAttrId = String(rec.id)
			continue
		}
		if (pendingAttrId && rec.key === '_NETLABEL_' && rec.parentId === '$$root') {
			out.push({
				primitiveId: pendingAttrId,
				net: String(rec.value ?? ''),
				x: typeof rec.x === 'number' ? rec.x : undefined,
				y: typeof rec.y === 'number' ? rec.y : undefined,
			})
		}
		pendingAttrId = undefined
	}
	return out
}

/**
 * 收集全部网络标签（附着 + 浮空）——listNetLabels 与 structuralAudit 共用。
 * 0.10.60 从 listNetLabels handler 原样抽出，行为不变。
 */
async function collectNetLabels(netFilter?: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = []
	const seen = new Set<string>()
	// ① 附着标签：逐导线取属性（getAll(parentId) 按父图元过滤是可靠的，与 getAll(net) 不同）
	const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
	for (const w of wires) {
		const wireId = safeState<string>(w, 'getState_PrimitiveId')
		if (!wireId)
			continue
		let attrs: Array<any> = []
		try {
			attrs = (await eda.sch_PrimitiveAttribute.getAll(wireId)) ?? []
		}
		catch {
			continue
		}
		for (const a of attrs) {
			const key = safeState<string>(a, 'getState_Key') ?? ''
			if (!/^(NET|Name)$/i.test(key))
				continue
			const value = safeState<string>(a, 'getState_Value') ?? ''
			if (!value || (netFilter && value !== netFilter))
				continue
			const id = safeState<string>(a, 'getState_PrimitiveId') ?? ''
			seen.add(id)
			out.push({
				primitiveId: id,
				net: value,
				x: safeState<number>(a, 'getState_X'),
				y: safeState<number>(a, 'getState_Y'),
				color: safeState<string>(a, 'getState_Color'),
				rotation: safeState<number>(a, 'getState_Rotation'),
				mirror: safeState<boolean>(a, 'getState_Mirror'),
				attached: true,
				wireId,
			})
		}
	}
	// ② 浮空标签：官方 getAll 不枚举 parentId=$$root 的属性（盲区），走文档源码扫描
	try {
		const floats = await scanFloatingNetLabels()
		for (const f of floats) {
			if (!f.net || (netFilter && f.net !== netFilter) || seen.has(f.primitiveId))
				continue
			out.push({
				primitiveId: f.primitiveId,
				net: f.net,
				x: f.x,
				y: f.y,
				color: undefined,
				attached: false,
			})
		}
	}
	catch {
		// 文档源码读取失败不阻断，附着列表已返回
	}
	return out
}

import { runStructuralAudit } from './schematicAuditEngine'
import type { IAuditWire, IAuditLabel, IAuditComp, IAuditCompPins, IAuditRect } from './schematicAuditEngine'

/**
 * 从文档源码原文中切除指定浮空 ATTR 记录（{type:ATTR,id}头段 + 紧随的 _NETLABEL_ 体段）。
 * 字节级手术：只删除命中段的原文区间（连同其前驱分隔符），其余字节原样保留——
 * 不做 split+rejoin 重组，避免分隔符归一化导致 setDocumentSource 判格式错误拒写（0.10.9 教训）。
 */
function stripFloatingAttrsFromSource(source: string, ids: Set<string>): { text: string, removed: number } {
	const isSep = (ch: string) => ch === '|' || ch === '\n' || ch === '\r'
	// 切分段，记录每段区间（含前驱分隔符起点）
	const parts: Array<{ sepStart: number, start: number, end: number, text: string }> = []
	let i = 0
	const n = source.length
	while (i < n) {
		const sepStart = i
		while (i < n && isSep(source[i]))
			i++
		const start = i
		while (i < n && !isSep(source[i]))
			i++
		if (i > start)
			parts.push({ sepStart, start, end: i, text: source.slice(start, i) })
	}
	// 命中段删除区间：[前驱分隔符起点, 段尾)；首段无前驱分隔符时吃后续分隔符
	const ranges: Array<[number, number]> = []
	for (let k = 0; k < parts.length; k++) {
		const t = parts[k].text
		if (!t.startsWith('{'))
			continue
		let rec: any
		try {
			rec = JSON.parse(t)
		}
		catch {
			continue
		}
		if (rec.type !== 'ATTR' || !ids.has(String(rec.id ?? '')))
			continue
		// 体段必须是紧随其后的 _NETLABEL_ / parentId=$$root 记录，确认后才切除（防误删）
		const next = k + 1 < parts.length ? parts[k + 1].text : ''
		let body: any
		try {
			body = next.startsWith('{') ? JSON.parse(next) : undefined
		}
		catch {
			body = undefined
		}
		if (body && body.key === '_NETLABEL_' && body.parentId === '$$root') {
			for (const idx of [k, k + 1]) {
				const p = parts[idx]
				// 首段（sepStart===0 即源从头开始）没有前驱分隔符可吃，改为吃后续分隔符
				if (p.sepStart === 0 && p.start === 0) {
					let e = p.end
					while (e < n && isSep(source[e]))
						e++
					ranges.push([0, e])
				}
				else
					ranges.push([p.sepStart, p.end])
			}
		}
	}
	if (!ranges.length)
		return { text: source, removed: 0 }
	ranges.sort((a, b) => a[0] - b[0])
	let text = ''
	let cursor = 0
	for (const [s, e] of ranges) {
		if (s < cursor)
			continue
		text += source.slice(cursor, s)
		cursor = e
	}
	text += source.slice(cursor)
	return { text, removed: ranges.length / 2 }
}

/**
 * 删除浮空标签（parentId=$$root 的官方枚举盲区图元）。
 * 官方实锤（pro-api-types 类型注释）：属性图元不支持删除——
 * SCH_PrimitiveAttribute.delete 标注 @internal「属性图元不支持删除，本接口调用将不会有任何效果」，
 * ISCH_PrimitiveAttribute 实例上根本没有 delete 方法。故通道①②只是无害兜底，诊断里注明官方实锤。
 * 0.10.11 顺序调整（0.10.10 事故：通道③源码改写被官方运行时校验判"数据格式不对"弹窗拒绝，工程靠未保存幸免）：
 *  主通道 ④ 借尸还魂：建临时短导线 → modify 改浮标 parentId 挂上去 → 删导线级联带走 → 源码重扫读回验证；
 *          任一步失败回滚临时导线并如实报 diagnostics；删导线后【必须】以源码重扫为准（画布显示可能滞后）。
 *  末通道 ③ 文档源码改写【默认禁用】：仅显式 allowSourceRewrite:true 才执行（最后手段，执行时带醒目 warning）。
 * 每通道后都用文档源码读回判定，返回真实 deleted / failed / 逐通道诊断。
 */
async function deleteFloatingLabels(ids: Array<string>, opts?: { allowSourceRewrite?: boolean, batchSize?: number, beforeWrite?: () => void, shouldStop?: () => boolean, onTimeout?: () => void }): Promise<{ deleted: Array<string>, failed: Array<string>, method?: string, diagnostics?: Array<string>, warning?: string, batches?: Array<{ batch: number, attempted: number, deleted: number, failed: number }>, unprocessed?: Array<string> }> {
	const alive = async (): Promise<Set<string>> => new Set((await scanFloatingNetLabels()).map(f => String(f.primitiveId)))
	const diagnostics: Array<string> = []
	let writeStopRequested = false
	const beforeWrite = () => {
		if (writeStopRequested)
			throw new Error('浮标删除内部单项超时，已停止后续写入')
		opts?.beforeWrite?.()
	}
	const shouldStop = () => writeStopRequested || Boolean(opts?.shouldStop?.())
	const signalTimeoutStop = Boolean(opts?.beforeWrite || opts?.shouldStop || opts?.onTimeout)
	let remaining = await alive()
	let method: string | undefined
	// 通道①：实例 delete()（官方实例无此方法，仅兜底；get 对盲区 ID 也可能返回空）
	const ch1 = ids.filter(id => remaining.has(id))
	if (ch1.length) {
		let got = 0
		for (const id of ch1) {
			try {
				const attr = await eda.sch_PrimitiveAttribute.get(id)
				if (attr) {
					got++
					if (typeof (attr as any).delete === 'function') {
						beforeWrite()
						await (attr as any).delete()
					}
				}
			}
			catch (e) {
				if (shouldStop())
					throw e
				/* 单个失败交给下一通道 */
			}
		}
		remaining = await alive()
		diagnostics.push(`通道①实例delete: get命中${got}/${ch1.length}（官方标注属性图元不支持删除，预期无效）`)
		if (!ids.some(id => remaining.has(id)))
			method = 'instanceDelete'
	}
	// 通道②：类级 delete（官方 @internal 注释明确"不会有任何效果"，兜底再试一次）
	const ch2 = ids.filter(id => remaining.has(id))
	if (ch2.length) {
		try {
			beforeWrite()
			const r = await (eda.sch_PrimitiveAttribute as any).delete(ch2)
			diagnostics.push(`通道②类级delete: 返回 ${JSON.stringify(r)}（官方注释：属性图元不支持删除，调用无任何效果）`)
		}
		catch (e: any) {
			if (shouldStop())
				throw e
			diagnostics.push(`通道②类级delete: 抛错 ${String(e?.message ?? e)}`)
		}
		remaining = await alive()
		if (!ids.some(id => remaining.has(id)))
			method = method ?? 'classDelete'
	}
	// 通道④（主通道）：借尸还魂——建临时短导线 → modify 改 parentId 挂上去 → 删导线级联带走 → 源码重扫验证
	// 0.10.12 加固（0.10.11 实测：真删 8 个后第 9 个起指令整体超时、会话创建类 API 全线失效，且超时丢 diagnostics）：
	//  ① 每条包 8s 超时熔断，单条超时标记 failed 立即跳下一条，不拖死整指令；
	//  ② 单项状态未知或超时立即停止后续写入；明确读回仍存在的目标会继续处理下一项；
	//  ③ 分批执行（batchSize 默认 5，批间停 300ms），返回分批进度，大批浮标可多次调用；
	//  ④ 全局时间预算：临近扩展侧指令超时即停止开新条，累积结果照常返回（部分结果不丢）；
	//  ⑤ 回滚顺序修正：删临时导线失败先把浮标 parentId 改回 $$root 还原，再重试删导线，
	//     避免留下"持属性无名导线"孤儿（0.10.11 实测遗留 67cd6f589fe4410b 删不掉）。
	// 0.10.13 修正（0.10.12 终验发现）：
	//  ⑥ 成败判定一律以【每条走完后源码重扫读回】为准，不再信 modify/delete 返回值——
	//     官方 modify parentId 有"返回 falsy 但实际生效"的假失败行为（0.10.12 实测 4/4 报"被拒"，
	//     读回却已删 3 个），误报 failed 还会误触发熔断；读回显示已删即记成功、不计连续失败。
	//  ⑦ 回滚删临时导线若也失败，diagnostics 明确记录导线 ID+坐标（不再静默吞掉）。
	//  ⑧ 浮标缺坐标时不往 (0,0) 画线，直接 failed 注明"源码未解析到坐标"。
	const PER_ITEM_TIMEOUT_MS = 8000
	const GLOBAL_BUDGET_MS = 100000 // 扩展侧该指令超时已放宽到 140s，留 40s 余量给收尾与传输
	const batchSize = Math.max(1, Number(opts?.batchSize) || 5)
	const startedAt = Date.now()
	const batches: Array<{ batch: number, attempted: number, deleted: number, failed: number }> = []
	const attempted = new Set<string>()
	const ch4 = ids.filter(id => remaining.has(id))
	if (ch4.length) {
		const floats = await scanFloatingNetLabels()
		let circuitBroken = false
		let budgetExhausted = false
		// 单条源码重扫：该浮标是否还浮着（每条成败的唯一判定依据，不信任何接口返回值——官方假失败前科）
		const stillFloats = async (id: string): Promise<boolean> =>
			(await scanFloatingNetLabels()).some(f => String(f.primitiveId) === id)
		// 单条借尸还魂流程（尽力而为，报错不直接定生死，由走完后的源码重扫判定）
		const reborrowOne = async (id: string): Promise<void> => {
			const f = floats.find(fl => String(fl.primitiveId) === id)
			if (!f)
				throw new Error('源码扫描中找不到该浮标（可能已被前序步骤删除）')
			// 缺坐标兜底：不往 (0,0) 画临时导线
			if (f.x == null || f.y == null)
				throw new Error('源码未解析到坐标，无法定位画临时导线')
			// 浮标坐标是源码坐标系（Y 轴与 API 相反），临时导线画在其 API 等价位置
			const ax = f.x
			const ay = -f.y
			let tmpWireId: string | undefined
			beforeWrite()
			const wire = await eda.sch_PrimitiveWire.create([ax, ay, ax + 20, ay])
			tmpWireId = wire ? safeState<string>(wire, 'getState_PrimitiveId') : undefined
			if (!tmpWireId)
				throw new Error('临时导线 create 返回空（会话创建功能可能已损坏）')
			try {
				// ⚠️ 官方假失败前科：modify 可能返回 falsy 但实际已生效（0.10.12 实测 4/4"被拒"读回却已删），
				// 故此处不再因 falsy 抛错回滚——继续删导线，最终生死由走完后源码重扫判定
				beforeWrite()
				const mod = await eda.sch_PrimitiveAttribute.modify(id, { parentId: tmpWireId } as any)
				if (!mod)
					diagnostics.push(`通道④借尸还魂: modify parentId 返回 falsy（${id}），按假失败处理继续删线，以源码重扫为准`)
				// 删临时导线，期望属性级联删除；画布显示可能滞后，成败以删后源码重扫为准
				beforeWrite()
				await eda.sch_PrimitiveWire.delete([tmpWireId])
				tmpWireId = undefined // 已成功删除，无需回滚
			}
			finally {
				if (tmpWireId) {
					// 回滚顺序修正：先把浮标 parentId 改回 $$root 还原（避免"持属性的无名导线"删不掉），再删临时导线
					try {
						beforeWrite()
						await eda.sch_PrimitiveAttribute.modify(id, { parentId: '$$root' } as any)
					}
					catch (e) {
						if (shouldStop())
							throw e
						/* 忽略 */
					}
					try {
						beforeWrite()
						await eda.sch_PrimitiveWire.delete([tmpWireId])
					}
					catch (e: any) {
						if (shouldStop())
							throw e
						// 回滚删线也失败：明确记录，不再静默吞掉（可能留下持属性孤儿线，需手动框选删除）
						diagnostics.push(`通道④借尸还魂: ⚠️ 回滚删临时导线也失败（导线ID ${tmpWireId}，坐标 [${ax},${ay}]-[${ax + 20},${ay}]，${id}）：${String(e?.message ?? e)}——该线可能已持属性删不掉，请在 EDA 里按坐标手动框选删除`)
					}
				}
			}
		}
		for (let bi = 0; bi < ch4.length; bi += batchSize) {
			if (circuitBroken || budgetExhausted)
				break
			if (bi > 0)
				await new Promise(resolve => setTimeout(resolve, 300)) // 批间停顿，给官方编辑器喘息
			const batch = ch4.slice(bi, bi + batchSize)
			let bDeleted = 0
			let bFailed = 0
			for (const id of batch) {
				if (circuitBroken || shouldStop())
					break
				if (Date.now() - startedAt > GLOBAL_BUDGET_MS) {
					budgetExhausted = true
					diagnostics.push(`通道④借尸还魂: 全局时间预算耗尽（>${GLOBAL_BUDGET_MS / 1000}s），停止开新条，已累积结果照常返回；剩余浮标请再次调用本指令`)
					break
				}
				attempted.add(id)
				let itemError: string | undefined
				let itemTimeout: ReturnType<typeof setTimeout> | undefined
				try {
					await Promise.race([
						reborrowOne(id),
						new Promise((_, reject) => { itemTimeout = setTimeout(() => {
							writeStopRequested = true
							circuitBroken = true
							if (signalTimeoutStop) {
								opts?.onTimeout?.()
							}
							reject(new Error(`单条超时（>${PER_ITEM_TIMEOUT_MS / 1000}s，疑似官方弹模态框或卡绘制模式）`))
						}, PER_ITEM_TIMEOUT_MS) }),
					])
				}
				catch (e: any) {
					itemError = String(e?.message ?? e)
				}
				finally {
					if (itemTimeout !== undefined)
						clearTimeout(itemTimeout)
				}
				// 成败唯一判定：每条走完后源码重扫读回（官方 modify/delete 返回值不可信——假失败前科）
				let gone: boolean | undefined
				try {
					gone = !(await stillFloats(id))
				}
				catch (e: any) {
					writeStopRequested = true
					circuitBroken = true
					diagnostics.push(`通道④借尸还魂: 删除后读回未知（${id}）：${String(e?.message ?? e)}，停止后续写入`)
				}
				if (gone === true) {
					bDeleted++
					if (itemError)
						diagnostics.push(`通道④借尸还魂: 接口报错「${itemError}」但源码重扫确认已删除（${id}）——官方假失败，记成功`)
				}
				else if (gone === false) {
					bFailed++
					diagnostics.push(`通道④借尸还魂: 失败 ${itemError ? `${itemError}，` : ''}源码重扫确认仍在（${id}），已按序回滚（先还原 parentId 再删临时导线）`)
				}
				if (shouldStop())
					break
			}
			batches.push({ batch: batches.length + 1, attempted: batch.length, deleted: bDeleted, failed: bFailed })
		}
		remaining = await alive()
		diagnostics.push(`通道④借尸还魂: 源码重扫读回剩余 ${ids.filter(id => remaining.has(id)).length}/${ch4.length}`)
		if (!ids.some(id => remaining.has(id)))
			method = method ?? 'reparentThenDeleteWire'
	}
	// 通道③（⚠️ 默认禁用，最后手段）：文档源码改写——0.10.10 实机事故：离线字节级切除验证正确，
	// 但官方对 setDocumentSource 写回有运行时格式校验，写回被判"数据格式不对"弹窗拒绝（离线验证通过 ≠ 运行时安全）。
	// 仅显式 allowSourceRewrite:true 才执行，且操作前必须确保工程已保存。
	const allowSourceRewrite = Boolean(opts?.allowSourceRewrite)
	const ch3 = ids.filter(id => remaining.has(id))
	let warning: string | undefined
	if (ch3.length && !allowSourceRewrite)
		diagnostics.push(`通道③源码改写: 已跳过（默认禁用；0.10.10 曾被官方运行时判"数据格式不对"，确需执行请显式传 allowSourceRewrite:true 并确保工程已保存）`)
	if (ch3.length && allowSourceRewrite) {
		warning = '⚠️ 源码改写曾被官方运行时校验判"数据格式不对"（0.10.10 实机事故），属最后手段——操作前请确保工程已保存，随时做好不保存关页丢弃的准备'
		try {
			const source = await eda.sys_FileManager.getDocumentSource()
			if (source) {
				const { text, removed } = stripFloatingAttrsFromSource(String(source), new Set(ch3))
				if (removed > 0) {
					beforeWrite()
					const writeBack = await eda.sys_FileManager.setDocumentSource(text)
					diagnostics.push(`通道③源码改写(显式允许): 切除${removed}条记录，setDocumentSource 返回 ${JSON.stringify(writeBack)}`)
				}
				else
					diagnostics.push('通道③源码改写(显式允许): 源码中未匹配到目标 ATTR 记录（0 切除）')
			}
			else
				diagnostics.push('通道③源码改写(显式允许): getDocumentSource 返回空')
		}
		catch (e: any) {
			diagnostics.push(`通道③源码改写(显式允许): 抛错 ${String(e?.message ?? e)}`)
		}
		remaining = await alive()
		if (!ids.some(id => remaining.has(id)))
			method = method ?? 'documentSourceRewrite'
	}
	const deleted = ids.filter(id => !remaining.has(id))
	const failed = ids.filter(id => remaining.has(id))
	// 分批熔断/时间预算提前退出时，未轮到的浮标单独列出（仍在 failed 中），方便再次调用接着删
	const unprocessed = ids.filter(id => remaining.has(id) && !attempted.has(id))
	return { deleted, failed, method, diagnostics, warning, ...(batches.length ? { batches } : {}), ...(unprocessed.length ? { unprocessed } : {}) }
}

/**
 * 估算网络标签文字宽度（0.10.18 首版，0.10.21 三样本再标定）：默认字体下 ≈ 4.4 单位/字符 + 5 单位边距。
 * 标定样本（exportPng 像素测量，1.955px/单位）：GND(3)=17.4、STATUS_LED(10)=46、USART2_RTS(9)=47.1——
 * 数字/下划线比字母略宽，4.1 系数对混合长网名低估 ~5 单位，故提到 4.4（宁高估：桩长/越位都留得起余量）。
 * 用途：① labelWire 桩长自适应（桩长=max(20, width+14)）；② fixNetLabels 导线越位几何测量（文字右缘=锚点+width）。
 * ⚠️ 0.10.20 实锤：附着看锚点不看右缘，【不要】再用它做锚点偏移放置（0.10.18 偏移策略电气不成立已回滚）。
 * ⚠️ 用户改过 fontSize 会失准；非 ASCII 字符按 2 个字符宽估。
 */
function estimateLabelWidth(net: string): number {
	let units = 0
	for (const ch of String(net))
		units += ch.charCodeAt(0) > 127 ? 2 : 1
	return Math.ceil(4.4 * units + 5)
}

/**
 * 设置网络标签文字方向（0.10.16）：官方 createNetLabel(x, y, net) 无方向参数（标签默认锚点在左、文字向右伸展），
 * 但 sch_PrimitiveAttribute.modify(id, { rotation }) 支持旋转（pro-api-types 实锤），getState_Rotation 可读回。
 * ⚠️ 官方 modify 有假失败前科（返回 falsy 但实际生效）——成败一律以读回 rotation 为准，不信返回值。
 * ⚠️ 0.10.18 修复假成功：rotation=0 时原来直接返回 0 什么都没改（fixNetLabels 原地转正因此假成功）——
 *    现在 0 也走 modify + 读回验证。另：rotation 180 = 上下颠倒反字（装机目测实锤），正常标签一律 rotation 0。
 * 返回实际读回的旋转值；读回不匹配返回 undefined。
 */
async function applyLabelRotation(labelId: string, rotation: number): Promise<number | undefined> {
	if (!labelId)
		return undefined
	try {
		await eda.sch_PrimitiveAttribute.modify(labelId, { rotation } as any)
	}
	catch { /* 假失败不轻信，读回为准 */ }
	try {
		const back = await eda.sch_PrimitiveAttribute.get(labelId)
		const actual = back ? safeState<number>(back, 'getState_Rotation') : undefined
		if (actual != null && Math.abs(((actual - rotation) % 360 + 360) % 360) < 0.5)
			return actual
		return undefined // 读回不符：判失败（假失败防御）
	}
	catch {
		return undefined
	}
}

/**
 * 官方 createNetLabel 偶发"返回空但实际已创建"（假失败）：微偏重试前必须先确认锚点处是否已有该网名标签。
 * 0.10.10 根因修复（双标签真正源头）：
 *  - 附着检查【不能】按导线 getState_Net 预过滤——假失败标签已挂上导线，但导线网络名传播是异步的，
 *    创建后立刻查导线还没改名 → 预过滤把目标导线整根跳过 → 误判没创建 → ±2 重试画出第二个浮标。
 *    改为枚举全部导线的 NET/Name 属性，按属性值+坐标匹配（属性随创建即时可查）。
 *  - 假失败标签的可枚举性也有延迟，找不到时等 300ms 再查，共 3 轮。
 *  - 浮空比对保留 Y 符号翻转：文档源码 Y 轴与 API 相反（API y=-600 ↔ 源码 y=+600）。
 */
async function findGhostNetLabel(net: string, x: number, y: number): Promise<{ id: string, attached: boolean } | undefined> {
	for (let pass = 0; pass < 3; pass++) {
		if (pass > 0)
			await new Promise(resolve => setTimeout(resolve, 300))
		// ① 已附着标签：枚举全部导线的属性，按属性值+坐标匹配（不按导线网名预过滤，防异步传播竞态）
		try {
			const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
			for (const w of wires) {
				const wireId = safeState<string>(w, 'getState_PrimitiveId')
				if (!wireId)
					continue
				const attrs = (await eda.sch_PrimitiveAttribute.getAll(wireId).catch(() => [])) ?? []
				for (const a of attrs) {
					const key = safeState<string>(a, 'getState_Key') ?? ''
					if (!/^(NET|Name)$/i.test(key) || safeState<string>(a, 'getState_Value') !== net)
						continue
					const ax = safeState<number>(a, 'getState_X')
					const ay = safeState<number>(a, 'getState_Y')
					const id = safeState<string>(a, 'getState_PrimitiveId') ?? ''
					if (ax == null || ay == null || (Math.abs(ax - x) <= 3 && Math.abs(ay - y) <= 3))
						return { id, attached: true }
				}
			}
		}
		catch { /* 忽略 */ }
		// ② 浮空标签：文档源码扫描（源码 Y 轴与 API 相反，比对时翻转）
		try {
			const floats = await scanFloatingNetLabels()
			const hit = floats.find(f =>
				f.net === net
				&& Math.abs((f.x ?? 1e9) - x) <= 3
				&& Math.abs((f.y ?? 1e9) + y) <= 3)
			if (hit)
				return { id: hit.primitiveId, attached: false }
		}
		catch {
			return undefined
		}
	}
	return undefined
}

export const schematicCommands: Array<ICommandDef> = [
	{
		name: 'schematic.listRects',
		summary: '列出当前图页全部矩形（功能区块框）——确认分区大小、排查重叠用。⚠️ 坐标系 +Y 向上：官方"左上点"是世界坐标 (minX, maxY)，即 y 是矩形上沿；返回的 span 是归一化的世界坐标包围盒（x1,y1 左下角 / x2,y2 右上角），布局计算一律用 span',
		params: [],
		returns: '[{ primitiveId, x, y, width, height, span: { x1, y1, x2, y2 }, color }]（x,y 为官方左上点原始值；span.y1=下沿=y-height，span.y2=上沿=y）',
		example: { cmd: 'schematic.listRects' },
		handler: async () => {
			const rects = await eda.sch_PrimitiveRectangle.getAll()
			return (rects ?? []).map(r => {
				const x = safeState<number>(r, 'getState_TopLeftX')
				const y = safeState<number>(r, 'getState_TopLeftY')
				const width = safeState<number>(r, 'getState_Width')
				const height = safeState<number>(r, 'getState_Height')
				return {
					primitiveId: safeState<string>(r, 'getState_PrimitiveId'),
					x, y, width, height,
					// +Y 向上：左上点 y 是上沿（最大值），下沿 = y - height
					span: (x != null && y != null && width != null && height != null)
						? { x1: x, y1: y - height, x2: x + width, y2: y }
						: undefined,
					color: safeState<string>(r, 'getState_Color'),
				}
			})
		},
	},
	{
		name: 'schematic.modifyRect',
		summary: '修改矩形（功能区块框）的位置/尺寸/样式',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '矩形图元 ID' },
			{ name: 'x', type: 'number', description: '左上角 X' },
			{ name: 'y', type: 'number', description: '左上角 Y（+Y 向上世界坐标，即矩形上沿，矩形向下延伸 height）' },
			{ name: 'width', type: 'number', description: '宽度' },
			{ name: 'height', type: 'number', description: '高度' },
			{ name: 'color', type: 'string', description: '边框颜色' },
			{ name: 'lineType', type: 'string', description: '线型 solid | dashed' },
		],
		returns: '{ primitiveId, modified }',
		example: { cmd: 'schematic.modifyRect', params: { primitiveId: 'xxx', width: 450 } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const lineTypeMap: Record<string, number> = { solid: 0, dashed: 1, dotted: 2 }
			const property: Record<string, any> = {}
			if (params.x != null)
				property.topLeftX = Number(params.x)
			if (params.y != null)
				property.topLeftY = Number(params.y)
			if (params.width != null)
				property.width = Number(params.width)
			if (params.height != null)
				property.height = Number(params.height)
			if (params.color != null)
				property.color = String(params.color)
			if (params.lineType != null)
				property.lineType = (lineTypeMap[String(params.lineType)] ?? 0) as any
			if (!Object.keys(property).length)
				throw new Error('至少提供一个要修改的属性（x / y / width / height / color / lineType）')
			// 0.10.24 原子化（P10：官方 modify 多字段合并修改可能整体失效）——按类别拆步：位置 / 尺寸 / 样式
			const rectSteps: Array<{ props: Record<string, any>, checks: Array<[string, string, number]> }> = []
			const posProps: Record<string, any> = {}
			const posChecks: Array<[string, string, number]> = []
			if (property.topLeftX != null) {
				posProps.topLeftX = property.topLeftX
				posChecks.push(['x', 'getState_TopLeftX', property.topLeftX])
			}
			if (property.topLeftY != null) {
				posProps.topLeftY = property.topLeftY
				posChecks.push(['y', 'getState_TopLeftY', property.topLeftY])
			}
			if (Object.keys(posProps).length)
				rectSteps.push({ props: posProps, checks: posChecks })
			const sizeProps: Record<string, any> = {}
			const sizeChecks: Array<[string, string, number]> = []
			if (property.width != null) {
				sizeProps.width = property.width
				sizeChecks.push(['width', 'getState_Width', property.width])
			}
			if (property.height != null) {
				sizeProps.height = property.height
				sizeChecks.push(['height', 'getState_Height', property.height])
			}
			if (Object.keys(sizeProps).length)
				rectSteps.push({ props: sizeProps, checks: sizeChecks })
			const styleProps: Record<string, any> = {}
			if (property.color != null)
				styleProps.color = property.color
			if (property.lineType != null)
				styleProps.lineType = property.lineType
			if (Object.keys(styleProps).length)
				rectSteps.push({ props: styleProps, checks: [] })
			// 逐步执行 + 每步读回（用该步返回对象读状态，数值字段逐一核对；假失败前科不信 falsy，无读回字段可核时才采信返回值）
			const readback: Record<string, unknown> = {}
			let verified = true
			let lastRect: any
			for (const step of rectSteps) {
				let rect: any
				try {
					rect = await eda.sch_PrimitiveRectangle.modify(String(params.primitiveId), step.props as any)
				}
				catch { /* 读回为准 */ }
				if (rect)
					lastRect = rect
				const back = rect ?? lastRect
				if (!back) {
					if (step.checks.length)
						verified = false
					continue
				}
				for (const [field, getter, want] of step.checks) {
					const actual = safeState<number>(back, getter)
					readback[field] = actual ?? null
					if (actual == null || Math.abs(actual - want) > 0.5)
						verified = false
				}
			}
			if (!lastRect)
				throw new Error('矩形修改失败（图元不存在或不是矩形）')
			return { primitiveId: safeState<string>(lastRect, 'getState_PrimitiveId'), modified: true, ...(Object.keys(readback).length ? { readback: { ...readback, verified } } : {}), ...(!verified ? { note: '读回数值与目标不符（官方 modify 假成功嫌疑），请用 schematic.listRects 复核后重试' } : {}) }
		},
	},
	{
		name: 'schematic.checkRectOverlap',
		summary: '检查全部矩形（功能区块框）两两之间是否重叠——分区布局自查用。坐标系 +Y 向上，内部按归一化世界坐标包围盒计算（上沿=y、下沿=y-height）；返回每个矩形的实际包围盒供核对，结果不可信时请先对比 rects 字段与源数据',
		params: [],
		returns: '{ rectCount, rects: [{ id, span }], overlaps: [{ a, b, area: { x1, y1, x2, y2 } }] }（无重叠时 overlaps 为空）',
		example: { cmd: 'schematic.checkRectOverlap' },
		handler: async () => {
			const rects = await eda.sch_PrimitiveRectangle.getAll()
			// +Y 向上：官方左上点 y 是上沿（最大值），下沿 = y - height
			const list = (rects ?? []).map(r => {
				const x = safeState<number>(r, 'getState_TopLeftX') ?? 0
				const y = safeState<number>(r, 'getState_TopLeftY') ?? 0
				const w = safeState<number>(r, 'getState_Width') ?? 0
				const h = safeState<number>(r, 'getState_Height') ?? 0
				return {
					id: safeState<string>(r, 'getState_PrimitiveId') ?? '?',
					span: { x1: x, y1: y - h, x2: x + w, y2: y },
				}
			})
			const overlaps: Array<Record<string, unknown>> = []
			for (let i = 0; i < list.length; i++) {
				for (let j = i + 1; j < list.length; j++) {
					const a = list[i].span
					const b = list[j].span
					const x1 = Math.max(a.x1, b.x1)
					const y1 = Math.max(a.y1, b.y1)
					const x2 = Math.min(a.x2, b.x2)
					const y2 = Math.min(a.y2, b.y2)
					if (x2 > x1 && y2 > y1)
						overlaps.push({ a: list[i].id, b: list[j].id, area: { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1 } })
				}
			}
			return { rectCount: list.length, rects: list, overlaps }
		},
	},
	{
		name: 'schematic.structuralAudit',
		summary: '【只读·结构验收】默认当前页：一次调用完成整页结构+排版审计：并查集把物理相接导线段编成树（0.10.63 空间哈希加速），用官方解析 net 字段对账（非几何猜测）。覆盖：异网桥接/短路（标签挂错网 blocking）、不同网名共线重叠（blocking）、重复位号（blocking）、浮空标签、引脚穿线、孤立线树、内部十字交叉（候选，供目检）、功能区框重叠、器件出区（无位号图框自动跳过）、器件相碰（引脚云近似，candidate）。allPages:true 时自动逐页切换审计全部分原理图页并汇总（九页验收一次调用）。只读不改图',
		params: [
			{ name: 'ncExempt', type: 'string[]', description: '豁免名单（NC/预留引脚），如 ["U2.2","U2.7"]——名单内引脚不报穿线候选' },
			{ name: 'deviceMargin', type: 'number', description: '器件相碰筛选的引脚云外扩 mil 数，默认 10（引脚云不重叠则本体几乎不可能相碰；云重叠只说明靠得近，结论标 candidate 待目检）' },
			{ name: 'allPages', type: 'boolean', description: 'true=自动逐页切换审计工程内全部分原理图页并汇总（大工程可用 _timeoutMs 延长总熔断）' },
		],
		returns: '单页：{ stats, summary, blockingCount, issues, warning? }。allPages：{ pages: [{ pageUuid, pageName, stats, summary, blockingCount, issues, warning? }], pageCount, totalBlocking, overallSummary }。blocking=0 不代表整图电气验收通过：本指令证明结构合法，不证明设计意图（关键网络仍按项目契约对账）',
		example: { cmd: 'schematic.structuralAudit', params: { ncExempt: ['U2.2', 'U2.7'] } },
		handler: async (params) => {
			if (params.ncExempt !== undefined && (!Array.isArray(params.ncExempt) || params.ncExempt.some((ref: unknown) => typeof ref !== 'string')))
				throw new Error('ncExempt 必须是字符串数组')
			if (params.allPages !== undefined && typeof params.allPages !== 'boolean')
				throw new Error('allPages 必须是布尔值')
			if (Object.hasOwn(params, 'deviceMargin') && (typeof params.deviceMargin !== 'number' || !Number.isFinite(params.deviceMargin) || params.deviceMargin < 0))
				throw new Error('deviceMargin 必须是有限且不小于 0 的数字')
			const ncExempt = new Set<string>(params.ncExempt ?? [])
			const deviceMargin = Object.hasOwn(params, 'deviceMargin') ? params.deviceMargin : 10

			// ①~④ 采集+分析当前激活页（全部只读）
			const auditCurrentPage = async () => {
				// ① 采集（全部只读）
				const rawWires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				const wires: Array<IAuditWire> = rawWires.map(w => ({
					primitiveId: safeState<string>(w, 'getState_PrimitiveId') ?? '?',
					net: safeState<string>(w, 'getState_Net') ?? '',
					line: safeState<Array<number>>(w, 'getState_Line') ?? [],
				}))
				const rawLabels = await collectNetLabels(undefined)
				const labels: Array<IAuditLabel> = rawLabels.map(l => ({
					primitiveId: String(l.primitiveId ?? '?'),
					net: String(l.net ?? ''),
					x: l.x != null ? Number(l.x) : undefined,
					y: l.y != null ? Number(l.y) : undefined,
					attached: l.attached !== false,
					wireId: l.wireId != null ? String(l.wireId) : undefined,
				}))
				const rawComps = (await eda.sch_PrimitiveComponent.getAll(undefined, false)) ?? []
				const comps: Array<IAuditComp> = rawComps.map(c => ({
					primitiveId: safeState<string>(c, 'getState_PrimitiveId') ?? '?',
					designator: safeState<string>(c, 'getState_Designator') ?? undefined,
					x: safeState<number>(c, 'getState_X') ?? undefined,
					y: safeState<number>(c, 'getState_Y') ?? undefined,
				}))
				// ② 引脚逐器件读取（单条 15s 熔断；属性读取失败的器件跳过并记录）
				// 注意：必须按器件（primitiveId）逐条成条目，不能按位号索引——
				// 真实页面常有一批位号未规范化（全是 "R?"），Record 按位号做 key 会互相覆盖丢引脚
				const compPins: Array<IAuditCompPins> = []
				const pinReadFailed: Array<string> = []
				for (const c of comps) {
					try {
						const pins = await withTimeout(eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(c.primitiveId), 15000, `listPins(${c.designator ?? c.primitiveId})`)
						compPins.push({
							primitiveId: c.primitiveId,
							designator: c.designator,
							pins: (pins ?? []).map(p => ({
								pinNumber: p.getState_PinNumber != null ? String(p.getState_PinNumber()) : undefined,
								pinName: p.getState_PinName != null ? String(p.getState_PinName()) : undefined,
								x: Number(p.getState_X?.() ?? NaN),
								y: Number(p.getState_Y?.() ?? NaN),
							})).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)),
						})
					}
					catch {
						pinReadFailed.push(c.designator ?? c.primitiveId)
					}
				}
				// ③ 功能区框
				const rawRects = (await eda.sch_PrimitiveRectangle.getAll()) ?? []
				const rects: Array<IAuditRect> = rawRects.map(r => {
					const x = safeState<number>(r, 'getState_TopLeftX') ?? 0
					const y = safeState<number>(r, 'getState_TopLeftY') ?? 0
					const w = safeState<number>(r, 'getState_Width') ?? 0
					const h = safeState<number>(r, 'getState_Height') ?? 0
					return { id: safeState<string>(r, 'getState_PrimitiveId') ?? '?', span: { x1: x, y1: y - h, x2: x + w, y2: y } }
				})

				// ④ 分析
				const { issues, stats } = runStructuralAudit({ wires, labels, comps, compPins, rects, ncExempt, deviceMargin })
				const summary: Record<string, number> = {}
				for (const it of issues) {
					const key = `${it.rule}[${it.type}]`
					summary[key] = (summary[key] ?? 0) + 1
				}
				const blockingCount = issues.filter(i => i.type === 'blocking').length
				return {
					stats,
					summary,
					blockingCount,
					issues,
					...(pinReadFailed.length ? { warning: `引脚读取失败 ${pinReadFailed.length} 个器件（${pinReadFailed.slice(0, 5).join(',')}${pinReadFailed.length > 5 ? '…' : ''}），这些器件未参与引脚相关检查` } : {}),
				}
			}

			// 单页模式
			if (params.allPages !== true)
				return await auditCurrentPage()

			// allPages 模式（0.10.63）：从工程文档树收集全部分原理图页，逐页激活+审计+汇总
			const info: any = await eda.dmt_Project.getCurrentProjectInfo()
			if (!info)
				throw new Error('当前没有打开的工程，无法 allPages 审计')
			const pages: Array<{ pageUuid: string, pageName: string }> = []
			const walk = (node: any) => {
				if (!node || typeof node !== 'object')
					return
				if (Array.isArray(node.page) && (node.itemType === 'Schematic' || node.schematic))
					for (const p of node.page)
						pages.push({ pageUuid: String(p.uuid), pageName: String(p.name ?? p.uuid) })
				for (const v of Object.values(node)) {
					if (v && typeof v === 'object') {
						if (Array.isArray(v)) {
							for (const it of v)
								walk(it)
						}
						else
							walk(v)
					}
				}
			}
			walk(info.data ?? info)
			if (!pages.length)
				throw new Error('工程文档树中未找到原理图页（结构异常，可先 project.getInfo 人工确认）')
			const pageResults: Array<any> = []
			for (const pg of pages) {
				// 与 editor.openDocument 同路径：openDocument 返回 tabId，再显式激活一次
				const tabId = await eda.dmt_EditorControl.openDocument(pg.pageUuid).catch(() => null)
				if (!tabId) {
					// 0.10.65 修复：openDocument 失败必须跳过本页——此前照跑当前激活页，
					// 审计结果被记到目标页名下（张冠李戴且无提示）
					pageResults.push({ pageUuid: pg.pageUuid, pageName: pg.pageName, error: 'openDocument 失败，本页未审计', blockingCount: 0, summary: {}, issues: [] })
					continue
				}
				try {
					await eda.dmt_EditorControl.activateDocument(tabId)
				}
				catch {
					// 激活失败不阻断
				}
				await new Promise(resolve => setTimeout(resolve, 400))
				const r = await auditCurrentPage()
				pageResults.push({ pageUuid: pg.pageUuid, pageName: pg.pageName, ...r })
			}
			const overallSummary: Record<string, number> = {}
			let totalBlocking = 0
			for (const r of pageResults) {
				totalBlocking += r.blockingCount
				for (const [k, v] of Object.entries(r.summary))
					overallSummary[k] = (overallSummary[k] ?? 0) + Number(v)
			}
			return { pages: pageResults, pageCount: pageResults.length, totalBlocking, overallSummary }
		},
	},
	{
		name: 'schematic.placeRegion',
		summary: '绘制功能区：矩形框 + 区标题文本一步完成（如「① 输入区（4-32V）」）。坐标 +Y 向上：x,y 是框左上角（y 为上沿），标题自动放在框内左上；返回 span 供后续布局/重叠计算',
		params: [
			{ name: 'x', type: 'number', required: true, description: '框左上角 X（10mil）' },
			{ name: 'y', type: 'number', required: true, description: '框上沿 Y（10mil，+Y 向上世界坐标）' },
			{ name: 'width', type: 'number', required: true, description: '宽度（10mil）' },
			{ name: 'height', type: 'number', required: true, description: '高度（10mil）' },
			{ name: 'title', type: 'string', required: true, description: '区标题，如「① 输入区」' },
			{ name: 'color', type: 'string', description: '边框颜色，如 #8888FF' },
			{ name: 'lineType', type: 'string', description: '线型 solid | dashed（默认 dashed）' },
			{ name: 'fontSize', type: 'number', description: '标题字号，默认 12' },
		],
		returns: '{ rectId, textId, span }',
		example: { cmd: 'schematic.placeRegion', params: { x: 60, y: 650, width: 400, height: 300, title: '① 输入区（4-32V）' } },
		handler: async (params) => {
			if ([params.x, params.y, params.width, params.height].some(v => v == null) || !params.title)
				throw new Error('缺少参数 x / y / width / height / title')
			const lineTypeMap: Record<string, number> = { solid: 0, dashed: 1, dotted: 2 }
			const rect = await eda.sch_PrimitiveRectangle.create(
				Number(params.x), Number(params.y),
				Number(params.width), Number(params.height),
				undefined, undefined,
				params.color ? String(params.color) : undefined,
				undefined, undefined,
				(params.lineType != null ? (lineTypeMap[String(params.lineType)] ?? 1) : 1) as any,
				undefined,
			)
			if (!rect)
				throw new Error('矩形创建失败（可能当前打开的不是原理图）')
			const rectId = safeState<string>(rect, 'getState_PrimitiveId')
			// 标题放框内左上：左缩进 10、上沿下移 30（文本锚点在文字左下）
			const text = await eda.sch_PrimitiveText.create(
				Number(params.x) + 10, Number(params.y) - 30,
				String(params.title),
				undefined, undefined, undefined,
				params.fontSize != null ? Number(params.fontSize) : 12,
				true,
			)
			const textId = text ? safeState<string>(text, 'getState_PrimitiveId') : undefined
			return {
				rectId,
				textId,
				span: {
					x1: Number(params.x), y1: Number(params.y) - Number(params.height),
					x2: Number(params.x) + Number(params.width), y2: Number(params.y),
				},
				...(textId ? {} : { note: '标题文本创建失败，仅矩形已放置' }),
			}
		},
	},

	{
		name: 'schematic.getPageInfo',
		summary: '获取原理图图页信息（含图框尺寸：titleBlockData 的 Width/Height，单位 10mil）',
		params: [
			{ name: 'pageUuid', type: 'string', description: '图页 UUID（也接受别名 uuid）；留空读取当前焦点原理图图页' },
		],
		returns: '{ uuid, name, size, width, height, showTitleBlock, titleBlockData }（width/height 单位 10mil，A4 为 1170×825）',
		example: { cmd: 'schematic.getPageInfo' },
		handler: async (params) => {
			let pageUuid = params.pageUuid ? String(params.pageUuid) : params.uuid ? String(params.uuid) : undefined
			if (!pageUuid) {
				const focus: any = await eda.dmt_SelectControl.getCurrentDocumentInfo()
				if (focus?.documentType !== 1 || typeof focus?.uuid !== 'string' || !focus.uuid.trim())
					throw new Error('无法确认当前焦点是有效原理图图页，请显式提供 pageUuid')
				pageUuid = focus.uuid
			}
			const targetPageUuid = String(pageUuid)
			const page = await eda.dmt_Schematic.getSchematicPageInfo(targetPageUuid)
			if (!page)
				throw new Error(`图页不存在: ${targetPageUuid}`)
			if (page.uuid !== targetPageUuid)
				throw new Error(`图页读取结果 UUID 与目标不一致: 目标 ${targetPageUuid}，实际 ${page.uuid ?? '(缺失)'}`)
			const tb = page.titleBlockData ?? {}
			return {
				uuid: page.uuid,
				name: page.name,
				size: tb['Size']?.value ?? tb['Page Size']?.value,
				width: tb['Width']?.value,
				height: tb['Height']?.value,
				showTitleBlock: page.showTitleBlock,
				titleBlockData: tb,
			}
		},
	},
	{
		name: 'schematic.connectPin',
		summary: '将器件引脚接入指定网络：画一条从引脚尖端外 30 到引脚原点的命名导线（端点对原点即连通；不要探入本体侧，会产生 T 形结点红点）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
			{ name: 'pin', type: 'string', required: true, description: '引脚编号或引脚名（支持前缀匹配，如 VDD、PA13）' },
			{ name: 'net', type: 'string', required: true, description: '网络名（GND/3V3/5V 等任意网络名均直接作为导线网络）' },
		],
		returns: '{ primitiveId, net, pinNumber, from, to }',
		example: { cmd: 'schematic.connectPin', params: { primitiveId: 'xxx', pin: 'VDD', net: '3V3' } },
		handler: async (params) => {
			if (!params.primitiveId || !params.pin || !params.net)
				throw new Error('缺少参数 primitiveId / pin / net')
			const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(String(params.primitiveId))
			if (!pins?.length)
				throw new Error('未找到该器件的引脚（请先激活对应原理图图页）')
			const key = String(params.pin)
			const pin = pins.find(p => p.getState_PinNumber?.() === key || p.getState_PinName?.() === key)
				?? pins.find(p => (p.getState_PinName?.() ?? '').startsWith(key))
			if (!pin)
				throw new Error(`引脚 ${key} 不存在，可用 listPins 查看`)

			// getState_X/Y 是引脚原点（电气端点），引脚线段沿旋转方向延伸 pinLength。
			// 实测规则（v0.7.7 起）：导线端点精确落在引脚原点即连通；
			// 探入本体侧会让端点落在引脚线中段，产生 T 形结点红点 + "单网络"警告。
			// 因此画一条从「引脚尖端外 30」到原点的导线，并直接命名网络。
			const rot = pin.getState_Rotation?.() ?? 0
			const len = pin.getState_PinLength?.() ?? 10
			const rad = (rot * Math.PI) / 180
			const normalizedRot = ((rot % 360) + 360) % 360
			let dx: number
			let dy: number
			switch (normalizedRot) {
				case 0: dx = 1; dy = 0; break
				case 90: dx = 0; dy = 1; break
				case 180: dx = -1; dy = 0; break
				case 270: dx = 0; dy = -1; break
				default: dx = Math.cos(rad); dy = Math.sin(rad)
			}
			const x = pin.getState_X()
			const y = pin.getState_Y()
			const x1 = x + dx * (len + 30)
			const y1 = y + dy * (len + 30)
			const x2 = x
			const y2 = y

			const net = String(params.net)
			// 智能命名：该网络已在页面存在（命名导线或网络标签）则画无名短桩，
			// 避免合并后 NET 属性叠加产生"导线有多个网络名"警告
			const shouldName = !(await netExistsOnPage(net))
			const wire = await withStage('drawWire:wire.create', () => eda.sch_PrimitiveWire.create([x1, y1, x2, y2], shouldName ? net : undefined))
			if (!wire)
				throw new Error('导线创建失败')
			return {
				primitiveId: safeState<string>(wire, 'getState_PrimitiveId'),
				net,
				named: shouldName,
				pinNumber: pin.getState_PinNumber?.(),
				from: { x: x1, y: y1 },
				to: { x: x2, y: y2 },
			}
		},
	},
	{
		name: 'schematic.labelWire',
		summary: '【推荐·语义化】标签连接：把【1 个引脚】接入指定网络——自动画短桩（沿引脚朝向外，0.10.21 起默认长 60 容纳长网名，stubLen 可覆盖，防撞自动换向）+ 放网络标签（自带同名防呆+附着验证）。0.10.20 起标签 rotation 恒 0、锚点恒在桩末端（全方向一致）——决定性实验实锤：附着判定看锚点（锚点必须落在导线上，离线外 5 单位即浮标），rotation 0 文字自锚点右伸；0.10.18 的锚点偏移策略电气不成立已回滚。⚠️ 只接 1 个引脚且必须带名字；两个引脚互连请用 schematic.linkWire',
		params: [
			{ name: 'pin', type: 'string', required: true, description: '引脚引用 "位号.引脚号"，如 U1.7、R2.1' },
			{ name: 'net', type: 'string', required: true, description: '网络名（必须）' },
			{ name: 'color', type: 'string', description: '标签颜色，如 #FF0000' },
			{ name: 'stubLen', type: 'number', description: '短桩长度（默认 60，能容纳长网名文字右伸不压器件；显式指定时最小钳 20）' },
			{ name: 'force', type: 'boolean', description: '引脚已被其他网络占用时仍强行连接（合并网络，慎用）' },
		],
		returns: '{ pin, net, stub, stubLen, labelId, labelPos, placement, attached } 或 { alreadyConnected: true }',
		example: { cmd: 'schematic.labelWire', params: { pin: 'U1.7', net: '3V3' } },
		handler: async (params) => {
			if (!params.pin || !params.net)
				throw new Error('缺少参数 pin / net')
			if (params.stubLen != null && (typeof params.stubLen !== 'number' || !Number.isFinite(params.stubLen) || params.stubLen <= 0))
				throw new Error('stubLen 必须是有限正数；显式值仍按最小 20 单位处理')
			const net = String(params.net)
			const p = await resolvePinPoint(String(params.pin))
			assertPinConnectable(p)
			// 占用预检：引脚若已被导线占用——同名则直接复用，异名则拒绝（继续画会串网）
			if (!params.force) {
				const occupied = await findWireNetsAtPoint(p.x, p.y)
				if (occupied.length) {
					if (occupied.every(n => n === net))
						return { pin: `${p.designator}.${p.pin}`, net, alreadyConnected: true, note: '引脚已在目标网络中，未重复画桩' }
					throw new Error(`引脚 ${p.designator}.${p.pin} 已接入网络 ${occupied.join('、')}，与目标 ${net} 冲突，继续会串网。请先删该引脚上的现有导线（schematic.listWires 查 → schematic.delete 删），或确认要合并网络时加 force:true`)
				}
			}
			const existingWires = await collectWireSegsByNet()
			// 短桩候选方向：沿引脚朝向（尖端向外）、上、下、反向
			const rad = (p.rot * Math.PI) / 180
			const outX = Math.cos(rad)
			const outY = Math.sin(rad)
			// 0.10.21 桩长：统一默认 60（用户决策：不按网名长度自适应，长短不一难看；60 能容纳 STATUS_LED 级
			// 长名文字右伸 46+余量不压器件，全方向一致）；stubLen 参数可显式覆盖（最小钳 20）
			const STUB = Math.max(20, params.stubLen != null ? Number(params.stubLen) : 60)
			const allPinPts = await collectAllPinPoints()
			const candidates: Array<[number, number]> = [
				[Math.round(outX), Math.round(outY)],
				[0, 1], [0, -1],
				[-Math.round(outX), -Math.round(outY)],
			]
			let chosen: [number, number, number, number] | undefined
			for (const [ux, uy] of candidates) {
				if (ux === 0 && uy === 0)
					continue
				const ex = p.x + ux * STUB
				const ey = p.y + uy * STUB
				const seg: [number, number, number, number] = [p.x, p.y, ex, ey]
				// 0.10.26 修复（0.10.24 终验实锤：FB 短桩横穿 R1.2 引脚中段致串网）——
				// 引脚避让从「只查桩末端」改为「整段路径 8 单位内有任何引脚（含中段）就换方向」
				const hitsPin = allPinPts.some(q =>
					!(q.x === p.x && q.y === p.y) && pointToSegDist(q.x, q.y, p.x, p.y, ex, ey) < 8)
				if (hitsPin)
					continue
				if (existingWires.some(s => s.net !== net && segmentsIntersectOrTouch(seg, s.segment)))
					continue
				chosen = seg
				break
			}
			if (!chosen)
				throw new Error(`${p.designator}.${p.pin} 四个方向的短桩都与相邻图元/引脚冲突（整段 8 单位避让），请先挪开相邻器件或手动 drawWire`)
			const [sx1, sy1, ex, ey] = chosen
			const stub = await withStage('labelWire:wire.create', () => eda.sch_PrimitiveWire.create([sx1, sy1, ex, ey]))
			if (!stub)
				throw new Error('短桩导线创建失败（可能当前打开的不是原理图）')
			// 标签落点（0.10.20 锚点语义实锤后回归最简）：rotation 恒 0、锚点 = 桩末端（全方向一致）。
			// 决定性实验结论（TPS5450 页实测矩阵）：① 附着判定看锚点——锚点必须落在导线上
			// （端点/中段均附着，离线外 5 单位即浮标）；② rotation 0 文字从锚点向右伸展（锚点=文字左缘）。
			// 因此 0.10.18 的「锚点左移文字宽度、右缘对齐」电气上不成立（锚点离线即浮标，验收 2/2 复现超时）；
			// 官方标准形态就是「锚点压桩末端、文字右伸」（12路 人工页标签全是这个形态）。
			const bx = ex
			const by = ey
			const placement = '锚点在桩末端（rotation 0，文字自锚点右伸；0.10.20 锚点语义实锤：附着看锚点，锚点必须在导线上）'
			// 标签放落点（±2 自动微偏；返回空时先查是否假失败已创建，防双份）
			let labelId: string | undefined
			for (const [ddx, ddy] of [[0, 0], [0, 2], [0, -2], [2, 0], [-2, 0]] as Array<[number, number]>) {
				const lbl = await withStage('labelWire:createNetLabel', () => (eda.sch_PrimitiveAttribute as any).createNetLabel(bx + ddx, by + ddy, net))
				if (lbl) {
					labelId = safeState<string>(lbl, 'getState_PrimitiveId')
					break
				}
				const ghost = await findGhostNetLabel(net, bx + ddx, by + ddy)
				if (ghost) {
					labelId = ghost.id
					break
				}
			}
			if (!labelId) {
				// 原则：插件不擅自修复/回滚——短桩保留，如实报告，由操作者决定删不删
				return {
					pin: `${p.designator}.${p.pin}`,
					net,
					stub: { x1: sx1, y1: sy1, x2: ex, y2: ey },
					stubId: safeState<string>(stub, 'getState_PrimitiveId'),
					stubLen: STUB,
					labelId: undefined,
					attached: false,
					warning: '网络标签创建失败（±2 微偏均被拒）。短桩已保留未回滚：要继续可手动 placeNetLabel 补标签；要放弃请用 schematic.delete 删除 stubId',
				}
			}
			if (params.color) {
				try {
					await eda.sch_PrimitiveAttribute.modify(labelId, { color: String(params.color) } as any)
				}
				catch { /* 着色失败不阻断 */ }
			}
			// 附着验证：桩末端附近导线应已归入该网络（批处理场景由 batchWire 统一审计，跳过逐条等待）。
			// 0.10.20：附着不上时快速失败（最多 2 次 500ms 重试，≈1.5s 内返回 attached:false），
			// 不再 6 次轮询到 25s 代理超时（0.10.19 验收缺陷：偏移锚点不附着时指令整体超时且报误导文案）
			let attached: boolean | undefined
			if (params.skipAttachVerify) {
				attached = undefined
			}
			else {
				await new Promise(resolve => setTimeout(resolve, 500))
				attached = false
				for (let attempt = 0; attempt < 2 && !attached; attempt++) {
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				for (const w of wires) {
					if (safeState<string>(w, 'getState_Net') !== net)
						continue
					const line = safeState<Array<number>>(w, 'getState_Line') ?? []
					for (let i = 0; i + 1 < line.length; i += 2) {
						const x1 = line[i]
						const y1 = line[i + 1]
						const x2 = line[i + 2] ?? x1
						const y2 = line[i + 3] ?? y1
						const ddx = Math.max(Math.min(x1, x2) - ex, 0, ex - Math.max(x1, x2))
						const ddy = Math.max(Math.min(y1, y2) - ey, 0, ey - Math.max(y1, y2))
						if (Math.hypot(ddx, ddy) <= 5) {
							attached = true
							break
						}
					}
					if (attached)
						break
				}
					if (!attached)
						await new Promise(resolve => setTimeout(resolve, 500))
				}
			}
			return {
				pin: `${p.designator}.${p.pin}`,
				net,
				stub: { x1: sx1, y1: sy1, x2: ex, y2: ey },
				stubLen: STUB,
				labelId,
				labelPos: { x: bx, y: by },
				placement,
				attached,
				...(attached === false ? { note: '附着验证未通过（标签可能浮空）——请用 schematic.listNetLabels 复核；确认浮空用 schematic.pruneFloatingLabels 清理后重放，短桩可 schematic.delete 删除' } : {}),
			}
		},
	},
	{
		name: 'schematic.linkWire',
		summary: '【推荐·语义化】导线连接：用无名导线把【正好 2 个引脚】物理连通——自动 U 形正交走线（先下折再横走，横腿深度自动避开现有导线防共线合并）。⚠️ 必须正好 2 个引脚且不允许带网络名；接网络请用 schematic.labelWire',
		params: [
			{ name: 'pins', type: 'string[]', required: true, description: '正好两个引脚引用 ["U1.7","C1.1"]' },
			{ name: 'color', type: 'string', description: '导线颜色' },
			{ name: 'jogDir', type: 'string', description: '横腿方向 down | up（默认 down；引脚同列时左右错层用 left | right）' },
			{ name: 'force', type: 'boolean', description: '引脚已被占用时仍强行连接（合并网络，慎用）' },
		],
		returns: '{ pins, route: [[x,y],...], segments, wireIds } 或 { alreadyConnected: true }',
		example: { cmd: 'schematic.linkWire', params: { pins: ['U1.7', 'C1.1'] } },
		handler: async (params) => {
			if (!Array.isArray(params.pins) || params.pins.length !== 2)
				throw new Error('linkWire 必须正好给 2 个引脚（pins: ["U1.7","C1.1"]）；接网络用 schematic.labelWire，多点网络逐对连接或改用标签')
			const a = await resolvePinPoint(String(params.pins[0]))
			const b = await resolvePinPoint(String(params.pins[1]))
			assertPinConnectable(a)
			assertPinConnectable(b)
			// 占用预检：两引脚已在同一网络→直接复用；分属不同网络/单侧被占→拒绝（直连会短接网络）
			if (!params.force) {
				const aNets = await findWireNetsAtPoint(a.x, a.y)
				const bNets = await findWireNetsAtPoint(b.x, b.y)
				const common = aNets.filter(n => bNets.includes(n))
				if (common.length)
					return { pins: [`${a.designator}.${a.pin}`, `${b.designator}.${b.pin}`], alreadyConnected: true, net: common[0], note: '两引脚已在同一网络，无需连线' }
				if (aNets.length || bNets.length)
					throw new Error(`引脚已被占用：${a.designator}.${a.pin}→${aNets.join('、') || '空'}，${b.designator}.${b.pin}→${bNets.join('、') || '空'}。直接连线会把不同网络短接；确认要合并请加 force:true，否则先删现有导线`)
			}
			const existing = await collectWireSegs()
			// 0.10.27：link 直连同样做整段引脚避让（0.10.26 装机复测实锤：FBA link 横腿 (580,560)→(625,560)
			// 穿过 RV1.2 引脚把它并入无名网——0.10.26 只修了 labelWire 短桩，link 路径没修）。
			// 候选路径逐段查全页引脚（两端点引脚除外），所有候选都穿引脚则抛特定错误（autoLayout 据此降级为两端 label）
			const allPinPts = await collectAllPinPoints()
			const endKeys = new Set([`${a.x},${a.y}`, `${b.x},${b.y}`])
			const segHitsPin = (x1: number, y1: number, x2: number, y2: number): boolean =>
				allPinPts.some(q => !endKeys.has(`${q.x},${q.y}`) && pointToSegDist(q.x, q.y, x1, y1, x2, y2) < 8)
			const routeHitsPin = (r: Array<[number, number]>): boolean => {
				for (let i = 0; i + 1 < r.length; i++) {
					if (segHitsPin(r[i][0], r[i][1], r[i + 1][0], r[i + 1][1]))
						return true
				}
				return false
			}
			const outward = (pin: typeof a): [number, number] => {
				const rotation = ((pin.rot % 360) + 360) % 360
				switch (rotation) {
					case 0: return [1, 0]
					case 90: return [0, 1]
					case 180: return [-1, 0]
					case 270: return [0, -1]
					default: return [Math.round(Math.cos(rotation * Math.PI / 180)), Math.round(Math.sin(rotation * Math.PI / 180))]
				}
			}
			const [aOutX, aOutY] = outward(a)
			const [bOutX, bOutY] = outward(b)
			const escape = Math.max(30, a.pinLen + 10, b.pinLen + 10)
			const aExit: [number, number] = [a.x + aOutX * escape, a.y + aOutY * escape]
			const bExit: [number, number] = [b.x + bOutX * escape, b.y + bOutY * escape]
			const jogDown = String(params.jogDir ?? 'down') !== 'up'
			const candidates: Array<Array<[number, number]>> = []
			const push = (points: Array<[number, number]>) => {
				const compact = points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1])
				if (compact.length >= 2) candidates.push(compact)
			}
			const bridgeA: Array<[number, number]> = [[aExit[0], aExit[1]], [bExit[0], aExit[1]], [bExit[0], bExit[1]]]
			const bridgeB: Array<[number, number]> = [[aExit[0], aExit[1]], [aExit[0], bExit[1]], [bExit[0], bExit[1]]]
			push([[a.x, a.y], aExit, ...bridgeA.slice(1), [b.x, b.y]])
			push([[a.x, a.y], aExit, ...bridgeB.slice(1), [b.x, b.y]])
			// 同行/同列时，先沿请求方向生成折线候选，再逐步外移；首末段始终从 pin 尖端朝外。
			const sameRow = aExit[1] === bExit[1]
			const sameColumn = aExit[0] === bExit[0]
			const preferredSign = jogDown ? -1 : 1
			if (sameRow || sameColumn) {
				const axis = sameRow ? 'y' : 'x'
				const coords = axis === 'y'
					? [a.y, b.y, ...existing.flatMap(s => [s[1], s[3]]), ...allPinPts.map(q => q.y)]
					: [a.x, b.x, ...existing.flatMap(s => [s[0], s[2]]), ...allPinPts.map(q => q.x)]
				const base = axis === 'y' ? aExit[1] : aExit[0]
				const edge = preferredSign < 0 ? Math.min(...coords) - 30 : Math.max(...coords) + 30
				const maxSteps = Math.max(1, Math.ceil(Math.abs(edge - base) / 15) + 1)
				for (let k = 0; k < maxSteps; k++) {
					const jog = base + preferredSign * (30 + 15 * k)
					if (axis === 'y') push([[a.x, a.y], aExit, [aExit[0], jog], [bExit[0], jog], bExit, [b.x, b.y]])
					else push([[a.x, a.y], aExit, [jog, aExit[1]], [jog, bExit[1]], bExit, [b.x, b.y]])
				}
			}
			const routeClear = (points: Array<[number, number]>) => {
				const segs = points.slice(1).map((point, index) => [points[index][0], points[index][1], point[0], point[1]] as [number, number, number, number])
				const selfClear = segs.every((segment, index) => segs.slice(index + 1).every((other, offset) => {
					const otherIndex = index + 1 + offset
					if (otherIndex === index + 1) return !segCollinearOverlap(segment, other)
					return !segmentsIntersectOrTouch(segment, other)
				}))
				return selfClear && segs.every(segment => segment[0] === segment[2] || segment[1] === segment[3])
					&& !routeHitsPin(points)
					&& !segs.some(segment => existing.some(old => segCollinearOverlap(segment, old)))
			}
			const route = candidates.find(routeClear)
			if (!route)
				throw new Error('找不到不共线且不穿引脚的走线路径（已按当前障碍范围检查 U 形候选及 L 形两变体），autoLayout 场景会自动降级为两端 label 短桩（PIN_CROSSING_FALLBACK）')
			const wireColor = params.color != null ? String(params.color) : undefined
			const wireIds: Array<string> = []
			const { segments } = splitToSimpleSegments(route as Array<[number, number]>)
			for (const [x1, y1, x2, y2] of segments) {
				const wire = await withStage('linkWire:wire.create', () => eda.sch_PrimitiveWire.create([x1, y1, x2, y2], undefined, wireColor as any))
				if (!wire)
					throw new Error(`走线段 (${x1},${y1})→(${x2},${y2}) 创建失败`)
				const id = safeState<string>(wire, 'getState_PrimitiveId')
				if (id)
					wireIds.push(id)
			}
			return {
				pins: [`${a.designator}.${a.pin}`, `${b.designator}.${b.pin}`],
				route,
				segments: wireIds.length,
				wireIds,
			}
		},
	},
	{
		name: 'schematic.batchWire',
		summary: '【推荐·批量】一次提交一批接线项（label 标签接网 / link 两脚直连），逐条执行逐条收错，最后只做一次网表统一审计——比逐条 labelWire/linkWire 快得多（省去每条 500ms×6 的附着等待）。⚠️ 只报告不自动修复：audit 失败的项由操作者决定处置',
		params: [
			{ name: 'items', type: 'array', required: true, description: '接线项数组：[{type:"label", pin:"U1.7", net:"VOUT", color?, stubLen?}, {type:"link", pins:["U1.7","C1.1"], color?, jogDir?}]；stubLen 为有限正数，最小按 20 单位处理' },
			{ name: 'continueOnError', type: 'boolean', description: '单项失败是否继续执行后续项，默认 true' },
			{ name: 'skipAudit', type: 'boolean', description: '跳过最后的网表统一审计（只要执行结果），默认 false' },
		],
		returns: '{ items: [{item, ok, data|error}], audit: [{item, pass, detail}], summary: {total, ok, failed, auditFailed} }',
		example: { cmd: 'schematic.batchWire', params: { items: [{ type: 'label', pin: 'U1.7', net: 'VOUT' }, { type: 'link', pins: ['R1.1', 'C1.1'] }] } },
		handler: async (params, ctx) => {
			if (!Array.isArray(params.items) || !params.items.length)
				throw new Error('缺少参数 items（非空数组）')
			for (const [index, item] of (params.items as Array<any>).entries()) {
				if (item?.type === 'label' && item.stubLen != null
					&& (typeof item.stubLen !== 'number' || !Number.isFinite(item.stubLen) || item.stubLen <= 0))
					throw new Error(`items[${index}].stubLen 必须是有限正数；显式值仍按最小 20 单位处理。整批未执行`)
			}
			const continueOnError = params.continueOnError !== false
			const labelCmd = schematicCommands.find(c => c.name === 'schematic.labelWire')
			const linkCmd = schematicCommands.find(c => c.name === 'schematic.linkWire')
			if (!labelCmd || !linkCmd)
				throw new Error('内部错误：labelWire/linkWire 未注册')

			// 0.10.49：注册长任务——逐条进度心跳重置代理/扩展超时（批量接线 48 项约 60s+，
			// 客户端超时后同参数重发只回进度不重复执行）；心跳经 ctx.onProgress 发给代理
			const { task, existing } = beginTask('schematic.batchWire',
				{ items: params.items, continueOnError, skipAudit: params.skipAudit === true },
				ctx && ((t) => ctx.onProgress?.({ taskId: t.id, state: t.state, ...t.progress })))
			if (existing) {
				return {
					taskId: task.id,
					alreadyRunning: true,
					state: task.state,
					progress: task.progress,
					note: '相同批量接线任务仍在后台执行——这是实时进度，稍后重发或 task.get 取结果即可，不要改参数重发',
				}
			}

			try {
			const results: Array<any> = []
			for (let i = 0; i < params.items.length; i++) {
				const item = params.items[i] ?? {}
				const type = String(item.type ?? '')
				try {
					let data: any
					if (type === 'label') {
						if (!item.pin || !item.net)
							throw new Error('label 项缺少 pin / net')
						const focus = await eda.dmt_SelectControl.getCurrentDocumentInfo()
						if (focus?.documentType !== 1 || !focus.uuid) throw new Error('批量短桩写前无法确认原理图身份')
						data = await labelCmd.handler({ pin: item.pin, net: item.net, color: item.color, stubLen: item.stubLen, skipAttachVerify: true }, ctx)
						if (!data.alreadyConnected) {
							let verified = false
							let reason = '短桩完整几何及目标网络尚未读回'
							for (const delay of [0, 100, 250, 500]) {
								if (delay) await new Promise(resolve => setTimeout(resolve, delay))
								try {
									const current = await eda.dmt_SelectControl.getCurrentDocumentInfo()
									if (current?.documentType !== 1 || current.uuid !== focus.uuid) { reason = '批量短桩写后焦点改变'; break }
									const segments = await collectWireSegsByNet()
									const after = await eda.dmt_SelectControl.getCurrentDocumentInfo()
									if (after?.documentType !== 1 || after.uuid !== focus.uuid) { reason = '批量短桩读回期间焦点改变'; break }
									const stub = data.stub
									if (!stub || !data.labelId) { reason = '短桩或标签创建结果未确认'; break }
									const vertical = stub.x1 === stub.x2
									const lo = Math.min(vertical ? stub.y1 : stub.x1, vertical ? stub.y2 : stub.x2)
									const hi = Math.max(vertical ? stub.y1 : stub.x1, vertical ? stub.y2 : stub.x2)
									const intervals = segments.filter(s => s.net === String(item.net)
										&& (vertical ? s.segment[0] === stub.x1 && s.segment[2] === stub.x1 : s.segment[1] === stub.y1 && s.segment[3] === stub.y1))
										.map(s => vertical ? [Math.min(s.segment[1], s.segment[3]), Math.max(s.segment[1], s.segment[3])] : [Math.min(s.segment[0], s.segment[2]), Math.max(s.segment[0], s.segment[2])]).sort((a, b) => a[0] - b[0])
									let covered = lo
									for (const [start, end] of intervals) { if (start > covered) break; if (end >= covered) covered = end }
									if (hi > lo && covered >= hi) { verified = true; break }
								}
								catch (error) { reason = String((error as any)?.message ?? error) }
							}
							if (!verified) throw new Error('批量短桩写后未确认，停止后续项', { cause: { partial: true, retryable: false, result: { index: i, item, data, reason } } })
							data.stubReadbackVerified = true
						}
					}
					else if (type === 'link') {
						if (!Array.isArray(item.pins))
							throw new Error('link 项缺少 pins 数组')
						data = await linkCmd.handler({ pins: item.pins, color: item.color, jogDir: item.jogDir, force: item.force }, ctx)
					}
					else
						throw new Error(`未知 type "${type}"，只支持 label | link`)
					results.push({ index: i, item, ok: true, data })
				}
				catch (e: any) {
					if (e?.cause?.partial) throw e
					// 0.10.51：失败项保留完整诊断——error 保持字符串兼容旧调用方（含 0.10.48 的
					// [阶段] 前缀），另附 message/name/stack/cause（GPT KIMI-EDA-20261002-07 指出：
					// 此处只 String(message) 绕过了 registry.errorResult 的堆栈透传，批量路径丢失诊断）
					const detail = serializeErrorDetail(e)
					results.push({ index: i, item, ok: false, error: detail.message, ...detail })
					if (!continueOnError)
						break
				}
				taskProgress(task, {
					stage: 'items',
					done: results.length,
					total: params.items.length,
					ok: results.filter(r => r.ok).length,
					failed: results.filter(r => !r.ok).length,
					last: { type: item.type, pin: item.pin, pins: item.pins, net: item.net },
				})
			}

			// 统一审计：一次网表导出，逐条核对
			const audit: Array<any> = []
			if (!params.skipAudit) {
				taskProgress(task, { stage: 'audit', done: results.length, total: params.items.length })
				// getNetlistFile 大批量改动后会导出缓存旧快照（误报 pass:false），
				// 参考 runDrc 双跑取稳定值的做法：审计未全过时等 800ms 重导，最多 5 次，取最后一次结果。
				// 0.10.45：换用 pinNetMapRobust——getNetlistFile 返空（如缺封装，04 实测因果）时
				// 自动回退 PADS 文本网表解析，缺封装工程上终审不再整体失效（GPT KIMI-EDA-20261002-05）。
				const exportPinNetMap = (): Promise<Map<string, string> | undefined> => pinNetMapRobust()
				const auditWith = (pinNetMap: Map<string, string> | undefined): Array<any> => results.filter(r => r.ok).map((r) => {
					if (!pinNetMap)
						return { index: r.index, item: r.item, pass: undefined, detail: '网表导出失败，未能审计' }
					if (String(r.item.type) === 'label') {
						const actual = pinNetMap.get(String(r.item.pin))
						const pass = actual === String(r.item.net)
						return {
							index: r.index,
							item: r.item,
							pass,
							detail: pass ? '已入网' : `引脚实际网络为 ${actual ?? '(悬空/未入网)'}，期望 ${r.item.net}——标签可能未附着，可用 schematic.listNetLabels 复核或 schematic.repairNet 修复`,
						}
					}
					const [pa, pb] = (r.item.pins as Array<string>).map(String)
					const na = pinNetMap.get(pa)
					const nb = pinNetMap.get(pb)
					const pass = na != null && na === nb
					return {
						index: r.index,
						item: r.item,
						pass,
						detail: pass ? `两脚同网 ${na}` : `两脚网络不一致：${pa}→${na ?? '(空)'}，${pb}→${nb ?? '(空)'}`,
					}
				})
				let pinNetMap = await exportPinNetMap()
				let lastAudit = auditWith(pinNetMap)
				for (let retry = 0; retry < 5 && lastAudit.some(a => a.pass === false); retry++) {
					await new Promise(resolve => setTimeout(resolve, 800))
					pinNetMap = await exportPinNetMap()
					lastAudit = auditWith(pinNetMap)
				}
				audit.push(...lastAudit)
			}

			// 0.10.24（P01 关联加固）：批量命名偶发失效（空网名）必须进 failed 清单——
			// 网表审计 pass:false 的项即使执行阶段 ok:true 也改写为失败（带实际网名），不允许静默进成功计数
			for (const a of audit) {
				if (a.pass !== false)
					continue
				const r = results.find(x => x.index === a.index)
				if (r && r.ok) {
					r.ok = false
					r.error = `网表审计未通过：${a.detail}`
					r.auditFailed = true
					delete r.data
				}
			}

			const failed = results.filter(r => !r.ok).length
			const auditFailed = audit.filter(a => a.pass === false).length
			const batchResult = {
				items: results,
				audit,
				summary: { total: results.length, ok: results.length - failed, failed, auditFailed },
				...(failed || auditFailed ? { note: '存在失败/审计未通过项，插件不自动修复——请按 audit.detail 逐条处置后重跑失败项' } : {}),
			}
			finishTask(task, batchResult.summary)
			return { taskId: task.id, ...batchResult }
			}
			catch (e) {
				failTask(task, e)
				throw e
			}
		},
	},
	{
		name: 'schematic.listPins',
		summary: '列出器件全部引脚（编号、名称、坐标）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
		],
		returns: '引脚列表 [{ pinNumber, pinName, x, y }]',
		example: { cmd: 'schematic.listPins', params: { primitiveId: 'xxx' } },
		handler: async (params) => {
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(String(params.primitiveId))
			return (pins ?? []).map(p => ({
				pinNumber: p.getState_PinNumber?.(),
				pinName: p.getState_PinName?.(),
				x: p.getState_X?.(),
				y: p.getState_Y?.(),
			}))
		},
	},
	{
		name: 'schematic.listComponents',
		summary: '列出当前原理图图页的全部器件',
		params: [
			{ name: 'allPages', type: 'boolean', description: '是否包含所有图页，默认 false（仅当前图页）' },
		],
		returns: '器件列表 [{ primitiveId, designator, name, x, y, rotation }]',
		example: { cmd: 'schematic.listComponents' },
		handler: async (params) => {
			if (params.allPages !== undefined && typeof params.allPages !== 'boolean')
				throw new Error('allPages 必须是布尔值')
			const allPages = params.allPages ?? false
			const components = await eda.sch_PrimitiveComponent.getAll(undefined, allPages)
			return (components ?? []).map(c => ({
				primitiveId: safeState<string>(c, 'getState_PrimitiveId'),
				designator: safeState<string>(c, 'getState_Designator'),
				name: safeState<string>(c, 'getState_Name'),
				x: safeState<number>(c, 'getState_X'),
				y: safeState<number>(c, 'getState_Y'),
				rotation: safeState<number>(c, 'getState_Rotation'),
			}))
		},
	},
	{
		name: 'schematic.placeDevice',
		summary: '按立创编号或库内器件 UUID 在原理图放置器件；返回放置本身、封装核验和器件库身份的独立状态，不自动替换缺封装器件',
		params: [
			{ name: 'lcscId', type: 'string', description: '立创编号，如 C25804（与 deviceUuid 二选一）；可选 libraryUuid 限定查询库，未传时沿用 SDK 默认查询范围' },
			{ name: 'deviceUuid', type: 'string', description: '器件 UUID（需同时给 libraryUuid）' },
			{ name: 'libraryUuid', type: 'string', description: '器件所在库 UUID；与 deviceUuid 配对使用，或限定 lcscId 搜索库' },
			{ name: 'x', type: 'number', required: true, description: '坐标 X（单位 10mil；A4 图框有效范围约 0–1170，建议 100–1000）' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y（单位 10mil；A4 图框有效范围约 0–830，建议 100–700）' },
			{ name: 'rotation', type: 'number', description: '旋转角度，默认 0' },
			{ name: 'mirror', type: 'boolean', description: '是否镜像，默认 false' },
			{ name: 'subPartName', type: 'string', description: '多部件器件的子部件名' },
			{ name: 'addIntoBom', type: 'boolean', description: '是否加入 BOM，默认 true' },
			{ name: 'addIntoPcb', type: 'boolean', description: '是否转换到 PCB，默认 true' },
		],
		returns: '{ primitiveId, designator, device: { requestedLcscId?, requestedLibraryUuid?, selectedDeviceUuid, selectedLibraryUuid }, placementVerified, footprintVerified, footprintStatus, pcbReady, warnings, readback: { footprint, pinPadMap?, pinPadMapVerified, verified, persistenceVerified: false } }；placementVerified 只确认符号实例放置与读回；pcbReady 仅表示封装资源及实例焊盘映射核验，不代表工程保存或整板验收',
		example: { cmd: 'schematic.placeDevice', params: { lcscId: 'C25804', x: 300, y: 300, addIntoBom: false, addIntoPcb: true } },
		handler: async (params) => {
			return await placeDeviceSafely(eda as any, params)
		},
	},
	{
		name: 'schematic.getPlacementResourcesDiagnostic',
		summary: '只读诊断器件实例封装 UUID 与当前文档封装资源返回，不执行放置或保存',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '待检查的原理图器件实例 primitiveId' },
		],
		returns: '{ diagnosticOnly: true, placementVerified: false, documentUuid, projectUuid, focusStart, focusEnd, focusUnchanged, instanceFootprintUuid, typedFootprint, projectLibraryUuid, projectLibraryUuidError?, resourceListState, resourceCount, resources, projectResource, complete }',
		example: { cmd: 'schematic.getPlacementResourcesDiagnostic', params: { primitiveId: 'a1b2c3d4' } },
		handler: async (params) => {
			const primitiveId = String(params.primitiveId ?? '').trim()
			if (!primitiveId)
				throw new Error('缺少参数 primitiveId')
			const focusSummary = (info: any) => ({
				documentType: info?.documentType ?? null,
				uuid: typeof info?.uuid === 'string' ? info.uuid : null,
				parentProjectUuid: typeof info?.parentProjectUuid === 'string' ? info.parentProjectUuid : null,
			})
			let complete = true
			let focusStart: any
			let focusEnd: any
			let instanceFootprintUuid: string | null = null
			let typedFootprint: { uuid: string | null; libraryUuid: string | null } | null = null
			let projectLibraryUuid: string | null = null
			let projectLibraryUuidError: string | undefined
			let focusReadError: string | undefined
			let instanceReadError: string | undefined
			let resourceReadError: string | undefined
			let projectResourceError: string | undefined
			let projectResource: Record<string, unknown> | null = null
			let sources: Array<any> = []
			let resourceCount: number | null = null
			try {
				focusStart = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			}
			catch (error: any) {
				complete = false
				focusReadError = `读取起始焦点失败：${String(error?.message ?? error)}`
			}
			const hasValidStartIdentity = focusStart?.documentType === 1
				&& typeof focusStart.uuid === 'string' && focusStart.uuid.trim() !== ''
				&& typeof focusStart.parentProjectUuid === 'string' && focusStart.parentProjectUuid.trim() !== ''
			if (!hasValidStartIdentity) {
				complete = false
				focusReadError ??= '起始焦点不是具有 page/project UUID 的原理图'
			}
			if (hasValidStartIdentity) {
				try {
					const component = await eda.sch_PrimitiveComponent.get(primitiveId)
					if (!component)
						throw new Error(`找不到器件实例 ${primitiveId}`)
					const getFootprint = component?.getState_Footprint
					if (typeof getFootprint !== 'function')
						throw new Error('实例缺少 getState_Footprint')
					const footprint = getFootprint.call(component)
					if (footprint == null)
						instanceFootprintUuid = null
					else if (typeof footprint === 'object' && !Array.isArray(footprint)) {
						typedFootprint = { uuid: typeof footprint.uuid === 'string' ? footprint.uuid : null, libraryUuid: typeof footprint.libraryUuid === 'string' ? footprint.libraryUuid : null }
						if (typeof footprint.uuid === 'string' && footprint.uuid)
							instanceFootprintUuid = footprint.uuid
						else
							throw new Error('实例 Footprint 结构缺少有效 uuid')
					}
					else
						throw new Error('实例 Footprint 结构缺少有效 uuid')
				}
				catch (error: any) {
					complete = false
					instanceReadError = `读取实例 Footprint 失败：${String(error?.message ?? error)}`
				}
			}
			else {
				complete = false
			}
			if (hasValidStartIdentity) {
				try {
					const value = await eda.lib_LibrariesList.getProjectLibraryUuid()
					if (typeof value !== 'string' || !value.trim())
						throw new Error('getProjectLibraryUuid 返回值不是非空字符串')
					projectLibraryUuid = value
				}
				catch (error: any) {
					complete = false
					projectLibraryUuidError = String(error?.message ?? error)
				}
			}
			if (hasValidStartIdentity) {
				try {
					const result = await eda.sys_FileManager.getDocumentFootprintSources()
					if (!Array.isArray(result))
						throw new Error('getDocumentFootprintSources 返回值不是数组')
					sources = result
					resourceCount = result.length
				}
				catch (error: any) {
					complete = false
					resourceReadError = `读取工程封装资源失败：${String(error?.message ?? error)}`
				}
			}
			const resources = sources.map((resource: any, index: number) => {
				const summary: Record<string, unknown> = {
					index,
					rawFootprintUuid: resource?.footprintUuid ?? null,
					sourceLength: typeof resource?.documentSource === 'string' ? resource.documentSource.length : null,
					doctype: null,
					headUuid: null,
				}
				const errors: Array<string> = []
				if (typeof resource?.footprintUuid !== 'string' || !resource.footprintUuid.trim())
					errors.push('资源条目缺少 footprintUuid')
				if (typeof resource?.documentSource !== 'string')
					errors.push('documentSource 不是字符串')
				else {
					const rows: Array<Array<any>> = []
					for (const [lineIndex, line] of resource.documentSource.split(/\r?\n/).entries()) {
						if (!line.trim())
							continue
						try {
							const row = JSON.parse(line)
							if (!Array.isArray(row) || typeof row[0] !== 'string') {
								errors.push(`第 ${lineIndex + 1} 行不是数组记录`)
								continue
							}
							rows.push(row)
						}
						catch {
							errors.push(`第 ${lineIndex + 1} 行 JSON 解析失败`)
						}
					}
					const doctypes = rows.filter(row => row[0] === 'DOCTYPE')
					const heads = rows.filter(row => row[0] === 'HEAD' || row[0] === 'DOCHEAD')
					if (doctypes.length !== 1 || typeof doctypes[0]?.[1] !== 'string')
						errors.push(`DOCTYPE 数量或内容无效（${doctypes.length}）`)
					else {
						summary.doctype = { type: doctypes[0][1], version: typeof doctypes[0][2] === 'string' ? doctypes[0][2] : null }
						if (doctypes[0][1] !== 'FOOTPRINT')
							errors.push(`DOCTYPE 类型不支持（${doctypes[0][1]}）`)
					}
					if (heads.length !== 1 || !heads[0]?.[1] || typeof heads[0][1] !== 'object' || Array.isArray(heads[0][1]))
						errors.push(`HEAD/DOCHEAD 数量或内容无效（${heads.length}）`)
					else if (typeof heads[0][1].uuid !== 'string' || !heads[0][1].uuid.trim())
						errors.push('HEAD/DOCHEAD.uuid 缺失或无效')
					else
						summary.headUuid = heads[0][1].uuid
				}
				if (errors.length) {
					complete = false
					summary.parseError = errors.join('; ')
				}
				return summary
			})
			if (instanceFootprintUuid && hasValidStartIdentity) {
				try {
					projectResource = await getProjectFootprintDiagnostic(eda as any, instanceFootprintUuid, primitiveId, focusStart)
				}
				catch (error: any) {
					complete = false
					projectResourceError = String(error?.message ?? error)
				}
			}
			else if (!instanceFootprintUuid && !instanceReadError && !focusReadError && hasValidStartIdentity) {
				projectResource = { state: 'no-instance-footprint' }
			}
			else {
				complete = false
			}
			try {
				focusEnd = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			}
			catch (error: any) {
				complete = false
				focusReadError = [focusReadError, `读取结束焦点失败：${String(error?.message ?? error)}`].filter(Boolean).join('; ')
			}
			const start = focusSummary(focusStart)
			const end = focusSummary(focusEnd)
			const focusUnchanged = hasValidStartIdentity
				&& start.documentType === end.documentType && start.uuid === end.uuid && start.parentProjectUuid === end.parentProjectUuid
			if (!focusUnchanged)
				complete = false
			const resourceListState = resourceReadError ? 'unavailable' : !hasValidStartIdentity ? 'not-read-invalid-focus' : sources.length === 0 ? 'empty-returned' : 'nonempty-returned'
			return {
				diagnosticOnly: true,
				placementVerified: false,
				primitiveId,
				documentUuid: start.uuid,
				projectUuid: start.parentProjectUuid,
				focusStart: start,
				focusEnd: end,
				focusUnchanged,
				instanceFootprintUuid,
				typedFootprint,
				projectLibraryUuid,
				...(projectLibraryUuidError ? { projectLibraryUuidError } : {}),
				...(focusReadError ? { focusReadError } : {}),
				...(instanceReadError ? { instanceReadError } : {}),
				resourceListState,
				resourceCount,
				resources,
				...(resourceReadError ? { resourceReadError } : {}),
				projectResource,
				...(projectResourceError ? { projectResourceError } : {}),
				complete,
			}
		},
	},
	{
		name: 'schematic.drawWire',
		summary: '在原理图绘制导线。内部自动拆成简单两点段（多分支折线/重复段/斜线伪段都不会失败）；智能命名：同一网络在页面只命名一次，其余段自动无名（从源头避免"多个网络名"警告）',
		params: [
			{ name: 'points', type: 'number[][]', required: true, description: '折点坐标 [[x1,y1],[x2,y2],...]（单位 10mil）' },
			{ name: 'net', type: 'string', description: '网络名，留空则自动；若该网络已存在则自动画无名段' },
			{ name: 'color', type: 'string', description: '导线颜色，如 #FF0000（0.9.8 起）' },
			{ name: 'lineWidth', type: 'number', description: '线宽（0.9.8 起）' },
			{ name: 'lineType', type: 'string', description: '线型 solid | dashed | dotted（0.9.8 起）' },
		],
		returns: '{ primitiveIds, segments, named, net?, skippedDiagonal?, drawingOrderChanges?: [{ id, wireId, before, after }] }',
		example: { cmd: 'schematic.drawWire', params: { points: [[300, 300], [400, 300]], net: 'VCC' } },
		handler: async (params) => {
			const operationStartedAt = performance.now()
			const requestedOperationBudget = params._timeoutMs == null ? 290_000 : Number(params._timeoutMs)
			if (!Number.isFinite(requestedOperationBudget) || requestedOperationBudget <= 0)
				throw new Error('_timeoutMs 必须是有限正数')
			const effectiveOperationBudget = Math.max(1000, requestedOperationBudget)
			const operationMargin = Math.min(250, effectiveOperationBudget * 0.1)
			const operationDeadline = operationStartedAt + Math.max(1, effectiveOperationBudget - operationMargin)
			const awaitWithinOperationDeadline = async <T>(operation: () => Promise<T> | T, label: string): Promise<T> => {
				const remaining = operationDeadline - performance.now()
				if (remaining <= 0) throw new Error(`${label}超出 drawWire 总时间预算`)
				let timer: ReturnType<typeof setTimeout> | undefined
				try {
					return await Promise.race([
						Promise.resolve().then(operation),
						new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超出 drawWire 总时间预算`)), remaining) }),
					])
				}
				finally { if (timer !== undefined) clearTimeout(timer) }
			}
			if (!Array.isArray(params.points) || params.points.length < 2)
				throw new Error('points 至少需要两个点')
			// 兼容 [{x,y},...] 对象形式，统一归一为 [[x,y],...]
			const pts = (params.points as Array<any>).map(p =>
				Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.x), Number(p?.y)]) as Array<[number, number]>
			if (pts.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
				throw new Error('points 格式应为 [[x1,y1],[x2,y2],...] 或 [{x,y},...]')
			const net = params.net ? String(params.net) : undefined
			const wireColor = params.color != null ? String(params.color) : undefined
			const wireWidth = params.lineWidth != null ? Number(params.lineWidth) : undefined
			const wireTypeMap: Record<string, number> = { solid: 0, dashed: 1, dotted: 2 }
			const wireType = params.lineType != null ? (wireTypeMap[String(params.lineType)] ?? 0) : undefined
			const initialFocus: any = await awaitWithinOperationDeadline(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), '读取初始焦点')
			if (initialFocus?.documentType !== 1 || typeof initialFocus.uuid !== 'string' || !initialFocus.uuid.trim())
				throw new Error(`焦点文档不是有效原理图（documentType=${initialFocus?.documentType ?? '未知'}, uuid=${initialFocus?.uuid ?? '无'}）`)
			const expectedUuid = initialFocus.uuid
			// 智能命名：网络已存在（命名导线或网络标签）则画无名段
			let nameNext = net ? !(await awaitWithinOperationDeadline(() => netExistsOnPage(net), '检查现存网络名')) : false
			const { segments, skippedDiagonal } = splitToSimpleSegments(pts)
			if (!segments.length)
				throw new Error('没有可绘制的有效线段（全部为重复/零长/斜线段）')
			// create 会把相接线合并到旧图元上，故每段都以源码/模型读回确认最终存活 ID。
			// 快照只保存原始值，避免 SDK getter 返回的活动对象在后续写入后改变。
			const normalizeLine = (value: any): Array<number> | undefined => {
				const values = Array.isArray(value) && Array.isArray(value[0]) ? value.flat() : value
				return Array.isArray(values) && values.length >= 4 && values.length % 2 === 0 && values.every(Number.isFinite) ? [...values] : undefined
			}
			const lineGeometryCandidates = (value: any, sourcePaths?: Array<Array<number>>): Array<Array<Array<number>>> => {
				const groups: Array<Array<number>> = Array.isArray(value) && Array.isArray(value[0]) ? value : [value]
				if (!groups.length || groups.some(group => !Array.isArray(group) || group.length < 4 || group.length % 2 !== 0 || !group.every(Number.isFinite)))
					return []
				let combined: Array<Array<Array<number>>> = [[]]
				for (const group of groups) {
					const choices: Array<Array<Array<number>>> = [[ [...group] ]]
					if (group.length % 4 === 0) {
						const tuples: Array<Array<number>> = []
						for (let i = 0; i < group.length; i += 4) tuples.push(group.slice(i, i + 4))
						choices.push(tuples)
					}
					const geometryKey = (paths: Array<Array<number>>) => paths.flatMap(path => lineSegments(path).map(segmentKey)).sort().join('|')
					const uniqueChoices = [...new Map(choices.map(choice => [geometryKey(choice), choice])).values()]
					const sourceCompatible = sourcePaths ? uniqueChoices.filter(choice => geometryPathsPreserved(choice, sourcePaths)) : uniqueChoices
					const next = new Map<string, Array<Array<number>>>()
					for (const prefix of combined) for (const choice of sourceCompatible) {
						const candidate = [...prefix, ...choice]
						const key = geometryKey(candidate)
						if (!next.has(key)) next.set(key, candidate)
					}
					combined = [...next.values()]
				}
				return combined
			}
			const sourceLineToSdk = (line: Array<number>) => line.map((value, index) => index % 2 === 1 ? -value : value)
			const wireCovers = (wire: any, segment: Array<number>) =>
				pathCovered(segment, wire?.sourcePaths ?? [])
			const wireContributes = (wire: any, segment: Array<number>) => {
				const [x1, y1, x2, y2] = segment
				return (wire?.sourcePaths ?? []).some((line: Array<number> | undefined) => lineSegments(line).some(([ax, ay, bx, by]) =>
					y1 === y2 && ay === by && ay === y1 && Math.min(Math.max(ax, bx), Math.max(x1, x2)) > Math.max(Math.min(ax, bx), Math.min(x1, x2))
					|| x1 === x2 && ax === bx && ax === x1 && Math.min(Math.max(ay, by), Math.max(y1, y2)) > Math.max(Math.min(ay, by), Math.min(y1, y2))))
			}
			const lineSegments = (line: Array<number> | undefined) => {
				const out: Array<Array<number>> = []
				if (line) for (let i = 0; i + 3 < line.length; i += 2) out.push(line.slice(i, i + 4))
				return out
			}
			const segmentCovered = (target: Array<number>, lines: Array<Array<number>>) => {
				const [x1, y1, x2, y2] = target
				const horizontal = y1 === y2
				const vertical = x1 === x2
				if (!horizontal && !vertical) return false
				const fixed = horizontal ? y1 : x1
				const low = Math.min(horizontal ? x1 : y1, horizontal ? x2 : y2)
				const high = Math.max(horizontal ? x1 : y1, horizontal ? x2 : y2)
				const intervals = lines.flatMap(lineSegments).flatMap(([ax, ay, bx, by]) => {
					if (horizontal ? ay !== fixed || by !== fixed : ax !== fixed || bx !== fixed) return []
					const a = Math.max(low, Math.min(horizontal ? ax : ay, horizontal ? bx : by))
					const b = Math.min(high, Math.max(horizontal ? ax : ay, horizontal ? bx : by))
					return b > a ? [[a, b] as [number, number]] : []
				}).sort((a, b) => a[0] - b[0])
				let end = low
				for (const [a, b] of intervals) {
					if (a > end) return false
					end = Math.max(end, b)
					if (end >= high) return true
				}
				return false
			}
			const pathCovered = (target: Array<number>, lines: Array<Array<number>>) =>
				lineSegments(target).every(segment => segmentCovered(segment, lines))
			const segmentKey = (segment: Array<number>) => {
				const [x1, y1, x2, y2] = segment
				return JSON.stringify([[x1, y1], [x2, y2]].sort((a, b) => a[0] - b[0] || a[1] - b[1]))
			}
			const sameSegments = (a: Array<number>, b: Array<number>) => {
				const left = lineSegments(a).map(segmentKey).sort()
				const right = lineSegments(b).map(segmentKey).sort()
				return left.length === right.length && left.every((value, index) => value === right[index])
			}
			const geometryPreserved = (target: Array<number>, lines: Array<Array<number>>) =>
				lineSegments(target).every(segment => segment[1] === segment[3] || segment[0] === segment[2]
					? segmentCovered(segment, lines)
					: lines.some(line => lineSegments(line).some(candidate => segmentKey(candidate) === segmentKey(segment))))
			const geometryPathsPreserved = (targets: Array<Array<number>>, lines: Array<Array<number>>) =>
				targets.flatMap(lineSegments).every(segment => geometryPreserved(segment, lines))
			const segmentOverlaps = (a: Array<number>, b: Array<number>) => {
				const [ax1, ay1, ax2, ay2] = a
				const [bx1, by1, bx2, by2] = b
				return ay1 === ay2 && by1 === by2 && ay1 === by1
					? Math.min(Math.max(ax1, ax2), Math.max(bx1, bx2)) > Math.max(Math.min(ax1, ax2), Math.min(bx1, bx2))
					: ax1 === ax2 && bx1 === bx2 && ax1 === bx1
						? Math.min(Math.max(ay1, ay2), Math.max(by1, by2)) > Math.max(Math.min(ay1, ay2), Math.min(by1, by2))
						: false
			}
			const segmentOverlapsOrMatches = (a: Array<number>, b: Array<number>) =>
				segmentOverlaps(a, b) || segmentKey(a) === segmentKey(b)
			const segmentsTouch = (a: Array<number>, b: Array<number>) => {
				if (segmentOverlapsOrMatches(a, b)) return true
				const onSegment = (x: number, y: number, line: Array<number>) =>
					(x === line[0] && line[0] === line[2] && y >= Math.min(line[1], line[3]) && y <= Math.max(line[1], line[3]))
					|| (y === line[1] && line[1] === line[3] && x >= Math.min(line[0], line[2]) && x <= Math.max(line[0], line[2]))
				const endpoints = [[a[0], a[1]], [a[2], a[3]], [b[0], b[1]], [b[2], b[3]]]
				return endpoints.some(([x, y]) => onSegment(x, y, a) && onSegment(x, y, b))
			}
			const styleKey = (item: any) => JSON.stringify({ color: item?.strokeColor ?? item?.color ?? null, width: item?.strokeWidth ?? item?.lineWidth ?? null, type: item?.strokeStyle ?? item?.lineType ?? null })
			class DrawWireIdentityError extends Error {
				code = 'DRAW_WIRE_IDENTITY_CHANGED'
			}
			const isIdentityError = (error: any) => error?.code === 'DRAW_WIRE_IDENTITY_CHANGED'
			const capture = async (expectedUuid: string, allowWireIdLag = false, deadline?: number) => {
				const awaitCaptureRead = async <T>(operation: () => Promise<T> | T, label: string): Promise<T> => {
					const readDeadline = deadline ?? operationDeadline
					const remaining = readDeadline - performance.now()
					if (remaining <= 0) throw new Error(`${label}超出 drawWire 总时间预算`)
					let timer: ReturnType<typeof setTimeout> | undefined
					try {
						return await Promise.race([
							Promise.resolve().then(operation),
							new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超出 drawWire 总时间预算`)), remaining) }),
						])
					}
					finally { if (timer !== undefined) clearTimeout(timer) }
				}
				const focus: any = await awaitCaptureRead(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), '读取焦点文档')
				if (focus?.documentType !== 1 || focus?.uuid !== expectedUuid)
					throw new DrawWireIdentityError(`焦点原理图已变化（预期 UUID=${expectedUuid}, 当前=${focus?.uuid ?? '未知'}）`)
				const source = await awaitCaptureRead(() => eda.sys_FileManager.getDocumentSource(), '读取原理图源码')
				const focusAfterSource: any = await awaitCaptureRead(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), '源码后焦点核对')
				if (focusAfterSource?.documentType !== 1 || focusAfterSource?.uuid !== expectedUuid)
					throw new DrawWireIdentityError(`读取原理图源码期间焦点已变化（预期 UUID=${expectedUuid}, 当前=${focusAfterSource?.uuid ?? '未知'}）`)
				if (typeof source !== 'string' || !source.trim()) throw new Error('原理图源码读回为空或非法')
				const parsed = parseSourceLog(source)
				if (parsed.docType !== 'SCH_PAGE' || parsed.uuid !== focus.uuid)
					throw new DrawWireIdentityError(`焦点 UUID 与源码不符（焦点=${focus.uuid}, 源码=${parsed.uuid}, 类型=${parsed.docType}）`)
				const records = resolveRecords(parsed)
				const sourceLines = new Map<string, Array<any>>()
				const sourceNets = new Map<string, Array<any>>()
				const sourceAttrs = new Map<string, Array<any>>()
				for (const record of records.values()) {
					const data: any = record.data && typeof record.data === 'object' ? record.data : {}
					if (record.header.type === 'LINE' && data.lineGroup != null) {
						const key = String(data.lineGroup)
						if (!sourceLines.has(key)) sourceLines.set(key, [])
						sourceLines.get(key)!.push({ id: String(record.header.id ?? ''), ...data })
					}
					if (record.header.type === 'ATTR' && data.parentId != null && ['NET', 'Name'].includes(String(data.key))) {
						const key = String(data.parentId)
						if (!sourceNets.has(key)) sourceNets.set(key, [])
						sourceNets.get(key)!.push({ parentId: key, key: data.key, value: data.value })
					}
					if (record.header.type === 'ATTR' && data.parentId != null) {
						const key = String(data.parentId)
						if (!sourceAttrs.has(key)) sourceAttrs.set(key, [])
						sourceAttrs.get(key)!.push({ id: String(record.header.id ?? ''), header: { ...record.header }, data: { ...data } })
					}
				}
				const rawWires = await awaitCaptureRead(() => eda.sch_PrimitiveWire.getAll(), '读取 SDK 原理图导线')
				const focusAfterModel: any = await awaitCaptureRead(() => eda.dmt_SelectControl.getCurrentDocumentInfo(), '模型后焦点核对')
				if (focusAfterModel?.documentType !== 1 || focusAfterModel?.uuid !== expectedUuid)
					throw new DrawWireIdentityError(`读取 SDK 原理图导线期间焦点已变化（预期 UUID=${expectedUuid}, 当前=${focusAfterModel?.uuid ?? '未知'}）`)
				if (!Array.isArray(rawWires)) throw new Error('SDK 导线读回不是数组')
				const wires = new Map<string, any>()
				for (const wire of rawWires) {
					const id = safeState<string>(wire, 'getState_PrimitiveId')
					if (!id) continue
					const colorRead = readState<any>(wire, 'getState_Color')
					const lineWidthRead = readState<any>(wire, 'getState_LineWidth')
					const lineTypeRead = readState<any>(wire, 'getState_LineType')
					wires.set(id, {
						id,
						rawLine: safeState<any>(wire, 'getState_Line'),
						color: colorRead.ok ? colorRead.value : undefined,
						lineWidth: lineWidthRead.ok ? lineWidthRead.value : undefined,
						lineType: lineTypeRead.ok ? lineTypeRead.value : undefined,
						styleRead: {
							color: colorRead,
							lineWidth: lineWidthRead,
							lineType: lineTypeRead,
						},
						net: safeState<any>(wire, 'getState_Net'),
					})
				}
				const effectiveWireRecords = [...records.values()].filter(record => record.header.type === 'WIRE' && record.header.id != null)
				const sourceWireIds = effectiveWireRecords.map(record => String(record.header.id)).sort()
				const sdkWireIds = [...wires.keys()].sort()
				const wireIdsSynchronized = sourceWireIds.length === sdkWireIds.length && sourceWireIds.every((id, index) => id === sdkWireIds[index])
				if (!wireIdsSynchronized) {
					if (allowWireIdLag)
						return { uuid: focus.uuid, wires, sourceWireIds, sdkWireIds, wireIdsSynchronized: false }
					throw new Error('有效源码 WIRE ID 与 SDK 导线 ID 不一致')
				}
				for (const record of records.values()) {
					if (record.header.type !== 'WIRE' || record.header.id == null) continue
					const id = String(record.header.id)
					const data: any = record.data && typeof record.data === 'object' ? record.data : {}
					const { line: _geometry, ...wireAttributes } = data
					const model = wires.get(id) ?? { id }
					const sourceLineRecords = sourceLines.get(id) ?? []
					if (!model.rawLine || !sourceLineRecords.length)
						throw new Error(`WIRE ${id} 缺少 SDK getter 几何或关联 LINE 源记录`)
					const sourceLineGeometry = sourceLineRecords.map((item: any) => {
						const nativeLine = normalizeLine([item.startX, item.startY, item.endX, item.endY])
						return nativeLine ? sourceLineToSdk(nativeLine) : undefined
					})
					if (sourceLineGeometry.some((line: any) => !line))
						throw new Error(`WIRE ${id} 的 LINE 源几何缺少有限坐标`)
					const sourcePaths = sourceLineGeometry as Array<Array<number>>
					const optionalWireLines = data.line == null ? [] : lineGeometryCandidates(data.line).map(paths => paths.map(sourceLineToSdk))
					if (data.line != null && !optionalWireLines.length)
						throw new Error(`WIRE ${id} 的可选 line 字段格式非法`)
					const getterCandidates = lineGeometryCandidates(model.rawLine, sourcePaths)
					const matchingGetter = getterCandidates.filter(candidate => geometryPathsPreserved(sourcePaths, candidate) && geometryPathsPreserved(candidate, sourcePaths))
					const geometryKey = (paths: Array<Array<number>>) => paths.flatMap(path => lineSegments(path).map(segmentKey)).sort().join('|')
					const uniqueGetterMatches = [...new Map(matchingGetter.map(candidate => [geometryKey(candidate), candidate])).values()]
					const matchingWireLine = optionalWireLines.filter(candidate => geometryPathsPreserved(sourcePaths, candidate) && geometryPathsPreserved(candidate, sourcePaths))
					if (!uniqueGetterMatches.length || (data.line != null && !matchingWireLine.length))
						throw new Error(`WIRE ${id} 的 LINE 源几何与 SDK getter 几何不一致`)
					// LINE records define canonical persisted geometry. SDK getter interpretations
					// are accepted when any complete candidate covers the same geometry both ways;
					// candidate segmentation may differ while representing the same covered path.
					const confirmedPaths = sourcePaths
					wires.set(id, {
						...model,
						line: undefined,
						rawLine: undefined,
						getterPaths: confirmedPaths,
						sourcePaths: confirmedPaths,
						sourceWireAttributes: wireAttributes,
						sourceLines: sourceLineRecords.map((item: any, index: number) => ({ ...item, sdkLine: sourceLineGeometry[index] })),
						sourceLineStyles: sourceLineRecords.map((item: any, index: number) => ({ geometry: sourceLineGeometry[index], style: styleKey(item) })),
						sourceNets: sourceNets.get(id) ?? [],
						sourceAttrs: sourceAttrs.get(id) ?? [],
					})
				}
				return { uuid: focus.uuid, wires, sourceWireIds, sdkWireIds, wireIdsSynchronized: true, records: [...records.values()].map(record => ({ header: { ...record.header }, data: record.data && typeof record.data === 'object' ? { ...record.data } : record.data })) }
			}
			let currentState = await capture(expectedUuid)
			const plain = (value: any): string => {
				if (Array.isArray(value)) return `[${value.map(plain).join(',')}]`
				if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${plain(value[key])}`).join(',')}}`
				return JSON.stringify(value) ?? String(value)
			}
			const primitiveIds: string[] = []
			const drawingOrderChanges: Array<{ id: string, before: number, after: number, wireId: string }> = []
			const created = new Set<string>()
			const reused = new Set<string>()
			const removed = new Set<string>()
			const coveredSegments: Array<string[]> = []
			let wireIdSyncEvidence: any
			let partial: any
			let createCalls = 0
			let didName = false
			let verifiedTargetNet = false
			let writeAttempted = false
			let lastVerifiedPhase = 'pre-write'
			let lastVerifiedSegment: number | undefined
			const throwPartial = (reason: string, stateName: 'partial' | 'unknown', segmentIndex?: number, affectedId?: string, syncEvidence?: any): never => {
				const result = {
					primitiveIds: [...primitiveIds],
					segments: createCalls,
					created: [...created].filter(id => currentState.wires.has(id)),
					reused: [...reused].filter(id => currentState.wires.has(id)),
					removed: [...removed].filter(id => !currentState.wires.has(id)),
					partial: { reason, state: stateName, ...(segmentIndex ? { stoppedAtSegment: segmentIndex } : {}), ...(affectedId ? { affectedId } : {}), ...(syncEvidence ? { wireIdSync: syncEvidence } : {}) },
					verification: { focusUuid: currentState.uuid, sourceAndModelReadback: !writeAttempted || ['post-write', 'final'].includes(lastVerifiedPhase), lastVerifiedPhase, ...(lastVerifiedSegment ? { lastVerifiedSegment } : {}), snapshot: 'last-verified' },
					named: didName,
					...(net ? { net } : {}),
				}
				throw new Error('schematic.drawWire 部分写入或结果未知', { cause: { partial: true, retryable: false, result } })
			}
			const capturePostWrite = async (segmentIndex: number, before: any, segment: Array<number>, segmentWasNamed: boolean, segmentIndexZero: number) => {
				const samplingDeadline = operationDeadline
				let attempts = 0
				let lastError: any
				while (performance.now() < samplingDeadline) {
					attempts++
					try {
						const snapshot = await capture(expectedUuid, true, samplingDeadline)
						if (!snapshot.wireIdsSynchronized) {
							wireIdSyncEvidence = { segmentIndex, attempts, sampledAt: new Date().toISOString(), sampledAtMonotonicMs: Math.round(performance.now()), sourceWireIds: [...snapshot.sourceWireIds], sdkWireIds: [...snapshot.sdkWireIds] }
							throw new Error('有效源码 WIRE ID 与 SDK 导线 ID 暂未同步')
						}
						const validation = validateAfter(before, snapshot, segmentIndexZero, segmentWasNamed, verifiedTargetNet)
						if (!validation.ok) throw Object.assign(new Error(validation.reason), { validation })
						wireIdSyncEvidence = undefined
						return { snapshot, validation }
					}
					catch (error) {
						if (isIdentityError(error)) throw error
						lastError = error
					}
					const remaining = samplingDeadline - performance.now()
					if (remaining <= 0) break
					await new Promise(resolve => setTimeout(resolve, Math.min(40, remaining)))
				}
				throw Object.assign(new Error(`写后完整后验在 drawWire 总预算内未收敛：${String(lastError?.message ?? lastError ?? '无有效采样')}`), { validation: lastError?.validation })
			}
			const comparableHeader = (header: any) => {
				const { ticket: _ticket, ...rest } = header ?? {}
				return rest
			}
			const recordKey = (record: any) => `${record?.header?.type ?? ''}\u0000${String(record?.header?.id ?? '')}`
			const checkSnapshotChanges = (before: any, after: any, requested: Array<number>[], segmentWasNamed: boolean, currentSegment: Array<number>, changes: Array<{ id: string, before: number, after: number, wireId: string }>) => {
				const oldRecords = new Map<string, any>((before.records ?? []).map((record: any) => [recordKey(record), record]))
				const newRecords = new Map<string, any>((after.records ?? []).map((record: any) => [recordKey(record), record]))
				const isWireRecord = (record: any) => ['WIRE', 'LINE'].includes(record.header.type)
					|| record.header.type === 'ATTR' && (before.wires.has(String(record.data?.parentId ?? '')) || after.wires.has(String(record.data?.parentId ?? '')))
				for (const [key, record] of oldRecords) {
					if (record.header.type === 'DOCHEAD' || isWireRecord(record)) continue
					const current = newRecords.get(key)
					if (!current || plain(comparableHeader(record.header)) !== plain(comparableHeader(current.header)) || plain(record.data) !== plain(current.data))
						throw new Error(`写后非导线有效记录丢失或变化：${key.replace('\u0000', ':')}`)
				}
				for (const [key, record] of newRecords) {
					if (record.header.type === 'DOCHEAD' || isWireRecord(record)) continue
					const old = oldRecords.get(key)
					if (!old || isWireRecord(old))
						throw new Error(`写后出现非请求新增或改归属的非导线有效记录：${key.replace('\u0000', ':')}`)
				}
				const oldLineIds = new Set<string>((before.records ?? []).filter((record: any) => record.header.type === 'LINE').map((record: any) => String(record.header.id)))
				const addedLines = (after.records ?? []).filter((record: any) => record.header.type === 'LINE' && !oldLineIds.has(String(record.header.id)))
				const knownUnlabeledTBranch = (): boolean => {
					if (segmentWasNamed || requested.length !== 1 || requested[0].length !== 4) return false
					if (plain([...before.wires.keys()].sort()) !== plain([...after.wires.keys()].sort())) return false
					const [x1, y1, x2, y2] = requested[0]
					if (x1 !== x2 || y1 === y2) return false
					const candidates = [...before.wires.entries()].filter(([wireId, wire]: [string, any]) => {
						if (wire.net !== '' || wire.color !== null || wire.lineWidth !== null || wire.lineType !== 0
							|| !wire.styleRead?.color?.ok || !wire.styleRead?.lineWidth?.ok || !wire.styleRead?.lineType?.ok) return false
						const lines = (before.records ?? []).filter((record: any) => record.header.type === 'LINE' && String(record.data?.lineGroup ?? '') === wireId)
						if (lines.length !== 1) return false
						const [a, ay, b, by] = sourceLineToSdk([lines[0].data.startX, lines[0].data.startY, lines[0].data.endX, lines[0].data.endY])
						return ay === by && y1 === ay && x1 > Math.min(a, b) && x1 < Math.max(a, b)
					})
					if (candidates.length !== 1) return false
					const [[wireId, oldWire]] = candidates as Array<[string, any]>
					const nextWire = after.wires.get(wireId)
					if (!nextWire || oldWire.net !== '' || nextWire.net !== ''
						|| oldWire.color !== null || oldWire.lineWidth !== null || oldWire.lineType !== 0
						|| nextWire.color !== null || nextWire.lineWidth !== null || nextWire.lineType !== 0
						|| !oldWire.styleRead?.color?.ok || !oldWire.styleRead?.lineWidth?.ok || !oldWire.styleRead?.lineType?.ok
						|| !nextWire.styleRead?.color?.ok || !nextWire.styleRead?.lineWidth?.ok || !nextWire.styleRead?.lineType?.ok
						|| plain(oldWire.sourceWireAttributes) !== plain(nextWire.sourceWireAttributes)) return false
					const oldLines = (before.records ?? []).filter((record: any) => record.header.type === 'LINE' && String(record.data?.lineGroup ?? '') === wireId)
					const nextLines = (after.records ?? []).filter((record: any) => record.header.type === 'LINE' && String(record.data?.lineGroup ?? '') === wireId)
					const addedTargetLines = addedLines.filter((record: any) => String(record.data?.lineGroup ?? '') === wireId)
					if (oldLines.length !== 1 || nextLines.length !== 3 || addedTargetLines.length !== 2) return false
					const oldLine = oldLines[0]
					const [ox1, oy1, ox2, oy2] = sourceLineToSdk([oldLine.data.startX, oldLine.data.startY, oldLine.data.endX, oldLine.data.endY])
				if (oy1 !== oy2 || x1 !== x2 || y1 === y2 || y1 !== oy1
					|| !(x1 > Math.min(ox1, ox2) && x1 < Math.max(ox1, ox2))) return false
				for (const record of before.records ?? []) {
					if (record.header.type !== 'LINE' || String(record.data?.lineGroup ?? '') === wireId) continue
					const otherLine = sourceLineToSdk([record.data.startX, record.data.startY, record.data.endX, record.data.endY])
					if (segmentsIntersectOrTouch([x1, y1, x2, y2], otherLine)) return false
				}
				const expectedGeometry = [[ox1, oy1, x1, y1], [x1, y1, ox2, oy2], [x1, y1, x2, y2]].map(segmentKey).sort()
				const actualGeometry = nextLines.map((record: any) => {
					const data = record.data ?? {}
					if (!['fillColor', 'fillStyle', 'strokeColor', 'strokeStyle', 'strokeWidth'].every(key => Object.hasOwn(data, key) && data[key] === null)) return undefined
					return segmentKey(sourceLineToSdk([data.startX, data.startY, data.endX, data.endY]))
				}).sort()
				const retainedLines = nextLines.filter((record: any) => String(record.header.id) === String(oldLine.header.id))
				if (retainedLines.length !== 1 || plain(comparableHeader(oldLine.header)) !== plain(comparableHeader(retainedLines[0].header))
					|| actualGeometry.some((geometry: any) => geometry === undefined) || plain(actualGeometry) !== plain(expectedGeometry)) return false
				const comparableLineHeader = (header: any) => { const { id: _id, ticket: _ticket, ...rest } = header ?? {}; return rest }
				if (nextLines.some((record: any) => plain(comparableLineHeader(oldLine.header)) !== plain(comparableLineHeader(record.header)))) return false
				const retainedData = retainedLines[0]?.data ?? {}
				const retainedGeometry = segmentKey(sourceLineToSdk([retainedData.startX, retainedData.startY, retainedData.endX, retainedData.endY]))
				if (![segmentKey([ox1, oy1, x1, y1]), segmentKey([x1, y1, ox2, oy2])].includes(retainedGeometry)) return false
				const omitCoordinates = (data: any) => {
					const copy = { ...data }
					for (const field of ['startX', 'startY', 'endX', 'endY']) delete copy[field]
					return copy
				}
				const originalLineData = omitCoordinates(oldLine.data)
				if (nextLines.some((record: any) => plain(Object.keys(record.data ?? {}).sort()) !== plain(Object.keys(oldLine.data ?? {}).sort()) || plain(omitCoordinates(record.data)) !== plain(originalLineData))) return false
				const oldRelevance = (before.records ?? []).filter((record: any) => record.header.type === 'ATTR' && record.data?.parentId === wireId && record.data?.key === 'Relevance')
				const nextRelevance = (after.records ?? []).filter((record: any) => record.header.type === 'ATTR' && record.data?.parentId === wireId && record.data?.key === 'Relevance')
				if (oldRelevance.length !== 1 || nextRelevance.length !== 1 || String(oldRelevance[0].header.id) !== String(nextRelevance[0].header.id)
					|| plain(comparableHeader(oldRelevance[0].header)) !== plain(comparableHeader(nextRelevance[0].header)) || oldRelevance[0].data?.value !== '[]'
					|| oldRelevance[0].data?.zIndex !== 3 || nextRelevance[0].data?.zIndex !== 7
					|| plain({ ...oldRelevance[0].data, zIndex: 7 }) !== plain(nextRelevance[0].data)) return false
				const oldNets = (before.records ?? []).filter((record: any) => record.header.type === 'ATTR' && record.data?.parentId === wireId && record.data?.key === 'NET')
				const nextNets = (after.records ?? []).filter((record: any) => record.header.type === 'ATTR' && record.data?.parentId === wireId && record.data?.key === 'NET')
				if (oldNets.length !== 1 || nextNets.length !== 1 || oldNets[0].data?.value !== '' || nextNets[0].data?.value !== ''
					|| String(oldNets[0].header.id) === String(nextNets[0].header.id) || newRecords.has(recordKey(oldNets[0]))
						|| (after.records ?? []).some((record: any) => String(record.header.id ?? '') === String(oldNets[0].header.id))
						|| (before.records ?? []).some((record: any) => String(record.header.id ?? '') === String(nextNets[0].header.id))
					|| !Number.isFinite(oldNets[0].data?.x) || oldNets[0].data?.x < Math.min(ox1, ox2) || oldNets[0].data?.x > Math.max(ox1, ox2)
					|| oldNets[0].data?.y !== -oy1 || oldNets[0].data?.rotation !== null || !Number.isFinite(oldNets[0].data?.zIndex)
						|| oldNets[0].data?.zIndex !== 4 || nextNets[0].data?.x !== x1 || nextNets[0].data?.y !== -((y1 + y2) / 2) || nextNets[0].data?.rotation !== 90 || nextNets[0].data?.zIndex !== 8
					|| plain({ ...oldNets[0].data, x: x1, y: -((y1 + y2) / 2), rotation: 90, zIndex: 8 }) !== plain(nextNets[0].data)) return false
				const comparableNetHeader = (header: any) => { const { id: _id, ticket: _ticket, ...rest } = header ?? {}; return rest }
				if (plain(comparableNetHeader(oldNets[0].header)) !== plain(comparableNetHeader(nextNets[0].header))) return false
				const allowed = new Set([recordKey(oldLine), recordKey(oldRelevance[0]), recordKey(oldNets[0])])
				for (const [key, oldRecord] of oldRecords) {
					if (oldRecord.header.type === 'DOCHEAD' || allowed.has(key)) continue
					const current = newRecords.get(key)
					if (!current || plain(comparableHeader(oldRecord.header)) !== plain(comparableHeader(current.header)) || plain(oldRecord.data) !== plain(current.data)) return false
				}
				for (const record of after.records ?? []) {
					const key = recordKey(record)
					if (record.header.type === 'DOCHEAD' || oldRecords.has(key)) continue
					if (record.header.type === 'LINE' && String(record.data?.lineGroup ?? '') === wireId) continue
					if (record.header.type === 'ATTR' && String(record.header.id) === String(nextNets[0].header.id) && record.data?.parentId === wireId && record.data?.key === 'NET') continue
					return false
				}
				changes.push({ id: String(oldRelevance[0].header.id), before: 3, after: 7, wireId })
				return true
				}
				// This narrow comparison applies only to a simple append that retains all
				// old WIRE IDs and every old LINE record verbatim. Merge/extension flows
				// keep their established geometry/style validation path.
				if ([...before.wires.keys()].some((id: string) => !after.wires.has(id))) return
				const oldLineRecords = (before.records ?? []).filter((record: any) => record.header.type === 'LINE')
				const oldLinesUnchanged = oldLineRecords.every((record: any) => {
					const current = newRecords.get(recordKey(record))
					return current && plain(comparableHeader(record.header)) === plain(comparableHeader(current.header)) && plain(record.data) === plain(current.data)
				})
				if (!oldLinesUnchanged) {
					if (knownUnlabeledTBranch()) return
					for (const record of oldRecords.values()) {
						if (record.header.type !== 'ATTR') continue
						const current = newRecords.get(recordKey(record))
						if (current && plain(record.data?.zIndex) !== plain(current.data?.zIndex))
							throw new Error(`ATTR ${record.header.id} 的 zIndex 变化没有对应的简单新增 LINE`)
					}
					return
				}
				const isSame = (left: any, right: any) => plain(comparableHeader(left.header)) === plain(comparableHeader(right.header)) && plain(left.data) === plain(right.data)
				const changedAttrs = new Map<string, Array<{ old: any, current: any }>>()
				for (const [key, oldRecord] of oldRecords) {
					if (oldRecord.header.type === 'DOCHEAD') continue
					const current = newRecords.get(key)
					if (!current)
						throw new Error(`写后有效记录丢失：${key.replace('\u0000', ':')}`)
					if (isSame(oldRecord, current)) continue
					if (oldRecord.header.type !== 'ATTR' || !oldRecord.data || !current.data || typeof oldRecord.data !== 'object' || typeof current.data !== 'object')
						throw new Error(`写后非目标有效记录发生变化：${key.replace('\u0000', ':')}`)
					const parentId = String(oldRecord.data.parentId ?? '')
					if (!parentId || parentId !== String(current.data.parentId ?? ''))
						throw new Error(`旧 ATTR ${oldRecord.header.id} 的 parentId 发生变化`)
					const oldData = { ...oldRecord.data }; delete oldData.zIndex
					const currentData = { ...current.data }; delete currentData.zIndex
					if (plain(comparableHeader(oldRecord.header)) !== plain(comparableHeader(current.header)) || plain(oldData) !== plain(currentData))
						throw new Error(`旧 ATTR ${oldRecord.header.id} 除 zIndex 外的字段发生变化`)
					if (!changedAttrs.has(parentId)) changedAttrs.set(parentId, [])
					changedAttrs.get(parentId)!.push({ old: oldRecord, current })
				}
				const requestedGeometry = requested
				for (const record of newRecords.values()) {
					const key = recordKey(record)
					if (oldRecords.has(key)) continue
					if (record.header.type === 'DOCHEAD') continue
					if (record.header.type === 'WIRE') {
						const wire = after.wires.get(String(record.header.id))
						if (!wire || !requestedGeometry.some(segment => wireContributes(wire, segment))) throw new Error(`新增 WIRE ${record.header.id} 不属于本次请求路径`)
						continue
					}
					if (record.header.type === 'LINE') {
						const lineId = String(record.header.id)
						const owner = String(record.data?.lineGroup ?? '')
						const wire = after.wires.get(owner)
						const line = wire?.sourceLines.find((item: any) => item.id === lineId)
						const expectedStrokeStyle = wire?.styleRead?.lineType?.ok
							? wire.lineType === null ? null : ({ 0: 'SOLID', 1: 'SHORT_DASH', 2: 'DOT' } as Record<number, string>)[wire.lineType]
							: undefined
						if (!wire || !line || !requestedGeometry.some(segment => geometryPreserved(line.sdkLine, [segment]))
							|| !wire.styleRead?.color?.ok || !wire.styleRead?.lineWidth?.ok || !wire.styleRead?.lineType?.ok
							|| line.strokeColor !== wire.color || line.strokeWidth !== wire.lineWidth || line.strokeStyle !== expectedStrokeStyle)
							throw new Error(`新增 LINE ${lineId} 的请求几何、归属或样式未与保留 WIRE 一致`)
						continue
					}
					if (record.header.type === 'ATTR') {
						const owner = String(record.data?.parentId ?? '')
						const wire = after.wires.get(owner)
						const isNewWire = !oldRecords.has(`WIRE\u0000${owner}`)
						const data = record.data
						const relevanceKeys = ['id', 'x', 'y', 'rotation', 'color', 'fontFamily', 'fontSize', 'fontWeight', 'italic', 'underline', 'align', 'value', 'keyVisible', 'valueVisible', 'key', 'fillColor', 'parentId', 'zIndex']
						const validIdentity = typeof record.header.id === 'string' && record.header.id.trim().length > 0
						const autoRelevance = isNewWire && data?.key === 'Relevance' && data?.value === '[]'
							&& wire && wireContributes(wire, currentSegment)
							&& ['key', 'value', 'parentId'].every(key => Object.hasOwn(data, key))
							&& Object.keys(data).every(key => relevanceKeys.includes(key))
							&& Object.keys(data).filter(key => !['id', 'key', 'parentId', 'value', 'zIndex'].includes(key)).every(key => data[key] === null)
							&& (data.id == null || data.id === record.header.id) && data.parentId === owner && (data.zIndex == null || Number.isSafeInteger(data.zIndex))
						const autoUnnamedNet = !segmentWasNamed && isNewWire && data?.key === 'NET' && data?.value === ''
							&& wire && wireContributes(wire, currentSegment)
							&& ['key', 'value', 'parentId'].every(key => Object.hasOwn(data, key))
							&& Object.keys(data).every(key => relevanceKeys.includes(key))
							&& (data.x == null || Number.isFinite(data.x)) && (data.y == null || Number.isFinite(data.y))
							&& ['keyVisible', 'valueVisible'].every(key => data[key] == null || typeof data[key] === 'boolean')
							&& Object.keys(data).filter(key => !['id', 'x', 'y', 'keyVisible', 'valueVisible', 'key', 'parentId', 'value', 'zIndex'].includes(key)).every(key => data[key] == null)
							&& (data.id == null || data.id === record.header.id) && data.parentId === owner && (data.zIndex == null || Number.isSafeInteger(data.zIndex))
						const requestedNetAttr = segmentWasNamed && net && ['NET', 'Name'].includes(String(data?.key)) && data?.value === net && wire?.net === net
						if (!wire || !validIdentity || !requestedGeometry.some(segment => wireContributes(wire, segment)) || !(autoRelevance || autoUnnamedNet && wire.net === '' || requestedNetAttr))
							throw new Error(`新增 ATTR ${record.header.id} 不是本次新 WIRE 的有效网络或 Relevance 属性`)
						continue
					}
					throw new Error(`写后出现非请求新增有效记录：${key.replace('\u0000', ':')}`)
				}
				for (const [wireId, entries] of changedAttrs) {
					if (!before.wires.has(wireId) || !after.wires.has(wireId) || !requestedGeometry.some(segment => wireContributes(after.wires.get(wireId), segment)))
						throw new Error(`旧 ATTR 所属 WIRE ${wireId} 不是本次保留并承接请求路径的同一导线`)
					const oldGroup = (before.records ?? []).filter((record: any) => record.header.type === 'ATTR' && String(record.data?.parentId ?? '') === wireId)
					const afterGroup = (after.records ?? []).filter((record: any) => record.header.type === 'ATTR' && String(record.data?.parentId ?? '') === wireId)
					const oldAttrIds = oldGroup.map((record: any) => String(record.header.id)).sort()
					const afterAttrIds = afterGroup.map((record: any) => String(record.header.id)).sort()
					if (oldGroup.length !== afterGroup.length || oldGroup.length !== entries.length || oldAttrIds.some((id: string, index: number) => id !== afterAttrIds[index]))
						throw new Error(`WIRE ${wireId} 的 ATTR 身份集合发生增删`)
					const groupEntries = oldGroup.map((old: any) => ({ old, current: newRecords.get(recordKey(old)) }))
					if (groupEntries.some((entry: any) => !entry.current || !entries.some(pair => pair.old === entry.old)))
						throw new Error(`WIRE ${wireId} 的 ATTR 身份发生变化`)
					const byZIndexThenId = (a: any, b: any) => Number(a.data?.zIndex) - Number(b.data?.zIndex) || String(a.header.id).localeCompare(String(b.header.id))
					const oldZOrder = [...oldGroup].sort(byZIndexThenId).map((record: any) => String(record.header.id))
					const afterZOrder = [...afterGroup].sort(byZIndexThenId).map((record: any) => String(record.header.id))
					if (oldZOrder.some((id: string, index: number) => id !== afterZOrder[index])) throw new Error(`WIRE ${wireId} 的 ATTR 相对 zIndex 顺序发生变化`)
					const offsets: number[] = groupEntries.map(({ old, current }: any) => Number(current.data.zIndex) - Number(old.data.zIndex))
					const unchanged = offsets.every(offset => offset === 0)
					const addedLineCountForWire = addedLines.filter((record: any) => String(record.data?.lineGroup ?? '') === wireId).length
					const appended = addedLineCountForWire > 0 && offsets.every(offset => Number.isSafeInteger(oldGroup[0]?.data?.zIndex) && Number.isSafeInteger(offset) && offset === addedLineCountForWire)
					if (!unchanged && !appended)
						throw new Error(`WIRE ${wireId} 的 ATTR zIndex 未保持原值或统一增加新增 LINE 数量`)
					if (appended) {
						for (const { old, current } of groupEntries as any) {
							if (!Number.isSafeInteger(old.data.zIndex) || !Number.isSafeInteger(current.data.zIndex)) throw new Error(`WIRE ${wireId} 的 ATTR zIndex 不是有限整数`)
							const existing = changes.find(change => change.id === String(old.header.id) && change.wireId === wireId)
							if (existing) existing.after = current.data.zIndex
							else changes.push({ id: String(old.header.id), before: old.data.zIndex, after: current.data.zIndex, wireId })
						}
					}
				}
			}
			const validateAfter = (before: any, after: any, i: number, segmentWasNamed: boolean, previousTargetNetVerified: boolean) => {
				const [x1, y1, x2, y2] = segments[i]
				let partial: any
				let verifiedTargetNet = previousTargetNetVerified
				const sampleDrawingOrderChanges: Array<{ id: string, before: number, after: number, wireId: string }> = []
				if (segmentWasNamed && net) {
					const targetWire = [...after.wires.values()].find((wire: any) => wireContributes(wire, [x1, y1, x2, y2])
						&& wire.net === net && wire.sourceNets.some((attr: any) => attr.parentId === wire.id && ['NET', 'Name'].includes(String(attr.key)) && attr.value === net))
					if (!targetWire)
						partial = { stoppedAtSegment: i + 1, reason: `第 ${i + 1} 段命名目标「${net}」未在存活贡献线的源 NET value/parentId 与 getter.net 中一致读回`, state: 'partial' }
					else
						verifiedTargetNet = true
				}
				if (after.uuid !== before.uuid) {
					throw new DrawWireIdentityError(`写入期间焦点 UUID 改变（${before.uuid}→${after.uuid}），create 结果可能已写`)
				}
				const beforeIds = new Set<string>(before.wires.keys())
				const afterIds = new Set<string>(after.wires.keys())
				const covering = [...after.wires.values()].filter((wire: any) => wireContributes(wire, [x1, y1, x2, y2])).map((wire: any) => wire.id)
				const beforeLines = [...before.wires.values()].flatMap((wire: any) => wire.sourceLines)
				const afterLines = [...after.wires.values()].flatMap((wire: any) => wire.sourceLines)
				const oldGeometry = [...before.wires.values()].flatMap((wire: any) => wire.sourcePaths)
				const requestedGeometry = segments.slice(0, i + 1).map((segment: any) => [...segment])
				for (const [id, oldWire] of before.wires) {
					const afterSourcePaths = [...after.wires.values()].flatMap((wire: any) => wire.sourcePaths)
					if (!geometryPathsPreserved(oldWire.sourcePaths, afterSourcePaths)) {
						partial = { stoppedAtSegment: i + 1, reason: `旧导线 ${id} 的原几何范围未完整保留`, state: 'partial', affectedId: id }
						break
					}
					for (const oldLine of oldWire.sourceLines) {
						const targetLine = oldLine.sdkLine
						const exactDiagonal = targetLine[1] !== targetLine[3] && targetLine[0] !== targetLine[2]
						const replacements = afterLines.filter((line: any) => exactDiagonal
							? segmentKey(targetLine) === segmentKey(line.sdkLine)
							: segmentOverlaps(targetLine, line.sdkLine))
						if (!replacements.length || (exactDiagonal ? !replacements.some((line: any) => segmentKey(targetLine) === segmentKey(line.sdkLine)) : !segmentCovered(targetLine, replacements.map((line: any) => line.sdkLine))) || replacements.some((line: any) => styleKey(line) !== styleKey(oldLine))) {
							partial = { stoppedAtSegment: i + 1, reason: `旧导线 ${id} 的 LINE 样式/几何未承接`, state: 'partial', affectedId: id }
							break
						}
					}
					if (partial) break
					const oldNetKey = plain(oldWire.sourceNets.map((attr: any) => ({ key: attr.key, value: attr.value })).sort((a: any, b: any) => `${a.key}:${a.value}`.localeCompare(`${b.key}:${b.value}`)))
					const oldSegments: Array<Array<number>> = (oldWire.sourcePaths as Array<Array<number>>).flatMap((path: Array<number>) => lineSegments(path))
					const carriersBySegment: Array<Array<any>> = oldSegments.map((segment: Array<number>) => [...after.wires.values()].filter((wire: any) => wire.sourcePaths.flatMap((path: Array<number>) => lineSegments(path)).some((line: Array<number>) => segmentOverlapsOrMatches(segment, line))))
					const carriers = [...new Map(carriersBySegment.flat().map((wire: any) => [wire.id, wire])).values()]
					if (!carriers.length || carriersBySegment.some((items, index) => !items.length || !geometryPathsPreserved([oldSegments[index]], items.flatMap((wire: any) => wire.sourcePaths))) || carriers.some((wire: any) => plain(wire.sourceWireAttributes) !== plain(oldWire.sourceWireAttributes))) {
						partial = { stoppedAtSegment: i + 1, reason: `旧导线 ${id} 的 WIRE 属性或旧几何承接发生变化`, state: 'partial', affectedId: id }
						break
					}
					const oldHasNoConflictingName = !!net && oldWire.sourceNets.every((attr: any) => attr.value === '' || attr.value === net)
					const touchesRequest = oldHasNoConflictingName && verifiedTargetNet
						&& oldSegments.some((oldSegment: Array<number>) => requestedGeometry.some((requested: Array<number>) => segmentsTouch(oldSegment, requested)))
					const carrierHasExpectedNets = (wire: any) => {
						const actual = wire.sourceNets.map((attr: any) => ({ key: attr.key, value: attr.value })).sort((a: any, b: any) => `${a.key}:${a.value}`.localeCompare(`${b.key}:${b.value}`))
						return plain(actual) === oldNetKey || (touchesRequest && actual.some((attr: any) => ['NET', 'Name'].includes(String(attr.key)) && attr.value === net) && actual.every((attr: any) => attr.value === '' || attr.value === net) && wire.net === net)
					}
					if (carriersBySegment.some(items => items.some((wire: any) => !carrierHasExpectedNets(wire) || wire.sourceNets.some((attr: any) => attr.parentId !== wire.id || typeof attr.value !== 'string')))) {
						partial = { stoppedAtSegment: i + 1, reason: `旧导线 ${id} 的 NET 属性未按真实 value/parentId 承接`, state: 'partial', affectedId: id }
						break
					}
					if (carriers.some((wire: any) => wire.color !== oldWire.color || wire.lineWidth !== oldWire.lineWidth || wire.lineType !== oldWire.lineType)) {
						partial = { stoppedAtSegment: i + 1, reason: `旧导线 ${id} 的 getter 样式发生变化`, state: 'partial', affectedId: id }
						break
					}
				}
				if (!partial && afterLines.some((line: any) => !geometryPreserved(line.sdkLine, [...oldGeometry, ...requestedGeometry])))
					partial = { stoppedAtSegment: i + 1, reason: '写入改变了请求路径以外的有效导线几何', state: 'partial' }
				if (!partial && (wireColor != null || wireWidth != null || wireType != null)) {
					const requested = [x1, y1, x2, y2]
					const expectedStyle = { color: wireColor, width: wireWidth, type: wireType == null ? undefined : ['SOLID', 'SHORT_DASH', 'DOT'][wireType] }
					const affected = [...after.wires.values()].filter((wire: any) => wireContributes(wire, requested))
					const expectedStyleMatches = (wire: any, line: any) =>
						(wireColor == null || (line.strokeColor === wireColor && wire.color === wireColor))
						&& (wireWidth == null || (line.strokeWidth === wireWidth && wire.lineWidth === wireWidth))
						&& (wireType == null || (line.strokeStyle === expectedStyle.type && wire.lineType === wireType))
					if (!affected.length || affected.some((wire: any) => wire.sourceLines.filter((line: any) => segmentOverlaps(requested, line.sdkLine)).some((line: any) => !expectedStyleMatches(wire, line))
						|| !wire.sourceLines.some((line: any) => segmentOverlaps(requested, line.sdkLine))))
						partial = { stoppedAtSegment: i + 1, reason: `第 ${i + 1} 段显式样式未在源 LINE 与 getter 中一致读回`, state: 'partial' }
				}
				if (!partial) {
					try { checkSnapshotChanges(before, after, requestedGeometry, segmentWasNamed, [x1, y1, x2, y2], sampleDrawingOrderChanges) }
					catch (error) { partial = { stoppedAtSegment: i + 1, reason: String((error as any)?.message ?? error), state: 'partial' } }
				}
				if (!partial && !segmentCovered([x1, y1, x2, y2], [...after.wires.values()].flatMap((wire: any) => wire.sourcePaths)))
					partial = { stoppedAtSegment: i + 1, reason: `第 ${i + 1} 段未被连续有效几何覆盖`, state: 'unknown' }
				if (!covering.length) partial ??= { stoppedAtSegment: i + 1, reason: '写后读回未找到覆盖本段的存活导线', state: 'unknown' }
				if (partial) return { ok: false, reason: partial.reason, affectedId: partial.affectedId, state: partial.state }
				return { ok: true, covering, created: [...afterIds].filter((id: string) => !beforeIds.has(id)), removed: [...beforeIds].filter((id: string) => !afterIds.has(id)), reused: covering.filter((id: string) => beforeIds.has(id)), verifiedTargetNet, drawingOrderChanges: sampleDrawingOrderChanges }
			}
			for (let i = 0; i < segments.length; i++) {
				const [x1, y1, x2, y2] = segments[i]
				const segmentWasNamed = Boolean(nameNext && net)
				let before: any
				try { before = await capture(expectedUuid) }
				catch (error) {
					if (writeAttempted) throwPartial(`写前读回失败：${String((error as any)?.message ?? error)}`, 'unknown', i + 1)
					throw error
				}
				currentState = before
				lastVerifiedPhase = i === 0 ? 'pre-write' : 'post-write'
				lastVerifiedSegment = i || lastVerifiedSegment
				let returned: any
				let createError: any
				let createAttempted = false
				try {
					returned = await awaitWithinOperationDeadline(
						() => {
							if (performance.now() >= operationDeadline) throw new Error(`第 ${i + 1} 段 create 前 drawWire 总时间预算已到期`)
							createAttempted = true
							createCalls++
							writeAttempted = true
							if (nameNext) didName = true
							return eda.sch_PrimitiveWire.create([x1, y1, x2, y2], nameNext ? net : undefined, wireColor as any, wireWidth as any, wireType as any)
						},
						`第 ${i + 1} 段 create`,
					)
				}
				catch (error) { createError = error }
				if (!createAttempted) {
					if (writeAttempted) throwPartial(`第 ${i + 1} 段 create 前预算到期；之前已有写入，停止后续动作：${String(createError?.message ?? createError)}`, 'unknown', i + 1)
					throw createError
				}
				if (createError || !returned)
					throwPartial(createError ? `第 ${i + 1} 段 create 抛错，结果未知；停止后续采样与写入：${String(createError?.message ?? createError)}` : `第 ${i + 1} 段 create 返回空值，结果未知；停止后续采样与写入`, 'unknown', i + 1)
				let after: any
				let sampled: any
				try { sampled = await capturePostWrite(i + 1, before, [x1, y1, x2, y2], segmentWasNamed, i); after = sampled.snapshot }
				catch (error) { const failure = (error as any)?.validation; throwPartial(`写后完整只读后验失败：${String((error as any)?.message ?? error)}`, failure?.state ?? 'unknown', i + 1, failure?.affectedId, wireIdSyncEvidence) }
				const delta = sampled.validation
				if (delta.verifiedTargetNet) verifiedTargetNet = true
				for (const id of delta.created) created.add(id)
				for (const id of delta.removed) removed.add(id)
				for (const id of delta.reused) reused.add(id)
				coveredSegments[i] = delta.covering
				primitiveIds.splice(0, primitiveIds.length, ...new Set(coveredSegments.flat().filter((id: string) => after.wires.has(id))))
				for (const change of delta.drawingOrderChanges) {
					const existing = drawingOrderChanges.find(item => item.id === change.id && item.wireId === change.wireId)
					if (existing) existing.after = change.after
					else drawingOrderChanges.push(change)
				}
				currentState = after
				lastVerifiedPhase = 'post-write'
				lastVerifiedSegment = i + 1
				nameNext = false // 命名只用于第一段，其余段无名
			}
			// 最终核对固定初始焦点，并要求全部请求段仍有连续有效几何覆盖。
			let finalState: any
			try { finalState = await capture(expectedUuid) }
			catch (error) { throwPartial(`最终焦点/source/getter 复核失败：${String((error as any)?.message ?? error)}`, 'unknown') }
			const finalDelta = validateAfter(currentState, finalState, segments.length - 1, false, verifiedTargetNet)
			if (!finalDelta.ok)
				throwPartial(`最终完整后验失败：${finalDelta.reason}`, finalDelta.state ?? 'unknown', segments.length, finalDelta.affectedId)
			if (!segments.every(segment => segmentCovered(segment, [...finalState.wires.values()].flatMap((wire: any) => wire.sourcePaths))))
				throwPartial('最终读回发现请求路径未被存活导线连续覆盖', 'partial')
			const finalIds = [...finalState.wires.values()].filter((wire: any) => segments.some(segment => wireContributes(wire, segment))).map((wire: any) => wire.id)
			// 读回验证不依赖 create 返回对象 ID，按最终存活线的 NET 属性核实命名结果。
			let readback: { namedWireId?: string, net?: string, verified: boolean } | undefined
			if (didName && net && finalState) {
				const named = [...finalState.wires.values()].find((wire: any) => finalIds.includes(wire.id) && wire.net === net && wire.sourceNets?.some((attr: any) => attr.parentId === wire.id && (attr.key === 'NET' || attr.key === 'Name') && attr.value === net))
				readback = { namedWireId: named?.id, net: named?.sourceNets?.find((attr: any) => attr.parentId === named.id && attr.value === net)?.value ?? null as any, verified: !!named }
			}
			if (didName && net && readback?.verified) {
				const namedWire = finalState.wires.get(readback.namedWireId!)
				if (namedWire?.net !== net)
					readback.verified = false
			}
			if (didName && net && !readback?.verified)
				throwPartial(`命名目标「${net}」未在最终有效 NET value/parentId 中读回`, 'partial')
			if (partial) throwPartial(partial.reason, partial.state, partial.stoppedAtSegment, partial.affectedId)
			for (const id of finalDelta.created) created.add(id)
			for (const id of finalDelta.removed) removed.add(id)
			for (const change of finalDelta.drawingOrderChanges) {
				const existing = drawingOrderChanges.find(item => item.id === change.id && item.wireId === change.wireId)
				if (existing) existing.after = change.after
				else drawingOrderChanges.push(change)
			}
			currentState = finalState
			lastVerifiedPhase = 'final'
			primitiveIds.splice(0, primitiveIds.length, ...finalIds)
			const createdFinal = [...created].filter(id => finalState.wires.has(id))
			const removedFinal = [...removed].filter(id => !finalState.wires.has(id))
			const reusedFinal = [...reused].filter(id => finalState.wires.has(id))
			return {
				primitiveIds: finalIds,
				segments: createCalls,
				created: createdFinal,
				reused: reusedFinal,
				removed: removedFinal,
				...(partial ? { partial } : {}),
				...(finalState ? { verification: { focusUuid: finalState.uuid, sourceAndModelReadback: true, coverageSegments: coveredSegments.length } } : {}),
				named: didName,
				...(net ? { net } : {}),
				...(drawingOrderChanges.length ? { drawingOrderChanges } : {}),
				...(readback ? { readback, ...(readback.verified ? {} : { note: `命名段读回网名「${readback.net ?? '(读取失败)'}」与目标「${net}」不符——导线已画出但可能没带上名，请用 schematic.listWires 复核后用 setWireNet 补名` }) } : {}),
				// 0.10.26（0.10.24 终验实锤）：官方对命名导线会在导线中点自动落一个 NET 属性标签——
				// 它与 placeNetLabel 的标签是两套，同网并存即重复（DRC "多个网络名"类警告），且属性标签删不掉
				...(didName && readback?.verified ? { namingNote: `命名导线已自动在导线中点落一个网络标签（NET 属性）。⚠️ 该标签是导线持有的属性，官方不支持单独删除（只能删整根导线重画）；请不要再对该网络 placeNetLabel 补标签，否则标签重复。需要标签收尾的场景建议：drawWire 不传 net（画无名线）+ placeNetLabel 放标签` } : {}),
				...(skippedDiagonal ? { skippedDiagonal } : {}),
			}
		},
	},
	{
		name: 'schematic.setWireNet',
		summary: '修改导线网络名；也用于清理"导线有多个同名网络名"的 DRC 警告（命名短桩与母排合并后同名冗余）。0.10.23 起：modify 后强制读回验证（官方返回值不可信，0.10.22 曾假成功——回显目标网名但保存后实际为空），读回不符判失败并如实返回实际网名',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '导线图元 ID' },
			{ name: 'net', type: 'string', required: true, description: '目标网络名' },
		],
		returns: '{ primitiveId, net, readback: { net, verified } }（verified=false 时报错并带实际网名）',
		example: { cmd: 'schematic.setWireNet', params: { primitiveId: 'xxx', net: 'VIN' } },
		handler: async (params) => {
			if (!params.primitiveId || !params.net)
				throw new Error('缺少参数 primitiveId / net')
			const wireId = String(params.primitiveId)
			const targetNet = String(params.net)
			const result = await setWireNetPreservingState(wireId, targetNet)
			return result
		},
	},
	{
		name: 'schematic.modifyWire',
		summary: '修改导线颜色/线宽/线型/网络名（0.9.8 起；按网名批量改色也可以——传 net 过滤 + color 即可，如把 3V3 全部导线标红）',
		params: [
			{ name: 'primitiveId', type: 'string', description: '导线图元 ID（单根修改；与 net 过滤二选一）' },
			{ name: 'net', type: 'string', description: '按当前网络名过滤批量修改（与 primitiveId 二选一）' },
			{ name: 'color', type: 'string', description: '导线颜色，如 #FF0000' },
			{ name: 'lineWidth', type: 'number', description: '线宽' },
			{ name: 'lineType', type: 'string', description: '线型 solid | dashed | dotted' },
			{ name: 'newNet', type: 'string', description: '改网络名（单根修改时可用）' },
		],
		returns: '{ modified: [成功 ID], failed: [失败 ID] }',
		example: { cmd: 'schematic.modifyWire', params: { net: '3V3', color: '#FF0000' } },
		handler: async (params) => {
			const property: Record<string, unknown> = {}
			if (params.color != null)
				property.color = String(params.color)
			if (params.lineWidth != null)
				property.lineWidth = Number(params.lineWidth)
			if (params.lineType != null) {
				if (typeof params.lineType !== 'string')
					throw new Error('lineType 必须是字符串：solid、dashed 或 dotted')
				const m: Record<string, number> = { solid: 0, dashed: 1, dotted: 2 }
				const requestedLineType = params.lineType
				if (!Object.hasOwn(m, requestedLineType))
					throw new Error('lineType 仅支持 solid、dashed 或 dotted')
				property.lineType = m[requestedLineType]
			}
			if (params.newNet != null)
				property.net = String(params.newNet)
			if (!Object.keys(property).length)
				throw new Error('至少提供一个要修改的属性（color / lineWidth / lineType / newNet）')
			const wires = await eda.sch_PrimitiveWire.getAll()
			if (!Array.isArray(wires))
				throw new Error('读取原理图导线失败：getAll 未返回数组，未执行修改')
			let targets: Array<{ id: string, wire: any }> = []
			if (params.primitiveId) {
				const id = String(params.primitiveId)
				const wire = wires.find(w => safeState<string>(w, 'getState_PrimitiveId') === id)
				if (!wire)
					throw new Error(`原理图导线 ${id} 不存在，未执行修改`)
				targets = [{ id, wire }]
			}
			else if (params.net) {
				targets = wires
					.filter(w => safeState<string>(w, 'getState_Net') === String(params.net))
					.map(w => ({ id: safeState<string>(w, 'getState_PrimitiveId'), wire: w }))
					.filter((entry): entry is { id: string, wire: any } => typeof entry.id === 'string' && !!entry.id)
				if (!targets.length)
					throw new Error(`没有找到网络 ${params.net} 的导线`)
			}
			else {
				throw new Error('缺少参数 primitiveId 或 net（二选一）')
			}
			const changesStyle = Object.keys(property).some(k => k === 'color' || k === 'lineWidth' || k === 'lineType')
			const startingDoc = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (!startingDoc?.uuid || startingDoc.documentType !== 1)
				throw new Error('焦点文档不是有效的原理图页，整批未执行修改')
			const sourceBefore = await eda.sys_FileManager.getDocumentSource()
			if (typeof sourceBefore !== 'string' || !sourceBefore.trim())
				throw new Error('无法读取当前原理图源码，整批未执行修改')
			const parsedBefore = parseSourceLog(sourceBefore)
			if (parsedBefore.uuid !== startingDoc.uuid)
				throw new Error('焦点原理图页与源码 UUID 不一致，整批未执行修改')
			const sourceWires = resolveRecords(parsedBefore, 'WIRE')
			const sourceAttrs = resolveRecords(parsedBefore, 'ATTR')
			const sourceLines = resolveRecords(parsedBefore, 'LINE')
			const sourceLineTypeByGetter: Record<number, string> = { 0: 'SOLID', 1: 'SHORT_DASH', 2: 'DOT' }
			const originals = new Map<string, { state: Record<string, unknown>, net: string, attrMode: 'none' | 'empty' | 'named', netAttrId?: string, netAttrData?: Record<string, unknown>, getterAttrs: Array<{ id: string, key: string, value: unknown }>, lines: Array<{ id: string, lineGroup: unknown, startX: unknown, startY: unknown, endX: unknown, endY: unknown, strokeColor: unknown, strokeWidth: unknown, strokeStyle: unknown }>, lineTypeEncodingVerified: boolean }>()
			for (const { id, wire } of targets) {
				if (!sourceWires.has(`WIRE\u0000${id}`))
					throw new Error(`导线 ${id} 在当前源码中不存在，整批未执行修改`)
				const net = readState<unknown>(wire, 'getState_Net')
				const color = readState<unknown>(wire, 'getState_Color')
				const lineWidth = readState<unknown>(wire, 'getState_LineWidth')
				const lineType = readState<unknown>(wire, 'getState_LineType')
				const line = readState<unknown>(wire, 'getState_Line')
				const state = { color: color.ok ? color.value : undefined, lineWidth: lineWidth.ok ? lineWidth.value : undefined, lineType: lineType.ok ? lineType.value : undefined, line: line.ok ? line.value : undefined }
				if (!net.ok || typeof net.value !== 'string' || !color.ok || !lineWidth.ok || !lineType.ok || !line.ok || state.line === undefined)
					throw new Error(`导线 ${id} 的网络、样式或几何读回不可信，整批未执行修改`)
				const directLines = Array.from(sourceLines.values()).filter(record => (record.data as Record<string, unknown>)?.lineGroup === id)
				if (!directLines.length)
					throw new Error(`导线 ${id} 在源码中没有对应 LINE 段，整批未执行修改`)
				const lineStates = directLines.map(record => {
					const data = record.data as Record<string, unknown>
					for (const endpoint of ['startX', 'startY', 'endX', 'endY'] as const) {
						if (!Object.hasOwn(data, endpoint) || typeof data[endpoint] !== 'number' || !Number.isFinite(data[endpoint]))
							throw new Error(`导线 ${id} 的 LINE 源码端点 ${endpoint} 缺失或非有限数值，整批未执行修改`)
					}
					if (!Object.hasOwn(data, 'strokeColor') || !Object.hasOwn(data, 'strokeWidth') || !Object.hasOwn(data, 'strokeStyle'))
						throw new Error(`导线 ${id} 的 LINE 源码缺少 strokeColor/strokeWidth/strokeStyle 字段，整批未执行修改`)
					if (data.strokeColor !== state.color || data.strokeWidth !== state.lineWidth)
						throw new Error(`导线 ${id} 的 LINE 源码颜色或线宽与对象 getter 不一致，整批未执行修改`)
					return { id: String(record.header.id), lineGroup: data.lineGroup, startX: data.startX, startY: data.startY, endX: data.endX, endY: data.endY, strokeColor: data.strokeColor, strokeWidth: data.strokeWidth, strokeStyle: data.strokeStyle }
				})
				const lineTypeEncodingVerified = state.lineType === null
					? lineStates.every(line => line.strokeStyle === null)
					: typeof state.lineType === 'number'
						&& Object.hasOwn(sourceLineTypeByGetter, state.lineType)
						&& lineStates.every(line => line.strokeStyle === sourceLineTypeByGetter[state.lineType as number])
				if (property.lineType != null && !lineTypeEncodingVerified)
					throw new Error(`导线 ${id} 的源 LINE.strokeStyle 与对象 lineType 尚无已核实的数值映射，整批未执行修改`)
				let attrs: any[]
				try {
					const result = await eda.sch_PrimitiveAttribute.getAll(id)
					if (!Array.isArray(result))
						throw new Error('属性接口未返回数组')
					attrs = result
				}
				catch (error) {
					throw new Error(`导线 ${id} 的 NET/Name 属性读取失败，整批未执行修改：${error instanceof Error ? error.message : String(error)}`)
				}
				const live: Array<{ id: string, key: string, value: unknown }> = []
				for (const attr of attrs) {
					const key = attr?.getState_Key?.()
					if (typeof key !== 'string')
						throw new Error(`导线 ${id} 的属性键读回不可信，整批未执行修改`)
					if (!/^(NET|Name)$/i.test(key))
						continue
					const attrId = attr?.getState_PrimitiveId?.()
					const value = attr?.getState_Value?.()
					if (typeof attrId !== 'string' || !attrId || typeof value !== 'string')
						throw new Error(`导线 ${id} 的 NET/Name 属性值或 ID 读回不可信，整批未执行修改`)
					live.push({ id: attrId, key, value })
				}
				const direct = Array.from(sourceAttrs.values()).filter(record => {
					const data = record.data as Record<string, unknown>
					return data?.parentId === id && typeof data.key === 'string' && /^(NET|Name)$/i.test(data.key)
				})
				if (live.length !== direct.length)
					throw new Error(`导线 ${id} 的 NET/Name 属性数量与源码不一致，整批未执行修改`)
				const sourceKeyByLiveId = new Map<string, string>()
				for (const attr of live) {
					const record = direct.find(item => String(item.header.id) === attr.id)
					const data = record?.data as Record<string, unknown> | undefined
					const getterAlias = /^Name$/i.test(attr.key) && typeof data?.key === 'string' && /^NET$/i.test(data.key)
					if (!data || data.parentId !== id || (!getterAlias && data.key !== attr.key) || data.value !== attr.value)
						throw new Error(`导线 ${id} 的 NET/Name 属性与源码不一致，整批未执行修改`)
					sourceKeyByLiveId.set(attr.id, String(data.key))
				}
				const nets = live.filter(attr => /^NET$/i.test(sourceKeyByLiveId.get(attr.id) ?? ''))
				const names = live.filter(attr => /^Name$/i.test(sourceKeyByLiveId.get(attr.id) ?? ''))
				if (names.length || nets.length > 1)
					throw new Error(`导线 ${id} 存在 Name-only 或重复 NET/Name 属性，整批未执行修改`)
				if (nets.length === 1 && nets[0].value !== net.value)
					throw new Error(`导线 ${id} 的显式 NET 属性与网络 getter 不一致，整批未执行修改`)
				if (nets.length === 0 && net.value !== '')
					throw new Error(`导线 ${id} 有效网络名缺少显式 NET 属性，整批未执行修改`)
				const sourceNetRecord = nets.length ? direct.find(record => String(record.header.id) === nets[0].id) : undefined
				originals.set(id, { state, net: net.value as string, attrMode: nets.length ? (net.value === '' ? 'empty' : 'named') : 'none', ...(nets.length ? { netAttrId: nets[0].id, netAttrData: { ...(sourceNetRecord?.data as Record<string, unknown>) } } : {}), getterAttrs: live.map(attr => ({ ...attr })), lines: lineStates, lineTypeEncodingVerified })
			}
			const focusedAgain = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (focusedAgain?.uuid !== startingDoc.uuid || focusedAgain?.documentType !== 1)
				throw new Error('整批预检期间焦点原理图页发生变化，整批未执行修改')
			const snapshot = await captureDocumentSnapshot('schematic.modifyWire', 1)
			const preflightSourceMatch = compareDocumentSources(sourceBefore, snapshot.source)
			if (snapshot.documentUuid !== startingDoc.uuid || !preflightSourceMatch.equal)
				throw new Error('整批预检后原理图源码发生变化，整批未执行修改')
			const modified: Array<string> = []
			const failedIds: Array<string> = []
			const requestStyle: Record<string, unknown> = {}
			for (const k of ['color', 'lineWidth', 'lineType']) {
				if (property[k] != null)
					requestStyle[k] = property[k]
			}
			const readback: Array<{ id: string, fields: Record<string, { actual: unknown, expected: unknown, verified: boolean | null }>, sdkSucceeded: boolean, verified: boolean }> = []
			try {
			await withDocumentRecovery(snapshot, async (write) => {
				const getters: Record<string, string> = { color: 'getState_Color', lineWidth: 'getState_LineWidth', lineType: 'getState_LineType', net: 'getState_Net' }
				const callPropsById = new Map<string, Record<string, unknown>>()
				const stableWithoutValue = (value: unknown) => {
					const normalize = (item: unknown): unknown => {
						if (Array.isArray(item)) return item.map(normalize)
						if (item && typeof item === 'object') {
							return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]))
						}
						return item
					}
					if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value)
					const { value: _value, ...rest } = value as Record<string, unknown>
					return JSON.stringify(normalize(rest))
				}
				const verifyPostWrite = async (id: string, before: NonNullable<ReturnType<typeof originals.get>>, callProps: Record<string, unknown>, recordReadback: boolean) => {
					await new Promise(resolve => setTimeout(resolve, 400))
					await assertSnapshotFocused(snapshot)
					const wiresAfter = await eda.sch_PrimitiveWire.getAll()
					if (!Array.isArray(wiresAfter)) throw new Error(`导线 ${id} 修改后对象读回不可用`)
					const sourceAfterText = await eda.sys_FileManager.getDocumentSource()
					await assertSnapshotFocused(snapshot)
					if (typeof sourceAfterText !== 'string' || !sourceAfterText.trim()) throw new Error(`导线 ${id} 修改后源码读回不可用`)
					const sourceAfter = parseSourceLog(sourceAfterText)
					if (sourceAfter.uuid !== snapshot.documentUuid) throw new Error(`导线 ${id} 修改后源码 UUID 与快照不一致`)
					const afterWires = resolveRecords(sourceAfter, 'WIRE')
					const afterAttrs = resolveRecords(sourceAfter, 'ATTR')
					const afterLines = resolveRecords(sourceAfter, 'LINE')
					const found = wiresAfter.find(w => safeState<string>(w, 'getState_PrimitiveId') === id)
					const fields: Record<string, { actual: unknown, expected: unknown, verified: boolean | null }> = {}
					let fieldsVerified = Boolean(found) && afterWires.has(`WIRE\u0000${id}`)
					for (const field of ['color', 'lineWidth', 'lineType', 'net'] as const) {
						const actual = found ? safeState<unknown>(found, getters[field]) : undefined
						const expected = Object.hasOwn(callProps, field) ? callProps[field] : field === 'net' ? before.net : before.state[field]
						const verified = actual === expected
						fields[field] = { actual: actual ?? null, expected, verified }
						fieldsVerified &&= verified
					}
					const actualLine = found ? safeState<unknown>(found, 'getState_Line') : undefined
					const geometryVerified = JSON.stringify(actualLine) === JSON.stringify(before.state.line)
					fields.line = { actual: actualLine ?? null, expected: before.state.line, verified: geometryVerified }
					fieldsVerified &&= geometryVerified
					const directLines = Array.from(afterLines.values()).filter(item => (item.data as Record<string, unknown>)?.lineGroup === id)
					const expectedColor = callProps.color
					const expectedWidth = callProps.lineWidth
					const expectedLineType = callProps.lineType
					const sourceLineChecks = directLines.map(item => {
						const data = item.data as Record<string, unknown>
						const lineId = String(item.header.id)
						const previous = before.lines.find(line => line.id === lineId)
						const fieldsExist = Object.hasOwn(data, 'strokeColor') && Object.hasOwn(data, 'strokeWidth') && Object.hasOwn(data, 'strokeStyle')
						const identityVerified = !!previous && data.lineGroup === previous.lineGroup
							&& data.startX === previous.startX && data.startY === previous.startY && data.endX === previous.endX && data.endY === previous.endY
						const colorVerified = fieldsExist && data.strokeColor === expectedColor
						const widthVerified = fieldsExist && data.strokeWidth === expectedWidth
						let typeVerified: boolean | null
						if (expectedLineType === before.state.lineType)
							typeVerified = !!previous && data.strokeStyle === previous.strokeStyle
						else if (before.lineTypeEncodingVerified && typeof expectedLineType === 'number' && Object.hasOwn(sourceLineTypeByGetter, expectedLineType))
							typeVerified = data.strokeStyle === sourceLineTypeByGetter[expectedLineType]
						else typeVerified = null
						return { id: lineId, strokeColor: data.strokeColor, strokeWidth: data.strokeWidth, strokeStyle: data.strokeStyle, identityVerified, colorVerified, widthVerified, typeVerified }
					})
					const linesVerified = directLines.length === before.lines.length && sourceLineChecks.length === before.lines.length
						&& sourceLineChecks.every(line => line.identityVerified && line.colorVerified && line.widthVerified && line.typeVerified === true)
					fields.sourceLineStyle = { actual: sourceLineChecks, expected: { strokeColor: expectedColor, strokeWidth: expectedWidth, lineType: expectedLineType }, verified: linesVerified }
					fieldsVerified &&= linesVerified
					const directAttrs = Array.from(afterAttrs.values()).filter(item => {
						const data = item.data as Record<string, unknown>
						return data?.parentId === id && typeof data.key === 'string' && /^(NET|Name)$/i.test(data.key)
					})
					const matchingNets = directAttrs.filter(item => /^NET$/i.test(String((item.data as Record<string, unknown>).key)))
					const expectedNet = Object.hasOwn(callProps, 'net') ? callProps.net : before.net
					const sourceNetRecord = matchingNets.length === 1 ? matchingNets[0] : undefined
					const sourceNetData = sourceNetRecord?.data as Record<string, unknown> | undefined
					const sourceAttrStable = !!sourceNetRecord && !!sourceNetData
						&& String(sourceNetRecord.header.id) === before.netAttrId && sourceNetData.parentId === id
						&& stableWithoutValue(sourceNetData) === stableWithoutValue(before.netAttrData)
					const expectedAttrMode = before.attrMode === 'none' && expectedNet !== '' ? 'named' : before.attrMode
					const newNetAttrVerified = before.attrMode === 'none' && expectedAttrMode === 'named'
						&& directAttrs.length === 1 && matchingNets.length === 1 && sourceNetData?.parentId === id && sourceNetData?.value === expectedNet
					const attrVerified = expectedAttrMode === 'none'
						? directAttrs.length === 0
						: directAttrs.length === 1 && matchingNets.length === 1 && sourceNetData?.value === expectedNet
							&& (before.attrMode === 'none' ? newNetAttrVerified : sourceAttrStable)
					fields.netAttribute = { actual: matchingNets.map(item => (item.data as Record<string, unknown>).value), expected: expectedNet, verified: attrVerified }
					fieldsVerified &&= attrVerified
					const verified = fieldsVerified
					if (recordReadback) readback.push({ id, fields, sdkSucceeded: true, verified })
					if (!verified) {
						const sourceAttrsFor = (records: typeof sourceAttrs) => {
							const matches = Array.from(records.values()).filter(item => {
								const data = item.data as Record<string, unknown>
								return data?.parentId === id && typeof data.key === 'string' && /^(NET|Name)$/i.test(data.key)
							})
							return { records: matches.slice(0, 4).map(item => {
								const data = item.data as Record<string, unknown>
								return { id: String(item.header.id), key: data.key, value: data.value, parentId: data.parentId, display: data.display ?? null }
							}), omitted: Math.max(0, matches.length - 4) }
						}
						const sourceLinesFor = (records: typeof sourceLines) => {
							const matches = Array.from(records.values()).filter(item => (item.data as Record<string, unknown>)?.lineGroup === id)
							return { records: matches.slice(0, 4).map(item => {
								const data = item.data as Record<string, unknown>
								return { id: String(item.header.id), lineGroup: data.lineGroup, strokeStyle: data.strokeStyle, strokeWidth: data.strokeWidth, strokeColor: data.strokeColor, start: [data.startX, data.startY], end: [data.endX, data.endY] }
							}), omitted: Math.max(0, matches.length - 4) }
						}
						const safeGetterAttrs = async () => {
							try {
								const result = await withTimeout(eda.sch_PrimitiveAttribute.getAll(id), 2000, `导线 ${id} 写后属性诊断读取`)
								if (!Array.isArray(result)) return []
								return result.filter(attr => /^(NET|Name)$/i.test(String(attr?.getState_Key?.() ?? ''))).slice(0, 4).map(attr => ({ id: attr?.getState_PrimitiveId?.() ?? null, key: attr?.getState_Key?.() ?? null, value: attr?.getState_Value?.() ?? null, display: (attr as any)?.getState_Display?.() ?? null }))
							}
							catch { return [{ readError: true }] }
						}
						const diagnostic = {
							failedFields: Object.entries(fields).filter(([, value]) => value.verified !== true).map(([field]) => field),
							getters: Object.fromEntries(['color', 'lineWidth', 'lineType', 'net', 'line'].filter(field => fields[field]).map(field => [field, fields[field]])),
							attributes: { before: { source: sourceAttrsFor(sourceAttrs), getter: before.getterAttrs }, after: { source: sourceAttrsFor(afterAttrs), getter: await safeGetterAttrs() } },
							lines: { before: sourceLinesFor(sourceLines), after: sourceLinesFor(afterLines) },
							targetWire: { before: sourceWires.has(`WIRE\u0000${id}`), afterGetter: Boolean(found), afterSource: afterWires.has(`WIRE\u0000${id}`) }, callProps, docUuid: snapshot.documentUuid,
						}
						const boundDiagnostic = (value: unknown): unknown => {
							if (typeof value === 'string') return value.length <= 96 ? value : `${value.slice(0, 93)}...`
							if (Array.isArray(value)) return value.map(boundDiagnostic)
							if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 16).map(([key, entry]) => [key, boundDiagnostic(entry)]))
							return value
						}
						throw new Error(`导线 ${id} 对象、网络属性或几何后验不一致；诊断=${JSON.stringify(boundDiagnostic(diagnostic))}`)
					}
					return { fields, verified }
				}
				for (const { id } of targets) {
					const before = originals.get(id)!
					const callProps = {
						color: Object.hasOwn(requestStyle, 'color') ? requestStyle.color : before.state.color,
						lineWidth: Object.hasOwn(requestStyle, 'lineWidth') ? requestStyle.lineWidth : before.state.lineWidth,
						lineType: Object.hasOwn(requestStyle, 'lineType') ? requestStyle.lineType : before.state.lineType,
						...(property.net != null ? { net: property.net as string } : changesStyle && before.attrMode !== 'none' ? { net: before.net } : {}),
					}
					const result: unknown = await write(() => eda.sch_PrimitiveWire.modify(id, callProps as any))
					if (result == null || result === false) throw new Error(`导线 ${id} 修改接口返回空值或 false`)
					callPropsById.set(id, callProps)
					await verifyPostWrite(id, before, callProps, true)
					modified.push(id)
				}
				for (const { id } of targets) await verifyPostWrite(id, originals.get(id)!, callPropsById.get(id)!, true)
			})
			}
			catch (error) {
				const recovery = (error as Error & { cause?: Record<string, unknown> })?.cause
				if (recovery?.restored === true) {
					await new Promise(resolve => setTimeout(resolve, 400))
					let restoredWires: any
					try { restoredWires = await eda.sch_PrimitiveWire.getAll() }
					catch { restoredWires = undefined }
					let modelRestored = Array.isArray(restoredWires)
					for (const { id } of targets) {
						const before = originals.get(id)!
						const wire = Array.isArray(restoredWires) ? restoredWires.find(w => safeState<string>(w, 'getState_PrimitiveId') === id) : undefined
						modelRestored &&= Boolean(wire)
						for (const [field, getter] of [['color', 'getState_Color'], ['lineWidth', 'getState_LineWidth'], ['lineType', 'getState_LineType']] as const)
							modelRestored &&= safeState<unknown>(wire, getter) === before.state[field]
						modelRestored &&= safeState<unknown>(wire, 'getState_Net') === before.net
						modelRestored &&= JSON.stringify(safeState<unknown>(wire, 'getState_Line')) === JSON.stringify(before.state.line)
						let attrs: any
						try { attrs = await eda.sch_PrimitiveAttribute.getAll(id) }
						catch { modelRestored = false; continue }
						if (!Array.isArray(attrs)) {
							modelRestored = false
							continue
						}
						const netAttrs = attrs.filter(attr => /^(NET|Name)$/i.test(String(attr?.getState_Key?.() ?? '')))
						const sourceNetAttrs = Array.from(sourceAttrs.values()).filter(record => {
							const data = record.data as Record<string, unknown>
							return data?.parentId === id && typeof data.key === 'string' && /^(NET|Name)$/i.test(data.key)
						})
						if (before.attrMode === 'none') {
							modelRestored &&= netAttrs.length === 0 && sourceNetAttrs.length === 0
							continue
						}
						const sourceNet = sourceNetAttrs.length === 1 ? sourceNetAttrs[0] : undefined
						const sourceNetData = sourceNet?.data as Record<string, unknown> | undefined
						const getterNet = netAttrs.length === 1 ? netAttrs[0] : undefined
						const getterKey = String(getterNet?.getState_Key?.() ?? '')
						const getterId = getterNet?.getState_PrimitiveId?.()
						const getterValue = getterNet?.getState_Value?.()
						const sourceBackedNet = !!sourceNet && !!sourceNetData
							&& /^NET$/i.test(String(sourceNetData.key)) && sourceNetData.parentId === id
							&& String(sourceNet.header.id) === before.netAttrId && sourceNetData.value === before.net
						const getterMatchesSource = getterId === before.netAttrId && getterValue === before.net
							&& (/^NET$/i.test(getterKey) || /^Name$/i.test(getterKey) && sourceBackedNet)
						modelRestored &&= netAttrs.length === 1 && sourceBackedNet && getterMatchesSource
					}
					if (!modelRestored) {
						const operationError = error instanceof Error ? error.message : String(error)
						throw new Error(`源码快照已恢复，但目标导线对象 getter/属性恢复未确认：${operationError}`, {
							cause: { ...recovery, partial: true, restored: false, retryable: false, modelRestored: false },
						})
					}
				}
				throw error
			}
			return { modified, failed: failedIds, ...(readback.length ? { readback } : {}) }
		},
	},
	{
		name: 'schematic.dedupeWireNets',
		summary: '清理导线重复网络名：识别NET/Name同名属性，冲突拒绝；按原导线整体带名重建并按返回ID立即读回验证',
		params: [],
		returns: '{ dupWires, rebuilt: 成功重建的原导线数, renamed: 独立modify次数(始终为0), skippedDiagonal, failed? }',
		example: { cmd: 'schematic.dedupeWireNets' },
		handler: async () => {
			const startingDoc = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (!startingDoc?.uuid || startingDoc.documentType !== 1)
				throw new Error('焦点文档不是有效的原理图页，已拒绝去重')
			const sourceBeforeText = await eda.sys_FileManager.getDocumentSource()
			if (typeof sourceBeforeText !== 'string' || !sourceBeforeText.trim()) throw new Error('无法读取原理图源码，未执行去重')
			const parsedBefore = parseSourceLog(sourceBeforeText)
			if (parsedBefore.uuid !== startingDoc.uuid || parsedBefore.docType !== 'SCH_PAGE') throw new Error('源码身份与焦点原理图不一致，未执行去重')
			const sourceLinesByWire = new Map<string, Array<any>>()
			for (const record of resolveRecords(parsedBefore, 'LINE').values()) {
				const data = record.data as Record<string, unknown>
				if (data?.lineGroup == null) continue
				const id = String(data.lineGroup)
				if (!sourceLinesByWire.has(id)) sourceLinesByWire.set(id, [])
				sourceLinesByWire.get(id)!.push(record)
			}
			const wires = await eda.sch_PrimitiveWire.getAll()
			// 1. 找出 NET 属性重复的导线（每根导线正常只应有 1 个 NET 属性）
			const dup: Array<{ id: string, net: string, line: Array<number> }> = []
			const formatValues = (values: unknown[]) => {
				try { return JSON.stringify(values) ?? String(values) }
				catch { return `[无法序列化的${values.length}个值]` }
			}
			for (const w of wires ?? []) {
				const id = w.getState_PrimitiveId?.()
				const line = w.getState_Line?.()
				if (!id || !line)
					continue
				let attrs: Array<any>
				try {
					const result = await eda.sch_PrimitiveAttribute.getAll(id)
					if (!Array.isArray(result))
						throw new Error('属性接口未返回数组')
					attrs = result
				}
				catch (error) {
					const detail = error instanceof Error ? error.message : String(error)
					throw new Error(`导线 ${id} NET/Name 属性读取失败（values=[]）：${detail}`)
				}
				let netAttrs: Array<any>
				try {
					netAttrs = []
					for (const attr of attrs) {
						if (typeof attr?.getState_Key !== 'function')
							throw new Error('属性条目缺少 getState_Key')
						if (/^(NET|Name)$/i.test(String(attr.getState_Key() ?? '')))
							netAttrs.push(attr)
					}
				}
				catch (error) {
					const detail = error instanceof Error ? error.message : String(error)
					throw new Error(`导线 ${id} NET/Name 属性键读取失败（values=[]）：${detail}`)
				}
				if (netAttrs.length > 1) {
					const values: unknown[] = []
					try {
						for (const attr of netAttrs)
							values.push(attr.getState_Value?.())
					}
					catch (error) {
						const detail = error instanceof Error ? error.message : String(error)
						throw new Error(`候选导线 ${id} NET/Name 属性值读取失败（values=${formatValues(values)}）：${detail}`)
					}
					if (values.some(value => typeof value !== 'string' || value.length === 0)
						|| values.some(value => value !== values[0]))
						throw new Error(`候选导线 ${id} 的 NET/Name 属性值必须是相同的非空字符串（values=${formatValues(values)}）`)
					dup.push({
						id,
						net: values[0] as string,
						line: line as Array<number>,
					})
				}
			}
			if (!dup.length)
				return { dupWires: 0, rebuilt: 0, renamed: 0, skippedDiagonal: 0 }
			// 2. 每条原导线单独保留一组正交线段；跳过非水平/垂直的 T 形分支编码伪段。
			let skippedDiagonal = 0
			const rebuilds: Array<{ id: string, net: string, segs: Array<{ line: Array<number>, color: unknown, width: unknown, strokeStyle: unknown }> }> = []
			for (const w of dup) {
				const norm = new Set<string>()
				const segs: Array<{ line: Array<number>, color: unknown, width: unknown, strokeStyle: unknown }> = []
				let wireSegmentCount = 0
				const sourceLines = sourceLinesByWire.get(w.id) ?? []
				if (!sourceLines.length) throw new Error(`候选导线 ${w.id} 在源码中没有真实 LINE 段，未执行去重`)
				for (const record of sourceLines) {
					const data = record.data as Record<string, unknown>
					const [x1, sy1, x2, sy2] = [data.startX, data.startY, data.endX, data.endY]
					if (![x1, sy1, x2, sy2].every(value => typeof value === 'number' && Number.isFinite(value)))
						throw new Error(`候选导线 ${w.id} 的 LINE 源端点非法，未执行去重`)
					if (!['strokeColor', 'strokeWidth', 'strokeStyle'].every(key => Object.hasOwn(data, key)))
						throw new Error(`候选导线 ${w.id} 的 LINE 源码缺少完整样式，未执行去重`)
					if (data.strokeColor === undefined || data.strokeWidth === undefined || data.strokeStyle === undefined)
						throw new Error(`候选导线 ${w.id} 的 LINE 样式含 undefined，未执行去重`)
					const lineType = ({ SOLID: 0, SHORT_DASH: 1, DOT: 2 } as Record<string, number>)[String(data.strokeStyle)]
					if (data.strokeStyle !== null && lineType === undefined)
						throw new Error(`候选导线 ${w.id} 的线型 ${String(data.strokeStyle)} 没有已核实的 SDK 映射，未执行去重`)
					const line = [x1 as number, -(sy1 as number), x2 as number, -(sy2 as number)]
					const [ax, ay, bx, by] = line
					if (ax === bx && ay === by)
						continue
					if (ax !== bx && ay !== by) {
						throw new Error(`候选导线 ${w.id} 含真实斜 LINE 段，当前无法证明重建保真，未执行去重`)
					}
					const key = `${Math.min(ax, bx)},${Math.min(ay, by)},${Math.max(ax, bx)},${Math.max(ay, by)}`
					if (norm.has(key))
						continue
					norm.add(key)
					segs.push({ line, color: data.strokeColor, width: data.strokeWidth, strokeStyle: data.strokeStyle })
					wireSegmentCount++
				}
				if (!wireSegmentCount)
					throw new Error(`候选导线 ${w.id} 没有可重建的水平或垂直线段，原图未改动`)
				const firstStyle = segs[0]
				if (segs.some(segment => segment.color !== firstStyle.color || segment.width !== firstStyle.width || segment.strokeStyle !== firstStyle.strokeStyle))
					throw new Error(`候选导线 ${w.id} 含混合颜色/线宽/线型；官方单次 create 无法证明逐段保真，未执行去重`)
				rebuilds.push({ id: w.id, net: w.net, segs })
			}
			const focusedAgain = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (focusedAgain?.uuid !== startingDoc.uuid || focusedAgain?.documentType !== 1)
				throw new Error('枚举导线期间焦点原理图页发生变化，原图未改动')
			const snapshot = await captureDocumentSnapshot('schematic.dedupeWireNets', 1)
			if (snapshot.documentUuid !== startingDoc.uuid)
				throw new Error('快照与候选导线所属的原理图页不一致，原图未改动')
			let rebuilt = 0
			const renamed = 0
			await withDocumentRecovery(snapshot, async (write) => {
				// 删除整组旧线；失败统一恢复完整原文，绝不按新 ID 逐个回滚。
				if (await write(() => eda.sch_PrimitiveWire.delete(dup.map(w => w.id))) !== true)
					throw new Error('删除重复属性导线返回 false')
				for (const original of rebuilds) {
					const ids = new Set<string>()
					const style = original.segs[0]
					const points = original.segs.flatMap(segment => segment.line)
					const lineType = style.strokeStyle === null ? null : ({ SOLID: 0, SHORT_DASH: 1, DOT: 2 } as Record<string, number>)[String(style.strokeStyle)]
					const created = await write(() => eda.sch_PrimitiveWire.create(points, original.net, style.color as any, style.width as any, lineType as any))
					if (!created) throw new Error(`原导线 ${original.id} 带完整样式重建失败（create未返回图元）`)
					const id = created.getState_PrimitiveId?.()
					if (typeof id !== 'string' || !id) throw new Error(`原导线 ${original.id} 重建未返回有效ID`)
					ids.add(id)
					await assertSnapshotFocused(snapshot)
					const sourceAfterText = await eda.sys_FileManager.getDocumentSource()
					if (typeof sourceAfterText !== 'string' || !sourceAfterText.trim()) throw new Error(`原导线 ${original.id} 重建后源码读回失败`)
					const sourceAfter = parseSourceLog(sourceAfterText)
					if (sourceAfter.uuid !== snapshot.documentUuid) throw new Error('重建后源码 UUID 与快照不一致')
					const linesAfter = [...resolveRecords(sourceAfter, 'LINE').values()]
					for (const segment of original.segs) {
						const [x1, y1, x2, y2] = segment.line
						const exact = linesAfter.some(record => {
							const data = record.data as Record<string, unknown>
							return ids.has(String(data.lineGroup))
								&& (data.startX === x1 && data.startY === -y1 && data.endX === x2 && data.endY === -y2
									|| data.startX === x2 && data.startY === -y2 && data.endX === x1 && data.endY === -y1)
								&& data.strokeColor === segment.color && data.strokeWidth === segment.width && data.strokeStyle === segment.strokeStyle
						})
						if (!exact) throw new Error(`原导线 ${original.id} 的线段几何或颜色/线宽/线型未完整读回`)
					}
					for (const id of ids) {
						await assertSnapshotFocused(snapshot)
						const readback = await eda.sch_PrimitiveWire.get(id)
						await assertSnapshotFocused(snapshot)
						if (!readback) throw new Error(`重建导线 ${id} 按ID立即读回不存在`)
						const actualNet = readback.getState_Net?.()
						if (actualNet !== original.net) throw new Error(`重建导线 ${id} 网络读回不一致（期望=${JSON.stringify(original.net)}, 实际=${JSON.stringify(actualNet)}）`)
					await assertSnapshotFocused(snapshot)
					let readbackAttrs: Array<any>
					try {
						const attrs = await eda.sch_PrimitiveAttribute.getAll(id)
						if (!Array.isArray(attrs))
							throw new Error('属性接口未返回数组')
						readbackAttrs = attrs
					}
					catch (error) {
						const detail = error instanceof Error ? error.message : String(error)
						throw new Error(`重建导线 ${id} 网络属性读回失败：${detail}`)
					}
					await assertSnapshotFocused(snapshot)
					const networkAttrs = readbackAttrs.filter(attr => /^(NET|Name)$/i.test(String(attr.getState_Key?.() ?? '')))
					if (networkAttrs.length !== 1)
						throw new Error(`重建导线 ${id} NET/Name属性数量不为1（实际=${networkAttrs.length}）`)
					const actualName = networkAttrs[0].getState_Value?.()
					if (actualName !== original.net)
						throw new Error(`重建导线 ${id} 网络属性读回不一致（期望=${JSON.stringify(original.net)}, 实际=${JSON.stringify(actualName)}）`)
					}
					rebuilt += 1
				}
			})
			return { dupWires: dup.length, rebuilt, renamed, skippedDiagonal }
		},
	},
	{
		name: 'schematic.repairNet',
		summary: '碎网修复宏（一条命令完成审计→补标签→前后对比）：人工拖动网络标签等原因导致网络断裂后用它收尾。流程：① adoptWireIds 先把无名残线归入网络；② 找出"属于该网络但没有名字属性"的导线并自动补网络标签（自动 ±2 微偏+附着验证）；③ 网表前后成员对比。顽固的重复属性导线请先用 dedupeWireNets 或删线重画',
		params: [
			{ name: 'net', type: 'string', required: true, description: '要修复的网络名，如 VOUT' },
			{ name: 'adoptWireIds', type: 'string[]', description: '先把这些无名导线命名归入该网络（等价逐条 setWireNet），再补标签' },
			{ name: 'dryRun', type: 'boolean', description: '只审计不改动，默认 false' },
		],
		returns: '{ before: { members, count }, after: { members, count }, wiresOfNet, labelsBefore, floatingLabels, adopted, placedLabels, failedLabels, repaired }（repaired=true 表示成员数有增长或持平且已无无名导线）',
		example: { cmd: 'schematic.repairNet', params: { net: 'VOUT' } },
		handler: async (params) => {
			if (!params.net)
				throw new Error('缺少参数 net')
			if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean')
				throw new Error('dryRun 必须是布尔值')
			const net = String(params.net)
			const dryRun = params.dryRun ?? false

			// --- 网表成员审计（0.10.45 起带回退：getNetlistFile 返空时自动用 PADS 文本网表，GPT -05） ---
			const getNetMembers = async (): Promise<Array<string>> => {
				const map = await pinNetMapRobust()
				if (!map)
					throw new Error('网表读取失败：getNetlistFile 与 PADS 文本回退均不可用（如器件缺封装——04 实测因果；可先 schematic.runDrcDetailed 查致命项）')
				return [...map].filter(([, n]) => n === net).map(([refPin]) => refPin).sort()
			}

			// --- 网络标签盘点（附着 + 浮空） ---
			const scanLabels = async () => {
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				const labels: Array<{ primitiveId: string, wireId: string, x?: number, y?: number }> = []
				const floating: Array<{ primitiveId: string, x?: number, y?: number }> = []
				const wireIds = new Set<string>()
				for (const w of wires) {
					const wid = safeState<string>(w, 'getState_PrimitiveId')
					if (wid)
						wireIds.add(wid)
				}
				for (const w of wires) {
					const wid = safeState<string>(w, 'getState_PrimitiveId')
					if (!wid)
						continue
					let attrs: Array<any> = []
					try {
						attrs = (await eda.sch_PrimitiveAttribute.getAll(wid)) ?? []
					}
					catch {
						continue
					}
					for (const a of attrs) {
						const key = safeState<string>(a, 'getState_Key') ?? ''
						if (!/^(NET|Name)$/i.test(key))
							continue
						if (safeState<string>(a, 'getState_Value') !== net)
							continue
						labels.push({
							primitiveId: safeState<string>(a, 'getState_PrimitiveId') ?? '',
							wireId: wid,
							x: safeState<number>(a, 'getState_X'),
							y: safeState<number>(a, 'getState_Y'),
						})
					}
				}
				// 浮空标签：父图元不是导线的同名属性
				try {
					const all = (await eda.sch_PrimitiveAttribute.getAll()) ?? []
					const attachedIds = new Set(labels.map(l => l.primitiveId))
					for (const a of all) {
						const key = safeState<string>(a, 'getState_Key') ?? ''
						if (!/^(NET|Name)$/i.test(key))
							continue
						const value = safeState<string>(a, 'getState_Value') ?? ''
						if (value !== net)
							continue
						const id = safeState<string>(a, 'getState_PrimitiveId') ?? ''
						if (attachedIds.has(id))
							continue
						const parent = safeState<string>(a, 'getState_ParentPrimitiveId')
						if (parent && wireIds.has(parent))
							continue
						floating.push({
							primitiveId: id,
							x: safeState<number>(a, 'getState_X'),
							y: safeState<number>(a, 'getState_Y'),
						})
					}
				}
				catch {
					// 浮空扫描失败不阻断主流程
				}
				return { labels, floating }
			}

			// --- 属于该网络的导线及其名字属性状态 ---
			const scanWires = async () => {
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				const named: Array<{ id: string, line: Array<number>, hasNameAttr: boolean }> = []
				for (const w of wires) {
					if (safeState<string>(w, 'getState_Net') !== net)
						continue
					const id = safeState<string>(w, 'getState_PrimitiveId')
					const line = safeState<Array<number>>(w, 'getState_Line') ?? []
					if (!id)
						continue
					let hasNameAttr = false
					try {
						const attrs = (await eda.sch_PrimitiveAttribute.getAll(id)) ?? []
						hasNameAttr = attrs.some(a =>
							/^(NET|Name)$/i.test(safeState<string>(a, 'getState_Key') ?? '')
							&& safeState<string>(a, 'getState_Value') === net)
					}
					catch {
						// 属性读取失败按有名字处理，避免误补重复标签
						hasNameAttr = true
					}
					named.push({ id, line, hasNameAttr })
				}
				return named
			}

			const before = await getNetMembers()

			// ① 收养无名残线
			const adopted: Array<string> = []
			const adoptFailed: Array<string> = []
			if (!dryRun && Array.isArray(params.adoptWireIds)) {
				for (const wid of params.adoptWireIds) {
					try {
						const id = String(wid)
						await setWireNetPreservingState(id, net, { requireUnnamed: true })
						adopted.push(id)
					}
					catch (error) {
						if ((error as any)?.cause?.partial === true)
							throw new Error(`收养导线 ${String(wid)} 的写入或读回未确认，已停止后续步骤`, { cause: { ...(error as any).cause, adopted, failedId: String(wid) } })
						adoptFailed.push(String(wid))
					}
				}
			}

			// ② 给缺名字属性的导线补标签
			const wires = await scanWires()
			const missing = wires.filter(w => !w.hasNameAttr)
			const placedLabels: Array<{ wireId: string, x: number, y: number }> = []
			const failedLabels: Array<{ wireId: string, x: number, y: number, reason: string }> = []
			if (!dryRun) {
				for (const w of missing) {
					// 锚点取第一段中点（placeNetLabel 同款 ±2 自动微偏）
					const line = w.line
					if (line.length < 2)
						continue
					const mx = line.length >= 4 ? Math.round((line[0] + line[2]) / 2) : line[0]
					const my = line.length >= 4 ? Math.round((line[1] + line[3]) / 2) : line[1]
					let ok = false
					let lastErr = ''
					for (const [dx, dy] of [[0, 0], [0, 2], [0, -2], [2, 0], [-2, 0]] as Array<[number, number]>) {
						try {
							const label = await (eda.sch_PrimitiveAttribute as any).createNetLabel(mx + dx, my + dy, net)
							if (label) {
								ok = true
								break
							}
						}
						catch (e: any) {
							lastErr = e?.message ?? String(e)
						}
					}
					if (ok)
						placedLabels.push({ wireId: w.id, x: mx, y: my })
					else
						failedLabels.push({ wireId: w.id, x: mx, y: my, reason: lastErr || '官方返回空（±2 微偏均被拒）' })
				}
				// 等官方合并/附着计算稳定
				if (placedLabels.length)
					await new Promise(resolve => setTimeout(resolve, 800))
			}

			const { labels, floating } = await scanLabels()
			const after = dryRun ? before : await getNetMembers()
			return {
				before: { members: before, count: before.length },
				after: { members: after, count: after.length },
				wiresOfNet: wires.length,
				wiresMissingName: missing.map(w => w.id),
				labelsBefore: labels.length,
				floatingLabels: floating,
				adopted,
				...(adoptFailed.length ? { adoptFailed } : {}),
				placedLabels,
				failedLabels,
				dryRun,
				repaired: !dryRun && after.length >= before.length && missing.length === placedLabels.length,
			}
		},
	},
	{
		name: 'schematic.getComponentsInRect',
		summary: '查询落在指定矩形（功能区块框）内的器件——按区框批量选择/搬移/核对分区归属用。锚点判定：器件原点 (x,y) 落在 span 内即计入',
		params: [
			{ name: 'rectId', type: 'string', description: '区框矩形图元 ID（与显式 span 二选一）' },
			{ name: 'x1', type: 'number', description: 'span 左下 X（10mil，+Y 向上世界坐标）' },
			{ name: 'y1', type: 'number', description: 'span 左下 Y' },
			{ name: 'x2', type: 'number', description: 'span 右上 X' },
			{ name: 'y2', type: 'number', description: 'span 右上 Y' },
			{ name: 'margin', type: 'number', description: 'span 四向外扩余量（10mil，默认 0）' },
		],
		returns: '{ span, count, components: [{ primitiveId, designator, name, x, y, rotation }] }',
		example: { cmd: 'schematic.getComponentsInRect', params: { rectId: 'xxx' } },
		handler: async (params) => {
			let span: { x1: number, y1: number, x2: number, y2: number } | undefined
			if (params.rectId) {
				const rects = (await eda.sch_PrimitiveRectangle.getAll()) ?? []
				for (const r of rects) {
					if (safeState<string>(r, 'getState_PrimitiveId') !== String(params.rectId))
						continue
					const x = safeState<number>(r, 'getState_TopLeftX')
					const y = safeState<number>(r, 'getState_TopLeftY')
					const w = safeState<number>(r, 'getState_Width')
					const h = safeState<number>(r, 'getState_Height')
					if (x == null || y == null || w == null || h == null)
						throw new Error('矩形几何数据读取失败')
					// +Y 向上：左上点 y 是上沿，下沿 = y - height
					span = { x1: x, y1: y - h, x2: x + w, y2: y }
					break
				}
				if (!span)
					throw new Error(`未找到矩形 ${params.rectId}（用 schematic.listRects 查 ID）`)
			}
			else if (params.x1 != null && params.y1 != null && params.x2 != null && params.y2 != null) {
				span = {
					x1: Math.min(Number(params.x1), Number(params.x2)),
					y1: Math.min(Number(params.y1), Number(params.y2)),
					x2: Math.max(Number(params.x1), Number(params.x2)),
					y2: Math.max(Number(params.y1), Number(params.y2)),
				}
			}
			else {
				throw new Error('缺少参数：给 rectId 或显式 span（x1/y1/x2/y2）')
			}
			const margin = params.margin != null ? Number(params.margin) : 0
			span = { x1: span.x1 - margin, y1: span.y1 - margin, x2: span.x2 + margin, y2: span.y2 + margin }
			const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
			const inside = comps.map(c => ({
				primitiveId: safeState<string>(c, 'getState_PrimitiveId'),
				designator: safeState<string>(c, 'getState_Designator'),
				name: safeState<string>(c, 'getState_Name'),
				x: safeState<number>(c, 'getState_X'),
				y: safeState<number>(c, 'getState_Y'),
				rotation: safeState<number>(c, 'getState_Rotation'),
			})).filter(c =>
				typeof c.x === 'number' && typeof c.y === 'number'
				&& c.x >= span!.x1 && c.x <= span!.x2 && c.y >= span!.y1 && c.y <= span!.y2)
			return { span, count: inside.length, components: inside }
		},
	},
	{
		name: 'schematic.buildBlock',
		summary: '【宏】按 AI 提供的器件清单+连接表自动生成一个功能区电路：自动平铺区框（默认从 0,0 起排，间隙 5）→ 行列排布器件 → 按 nets 连线 → 网表+DRC 自查。0.10.14 起连线层切换到 batchWire 语义化引擎（labelWire 短桩+标签带假失败 ghost 检查/占用预检/NC 预检，linkWire U 形防共线动态错层，batchWire 逐条收错+一次网表统一审计），0.9.x 自绘连线逻辑已删除。布局模板为 cw32-style（器件横距 60、行距 90、短桩长 20、标题在框底居中字号 20、区框默认黑色虚线可用 color/lineType 自定义）',
		params: [
			{ name: 'components', type: 'array', required: true, description: '器件清单 [{ ref, lcscId?, deviceUuid?, libraryUuid?, rotation?, mirror? }]，ref 是连接表里引用的名字（如 U1/C1），nets 里的引脚按 "ref.引脚号" 引用' },
			{ name: 'nets', type: 'array', required: true, description: '连接表 [{ name, pins: ["U1.7","C1.1"], style?: "wire"|"label", color?: "#FF0000" }]。style 缺省自动：2 个引脚 wire 直连，≥3 个或电源类网络（GND/VCC/VDD/VIN/VOUT/3V3/5V 等）label 短桩+标签；color 会同时作用于导线和标签' },
			{ name: 'region', type: 'object', description: '区框 { x, y, width, height, title, color, lineType }（x,y 为左下角；color 默认黑色 #000000，lineType 默认 dashed 虚线）。留空则自动估算尺寸并从 (0,0) 起自动平铺到页面空位' },
			{ name: 'title', type: 'string', description: '区标题（region 留空时用它）' },
			{ name: 'color', type: 'string', description: '区框颜色（region 留空时用它），默认 #000000 黑色' },
			{ name: 'skipAudit', type: 'boolean', description: '跳过收尾网表/DRC 自查（默认 false）' },
		],
		returns: '{ region: { rectId, span }, placed: [{ ref, primitiveId, designator, x, y }], nets: [{ name, style, wired?/labeled?, ok?, error?/incomplete?, missing? }], drc, wireAudit, failed }（网表审计由 batchWire 统一完成，明细在 wireAudit）',
		example: { cmd: 'schematic.buildBlock', params: { title: '电源滤波', components: [{ ref: 'C1', lcscId: 'C23138' }], nets: [{ name: 'VDD', pins: ['C1.1'] }, { name: 'GND', pins: ['C1.2'] }] } },
		handler: async (params) => {
			if (!Array.isArray(params.components) || !params.components.length)
				throw new Error('缺少参数 components（器件清单数组）')
			if (!Array.isArray(params.nets))
				throw new Error('缺少参数 nets（连接表数组，可为空数组）')

			// ---------- ① 区框：显式或自动平铺 ----------
			const n = params.components.length
			const estW = Math.max(170, Math.ceil(Math.sqrt(n * 1.6)) * 60 + 60)
			const estH = Math.max(150, Math.ceil(n / Math.max(1, Math.floor(estW / 60))) * 90 + 70)
			const rg = params.region as Record<string, unknown> | undefined
			let rx = rg?.x != null ? Number(rg.x) : undefined
			let ry = rg?.y != null ? Number(rg.y) : undefined
			const rw = rg?.width != null ? Number(rg.width) : estW
			const rh = rg?.height != null ? Number(rg.height) : estH
			const title = String(rg?.title ?? params.title ?? '功能区')
			// 自动平铺：从 (0,0) 起扫描现有矩形找空位（行优先，行内贴最右，间隙 5）
			if (rx == null || ry == null) {
				const rects = (await eda.sch_PrimitiveRectangle.getAll()) ?? []
				const spans = rects.map(r => {
					const x = safeState<number>(r, 'getState_TopLeftX') ?? 0
					const y = safeState<number>(r, 'getState_TopLeftY') ?? 0
					const w = safeState<number>(r, 'getState_Width') ?? 0
					const h = safeState<number>(r, 'getState_Height') ?? 0
					return { x1: x, y1: y - h, x2: x + w, y2: y }
				})
				const PAGE_W = 1170
				let placed = false
				let bandY = 0
				for (let guard = 0; guard < 20 && !placed; guard++) {
					const band = spans.filter(s => s.y1 < bandY + rh && s.y2 > bandY).sort((a, b) => a.x1 - b.x1)
					let cursor = 0
					for (const s of band) {
						if (s.x1 - cursor >= rw) {
							rx = cursor; ry = bandY; placed = true; break
						}
						cursor = Math.max(cursor, s.x2 + 5)
					}
					if (!placed && cursor + rw <= PAGE_W) {
						rx = cursor; ry = bandY; placed = true
					}
					if (!placed)
						bandY = Math.max(...band.map(s => s.y2), bandY) + 5
				}
				if (!placed)
					throw new Error('页面内找不到足够空位放置区框，请显式传 region')
			}
			const span = { x1: rx!, y1: ry!, x2: rx! + rw, y2: ry! + rh }

			// 画区框（cw32-style：虚线框 + 框底居中标题字号 20；颜色默认黑色，可自定义）
			const lineTypeMap: Record<string, number> = { solid: 0, dashed: 1, dotted: 2 }
			const regionColor = String(rg?.color ?? params.color ?? '#000000')
			const regionLineType = (lineTypeMap[String(rg?.lineType ?? 'dashed')] ?? 1) as any
			const rect = await eda.sch_PrimitiveRectangle.create(rx!, ry! + rh, rw, rh, undefined, undefined, regionColor, undefined, undefined, regionLineType, undefined)
			if (!rect)
				throw new Error('区框矩形创建失败（可能当前打开的不是原理图）')
			const rectId = safeState<string>(rect, 'getState_PrimitiveId')
			let titleW = 0
			for (const ch of title)
				titleW += /[⺀-鿿　-〿＀-￯]/.test(ch) ? 20 : 11
			await eda.sch_PrimitiveText.create(
				Math.round(span.x1 + (rw - titleW) / 2), span.y1 + 5,
				title, undefined, undefined, undefined, 20, true,
			)

			// ---------- ② 行列排布放器件 ----------
			const innerX = span.x1 + 40
			const innerRight = span.x2 - 20
			const colStep = 60
			const rowStep = 90
			let cx = innerX
			let cy = span.y2 - 50
			const placed: Array<{ ref: string, primitiveId?: string, designator?: string, x: number, y: number, error?: string, designatorNote?: string }> = []
			for (const comp of params.components as Array<Record<string, unknown>>) {
				const ref = String(comp.ref ?? '')
				if (!ref) {
					placed.push({ ref: '?', x: 0, y: 0, error: '缺少 ref' })
					continue
				}
				let deviceRef: { libraryUuid: string, uuid: string } | undefined
				if (comp.lcscId) {
					const items = await eda.lib_Device.getByLcscIds([String(comp.lcscId)])
					if (!items?.[0]) {
						placed.push({ ref, x: 0, y: 0, error: `未找到立创编号 ${comp.lcscId}` })
						continue
					}
					deviceRef = { libraryUuid: items[0].libraryUuid, uuid: items[0].uuid }
				}
				else if (comp.deviceUuid && comp.libraryUuid) {
					deviceRef = { libraryUuid: String(comp.libraryUuid), uuid: String(comp.deviceUuid) }
				}
				else {
					placed.push({ ref, x: 0, y: 0, error: '需要 lcscId 或 deviceUuid+libraryUuid' })
					continue
				}
				const created = await eda.sch_PrimitiveComponent.create(
					deviceRef, cx, cy, undefined,
					comp.rotation != null ? Number(comp.rotation) : undefined,
					comp.mirror != null ? Boolean(comp.mirror) : undefined,
					true, true,
				)
				if (!created) {
					placed.push({ ref, x: cx, y: cy, error: '官方返回空' })
					continue
				}
				const newId = safeState<string>(created, 'getState_PrimitiveId')
				// 位号落地（0.10.17 缺陷修复）：lcscId 放置后位号是占位符 "R?"/"C?"，
				// 连线引擎按位号解析引脚会得到 "R?.2" 被格式校验拒绝——放置后立刻把用户 ref 落为真实位号。
				// 官方 modify 有假失败前科：改完读回 getState_Designator 验证，失败如实记录（连线改用读回值）。
				let actualDesignator = safeState<string>(created, 'getState_Designator')
				let designatorNote: string | undefined
				if (newId && actualDesignator !== ref) {
					try {
						const attrIds = await eda.sch_PrimitiveAttribute.getAllPrimitiveId(newId)
						const attrs = await eda.sch_PrimitiveAttribute.get(attrIds)
						const desAttr = (attrs ?? []).find(a => safeState<string>(a, 'getState_Key') === 'Designator')
						const desAttrId = desAttr ? safeState<string>(desAttr, 'getState_PrimitiveId') : undefined
						if (desAttrId) {
							await eda.sch_PrimitiveAttribute.modify(desAttrId, { value: ref })
							// 读回验证（不信 modify 返回值）
							const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
							const me = comps.find(c => safeState<string>(c, 'getState_PrimitiveId') === newId)
							const readBack = me ? safeState<string>(me, 'getState_Designator') : undefined
							if (readBack === ref)
								actualDesignator = ref
							else
								designatorNote = `位号改写读回为 ${readBack ?? '(读不到)'}，期望 ${ref}——官方假失败或位号冲突，连线将按读回位号进行`
						}
						else
							designatorNote = '器件上没有 Designator 属性图元，位号未改写'
					}
					catch (e: any) {
						designatorNote = `位号改写抛错 ${String(e?.message ?? e)}`
					}
				}
				placed.push({
					ref,
					primitiveId: newId,
					designator: actualDesignator,
					x: cx, y: cy,
					...(designatorNote ? { designatorNote } : {}),
				})
				cx += colStep
				if (cx > innerRight) {
					cx = innerX
					cy -= rowStep
				}
			}

			// ---------- ③ （0.10.14 起删除）引脚坐标读回已由 labelWire/linkWire 内部的 resolvePinPoint 按位号实时解析 ----------

			// ---------- ④ 按连接表连线（0.10.14 起切换到 batchWire 语义化引擎）----------
			// 0.9.x 时代的自绘连线层（自画 U 形导线/自放标签/stubSegs 防撞登记/横腿按序号错层）已删除——
			// labelWire/linkWire 内部已有更新且实测打磨过的防护，对照 0.9.9 三类共线陷阱：
			//  ① 相邻器件短桩同间隙共线重叠 → labelWire 短桩四方向防撞（背离本体→上→下→反向），
			//     桩终点 8 单位内有其他引脚或与现有导线共线即换向，另有 findWireNetsAtPoint 占用预检；
			//  ② 同行引脚共线被直线/L 走线穿过 → linkWire 一律 U 形绕行；
			//  ③ 多网络横腿同深度共线 → linkWire 横腿深度从 30 起每次 +15，按当前障碍范围动态避让。
			// 另免费获得：createNetLabel 假失败 ghost 双路检查、NC 引脚预检（逐条收错不中断）、一次网表统一审计。
			// 电源网判定（0.10.18 起允许全大写后缀；0.10.19 起抽到模块级 isPowerNetName 共享）
			const isPowerNet = isPowerNetName
			// 用户 ref → 实际位号映射（labelWire/linkWire 按位号在页面解析引脚）
			const designatorOf = new Map<string, string>()
			for (const p of placed) {
				if (p.primitiveId)
					designatorOf.set(p.ref, p.designator ?? p.ref)
			}
			const resolveRef = (pinRef: string): string => {
				const dot = pinRef.indexOf('.')
				if (dot < 0)
					return pinRef
				const ref = pinRef.slice(0, dot)
				return `${designatorOf.get(ref) ?? ref}${pinRef.slice(dot)}`
			}
			const netResults: Array<Record<string, unknown>> = []
			const failed: Array<Record<string, unknown>> = []
			const batchItems: Array<Record<string, unknown>> = []
			const netItemIdx: Array<Array<number>> = [] // netResults[i] 对应的 batchItems 下标
			for (const netSpec of params.nets as Array<Record<string, unknown>>) {
				const netName = String(netSpec.name ?? '')
				const pinRefs = Array.isArray(netSpec.pins) ? (netSpec.pins as Array<string>).map(String) : []
				if (!netName || pinRefs.length < 1)
					continue
				// 放置失败/缺 ref 的引脚记 missing，不进接线项
				const missing = pinRefs.filter((pr) => {
					const dot = pr.indexOf('.')
					return dot < 0 || !designatorOf.has(pr.slice(0, dot))
				})
				const okRefs = pinRefs.filter(pr => !missing.includes(pr)).map(resolveRef)
				const style = netSpec.style != null
					? String(netSpec.style)
					: (okRefs.length <= 2 && !isPowerNet(netName) ? 'wire' : 'label')
				const netColor = netSpec.color != null ? String(netSpec.color) : undefined
				const idxs: Array<number> = []
				if (style === 'wire' && okRefs.length === 2) {
					idxs.push(batchItems.length)
					batchItems.push({ type: 'link', pins: okRefs, ...(netColor ? { color: netColor } : {}) })
				}
				else {
					// ≥3 引脚 / 电源类 / 显式 label：每引脚一个 label 项（短桩+标签）
					for (const pr of okRefs) {
						idxs.push(batchItems.length)
						batchItems.push({ type: 'label', pin: pr, net: netName, ...(netColor ? { color: netColor } : {}) })
					}
				}
				netResults.push({
					name: netName,
					style,
					...(style === 'wire' && okRefs.length === 2 ? { wired: okRefs } : { labeled: okRefs }),
					...(netColor ? { color: netColor } : {}),
					...(missing.length ? { missing } : {}),
				})
				netItemIdx.push(idxs)
				if (!okRefs.length)
					failed.push({ net: netName, reason: '全部引脚引用都无法解析（器件放置失败或缺 ref）' })
			}
			// 统一交给 batchWire 执行+审计（逐条收错不中断；NC 引脚被 assertPinConnectable 逐条拒，汇总进 failed）
			let wireAudit: Array<any> = []
			if (batchItems.length) {
				const batchCmd = schematicCommands.find(c => c.name === 'schematic.batchWire')
				if (!batchCmd)
					throw new Error('内部错误：batchWire 未注册')
				const br = await batchCmd.handler({
					items: batchItems,
					continueOnError: true,
					skipAudit: Boolean(params.skipAudit),
				}) as any
				wireAudit = br?.audit ?? []
				// 汇总回 nets 结构（保持对外兼容：name/style/wired/labeled/missing + 结果）
				const itemResults: Array<any> = br?.items ?? []
				for (let i = 0; i < netResults.length; i++) {
					const nr = netResults[i]
					const idxs = netItemIdx[i]
					const itemErrs = idxs.map(ix => itemResults[ix]).filter(r => r && !r.ok)
					const audits = idxs.map(ix => wireAudit.find((a: any) => a.index === ix)).filter(Boolean)
					const auditBad = audits.filter((a: any) => a.pass === false)
					if (itemErrs.length) {
						nr.ok = false
						nr.error = itemErrs.map((r: any) => r.error).join('；')
						for (const r of itemErrs) {
							const it = r.item ?? {}
							failed.push({ net: nr.name, ...(it.pin ? { pin: it.pin } : it.pins ? { pins: it.pins } : {}), reason: r.error })
						}
					}
					else if (auditBad.length) {
						nr.ok = false
						nr.incomplete = auditBad.map((a: any) => a.detail).join('；')
					}
					else if (audits.some((a: any) => a.pass === undefined)) {
						nr.ok = undefined // 审计未能执行（skipAudit 或网表导出失败）
					}
					else if (idxs.length)
						nr.ok = true
				}
			}

			// ---------- ⑤ 收尾自查：DRC 聚合（网表审计已由 batchWire 统一完成）----------
			let audit: Record<string, unknown> | undefined
			if (!params.skipAudit) {
				try {
					const drcRaw = await eda.sch_Drc.check(true, false, true)
					const drcGroups = checkedSchematicDrcEntries(drcRaw)
					const drcTotal = drcGroups.reduce((s: number, e: any) => s + (typeof e?.count === 'number' ? e.count : 1), 0)
					audit = {
						drc: { totalCount: drcTotal, groups: drcGroups, note: '明细见 EDA 输出面板' },
						wireAudit, // batchWire 统一网表审计明细（逐条 pass/detail）
					}
				}
				catch (e: any) {
					audit = { auditError: e?.message ?? String(e), wireAudit }
				}
			}

			return {
				region: { rectId, span, title },
				placed,
				refMap: Object.fromEntries([...designatorOf.entries()]), // 用户 ref → 实际位号（连线按此解析）
				nets: netResults,
				...(failed.length ? { failed } : {}),
				...(audit ?? {}),
			}
		},
	},
	{
		name: 'schematic.setPinNoConnect',
		summary: '给器件引脚打/取消非连接标识（X 标记），用于声明引脚有意悬空，消除悬空引脚 DRC 提示',
		params: [
			{ name: 'componentId', type: 'string', required: true, description: '器件图元 ID' },
			{ name: 'pinNumbers', type: 'array', required: true, description: '引脚编号数组，如 ["3","4","10"]' },
			{ name: 'noConnected', type: 'boolean', description: 'true=打 X（默认），false=取消 X' },
		],
		returns: '{ done: [成功引脚], failed: [未找到引脚] }',
		example: { cmd: 'schematic.setPinNoConnect', params: { componentId: 'xxx', pinNumbers: ['3', '4'] } },
		handler: async (params) => {
			if (!params.componentId)
				throw new Error('缺少参数 componentId')
			if (!Array.isArray(params.pinNumbers) || !params.pinNumbers.length)
				throw new Error('缺少参数 pinNumbers（数组）')
			const noConnected = params.noConnected !== false
			const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(String(params.componentId))
			if (!pins?.length)
				throw new Error('未找到该器件的引脚（请确认已激活原理图图页）')
			const wanted = new Set(params.pinNumbers.map(String))
			const done: Array<string> = []
			const failed: Array<string> = []
			for (const num of wanted) {
				const pin = pins.find(p => String(p.getState_PinNumber?.()) === num)
				if (!pin) {
					failed.push(num)
					continue
				}
				const result = await (eda.sch_PrimitivePin as any).modify(pin, { noConnected })
				if (result === false)
					failed.push(num)
				else
					done.push(num)
			}
			return { done, failed }
		},
	},
	{
		name: 'schematic.getSelection',
		summary: '获取原理图当前选中的图元',
		params: [],
		returns: '选中图元的 primitiveId 列表',
		example: { cmd: 'schematic.getSelection' },
		handler: async () => {
			return await eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId()
		},
	},
	{
		name: 'schematic.save',
		summary: '保存当前原理图',
		params: [],
		returns: '是否保存成功',
		example: { cmd: 'schematic.save' },
		handler: async () => {
			return { saved: await eda.sch_Document.save() }
		},
	},
	{
		name: 'schematic.getAttributes',
		summary: '读取器件/图元的全部属性（位号 Designator、封装、值等）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
		],
		returns: '[{ primitiveId, key, value }]',
		example: { cmd: 'schematic.getAttributes', params: { primitiveId: 'xxx' } },
		handler: async (params) => {
			const compId = String(params.primitiveId)
			const attrIds = await eda.sch_PrimitiveAttribute.getAllPrimitiveId(compId)
			const attrs = await eda.sch_PrimitiveAttribute.get(attrIds)
			return (attrs ?? []).map(a => ({
				primitiveId: safeState<string>(a, 'getState_PrimitiveId'),
				key: safeState<string>(a, 'getState_Key'),
				value: safeState<string>(a, 'getState_Value'),
			}))
		},
	},
	{
		name: 'schematic.setAttribute',
		summary: '修改器件属性（如把位号从 R? 改成 R4：key=Designator）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
			{ name: 'key', type: 'string', required: true, description: '属性名，如 Designator / Value / Footprint' },
			{ name: 'value', type: 'string', required: true, description: '新属性值' },
		],
		returns: '{ key, value }',
		example: { cmd: 'schematic.setAttribute', params: { primitiveId: 'xxx', key: 'Designator', value: 'R4' } },
		handler: async (params) => {
			if (typeof params.primitiveId !== 'string' || !params.primitiveId.trim())
				throw new Error('primitiveId 必须是非空字符串')
			if (typeof params.key !== 'string' || !params.key.trim())
				throw new Error('key 必须是非空字符串')
			if (typeof params.value !== 'string')
				throw new Error('value 必须是字符串；需要清空属性时请显式传空字符串')
			const compId = String(params.primitiveId)
			const key = String(params.key)
			const value = String(params.value)
			const attrIds = await eda.sch_PrimitiveAttribute.getAllPrimitiveId(compId)
			const attrs = await eda.sch_PrimitiveAttribute.get(attrIds)
			const target = (attrs ?? []).find(a => safeState<string>(a, 'getState_Key') === key)
			if (!target)
				throw new Error(`器件 ${compId} 上没有属性 ${key}`)
			const attrId = safeState<string>(target, 'getState_PrimitiveId')
			if (!attrId)
				throw new Error('读取属性图元 ID 失败')
			await eda.sch_PrimitiveAttribute.modify(attrId, { value })
			// 读回验证（官方 modify 假成功前科，0.10.23：成败以读回为准）
			await new Promise(resolve => setTimeout(resolve, 300))
			const back = await eda.sch_PrimitiveAttribute.get(attrId)
			const actual = back ? safeState<string>(back as any, 'getState_Value') : undefined
			const verified = actual != null && actual === value
			if (!verified)
				throw new Error(`属性 ${key} 修改未生效：读回实际为「${actual ?? '(读取失败)'}」，目标「${value}」——官方 modify 假成功，请重试`)
			return { key, value, readback: { value: actual, verified } }
		},
	},
	{
		name: 'schematic.modifyComponent',
		summary: '安全修改器件属性。property 必须明确包含官方全部 14 个字段；缺项或不完整 otherProperty 会在写入前拒绝。',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
			{ name: 'property', type: 'object', required: true, description: '必须含 x,y,rotation,mirror,addIntoBom,addIntoPcb,designator,name,uniqueId,manufacturer,manufacturerId,supplier,supplierId,otherProperty 全部字段' },
		],
		returns: '{ modified, readback: { ..., verified } }',
		example: { cmd: 'schematic.modifyComponent', params: { primitiveId: 'xxx', property: { x: 400, y: 300, rotation: 0, mirror: false, addIntoBom: true, addIntoPcb: true, designator: 'R4', name: 'Resistor', uniqueId: 'uuid', manufacturer: null, manufacturerId: null, supplier: null, supplierId: null, otherProperty: { Resistance: '10k' } } } },
		handler: async (params) => {
			if (typeof params.primitiveId !== 'string' || !params.primitiveId)
				throw new Error('primitiveId 必须是非空字符串')
			return await modifyComponentSafely(eda as any, params.primitiveId, params.property)
		},
	},
	{
		name: 'schematic.moveComponent',
		summary: '安全移动 / 旋转 / 镜像原理图器件，保留并验证全部可读非几何属性',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '器件图元 ID' },
			{ name: 'x', type: 'number', description: '新坐标 X（单位 10mil）' },
			{ name: 'y', type: 'number', description: '新坐标 Y（单位 10mil）' },
			{ name: 'rotation', type: 'number', description: '旋转角度（0/90/180/270）' },
			{ name: 'mirror', type: 'boolean', description: '是否镜像' },
		],
		returns: '{ modified, readback: { ..., verified } }',
		example: { cmd: 'schematic.moveComponent', params: { primitiveId: 'xxx', x: 400, y: 300, rotation: 90 } },
		handler: async (params) => {
			if (typeof params.primitiveId !== 'string' || !params.primitiveId)
				throw new Error('primitiveId 必须是非空字符串')
			const requested: Record<string, unknown> = {}
			for (const field of ['x', 'y', 'rotation', 'mirror']) {
				if (Object.prototype.hasOwnProperty.call(params, field))
					requested[field] = params[field]
			}
			const movement = await moveComponentSafely(eda as any, params.primitiveId, requested)
			return movement
		},
	},
	{
		name: 'schematic.delete',
		summary: '删除原理图图元（器件 / 导线 / 文本 / 网络标签等属性，按 primitiveId，可批量）；先完整预检类型与父子关系，再删后读回验证，区分直接删除、级联删除、原本不存在、仍存在和读回未知。TEXT 通过官方 sch_PrimitiveText.delete 按 ID 删除，并验证完整源码与模型；不确定时只读核验，不回退源码写入。逐项 8s 超时保护、batchSize 分批（默认 10，批间停 300ms）、全局时间预算 100s；不完整结果通过 error.cause.partial 供宏停止后续写入。源码与模型读回不代表关闭重开持久性验证',
		params: [
			{ name: 'primitiveIds', type: 'string[]', required: true, description: '要删除的图元 ID 列表（也兼容单数 primitiveId，自动转数组）' },
			{ name: 'batchSize', type: 'number', description: '分批大小，默认 10：每批之间停 300ms 并记录分批进度。大批删除建议保持默认多次调用，不要一次调大硬跑' },
		],
		returns: '{ taskId, deleted: [...], failed: [...], outcomeBy: { id: directDeleted|cascadeDeleted|notFound|stillExists|unknown }, deletedBy: { id: type }, persistenceVerified?: false, reconciled?, sessionHealth?, probeDocumentUuid?, probeId?, probeStatus?, probeResidue?, batches?, unprocessed?, failedNote? }（TEXT 成功仅确认源码和模型当前读回，附 persistenceVerified:false；源码或模型读回异常保持 unknown 并停止后续写入。发生写操作后有未完成项时以 error.cause.partial=true 保留结果并阻止宏继续写入。健康探针单次创建与单次清理，按 ID+几何读回，清理前复核原文档焦点；只有删除前合法枚举见过探针且删除后合法枚举不含探针才报告 sessionHealth=ok，否则保留证据并报告 inconclusive/degraded）',
		example: { cmd: 'schematic.delete', params: { primitiveIds: ['xxx', 'yyy'] } },
		handler: async (params, ctx) => {
			// 兼容单数 primitiveId（自动转数组）
			const raw = params.primitiveIds ?? params.primitiveId
			const ids = Array.isArray(raw)
				? raw.map(String)
				: raw != null ? [String(raw)] : []
			if (!ids.length)
				throw new Error('缺少参数 primitiveIds（数组）或 primitiveId（单个 ID）')
			const MAX_FUSE_MS = 2147483647
			const requestedFuseMs = params._timeoutMs == null ? 290_000 : Number(params._timeoutMs)
			if (!Number.isFinite(requestedFuseMs) || requestedFuseMs > MAX_FUSE_MS)
				throw new Error(`_timeoutMs 必须是有限数值且不超过 ${MAX_FUSE_MS}ms`)
			const GLOBAL_BUDGET_MS = 100000
			const effectiveDeadlineMs = Math.min(GLOBAL_BUDGET_MS, Math.max(1000, requestedFuseMs))
			const operationStartedAt = performance.now()
			const deadlineExpired = () => performance.now() - operationStartedAt >= effectiveDeadlineMs
			const PER_ITEM_TIMEOUT_MS = 8000
			let stopAfterUncertainWrite = false
			let deadlineStoppedWrites = false
			const uncertainWriteIds = new Set<string>()
			class DeleteItemTimeout extends Error {
				readonly code = 'SCHEMATIC_DELETE_ITEM_TIMEOUT'
				constructor(id: string, stage = 'unknown', sdkSettled = false, elapsedMs = 0, stageElapsedMs = 0) {
					super(`图元 ${id} 单项删除全流程超时（>${PER_ITEM_TIMEOUT_MS / 1000}s；阶段=${stage}，SDK已结束=${sdkSettled}，累计=${Math.round(elapsedMs)}ms，阶段等待=${Math.round(stageElapsedMs)}ms；官方操作可能仍在后台执行）`)
					this.name = 'DeleteItemTimeout'
				}
			}
			class DeleteWriteStopped extends Error {
				readonly code = 'SCHEMATIC_DELETE_WRITE_STOPPED'
			}
			class DeletePostWriteReadbackUnknown extends Error {
				readonly code = 'SCHEMATIC_DELETE_POST_WRITE_READBACK_UNKNOWN'
			}
			const ensureDeleteWriteAllowed = () => {
				if (stopAfterUncertainWrite)
					throw new DeleteWriteStopped('前序写入结果不确定，停止后续删除写入')
				if (deadlineExpired()) {
					deadlineStoppedWrites = true
					stopAfterUncertainWrite = true
					throw new DeleteWriteStopped(`单指令熔断窗口到期（>${effectiveDeadlineMs}ms），停止后续删除写入`)
				}
			}
			const shouldStopDeleteWrites = () => stopAfterUncertainWrite || deadlineExpired()
			// 0.10.42 任务登记（KIMI-EDA-20261002-03）：客户端超时后可凭 taskId 查实时进度/补取结果；
			// 相同 ID 清单的任务仍在跑时直接返回现有进度，不重复执行（防盲重发）
			// 0.10.49：onUpdate 心跳——任务进度每次更新都推给代理，重置其超时计时器
			const { task, existing } = beginTask('schematic.delete', { primitiveIds: [...ids].sort() },
				ctx && ((t) => ctx.onProgress?.({ taskId: t.id, state: t.state, ...t.progress })))
			if (existing)
				return {
					taskId: task.id,
					alreadyRunning: true,
					state: task.state,
					progress: task.progress,
					note: '相同删除任务仍在后台执行——这是实时进度，用 task.get 继续查询即可，不要重发（重发不会重复执行）',
				}
			try {
			// 官方 delete 对不匹配的 ID 也可能返回 true（假成功），
			// 必须先按 getAllPrimitiveId 成员判定识别真实类型，删后再次读回验证
			const kinds: Array<{
				type: string
				list: () => Promise<Array<string>>
				del: (list: Array<string>, beforeWrite: () => void) => Promise<boolean>
			}> = [
				{ type: 'component', list: () => eda.sch_PrimitiveComponent.getAllPrimitiveId(), del: list => eda.sch_PrimitiveComponent.delete(list) },
				{ type: 'wire', list: () => eda.sch_PrimitiveWire.getAllPrimitiveId(), del: list => eda.sch_PrimitiveWire.delete(list) },
				// TEXT 删除走官方 typed API；每个 ID 都以最新源码和模型快照预检，并在写后双读回。
				{ type: 'text', list: () => eda.sch_PrimitiveText.getAllPrimitiveId(), del: async ([id], beforeWrite) => {
					const result = await deleteTextFromSourceSnapshot([id], {
						beforeWrite,
						shouldStop: shouldStopDeleteWrites,
						timeoutMs: effectiveDeadlineMs,
						onWriteStart: () => { writeAttempted = true },
					})
					if (!result.deleted.includes(id))
						throw new Error(`TEXT ${id} 未从官方 typed delete 删除（状态=${result.skipped.includes(id) ? '原本不存在' : '未知'}）`)
					return true
				} },
				{ type: 'rectangle', list: () => eda.sch_PrimitiveRectangle.getAllPrimitiveId(), del: list => eda.sch_PrimitiveRectangle.delete(list) },
				// 属性（网络标签等）：官方没有类级 delete，必须 get 到实例后调实例方法 delete()
				{ type: 'attribute', list: () => eda.sch_PrimitiveAttribute.getAllPrimitiveId(), del: async (list, beforeWrite) => {
					let any = false
					for (const id of list) {
						try {
							const attr = await eda.sch_PrimitiveAttribute.get(id)
							if (attr && typeof (attr as any).delete === 'function') {
								beforeWrite()
								await (attr as any).delete()
								any = true
							}
						}
						catch (e) {
							if (shouldStopDeleteWrites())
								throw e
							/* 单个失败继续 */
						}
					}
					return any
				} },
			]
			type DeletePresence = { state: 'present', kind: (typeof kinds)[number] } | { state: 'missing' } | { state: 'unknown', reason: string }
			const readPresence = async (id: string): Promise<DeletePresence> => {
				const errors: string[] = []
				for (const kind of kinds) {
					try {
						const listed = await withTimeout(kind.list(), PER_ITEM_TIMEOUT_MS, `删除前后读回 ${kind.type}`)
						if (!Array.isArray(listed))
							throw new Error(`${kind.type} 清单不是数组`)
						if (listed.map(String).includes(id))
							return { state: 'present', kind }
					}
					catch (e: any) {
						errors.push(`${kind.type}: ${String(e?.message ?? e)}`)
					}
				}
				try {
					if ((await withTimeout(scanFloatingNetLabels(), PER_ITEM_TIMEOUT_MS, '浮标源码扫描')).some(f => String(f.primitiveId) === id))
						return { state: 'present', kind: { type: 'floatingAttribute', list: async () => [], del: async () => false } }
				}
				catch (e: any) {
					errors.push(`浮标源码扫描: ${String(e?.message ?? e)}`)
				}
				return errors.length ? { state: 'unknown', reason: errors.join('；') } : { state: 'missing' }
			}
			// 先读全体目标和属性父级，再开始写操作；只有所有枚举与浮标扫描都成功，才能把未命中认定为原本不存在。
			const initialById = new Map<string, DeletePresence>()
			const parentByAttribute = new Map<string, string>()
			let parentEvidenceComplete = true
			for (const id of ids) {
				initialById.set(id, await readPresence(id))
			}
			try {
				const attrs = await withTimeout(eda.sch_PrimitiveAttribute.getAll(), PER_ITEM_TIMEOUT_MS, '属性父级读回')
				if (!Array.isArray(attrs))
					throw new Error('属性清单不是数组')
				for (const attr of attrs) {
					const attrId = safeState<string>(attr, 'getState_PrimitiveId')
					const parentId = safeState<string>(attr, 'getState_ParentPrimitiveId')
					if (attrId && parentId)
						parentByAttribute.set(attrId, parentId)
				}
			}
			catch {
				parentEvidenceComplete = false
			}
			for (const id of ids) {
				const initial = initialById.get(id)
				if (initial?.state === 'present' && initial.kind.type === 'attribute' && !parentByAttribute.has(id))
					parentEvidenceComplete = false
			}
			if (!parentEvidenceComplete && ids.some(id => {
				const state = initialById.get(id)
				return state?.state === 'present' && state.kind.type === 'wire'
			})) {
				for (const id of ids) {
					const initial = initialById.get(id)
					if (initial?.state === 'present' && initial.kind.type === 'attribute')
						initialById.set(id, { state: 'unknown', reason: '属性父级读回失败，无法区分独立属性与导线级联属性' })
				}
			}
			const outcomeBy: Record<string, 'directDeleted' | 'cascadeDeleted' | 'notFound' | 'stillExists' | 'unknown'> = {}
			const attempted = new Set<string>()
			let writeAttempted = false
			const targetSet = new Set(ids)
			const pendingCascade = new Set<string>()
			const isKnownWire = (id: string) => {
				const state = initialById.get(id)
				return state?.state === 'present' && state.kind.type === 'wire'
			}
			const deleted: Array<string> = []
			const failed: Array<string> = []
			const deletedBy: Record<string, string> = {}
			let floatDiag: Array<string> | undefined
			// 0.10.23 加固（照抄 pruneFloatingLabels 0.10.12 成熟机制）：
			//  ① 逐项 8s Promise.race 超时熔断——官方 API 偶尔永不 resolve（模态框/卡绘制），超时不拖死整批；
			//  ② 单项状态未知或超时立即停止后续写入；明确读回仍存在的目标会继续处理下一项；
			//  ③ 分批执行（batchSize 默认 10，批间停 300ms），返回分批进度，unprocessed 可再次调用续删；
			//  ④ 全局时间预算 100s：耗尽即停开新项，已累积结果照常返回（部分结果不丢）；
			//  ⑤ 每项成败一律以删后读回为准，不信 delete 布尔返回值（原有机制保留）。
			const batchSize = Math.max(1, Number(params.batchSize) || 10)
			const startedAt = Date.now()
			const batches: Array<{ batch: number, attempted: number, deleted: number, failed: number }> = []
			const diagnostics: Array<string> = []
			const failReason = new Map<string, string>() // 0.10.41：记录每项失败原因，终扫对账排除「从不存在」的 ID
			let circuitBroken = false
			let deadlineStoppedWrites = false
			let budgetExhausted = false
			diag('schematic.delete', 'delete-start', `total=${ids.length}`)
			// 单项删除全流程（类型识别 → 删除 → 读回验证），包 8s 超时熔断
			type DeleteItemProgress = { stage: string, stageStartedAt: number, sdkSettled: boolean, itemStartedAt: number, timedOut: boolean }
			const setItemStage = (progress: DeleteItemProgress, stage: string) => {
				progress.stage = stage
				progress.stageStartedAt = performance.now()
			}
			const ensureItemLive = (id: string, progress: DeleteItemProgress) => {
				if (progress.timedOut)
					throw new DeleteItemTimeout(id, progress.stage, progress.sdkSettled, performance.now() - progress.itemStartedAt, performance.now() - progress.stageStartedAt)
			}
			const deleteOne = async (id: string, progress: DeleteItemProgress): Promise<'directDeleted' | 'cascadePending' | 'notFound' | 'unknown'> => {
				const initial = initialById.get(id)!
				if (initial.state === 'missing')
					return 'notFound'
				if (initial.state === 'unknown')
					return 'unknown'
				const parentId = parentByAttribute.get(id)
				if (parentEvidenceComplete && parentId && targetSet.has(parentId) && isKnownWire(parentId))
					return 'cascadePending'
				const kind = initial.kind
				if (kind.type === 'floatingAttribute') {
					ensureDeleteWriteAllowed()
					writeAttempted = true
					setItemStage(progress, 'floating-source-delete')
					progress.sdkSettled = false
					let r: Awaited<ReturnType<typeof deleteFloatingLabels>>
					try {
						r = await deleteFloatingLabels([id], {
							beforeWrite: ensureDeleteWriteAllowed,
							shouldStop: shouldStopDeleteWrites,
							onTimeout: () => {
								uncertainWriteIds.add(id)
								stopAfterUncertainWrite = true
								outcomeBy[id] = 'unknown'
							},
						})
					}
					finally {
						progress.sdkSettled = true
					}
					ensureItemLive(id, progress)
					if (uncertainWriteIds.has(id))
						return 'unknown'
					if (r.deleted.length) {
						deletedBy[id] = 'floatingAttribute'
						return 'directDeleted'
					}
					floatDiag = r.diagnostics
					outcomeBy[id] = 'stillExists'
					throw new Error('浮空标签删除通道未生效（读回仍在）')
				}
				ensureDeleteWriteAllowed()
				writeAttempted = true
				setItemStage(progress, 'sdk-delete')
				progress.sdkSettled = false
				try {
					await kind.del([id], ensureDeleteWriteAllowed)
				}
				finally {
					progress.sdkSettled = true
				}
				ensureItemLive(id, progress)
				// 删除调用返回后立即读回；仍存在时按原间隔复核（删除布尔值不可信）。
				let verification: DeletePresence = { state: 'unknown', reason: '尚未读回' }
				setItemStage(progress, 'immediate-readback')
				verification = await readPresence(id)
				ensureItemLive(id, progress)
				for (const waitMs of verification.state === 'present' ? [400, 600, 1000] : []) {
					setItemStage(progress, `delayed-readback-${waitMs}ms`)
					await new Promise(resolve => setTimeout(resolve, waitMs))
					ensureItemLive(id, progress)
					verification = await readPresence(id)
					ensureItemLive(id, progress)
					if (verification.state !== 'present')
						break
				}
				if (verification.state === 'unknown') {
					outcomeBy[id] = 'unknown'
					uncertainWriteIds.add(id)
					stopAfterUncertainWrite = true
					throw new Error(`删除后读回未知：${verification.reason}`)
				}
				if (verification.state === 'present') {
					outcomeBy[id] = 'stillExists'
					// 0.10.26（终验实锤：drawWire 命名自动落的 NET 属性标签删不掉，用户误以为 delete 失灵）——属性类给明确处置指引
					if (kind.type === 'attribute')
						throw new Error('属性图元官方不支持单独删除（pro-api-types 标注 @internal，导线持有的 NET/Name 属性随父导线存亡）——要消除这个标签请删整根父导线后重画（drawWire 不传 net 画无名线 + 需要时 placeNetLabel 补标签）')
					throw new Error('删后读回验证仍在（假成功）')
				}
				deletedBy[id] = kind.type
				return 'directDeleted'
			}
			for (let bi = 0; bi < ids.length; bi += batchSize) {
				if (circuitBroken || budgetExhausted || stopAfterUncertainWrite)
					break
				if (bi > 0)
					await new Promise(resolve => setTimeout(resolve, 300)) // 批间停顿，给官方编辑器喘息
				const batch = ids.slice(bi, bi + batchSize)
				let bDeleted = 0
				let bFailed = 0
				for (const id of batch) {
					if (circuitBroken || stopAfterUncertainWrite)
						break
					if (Date.now() - startedAt > GLOBAL_BUDGET_MS) {
						budgetExhausted = true
						diagnostics.push(`全局时间预算耗尽（>${GLOBAL_BUDGET_MS / 1000}s），停止开新项，已累积结果照常返回；剩余 ID 请再次调用本指令续删`)
						break
					}
					if (deadlineExpired()) {
						deadlineStoppedWrites = true
						budgetExhausted = true
						diagnostics.push(`单指令熔断窗口到期（>${effectiveDeadlineMs}ms），停止开新项`)
						break
					}
					attempted.add(id)
					let itemError: string | undefined
					let itemTimeout: ReturnType<typeof setTimeout> | undefined
					const itemStartedAt = performance.now()
					const progress: DeleteItemProgress = { stage: 'starting', stageStartedAt: itemStartedAt, sdkSettled: true, itemStartedAt, timedOut: false }
					try {
						const outcome = await Promise.race([
							deleteOne(id, progress),
							new Promise((_, reject) => { itemTimeout = setTimeout(() => {
								progress.timedOut = true
								uncertainWriteIds.add(id)
								stopAfterUncertainWrite = true
								outcomeBy[id] = 'unknown'
								const elapsedMs = performance.now() - itemStartedAt
								const stageElapsedMs = performance.now() - progress.stageStartedAt
								diag('schematic.delete', 'item-timeout', `${id}: stage=${progress.stage} sdkSettled=${progress.sdkSettled} elapsedMs=${Math.round(elapsedMs)} stageElapsedMs=${Math.round(stageElapsedMs)}`)
								reject(new DeleteItemTimeout(id, progress.stage, progress.sdkSettled, elapsedMs, stageElapsedMs))
							}, PER_ITEM_TIMEOUT_MS) }),
						]) as Awaited<ReturnType<typeof deleteOne>>
						if (outcome === 'directDeleted') {
							outcomeBy[id] = 'directDeleted'
							deleted.push(id)
							bDeleted++
						}
					else if (outcome === 'cascadePending')
						pendingCascade.add(id)
					else {
						outcomeBy[id] = outcome
						failed.push(id)
						bFailed++
					}
					}
					catch (e: any) {
						itemError = String(e?.message ?? e)
						failReason.set(id, itemError)
						diag('schematic.delete', 'item-failed', `${id}: ${itemError}`)
						failed.push(id)
						bFailed++
						outcomeBy[id] ??= 'unknown'
						if (e instanceof DeleteItemTimeout || e instanceof DeleteWriteStopped || e instanceof DeletePostWriteReadbackUnknown || e?.cause?.partial === true) {
							uncertainWriteIds.add(id)
							stopAfterUncertainWrite = true
							circuitBroken = true
							outcomeBy[id] = 'unknown'
							if (e instanceof DeleteItemTimeout)
								diagnostics.push(`单项删除超时（${itemError}）后立即停止后续写入；原官方调用可能仍在后台执行`)
							else
								diagnostics.push(`单项删除写入或读回状态未确认（${itemError}），立即停止后续写入`)
						}
						diagnostics.push(`${id}: ${itemError}`)
					}
					finally {
						if (itemTimeout !== undefined)
							clearTimeout(itemTimeout)
					}
				}
				batches.push({ batch: batches.length + 1, attempted: batch.length, deleted: bDeleted, failed: bFailed })
				taskProgress(task, { stage: 'deleting', batches: [...batches], deleted: [...deleted], failed: [...failed], remaining: ids.length - attempted.size })
				diag('schematic.delete', 'batch-done', `第${batches.length}批 尝试${batch.length} 成${bDeleted} 败${bFailed} 熔断=${circuitBroken} 预算尽=${budgetExhausted}`)
			}
			const unprocessed = ids.filter(id => !attempted.has(id))
			// 0.10.25 终扫对账（0.10.24 装机实锤：4 个报「超时失败」的导线实际被官方后台删掉了——
			// 官方 delete 假超时/后台继续删，failed 口径偏保守）。整批结束（含熔断/预算耗尽路径）后
			// 重新全量枚举一次：已不存在的「失败」项挪到 deleted 并注明；仍存在的保留 failed 附 resumeNote
			// 0.10.41 口径修复：失败原因是「图元不存在/类型不支持」的 ID 从不存在，终扫必然查不到——
			// 不能当成「后台已删」对账进 deleted（0.10.40 装机实测：假 ID 被误挪），保持 failed 原样
			const reconciled: Array<{ id: string, note: string }> = []
			if (failed.length || pendingCascade.size) {
				taskProgress(task, { stage: 'final-sweep' })
				diag('schematic.delete', 'final-sweep-start', `failed=${failed.length} cascadeCandidates=${pendingCascade.size}`)
				await new Promise(resolve => setTimeout(resolve, 1500))
				const finalById = new Map<string, DeletePresence>()
				for (const id of new Set([...failed, ...pendingCascade]))
					finalById.set(id, await readPresence(id))
				for (const id of new Set([...failed, ...pendingCascade])) {
					if (uncertainWriteIds.has(id)) {
						outcomeBy[id] = 'unknown'
						if (!failed.includes(id))
							failed.push(id)
						continue
					}
					const initial = initialById.get(id)!
					const final = finalById.get(id)!
					const parentId = parentByAttribute.get(id)
					if (initial.state === 'missing') {
						outcomeBy[id] = 'notFound'
						if (!failed.includes(id))
							failed.push(id)
						continue
					}
					if (initial.state === 'unknown' || final.state === 'unknown') {
						outcomeBy[id] = 'unknown'
						if (!failed.includes(id))
							failed.push(id)
						continue
					}
					if (final.state === 'present') {
						outcomeBy[id] = 'stillExists'
						if (!failed.includes(id))
							failed.push(id)
						continue
					}
					const parentWasDeleted = Boolean(parentId && targetSet.has(parentId) && parentEvidenceComplete && isKnownWire(parentId) && (outcomeBy[parentId] === 'directDeleted' || outcomeBy[parentId] === 'cascadeDeleted' || finalById.get(parentId)?.state === 'missing'))
					if (parentWasDeleted) {
						outcomeBy[id] = 'cascadeDeleted'
						deletedBy[id] = 'attribute'
						if (!deleted.includes(id))
							deleted.push(id)
					}
					else if (attempted.has(id)) {
						outcomeBy[id] = 'directDeleted'
						deletedBy[id] = initial.kind.type
						if (!deleted.includes(id))
							deleted.push(id)
						if (failed.includes(id))
							reconciled.push({ id, note: '终扫完整读回确认已删除' })
					}
					else {
						outcomeBy[id] = 'unknown'
						if (!failed.includes(id))
							failed.push(id)
						continue
					}
					if (failed.includes(id))
						failed.splice(failed.indexOf(id), 1)
				}
				if (reconciled.length)
					diagnostics.push(`终扫对账：${reconciled.length} 个原报失败的 ID 经完整读回确认已删除：${reconciled.map(r => r.id).join('、')}`)
			}
			// 0.10.52（KIMI-EDA-20261003-09）：终扫对账后刷新进度——此前 progress 停留在
			// final-sweep 前最后一帧 deleting，对账挪入 deleted 的进度不可见，调用方只见旧数
			taskProgress(task, { stage: 'final-sweep-done', deleted: deleted.length, failed: failed.length, reconciled: reconciled.length })
			diag('schematic.delete', 'final-sweep-done', `deleted=${deleted.length} failed=${failed.length} reconciled=${reconciled.length}`)
			// 健康探针单链执行：创建/删除各一次，不使用内层超时后丢弃的 Promise；ID 立即记录进度。
			// 只有删除前合法枚举见过 ID 且删除后合法枚举不含 ID 才确认清理；未知状态保留 ID 与原文档证据。
			let sessionHealth: 'ok' | 'degraded' | 'inconclusive' | undefined
			let probeResidue: string | undefined
			let probeResidueDetail: { id: string, cleanupAttempts: number, lastError: string } | undefined
			let probeWriteUncertain = false
			let probeDocumentUuid: string | undefined
			let probeId: string | undefined
			let probeError = ''
			let cleanupAttempts = 0
			const stillPresentIds = Object.entries(outcomeBy).filter(([, outcome]) => outcome === 'stillExists').map(([id]) => id)
			if (!deadlineStoppedWrites && deadlineExpired()) {
				deadlineStoppedWrites = true
				diagnostics.push(`单指令熔断窗口到期（>${effectiveDeadlineMs}ms），跳过健康探针写入`)
			}
			if (!stopAfterUncertainWrite && !deadlineStoppedWrites && (reconciled.length || stillPresentIds.length)) {
				taskProgress(task, { stage: 'health-probe' })
				diag('schematic.delete', 'health-probe-start', `reconciled=${reconciled.length} stillExists=${stillPresentIds.length}`)
				let probeWasEnumerated = false
				let probeGeometryVerified = false
				let probeCreateAttempted = false
				const expectedLine = [0, 0, 10, 0]
				const sameLine = (line: unknown) => {
					if (!Array.isArray(line) || line.length < 4)
						return false
					const actual = line.slice(0, 4).map(Number)
					return actual.every(Number.isFinite)
						&& ((actual[0] === expectedLine[0] && actual[1] === expectedLine[1] && actual[2] === expectedLine[2] && actual[3] === expectedLine[3])
							|| (actual[0] === expectedLine[2] && actual[1] === expectedLine[3] && actual[2] === expectedLine[0] && actual[3] === expectedLine[1]))
				}
				try {
					const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo()
					probeDocumentUuid = String(doc?.uuid ?? '') || undefined
					if (doc?.documentType !== 1 || !probeDocumentUuid) {
						sessionHealth = 'inconclusive'
						probeError = `焦点文档信息不完整或不是原理图（documentType=${doc?.documentType ?? '无焦点'}, uuid=${probeDocumentUuid ?? '无'}）`
					}
					else {
						if (deadlineExpired()) {
							deadlineStoppedWrites = true
							throw new Error(`单指令熔断窗口到期（>${effectiveDeadlineMs}ms），跳过健康探针创建`)
						}
						probeCreateAttempted = true
						probeWriteUncertain = true
						diag('schematic.delete', 'probe-create-start', `doc=${probeDocumentUuid} line=${JSON.stringify(expectedLine)}`)
						const probeWire = await eda.sch_PrimitiveWire.create(expectedLine) as any
						probeId = safeState<string>(probeWire, 'getState_PrimitiveId')
						if (!probeId)
							throw new Error('创建调用已返回但未提供探针图元 ID')
						taskProgress(task, { stage: 'health-probe-created', probeDocumentUuid, probeId })
						diag('schematic.delete', 'probe-created', `doc=${probeDocumentUuid} id=${probeId}`)
						for (let check = 1; check <= 3; check++) {
							try {
								const instance = await eda.sch_PrimitiveWire.get(probeId) as any
								const returnedId = instance ? safeState<string>(instance, 'getState_PrimitiveId') : undefined
								const line = instance ? safeState<Array<number>>(instance, 'getState_Line') : undefined
								if (returnedId === probeId && sameLine(line))
									probeGeometryVerified = true
								else
									probeError = '按 ID 读回的探针 ID 或几何不匹配'
							}
							catch (e: any) {
								probeError = `按 ID 读回失败：${String(e?.message ?? e)}`
							}
							try {
								const allIds = await eda.sch_PrimitiveWire.getAllPrimitiveId()
								if (!Array.isArray(allIds))
									throw new Error('导线枚举不是数组')
								if (allIds.map(String).includes(probeId))
									probeWasEnumerated = true
							}
							catch (e: any) {
								probeError = `探针创建后枚举失败：${String(e?.message ?? e)}`
							}
							if (probeGeometryVerified && probeWasEnumerated)
								break
						}
						if (!probeGeometryVerified)
							throw new Error(probeError || '三次按 ID 读回均未确认探针几何')
						const focused = await eda.dmt_SelectControl.getCurrentDocumentInfo()
						if (focused?.documentType !== 1 || String(focused?.uuid ?? '') !== probeDocumentUuid) {
							sessionHealth = 'inconclusive'
							probeError = `清理前焦点已变化，保留探针 ID 不跨页删除（原页=${probeDocumentUuid}, 当前=${String(focused?.uuid ?? '无')})`
						}
						else {
							try {
								const beforeDelete = await eda.sch_PrimitiveWire.getAllPrimitiveId()
								if (!Array.isArray(beforeDelete))
									throw new Error('清理前导线枚举不是数组')
								if (beforeDelete.map(String).includes(probeId))
									probeWasEnumerated = true
							}
							catch (e: any) {
								probeError = `清理前导线枚举失败：${String(e?.message ?? e)}`
							}
							const latestFocus = await eda.dmt_SelectControl.getCurrentDocumentInfo()
							if (latestFocus?.documentType !== 1 || String(latestFocus?.uuid ?? '') !== probeDocumentUuid)
								throw new Error(`删除前焦点文档已变化，停止清理（原页=${probeDocumentUuid}, 当前=${String(latestFocus?.uuid ?? '无')}）`)
							if (deadlineExpired()) {
								deadlineStoppedWrites = true
								throw new Error(`单指令熔断窗口到期（>${effectiveDeadlineMs}ms），跳过健康探针清理`)
							}
							cleanupAttempts = 1
							taskProgress(task, { stage: 'health-probe-cleanup', probeDocumentUuid, probeId, cleanupAttempts, probeWasEnumerated })
							diag('schematic.delete', 'probe-cleanup-start', `doc=${probeDocumentUuid} id=${probeId} enumeratedBefore=${probeWasEnumerated}`)
							try {
								await eda.sch_PrimitiveWire.delete([probeId])
							}
							catch (e: any) {
								probeError = `探针删除调用异常：${String(e?.message ?? e)}`
							}
							let absentAfterDelete = false
							let stillPresentAfterDelete = false
							for (let check = 1; check <= 3; check++) {
								try {
									const left = await eda.sch_PrimitiveWire.getAllPrimitiveId()
									if (!Array.isArray(left))
									throw new Error('清理后导线枚举不是数组')
									if (!left.map(String).includes(probeId))
										absentAfterDelete = true
									else
										stillPresentAfterDelete = true
								}
								catch (e: any) {
									probeError = `清理后读回失败：${String(e?.message ?? e)}`
								}
								if (absentAfterDelete)
									break
							}
							if (probeWasEnumerated && absentAfterDelete) {
								sessionHealth = 'ok'
								probeWriteUncertain = false
								diag('schematic.delete', 'probe-cleaned', `enumeratedBefore=true id=${probeId}`)
							}
							else if (stillPresentAfterDelete) {
								sessionHealth = 'degraded'
								probeError = `清理后完整导线枚举仍含探针 ID（删除前曾枚举=${probeWasEnumerated}）`
							}
							else {
								sessionHealth = 'inconclusive'
								probeError = `探针未能通过“删除前合法枚举含 ID、删除后合法枚举不含 ID”确认清理（此前见到=${probeWasEnumerated}, 删除后缺失读回=${absentAfterDelete}）`
							}
						}
					}
				}
				catch (e: any) {
					sessionHealth = 'inconclusive'
					probeError = String(e?.message ?? e)
				}
				if (sessionHealth !== 'ok') {
					probeWriteUncertain = probeCreateAttempted
					if (sessionHealth === 'degraded' && probeId) {
						probeResidue = probeId
						probeResidueDetail = { id: probeId, cleanupAttempts, lastError: probeError || '探针清理状态未知' }
					}
					diagnostics.push(`会话健康探针状态=${sessionHealth}（${probeError || '未知'}）${probeId ? `，ID=${probeId}` : ''}${probeResidue ? '；合法读回确认探针仍存在' : '；未确认探针仍存在，不报告残留'}`)
				}
				diag('schematic.delete', 'health-probe-done', `sessionHealth=${sessionHealth} doc=${probeDocumentUuid ?? 'unknown'} id=${probeId ?? 'unknown'}`)
			}
			if (!deadlineStoppedWrites && deadlineExpired()) {
				deadlineStoppedWrites = true
				diagnostics.push(`单指令熔断窗口在健康探针完成后到期（>${effectiveDeadlineMs}ms），保留 partial 结果并停止后续宏步骤`)
			}
			if (!deleted.length && failed.length)
				diagnostics.push('没有图元被确认删除；请依据 outcomeBy 区分原本不存在、仍存在或读回未知，不要把未知当作成功')
			const deleteResult = {
				deleted,
				failed,
				outcomeBy,
				deletedBy,
				...(Object.values(deletedBy).includes('text') ? { persistenceVerified: false } : {}),
				...(reconciled.length ? { reconciled } : {}),
				...(sessionHealth ? { sessionHealth } : {}),
				...(sessionHealth === 'degraded' ? {
					warning: '🛑 健康探针删除后仍有完整枚举证明探针存在，或探针状态未能确认；请按 probeResidue/probeResidueDetail 里的原文档 UUID 与 ID 只读复核后再继续写入',
				} : {}),
				...(sessionHealth === 'inconclusive' ? {
					note: '会话健康探针未能得出可信结论（inconclusive，见 diagnostics）；删除项以 outcomeBy 分类，unknown/unprocessed 项仍未确认',
				} : {}),
				...(probeResidue ? { probeResidue } : {}),
				...(probeResidueDetail ? { probeResidueDetail } : {}),
				...(sessionHealth ? { probeDocumentUuid, probeId, probeCleanupAttempts: cleanupAttempts, probeStatus: sessionHealth === 'ok' ? 'cleaned' : 'unconfirmed' } : {}),
				...(batches.length > 1 ? { batches } : {}),
				...(unprocessed.length ? {
					unprocessed,
					resumeNote: `有 ${unprocessed.length} 个图元因熔断/时间预算未轮到处理——确认 EDA 会话健康后再次调用本指令即可接着删（已删的不会重复）`,
				} : {}),
				...(stillPresentIds.length ? {
					failedNote: `${stillPresentIds.length} 个图元经完整读回确认仍存在——确认会话健康后再次调用本指令续删：${stillPresentIds.join('、')}`,
				} : {}),
				...(diagnostics.length ? { diagnostics } : {}),
				...(floatDiag?.length ? { floatDiagnostics: floatDiag } : {}),
			}
			if (failed.length || unprocessed.length || probeWriteUncertain || deadlineStoppedWrites) {
				const error = new Error(`删除结果包含未完成项：deleted=${deleted.length} failed=${failed.length} unprocessed=${unprocessed.length}（分类：${JSON.stringify(outcomeBy)}）`)
				;(error as any).cause = writeAttempted || probeWriteUncertain
					? { partial: true, taskId: task.id, result: deleteResult }
					: { taskId: task.id, result: deleteResult }
				throw error
			}
			finishTask(task, deleteResult)
			return { taskId: task.id, ...deleteResult }
			}
			catch (e) {
				failTask(task, e)
				throw e
			}
		},
	},
	{
		name: 'schematic.placeNetLabel',
		summary: '在导线旁边放置网络标签（信号网络收尾用），放置后自动验证电气附着（附着的可靠位置是导线自由端/短桩末端）。注意：标签是贴在导线【边上】而不是压在线上——锚点坐标取导线线段上的点，文字本体自动让开；直接压线体会被官方拒绝',
		params: [
			{ name: 'net', type: 'string', required: true, description: '网络名，如 NRST、SWDIO' },
			{ name: 'x', type: 'number', required: true, description: '锚点 X（导线线段上的点）' },
			{ name: 'y', type: 'number', required: true, description: '锚点 Y' },
			{ name: 'noVerify', type: 'boolean', description: '跳过附着验证（默认 false）' },
			{ name: 'force', type: 'boolean', description: '跳过"附近导线已同名"防呆检查（默认 false；0.10.0 起同名重复放置会被拒绝）' },
			{ name: 'rotation', type: 'number', description: '标签文字旋转角度（0=正常向右，90/270=竖排方向）。180° 在当前 EDA 中会导致文字上下颠倒，不要将其作为“向左”使用；设置后读回验证，失败在返回里注明' },
		],
		returns: '{ primitiveId, attached: true|false|undefined }（true 经标签属性 ID/父导线与同 ID 属性读回确认；false 表示已确认浮空但保留标签并以 partial 报错；undefined 表示 noVerify 未验证。读取异常或状态不完整按 unknown/partial 报错）',
		example: { cmd: 'schematic.placeNetLabel', params: { net: 'NRST', x: 464, y: 455 } },
		handler: async (params) => {
			if (!params.net || params.x == null || params.y == null)
				throw new Error('缺少参数 net / x / y')
			const net = String(params.net)
			const ax = Number(params.x)
			const ay = Number(params.y)
			const wantRotation = params.rotation != null ? ((Number(params.rotation) % 360) + 360) % 360 : 0
			// 前置防呆（0.10.0）：锚点附近导线已带同名网络名（导线命名属性或已附着的同名标签）时拒绝再放——
			// 同一导线挂两个同名属性会产生"导线有多个网络名"警告，且导线持有的属性官方接口删不掉，
			// 只能删线重画（GPT 实测翻车：短桩已有 STATUS_LED 又放同名标签，删除命令全部无效）
			if (!params.force) {
				const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
				for (const w of wires) {
					if (safeState<string>(w, 'getState_Net') !== net)
						continue
					const line = safeState<Array<number>>(w, 'getState_Line') ?? []
					for (let i = 0; i + 1 < line.length; i += 2) {
						const x1 = line[i]
						const y1 = line[i + 1]
						const x2 = line[i + 2] ?? x1
						const y2 = line[i + 3] ?? y1
						const ddx = Math.max(Math.min(x1, x2) - ax, 0, ax - Math.max(x1, x2))
						const ddy = Math.max(Math.min(y1, y2) - ay, 0, ay - Math.max(y1, y2))
						if (Math.hypot(ddx, ddy) <= 8) {
							const wid = safeState<string>(w, 'getState_PrimitiveId')
							throw new Error(`锚点附近导线（${wid}）已命名为 ${net}，无需再放标签——重复放置会产生"多个网络名"警告且无法删除。确要放请加 force:true`)
						}
					}
				}
			}
			// 官方签名是 createNetLabel(x, y, net)，参数顺序与直觉相反，别搞错。
			// 实测锚点正好压在线体上常被拒绝，偏移 ±2 却能成功且电气附着正常——自动微偏重试
			let label: any
			let labelId: string | undefined
			let ghostAdopted = false
			let usedX = ax
			let usedY = ay
			for (const [dx, dy] of [[0, 0], [0, 2], [0, -2], [2, 0], [-2, 0]] as Array<[number, number]>) {
				label = await withStage('placeNetLabel:createNetLabel', () => (eda.sch_PrimitiveAttribute as any).createNetLabel(ax + dx, ay + dy, net))
				if (label) {
					usedX = ax + dx
					usedY = ay + dy
					break
				}
				// 源头防双份：返回空不代表没创建（官方偶发假失败），确认锚点处真的没标签才换下一个偏移
				const ghost = await findGhostNetLabel(net, ax + dx, ay + dy)
				if (ghost) {
					labelId = ghost.id
					ghostAdopted = true
					usedX = ax + dx
					usedY = ay + dy
					break
				}
			}
			if (!label && !labelId)
				throw new Error('网络标签创建失败：官方返回空（已自动尝试 ±2 微偏）。标签要贴在导线边上而不是压在线上，可把锚点偏移 2~5 个单位再试')
			labelId ??= safeState<string>(label, 'getState_PrimitiveId')
			if (!labelId) {
				const error = new Error('网络标签创建或 ghost 命中但没有可核对的 primitiveId；附着结果未知，标签已保留')
				;(error as any).cause = { partial: true, primitiveId: 'unknown', parentId: 'unknown', usedX, usedY, reason: '标签读回对象未提供 primitiveId' }
				throw error
			}
			// 文字方向（0.10.16）：modify rotation + 读回验证（官方假失败前科，成败以读回为准）
			const labelRotation = labelId && wantRotation ? await applyLabelRotation(labelId, wantRotation) : undefined
			const rotationResult = wantRotation
				? { labelRotation, ...(labelRotation == null ? { rotationNote: `标签旋转 ${wantRotation}° 设置失败（读回不匹配），文字仍为默认朝右` } : {}) }
				: {}
			if (params.noVerify)
				return { primitiveId: labelId, attached: undefined, ...rotationResult, ...(ghostAdopted ? { note: '官方创建接口返回空但标签实际已生成（假失败），已直接采用该标签；attached 未验证' } : {}) }
			// 只核对本次标签 ID 和其父级关系；不以邻近同名导线的网络名传播状态代替附着证据。
			const checkAttached = async (): Promise<{ state: 'attached' | 'floating' | 'unknown', parentId?: string, reason?: string }> => {
				try {
					const attr = await eda.sch_PrimitiveAttribute.get(labelId!) as any
					if (!attr)
						return { state: 'unknown', reason: '按标签 ID 未读到属性' }
					const returnedId = safeState<string>(attr, 'getState_PrimitiveId')
					const key = safeState<string>(attr, 'getState_Key')
					const value = safeState<string>(attr, 'getState_Value')
					const parentId = safeState<string>(attr, 'getState_ParentPrimitiveId')
					if (returnedId !== labelId)
						return { state: 'unknown', parentId, reason: `属性 ID 不匹配（读回 ${returnedId ?? '缺失'}）` }
					if (!/^(NET|Name)$/i.test(key ?? '') || value !== net)
						return { state: 'unknown', parentId, reason: `属性键值不符（key=${key ?? '缺失'}, value=${value ?? '缺失'}）` }
					if (parentId === '$$root')
						return { state: 'floating', parentId, reason: '标签 parentId=$$root，已确认浮空' }
					if (typeof parentId !== 'string' || !parentId.trim())
						return { state: 'unknown', reason: '标签 parentId 缺失或非法' }
					const wire = await eda.sch_PrimitiveWire.get(parentId) as any
					if (!wire || safeState<string>(wire, 'getState_PrimitiveId') !== parentId)
						return { state: 'unknown', parentId, reason: '父导线缺失或 ID 不匹配' }
					const attrs = await eda.sch_PrimitiveAttribute.getAll(parentId) as any
					if (!Array.isArray(attrs))
						return { state: 'unknown', parentId, reason: '父导线属性读回不是数组' }
					const same = attrs.find((item: any) => safeState<string>(item, 'getState_PrimitiveId') === labelId)
					if (!same)
						return { state: 'unknown', parentId, reason: '父导线属性读回缺少本标签 ID' }
					const sameKey = safeState<string>(same, 'getState_Key')
					const sameValue = safeState<string>(same, 'getState_Value')
					const sameParent = safeState<string>(same, 'getState_ParentPrimitiveId')
					if (!/^(NET|Name)$/i.test(sameKey ?? '') || sameValue !== net || sameParent !== parentId)
						return { state: 'unknown', parentId, reason: `父导线属性与标签读回不一致（key=${sameKey ?? '缺失'}, value=${sameValue ?? '缺失'}, parentId=${sameParent ?? '缺失'}）` }
					return { state: 'attached', parentId }
				}
				catch (error: any) {
					return { state: 'unknown', reason: `附着读回异常：${String(error?.message ?? error)}` }
				}
			}
			let lastFloating: { parentId?: string, reason?: string } | undefined
			for (let attempt = 0; attempt < 3; attempt++) {
				if (attempt > 0)
					await new Promise(resolve => setTimeout(resolve, 500))
				const checked = await checkAttached()
				if (checked.state === 'attached')
					return { primitiveId: labelId, attached: true, wireId: checked.parentId, ...rotationResult, ...(ghostAdopted ? { note: '官方创建接口返回空但标签实际已生成（假失败），已直接采用该标签' } : {}) }
				if (checked.state === 'unknown') {
					const error = new Error(`网络标签附着状态未知：${checked.reason ?? '读回证据不完整'}`)
					;(error as any).cause = { partial: true, primitiveId: labelId, parentId: checked.parentId ?? 'unknown', usedX, usedY, reason: checked.reason ?? '读回证据不完整' }
					throw error
				}
				lastFloating = checked
			}
			const reason = lastFloating?.reason ?? '连续三次读回确认 parentId=$$root'
			const error = new Error(`标签未电气附着（primitiveId=${labelId}, 锚点 ${usedX},${usedY}, ${reason}）。标签已保留未删除，请按需用 schematic.moveLabel 调整或 schematic.delete 删除`)
			;(error as any).cause = { partial: true, primitiveId: labelId, parentId: lastFloating?.parentId, usedX, usedY, reason }
			throw error
		},
	},
	{
		name: 'schematic.listNetLabels',
		summary: '列出全部网络标签（导线 NET/Name 属性 + 浮空标签），含附着状态与颜色——0.10.46 起查标签一律用本指令（listLabels 已删：它不返回导线网络属性，实测 891 条里无 NET 键），排查"网络标签没有连接导线"类 DRC 信息、按网名查标签残留时用',
		params: [
			{ name: 'net', type: 'string', description: '按网络名过滤，留空为全部' },
		],
		returns: '[{ primitiveId, net, x, y, color, rotation?, attached, wireId }]（attached=false 即浮空标签，DRC 会报"没有连接导线或总线"；rotation 为宿主读回角度，180° 在当前 EDA 中会导致文字上下颠倒）',
		example: { cmd: 'schematic.listNetLabels', params: { net: 'GND' } },
		handler: async (params) => {
			return collectNetLabels(params.net ? String(params.net) : undefined)
		},
	},
	{
		name: 'schematic.pruneFloatingLabels',
		summary: '【宏】一键清理浮空网络标签：扫描全页 attached=false 的标签（附着失败残留、导线被删后留下的孤儿标签，DRC"网络标签没有连接导线或总线"的来源），dryRun 预览（含每个浮标的世界坐标，方便查看）或直接删除。删除主通道为「借尸还魂」（建临时导线→modify 浮标 parentId 挂上去→删导线级联带走→源码重扫验证）。逐项超时保护、分批执行（batchSize 默认 5、批间停 300ms、返回分批进度）、全局时间预算耗尽即停且累积 diagnostics 不丢、回滚顺序修正（删临时导线失败先把 parentId 改回 $$root 再重试删线，避免留下删不掉的"持属性无名导线"孤儿）。文档源码改写通道默认禁用，仅显式 allowSourceRewrite:true 才执行；全失败时返回 manualDelete 世界坐标清单',
		params: [
			{ name: 'dryRun', type: 'boolean', description: '只列出浮空标签不删除（默认 false 直接删）；返回每个浮标的世界坐标（Y 已翻转为 API 坐标），方便手动框选删除兜底' },
			{ name: 'batchSize', type: 'number', description: '分批大小，默认 5：每批之间停 300ms 并记录分批进度。大批浮标建议保持默认多次调用，不要一次调大硬跑（0.10.11 实测连续高频创建临时导线会拖垮编辑器会话）' },
			{ name: 'allowSourceRewrite', type: 'boolean', description: '⚠️ 最后手段：允许「文档源码改写」删除通道（默认 false 禁用）。0.10.10 实机事故：该通道曾被官方运行时校验判"数据格式不对"弹窗拒绝——仅在借尸还魂通道失败且工程已保存时才显式传 true' },
		],
		returns: '{ floating: [{ primitiveId, net, x, y, worldX, worldY }], deleted, failed, unprocessed?, batches?, method, diagnostics, warning?, dryRun }（全失败时附 manualDelete 手动框选指引；unprocessed 为熔断/预算退出时未轮到的浮标，再次调用接着删）',
		example: { cmd: 'schematic.pruneFloatingLabels', params: { dryRun: true } },
		handler: async (params) => {
			if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean')
				throw new Error('dryRun 必须是布尔值')
			if (params.allowSourceRewrite !== undefined && typeof params.allowSourceRewrite !== 'boolean')
				throw new Error('allowSourceRewrite 必须是布尔值')
			const dryRun = params.dryRun ?? false
			const allowSourceRewrite = params.allowSourceRewrite ?? false
			const batchSize = Math.max(1, Number(params.batchSize) || 5)
			// 浮空标签是官方枚举盲区（getAll 不返回 parentId=$$root 的属性），走文档源码扫描
			const floatingRaw = await scanFloatingNetLabels()
			// 每个浮标附世界坐标（源码 Y 轴与 API 相反，翻转后即为界面/框选坐标），dryRun 也返回方便手动框选兜底
			const floating = floatingRaw.map(f => ({
				...f,
				worldX: f.x,
				worldY: f.y != null ? -f.y : undefined,
			}))
			let deleted: Array<string> = []
			let failed: Array<string> = []
			let method: string | undefined
			let diagnostics: Array<string> | undefined
			let warning: string | undefined
			let batches: Array<{ batch: number, attempted: number, deleted: number, failed: number }> | undefined
			let unprocessed: Array<string> | undefined
			if (!dryRun && floatingRaw.length) {
				const r = await deleteFloatingLabels(floatingRaw.map(f => String(f.primitiveId)), { allowSourceRewrite, batchSize })
				deleted = r.deleted
				failed = r.failed
				method = r.method
				diagnostics = r.diagnostics
				warning = r.warning
				batches = r.batches
				unprocessed = r.unprocessed
			}
			// 手动删除指引：源码 Y 轴与 API/界面相反，框选坐标要翻转 Y
			const failedSet = new Set(failed)
			const manualDelete = failed.length
				? floating.filter(f => failedSet.has(String(f.primitiveId))).map(f => ({
					primitiveId: f.primitiveId,
					net: f.net,
					worldX: f.worldX,
					worldY: f.worldY,
				}))
				: undefined
			return {
				floating,
				deleted,
				failed,
				dryRun,
				...(method ? { method } : {}),
				...(diagnostics?.length ? { diagnostics } : {}),
				...(warning ? { warning } : {}),
				...(batches?.length ? { batches } : {}),
				...(unprocessed?.length ? {
					unprocessed,
					resumeNote: `有 ${unprocessed.length} 个浮标因熔断/时间预算未轮到处理——确认 EDA 会话健康后再次调用本指令即可接着删（已删的不会重复）`,
				} : {}),
				...(manualDelete ? {
					manualDelete,
					note: `有 ${failed.length} 个浮标所有删除通道均无效（已读回验证）。官方实锤：属性图元 delete 接口标注"不会有任何效果"（pro-api-types @internal），父图元是 $$root 又无父可删。请在 EDA 里按 manualDelete 的世界坐标（Y 已翻转）框选手动删除；或不保存工程直接关页丢弃`,
				} : {}),
			}
		},
	},
	{
		name: 'schematic.fixNetLabels',
		summary: '【宏·全科体检】一条命令修复全部网络标签问题（0.10.17，替代 fixMirroredLabels）：① 浮空标签（没附着导线）→ 走浮标删除通道清除；② 重复标签（同一短桩/导线上同网名 >1 个，或同网名锚点间距 <10）→ 保留位置正确的一个，其余清除；③ 方向/反字（rotation 命中 angle，默认 180——⚠️ 镜像标志不入源码，只能按旋转角识别）→ 原地 rotation→0 读回验证，改不动走「删短桩级联→labelWire 重放（自动朝外）」；④ 位置不对（锚点距所属导线本体 >20=不在线上、电气虚附着；或导线越位=导线越过 rotation 0 标签文字右缘 5~40 且戳出端点悬空无引脚，0.10.18 新增）→ moveLabel 挪到导线端点/外端（右缘对齐），挪不动走删重放兜底。dryRun 默认 true 只出分类体检报告（符合不越权原则），人工/AI 确认后 dryRun:false 真修，逐条收错。修完自动 pruneFloatingLabels dryRun 复核剩余',
		params: [
			{ name: 'dryRun', type: 'boolean', description: '只扫描出分类体检报告（默认 true）；false 才真修' },
			{ name: 'angle', type: 'number', description: '方向嫌疑旋转角（默认 180；竖排侧字传 90/270）。⚠️ 0.10.16 起 labelWire 合法使用 180 朝外，修复前请人工核对清单' },
			{ name: 'net', type: 'string', description: '只处理指定网络的标签' },
		],
		returns: '{ floating, duplicates, rotationSuspects, misplaced（dryRun 体检四类清单，每条带 id/net/世界坐标/问题/建议）, fixed, pruned, failed, remaining, dryRun }',
		example: { cmd: 'schematic.fixNetLabels', params: { dryRun: true } },
		handler: async (params) => {
			if (params.dryRun !== undefined && typeof params.dryRun !== 'boolean')
				throw new Error('dryRun 必须是布尔值')
			const dryRun = params.dryRun ?? true
			const angle = ((Number(params.angle ?? 180) % 360) + 360) % 360
			const netFilter = params.net != null ? String(params.net) : undefined
			const { labels, wireLines } = await scanNetLabelAttrsFromSource()
			// 统一转世界坐标（源码 Y 与 API 相反，翻转）
			interface Item { id: string, net: string, wx?: number, wy?: number, rotation?: number, attached: boolean, wireId?: string }
			const items: Array<Item> = labels
				.filter(l => !netFilter || l.net === netFilter)
				.map(l => ({
					id: l.primitiveId,
					net: l.net,
					wx: l.x,
					wy: l.y != null ? -l.y : undefined,
					rotation: l.rotation,
					attached: l.parentId != null && l.parentId !== '$$root',
					wireId: l.parentId != null && l.parentId !== '$$root' ? l.parentId : undefined,
				}))
			const card = (it: Item, issue: string, suggestion: string) => ({
				primitiveId: it.id, net: it.net, worldX: it.wx, worldY: it.wy,
				...(it.rotation != null ? { rotation: it.rotation } : {}),
				attached: it.attached, ...(it.wireId ? { wireId: it.wireId } : {}),
				issue, suggestion,
			})
			// ---------- 分类体检 ----------
			// ① 浮空
			const floatingItems = items.filter(i => !i.attached)
			const floating = floatingItems.map(i => card(i, '浮空标签：未附着任何导线（DRC"网络标签没有连接导线或总线"来源）', '真修时走浮标删除通道清除（孤儿不重放）'))
			const floatingIds = new Set(floatingItems.map(i => i.id))
			// 附着标签的导线几何（源码系），端点判定用
			const wireEnds = (wireId?: string): Array<[number, number]> => {
				const segs = wireId ? (wireLines.get(wireId) ?? []) : []
				const ends: Array<[number, number]> = []
				for (const [x1, y1, x2, y2] of segs) {
					ends.push([x1, y1], [x2, y2])
				}
				return ends
			}
			const distToEnds = (it: Item): number => {
				if (it.wx == null || it.wy == null)
					return Infinity
				const sx = it.wx
				const sy = -it.wy // 回源码系
				const ends = wireEnds(it.wireId)
				return ends.length ? Math.min(...ends.map(([ex, ey]) => Math.hypot(ex - sx, ey - sy))) : Infinity
			}
			// 锚点到所属导线线段的最短距离（源码系）。⚠️ 不能用端点距离判位置：
			// 每条导线自带网名显示 ATTR（key=NET）通常挂线中间，端点距离会把它们全误判成位置异常
			const distToWire = (it: Item): number => {
				if (it.wx == null || it.wy == null)
					return 0 // 无坐标无法判定，不误报
				const sx = it.wx
				const sy = -it.wy
				const segs = it.wireId ? (wireLines.get(it.wireId) ?? []) : []
				if (!segs.length)
					return 0
				const pseg = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
					const dx = x2 - x1
					const dy = y2 - y1
					if (dx === 0 && dy === 0)
						return Math.hypot(px - x1, py - y1)
					const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
					return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
				}
				return Math.min(...segs.map(([x1, y1, x2, y2]) => pseg(sx, sy, x1, y1, x2, y2)))
			}
			// ④b 导线越位（0.10.18 新增，0.10.20 按锚点语义修订）：rotation 0 标签附着在水平导线上，
			// 文字右缘 = 锚点 x + 文字宽度；导线越过右缘向外戳出 >5 即越位嫌疑（纯外观缺陷，电气不影响——附着看锚点）。
			// 防误报两道闸：① 越位量 ≤40（超过 40 的是导线自带网名显示挂线头、长线右延属正常，不算）；
			// ② 越位端点若有器件引脚（延伸是 functional 连线）不算越位——只有悬空戳出的线头才算。
			// 返回越位量（>0 表示越位），0 表示不越位/不适用。修复目标锚点 x = 导线外端 − 文字宽度。
			const overhangInfo = (it: Item): { amount: number, endX: number, endY: number } | undefined => {
				if (!it.attached || it.wx == null || it.wy == null)
					return undefined
				const rot = ((it.rotation ?? 0) % 360 + 360) % 360
				if (rot !== 0)
					return undefined // 方向异常标签归方向类处理
				const segs = it.wireId ? (wireLines.get(it.wireId) ?? []) : []
				const horiz = segs.filter(([x1, y1, x2, y2]) => y1 === y2 && x1 !== x2)
				if (!horiz.length)
					return undefined
				const sx = it.wx // 源码系 x 与世界系同向（只 Y 翻转）
				const wireMaxX = Math.max(...horiz.map(([x1, , x2]) => Math.max(x1, x2)))
				const amount = wireMaxX - (sx + estimateLabelWidth(it.net))
				if (amount <= 5 || amount > 40)
					return undefined
				return { amount, endX: wireMaxX, endY: horiz[0][1] } // endY 源码系
			}
			// 越位端点是否落在器件引脚上（有引脚=功能性延伸，不是线头越位）
			const pinAtCache = new Map<string, boolean>()
			const pinAt = async (sx: number, sy: number): Promise<boolean> => {
				if (!pinAtCache.size) {
					const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
					for (const c of comps) {
						const cid = safeState<string>(c, 'getState_PrimitiveId')
						if (!cid)
							continue
						for (const pin of (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(cid)) ?? []) {
							const px = pin.getState_X?.()
							const py = pin.getState_Y?.()
							if (px != null && py != null)
								pinAtCache.set(`${Math.round(px)},${Math.round(-py)}`, true) // 世界系→源码系 Y 翻转
						}
					}
				}
				for (const key of pinAtCache.keys()) {
					const [px, py] = key.split(',').map(Number)
					if (Math.hypot(px - sx, py - sy) <= 8)
						return true
				}
				return false
			}
			const overhangSuspectIds = new Set<string>()
			for (const it of items) {
				const oh = overhangInfo(it)
				if (oh && !(await pinAt(oh.endX, oh.endY)))
					overhangSuspectIds.add(it.id)
			}
			const isMisplaced = (it: Item): boolean =>
				it.attached && !dupIds.has(it.id) && (distToWire(it) > 20 || overhangSuspectIds.has(it.id))
			// ② 重复：同一导线上同网名 >1 个；或同网名锚点间距 <10（世界系）
			const dupIds = new Set<string>()
			const byWireNet = new Map<string, Array<Item>>()
			for (const it of items.filter(i => i.attached)) {
				const k = `${it.wireId}|${it.net}`
				const arr = byWireNet.get(k) ?? []
				arr.push(it)
				byWireNet.set(k, arr)
			}
			for (const arr of byWireNet.values()) {
				if (arr.length > 1) {
					// 保留离导线端点最近的一个，其余标重复
					const sorted = [...arr].sort((a, b) => distToEnds(a) - distToEnds(b))
					for (const it of sorted.slice(1))
						dupIds.add(it.id)
				}
			}
			const attachedNonDup = items.filter(i => i.attached && !dupIds.has(i.id))
			for (let i = 0; i < attachedNonDup.length; i++) {
				for (let j = i + 1; j < attachedNonDup.length; j++) {
					const a = attachedNonDup[i]
					const b = attachedNonDup[j]
					if (a.net !== b.net || a.wx == null || b.wx == null || a.wy == null || b.wy == null)
						continue
					if (Math.hypot(a.wx - b.wx, a.wy - b.wy) < 10) {
						// 间距过近视为重复：保留离各自导线端点更近的
							dupIds.add((distToEnds(a) <= distToEnds(b) ? b : a).id)
					}
				}
			}
			const duplicates = items.filter(i => dupIds.has(i.id)).map(i => card(i, '重复标签：同一导线/同网名间距 <10 有多个', '真修时清除多余者（短桩场景删桩重放一个）'))
			// ③ 方向/反字嫌疑
			const rotationSuspects = items
				.filter(i => i.rotation != null && ((i.rotation % 360) + 360) % 360 === angle)
				.map(i => card(i, `方向嫌疑：rotation=${angle}（可能是镜像/旋转导致的反字侧字；也可能是 labelWire 合法朝外，请人工核对）`, '真修时原地转正 rotation→0（读回验证），改不动删桩重放'))
			// ④ 位置不对：锚点距所属导线本体 >20（不在线上），或导线越位（越过 rotation 0 标签文字右缘 5~40 且端点悬空无引脚）
			const misplaced = items
				.filter(i => isMisplaced(i))
				.map(i => overhangSuspectIds.has(i.id)
					? card(i, `导线越位：导线越过标签文字右缘向外戳出 ${Math.round(overhangInfo(i)?.amount ?? 0)}（端点悬空无引脚；戳出的线头露在文字外，属外观缺陷）`, '真修时把标签沿导线平移到导线外端（右缘对齐端点），moveLabel 读回验证，失败删桩重放')
					: card(i, '位置异常：锚点距所属导线 >20（不在线上，可能电气虚附着）', '真修时 moveLabel 挪到最近导线端点，挪不动删桩重放'))
			if (dryRun) {
				return {
					floating, duplicates, rotationSuspects, misplaced,
					dryRun: true,
					total: floating.length + duplicates.length + rotationSuspects.length + misplaced.length,
					note: '体检报告（未动任何图元）。确认分类无误后 dryRun:false 真修；可用 net 参数缩小范围。⚠️ 镜像标志不入源码，方向类按旋转角识别，rotationSuspects 里可能含 labelWire 合法朝外标签，请核对',
				}
			}
			// ---------- 真修 ----------
			const fixed: Array<string> = []
			const pruned: Array<string> = []
			const failed: Array<Record<string, unknown>> = []
			const handled = new Set<string>()
			const replayedWires = new Set<string>()
			// 删桩重放兜底（共享）：删导线级联删标签 → 远端引脚 labelWire 重放；找不到引脚 placeNetLabel 原地重放
			const replay = async (it: Item): Promise<void> => {
				const segs = it.wireId ? (wireLines.get(it.wireId) ?? []) : []
				if (!segs.length)
					throw new Error('源码中找不到所属导线几何，无法重放')
				const ax = it.wx ?? 0
				const ay = it.wy ?? 0
				// 归属引脚 = 导线端点中离标签锚点较远的那个（源码→世界系 Y 翻转后匹配）
				const ends: Array<[number, number]> = []
				for (const [x1, y1, x2, y2] of segs)
					ends.push([x1, -y1], [x2, -y2])
				ends.sort((p, q) => Math.hypot(q[0] - ax, q[1] - ay) - Math.hypot(p[0] - ax, p[1] - ay))
				const [px, py] = ends[0]
				let pinRef: string | undefined
				const comps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
				for (const c of comps) {
					const des = safeState<string>(c, 'getState_Designator')
					const cid = safeState<string>(c, 'getState_PrimitiveId')
					if (!des || !cid)
						continue
					for (const pin of (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(cid)) ?? []) {
						const ppx = pin.getState_X?.()
						const ppy = pin.getState_Y?.()
						if (ppx != null && ppy != null && Math.hypot(ppx - px, ppy - py) <= 8) {
							pinRef = `${des}.${pin.getState_PinNumber?.()}`
							break
						}
					}
					if (pinRef)
						break
				}
				if (!replayedWires.has(String(it.wireId))) {
					// 0.10.65 修复：改走 schematic.delete 受保护通道（逐项超时熔断+删后读回+终扫对账）。
					// 此前裸调官方 sch_PrimitiveWire.delete：官方假失败时旧线残留，随后 labelWire/placeNetLabel
					// 会在同一根线上再放一个标签——亲手制造"一根线多个网络名"（正是本指令要修的病）；
					// 官方挂起则整条指令无墙钟保护。
					// 复审补强（0.10.65）：replayedWires 登记必须在删除确认之后——登记在前时，
					// 删除未确认的后续重复项会跳过删除分支直接放标签，在残留旧线上叠标签。
					const delCmd = schematicCommands.find(c => c.name === 'schematic.delete')
					if (!delCmd)
						throw new Error('内部错误：schematic.delete 未注册')
					const dr: any = await delCmd.handler({ primitiveIds: [String(it.wireId)] })
					const gone = Array.isArray(dr?.deleted) && dr.deleted.map(String).includes(String(it.wireId))
					if (!gone) {
						// 0.10.65 三审修复：早退必须抛错而非 return——调用方 catch 会记 failItem，
						// return 会导致该标签同时进 failed 和 fixed 两个清单（fixed 虚增）
						throw new Error(`所属导线 ${it.wireId} 受保护删除未确认（deleted 清单无它），跳过重放防止同一根线叠两个标签`)
					}
					replayedWires.add(String(it.wireId))
				}
				if (pinRef) {
					const labelCmd = schematicCommands.find(c => c.name === 'schematic.labelWire')
					if (!labelCmd)
						throw new Error('内部错误：labelWire 未注册')
					await labelCmd.handler({ pin: pinRef, net: it.net })
				}
				else {
					const placeCmd = schematicCommands.find(c => c.name === 'schematic.placeNetLabel')
					if (!placeCmd)
						throw new Error('内部错误：placeNetLabel 未注册')
					await placeCmd.handler({ net: it.net, x: ax, y: ay, rotation: 0, force: true })
				}
			}
			const failItem = (it: Item, reason: string) =>
				failed.push({ primitiveId: it.id, net: it.net, worldX: it.wx, worldY: it.wy, reason })
			// ① 浮空 → 浮标删除通道清除（不重放）
			if (floatingItems.length) {
				const r = await deleteFloatingLabels(floatingItems.map(i => i.id))
				pruned.push(...r.deleted)
				for (const fid of r.failed) {
					const it = floatingItems.find(i => i.id === fid)!
					failItem(it, '浮空标签删除失败（所有通道无效），请按坐标手动框选删除')
				}
				floatingItems.forEach(i => handled.add(i.id))
			}
			// ② 重复 → 多余者在短桩上则删桩重放一个；长导线上的重复标签官方删不掉，如实报手工
			for (const it of items.filter(i => dupIds.has(i.id))) {
				if (handled.has(it.id))
					continue
				try {
					const segs = it.wireId ? (wireLines.get(it.wireId) ?? []) : []
					const totalLen = segs.reduce((s, [x1, y1, x2, y2]) => s + Math.hypot(x2 - x1, y2 - y1), 0)
					if (totalLen > 40)
						throw new Error('重复标签挂在长导线上（属性图元官方删不掉），需删线重画——请按坐标人工处置')
					await replay(it)
					fixed.push(it.id)
				}
				catch (e: any) {
					failItem(it, String(e?.message ?? e))
				}
				handled.add(it.id)
			}
			// ③ 方向/反字 → 原地转正读回验证，失败删桩重放
			for (const it of items.filter(i => i.rotation != null && ((i.rotation % 360) + 360) % 360 === angle)) {
				if (handled.has(it.id))
					continue
				try {
					const back = await applyLabelRotation(it.id, 0)
					if (back === 0)
						fixed.push(it.id)
					else if (it.attached) {
						await replay(it)
						fixed.push(it.id)
					}
					else
						throw new Error('原地转正读回不匹配且为浮空标签（已在浮空类处理或未清除）')
				}
				catch (e: any) {
					failItem(it, String(e?.message ?? e))
				}
				handled.add(it.id)
			}
			// ④ 位置不对/导线越位 → moveLabel 挪到目标点（越位：导线外端−文字宽度，右缘对齐；离线：最近端点），读回验证，失败删桩重放
			for (const it of items.filter(i => isMisplaced(i))) {
				if (handled.has(it.id))
					continue
				try {
					const sx = it.wx ?? 0
					const sy = -(it.wy ?? 0)
					let tx: number
					let ty: number
					if (overhangSuspectIds.has(it.id)) {
						// 越位修复：锚点沿导线平移到导线外端 − 文字宽度（源码系 x 与世界系同向）
						const oh = overhangInfo(it)
						if (!oh)
							throw new Error('越位信息缺失')
						tx = oh.endX - estimateLabelWidth(it.net)
						ty = it.wy ?? 0
					}
					else {
						// 最近端点（源码系 → 世界系）
						const ends = wireEnds(it.wireId)
						if (!ends.length)
							throw new Error('找不到所属导线端点')
						ends.sort((p, q) => Math.hypot(p[0] - sx, p[1] - sy) - Math.hypot(q[0] - sx, q[1] - sy))
						tx = ends[0][0]
						ty = -ends[0][1]
					}
					const mv = await eda.sch_PrimitiveAttribute.modify(it.id, { x: tx, y: ty })
					// 读回验证（假失败前科：不信返回值）
					const back = await eda.sch_PrimitiveAttribute.get(it.id)
					const bx = back ? safeState<number>(back, 'getState_X') : undefined
					const by = back ? safeState<number>(back, 'getState_Y') : undefined
					if (mv && bx != null && by != null && Math.hypot(bx - tx, by - ty) <= 2)
						fixed.push(it.id)
					else {
						await replay(it)
						fixed.push(it.id)
					}
				}
				catch (e: any) {
					failItem(it, String(e?.message ?? e))
				}
				handled.add(it.id)
			}
			// ---------- 复核：浮标 dryRun 重扫 ----------
			let remaining: Record<string, unknown> | undefined
			try {
				const pruneCmd = schematicCommands.find(c => c.name === 'schematic.pruneFloatingLabels')
				const pr = pruneCmd ? (await pruneCmd.handler({ dryRun: true })) as any : undefined
				remaining = { floatingLeft: pr?.floating?.length ?? 0, failedLeft: failed.length }
			}
			catch {
				remaining = { floatingLeft: '复核失败', failedLeft: failed.length }
			}
			return {
				floating, duplicates, rotationSuspects, misplaced,
				dryRun: false,
				fixed,
				pruned,
				...(failed.length ? { failed } : {}),
				remaining,
				note: `已修 ${fixed.length} 个（原地转正/挪动/删桩重放），清除浮空与多余 ${pruned.length} 个${failed.length ? `，失败 ${failed.length} 个（见 failed 明细）` : ''}。剩余浮标 ${remaining?.floatingLeft ?? '?'} 个。请目测画布确认文字恢复正字、位置正确`,
			}
		},
	},
	{
		name: 'schematic.autoLayout',
		summary: '【宏·原理图自动整理】把已放好网络（标签/导线）的一批器件重新排整齐并重建连线（0.10.19）：designators 或 region 二选一框定器件 → 网表导出连接表（NC/悬空自动跳过）→ 按网络聚类贪心排序 + cw32 模板行列排（横距 60 行距 90）→ 移动器件（官方 modify x/y，读回验证）→ rewire：删旧短桩导线（级联删标签）+ 清浮标 → 连接表转 batchWire（0.10.26 起 link 直连先于 label 短桩建，避免短桩先建占用引脚致 link 被拒；0.10.27 起删线前识别导线携带的外部引脚（带 1 个外部引脚的线删后自动补网重建、穿 ≥3 引脚的复杂长线保留不删进 skippedWires），link 因整段穿第三方引脚失败时自动降级两端 label 短桩（fallbacks）；未恢复的失败项在 rewireFailed/warning 里明列，插件不擅自恢复原连接）重建 → DRC 聚合。⚠️ 探针实锤：官方移动器件导线/标签不橡皮筋跟随，rewire 必须全量重建。dryRun 默认 true 只出排布方案+连接表预览，确认后 dryRun:false 才动画布',
		params: [
			{ name: 'designators', type: 'array', description: '器件位号清单，如 ["U1","C1","C2"]（与 region 二选一）' },
			{ name: 'region', type: 'object', description: '框选范围 {x, y, width, height}，范围内器件全部参与（与 designators 二选一）' },
			{ name: 'template', type: 'object', description: '排列模板 { colGap=60, rowGap=90, maxCols=ceil(sqrt(n)), origin=排序后第一个器件的当前位置 }' },
			{ name: 'rewire', type: 'boolean', description: '重排后重建连线（默认 true）；false 只移动器件' },
			{ name: 'dryRun', type: 'boolean', description: '只出排布方案与连接表预览（默认 true），false 才真移动+重建连线' },
		],
		returns: '{ dryRun, plan: [{designator, from, to}], connections: [{net, pins, style}], moved?, moveFailed?, rewired?: batchWire 结果, deletedWires?, prunedLabels?, drc?, failed? }',
		example: { cmd: 'schematic.autoLayout', params: { designators: ['U1', 'C1', 'C2'], dryRun: true } },
		handler: async (params) => {
			const dryRun = params.dryRun !== false
			const rewire = params.rewire !== false
			// ---------- ① 收集目标器件 ----------
			const layoutFocus = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (!layoutFocus?.uuid || layoutFocus.documentType !== 1)
				throw new Error('焦点文档不是有效的原理图页，已拒绝 autoLayout')
			const all = (await eda.sch_PrimitiveComponent.getAll()) ?? []
			const comps = all.map(c => ({
				primitiveId: safeState<string>(c, 'getState_PrimitiveId'),
				designator: safeState<string>(c, 'getState_Designator'),
				x: safeState<number>(c, 'getState_X'),
				y: safeState<number>(c, 'getState_Y'),
			})).filter(c => c.primitiveId && c.designator && c.x != null && c.y != null)
				.filter(c => !/^DRAWING|DRAW/i.test(String(c.designator))) // 排除图框器件
			let targets: typeof comps = []
			if (Array.isArray(params.designators) && params.designators.length) {
				const want = params.designators.map(String)
				targets = comps.filter(c => want.includes(String(c.designator)))
				const missing = want.filter(d => !targets.some(t => t.designator === d))
				if (missing.length)
					throw new Error(`找不到器件：${missing.join('、')}（用 schematic.listComponents 查位号）`)
			}
			else if (params.region && params.region.x != null) {
				const r = params.region
				const rx2 = Number(r.x) + Number(r.width ?? 0)
				const ry2 = Number(r.y) + Number(r.height ?? 0)
				targets = comps.filter(c =>
					Math.min(Number(r.x), rx2) <= Number(c.x) && Number(c.x) <= Math.max(Number(r.x), rx2)
					&& Math.min(Number(r.y), ry2) <= Number(c.y) && Number(c.y) <= Math.max(Number(r.y), ry2))
				if (!targets.length)
					throw new Error('region 范围内没有器件')
			}
			else
				throw new Error('需要 designators 数组或 region 对象（二选一）')
			const targetSet = new Set(targets.map(t => String(t.designator)))
			// ---------- ② 连接表（网表导出；NC/悬空引脚无网络自动跳过） ----------
			const pinNetMap = await pinNetMapRobust()
			if (!pinNetMap)
				throw new Error('网表导出失败（请确认原理图页处于激活状态）')
			const netToPins = new Map<string, Array<string>>()
			for (const [ref, net] of pinNetMap) {
				const arr = netToPins.get(net) ?? []
				arr.push(ref)
				netToPins.set(net, arr)
			}
			// 只保留触及目标器件的网络，但网络内引脚保留全集（link 重建需要外部另一端）
			const involved = [...netToPins.entries()].filter(([, pins]) =>
				pins.some(r => targetSet.has(r.split('.')[0])))
			if (!involved.length)
				throw new Error(`目标器件 ${[...targetSet].join('、')} 没有任何已入网引脚（网络关系不存在，无法用 autoLayout；请先接线或用 buildBlock 生成）`)
			// ---------- ③ 排布：网络聚类贪心排序 + 行列网格 ----------
			const compNets = new Map<string, Set<string>>()
			for (const t of targets)
				compNets.set(String(t.designator), new Set())
			for (const [net, pins] of involved)
				for (const r of pins) {
					const des = r.split('.')[0]
					if (targetSet.has(des))
						compNets.get(des)!.add(net)
				}
			const natural = (a: string, b: string) =>
				a.replace(/(\d+)/, m => m.padStart(6, '0')).localeCompare(b.replace(/(\d+)/, m => m.padStart(6, '0')))
			const remaining = [...targets].sort((a, b) => natural(String(a.designator), String(b.designator)))
			const order: typeof targets = []
			const placedNets = new Set<string>()
			while (remaining.length) {
				let bestIdx = 0
				let bestScore = -1
				for (let i = 0; i < remaining.length; i++) {
					const cn = compNets.get(String(remaining[i].designator))!
					const score = order.length
						? [...cn].filter(n => placedNets.has(n)).length
						: cn.size // 第一个：连接最多的器件
					if (score > bestScore) {
						bestScore = score
						bestIdx = i
					}
				}
				const [pick] = remaining.splice(bestIdx, 1)
				order.push(pick)
				for (const n of compNets.get(String(pick.designator))!)
					placedNets.add(n)
			}
			const tpl = params.template ?? {}
			const colGap = Number(tpl.colGap ?? 60)
			const rowGap = Number(tpl.rowGap ?? 90)
			const maxCols = Math.max(1, Number(tpl.maxCols ?? Math.ceil(Math.sqrt(order.length))))
			const origin = (tpl.origin && tpl.origin.x != null)
				? { x: Number(tpl.origin.x), y: Number(tpl.origin.y) }
				: { x: Number(order[0].x), y: Number(order[0].y) } // 缺省从排序后第一个器件的当前位置起排
			const plan = order.map((t, i) => ({
				designator: String(t.designator),
				primitiveId: String(t.primitiveId),
				from: { x: t.x, y: t.y },
				to: { x: origin.x + (i % maxCols) * colGap, y: origin.y - Math.floor(i / maxCols) * rowGap },
			}))
			const connections = involved.map(([net, pins]) => ({
				net,
				pins: pins.sort(),
				style: pins.length === 2 && !isPowerNetName(net) ? 'link' : 'label',
				targetPins: pins.filter(r => targetSet.has(r.split('.')[0])),
			}))
			if (dryRun) {
				return {
					dryRun: true,
					plan,
					connections,
					note: `排布方案（未动画布）：${order.length} 个器件按网络聚类排序后行列排（横距 ${colGap} 行距 ${rowGap} 每行 ${maxCols} 个，原点 ${origin.x},${origin.y}）。rewire=${rewire}：真跑时先删旧短桩导线（级联删标签）再按连接表 batchWire 重建。确认后 dryRun:false 执行`,
				}
			}
			// ---------- ④ 移动前记录旧引脚坐标（rewire 清理用；移动后引脚坐标就变） ----------
			const oldPinPts: Array<{ ref: string, x: number, y: number }> = []
			const involvedPinRefs = new Set<string>()
			for (const [, pins] of involved)
				for (const r of pins)
					involvedPinRefs.add(r)
			for (const t of targets) {
				const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(String(t.primitiveId))) ?? []
				for (const p of pins) {
					const pn = String(p.getState_PinNumber?.() ?? '')
					if (!involvedPinRefs.has(`${t.designator}.${pn}`))
						continue // NC/悬空引脚不在连接表，跳过
					const px = p.getState_X?.()
					const py = p.getState_Y?.()
					if (px != null && py != null)
						oldPinPts.push({ ref: `${t.designator}.${pn}`, x: px, y: py })
				}
			}
			// ---------- ⑤ 移动器件（读回验证，假失败前科不信返回值） ----------
			const moved: Array<Record<string, unknown>> = []
			for (const item of plan) {
				try {
					await moveComponentSafely(eda as any, item.primitiveId, { x: item.to.x, y: item.to.y }, layoutFocus)
					moved.push({ designator: item.designator, from: item.from, to: item.to })
				}
				catch (e: any) {
					const message = e instanceof Error ? e.message : String(e)
					const partial = moved.length > 0 || e?.cause?.partial === true
					const cause = e?.cause && typeof e.cause === 'object' ? e.cause : {}
					const error = new Error(`autoLayout 在移动 ${item.designator} 时停止：${message}`, { cause: { ...cause, partial, retryable: false, moved, phase: 'schematic.autoLayout component movement', operationError: message } }) as Error & { partial?: boolean, retryable?: boolean, moved?: unknown, phase?: string }
					error.partial = partial
					error.retryable = false
					error.phase = 'schematic.autoLayout component movement'
					error.moved = moved
					throw error
				}
			}
			if (!rewire) {
				return {
					dryRun: false,
					moved,
					note: '已按方案移动器件（rewire:false 未重建连线；旧导线/标签原地未动——官方移动不跟随，需要时用 rewire:true 重跑）',
				}
			}
			// ---------- ⑥ rewire：删碰旧引脚的导线（级联删标签）→ 清浮标 → batchWire 重建 ----------
			const segDist = (px: number, py: number, x1: number, y1: number, x2: number, y2: number): number => {
				const dx = x2 - x1
				const dy = y2 - y1
				if (dx === 0 && dy === 0)
					return Math.hypot(px - x1, py - y1)
				const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
				return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
			}
			const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
			// 全页引脚表（0.10.27）：目标器件用移动前坐标（oldPinPts），外部器件用当前坐标——
			// 用于识别 incident 导线是否还穿着目标器件以外的引脚（删线会顺手拆掉外部引脚的连接，0.10.26 复测 R2.1/J4.1 掉网事故）
			const allPinRefs: Array<{ ref: string, x: number, y: number }> = oldPinPts.map(p => ({ ...p }))
			try {
				const allComps = (await eda.sch_PrimitiveComponent.getAll()) ?? []
				for (const c of allComps) {
					const cdes = safeState<string>(c, 'getState_Designator')
					const cpid = safeState<string>(c, 'getState_PrimitiveId')
					if (!cdes || !cpid || targetSet.has(cdes))
						continue
					try {
						const pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(cpid)) ?? []
						for (const p of pins) {
							const pn = String(p.getState_PinNumber?.() ?? '')
							const px = p.getState_X?.()
							const py = p.getState_Y?.()
							if (pn && px != null && py != null)
								allPinRefs.push({ ref: `${cdes}.${pn}`, x: px, y: py })
						}
					}
					catch { /* 单个器件取引脚失败不阻断 */ }
				}
			}
			catch { /* 全页引脚表失败则退化为 0.10.26 行为（只按目标引脚判） */ }
			// 按连接表找导线所属网络（involved 的 pins 是全成员 ref 表）
			const netOfRefs = (refs: Array<string>): string => {
				let best = ''
				let bestHit = 0
				for (const [net, pins] of involved) {
					const hit = refs.filter(r => pins.includes(r)).length
					if (hit > bestHit) {
						bestHit = hit
						best = net
					}
				}
				return best
			}
			const incidentIds: Array<string> = []
			const externalRewired: Array<Record<string, unknown>> = []
			const skippedWires: Array<Record<string, unknown>> = []
			const externalLabelItems: Array<Record<string, unknown>> = []
			for (const w of wires) {
				const wid = safeState<string>(w, 'getState_PrimitiveId')
				const line = safeState<Array<number>>(w, 'getState_Line') ?? []
				if (!wid || !line.length)
					continue
				const wireRefs = new Set<string>()
				let hit = false
				for (let i = 0; i + 1 < line.length; i += 2) {
					const x1 = line[i]
					const y1 = line[i + 1]
					const x2 = line[i + 2] ?? x1
					const y2 = line[i + 3] ?? y1
					for (const pt of allPinRefs) {
						if (segDist(pt.x, pt.y, x1, y1, x2, y2) <= 3) {
							wireRefs.add(pt.ref)
							if (!hit && oldPinPts.some(o => o.ref === pt.ref))
								hit = true
						}
					}
				}
				if (!hit)
					continue
				const refs = [...wireRefs]
				const extRefs = refs.filter(r => !targetSet.has(r.split('.')[0]))
				if (!extRefs.length) {
					incidentIds.push(wid) // 纯内部线：照删
					continue
				}
				const net = netOfRefs(refs)
				if (refs.length > 2) {
					// 复杂长线（穿 ≥3 个引脚）：保留原线不删，目标侧照常重建，可能留悬线，人工复核
					skippedWires.push({ primitiveId: wid, net, pins: refs, reason: '该线穿过 3 个及以上引脚（复杂长线），保留原线未删；目标器件侧已照常重建，可能残留悬线/重复连接，请人工复核' })
					continue
				}
				// 带 1 个外部引脚的短线：照删，外部侧补 label 重建（link 网由连接表 link 项覆盖两端，无需额外项）
				const netPins = involved.find(([n]) => n === net)?.[1] ?? []
				const isLinkNet = netPins.length === 2 && !isPowerNetName(net)
				for (const r of extRefs) {
					if (!isLinkNet && netPins.includes(r))
						externalLabelItems.push({ type: 'label', pin: r, net })
				}
				externalRewired.push({ primitiveId: wid, net, externalPins: extRefs, strategy: isLinkNet ? '由连接表 link 项重建两端' : '外部引脚补 label 短桩重建' })
				incidentIds.push(wid)
			}
			const deletedWires: Array<string> = []
			const deleteFailed: Array<string> = []
			if (incidentIds.length) {
				try {
					await eda.sch_PrimitiveWire.delete(incidentIds)
					// 读回验证（不信返回值）
					const alive = new Set(((await eda.sch_PrimitiveWire.getAll()) ?? []).map(w => safeState<string>(w, 'getState_PrimitiveId')))
					for (const id of incidentIds)
						(alive.has(id) ? deleteFailed : deletedWires).push(id)
				}
				catch (e: any) {
					deleteFailed.push(...incidentIds)
				}
			}
			// 浮标清理：只清网络在连接表内且靠近旧引脚点的浮标（不碰无关浮标）
			const prunedLabels: Array<string> = []
			try {
				const floats = await scanFloatingNetLabels()
				const involvedNets = new Set(involved.map(([n]) => n))
				const victims = floats.filter(f => involvedNets.has(f.net)
					&& f.x != null && f.y != null
					&& oldPinPts.some(pt => Math.hypot((f.x ?? 0) - pt.x, -(f.y ?? 0) - pt.y) <= 60))
				if (victims.length) {
					const r = await deleteFloatingLabels(victims.map(v => v.primitiveId))
					prunedLabels.push(...r.deleted)
				}
			}
			catch { /* 浮标清理失败不阻断 */ }
			// ---------- ⑦ 连接表 → batchWire 重建（0.10.26：link 先于 label——先直连占好引脚，
			// 再画短桩，避免短桩先建横穿第三方引脚占用网络后 link 被拒断网；0.10.24 终验 FBA 断网事故） ----------
			const linkItems: Array<Record<string, unknown>> = []
			const labelItems: Array<Record<string, unknown>> = []
			for (const [net, pins] of involved) {
				if (pins.length === 2 && !isPowerNetName(net))
					linkItems.push({ type: 'link', pins: [...pins].sort() })
				else
					for (const r of pins) {
						const des = r.split('.')[0]
						if (targetSet.has(des)) // 外部引脚的标签保持不动，只重建目标器件侧
							labelItems.push({ type: 'label', pin: r, net })
					}
			}
			// 0.10.27：⑥ 识别出的外部引脚补网项并入（按 pin 去重——外部侧标签若已存在/已覆盖则不重复）
			for (const it of externalLabelItems) {
				if (!labelItems.some(x => x.pin === it.pin) && !linkItems.some(x => (x.pins as Array<string>)?.includes(it.pin as string)))
					labelItems.push(it)
			}
			const items = [...linkItems, ...labelItems]
			const batchCmd = schematicCommands.find(c => c.name === 'schematic.batchWire')
			if (!batchCmd)
				throw new Error('内部错误：batchWire 未注册')
			const wiring = items.length ? await batchCmd.handler({ items, continueOnError: true }) as any : { note: '无可重建项' }
			// 0.10.27：link 失败项降级——整段路径穿第三方引脚时 linkWire 抛 PIN_CROSSING_FALLBACK，
			// 自动改为两端 label 短桩直连再试一次；恢复的不计入 rewireFailed
			const fallbacks: Array<Record<string, unknown>> = []
			const linkFailed = Array.isArray(wiring.items)
				? wiring.items.filter((it: any) => !it.ok && it.item?.type === 'link' && Array.isArray(it.item?.pins) && it.item.pins.length === 2)
				: []
			const recoveredLinks = new Set<any>()
			if (linkFailed.length) {
				const fItems: Array<Record<string, unknown>> = []
				const fPairs: Array<{ item: any, pins: [string, string] }> = []
				for (const it of linkFailed) {
					const [pa, pb] = it.item.pins as [string, string]
					const net = involved.find(([, pins]) => pins.includes(pa) && pins.includes(pb))?.[0] ?? ''
					if (!net)
						continue
					fItems.push({ type: 'label', pin: pa, net }, { type: 'label', pin: pb, net })
					fPairs.push({ item: it, pins: [pa, pb] })
				}
				if (fItems.length) {
					const fr = await batchCmd.handler({ items: fItems, continueOnError: true }) as any
					fPairs.forEach((p, i) => {
						const ra = fr?.items?.[i * 2]
						const rb = fr?.items?.[i * 2 + 1]
						const ok = !!ra?.ok && !!rb?.ok
						fallbacks.push({ pins: p.pins, net: fItems[i * 2].net, ok, ...(ok ? {} : { error: ra?.error ?? rb?.error ?? '' }), strategy: 'link 直连失败（整段路径穿第三方引脚），降级为两端 label 短桩' })
						if (ok)
							recoveredLinks.add(p.item)
					})
				}
			}
			// 重连失败明列（不断网原则：旧导线已删，失败项的网络就是断的——必须醒目列出由操作者处置，插件不擅自恢复原连接）
			const rewiredFailed = Array.isArray(wiring.items) ? wiring.items.filter((it: any) => !it.ok && !recoveredLinks.has(it)) : []
			// ---------- ⑧ DRC 聚合 ----------
			let drc: Record<string, unknown> | undefined
			try {
				const drcCmd = schematicCommands.find(c => c.name === 'schematic.runDrc')
				const dr = drcCmd ? (await drcCmd.handler({})) as any : undefined
				drc = dr ? { fatalCount: dr.fatalCount, totalCount: dr.totalCount, passed: dr.passed } : undefined
			}
			catch {
				drc = { note: 'DRC 运行失败，请手动 schematic.runDrc 复核' }
			}
			return {
				dryRun: false,
				moved,
				deletedWires,
				...(deleteFailed.length ? { deleteFailed } : {}),
				prunedLabels,
				...(externalRewired.length ? { externalRewired } : {}),
				...(skippedWires.length ? { skippedWires } : {}),
				...(fallbacks.length ? { fallbacks } : {}),
				rewired: wiring,
				...(rewiredFailed.length ? {
					rewireFailed: rewiredFailed.map((it: any) => ({ item: it.item, error: it.error })),
					warning: `⚠️ ${rewiredFailed.length} 项重连失败（旧导线已删，对应网络当前是断开的，插件不擅自恢复原连接）：${rewiredFailed.map((it: any) => `${JSON.stringify(it.item)}（${it.error ?? ''}）`).join('；')}。请按失败项逐条人工修复（labelWire/linkWire 重发或 drawWire+placeNetLabel），修完跑 schematic.runDrc + exportNetlist 审计`,
				} : {}),
				drc,
				note: `已移动 ${moved.length}/${plan.length} 个器件，删旧导线 ${deletedWires.length} 根、清浮标 ${prunedLabels.length} 个，batchWire 重建 ${items.length} 项（link 先于 label 执行）${externalRewired.length ? `，其中 ${externalRewired.length} 根线带外部引脚已一并补网重建` : ''}${skippedWires.length ? `，${skippedWires.length} 根复杂长线保留未删（见 skippedWires，请人工复核）` : ''}${fallbacks.length ? `，${fallbacks.filter(f => f.ok).length}/${fallbacks.length} 个 link 失败项已降级 label 短桩${fallbacks.some(f => !f.ok) ? '（仍有失败的见 fallbacks）' : '恢复'}` : ''}${rewiredFailed.length ? `，其中 ${rewiredFailed.length} 项失败见 warning` : ''}。请目测画布确认排布与连线`,
			}
		},
	},
	{
		name: 'schematic.modifyNetLabel',
		summary: '修改网络标签：颜色、位置、改名和旋转角度。可按标签 ID 精确改，或按网络名批量改。当前 EDA 中 rotation=180 会导致文字上下颠倒，不要用它表示“向左”；不要用镜像 mirror，镜像会把文字翻成反字，且官方原理图属性接口不支持修改 mirror（pro-api-types 无此字段），被镜像的标签只能删了重放',
		params: [
			{ name: 'primitiveId', type: 'string', description: '标签图元 ID（与 net 二选一）' },
			{ name: 'net', type: 'string', description: '网络名：批量修改该网络的全部标签' },
			{ name: 'color', type: 'string', description: '标签颜色，如 #0000FF' },
			{ name: 'newNet', type: 'string', description: '改网络名（改 value）' },
			{ name: 'x', type: 'number', description: '新坐标 X（建议 10 的倍数）' },
			{ name: 'y', type: 'number', description: '新坐标 Y' },
			{ name: 'rotation', type: 'number', description: '文字旋转角度（0=正常向右，90/270=竖排方向；180° 在当前 EDA 中会导致文字上下颠倒，不要将其作为“向左”使用）。改完读回 getState_Rotation 验证，返回带读回值' },
			{ name: 'mirror', type: 'boolean', description: '⚠️ 官方原理图属性接口不支持 mirror（pro-api-types 无此字段/无 getState_Mirror）——传入会被拒绝并提示；镜像反字的标签请删除重放（rotation 控制方向）' },
		],
		returns: '{ modified: [...], failed: [{ id, fields: [{ field, want, actual }] }], readback?: [{ id, rotation?, x?, y?, value?, color?, ok }], mirrorNote? }（0.10.24 起多字段请求内部自动拆成 rotation/位置/改名/颜色独立步骤顺序执行+逐字段读回——官方 modify 对「位置+旋转」合并修改整体失效（P10 实锤），不要再指望一次调用多字段原子生效）',
		example: { cmd: 'schematic.modifyNetLabel', params: { net: 'GND', color: '#0000FF' } },
		handler: async (params) => {
			if (!params.primitiveId && !params.net)
				throw new Error('缺少参数 primitiveId 或 net（二选一）')
			const property: Record<string, any> = {}
			if (params.color != null)
				property.color = String(params.color)
			if (params.newNet != null)
				property.value = String(params.newNet)
			if (params.x != null)
				property.x = Number(params.x)
			if (params.y != null)
				property.y = Number(params.y)
			if (params.rotation != null)
				property.rotation = ((Number(params.rotation) % 360) + 360) % 360
			// ⚠️ 官方原理图属性 modify 签名没有 mirror 字段（pro-api-types 实锤），也不存在 getState_Mirror——
			// 镜像反字的标签本接口修不了，只能删了重放（rotation 控制文字方向）
			const mirrorRequested = params.mirror != null
			if (!Object.keys(property).length)
				throw new Error('至少提供一个要修改的属性（color / newNet / x / y / rotation）；mirror 官方接口不支持，镜像标签请删除重放')
			let ids: Array<string> = []
			if (params.primitiveId) {
				ids = [String(params.primitiveId)]
			}
			else {
				// 复用 listNetLabels 的逻辑按网名收集标签 ID
				const labels = await (async (): Promise<Array<any>> => {
					const wires = (await eda.sch_PrimitiveWire.getAll()) ?? []
					const found: Array<any> = []
					for (const w of wires) {
						const wireId = safeState<string>(w, 'getState_PrimitiveId')
						if (!wireId)
							continue
						try {
							for (const a of (await eda.sch_PrimitiveAttribute.getAll(wireId)) ?? []) {
								const key = safeState<string>(a, 'getState_Key') ?? ''
								if (/^(NET|Name)$/i.test(key) && safeState<string>(a, 'getState_Value') === String(params.net))
									found.push(a)
							}
						}
						catch { /* 单线失败继续 */ }
					}
					return found
				})()
				ids = labels.map(a => safeState<string>(a, 'getState_PrimitiveId')).filter(Boolean) as Array<string>
				if (!ids.length)
					throw new Error(`未找到网络 ${params.net} 的标签（浮空标签请用 listNetLabels 查 ID 后按 primitiveId 修改）`)
			}
			// 0.10.24 原子化（P10 实锤：官方 modify 对「位置+旋转」多字段合并修改整体失效——
			// GPT 现场：传 primitiveId+x+y+rotation 返回 modified 空、failed 含原 ID、读回全旧值，
			// 拆成「只转 rotation」「只移 x/y」两个单步各自成功。结论：多字段合并修改不可信）。
			// 多字段请求在插件内部拆成独立步骤顺序执行：rotation（走 applyLabelRotation 读回验证）
			// → 位置 x/y → 改名 value → 颜色 color；每步读回，不符即从 modified 挪到 failed（带字段与实际值）
			const modified: Array<string> = []
			const failed: Array<Record<string, unknown>> = []
			const readback: Array<Record<string, unknown>> = []
			const wantRotation = property.rotation != null ? Number(property.rotation) : undefined
			const wantX = property.x != null ? Number(property.x) : undefined
			const wantY = property.y != null ? Number(property.y) : undefined
			const wantValue = property.value != null ? String(property.value) : undefined
			const wantColor = property.color != null ? String(property.color) : undefined
			for (const id of ids) {
				const entry: Record<string, unknown> = { id }
				const fieldFails: Array<Record<string, unknown>> = []
				// 步骤 1：旋转（applyLabelRotation 自带 modify+读回，读回不符返回 undefined 判失败）
				if (wantRotation != null) {
					const actual = await applyLabelRotation(id, wantRotation)
					entry.rotation = actual ?? null
					if (actual == null)
						fieldFails.push({ field: 'rotation', want: wantRotation, actual: actual ?? null })
				}
				// 步骤 2：位置（x/y 同属「位置」类别，一次 modify；改完读回坐标逐轴核对）
				if (wantX != null || wantY != null) {
					const posProps: Record<string, any> = {}
					if (wantX != null)
						posProps.x = wantX
					if (wantY != null)
						posProps.y = wantY
					try {
						await eda.sch_PrimitiveAttribute.modify(id, posProps)
					}
					catch { /* 假失败不轻信，读回为准 */ }
					await new Promise(resolve => setTimeout(resolve, 300))
					try {
						const back = await eda.sch_PrimitiveAttribute.get(id)
						const actualX = back ? safeState<number>(back, 'getState_X') : undefined
						const actualY = back ? safeState<number>(back, 'getState_Y') : undefined
						if (wantX != null) {
							entry.x = actualX ?? null
							if (actualX == null || Math.abs(actualX - wantX) > 0.5)
								fieldFails.push({ field: 'x', want: wantX, actual: actualX ?? null })
						}
						if (wantY != null) {
							entry.y = actualY ?? null
							if (actualY == null || Math.abs(actualY - wantY) > 0.5)
								fieldFails.push({ field: 'y', want: wantY, actual: actualY ?? null })
						}
					}
					catch {
						fieldFails.push({ field: 'position', want: posProps, actual: null, reason: '读回失败' })
					}
				}
				// 步骤 3：改名（newNet→value，0.10.23 起读回验证）
				if (wantValue != null) {
					try {
						await eda.sch_PrimitiveAttribute.modify(id, { value: wantValue })
					}
					catch { /* 读回为准 */ }
					await new Promise(resolve => setTimeout(resolve, 300))
					try {
						const back = await eda.sch_PrimitiveAttribute.get(id)
						const actualValue = back ? safeState<string>(back, 'getState_Value') : undefined
						entry.value = actualValue ?? null
						if (actualValue == null || actualValue !== wantValue)
							fieldFails.push({ field: 'newNet', want: wantValue, actual: actualValue ?? null })
					}
					catch {
						fieldFails.push({ field: 'newNet', want: wantValue, actual: null, reason: '读回失败' })
					}
				}
				// 步骤 4：颜色（getState_Color 可能读不出——读不出只记录不判失败，读得出严格比对）
				if (wantColor != null) {
					try {
						await eda.sch_PrimitiveAttribute.modify(id, { color: wantColor })
					}
					catch { /* 读回为准 */ }
					await new Promise(resolve => setTimeout(resolve, 300))
					try {
						const back = await eda.sch_PrimitiveAttribute.get(id)
						const actualColor = back ? safeState<string>(back, 'getState_Color') : undefined
						entry.color = actualColor ?? null
						if (actualColor != null && actualColor.toLowerCase() !== wantColor.toLowerCase())
							fieldFails.push({ field: 'color', want: wantColor, actual: actualColor })
					}
					catch { /* 颜色读回失败不判失败 */ }
				}
				entry.ok = fieldFails.length === 0
				readback.push(entry)
				if (fieldFails.length)
					failed.push({ id, fields: fieldFails })
				else
					modified.push(id)
			}
			if (!modified.length && failed.length)
				throw new Error(`修改失败：${JSON.stringify(failed)}（图元不存在/不是属性标签，或读回均不符）`)
			return {
				modified,
				failed,
				...(readback.length ? { readback } : {}),
				...(mirrorRequested ? { mirrorNote: '官方原理图属性接口不支持 mirror（pro-api-types 无此字段、无 getState_Mirror），mirror 参数未生效。镜像反字的标签请删除重放；rotation=180 在当前 EDA 中会导致文字上下颠倒' } : {}),
			}
		},
	},
	{
		name: 'schematic.moveLabel',
		summary: '移动网络标签 / 属性图元到指定坐标（修复「不在格点上」警告时把坐标取整到 10 的倍数；移动后需复跑 DRC 确认吸附关系没丢）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '标签图元 ID' },
			{ name: 'x', type: 'number', required: true, description: '新坐标 X（建议 10 的倍数）' },
			{ name: 'y', type: 'number', required: true, description: '新坐标 Y（建议 10 的倍数）' },
		],
		returns: '{ moved, x, y }',
		example: { cmd: 'schematic.moveLabel', params: { primitiveId: 'xxx', x: 1020, y: 540 } },
		handler: async (params) => {
			if (!params.primitiveId || params.x == null || params.y == null)
				throw new Error('缺少参数 primitiveId / x / y')
			const result = await eda.sch_PrimitiveAttribute.modify(String(params.primitiveId), {
				x: Number(params.x),
				y: Number(params.y),
			})
			if (!result)
				throw new Error(`标签 ${params.primitiveId} 移动失败（图元可能不存在）`)
			// 读回验证（0.10.23：官方 modify 假成功前科，成败以读回为准）
			await new Promise(resolve => setTimeout(resolve, 300))
			const back = await eda.sch_PrimitiveAttribute.get(String(params.primitiveId))
			const actualX = back ? safeState<number>(back as any, 'getState_X') : undefined
			const actualY = back ? safeState<number>(back as any, 'getState_Y') : undefined
			const verified = actualX != null && actualY != null
				&& Math.abs(actualX - Number(params.x)) <= 0.5 && Math.abs(actualY - Number(params.y)) <= 0.5
			if (!verified)
				throw new Error(`标签 ${params.primitiveId} 移动未生效：读回实际坐标 (${actualX ?? '?'}, ${actualY ?? '?'})，目标 (${Number(params.x)}, ${Number(params.y)})——官方 modify 假成功，请重试`)
			return { moved: true, x: Number(params.x), y: Number(params.y), readback: { x: actualX, y: actualY, verified } }
		},
	},
	{
		name: 'schematic.runDrc',
		summary: '运行原理图 DRC 检查（需先激活原理图图页）；官方结果结构未知时明确报错，不把异常返回当 0 项通过。存在致命错误时 pcb.importChanges 可能静默失败，导入前须先清到 0 致命',
		params: [],
		returns: '{ passed, totalCount, fatalCount, groups, note? }；groups 按宿主实际结果保留逐条或 {type,count} 聚合结构，未知结构报错',
		example: { cmd: 'schematic.runDrc' },
		handler: async () => {
			const runOnce = async (): Promise<{ passed: boolean, totalCount: number, fatalCount: number, groups: Array<any> }> => {
				let errors: any
				try {
					errors = await eda.sch_Drc.check(true, false, true)
				}
				catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					if (/doctype/i.test(msg))
						throw new Error('当前激活的不是原理图图页，无法运行原理图 DRC。请先用 editor.openDocument 激活图页')
					throw err
				}
				const groups = checkedSchematicDrcEntries(errors)
				// 官方实际返回按类型聚合的 { type, count }（文档写的是逐条 ISCH_DrcError，两者都兼容）
				const countOf = (e: any) => (typeof e?.count === 'number' ? e.count : 1)
				const totalCount = groups.reduce((sum: number, e: any) => sum + countOf(e), 0)
				const fatalCount = groups
					.filter((e: any) => /fatal/i.test(String(e?.type ?? e?.rule ?? '')))
					.reduce((sum: number, e: any) => sum + countOf(e), 0)
				return { passed: totalCount === 0, totalCount, fatalCount, groups }
			}
			// 大批量改动后第一次 DRC 可能是过渡态旧结果（实测相差可达 10 条），
			// 自动跑两遍取稳定值
			const first = await runOnce()
			await new Promise(resolve => setTimeout(resolve, 800))
			const second = await runOnce()
			return {
				...second,
				...(first.totalCount !== second.totalCount
					? { note: `首次结果为过渡态（${first.totalCount} 条），已自动复跑取稳定值` }
					: {}),
			}
		},
	},
	{
		name: 'schematic.runDrcDetailed',
		summary: '运行原理图 DRC 并返回宿主实际给出的逐条违规或聚合结果；EDA 4.1.78 已实测返回逐条明细，其他版本按返回结构判断，不能仅按版本推断。结果结构未知时报错，不报告通过',
		params: [],
		returns: '{ passed, totalCount, fatalCount, warnCount, violations, aggregated, note? }；逐条结构含 type/rule/net?/primitives，聚合结构含 type/count 并标 aggregated:true；未知结构报错',
		example: { cmd: 'schematic.runDrcDetailed' },
		handler: async () => {
			const runOnce = async (): Promise<{ passed: boolean, totalCount: number, fatalCount: number, warnCount: number, violations: Array<any>, aggregated: boolean }> => {
				let errors: any
				try {
					errors = await eda.sch_Drc.check(true, false, true)
				}
				catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					if (/doctype/i.test(msg))
						throw new Error('当前激活的不是原理图图页，无法运行原理图 DRC。请先用 editor.openDocument 激活图页')
					throw err
				}
				const list = checkedSchematicDrcEntries(errors)
				// 官方文档承诺逐条 ISCH_DrcError（type/rule/primitives/net），运行时也可能退化为聚合 {type,count}——两种都兼容
				const aggregated = list.some((e: any) => typeof e?.count === 'number' && !e?.primitives)
				const violations = list.map((e: any) => {
					if (e && typeof e === 'object' && (e.primitives || e.rule))
						return {
							type: e.type ?? undefined,
							rule: e.rule ?? undefined,
							...(e.net != null ? { net: e.net } : {}),
							primitives: Array.isArray(e.primitives) ? e.primitives.map((p: any) => ({
								...(p?.name != null ? { name: p.name } : {}),
								...(p?.designator != null ? { designator: p.designator } : {}),
								primitiveId: p?.primitiveId,
								...(p?.sheet != null ? { sheet: p.sheet } : {}),
							})) : [],
						}
					return e
				})
				const countOf = (e: any) => (typeof e?.count === 'number' ? e.count : 1)
				const totalCount = list.reduce((sum: number, e: any) => sum + countOf(e), 0)
				const fatalCount = list
					.filter((e: any) => /fatal/i.test(String(e?.type ?? '')))
					.reduce((sum: number, e: any) => sum + countOf(e), 0)
				const warnCount = list
					.filter((e: any) => /warn/i.test(String(e?.type ?? '')))
					.reduce((sum: number, e: any) => sum + countOf(e), 0)
				return { passed: totalCount === 0, totalCount, fatalCount, warnCount, violations, aggregated }
			}
			// 与 runDrc 同理：大批量改动后第一次 DRC 可能是过渡态旧结果，自动跑两遍取稳定值
			const first = await runOnce()
			await new Promise(resolve => setTimeout(resolve, 800))
			const second = await runOnce()
			const notes: Array<string> = []
			if (second.aggregated)
				notes.push('官方运行时返回聚合结构（{type,count}），没有完整逐条明细；请按返回结构判断，不按 EDA 版本推断')
			if (first.totalCount !== second.totalCount)
				notes.push(`首次与复跑数量不同（${first.totalCount}→${second.totalCount}）；当前结果可能仍在刷新，不能仅凭两次计数确认稳定`)
			return { ...second, ...(notes.length ? { note: notes.join('；') } : {}) }
		},
	},
	{
		name: 'schematic.listNets',
		summary: '列出原理图网络。EDA 4.1 用 PADS 网表和命名导线回退；自动网名可恢复，但 detail:true 无法可靠归属无网络名导线，须用 getNetlist 核对引脚；回退失败会报错',
		params: [
			{ name: 'detail', type: 'boolean', description: '是否返回每个网络的导线明细，默认 false（仅网络名列表）' },
		],
		returns: '网络名列表，或 [{ net, wires }]',
		example: { cmd: 'schematic.listNets' },
		handler: async (params) => {
			if (params.detail !== undefined && typeof params.detail !== 'boolean')
				throw new Error('detail 必须是布尔值')
			if (isEda42OrNewer()) {
				if (!params.detail)
					return await eda.sch_Net.getAllNetsName()
				return await eda.sch_Net.getAllNets()
			}
			// EDA 4.1.x returns [] for both sch_Net methods even when the page has nets.
			// The existing PADS netlist path captures generated net names; wires add
			// standalone named segments that may not have any component pins.
			const pinMap = await pinNetMapFromPadsText()
			if (!pinMap)
				throw new Error('schematic.listNets：EDA 4.1 网表回退不可用，无法可靠列出全部网络；请检查活动原理图和网表生成结果')
			const wires = (await eda.sch_PrimitiveWire.getAll() ?? []).map(w => ({
				primitiveId: safeState<string>(w, 'getState_PrimitiveId'),
				net: safeState<string>(w, 'getState_Net'),
				line: safeState<Array<number>>(w, 'getState_Line'),
				lineWidth: safeState<number>(w, 'getState_LineWidth'),
			}))
			const names = [...new Set([...pinMap.values(), ...wires.map(w => w.net).filter((n): n is string => Boolean(n))])].sort()
			if (!params.detail)
				return names
			return names.map(net => ({ net, wires: wires.filter(w => w.net === net),
				...(wires.some(w => !w.net) ? { note: 'EDA 4.1 不提供自动网络的导线归属；空网络名导线未计入 wires' } : {}) }))
		},
	},
	{
		name: 'schematic.listWires',
		summary: '列出原理图导线（可按网络过滤）——画完线后读回自查用',
		params: [
			{ name: 'net', type: 'string', description: '网络名过滤，留空为全部导线' },
		],
		returns: '导线列表 [{ primitiveId, net, line, lineWidth }]；line 原样返回 SDK getState_Line 数组，不重排或拆组；多段线的权威单段几何以 documentSource 中同 lineGroup 的 LINE.startX/startY/endX/endY 记录为准（源码 Y 需按坐标约定转换）',
		example: { cmd: 'schematic.listWires', params: { net: 'GND' } },
		handler: async (params) => {
			// getAll(net) 的过滤参数运行时不可靠（实测返回空），全量取回后手动过滤
			const wires = await eda.sch_PrimitiveWire.getAll()
			const netFilter = params.net ? String(params.net) : undefined
			return (wires ?? [])
				.map(w => ({
					primitiveId: safeState<string>(w, 'getState_PrimitiveId'),
					net: safeState<string>(w, 'getState_Net'),
					line: safeState<Array<number>>(w, 'getState_Line'),
					lineWidth: safeState<number>(w, 'getState_LineWidth'),
				}))
				.filter(w => !netFilter || w.net === netFilter)
		},
	},
	{
		name: 'schematic.exportBom',
		summary: '导出宿主原始 BOM 文件及实测格式信息（base64 不转换）；EDA 4.1.78 的 csv 实为 UTF-16LE 制表符文本，按返回 format/encoding/delimiter 解析',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 schematic-bom' },
			{ name: 'fileType', type: 'string', description: 'xlsx | csv，默认 xlsx' },
		],
		returns: '{ fileName, size, mimeType, base64, format, encoding?, delimiter?, note? }；base64 保留宿主原始字节，格式字段由文件头和表头识别',
		example: { cmd: 'schematic.exportBom', params: { fileType: 'csv' } },
		handler: async (params) => {
			if (params.fileType != null && params.fileType !== 'csv' && params.fileType !== 'xlsx')
				throw new Error('fileType 仅支持 csv 或 xlsx')
			const fileType = (params.fileType ?? 'xlsx') as 'xlsx' | 'csv'
			const requestedName = params.fileName == null ? '' : String(params.fileName).trim()
			const fileStem = requestedName.replace(new RegExp(`\\.${fileType}$`, 'i'), '')
			const file = await eda.sch_ManufactureData.getBomFile(
				fileStem || undefined,
				fileType,
			)
			const result = await fileToResult(file, `schematic-bom.${fileType}`)
			if (!result)
				throw new Error('BOM 导出失败：官方返回空（请确认已激活原理图图页且图中有器件）')
			return { ...result, ...describeBomFile(result, fileType) }
		},
	},
	{
		name: 'schematic.exportPng',
		summary: '导出原理图 PNG 图片（返回 base64；可指定分辨率，单边最大 4096）',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 schematic.png' },
			{ name: 'width', type: 'number', description: '图片宽度像素，与 height 二选一或都留空（原始分辨率）' },
			{ name: 'height', type: 'number', description: '图片高度像素' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'schematic.exportPng', params: { width: 2048 } },
		handler: async (params) => {
			const resolution: Record<string, number> = {}
			for (const key of ['width', 'height'] as const) {
				if (params[key] == null)
					continue
				const value = params[key]
				if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 4096)
					throw new Error(`${key} 必须是 1 至 4096 之间的正整数`)
				resolution[key] = value
			}
			const file = await eda.sch_ManufactureData.getPngFile(
				params.fileName ? String(params.fileName) : undefined,
				Object.keys(resolution).length ? resolution as any : undefined,
			)
			const result = await fileToResult(file, 'schematic.png')
			if (!result)
				throw new Error('PNG 导出失败：官方返回空（请确认已激活原理图图页）')
			return result
		},
	},
	{
		name: 'schematic.exportNetlist',
		summary: '导出原理图网表文件（base64）；宿主生成时可能更新重复位号、Unique ID并保存，不用于只读来源',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 netlist' },
			{ name: 'netlistType', type: 'string', description: '网表格式，如 Protel2（Altium Designer 格式），默认官方默认格式' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'schematic.exportNetlist' },
		handler: async (params) => {
			const file = await eda.sch_ManufactureData.getNetlistFile(
				params.fileName ? String(params.fileName) : undefined,
				params.netlistType ? String(params.netlistType) as any : undefined,
			)
			const result = await fileToResult(file, 'netlist.net')
			if (!result || !Number.isFinite(result.size) || result.size <= 0 || !result.base64)
				throw new Error('网表导出失败：官方返回空、零字节文件或空 base64（如数据校验不满足可能抛错而非返空）。可改用 schematic.getNetlist 直接取网表字符串做连通性审计，或 schematic.runDrcDetailed 查致命项')
			return result
		},
	},
	{
		name: 'schematic.getNetlist',
		summary: '取得原理图网表字符串；宿主生成时可能更新重复位号、Unique ID并保存，不用于只读来源',
		params: [
			{ name: 'netlistType', type: 'string', description: '网表格式：Allegro/PADS/Protel2/JLCEDA/EasyEDA/DISA/DSNET；未传时默认 Protel2' },
		],
		returns: '{ netlistType, length, netlist }',
		example: { cmd: 'schematic.getNetlist', params: { netlistType: 'Protel2' } },
		handler: async (params) => {
			const rawType = params.netlistType == null ? 'Protel2' : String(params.netlistType)
			const netlist = await withTimeout(
				eda.sch_Netlist.getNetlist(rawType as any),
				45000,
				`getNetlist(${rawType ?? 'default'})`,
			).catch((e: any) => {
				throw new Error(`网表读取失败：${String(e?.message ?? e)}——请检查 EDA 返回的信息或稍后重试`)
			})
			if (typeof netlist !== 'string' || netlist.trim().length === 0)
				throw new Error('网表读取失败：官方返回非字符串或空——该接口与 exportNetlist 是两条独立路径，同时失败才说明原理图数据不满足网表校验')
			return { netlistType: rawType ?? 'default', length: netlist.length, netlist }
		},
	},
	// ---------- 原理图文本 + 区域/点查询 ----------
	{
		name: 'schematic.placeText',
		summary: '在原理图放置文本（注释/版本号/说明）',
		params: [
			{ name: 'x', type: 'number', required: true, description: '坐标 X（10mil 单位）' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y' },
			{ name: 'content', type: 'string', required: true, description: '文本内容' },
			{ name: 'rotation', type: 'number', description: '旋转角度，默认 0' },
			{ name: 'fontSize', type: 'number', description: '字号，默认官方默认' },
			{ name: 'fontName', type: 'string', description: '字体名' },
			{ name: 'textColor', type: 'string', description: '颜色（如 #FF0000）' },
			{ name: 'bold', type: 'boolean', description: '加粗' },
		],
		returns: '{ primitiveId }',
		example: { cmd: 'schematic.placeText', params: { x: 300, y: 700, content: 'STM32 最小系统 V1.0' } },
		handler: async (params) => {
			if (params.x == null || params.y == null || !params.content)
				throw new Error('缺少参数 x / y / content')
			const text = await eda.sch_PrimitiveText.create(
				Number(params.x),
				Number(params.y),
				String(params.content),
				params.rotation != null ? Number(params.rotation) : undefined,
				params.textColor != null ? String(params.textColor) : undefined,
				params.fontName != null ? String(params.fontName) : undefined,
				params.fontSize != null ? Number(params.fontSize) : undefined,
				params.bold != null ? Boolean(params.bold) : undefined,
			)
			if (!text)
				throw new Error('文本创建失败：官方返回空')
			return { primitiveId: safeState<string>(text, 'getState_PrimitiveId') }
		},
	},
	{
		name: 'schematic.listTexts',
		summary: '列出原理图全部文本图元（含 offGrid 格点标记——0.10.46 起接替已删除的 listLabels 的"不在格点"排查能力）',
		params: [],
		returns: '[{ primitiveId, x, y, content, fontSize, rotation, offGrid }]（offGrid=true 即坐标不是 10 的倍数，DRC 会报"图元不在格点上"）',
		example: { cmd: 'schematic.listTexts' },
		handler: async () => {
			const texts = await eda.sch_PrimitiveText.getAll()
			return (texts ?? []).map(t => {
				const x = safeState<number>(t, 'getState_X')
				const y = safeState<number>(t, 'getState_Y')
				return {
					primitiveId: safeState<string>(t, 'getState_PrimitiveId'),
					x,
					y,
					content: safeState<string>(t, 'getState_Content'),
					fontSize: safeState<number>(t, 'getState_FontSize'),
					rotation: safeState<number>(t, 'getState_Rotation'),
					offGrid: (typeof x === 'number' && x % 10 !== 0) || (typeof y === 'number' && y % 10 !== 0),
				}
			})
		},
	},
	{
		name: 'schematic.modifyText',
		summary: '修改已有原理图文本（内容/位置/字号/颜色/旋转）；EDA 4.1.78 实机确认保存后会回退且本指令拒绝执行，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '文本图元 ID' },
			{ name: 'content', type: 'string', description: '新内容' },
			{ name: 'x', type: 'number', description: '新坐标 X' },
			{ name: 'y', type: 'number', description: '新坐标 Y' },
			{ name: 'fontSize', type: 'number', description: '字号' },
			{ name: 'textColor', type: 'string', description: '颜色' },
			{ name: 'rotation', type: 'number', description: '旋转角度' },
		],
		returns: '{ modified }',
		example: { cmd: 'schematic.modifyText', params: { primitiveId: 'xxx', content: 'V1.1' } },
		handler: async (params) => {
			requireEda42('schematic.modifyText')
			if (!params.primitiveId)
				throw new Error('缺少参数 primitiveId')
			const property: Record<string, any> = {}
			if (params.content != null)
				property.content = String(params.content)
			if (params.textColor != null)
				property.textColor = String(params.textColor)
			for (const k of ['x', 'y', 'fontSize', 'rotation']) {
				if (params[k] != null)
					property[k] = Number(params[k])
			}
			if (Object.keys(property).length === 0)
				throw new Error('至少提供一个要修改的属性')
			const tid = String(params.primitiveId)
			// 0.10.24 原子化（P10：官方 modify 多字段合并修改可能整体失效）——按类别拆步顺序执行
			const steps: Array<Record<string, any>> = []
			if (property.content != null)
				steps.push({ content: property.content })
			if (property.x != null || property.y != null) {
				const s: Record<string, any> = {}
				if (property.x != null)
					s.x = property.x
				if (property.y != null)
					s.y = property.y
				steps.push(s)
			}
			if (property.fontSize != null)
				steps.push({ fontSize: property.fontSize })
			if (property.textColor != null)
				steps.push({ textColor: property.textColor })
			if (property.rotation != null)
				steps.push({ rotation: property.rotation })
			let anyResult = false
			for (const stepProps of steps) {
				try {
					if (await eda.sch_PrimitiveText.modify(tid, stepProps as any))
						anyResult = true
				}
				catch { /* 假失败不轻信，读回为准 */ }
			}
			// 读回验证（官方返回值不可信，成败以读回为准）
			const readback: Record<string, unknown> = {}
			let verified = anyResult
			await new Promise(resolve => setTimeout(resolve, 300))
			try {
				const back = await eda.sch_PrimitiveText.get(tid)
				if (back) {
					const checks: Array<[string, string, any]> = []
					if (property.content != null)
						checks.push(['content', 'getState_Content', property.content])
					if (property.x != null)
						checks.push(['x', 'getState_X', property.x])
					if (property.y != null)
						checks.push(['y', 'getState_Y', property.y])
					if (property.rotation != null)
						checks.push(['rotation', 'getState_Rotation', property.rotation])
					if (property.fontSize != null)
						checks.push(['fontSize', 'getState_FontSize', property.fontSize])
					for (const [field, getter, want] of checks) {
						const actual = safeState<any>(back as any, getter)
						readback[field] = actual ?? null
						if (actual == null)
							verified = false
						else if (typeof want === 'number' ? Math.abs(Number(actual) - want) > 0.5 : String(actual) !== String(want))
							verified = false
					}
				}
				else {
					verified = false
				}
			}
			catch {
				verified = false
			}
			if (!verified)
				throw new Error(`文本 ${tid} 修改读回不匹配（读回 ${JSON.stringify(readback)}，目标 ${JSON.stringify(property)}）——官方 modify 假成功，请重试`)
			return { modified: true, ...(Object.keys(readback).length ? { readback: { ...readback, verified } } : {}) }
		},
	},
	{
		name: 'schematic.getPrimitivesInRegion',
		summary: '查询指定矩形区域内的原理图图元（返回 id+类型；布局避障用）；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [
			{ name: 'left', type: 'number', required: true, description: '区域左边界（10mil 单位）' },
			{ name: 'right', type: 'number', required: true, description: '区域右边界' },
			{ name: 'top', type: 'number', required: true, description: '区域上边界' },
			{ name: 'bottom', type: 'number', required: true, description: '区域下边界' },
		],
		returns: '[{ primitiveId, primitiveType }]',
		example: { cmd: 'schematic.getPrimitivesInRegion', params: { left: 300, right: 600, top: 300, bottom: 600 } },
		handler: async (params) => {
			requireEda42('schematic.getPrimitivesInRegion')
			for (const k of ['left', 'right', 'top', 'bottom']) {
				if (params[k] == null)
					throw new Error(`缺少参数 ${k}`)
			}
			const prims = await eda.sch_Document.getPrimitivesInRegion(
				Number(params.left), Number(params.right), Number(params.top), Number(params.bottom),
			)
			return (prims ?? []).map(p => ({
				primitiveId: safeState<string>(p, 'getState_PrimitiveId'),
				primitiveType: safeState<string>(p, 'getState_PrimitiveType'),
			}))
		},
	},
	{
		name: 'schematic.getPrimitiveAtPoint',
		summary: '查询指定坐标处的原理图图元（返回 id+类型）；EDA 4.1.78 实机确认不支持，需 EDA 4.2 或更高版本（4.2 尚未实机验收）',
		params: [
			{ name: 'x', type: 'number', required: true, description: '坐标 X（10mil 单位）' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y' },
		],
		returns: '{ primitiveId, primitiveType } 或 null',
		example: { cmd: 'schematic.getPrimitiveAtPoint', params: { x: 550, y: 400 } },
		handler: async (params) => {
			requireEda42('schematic.getPrimitiveAtPoint')
			if (params.x == null || params.y == null)
				throw new Error('缺少参数 x / y')
			const p = await eda.sch_Document.getPrimitiveAtPoint(Number(params.x), Number(params.y))
			if (!p)
				return null
			return {
				primitiveId: safeState<string>(p, 'getState_PrimitiveId'),
				primitiveType: safeState<string>(p, 'getState_PrimitiveType'),
			}
		},
	},
]
