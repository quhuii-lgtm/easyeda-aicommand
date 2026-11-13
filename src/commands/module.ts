/** Module reuse operations integrated into AI Command Engine. */
import type { ICommandDef, IParamDoc } from '../engine/types'
import { getProxyUrl, setProxyPort } from '../bridge/proxy-endpoint'
import { executeModuleOperation, isModuleBusinessCommand, isModuleRecordQuery } from '../modules/reuse/service'

type Param = IParamDoc
const p = (name: string, type: string, description: string, required = true): Param => ({ name, type, required, description })

type BackendEnvelope = { ok: boolean, data?: any, error?: { message?: string, code?: string, cause?: unknown } }
async function libraryRequest(action: string, params: Record<string, unknown>): Promise<any> {
	const url = getProxyUrl('/module-library')
	if (!url) throw new Error('AI Command Engine 代理尚未连接，无法访问本地模块库')
	let text: string
	try {
		const response = await eda.sys_ClientUrl.request(url, 'POST', JSON.stringify({ action, params }), { headers: { 'Content-Type': 'application/json' } })
		text = await response.text()
	}
	catch (cause) {
		const write = action === 'save' || action === 'setDirectory'
		throw new Error(write ? '模块库写入请求已发出但响应丢失，结果未知；先检查模块库状态。' : '模块库请求未能完成。', {
			cause: { partial: write, writeAttempted: write, retryable: false, outcome: write ? 'unknown' : 'not_started', cause },
		})
	}
	let result: BackendEnvelope
	try { result = JSON.parse(text) as BackendEnvelope }
	catch (cause) {
		const write = action === 'save' || action === 'setDirectory'
		throw new Error(write ? '模块库写入响应不是有效 JSON，保存结果未知；先检查模块库状态。' : '模块库代理返回了无效 JSON。', {
			cause: { partial: write, writeAttempted: write, retryable: false, outcome: write ? 'unknown' : 'not_started', response: text.slice(0, 1000), cause },
		})
	}
	if (!result || result.ok !== true) {
		const detail = result?.error
		const write = action === 'save' || action === 'setDirectory'
		const backendCause = detail?.cause
		const knownPartial = backendCause && typeof backendCause === 'object' && typeof (backendCause as any).partial === 'boolean'
		const partial = knownPartial ? (backendCause as any).partial : write
		const knownWriteAttempted = backendCause && typeof backendCause === 'object' && typeof (backendCause as any).writeAttempted === 'boolean'
		const writeAttempted = knownWriteAttempted ? (backendCause as any).writeAttempted : write
		throw new Error(detail?.message || '模块库操作失败', {
			cause: {
				...(backendCause && typeof backendCause === 'object' ? backendCause as object : {}),
				...(detail?.code ? { code: detail.code } : {}),
				...(backendCause !== undefined ? { backendCause } : {}),
				partial,
				writeAttempted,
				retryable: false,
				outcome: partial ? 'unknown' : 'not_started',
			},
		})
	}
	return result.data
}

function validateLibraryParams(action: string, raw: Record<string, any>): Record<string, unknown> {
	const required = action === 'info' ? []
		: action === 'setDirectory' ? ['directory']
			: action === 'save' ? ['localId', 'version', 'fileName', 'base64']
				: action === 'search' ? ['query']
					: action === 'get' ? ['localId', 'version'] : []
	const optional = action === 'setDirectory' ? ['edaInstallDirectory']
		: action === 'save' ? ['name', 'sha256', 'description', 'tags', 'directory']
			: action === 'list' ? ['directory']
				: action === 'search' ? ['directory', 'limit']
					: action === 'get' ? ['directory'] : []
	const allowed = new Set([...required, ...optional])
	for (const key of required) if (!(key in raw)) throw new Error(`${key} 是必填参数`)
	for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new Error(`不支持模块库参数：${key}`)
	for (const key of ['localId', 'version', 'name', 'fileName', 'base64', 'sha256', 'description', 'query', 'edaInstallDirectory']) {
		if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key].trim())) throw new Error(`${key} 必须是非空字符串`)
	}
	if (action === 'setDirectory' && raw.directory !== null && (typeof raw.directory !== 'string' || !raw.directory.trim()))
		throw new Error('directory 必须是非空路径字符串或 null')
	if (['list', 'search', 'get', 'save'].includes(action) && raw.directory !== undefined && (typeof raw.directory !== 'string' || !raw.directory.trim()))
		throw new Error('directory 必须是非空路径字符串')
	if (action === 'save') {
		if (!/\.epro2?$/i.test(raw.fileName) || /[\\/]/.test(raw.fileName)) throw new Error('fileName 必须是不带路径的 .epro 或 .epro2 文件名')
		if (typeof raw.base64 !== 'string' || !raw.base64) throw new Error('base64 必须是非空归档内容')
		if (raw.sha256 !== undefined && !/^[a-f\d]{64}$/i.test(raw.sha256)) throw new Error('sha256 必须是 64 位十六进制字符串')
		if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.some((tag: unknown) => typeof tag !== 'string')))
			throw new Error('tags 必须是字符串数组')
	}
	if (action === 'search' && raw.limit !== undefined && (!Number.isInteger(raw.limit) || raw.limit < 1))
		throw new Error('limit 必须是正整数')
	return { ...raw }
}

