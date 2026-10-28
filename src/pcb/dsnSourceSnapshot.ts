import { parseSourceLog, type ISourceRecord } from './sourcelog'

export interface PcbSourceSnapshotComparison {
	matches: boolean
	reason: string
	recordIndex?: number
	field?: string
	expected?: unknown
	actual?: unknown
}

interface Difference {
	field: string
	expected: unknown
	actual: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function firstDifference(expected: unknown, actual: unknown, field: string): Difference | undefined {
	if (Object.is(expected, actual))
		return undefined
	if (Array.isArray(expected) && Array.isArray(actual)) {
		const length = Math.min(expected.length, actual.length)
		for (let index = 0; index < length; index++) {
			const difference = firstDifference(expected[index], actual[index], `${field}[${index}]`)
			if (difference)
				return difference
		}
		return expected.length === actual.length
			? undefined
			: { field: `${field}.length`, expected: expected.length, actual: actual.length }
	}
	if (isObject(expected) && isObject(actual)) {
		const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
		for (const key of keys) {
			if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key))
				return { field: `${field}.${key}`, expected: expected[key], actual: actual[key] }
			const difference = firstDifference(expected[key], actual[key], `${field}.${key}`)
			if (difference)
				return difference
		}
		return undefined
	}
	return { field, expected, actual }
}

function payload(record: ISourceRecord): unknown {
	if (record.header.type !== 'DOCHEAD' || !isObject(record.data))
		return record.data
	const copy = { ...record.data }
	delete copy.client
	delete copy.updateTime
	delete copy.version
	return copy
}

function recordLabel(record: ISourceRecord | undefined): string {
	if (!record)
		return '缺少记录'
	return `${String(record.header.type ?? '未知类型')}(${String(record.header.id ?? '无ID')})`
}

function shortValue(value: unknown): string {
	let rendered: string
	try { rendered = JSON.stringify(value) ?? String(value) }
	catch { rendered = String(value) }
	return rendered.length > 120 ? `${rendered.slice(0, 117)}...` : rendered
}

function parseSnapshot(source: string): ReturnType<typeof parseSourceLog> {
	const lines = source.split(/\r?\n/)
	const lastLine = lines.findLastIndex(line => line.trim().length > 0)
	if (lastLine < 0)
		return parseSourceLog(source)
	const finalRecord = lines[lastLine]
	if (!finalRecord.endsWith('|')) {
		const separator = finalRecord.indexOf('||')
		if (separator < 0)
			return parseSourceLog(source)
		// The observed editor response omits only the final record terminator at EOF.
		// Accept that form only after both the complete header and payload parse as JSON.
		JSON.parse(finalRecord.slice(0, separator))
		JSON.parse(finalRecord.slice(separator + 2))
		lines[lastLine] = `${finalRecord}|`
	}
	return parseSourceLog(lines.join('\n'))
}

/** Compare parsed PCB source records, ignoring only volatile DOCHEAD metadata. */
export function comparePcbSourceSnapshots(expectedSource: unknown, actualSource: unknown): PcbSourceSnapshotComparison {
	if (typeof expectedSource !== 'string' || typeof actualSource !== 'string')
		return { matches: false, reason: 'PCB 源码快照必须是字符串' }
	let expected: ReturnType<typeof parseSourceLog>
	let actual: ReturnType<typeof parseSourceLog>
	try { expected = parseSnapshot(expectedSource) }
	catch (error) { return { matches: false, reason: `基准源码解析失败：${error instanceof Error ? error.message : String(error)}` } }
	try { actual = parseSnapshot(actualSource) }
	catch (error) { return { matches: false, reason: `当前源码解析失败：${error instanceof Error ? error.message : String(error)}` } }

	const commonLength = Math.min(expected.records.length, actual.records.length)
	for (let index = 0; index < commonLength; index++) {
		const before = expected.records[index]
		const after = actual.records[index]
		const headerDifference = firstDifference(before.header, after.header, 'header')
		if (headerDifference)
			return {
				matches: false,
				reason: `第 ${index + 1} 条 ${recordLabel(before)} / ${recordLabel(after)} 的 ${headerDifference.field} 不同：${shortValue(headerDifference.expected)} → ${shortValue(headerDifference.actual)}`,
				recordIndex: index,
				...headerDifference,
			}
		const dataDifference = firstDifference(payload(before), payload(after), 'data')
		if (dataDifference)
			return {
				matches: false,
				reason: `第 ${index + 1} 条 ${recordLabel(before)} 的 ${dataDifference.field} 不同：${shortValue(dataDifference.expected)} → ${shortValue(dataDifference.actual)}`,
				recordIndex: index,
				...dataDifference,
			}
	}
	if (expected.records.length !== actual.records.length) {
		const index = commonLength
		return {
			matches: false,
			reason: `第 ${index + 1} 条记录不同：${recordLabel(expected.records[index])} → ${recordLabel(actual.records[index])}`,
			recordIndex: index,
			field: 'record',
			expected: expected.records[index] ? { header: expected.records[index].header, data: expected.records[index].data } : undefined,
			actual: actual.records[index] ? { header: actual.records[index].header, data: actual.records[index].data } : undefined,
		}
	}
	return { matches: true, reason: 'PCB 源码记录相同（忽略 DOCHEAD.client/updateTime/version）' }
}
