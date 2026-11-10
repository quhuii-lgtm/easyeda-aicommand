import type { ICommandRequest } from './engine/types';
import extensionConfig from '../extension.json' with { type: 'json' };
import { createBridgeOwnerCoordinator } from './bridge/owner';
/**
 * AI Command Engine — 扩展入口
 *
 * 激活时：
 * 1. 注册全部内置指令到指令引擎
 * 2. 启动桥接客户端，扫描 49720–49729 的本地指令代理并连接匹配服务
 * 3. 同时在全局对象挂载 __aiCommand 作为诊断/备用通道
 *
 * 注意：扩展运行在独立 JS 上下文，window 不与其他扩展共享，
 * 因此与 AI 的通信必须走本扩展自己的 WebSocket 连接。
 */
import { getBridgeLifecycleStatus, reconnectBridgeClient, startBridgeClient, stopBridgeClient } from './bridge/client';
import { openSmtQuery as openSmtQueryAtOwner } from './bridge/smtMenu';
import { launchPcbToolsAction } from './menus/pcb-tools';
import { autoCopperCommands } from './commands/autoCopper';
import { componentAttributeCommands } from './commands/componentAttributes';
import { dfmCommands } from './commands/dfm';
import { diffPairCommands } from './commands/diffPair';
import { lengthTuneCommands } from './commands/tuneLength';
import { editorCommands } from './commands/editor';
import { fanoutCommands } from './commands/fanout';
import { knowledgeCommands } from './commands/knowledge';
import { libCommands } from './commands/lib';
import { manufacturingProfileCommands } from './commands/manufacturingProfile';
import { padBranchCommands } from './commands/padBranches';
import { netSilkscreenCommands } from './commands/netSilkscreen';
import { padExpansionCommands } from './commands/padExpand';
import { padHoleCommands } from './commands/padHole';
import { pcbCommands } from './commands/pcb';
import { pcbGroupingCommands } from './commands/pcbGrouping';
import { libraryCommands, projectCommands } from './commands/project';
import { schematicCommands } from './commands/schematic';
import { silkscreenCheckCommands } from './commands/silkscreenCheck';
import { systemCommands } from './commands/system';
import { installDfmMenuApi, padSpacingMenu, pcbDfmMenu, smtDfmMenu } from './dfm/menu';
import { executeCommand, getCommandDocs, listCommandNames, registerCommand } from './engine/registry';

let registered = false;
let activating = false;
const bridgeOwner = createBridgeOwnerCoordinator(extensionConfig.version);

function registerAllCommands(): void {
	for (const def of [
		...projectCommands,
		...libraryCommands,
		...editorCommands,
		...schematicCommands,
		...pcbCommands,
		...diffPairCommands,
		...padBranchCommands,
		...lengthTuneCommands,
		...componentAttributeCommands,
		...silkscreenCheckCommands,
		...manufacturingProfileCommands,
		...padHoleCommands,
		...fanoutCommands,
		...autoCopperCommands,
		...padExpansionCommands,
		...netSilkscreenCommands,
		...dfmCommands,
		...pcbGroupingCommands,
		...knowledgeCommands,
		...systemCommands,
		...libCommands,
	])
		registerCommand(def);
}

/**
 * 单 owner 激活：同一 EDA 窗口可能累积多个扩展上下文，只有发现无 owner 的上下文
 * 才会登记命令并启动桥接；其他上下文复用现有 owner 的 RPC 菜单服务。
 */
function handleBridgeOwnerRequest(request: any): unknown {
	switch (request?.method) {
		case 'start':
			startBridgeClient();
			return { status: getBridgeLifecycleStatus() };
		case 'stop':
			stopBridgeClient();
			return { status: getBridgeLifecycleStatus() };
		case 'reconnect':
			reconnectBridgeClient();
			return { status: getBridgeLifecycleStatus() };
		case 'status':
			return { status: getBridgeLifecycleStatus(), commandCount: listCommandNames().length };
		case 'commands':
			return listCommandNames();
		case 'open-smt':
			return openSmtQueryAtOwner();
		case 'pcb-tools-group':
			launchPcbToolsAction('group');
			return { started: true };
		case 'pcb-tools-route-start':
			launchPcbToolsAction('route-start');
			return { started: true };
		case 'pcb-tools-route-status':
			launchPcbToolsAction('route-status');
			return { started: true };
		case 'pcb-tools-route-stop':
			launchPcbToolsAction('route-stop');
			return { started: true };
		case 'pcb-tools-route-fetch':
			launchPcbToolsAction('route-fetch');
			return { started: true };
		case 'pcb-tools-route-import':
			launchPcbToolsAction('route-import');
			return { started: true };
		default:
			throw new Error(`未知的桥接菜单请求：${String(request?.method)}`);
	}
}

