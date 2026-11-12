type JsonObject = Record<string, unknown>;

type SourceRecord = {
	header: JsonObject;
	data: unknown;
	lineIndex: number;
	line: string;
};

type ParsedSource = {
	uuid: string;
	docType: string;
	records: SourceRecord[];
	effective: Map<string, SourceRecord>;
	maxTicket: number;
};

export type FootprintResourceSource = {
	/** 原样的完整封装引用值；引用按不透明字符串处理。 */
	footprintUuid: string;
	documentSource: string;
};

export type FootprintRestorePlan = {
	schema: 1;
	templateUuid: string;
	targetUuid: string;
	templateSourceSha256: string;
	targetSourceSha256: string;
	noOp: boolean;
	changes: Array<{
		sourceUid: string;
		expectedTargetUid: string;
		sourceComponentId: string;
		targetComponentId: string;
		targetAttributeId: string;
		beforeReference: string;
		afterReference: string;
		resource: { documentUuid: string; docType: string; effectiveRecordCount: number; sourceSha256: string };
	}>;
};

export type PcbInstanceStateRestorePlan = {
	schema: 1;
	targetUuid: string;
	targetSourceSha256: string;
	changes: Array<{
		targetUid: string;
		targetComponentId: string;
		field: 'locked' | 'Footprint.specialColor';
		targetAttributeId?: string;
		sourceColorBound?: boolean;
		beforeValue: unknown;
		afterValue: unknown;
	}>;
};

function fail(message: string): never {
	throw new Error(message);
}

function object(value: unknown): value is JsonObject {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim())
		fail(`${name} 必须是非空字符串`);
	return value;
}

function keyOf(record: SourceRecord): string {
	return `${String(record.header.type)}\u0000${String(record.header.id ?? '')}`;
}

function parseSource(source: unknown, expectedUuid: string | undefined, expectedDocType: string): ParsedSource {
	if (typeof source !== 'string' || !source)
		fail(`${expectedDocType} 源码为空`);
	const records: SourceRecord[] = [];
	const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
	let maxTicket = 0;
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		if (!line || !line.replace(/[\r\n]+$/, '').trim())
			continue;
		const content = line.replace(/[\r\n]+$/, '');
		const separator = content.indexOf('||');
		if (separator < 0)
			fail(`${expectedDocType} 源码第 ${lineIndex + 1} 行缺少 ||`);
		let header: unknown;
		let data: unknown;
		try {
			header = JSON.parse(content.slice(0, separator));
			let dataText = content.slice(separator + 2);
			if (dataText.endsWith('|'))
				dataText = dataText.slice(0, -1);
			// Host source logs encode a deletion either as JSON "" or as an empty payload (|||).
			data = dataText === '' ? '' : JSON.parse(dataText);
		}
		catch {
			fail(`${expectedDocType} 源码第 ${lineIndex + 1} 行不是有效 JSON`);
		}
		if (!object(header) || typeof header.type !== 'string' || !header.type.trim())
			fail(`${expectedDocType} 源码第 ${lineIndex + 1} 行的 header 无效`);
		if (header.type !== 'DOCHEAD' && (typeof header.id !== 'string' || !header.id.trim()))
			fail(`${expectedDocType} 源码第 ${lineIndex + 1} 行缺少 id`);
		if (header.ticket !== undefined && (typeof header.ticket !== 'number' || !Number.isFinite(header.ticket)))
			fail(`${expectedDocType} 源码第 ${lineIndex + 1} 行 ticket 无效`);
		maxTicket = Math.max(maxTicket, Number(header.ticket ?? 0));
		records.push({ header, data, lineIndex, line });
	}
	const docHeads = records.filter(record => record.header.type === 'DOCHEAD');
	if (docHeads.length < 1 || docHeads.some(record => !object(record.data)
		|| typeof record.data.uuid !== 'string' || !record.data.uuid.trim()
		|| typeof record.data.docType !== 'string' || !record.data.docType.trim()
		|| record.data.uuid !== (object(docHeads[0]?.data) ? docHeads[0].data.uuid : undefined)
		|| record.data.docType !== (object(docHeads[0]?.data) ? docHeads[0].data.docType : undefined))
		|| !object(docHeads[0]?.data)
		|| (expectedUuid !== undefined && docHeads[0].data.uuid !== expectedUuid)
		|| docHeads[0].data.docType !== expectedDocType)
		fail(`DOCHEAD 与指定身份不符：期望 ${expectedDocType}/${expectedUuid ?? '从源码读回'}`);
	const highestByKey = new Map<string, SourceRecord>();
	for (const record of records) {
		if (record.header.type === 'DOCHEAD')
			continue;
		const key = keyOf(record);
		const previous = highestByKey.get(key);
		if (!previous || Number(record.header.ticket ?? 0) >= Number(previous.header.ticket ?? 0)) {
			highestByKey.set(key, record);
		}
	}
	const effective = new Map<string, SourceRecord>();
	for (const [key, record] of highestByKey) {
		if (record.data !== '')
			effective.set(key, record);
	}
	return { uuid: docHeads[0].data.uuid as string, docType: expectedDocType, records, effective, maxTicket };
}

