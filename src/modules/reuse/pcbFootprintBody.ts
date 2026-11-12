import JSZip from 'jszip';
import { cloneJsonData } from './jsonDataClone';
import { transformFootprintOwnedPolygonPath } from './pcbTemplatePhysical';

type JsonObject = Record<string, unknown>;
type LegacyRow = unknown[];

export type LegacyPcbBoardIdentity = {
	boardName: string;
	schematicUuid: string;
	pcbUuid: string;
	pcbName: string;
};

export type LegacyPcbComponentIdentity = {
	sourceUid: string;
	sourceComponentId: string;
	layerId: number;
	x: number;
	y: number;
	angle: number;
	existingFootprintUuid?: string;
	getterFootprintUuid?: string;
	nativeFootprintUuid?: string;
	nativeFootprintBindingOrigin?: 'native-pcb-attr' | 'component-getter';
	nativeAttributes?: Record<string, unknown>;
};

export type LegacyFootprintBoardAliasProof = {
	projectUuid: string;
	boardName: string;
	nativePcbUuid: string;
	nativeSchematicUuid: string;
	nativePcbName: string;
	compiledPcbUuid: string;
	compiledPcbPath: string;
	archiveSha256: string;
	nativeRawBeforeSha256: string;
	nativeRawAfterSha256: string;
	nativeSemanticSha256: string;
	nativeReadbackSemanticSha256: string;
	nativeEffectiveRecordCount: number;
	nativeReadbackVerified: true;
	headUuidAbsent: boolean;
	uidPoseBindings: Array<{ sourceUid: string; nativeComponentId: string; legacyComponentId: string;
		layerId: number; x: number; y: number; angle: number; legacyAngle: number }>;
};

export type LegacyFootprintInstance = {
	sourceUid: string;
	sourceComponentId: string;
	legacyComponentId: string;
	footprintUuid: string;
	legacyFootprintUuid: string;
	nativeFootprintUuid?: string;
	canonicalFootprintReference?: string;
	footprintAliasProof?: {
		sourceUid: string;
		nativeComponentId: string;
		legacyComponentId: string;
		nativeFootprintUuid: string;
		legacyFootprintUuid: string;
		nativeFootprintBindingOrigin: 'native-pcb-attr' | 'component-getter';
		nativeResourceDocumentUuid: string;
		nativeResourceSha256: string;
		legacyBoardPath: string;
		legacyMasterPath: string;
		legacyMasterHeadSha256: string;
		legacyMasterSha256: string;
		boardAliasProof: LegacyFootprintBoardAliasProof;
	};
	componentRow: LegacyRow;
	nativeAttributes: Record<string, unknown>;
	footprintAttributeRow: LegacyRow;
	attributeRows: LegacyRow[];
	propertyRows: LegacyRow[];
	padNetRows: LegacyRow[];
	inactivePadNetCache: LegacyRow[];
	connectRows: LegacyRow[];
	instancePrimitiveRows: LegacyRow[];
	associatedRows: LegacyRow[];
	master: {
		path: string;
		uuid: string;
		title: string;
		content: string;
		sha256: string;
		rows: LegacyRow[];
	};
};

export type LegacyFootprintBoardCapture = {
	boardName: string;
	schematicUuid: string;
	pcbName: string;
	legacyPcbUuid: string;
	pcbPath: string;
	pcbHeadUuid?: string;
	pcbHeadUuidAbsent: boolean;
	boardAliasProof?: LegacyFootprintBoardAliasProof;
	instances: LegacyFootprintInstance[];
	groups: Array<{ groupId: string; recordPresent: boolean; memberCounts: Record<string, number> }>;
};

export type LegacyFootprintBodyComparison = {
	confirmed: boolean;
	noOp: boolean;
	requiresFinalFootprintVerification: boolean;
	referenceRestoreEligible: boolean;
	stateRestoreEligible: boolean;
	stateRestoreOriginalMismatches?: string[];
	matched: Array<{ sourceUid: string; targetUid: string; footprintUuid: string; associatedRecordCount: number }>;
	mismatches: string[];
	referenceRepairMismatches: string[];
};

export type LegacyFootprintBodyMapping = {
	sourceUid: string;
	targetUid: string;
	sourceNativeGroupId?: string | number;
	targetNativeGroupId?: string | number;
	targetProps?: Record<string, unknown>;
	targetDesignator?: string;
	transform: { rotationDegrees: number; dx: number; dy: number };
};

export type LegacyFootprintLineGroupNormalization = {
	status: 'conditional_on_final_footprint_verification';
	placementOperationId: string;
	sourceNativeGroupId: string | number;
	targetNativeGroupId: string | number;
	sourceLineCount: number;
	targetLineCount: number;
	sourceLineIds: string[];
	targetLineIds: string[];
	merges: Array<{ sourceLineIds: string[]; targetLineId: string }>;
	padCovered: Array<{ sourceLineId: string; padCoverageAssociationId: string }>;
};

