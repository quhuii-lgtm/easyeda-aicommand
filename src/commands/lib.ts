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
import { parseSourceLog } from '../pcb/sourcelog'

/** libraryUuid 缺省取个人库 */
async function resolveLibraryUuid(params: Record<string, any>): Promise<string> {
	if (params.libraryUuid)
		return String(params.libraryUuid)
	const uuid = await eda.lib_LibrariesList.getPersonalLibraryUuid()
	if (!uuid)
		throw new Error('未传 libraryUuid，且获取个人库 UUID 失败（官方返回空）')
	return uuid
}

function footprintSourceUuid(source: string, footprintUuid: string): string {
	const firstLine = source.split(/\r?\n/).find(line => line.trim())
	if (!firstLine)
		throw new Error('封装源码不可读取：源码为空')
	let first: unknown
	try { first = JSON.parse(firstLine.includes('||') ? firstLine.slice(0, firstLine.indexOf('||')) : firstLine) }
	catch (error) { throw new Error('封装源码身份不可读取：首行不是有效 JSON', { cause: error }) }
	let uuid: unknown
	if (first && typeof first === 'object' && !Array.isArray(first) && (first as any).type === 'DOCHEAD') {
		const parsed = parseSourceLog(source)
		if (parsed.docType !== 'FOOTPRINT')
			throw new Error(`封装源码类型不匹配：预期 FOOTPRINT，实际 ${parsed.docType}`)
		const heads = parsed.records.filter(record => record.header.type === 'DOCHEAD')
		const identities = heads.map(record => {
			const data = record.data as any
			if (!data || typeof data !== 'object' || Array.isArray(data) || data.docType !== 'FOOTPRINT' || typeof data.uuid !== 'string' || !data.uuid.trim())
				throw new Error('封装源码 DOCHEAD 缺少有效 FOOTPRINT UUID')
			return data.uuid
		})
		if (!identities.length || identities.some(value => value !== identities[0]))
			throw new Error('封装源码 DOCHEAD UUID 身份冲突')
		uuid = identities[0]
	}
	else {
		let rows: unknown[]
		try { rows = source.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) }
		catch (error) { throw new Error('封装源码身份不可读取：EFOO 行格式无效', { cause: error }) }
		const docType = rows.find((row: any) => Array.isArray(row) && row[0] === 'DOCTYPE') as any
		const heads = rows.filter((row: any) => Array.isArray(row) && (row[0] === 'HEAD' || row[0] === 'DOCHEAD')) as any[]
		if (docType?.[1] !== 'FOOTPRINT' || heads.length !== 1 || typeof heads[0]?.[1]?.uuid !== 'string' || !heads[0][1].uuid.trim())
			throw new Error('封装源码缺少唯一且有效的 FOOTPRINT HEAD.uuid')
		uuid = heads[0][1].uuid
	}
	if (uuid !== footprintUuid)
		throw new Error(`封装源码 UUID 与请求不一致（请求 ${footprintUuid}，源码 ${String(uuid)}）`)
	return uuid
}

