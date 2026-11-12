export function createNativeInspector({ hashText } = {}) {
	if (hashText !== undefined && typeof hashText !== 'function')
		throw new Error('hashText must be a function when provided');
const SCHEMA_VERSION = 1;
const NON_EXECUTABLE_REASON = '原生内容检查只提供只读证据，重建覆盖尚未核实';

const KNOWN_DOC_TYPES = new Set([
	'BOARD', 'BLOB', 'CONFIG', 'DEVICE', 'FOOTPRINT', 'PANEL', 'PCB', 'SCH', 'SCH_PAGE', 'SYMBOL',
]);

const KNOWN_RECORD_TYPES = new Set([
	'ACTIVE_LAYER', 'ARC', 'ATTR', 'BLOB', 'CANVAS', 'COMPONENT', 'D3_ATTRIBUTE', 'DOCHEAD',
	'ELE_PLACEHOLDER', 'LAYER', 'LAYER_PHYS', 'LINE', 'META', 'NET', 'OBJ', 'PAD', 'PAD_NET',
	'PANELIZE', 'PART', 'PIN', 'POLY', 'POUR', 'POURED', 'PREFERENCE', 'PRIMITIVE', 'RULE',
	'RULE_SELECTOR', 'RULE_TEMPLATE', 'SHEET', 'SILK_OPTS', 'TABLE', 'TEXT', 'UNIVERSAL', 'VIA', 'WIRE',
]);

function isObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
	throw new Error(message);
}