function fail(message: string): never { throw new Error(message); }
function object(value: unknown): value is JsonObject { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) fail(`${name} 必须是非空字符串`);
	return value;
}
function finite(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} 必须是有限数值`);
	return value;
}
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}
function equivalent(a: unknown, b: unknown): boolean {
	if (typeof a === 'number' && typeof b === 'number')
		return Object.is(a, b) || (Number.isFinite(a) && Number.isFinite(b)
			&& Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 8);
	if (Array.isArray(a) || Array.isArray(b))
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equivalent(value, b[index]));
	if (object(a) || object(b)) {
		if (!object(a) || !object(b)) return false;
		const keysA = Object.keys(a).sort(); const keysB = Object.keys(b).sort();
		return stable(keysA) === stable(keysB) && keysA.every(key => equivalent(a[key], b[key]));
	}
	return Object.is(a, b);
}
function sameMultiset(a: unknown[], b: unknown[]): boolean {
	if (a.length !== b.length) return false;
	const remaining = [...b];
	for (const value of a) {
		const index = remaining.findIndex(candidate => equivalent(value, candidate));
		if (index < 0) return false;
		remaining.splice(index, 1);
	}
	return remaining.length === 0;
}
function normalizeDegrees(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} 必须是有限角度数值`);
	return ((value % 360) + 360) % 360;
}
function normalizedMasterRows(rows: LegacyRow[], canonicalUuid?: string): LegacyRow[] {
	return rows.map(row => {
		const copy = [...row];
		if (canonicalUuid && copy[0] === 'HEAD' && object(copy[1]) && typeof copy[1].uuid === 'string')
			copy[1] = { ...copy[1], uuid: canonicalUuid };
		const slot: Record<string, number> = { COMPONENT: 6, PAD: 8, STRING: 15, ATTR: 18 };
		const angleIndex = slot[String(copy[0])];
		if (angleIndex !== undefined && copy.length > angleIndex)
			copy[angleIndex] = normalizeDegrees(copy[angleIndex], `${String(copy[0])}[${angleIndex}]`);
		return copy;
	});
}
function normalizeComparisonAngle(row: LegacyRow): LegacyRow {
	const copy = [...row];
	const angleIndex = ({ COMPONENT: 6, PAD: 8, STRING: 15, ATTR: 18 } as Record<string, number>)[String(copy[0])];
	if (angleIndex !== undefined && copy.length > angleIndex)
		copy[angleIndex] = normalizeDegrees(copy[angleIndex], `${String(copy[0])}[${angleIndex}]`);
	return copy;
}
function hasVerifiedFootprintAlias(instance: LegacyFootprintInstance): boolean {
	const proof = instance.footprintAliasProof;
	if (!object(proof) || !object(proof.boardAliasProof)) return false;
	const boardProof = proof.boardAliasProof;
	if (typeof boardProof.projectUuid !== 'string' || !boardProof.projectUuid.trim()
		|| typeof boardProof.nativePcbUuid !== 'string' || !boardProof.nativePcbUuid.trim()
		|| typeof boardProof.nativeSchematicUuid !== 'string' || !boardProof.nativeSchematicUuid.trim()
		|| typeof boardProof.nativePcbName !== 'string' || !boardProof.nativePcbName.trim()
		|| typeof boardProof.compiledPcbUuid !== 'string' || !boardProof.compiledPcbUuid.trim()
		|| typeof boardProof.compiledPcbPath !== 'string' || !boardProof.compiledPcbPath.trim()
		|| typeof boardProof.archiveSha256 !== 'string' || boardProof.archiveSha256.length !== 64
		|| typeof boardProof.nativeRawBeforeSha256 !== 'string' || boardProof.nativeRawBeforeSha256.length !== 64
		|| typeof boardProof.nativeRawAfterSha256 !== 'string' || boardProof.nativeRawAfterSha256.length !== 64
		|| typeof boardProof.nativeSemanticSha256 !== 'string' || boardProof.nativeSemanticSha256.length !== 64
		|| typeof boardProof.nativeReadbackSemanticSha256 !== 'string' || boardProof.nativeReadbackSemanticSha256.length !== 64
		|| typeof boardProof.nativeEffectiveRecordCount !== 'number' || boardProof.nativeEffectiveRecordCount <= 0
		|| boardProof.nativeReadbackVerified !== true
		|| boardProof.nativeSemanticSha256 !== boardProof.nativeReadbackSemanticSha256
		|| typeof boardProof.headUuidAbsent !== 'boolean' || !Array.isArray(boardProof.uidPoseBindings)) return false;
	return Boolean(proof
		&& proof.sourceUid === instance.sourceUid
		&& proof.nativeComponentId === instance.sourceComponentId
		&& proof.legacyComponentId === instance.legacyComponentId
		&& proof.nativeFootprintUuid === instance.nativeFootprintUuid
		&& proof.nativeFootprintUuid === instance.canonicalFootprintReference
		&& proof.legacyFootprintUuid === instance.legacyFootprintUuid
		&& proof.legacyFootprintUuid === instance.footprintUuid
		&& proof.nativeResourceDocumentUuid.length > 0
		&& (proof.nativeFootprintBindingOrigin === 'native-pcb-attr' || proof.nativeFootprintBindingOrigin === 'component-getter')
		&& proof.nativeResourceSha256.length === 64
		&& proof.legacyBoardPath.length > 0
		&& proof.legacyMasterPath === instance.master.path
		&& proof.legacyMasterSha256 === instance.master.sha256
		&& proof.legacyMasterHeadSha256.length === 64
		&& boardProof.compiledPcbPath === proof.legacyBoardPath
		&& boardProof.compiledPcbUuid === boardProof.compiledPcbPath.split('/').at(-1)?.replace('.epcb', '')
		&& boardProof.uidPoseBindings.some(binding => object(binding) && binding.sourceUid === proof.sourceUid
			&& binding.nativeComponentId === proof.nativeComponentId && binding.legacyComponentId === proof.legacyComponentId
			&& typeof binding.angle === 'number' && Number.isFinite(binding.angle)
			&& typeof binding.legacyAngle === 'number' && Number.isFinite(binding.legacyAngle)
			&& normalizeDegrees(binding.angle, 'proof native angle') === normalizeDegrees(binding.legacyAngle, 'proof legacy angle')));
}
function rotationCoefficients(degrees: number): { cos: number; sin: number } {
	const normalized = ((degrees % 360) + 360) % 360;
	if (normalized === 0) return { cos: 1, sin: 0 };
	if (normalized === 90) return { cos: 0, sin: 1 };
	if (normalized === 180) return { cos: -1, sin: 0 };
	if (normalized === 270) return { cos: 0, sin: -1 };
	const angle = degrees * Math.PI / 180;
	return { cos: Math.cos(angle), sin: Math.sin(angle) };
}
function transformedPoint(x: number, y: number, transform: LegacyFootprintBodyMapping['transform']): [number, number] {
	const { cos, sin } = rotationCoefficients(transform.rotationDegrees);
	return [x * cos - y * sin + transform.dx, x * sin + y * cos + transform.dy];
}
function normalizeOwnedRow(
	row: LegacyRow,
	idMap: Map<string, string>,
	componentId: string,
	transform: LegacyFootprintBodyMapping['transform'],
	netMap: Map<string, string>,
): LegacyRow {
	const copy = cloneJsonData(row) as LegacyRow;
	const type = String(copy[0]);
	if (type === 'PAD_NET') {
		copy[1] = componentId;
		if (typeof copy[3] === 'string' && netMap.has(copy[3])) copy[3] = netMap.get(copy[3]);
		return copy;
	}
	const sourceId = copy[1];
	if (typeof sourceId === 'string') copy[1] = idMap.get(sourceId) ?? sourceId;
	if (type === 'ATTR' && typeof copy[3] === 'string') copy[3] = idMap.get(copy[3]) ?? copy[3];
	if (type === 'CONNECT') {
		const related = Array.isArray(copy[2]) ? copy[2] : object(copy[2]) && Array.isArray(copy[2].relatedIds) ? copy[2].relatedIds : undefined;
		if (!related) fail(`CONNECT 关联结构无法规范化：${String(copy[1])}`);
		const mapped = related.map(child => typeof child === 'string' ? idMap.get(child) ?? child : child);
		mapped.sort((left, right) => String(left).localeCompare(String(right)));
		if (Array.isArray(copy[2])) copy[2] = mapped;
		else if (object(copy[2])) copy[2] = { ...copy[2], relatedIds: mapped };
		return copy;
	}
	if (['PAD', 'VIA', 'LINE'].includes(type)) {
		if (typeof copy[3] === 'string' && netMap.has(copy[3])) copy[3] = netMap.get(copy[3]);
		const pairs = type === 'LINE' ? [[5, 6], [7, 8]] : type === 'PAD' ? [[6, 7]] : [[5, 6]];
		for (const [xIndex, yIndex] of pairs) {
			if (typeof copy[xIndex] !== 'number' || typeof copy[yIndex] !== 'number') fail(`${type} 实例覆盖坐标字段无法解析：${String(copy[1])}`);
			[copy[xIndex], copy[yIndex]] = transformedPoint(copy[xIndex] as number, copy[yIndex] as number, transform);
		}
		if (type === 'PAD') copy[8] = normalizeDegrees(normalizeDegrees(copy[8], '源 PAD[8]') + transform.rotationDegrees, '实例 PAD[8]');
		return copy;
	}
	if (type === 'POLY') {
		if (typeof sourceId !== 'string' || !idMap.has(sourceId)) fail(`POLY 实例覆盖 owner ID 无法映射：${String(sourceId)}`);
		if (typeof copy[5] !== 'number' || !Number.isFinite(copy[5])) fail(`POLY 实例覆盖宽度字段无法解析：${String(sourceId)}`);
		copy[6] = transformFootprintOwnedPolygonPath(copy[6], transform, `POLY 实例覆盖 ${String(sourceId)}`);
		return copy;
	}
	if (type === 'STRING') {
		if (typeof copy[6] !== 'number' || typeof copy[7] !== 'number') fail(`STRING 实例覆盖坐标字段无法解析：${String(copy[1])}`);
		[copy[6], copy[7]] = transformedPoint(copy[6], copy[7], transform);
		copy[15] = normalizeDegrees(normalizeDegrees(copy[15], '源 STRING[15]') + transform.rotationDegrees, '实例 STRING[15]');
		return copy;
	}
	if (['COMPONENT', 'PROP', 'ATTR', 'PAD_NET'].includes(type)) return copy;
	fail(`未支持的 Footprint 复合实例覆盖类型：${type}`);
}
async function sha256(source: string): Promise<string> {
	if (!globalThis.crypto?.subtle) fail('当前环境没有 SHA-256 能力');
	const result = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
	return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function parseJsonLines(source: string, label: string): LegacyRow[] {
	const rows: LegacyRow[] = [];
	for (const [lineIndex, line] of source.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		let row: unknown;
		try { row = JSON.parse(line); }
		catch { fail(`${label} 第 ${lineIndex + 1} 行不是有效 JSON`); }
		if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0].trim())
			fail(`${label} 第 ${lineIndex + 1} 行不是受支持的记录数组`);
		rows.push(row as LegacyRow);
	}
	return rows;
}