function effectiveByType(parsed: ParsedSource, type: string): SourceRecord[] {
	return [...parsed.effective.values()].filter(record => record.header.type === type);
}

function childAttributes(parsed: ParsedSource, parentId: string, key: string): SourceRecord[] {
	return effectiveByType(parsed, 'ATTR').filter(record => object(record.data)
		&& record.data.parentId === parentId && record.data.key === key);
}

async function digest(source: string): Promise<string> {
	if (!globalThis.crypto?.subtle)
		fail('当前环境不提供 SHA-256 摘要能力');
	const bytes = new TextEncoder().encode(source);
	const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function componentUniqueId(record: SourceRecord): string {
	if (!object(record.data) || !object(record.data.attrs))
		return '';
	return typeof record.data.attrs['Unique ID'] === 'string' ? record.data.attrs['Unique ID'] as string : '';
}

function resourceSource(resources: FootprintResourceSource[], reference: string): { source: string; parsed: ParsedSource } {
	const matches = resources.filter(resource => resource?.footprintUuid === reference);
	if (matches.length !== 1)
		fail(matches.length === 0 ? `缺少原生封装资源：${reference}` : `原生封装资源引用重复：${reference}`);
	const source = matches[0].documentSource;
	if (typeof source !== 'string' || !source)
		fail(`原生封装资源内容为空：${reference}`);
	const lines = source.match(/[^\n]*(?:\n|$)/g) ?? [];
	const heads: Array<{ lineIndex: number; uuid: string; docType: string }> = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const content = lines[lineIndex].replace(/[\r\n]+$/, '');
		if (!content.trim()) continue;
		const separator = content.indexOf('||');
		if (separator < 0) fail(`原生封装资源 ${reference} 第 ${lineIndex + 1} 行缺少 ||`);
		let header: unknown;
		let data: unknown;
		try {
			header = JSON.parse(content.slice(0, separator));
			let text = content.slice(separator + 2);
			if (text.endsWith('|')) text = text.slice(0, -1);
			data = text === '' ? '' : JSON.parse(text);
		}
		catch { fail(`原生封装资源 ${reference} 第 ${lineIndex + 1} 行无效`); }
		if (!object(header) || typeof header.type !== 'string') fail(`原生封装资源 ${reference} header 无效`);
		if (header.type !== 'DOCHEAD' && (typeof header.id !== 'string' || !header.id.trim()))
			fail(`原生封装资源 ${reference} 第 ${lineIndex + 1} 行缺少 id`);
		if (header.ticket !== undefined && (typeof header.ticket !== 'number' || !Number.isFinite(header.ticket)))
			fail(`原生封装资源 ${reference} 第 ${lineIndex + 1} 行 ticket 无效`);
		if (header.type === 'DOCHEAD') {
			if (!object(data) || typeof data.uuid !== 'string' || !data.uuid.trim() || typeof data.docType !== 'string' || !data.docType.trim())
				fail(`原生封装资源 ${reference} 的 DOCHEAD 无效`);
			heads.push({ lineIndex, uuid: data.uuid, docType: data.docType });
		}
	}
	const exactHeads = heads.filter(head => head.uuid === reference && head.docType === 'FOOTPRINT');
	const identities = new Map(heads.map(head => [`${head.docType}\u0000${head.uuid}`, head]));
	let identity: { uuid: string; docType: string } | undefined = exactHeads[0];
	if (!identity) {
		if (identities.size !== 1 || heads[0]?.docType !== 'FOOTPRINT')
			fail(`多文档原生封装内容中找不到与资源键匹配的 FOOTPRINT DOCHEAD：${reference}`);
		identity = heads[0];
	}
	const sections: string[] = [];
	for (let index = 0; index < heads.length; index++) {
		const head = heads[index];
		if (head.uuid !== identity.uuid || head.docType !== identity.docType) continue;
		const nextHead = heads[index + 1];
		sections.push(lines.slice(head.lineIndex, nextHead?.lineIndex ?? lines.length).join(''));
	}
	const parsed = parseSource(sections.join(''), identity.uuid, 'FOOTPRINT');
	if (!parsed.effective.size)
		fail(`原生封装资源 ${reference} 没有有效内容`);
	return { source, parsed };
}

