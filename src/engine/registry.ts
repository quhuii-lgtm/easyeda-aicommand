/**
 * 指令注册表与执行器
 *
 * 核心能力：
 * 1. 指令注册 / 查询（含文档元数据）
 * 2. 统一返回格式 { ok, cmd, data | error, durationMs }
 * 3. 宏指令（macro）：按序执行多个步骤，支持 `$stepId.path` 变量引用
 */
import type {
	ICommandContext,
	ICommandDef,
	ICommandRequest,
	IMacroStep,
	TCommandResult,
} from './types'
import { beginTask, failTask, finishTask, taskProgress } from './tasks'
import { diag } from './diag'

const registry = new Map<string, ICommandDef>()

export function registerCommand(def: ICommandDef): void {
	registry.set(def.name, def)
}

export function hasCommand(name: string): boolean {
	return registry.has(name)
}

/** 指令文档（喂给 AI 的元数据，不含 handler） */
export function getCommandDocs(): Array<Omit<ICommandDef, 'handler'>> {
	return [...registry.values()].map(({ handler: _handler, ...doc }) => doc)
}

export function listCommandNames(): Array<string> {
	return [...registry.keys()]
}

/**
 * 0.10.51（GPT KIMI-EDA-20261002-07）：错误详情序列化——供 errorResult 与 batchWire 等
 * 「直接调用其他 handler、绕过 errorResult」的路径共用。保留 stage 前缀 message + name +
 * 截断堆栈 + 可序列化 cause（递归一层）。
 */
export function serializeErrorDetail(err: unknown): { message: string, name?: string, stack?: string, cause?: unknown } {
	let message: string
	if (err instanceof Error)
		message = err.message
	else {
		try {
			message = JSON.stringify(err, null, 0) ?? String(err)
		}
		catch {
			message = String(err)
		}
		if (message === '[object Object]') {
			message = `官方返回了不可序列化的错误对象（keys: ${err && typeof err === 'object' ? Object.keys(err as object).join(',') : typeof err}）`
		}
	}
	const name = err instanceof Error ? err.name : undefined
	const stack = err instanceof Error && err.stack ? String(err.stack).slice(0, 4000) : undefined
	let cause: unknown
	const rawCause = (err as any)?.cause
	if (rawCause !== undefined && rawCause !== null) {
		try {
			cause = rawCause instanceof Error
				? { message: rawCause.message, name: rawCause.name, stack: rawCause.stack ? String(rawCause.stack).slice(0, 2000) : undefined }
				: JSON.parse(JSON.stringify(rawCause) ?? 'null')
		}
		catch {
			cause = String(rawCause)
		}
	}
	return { message, ...(name ? { name } : {}), ...(stack ? { stack } : {}), ...(cause !== undefined ? { cause } : {}) }
}

/** 0.10.62：单指令熔断计时器（Promise.race 实现；熔断后原 Promise 仍在后台，与"超时≠取消"语义一致） */
function withFuse<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(label)), ms)
		p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
	})
}

/**
 * 心跳感知熔断（0.10.65）：与 withFuse 的区别是每次心跳（onArm 拿到的 reset 回调）重设计时窗口，
 * 只有「超过 ms 无任何心跳」才拒绝。不上报心跳的指令退化为绝对时长熔断（与 withFuse 等价）。
 */
function withHeartbeatFuse<T>(p: Promise<T>, ms: number, label: string, onArm: (reset: () => void) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		// 0.10.73：熔断杀死的拒绝带 partial 标记（经 cause 透传到 error 对象）——代理侧据此区分
		// "包装层超时返回"与"指令真实完成"，只有后者才允许解除写保护（KIMI-EDA-20261006-04 P1-3）
		const fuseError = () => new Error(label, { cause: { partial: true, source: 'heartbeat-fuse' } })
		let timer = setTimeout(() => reject(fuseError()), ms)
		onArm(() => {
			clearTimeout(timer)
			timer = setTimeout(() => reject(fuseError()), ms)
		})
		p.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
	})
}