function uniqueRows(rows: LegacyRow[], predicate: (row: LegacyRow) => boolean, label: string): LegacyRow[] {
	const result = rows.filter(predicate);
	if (result.length !== 1) fail(`${label} 唯一性不成立（找到 ${result.length} 条）`);
	return result;
}

function legacyBoard(project: JsonObject, identity: LegacyPcbBoardIdentity): { uuid: string; path: string } {
	const boards = project.boards;
	const pcbs = project.pcbs;
	if (!object(boards) || !object(pcbs)) fail('旧格式工程缺少 boards/pcbs 映射');
	const matched: Array<{ boardName: string; uuid: string }> = [];
	for (const [boardName, value] of Object.entries(boards)) {
		if (!object(value) || value.schematic !== identity.schematicUuid || typeof value.pcb !== 'string') continue;
		if (boardName !== identity.boardName || pcbs[value.pcb] !== identity.pcbName) continue;
		matched.push({ boardName, uuid: value.pcb });
	}
	if (matched.length !== 1)
		fail(`旧格式工程中 boardName/SCH UUID/PCB name 未唯一配对（匹配 ${matched.length} 项）`);
	const pcbPath = `PCB/${matched[0].uuid}.epcb`;
	return { uuid: matched[0].uuid, path: pcbPath };
}

function checkGeometry(row: LegacyRow, component: LegacyPcbComponentIdentity): void {
	if (row[3] !== component.layerId || row[4] !== component.x || row[5] !== component.y
		|| normalizeDegrees(row[6], '旧格式 COMPONENT[6]') !== normalizeDegrees(component.angle, '当前源码 angle'))
		fail(`旧格式 COMPONENT 几何与当前源码不一致：${component.sourceUid}`);
}

function associatedRows(rows: LegacyRow[], componentId: string, attributeIds: Set<string>, primitiveIds: Set<string>, padIds: Set<string>): {
	attributes: LegacyRow[]; properties: LegacyRow[]; padNets: LegacyRow[]; inactivePadNetCache: LegacyRow[];
	connects: LegacyRow[]; primitives: LegacyRow[]; all: LegacyRow[];
} {
	const compositeIds = new Set([...primitiveIds].map(primitiveId => `${componentId}${primitiveId}`));
	const ownedIds = new Set([componentId, ...attributeIds, ...compositeIds]);
	const attributes = rows.filter(row => row[0] === 'ATTR' && (row[3] === componentId || (typeof row[1] === 'string' && compositeIds.has(row[1]))));
	const properties = rows.filter(row => row[0] === 'PROP' && typeof row[1] === 'string' && ownedIds.has(row[1]));
	const padNets: LegacyRow[] = [];
	const inactivePadNetCache: LegacyRow[] = [];
	for (const row of rows) {
		if (row[0] !== 'PAD_NET' || row[1] !== componentId) continue;
		if (typeof row[4] === 'string' && padIds.has(row[4])) { padNets.push(row); continue; }
		const localId = typeof row[4] === 'string' ? row[4] : '';
		const instanceId = `${componentId}${localId}`;
		const hasOverride = rows.some(candidate => candidate !== row && candidate[1] === instanceId);
		const hasConnect = rows.some(candidate => {
			if (candidate[0] !== 'CONNECT') return false;
			const related = Array.isArray(candidate[2]) ? candidate[2]
				: object(candidate[2]) && Array.isArray(candidate[2].relatedIds) ? candidate[2].relatedIds : [];
			return candidate[1] === instanceId || related.includes(instanceId);
		});
		const neutralCache = row.length === 6 && row[2] === '' && row[3] === '' && localId.length > 0 && row[5] === 0;
		if (!neutralCache || hasOverride || hasConnect)
			fail(`PAD_NET 引用非 PAD/不存在局部 ID 且不满足 inactive cache 条件：${String(row[4])}`);
		inactivePadNetCache.push(row);
	}
	const connects = rows.filter(row => row[0] === 'CONNECT' && typeof row[1] === 'string' && ownedIds.has(row[1]));
	for (const row of connects) {
		const related = Array.isArray(row[2]) ? row[2] : object(row[2]) && Array.isArray(row[2].relatedIds) ? row[2].relatedIds : undefined;
		if (!related) fail(`CONNECT 关联结构无法解析：${String(row[1])}`);
		for (const child of related) {
			if (typeof child !== 'string' || !compositeIds.has(child))
				fail(`CONNECT 引用了当前 Footprint 实例外或未知子图元：${String(row[1])}→${String(child)}`);
		}
	}
	const instancePrimitives = rows.filter(row => typeof row[1] === 'string' && compositeIds.has(row[1])
		&& !['ATTR', 'PROP', 'PAD_NET', 'CONNECT', 'COMPONENT'].includes(String(row[0])));
	const all = rows.filter(row => (row[0] === 'COMPONENT' && row[1] === componentId)
		|| attributes.includes(row) || properties.includes(row) || padNets.includes(row) || inactivePadNetCache.includes(row)
		|| connects.includes(row) || instancePrimitives.includes(row));
	const compositePattern = /^[a-z]+\d+[a-z]+\d+$/i;
	for (const row of rows) {
		if (typeof row[1] !== 'string' || !compositePattern.test(row[1]) || !row[1].startsWith(componentId)) continue;
		const suffix = row[1].slice(componentId.length);
		if (/^[a-z]+\d+$/i.test(suffix) && !primitiveIds.has(suffix))
			fail(`发现无法归属的复合 Footprint 引用，拒绝静默忽略：${String(row[0])} ${row[1]}`);
	}
	return { attributes, properties, padNets, inactivePadNetCache, connects, primitives: instancePrimitives, all };
}

type FootprintMasterRows = { content: string; rows: LegacyRow[]; title: string };

function validatedMasterRows(content: string, sourcePath: string, footprintUuid: string): FootprintMasterRows {
	const rows = parseJsonLines(content, sourcePath);
	const [head] = uniqueRows(rows, row => row[0] === 'HEAD', `${sourcePath} HEAD`);
	const [doctype] = uniqueRows(rows, row => row[0] === 'DOCTYPE', `${sourcePath} DOCTYPE`);
	if (doctype[1] !== 'FOOTPRINT' || doctype[2] !== '1.8' || !object(head[1]) || head[1].uuid !== footprintUuid)
		fail(`旧格式封装 DOC identity 与精确资源键不符：${footprintUuid}`);
	return { content, rows, title: typeof head[1].title === 'string' ? head[1].title : '' };
}