export async function planPcbFootprintRestore(input: {
	templateUuid: string;
	targetUuid: string;
	templateSource: string;
	targetSource: string;
	resources: FootprintResourceSource[];
	bindings: Array<{ sourceUid: string; targetComponentId: string; expectedTargetUid?: string }>;
	existingComponentIds: string[];
}): Promise<FootprintRestorePlan> {
	const templateUuid = requiredString(input?.templateUuid, 'templateUuid');
	const targetUuid = requiredString(input?.targetUuid, 'targetUuid');
	const template = parseSource(input.templateSource, templateUuid, 'PCB');
	const target = parseSource(input.targetSource, targetUuid, 'PCB');
	if (!Array.isArray(input.bindings) || !input.bindings.length)
		fail('bindings 必须包含至少一个来源与目标对应关系');
	if (!Array.isArray(input.existingComponentIds) || !Array.isArray(input.resources))
		fail('existingComponentIds 与 resources 必须是数组');
	const existing = new Set(input.existingComponentIds.map((id, index) => requiredString(id, `existingComponentIds[${index}]`)));
	const bindingByTarget = new Map<string, { sourceUid: string; targetComponentId: string; expectedTargetUid: string }>();
	for (const [index, raw] of input.bindings.entries()) {
		if (!object(raw)) fail(`bindings[${index}] 无效`);
		const sourceUid = requiredString(raw.sourceUid, `bindings[${index}].sourceUid`);
		const targetComponentId = requiredString(raw.targetComponentId, `bindings[${index}].targetComponentId`);
		const expectedTargetUid = requiredString(raw.expectedTargetUid ?? sourceUid, `bindings[${index}].expectedTargetUid`);
		if (existing.has(targetComponentId))
			fail(`目标组件属于既有集合，禁止修改：${targetComponentId}`);
		const previous = bindingByTarget.get(targetComponentId);
		if (previous && (previous.sourceUid !== sourceUid || previous.expectedTargetUid !== expectedTargetUid))
			fail(`同一物理目标对应多个来源或目标 UID：${targetComponentId}`);
		bindingByTarget.set(targetComponentId, { sourceUid, targetComponentId, expectedTargetUid });
	}
	const sourceComponents = effectiveByType(template, 'COMPONENT');
	const targetComponents = new Map(effectiveByType(target, 'COMPONENT').map(record => [String(record.header.id), record]));
	const changes: FootprintRestorePlan['changes'] = [];
	const resourceCache = new Map<string, { source: string; parsed: ParsedSource; sha256: string }>();
	for (const binding of bindingByTarget.values()) {
		const sourceMatches = sourceComponents.filter(component => componentUniqueId(component) === binding.sourceUid);
		if (sourceMatches.length !== 1)
			fail(sourceMatches.length ? `模板 Unique ID 有歧义：${binding.sourceUid}` : `模板中找不到 Unique ID：${binding.sourceUid}`);
		const sourceComponent = sourceMatches[0];
		const sourceComponentId = String(sourceComponent.header.id);
		const sourceFootprints = childAttributes(template, sourceComponentId, 'Footprint');
		if (sourceFootprints.length !== 1 || !object(sourceFootprints[0].data)
			|| typeof sourceFootprints[0].data.value !== 'string' || !sourceFootprints[0].data.value.trim())
			fail(`模板封装属性缺失或不唯一：${binding.sourceUid}`);
		const reference = sourceFootprints[0].data.value as string;
		const targetComponent = targetComponents.get(binding.targetComponentId);
		if (!targetComponent || componentUniqueId(targetComponent) !== binding.expectedTargetUid)
			fail(`目标组件已变化或 UID 不匹配：${binding.targetComponentId}`);
		const targetFootprints = childAttributes(target, binding.targetComponentId, 'Footprint');
		if (targetFootprints.length !== 1 || !object(targetFootprints[0].data)
			|| typeof targetFootprints[0].data.value !== 'string')
			fail(`目标封装属性缺失或不唯一：${binding.targetComponentId}`);
		const resource = resourceSource(input.resources, reference);
		let verifiedResource = resourceCache.get(reference);
		if (!verifiedResource) {
			verifiedResource = { ...resource, sha256: await digest(resource.source) };
			resourceCache.set(reference, verifiedResource);
		}
		changes.push({
			sourceUid: binding.sourceUid,
			expectedTargetUid: binding.expectedTargetUid,
			sourceComponentId,
			targetComponentId: binding.targetComponentId,
			targetAttributeId: String(targetFootprints[0].header.id),
			beforeReference: targetFootprints[0].data.value as string,
			afterReference: reference,
			resource: {
				documentUuid: verifiedResource.parsed.uuid,
				docType: verifiedResource.parsed.docType,
				effectiveRecordCount: verifiedResource.parsed.effective.size,
				sourceSha256: verifiedResource.sha256,
			},
		});
	}
	return {
		schema: 1,
		templateUuid,
		targetUuid,
		templateSourceSha256: await digest(input.templateSource),
		targetSourceSha256: await digest(input.targetSource),
		noOp: changes.every(change => change.beforeReference === change.afterReference),
		changes,
	};
}

