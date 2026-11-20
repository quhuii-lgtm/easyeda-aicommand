/**
 * 工程与库类指令
 */
import type { ICommandDef } from '../engine/types'
import { fileToResult } from './util'
import JSZip from 'jszip'

type ProjectNode = Record<string, any>

type OperationDeadline = {
	check: (phase: string, partial?: boolean) => void
	wait: <T>(start: () => Promise<T>, phase: string, partial?: boolean) => Promise<T>
}

function createOperationDeadline(params: any, label: string): OperationDeadline {
	const supplied = params?._timeoutMs == null ? 290_000 : Math.max(1000, Number(params._timeoutMs))
	const timeoutMs = Number.isFinite(supplied) ? supplied : 290_000
	const deadlineAt = Date.now() + timeoutMs
	const timeoutError = (phase: string, partial = false) => new Error(`${label} 超过 ${timeoutMs}ms 操作期限（${phase}），未继续后续写入`, {
		cause: { partial, retryable: false, phase: `${label} deadline`, timeoutMs },
	})
	return {
		check(phase, partial = false) {
			if (Date.now() >= deadlineAt)
				throw timeoutError(phase, partial)
		},
		async wait<T>(start: () => Promise<T>, phase: string, partial = false) {
			if (Date.now() >= deadlineAt)
				throw timeoutError(phase, partial)
			const promise = start()
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				const value = await Promise.race([
					promise,
					new Promise<never>((_resolve, reject) => {
						timer = setTimeout(() => reject(timeoutError(phase, partial)), Math.max(1, deadlineAt - Date.now()))
					}),
				])
				if (Date.now() >= deadlineAt)
					throw timeoutError(phase, partial)
				return value
			}
			finally {
				if (timer !== undefined)
					clearTimeout(timer)
			}
		},
	}
}

function projectData(project: any, projectUuid: string): ProjectNode[] {
	if (!project || typeof project !== 'object' || project.uuid !== projectUuid || !Array.isArray(project.data))
		throw new Error(`无法读取工程 ${projectUuid} 的完整文档树`)
	const found: ProjectNode[] = []
	const addPcb = (pcb: any, parentBoardName?: string, nested = false) => {
		if (!pcb || typeof pcb !== 'object' || pcb.itemType !== 'PCB' || typeof pcb.uuid !== 'string' || !pcb.uuid || typeof pcb.name !== 'string' || !pcb.name || pcb.parentProjectUuid !== projectUuid || (nested ? pcb.parentBoardName !== parentBoardName : pcb.parentBoardName !== undefined && pcb.parentBoardName !== ''))
			throw new Error(`工程 ${projectUuid} 的 PCB 节点结构或归属无效`)
		found.push(pcb)
	}
	const addPage = (page: any, schematicUuid: string) => {
		if (!page || typeof page !== 'object' || page.itemType !== 'Schematic Page' || typeof page.uuid !== 'string' || !page.uuid || typeof page.name !== 'string' || !page.name || page.parentSchematicUuid !== schematicUuid)
			throw new Error(`原理图 ${schematicUuid} 含有结构或归属无效的图页`)
		found.push(page)
	}
	const addSchematic = (schematic: any, parentBoardName?: string, nested = false) => {
		if (!schematic || typeof schematic !== 'object' || schematic.itemType !== 'Schematic' || typeof schematic.uuid !== 'string' || !schematic.uuid || typeof schematic.name !== 'string' || !schematic.name || schematic.parentProjectUuid !== projectUuid || (nested ? schematic.parentBoardName !== parentBoardName : schematic.parentBoardName !== undefined && schematic.parentBoardName !== '') || !Array.isArray(schematic.page))
			throw new Error(`工程 ${projectUuid} 的原理图节点结构或归属无效`)
		found.push(schematic)
		for (const page of schematic.page)
			addPage(page, schematic.uuid)
	}
	for (const node of project.data) {
		if (!node || typeof node !== 'object')
			throw new Error(`工程 ${projectUuid} 文档树包含空或非对象节点`)
		if (node.itemType === 'Board') {
			if (typeof node.name !== 'string' || !node.name || node.parentProjectUuid !== projectUuid || !Object.hasOwn(node, 'schematic') || !Object.hasOwn(node, 'pcb'))
				throw new Error(`工程 ${projectUuid} 的 Board 节点结构或归属无效`)
			found.push(node)
			if (node.schematic !== null)
				addSchematic(node.schematic, node.name, true)
			if (node.pcb !== null)
				addPcb(node.pcb, node.name, true)
		}
		else if (node.itemType === 'Schematic') {
			addSchematic(node)
		}
		else if (node.itemType === 'PCB') {
			addPcb(node)
		}
		else if (node.itemType === 'Panel') {
			if (typeof node.uuid !== 'string' || !node.uuid || typeof node.name !== 'string' || !node.name || node.parentProjectUuid !== projectUuid)
				throw new Error(`工程 ${projectUuid} 的 Panel 节点结构或归属无效`)
			found.push(node)
		}
		else {
			throw new Error(`工程 ${projectUuid} 文档树含不支持或未知节点类型 ${String(node.itemType)}`)
		}
	}
	return found
}

function projectTreeUnchanged(before: any, after: any): boolean {
	if (!before || !after || before.uuid !== after.uuid || !Array.isArray(before.data) || !Array.isArray(after.data))
		return false
	try {
		return JSON.stringify(before.data) === JSON.stringify(after.data)
	}
	catch {
		return false
	}
}

function mutationUnknown(label: string, operationError: unknown, details: Record<string, unknown> = {}) {
	const message = operationError instanceof Error ? operationError.message : String(operationError)
	return new Error(`${label}结果未知，未自动重试。请先读取工程树核对状态。原始错误：${message}`, {
		cause: { partial: true, retryable: false, phase: label, operationError: message, ...details },
	})
}

function requireUuid(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0)
		throw new Error(`${label}必须是非空 UUID`)
	return value
}

async function currentProjectTree(deadline?: OperationDeadline, phase = '读取当前工程树') {
	const current: any = deadline
		? await deadline.wait(() => eda.dmt_Project.getCurrentProjectInfo(), phase)
		: await eda.dmt_Project.getCurrentProjectInfo()
	if (!current || typeof current.uuid !== 'string' || !current.uuid)
		throw new Error('无法读取当前工程完整信息')
	const nodes = projectData(current, current.uuid)
	deadline?.check(`${phase} 校验`)
	return { project: current, nodes }
}

async function confirmCurrentProject(deadline: OperationDeadline, projectUuid: string, phase: string) {
	const current = await currentProjectTree(deadline, phase)
	if (current.project.uuid !== projectUuid)
		throw new Error(`当前工程已从 ${projectUuid} 切换为 ${current.project.uuid}，未写入`)
	return current
}

/**
 * 规范化器件搜索结果。
 * 注意：官方文档写的字段（name / symbol 对象）与实际运行时返回不一致，
 * 实测返回 footprintName / manufacturerId / supplierId / otherProperty 等字段，这里做双兼容。
 */
function mapDevice(item: any) {
	const op = item?.otherProperty ?? {}
	const property = item?.property ?? {}
	const pop = property?.otherProperty ?? {}
	return {
		uuid: item?.uuid,
		libraryUuid: item?.libraryUuid,
		name: item?.name ?? property?.name ?? op['LCSC Part Name'] ?? item?.manufacturerId ?? item?.footprintName,
		manufacturer: item?.manufacturer ?? property?.manufacturer ?? op['Manufacturer'],
		manufacturerId: item?.manufacturerId ?? property?.manufacturerId ?? op['Manufacturer Part'],
		lcscId: item?.supplierId ?? property?.supplierId ?? op['Supplier Part'],
		footprint: item?.footprint?.name ?? item?.footprintName ?? op['Supplier Footprint'],
		value: op['Value'] ?? pop['Value'],
		description: item?.description ?? op['Description'] ?? pop['Description'],
	}
}