function errorResult(cmd: string, err: unknown, suggestion?: string, durationMs = 0): TCommandResult {
	// 0.10.39：官方 API 经常 reject 一个普通对象（{code, message} 等），String(err) 会变成 "[object Object]"
	// 把真实错误吞掉（GPT 与 LoRa 封装改名均踩到）。非 Error 一律先尝试 JSON 序列化保留全部字段。
	const detail = serializeErrorDetail(err)
	return {
		ok: false,
		cmd,
		error: {
			...detail,
			...(suggestion ? { suggestion } : {}),
		},
		durationMs,
	}
}

/** 解析 `$stepId.path.to.value` / `$stepId[0].x` 形式的变量引用 */
function lookupVar(ref: string, ctx: ICommandContext): any {
	const m = /^\$([\w-]+)((?:\.[\w$-]+|\[[\w$-]+\])*)$/.exec(ref)
	if (!m)
		throw new Error(`非法变量引用: ${ref}`)
	const [, root, rest] = m
	if (!(root in ctx.vars))
		throw new Error(`变量 $${root} 不存在（前序步骤未设置 id 或未执行成功）`)
	let value: any = ctx.vars[root]
	const segRe = /\.([\w$-]+)|\[([\w$-]+)\]/g
	let seg: RegExpExecArray | null
	while ((seg = segRe.exec(rest)) !== null) {
		const key = seg[1] ?? seg[2]
		if (value == null)
			throw new Error(`变量引用 ${ref} 在 "${key}" 处为空`)
		value = value[key]
	}
	if (value === undefined)
		throw new Error(`变量引用 ${ref} 不存在该字段（前序步骤返回里没有 ${rest}）`)
	return value
}

/** 深度替换 params 中的变量引用（仅完整字符串引用，不做字符串内插值） */
export function resolveRefs<T>(value: T, ctx: ICommandContext): T {
	if (typeof value === 'string' && value.startsWith('$'))
		return lookupVar(value, ctx)
	if (Array.isArray(value))
		return value.map(item => resolveRefs(item, ctx)) as T
	if (value !== null && typeof value === 'object') {
		const out: Record<string, any> = {}
		for (const [k, v] of Object.entries(value))
			out[k] = resolveRefs(v, ctx)
		return out as T
	}
	return value
}

