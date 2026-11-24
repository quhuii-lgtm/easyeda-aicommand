import type { ICommandDef } from '../engine/types'
import { executeCommand } from '../engine/registry'
import { pcbSourceRevision } from '../pcb/dsnSourceSnapshot'
import { parseSourceLog } from '../pcb/sourcelog'
import { DFM_PACKAGE_CHECKS, JLC_SUPPORTED_MATERIALS, UPSTREAM_INFO, runOfficialDfm, type DfmKind, type DfmRun } from '../dfm/official'

type DfmInputs = {
	material?: string
	thickness?: number
	outerCopperOz?: 1 | 2
	innerCopperOz?: 1
	standard?: 'economy' | 'standard'
	minSpacingMm?: number
	smtDesignators?: string[]
	padPurposeEvidence?: Array<{ padId: string; classification: 'nc' | 'reserved' | 'mechanical' | 'other'; reason: string; source: string }>
}

const PAD_PURPOSE_CLASSIFICATIONS = new Set(['nc', 'reserved', 'mechanical', 'other'])

function validatePadPurposeEvidence(value: unknown): NonNullable<DfmInputs['padPurposeEvidence']> {
	if (!Array.isArray(value) || value.length > 500)
		throw new Error('padPurposeEvidence 必须是最多500项的数组')
	const seen = new Set<string>()
	return value.map((entry, index) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry))
			throw new Error(`padPurposeEvidence[${index}] 必须是对象`)
		const item = entry as Record<string, unknown>
		if (typeof item.padId !== 'string' || !item.padId.trim() || item.padId.length > 256)
			throw new Error(`padPurposeEvidence[${index}].padId 必须是非空精确图元ID`)
		if (seen.has(item.padId))
			throw new Error(`padPurposeEvidence 中 padId 重复：${item.padId}`)
		seen.add(item.padId)
		if (typeof item.classification !== 'string' || !PAD_PURPOSE_CLASSIFICATIONS.has(item.classification))
			throw new Error(`padPurposeEvidence[${index}].classification 必须为 nc、reserved、mechanical 或 other`)
		for (const field of ['reason', 'source'] as const) {
			if (typeof item[field] !== 'string' || !item[field].trim() || item[field].length > 2000)
				throw new Error(`padPurposeEvidence[${index}].${field} 必须是非空字符串（最多2000字符）`)
		}
		return { padId: item.padId, classification: item.classification as 'nc' | 'reserved' | 'mechanical' | 'other', reason: item.reason as string, source: item.source as string }
	})
}

const DEFAULT_TIMEOUT_MS = 290_000

function documentError(message: string): Error {
	return new Error(`DFM 检查已停止：${message}`)
}

function currentDocument(sdk: any, expectedUuid: string): Promise<void> {
	return sdk.dmt_SelectControl.getCurrentDocumentInfo().then((focus: any) => {
		if (focus?.uuid !== expectedUuid || focus?.documentType !== 3)
			throw documentError(`焦点已离开 PCB ${expectedUuid}，拒绝继续读取`)
	})
}

function timeoutBudget(params: Record<string, any>): number {
	return params._timeoutMs != null ? Math.max(1000, Number(params._timeoutMs)) : DEFAULT_TIMEOUT_MS
}

function guardedSdk(sdk: any, expectedUuid: string, budgetMs: number, startedAt: number) {
	const deadline = startedAt + budgetMs
	let failure: Error | undefined
	let tail: Promise<void> = Promise.resolve()
	const latch = (error: unknown): Error => {
		if (!failure)
			failure = error instanceof Error ? error : new Error(String(error))
		return failure
	}
	const checkDeadline = (): void => {
		if (failure)
			throw failure
		if (Date.now() >= deadline)
			throw latch(documentError(`超过现有 ${budgetMs}ms 执行预算，拒绝后续读取`))
	}
	const checkFocus = async (): Promise<void> => {
		checkDeadline()
		try {
			await currentDocument(sdk, expectedUuid)
		}
		catch (error) {
			throw latch(error)
		}
		checkDeadline()
	}
	const invoke = (target: any, name: string, path: string, method: (...args: any[]) => any, args: any[]): Promise<any> => {
		const operation = tail.then(async () => {
			await checkFocus()
			let result: any
			let callError: unknown
			let callFailed = false
			try {
				result = await Reflect.apply(method, target, args)
			}
			catch (error) {
				callFailed = true
				callError = error
			}
			checkDeadline()
			await checkFocus()
			if (callFailed)
				throw callError
			if (name === 'getDocumentSource') {
				try {
					const header = parseSourceLog(result)
					if (header.uuid !== expectedUuid || header.docType.toUpperCase() !== 'PCB')
						throw documentError(`源码 DOCHEAD 与 PCB ${expectedUuid} 不符`)
				}
				catch (error) {
					throw latch(error)
				}
			}
			return result
		})
		tail = operation.then(() => undefined, () => undefined)
		return operation
	}
	const cache = new WeakMap<object, any>()
	const wrap = (target: any, path: string): any => {
		if (!target || (typeof target !== 'object' && typeof target !== 'function'))
			return target
		if (cache.has(target))
			return cache.get(target)
		const proxy = new Proxy(target, {
			get(obj, key) {
				if (key === 'sys_Log')
					return { add: () => undefined }
				const value = Reflect.get(obj, key, obj)
				if (path === 'sdk.sys_Unit')
					return value
				if (typeof value === 'function')
					return (...args: any[]) => invoke(obj, String(key), `${path}.${String(key)}`, value, args)
				return wrap(value, `${path}.${String(key)}`)
			},
		})
		cache.set(target, proxy)
		return proxy
	}
	return {
		sdk: wrap(sdk, 'sdk'),
		checkFinal: checkFocus,
		throwIfFailed: () => { if (failure) throw failure },
	}
}

