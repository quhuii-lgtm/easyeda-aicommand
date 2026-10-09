import type { ICommandDef } from '../engine/types'
import { executeCommand } from '../engine/registry'
import { parseSourceLog } from '../pcb/sourcelog'
import { JLC_SUPPORTED_MATERIALS, UPSTREAM_INFO, runOfficialDfm, type DfmKind, type DfmRun } from '../dfm/official'

type DfmInputs = {
	material?: string
	thickness?: number
	outerCopperOz?: 1 | 2
	innerCopperOz?: 1
	standard?: 'economy' | 'standard'
	minSpacingMm?: number
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
	if (kind === 'pcb') {
		if (typeof params.material !== 'string' || !JLC_SUPPORTED_MATERIALS.includes(params.material))
			throw new Error(`material 必须是受支持板材之一：${JLC_SUPPORTED_MATERIALS.join('、')}`)
		if (typeof params.thickness !== 'number' || !Number.isFinite(params.thickness) || params.thickness <= 0)
			throw new Error('thickness 必须是有限正数，单位 mm')
		if (params.outerCopperOz !== 1 && params.outerCopperOz !== 2)
			throw new Error('outerCopperOz 必须为数字 1 或 2')
		if (params.innerCopperOz !== 1)
			throw new Error('innerCopperOz 必须为数字 1（本次内层选项）')
		return { material: params.material, thickness: params.thickness, outerCopperOz: params.outerCopperOz, innerCopperOz: params.innerCopperOz }
	}
	if (kind === 'smt') {
		if (params.standard !== 'economy' && params.standard !== 'standard')
			throw new Error('standard 必须为 economy 或 standard')
		if (typeof params.thickness !== 'number' || !Number.isFinite(params.thickness) || params.thickness <= 0)
			throw new Error('thickness 必须是有限正数，单位 mm')
		return { standard: params.standard, thickness: params.thickness }
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
	const core: DfmRun = await runOfficialDfm(kind, inputs, guarded.sdk)
	await guarded.checkFinal()
	guarded.throwIfFailed()
	return {
		...core,
		documentUuid,
		checkType: kind,
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
		? '{ results, expectedCount, issues, coverage, upstreamPassed, complete, passed, reportedCopper, documentUuid, checkType, inputs, timestamp, upstream }'
		: '{ results, expectedCount, issues, coverage, upstreamPassed, complete, passed, documentUuid, checkType, inputs, timestamp, upstream }',
	example: { cmd: name },
	handler: async values => runDfmCommand(kind, values),
})

export const dfmCommands: ICommandDef[] = [
	def('pcb.runDfm', 'pcb', [
		{ name: 'material', type: 'string', required: true, description: `板材型号；从以下来源清单中选择：${JLC_SUPPORTED_MATERIALS.join('、')}` },
		{ name: 'thickness', type: 'number', required: true, description: '板厚，单位 mm，必须为有限正数' },
		{ name: 'outerCopperOz', type: 'number', required: true, description: '下单外层铜厚，当前提供 1 或 2 oz；无默认值' },
		{ name: 'innerCopperOz', type: 'number', required: true, description: '下单内层铜厚，本次提供 1 oz；无默认值' },
	], '执行基于嘉立创下单检查器 v1.0.4 的 PCB DFM 检查；结果 complete 与 passed 分开，覆盖边界见 coverage。'),
	def('pcb.runSmtDfm', 'smt', [
		{ name: 'standard', type: 'string', required: true, description: 'SMT标准：economy（经济型）或 standard（标准型）' },
		{ name: 'thickness', type: 'number', required: true, description: 'PCB板厚，单位 mm，必须为有限正数' },
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