/** 执行单条指令 */
export async function executeCommand(req: ICommandRequest, ctx?: ICommandContext): Promise<TCommandResult> {
	const started = Date.now()
	const cmd = req?.cmd
	if (!cmd || typeof cmd !== 'string')
		return errorResult(String(cmd), new Error('缺少 cmd 字段'), '请求格式为 { cmd: string, params?: object }')

	if (cmd === 'macro')
		return executeMacro(req.params ?? {}, ctx)

	const def = registry.get(cmd)
	if (!def) {
		return errorResult(
			cmd,
			new Error(`未知指令: ${cmd}`),
			`调用 __listCommands 获取全部可用指令（或代理端 GET /commands）`,
		)
	}

	const context = ctx ?? { vars: {} }
	try {
		const params = resolveRefs(req.params ?? {}, context)
		// 文档类型守卫：schematic.*/pcb.* 指令要求焦点文档类型匹配。
		// 官方读接口在焦点不在目标文档时可能返回空数据（不报错），写接口则可能静默失败，
		// 曾导致"放置成功但读回为空/写到错误文档"的误判。守卫把这类情况变成明确报错。
		const needDocType = cmd.startsWith('schematic.') ? 1 : cmd.startsWith('pcb.') ? 3 : 0
		if (needDocType) {
			// 0.10.73（KIMI-EDA-20261006-04 P1-1 复核）：删除"全树同类候选唯一→自愈"分支——
			// 唯一候选也可能是无关页（焦点在 PCB、树上只有一个未激活的无关原理图标签的反例），
			// 候选数量不能证明目标身份（GPT 复核定案）。现规则：**只有激活的同类标签才自愈**
			// （这是已确认的"焦点卡住"场景：激活页=用户/AI 正在看的页=操作目标）；
			// 无激活命中 → 拒绝，要求显式声明目标（params.__docUuid）并 editor.openDocument 激活。
			const expectUuid = typeof (params as any)?.__docUuid === 'string' && (params as any).__docUuid
				? (params as any).__docUuid
				: undefined
			let doc = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => undefined)
			if (doc?.documentType !== needDocType) {
				// 焦点卡住自愈（实测：层叠变更等操作后 getCurrentDocumentInfo 可能滞留旧文档，
				// 此时激活中的标签页已是正确类型）：只认当前激活的同类标签，绝不猜测未激活标签
				try {
					const tree = await (eda.dmt_EditorControl as any).getSplitScreenTree()
					let activeHit: any
					const walk = (node: any): void => {
						if (!node)
							return
						if (Array.isArray(node.tabs)) {
							for (const t of node.tabs) {
								if (t?.documentType === needDocType && t.active && !activeHit)
									activeHit = t
							}
						}
						for (const child of node.children ?? [])
							walk(child)
					}
					walk(tree)
					const target = activeHit
					if (target?.tabId) {
						await eda.dmt_EditorControl.activateDocument(String(target.tabId)).catch(() => false)
						await new Promise(resolve => setTimeout(resolve, 300))
						doc = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => undefined)
					}
				}
				catch {
					// 自愈失败走原报错
				}
			}
			if (doc?.documentType !== needDocType) {
				const want = needDocType === 1 ? '原理图' : 'PCB'
				return errorResult(
					cmd,
					new Error(`当前焦点文档不是${want}（documentType=${doc?.documentType ?? '无焦点文档'}），且没有激活的同类标签可自愈。请先 editor.listTabs 找到目标文档，editor.openDocument 激活后重试；页级操作建议显式传 params.__docUuid 声明目标页身份`),
					undefined,
					Date.now() - started,
				)
			}
			if (expectUuid && doc?.uuid !== expectUuid) {
				return errorResult(
					cmd,
					new Error(`焦点文档与 __docUuid 不符（焦点=${doc?.uuid ?? '未知'}，要求=${expectUuid}）。请 editor.openDocument 激活目标文档后重试`),
					undefined,
					Date.now() - started,
				)
			}
		}
		// 0.10.62：单指令全局熔断——此前裸 await handler，某个官方调用挂起会占住扩展执行队列
		// 直到代理 300s 超时。默认 290s（给 delete 批量 ~200s 余量），_timeoutMs 参数可覆盖（最小 1s）。
		// macro 排除：自带任务注册/逐步心跳体系，长宏靠心跳保活，不能套总时长熔断。
		// 0.10.65 修复：客户端看门狗对批量指令放宽 300s 且按进度心跳重置（0.10.49），本熔断原为
		// 290s 绝对时长——健康长批量在 (290s,300s] 会被误杀报超时（后台仍在跑）。改为心跳感知：
		// 每次 onProgress 上报重置熔断窗口；不上报心跳的指令行为与旧版一致（绝对时长熔断）。
		let data: any
		if (cmd === 'macro')
			data = await def.handler(params, context)
		else {
			const fuseMs = params._timeoutMs != null ? Math.max(1000, Number(params._timeoutMs)) : 290_000
			let resetFuse: () => void = () => {}
			const hbContext: ICommandContext = context.onProgress
				? { ...context, onProgress: (patch) => { resetFuse(); context.onProgress?.(patch) } }
				: context
			data = await withHeartbeatFuse(
				def.handler(params, hbContext),
				fuseMs,
				`指令 ${cmd} 执行超时（${fuseMs}ms 无进度心跳）——官方调用可能仍在后台执行，重发前先用只读指令确认现场`,
				(r) => { resetFuse = r },
			)
		}
		return { ok: true, cmd, data: data ?? null, durationMs: Date.now() - started }
	}
	catch (err) {
		return errorResult(cmd, err, undefined, Date.now() - started)
	}
}

