/**
 * 库器件（LIB）指令 —— 薄封装官方 eda.lib_* API
 *
 * 官方库器件体系（薄封装原则：官方有源代码就直接封装，不自造逻辑）：
 * - 三件套关系：符号（Symbol，原理图图形）+ 封装（Footprint，PCB 焊盘图形）+ 3D 模型
 *   通过 lib_Device.create 的 association 组装成完整器件（Device）
 * - documentSource 是库文档源码字符串（符号/封装的图形容器源码），
 *   官方流程：openInEditor 打开文档 → sys_FileManager.getDocumentSource() 读源码
 *   → 改写后 lib_*.updateDocumentSource 写回库
 * - 库 UUID 来源：eda.lib_LibrariesList.getSystemLibraryUuid() / getPersonalLibraryUuid()
 *   / getProjectLibraryUuid() / getFavoriteLibraryUuid()
 *
 * 本文件公共约束：
 * - libraryUuid 缺省时自动取个人库，拿不到才报错
 * - create 类拿到 uuid 后用对应 get 读回确认，返回读回结果
 * - 官方返回 undefined / false 时如实报错，不假装成功
 */
import type { ICommandDef } from '../engine/types'

/** libraryUuid 缺省取个人库 */
async function resolveLibraryUuid(params: Record<string, any>): Promise<string> {
	if (params.libraryUuid)
		return String(params.libraryUuid)
	const uuid = await eda.lib_LibrariesList.getPersonalLibraryUuid()
	if (!uuid)
		throw new Error('未传 libraryUuid，且获取个人库 UUID 失败（官方返回空）')
	return uuid
}

/**
 * modify 后回查（0.10.62，消 pitfalls H1/H2）：官方 modify 后 uuid 可能变化，
 * 且 get 对已变化/不存在 uuid 会 reject 对象而非返回空（0.10.38 实测）。
 * 优先按旧 uuid get；失败且调用方带了新名则按名 search 精确定位新 uuid；
 * 都不行走 warning 提示人工按名确认——不抛错，因为 modify 本身官方已返回 true。
 */
async function verifyLibModify(
	kind: 'symbol' | 'footprint' | 'device',
	uuid: string,
	libraryUuid: string,
	newName?: string,
): Promise<{ modified: true, uuid: string, uuidChanged: boolean, verify: 'get' | 'search' | 'none', warning?: string }> {
	const api: any = kind === 'symbol' ? eda.lib_Symbol : kind === 'footprint' ? eda.lib_Footprint : eda.lib_Device
	try {
		const item = await api.get(uuid, libraryUuid)
		if (item)
			return { modified: true, uuid, uuidChanged: false, verify: 'get' }
	}
	catch {
		// get 对不存在/已变 uuid 会 reject——落按名回搜
	}
	if (newName) {
		try {
			// 0.10.65 修复：search 签名按 kind 分支——symbol/device 是 6 参（第 4 位 symbolType），
			// footprint 是 5 参。此前统一按 5 参调用，symbol/device 的 itemsOfPage=20/page=1 错位到
			// symbolType/itemsOfPage，过滤条件错导致回搜漏命中、误判 verify:'none' 返回失效旧 uuid。
			const results = kind === 'footprint'
				? await api.search(String(newName), libraryUuid, undefined, 20, 1)
				: await api.search(String(newName), libraryUuid, undefined, undefined, 20, 1)
			const list: Array<any> = Array.isArray(results) ? results : ((results as any)?.data ?? [])
			const hit = list.find(it => it && String(it.name ?? '') === String(newName))
			const newUuid = hit ? String(hit.uuid ?? '') : ''
			if (newUuid)
				return { modified: true, uuid: newUuid, uuidChanged: newUuid !== uuid, verify: 'search' }
			return { modified: true, uuid, uuidChanged: false, verify: 'none',
				warning: `modify 官方返回成功，但按旧 uuid 回查失败、按名「${newName}」也未精确搜到——请人工在库中确认实际结果（官方 modify 后 uuid 可能变化，0.10.38 实测）` }
		}
		catch {
			// search 失败走统一 warning
		}
	}
	return { modified: true, uuid, uuidChanged: false, verify: 'none',
		warning: `modify 官方返回成功，但按旧 uuid 回查失败（官方 modify 后 uuid 可能变化，0.10.38 实测）${newName ? `；按名「${newName}」回搜未执行成功，请按名字搜索确认` : '；未传新名无法按名回搜，请按名字搜索确认'}` }
}

