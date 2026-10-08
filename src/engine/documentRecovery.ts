/**
 * Shared full-document snapshot and recovery for destructive command handlers.
 * This intentionally does not promise recovery after an extension/process crash.
 */
import { parseSourceLog } from '../pcb/sourcelog'

export interface IDocumentSnapshot {
	documentUuid: string
	documentType: number
	command: string
	source: string
	storageKey: string
}

export type TDocumentWrite = <T>(action: () => Promise<T>, beforeWrite?: () => void) => Promise<T>

export interface IDocumentSourceComparison {
	equal: boolean
	difference?: string
	normalizations?: string[]
}

const EMPTY_NET_TOLERANCE_NORMALIZATION = 'PCB empty-net default NET_LENGTH_TOLERANCE'
const DEFAULT_NET_TOLERANCE = ['default', null]

function orderedValue(value: any): any {
	if (Array.isArray(value))
		return value.map(orderedValue)
	if (value && typeof value === 'object') {
		const result = Object.create(null) as Record<string, unknown>
		for (const key of Object.keys(value).sort())
			result[key] = orderedValue(value[key])
		return result
	}
	return value
}

function firstDifference(expected: any, actual: any, path: string): string | undefined {
	if (Object.is(expected, actual))
		return undefined
	if (Array.isArray(expected) && Array.isArray(actual)) {
		if (expected.length !== actual.length)
			return `${path}.length (${expected.length} != ${actual.length})`
		for (let i = 0; i < expected.length; i++) {
			const difference = firstDifference(expected[i], actual[i], `${path}[${i}]`)
			if (difference)
				return difference
		}
		return undefined
	}
	if (Array.isArray(expected) !== Array.isArray(actual))
		return `${path} (array/object shape differs)`
	if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
		const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
		for (const key of keys) {
			if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key))
				return `${path}.${key} (${Object.hasOwn(expected, key) ? 'missing in readback' : 'added in readback'})`
			const difference = firstDifference(expected[key], actual[key], `${path}.${key}`)
			if (difference)
				return difference
		}
		return undefined
	}
	return `${path} (${JSON.stringify(expected)} != ${JSON.stringify(actual)})`
}

function recordIdentity(record: ReturnType<typeof parseSourceLog>['records'][number]): string | undefined {
	const { type, id } = record.header
	if (type === 'DOCHEAD' && id == null)
		return 'DOCHEAD\u0000<document-head>'
	if (typeof type !== 'string' || (typeof id !== 'string' && typeof id !== 'number'))
		return undefined
	return `${type}\u0000${typeof id}:${String(id)}`
}

function isEmptyNetRuleSelector(record: ReturnType<typeof parseSourceLog>['records'][number]): boolean {
	if (record.header.type !== 'RULE_SELECTOR' || typeof record.header.id !== 'string')
		return false
	try {
		const id = JSON.parse(record.header.id)
		return Array.isArray(id)
			&& id.length === 2
			&& id[0] === 'RULE_SELECTOR'
			&& Array.isArray(id[1])
			&& id[1].length === 2
			&& id[1][0] === 'NET'
			&& id[1][1] === ''
	}
	catch {
		return false
	}
}

/**
 * Compare complete document contents while allowing only known source-log reserialization:
 * DOCHEAD client/updateTime/version, record ticket and line/object-key order.
 * Ambiguous identities and malformed logs compare equal only on exact string identity. That result
 * does not validate the log format; callers requiring a valid source must parse it separately.
 */