export async function applyPcbFootprintRestorePlan(plan: FootprintRestorePlan, currentTargetSource: string): Promise<{ source: string; noOp: boolean }> {
	if (!plan || plan.schema !== 1 || !Array.isArray(plan.changes))
		fail('封装恢复计划无效');
	if (await digest(currentTargetSource) !== plan.targetSourceSha256)
		fail('目标 PCB 源码在计划生成后已变化');
	const target = parseSource(currentTargetSource, plan.targetUuid, 'PCB');
	if (plan.noOp)
		return { source: currentTargetSource, noOp: true };
	const byLine = new Map<number, FootprintRestorePlan['changes'][number]>();
	for (const change of plan.changes) {
		const attr = target.effective.get(`ATTR\u0000${change.targetAttributeId}`);
		if (!attr || attr.header.id !== change.targetAttributeId || !object(attr.data)
			|| attr.data.parentId !== change.targetComponentId || attr.data.key !== 'Footprint'
			|| attr.data.value !== change.beforeReference)
			fail(`目标封装属性与计划不符：${change.targetComponentId}`);
		byLine.set(attr.lineIndex, change);
	}
	const lines = currentTargetSource.match(/[^\n]*(?:\n|$)/g) ?? [];
	for (const [lineIndex, change] of byLine) {
		const original = target.records.find(record => record.lineIndex === lineIndex);
		if (!original || !object(original.data)) fail('计划指向的有效属性记录无法回读');
		const raw = original.line;
		const lineEnding = raw.match(/\r?\n$/)?.[0] ?? '';
		const content = raw.slice(0, raw.length - lineEnding.length);
		const separator = content.indexOf('||');
		const headerText = content.slice(0, separator);
		const dataText = content.slice(separator + 2);
		const trailingPipe = dataText.endsWith('|');
		const nextData = JSON.stringify({ ...original.data, value: change.afterReference });
		lines[lineIndex] = `${headerText}||${nextData}${trailingPipe ? '|' : ''}${lineEnding}`;
	}
	const source = lines.join('');
	const applied = parseSource(source, plan.targetUuid, 'PCB');
	for (const change of plan.changes) {
		const attr = applied.effective.get(`ATTR\u0000${change.targetAttributeId}`);
		if (!attr || !object(attr.data) || attr.data.value !== change.afterReference)
			fail(`改写后封装属性读回不符：${change.targetComponentId}`);
	}
	return { source, noOp: false };
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}