function cleanTimeout(params: Record<string, any>): Record<string, any> {
	const { _timeoutMs: _ignoredTimeout, ...businessParams } = params
	return businessParams
}

const definitions: Array<{ name: string, summary: string, params: Param[], returns: string }> = [
	{ name: 'module.getStatus', summary: '读取模块复用集成能力状态；不启动旧版 Gateway，也不检查模块库目录', params: [], returns: '{ integrated, capabilities, nativeCapabilities }' },
	{ name: 'module.getContext', summary: '核对并读取当前工程与文档上下文', params: [p('projectUuid', 'string', '当前工程 UUID'), p('documentUuid', 'string', '当前原理图页或 PCB 文档 UUID')], returns: '{ project, document }' },
	{ name: 'module.capturePair', summary: '读取已配对原理图页与 PCB 的原始内容快照', params: [p('projectUuid', 'string', '当前工程 UUID'), p('schematicPageUuid', 'string', '配对的原理图页 UUID'), p('pcbUuid', 'string', '配对 PCB UUID')], returns: '配对身份、源码摘要与 captureId' },
	{ name: 'module.probeNativeCopy', summary: '将捕获的原生文档副本写入目标工程并核对操作状态', params: [p('operationId', 'string', '本次操作唯一 ID'), p('captureId', 'string', 'module.capturePair 返回的捕获 ID'), p('targetProjectUuid', 'string', '目标工程 UUID'), p('documentType', 'string', 'schematic 或 pcb'), p('targetSchematicUuid', 'string', 'documentType 为 schematic 时的目标原理图 UUID', false)], returns: '原生复制操作状态和读回证据' },
	{ name: 'module.getCopyOperation', summary: '只读查询原生复制操作记录', params: [p('operationId', 'string', '原复制操作 ID')], returns: '操作记录或未找到结果' },
	{ name: 'module.restoreFile', summary: '把已保存的 .epro/.epro2 文件恢复到现有目标工程', params: [p('operationId', 'string', '本次操作唯一 ID'), p('targetProjectUuid', 'string', '目标工程 UUID'), p('fileName', 'string', '不带路径的 .epro 或 .epro2 文件名'), p('base64', 'string', '归档文件 Base64 内容')], returns: '恢复状态；metadataVerified 不代表内容已验证' },
	{ name: 'module.getRestoreOperation', summary: '只读查询文件恢复操作', params: [p('operationId', 'string', '原恢复操作 ID')], returns: '恢复操作状态' },
	{ name: 'module.exportTemplateFile', summary: '从当前工程导出含指定模块内容的原生模板文件', params: [p('projectUuid', 'string', '当前工程 UUID'), p('cbbUuid', 'string', '复用模块 UUID'), p('libraryUuid', 'string', '模块库 UUID'), p('templateSchematicUuid', 'string', '模板父原理图 UUID'), p('templatePcbUuid', 'string', '模板 PCB UUID'), p('fileName', 'string', '无路径的 .epro2 文件名')], returns: '模板文件名、文件大小、MIME 类型、Base64 和内容/绑定核验状态（未在此命令确认）' },
	{ name: 'module.placeSchematicPage', summary: '将复用模板原理图页放到目标页', params: [p('operationId', 'string', '本次操作唯一 ID'), p('cbbUuid', 'string', '模板复用块 UUID'), p('libraryUuid', 'string', '模块库 UUID'), p('sourceSchematicUuid', 'string', '模板父原理图 UUID'), p('sourcePcbUuid', 'string', '模板 PCB UUID'), p('targetProjectUuid', 'string', '目标工程 UUID'), p('targetSchematicUuid', 'string', '目标原理图 UUID'), p('targetSchematicPageUuid', 'string', '目标原理图页 UUID'), p('targetPcbUuid', 'string', '与目标页配对的 PCB UUID'), p('x', 'number', '放置 X 坐标，单位 10mil'), p('y', 'number', '放置 Y 坐标，单位 10mil'), p('reimportWhenNameRepeated', 'boolean', '同名器件时是否重新导入')], returns: '放置操作状态与读回结果' },
	{ name: 'module.alignTemplatePcb', summary: '按已放置原理图页对齐模板 PCB', params: [p('operationId', 'string', '本次操作唯一 ID'), p('placementOperationId', 'string', '原放置操作 ID'), p('targetProjectUuid', 'string', '目标工程 UUID'), p('targetSchematicPageUuid', 'string', '目标原理图页 UUID'), p('templateSchematicUuid', 'string', '模板父原理图 UUID'), p('templatePcbUuid', 'string', '模板 PCB UUID')], returns: '对齐操作状态与身份读回' },
	{ name: 'module.mapInstanceNets', summary: '映射实例接口网与内部网；完成后仍需核对实际网表', params: [p('operationId', 'string', '本次操作唯一 ID'), p('placementOperationId', 'string', '原放置操作 ID'), p('targetProjectUuid', 'string', '目标工程 UUID'), p('targetSchematicPageUuid', 'string', '目标原理图页 UUID'), p('netMap', '{sourceNet,targetNet,kind}[]', '每项来源网名、目标网名和分类；kind 为 internal 或 interface，覆盖全部非空网络')], returns: '网络映射结果与实际读回证据' },
	{ name: 'module.getPlacementOperation', summary: '只读查询原理图放置、PCB 对齐或网络映射操作', params: [p('operationId', 'string', '原操作 ID'), p('targetProjectUuid', 'string', '目标工程 UUID')], returns: '操作状态、阶段和核验字段' },
	{ name: 'module.getPcbImportOperation', summary: '只读查询历史 PCB 导入操作记录', params: [p('operationId', 'string', '原操作 ID'), p('targetProjectUuid', 'string', '目标工程 UUID')], returns: '原 PCB 导入操作状态' },
	{ name: 'module.preparePcbComposition', summary: '核对来源/目标板并准备 PCB 实例组合计划，不写入目标 PCB', params: [p('operationId', 'string', '计划操作唯一 ID'), p('projectUuid', 'string', '当前工程 UUID'), p('sourcePcbUuid', 'string', '来源 PCB UUID'), p('targetPcbUuid', 'string', '目标 PCB UUID'), p('targetSchematicPageUuid', 'string', '与目标 PCB 配对的原理图页 UUID'), p('uidMappings', '{sourceUid,targetUid}[]', '来源器件 UID 到目标器件 UID 映射'), p('netMappings', '{sourceNet,targetNet}[]', '来源网络到目标网络映射'), p('transform', '{dx,dy,rotationDegrees}', '对象结构 {dx,dy,rotationDegrees}：dx、dy 为 PCB 平移（单位 mil），rotationDegrees 为旋转角度')], returns: 'planId、组合预检结果及待执行操作信息' },
	{ name: 'module.composePcbInstance', summary: '执行已准备的 PCB 实例组合计划；返回未确认状态时停止宏并先查询记录', params: [p('planId', 'string', 'preparePcbComposition 返回的计划 ID'), p('projectUuid', 'string', '当前工程 UUID'), p('targetPcbUuid', 'string', '目标 PCB UUID')], returns: '组合结果、逐焊盘网络及图元读回信息；netlistVerified/saveReloadVerified 仍需按结果判断' },
	{ name: 'module.getPcbCompositionOperation', summary: '只读查询 PCB 组合操作，不继续写入', params: [p('operationId', 'string', '原组合操作 ID'), p('projectUuid', 'string', '原目标工程 UUID')], returns: '原操作阶段、状态、部分写入和核验字段' },
	{ name: 'module.prepareReplacement', summary: '为成组器件换件建立并核验计划，不替换设计', params: [p('projectUuid', 'string', '当前工程 UUID'), p('boardUuid', 'string', '目标板 UUID'), p('replacements', 'Replacement[]', '完整替换项数组，成员字段见下方参数说明')], returns: 'planId 和换件预检结果' },
	{ name: 'module.executeReplacement', summary: '按准备计划执行换件与保存重开核对；不确定状态会作为 ACE 指令失败', params: [p('planId', 'string', 'prepareReplacement 返回的计划 ID'), p('operationId', 'string', '本次执行唯一 ID')], returns: '已确认结果；未确认时返回 ACE 错误并保留 operationId/phase/partial' },
	{ name: 'module.getReplacementOperation', summary: '只读查询换件操作状态，不继续写入', params: [p('operationId', 'string', '原换件操作 ID')], returns: '换件操作阶段、状态和写入信息' },
	{ name: 'module.captureExtractionSource', summary: '捕获当前工程归档并生成原生文档摘要', params: [p('projectUuid', 'string', '当前工程 UUID'), p('fileName', 'string', '可选归档文件名，不得包含路径', false), p('includeSource', 'boolean', '是否在返回中包含源归档 Base64', false)], returns: '{ captureId, sourceSha, availableEpru, documentSummary, base64? }' },
	{ name: 'module.extractModuleArchive', summary: '按 workcard 生成模块归档并自动保存到模块库；磁盘保存失败时仅重试 module.librarySave', params: [p('operationId', 'string', '本次提取唯一 ID'), p('projectUuid', 'string', '来源工程 UUID'), p('captureId', 'string', 'captureExtractionSource 返回的捕获 ID'), p('workcard', 'object', '必须含 boardUuid、schematicUuid、schematicPageUuid、pcbUuid、newModule{localId,version,name}、interfaces[]、internalNets[]、selected{}；selected 可含 uids、pcbComponentIds、pcbLineIds、pcbViaIds、pcbStringIds、pcbOwnedPolyIds、schComponentIds、schWireIds、schLineIds、schTextIds、pcbArcIds、pcbStandalonePadIds'), p('sourceEpru', 'string', '多 EPRU 归档中的来源 EPRU 路径', false), p('outputEpru', 'string', '输出 EPRU 路径', false), p('fileName', 'string', '输出归档文件名', false), p('libraryDirectory', 'string', '仅本次自动保存使用的模块库目录；省略时用用户配置或 EDA 安装目录/module-library', false)], returns: '{ state:extracted, base64, sha256, librarySaved:true, library }；保存失败会带 operationId 和原文件信息报错' },
	{ name: 'module.libraryInfo', summary: '读取模块库目录设置和目录可用状态', params: [], returns: '用户设置目录、实际使用目录、默认目录及可用状态' },
	{ name: 'module.setLibraryDirectory', summary: '设置或恢复模块库目录；directory:null 恢复默认目录', params: [p('directory', 'string|null', '用户指定路径；null 清除自定义目录并恢复默认'), p('edaInstallDirectory', 'string', '仅当无法从插件上下文识别时提供实际 EDA 安装目录', false)], returns: '保存后的模块库目录信息' },
	{ name: 'module.librarySave', summary: '把模块归档保存到本机模块库；可用以恢复自动保存失败的提取文件', params: [p('localId', 'string', '模块本地唯一 ID'), p('version', 'string', '模块版本'), p('fileName', 'string', '不带路径的 .epro/.epro2 文件名'), p('base64', 'string', '归档内容 Base64'), p('name', 'string', '显示名称', false), p('sha256', 'string', '可选 SHA-256 校验值', false), p('description', 'string', '描述', false), p('tags', 'string[]', '标签数组', false), p('directory', 'string', '覆盖当前设置目录的单次保存路径', false)], returns: '模块库文件位置及摘要信息' },
	{ name: 'module.libraryList', summary: '列出本地模块库条目', params: [p('directory', 'string', '单次查询目录；省略时用已配置或默认目录', false)], returns: '模块条目数组' },
	{ name: 'module.librarySearch', summary: '按名称、ID、标签或描述检索本地模块库', params: [p('query', 'string', '搜索词'), p('directory', 'string', '单次查询目录；省略时用已配置或默认目录', false), p('limit', 'integer', '最多返回条数，正整数', false)], returns: '匹配的模块条目数组' },
	{ name: 'module.libraryGet', summary: '读取指定模块版本的归档内容和校验信息', params: [p('localId', 'string', '模块本地唯一 ID'), p('version', 'string', '模块版本'), p('directory', 'string', '单次查询目录；省略时用已配置或默认目录', false)], returns: '模块元数据、文件名、Base64 与 SHA-256' },
]