async function getFootprintSource(footprintUuid: string, params: Record<string, any>) {
	const explicit = params.libraryUuid !== undefined && params.libraryUuid !== null
	if (explicit && typeof params.libraryUuid !== 'string')
		throw new Error('libraryUuid 显式传入时必须是字符串')
	const requestedLibraryUuid = explicit ? String(params.libraryUuid).trim() : ''
	if (explicit && !requestedLibraryUuid)
		throw new Error('libraryUuid 显式传入时必须是非空字符串')
	const query = {
		strategy: explicit ? 'explicit-library-only' : 'project-then-personal',
		projectLibrary: explicit ? 'not-queried' : 'not-queried',
		personalLibrary: explicit ? 'not-queried' : 'not-queried',
		attempts: [] as Array<{ libraryUuid: string, status: 'found' | 'empty' | 'sdk-error' | 'identity-error' }>,
	}
	const failure = (message: string, cause?: unknown) => new Error(message, {
		cause: { footprintSourceQuery: { ...query, attempts: query.attempts.map(attempt => ({ ...attempt })) }, ...(cause === undefined ? {} : { sdkError: cause }) },
	})
	const queryLibrary = async (libraryUuid: string) => {
		let source: unknown
		try { source = await eda.lib_Footprint.getDocumentSource(footprintUuid, libraryUuid) }
		catch (error) {
			query.attempts.push({ libraryUuid, status: 'sdk-error' })
			throw failure(`读取封装源码时 SDK 异常（footprintUuid=${footprintUuid}, libraryUuid=${libraryUuid}）`, error)
		}
		if (source === undefined || source === null || typeof source === 'string' && !source.trim()) {
			query.attempts.push({ libraryUuid, status: 'empty' })
			return undefined
		}
		if (typeof source !== 'string' || !source.trim())
			throw failure(`封装源码返回类型无效（footprintUuid=${footprintUuid}, libraryUuid=${libraryUuid}）`)
		try { footprintSourceUuid(source, footprintUuid) }
		catch (error) {
			query.attempts.push({ libraryUuid, status: 'identity-error' })
			throw failure(`封装源码身份核验失败（footprintUuid=${footprintUuid}, libraryUuid=${libraryUuid}）：${(error as Error).message}`, error)
		}
		query.attempts.push({ libraryUuid, status: 'found' })
		return { libraryUuid, source }
	}
	const querySnapshot = () => ({ ...query, attempts: query.attempts.map(attempt => ({ ...attempt })) })
	const noLibraryResult = () => failure(`在可查询的库中未找到封装源码（footprintUuid=${footprintUuid}）`)
	if (explicit) {
		const result = await queryLibrary(requestedLibraryUuid)
		if (!result) throw noLibraryResult()
		return { ...result, query: querySnapshot() }
	}
	let projectLibraryUuid: string | undefined
	try {
		projectLibraryUuid = await eda.lib_LibrariesList.getProjectLibraryUuid()
		query.projectLibrary = projectLibraryUuid ? 'available' : 'unavailable'
	}
	catch (error) {
		query.projectLibrary = 'sdk-error'
		throw failure('获取当前工程库 UUID 时 SDK 异常', error)
	}
	if (projectLibraryUuid) {
		const projectResult = await queryLibrary(projectLibraryUuid)
		if (projectResult) return { ...projectResult, query: querySnapshot() }
	}
	let personalLibraryUuid: string | undefined
	try {
		personalLibraryUuid = await eda.lib_LibrariesList.getPersonalLibraryUuid()
		query.personalLibrary = personalLibraryUuid ? 'available' : 'unavailable'
	}
	catch (error) {
		query.personalLibrary = 'sdk-error'
		throw failure('获取个人库 UUID 时 SDK 异常', error)
	}
	if (!personalLibraryUuid || personalLibraryUuid === projectLibraryUuid)
		throw noLibraryResult()
	const personalResult = await queryLibrary(personalLibraryUuid)
	if (!personalResult) throw noLibraryResult()
	return { ...personalResult, query: querySnapshot() }
}

function searchPageNumber(value: unknown, fallback: number, field: 'itemsOfPage' | 'page'): number {
	const number = value === undefined ? fallback : Number(value)
	if (!Number.isSafeInteger(number) || number <= 0)
		throw new Error(`${field} 必须是正整数`)
	return number
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

function cloneLibValue(value: any): any {
	if (Array.isArray(value))
		return value.map(cloneLibValue)
	if (value && typeof value === 'object')
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneLibValue(item)]))
	return value
}

function canonicalLibValue(value: any): any {
	if (Array.isArray(value))
		return value.map(canonicalLibValue)
	if (value && typeof value === 'object')
		return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalLibValue(value[key])]))
	return value
}

function libValuesEqual(a: any, b: any): boolean {
	return JSON.stringify(canonicalLibValue(a)) === JSON.stringify(canonicalLibValue(b))
}

function symbolModifyExpected(before: any, params: Record<string, any>): Record<string, any> {
	const otherProperty = cloneLibValue(before.otherProperty ?? {})
	if (params.otherProperty && typeof params.otherProperty === 'object' && !Array.isArray(params.otherProperty)) {
		for (const [key, value] of Object.entries(params.otherProperty)) {
			if (value === null)
				delete otherProperty[key]
			else if (value !== undefined)
				otherProperty[key] = cloneLibValue(value)
		}
	}
	return {
		name: params.name === undefined ? before.name : params.name,
		libraryUuid: before.libraryUuid,
		libraryType: before.libraryType,
		cbbUuid: before.cbbUuid,
		description: params.description === undefined ? before.description : params.description === null ? null : String(params.description),
		classification: params.classification === undefined ? before.classification : params.classification,
		type: before.type,
		subPartNames: before.subPartNames,
		otherProperty,
	}
}