function validateInputs(kind: DfmKind, params: Record<string, any>): DfmInputs {
	if (kind !== 'pcb' && params.padPurposeEvidence !== undefined)
		throw new Error('padPurposeEvidence 仅适用于 pcb.runDfm')
	if (kind !== 'smt' && params.smtDesignators !== undefined)
		throw new Error('smtDesignators 仅适用于 pcb.runSmtDfm')
	if (kind === 'pcb') {
		if (typeof params.material !== 'string' || !JLC_SUPPORTED_MATERIALS.includes(params.material))
			throw new Error(`material 必须是受支持板材之一：${JLC_SUPPORTED_MATERIALS.join('、')}`)
		if (typeof params.thickness !== 'number' || !Number.isFinite(params.thickness) || params.thickness <= 0)
			throw new Error('thickness 必须是有限正数，单位 mm')
		if (params.outerCopperOz !== 1 && params.outerCopperOz !== 2)
			throw new Error('outerCopperOz 必须为数字 1 或 2')
		if (params.innerCopperOz !== 1)
			throw new Error('innerCopperOz 必须为数字 1（本次内层选项）')
		return {
			material: params.material, thickness: params.thickness, outerCopperOz: params.outerCopperOz, innerCopperOz: params.innerCopperOz,
			...(params.padPurposeEvidence === undefined ? {} : { padPurposeEvidence: validatePadPurposeEvidence(params.padPurposeEvidence) }),
		}
	}
	if (kind === 'smt') {
		if (params.standard !== 'economy' && params.standard !== 'standard')
			throw new Error('standard 必须为 economy 或 standard')
		if (typeof params.thickness !== 'number' || !Number.isFinite(params.thickness) || params.thickness <= 0)
			throw new Error('thickness 必须是有限正数，单位 mm')
		const roster = params.smtDesignators
		if (roster !== undefined && (!Array.isArray(roster) || roster.some(ref => typeof ref !== 'string' || !ref || ref !== ref.trim()) || new Set(roster).size !== roster.length))
			throw new Error('smtDesignators 必须是无重复的精确机贴位号数组')
		return { standard: params.standard, thickness: params.thickness, ...(roster === undefined ? {} : { smtDesignators: roster }) }
	}
	if (typeof params.minSpacingMm !== 'number' || !Number.isFinite(params.minSpacingMm) || params.minSpacingMm <= 0)
		throw new Error('minSpacingMm 必须是有限正数，单位 mm')
	return { minSpacingMm: params.minSpacingMm }
}

export async function runDfmCommand(kind: DfmKind, params: Record<string, any>, expectedUuid?: string) {
	const inputs = validateInputs(kind, params)
	const sdk = eda
	const startedAt = Date.now()
	const budgetMs = timeoutBudget(params)
	if (Date.now() - startedAt >= budgetMs)
		throw documentError(`超过现有 ${budgetMs}ms 执行预算，拒绝开始读取`)
	const focus = await sdk.dmt_SelectControl.getCurrentDocumentInfo()
	if (Date.now() - startedAt >= budgetMs)
		throw documentError(`超过现有 ${budgetMs}ms 执行预算，拒绝开始检查`)
	const documentUuid = expectedUuid ?? params.__docUuid ?? focus?.uuid
	if (focus?.documentType !== 3 || !documentUuid || focus.uuid !== documentUuid)
		throw documentError(`当前焦点不是要求的 PCB（要求 ${documentUuid ?? '有效 UUID'}，实际 ${focus?.uuid ?? '无焦点'}）`)
	const guarded = guardedSdk(sdk, documentUuid, budgetMs, startedAt)
	const readRevision = async () => {
		try {
			const source = await guarded.sdk.sys_FileManager.getDocumentSource()
			return await pcbSourceRevision(source, documentUuid)
		}
		catch {
			guarded.throwIfFailed()
			return null
		}
	}
	const initialRevision = kind === 'spacing' ? null : await readRevision()
	const core: DfmRun = await runOfficialDfm(kind, inputs, guarded.sdk)
	await guarded.checkFinal()
	guarded.throwIfFailed()
	const revision = initialRevision ? await readRevision() : null
	if (revision && revision !== initialRevision)
		throw documentError('PCB 内容在检查期间改变，请重新检查')
	return {
		...core,
		documentUuid,
		checkType: kind,
		checkScope: {
			object: 'active-pcb',
			revision,
			revisionStatus: revision ? 'verified' : 'unverified',
			ruleStatus: core.results.map(result => ({
				number: result.number, item: result.item, result: result.result,
				verification: core.issues.some(issue => issue.item === result.number) ? 'partial'
					: result.result === 'warning' ? 'review-required' : 'evaluated',
			})),
			assemblyBasis: kind === 'smt' ? inputs.smtDesignators === undefined ? 'board-geometry-estimate' : 'explicit-designators' : null,
			approximation: core.coverage,
			notCovered: [...DFM_PACKAGE_CHECKS],
		},
		inputs,
		timestamp: Date.now(),
		upstream: UPSTREAM_INFO,
	}
}