export async function verifyPcbFootprintRestore(input: {
	plan: FootprintRestorePlan;
	beforeTargetSource: string;
	afterTargetSource: string;
	templateSource: string;
	resources: FootprintResourceSource[];
}): Promise<{ ok: boolean; noOp: boolean; changedAttributeIds: string[]; error?: string }> {
	try {
		const { plan } = input;
		if (!plan || plan.schema !== 1) fail('封装恢复计划无效');
		if (await digest(input.templateSource) !== plan.templateSourceSha256) fail('模板源码发生变化');
		if (await digest(input.beforeTargetSource) !== plan.targetSourceSha256) fail('改写前目标源码与计划不符');
		const template = parseSource(input.templateSource, plan.templateUuid, 'PCB');
		if (template.uuid !== plan.templateUuid) fail('模板 PCB 身份发生变化');
		const before = parseSource(input.beforeTargetSource, plan.targetUuid, 'PCB');
		const after = parseSource(input.afterTargetSource, plan.targetUuid, 'PCB');
		const resources = new Map(input.resources.map(resource => [resource.footprintUuid, resource]));
		for (const change of plan.changes) {
			const resource = resources.get(change.afterReference);
			if (!resource || await digest(resource.documentSource) !== change.resource.sourceSha256)
				fail(`原生封装资源发生变化或缺失：${change.afterReference}`);
			const parsedResource = resourceSource([resource], change.afterReference).parsed;
			if (parsedResource.uuid !== change.resource.documentUuid)
				fail(`原生封装资源 DOCHEAD 身份变化：${change.afterReference}`);
			if (parsedResource.effective.size !== change.resource.effectiveRecordCount)
				fail(`原生封装资源有效内容变化：${change.afterReference}`);
		}
		if (before.effective.size !== after.effective.size) fail('改写前后有效记录数量变化');
		const approved = new Map(plan.changes.map(change => [`ATTR\u0000${change.targetAttributeId}`, change]));
		const changedAttributeIds: string[] = [];
		const consumedAfterKeys = new Set<string>();
		for (const [key, beforeRecord] of before.effective) {
			const change = approved.get(key);
			if (!change) {
				const afterRecord = after.effective.get(key);
				if (!afterRecord) fail(`改写后缺少有效记录：${key.replace('\u0000', '/')}`);
				if (canonical({ header: beforeRecord.header, data: beforeRecord.data }) !== canonical({ header: afterRecord.header, data: afterRecord.data }))
					fail(`出现未批准的 PCB 记录变化：${key.replace('\u0000', '/')}`);
				consumedAfterKeys.add(key);
				continue;
			}
			let afterKey = key;
			let afterRecord = after.effective.get(key);
			if (!afterRecord) {
				const replacements = effectiveByType(after, 'ATTR').filter(record => object(record.data)
					&& record.data.parentId === change.targetComponentId && record.data.key === 'Footprint'
					&& record.data.value === change.afterReference);
				if (replacements.length !== 1) fail(`封装引用改写后唯一属性记录缺失或重复：${change.targetComponentId}`);
				afterRecord = replacements[0];
				afterKey = keyOf(afterRecord);
				if (before.effective.has(afterKey) || consumedAfterKeys.has(afterKey)) fail(`封装引用改写后属性 ID 与已有有效记录冲突：${change.targetComponentId}`);
				const { id: _beforeId, ...beforeHeader } = beforeRecord.header;
				const { id: _afterId, ...afterHeader } = afterRecord.header;
				if (canonical(beforeHeader) !== canonical(afterHeader)) fail(`封装引用属性重建时 header 除 ID 外发生变化：${change.targetComponentId}`);
			}
			if (!object(beforeRecord.data) || !object(afterRecord.data)) fail(`封装属性记录无效：${change.targetAttributeId}`);
			const expected = { ...beforeRecord.data, value: change.afterReference };
			const headersMatch = afterKey === key
				? canonical(beforeRecord.header) === canonical(afterRecord.header)
				: (() => { const { id: _beforeId, ...beforeHeader } = beforeRecord.header; const { id: _afterId, ...afterHeader } = afterRecord.header;
					return canonical(beforeHeader) === canonical(afterHeader); })();
			if (!headersMatch || canonical(expected) !== canonical(afterRecord.data))
				fail(`封装属性之外的字段发生变化：${change.targetAttributeId}`);
			if (beforeRecord.data.value !== change.afterReference)
				changedAttributeIds.push(String(afterRecord.header.id));
			consumedAfterKeys.add(afterKey);
		}
		if ([...after.effective.keys()].some(key => !consumedAfterKeys.has(key))) fail('改写后增加了未批准的有效 PCB 记录');
		return { ok: true, noOp: changedAttributeIds.length === 0, changedAttributeIds };
	}
	catch (error) {
		return { ok: false, noOp: false, changedAttributeIds: [], error: error instanceof Error ? error.message : String(error) };
	}
}

