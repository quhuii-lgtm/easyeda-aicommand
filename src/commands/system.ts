/**
 * 系统/调试类指令：eval 逃生口（排障专用）+ 长任务状态查询（0.10.42）
 */
import type { ICommandDef } from '../engine/types'
import { getTask, listTasks } from '../engine/tasks'

/** JSON 序列化（容忍循环引用与 BigInt） */
function safeSerialize(value: unknown): unknown {
	const seen = new WeakSet()
	return JSON.parse(JSON.stringify(value ?? null, (_key, v) => {
		if (typeof v === 'bigint')
			return String(v)
		if (typeof v === 'function')
			return `[Function ${v.name || 'anonymous'}]`
		if (v && typeof v === 'object') {
			if (seen.has(v as object))
				return '[Circular]'
			seen.add(v as object)
		}
		return v
	}))
}

export const systemCommands: Array<ICommandDef> = [
	{
		name: 'system.eval',
		summary: '【调试专用】在扩展上下文执行任意 JS 代码（全局 eda 可用，支持 await），返回 JSON 序列化结果。正常操作用封装指令，仅排障时使用',
		params: [
			{ name: 'code', type: 'string', required: true, description: 'JS 代码体，用 return 返回结果；自动包在 async 函数中，可直接 await' },
		],
		returns: '代码 return 的值（JSON 安全序列化，循环引用显示为 [Circular]）',
		example: { cmd: 'system.eval', params: { code: 'return await eda.dmt_EditorControl.getSplitScreenTree()' } },
		handler: async (params) => {
			if (!params.code)
				throw new Error('缺少参数 code')
			// 0.10.36 实测定论：EDA 扩展沙箱同时禁用 new Function 和全局 eval（前者抛
			// "Function is not a constructor"，后者 "is not a function"），本指令在当前运行环境不可用，
			// 保留仅作占位；需要任意代码调试请提需求封正式指令
			throw new Error('system.eval 不可用：EDA 扩展沙箱禁用了动态代码执行（new Function 与 eval 均被移除）。请改用封装指令，或向插件提新指令需求')
		},
	},
	{
		name: 'task.get',
		summary: '查询长任务状态与结果（0.10.42，GPT KIMI-EDA-20261002-03）：批量删除等长指令客户端超时后，扩展侧任务仍在跑——用本指令查实时进度（state/progress），完成后补取最终结果（result），不要盲重发。相同参数的任务在跑时重发原指令会直接返回 running 进度而不会重复执行。结果保留 15 分钟',
		params: [
			{ name: 'taskId', type: 'string', required: true, description: '任务 ID（长指令返回里的 taskId 字段）' },
		],
		returns: '{ id, cmd, state: running|done|error, startedAt, updatedAt, progress, result?, error? }',
		example: { cmd: 'task.get', params: { taskId: 'task-xxx-1' } },
		handler: async (params) => {
			if (!params.taskId)
				throw new Error('缺少参数 taskId')
			const t = getTask(String(params.taskId))
			if (!t)
				throw new Error(`任务不存在或结果已过期（结果只保留 15 分钟）：${params.taskId}。用 task.list 看当前在册任务`)
			return t
		},
	},
	{
		name: 'task.list',
		summary: '列出在册长任务（不含结果正文，看详情用 task.get）',
		params: [],
		returns: '{ tasks: [{ id, cmd, state, startedAt, updatedAt, error? }], count }——0.10.44 起包一层对象：空注册表是 count:0/tasks:[]，不是 null；null 不可作为「后台已无任务」的证据',
		example: { cmd: 'task.list' },
		handler: async () => {
			const tasks = listTasks()
			return { tasks, count: tasks.length }
		},
	},
]