const replacementDetail = 'Replacement 项字段：oldUid、pcbComponentId；schematicParts[{pageUuid,componentId,subPartName?,newSubPartName?}]；newDevice{libraryUuid,uuid}；pinMap[{oldNumber,newNumber}]；可选 pcbPose{x,y,rotation,mirror?}、schematicPoses[{x,y,rotation,mirror?}]、localRoutes[{net,layer,width,anchor{primitiveId,endpoint:start|end},targetPadNumber,points:[[x,y],...]}]。坐标 PCB 用 mil，原理图用 SDK 单位。'
for (const item of definitions) {
	if (item.name === 'module.prepareReplacement')
		item.params[2]!.description += ` ${replacementDetail}`
}

function businessParams(params: Record<string, any>): Record<string, any> {
	return cleanTimeout(params)
}

async function handler(item: typeof definitions[number], rawParams: Record<string, any>, context?: import('../engine/types').ICommandContext): Promise<unknown> {
	const params = businessParams(rawParams)
	if (item.name.startsWith('module.library') || item.name === 'module.setLibraryDirectory') {
		const action = item.name === 'module.libraryInfo' ? 'info'
			: item.name === 'module.setLibraryDirectory' ? 'setDirectory'
				: item.name === 'module.librarySave' ? 'save'
					: item.name === 'module.libraryList' ? 'list'
						: item.name === 'module.librarySearch' ? 'search' : 'get'
		return libraryRequest(action, validateLibraryParams(action, params))
	}
	if (item.name === 'module.extractModuleArchive')
		return runModuleExtractionWithAutoSave(params, executeModuleOperation, (saveParams) => libraryRequest('save', validateLibraryParams('save', saveParams)))
	return executeModuleOperation(item.name, params, context?.stopSignal)
}