/** Plan only the narrow instance-state repairs that have independent legacy-slot proof. */
export async function planPcbInstanceStateRestore(input: {
	targetUuid: string;
	targetSource: string;
	bindings: Array<{ targetUid: string; targetComponentId: string }>;
	existingComponentIds: string[];
	eligible: Array<{ targetUid: string; field: 'locked' | 'Footprint.specialColor' }>;
}): Promise<PcbInstanceStateRestorePlan> {
	const targetUuid = requiredString(input?.targetUuid, 'targetUuid');
	const target = parseSource(input.targetSource, targetUuid, 'PCB');
	if (!Array.isArray(input.bindings) || !input.bindings.length || !Array.isArray(input.existingComponentIds)
		|| !Array.isArray(input.eligible)) fail('实例状态恢复绑定或证据无效');
	const existing = new Set(input.existingComponentIds.map((id, index) => requiredString(id, `existingComponentIds[${index}]`)));
	const byUid = new Map<string, Array<{ targetUid: string; targetComponentId: string }>>();
	for (const binding of input.bindings) {
		const targetUid = requiredString(binding?.targetUid, 'bindings.targetUid');
		const targetComponentId = requiredString(binding?.targetComponentId, 'bindings.targetComponentId');
		if (existing.has(targetComponentId)) fail(`目标组件属于既有集合，禁止修改：${targetComponentId}`);
		byUid.set(targetUid, [...(byUid.get(targetUid) ?? []), { targetUid, targetComponentId }]);
	}
	const eligibleKeys = new Set<string>();
	for (const entry of input.eligible) {
		if (!entry || (entry.field !== 'locked' && entry.field !== 'Footprint.specialColor')) fail('实例状态证据字段无效');
		const targetUid = requiredString(entry.targetUid, 'eligible.targetUid');
		const key = `${targetUid}\u0000${entry.field}`;
		if (eligibleKeys.has(key)) fail(`实例状态证据重复：${targetUid}/${entry.field}`);
		eligibleKeys.add(key);
	}
	const components = new Map(effectiveByType(target, 'COMPONENT').map(record => [String(record.header.id), record]));
	const changes: PcbInstanceStateRestorePlan['changes'] = [];
	for (const key of eligibleKeys) {
		const separator = key.indexOf('\u0000');
		const targetUid = key.slice(0, separator);
		const field = key.slice(separator + 1) as 'locked' | 'Footprint.specialColor';
		const matches = byUid.get(targetUid) ?? [];
		if (matches.length !== 1) fail(`实例状态恢复 targetUid 绑定不唯一：${targetUid}`);
		const binding = matches[0];
		const uidMatches = effectiveByType(target, 'COMPONENT').filter(record => componentUniqueId(record) === targetUid);
		if (uidMatches.length !== 1 || String(uidMatches[0].header.id) !== binding.targetComponentId)
			fail(`实例状态恢复目标 Unique ID 不唯一或组件身份变化：${targetUid}`);
		const component = components.get(binding.targetComponentId);
		if (!component || componentUniqueId(component) !== targetUid || !object(component.data))
			fail(`实例状态恢复目标 COMPONENT 已变化：${targetUid}`);
		if (field === 'locked') {
			if (typeof component.data.locked !== 'boolean') fail(`目标 COMPONENT locked 缺失或类型无效：${targetUid}`);
			if (component.data.locked !== false) fail(`目标 COMPONENT locked 已不是待恢复的 false：${targetUid}`);
			changes.push({ targetUid, targetComponentId: binding.targetComponentId, field, beforeValue: false, afterValue: true });
			continue;
		}
		const attributes = childAttributes(target, binding.targetComponentId, 'Footprint');
		if (attributes.length !== 1 || !object(attributes[0].data)) fail(`目标 Footprint ATTR 缺失或不唯一：${targetUid}`);
		if (attributes[0].data.specialColor !== null) fail(`目标 Footprint ATTR specialColor 不是明确 null：${targetUid}`);
		changes.push({ targetUid, targetComponentId: binding.targetComponentId, field,
			targetAttributeId: String(attributes[0].header.id), sourceColorBound: false,
			beforeValue: null, afterValue: '__SOURCE_COLOR_BOUND_BY_HOST__' });
	}
	return { schema: 1, targetUuid, targetSourceSha256: await digest(input.targetSource), changes };
}

