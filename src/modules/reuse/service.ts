import {
	capturePair,
	copyOperationArgs,
	getCopyOperation,
	isBusy,
	NativeCopyError,
	probeNativeCopy,
	validateCaptureParams,
	validateCopyParams,
} from './nativeCopy'
import {
	fileRestoreOperationArgs,
	FileRestoreError,
	getFileRestoreOperation,
	isFileRestoreBusy,
	restoreNativeProjectFile,
	validateFileRestoreParams,
} from './fileRestore'
import { exportTemplateFile, validateExportTemplateParams } from './templateExport'
import {
	alignTemplatePcb,
	getPlacementOperation,
	mapInstanceNets,
	NativePlacementError,
	placementOperationArgs,
	placeSchematicPage,
	validateAlignTemplatePcbParams,
	validateMapInstanceNetsParams,
	validatePlaceSchematicPageParams,
} from './nativePlacement'
import { getPcbImportOperation, pcbImportOperationArgs, PcbInstanceImportError } from './pcbInstanceImport'
import { createPcbCompositionHost, createPcbCompositionService, PcbCompositionError } from './pcbComposition'
import { prepareComposition, validatePrepareCompositionParams, readPreparedComposition, compositionPlanArgs } from './pcbCompositionEntry'
import { captureExtractionSource, extractModuleArchive, ModuleExtractionError, validateCaptureExtractionSourceParams, validateExtractModuleArchiveParams } from './moduleExtraction'
import { createComponentReplacementService } from './componentReplacement'
import { createEdaComponentReplacementHost } from './componentReplacementHost'

const operations = [
	'module.getStatus', 'module.getContext', 'module.capturePair', 'module.probeNativeCopy', 'module.getCopyOperation',
	'module.restoreFile', 'module.getRestoreOperation', 'module.exportTemplateFile', 'module.placeSchematicPage',
	'module.alignTemplatePcb', 'module.mapInstanceNets', 'module.getPlacementOperation', 'module.getPcbImportOperation',
	'module.preparePcbComposition', 'module.composePcbInstance', 'module.getPcbCompositionOperation',
	'module.prepareReplacement', 'module.executeReplacement', 'module.getReplacementOperation',
	'module.captureExtractionSource', 'module.extractModuleArchive',
] as const

const queryOperations = new Set([
	'module.getStatus', 'module.getCopyOperation', 'module.getRestoreOperation', 'module.getPlacementOperation',
	'module.getPcbImportOperation', 'module.getPcbCompositionOperation', 'module.getReplacementOperation',
	'module.libraryInfo', 'module.libraryList', 'module.librarySearch', 'module.libraryGet',
])

export function isModuleBusinessCommand(cmd: string): boolean {
	return (operations as readonly string[]).includes(cmd) || cmd === 'module.setLibraryDirectory'
		|| ['module.libraryInfo', 'module.librarySave', 'module.libraryList', 'module.librarySearch', 'module.libraryGet'].includes(cmd)
}

export function isModuleRecordQuery(cmd: string): boolean {
	return queryOperations.has(cmd)
}

let entryBusy = false
const componentReplacementService = createComponentReplacementService(createEdaComponentReplacementHost(eda))

function fail(message: string, cause?: unknown): never {
	throw new Error(message, cause === undefined ? undefined : { cause })
}

function object(value: unknown): value is Record<string, any> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function runEntryBusy<T>(work: () => Promise<T>): Promise<T> {
	if (entryBusy)
		fail('模块复用正处于写入操作中')
	entryBusy = true
	try {
		return await work()
	}
	finally {
		entryBusy = false
	}
}

async function readProject(expectedUuid: string): Promise<any> {
	const project = await eda.dmt_Project.getCurrentProjectInfo()
	if (!project)
		fail('读取当前工程失败：SDK 返回空结果')
	if (project.uuid !== expectedUuid)
		fail('目标工程与当前工程不一致')
	return project
}

async function readDocument(expectedUuid: string, projectUuid: string): Promise<any> {
	const document = await eda.dmt_SelectControl.getCurrentDocumentInfo()
	if (!document)
		fail('读取当前文档失败：SDK 返回空结果')
	if (document.uuid !== expectedUuid)
		fail('目标文档与当前文档不一致')
	if (document.parentProjectUuid !== projectUuid)
		fail('当前文档不属于目标工程')
	return document
}