async function parseMaster(zip: JSZip, footprintUuid: string, embedded: Map<string, FootprintMasterRows>): Promise<LegacyFootprintInstance['master']> {
	const path = `FOOTPRINT/${footprintUuid}.efoo`;
	const file = zip.file(path);
	const embeddedMaster = embedded.get(footprintUuid);
	if (!file && !embeddedMaster) fail(`旧格式工程缺少精确封装资源：${path}`);
	let externalMaster: FootprintMasterRows | undefined;
	if (file) externalMaster = validatedMasterRows(await file.async('string'), path, footprintUuid);
	if (externalMaster && embeddedMaster && !sameMultiset(externalMaster.rows, embeddedMaster.rows))
		fail(`同 UUID 外部与 PCB 嵌入封装内容冲突：${footprintUuid}`);
	const selected = externalMaster ?? embeddedMaster!;
	return { path: externalMaster ? path : `PCB embedded ${footprintUuid}`, uuid: footprintUuid, title: selected.title,
		content: selected.content, sha256: await sha256(selected.content), rows: selected.rows };
}

function splitPcbAndEmbeddedFootprints(rows: LegacyRow[], sourcePath: string): { pcbRows: LegacyRow[]; embedded: Map<string, FootprintMasterRows> } {
	const doctypeIndexes = rows.flatMap((row, index) => row[0] === 'DOCTYPE' ? [index] : []);
	const pcbIndexes = doctypeIndexes.filter(index => rows[index][1] === 'PCB');
	if (pcbIndexes.length !== 1)
		fail(`${sourcePath} PCB DOCTYPE 唯一性不成立（找到 ${pcbIndexes.length} 条）`);
	const pcbIndex = pcbIndexes[0];
	const embedded = new Map<string, FootprintMasterRows>();
	for (let sectionIndex = 0; sectionIndex < doctypeIndexes.length; sectionIndex++) {
		const start = doctypeIndexes[sectionIndex];
		const end = sectionIndex + 1 < doctypeIndexes.length ? doctypeIndexes[sectionIndex + 1] : rows.length;
		const section = rows.slice(start, end);
		const doctype = rows[start];
		if (doctype[2] !== '1.8') fail(`${sourcePath} DOCTYPE 版本无效：${String(doctype[1])}`);
		if (start === pcbIndex) continue;
		if (start > pcbIndex || doctype[1] !== 'FOOTPRINT')
			fail(`${sourcePath} 包含位于 PCB 之外的未知文档区块：${String(doctype[1])}`);
		const [head] = uniqueRows(section, row => row[0] === 'HEAD', `${sourcePath} 嵌入 FOOTPRINT HEAD`);
		if (!object(head[1]) || typeof head[1].uuid !== 'string' || !head[1].uuid.trim())
			fail(`${sourcePath} 嵌入 FOOTPRINT HEAD 缺少有效 UUID`);
		const footprintUuid = head[1].uuid;
		const content = section.map(row => JSON.stringify(row)).join('\n');
		const master = validatedMasterRows(content, `${sourcePath} embedded ${footprintUuid}`, footprintUuid);
		if (embedded.has(footprintUuid)) fail(`${sourcePath} 嵌入 FOOTPRINT UUID 重复：${footprintUuid}`);
		embedded.set(footprintUuid, master);
	}
	return { pcbRows: rows.slice(pcbIndex, doctypeIndexes.length ? rows.length : undefined), embedded };
}

export async function captureLegacyFootprintBoard(input: {
	archive: ArrayBuffer | Uint8Array;
	board: LegacyPcbBoardIdentity;
	components: LegacyPcbComponentIdentity[];
}): Promise<LegacyFootprintBoardCapture> {
	if (!Array.isArray(input?.components) || input.components.length === 0) fail('legacy capture 缺少模板器件');
	const boardName = text(input.board?.boardName, 'boardName');
	const schematicUuid = text(input.board?.schematicUuid, 'schematicUuid');
	text(input.board?.pcbUuid, '当前 PCB UUID');
	const pcbName = text(input.board?.pcbName, '当前 PCB name');
	const zip = await JSZip.loadAsync(input.archive);
	const projectFile = zip.file('project.json');
	if (!projectFile) fail('旧格式工程缺少 project.json');
	let projectValue: unknown;
	try { projectValue = JSON.parse(await projectFile.async('string')); }
	catch { fail('旧格式 project.json 不是有效 JSON'); }
	if (!object(projectValue)) fail('旧格式 project.json 结构无效');
	const selectedBoard = legacyBoard(projectValue, { boardName, schematicUuid, pcbUuid: input.board.pcbUuid, pcbName });
	const pcbFile = zip.file(selectedBoard.path);
	if (!pcbFile) fail(`旧格式工程缺少 Board 对应 PCB 文件：${selectedBoard.path}`);
	const pcbSource = await pcbFile.async('string');
	const allRows = parseJsonLines(pcbSource, selectedBoard.path);
	const sections = splitPcbAndEmbeddedFootprints(allRows, selectedBoard.path);
	const rows = sections.pcbRows;
	const [docType] = uniqueRows(rows, row => row[0] === 'DOCTYPE', `${selectedBoard.path} PCB DOCTYPE`);
	const [head] = uniqueRows(rows, row => row[0] === 'HEAD', `${selectedBoard.path} PCB HEAD`);
	if (docType[1] !== 'PCB' || !object(head[1]) || (head[1].uuid !== undefined && head[1].uuid !== selectedBoard.uuid))
		fail(`旧格式 PCB document type 与 manifest 不符：${selectedBoard.path}`);
	const instances: LegacyFootprintInstance[] = [];
	const groupMemberTypes = new Set(['COMPONENT', 'VIA', 'LINE', 'POLY', 'POUR']);
	const groupRecords = rows.filter(row => row[0] === 'GROUP');
	const groupIds = new Set<string>(groupRecords.map(group => text(group[1], `${selectedBoard.path} GROUP id`)));
	for (const row of rows) if (groupMemberTypes.has(String(row[0]))
		&& (typeof row[2] === 'string' || typeof row[2] === 'number' && Number.isFinite(row[2]))) groupIds.add(String(row[2]));
	const groups = [...groupIds].map(groupId => {
		const memberCounts: Record<string, number> = Object.create(null);
		for (const row of rows) if (groupMemberTypes.has(String(row[0])) && String(row[2]) === groupId)
			memberCounts[String(row[0])] = (memberCounts[String(row[0])] ?? 0) + 1;
		return { groupId, recordPresent: groupRecords.some(row => String(row[1]) === groupId), memberCounts };
	});
	if (new Set(groupRecords.map(group => String(group[1]))).size !== groupRecords.length)
		fail(`${selectedBoard.path} GROUP id 重复`);
	const seenSourceUids = new Set<string>();
	for (const component of input.components) {
		const sourceUid = text(component.sourceUid, 'sourceUid');
		const sourceComponentId = text(component.sourceComponentId, 'sourceComponentId');
		if (seenSourceUids.has(sourceUid)) fail(`模板 sourceUid 重复：${sourceUid}`);
		seenSourceUids.add(sourceUid);
		const matches = rows.filter(row => row[0] === 'COMPONENT' && object(row[7]) && row[7]['Unique ID'] === sourceUid);
		if (matches.length !== 1) fail(`旧格式 PCB 中 sourceUid ${sourceUid} 唯一性不成立（${matches.length}）`);
		const componentRow = matches[0];
		const componentId = text(componentRow[1], `${sourceUid} legacy component ID`);
		checkGeometry(componentRow, component);
		const attrRows = rows.filter(row => row[0] === 'ATTR' && row[3] === componentId);
		const footprintRows = attrRows.filter(row => row[7] === 'Footprint');
		if (footprintRows.length !== 1 || typeof footprintRows[0][8] !== 'string' || !footprintRows[0][8].trim())
			fail(`旧格式 PCB 的 Footprint ATTR 缺失/重复/无效：${sourceUid}`);
		const footprintUuid = footprintRows[0][8] as string;
		if (component.existingFootprintUuid !== undefined && component.existingFootprintUuid !== footprintUuid)
			fail(`旧格式 Footprint ATTR 与当前有效属性不一致：${sourceUid}`);
		if (component.getterFootprintUuid !== undefined && component.getterFootprintUuid !== footprintUuid)
			fail(`旧格式 Footprint ATTR 与实例 getter UUID 不一致：${sourceUid}`);
		if (component.nativeFootprintUuid !== undefined && !component.nativeFootprintUuid.trim())
			fail(`原生 Footprint 引用无效：${sourceUid}`);
		const master = await parseMaster(zip, footprintUuid, sections.embedded);
		const ids = new Set(attrRows.map(row => text(row[1], `${sourceUid} legacy ATTR ID`)));
		const primitiveRows = master.rows.filter(row => typeof row[1] === 'string' && !['DOCTYPE', 'HEAD', 'CANVAS', 'LAYER', 'PROP'].includes(String(row[0])));
		const primitiveIds = new Set(primitiveRows.map(row => row[1] as string));
		const padIds = new Set(master.rows.filter(row => row[0] === 'PAD' && typeof row[1] === 'string').map(row => row[1] as string));
		const linked = associatedRows(rows, componentId, ids, primitiveIds, padIds);
		instances.push({
				sourceUid, sourceComponentId, legacyComponentId: componentId, footprintUuid,
				legacyFootprintUuid: footprintUuid,
				...(component.nativeFootprintUuid ? { nativeFootprintUuid: component.nativeFootprintUuid,
					canonicalFootprintReference: component.nativeFootprintUuid } : {}),
			componentRow, nativeAttributes: component.nativeAttributes ?? {}, footprintAttributeRow: footprintRows[0],
			attributeRows: linked.attributes, propertyRows: linked.properties, padNetRows: linked.padNets,
			inactivePadNetCache: linked.inactivePadNetCache,
			connectRows: linked.connects, instancePrimitiveRows: linked.primitives,
			associatedRows: linked.all, master,
		});
	}
	return {
		boardName,
		schematicUuid,
		pcbName,
		legacyPcbUuid: selectedBoard.uuid,
		pcbPath: selectedBoard.path,
		...(typeof head[1].uuid === 'string' ? { pcbHeadUuid: head[1].uuid } : {}),
		pcbHeadUuidAbsent: head[1].uuid === undefined,
		instances,
		groups,
	};
}

