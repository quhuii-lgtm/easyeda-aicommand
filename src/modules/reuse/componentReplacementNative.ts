export type ReplacementNativeRecord = { type: string; id: string; data: unknown; header: Record<string, unknown> };

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Cross-check a component's expected UID/designator against its native record and direct ATTR children. */
export function assertReplacementComponentIdentity(records: ReplacementNativeRecord[], componentId: string, uid: string, designator: string,
	docType: 'PCB' | 'SCH' | 'SCH_PAGE'): void {
	const components = records.filter(record => record.type === 'COMPONENT' && record.id === componentId);
	if (components.length !== 1 || !isObject(components[0].data)) throw new Error(`${docType} COMPONENT身份记录不存在或不唯一：${componentId}`);
	const component = components[0].data;
	const children = records.filter(record => record.type === 'ATTR' && isObject(record.data) && record.data.parentId === componentId);
	const childValue = (key: string, expected: string, required: boolean) => {
		const matches = children.filter(record => (record.data as Record<string, unknown>).key === key);
		if (matches.length > 1 || (required && matches.length !== 1)) throw new Error(`${docType} ${componentId} 直属${key}属性缺失或重复`);
		if (!matches.length) return;
		if ((matches[0].data as Record<string, unknown>).value !== expected) throw new Error(`${docType} ${componentId} 直属${key}属性与冻结身份不符`);
	};
	const attrsValue = component.attrs;
	if (docType === 'PCB') {
		if (!isObject(attrsValue) || attrsValue['Unique ID'] !== uid) throw new Error(`PCB ${componentId} inline UID缺失或与冻结身份不符`);
		childValue('Unique ID', uid, false);
		childValue('Designator', designator, true);
	} else {
		childValue('Unique ID', uid, true);
		childValue('Designator', designator, true);
		if (attrsValue !== undefined) {
			if (!isObject(attrsValue)) throw new Error(`${docType} ${componentId} inline attrs格式无效`);
			if (Object.hasOwn(attrsValue, 'Unique ID') && attrsValue['Unique ID'] !== uid) throw new Error(`${docType} ${componentId} inline UID与冻结身份不符`);
			if (Object.hasOwn(attrsValue, 'Designator') && attrsValue.Designator !== designator) throw new Error(`${docType} ${componentId} inline位号与冻结身份不符`);
		}
	}
	if (docType === 'PCB' && attrsValue && isObject(attrsValue) && Object.hasOwn(attrsValue, 'Designator') && attrsValue.Designator !== designator)
		throw new Error(`PCB ${componentId} inline位号与直属ATTR不符`);
}

/** Extract one document from an epro2 epru that may contain many concatenated native logs. */
export function extractReplacementNativeDocumentSource(source: string, documentUuid: string, documentType: string): string {
	let active = false;
	const selected: string[] = [];
	for (const [index, line] of source.split(/(?<=\n)/).entries()) {
		const text = line.replace(/[\r\n]+$/, '');
		if (!text.trim()) continue;
		const split = text.indexOf('||'); if (split < 0) throw new Error(`归档源码第 ${index + 1} 行缺少 ||`);
		let header: unknown, data: unknown;
	try {
		header = JSON.parse(text.slice(0, split));
		const payload = text.slice(split + 2).replace(/\|$/, '');
		data = payload === '' ? '' : JSON.parse(payload);
	}
		catch { throw new Error(`归档源码第 ${index + 1} 行 JSON 无效`); }
		if (!isObject(header)) throw new Error(`归档源码第 ${index + 1} 行 header 无效`);
		if (header.type === 'DOCHEAD') {
			active = isObject(data) && data.docType === documentType && data.uuid === documentUuid;
		}
		if (active) selected.push(text);
	}
	if (!selected.length) throw new Error(`归档中找不到 ${documentType}/${documentUuid}`);
	return selected.join('\n');
}