async function getContext(projectUuid: string, documentUuid: string): Promise<unknown> {
	const project = await readProject(projectUuid)
	const document = await readDocument(documentUuid, projectUuid)
	const finalProject = await readProject(projectUuid)
	const finalDocument = await readDocument(documentUuid, projectUuid)
	if (finalProject.uuid !== project.uuid || finalDocument.uuid !== document.uuid)
		fail('读取期间工程或文档身份发生变化')
	return { project, document }
}

function getStatus(): unknown {
	return {
		integrated: true,
		gateway: { managedBy: 'ai-command-engine', startedByModule: false },
		capabilities: [...operations, 'module.libraryInfo', 'module.setLibraryDirectory', 'module.librarySave', 'module.libraryList', 'module.librarySearch', 'module.libraryGet'],
		nativeCapabilities: {
			placeCbbSchematicPage: typeof eda.sch_PrimitiveComponent?.placeCbbSchematicPage === 'function',
			modifySchematicAttribute: typeof eda.sch_PrimitiveAttribute?.modify === 'function',
			getSchematicAttribute: typeof eda.sch_PrimitiveAttribute?.get === 'function',
			modifySchematicWire: typeof eda.sch_PrimitiveWire?.modify === 'function',
			getSchematicWires: typeof eda.sch_PrimitiveWire?.getAll === 'function',
		},
	}
}

function operationError(error: unknown): { message: string, cause?: unknown } {
	const message = error instanceof Error ? error.message : String(error)
	if (error instanceof PcbCompositionError) {
		const op = error.operation
		return { message, cause: { operationId: op.operationId, phase: op.phase, outcome: op.status, partial: op.writeAttempted, writeAttempted: op.writeAttempted, retryable: false } }
	}
	if (error instanceof NativeCopyError || error instanceof FileRestoreError || error instanceof NativePlacementError || error instanceof PcbInstanceImportError)
		return { message, cause: (error as any).operationCause }
	if (error instanceof ModuleExtractionError)
		return { message, cause: { partial: false, retryable: false, outcome: 'not_started' } }
	const cause = (error as any)?.cause
	return { message, ...(cause !== undefined ? { cause } : {}) }
}

export function assertWriteResult(operation: string, result: unknown): void {
	if (!object(result)) {
		if (operation === 'module.executeReplacement')
			fail('换件命令未返回可核验的操作状态，结果未知；先查询原操作记录', { outcome: 'unknown', partial: true, writeAttempted: true, retryable: false })
		return
	}
	const state = typeof result.status === 'string' ? result.status : typeof result.state === 'string' ? result.state : undefined
	if (operation === 'module.extractModuleArchive' && state === 'failed') {
		fail(`模块归档提取失败：${String(result.error ?? '原因未提供')}`, {
			operationId: result.operationId, outcome: 'not_started', partial: false, writeAttempted: false, retryable: false,
		})
	}
	if (operation === 'module.executeReplacement' && state !== 'confirmed') {
		const writeAttempted = result.writeAttempted === true
		const partial = state !== 'not_started'
		fail(`换件操作未能确认完成（${String(state ?? '状态缺失')}${result.phase ? `/${result.phase}` : ''}）：${String(result.error ?? '需先查询原操作记录')}`, {
			operationId: result.operationId, phase: result.phase, outcome: state ?? 'unknown', partial,
			writeAttempted, retryable: result.retryable === true,
		})
	}
	if (!queryOperations.has(operation) && (state === 'partial' || state === 'unknown')) {
		const writeAttempted = result.writeAttempted === true
		fail(`模块复用操作未能确认完成（${state}${result.phase ? `/${result.phase}` : ''}）：${String(result.error ?? '需先读取操作记录')}`, {
			operationId: result.operationId, phase: result.phase, outcome: state,
			partial: state === 'partial' || state === 'unknown', writeAttempted, retryable: result.retryable === true,
		})
	}
}