export const libCommands: Array<ICommandDef> = [
	// ==================== 符号 Symbol ====================
	{
		name: 'lib.symbolCreate',
		summary: '在库中创建空白符号（返回创建后用 lib.symbolGet 读回的符号属性）',
		params: [
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'name', type: 'string', required: true, description: '符号名称' },
			{ name: 'classification', type: 'array', required: false, description: '分类（默认 [] 不分类）' },
			{ name: 'symbolType', type: 'number', required: false, description: '符号类型 ELIB_SymbolType（如 2）' },
			{ name: 'description', type: 'string', required: false, description: '描述' },
			{ name: 'otherProperty', type: 'object', required: false, description: '其它属性' },
		],
		returns: '读回的符号属性对象（含 uuid）',
		example: { cmd: 'lib.symbolCreate', params: { name: 'MY_RES', symbolType: 2 } },
		handler: async (params) => {
			if (!params.name)
				throw new Error('缺少参数 name')
			const libraryUuid = await resolveLibraryUuid(params)
			const symbolUuid = await eda.lib_Symbol.create(
				libraryUuid,
				String(params.name),
				(params.classification as any) ?? [],
				params.symbolType !== undefined ? Number(params.symbolType) as any : undefined,
				params.description ? String(params.description) : undefined,
				params.otherProperty as any,
			)
			if (!symbolUuid)
				throw new Error('创建符号失败：官方返回空（可能重名或无权限）')
			const item = await eda.lib_Symbol.get(symbolUuid, libraryUuid)
			if (!item)
				throw new Error(`符号已创建（uuid=${symbolUuid}）但读回失败：官方返回空`)
			return item
		},
	},
	{
		name: 'lib.symbolUpdateSource',
		summary: '把符号文档源码写回库（documentSource 来源见文件头注释的官方流程）',
		params: [
			{ name: 'symbolUuid', type: 'string', required: true, description: '符号 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'documentSource', type: 'string', required: true, description: '文档源码字符串' },
		],
		returns: '{ updated }',
		example: { cmd: 'lib.symbolUpdateSource', params: { symbolUuid: 'xxx', documentSource: '...' } },
		handler: async (params) => {
			if (!params.symbolUuid || !params.documentSource)
				throw new Error('缺少参数 symbolUuid / documentSource')
			const libraryUuid = await resolveLibraryUuid(params)
			const updated = await eda.lib_Symbol.updateDocumentSource(String(params.symbolUuid), libraryUuid, String(params.documentSource))
			if (updated !== true)
				throw new Error(`更新符号文档源码失败：官方返回 ${String(updated)}`)
			return { updated }
		},
	},
	{
		name: 'lib.symbolSearch',
		summary: '搜索符号（空关键字列出全部；官方默认搜系统库，本指令默认个人库）',
		params: [
			{ name: 'key', type: 'string', required: false, description: '搜索关键字，空串列出全部' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'classification', type: 'array', required: false, description: '分类，默认全部' },
			{ name: 'symbolType', type: 'number', required: false, description: '符号类型，默认全部' },
			{ name: 'itemsOfPage', type: 'number', required: false, description: '每页数量，默认 20' },
			{ name: 'page', type: 'number', required: false, description: '页码，默认 1' },
		],
		returns: '符号列表 [{ uuid, name, description, ... }]',
		example: { cmd: 'lib.symbolSearch', params: { key: 'resistor' } },
		handler: async (params) => {
			const libraryUuid = await resolveLibraryUuid(params)
			return await eda.lib_Symbol.search(
				String(params.key ?? ''),
				libraryUuid,
				params.classification as any,
				params.symbolType !== undefined ? Number(params.symbolType) as any : undefined,
				Number(params.itemsOfPage ?? 20),
				Number(params.page ?? 1),
			)
		},
	},
	{
		name: 'lib.symbolGet',
		summary: '获取符号的所有属性',
		params: [
			{ name: 'symbolUuid', type: 'string', required: true, description: '符号 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
		],
		returns: '符号属性对象',
		example: { cmd: 'lib.symbolGet', params: { symbolUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.symbolUuid)
				throw new Error('缺少参数 symbolUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const item = await eda.lib_Symbol.get(String(params.symbolUuid), libraryUuid)
			if (!item)
				throw new Error('符号不存在或无权访问（官方返回空）')
			return item
		},
	},
	{
		name: 'lib.symbolCopy',
		summary: '把符号复制到另一个库（目标库重名会失败）',
		params: [
			{ name: 'symbolUuid', type: 'string', required: true, description: '源符号 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '源库 UUID，默认个人库' },
			{ name: 'targetLibraryUuid', type: 'string', required: true, description: '目标库 UUID' },
			{ name: 'targetClassification', type: 'array', required: false, description: '目标库分类（默认 [] 不分类）' },
			{ name: 'newName', type: 'string', required: false, description: '新符号名称' },
		],
		returns: '{ symbolUuid }（新符号 UUID）',
		example: { cmd: 'lib.symbolCopy', params: { symbolUuid: 'xxx', targetLibraryUuid: 'yyy', newName: '我的符号' } },
		handler: async (params) => {
			if (!params.symbolUuid || !params.targetLibraryUuid)
				throw new Error('缺少参数 symbolUuid / targetLibraryUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const newUuid = await eda.lib_Symbol.copy(
				String(params.symbolUuid),
				libraryUuid,
				String(params.targetLibraryUuid),
				(params.targetClassification as any) ?? [],
				params.newName ? String(params.newName) : undefined,
			)
			if (!newUuid)
				throw new Error('复制符号失败：官方返回空（可能目标库重名）')
			return { symbolUuid: newUuid }
		},
	},
	{
		name: 'lib.symbolModify',
		summary: '修改符号属性（名称/分类/描述/其它属性；属性值设为 null 表示清除）',
		params: [
			{ name: 'symbolUuid', type: 'string', required: true, description: '符号 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'name', type: 'string', required: false, description: '新符号名称' },
			{ name: 'classification', type: 'array', required: false, description: '分类' },
			{ name: 'description', type: 'string', required: false, description: '描述（null 清除）' },
			{ name: 'otherProperty', type: 'object', required: false, description: '其它属性（值为 null 清除该项）' },
		],
		returns: '{ modified, uuid, uuidChanged, verify(get|search|none), warning? }——modify 后自动回查：官方 modify 后 uuid 可能变化（0.10.38 实测），返回的 uuid 是回查确认后的当前 uuid',
		example: { cmd: 'lib.symbolModify', params: { symbolUuid: 'xxx', description: '新描述' } },
		handler: async (params) => {
			if (!params.symbolUuid)
				throw new Error('缺少参数 symbolUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const modified = await eda.lib_Symbol.modify(
				String(params.symbolUuid),
				libraryUuid,
				params.name ? String(params.name) : undefined,
				params.classification as any,
				params.description !== undefined ? (params.description === null ? null : String(params.description)) : undefined,
				params.otherProperty as any,
			)
			if (modified !== true)
				throw new Error(`修改符号失败：官方返回 ${String(modified)}`)
			return await verifyLibModify('symbol', String(params.symbolUuid), libraryUuid, params.name ? String(params.name) : undefined)
		},
	},
	{
		name: 'lib.symbolDelete',
		summary: '删除符号',
		params: [
			{ name: 'symbolUuid', type: 'string', required: true, description: '符号 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
		],
		returns: '{ deleted }',
		example: { cmd: 'lib.symbolDelete', params: { symbolUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.symbolUuid)
				throw new Error('缺少参数 symbolUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const deleted = await eda.lib_Symbol.delete(String(params.symbolUuid), libraryUuid)
			if (deleted !== true)
				throw new Error(`删除符号失败：官方返回 ${String(deleted)}`)
			return { deleted }
		},
	},
	{
		name: 'lib.symbolOpenInEditor',
		summary: '在符号编辑器中打开库符号（编辑符号内容用；打开后配合 project.getDocumentSource 读源码、或编辑器内指令操作）',
		params: [
			{ name: 'symbolUuid', type: 'string', required: true, description: '符号 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
		],
		returns: '{ tabId }',
		example: { cmd: 'lib.symbolOpenInEditor', params: { symbolUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.symbolUuid)
				throw new Error('缺少参数 symbolUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const tabId = await eda.lib_Symbol.openInEditor(String(params.symbolUuid), libraryUuid)
			if (tabId == null)
				throw new Error('打开符号编辑器失败：官方返回空')
			return { tabId }
		},
	},
	{
		name: 'lib.footprintOpenInEditor',
		summary: '在封装编辑器中打开库封装（编辑封装内容用）',
		params: [
			{ name: 'footprintUuid', type: 'string', required: true, description: '封装 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
		],
		returns: '{ tabId }',
		example: { cmd: 'lib.footprintOpenInEditor', params: { footprintUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.footprintUuid)
				throw new Error('缺少参数 footprintUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const tabId = await eda.lib_Footprint.openInEditor(String(params.footprintUuid), libraryUuid)
			if (tabId == null)
				throw new Error('打开封装编辑器失败：官方返回空')
			return { tabId }
		},
	},

	// ==================== 封装 Footprint ====================
	{
		name: 'lib.footprintCreate',
		summary: '在库中创建空白封装（返回创建后用 lib.footprintGet 读回的封装属性）',
		params: [
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'name', type: 'string', required: true, description: '封装名称' },
			{ name: 'classification', type: 'array', required: false, description: '分类（默认 [] 不分类）' },
			{ name: 'description', type: 'string', required: false, description: '描述' },
			{ name: 'otherProperty', type: 'object', required: false, description: '其它属性' },
		],
		returns: '读回的封装属性对象（含 uuid）',
		example: { cmd: 'lib.footprintCreate', params: { name: 'MY_0603' } },
		handler: async (params) => {
			if (!params.name)
				throw new Error('缺少参数 name')
			const libraryUuid = await resolveLibraryUuid(params)
			const footprintUuid = await eda.lib_Footprint.create(
				libraryUuid,
				String(params.name),
				(params.classification as any) ?? [],
				params.description ? String(params.description) : undefined,
				params.otherProperty as any,
			)
			if (!footprintUuid)
				throw new Error('创建封装失败：官方返回空（可能重名或无权限）')
			const item = await eda.lib_Footprint.get(footprintUuid, libraryUuid)
			if (!item)
				throw new Error(`封装已创建（uuid=${footprintUuid}）但读回失败：官方返回空`)
			return item
		},
	},
	{
		name: 'lib.footprintUpdateSource',
		summary: '把封装文档源码写回库（documentSource 来源见文件头注释的官方流程）',
		params: [
			{ name: 'footprintUuid', type: 'string', required: true, description: '封装 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'documentSource', type: 'string', required: true, description: '文档源码字符串' },
		],
		returns: '{ updated }',
		example: { cmd: 'lib.footprintUpdateSource', params: { footprintUuid: 'xxx', documentSource: '...' } },
		handler: async (params) => {
			if (!params.footprintUuid || !params.documentSource)
				throw new Error('缺少参数 footprintUuid / documentSource')
			const libraryUuid = await resolveLibraryUuid(params)
			const updated = await eda.lib_Footprint.updateDocumentSource(String(params.footprintUuid), libraryUuid, String(params.documentSource))
			if (updated !== true)
				throw new Error(`更新封装文档源码失败：官方返回 ${String(updated)}`)
			return { updated }
		},
	},
	{
		name: 'lib.footprintSearch',
		summary: '搜索封装（空关键字列出全部；官方默认搜系统库，本指令默认个人库）',
		params: [
			{ name: 'key', type: 'string', required: false, description: '搜索关键字，空串列出全部' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'classification', type: 'array', required: false, description: '分类，默认全部' },
			{ name: 'itemsOfPage', type: 'number', required: false, description: '每页数量，默认 20' },
			{ name: 'page', type: 'number', required: false, description: '页码，默认 1' },
		],
		returns: '封装列表 [{ uuid, name, description, ... }]',
		example: { cmd: 'lib.footprintSearch', params: { key: '0603' } },
		handler: async (params) => {
			const libraryUuid = await resolveLibraryUuid(params)
			return await eda.lib_Footprint.search(
				String(params.key ?? ''),
				libraryUuid,
				params.classification as any,
				Number(params.itemsOfPage ?? 20),
				Number(params.page ?? 1),
			)
		},
	},
	{
		name: 'lib.footprintGet',
		summary: '获取封装的所有属性',
		params: [
			{ name: 'footprintUuid', type: 'string', required: true, description: '封装 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
		],
		returns: '封装属性对象',
		example: { cmd: 'lib.footprintGet', params: { footprintUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.footprintUuid)
				throw new Error('缺少参数 footprintUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const item = await eda.lib_Footprint.get(String(params.footprintUuid), libraryUuid)
			if (!item)
				throw new Error('封装不存在或无权访问（官方返回空）')
			return item
		},
	},
	{
		name: 'lib.footprintCopy',
		summary: '把封装复制到另一个库（目标库重名会失败）',
		params: [
			{ name: 'footprintUuid', type: 'string', required: true, description: '源封装 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '源库 UUID，默认个人库' },
			{ name: 'targetLibraryUuid', type: 'string', required: true, description: '目标库 UUID' },
			{ name: 'targetClassification', type: 'array', required: false, description: '目标库分类（默认 [] 不分类）' },
			{ name: 'newName', type: 'string', required: false, description: '新封装名称' },
		],
		returns: '{ footprintUuid }（新封装 UUID）',
		example: { cmd: 'lib.footprintCopy', params: { footprintUuid: 'xxx', targetLibraryUuid: 'yyy', newName: '我的封装' } },
		handler: async (params) => {
			if (!params.footprintUuid || !params.targetLibraryUuid)
				throw new Error('缺少参数 footprintUuid / targetLibraryUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const newUuid = await eda.lib_Footprint.copy(
				String(params.footprintUuid),
				libraryUuid,
				String(params.targetLibraryUuid),
				(params.targetClassification as any) ?? [],
				params.newName ? String(params.newName) : undefined,
			)
			if (!newUuid)
				throw new Error('复制封装失败：官方返回空（可能目标库重名）')
			return { footprintUuid: newUuid }
		},
	},
	{
		name: 'lib.footprintModify',
		summary: '修改封装属性（名称/分类/描述/其它属性；属性值设为 null 表示清除）',
		params: [
			{ name: 'footprintUuid', type: 'string', required: true, description: '封装 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'name', type: 'string', required: false, description: '新封装名称' },
			{ name: 'classification', type: 'array', required: false, description: '分类' },
			{ name: 'description', type: 'string', required: false, description: '描述（null 清除）' },
			{ name: 'otherProperty', type: 'object', required: false, description: '其它属性（值为 null 清除该项）' },
		],
		returns: '{ modified, uuid, uuidChanged, verify(get|search|none), warning? }——modify 后自动回查（官方 modify 后 uuid 可能变化，0.10.38 实测），返回的 uuid 是回查确认后的当前 uuid',
		example: { cmd: 'lib.footprintModify', params: { footprintUuid: 'xxx', description: '新描述' } },
		handler: async (params) => {
			if (!params.footprintUuid)
				throw new Error('缺少参数 footprintUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const modified = await eda.lib_Footprint.modify(
				String(params.footprintUuid),
				libraryUuid,
				params.name ? String(params.name) : undefined,
				params.classification as any,
				params.description !== undefined ? (params.description === null ? null : String(params.description)) : undefined,
				params.otherProperty as any,
			)
			if (modified !== true)
				throw new Error(`修改封装失败：官方返回 ${String(modified)}`)
			return await verifyLibModify('footprint', String(params.footprintUuid), libraryUuid, params.name ? String(params.name) : undefined)
		},
	},
	{
		name: 'lib.footprintDelete',
		summary: '删除封装',
		params: [
			{ name: 'footprintUuid', type: 'string', required: true, description: '封装 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
		],
		returns: '{ deleted }',
		example: { cmd: 'lib.footprintDelete', params: { footprintUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.footprintUuid)
				throw new Error('缺少参数 footprintUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const deleted = await eda.lib_Footprint.delete(String(params.footprintUuid), libraryUuid)
			if (deleted !== true)
				throw new Error(`删除封装失败：官方返回 ${String(deleted)}`)
			return { deleted }
		},
	},

	// ==================== 器件 Device ====================
	{
		name: 'lib.deviceCreate',
		summary: '组装创建器件：把已有符号+封装+3D 绑定成完整器件（内部组装 association 调官方 create；返回创建后用 lib.deviceGet 读回的器件属性）',
		params: [
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'name', type: 'string', required: true, description: '器件名称' },
			{ name: 'symbolUuid', type: 'string', required: false, description: '要绑定的符号 UUID（不绑定符号也不新建符号将无法创建器件）' },
			{ name: 'footprintUuid', type: 'string', required: false, description: '要绑定的封装 UUID' },
			{ name: 'model3DUuid', type: 'string', required: false, description: '要绑定的 3D 模型 UUID' },
			{ name: 'model3DLibraryUuid', type: 'string', required: false, description: '3D 模型所在库 UUID，默认同器件库' },
			{ name: 'classification', type: 'array', required: false, description: '分类（默认 [] 不分类）' },
			{ name: 'description', type: 'string', required: false, description: '描述' },
			{ name: 'property', type: 'object', required: false, description: '器件属性（designator/addIntoBom/addIntoPcb/manufacturer/supplier 等）' },
		],
		returns: '读回的器件属性对象（含 uuid）',
		example: { cmd: 'lib.deviceCreate', params: { name: 'MY_DEVICE', symbolUuid: 's', footprintUuid: 'f' } },
		handler: async (params) => {
			if (!params.name)
				throw new Error('缺少参数 name')
			if (!params.symbolUuid)
				throw new Error('缺少参数 symbolUuid（官方要求：不新建符号就必须指定符号关联，否则无法创建器件）')
			const libraryUuid = await resolveLibraryUuid(params)
			const association: any = { symbolUuid: String(params.symbolUuid) }
			if (params.footprintUuid)
				association.footprintUuid = String(params.footprintUuid)
			if (params.model3DUuid) {
				association.model3D = {
					uuid: String(params.model3DUuid),
					libraryUuid: params.model3DLibraryUuid ? String(params.model3DLibraryUuid) : libraryUuid,
				}
			}
			const deviceUuid = await eda.lib_Device.create(
				libraryUuid,
				String(params.name),
				(params.classification as any) ?? [],
				association,
				params.description ? String(params.description) : undefined,
				params.property as any,
			)
			if (!deviceUuid)
				throw new Error('创建器件失败：官方返回空（可能重名、无权限或关联的符号/封装无效）')
			const item = await eda.lib_Device.get(deviceUuid, libraryUuid)
			if (!item)
				throw new Error(`器件已创建（uuid=${deviceUuid}）但读回失败：官方返回空`)
			return item
		},
	},
	{
		name: 'lib.deviceSearch',
		summary: '搜索器件（空关键字列出全部；官方默认搜系统库，本指令默认个人库）',
		params: [
			{ name: 'key', type: 'string', required: false, description: '搜索关键字，空串列出全部' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'classification', type: 'array', required: false, description: '分类，默认全部' },
			{ name: 'symbolType', type: 'number', required: false, description: '符号类型，默认全部' },
			{ name: 'itemsOfPage', type: 'number', required: false, description: '每页数量，默认 20' },
			{ name: 'page', type: 'number', required: false, description: '页码，默认 1' },
		],
		returns: '器件列表 [{ uuid, name, supplierId, ... }]',
		example: { cmd: 'lib.deviceSearch', params: { key: '0402' } },
		handler: async (params) => {
			const libraryUuid = await resolveLibraryUuid(params)
			return await eda.lib_Device.search(
				String(params.key ?? ''),
				libraryUuid,
				params.classification as any,
				params.symbolType !== undefined ? Number(params.symbolType) as any : undefined,
				Number(params.itemsOfPage ?? 20),
				Number(params.page ?? 1),
			)
		},
	},
	{
		name: 'lib.deviceGet',
		summary: '获取器件的所有属性',
		params: [
			{ name: 'deviceUuid', type: 'string', required: true, description: '器件 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
		],
		returns: '器件属性对象',
		example: { cmd: 'lib.deviceGet', params: { deviceUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.deviceUuid)
				throw new Error('缺少参数 deviceUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const item = await eda.lib_Device.get(String(params.deviceUuid), libraryUuid)
			if (!item)
				throw new Error('器件不存在或无权访问（官方返回空）')
			return item
		},
	},
	{
		name: 'lib.deviceGetByLcscIds',
		summary: '用立创 C 编号获取器件（支持单个或数组批量；私有化部署环境不可用）',
		params: [
			{ name: 'lcscIds', type: 'string | array', required: true, description: '立创 C 编号，如 "C1523" 或 ["C1523","C17168"]' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'allowMultiMatch', type: 'boolean', required: false, description: '同一库内同 C 编号匹配多个时是否全部返回，默认 false' },
		],
		returns: '器件属性（或数组）',
		example: { cmd: 'lib.deviceGetByLcscIds', params: { lcscIds: ['C1523', 'C17168'] } },
		handler: async (params) => {
			if (!params.lcscIds)
				throw new Error('缺少参数 lcscIds')
			const libraryUuid = await resolveLibraryUuid(params)
			const result = await (eda.lib_Device.getByLcscIds as any)(
				params.lcscIds,
				libraryUuid,
				Boolean(params.allowMultiMatch ?? false),
			)
			if (result === undefined || (Array.isArray(result) && result.length === 0))
				throw new Error('未匹配到器件（官方返回空）')
			return result
		},
	},
	{
		name: 'lib.deviceCopy',
		summary: '把器件复制到另一个库（目标库重名会失败）',
		params: [
			{ name: 'deviceUuid', type: 'string', required: true, description: '源器件 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '源库 UUID，默认个人库' },
			{ name: 'targetLibraryUuid', type: 'string', required: true, description: '目标库 UUID' },
			{ name: 'targetClassification', type: 'array', required: false, description: '目标库分类（默认 [] 不分类）' },
			{ name: 'newName', type: 'string', required: false, description: '新器件名称' },
		],
		returns: '{ deviceUuid }（新器件 UUID）',
		example: { cmd: 'lib.deviceCopy', params: { deviceUuid: 'xxx', targetLibraryUuid: 'yyy', newName: '我的器件' } },
		handler: async (params) => {
			if (!params.deviceUuid || !params.targetLibraryUuid)
				throw new Error('缺少参数 deviceUuid / targetLibraryUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const newUuid = await eda.lib_Device.copy(
				String(params.deviceUuid),
				libraryUuid,
				String(params.targetLibraryUuid),
				(params.targetClassification as any) ?? [],
				params.newName ? String(params.newName) : undefined,
			)
			if (!newUuid)
				throw new Error('复制器件失败：官方返回空（可能目标库重名）')
			return { deviceUuid: newUuid }
		},
	},
	{
		name: 'lib.deviceModify',
		summary: '修改器件（名称/分类/描述/属性/关联；属性值设为 null 表示清除）',
		params: [
			{ name: 'deviceUuid', type: 'string', required: true, description: '器件 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'name', type: 'string', required: false, description: '新器件名称' },
			{ name: 'classification', type: 'array', required: false, description: '分类' },
			{ name: 'description', type: 'string', required: false, description: '描述（null 清除）' },
			{ name: 'symbolUuid', type: 'string', required: false, description: '改绑符号 UUID' },
			{ name: 'footprintUuid', type: 'string', required: false, description: '改绑封装 UUID' },
			{ name: 'property', type: 'object', required: false, description: '器件属性（designator/manufacturer/supplier 等）' },
		],
		returns: '{ modified, uuid, uuidChanged, verify(get|search|none), warning? }——modify 后自动回查（官方 modify 后 uuid 可能变化，0.10.38 实测），返回的 uuid 是回查确认后的当前 uuid',
		example: { cmd: 'lib.deviceModify', params: { deviceUuid: 'xxx', property: { designator: 'R' } } },
		handler: async (params) => {
			if (!params.deviceUuid)
				throw new Error('缺少参数 deviceUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			let association: any
			if (params.symbolUuid !== undefined || params.footprintUuid !== undefined) {
				association = {}
				if (params.symbolUuid !== undefined)
					association.symbolUuid = String(params.symbolUuid)
				if (params.footprintUuid !== undefined)
					association.footprintUuid = String(params.footprintUuid)
			}
			const modified = await eda.lib_Device.modify(
				String(params.deviceUuid),
				libraryUuid,
				params.name ? String(params.name) : undefined,
				params.classification as any,
				association,
				params.description !== undefined ? (params.description === null ? null : String(params.description)) : undefined,
				params.property as any,
			)
			if (modified !== true)
				throw new Error(`修改器件失败：官方返回 ${String(modified)}`)
			return await verifyLibModify('device', String(params.deviceUuid), libraryUuid, params.name ? String(params.name) : undefined)
		},
	},
	{
		name: 'lib.deviceDelete',
		summary: '删除器件',
		params: [
			{ name: 'deviceUuid', type: 'string', required: true, description: '器件 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
		],
		returns: '{ deleted }',
		example: { cmd: 'lib.deviceDelete', params: { deviceUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.deviceUuid)
				throw new Error('缺少参数 deviceUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const deleted = await eda.lib_Device.delete(String(params.deviceUuid), libraryUuid)
			if (deleted !== true)
				throw new Error(`删除器件失败：官方返回 ${String(deleted)}`)
			return { deleted }
		},
	},
]