/** Bind color values only after the host has re-read the latest source by UID. */
export async function bindPcbInstanceStateRestoreValues(input: {
	plan: PcbInstanceStateRestorePlan;
	targetSource: string;
	values: Array<{ targetUid: string; field: 'Footprint.specialColor'; value: string }>;
}): Promise<PcbInstanceStateRestorePlan> {
	const { plan } = input;
	if (!plan || plan.schema !== 1 || await digest(input.targetSource) !== plan.targetSourceSha256)
		fail('实例状态计划绑定时目标源码已变化');
	const target = parseSource(input.targetSource, plan.targetUuid, 'PCB');
	const values = new Map(input.values.map(value => [`${value.targetUid}\u0000${value.field}`, value.value]));
	const changes = plan.changes.map(change => {
		if (change.field !== 'Footprint.specialColor') return change;
		const value = values.get(`${change.targetUid}\u0000Footprint.specialColor`);
		if (typeof value !== 'string' || !value.trim()) fail(`源 Footprint specialColor 缺少完整字符串证据：${change.targetUid}`);
		const attrs = childAttributes(target, change.targetComponentId, 'Footprint');
		if (attrs.length !== 1 || String(attrs[0].header.id) !== change.targetAttributeId || !object(attrs[0].data)
			|| attrs[0].data.specialColor !== null) fail(`最新 Footprint ATTR 绑定已变化：${change.targetUid}`);
		return { ...change, afterValue: value, sourceColorBound: true };
	});
	return { ...plan, changes };
}