function canonical(value) {
	if (Array.isArray(value))
		return `[${value.map(canonical).join(',')}]`;
	if (isObject(value)) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function requireInput(input) {
	if (!isObject(input))
		fail('输入必须是对象');
	if (!isObject(input.projectMetadata) || Object.keys(input.projectMetadata).length === 0)
		fail('projectMetadata 必须是非空 project2 对象');
	if (typeof input.source !== 'string' || !input.source.trim())
		fail('source 必须是非空 epru 字符串');
}

function parseLine(raw, line) {
	const separator = raw.indexOf('||');
	if (separator < 0)
		fail(`第 ${line} 行缺少 || 分隔符`);

	const rawHeader = raw.slice(0, separator);
	let rawData = raw.slice(separator + 2);
	if (rawData.endsWith('|'))
		rawData = rawData.slice(0, -1);
	let header;
	let data;
	try {
		header = JSON.parse(rawHeader);
		// Native epro2 tombstones may encode an empty payload as a trailing pipe
		// with no JSON text. Keep rawData untouched for evidence and hash stability.
		data = rawData === '' ? '' : JSON.parse(rawData);
	}
	catch (error) {
		fail(`第 ${line} 行 JSON 无效：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isObject(header))
		fail(`第 ${line} 行 header 必须是对象`);
	if (typeof header.type !== 'string' || !header.type.trim())
		fail(`第 ${line} 行 header.type 必须是非空字符串`);

	return { header, data, rawHeader, rawData, raw, line };
}

function validateDocHead(record) {
	if (record.header.ticket !== undefined
		&& (!Number.isSafeInteger(record.header.ticket) || record.header.ticket < 0))
		fail(`第 ${record.line} 行 DOCHEAD ticket 非法`);
	if (!isObject(record.data))
		fail(`第 ${record.line} 行 DOCHEAD data 必须是对象`);
	if (typeof record.data.docType !== 'string' || !record.data.docType.trim())
		fail(`第 ${record.line} 行 DOCHEAD.docType 缺失或非法`);
	if (typeof record.data.uuid !== 'string' || !record.data.uuid.trim())
		fail(`第 ${record.line} 行 DOCHEAD.uuid 缺失或非法`);
}

function validateContentRecord(record) {
	if (!Number.isSafeInteger(record.header.ticket) || record.header.ticket <= 0)
		fail(`第 ${record.line} 行 ${record.header.type} ticket 必须是正安全整数`);
}

function countByType(records) {
	const counts = Object.create(null);
	for (const record of records)
		counts[record.header.type] = (counts[record.header.type] ?? 0) + 1;
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function replayDocument(doc, unsupported, hashText) {
	const latest = new Map();
	const tickets = new Map();
	const versionSignatures = new Map();
	for (const record of doc.rawRecords) {
		const type = record.header.type;
		const id = record.header.id;
		if (!KNOWN_RECORD_TYPES.has(type)) {
			unsupported.push({ kind: 'recordType', docType: doc.docType, docUuid: doc.uuid, type, id, line: record.line, observedRecord: record });
		}
		if (typeof id !== 'string' || !id.trim()) {
			unsupported.push({ kind: 'recordIdentity', docType: doc.docType, docUuid: doc.uuid, type, id, line: record.line, reason: '缺少非空字符串 id，原始记录保留但不参与可靠重放', observedRecord: record });
			continue;
		}
		const key = JSON.stringify([type, id]);
		const ticket = record.header.ticket;
		let versions = versionSignatures.get(key);
		if (!versions) {
			versions = new Map();
			versionSignatures.set(key, versions);
		}
		const signature = canonical({ header: record.header, data: record.data });
		if (versions.has(ticket) && versions.get(ticket).signature !== signature)
			fail(`第 ${record.line} 行与第 ${versions.get(ticket).line} 行在 ${type}/${id} 上发生同 ticket 冲突`);
		if (!versions.has(ticket))
			versions.set(ticket, { signature, line: record.line });
		const priorTicket = tickets.get(key);
		if (priorTicket === ticket) {
			continue;
		}
		if (priorTicket === undefined || ticket > priorTicket) {
			tickets.set(key, ticket);
			latest.set(key, record);
		}
	}

	const latestRecords = [...latest.values()].sort((a, b) => a.line - b.line).map(record => ({
		...record,
		deleted: record.data === '',
	}));
	const effectiveRecords = latestRecords.filter(record => !record.deleted);
	const docHashInput = doc.rawLines.map(record => record.raw).join('\n');
	const rawDocumentHash = hashText ? hashText(docHashInput) : undefined;
	return {
		docType: doc.docType,
		uuid: doc.uuid,
		docHead: doc.docHead,
		docHeads: doc.docHeads,
		rawRecordCount: doc.rawRecords.length,
		effectiveRecordCount: effectiveRecords.length,
		rawCountByType: countByType(doc.rawRecords),
		effectiveCountByType: countByType(effectiveRecords),
		counts: {
			docHead: 1,
			rawRecords: doc.rawRecords.length,
			effectiveRecords: effectiveRecords.length,
			rawByType: countByType(doc.rawRecords),
			effectiveByType: countByType(effectiveRecords),
		},
		...(rawDocumentHash !== undefined ? { rawDocumentHash } : {}),
		rawRecords: doc.rawRecords,
		latestRecords,
		effectiveRecords,
	};
}

function observedReferences(documents) {
	const byUuid = new Map(documents.map(doc => [doc.uuid, doc.docType]));
	const references = [];
	for (const doc of documents) {
		for (const record of doc.effectiveRecords) {
			if (!isObject(record.data))
				continue;
			const fieldNames = doc.docType === 'BOARD'
				? ['schematic', 'pcb']
				: (doc.docType === 'SCH' || doc.docType === 'PCB') ? ['board'] : [];
			for (const field of fieldNames) {
				const uuid = record.data[field];
				if (typeof uuid !== 'string' || !uuid.trim())
					continue;
				references.push({
					from: { docType: doc.docType, uuid: doc.uuid, recordType: record.header.type, recordId: record.header.id, line: record.line },
					field,
					observedUuid: uuid,
					observedTargetDocType: byUuid.get(uuid) ?? null,
					verified: false,
				});
			}
		}
	}
	return references;
}

function inspectNativeProject(input) {
	requireInput(input);
	const lines = input.source.split(/\r?\n/);
	const partitions = [];
	const documentsByUuid = new Map();
	let current;
	let currentSegmentRecordCount = 0;
	for (const [index, line] of lines.entries()) {
		if (!line.trim())
			continue;
		const record = parseLine(line, index + 1);
		if (record.header.type === 'DOCHEAD') {
			validateDocHead(record);
			if (current && currentSegmentRecordCount === 0)
				fail(`第 ${current.docHead.line} 行 DOCHEAD 对应空文档`);
			const prior = documentsByUuid.get(record.data.uuid);
			if (prior) {
				if (prior.docType !== record.data.docType)
					fail(`DOCHEAD.uuid ${record.data.uuid} 的 docType 冲突：${prior.docType} / ${record.data.docType}`);
				current = prior;
				current.docHeads.push(record);
				current.rawLines.push(record);
			}
			else {
				current = { docType: record.data.docType, uuid: record.data.uuid, docHead: record, docHeads: [record], rawRecords: [], rawLines: [record] };
				documentsByUuid.set(record.data.uuid, current);
				partitions.push(current);
			}
			currentSegmentRecordCount = 0;
			continue;
		}
		if (!current)
			fail(`第 ${record.line} 行位于首个 DOCHEAD 之前`);
		validateContentRecord(record);
		current.rawRecords.push(record);
		current.rawLines.push(record);
		currentSegmentRecordCount++;
	}
	if (!partitions.length)
		fail('source 不包含 DOCHEAD 文档');
	if (currentSegmentRecordCount === 0)
		fail(`第 ${current.docHeads.at(-1).line} 行 DOCHEAD 对应空文档`);

	const unsupported = [];
	const documents = partitions.map(doc => {
		if (!KNOWN_DOC_TYPES.has(doc.docType))
			unsupported.push({ kind: 'docType', docType: doc.docType, docUuid: doc.uuid, line: doc.docHead.line, observedDocHead: doc.docHead });
		return replayDocument(doc, unsupported, hashText);
	});
	const rawByType = Object.create(null);
	const effectiveByType = Object.create(null);
	for (const doc of documents) {
		for (const [type, count] of Object.entries(doc.rawCountByType))
			rawByType[type] = (rawByType[type] ?? 0) + count;
		for (const [type, count] of Object.entries(doc.effectiveCountByType))
			effectiveByType[type] = (effectiveByType[type] ?? 0) + count;
	}
	const rawRecordCount = documents.reduce((sum, doc) => sum + doc.rawRecordCount, 0);
	const effectiveRecordCount = documents.reduce((sum, doc) => sum + doc.effectiveRecordCount, 0);
	const projectMetadataHash = hashText ? hashText(canonical(input.projectMetadata)) : undefined;
	const sourceHash = hashText ? hashText(input.source) : undefined;
	return {
		schema: SCHEMA_VERSION,
		projectMetadata: input.projectMetadata,
		...(projectMetadataHash !== undefined ? { projectMetadataHash } : {}),
		...(sourceHash !== undefined ? { sourceHash } : {}),
		parserCoverageOnly: true,
		reconstructionCoverageVerified: false,
		executable: false,
		reason: NON_EXECUTABLE_REASON,
		documentCount: documents.length,
		rawRecordCount,
		effectiveRecordCount,
		counts: {
			documents: documents.length,
			docHeads: documents.reduce((sum, doc) => sum + doc.docHeads.length, 0),
			rawRecords: rawRecordCount,
			effectiveRecords: effectiveRecordCount,
			rawByType: Object.fromEntries(Object.entries(rawByType).sort(([a], [b]) => a.localeCompare(b))),
			effectiveByType: Object.fromEntries(Object.entries(effectiveByType).sort(([a], [b]) => a.localeCompare(b))),
		},
		documents,
		unsupported,
	};
}

function createPairInspection(input) {
	if (!isObject(input))
		fail('输入必须是对象');
	if (typeof input.schematicPageUuid !== 'string' || !input.schematicPageUuid.trim())
		fail('schematicPageUuid 必须是非空字符串');
	if (typeof input.pcbUuid !== 'string' || !input.pcbUuid.trim())
		fail('pcbUuid 必须是非空字符串');
	const inspection = inspectNativeProject(input);
	const schematicMatches = inspection.documents.filter(doc => doc.uuid === input.schematicPageUuid);
	const pcbMatches = inspection.documents.filter(doc => doc.uuid === input.pcbUuid);
	if (schematicMatches.length !== 1)
		fail(`找不到唯一的指定原理图图页 UUID：${input.schematicPageUuid}`);
	if (schematicMatches[0].docType !== 'SCH_PAGE')
		fail(`指定 schematicPageUuid 的 DOCHEAD 类型错误：${schematicMatches[0].docType}`);
	if (pcbMatches.length !== 1)
		fail(`找不到唯一的指定 PCB UUID：${input.pcbUuid}`);
	if (pcbMatches[0].docType !== 'PCB')
		fail(`指定 pcbUuid 的 DOCHEAD 类型错误：${pcbMatches[0].docType}`);
	const pairRawDocumentHash = hashText && schematicMatches[0].rawDocumentHash !== undefined && pcbMatches[0].rawDocumentHash !== undefined
		? hashText(`${schematicMatches[0].rawDocumentHash}\n${pcbMatches[0].rawDocumentHash}`)
		: undefined;
	return {
		...inspection,
		kind: 'pairInspection',
		schematicPageUuid: input.schematicPageUuid,
		pcbUuid: input.pcbUuid,
		selectedDocuments: [schematicMatches[0], pcbMatches[0]],
		...(pairRawDocumentHash !== undefined ? { pairRawDocumentHash } : {}),
		pairAssociationVerified: false,
		observedReferences: observedReferences(inspection.documents),
		executable: false,
		reason: NON_EXECUTABLE_REASON,
	};
}

	return {
		inspectNativeProject: input => inspectNativeProject(input),
		createPairInspection: input => createPairInspection(input),
	};
}