function symbolModifyDifferences(expected: Record<string, any>, actual: any): Array<Record<string, any>> {
	if (!actual)
		return [{ field: 'readback', expected: 'fresh symbol readback', actual: null }]
	const differences: Array<Record<string, any>> = []
	for (const field of ['name', 'libraryUuid', 'libraryType', 'cbbUuid', 'description', 'classification', 'type', 'subPartNames', 'otherProperty']) {
		const expectedValue = field === 'otherProperty' ? expected[field] ?? {} : expected[field]
		const actualValue = field === 'otherProperty' ? actual[field] ?? {} : actual[field]
		const clearRequested = (field === 'description' && expectedValue === null)
			|| (field === 'classification' && expectedValue === null)
		if (clearRequested ? actualValue !== undefined && actualValue !== null : !libValuesEqual(expectedValue, actualValue))
			differences.push({ field, expected: cloneLibValue(expectedValue), actual: cloneLibValue(actualValue) })
	}
	return differences
}

async function verifySymbolModify(
	params: Record<string, any>,
	libraryUuid: string,
	before: any,
): Promise<Record<string, any>> {
	const api: any = eda.lib_Symbol
	const symbolUuid = String(params.symbolUuid)
	const expected = symbolModifyExpected(before, params)
	let after: any
	let candidateUuid: string | undefined
	let readbackIssue: Record<string, any> | undefined
	let verify: 'get' | 'search' | 'none' = 'get'
	try {
		after = await api.get(symbolUuid, libraryUuid)
	}
	catch {
		after = undefined
	}
	if (after && (after.uuid !== symbolUuid || after.libraryUuid !== libraryUuid)) {
		readbackIssue = { field: 'identity', expected: { uuid: symbolUuid, libraryUuid }, actual: { uuid: after.uuid, libraryUuid: after.libraryUuid } }
		candidateUuid = undefined
		after = undefined
	}
	if (!after) {
		verify = 'search'
		try {
			const candidates = new Map<string, any>()
			const pageSize = 20
			for (let page = 1; ; page++) {
				const results = await api.search(String(expected.name), libraryUuid, undefined, undefined, pageSize, page)
				if (!Array.isArray(results))
					throw new Error('符号搜索返回非数组结果')
				for (const item of results) {
					if (item && item.libraryUuid === libraryUuid && item.name === expected.name && typeof item.uuid === 'string' && item.uuid)
						candidates.set(item.uuid, item)
				}
				if (results.length < pageSize)
					break
				if (page >= 1000)
					throw new Error('同名符号候选超过安全分页上限')
			}
			if (candidates.size === 1) {
				candidateUuid = [...candidates.keys()][0]
				after = await api.get(candidateUuid, libraryUuid)
				if (!after || after.uuid !== candidateUuid || after.libraryUuid !== libraryUuid) {
					readbackIssue = { field: 'candidateIdentity', expected: { uuid: candidateUuid, libraryUuid }, actual: after ? { uuid: after.uuid, libraryUuid: after.libraryUuid } : null }
					after = undefined
				}
			}
			else
				readbackIssue = { field: 'candidateCount', expected: 1, actual: candidates.size, candidateUuids: [...candidates.keys()] }
		}
		catch (error) {
			readbackIssue = { field: 'candidateSearch', expected: { name: expected.name, libraryUuid }, actual: String((error as Error)?.message ?? error) }
			after = undefined
		}
	}
	const differences = symbolModifyDifferences(expected, after)
	if (!after && readbackIssue)
		differences.unshift(readbackIssue)
	if (differences.length) {
		const uuid = after?.uuid ?? candidateUuid ?? symbolUuid
		const cause = {
			partial: true,
			retryable: false,
			sdkModified: true,
			before: cloneLibValue(before),
			after: cloneLibValue(after ?? null),
			differences,
			candidateUuid: candidateUuid ?? null,
			uuid,
			verify,
		}
		throw new Error('符号修改已提交，但读回属性不一致或身份无法确认；不要自动重试', { cause })
	}
	return {
		modified: true,
		uuid: after.uuid,
		uuidChanged: after.uuid !== symbolUuid,
		verify,
	}
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
			const itemsOfPage = searchPageNumber(params.itemsOfPage, 20, 'itemsOfPage')
			const page = searchPageNumber(params.page, 1, 'page')
			const libraryUuid = await resolveLibraryUuid(params)
			return await eda.lib_Symbol.search(
				String(params.key ?? ''),
				libraryUuid,
				params.classification as any,
				params.symbolType !== undefined ? Number(params.symbolType) as any : undefined,
				itemsOfPage,
				page,
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
		returns: '成功：{ modified, uuid, uuidChanged, verify }；读回属性不一致时抛出 partial 错误，cause 含 retryable:false、sdkModified:true、before/after/differences/candidateUuid/uuid/verify；不自动重试',
		example: { cmd: 'lib.symbolModify', params: { symbolUuid: 'xxx', description: '新描述' } },
		handler: async (params) => {
			if (!params.symbolUuid)
				throw new Error('缺少参数 symbolUuid')
			if (params.name !== undefined && (typeof params.name !== 'string' || !params.name.trim()))
				throw new Error('name 必须是非空字符串')
			if (params.name === undefined && params.classification === undefined && params.description === undefined && params.otherProperty === undefined)
				throw new Error('至少提供一个要修改的字段（name / classification / description / otherProperty）')
			const libraryUuid = await resolveLibraryUuid(params)
			const symbolUuid = String(params.symbolUuid)
			let before: any
			try {
				before = await eda.lib_Symbol.get(symbolUuid, libraryUuid)
			}
			catch (error) {
				throw new Error(`修改符号前无法读取并确认身份；未调用修改（symbolUuid=${symbolUuid}, libraryUuid=${libraryUuid}）`, { cause: error })
			}
			if (!before || before.uuid !== symbolUuid || before.libraryUuid !== libraryUuid || typeof before.name !== 'string')
				throw new Error(`修改符号前无法确认 UUID / library 身份或名称；未调用修改（symbolUuid=${symbolUuid}, libraryUuid=${libraryUuid}）`)
			before = cloneLibValue(before)
			const modified = await eda.lib_Symbol.modify(
				symbolUuid,
				libraryUuid,
				params.name === undefined ? before.name : String(params.name),
				params.classification as any,
				params.description !== undefined ? (params.description === null ? null : String(params.description)) : undefined,
				params.otherProperty as any,
			)
			if (modified !== true)
				throw new Error(`修改符号失败：官方返回 ${String(modified)}`)
			return await verifySymbolModify(params, libraryUuid, before)
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
			let tabId: string | undefined
			try {
				tabId = await eda.lib_Symbol.openInEditor(String(params.symbolUuid), libraryUuid)
			}
			catch (error) {
				if ((error as any)?.message === '[object Object]')
					throw new Error(`打开符号编辑器失败：官方接口返回不可读错误（symbolUuid=${String(params.symbolUuid)}, libraryUuid=${libraryUuid}）`, { cause: error })
				throw error
			}
			if (typeof tabId !== 'string' || !tabId.trim())
				throw new Error(`打开符号编辑器失败：官方未返回有效页签 ID（${String(tabId)}）`)
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
			let tabId: string | undefined
			try {
				tabId = await eda.lib_Footprint.openInEditor(String(params.footprintUuid), libraryUuid)
			}
			catch (error) {
				if ((error as any)?.message === '[object Object]')
					throw new Error(`打开封装编辑器失败：官方接口返回不可读错误（footprintUuid=${String(params.footprintUuid)}, libraryUuid=${libraryUuid}）`, { cause: error })
				throw error
			}
			if (typeof tabId !== 'string' || !tabId.trim())
				throw new Error(`打开封装编辑器失败：官方未返回有效页签 ID（${String(tabId)}）`)
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
		name: 'lib.footprintGetSource',
		summary: '直接读取库封装文档源码，不打开编辑器或修改库',
		params: [
			{ name: 'footprintUuid', type: 'string', required: true, description: '封装 UUID' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID；省略时按当前工程库、个人库顺序查询' },
		],
		returns: '{ footprintUuid, libraryUuid, source, query }；libraryUuid 是实际命中的库，query 记录查询顺序和结果；返回前核对源码 UUID',
		example: { cmd: 'lib.footprintGetSource', params: { footprintUuid: 'xxx' } },
		handler: async (params) => {
			if (!params.footprintUuid)
				throw new Error('缺少参数 footprintUuid');
			const footprintUuid = String(params.footprintUuid);
			const result = await getFootprintSource(footprintUuid, params)
			return { footprintUuid, ...result };
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
			const itemsOfPage = searchPageNumber(params.itemsOfPage, 20, 'itemsOfPage')
			const page = searchPageNumber(params.page, 1, 'page')
			const libraryUuid = await resolveLibraryUuid(params)
			return await eda.lib_Footprint.search(
				String(params.key ?? ''),
				libraryUuid,
				params.classification as any,
				itemsOfPage,
				page,
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
			let item: any
			try {
				item = await eda.lib_Footprint.get(String(params.footprintUuid), libraryUuid)
			}
			catch (error) {
				if ((error as any)?.message === '[object Object]')
					throw new Error('封装读取失败：官方接口返回不可读错误，无法判断不存在、无权限或其他原因；请核对封装与库 UUID', { cause: error })
				throw error
			}
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
			{ name: 'symbolUuid', type: 'string', required: false, description: '已有符号 UUID；与 symbolType 二选一，提供时绑定已有符号' },
			{ name: 'symbolLibraryUuid', type: 'string', required: false, description: '符号所在库 UUID，默认同 libraryUuid' },
			{ name: 'symbolType', type: 'number', required: false, description: '新建符号时使用的符号类型；仅在未提供 symbolUuid 时生效' },
			{ name: 'footprintUuid', type: 'string', required: false, description: '要绑定的封装 UUID' },
			{ name: 'footprintLibraryUuid', type: 'string', required: false, description: '封装所在库 UUID，默认同 libraryUuid' },
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
			if (!params.symbolUuid && params.symbolType === undefined)
				throw new Error('缺少参数 symbolUuid 或 symbolType：提供已有符号，或指定新建符号类型')
			const hasModel3DUuid = params.model3DUuid !== undefined
			const hasModel3DLibraryUuid = params.model3DLibraryUuid !== undefined
			if (hasModel3DUuid && (typeof params.model3DUuid !== 'string' || !params.model3DUuid.trim()))
				throw new Error('model3DUuid 必须是非空字符串')
			if (hasModel3DLibraryUuid && (typeof params.model3DLibraryUuid !== 'string' || !params.model3DLibraryUuid.trim()))
				throw new Error('model3DLibraryUuid 必须是非空字符串')
			if (hasModel3DLibraryUuid && !hasModel3DUuid)
				throw new Error('提供 model3DLibraryUuid 时必须同时提供 model3DUuid')
			const libraryUuid = await resolveLibraryUuid(params)
			const association: any = params.symbolUuid
				? { symbol: { uuid: String(params.symbolUuid), libraryUuid: params.symbolLibraryUuid ? String(params.symbolLibraryUuid) : libraryUuid } }
				: { symbolType: Number(params.symbolType) }
			if (params.footprintUuid) {
				association.footprint = {
					uuid: String(params.footprintUuid),
					libraryUuid: params.footprintLibraryUuid ? String(params.footprintLibraryUuid) : libraryUuid,
				}
			}
			if (hasModel3DUuid) {
				const model3DUuid = params.model3DUuid as string
				const model3DLibraryUuid = hasModel3DLibraryUuid ? params.model3DLibraryUuid as string : libraryUuid
				const modelApi = (eda as any).lib_3DModel
				if (!modelApi || typeof modelApi.get !== 'function')
					throw new Error('无法创建器件：当前 EDA SDK 不支持 lib_3DModel.get，不能核实 3D 模型 UUID 与库身份')
				let model: any
				try {
					model = await modelApi.get(model3DUuid, model3DLibraryUuid)
				}
				catch (error) {
					throw new Error(`无法创建器件：3D 模型验证失败（model3DUuid=${model3DUuid}, libraryUuid=${model3DLibraryUuid}）`, { cause: error })
				}
				if (!model)
					throw new Error(`无法创建器件：3D 模型不存在或无权访问（model3DUuid=${model3DUuid}, libraryUuid=${model3DLibraryUuid}）`)
				if (model.uuid !== model3DUuid || model.libraryUuid !== model3DLibraryUuid)
					throw new Error(`无法创建器件：3D 模型身份不符（请求 ${model3DUuid}@${model3DLibraryUuid}，实际 ${String(model.uuid)}@${String(model.libraryUuid)}）`)
				association.model3D = {
					uuid: model3DUuid,
					libraryUuid: model3DLibraryUuid,
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
		let item: any = null
		let getError: unknown
		try {
			item = await eda.lib_Device.get(deviceUuid, libraryUuid)
		}
		catch (error) {
			getError = error
		}
		if (item)
			return item
		try {
			const rows = await eda.lib_Device.search(String(params.name), libraryUuid, undefined, undefined, 20, 1)
			const matches = Array.isArray(rows) ? rows.filter((row: any) => row?.uuid === deviceUuid) : []
			if (matches.length === 1)
				return matches[0]
			throw new Error(`按创建 UUID 精确查询到 ${matches.length} 条记录`)
		}
		catch (searchError) {
			const detail = getError ? String((getError as any)?.message ?? getError) : '官方 get 返回空'
			throw new Error(`器件已创建（uuid=${deviceUuid}）但无法读回；get=${detail}；UUID 查询=${String((searchError as any)?.message ?? searchError)}`)
		}
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
			const itemsOfPage = searchPageNumber(params.itemsOfPage, 20, 'itemsOfPage')
			const page = searchPageNumber(params.page, 1, 'page')
			const libraryUuid = await resolveLibraryUuid(params)
			return await eda.lib_Device.search(
				String(params.key ?? ''),
				libraryUuid,
				params.classification as any,
				params.symbolType !== undefined ? Number(params.symbolType) as any : undefined,
				itemsOfPage,
				page,
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
		summary: '用立创 C 编号获取器件（支持单个或数组批量；可能没有关联封装，不能据此认定可转 PCB；私有化部署环境不可用）',
		params: [
			{ name: 'lcscIds', type: 'string | array', required: true, description: '立创 C 编号，如 "C1523" 或 ["C1523","C17168"]' },
			{ name: 'libraryUuid', type: 'string', required: false, description: '库 UUID，默认个人库' },
			{ name: 'allowMultiMatch', type: 'boolean', required: false, description: '同一库内同 C 编号匹配多个时是否全部返回，默认 false' },
			{ name: 'diagnostic', type: 'boolean', required: false, description: '设为 true 时附带 SDK 方法、实参快照、调用时间；能从返回字段确认时还会标记 missingFootprint；默认 false' },
		],
		returns: '默认原样返回器件属性（或数组）；不自动换库。关联封装缺失时器件不能据此认定可转 PCB。diagnostic:true 且成功时返回 { result, diagnostic: { sdkMethod, sdkArgs, startedAt, finishedAt, missingFootprint? } }；仅当所有结果项都能从返回字段确认封装存在或缺失时才提供 missingFootprint',
		example: { cmd: 'lib.deviceGetByLcscIds', params: { lcscIds: ['C1523', 'C17168'] } },
		handler: async (params) => {
			if (!params.lcscIds)
				throw new Error('缺少参数 lcscIds')
			if (params.diagnostic !== undefined && typeof params.diagnostic !== 'boolean')
				throw new Error('diagnostic 必须是布尔值')
			const lcscIds = params.lcscIds
			const allowMultiMatch = Boolean(params.allowMultiMatch ?? false)
			const libraryUuid = await resolveLibraryUuid(params)
			let result: any
			let diagnostic: { sdkMethod: string, sdkArgs: { lcscIds: unknown, libraryUuid: string, allowMultiMatch: boolean }, startedAt: string, finishedAt: string, missingFootprint?: boolean } | undefined
			if (params.diagnostic === true) {
				const sdkArgs = {
					lcscIds: Array.isArray(lcscIds) ? [...lcscIds] : lcscIds,
					libraryUuid,
					allowMultiMatch,
				}
				const startedAt = new Date().toISOString()
				result = await (eda.lib_Device.getByLcscIds as any)(lcscIds, libraryUuid, allowMultiMatch)
				const finishedAt = new Date().toISOString()
				diagnostic = { sdkMethod: 'lib_Device.getByLcscIds', sdkArgs, startedAt, finishedAt }
			}
			else {
				result = await (eda.lib_Device.getByLcscIds as any)(lcscIds, libraryUuid, allowMultiMatch)
			}
			if (result === undefined || (Array.isArray(result) && result.length === 0))
				throw new Error('未匹配到器件（官方返回空）')
			if (diagnostic) {
				const items = Array.isArray(result) ? result : [result]
				const footprintStates = items.map((item: any) => {
					if (!item || typeof item !== 'object') return undefined
					const footprintUuid = item.footprint?.uuid ?? item.footprintUuid
					if (typeof footprintUuid !== 'string') return undefined
					return footprintUuid.trim().length > 0
				})
				if (footprintStates.length > 0 && footprintStates.every((state: boolean | undefined) => state !== undefined))
					diagnostic.missingFootprint = footprintStates.every((hasFootprint: boolean) => !hasFootprint)
			}
			return diagnostic ? { result, diagnostic } : result
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