export function compareDocumentSources(expectedSource: string, actualSource: string): IDocumentSourceComparison {
	if (expectedSource === actualSource)
		return { equal: true, normalizations: [] }
	let expected: ReturnType<typeof parseSourceLog>
	let actual: ReturnType<typeof parseSourceLog>
	try {
		expected = parseSourceLog(expectedSource)
		actual = parseSourceLog(actualSource)
	}
	catch (error) {
		return { equal: false, difference: `invalid source log: ${messageOf(error)}` }
	}
	if (expected.uuid !== actual.uuid || expected.docType !== actual.docType)
		return { equal: false, difference: `DOCHEAD identity differs (docType/uuid)` }

	const indexRecords = (document: typeof expected) => {
		const indexed = new Map<string, typeof document.records[number]>()
		for (const record of document.records) {
			const key = recordIdentity(record)
			if (!key || indexed.has(key))
				return undefined
			indexed.set(key, record)
		}
		return indexed
	}
	const expectedRecords = indexRecords(expected)
	const actualRecords = indexRecords(actual)
	if (!expectedRecords || !actualRecords)
		return { equal: false, difference: 'ambiguous or missing record identity; exact source equality required' }
	const normalizations: string[] = []
	const keys = [...new Set([...expectedRecords.keys(), ...actualRecords.keys()])].sort()
	for (const key of keys) {
		const left = expectedRecords.get(key)
		const right = actualRecords.get(key)
		const label = key.split('\u0000').join(': ')
		if (!left || !right)
			return { equal: false, difference: `record ${label} ${left ? 'missing in readback' : 'added in readback'}` }
		const header = (record: typeof left) => {
			const copy = { ...record.header }
			delete copy.ticket
			return orderedValue(copy)
		}
		const headerDifference = firstDifference(header(left), header(right), `record ${label} header`)
		if (headerDifference)
			return { equal: false, difference: headerDifference }
		const data = (record: typeof left) => {
			if (record.header.type !== 'DOCHEAD' || !record.data || typeof record.data !== 'object')
				return orderedValue(record.data)
			const copy = { ...record.data as Record<string, unknown> }
			delete copy.client
			delete copy.updateTime
			delete copy.version
			return orderedValue(copy)
		}
		const expectedData = data(left)
		const actualData = data(right)
		if (expected.docType === 'PCB' && isEmptyNetRuleSelector(left)) {
			const expectedRuleKeys = expectedData && typeof expectedData === 'object' ? expectedData.ruleKeyValue : undefined
			const actualRuleKeys = actualData && typeof actualData === 'object' ? actualData.ruleKeyValue : undefined
			const key = 'NET_LENGTH_TOLERANCE'
			if (expectedRuleKeys && actualRuleKeys
				&& typeof expectedRuleKeys === 'object' && !Array.isArray(expectedRuleKeys)
				&& typeof actualRuleKeys === 'object' && !Array.isArray(actualRuleKeys)
				&& !Object.hasOwn(expectedRuleKeys, key)
				&& Object.hasOwn(actualRuleKeys, key)
				&& Array.isArray(actualRuleKeys[key])
				&& actualRuleKeys[key].length === DEFAULT_NET_TOLERANCE.length
				&& actualRuleKeys[key][0] === DEFAULT_NET_TOLERANCE[0]
				&& actualRuleKeys[key][1] === DEFAULT_NET_TOLERANCE[1]) {
				delete actualRuleKeys[key]
				normalizations.push(EMPTY_NET_TOLERANCE_NORMALIZATION)
			}
		}
		const dataDifference = firstDifference(expectedData, actualData, `record ${label} data`)
		if (dataDifference)
			return { equal: false, difference: dataDifference }
	}
	return { equal: true, normalizations }
}

function recoveryCredential(snapshot: IDocumentSnapshot) {
	return {
		documentUuid: snapshot.documentUuid,
		storageKey: snapshot.storageKey,
		source: snapshot.source,
	}
}

function messageOf(error: unknown): string {
	if (error instanceof Error)
		return error.message
	try { return JSON.stringify(error) ?? String(error) }
	catch { return String(error) }
}

async function currentDocument(): Promise<any> {
	return await eda.dmt_SelectControl.getCurrentDocumentInfo()
}