export const projectCommands: Array<ICommandDef> = [
	{
		name: 'project.getInfo',
		summary: '获取当前工程信息（名称、文档列表等）',
		params: [{ name: '__projectUuid', type: 'string', description: '可选，核对宿主此刻的当前工程 UUID，不切换工程' }],
		returns: '当前工程信息对象',
		example: { cmd: 'project.getInfo' },
		handler: async (params, ctx) => {
			const expected = params.__projectUuid
			if (expected !== undefined && (typeof expected !== 'string' || !expected.trim()))
				throw new Error('__projectUuid 必须是非空字符串')
			ctx?.onProgress?.({ phase: 'reading-project-identity' })
			const info = await eda.dmt_Project.getCurrentProjectInfo()
			if (!info)
				throw new Error('当前没有打开的工程')
			if (expected !== undefined && info.uuid !== expected)
				throw new Error(`当前工程 UUID 不符（要求=${expected}，实际=${info.uuid}）`)
			return info
		},
	},
	{
		name: 'project.getBoardInfo',
		summary: '获取当前板子（Board）信息与原理图/PCB 关联状态；pcb.importChanges 返回 false 时用它排查是否游离 PCB',
		params: [],
		returns: '{ current, all }（当前板子与全部板子的关联信息）',
		example: { cmd: 'project.getBoardInfo' },
		handler: async () => {
			let current: unknown = null
			let all: unknown = null
			try {
				current = await eda.dmt_Board.getCurrentBoardInfo()
			}
			catch (e) {
				current = `error: ${String(e)}`
			}
			try {
				all = await eda.dmt_Board.getAllBoardsInfo()
			}
			catch (e) {
				all = `error: ${String(e)}`
			}
			return { current, all }
		},
	},
	{
		name: 'project.associateBoard',
		summary: '把原理图与 PCB 关联到板子（修复游离 PCB 导致 pcb.importChanges 返回 false 的问题）',
		params: [
			{ name: 'schematicUuid', type: 'string', required: true, description: '原理图 UUID（工程树中 Schematic 节点的 uuid）' },
			{ name: 'pcbUuid', type: 'string', required: true, description: 'PCB UUID' },
		],
		returns: '{ boardName }',
		example: { cmd: 'project.associateBoard', params: { schematicUuid: 'xxx', pcbUuid: 'yyy' } },
		handler: async (params) => {
			if (!params.schematicUuid || !params.pcbUuid)
				throw new Error('缺少参数 schematicUuid / pcbUuid')
			const boardName = await eda.dmt_Board.createBoard(String(params.schematicUuid), String(params.pcbUuid))
			if (!boardName)
				throw new Error('板子关联失败')
			return { boardName }
		},
	},
	// ---------- 工程管理 ----------
	{
		name: 'project.create',
		summary: '新建工程',
		params: [
			{ name: 'name', type: 'string', required: true, description: '工程显示名称' },
			{ name: 'projectName', type: 'string', description: '工程内部名（英文，留空自动）' },
			{ name: 'description', type: 'string', description: '工程描述' },
		],
		returns: '{ projectUuid }',
		example: { cmd: 'project.create', params: { name: 'AI测试工程' } },
		handler: async (params) => {
			if (!params.name)
				throw new Error('缺少参数 name')
			const uuid = await eda.dmt_Project.createProject(
				String(params.name),
				params.projectName ? String(params.projectName) : undefined,
				undefined,
				undefined,
				params.description ? String(params.description) : undefined,
			)
			if (!uuid)
				throw new Error('工程创建失败（官方返回空）')
			return { projectUuid: uuid }
		},
	},
	{
		name: 'project.open',
		summary: '打开指定工程（切换当前工程）',
		params: [
			{ name: 'projectUuid', type: 'string', required: true, description: '工程 UUID（project.list 获取）' },
		],
		returns: '{ opened }',
		example: { cmd: 'project.open', params: { projectUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.projectUuid)
				throw new Error('缺少参数 projectUuid')
			const info = await eda.dmt_Project.getProjectInfo(String(params.projectUuid))
			if (!info)
				throw new Error('目标工程不存在或无权访问，未调用 openProject')
			const opened = await eda.dmt_Project.openProject(String(params.projectUuid))
			if (!opened)
				throw new Error('工程打开失败，请检查 uuid 是否正确')
			return { opened: true }
		},
	},
	{
		name: 'project.list',
		summary: '列出全部工程（可按 teamUuid 筛选；detail=true 时逐个查信息，较慢）',
		params: [
			{ name: 'teamUuid', type: 'string', description: '可选团队 UUID；省略时按官方默认范围列出' },
			{ name: 'detail', type: 'boolean', description: '是否返回每个工程的详细信息，默认 false' },
		],
		returns: '工程 uuid 列表，或 [{ uuid, info }]',
		example: { cmd: 'project.list' },
		handler: async (params) => {
			let teamUuid: string | undefined
			if (params.detail !== undefined && typeof params.detail !== 'boolean')
				throw new Error('detail 必须是布尔值')
			if (params.teamUuid !== undefined) {
				if (typeof params.teamUuid !== 'string' || params.teamUuid.length === 0)
					throw new Error('teamUuid 必须是非空字符串')
				teamUuid = params.teamUuid
			}
			const result: unknown = teamUuid === undefined
				? await eda.dmt_Project.getAllProjectsUuid()
				: await eda.dmt_Project.getAllProjectsUuid(teamUuid)
			if (result === undefined)
				throw new Error('project.list SDK 返回类型无效：收到 undefined，期望 string[]')
			if (result === null)
				throw new Error('project.list SDK 返回类型无效：收到 null，期望 string[]')
			if (!Array.isArray(result))
				throw new Error(`project.list SDK 返回类型无效：收到 ${typeof result}，期望 string[]`)
			for (let index = 0; index < result.length; index++) {
				if (typeof result[index] !== 'string')
					throw new Error(`project.list SDK 返回类型无效：string[] 第 ${index} 项是 ${typeof result[index]}，期望 string`)
				if (result[index].length === 0)
					throw new Error(`project.list SDK 返回数据无效：第 ${index} 项 uuid 为空`)
			}
			const uuids = result as string[]
			if (!params.detail)
				return uuids
			const out: Array<{ uuid: string, info: unknown }> = []
			for (const uuid of uuids)
				out.push({ uuid, info: await eda.dmt_Project.getProjectInfo(uuid) })
			return out
		},
	},
	{
		name: 'project.getInfoOf',
		summary: '查询指定工程的信息',
		params: [
			{ name: 'projectUuid', type: 'string', required: true, description: '工程 UUID' },
		],
		returns: '工程信息对象',
		example: { cmd: 'project.getInfoOf', params: { projectUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.projectUuid)
				throw new Error('缺少参数 projectUuid')
			const info = await eda.dmt_Project.getProjectInfo(String(params.projectUuid))
			if (!info)
				throw new Error('工程不存在或无权访问')
			return info
		},
	},
	{
		name: 'project.moveToFolder',
		summary: '把工程移到指定文件夹',
		params: [
			{ name: 'projectUuid', type: 'string', required: true, description: '工程 UUID' },
			{ name: 'folderUuid', type: 'string', description: '目标文件夹 UUID，留空移到根目录' },
		],
		returns: '{ moved }',
		example: { cmd: 'project.moveToFolder', params: { projectUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.projectUuid)
				throw new Error('缺少参数 projectUuid')
			const deadline = createOperationDeadline(params, 'project.moveToFolder')
			const projectUuid = String(params.projectUuid)
			if (params.folderUuid !== undefined && params.folderUuid !== '' && (typeof params.folderUuid !== 'string' || !params.folderUuid))
				throw new Error('folderUuid 必须是非空字符串；移到根目录请省略或传空字符串')
			if (params.folderUuid === null)
				throw new Error('folderUuid 不能为 null；移到根目录请省略参数')
			const targetFolderUuid = params.folderUuid === undefined || params.folderUuid === '' ? undefined : String(params.folderUuid)
			const before: any = await deadline.wait(() => eda.dmt_Project.getProjectInfo(projectUuid), '读取移动前工程信息')
			if (!before || before.uuid !== projectUuid || typeof before.teamUuid !== 'string' || !before.teamUuid)
				throw new Error(`无法确认工程 ${projectUuid} 的当前团队归属，未移动`)
			if (targetFolderUuid) {
				const folder: any = await deadline.wait(() => eda.dmt_Folder.getFolderInfo(before.teamUuid, targetFolderUuid), '读取目标文件夹归属')
				if (!folder || folder.uuid !== targetFolderUuid || folder.teamUuid !== before.teamUuid)
					throw new Error(`目标文件夹 ${targetFolderUuid} 不属于工程当前团队 ${before.teamUuid}，未移动`)
			}
			let moved: unknown
			deadline.check('发起移动前')
			try {
				moved = await deadline.wait(() => eda.dmt_Project.moveProjectToFolder(projectUuid, targetFolderUuid), '移动工程', true)
			}
			catch (err) {
				throw mutationUnknown('project.moveToFolder', err, { projectUuid, requestedFolderUuid: targetFolderUuid ?? null })
			}
			let after: any
			try {
				after = await deadline.wait(() => eda.dmt_Project.getProjectInfo(projectUuid), '读取移动后工程信息', true)
			}
			catch (err) {
				throw mutationUnknown('project.moveToFolder readback', err, { projectUuid, requestedFolderUuid: targetFolderUuid ?? null, sdkReturned: moved })
			}
			if (!after || after.uuid !== projectUuid)
				throw mutationUnknown('project.moveToFolder readback', '无法读取移动后的工程信息', { projectUuid, requestedFolderUuid: targetFolderUuid ?? null, sdkReturned: moved })
			if (after.teamUuid !== before.teamUuid)
				throw mutationUnknown('project.moveToFolder readback', '移动后工程团队 UUID 缺失或发生变化', { projectUuid, beforeTeamUuid: before.teamUuid, afterTeamUuid: after.teamUuid ?? null, requestedFolderUuid: targetFolderUuid ?? null, sdkReturned: moved })
			const landed = targetFolderUuid === undefined ? after.folderUuid === undefined : after.folderUuid === targetFolderUuid
			if (moved !== true || !landed)
				throw new Error(`工程移动未通过读回验收（SDK=${String(moved)}，请求目录=${targetFolderUuid ?? '根目录'}，实际目录=${after.folderUuid === undefined ? '根目录(undefined)' : String(after.folderUuid)}）`, {
					cause: { partial: moved === true || landed, retryable: false, phase: 'project.moveToFolder verify', projectUuid, requestedFolderUuid: targetFolderUuid ?? null, actualFolderUuid: after.folderUuid ?? null, sdkReturned: moved },
				})
			return { moved: true }
		},
	},
	{
		name: 'project.exportFile',
		summary: '导出当前工程文件（.epro，返回 base64，AI 可自行落盘做备份/迁移）',
		params: [
			{ name: 'fileName', type: 'string', description: '文件名，默认 project' },
			{ name: 'fileType', type: 'string', description: 'epro | epro2，默认 epro' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'project.exportFile' },
		handler: async (params) => {
			if (params.fileType !== undefined && params.fileType !== 'epro' && params.fileType !== 'epro2')
				throw new Error('fileType 必须是 epro 或 epro2')
			const fileType = (params.fileType ?? 'epro') as 'epro' | 'epro2'
			const file = await eda.sys_FileManager.getProjectFile(
				params.fileName ? String(params.fileName) : undefined,
				undefined,
				fileType,
			)
			const result = await fileToResult(file, `project.${fileType}`)
			if (!result)
				throw new Error('工程文件导出失败：官方返回空')
			return result
		},
	},
	{
		name: 'project.importFile',
		summary: '从工程文件导入工程（传 base64 文件内容；newProjectName 设置新工程显示名并检查同名；在线省略时仅从 epro2 根 project2.json 的 title 派生；根 project2.json 的字符串 description 随同一次新建导入写入；官方导入为 beta，空返回按结果未知处理）',
		params: [
			{ name: 'base64', type: 'string', required: true, description: '文件内容的 base64 编码' },
			{ name: 'fileName', type: 'string', required: true, description: '文件名（带扩展名，用于构造 File 和推断 fileType）' },
			{ name: 'fileType', type: 'string', description: "文件类型，如 'Altium Designer'、'KiCad'、'PADS'、'JLCEDA Pro' 等；缺省按扩展名推断（.PcbDoc/.SchDoc→'Altium Designer'），无法推断时必须显式传" },
			{ name: 'newProjectName', type: 'string', description: '新工程显示名；传入时检查当前团队是否已有同名工程；在线省略时只支持从 epro2 根 project2.json 的 title 派生，其他格式或元数据无法确定时必须显式传入' },
			{ name: 'saveToFolderPath', type: 'string', description: "本地文件夹路径（仅离线客户端）：传入后 saveTo 用 'Offline Client Local Path'；缺省新建工程到当前团队（自动取 dmt_Team.getCurrentTeamInfo 的 uuid）" },
		],
		returns: '{ uuid, name, ... }（官方 IDMT_BriefProjectItem 简略工程属性）',
		example: { cmd: 'project.importFile', params: { fileName: 'board.PcbDoc', fileType: 'Altium Designer', base64: '...' } },
		handler: async (params) => {
			if (!params.base64)
				throw new Error('缺少参数 base64（文件内容的 base64 编码）')
			if (!params.fileName)
				throw new Error('缺少参数 fileName（带扩展名的文件名）')
			const deadline = createOperationDeadline(params, 'project.importFile')
			const fileName = String(params.fileName)
			const requestedName = params.newProjectName === undefined ? undefined : String(params.newProjectName).trim()
			if (requestedName === '')
				throw new Error('newProjectName 不能是空白字符串')
			let importName = requestedName
			const ext = fileName.toLowerCase().split('.').pop() ?? ''
			let fileType = params.fileType ? String(params.fileType) : undefined
			if (!fileType) {
				const extMap: Record<string, string> = {
					pcbdoc: 'Altium Designer',
					schdoc: 'Altium Designer',
					prjpcb: 'Altium Designer',
					epro: 'JLCEDA Pro',
					epro2: 'JLCEDA Pro',
				}
				fileType = extMap[ext]
				if (!fileType)
					throw new Error(`无法按扩展名 .${ext} 推断 fileType，请显式传 fileType（如 'Altium Designer'、'KiCad'、'PADS'、'JLCEDA Pro' 等）`)
			}
			let bin: string
			try {
				bin = atob(String(params.base64))
			}
			catch {
				throw new Error('base64 不是有效的文件内容编码，未调用导入接口')
			}
			const u8 = new Uint8Array(bin.length)
			for (let i = 0; i < bin.length; i++)
				u8[i] = bin.charCodeAt(i)
			const file = new File([u8], fileName)
			// 0.10.36：saveTo 三档——saveToFolderPath → 离线本地路径；否则默认 New Project 到当前团队
			// （dmt_Team.getCurrentTeamInfo 拿 teamUuid，0.10.35 省略 saveTo 官方在线环境返回空）
			let saveTo: Record<string, unknown> | undefined
			if (params.saveToFolderPath) {
				saveTo = { operation: 'Offline Client Local Path', folderPath: String(params.saveToFolderPath) }
			}
			else {
				const canReadEpro2Metadata = fileType === 'JLCEDA Pro' && ext === 'epro2'
				let metadata: Record<string, unknown> | undefined
				if (canReadEpro2Metadata) {
					try {
						const archive = await deadline.wait(() => JSZip.loadAsync(u8), '解析 epro2 元数据归档')
						const metadataPaths = Object.keys(archive.files).filter(path => /(^|\/)project2\.json$/i.test(path) && !archive.files[path].dir)
						if (metadataPaths.length !== 1 || metadataPaths[0] !== 'project2.json')
							throw new Error('归档必须在根目录且仅包含一个 project2.json')
						const metadataText = await deadline.wait(() => archive.files[metadataPaths[0]].async('string'), '读取 epro2 工程元数据')
						const parsed: unknown = JSON.parse(metadataText)
						if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
							throw new Error('project2.json 顶层必须是普通对象')
						metadata = parsed as Record<string, unknown>
					}
					catch (error) {
						// Explicit names may proceed without optional metadata, but a parse timeout
						// must still stop before the SDK write. Derived names keep the strict gate below.
						deadline.check('解析 epro2 工程元数据')
						metadata = undefined
						if (importName === undefined) {
							const detail = error instanceof Error ? error.message : String(error)
							throw new Error(`无法从 epro2 元数据可靠确定工程显示名（${detail}），请显式传 newProjectName；未发起导入`)
						}
					}
				}
				if (importName === undefined) {
					if (!canReadEpro2Metadata)
						throw new Error(`无法从 ${fileType} 的 .${ext} 文件中可靠确定工程显示名，请显式传 newProjectName；未发起导入`)
					if (typeof metadata?.title !== 'string' || !metadata.title.trim())
						throw new Error('无法从 epro2 元数据可靠确定工程显示名（project2.json 顶层 title 缺失或为空），请显式传 newProjectName；未发起导入')
					importName = metadata.title.trim()
				}
				const team: any = await deadline.wait(() => eda.dmt_Team.getCurrentTeamInfo(), '读取导入目标团队')
				const teamUuid = team?.uuid ?? team?.teamUuid
				if (typeof teamUuid !== 'string' || !teamUuid)
					throw new Error('拿不到当前团队 uuid（dmt_Team.getCurrentTeamInfo 返回异常），无法新建工程')
				saveTo = {
					operation: 'New Project',
					newProjectOwnerTeamUuid: teamUuid,
					// EDA 4.1.78 的导入实现只读取 newProjectFriendlyName，忽略 newProjectName。
					...(importName === undefined ? {} : { newProjectFriendlyName: importName }),
					...(metadata && Object.hasOwn(metadata, 'description') && typeof metadata.description === 'string' ? { newProjectDescription: metadata.description } : {}),
				}
				if (importName) {
					const uuids = await deadline.wait(() => eda.dmt_Project.getAllProjectsUuid(teamUuid), '读取当前团队工程列表')
					if (!Array.isArray(uuids))
						throw new Error('无法读取当前团队工程列表，未发起导入')
					for (const uuid of uuids) {
						if (typeof uuid !== 'string' || !uuid)
							throw new Error('当前团队工程列表包含无效 UUID，无法排除重名，未发起导入')
						const info = await deadline.wait(() => eda.dmt_Project.getProjectInfo(uuid), `读取工程 ${uuid} 的名称`)
						if (!info || info.uuid !== uuid || info.teamUuid !== teamUuid || typeof info.friendlyName !== 'string')
							throw new Error(`无法读取工程 ${uuid} 的名称，未发起导入`)
						if (info.friendlyName === importName)
							throw new Error(`当前团队已有同名工程 ${importName}，未发起导入`)
					}
				}
			}
			let beforeProjectUuid: string | undefined
			try {
				const before = await deadline.wait(() => eda.dmt_Project.getCurrentProjectInfo(), '读取导入前当前工程 UUID')
				if (typeof before?.uuid === 'string' && before.uuid)
					beforeProjectUuid = before.uuid
			}
			catch {
				deadline.check('导入前读取恢复线索')
				/* 仅作恢复线索，不影响导入前置校验 */
			}
			const target = saveTo?.operation === 'New Project'
				? { operation: saveTo.operation, teamUuid: saveTo.newProjectOwnerTeamUuid, projectName: saveTo.newProjectFriendlyName }
				: saveTo ? { operation: saveTo.operation, folderPath: saveTo.folderPath } : undefined
			const unknownOutcome = (reason: unknown) => {
				const detail = reason instanceof Error ? reason.message : reason === undefined ? 'SDK 返回空结果' : String(reason)
				return new Error('工程导入调用已发起，但结果无法确认；不要自动重试，请先核对目标工程是否已创建', {
					cause: {
						partial: true,
						retryable: false,
						outcome: 'unknown',
						fileName,
						fileType,
						newProjectName: importName,
						target,
						beforeProjectUuid,
						sdkError: detail,
					},
				})
			}
			let project: any
			deadline.check('发起导入前')
			try {
				project = await deadline.wait(() => eda.sys_FileManager.importProjectByProjectFile(
					file,
					fileType as any,
					undefined,
					saveTo as any,
				), '导入工程文件', true)
			}
			catch (error) {
				throw unknownOutcome(error)
			}
			if (!project || typeof project !== 'object' || typeof project.uuid !== 'string' || !project.uuid)
				throw unknownOutcome(project === undefined ? 'SDK returned undefined' : project === null ? 'SDK returned null' : 'SDK returned no valid project UUID')
			return project
		},
	},
	{
		name: 'project.getDocumentSource',
		summary: '读取当前激活文档（原理图/PCB）的源数据 JSON——比逐个查图元快，适合做整体分析（只读，不提供写入）',
		params: [],
		returns: '{ source }（文档源数据 JSON 字符串）',
		example: { cmd: 'project.getDocumentSource' },
		handler: async () => {
			let before: any
			try {
				before = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			}
			catch (err) {
				throw new Error(`无法确认当前激活文档：${err instanceof Error ? err.message : String(err)}`)
			}
			if (!before || typeof before.uuid !== 'string' || !before.uuid)
				throw new Error('当前没有可确认的激活文档 UUID，未读取文档源数据')
			let source: unknown
			try {
				source = await eda.sys_FileManager.getDocumentSource()
			}
			catch (err) {
				throw new Error(`读取当前激活文档 ${before.uuid} 的源数据失败：${err instanceof Error ? err.message : String(err)}`)
			}
			let after: any
			try {
				after = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			}
			catch (err) {
				throw new Error(`源数据读取后无法确认焦点是否仍为文档 ${before.uuid}：${err instanceof Error ? err.message : String(err)}`)
			}
			if (!after || after.uuid !== before.uuid
				|| (before.documentType !== undefined && after.documentType !== before.documentType)
				|| (before.parentProjectUuid !== undefined && after.parentProjectUuid !== before.parentProjectUuid)
				|| (before.tabId !== undefined && after.tabId !== before.tabId))
				throw new Error(`读取期间激活文档焦点已从 ${before.uuid} 切换，未返回可能错配的源数据`)
			if (typeof source !== 'string' || !source.trim())
				throw new Error('读取当前激活文档源数据失败：官方返回空或非字符串')
			return { source }
		},
	},
	// ---------- 原理图文档管理 ----------
	{
		name: 'project.createSchematic',
		summary: '在当前工程新建原理图',
		params: [
			{ name: 'boardName', type: 'string', description: '关联的板子名——必须是已存在的板子名（传不存在的名字会创建失败）；要新建 PCB/原理图请省略 boardName，之后用 project.associateBoard 关联' },
		],
		returns: '{ schematicUuid }',
		example: { cmd: 'project.createSchematic' },
		handler: async (params) => {
			if (params.boardName !== undefined && (typeof params.boardName !== 'string' || !params.boardName))
				throw new Error('boardName 必须是非空字符串；创建游离原理图请省略参数')
			const deadline = createOperationDeadline(params, 'project.createSchematic')
			const boardName = params.boardName as string | undefined
			const { project, nodes } = await currentProjectTree(deadline, '读取原理图创建前工程树')
			const targetBoard = boardName ? nodes.find(node => node.itemType === 'Board' && node.name === boardName) : undefined
			if (boardName && !targetBoard)
				throw new Error(`当前工程 ${project.uuid} 中不存在精确匹配的 Board ${boardName}，未创建原理图`)
			if (boardName && targetBoard && targetBoard.schematic != null)
				throw new Error(`Board ${boardName} 的原理图槽已占用，未创建原理图`)
			const current = await confirmCurrentProject(deadline, project.uuid, '写入前复核原理图创建工程树')
			if (boardName) {
				const board = current.nodes.find(node => node.itemType === 'Board' && node.name === boardName)
				if (!board || board.schematic !== null)
					throw new Error(`Board ${boardName} 的原理图槽已改变，未创建原理图`)
			}
			let uuid: unknown
			deadline.check('发起创建前')
			try {
				uuid = await deadline.wait(() => eda.dmt_Schematic.createSchematic(boardName), '创建原理图', true)
			}
			catch (err) {
				throw mutationUnknown('project.createSchematic', err, { projectUuid: project.uuid, requestedBoardName: boardName ?? null })
			}
			if (typeof uuid !== 'string' || !uuid)
				throw mutationUnknown('project.createSchematic', 'SDK 返回空 UUID', { projectUuid: project.uuid, requestedBoardName: boardName ?? null })
			let verified = false
			try {
				for (let attempt = 0; attempt < 4; attempt++) {
					const after = await currentProjectTree(deadline, '创建后读取工程树').catch(() => undefined)
					if (after && after.project.uuid === project.uuid) {
						const schematic = after.nodes.find(node => node.itemType === 'Schematic' && node.uuid === uuid)
						const board = boardName ? after.nodes.find(node => node.itemType === 'Board' && node.name === boardName) : undefined
						verified = Boolean(schematic && (boardName ? board?.schematic?.uuid === uuid && schematic.parentBoardName === boardName : !schematic?.parentBoardName && !after.nodes.some(node => node.itemType === 'Board' && node.schematic?.uuid === uuid)))
						if (verified)
						break
					}
					if (attempt < 3)
						await deadline.wait(() => new Promise(resolve => setTimeout(resolve, 500)), '等待原理图创建同步', true)
				}
			}
			catch (err) {
				throw mutationUnknown('project.createSchematic readback', err, { projectUuid: project.uuid, schematicUuid: uuid, requestedBoardName: boardName ?? null })
			}
			if (!verified)
				throw mutationUnknown('project.createSchematic readback', '新原理图类型、工程归属或板槽归属不匹配/未读到', { projectUuid: project.uuid, schematicUuid: uuid, requestedBoardName: boardName ?? null })
			return { schematicUuid: uuid }
		},
	},
	{
		name: 'project.createSchematicPage',
		summary: '在指定原理图下新建图页',
		params: [
			{ name: 'schematicUuid', type: 'string', required: true, description: '原理图 UUID（工程树中 Schematic 节点，非图页）' },
		],
		returns: '{ pageUuid }',
		example: { cmd: 'project.createSchematicPage', params: { schematicUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.schematicUuid)
				throw new Error('缺少参数 schematicUuid')
			const uuid = await eda.dmt_Schematic.createSchematicPage(String(params.schematicUuid))
			if (!uuid)
				throw new Error('图页创建失败（官方返回空）')
			return { pageUuid: uuid }
		},
	},
	{
		name: 'project.deleteSchematicPage',
		summary: '删除指定原理图图页',
		params: [
			{ name: 'pageUuid', type: 'string', required: true, description: '图页 UUID' },
		],
		returns: '{ deleted }',
		example: { cmd: 'project.deleteSchematicPage', params: { pageUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.pageUuid)
				throw new Error('缺少参数 pageUuid')
			const deadline = createOperationDeadline(params, 'project.deleteSchematicPage')
			const pageUuid = String(params.pageUuid)
			const { project, nodes } = await currentProjectTree(deadline, '读取图页删除前工程树')
			const page = nodes.find(node => node.itemType === 'Schematic Page' && node.uuid === pageUuid)
			if (!page)
				throw new Error(`当前工程 ${project.uuid} 的完整文档树中不存在图页 ${pageUuid}，未删除`)
			const current = await confirmCurrentProject(deadline, project.uuid, '写入前复核图页删除工程树')
			if (!current.nodes.some(node => node.itemType === 'Schematic Page' && node.uuid === pageUuid))
				throw new Error(`图页 ${pageUuid} 已不在当前工程 ${project.uuid}，未删除`)
			let deleted: unknown
			deadline.check('发起删除前')
			try {
				deleted = await deadline.wait(() => eda.dmt_Schematic.deleteSchematicPage(pageUuid), '删除图页', true)
			}
			catch (err) {
				throw mutationUnknown('project.deleteSchematicPage', err, { projectUuid: project.uuid, pageUuid })
			}
			let remains: boolean
			let unchanged: boolean
			try {
				const after = await deadline.wait(() => eda.dmt_Project.getCurrentProjectInfo(), '读取图页删除后工程树', true)
				unchanged = projectTreeUnchanged(project, after)
				remains = projectData(after, project.uuid).some(node => node.itemType === 'Schematic Page' && node.uuid === pageUuid)
			}
			catch (err) {
				throw mutationUnknown('project.deleteSchematicPage readback', err, { projectUuid: project.uuid, pageUuid, sdkReturned: deleted })
			}
			if (deleted === false && remains && unchanged)
				throw new Error('官方返回 false，图页仍在当前工程树中，未删除', {
					cause: { partial: false, retryable: false, phase: 'project.deleteSchematicPage', projectUuid: project.uuid, pageUuid, sdkReturned: false, remains: true },
				})
			if (deleted !== true || remains)
				throw new Error(`图页删除结果矛盾或未确认（SDK=${String(deleted)}，读回仍存在=${remains}）`, {
					cause: { partial: true, retryable: false, phase: 'project.deleteSchematicPage verify', projectUuid: project.uuid, pageUuid, sdkReturned: deleted, remains, treeUnchanged: unchanged },
				})
			return { deleted: true }
		},
	},
	{
		name: 'project.copySchematicPage',
		summary: '复制原理图图页（0.10.37 起复制后等同步并读回验证：返回新页名称/归属/源页，名字官方自动派生"源名_N"属正常；若内容与源页不符请对照返回的 sourcePageUuid 复核）',
		params: [
			{ name: 'pageUuid', type: 'string', required: true, description: '源图页 UUID' },
			{ name: 'schematicUuid', type: 'string', description: '目标原理图 UUID，留空复制到同原理图（建议显式传，官方示例也显式传）' },
		],
		returns: '{ pageUuid, name, parentSchematicUuid, sourcePageUuid }（读回验证后的新图页）',
		example: { cmd: 'project.copySchematicPage', params: { pageUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.pageUuid)
				throw new Error('缺少参数 pageUuid')
			if (params.schematicUuid !== undefined && (typeof params.schematicUuid !== 'string' || !params.schematicUuid))
				throw new Error('schematicUuid 必须是非空字符串')
			const deadline = createOperationDeadline(params, 'project.copySchematicPage')
			const sourcePageUuid = String(params.pageUuid)
			const targetSchematic = params.schematicUuid as string | undefined
			const { project, nodes } = await currentProjectTree(deadline, '读取复制前工程树')
			const sourcePage = nodes.find(node => node.itemType === 'Schematic Page' && node.uuid === sourcePageUuid)
			if (!sourcePage)
				throw new Error(`源图页 ${sourcePageUuid} 不属于当前工程 ${project.uuid}，未复制`)
			const sourceSchematicUuid = requireUuid(sourcePage.parentSchematicUuid, `源图页 ${sourcePageUuid} 的父原理图`)
			if (!nodes.some(node => node.itemType === 'Schematic' && node.uuid === sourceSchematicUuid))
				throw new Error(`源图页 ${sourcePageUuid} 的父原理图不在当前工程 ${project.uuid}，未复制`)
			if (targetSchematic && !nodes.some(node => node.itemType === 'Schematic' && node.uuid === targetSchematic))
				throw new Error(`目标原理图 ${targetSchematic} 不属于当前工程 ${project.uuid}，未复制`)
			const expectedParent = targetSchematic ?? sourceSchematicUuid
			const current = await confirmCurrentProject(deadline, project.uuid, '写入前复核图页复制工程树')
			if (!current.nodes.some(node => node.itemType === 'Schematic Page' && node.uuid === sourcePageUuid && node.parentSchematicUuid === sourceSchematicUuid)
				|| (targetSchematic && !current.nodes.some(node => node.itemType === 'Schematic' && node.uuid === targetSchematic)))
				throw new Error('复制前源图页或目标原理图已不在当前工程树中，未复制')
			let uuid: unknown
			deadline.check('发起复制前')
			try {
				// 透传官方（签名 copySchematicPage(schematicPageUuid, schematicUuid?)，0.10.37 已逐字核对）
				uuid = await deadline.wait(() => eda.dmt_Schematic.copySchematicPage(sourcePageUuid, targetSchematic), '复制图页', true)
			}
			catch (err) {
				throw mutationUnknown('project.copySchematicPage', err, { projectUuid: project.uuid, sourcePageUuid, requestedSchematicUuid: expectedParent })
			}
			if (typeof uuid !== 'string' || !uuid || uuid === sourcePageUuid)
				throw mutationUnknown('project.copySchematicPage', 'SDK 返回空 UUID 或复用了源 UUID', {
					projectUuid: project.uuid,
					sourcePageUuid,
					requestedSchematicUuid: expectedParent,
					sdkResultType: uuid === null ? 'null' : typeof uuid,
					...(uuid === null || typeof uuid === 'string' || typeof uuid === 'boolean' || (typeof uuid === 'number' && Number.isFinite(uuid))
						? { sdkResultValue: uuid }
						: typeof uuid === 'number' ? { sdkResultValue: Number.isNaN(uuid) ? 'NaN' : uuid > 0 ? 'Infinity' : '-Infinity' } : {}),
					sdkResultIsSourceUuid: uuid === sourcePageUuid,
				})
			// 官方示例要求等同步再读回（1500ms）；只读轮询，不重复发起复制。
			try {
				await deadline.wait(() => new Promise(resolve => setTimeout(resolve, 1500)), '等待复制同步', true)
			}
			catch (err) {
				throw mutationUnknown('project.copySchematicPage readback', err, { projectUuid: project.uuid, pageUuid: uuid, sourcePageUuid, requestedSchematicUuid: expectedParent })
			}
			let info: any
			try {
				info = await deadline.wait(() => eda.dmt_Schematic.getSchematicPageInfo(uuid), '读取新图页信息', true)
			}
			catch (err) {
				throw mutationUnknown('project.copySchematicPage readback', err, { projectUuid: project.uuid, pageUuid: uuid, sourcePageUuid, requestedSchematicUuid: expectedParent })
			}
			if (!info || info.uuid !== uuid || typeof info.name !== 'string' || !info.name || info.parentSchematicUuid !== expectedParent)
				throw mutationUnknown('project.copySchematicPage readback', '新图页 UUID、父原理图或工程归属不匹配', { projectUuid: project.uuid, pageUuid: uuid, sourcePageUuid, requestedSchematicUuid: expectedParent, actualParentSchematicUuid: info?.parentSchematicUuid ?? null })
			let afterTree: { project: any, nodes: ProjectNode[] }
			try {
				afterTree = await currentProjectTree(deadline, '复制后读取工程树')
			}
			catch (err) {
				throw mutationUnknown('project.copySchematicPage readback', err, { projectUuid: project.uuid, pageUuid: uuid, sourcePageUuid, requestedSchematicUuid: expectedParent })
			}
			const { project: afterProject, nodes: afterNodes } = afterTree
			if (afterProject.uuid !== project.uuid || !afterNodes.some(node => node.itemType === 'Schematic Page' && node.uuid === uuid && node.parentSchematicUuid === expectedParent))
				throw mutationUnknown('project.copySchematicPage readback', '新图页未出现在当前工程目标原理图下', { projectUuid: project.uuid, pageUuid: uuid, sourcePageUuid, requestedSchematicUuid: expectedParent })
			return {
				pageUuid: uuid,
				name: info.name,
				parentSchematicUuid: info.parentSchematicUuid,
				sourcePageUuid,
			}
		},
	},
	{
		name: 'project.renameSchematicPage',
		summary: '按图页 UUID 修改原理图图页名。前置：自动打开激活该页文档并保存一次（官方对未在本窗口保存过的文档改名永远返回 false，独立工程实测）；改名 false 自动重试、true 后轮询读回确认（0.10.58 定案）',
		params: [
			{ name: 'pageUuid', type: 'string', required: true, description: '图页 UUID' },
			{ name: 'name', type: 'string', required: true, description: '新图页名' },
		],
		returns: '{ pageUuid, name, renamed, note? }（renamed=false 但无 note 时是真失败；带 note 是官方已接受但读回未生效）',
		example: { cmd: 'project.renameSchematicPage', params: { pageUuid: 'xxx', name: '电源页' } },
		handler: async (params) => {
			if (!params.pageUuid || !params.name)
				throw new Error('缺少参数 pageUuid / name')
			const pageUuid = String(params.pageUuid)
			const name = String(params.name)
			// 官方改页名的三个坑（独立工程多窗口实测，2026-10-04）：
			// 1) 目标页文档未在窗口中打开并激活时，modifySchematicPageName 永远返回 false（重试无用）；
			// 2) 仅打开激活还不够：该页所在文档必须在本窗口保存过一次（sch_Document.save），否则依旧永远 false
			//    （本窗口新建的对象不受限；跨窗口/重启前创建的旧页必须先保存）；
			// 3) 改名是异步提交：连续改名第二次可能返回 true 但读回仍是旧名（实测读回延迟 >800ms），
			//    旧实现固定 sleep 800ms 读回一次，必然产生 renamed:false 假阴性。
			// 修复：打开激活 → 保存 → false 重试 → true 后轮询读回（0.10.58，0.10.59 按外部审查加固失败路径）。
			// save 不能藏在 if(tabId) 里：官方对已打开文档可能返回空 tabId，漏掉 save 前置就必然 false。
			try {
				const tabId = await eda.dmt_EditorControl.openDocument(pageUuid)
				if (tabId) {
					try { await eda.dmt_EditorControl.activateDocument(tabId) }
					catch { /* 激活失败不阻断，openDocument 本身通常已激活 */ }
					await new Promise(resolve => setTimeout(resolve, 800))
				}
				// openDocument 返回的 tabId 只能标识标签，不能证明当前焦点；save() 无目标参数，
				// 每次保存前都必须读取焦点 UUID 并确认它就是目标页。
				let focusOk = false
				for (let i = 0; i < 5 && !focusOk; i++) {
					const focus: any = await eda.dmt_SelectControl.getCurrentDocumentInfo().catch(() => undefined)
					focusOk = focus?.uuid === pageUuid
					if (!focusOk)
						await new Promise(r => setTimeout(r, 300))
				}
				if (focusOk) {
					try { await eda.sch_Document.save() }
					catch { /* 保存失败不阻断，仍尝试直接改名 */ }
				}
			}
			catch { /* 打开失败不阻断，仍尝试直接改名 */ }
			let accepted = false
			for (let attempt = 1; attempt <= 3; attempt++) {
				accepted = await eda.dmt_Schematic.modifySchematicPageName(pageUuid, name)
				if (accepted)
					break
				await new Promise(resolve => setTimeout(resolve, 1200))
			}
			if (!accepted)
				throw new Error('改名失败（官方连续 3 次返回 false）。已自动完成前置（打开激活+保存），仍被拒的多窗口实测规律：本窗口从未成功改过页名时，由其他窗口/早前创建的页会被官方拒绝；可先对本窗口新建的页成功改名一次解锁，或换到创建该页的窗口操作；若同一工程在多个窗口打开，先关掉多余窗口')
			// 轮询读回确认，最多 6s；读回抛错不中断轮询（审查项：避免单点失败炸掉整个 handler）
			const deadline = Date.now() + 6000
			let lastName: string | null = null
			while (Date.now() < deadline) {
				try {
					const info: any = await eda.dmt_Schematic.getSchematicPageInfo(pageUuid)
					lastName = info?.name ?? null
				}
				catch { lastName = null }
				if (lastName === name)
					return { pageUuid, name, renamed: true }
				await new Promise(resolve => setTimeout(resolve, 600))
			}
			return { pageUuid, name: lastName, renamed: false, note: '官方已接受但读回未生效（异步提交），请稍后 listSchematicPages 复核' }
		},
	},
	{
		name: 'project.listSchematicPages',
		summary: '列出当前工程全部原理图图页',
		params: [],
		returns: '图页列表 [{ uuid, name, ... }]',
		example: { cmd: 'project.listSchematicPages' },
		handler: async () => {
			return await eda.dmt_Schematic.getAllSchematicPagesInfo()
		},
	},
	{
		name: 'project.reorderSchematicPages',
		summary: '调整原理图图页顺序',
		params: [
			{ name: 'schematicUuid', type: 'string', required: true, description: '原理图 UUID' },
			{ name: 'pageUuids', type: 'string[]', required: true, description: '按期望顺序排列的图页 uuid 列表（须包含全部图页）' },
		],
		returns: '{ reordered }',
		example: { cmd: 'project.reorderSchematicPages', params: { schematicUuid: 'xxx', pageUuids: ['p2', 'p1'] } },
		handler: async (params) => {
			if (!params.schematicUuid || !Array.isArray(params.pageUuids))
				throw new Error('缺少参数 schematicUuid / pageUuids')
			const wanted = params.pageUuids.map(String)
			// EDA 内部数据有延迟（新建/复制的图页不会立刻出现在列表里），做短暂重试
			let pages: Array<any> = []
			let ordered: Array<any> = []
			for (let attempt = 0; attempt < 4; attempt++) {
				pages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) ?? []
				ordered = []
				let missing: string | undefined
				for (const u of wanted) {
					const hit = pages.find(p => p?.uuid === u)
					if (!hit) {
						missing = u
						break
					}
					ordered.push(hit)
				}
				if (!missing)
					break
				if (attempt === 3)
					throw new Error(`图页 ${missing} 不存在，可用 project.listSchematicPages 查看`)
				await new Promise(resolve => setTimeout(resolve, 600))
			}
			const reordered = await eda.dmt_Schematic.reorderSchematicPages(
				String(params.schematicUuid),
				ordered as any,
			)
			return { reordered: Boolean(reordered) }
		},
	},
	{
		name: 'project.modifyTitleBlock',
		summary: '修改当前原理图图页的标题栏（图框）显示与内容。data 的键必须是当前图框里已存在的字段名（先用 schematic.getPageInfo 查 titleBlockData）；省略的字段状态沿用当前值。modified=true 仅代表宿主接受提交，不代表已保存或读回确认。纸张大小（Page Size）/图框符号（Symbol）实测不能通过此接口切换，请让用户在界面手动改',
		params: [
			{ name: 'showTitleBlock', type: 'boolean', description: '是否显示标题栏' },
			{ name: 'data', type: 'object', description: '标题栏字段，如 { "Title": { value: "主控板" } }；键必须先存在，省略的 showTitle/showValue/value 沿用当前值' },
		],
		returns: '{ modified, submitted, readback?: { uuid, verified: false }, note? }（modified=true 仅代表宿主接受提交，不代表已保存或读回确认）',
		example: { cmd: 'project.modifyTitleBlock', params: { showTitleBlock: true } },
		handler: async (params) => {
			if (!params || typeof params !== 'object' || Array.isArray(params))
				throw new Error('标题栏请求参数必须是对象')
			if (params.showTitleBlock != null && typeof params.showTitleBlock !== 'boolean')
				throw new Error('showTitleBlock 必须是布尔值')
			if (params.data !== undefined && (!params.data || typeof params.data !== 'object' || Array.isArray(params.data)))
				throw new Error('data 必须是包含标题栏字段对象的对象')
			// 此接口只修改当前图页，先确认实际焦点是有效原理图页，再读取该页字段。
			const focus: any = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (focus?.documentType !== 1 || !focus?.uuid)
				throw new Error('无法确认当前焦点是有效原理图图页，未修改标题栏')
			const page: any = await eda.dmt_Schematic.getSchematicPageInfo(String(focus.uuid))
			if (!page || page.uuid !== focus.uuid)
				throw new Error(`无法读取当前焦点图页 ${String(focus.uuid)}，未修改标题栏`)
			const mergedData: Record<string, any> | undefined = params.data === undefined ? undefined : {}
			if (params.data !== undefined) {
				const available = Object.keys(page.titleBlockData ?? {})
				const unknown = Object.keys(params.data).filter(k => !available.includes(k))
				if (unknown.length)
					throw new Error(`标题栏不存在字段: ${unknown.join('、')}（当前图框可用字段: ${available.join('、')}）。注意：Page Size / Symbol 不能用此接口切换纸张，请在 EDA 界面手动修改`)
				for (const [key, requested] of Object.entries(params.data)) {
					if (!requested || typeof requested !== 'object' || Array.isArray(requested))
						throw new Error(`标题栏字段 ${key} 的值必须是对象`)
					const current = page.titleBlockData?.[key]
					if (!current || typeof current !== 'object' || Array.isArray(current))
						throw new Error(`当前图框字段 ${key} 没有可沿用的状态，无法完整修改`)
					const merged = { ...current, ...requested }
					if (typeof merged.showTitle !== 'boolean' || typeof merged.showValue !== 'boolean' || merged.value === undefined)
						throw new Error(`当前图框字段 ${key} 缺少 showTitle/showValue/value 状态，无法完整修改`)
					mergedData![key] = merged
				}
			}
			const writeFocus: any = await eda.dmt_SelectControl.getCurrentDocumentInfo()
			if (writeFocus?.documentType !== 1 || writeFocus?.uuid !== focus.uuid)
				throw new Error(`标题栏校验期间焦点已从图页 ${String(focus.uuid)} 切换，未修改标题栏`)
			let modified: boolean
			try {
				modified = await eda.dmt_Schematic.modifySchematicPageTitleBlock(
					params.showTitleBlock ?? undefined,
					mergedData,
				)
			}
			catch (err) {
				throw new Error(`标题栏修改失败：${(err as any)?.message ?? err}。常见原因：data 含当前图框不存在的字段键，或试图用此接口切换 Page Size / Symbol（不支持，需界面手动操作）`, {
					cause: { partial: true, retryable: false, phase: 'project.modifyTitleBlock write', operationError: (err as any)?.message ?? String(err) },
				})
			}
			if (!modified)
				return { modified: false, submitted: false }
			return {
				modified: true,
				submitted: true,
				readback: { uuid: focus.uuid, verified: false },
				note: '宿主已接受修改，内容尚待独立读回确认',
			}
		},
	},
	// ---------- PCB 文档管理 ----------
	{
		name: 'project.createPcb',
		summary: '在当前工程新建 PCB',
		params: [
			{ name: 'boardName', type: 'string', description: '关联的板子名——必须是已存在的板子名（传不存在的名字会创建失败）；要新建 PCB/原理图请省略 boardName，之后用 project.associateBoard 关联' },
		],
		returns: '{ pcbUuid }',
		example: { cmd: 'project.createPcb' },
		handler: async (params) => {
			if (params.boardName !== undefined && (typeof params.boardName !== 'string' || !params.boardName))
				throw new Error('boardName 必须是非空字符串；创建游离 PCB 请省略参数')
			const deadline = createOperationDeadline(params, 'project.createPcb')
			const boardName = params.boardName as string | undefined
			const { project, nodes } = await currentProjectTree(deadline, '读取 PCB 创建前工程树')
			const targetBoard = boardName ? nodes.find(node => node.itemType === 'Board' && node.name === boardName) : undefined
			if (boardName && !targetBoard)
				throw new Error(`当前工程 ${project.uuid} 中不存在精确匹配的 Board ${boardName}，未创建 PCB`)
			if (boardName && targetBoard && targetBoard.pcb != null)
				throw new Error(`Board ${boardName} 的 PCB 槽已占用，未创建 PCB`)
			const current = await confirmCurrentProject(deadline, project.uuid, '写入前复核 PCB 创建工程树')
			if (boardName) {
				const board = current.nodes.find(node => node.itemType === 'Board' && node.name === boardName)
				if (!board || board.pcb !== null)
					throw new Error(`Board ${boardName} 的 PCB 槽已改变，未创建 PCB`)
			}
			let uuid: unknown
			deadline.check('发起创建前')
			try {
				uuid = await deadline.wait(() => eda.dmt_Pcb.createPcb(boardName), '创建 PCB', true)
			}
			catch (err) {
				throw mutationUnknown('project.createPcb', err, { projectUuid: project.uuid, requestedBoardName: boardName ?? null })
			}
			if (typeof uuid !== 'string' || !uuid)
				throw mutationUnknown('project.createPcb', 'SDK 返回空 UUID', { projectUuid: project.uuid, requestedBoardName: boardName ?? null })
			let verified = false
			try {
				for (let attempt = 0; attempt < 4; attempt++) {
					const after = await currentProjectTree(deadline, '创建后读取工程树').catch(() => undefined)
					if (after && after.project.uuid === project.uuid) {
						const pcb = after.nodes.find(node => node.itemType === 'PCB' && node.uuid === uuid)
						const board = boardName ? after.nodes.find(node => node.itemType === 'Board' && node.name === boardName) : undefined
						verified = Boolean(pcb && (boardName ? board?.pcb?.uuid === uuid && pcb.parentBoardName === boardName : !pcb?.parentBoardName && !after.nodes.some(node => node.itemType === 'Board' && node.pcb?.uuid === uuid)))
						if (verified)
						break
					}
					if (attempt < 3)
						await deadline.wait(() => new Promise(resolve => setTimeout(resolve, 500)), '等待 PCB 创建同步', true)
				}
			}
			catch (err) {
				throw mutationUnknown('project.createPcb readback', err, { projectUuid: project.uuid, pcbUuid: uuid, requestedBoardName: boardName ?? null })
			}
			if (!verified)
				throw mutationUnknown('project.createPcb readback', '新 PCB 类型、工程归属或板槽归属不匹配/未读到', { projectUuid: project.uuid, pcbUuid: uuid, requestedBoardName: boardName ?? null })
			return { pcbUuid: uuid, note: '新建 PCB 需在 EDA 界面打开渲染一次后，写操作才会被官方 API 接受' }
		},
	},
	{
		name: 'project.copyPcb',
		summary: '复制指定 PCB；boardName 指定副本归属的目标板子（Board）名，省略时创建游离 PCB',
		params: [
			{ name: 'pcbUuid', type: 'string', required: true, description: '源 PCB UUID' },
			{ name: 'boardName', type: 'string', description: '副本归属的目标板子（Board）名；省略时创建游离 PCB' },
		],
		returns: '{ pcbUuid }（新 PCB）；若 SDK 返回空或抛错，结果未知，错误标记 error.cause.partial=true 并阻止依赖宏继续',
		example: { cmd: 'project.copyPcb', params: { pcbUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.pcbUuid)
				throw new Error('缺少参数 pcbUuid')
			const deadline = createOperationDeadline(params, 'project.copyPcb')
			const sourcePcbUuid = String(params.pcbUuid)
			if (params.boardName !== undefined && (typeof params.boardName !== 'string' || !params.boardName))
				throw new Error('boardName 必须是非空字符串；创建游离副本请省略参数')
			const boardName = params.boardName as string | undefined
			const { project, nodes } = await currentProjectTree(deadline, '读取复制前工程树')
			if (!nodes.some(node => node.itemType === 'PCB' && node.uuid === sourcePcbUuid))
				throw new Error(`源 PCB ${sourcePcbUuid} 不属于当前工程 ${project.uuid}，未复制`)
			const targetBoard = boardName ? nodes.find(node => node.itemType === 'Board' && node.name === boardName) : undefined
			if (boardName && !targetBoard)
				throw new Error(`当前工程 ${project.uuid} 中不存在精确匹配的 Board ${boardName}，未复制 PCB`)
			if (boardName && targetBoard && targetBoard.pcb != null)
				throw new Error(`Board ${boardName} 的 PCB 槽已占用，未复制 PCB`)
			const current = await confirmCurrentProject(deadline, project.uuid, '写入前复核 PCB 复制工程树')
			if (!current.nodes.some(node => node.itemType === 'PCB' && node.uuid === sourcePcbUuid))
				throw new Error(`源 PCB ${sourcePcbUuid} 已不在当前工程 ${project.uuid}，未复制`)
			if (boardName) {
				const board = current.nodes.find(node => node.itemType === 'Board' && node.name === boardName)
				if (!board || board.pcb !== null)
					throw new Error(`Board ${boardName} 的 PCB 槽已改变，未复制 PCB`)
			}
			const unknownResult = (operationError: unknown) => new Error(
				`PCB 复制结果未知（源 PCB ${sourcePcbUuid}，请求 boardName=${boardName ?? '未提供'}）。官方调用可能已创建副本，也可能尚未创建；请先用 project.getInfo / project.listPcbs 核对是否生成副本，再决定后续操作；不要自动重试。原始错误：${operationError instanceof Error ? operationError.message : String(operationError)}`,
				{
					cause: {
						partial: true,
						retryable: false,
						phase: 'project.copyPcb',
						operationError: operationError instanceof Error ? operationError.message : String(operationError),
						result: { projectUuid: project.uuid, sourcePcbUuid, requestedBoardName: boardName ?? null, pcbUuid: 'unknown' },
					},
				},
			)
			let uuid: unknown
			deadline.check('发起复制前')
			try {
				uuid = await deadline.wait(() => eda.dmt_Pcb.copyPcb(sourcePcbUuid, boardName), '复制 PCB', true)
			}
			catch (err) {
				throw unknownResult(err)
			}
			if (typeof uuid !== 'string' || !uuid || uuid === sourcePcbUuid)
				throw unknownResult('SDK 返回空值')
			try {
				let verified = false
				for (let attempt = 0; attempt < 4; attempt++) {
					const after = await currentProjectTree(deadline, '复制后读取工程树').catch((err) => {
						deadline.check('复制后读取工程树', true)
						return undefined
					})
					if (after && after.project.uuid === project.uuid) {
						const copiedPcb = after.nodes.find(node => node.itemType === 'PCB' && node.uuid === uuid)
						const copiedBoard = boardName ? after.nodes.find(node => node.itemType === 'Board' && node.name === boardName) : undefined
						verified = Boolean(copiedPcb && (boardName
							? copiedBoard?.pcb?.uuid === uuid && copiedPcb.parentBoardName === boardName
							: !copiedPcb.parentBoardName && !after.nodes.some(node => node.itemType === 'Board' && node.pcb?.uuid === uuid)))
						if (verified)
							break
					}
					if (attempt < 3)
						await deadline.wait(() => new Promise(resolve => setTimeout(resolve, 500)), '等待 PCB 复制同步', true)
				}
				if (!verified)
					throw new Error(`新 PCB ${uuid} 未能在工程 ${project.uuid} 的${boardName ? `Board ${boardName} PCB 槽` : '游离文档'}中读回确认`)
			}
			catch (err) {
				throw unknownResult(err)
			}
			return { pcbUuid: uuid }
		},
	},
	{
		name: 'project.deletePcb',
		summary: '删除 PCB',
		params: [
			{ name: 'pcbUuid', type: 'string', required: true, description: 'PCB UUID' },
		],
		returns: '{ deleted }',
		example: { cmd: 'project.deletePcb', params: { pcbUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.pcbUuid)
				throw new Error('缺少参数 pcbUuid')
			const deadline = createOperationDeadline(params, 'project.deletePcb')
			const pcbUuid = String(params.pcbUuid)
			const { project, nodes } = await currentProjectTree(deadline, '读取 PCB 删除前工程树')
			if (!nodes.some(node => node.itemType === 'PCB' && node.uuid === pcbUuid))
				throw new Error(`当前工程 ${project.uuid} 的完整文档树中不存在 PCB ${pcbUuid}，未删除`)
			const current = await confirmCurrentProject(deadline, project.uuid, '写入前复核 PCB 删除工程树')
			if (!current.nodes.some(node => node.itemType === 'PCB' && node.uuid === pcbUuid))
				throw new Error(`PCB ${pcbUuid} 已不在当前工程 ${project.uuid}，未删除`)
			let deleted: unknown
			deadline.check('发起删除前')
			try {
				deleted = await deadline.wait(() => eda.dmt_Pcb.deletePcb(pcbUuid), '删除 PCB', true)
			}
			catch (err) {
				throw mutationUnknown('project.deletePcb', err, { projectUuid: project.uuid, pcbUuid })
			}
			let remains: boolean
			let unchanged: boolean
			try {
				const after = await deadline.wait(() => eda.dmt_Project.getCurrentProjectInfo(), '读取 PCB 删除后工程树', true)
				unchanged = projectTreeUnchanged(project, after)
				remains = projectData(after, project.uuid).some(node => node.itemType === 'PCB' && node.uuid === pcbUuid)
			}
			catch (err) {
				throw mutationUnknown('project.deletePcb readback', err, { projectUuid: project.uuid, pcbUuid, sdkReturned: deleted })
			}
			if (deleted === false && remains && unchanged)
				throw new Error('官方返回 false，PCB 仍在当前工程树中，未删除', {
					cause: { partial: false, retryable: false, phase: 'project.deletePcb', projectUuid: project.uuid, pcbUuid, sdkReturned: false, remains: true },
				})
			if (deleted !== true || remains)
				throw new Error(`PCB 删除结果矛盾或未确认（SDK=${String(deleted)}，读回仍存在=${remains}）`, {
					cause: { partial: true, retryable: false, phase: 'project.deletePcb verify', projectUuid: project.uuid, pcbUuid, sdkReturned: deleted, remains, treeUnchanged: unchanged },
				})
			return { deleted: true }
		},
	},
	{
		name: 'project.listPcbs',
		summary: '列出当前工程全部 PCB',
		params: [],
		returns: 'PCB 列表 [{ uuid, name, ... }]',
		example: { cmd: 'project.listPcbs' },
		handler: async () => {
			return await eda.dmt_Pcb.getAllPcbsInfo()
		},
	},
	// ---------- 板级管理 ----------
	{
		name: 'project.copyBoard',
		summary: '复制板子（Board）',
		params: [
			{ name: 'boardName', type: 'string', required: true, description: '源板子名' },
		],
		returns: '{ boardName }（新板子）',
		example: { cmd: 'project.copyBoard', params: { boardName: 'Board1' } },
		handler: async (params) => {
			if (!params.boardName)
				throw new Error('缺少参数 boardName')
			const name = await eda.dmt_Board.copyBoard(String(params.boardName))
			if (!name)
				throw new Error('板子复制失败（官方返回空）')
			return { boardName: name }
		},
	},
	{
		name: 'project.deleteBoard',
		summary: '删除指定板子（Board）；官方接口返回失败时，附带当前工程中的目标板信息，不自动重试删除',
		params: [
			{ name: 'boardName', type: 'string', required: true, description: '板子名' },
		],
		returns: '{ deleted, diagnostics? }——deleted:false 时 diagnostics 列出当前板子清单、目标板关联文档与可能原因',
		example: { cmd: 'project.deleteBoard', params: { boardName: 'Board1' } },
		handler: async (params) => {
			if (!params.boardName)
				throw new Error('缺少参数 boardName')
			const deadline = createOperationDeadline(params, 'project.deleteBoard')
			const boardName = String(params.boardName)
			const { project, nodes } = await currentProjectTree(deadline, '读取 Board 删除前工程树')
			if (!nodes.some(node => node.itemType === 'Board' && node.name === boardName))
				throw new Error(`当前工程 ${project.uuid} 的完整文档树中不存在 Board ${boardName}，未删除`)
			const current = await confirmCurrentProject(deadline, project.uuid, '写入前复核 Board 删除工程树')
			if (!current.nodes.some(node => node.itemType === 'Board' && node.name === boardName))
				throw new Error(`Board ${boardName} 已不在当前工程 ${project.uuid}，未删除`)
			let deleted: unknown
			deadline.check('发起删除前')
			try {
				deleted = await deadline.wait(() => eda.dmt_Board.deleteBoard(boardName), '删除 Board', true)
			}
			catch (err) {
				throw mutationUnknown('project.deleteBoard', err, { projectUuid: project.uuid, boardName })
			}
			let afterNodes: ProjectNode[]
			let unchanged: boolean
			try {
				const after = await deadline.wait(() => eda.dmt_Project.getCurrentProjectInfo(), '读取 Board 删除后工程树', true)
				unchanged = projectTreeUnchanged(project, after)
				afterNodes = projectData(after, project.uuid)
			}
			catch (err) {
				throw mutationUnknown('project.deleteBoard readback', err, { projectUuid: project.uuid, boardName, sdkReturned: deleted })
			}
			const boardRemains = afterNodes.some(node => node.itemType === 'Board' && node.name === boardName)
			if (deleted === true && !boardRemains)
				return { deleted: true }
			// 官方返回 false 时读取当前实际状态，不把历史故障或猜测当作本次原因。
			const boards = afterNodes.filter(node => node.itemType === 'Board').map(b => ({ name: b.name, uuid: b.uuid, schematic: b.schematic ? { uuid: b.schematic.uuid, pages: (b.schematic.page ?? []).length } : null, pcb: b.pcb?.uuid ?? null }))
			const target = boards.find(b => String(b.name) === boardName)
			const diagnostics: Record<string, any> = {
				boardExists: Boolean(target),
				boards: boards.map(b => b.name),
				target: target ?? '未在工程文档树中找到该板',
				likelyCauses: target
					? ['官方删除接口返回 false，目标板仍存在；具体失败原因尚未由接口提供']
					: ['官方返回值与读回状态不一致，目标板已不存在'],
			}
			if (deleted === false && boardRemains && unchanged)
				throw new Error('官方返回 false，Board 仍在当前工程树中，未删除', {
					cause: { partial: false, retryable: false, phase: 'project.deleteBoard', projectUuid: project.uuid, boardName, sdkReturned: false, remains: true, diagnostics },
				})
			throw new Error(`Board 删除结果矛盾（SDK=${String(deleted)}，读回仍存在=${boardRemains}）`, {
				cause: { partial: true, retryable: false, phase: 'project.deleteBoard verify', projectUuid: project.uuid, boardName, sdkReturned: deleted, remains: boardRemains, treeUnchanged: unchanged, diagnostics },
			})
		},
	},
	{
		name: 'project.renameBoard',
		summary: '重命名板子（Board）。官方接口按名字匹配且为异步提交，曾误改同名 Panel 对象；改名前后对 Board+Panel 全量快照做差异比对，renamed 只以快照为准；快照不可用或目标板不存在时拒绝改名，绝不盲改（0.10.59 按外部审查加固）',
		params: [
			{ name: 'boardName', type: 'string', required: true, description: '原板子名' },
			{ name: 'newName', type: 'string', required: true, description: '新板子名' },
		],
		returns: '{ renamed, warning?, nonTargetChanges? }（renamed 以 Board+Panel 快照比对结果为准，不以官方返回值为准）',
		example: { cmd: 'project.renameBoard', params: { boardName: 'Board1', newName: 'MainBoard' } },
		handler: async (params) => {
			if (!params.boardName || !params.newName)
				throw new Error('缺少参数 boardName / newName')
			const oldName = String(params.boardName)
			const newName = String(params.newName)
			// 官方接口按名字匹配，曾把同名 Panel 误改名而 Board 未动、却返回成功；
			// 且改名是异步提交。改为：改名前快照 Board+Panel 的 uuid→name，改名后比对：
			// 只有目标板确实变成新名、且没有其他板/Panel 被误改，才报 renamed:true（0.10.56 修复）。
			const snap = async () => {
				const map = new Map<string, string>()
				// 审查项：uuid 缺失时不能用 name 兜底当 key（同名对象会互相覆盖、差异比对丢失），用序号保证唯一
				let i = 0
				for (const b of (await eda.dmt_Board.getAllBoardsInfo()) ?? [])
					map.set(`board:${(b as { uuid?: string }).uuid ?? `nouuid-${i++}`}`, (b as { name?: string }).name ?? '')
				try {
					for (const p of (await eda.dmt_Panel.getAllPanelsInfo()) ?? [])
						map.set(`panel:${(p as { uuid?: string }).uuid ?? `nouuid-${i++}`}`, (p as { name?: string }).name ?? '')
				}
				catch { /* 部分工程无面板对象，忽略 */ }
				return map
			}
			let before: Map<string, string> | undefined
			try { before = await snap() } catch { /* before 置空，下方统一拒绝 */ }
			// 审查项：改名前快照不可用必须拒绝改名——没有 before 就无法区分"目标已改名"与"工程里本来就有同名板"，
			// 继续走官方返回值/fallback 比对会把假成功放回去（A3：错误或读回不一致不得报更名完成）。
			if (!before)
				return { renamed: false, warning: '改名前快照读取失败，无法安全匹配目标板，已拒绝执行（未调用官方改名接口）' }
			// 从快照锁定目标板 key（按旧名匹配）；快照里有多个同名板时取第一个并提示
			let targetKey: string | undefined
			for (const [k, n] of before) {
				if (n === oldName && k.startsWith('board:')) { targetKey = k; break }
			}
			if (!targetKey) {
				return { renamed: false, warning: `快照中找不到名为「${oldName}」的板子，无法安全改名（官方接口按名匹配，盲改可能误改同名面板），请先用 project.getInfo 核对板名` }
			}
			// 审查项：官方抛错要结构化返回，不让 handler 直接炸掉
			let apiResult = false
			try { apiResult = await eda.dmt_Board.modifyBoardName(oldName, newName) }
			catch (e: any) {
				return { renamed: false, warning: `官方改名接口抛错（未确认是否已执行，请勿重试盲改）：${e?.message ?? e}` }
			}
			// 官方异步提交，实测落地可能超过 1s：每 1s 快照一次，目标板落地即提前结束，最多 8s
			const deadline = Date.now() + 8000
			let after: Map<string, string> | undefined
			while (Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, 1000))
				try { after = await snap() } catch { after = undefined }
				if (after && after.get(targetKey) === newName)
					break
			}
			// 审查项：快照不可用一律 renamed:false，不信官方返回值（否则误改 Panel 时官方 true 又变成假成功）
			if (!after)
				return { renamed: false, warning: '改名后快照读取失败，无法校验实际结果；官方接口可能已执行也可能没有，请用 project.getInfo 人工核对后再决定是否重试' }
			const targetOk = after.get(targetKey) === newName
			// 非目标对象的：名字变化、旧对象消失，均视为误改；after 新增对象只在名字等于新旧名时才可疑上报
			// （审查项：否则窗口里并发新建的无关板子会被误报成"误改"）
			const nonTargetChanges: string[] = []
			for (const [k, n] of after) {
				if (k === targetKey)
					continue
				if (before.has(k)) {
					if (before.get(k) !== n)
						nonTargetChanges.push(`${k.startsWith('panel:') ? '面板' : '板子'} ${before.get(k)} → ${n}`)
				}
				else if (n === newName || n === oldName) {
					nonTargetChanges.push(`${k.startsWith('panel:') ? '面板' : '板子'} (新增) ${n}`)
				}
			}
			for (const [k, n] of before) {
				if (k !== targetKey && !after.has(k))
					nonTargetChanges.push(`${k.startsWith('panel:') ? '面板' : '板子'} ${n} 已消失`)
			}
			if (targetOk && nonTargetChanges.length === 0) {
				return apiResult
					? { renamed: true }
					: { renamed: true, note: '官方接口返回失败，但快照比对显示目标板已改名，以快照为准' }
			}
			const warning = !targetOk
				? `目标板「${oldName}」未变成「${newName}」，官方按名匹配可能改错了对象`
				: `改名成功，但同时改动了非目标对象：${nonTargetChanges.join('；')}`
			return { renamed: false, warning, ...(nonTargetChanges.length ? { nonTargetChanges } : {}) }
		},
	},
]