export async function executeModuleOperation(cmd: string, params: Record<string, any>): Promise<unknown> {
	try {
		if (!isModuleBusinessCommand(cmd) || cmd.startsWith('module.library'))
			fail(`未知模块复用业务指令：${cmd}`)
		const operation = cmd.slice('module.'.length)
		let data: unknown
		if (operation === 'getStatus') {
			data = getStatus()
		}
		else if (operation === 'getContext') {
			if (Object.keys(params).length !== 2 || !('projectUuid' in params) || !('documentUuid' in params)) fail('getContext 仅接受 projectUuid 和 documentUuid')
			if (typeof params.projectUuid !== 'string' || !params.projectUuid.trim()) fail('projectUuid 必须是非空字符串')
			if (typeof params.documentUuid !== 'string' || !params.documentUuid.trim()) fail('documentUuid 必须是非空字符串')
			if (entryBusy || isBusy() || isFileRestoreBusy()) fail('模块复用正处于写入操作中，暂不能读取上下文')
			data = await runEntryBusy(() => getContext(params.projectUuid, params.documentUuid))
		}
		else if (operation === 'capturePair') {
			validateCaptureParams(params)
			data = await runEntryBusy(() => capturePair(params))
		}
		else if (operation === 'captureExtractionSource') {
			validateCaptureExtractionSourceParams(params)
			data = await runEntryBusy(() => captureExtractionSource(params))
		}
		else if (operation === 'extractModuleArchive') {
			validateExtractModuleArchiveParams(params)
			data = await runEntryBusy(() => extractModuleArchive(params))
		}
		else if (operation === 'probeNativeCopy') {
			validateCopyParams(params)
			data = await runEntryBusy(() => probeNativeCopy(params))
		}
		else if (operation === 'getCopyOperation') {
			data = getCopyOperation(copyOperationArgs(params).operationId)
		}
		else if (operation === 'restoreFile') {
			validateFileRestoreParams(params)
			data = await runEntryBusy(() => restoreNativeProjectFile(params))
		}
		else if (operation === 'getRestoreOperation') {
			data = getFileRestoreOperation(fileRestoreOperationArgs(params).operationId)
		}
		else if (operation === 'exportTemplateFile') {
			validateExportTemplateParams(params)
			data = await runEntryBusy(() => exportTemplateFile(params))
		}
		else if (operation === 'placeSchematicPage') {
			validatePlaceSchematicPageParams(params)
			data = await runEntryBusy(() => placeSchematicPage(params))
		}
		else if (operation === 'alignTemplatePcb') {
			validateAlignTemplatePcbParams(params)
			data = await runEntryBusy(() => alignTemplatePcb(params))
		}
		else if (operation === 'mapInstanceNets') {
			validateMapInstanceNetsParams(params)
			data = await runEntryBusy(() => mapInstanceNets(params))
		}
		else if (operation === 'getPlacementOperation') {
			const query = placementOperationArgs(params)
			data = getPlacementOperation(query.operationId, query.targetProjectUuid)
		}
		else if (operation === 'getPcbImportOperation') {
			const query = pcbImportOperationArgs(params)
			data = await getPcbImportOperation(query.operationId, query.targetProjectUuid)
		}
		else if (operation === 'preparePcbComposition') {
			validatePrepareCompositionParams(params)
			data = await runEntryBusy(() => prepareComposition(params))
		}
		else if (operation === 'composePcbInstance') {
			const result = await runEntryBusy(async () => {
				const input = await readPreparedComposition(params)
				return createPcbCompositionService(createPcbCompositionHost()).composePcbInstance(input)
			})
			data = { ...result, stage: 'pcb_composition_readback', netlistVerified: false, saveReloadVerified: false }
		}
		else if (operation === 'getPcbCompositionOperation') {
			if (Object.keys(params).length !== 2 || typeof params.operationId !== 'string' || !params.operationId.trim()
				|| typeof params.projectUuid !== 'string' || !params.projectUuid.trim())
				fail('getPcbCompositionOperation 仅接受非空 operationId 和 projectUuid')
			const result = await createPcbCompositionService(createPcbCompositionHost()).getCompositionOperation(params.operationId)
			if (!result) fail('组合操作记录不存在')
			if (result.projectUuid !== params.projectUuid) fail('组合操作记录属于其他工程')
			data = result
		}
		else if (operation === 'prepareReplacement') {
			data = await runEntryBusy(() => componentReplacementService.prepareReplacement(params))
		}
		else if (operation === 'executeReplacement') {
			data = await runEntryBusy(() => componentReplacementService.executeReplacement(params))
		}
		else if (operation === 'getReplacementOperation') {
			if (typeof params.operationId !== 'string' || !params.operationId.trim() || Object.keys(params).length !== 1) fail('getReplacementOperation 仅接受非空 operationId')
			data = await componentReplacementService.getReplacementOperation(params.operationId)
		}
		else {
			fail(`不支持的模块复用操作：${operation}`)
		}
		assertWriteResult(cmd, data)
		return data
	}
	catch (error) {
		const detail = operationError(error)
		throw new Error(detail.message, detail.cause === undefined ? undefined : { cause: detail.cause })
	}
}