export function verifyLegacyFootprintBodyReadback(input: {
	template: LegacyFootprintBoardCapture;
	target: LegacyFootprintBoardCapture;
	mappings: LegacyFootprintBodyMapping[];
	netMappings: Array<{ sourceNet: string; targetNet: string }>;
	lineGroupNormalizations?: LegacyFootprintLineGroupNormalization[];
}): LegacyFootprintBodyComparison {
	const mismatches: string[] = [];
	const hardMismatches: string[] = [];
	const referenceRepairMismatches: string[] = [];
	const hardMismatch = (message: string) => { mismatches.push(message); hardMismatches.push(message); };
	const matched: LegacyFootprintBodyComparison['matched'] = [];
	const mappingBySource = new Map<string, LegacyFootprintBodyMapping>();
	const seenTargets = new Set<string>();
	for (const mapping of input.mappings) {
		if (mappingBySource.has(mapping.sourceUid)) hardMismatch(`sourceUid 映射重复：${mapping.sourceUid}`);
		if (seenTargets.has(mapping.targetUid)) hardMismatch(`多个 sourceUid 映射到同一 targetUid：${mapping.targetUid}`);
		if (mapping.targetProps && Object.keys(mapping.targetProps).some(key => !['Channel ID', 'Group ID', 'Reuse Block'].includes(key)))
			hardMismatch(`目标器件属性映射含不允许覆盖的字段：${mapping.sourceUid}`);
		mappingBySource.set(mapping.sourceUid, mapping);
		seenTargets.add(mapping.targetUid);
	}
	if (mappingBySource.size !== input.template.instances.length)
		hardMismatch('sourceUid mapping 未完整覆盖模板 Footprint 实例');
	const aliasFields = ['Channel ID', 'Group ID', 'Reuse Block'] as const;
	const aliasEvidence = new Map<typeof aliasFields[number], Array<{ uid: string; expected: string; actual: string }>>();
	const groupMappings: Array<{ sourceUid: string; sourceNativeGroupId?: string | number; targetNativeGroupId?: string | number; sourceLegacyGroup: unknown; targetLegacyGroup: unknown }> = [];
	for (const source of input.template.instances) {
		const mapping = mappingBySource.get(source.sourceUid);
		if (!mapping) continue;
		const targetUid = mapping.targetUid;
		const targets = input.target.instances.filter(item => item.sourceUid === targetUid);
		if (targets.length !== 1) {
			hardMismatch(`目标旧格式 PCB 中 targetUid ${targetUid} 唯一性不成立（${targets.length}）`);
			continue;
		}
		const target = targets[0];
		groupMappings.push({ sourceUid: source.sourceUid, sourceNativeGroupId: mapping.sourceNativeGroupId,
			targetNativeGroupId: mapping.targetNativeGroupId, sourceLegacyGroup: source.componentRow[2], targetLegacyGroup: target.componentRow[2] });
		for (const key of ['Channel ID', 'Group ID', 'Reuse Block']) {
			if (mapping.targetProps && Object.prototype.hasOwnProperty.call(mapping.targetProps, key)
				&& target.nativeAttributes[key] !== mapping.targetProps[key])
				hardMismatch(`${source.sourceUid}→${targetUid} 当前 COMP ${key} 与确认后的目标语义不符`);
		}
		const sourceReference = source.canonicalFootprintReference ?? source.nativeFootprintUuid ?? source.footprintUuid;
		const targetReference = target.canonicalFootprintReference ?? target.nativeFootprintUuid ?? target.footprintUuid;
		const referenceChanged = sourceReference !== targetReference;
		const legacyReferenceChanged = source.footprintUuid !== target.footprintUuid;
		const aliasesProven = hasVerifiedFootprintAlias(source) && hasVerifiedFootprintAlias(target);
		if (legacyReferenceChanged && !aliasesProven && !referenceChanged)
			hardMismatch(`${source.sourceUid}→${targetUid} legacy Footprint UUID 变化缺少完整原生 alias 证明`);
		if (referenceChanged) {
			mismatches.push(`${source.sourceUid}→${targetUid} Footprint reference 改变：${sourceReference}→${targetReference}`);
			referenceRepairMismatches.push(`${source.sourceUid}→${targetUid} Footprint reference 改变`);
		}
		const identityToken = aliasesProven ? '__VERIFIED_FOOTPRINT_ALIAS__' : undefined;
		if (!sameMultiset(normalizedMasterRows(source.master.rows, identityToken), normalizedMasterRows(target.master.rows, identityToken))) {
			const message = `${source.sourceUid}→${targetUid} 完整 FOOTPRINT master 记录变化`;
			if (referenceChanged) referenceRepairMismatches.push(message);
			else hardMismatch(message);
		}
		const idMap = new Map<string, string>([[source.legacyComponentId, target.legacyComponentId]]);
		const sourcePrimitiveIds = new Set(source.master.rows.filter(row => typeof row[1] === 'string' && !['DOCTYPE', 'HEAD', 'CANVAS', 'LAYER', 'PROP'].includes(String(row[0]))).map(row => row[1] as string));
		const targetPrimitiveIds = new Set(target.master.rows.filter(row => typeof row[1] === 'string' && !['DOCTYPE', 'HEAD', 'CANVAS', 'LAYER', 'PROP'].includes(String(row[0]))).map(row => row[1] as string));
		if (stable([...sourcePrimitiveIds].sort()) !== stable([...targetPrimitiveIds].sort())) {
			const message = `${source.sourceUid}→${targetUid} master primitive ID 集合变化`;
			hardMismatch(message);
		}
		for (const primitiveId of sourcePrimitiveIds)
			idMap.set(`${source.legacyComponentId}${primitiveId}`, `${target.legacyComponentId}${primitiveId}`);
		const sourceAttrs = source.attributeRows;
		const targetAttrs = target.attributeRows;
		const sourceAttrKeys = new Map<string, LegacyRow[]>();
		const targetAttrKeys = new Map<string, LegacyRow[]>();
		for (const row of sourceAttrs) sourceAttrKeys.set(String(row[7]), [...(sourceAttrKeys.get(String(row[7])) ?? []), row]);
		for (const row of targetAttrs) targetAttrKeys.set(String(row[7]), [...(targetAttrKeys.get(String(row[7])) ?? []), row]);
		if (sourceAttrKeys.size !== targetAttrKeys.size || [...sourceAttrKeys.keys()].some(key => sourceAttrKeys.get(key)?.length !== targetAttrKeys.get(key)?.length))
			hardMismatch(`${source.sourceUid}→${targetUid} ATTR 键/重数变化`);
		else {
			for (const [key, sourceRows] of sourceAttrKeys) {
				const targetRows = targetAttrKeys.get(key)!;
				for (let index = 0; index < sourceRows.length; index++) {
					const sourceAttr = sourceRows[index];
					const targetAttr = targetRows[index];
					idMap.set(String(sourceAttr[1]), String(targetAttr[1]));
				}
			}
		}
		const expectedNets = new Map(input.netMappings.map(item => [item.sourceNet, item.targetNet]));
		const expectedComponent = [...source.componentRow];
		const sourceAttrsObject = object(expectedComponent[7]) ? expectedComponent[7] as JsonObject : undefined;
		const targetAttrsObject = object(target.componentRow[7]) ? target.componentRow[7] as JsonObject : undefined;
		if (!sourceAttrsObject || !targetAttrsObject) hardMismatch(`${source.sourceUid}→${targetUid} COMPONENT attrs 无效`);
		else {
			const expectedAttrs: JsonObject = { ...sourceAttrsObject, 'Unique ID': targetUid };
			// A reference-only difference is the one repairable case delegated to the
			// existing exact-reference restore plan. Keep that precise mismatch visible,
			// while excluding the same reference field from the body comparison.
			if ((referenceChanged || aliasesProven && legacyReferenceChanged) && Object.prototype.hasOwnProperty.call(targetAttrsObject, 'Footprint'))
				expectedAttrs.Footprint = targetAttrsObject.Footprint;
			for (const key of ['Channel ID', 'Group ID', 'Reuse Block'])
				if (mapping.targetProps && Object.prototype.hasOwnProperty.call(mapping.targetProps, key)) {
					const expectedValue = mapping.targetProps[key];
					if (typeof expectedValue === 'string' && typeof targetAttrsObject[key] === 'string') {
						const field = key as typeof aliasFields[number];
						aliasEvidence.set(field, [...(aliasEvidence.get(field) ?? []), { uid: targetUid, expected: expectedValue, actual: targetAttrsObject[key] as string }]);
						// Channel IDs are checked against confirmed native attrs above, then
						// compared using the target's legacy projection (for example native
						// $1I2 may serialize as legacy $1e2). Group/Reuse remain semantic.
						if (key === 'Channel ID') expectedAttrs[key] = targetAttrsObject[key];
						else expectedAttrs[key] = expectedValue;
					}
					else expectedAttrs[key] = expectedValue;
				}
			for (const [key, value] of Object.entries(sourceAttrsObject))
				if (!aliasFields.includes(key as typeof aliasFields[number])
					&& mapping.targetProps && Object.prototype.hasOwnProperty.call(mapping.targetProps, key)) expectedAttrs[key] = mapping.targetProps[key];
			const expectedComponentAttrs: LegacyRow = [...expectedComponent];
			const targetComponentAttrs = [...target.componentRow];
			if (stable(expectedAttrs) !== stable(targetAttrsObject)) hardMismatch(`${source.sourceUid}→${targetUid} COMPONENT 属性变化`);
			const { cos, sin } = rotationCoefficients(mapping.transform.rotationDegrees);
			const expectedX = Number(source.componentRow[4]) * cos - Number(source.componentRow[5]) * sin + mapping.transform.dx;
			const expectedY = Number(source.componentRow[4]) * sin + Number(source.componentRow[5]) * cos + mapping.transform.dy;
			const expectedRotation = normalizeDegrees(normalizeDegrees(source.componentRow[6], '源 COMPONENT[6]') + mapping.transform.rotationDegrees, '实例 COMPONENT[6]');
			expectedComponentAttrs[1] = target.componentRow[1];
			// COMPONENT[2] is the legacy group binding. Its allowed remap is checked
			// below against independently verified native group membership; do not
			// rewrite any other row slot that happens to contain the same scalar.
			expectedComponentAttrs[2] = target.componentRow[2];
			expectedComponentAttrs[4] = expectedX;
			expectedComponentAttrs[5] = expectedY;
			expectedComponentAttrs[6] = expectedRotation;
			expectedComponentAttrs[7] = expectedAttrs;
			targetComponentAttrs[1] = target.componentRow[1];
			targetComponentAttrs[6] = normalizeDegrees(target.componentRow[6], '目标 COMPONENT[6]');
			if (!equivalent(expectedComponentAttrs, targetComponentAttrs)) hardMismatch(`${source.sourceUid}→${targetUid} COMPONENT 几何/字段变化`);
		}
		const expectedNetRows = source.padNetRows.map(row => normalizeOwnedRow(row, idMap, target.legacyComponentId, mapping.transform, expectedNets));
		const actualNetRows = target.padNetRows.map(row => [...row]);
		if (!sameMultiset(expectedNetRows, actualNetRows))
			hardMismatch(`${source.sourceUid}→${targetUid} PAD_NET 网络/记录变化`);
		const expectedInactiveCache = source.inactivePadNetCache.map(row => {
			const copy = [...row];
			copy[1] = target.legacyComponentId;
			return copy;
		});
		if (!sameMultiset(expectedInactiveCache, target.inactivePadNetCache))
			hardMismatch(`${source.sourceUid}→${targetUid} PAD_NET inactive cache 记录变化`);
		const sourceAttrsForCompare = sourceAttrs;
		const targetAttrsForCompare = targetAttrs;
		const expectedAttrRows = sourceAttrsForCompare.map(row => {
			const copied = [...row];
			copied[1] = idMap.get(String(row[1])) ?? row[1];
			copied[3] = target.legacyComponentId;
			if (typeof copied[5] === 'number' && typeof copied[6] === 'number') {
				const { cos, sin } = rotationCoefficients(mapping.transform.rotationDegrees);
				const x = Number(row[5]); const y = Number(row[6]);
				copied[5] = x * cos - y * sin + mapping.transform.dx;
				copied[6] = x * sin + y * cos + mapping.transform.dy;
			}
			if (row[7] === 'Designator' && mapping.targetDesignator !== undefined) copied[8] = mapping.targetDesignator;
			else if (row[7] === 'Channel ID' && mapping.targetProps && Object.prototype.hasOwnProperty.call(mapping.targetProps, 'Channel ID')) {
				const actualChannelRows = targetAttrs.filter(attr => attr[7] === 'Channel ID');
				const expectedChannel = mapping.targetProps['Channel ID'];
				if (actualChannelRows.length !== 1 || typeof expectedChannel !== 'string' || typeof actualChannelRows[0][8] !== 'string')
					hardMismatch(`${source.sourceUid}→${targetUid} Channel ID ATTR 投影缺失/不唯一`);
				else {
					aliasEvidence.set('Channel ID', [...(aliasEvidence.get('Channel ID') ?? []),
						{ uid: targetUid, expected: expectedChannel, actual: actualChannelRows[0][8] as string }]);
					copied[8] = actualChannelRows[0][8];
				}
			}
			else if (typeof row[7] === 'string' && mapping.targetProps && Object.prototype.hasOwnProperty.call(mapping.targetProps, row[7])) copied[8] = mapping.targetProps[row[7]];
			if ((referenceChanged || aliasesProven && legacyReferenceChanged) && row[7] === 'Footprint') {
				const targetFootprintRows = targetAttrs.filter(attr => attr[7] === 'Footprint');
				if (targetFootprintRows.length !== 1) hardMismatch(`${source.sourceUid}→${targetUid} Footprint ATTR 重数变化`);
				else copied[8] = targetFootprintRows[0][8];
			}
			return copied;
		});
		const actualAttrRows = targetAttrsForCompare.map(row => [...row]);
		if (!sameMultiset(expectedAttrRows, actualAttrRows))
			hardMismatch(`${source.sourceUid}→${targetUid} ATTR 值/样式/位置变化`);
		const expectedProps = source.propertyRows.map(row => normalizeOwnedRow(row, idMap, target.legacyComponentId, mapping.transform, expectedNets));
		const actualProps = target.propertyRows.map(row => row);
		if (!sameMultiset(expectedProps, actualProps))
			hardMismatch(`${source.sourceUid}→${targetUid} PROP 样式/颜色变化`);
		const expectedConnects = source.connectRows.map(row => normalizeOwnedRow(row, idMap, target.legacyComponentId, mapping.transform, expectedNets));
		if (!sameMultiset(expectedConnects, target.connectRows))
			hardMismatch(`${source.sourceUid}→${targetUid} CONNECT 子图元关系变化`);
		const expectedPrimitives = source.instancePrimitiveRows.map(row => normalizeOwnedRow(row, idMap, target.legacyComponentId, mapping.transform, expectedNets));
		const actualPrimitives = target.instancePrimitiveRows.map(row => normalizeComparisonAngle(row));
		if (!sameMultiset(expectedPrimitives, actualPrimitives))
			hardMismatch(`${source.sourceUid}→${targetUid} 复合实例图元字段/几何/网络变化`);
		const excluded = new Set<LegacyRow>([source.componentRow, ...source.attributeRows, ...source.propertyRows, ...source.padNetRows,
			...source.inactivePadNetCache, ...source.connectRows, ...source.instancePrimitiveRows]);
		const targetExcluded = new Set<LegacyRow>([target.componentRow, ...target.attributeRows, ...target.propertyRows, ...target.padNetRows,
			...target.inactivePadNetCache, ...target.connectRows, ...target.instancePrimitiveRows]);
		const expectedOther = source.associatedRows.filter(row => !excluded.has(row)).map(row => normalizeOwnedRow(row, idMap, target.legacyComponentId, mapping.transform, expectedNets));
		const actualOther = target.associatedRows.filter(row => !targetExcluded.has(row));
		if (!sameMultiset(expectedOther, actualOther))
			hardMismatch(`${source.sourceUid}→${targetUid} 其他关联记录变化`);
		matched.push({ sourceUid: source.sourceUid, targetUid, footprintUuid: sourceReference, associatedRecordCount: target.associatedRows.length });
	}
	const groupKey = (value: unknown) => `${typeof value}:${String(value)}`;
	const isUngroupedNativeGroup = (key: string) => key === groupKey(0) || key === groupKey('0') || key === groupKey('');
	let requiresFinalFootprintVerification = false;
	const lineNormalizationByPair = new Map<string, LegacyFootprintLineGroupNormalization>();
	for (const normalization of input.lineGroupNormalizations ?? []) {
		const pair = `${groupKey(normalization.sourceNativeGroupId)}\u0000${groupKey(normalization.targetNativeGroupId)}`;
		if (normalization.status !== 'conditional_on_final_footprint_verification'
			|| !normalization.placementOperationId || lineNormalizationByPair.has(pair)
			|| !Array.isArray(normalization.sourceLineIds) || !Array.isArray(normalization.targetLineIds)
			|| !Array.isArray(normalization.merges) || !Array.isArray(normalization.padCovered)
			|| normalization.sourceLineCount !== normalization.sourceLineIds.length
			|| normalization.targetLineCount !== normalization.targetLineIds.length
			|| new Set(normalization.sourceLineIds).size !== normalization.sourceLineIds.length
			|| new Set(normalization.targetLineIds).size !== normalization.targetLineIds.length) {
			hardMismatch('原生 GROUP LINE 正规化证明结构/组配对/成员快照无效');
			continue;
		}
		const sources = new Set(normalization.sourceLineIds), targets = new Set(normalization.targetLineIds);
		const consumed = new Set<string>(), projected = new Set<string>();
		let valid = true;
		for (const merge of normalization.merges) {
			if (!Array.isArray(merge.sourceLineIds) || merge.sourceLineIds.length < 2 || !targets.has(merge.targetLineId)
				|| projected.has(merge.targetLineId) || new Set(merge.sourceLineIds).size !== merge.sourceLineIds.length
				|| merge.sourceLineIds.some(id => !sources.has(id) || consumed.has(id))) { valid = false; break; }
			merge.sourceLineIds.forEach(id => consumed.add(id));
			projected.add(merge.targetLineId);
		}
		const associationIds = new Set<string>();
		for (const covered of normalization.padCovered) {
			if (!sources.has(covered.sourceLineId) || consumed.has(covered.sourceLineId)
				|| !covered.padCoverageAssociationId.trim() || associationIds.has(covered.padCoverageAssociationId)) { valid = false; break; }
			consumed.add(covered.sourceLineId);
			associationIds.add(covered.padCoverageAssociationId);
		}
		const reduction = normalization.merges.reduce((sum, merge) => sum + merge.sourceLineIds.length - 1, 0) + normalization.padCovered.length;
		if (!valid || normalization.targetLineCount !== normalization.sourceLineCount - reduction
			|| normalization.sourceLineCount - consumed.size !== normalization.targetLineCount - projected.size) {
			hardMismatch('原生 GROUP LINE 正规化证明的 ID 消费或计数公式无效');
			continue;
		}
		lineNormalizationByPair.set(pair, normalization);
	}
	for (const group of groupMappings) {
		const hasSource = group.sourceNativeGroupId !== undefined;
		const hasTarget = group.targetNativeGroupId !== undefined;
		if (hasSource !== hasTarget) hardMismatch(`${group.sourceUid} 原生组映射不完整`);
		if (!hasSource && !equivalent(group.sourceLegacyGroup, group.targetLegacyGroup))
			hardMismatch(`${group.sourceUid} 未分组器件的旧格式 COMPONENT[2] 组槽发生变化`);
	}
	const nativeGroupProofPresent = groupMappings.some(group => group.sourceNativeGroupId !== undefined || group.targetNativeGroupId !== undefined);
	for (let first = 0; nativeGroupProofPresent && first < groupMappings.length; first++) for (let second = first + 1; second < groupMappings.length; second++) {
		const left = groupMappings[first], right = groupMappings[second];
		const sourceNativeSame = left.sourceNativeGroupId !== undefined && right.sourceNativeGroupId !== undefined
			&& groupKey(left.sourceNativeGroupId) === groupKey(right.sourceNativeGroupId);
		const targetNativeSame = left.targetNativeGroupId !== undefined && right.targetNativeGroupId !== undefined
			&& groupKey(left.targetNativeGroupId) === groupKey(right.targetNativeGroupId);
		if (sourceNativeSame !== targetNativeSame)
			hardMismatch(`${left.sourceUid}/${right.sourceUid} 原生分组关系在导入后发生变化`);
		const sourceLegacySame = equivalent(left.sourceLegacyGroup, right.sourceLegacyGroup);
		const targetLegacySame = equivalent(left.targetLegacyGroup, right.targetLegacyGroup);
		if (sourceNativeSame !== sourceLegacySame)
			hardMismatch(`${left.sourceUid}/${right.sourceUid} 来源旧格式 COMPONENT[2] 与原生组分组关系不符`);
		if (targetNativeSame !== targetLegacySame)
			hardMismatch(`${left.sourceUid}/${right.sourceUid} 目标旧格式 COMPONENT[2] 与原生组分组关系不符`);
	}
	if (nativeGroupProofPresent) {
		const groupAliases = new Map<string, { sourceId: string; targetId: string; sourceNativeId: string; targetNativeId: string }>();
		for (const mapping of groupMappings) {
			if (mapping.sourceNativeGroupId === undefined || mapping.targetNativeGroupId === undefined) continue;
			const sourceId = String(mapping.sourceLegacyGroup), targetId = String(mapping.targetLegacyGroup);
			const sourceNativeId = groupKey(mapping.sourceNativeGroupId), targetNativeId = groupKey(mapping.targetNativeGroupId);
			const key = `${sourceNativeId}\u0000${targetNativeId}`;
			const previous = groupAliases.get(key);
			if (previous && (previous.sourceId !== sourceId || previous.targetId !== targetId))
				hardMismatch(`${mapping.sourceUid} 原生组到旧格式 COMPONENT[2] 别名不唯一`);
			else groupAliases.set(key, { sourceId, targetId, sourceNativeId, targetNativeId });
		}
		const consumedLineNormalizations = new Set<string>();
		for (const [pairKey, alias] of groupAliases) {
			const sourceGroups = input.template.groups.filter(group => group.groupId === alias.sourceId);
			const targetGroups = input.target.groups.filter(group => group.groupId === alias.targetId);
			const lineNormalization = lineNormalizationByPair.get(pairKey);
			if (lineNormalization) consumedLineNormalizations.add(pairKey);
			if (sourceGroups.length !== 1) hardMismatch(`来源 COMPONENT[2] 组别名没有唯一成员快照：${alias.sourceId}`);
			if (targetGroups.length !== 1) hardMismatch(`目标 COMPONENT[2] 组别名没有唯一成员快照：${alias.targetId}`);
			if (input.template.groups.some(group => group.recordPresent) && !isUngroupedNativeGroup(alias.sourceNativeId)
				&& sourceGroups.length === 1 && !sourceGroups[0].recordPresent)
				hardMismatch(`来源旧格式 GROUP 与 COMPONENT[2] 组别名不唯一：${alias.sourceId}`);
			if (input.target.groups.some(group => group.recordPresent) && !isUngroupedNativeGroup(alias.targetNativeId)
				&& targetGroups.length === 1 && !targetGroups[0].recordPresent)
				hardMismatch(`目标旧格式 GROUP 与 COMPONENT[2] 组别名不唯一：${alias.targetId}`);
			if (sourceGroups.length === 1 && targetGroups.length === 1) {
				if (lineNormalization) {
					const sourceCounts = sourceGroups[0].memberCounts, targetCounts = targetGroups[0].memberCounts;
					const allTypes = new Set([...Object.keys(sourceCounts), ...Object.keys(targetCounts)]);
					for (const type of allTypes) {
						if (type === 'LINE') continue;
						if ((sourceCounts[type] ?? 0) !== (targetCounts[type] ?? 0))
							hardMismatch(`旧格式 GROUP ${type} 成员数量变化：${alias.sourceId}→${alias.targetId}`);
					}
					if ((sourceCounts.LINE ?? 0) !== lineNormalization.sourceLineCount
						|| (targetCounts.LINE ?? 0) !== lineNormalization.targetLineCount)
						hardMismatch(`旧格式 GROUP LINE 实际数量与原生证明不符：${alias.sourceId}→${alias.targetId}`);
				}
				else if (stable(sourceGroups[0].memberCounts) !== stable(targetGroups[0].memberCounts))
					hardMismatch(`旧格式 GROUP 成员类型数量变化：${alias.sourceId}→${alias.targetId}`);
			}
		}
		if (consumedLineNormalizations.size !== lineNormalizationByPair.size)
			hardMismatch('原生 GROUP LINE 正规化证明没有绑定到唯一旧格式组别名');
		requiresFinalFootprintVerification = consumedLineNormalizations.size > 0;
	}
	else if (lineNormalizationByPair.size)
		hardMismatch('原生 GROUP LINE 正规化证明缺少原生组成员映射');
	for (const field of aliasFields) {
		const values = aliasEvidence.get(field) ?? [];
		for (const value of values) {
			if ((value.expected === '') !== (value.actual === ''))
				hardMismatch(`${value.uid} ${field} 空值状态变化`);
		}
		for (let first = 0; first < values.length; first++) for (let second = first + 1; second < values.length; second++) {
			const left = values[first]; const right = values[second];
			if (!left.expected || !right.expected) continue;
			if ((left.expected === right.expected) !== (left.actual === right.actual))
				hardMismatch(`${left.uid}/${right.uid} ${field} 分组关系变化`);
		}
	}
	const confirmed = mismatches.length === 0 && matched.length === input.template.instances.length;
	const referenceRestoreEligible = !confirmed && referenceRepairMismatches.length > 0
		&& hardMismatches.length === 0 && matched.length === input.template.instances.length;
	return { confirmed, noOp: confirmed && !requiresFinalFootprintVerification, requiresFinalFootprintVerification,
		stateRestoreEligible: false,
		referenceRestoreEligible, matched, mismatches: [...mismatches, ...referenceRepairMismatches], referenceRepairMismatches };
}
