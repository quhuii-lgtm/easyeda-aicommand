type RecordLike = { header: { type: string; id: string }; data: Record<string, any> };

export type PcbNetlistComponent = {
	targetUid: string;
	designator: string;
	pads: Array<{ padNumber: string; net: string }>;
	component: Record<string, any>;
};

export type AllowedAttributeChange = {
	pageUuid: string;
	attributeId: string;
	componentId: string;
	key: 'Unique ID' | 'Designator';
	parentId: string;
	beforeValue: string;
	afterValue: string;
};

function plainObject(value: unknown): value is Record<string, any> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sortObject(value: any): any {
	if (Array.isArray(value)) return value.map(sortObject);
	if (plainObject(value)) {
		const output: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(value).sort()) output[key] = sortObject(value[key]);
		return output;
	}
	return value;
}

export function stablePcbIdentityJson(value: unknown): string {
	return JSON.stringify(sortObject(value));
}

export async function sha256Hex(text: string): Promise<string> {
	if (typeof text !== 'string' || !globalThis.crypto?.subtle)
		throw new Error('Pcb instance identity requires Web Crypto SHA-256');
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

export function parseJlcEdaNetlist(text: string): { raw: Record<string, any>; components: PcbNetlistComponent[] } {
	let raw: any;
	try { raw = JSON.parse(text); }
	catch { throw new Error('JLCEDA 网表不是有效 JSON'); }
	if (!plainObject(raw) || !plainObject(raw.components) || !Object.keys(raw.components).length)
		throw new Error('JLCEDA 网表缺少有效 components');
	const components: PcbNetlistComponent[] = [];
	const designators = new Set<string>();
	for (const [uid, component] of Object.entries(raw.components)) {
		if (!uid.trim() || !plainObject(component) || !plainObject(component.props)
			|| component.props['Unique ID'] !== uid
			|| typeof component.props.Designator !== 'string' || !component.props.Designator.trim())
			throw new Error(`JLCEDA 网表器件 ${uid || '(空键)'} 缺少一致的 Unique ID/Designator`);
		if (designators.has(component.props.Designator))
			throw new Error(`JLCEDA 网表 Designator 重复：${component.props.Designator}`);
		designators.add(component.props.Designator);
		if (!plainObject(component.pinInfoMap))
			throw new Error(`JLCEDA 网表器件 ${uid} 缺少 pinInfoMap`);
		const pads = Object.entries(component.pinInfoMap).map(([pinKey, pinInfo]) => {
			if (!plainObject(pinInfo)) throw new Error(`JLCEDA 网表器件 ${uid} 引脚 ${pinKey} 无效`);
			const padNumber = pinInfo.number ?? pinKey;
			if (typeof padNumber !== 'string' || !padNumber.trim() || typeof pinInfo.net !== 'string')
				throw new Error(`JLCEDA 网表器件 ${uid} 引脚 ${pinKey} 缺少编号或网络字符串`);
			return { padNumber, net: pinInfo.net };
		});
		if (new Set(pads.map(pad => pad.padNumber)).size !== pads.length)
			throw new Error(`JLCEDA 网表器件 ${uid} 引脚编号重复`);
		components.push({ targetUid: uid, designator: component.props.Designator, pads, component });
	}
	return { raw, components };
}

function effectiveRecordKey(record: RecordLike): string {
	return `${record.header.type}\u0000${record.header.id}`;
}

export function verifyOnlyAllowedIdentityChanges(
	before: { effective: Map<string, RecordLike> },
	after: { effective: Map<string, RecordLike> },
	pageUuid: string,
	allowedChanges: AllowedAttributeChange[],
): void {
	const allowed = new Map(allowedChanges.filter(item => item.pageUuid === pageUuid)
		.map(item => [`ATTR\u0000${item.attributeId}`, item]));
	if (before.effective.size !== after.effective.size)
		throw new Error(`父 SCH 页 ${pageUuid} 有效记录数量发生变化`);
	for (const [key, oldRecord] of before.effective) {
		const current = after.effective.get(key);
		if (!current) throw new Error(`父 SCH 页 ${pageUuid} 丢失记录 ${key.replace('\u0000', '/')}`);
		const change = allowed.get(key);
		if (!change) {
			if (stablePcbIdentityJson(oldRecord) !== stablePcbIdentityJson(current))
				throw new Error(`父 SCH 页 ${pageUuid} 非身份属性记录发生变化：${key.replace('\u0000', '/')}`);
			continue;
		}
		if (oldRecord.header.type !== 'ATTR' || current.header.type !== 'ATTR'
			|| oldRecord.header.id !== change.attributeId || current.header.id !== change.attributeId
			|| oldRecord.data.parentId !== change.parentId || current.data.parentId !== change.parentId
			|| oldRecord.data.key !== change.key || current.data.key !== change.key
			|| oldRecord.data.value !== change.beforeValue || current.data.value !== change.afterValue)
			throw new Error(`父 SCH 页 ${pageUuid} 身份属性不符合允许变更记录：${change.attributeId}`);
		const oldData = { ...oldRecord.data }; const newData = { ...current.data };
		delete oldData.value; delete newData.value;
		if (stablePcbIdentityJson(oldData) !== stablePcbIdentityJson(newData))
			throw new Error(`父 SCH 页 ${pageUuid} 身份 ATTR 除 value 外字段发生变化：${change.attributeId}`);
		allowed.delete(key);
	}
	if (allowed.size)
		throw new Error(`父 SCH 页 ${pageUuid} 缺少预期身份 ATTR：${[...allowed.keys()].join(', ')}`);
}