const def = (name: string, kind: DfmKind, params: ICommandDef['params'], summary: string): ICommandDef => ({
	name,
	summary,
	params,
	returns: kind === 'pcb'
		? '{ results, expectedCount, issues, coverage, checkScope, upstreamPassed, complete, passed, reportedCopper, documentUuid, checkType, inputs, timestamp, upstream }'
		: '{ results, expectedCount, issues, coverage, checkScope, upstreamPassed, complete, passed, documentUuid, checkType, inputs, timestamp, upstream }',
	example: { cmd: name, params: kind === 'pcb'
		? { material: JLC_SUPPORTED_MATERIALS[0], thickness: 1.6, outerCopperOz: 1, innerCopperOz: 1 }
		: kind === 'smt' ? { standard: 'economy', thickness: 1.6 } : { minSpacingMm: 0.13 } },
	handler: async values => runDfmCommand(kind, values),
})

export const dfmCommands: ICommandDef[] = [
	def('pcb.runDfm', 'pcb', [
		{ name: 'material', type: 'string', required: true, description: `板材型号；从以下来源清单中选择：${JLC_SUPPORTED_MATERIALS.join('、')}` },
		{ name: 'thickness', type: 'number', required: true, description: '板厚，单位 mm，必须为有限正数' },
		{ name: 'outerCopperOz', type: 'number', required: true, description: '下单外层铜厚，当前提供 1 或 2 oz；无默认值' },
		{ name: 'innerCopperOz', type: 'number', required: true, description: '下单内层铜厚，本次提供 1 oz；无默认值' },
		{ name: 'padPurposeEvidence', type: 'array', required: false, description: '可选项目证据标注：[{padId,classification:"nc"|"reserved"|"mechanical"|"other",reason,source}]。按当前PCB精确 Primitive ID 匹配；不替代PCB网络/几何证据，不抑制原始 DFM issue；有效网络冲突、ID缺失/重复均保留为冲突/unknown。source 和 reason 由调用方提供，不代表宿主独立验证。' },
	], '执行基于嘉立创下单检查器 v1.0.4 的 PCB DFM 检查；结果 complete 与 passed 分开，覆盖边界见 coverage。reportedCopper 保留图纸原始厚度记录；当前源码厚度单位未确认，不换算为 mil/oz，也不据此判断下单铜重一致。输入铜重仍用于本次制造能力检查。'),
	def('pcb.runSmtDfm', 'smt', [
		{ name: 'standard', type: 'string', required: true, description: 'SMT标准：economy（经济型）或 standard（标准型）' },
		{ name: 'thickness', type: 'number', required: true, description: 'PCB板厚，单位 mm，必须为有限正数' },
		{ name: 'smtDesignators', type: 'string[]', description: '可选。当前 PCB 的机贴位号，按名单检查贴装面、最小封装、IC 脚距和 BGA 球距。可使用 pcb.preflightAssembly 返回的名单；省略时按板上图元估计。' },
	], '执行基于嘉立创下单检查器 v1.0.4 的 SMT DFM 检查；结果 complete 与 passed 分开，覆盖边界见 coverage。'),
	def('pcb.checkSameNetPadSpacing', 'spacing', [
		{ name: 'minSpacingMm', type: 'number', required: true, description: '同网络焊盘最小边缘间距，单位 mm，必须为有限正数' },
	], '按指定最小间距检查同网络焊盘；来源和上游几何近似边界见 coverage。'),
]

export async function executeDfmCommand(kind: DfmKind, params: Record<string, any>, expectedUuid: string) {
	const command = dfmCommands.find(definition => definition.name === commandName(kind))
	if (!command)
		throw new Error(`未知 DFM 检查类型：${kind}`)
	return executeCommand({ cmd: command.name, params: { ...params, __docUuid: expectedUuid } })
}

export function commandName(kind: DfmKind): string {
	return kind === 'pcb' ? 'pcb.runDfm' : kind === 'smt' ? 'pcb.runSmtDfm' : 'pcb.checkSameNetPadSpacing'
}
