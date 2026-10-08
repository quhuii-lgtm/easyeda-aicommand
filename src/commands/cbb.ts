/**
 * 复用模块（CBB）指令
 *
 * 官方复用模块体系（ADD since EDA v4.x）：
 * - 一个 CBB 本质上是一个"模块工程"：内含原理图图页 + PCB + 模块符号，存放在系统库/个人库/团队库
 * - 消费侧三件套：
 *   sch_PrimitiveComponent.createCbbSymbol      放模块符号（层次化设计）
 *   sch_PrimitiveComponent.placeCbbSchematicPage 把模块原理图图页内容铺进当前图页
 *   pcb_PrimitiveComponent.placeCbbPcb           把模块 PCB（含布局布线）铺进当前 PCB
 * - 管理侧：lib_Cbb.create/copy/search/get/modify/delete/openProjectInEditor
 *
 * 典型复用流程：
 * 1. cbb.listLibraries 拿库 UUID → cbb.search 找模块（系统库自带大量官方模块）
 * 2. cbb.openProject 打开模块工程 → editor.listTabs / project.getInfo 拿到图页与 PCB 的 uuid
 * 3. 回到目标工程：cbb.placeSchematicPage + cbb.placePcb 一次性复用原理图与 PCB 布局
 */
import type { ICommandDef } from '../engine/types'
import { fileToResult } from './util'

function unconfirmedCbbWriteError(action: string): Error {
	return new Error(
		`${action}结果未确认：官方接口返回空，操作可能已完成也可能未完成。请先检查目标库；勿直接使用同名模块或重复执行`,
		{ cause: { partial: true, retryable: false } },
	)
}