/** 执行宏指令：按序执行 steps，步骤结果存入 vars[id] */
async function executeMacro(
	params: { steps?: Array<IMacroStep>, stopOnError?: boolean },
	parentCtx?: ICommandContext,
): Promise<TCommandResult> {
	const started = Date.now()
	const steps = params.steps
	if (!Array.isArray(steps) || steps.length === 0)
		return errorResult('macro', new Error('macro 指令需要非空 steps 数组'))

	const stopOnError = params.stopOnError !== false
	// 0.10.49：宏注册长任务——客户端超时后同参数重发只回进度不重复执行；逐步心跳重置代理/扩展超时
	const { task, existing } = beginTask('macro', { steps, stopOnError },
		parentCtx && ((t) => parentCtx.onProgress?.({ taskId: t.id, state: t.state, ...t.progress })))
	if (existing) {
		return {
			ok: true,
			cmd: 'macro',
			data: {
				taskId: task.id,
				alreadyRunning: true,
				state: task.state,
				progress: task.progress,
				note: '相同宏仍在后台执行——这是实时进度，稍后重发或 task.get 取结果即可，不要改参数重发',
			},
			durationMs: Date.now() - started,
		} as TCommandResult
	}
	// onProgress 必须穿透给子指令（batchWire/delete 等长指令才有心跳通道）
	const ctx: ICommandContext = { vars: { ...(parentCtx?.vars ?? {}) }, onProgress: parentCtx?.onProgress }
	const results: Array<TCommandResult> = []

	for (const [index, step] of steps.entries()) {
		if (!step?.cmd) {
			results.push(errorResult('unknown', new Error(`第 ${index + 1} 步缺少 cmd 字段`)))
			if (stopOnError)
				break
			continue
		}
		taskProgress(task, { stage: 'step', step: index + 1, totalSteps: steps.length, cmd: step.cmd, failed: results.filter(r => !r.ok).length })
		const result = await executeCommand({ cmd: step.cmd, params: step.params }, ctx)
		results.push(result)
		diag('macro', 'step-done', `第${index + 1}/${steps.length}步 ${step.cmd} ok=${result.ok}${result.ok ? '' : ` 错误=${result.error?.message ?? ''}`}`)
		if (result.ok && step.id)
			ctx.vars[step.id] = result.data
		const partialCause = (result as any)?.error?.cause
		// partial 表示包装层已停止等待，但官方调用可能还在后台改工程。即使 stopOnError=false
		// 也必须停宏，避免后续写入与未确认的旧写交错；保留 cause 供代理写保护识别。
		if (partialCause?.partial === true) {
			const failed = results.filter(r => !r.ok).length
			const unexecutedSteps = steps.length - index - 1
			failTask(task, `第 ${index + 1} 步（${step.cmd}）结果不确定`)
			diag('macro', 'stopped-partial', `第${index + 1}步 ${step.cmd} 返回 partial，跳过后续 ${unexecutedSteps} 步`)
			return {
				ok: false,
				cmd: 'macro',
				error: {
					message: `宏在第 ${index + 1} 步（${step.cmd}）结果不确定：官方操作可能仍在后台执行；已停止并跳过后续 ${unexecutedSteps} 步。不要直接重发该宏。`,
					suggestion: '先用只读指令核对现场并确认原操作已结束，再决定如何处理写保护。',
					cause: partialCause,
				},
				data: { total: results.length, failed, steps: results, stoppedAtStep: index + 1, stoppedReason: 'partial', unexecutedSteps, taskId: task.id },
				durationMs: Date.now() - started,
			} as TCommandResult
		}
		// 0.10.52（KIMI-EDA-20261003-09）：健康降级传播——子步骤 sessionHealth=degraded 时
		// 写通道可能已损坏，继续执行后续写入只会扩大残留/假成功，必须当作停止条件；
		// 此前只认 result.ok，delete 返回 ok:true+degraded 被宏吞掉，最终 total8/failed0 掩盖降级。
		const stepHealth = ((result as any).data as any)?.sessionHealth as string | undefined
		if (stepHealth === 'degraded' && stopOnError) {
			const stepProbeResidue = ((result as any).data as any)?.probeResidue as string | undefined
			failTask(task, `第 ${index + 1} 步（${step.cmd}）会话健康降级`)
			diag('macro', 'stopped-health-degraded', `第${index + 1}步 ${step.cmd} probeResidue=${stepProbeResidue ?? '无'}`)
			return {
				ok: false,
				cmd: 'macro',
				error: {
					message: `宏在第 ${index + 1} 步（${step.cmd}）检测到会话健康降级（sessionHealth=degraded）——依赖写入已中断，未执行的 ${steps.length - index - 1} 步已跳过${stepProbeResidue ? `；探针残留 ${stepProbeResidue}` : ''}`,
					suggestion: '先只用只读指令复核现场（listWires/listNetLabels/exportNetlist），确认会话健康后重发本宏；探针残留用 schematic.delete 定点删除',
				},
				data: {
					total: results.length,
					failed: results.filter(r => !r.ok).length,
					steps: results,
					stoppedAtStep: index + 1,
					stoppedReason: 'sessionHealth:degraded',
					sessionHealth: 'degraded',
					...(stepProbeResidue ? { probeResidue: stepProbeResidue } : {}),
					unexecutedSteps: steps.length - index - 1,
					taskId: task.id,
				},
				durationMs: Date.now() - started,
			} as TCommandResult
		}
		if (!result.ok && stopOnError) {
			failTask(task, `第 ${index + 1} 步（${step.cmd}）失败`)
			return {
				ok: false,
				cmd: 'macro',
				error: {
					message: `宏在第 ${index + 1} 步（${step.cmd}）失败: ${result.error.message}`,
					suggestion: '已中断后续步骤；修正该步参数后重试',
				},
				durationMs: Date.now() - started,
			}
		}
	}

	const failed = results.filter(r => !r.ok).length
	// 0.10.52：降级步骤汇总——即使 stopOnError=false 继续跑完，最终数据也必须暴露哪些步降级过
	const degradedSteps = results
		.map((r, i) => ({ health: ((r as any).data as any)?.sessionHealth as string | undefined, step: i + 1, cmd: steps[i]?.cmd }))
		.filter(s => s.health === 'degraded')
	finishTask(task, { total: results.length, failed, degradedSteps: degradedSteps.length })
	diag('macro', 'macro-done', `total=${results.length} failed=${failed} degraded=${degradedSteps.length}`)
	return {
		ok: failed === 0,
		cmd: 'macro',
		data: {
			total: results.length,
			failed,
			steps: results,
			taskId: task.id,
			...(degradedSteps.length ? {
				degradedSteps: degradedSteps.map(s => ({ step: s.step, cmd: s.cmd })),
				warning: `${degradedSteps.length} 个步骤返回 sessionHealth=degraded——写通道当时可能已劣化，这些步的结果（含 reconciled/probeResidue）需逐项复核，别直接采信全成功`,
			} : {}),
		},
		durationMs: Date.now() - started,
	} as TCommandResult
}