export function activate(_status?: 'onStartupFinished', _arg?: string): void {
	installDfmMenuApi();
	if (registered || activating)
		return;
	activating = true;

	try {
		const role = bridgeOwner.activate(handleBridgeOwnerRequest);
		if (role !== 'owner') {
			registered = true;
			return;
		}

		registerAllCommands()

		// 备用/诊断通道：挂到全局对象
		;(globalThis as any).__aiCommand = {
			version: extensionConfig.version,
			execute: async (req: ICommandRequest) => executeCommand(req),
			listCommands: async () => listCommandNames(),
			help: async (cmd?: string) => {
				const docs = getCommandDocs();
				if (cmd)
					return docs.filter(doc => doc.name === cmd);
				return docs;
			},
		};

		// 主通道：WebSocket 连接本地指令代理（需要「外部交互」权限）
		bridgeOwner.markReady();
		registered = true;
		startBridgeClient();

		try {
			eda.sys_Log.add(`AI Command Engine v${extensionConfig.version} 已激活，注册指令 ${listCommandNames().length} 条`);
		}
		catch {
			// 日志失败不影响激活
		}
	}
	catch (err) {
		if (!registered)
			bridgeOwner.release();
		// 激活失败时直接弹窗，便于排查
		eda.sys_Dialog.showInformationMessage(
			`AI Command Engine 激活失败: ${err instanceof Error ? err.message : String(err)}`,
			'Error',
		);
	}
	finally {
		activating = false;
	}
}

export { padSpacingMenu, pcbDfmMenu, smtDfmMenu };

async function requestOwner(method: string, title: string): Promise<any | undefined> {
	try {
		return await bridgeOwner.request(method);
	}
	catch (err) {
		eda.sys_Dialog.showInformationMessage(
			`无法执行菜单操作：${err instanceof Error ? err.message : String(err)}`,
			title,
		);
		return undefined;
	}
}

export async function about(): Promise<void> {
	const result = await requestOwner('status', 'About');
	if (!result)
		return;
	eda.sys_Dialog.showInformationMessage(
		`AI Command Engine v${extensionConfig.version}\n已注册 ${result.commandCount} 条指令\n桥接状态：${result.status}`,
		'About',
	);
}

/** 启动或恢复已激活所有者的本窗口桥接。 */
export async function connectBridge(): Promise<void> {
	const result = await requestOwner('start', '启动桥接');
	if (!result)
		return;
	eda.sys_Dialog.showInformationMessage(
			result.status + '\n由 AI 使用配套技能的 scripts/start-proxy.ps1 在后台启动代理；本窗口会自动连接。稍后可在 About 查看结果。',
			'启动桥接',
		);
}

/** 停止接收新指令，等待在途结果后断开。 */
export async function disconnectBridge(): Promise<void> {
	const result = await requestOwner('stop', '停止桥接');
	if (!result)
		return;
	eda.sys_Dialog.showInformationMessage(
		result.status + '\n当前操作结束后才断开；结果未知时保留连接和写保护。全部窗口停止且无待处理操作后，桥接空闲 300 秒自动退出。',
		'停止桥接',
	);
}

/** 只重连所有者的本窗口；使用与停止相同的等待流程。 */
export async function reconnectBridge(): Promise<void> {
	const result = await requestOwner('reconnect', '重新连接桥接');
	if (!result)
		return;
	eda.sys_Dialog.showInformationMessage(
		result.status + '\n只重新连接本窗口，等待当前操作结束，不清除结果未知的写保护。',
		'重新连接桥接',
	);
}

export async function listCommands(): Promise<void> {
	const names = await requestOwner('commands', 'AI Command Engine — 指令列表');
	if (!names)
		return;
	eda.sys_Dialog.showInformationMessage(
		names.join('\n'),
		'AI Command Engine — 指令列表',
	);
}

/** Open the SMT query page in the bridge owner context. */
export async function openSmtQuery(): Promise<void> {
	await requestOwner('open-smt', 'SMT 物料查询');
}

async function startPcbMenuAction(method: string, title: string): Promise<void> {
	const result = await requestOwner(method, title);
	if (result?.started)
		eda.sys_Dialog.showInformationMessage(`已在桥接所有者上下文启动“${title}”；结果会在完成后显示。`, title)
}

export async function pcbGroupBySchematicRegionsMenu(): Promise<void> {
	await startPcbMenuAction('pcb-tools-group', '按原理图功能区分组');
}

export async function pcbAutoRouteStartMenu(): Promise<void> {
	await startPcbMenuAction('pcb-tools-route-start', '启动自动布线');
}

export async function pcbAutoRouteStatusMenu(): Promise<void> {
	await startPcbMenuAction('pcb-tools-route-status', '查询自动布线状态');
}

export async function pcbAutoRouteStopMenu(): Promise<void> {
	await startPcbMenuAction('pcb-tools-route-stop', '停止自动布线');
}

export async function pcbAutoRouteFetchMenu(): Promise<void> {
	await startPcbMenuAction('pcb-tools-route-fetch', '取回已完成 SES');
}

export async function pcbAutoRouteImportMenu(): Promise<void> {
	await startPcbMenuAction('pcb-tools-route-import', '显式导入已取回 SES');
}

/** 打开 SMT 物料查询窗口（页面由本地指令代理提供） */