export const cbbCommands: Array<ICommandDef> = [
	{
		name: 'cbb.listLibraries',
		summary: '获取系统库/个人库/工程库/收藏库 UUID（cbb.* 其他指令的 libraryUuid 来源）',
		params: [],
		returns: '{ system, personal, project, favorite }',
		example: { cmd: 'cbb.listLibraries' },
		handler: async () => {
			const list: any = eda.lib_LibrariesList
			const safe = async (fn: () => Promise<string | undefined>) => {
				try {
					return await fn()
				}
				catch {
					return null
				}
			}
			return {
				system: await safe(() => list.getSystemLibraryUuid()),
				personal: await safe(() => list.getPersonalLibraryUuid()),
				project: await safe(() => list.getProjectLibraryUuid()),
				favorite: await safe(() => list.getFavoriteLibraryUuid()),
			}
		},
	},
	{
		name: 'cbb.search',
		summary: '搜索复用模块（空关键字列出全部；系统库自带官方模块，个人库是自己沉淀的模块）',
		params: [
			{ name: 'key', type: 'string', required: false, description: '搜索关键字，空串列出全部' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认系统库' },
			{ name: 'itemsOfPage', type: 'number', required: false, description: '每页数量，默认 20' },
			{ name: 'page', type: 'number', required: false, description: '页码，默认 1' },
		],
		returns: '模块列表 [{ uuid, name, description, ... }]',
		example: { cmd: 'cbb.search', params: { key: 'stm32', itemsOfPage: 10 } },
		handler: async (params) => {
			const results = await eda.lib_Cbb.search(
				String(params.key ?? ''),
				params.libraryUuid ? String(params.libraryUuid) : undefined,
				undefined,
				Number(params.itemsOfPage ?? 20),
				Number(params.page ?? 1),
			)
			return (results ?? []).map((item: any) => ({
				uuid: item?.uuid,
				libraryUuid: item?.libraryUuid,
				name: item?.name,
				description: item?.description,
				classification: item?.classification,
				updateTime: item?.updateTime,
			}))
		},
	},
	{
		name: 'cbb.get',
		summary: '获取复用模块详细属性',
		params: [
			{ name: 'cbbUuid', type: 'string', required: true, description: '复用模块 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认系统库' },
		],
		returns: '模块属性对象',
		example: { cmd: 'cbb.get', params: { cbbUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.cbbUuid)
				throw new Error('缺少参数 cbbUuid')
			const item = await eda.lib_Cbb.get(String(params.cbbUuid), params.libraryUuid ? String(params.libraryUuid) : undefined)
			if (!item)
				throw new Error('模块不存在或无权访问')
			return item
		},
	},
	{
		name: 'cbb.create',
		summary: '在指定库创建空白复用模块工程（创建后可 cbb.openProject 打开并往里画内容）',
		params: [
			{ name: 'libraryUuid', type: 'string', required: true, description: '库 UUID（一般用个人库，见 cbb.listLibraries）' },
			{ name: 'name', type: 'string', required: true, description: '模块名称' },
			{ name: 'description', type: 'string', required: false, description: '描述' },
		],
		returns: '{ cbbUuid, verify? }——仅官方直接返回 UUID 时确认创建成功；空返回标记为结果未确认',
		example: { cmd: 'cbb.create', params: { libraryUuid: 'xxx', name: 'STM32F103最小系统' } },
		handler: async (params) => {
			if (!params.libraryUuid || !params.name)
				throw new Error('缺少参数 libraryUuid / name')
			const libraryUuid = String(params.libraryUuid)
			const name = String(params.name)
			const cbbUuid = await eda.lib_Cbb.create(
				libraryUuid,
				name,
				[],
				params.description ? String(params.description) : undefined,
			)
			if (cbbUuid)
				return { cbbUuid, verify: 'official' }
			// 官方接口返回空时不能把同名库对象判定为本次创建成功。
			throw unconfirmedCbbWriteError('创建')
		},
	},
	{
		name: 'cbb.copy',
		summary: '把复用模块复制到另一个库（例如把系统库官方模块复制到个人库再改造）',
		params: [
			{ name: 'cbbUuid', type: 'string', required: true, description: '源模块 UUID' },
			{ name: 'libraryUuid', type: 'string', required: true, description: '源库 UUID' },
			{ name: 'targetLibraryUuid', type: 'string', required: true, description: '目标库 UUID' },
			{ name: 'newName', type: 'string', required: false, description: '新名称（目标库重名会失败）' },
		],
		returns: '{ cbbUuid, verify? }——仅官方直接返回 UUID 时确认复制成功；空返回标记为结果未确认',
		example: { cmd: 'cbb.copy', params: { cbbUuid: 'xxx', libraryUuid: 'sys', targetLibraryUuid: 'personal', newName: '我的模块' } },
		handler: async (params) => {
			if (!params.cbbUuid || !params.libraryUuid || !params.targetLibraryUuid)
				throw new Error('缺少参数 cbbUuid / libraryUuid / targetLibraryUuid')
			const newUuid = await eda.lib_Cbb.copy(
				String(params.cbbUuid),
				String(params.libraryUuid),
				String(params.targetLibraryUuid),
				[],
				params.newName ? String(params.newName) : undefined,
			)
			if (newUuid)
				return { cbbUuid: newUuid, verify: 'official' }
			// 官方接口返回空时不能把同名库对象判定为本次复制成功。
			throw unconfirmedCbbWriteError('复制')
		},
	},
	{
		name: 'cbb.delete',
		summary: '删除复用模块',
		params: [
			{ name: 'cbbUuid', type: 'string', required: true, description: '模块 UUID' },
			{ name: 'libraryUuid', type: 'string', required: true, description: '库 UUID' },
		],
		returns: '{ deleted }',
		example: { cmd: 'cbb.delete', params: { cbbUuid: 'xxx', libraryUuid: 'yyy' } },
		handler: async (params) => {
			if (!params.cbbUuid || !params.libraryUuid)
				throw new Error('缺少参数 cbbUuid / libraryUuid')
			const deleted = await eda.lib_Cbb.delete(String(params.cbbUuid), String(params.libraryUuid))
			return { deleted }
		},
	},
	{
		name: 'cbb.openProject',
		summary: '在编辑器打开复用模块工程（⚠️ 会切换当前工程，未保存的修改将丢失；打开后用 editor.listTabs 拿图页/PCB uuid）',
		params: [
			{ name: 'cbbUuid', type: 'string', required: true, description: '模块 UUID' },
			{ name: 'libraryUuid', type: 'string', required: true, description: '库 UUID' },
		],
		returns: '{ opened }',
		example: { cmd: 'cbb.openProject', params: { cbbUuid: 'xxx', libraryUuid: 'yyy' } },
		handler: async (params) => {
			if (!params.cbbUuid || !params.libraryUuid)
				throw new Error('缺少参数 cbbUuid / libraryUuid')
			const opened = await eda.lib_Cbb.openProjectInEditor(String(params.cbbUuid), String(params.libraryUuid))
			return { opened }
		},
	},
	{
		name: 'cbb.placeSymbol',
		summary: '在当前原理图放置模块符号（层次化设计入口；SCH 坐标单位 10mil）',
		params: [
			{ name: 'libraryUuid', type: 'string', required: true, description: '库 UUID' },
			{ name: 'cbbUuid', type: 'string', required: true, description: '模块 UUID' },
			{ name: 'x', type: 'number', required: true, description: '坐标 X（10mil 单位，需为 5 的倍数）' },
			{ name: 'y', type: 'number', required: true, description: '坐标 Y（10mil 单位，需为 5 的倍数）' },
			{ name: 'rotation', type: 'number', required: false, description: '旋转角度，默认 0' },
			{ name: 'mirror', type: 'boolean', required: false, description: '是否镜像，默认 false' },
		],
		returns: '{ primitiveId, designator }',
		example: { cmd: 'cbb.placeSymbol', params: { libraryUuid: 'x', cbbUuid: 'y', x: 2000, y: 2000 } },
		handler: async (params) => {
			if (!params.libraryUuid || !params.cbbUuid || params.x === undefined || params.y === undefined)
				throw new Error('缺少参数 libraryUuid / cbbUuid / x / y')
			const symbol = await eda.sch_PrimitiveComponent.createCbbSymbol(
				{ libraryUuid: String(params.libraryUuid), cbbUuid: String(params.cbbUuid) },
				Number(params.x),
				Number(params.y),
				Number(params.rotation ?? 0),
				Boolean(params.mirror ?? false),
			)
			if (!symbol)
				throw new Error('放置失败')
			return {
				primitiveId: symbol.getState_PrimitiveId(),
				designator: symbol.getState_Designator(),
			}
		},
	},
	{
		name: 'cbb.placeSchematicPage',
		summary: '把复用模块的原理图图页内容铺进当前图页（uuid 是模块工程内图页的 UUID，先 cbb.openProject + editor.listTabs 获取）',
		params: [
			{ name: 'libraryUuid', type: 'string', required: true, description: 'CBB 工程所在库的 UUID' },
			{ name: 'cbbUuid', type: 'string', required: true, description: 'CBB 工程 UUID' },
			{ name: 'uuid', type: 'string', required: true, description: 'CBB 工程内原理图图页的 UUID' },
			{ name: 'x', type: 'number', required: true, description: '放置坐标 X' },
			{ name: 'y', type: 'number', required: true, description: '放置坐标 Y' },
			{ name: 'reimportWhenNameRepeated', type: 'boolean', required: false, description: '重名模块时是否重新引入，默认 true' },
		],
		returns: '{ placed }',
		example: { cmd: 'cbb.placeSchematicPage', params: { libraryUuid: 'a', cbbUuid: 'b', uuid: 'c', x: 2000, y: 2000 } },
		handler: async (params) => {
			if (!params.libraryUuid || !params.cbbUuid || !params.uuid || params.x === undefined || params.y === undefined)
				throw new Error('缺少参数 libraryUuid / cbbUuid / uuid / x / y')
			const placed = await eda.sch_PrimitiveComponent.placeCbbSchematicPage(
				{ libraryUuid: String(params.libraryUuid), cbbUuid: String(params.cbbUuid), uuid: String(params.uuid) },
				Number(params.x),
				Number(params.y),
				{ reimportWhenNameRepeated: params.reimportWhenNameRepeated !== false },
			)
			return { placed }
		},
	},
	{
		name: 'cbb.placePcb',
		summary: '把复用模块的 PCB（含布局布线）铺进当前 PCB——复用价值最大的一条：电源/最小系统等成熟布局直接整体搬入',
		params: [
			{ name: 'libraryUuid', type: 'string', required: true, description: 'CBB 工程所在库的 UUID' },
			{ name: 'cbbUuid', type: 'string', required: true, description: 'CBB 工程 UUID' },
			{ name: 'uuid', type: 'string', required: true, description: 'CBB 工程内 PCB 的 UUID' },
			{ name: 'x', type: 'number', required: true, description: '放置坐标 X（PCB 单位 mil）' },
			{ name: 'y', type: 'number', required: true, description: '放置坐标 Y（PCB 单位 mil）' },
			{ name: 'reimportWhenNameRepeated', type: 'boolean', required: false, description: '重名模块时是否重新引入，默认 true' },
		],
		returns: '{ placed }',
		example: { cmd: 'cbb.placePcb', params: { libraryUuid: 'a', cbbUuid: 'b', uuid: 'c', x: 500, y: -500 } },
		handler: async (params) => {
			if (!params.libraryUuid || !params.cbbUuid || !params.uuid || params.x === undefined || params.y === undefined)
				throw new Error('缺少参数 libraryUuid / cbbUuid / uuid / x / y')
			const placed = await eda.pcb_PrimitiveComponent.placeCbbPcb(
				{ libraryUuid: String(params.libraryUuid), cbbUuid: String(params.cbbUuid), uuid: String(params.uuid) },
				Number(params.x),
				Number(params.y),
				{ reimportWhenNameRepeated: params.reimportWhenNameRepeated !== false },
			)
			return { placed }
		},
	},
	{
		name: 'cbb.openSymbolInEditor',
		summary: '在编辑器打开复用模块的模块符号（⚠️ 前置条件：先 cbb.openProject 打开模块工程；返回标签页 ID）',
		params: [
			{ name: 'cbbUuid', type: 'string', required: true, description: '模块 UUID' },
			{ name: 'libraryUuid', type: 'string', required: true, description: '库 UUID' },
			{ name: 'splitScreenId', type: 'string', required: false, description: '分屏 ID，不填则在最后输入焦点的分屏内打开' },
		],
		returns: '{ tabId }',
		example: { cmd: 'cbb.openSymbolInEditor', params: { cbbUuid: 'xxx', libraryUuid: 'yyy' } },
		handler: async (params) => {
			if (!params.cbbUuid || !params.libraryUuid)
				throw new Error('缺少参数 cbbUuid / libraryUuid')
			const tabId = await eda.lib_Cbb.openSymbolInEditor(
				String(params.cbbUuid),
				String(params.libraryUuid),
				params.splitScreenId ? String(params.splitScreenId) : undefined,
			)
			if (!tabId)
				throw new Error('打开模块符号失败（官方返回空；需先 cbb.openProject 打开模块工程）')
			return { tabId }
		},
	},
	{
		name: 'cbb.exportFile',
		summary: '导出复用模块为 epro 文件（base64 返回；需要团队模块下载权限，无权限会报错）',
		params: [
			{ name: 'cbbUuid', type: 'string', required: true, description: '模块 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认系统库' },
			{ name: 'fileName', type: 'string', required: false, description: '导出文件名' },
		],
		returns: '{ fileName, size, mimeType, base64 }',
		example: { cmd: 'cbb.exportFile', params: { cbbUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.cbbUuid)
				throw new Error('缺少参数 cbbUuid')
			const file = await eda.sys_FileManager.getCbbFileByCbbUuid(
				String(params.cbbUuid),
				params.libraryUuid ? String(params.libraryUuid) : undefined,
				{ fileName: params.fileName ? String(params.fileName) : undefined },
			)
			if (!file)
				throw new Error('导出失败')
			return fileToResult(file, 'cbb-export.epro')
		},
	},
]