export const libraryCommands: Array<ICommandDef> = [
	{
		name: 'library.searchDevice',
		summary: '按关键词搜索器件库',
		params: [
			{ name: 'keyword', type: 'string', required: true, description: '搜索关键词，如型号或名称' },
			{ name: 'limit', type: 'number', description: '返回数量上限，默认 10' },
		],
		returns: '器件列表 [{ uuid, libraryUuid, name, manufacturerId, lcscId, footprint, value }]',
		example: { cmd: 'library.searchDevice', params: { keyword: 'NE555', limit: 5 } },
		handler: async (params) => {
			if (!params.keyword)
				throw new Error('缺少参数 keyword')
			const items = await eda.lib_Device.search(String(params.keyword))
			const limit = Number(params.limit) || 10
			return (items ?? []).slice(0, limit).map(mapDevice)
		},
	},
	{
		name: 'library.getDeviceByLcsc',
		summary: '按立创商城编号（如 C25804）查询器件',
		params: [
			{ name: 'lcscId', type: 'string', required: true, description: '立创编号，如 C25804' },
		],
		returns: '器件对象 { uuid, libraryUuid, name, manufacturerId, lcscId, footprint, value, description }',
		example: { cmd: 'library.getDeviceByLcsc', params: { lcscId: 'C25804' } },
		handler: async (params) => {
			if (!params.lcscId)
				throw new Error('缺少参数 lcscId')
			const items = await eda.lib_Device.getByLcscIds([String(params.lcscId)])
			const item = items?.[0]
			if (!item)
				throw new Error(`未找到立创编号为 ${params.lcscId} 的器件`)
			return mapDevice(item)
		},
	},
]
