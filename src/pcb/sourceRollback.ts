import { compareDocumentSources } from '../engine/documentRecovery'
import { parseSourceLog } from './sourcelog'

export interface IPcbSourceBackup {
	backupId: string
	pcbUuid: string
	source: string
	createdAt?: string
}

export interface IPcbSourceRollbackApi {
	assertTarget: () => Promise<void>
	assertProject?: () => Promise<void>
	readSource: () => Promise<string | undefined>
	writeSource: (source: string) => Promise<boolean>
	save: () => Promise<unknown>
	getTabs: () => Promise<unknown>
	closeDocument: (tabId: string) => Promise<unknown>
	openDocument: (pcbUuid: string) => Promise<unknown>
	activateDocument: (tabId: string) => Promise<unknown>
	afterCloseConfirmed?: () => void
}

function sourceIdentity(source: string): { docType: string, uuid: string } {
	const document = parseSourceLog(source)
	return { docType: document.docType, uuid: document.uuid }
}

function tabIds(tree: unknown): string[] | undefined {
	const ids: string[] = []
	const walk = (node: any): boolean => {
		if (!node || typeof node !== 'object' || Array.isArray(node))
			return false
		let recognized = false
		for (const key of ['tabs', 'children', 'splitScreens', 'leaves']) {
			if (!Object.hasOwn(node, key))
				continue
			recognized = true
			if (!Array.isArray(node[key]))
				return false
			if (key === 'tabs') {
				for (const tab of node.tabs) {
					if (!tab || typeof tab !== 'object' || typeof tab.tabId !== 'string')
						return false
					ids.push(tab.tabId)
				}
			}
			else if (!node[key].every(walk)) {
				return false
			}
		}
		return recognized
	}
	return walk(tree) ? ids : undefined
}

function partialError(phase: string, message: string, result: Record<string, unknown>): Error {
	return new Error(message, { cause: { partial: true, retryable: false, phase, result } })
}

