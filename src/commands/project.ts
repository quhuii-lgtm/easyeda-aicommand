/**
 * 工程与库类指令
 */
import type { ICommandDef } from '../engine/types'
import { fileToResult } from './util'

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
		params: [],
		returns: '当前工程信息对象',
		example: { cmd: 'project.getInfo' },
		handler: async () => {
			const info = await eda.dmt_Project.getCurrentProjectInfo()
			if (!info)
				throw new Error('当前没有打开的工程')
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
			const opened = await eda.dmt_Project.openProject(String(params.projectUuid))
			if (!opened)
				throw new Error('工程打开失败，请检查 uuid 是否正确')
			return { opened: true }
		},
	},
	{
		name: 'project.list',
		summary: '列出全部工程（uuid 列表；detail=true 时逐个查信息，较慢）',
		params: [
			{ name: 'detail', type: 'boolean', description: '是否返回每个工程的详细信息，默认 false' },
		],
		returns: '工程 uuid 列表，或 [{ uuid, info }]',
		example: { cmd: 'project.list' },
		handler: async (params) => {
			const uuids = await eda.dmt_Project.getAllProjectsUuid()
			if (!params.detail)
				return uuids ?? []
			const out: Array<{ uuid: string, info: unknown }> = []
			for (const uuid of uuids ?? [])
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
			const moved = await eda.dmt_Project.moveProjectToFolder(
				String(params.projectUuid),
				params.folderUuid ? String(params.folderUuid) : undefined,
			)
			return { moved: Boolean(moved) }
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
			const fileType = (params.fileType === 'epro2' ? 'epro2' : 'epro') as 'epro' | 'epro2'
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
		summary: '从工程文件导入工程（薄封装官方 sys_FileManager.importProjectByProjectFile；支持 .epro/.PcbDoc/.SchDoc/.kicad_pcb 等，传 base64 文件内容；缺省新建工程到当前团队；导入可能耗时，耐心等待返回）',
		params: [
			{ name: 'base64', type: 'string', required: true, description: '文件内容的 base64 编码' },
			{ name: 'fileName', type: 'string', required: true, description: '文件名（带扩展名，用于构造 File 和推断 fileType）' },
			{ name: 'fileType', type: 'string', description: "文件类型，如 'Altium Designer'、'KiCad'、'PADS'、'JLCEDA Pro' 等；缺省按扩展名推断（.PcbDoc/.SchDoc→'Altium Designer'），无法推断时必须显式传" },
			{ name: 'newProjectName', type: 'string', description: '新工程名，缺省官方按文件名命名' },
			{ name: 'saveToFolderPath', type: 'string', description: "本地文件夹路径（仅离线客户端）：传入后 saveTo 用 'Offline Client Local Path'；缺省新建工程到当前团队（自动取 dmt_Team.getCurrentTeamInfo 的 uuid）" },
		],
		returns: '{ uuid, name, ... }（官方 IDMT_BriefProjectItem 简略工程属性）',
		example: { cmd: 'project.importFile', params: { fileName: 'board.PcbDoc', fileType: 'Altium Designer', base64: '...' } },
		handler: async (params) => {
			if (!params.base64)
				throw new Error('缺少参数 base64（文件内容的 base64 编码）')
			if (!params.fileName)
				throw new Error('缺少参数 fileName（带扩展名的文件名）')
			const fileName = String(params.fileName)
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
			const bin = atob(String(params.base64))
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
				const team: any = await eda.dmt_Team.getCurrentTeamInfo()
				const teamUuid = team?.uuid ?? team?.teamUuid
				if (!teamUuid)
					throw new Error('拿不到当前团队 uuid（dmt_Team.getCurrentTeamInfo 返回异常），无法新建工程')
				saveTo = {
					operation: 'New Project',
					newProjectOwnerTeamUuid: teamUuid,
					newProjectName: params.newProjectName ? String(params.newProjectName) : undefined,
				}
			}
			const project = await eda.sys_FileManager.importProjectByProjectFile(
				file,
				fileType as any,
				undefined,
				saveTo as any,
			)
			if (!project)
				throw new Error('导入失败：官方返回空')
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
			const source = await eda.sys_FileManager.getDocumentSource()
			if (source == null)
				throw new Error('读取失败：官方返回空（请确认有文档处于激活状态）')
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
			const uuid = await eda.dmt_Schematic.createSchematic(
				params.boardName ? String(params.boardName) : undefined,
			)
			if (!uuid)
				throw new Error(`原理图创建失败（官方返回空${params.boardName ? '；boardName 必须是已存在的板子名，不存在时会静默失败，可留空自动创建' : ''}）`)
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
			const deleted = await eda.dmt_Schematic.deleteSchematicPage(String(params.pageUuid))
			return { deleted: Boolean(deleted) }
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
			const sourcePageUuid = String(params.pageUuid)
			const targetSchematic = params.schematicUuid ? String(params.schematicUuid) : undefined
			// 透传官方（签名 copySchematicPage(schematicPageUuid, schematicUuid?)，0.10.37 已逐字核对）
			const uuid = await eda.dmt_Schematic.copySchematicPage(sourcePageUuid, targetSchematic)
			if (!uuid)
				throw new Error('图页复制失败（官方返回空）')
			// 官方示例要求等同步再读回（1500ms），读回新页名称与归属一并返回，便于调用方核对"复制的是不是想要的页"
			await new Promise(resolve => setTimeout(resolve, 1500))
			const info: any = await eda.dmt_Schematic.getSchematicPageInfo(uuid)
			return {
				pageUuid: uuid,
				name: info?.name ?? null,
				parentSchematicUuid: info?.parentSchematicUuid ?? info?.schematicUuid ?? null,
				sourcePageUuid,
				...(targetSchematic && info?.parentSchematicUuid && info.parentSchematicUuid !== targetSchematic
					? { warning: `新页归属 ${info.parentSchematicUuid} 与目标原理图 ${targetSchematic} 不一致（官方行为异常），请复核` }
					: {}),
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
			const uuid = await eda.dmt_Pcb.createPcb(
				params.boardName ? String(params.boardName) : undefined,
			)
			if (!uuid)
				throw new Error(`PCB 创建失败（官方返回空${params.boardName ? '；boardName 必须是已存在的板子名，不存在时会静默失败，可留空自动创建' : ''}）`)
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
			const sourcePcbUuid = String(params.pcbUuid)
			const boardName = params.boardName ? String(params.boardName) : undefined
			const unknownResult = (operationError: unknown) => new Error(
				`PCB 复制结果未知（源 PCB ${sourcePcbUuid}，请求 boardName=${boardName ?? '未提供'}）。官方调用可能已创建副本，也可能尚未创建；请先用 project.getInfo / project.listPcbs 核对是否生成副本，再决定后续操作；不要自动重试。原始错误：${operationError instanceof Error ? operationError.message : String(operationError)}`,
				{
					cause: {
						partial: true,
						retryable: false,
						phase: 'project.copyPcb',
						operationError: operationError instanceof Error ? operationError.message : String(operationError),
						result: { sourcePcbUuid, requestedBoardName: boardName ?? null, pcbUuid: 'unknown' },
					},
				},
			)
			let uuid: string | undefined
			try {
				uuid = await eda.dmt_Pcb.copyPcb(sourcePcbUuid, boardName)
			}
			catch (err) {
				throw unknownResult(err)
			}
			if (!uuid)
				throw unknownResult('SDK 返回空值')
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
			const deleted = await eda.dmt_Pcb.deletePcb(String(params.pcbUuid))
			return { deleted: Boolean(deleted) }
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
		summary: '删除板子（Board）。返回 deleted:false 时会附带诊断信息（0.10.63）：常见原因是板子下有未关闭的文档页签/存在关联文档引用，可先手动关闭页签重试，仍失败请用户在 EDA 界面删除',
		params: [
			{ name: 'boardName', type: 'string', required: true, description: '板子名' },
		],
		returns: '{ deleted, diagnostics? }——deleted:false 时 diagnostics 列出当前板子清单、目标板关联文档与可能原因',
		example: { cmd: 'project.deleteBoard', params: { boardName: 'Board1' } },
		handler: async (params) => {
			if (!params.boardName)
				throw new Error('缺少参数 boardName')
			const boardName = String(params.boardName)
			const deleted = await eda.dmt_Board.deleteBoard(boardName)
			if (deleted)
				return { deleted: true }
			// 0.10.63：删不掉（实测空板也返回 false，如 某多页工程 Schematic8）——给诊断而不是干巴巴一个 false
			let diagnostics: Record<string, any> | undefined
			try {
				const info: any = await eda.dmt_Project.getCurrentProjectInfo()
				const boards: Array<any> = []
				const walkDocs = (node: any) => {
					if (!node || typeof node !== 'object')
						return
					if (node.itemType === 'Board')
						boards.push({ name: node.name, uuid: node.uuid, schematic: node.schematic ? { uuid: node.schematic.uuid, pages: (node.schematic.page ?? []).length } : null, pcb: node.pcb?.uuid ?? null })
					for (const v of Object.values(node)) {
						if (v && typeof v === 'object') {
							if (Array.isArray(v)) {
								for (const it of v)
									walkDocs(it)
							}
							else
								walkDocs(v)
						}
					}
				}
				walkDocs(info?.data ?? info)
				const target = boards.find(b => String(b.name) === boardName)
				diagnostics = {
					boardExists: Boolean(target),
					boards: boards.map(b => b.name),
					target: target ?? '未在工程文档树中找到该板',
					likelyCauses: target
						? ['板子下有未关闭的文档页签（先 editor.listTabs 确认并手动关闭对应页签后重试）',
							'板子存在关联文档引用（schematic/pcb 非空，先删关联文档）',
							'官方 deleteBoard 对部分板子（实测含空板）恒返回 false——请用户在 EDA 界面左侧工程面板手动删除']
						: ['板名不存在（注意大小写/空格；可先 project.getInfo 核对板名清单）'],
				}
			}
			catch (e) {
				diagnostics = { note: `诊断信息采集失败：${(e as Error)?.message ?? e}` }
			}
			return { deleted: false, diagnostics }
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