export async function applyPcbInstanceStateRestorePlan(plan: PcbInstanceStateRestorePlan, currentTargetSource: string): Promise<{ source: string; noOp: boolean }> {
	if (!plan || plan.schema !== 1 || !Array.isArray(plan.changes)) fail('实例状态恢复计划无效');
	if (await digest(currentTargetSource) !== plan.targetSourceSha256) fail('实例状态恢复计划生成后目标源码已变化');
	const target = parseSource(currentTargetSource, plan.targetUuid, 'PCB');
	const lines = currentTargetSource.match(/[^\n]*(?:\n|$)/g) ?? [];
	const byLine = new Map<number, PcbInstanceStateRestorePlan['changes'][number]>();
	for (const change of plan.changes) {
		const component = target.effective.get(`COMPONENT\u0000${change.targetComponentId}`);
		if (!component || componentUniqueId(component) !== change.targetUid || !object(component.data)) fail(`实例状态目标 UID/COMPONENT 已变化：${change.targetUid}`);
		if (change.field === 'locked') {
			if (component.data.locked !== change.beforeValue || change.beforeValue !== false || change.afterValue !== true)
				fail(`目标 COMPONENT locked 与计划不符：${change.targetUid}`);
			byLine.set(component.lineIndex, change);
			continue;
		}
		const attr = target.effective.get(`ATTR\u0000${change.targetAttributeId}`);
		if (!attr || !object(attr.data) || attr.data.parentId !== change.targetComponentId || attr.data.key !== 'Footprint'
			|| attr.data.specialColor !== change.beforeValue || change.sourceColorBound !== true
			|| typeof change.afterValue !== 'string' || !change.afterValue.trim())
			fail(`目标 Footprint specialColor 与计划不符：${change.targetUid}`);
		byLine.set(attr.lineIndex, change);
	}
	for (const [lineIndex, change] of byLine) {
		const original = target.records.find(record => record.lineIndex === lineIndex);
		if (!original || !object(original.data)) fail('实例状态计划指向的记录无法回读');
		const raw = original.line, ending = raw.match(/\r?\n$/)?.[0] ?? '', content = raw.slice(0, raw.length - ending.length);
		const separator = content.indexOf('||');
		const trailingPipe = content.slice(separator + 2).endsWith('|');
		const property = change.field === 'locked' ? 'locked' : 'specialColor';
		lines[lineIndex] = `${content.slice(0, separator + 2)}${JSON.stringify({ ...original.data, [property]: change.afterValue })}${trailingPipe ? '|' : ''}${ending}`;
	}
	return { source: lines.join(''), noOp: plan.changes.length === 0 };
}

export async function verifyPcbInstanceStateRestore(input: {
	plan: PcbInstanceStateRestorePlan;
	beforeTargetSource: string;
	afterTargetSource: string;
}): Promise<{ ok: boolean; changed: Array<{ targetUid: string; field: string }>; error?: string }> {
	try {
		const { plan } = input;
		if (!plan || plan.schema !== 1 || await digest(input.beforeTargetSource) !== plan.targetSourceSha256) fail('实例状态计划前目标源码不符');
		const before = parseSource(input.beforeTargetSource, plan.targetUuid, 'PCB');
		const after = parseSource(input.afterTargetSource, plan.targetUuid, 'PCB');
		if (before.effective.size !== after.effective.size) fail('实例状态恢复前后有效记录数量变化');
		const approved = new Map<string, PcbInstanceStateRestorePlan['changes'][number]>();
		for (const change of plan.changes) {
			const key = `${change.field === 'locked' ? 'COMPONENT' : 'ATTR'}\u0000${change.field === 'locked' ? change.targetComponentId : change.targetAttributeId}`;
			if (approved.has(key)) fail('实例状态计划重复定位同一记录');
			approved.set(key, change);
		}
		const changed: Array<{ targetUid: string; field: string }> = [];
		for (const [key, source] of before.effective) {
			const target = after.effective.get(key);
			if (!target) fail(`实例状态恢复后缺少有效记录：${key.replace('\u0000', '/')}`);
			const change = approved.get(key);
			if (!change) {
				if (canonical({ header: source.header, data: source.data }) !== canonical({ header: target.header, data: target.data })) fail(`实例状态恢复出现未批准字段变化：${key.replace('\u0000', '/')}`);
				continue;
			}
			if (!object(source.data) || !object(target.data)) fail('实例状态恢复记录结构无效');
			const property = change.field === 'locked' ? 'locked' : 'specialColor';
			if (canonical({ header: source.header, data: { ...source.data, [property]: change.afterValue } }) !== canonical({ header: target.header, data: target.data }))
				fail(`实例状态恢复记录含额外变化：${change.targetUid}/${change.field}`);
			if (source.data[property] !== change.afterValue) changed.push({ targetUid: change.targetUid, field: change.field });
		}
		return { ok: true, changed };
	}
	catch (error) { return { ok: false, changed: [], error: error instanceof Error ? error.message : String(error) }; }
}