/** Read and persist an exact source snapshot, requiring focus and SDK storage readback before writes. */
export async function captureDocumentSnapshot(command: string, documentType: number): Promise<IDocumentSnapshot> {
	const before = await currentDocument()
	if (!before?.uuid || before.documentType !== documentType)
		throw new Error(`快照前焦点文档类型或 UUID 无效（${command}）`)
	const source = await eda.sys_FileManager.getDocumentSource()
	if (typeof source !== 'string' || !source.trim())
		throw new Error(`无法取得非空文档源码，已拒绝执行 ${command}`)
	const parsed = parseSourceLog(source)
	if (parsed.uuid !== before.uuid)
		throw new Error(`源码 UUID 与焦点文档不一致（${command}），已拒绝执行`)
	const after = await currentDocument()
	if (after?.uuid !== before.uuid || after?.documentType !== documentType)
		throw new Error(`读取快照期间焦点文档发生变化（${command}），已拒绝执行`)

	const storageKey = `ai-command-engine:destructive-recovery:${command}:${before.uuid}`

	const snapshot: IDocumentSnapshot = {
		documentUuid: before.uuid,
		documentType,
		command,
		source,
		storageKey,
	}
	const stored = JSON.stringify({ schema: 1, command, documentUuid: before.uuid, source })
	let writeOk = false
	try { writeOk = await eda.sys_Storage.setExtensionUserConfig(storageKey, stored) === true }
	catch (error) { throw new Error(`持久化恢复快照失败，已拒绝执行 ${command}：${messageOf(error)}`) }
	if (!writeOk)
		throw new Error(`持久化恢复快照返回 false，已拒绝执行 ${command}`)
	let storedBack: any
	try { storedBack = eda.sys_Storage.getExtensionUserConfig(storageKey) }
	catch (error) { throw new Error(`回读恢复快照失败，已拒绝执行 ${command}：${messageOf(error)}`) }
	if (storedBack !== stored)
		throw new Error(`恢复快照回读不匹配，已拒绝执行 ${command}`)
	return snapshot
}

/** Refuse to write unless the exact document captured by the snapshot still has focus. */
export async function assertSnapshotFocused(snapshot: IDocumentSnapshot): Promise<void> {
	const focus = await currentDocument()
	if (focus?.uuid !== snapshot.documentUuid || focus?.documentType !== snapshot.documentType)
		throw new Error(`焦点文档已变化，已拒绝向目标文档写入（${snapshot.documentUuid}）`)
}

/**
 * Run a sequence of guarded writes. Any attempted write marks the document as possibly changed,
 * because a rejected SDK promise can still have partially applied. A later failure restores the
 * complete original source and verifies content-equivalent readback; new primitive IDs are never rolled back.
 */
export async function withDocumentRecovery<T>(
	snapshot: IDocumentSnapshot,
	operation: (write: TDocumentWrite) => Promise<T>,
): Promise<T> {
	let mayHaveWritten = false
	const write: TDocumentWrite = async <R>(action: () => Promise<R>, beforeWrite?: () => void): Promise<R> => {
		await assertSnapshotFocused(snapshot)
		mayHaveWritten = true
		beforeWrite?.()
		return await action()
	}

	try {
		const result = await operation(write)
		await assertSnapshotFocused(snapshot)
		return result
	}
	catch (operationError) {
		if (!mayHaveWritten)
			throw operationError

		let restoreError: unknown
		let restoreSucceeded = false
		let restoreNormalizations: string[] = []
		try {
			await assertSnapshotFocused(snapshot)
			const restored = await eda.sys_FileManager.setDocumentSource(snapshot.source)
			if (restored !== true)
				throw new Error('恢复 setDocumentSource 未返回 true')
			await assertSnapshotFocused(snapshot)
			const readback = await eda.sys_FileManager.getDocumentSource()
			await assertSnapshotFocused(snapshot)
			if (typeof readback !== 'string' || !readback.trim())
				throw new Error('恢复源码回读为空')
			const comparison = compareDocumentSources(snapshot.source, readback)
			if (!comparison.equal)
				throw new Error(`恢复源码回读与原快照内容不一致：${comparison.difference ?? 'unknown difference'}`)
			restoreNormalizations = comparison.normalizations ?? []
			const parsed = parseSourceLog(readback)
			if (parsed.uuid !== snapshot.documentUuid)
				throw new Error('恢复源码 UUID 与原文档不一致')
			restoreSucceeded = true
		}
		catch (error) {
			restoreError = error
		}

		if (restoreSucceeded) {
			throw new Error(`操作失败，原文档内容已整页恢复：${messageOf(operationError)}`, {
				cause: {
					restored: true,
					contentRestored: true,
					retryable: true,
					operationError: messageOf(operationError),
					normalizations: restoreNormalizations,
					recovery: recoveryCredential(snapshot),
				},
			})
		}
		throw new Error(`操作失败且原文档整页恢复未确认：${messageOf(operationError)}；恢复错误：${messageOf(restoreError)}`, {
			cause: {
				partial: true,
				restored: false,
				retryable: false,
				operationError: messageOf(operationError),
				recoveryError: messageOf(restoreError),
				recovery: recoveryCredential(snapshot),
			},
		})
	}
}