/** Read the effective native record set using the same ticket resolution as the editor. */
export function parseReplacementNativeSource(source: string, documentUuid: string, documentType: 'PCB' | 'SCH' | 'SCH_PAGE') {
	if (!source.trim()) throw new Error(`${documentType} 原生源码为空`);
	const lines = source.split(/\r?\n/), effective = new Map<string, ReplacementNativeRecord>();
	let actualType = '', actualUuid = '';
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		const split = line.indexOf('||'); if (split < 0) throw new Error(`原生源码第 ${index + 1} 行缺少 ||`);
		let header: unknown, data: unknown;
		try {
			header = JSON.parse(line.slice(0, split)); const payload = line.slice(split + 2).replace(/\|$/, ''); data = payload === '' ? '' : JSON.parse(payload);
		} catch { throw new Error(`原生源码第 ${index + 1} 行 JSON 无效`); }
		if (!isObject(header) || typeof header.type !== 'string') throw new Error(`原生源码第 ${index + 1} 行 header 无效`);
		if (header.type === 'DOCHEAD') {
			if (!isObject(data) || typeof data.docType !== 'string' || typeof data.uuid !== 'string') throw new Error('原生 DOCHEAD 缺少 docType/uuid');
			if (actualType && (actualType !== data.docType || actualUuid !== data.uuid)) throw new Error('单文档源码包含多个 DOCHEAD');
			actualType = data.docType; actualUuid = data.uuid; continue;
		}
		if (typeof header.id !== 'string') throw new Error(`原生源码第 ${index + 1} 行缺少 id`);
		const key = `${header.type}\0${header.id}`, prior = effective.get(key);
		if (!prior || Number(header.ticket ?? 0) >= Number(prior.header.ticket ?? 0)) {
			// Keep the winning tombstone's ticket so a later-arriving lower-ticket record cannot resurrect it.
			effective.set(key, { type: header.type, id: header.id, data, header });
		}
	}
	if (actualUuid !== documentUuid || actualType !== documentType)
		throw new Error(`原生源码身份不符：期望 ${documentType}/${documentUuid}，实际 ${actualType}/${actualUuid}`);
	const records = [...effective.values()].filter(record => record.data !== '');
	return { uuid: actualUuid, docType: actualType, records };
}

/** Update only selected effective record payloads while preserving original headers and history. */
export function patchReplacementNativeSource(source: string, documentUuid: string, documentType: 'PCB' | 'SCH' | 'SCH_PAGE',
	updates: Array<{ type: string; id: string; patch: Record<string, unknown> }>): string {
	const parsed = parseReplacementNativeSource(source, documentUuid, documentType);
	const unique = new Set<string>();
	const effectiveLines = new Map<string, { index: number; ticket: number }>();
	const lines: Array<{ text: string; eol: string }> = [];
	for (let offset = 0; offset < source.length;) {
		const newline = source.indexOf('\n', offset), end = newline < 0 ? source.length : newline;
		const cr = end > offset && source[end - 1] === '\r';
		lines.push({ text: source.slice(offset, cr ? end - 1 : end), eol: newline < 0 ? '' : cr ? '\r\n' : '\n' });
		offset = newline < 0 ? source.length : newline + 1;
	}
	for (const [index, line] of lines.entries()) {
		if (!line.text.trim()) continue;
		const sep = line.text.indexOf('||'); if (sep < 0) throw new Error(`原生源码第 ${index + 1} 行缺少 ||`);
		let header: unknown; try { header = JSON.parse(line.text.slice(0, sep)); } catch { throw new Error(`原生源码第 ${index + 1} 行 header JSON 无效`); }
		if (!isObject(header) || typeof header.type !== 'string' || typeof header.id !== 'string' || header.type === 'DOCHEAD') continue;
		const key = `${header.type}\0${header.id}`, ticket = Number(header.ticket ?? 0), previous = effectiveLines.get(key);
		if (!previous || ticket >= previous.ticket) effectiveLines.set(key, { index, ticket });
	}
	for (const item of updates) {
		const key = `${item.type}\0${item.id}`;
		if (unique.has(key)) throw new Error(`同一轮原生补丁包含重复对象：${item.type}/${item.id}`);
		unique.add(key);
		const records = parsed.records.filter(record => record.type === item.type && record.id === item.id);
		if (records.length !== 1 || !isObject(records[0].data)) throw new Error(`${item.type}/${item.id} 原生记录不存在、不唯一或格式错误`);
		const next = { ...records[0].data, ...item.patch };
		const target = effectiveLines.get(key);
		if (!target) throw new Error(`${item.type}/${item.id} 有效源码行不存在`);
		const line = lines[target.index], sep = line.text.indexOf('||'), payload = line.text.slice(sep + 2), terminator = payload.endsWith('|');
		line.text = `${line.text.slice(0, sep + 2)}${JSON.stringify(next)}${terminator ? '|' : ''}`;
	}
	return lines.map(line => line.text + line.eol).join('');
}