/** Recover a single PCB document from its existing source backup and prove each stage by readback. */
export async function rollbackPcbSource(
	backup: IPcbSourceBackup,
	pcbUuid: string,
	targetTabId: string | undefined,
	verifyPersistence: boolean,
	api: IPcbSourceRollbackApi,
): Promise<Record<string, unknown>> {
	const result = {
		restored: false,
		contentVerified: false,
		saved: false,
		saveAcknowledged: false,
		persistenceVerified: false,
		backupId: backup.backupId,
		pcbUuid,
		verify: { equal: false } as { equal: boolean, difference?: string, normalizations?: string[] },
		phases: { write: 'not-started', save: 'not-started', close: 'not-started', open: 'not-started' } as Record<string, string>,
	}
	if (!backup.source)
		throw new Error('备份内容为空，已中止')
	let identity: { docType: string, uuid: string }
	try { identity = sourceIdentity(backup.source) }
	catch (error) { throw new Error(`备份源码格式无效，已中止：${error instanceof Error ? error.message : String(error)}`) }
	if (identity.docType !== 'PCB' || identity.uuid !== pcbUuid)
		throw new Error(`备份源码不是目标 PCB（docType=${identity.docType}, uuid=${identity.uuid}；目标=${pcbUuid}），未写入`)
	if (backup.pcbUuid && backup.pcbUuid !== pcbUuid)
		throw new Error(`备份 metadata pcbUuid 与当前 PCB 不符（备份 ${backup.pcbUuid}，当前 ${pcbUuid}），未写入`)

	const call = async <T>(phase: string, operation: () => Promise<T>, guardBefore = true, guardAfter = true): Promise<T> => {
		if (guardBefore)
			await api.assertTarget()
		let value: T
		try { value = await operation() }
		catch (error) {
			try { if (guardAfter) await api.assertTarget() }
			catch (targetError) {
				throw partialError(phase, `${phase}调用结果未知且目标复核失败：${String((error as any)?.message ?? error)}；${String((targetError as any)?.message ?? targetError)}`, { ...result, operationError: String((error as any)?.message ?? error), targetError: String((targetError as any)?.message ?? targetError) })
			}
			throw error
		}
		try { if (guardAfter) await api.assertTarget() }
		catch (error) {
			throw partialError(`${phase}.target`, `${phase}已调用，但目标复核失败：${String((error as any)?.message ?? error)}`, { ...result, sdkResult: value, targetError: String((error as any)?.message ?? error) })
		}
		return value
	}
	const verifyProject = async (phase: string): Promise<void> => {
		try {
			await api.assertProject?.()
		}
		catch (error) {
			throw partialError(phase, `源码已保存，但工程身份/停止信号核验失败；不再继续关闭后操作：${String((error as any)?.message ?? error)}`, { ...result, projectError: String((error as any)?.message ?? error) })
		}
	}

	const currentSource = await call('read-current-source', api.readSource)
	if (!currentSource)
		throw new Error('无法读取当前 PCB 源码，未写入')
	const currentIdentity = sourceIdentity(currentSource)
	if (currentIdentity.docType !== 'PCB' || currentIdentity.uuid !== pcbUuid)
		throw new Error(`当前源码身份不符（${currentIdentity.docType}/${currentIdentity.uuid}，目标 PCB ${pcbUuid}），未写入`)
	const initialComparison = compareDocumentSources(backup.source, currentSource)
	let writeSdkResult: unknown = 'skipped-already-equal'
	let writeError: string | undefined
	if (!initialComparison.equal) {
		result.phases.write = 'invoked-unknown'
		await api.assertTarget()
		try {
			writeSdkResult = await api.writeSource(backup.source)
		}
		catch (error) { writeError = String((error as any)?.message ?? error) }
		try { await api.assertTarget() }
		catch (error) {
			throw partialError('write-source.target', `源码写入调用已发出，但目标复核失败；写入结果未知，未保存/关闭/重开：${String((error as any)?.message ?? error)}`, { ...result, writeSdkResult: writeError ? 'threw' : writeSdkResult, operationError: writeError, targetError: String((error as any)?.message ?? error) })
		}
		result.phases.write = 'readback-pending'
	}
	else {
		result.phases.write = 'skipped-already-equal'
	}

	let readback: string | undefined
	try { readback = await call('readback-source', api.readSource) }
	catch (error) {
		throw partialError('readback-source', `源码写入后的读回结果未知；现场保留，未保存/关闭/重开：${String((error as any)?.message ?? error)}`, { ...result, writeSdkResult })
	}
	if (!readback) {
		throw partialError('readback-source', '源码写入后的读回为空；现场保留，未保存/关闭/重开', { ...result, writeSdkResult: writeError ? 'threw' : writeSdkResult, writeError })
	}
	const contentComparison = compareDocumentSources(backup.source, readback)
	result.verify = { equal: contentComparison.equal, ...(contentComparison.difference ? { difference: contentComparison.difference } : {}), ...(contentComparison.normalizations?.length ? { normalizations: contentComparison.normalizations } : {}) }
	if (!contentComparison.equal)
		throw partialError('readback-source', `恢复源码完整比较不一致：${contentComparison.difference ?? '内容不同'}；现场保留，未保存/关闭/重开`, { ...result, writeSdkResult: writeError ? 'threw' : writeSdkResult, writeError })
	result.contentVerified = true
	result.restored = true
	result.phases.write = initialComparison.equal ? 'skipped-already-equal' : writeSdkResult === true ? 'acknowledged-and-verified' : 'sdk-nontrue-or-threw-but-readback-verified'

	result.phases.save = 'invoked-unknown'
	let saveResult: unknown
	try { saveResult = await call('save', api.save) }
	catch (error) {
		throw partialError('save', `源码已读回吻合，但保存调用结果未知；未关闭/重开：${String((error as any)?.message ?? error)}`, { ...result, saveResult: 'unknown' })
	}
	result.saveAcknowledged = saveResult === true
	result.saved = result.saveAcknowledged
	result.phases.save = result.saveAcknowledged ? 'acknowledged' : 'not-acknowledged'
	if (!result.saveAcknowledged) {
		return { ...result, saveResult, note: '源码内容已在内存读回吻合；save 未返回 true，未关闭/重开，持久性未确认' }
	}
	if (!verifyPersistence)
		return { ...result, saveResult, note: '已取得 save=true；verifyPersistence=false，未关闭/重开，持久性未确认' }

	if (!targetTabId)
		throw partialError('close-preflight', '源码已保存，但未取得目标 tabId；为避免关闭错误页签，未关闭/重开', result)
	result.phases.close = 'invoked-unknown'
	let closeResult: unknown
	try { closeResult = await call('close-document', () => api.closeDocument(targetTabId), true, false) }
	catch (error) {
		throw partialError('close-document', `源码已保存，但 closeDocument 结果未知；未继续重开：${String((error as any)?.message ?? error)}`, { ...result, closeResult: 'unknown' })
	}
	let ids: string[] | undefined
	try {
		await verifyProject('project-after-close')
		ids = tabIds(await call('read-tabs-after-close', api.getTabs, false, false))
		await verifyProject('project-after-tabs')
	}
	catch (error) {
		throw partialError('read-tabs-after-close', `closeDocument 已调用（sdkResult=${String(closeResult)}），但页签状态未知，未重开：${String((error as any)?.message ?? error)}`, { ...result, closeResult, close: 'invoked', tabs: 'unknown' })
	}
	if (!ids)
		throw partialError('read-tabs-after-close', '页签树结构无效，无法确认目标页是否关闭；未重开', { ...result, closeResult, tabs: 'invalid' })
	if (ids.includes(targetTabId))
		throw partialError('read-tabs-after-close', `closeDocument 已调用（sdkResult=${String(closeResult)}），但有效页签树仍包含目标页 ${targetTabId}；未重开`, { ...result, closeResult, tabStillOpen: true })
	result.phases.close = 'confirmed-absent'
	api.afterCloseConfirmed?.()

	result.phases.open = 'invoked-unknown'
	let opened: unknown
	try {
		await verifyProject('project-before-open')
		opened = await call('open-document', () => api.openDocument(pcbUuid), false, false)
		await verifyProject('project-after-open')
	}
	catch (error) {
		throw partialError('open-document', `目标页已确认关闭，但 openDocument 结果未知：${String((error as any)?.message ?? error)}`, { ...result, closeResult, openResult: 'unknown' })
	}
	const reopenedTabId = typeof opened === 'string' ? opened : typeof (opened as any)?.tabId === 'string' ? (opened as any).tabId : undefined
	if (!reopenedTabId)
		throw partialError('open-document', '目标页已确认关闭，但 openDocument 未返回有效 tabId；目标重开未确认', { ...result, closeResult, openResult: opened })
	let activateResult: unknown
	try {
		await verifyProject('project-before-activate')
		activateResult = await call('activate-document', () => api.activateDocument(reopenedTabId), false, true)
		await verifyProject('project-after-activate')
	}
	catch (error) {
		throw partialError('activate-document', `目标页已重开，但 activateDocument 结果未知：${String((error as any)?.message ?? error)}`, { ...result, closeResult, openResult: opened, activateResult: 'unknown' })
	}
	if (activateResult !== true)
		throw partialError('activate-document', `目标页已重开，但激活未获确认（${String(activateResult)}）`, { ...result, closeResult, openResult: opened, activateResult })
	let persistedSource: string | undefined
	try { persistedSource = await call('read-persisted-source', api.readSource) }
	catch (error) {
		throw partialError('read-persisted-source', `目标页已关闭、重开并激活，但持久源码读取结果未知：${String((error as any)?.message ?? error)}`, { ...result, closeResult, openResult: opened, activateResult, readback: 'unknown' })
	}
	if (!persistedSource)
		throw partialError('read-persisted-source', '目标页重开后源码为空，持久性未确认', { ...result, closeResult, openResult: opened, activateResult })
	const persistedComparison = compareDocumentSources(backup.source, persistedSource)
	result.verify = { equal: persistedComparison.equal, ...(persistedComparison.difference ? { difference: persistedComparison.difference } : {}), ...(persistedComparison.normalizations?.length ? { normalizations: persistedComparison.normalizations } : {}) }
	if (!persistedComparison.equal)
		throw partialError('read-persisted-source', `目标页重开后源码不符：${persistedComparison.difference ?? '内容不同'}`, { ...result, closeResult, openResult: opened, activateResult })
	result.persistenceVerified = true
	result.phases.open = 'reopened-and-verified'
	return { ...result, writeSdkResult: writeError ? 'threw' : writeSdkResult, ...(writeError ? { writeError } : {}), saveResult, closeResult, openResult: opened, activateResult }
}
