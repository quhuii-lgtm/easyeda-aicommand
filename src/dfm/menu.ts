import { executeCommand, registerCommand } from '../engine/registry'
import { commandName, dfmCommands } from '../commands/dfm'
import { DFM_COVERAGE, JLC_SUPPORTED_MATERIALS, UPSTREAM_INFO, type DfmKind } from './official'

let menuDocumentUuid: string | undefined
let initialKind: DfmKind = 'pcb'
let menuSessionToken: string | undefined
let sessionSequence = 0

function captureSession(token?: string) {
	if (!menuDocumentUuid || !menuSessionToken || token !== menuSessionToken)
		throw new Error('DFM 窗口会话已失效；请关闭后从 PCB 菜单重新打开')
	return { documentUuid: menuDocumentUuid, sessionToken: menuSessionToken }
}

async function assertSession(token?: string): Promise<{ documentUuid: string; sessionToken: string }> {
	const session = captureSession(token)
	await getCurrentPcb(session.documentUuid)
	const current = captureSession(token)
	if (current.documentUuid !== session.documentUuid)
		throw new Error('DFM 窗口绑定的 PCB 已变化，已拒绝操作')
	return session
}

function registerMenuCommands(): void {
	for (const command of dfmCommands)
		registerCommand(command)
}

async function getCurrentPcb(expectedUuid?: string): Promise<any> {
	const focus = await eda.dmt_SelectControl.getCurrentDocumentInfo()
	if (focus?.documentType !== 3 || typeof focus.uuid !== 'string' || !focus.uuid)
		throw new Error('当前焦点不是有效 PCB 文档，未打开 DFM 检查')
	if (expectedUuid && focus.uuid !== expectedUuid)
		throw new Error(`PCB 文档已切换（原 ${expectedUuid}，当前 ${focus.uuid}），请重新打开嘉立创下单检查`)
	return focus
}

async function openDfmMenu(kind: DfmKind): Promise<void> {
	try {
		const focus = await getCurrentPcb()
		menuDocumentUuid = focus.uuid
		initialKind = kind
		menuSessionToken = `${Date.now().toString(36)}-${(++sessionSequence).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
		registerMenuCommands()
		const opened = await eda.sys_IFrame.openIFrame(
			'/iframe/jlc-dfm/index.html',
			980,
			700,
			`jlcOrderDfm-${menuSessionToken}`,
			{ title: '嘉立创下单检查', maximizeButton: true, minimizeButton: true },
		)
		if (!opened)
			throw new Error('宿主未能打开 DFM 检查窗口')
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		try { eda.sys_Dialog.showInformationMessage(message, '嘉立创下单检查') }
		catch { throw error }
	}
}

export function pcbDfmMenu(): Promise<void> {
	return openDfmMenu('pcb')
}

export function smtDfmMenu(): Promise<void> {
	return openDfmMenu('smt')
}

export function padSpacingMenu(): Promise<void> {
	return openDfmMenu('spacing')
}

export async function getDfmMenuContext(): Promise<any> {
	const session = captureSession(menuSessionToken)
	await assertSession(session.sessionToken)
	return {
		documentUuid: session.documentUuid,
		sessionToken: session.sessionToken,
		initialKind,
		materials: JLC_SUPPORTED_MATERIALS,
		coverage: DFM_COVERAGE,
		upstream: UPSTREAM_INFO,
	}
}

export async function runDfmMenuCheck(kind: DfmKind, inputs: Record<string, any>, token?: string): Promise<any> {
	const session = await assertSession(token)
	registerMenuCommands()
	const result = await executeCommand({
		cmd: commandName(kind),
		params: { ...inputs, __docUuid: session.documentUuid },
	})
	if (!result.ok)
		throw new Error(result.error.message)
	await assertSession(session.sessionToken)
	if (!result.data || result.data.documentUuid !== session.documentUuid)
		throw new Error('DFM 检查返回文档身份不匹配，已拒绝显示结果')
	return result
}

export async function locateDfmViolation(item: { id?: string; x?: number; y?: number }, token?: string): Promise<boolean> {
	if (typeof item?.id !== 'string' || !item.id || !Number.isFinite(item.x) || !Number.isFinite(item.y))
		throw new Error('该违规项缺少有效图元 ID 或坐标，无法定位')
	const sdk = eda as any
	const session = await assertSession(token)
	const selected = await sdk.pcb_SelectControl.doSelectPrimitives([item.id])
	await assertSession(session.sessionToken)
	if (!selected)
		throw new Error(`无法选中图元 ${item.id}`)
	const navigated = await sdk.pcb_Document.navigateToCoordinates(item.x, item.y)
	await assertSession(session.sessionToken)
	return Boolean(navigated)
}

export async function saveDfmReport(extension: 'txt' | 'json', content: string, token?: string): Promise<{ saved: true; fileName: string } | { saved: false; cancelled: true; message: string }> {
	const session = await assertSession(token)
	if (extension !== 'txt' && extension !== 'json')
		throw new Error('仅支持导出 TXT 或 JSON')
	const fileName = `jlc-dfm-${session.documentUuid}-${Date.now()}.${extension}`
	try {
		const sdk = eda as any
		await sdk.sys_FileSystem.saveFile(
			new Blob([content], { type: extension === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' }),
			fileName,
		)
		return { saved: true, fileName }
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/cancel(?:led|ed)?/i.test(message))
			return { saved: false, cancelled: true, message }
		throw error
	}
}

export function installDfmMenuApi(): void {
	if (typeof eda === 'undefined')
		return
	const sdk = eda as any
	sdk.jlcOrderDfm = {
		getContext: getDfmMenuContext,
		runCheck: runDfmMenuCheck,
		locate: locateDfmViolation,
		saveReport: saveDfmReport,
	}
}
