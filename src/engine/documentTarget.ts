import type { DocumentTargetIdentity, ICommandContext } from './types'

/** Capture the identity fields that the SDK actually supplied; do not retain its mutable object. */
export function captureDocumentTarget(document: any): DocumentTargetIdentity {
	const target: DocumentTargetIdentity = {
		documentType: document.documentType,
		uuid: document.uuid,
	}
	if (Object.prototype.hasOwnProperty.call(document, 'tabId') && document.tabId !== undefined)
		target.tabId = document.tabId
	if (Object.prototype.hasOwnProperty.call(document, 'parentProjectUuid') && document.parentProjectUuid !== undefined)
		target.parentProjectUuid = document.parentProjectUuid
	return target
}

/** Re-read host focus and reject if any captured identity field has drifted. */
export async function assertDocumentTarget(
	target: DocumentTargetIdentity,
	stopSignal?: ICommandContext['stopSignal'],
): Promise<void> {
	stopSignal?.assertActive()
	const current = await eda.dmt_SelectControl.getCurrentDocumentInfo()
	stopSignal?.assertActive()
	if (current?.documentType !== target.documentType
		|| current?.uuid !== target.uuid
		|| (target.tabId !== undefined && current?.tabId !== target.tabId)
		|| (target.parentProjectUuid !== undefined && current?.parentProjectUuid !== target.parentProjectUuid)) {
		throw new Error(`当前文档身份已变化（目标=${target.documentType}/${target.uuid}/${String(target.parentProjectUuid ?? '')}/${String(target.tabId ?? '')}，当前=${String(current?.documentType ?? '')}/${String(current?.uuid ?? '')}/${String(current?.parentProjectUuid ?? '')}/${String(current?.tabId ?? '')}）`)
	}
}