export async function runModuleExtractionWithAutoSave(
	params: Record<string, any>,
	extract: (cmd: string, params: Record<string, any>) => Promise<unknown> = executeModuleOperation,
	save: (params: Record<string, unknown>) => Promise<unknown> = saveParams => libraryRequest('save', validateLibraryParams('save', saveParams)),
): Promise<Record<string, any>> {
	const { libraryDirectory, ...extractParams } = params
	if (libraryDirectory !== undefined && (typeof libraryDirectory !== 'string' || !libraryDirectory.trim()))
		throw new Error('libraryDirectory 必须是非空目录路径')
	const workcard = extractParams.workcard
	const newModule = workcard && typeof workcard === 'object' ? workcard.newModule : undefined
	if (!newModule || typeof newModule.localId !== 'string' || !newModule.localId.trim() || typeof newModule.version !== 'string' || !newModule.version.trim())
		throw new Error('workcard.newModule 必须提供非空 localId 和 version，才能保存到模块库')
	const extracted = await extract('module.extractModuleArchive', extractParams)
	if (!extracted || typeof extracted !== 'object' || (extracted as any).state !== 'extracted')
		throw new Error('模块提取结果不完整；未尝试保存模块库')
	const file = extracted as Record<string, any>
	const saveParams = {
		localId: newModule.localId,
		version: newModule.version,
		...(typeof newModule.name === 'string' && newModule.name.trim() ? { name: newModule.name } : {}),
		fileName: file.fileName,
		base64: file.base64,
		sha256: file.sha256,
		...(libraryDirectory ? { directory: libraryDirectory } : {}),
	}
	try {
		const library = await save(saveParams)
		return { ...file, librarySaved: true, library }
	}
	catch (error) {
		const libraryError = error instanceof Error ? error : new Error(String(error))
		const saveCause = (libraryError as any).cause
		throw new Error(`模块已提取，但自动保存到本地模块库未确认。不要重复提取；只调用 module.librarySave 重试保存。operationId=${String(file.operationId)}。`, {
			cause: {
				operationId: file.operationId,
				state: 'extracted',
				librarySaved: false,
				libraryError: { message: libraryError.message, cause: saveCause },
				file: { fileName: file.fileName, base64: file.base64, sha256: file.sha256, bytes: file.bytes },
				retry: { cmd: 'module.librarySave', params: saveParams },
				extractionConfirmed: true,
				outcome: saveCause?.outcome ?? 'unknown',
				partial: true,
				writeAttempted: saveCause?.writeAttempted ?? true,
				libraryWritePartial: saveCause?.partial ?? true,
				retryable: false,
			},
		})
	}
}

export const moduleCommands: ICommandDef[] = definitions.map(item => ({
	...item,
	...(item.name === 'module.prepareReplacement' ? { params: item.params.map(param => param.name === 'replacements' ? { ...param, description: `${param.description} ${replacementDetail}` } : param) } : {}),
	handler: (params, context) => handler(item, params, context),
}))

export { isModuleBusinessCommand, isModuleRecordQuery }
export { setProxyPort }
