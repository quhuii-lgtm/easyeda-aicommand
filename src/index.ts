/**
 * AI Command Engine — 扩展入口
 *
 * 激活时：
 * 1. 注册全部内置指令到指令引擎
 * 2. 启动桥接客户端，主动连接本地指令代理（bridge/command-proxy.mjs，默认 ws://127.0.0.1:49720/ws）
 * 3. 同时在全局对象挂载 __aiCommand 作为诊断/备用通道
 *
 * 注意：扩展运行在独立 JS 上下文，window 不与其他扩展共享，
 * 因此与 AI 的通信必须走本扩展自己的 WebSocket 连接。
 */
import { isBridgeConnected, startBridgeClient, stopBridgeClient } from './bridge/client'
import { cbbCommands } from './commands/cbb'
import { editorCommands } from './commands/editor'
import { knowledgeCommands } from './commands/knowledge'
import { libCommands } from './commands/lib'
import { pcbCommands } from './commands/pcb'
import { pcbGroupingCommands } from './commands/pcbGrouping'
import { libraryCommands, projectCommands } from './commands/project'
import { schematicCommands } from './commands/schematic'
import { systemCommands } from './commands/system'
import { executeCommand, getCommandDocs, listCommandNames, registerCommand } from './engine/registry'
import type { ICommandRequest } from './engine/types'
import extensionConfig from '../extension.json' with { type: 'json' }

let registered = false

function registerAllCommands(): void {
	for (const def of [
		...projectCommands,
		...libraryCommands,
		...editorCommands,
		...schematicCommands,
		...pcbCommands,
		...pcbGroupingCommands,
		...knowledgeCommands,
		...systemCommands,
		...cbbCommands,
		...libCommands,
	])
		registerCommand(def)
}

/** 0.10.70（KIMI-EDA-20261006-01）：幂等激活守卫。EDA 会为同一扩展累积多个 JS 上下文
 * （每次导入/部分菜单点击都可能产生新上下文），某些上下文里官方只回调菜单导出函数而不调
 * activate()——该上下文指令表就只有 import 时自动注册的 macro（残态，0.10.65 首装即遇过）。
 * 所有对外导出函数都先走这里，保证任何上下文首次被调用时指令注册与桥接都已就绪。 */
function ensureActivated(): void {
	if (registered)
		return
	activate()
}

export function activate(status?: 'onStartupFinished', arg?: string): void {
	if (registered)
		return
	registered = true

	try {
		registerAllCommands()

		// 备用/诊断通道：挂到全局对象
		;(globalThis as any).__aiCommand = {
			version: extensionConfig.version,
			execute: async (req: ICommandRequest) => executeCommand(req),
			listCommands: async () => listCommandNames(),
			help: async (cmd?: string) => {
				const docs = getCommandDocs()
				if (cmd)
					return docs.filter(doc => doc.name === cmd)
				return docs
			},
		}

		// 主通道：WebSocket 连接本地指令代理（需要「外部交互」权限）
		startBridgeClient()

		try {
			eda.sys_Log.add(`AI Command Engine v${extensionConfig.version} 已激活，注册指令 ${listCommandNames().length} 条`)
		}
		catch {
			// 日志失败不影响激活
		}
	}
	catch (err) {
		// 激活失败时直接弹窗，便于排查
		eda.sys_Dialog.showInformationMessage(
			`AI Command Engine 激活失败: ${err instanceof Error ? err.message : String(err)}`,
			'Error',
		)
	}
}

export function about(): void {
	ensureActivated()
	const bridgeStatus = isBridgeConnected() ? '已连接指令代理' : '未连接指令代理（请先运行 bridge/command-proxy.mjs，或点菜单「连接指令代理」）'
	eda.sys_Dialog.showInformationMessage(
		`AI Command Engine v${extensionConfig.version}\n已注册 ${listCommandNames().length} 条指令\n桥接状态：${bridgeStatus}`,
		'About',
	)
}

/**
 * 菜单「连接指令代理」：连接/强制重连本地指令代理。
 * 已连接时调用 = 断开重连一次（代理重启后用它恢复）；未连接时立即发起连接。
 * 0.10.64（KIMI-EDA-20261005-01）
 */
export function connectBridge(): void {
	ensureActivated()
	// 0.10.65 修复：先取连接状态再调 startBridgeClient（该方法会把 connected 复位后重连，
	// 后取状态会让已连接场景误显示「代理未运行」分支文案）
	const wasConnected = isBridgeConnected()
	startBridgeClient()
	eda.sys_Dialog.showInformationMessage(
		`已请求连接指令代理（ws://127.0.0.1:49720）\n`
		+ `${wasConnected ? '此前已连接，本次为强制重连（适合代理重启后恢复）' : '若代理未运行，激活时已尝试过 ai-command-proxy:// 自动拉起；仍失败请手动运行 bridge/command-proxy.mjs'}\n`
		+ '连接结果可稍候点「About...」查看桥接状态',
		'连接指令代理',
	)
}

/** 菜单「断开指令代理」：断开连接并暂停自动重连（0.10.64） */
export function disconnectBridge(): void {
	ensureActivated()
	stopBridgeClient()
	eda.sys_Dialog.showInformationMessage(
		'已暂停指令代理：AI 发往本窗口的一切指令都会被代理拒绝。\n连接随即断开（EDA 的自动重连会被代理持续挡回），后台空闲 300 秒后自动退出。\n点「连接指令代理」可随时恢复（后台没在跑会自动拉起）。',
		'断开指令代理',
	)
}

export function listCommands(): void {
	ensureActivated()
	const names = listCommandNames()
	eda.sys_Dialog.showInformationMessage(
		names.join('\n'),
		'AI Command Engine — 指令列表',
	)
}

/** 打开 SMT 物料查询窗口（页面由本地指令代理提供） */
export async function openSmtQuery(): Promise<void> {
	ensureActivated()
	const url = 'http://127.0.0.1:49720/smt'
	try {
		const resp = await eda.sys_ClientUrl.request('http://127.0.0.1:49720/health', 'GET')
		if (resp?.status === 200) {
			eda.sys_Window.open(url, '_blank' as any)
			return
		}
	}
	catch {
		// 代理未运行
	}
	eda.sys_Dialog.showInformationMessage(
		'指令代理未运行，无法打开 SMT 物料查询窗口。\n请先运行 start-services.bat（或注册 ai-command-proxy:// 协议后由本扩展自动拉起）。',
		'SMT 物料查询',
	)
}