// 0.10.39：macro 注册为正式指令文档——/commands（__listCommands）与 /help 都会列出它。
// 之前 macro 只在 executeCommand 里特判，不在注册表，OpenCode 固定执行器预检查读 /commands 发现 macro 没列出而拒绝。
// 执行路径不变（executeCommand 仍先拦截 'macro'），这里的 handler 只是兜底。
registerCommand({
	name: 'macro',
	summary: '宏指令：按序执行多个步骤，支持 $stepId.path 变量引用前序步骤返回的 data',
	params: [
		{ name: 'steps', type: 'array', required: true, description: '步骤数组 [{ id?, cmd, params? }]；id 命名后，后续步骤可用 "$id.字段路径" 引用该步返回的 data' },
		{ name: 'stopOnError', type: 'boolean', description: '任一步失败即中断（默认 true）；0.10.52 起子步骤 sessionHealth=degraded 同样触发中断（写通道劣化时不再继续写入），降级步骤在返回 degradedSteps/warning 里暴露，不会 total/failed0 掩盖' },
	],
	returns: '{ total, failed, steps: [每步的指令返回] }',
	example: { cmd: 'macro', params: { steps: [{ id: 'c', cmd: 'project.create', params: { name: 'demo' } }, { cmd: 'editor.openDocument', params: { uuid: '$c.projectUuid' } }] } },
	handler: async params => executeMacro(params as { steps?: Array<IMacroStep>, stopOnError?: boolean }),
})
