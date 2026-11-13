import JSZip from 'jszip';
import { createNativeInspector } from './native-analysis/inspector-core.mjs';
import type { PreparedReplacement } from './componentReplacementHost';
import type { ReplacementStage, ReplacementStageContext } from './componentReplacement';
import { assertReplacementComponentIdentity, parseReplacementNativeSource, type ReplacementNativeRecord } from './componentReplacementNative';
import { assertFreshEffectiveDeviceAssociation, predictCandidateSchPersistenceModels, projectEffectiveDeviceRawExpected } from './componentReplacementSchematic';
import { activateOrOpenReplacementDocument } from './componentReplacementNavigation';

type ObjectValue = Record<string, any>;
type DocumentSnapshot = { uuid: string; type: 1 | 3; source: string };
type CloseAcknowledgement = { docUuid: string; tabId: string; closeAck: boolean | null; error?: string };
type CloseTreePoll = { elapsedMs: number; tree: unknown; valid: boolean; remainingTargetIds: string[]; error?: string };
type CloseReadback = { stage: 'save_close_reopen'; before: DocumentSnapshot[]; after: DocumentSnapshot[]; closedTabIds: string[]; closeAcknowledgements: CloseAcknowledgement[]; closeTreePolls: CloseTreePoll[]; candidateDefaultPersistenceProofs:ObjectValue[] };
class CloseVerificationError extends Error {
	readonly failureEvidence: ObjectValue;
	constructor(message: string, failureEvidence: ObjectValue) { super(message); this.name = 'CloseVerificationError'; this.failureEvidence = failureEvidence; }
}
function pause(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
const geometryTolerance = 1e-9;
function closeGeometryNumber(expected: unknown, actual: unknown): boolean {
	return typeof expected === 'number' && Number.isFinite(expected) && typeof actual === 'number' && Number.isFinite(actual)
		&& Math.abs(expected - actual) <= geometryTolerance;
}
function equalGeometryValue(expected: unknown, actual: unknown): boolean {
	if (typeof expected === 'number' || typeof actual === 'number') return closeGeometryNumber(expected, actual);
	if (Array.isArray(expected) || Array.isArray(actual)) return Array.isArray(expected) && Array.isArray(actual)
		&& expected.length === actual.length && expected.every((item, index) => equalGeometryValue(item, actual[index]));
	if (expected && typeof expected === 'object' || actual && typeof actual === 'object') {
		if (!expected || !actual || typeof expected !== 'object' || typeof actual !== 'object') return false;
		const a = Object.keys(expected as ObjectValue).sort(), b = Object.keys(actual as ObjectValue).sort();
		return stable(a) === stable(b) && a.every(key => equalGeometryValue((expected as ObjectValue)[key], (actual as ObjectValue)[key]));
	}
	return stable(expected) === stable(actual);
}
function samePadGeometry(expectedRows: ObjectValue[], actualRows: ObjectValue[]): boolean {
	if (expectedRows.length !== actualRows.length) return false;
	const expected = [...expectedRows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
	const actual = [...actualRows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
	const strictFields = ['id', 'number', 'layer'];
	const numericFields = ['x', 'y', 'rotation', 'holeOffsetX', 'holeOffsetY', 'holeRotation'];
	const nestedNumericFields = ['shape', 'hole', 'specialPad'];
	return expected.every((row, index) => {
		const candidate = actual[index];
		return strictFields.every(field => stable(row[field]) === stable(candidate[field]))
			&& numericFields.every(field => closeGeometryNumber(row[field], candidate[field]))
			&& nestedNumericFields.every(field => equalGeometryValue(row[field] ?? null, candidate[field] ?? null));
	});
}
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as ObjectValue)[key])}`).join(',')}}`;
	return JSON.stringify(value);
}
function value(object: unknown, getter: string): any {
	const fn = (object as ObjectValue | undefined)?.[`getState_${getter}`];
	if (typeof fn !== 'function') throw new Error(`最终读回缺少 SDK getter ${getter}`);
	return fn.call(object);
}
function oneStage(results: unknown[], stage: string, index?: number, partIndex?: number): ObjectValue {
	const rows = results.filter((r): r is ObjectValue => Boolean(r && typeof r === 'object' && (r as ObjectValue).stage === stage
		&& (index === undefined || (r as ObjectValue).replacementIndex === index) && (partIndex === undefined || (r as ObjectValue).partIndex === partIndex)));
	if (rows.length !== 1) throw new Error(`最终验收缺少唯一阶段结果 ${stage}/${index ?? ''}/${partIndex ?? ''}`);
	return rows[0];
}
function documentList(prepared: PreparedReplacement): Array<{ uuid: string; type: 1 | 3 }> {
	return [{ uuid: prepared.pcbUuid, type: 3 }, ...[...new Set(prepared.replacements.flatMap(r => r.schematicParts.map(p => p.pageUuid)))].map(uuid => ({ uuid, type: 1 as const }))];
}
function records(source: string, uuid: string, type: 1 | 3): ReplacementNativeRecord[] {
	return parseReplacementNativeSource(source, uuid, type === 3 ? 'PCB' : 'SCH_PAGE').records;
}
function key(record: ReplacementNativeRecord): string { return `${record.type}\0${record.id}`; }
function padOwner(record: ReplacementNativeRecord): string | undefined {
	if (record.type !== 'PAD_NET') return undefined;
	try { const tuple = JSON.parse(record.id); return Array.isArray(tuple) && tuple.length===4 && tuple[0] === 'PAD_NET' && tuple.slice(1).every(v=>typeof v==='string'&&v.length>0) ? tuple[1] : undefined; }
	catch { return undefined; }
}
function parent(record: ReplacementNativeRecord): string | undefined {
	return record.data && typeof record.data === 'object' ? (record.data as ObjectValue).parentId : undefined;
}
function nativeComponent(rows: ReplacementNativeRecord[], id: string): ObjectValue {
	const found = rows.filter(r => r.type === 'COMPONENT' && r.id === id);
	if (found.length !== 1 || !found[0].data || typeof found[0].data !== 'object') throw new Error(`最终原生 COMPONENT 不唯一：${id}`);
	return found[0].data as ObjectValue;
}
function attrsFor(rows: ReplacementNativeRecord[], id: string): ObjectValue {
	const output: ObjectValue = {};
	for (const r of rows.filter(r => r.type === 'ATTR' && parent(r) === id)) {
		const data = r.data as ObjectValue;
		if (Object.hasOwn(output, data.key) && stable(output[data.key]) !== stable(data.value)) throw new Error(`最终属性键冲突：${id}/${data.key}`);
		output[data.key] = data.value;
	}
	return output;
}
function referenceUuid(raw: unknown): string {
	let parsed: any = raw;
	if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { return raw; } }
	if (typeof parsed?.uuid === 'string') return parsed.uuid;
	if (typeof parsed?.uuid?.uuid === 'string') return parsed.uuid.uuid;
	throw new Error('最终器件/封装引用无法解析');
}
function inspectSplitScreenTree(tree: unknown): { valid: boolean; tabIds: string[] } {
	const tabIds: string[] = [], seen = new Set<string>();
	const visit = (node: unknown): boolean => {
		if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
		const row = node as ObjectValue;
		if (typeof row.id !== 'string' || !row.id || (!Object.hasOwn(row, 'tabs') && !Object.hasOwn(row, 'children'))) return false;
		if (Object.hasOwn(row, 'tabs')) {
			if (!Array.isArray(row.tabs)) return false;
			for (const tab of row.tabs) {
				if (!tab || typeof tab !== 'object' || typeof (tab as ObjectValue).tabId !== 'string' || !(tab as ObjectValue).tabId) return false;
				const tabId = (tab as ObjectValue).tabId as string;
				if (seen.has(tabId)) return false;
				seen.add(tabId); tabIds.push(tabId);
			}
		}
		if (Object.hasOwn(row, 'children')) {
			if (!Array.isArray(row.children) || !row.children.every(visit)) return false;
		}
		return true;
	};
	return { valid: visit(tree), tabIds };
}

/** Compare two live representations. No archive normalization belongs in this comparison. */
export function assertReplacementRecordsUnchanged(before: ReplacementNativeRecord[], after: ReplacementNativeRecord[], excluded: Set<string>): void {
	const differences = replacementRecordDifferenceKeys(before,after,excluded);
	if (differences.length) throw new Error(`非目标原生记录发生变化：${differences.slice(0, 12).map(k => k.replace('\0', '/')).join(',')}`);
}
function replacementRecordDifferenceKeys(before:ReplacementNativeRecord[],after:ReplacementNativeRecord[],excluded:Set<string>):string[]{
	const expected=new Map(before.filter(r=>!excluded.has(key(r))).map(r=>[key(r),{header:r.header,data:r.data}]));
	const actual=new Map(after.filter(r=>!excluded.has(key(r))).map(r=>[key(r),{header:r.header,data:r.data}]));
	return [...new Set([...expected.keys(),...actual.keys()])].filter(k=>stable(expected.get(k))!==stable(actual.get(k)));
}
function replacementRecordDifferenceSummary(before:ReplacementNativeRecord[],after:ReplacementNativeRecord[]):ObjectValue{
	const identities=replacementRecordDifferenceKeys(before,after,new Set()),sequenceChanged=stable(before.map(row=>({header:row.header,data:row.data})))!==stable(after.map(row=>({header:row.header,data:row.data})));
	return {count:identities.length+(sequenceChanged&&identities.length===0?1:0),identities:identities.slice(0,20),sequenceChanged};
}
type NativeTargetExpected={component:{id:string;data:ObjectValue};attributes:Array<{id:string;data:ObjectValue}>};
type SchPersistenceModel={model:'associated-template'|'plain-template';persistedExpected:NativeTargetExpected;defaultTransitions:ObjectValue[];orderedChildrenProof:ObjectValue[]};
function targetNativeExpected(rows:ReplacementNativeRecord[],candidateId:string):NativeTargetExpected{
	const components=rows.filter(row=>row.type==='COMPONENT'&&row.id===candidateId),attributes=rows.filter(row=>row.type==='ATTR'&&parent(row)===candidateId);
	if(components.length!==1||!components[0].data||typeof components[0].data!=='object')throw new Error(`默认持久化目标COMPONENT不唯一：${candidateId}`);
	return {component:{id:candidateId,data:components[0].data as ObjectValue},attributes:attributes.map(row=>({id:row.id,data:row.data as ObjectValue}))};
}
function assertNativeTargetExpected(actual:NativeTargetExpected,expected:unknown,candidateId:string,stage:string):void{
	if(!expected||typeof expected!=='object'||Array.isArray(expected))throw new Error(`${stage}目标快照缺失`);
	const target=expected as ObjectValue,component=target.component,attributes=target.attributes;
	if(!component||component.id!==candidateId||!component.data||typeof component.data!=='object'||!Array.isArray(attributes))throw new Error(`${stage}目标快照结构无效`);
	const ids=new Set<string>();
	for(const row of attributes){if(!row||typeof row.id!=='string'||!row.id||ids.has(row.id)||!row.data||typeof row.data!=='object'||row.data.parentId!==candidateId)throw new Error(`${stage}目标ATTR快照无效`);ids.add(row.id);}
	if(stable(actual)!==stable({component:{id:component.id,data:component.data},attributes:attributes.map(row=>({id:row.id,data:row.data}))}))throw new Error(`${stage}候选目标完整原生记录不符：${candidateId}`);
}
function replaceNativeTargetRows(rows:ReplacementNativeRecord[],candidateId:string,target:NativeTargetExpected):ReplacementNativeRecord[]{
	const component=target.component,attributes=new Map(target.attributes.map(row=>[row.id,row.data]));
	return rows.map(row=>row.type==='COMPONENT'&&row.id===candidateId?{...row,data:component.data}
		:row.type==='ATTR'&&parent(row)===candidateId&&attributes.has(row.id)?{...row,data:attributes.get(row.id)!}:row);
}
function setMissingFalse(data:ObjectValue,path:unknown[],type:string):void{
	const validPath=type==='COMPONENT'&&stable(path)===stable(['attrs','isSwitchClose'])||type==='ATTR'&&stable(path)===stable(['strikeout']);
	if(!validPath)throw new Error('默认持久化迁移路径超出已确认字段');
	let target:ObjectValue=data;
	for(const key of path.slice(0,-1)){if(typeof key!=='string'||!target[key]||typeof target[key]!=='object'||Array.isArray(target[key]))throw new Error('默认持久化迁移父路径缺失');target=target[key];}
	const leaf=path.at(-1);
	if(typeof leaf!=='string'||Object.hasOwn(target,leaf))throw new Error('默认持久化迁移源字段并非缺失');
	target[leaf]=false;
}
function applyDefaultTransitions(expected:NativeTargetExpected,transitions:unknown,candidateId:string):NativeTargetExpected{
	if(!Array.isArray(transitions))throw new Error('默认持久化迁移表无效');
	const output=JSON.parse(JSON.stringify(expected)) as NativeTargetExpected,seen=new Set<string>();
	for(const row of transitions){
		if(!row||typeof row!=='object'||row.from!=='missing'||row.to!==false||!Array.isArray(row.path))throw new Error('默认持久化迁移项无效');
		const identity=`${row.type}\0${row.id}\0${stable(row.path)}`;if(seen.has(identity))throw new Error('默认持久化迁移项重复');seen.add(identity);
		if(row.type==='COMPONENT'&&row.id===candidateId)setMissingFalse(output.component.data,row.path,row.type);
		else if(row.type==='ATTR'){
			const attr=output.attributes.find(item=>item.id===row.id);
			if(!attr)throw new Error('默认持久化迁移ATTR不属于候选目标');
			setMissingFalse(attr.data,row.path,row.type);
		}else throw new Error('默认持久化迁移记录超出候选COMPONENT/ATTR');
	}
	return output;
}
export function assertSubmittedWireProof(submitted:unknown,wire:unknown,inputTransitions:unknown,defaultTransitions:unknown,deviceNameProof:unknown,candidateId:string,deviceTitle:unknown,deviceUuid:string,effectiveDeviceAssociation?:ObjectValue):void{
	const submittedTarget=submitted as NativeTargetExpected,wireTarget=wire as NativeTargetExpected;
	assertNativeTargetExpected(submittedTarget,submitted,candidateId,'已提交');
	assertNativeTargetExpected(wireTarget,wire,candidateId,'wire');
	if(!Array.isArray(inputTransitions))throw new Error('候选输入到wire迁移表无效');
	const defaults=Array.isArray(defaultTransitions)?defaultTransitions as ObjectValue[]:[];
	const output=JSON.parse(JSON.stringify(submittedTarget)) as NativeTargetExpected,seen=new Set<string>();
	for(const raw of inputTransitions){
		if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('候选输入到wire迁移项无效');
		const row=raw as ObjectValue,type=row.type,id=row.id,path=row.path;
		if((type!=='COMPONENT'&&type!=='ATTR')||typeof id!=='string'||!Array.isArray(path)||row.from!==false||row.to!=='missing')throw new Error('候选输入到wire迁移项无效');
		const identity=`${type}\0${id}\0${stable(path)}`;if(seen.has(identity))throw new Error('候选输入到wire迁移重复');seen.add(identity);
		if(type==='COMPONENT'){
			if(id!==candidateId||stable(path)!==stable(['attrs','isSwitchClose'])||!defaults.some(item=>item.type==='COMPONENT'&&item.id===id&&stable(item.path)===stable(path)))throw new Error('候选COMPONENT输入到wire路径超出声明默认字段');
			const attrs=output.component.data.attrs;if(!attrs||typeof attrs!=='object'||Array.isArray(attrs)||attrs.isSwitchClose!==false)throw new Error('候选COMPONENT输入字段不是false');
			delete attrs.isSwitchClose;
		}else{
			if(stable(path)!==stable(['strikeout'])||!defaults.some(item=>item.type==='ATTR'&&item.id===id&&stable(item.path)===stable(path)))throw new Error('候选ATTR输入到wire路径超出克隆归属字段');
			const attr=output.attributes.find(item=>item.id===id);if(!attr||attr.data.parentId!==candidateId||attr.data.strikeout!==false)throw new Error('候选ATTR输入字段不是目标false值');
			delete attr.data.strikeout;
		}
	}
	let expectedWire=output;
	if(effectiveDeviceAssociation){
		if(effectiveDeviceAssociation.candidateId!==candidateId||effectiveDeviceAssociation.deviceUuid!==deviceUuid)throw new Error('有效Device关联证明与候选/DEVICE不符');
		const typedAttr=effectiveDeviceAssociation.typedAttr,typedReference=effectiveDeviceAssociation.typedReference;
		if(!typedAttr||typedAttr.primitiveId!==effectiveDeviceAssociation.attrId||typedAttr.parentPrimitiveId!==candidateId||typedAttr.key!=='Device'||typedAttr.value!==deviceUuid
			||!typedReference||typedReference.uuid!==deviceUuid||(typedReference.libraryUuid!==undefined&&typedReference.libraryUuid!==null&&typedReference.libraryUuid!==''
				&&typedReference.libraryUuid!==effectiveDeviceAssociation.projectUuid&&typedReference.libraryUuid!==effectiveDeviceAssociation.sourceLibraryUuid))throw new Error('有效Device关联缺少即时fresh typed属性/引用证明');
		expectedWire=projectEffectiveDeviceRawExpected(output,effectiveDeviceAssociation) as NativeTargetExpected;
	}
	if(stable(expectedWire)!==stable(wireTarget))throw new Error('已提交候选与实际wire差异超出DeviceName/声明输入迁移');
	if(!deviceNameProof||typeof deviceNameProof!=='object'||Array.isArray(deviceNameProof))throw new Error('DeviceName规范化证明无效');
	const nameProof=deviceNameProof as ObjectValue;
	if(nameProof.deviceUuid!==deviceUuid||typeof deviceTitle!=='string'||nameProof.title!==deviceTitle||nameProof.source!==''
		||nameProof.serialized!==JSON.stringify({name:deviceTitle,source:'',uuid:deviceUuid}))throw new Error('DeviceName规范化证明与DEVICE META不符');
	const serialized=nameProof.serialized;
	if(submittedTarget.component.data.attrs?.DeviceName!==serialized||wireTarget.component.data.attrs?.DeviceName!==serialized)throw new Error('候选wire DeviceName不等于规范化序列化值');
}
function applyDefaultExpectedToRows(rows:ReplacementNativeRecord[],candidateId:string,expected:NativeTargetExpected):ReplacementNativeRecord[]{
	const componentById=new Map(expected.attributes.map(row=>[row.id,row.data]));
	return rows.map(row=>row.type==='COMPONENT'&&row.id===candidateId?{...row,data:expected.component.data}
		:row.type==='ATTR'&&parent(row)===candidateId&&componentById.has(row.id)?{...row,data:componentById.get(row.id)!}:row);
}
function canonicalTicketSequence(rows: ReplacementNativeRecord[]): boolean {
	const seen = new Set<string>();
	for (const [index, row] of rows.entries()) {
		const identity = key(row), ticket = row.header.ticket;
		if (seen.has(identity) || !Number.isSafeInteger(ticket) || ticket !== index + 1) return false;
		seen.add(identity);
	}
	return true;
}
function headerWithoutTicket(header: Record<string, unknown>): ObjectValue {
	const copy = { ...header }; delete copy.ticket; return copy;
}
function assertReplacementRecordsWithTicketReindex(before: ReplacementNativeRecord[], after: ReplacementNativeRecord[], excluded: Set<string>,
	expectedRemoved: Set<string>, expectedAdded: Set<string>, documentUuid: string, stage: string): ObjectValue | undefined {
	// A noncanonical snapshot gets the ordinary strict comparison. It never receives a ticket exception.
	if (!canonicalTicketSequence(before) || !canonicalTicketSequence(after)) {
		assertReplacementRecordsUnchanged(before, after, excluded); return undefined;
	}
	const beforeKeys = before.map(key), afterKeys = after.map(key), beforeSet = new Set(beforeKeys), afterSet = new Set(afterKeys);
	const removed = new Set(beforeKeys.filter(identity => !afterSet.has(identity))), added = new Set(afterKeys.filter(identity => !beforeSet.has(identity)));
	if (stable([...removed].sort()) !== stable([...expectedRemoved].sort()) || stable([...added].sort()) !== stable([...expectedAdded].sort()))
		throw new Error(`ticket重排阶段新增/删除记录超出明确所有权：${stage}/${documentUuid}`);
	const retainedBefore = beforeKeys.filter(identity => !removed.has(identity)), retainedAfter = afterKeys.filter(identity => !added.has(identity));
	if (stable(retainedBefore) !== stable(retainedAfter)) throw new Error(`ticket重排改变了保留记录相对顺序：${stage}/${documentUuid}`);
	const beforeByKey = new Map(before.map(row => [key(row), row])), afterByKey = new Map(after.map(row => [key(row), row]));
	for (const identity of beforeKeys.filter(identity => afterSet.has(identity) && !excluded.has(identity))) {
		const old = beforeByKey.get(identity)!, next = afterByKey.get(identity)!;
		if (stable(headerWithoutTicket(old.header)) !== stable(headerWithoutTicket(next.header)) || stable(old.data) !== stable(next.data))
			throw new Error(`ticket重排伴随保留记录内容变化：${identity.replace('\0', '/')}`);
	}
	const mappings: ObjectValue[] = [];
	for (const identity of beforeKeys.filter(identity => afterSet.has(identity))) {
		const oldIndex = beforeKeys.indexOf(identity), newIndex = afterKeys.indexOf(identity);
		const removedBefore = beforeKeys.slice(0, oldIndex).filter(value => removed.has(value)).length;
		const addedBefore = afterKeys.slice(0, newIndex).filter(value => added.has(value)).length;
		if (newIndex !== oldIndex - removedBefore + addedBefore) throw new Error(`ticket映射与明确增删数量不符：${identity.replace('\0', '/')}`);
		const oldTicket = beforeByKey.get(identity)!.header.ticket, newTicket = afterByKey.get(identity)!.header.ticket;
		if (oldTicket !== newTicket) mappings.push({ key: identity, before: oldTicket, after: newTicket, removedBefore, addedBefore });
	}
	return mappings.length ? { documentUuid, stage, recordCountBefore: before.length, recordCountAfter: after.length, added: [...added], removed: [...removed], mappings } : undefined;
}
export function mergeReplacementSchematicNetlists(target:ObjectValue,incoming:ObjectValue):void {
	for(const [uid,row] of Object.entries(incoming)) {
		const existing=target[uid];
		if(!existing){target[uid]=JSON.parse(JSON.stringify(row));continue;}
		if(stable(existing.props)!==stable(row.props))throw new Error('跨页面重复UID的器件属性冲突');
		for(const [number,pin]of Object.entries(row.pinInfoMap??{})){
			if(Object.hasOwn(existing.pinInfoMap??{},number)&&stable(existing.pinInfoMap[number])!==stable(pin))throw new Error('跨页面重复UID的引脚冲突');
			existing.pinInfoMap??={};existing.pinInfoMap[number]=JSON.parse(JSON.stringify(pin));
		}
	}
}

/** Save/reopen and final joint readback. This module never creates, deletes, or replaces design primitives. */
export function createReplacementVerification(api: typeof eda = eda) {
	let accepted: DocumentSnapshot[] | undefined;
	let acceptedIdentity:string|undefined;
	const initial = (prepared: PreparedReplacement): DocumentSnapshot[] => documentList(prepared).map(doc => ({ ...doc, source: doc.type === 3 ? prepared.pcbSource : prepared.replacements.flatMap(r=>r.schematicParts).find(p=>p.pageUuid===doc.uuid)!.source }));
	const selectPrepared=(prepared:PreparedReplacement)=>{
		const snapshots=initial(prepared), identity=JSON.stringify({project:prepared.projectUuid,board:prepared.boardUuid,snapshots,inputs:prepared.replacements.map(r=>r.input)});
		if(identity!==acceptedIdentity){accepted=undefined;acceptedIdentity=identity;}
	};
	async function activate(prepared: PreparedReplacement, doc: { uuid: string; type: 1 | 3 }) {
		if ((await api.dmt_Project.getCurrentProjectInfo())?.uuid !== prepared.projectUuid) throw new Error('保存/最终验收工程身份不符');
		await activateOrOpenReplacementDocument(api, prepared.projectUuid, doc.uuid);
		const info = await api.dmt_SelectControl.getCurrentDocumentInfo();
		if (!info || info.uuid !== doc.uuid || info.documentType !== doc.type || info.parentProjectUuid !== prepared.projectUuid) throw new Error('保存/最终验收文档身份不符');
		return info;
	}
	async function read(prepared: PreparedReplacement, doc: { uuid: string; type: 1 | 3 }): Promise<DocumentSnapshot> {
		await activate(prepared, doc);
		const source = await api.sys_FileManager.getDocumentSource();
		if (typeof source !== 'string' || !source.trim()) throw new Error('保存/最终验收文档源码为空');
		records(source, doc.uuid, doc.type);
		return { ...doc, source };
	}
	return {
		reset(prepared: PreparedReplacement): void { selectPrepared(prepared); accepted=initial(prepared); },
		async assertPlanStillCurrent(prepared: PreparedReplacement): Promise<void> {
			selectPrepared(prepared);
			const expected=accepted ?? initial(prepared);
			for(const doc of expected) {
				const current=await read(prepared,doc);
				assertReplacementRecordsUnchanged(records(doc.source,doc.uuid,doc.type),records(current.source,doc.uuid,doc.type),new Set());
			}
			if(!accepted) accepted=expected;
		},
		async acceptStageDelta(prepared: PreparedReplacement, replacementIndex: number, stage: ReplacementStage, context: ReplacementStageContext, result: unknown): Promise<void> {
			selectPrepared(prepared);
			const before=accepted ?? initial(prepared), after:DocumentSnapshot[]=[], r=prepared.replacements[replacementIndex], output=result as ObjectValue;
			const ticketReindexProofs:ObjectValue[]=[];
			const sch=stage.startsWith('schematic_'), targetUuid=sch?r.schematicParts[context.partIndex!].pageUuid:prepared.pcbUuid;
			const oldId=sch?r.schematicParts[context.partIndex!].componentId:r.input.pcbComponentId;
			const createStage=sch?'schematic_create_part':'pcb_create_candidate';
			const created=stage===createStage?output:oneStage(context.previousResults,createStage,replacementIndex,sch?context.partIndex:undefined);
			const candidateId=String(created.candidateId);
			const isRead=stage==='pcb_verify_candidate'||stage==='pcb_verify_contact'||stage==='schematic_verify_part';
			for(const doc of before) {
				const next=await read(prepared,doc), oldRows=records(doc.source,doc.uuid,doc.type), nextRows=records(next.source,doc.uuid,doc.type), excluded=new Set<string>();
				if(doc.uuid===targetUuid&&!isRead) {
					const owns=(row:ReplacementNativeRecord,id:string)=>row.type==='COMPONENT'&&row.id===id||row.type==='ATTR'&&parent(row)===id||row.type==='PAD_NET'&&padOwner(row)===id;
					const priorKeys=new Set(oldRows.map(key)), creating=stage===createStage;
					if(creating&&oldRows.some(row=>row.type==='COMPONENT'&&row.id===candidateId))throw new Error('创建候选返回了已经存在的ID');
					const mayChangeCandidate=!stage.endsWith('delete_old')&&stage!=='schematic_delete_old_part'&&stage!=='pcb_local_routes';
					const mayDeleteOld=stage==='pcb_delete_old'||stage==='schematic_delete_old_part';
					if(creating&&oldRows.some(row=>owns(row,candidateId)))throw new Error('创建候选ID已有原生记录');
					for(const row of oldRows)if(!creating&&mayChangeCandidate&&owns(row,candidateId)||mayDeleteOld&&owns(row,oldId))excluded.add(key(row));
					for(const row of nextRows)if(mayChangeCandidate&&!priorKeys.has(key(row))&&owns(row,candidateId))excluded.add(key(row));
					if(mayDeleteOld&&nextRows.some(row=>owns(row,oldId)))throw new Error('删除旧件后仍残留旧件所属记录');
					if(stage==='pcb_local_routes') {
						const ids=output.segmentIds??[], expected=r.localRoutes.flatMap(route=>route.points.slice(1).map((p,i)=>({netName:route.net,layerId:typeof route.layer==='number'?route.layer:route.layer==='top'?1:2,width:route.width,startX:route.points[i][0],startY:route.points[i][1],endX:p[0],endY:p[1]})));
						if(ids.length!==expected.length||new Set(ids).size!==ids.length)throw new Error('新建线路ID集合与计划数量不符');
						for(let i=0;i<ids.length;i++) {
							if(priorKeys.has(`LINE\0${ids[i]}`))throw new Error('新建线路返回了已有线路ID');
							const row=nextRows.find(row=>row.type==='LINE'&&row.id===ids[i]);
							if(!row||Object.entries(expected[i]).some(([k,v])=>stable((row.data as ObjectValue)[k])!==stable(v)))throw new Error('新建线路几何/网络/层/宽度与计划不符');
							excluded.add(key(row));
						}
					}
					if(creating||mayDeleteOld||stage==='pcb_local_routes') {
						const beforeKeys=new Set(oldRows.map(key)), afterKeys=new Set(nextRows.map(key));
						const added=new Set(nextRows.filter(row=>!beforeKeys.has(key(row))).map(key)), removed=new Set(oldRows.filter(row=>!afterKeys.has(key(row))).map(key));
						let expectedAdded=new Set<string>(), expectedRemoved=new Set<string>();
						if(creating) {
							expectedAdded=new Set(nextRows.filter(row=>owns(row,candidateId)).map(key));
							if(!nextRows.some(row=>row.type==='COMPONENT'&&row.id===candidateId)||stable([...added].sort())!==stable([...expectedAdded].sort()))throw new Error('创建阶段新增原生记录不属于唯一候选');
						} else if(stage==='pcb_local_routes') {
							expectedAdded=new Set((output.segmentIds??[]).map((id:string)=>`LINE\0${id}`));
							if(stable([...added].sort())!==stable([...expectedAdded].sort())||removed.size)throw new Error('线路阶段增删集合超出返回的线路ID');
						} else {
							expectedRemoved=new Set(oldRows.filter(row=>owns(row,oldId)).map(key));
							if(!oldRows.some(row=>row.type==='COMPONENT'&&row.id===oldId)||!oldRows.some(row=>row.type==='COMPONENT'&&row.id===candidateId)
								||!nextRows.some(row=>row.type==='COMPONENT'&&row.id===candidateId)
								||stable([...removed].sort())!==stable([...expectedRemoved].sort())||added.size)throw new Error('删除阶段只允许删除冻结旧件所属记录并保留候选');
						}
						const proof=assertReplacementRecordsWithTicketReindex(oldRows,nextRows,excluded,expectedRemoved,expectedAdded,doc.uuid,stage);
						if(proof)ticketReindexProofs.push(proof);
					} else assertReplacementRecordsUnchanged(oldRows,nextRows,excluded);
				} else assertReplacementRecordsUnchanged(oldRows,nextRows,excluded);
				after.push(next);
			}
			if(ticketReindexProofs.length&&output&&typeof output==='object')output.ticketReindexProofs=ticketReindexProofs;
			accepted=after;
		},
		async saveCloseReopen(prepared: PreparedReplacement, prior: unknown[], context?: { assertActive?: () => void }): Promise<CloseReadback> {
			selectPrepared(prepared);
			const before: DocumentSnapshot[] = [], after: DocumentSnapshot[] = [], closedTabIds: string[] = [], closeAcknowledgements:CloseAcknowledgement[]=[];
			const closeTreePolls:CloseTreePoll[]=[], targetTabIds:string[]=[],candidateDefaultPersistenceProofs:ObjectValue[]=[],expectedRowsByPage=new Map<string,ReplacementNativeRecord[]>(),persistenceChoicesByPage=new Map<string,Array<{candidateId:string;models:SchPersistenceModel[];beforeRows:ReplacementNativeRecord[];beforeMode:'immediate-wire'|'already-persisted';lockedModel?:SchPersistenceModel;proof:ObjectValue;output:ObjectValue;resourceDocuments:any[]}>>();
			let failedDocument:ObjectValue|undefined;
			const closeEvidence=()=>({targetTabIds:[...targetTabIds],before:[...before],after:[...after],closeAcknowledgements:[...closeAcknowledgements],closeTreePolls:[...closeTreePolls],candidateDefaultPersistenceProofs:[...candidateDefaultPersistenceProofs],failedDocument:failedDocument?{...failedDocument}:null});
			for (const doc of documentList(prepared)) {
				context?.assertActive?.();
				let info:Awaited<ReturnType<typeof activate>>;
				try{info=await activate(prepared,doc);}catch(error){failedDocument={uuid:doc.uuid,type:doc.type,stage:'activate-before-save',error:error instanceof Error?error.message:String(error)};throw new CloseVerificationError(`保存前激活文档失败：${doc.uuid}`,closeEvidence());}
				let snapshot:DocumentSnapshot;
				try{snapshot=await read(prepared,doc);}catch(error){failedDocument={uuid:doc.uuid,type:doc.type,stage:'capture-before-save',error:error instanceof Error?error.message:String(error)};throw new CloseVerificationError(`保存前源码读取失败：${doc.uuid}`,closeEvidence());}
				before.push(snapshot);
				const expected=accepted?.find(d=>d.uuid===doc.uuid);
				if(expected){
					const differences=replacementRecordDifferenceKeys(records(expected.source,doc.uuid,doc.type),records(snapshot.source,doc.uuid,doc.type),new Set());
					if(differences.length){failedDocument={uuid:doc.uuid,type:doc.type,stage:'pre-save-strict-compare',error:'当前源码与已接受阶段快照不同',differenceSummary:{count:differences.length,identities:differences.slice(0,20)}};throw new CloseVerificationError(`保存前源码严格读回失败：${doc.uuid}`,closeEvidence());}
				}
				const pageProofs=prepared.replacements.flatMap((replacement,replacementIndex)=>replacement.schematicParts.map((part,partIndex)=>({replacement,replacementIndex,part,partIndex})))
					.filter(item=>item.part.pageUuid===doc.uuid);
				if(pageProofs.length){
					const actualRows=records(snapshot.source,doc.uuid,doc.type),persistedRows=actualRows.map(row=>row);
					for(const item of pageProofs){
						let association:ObjectValue,create:ObjectValue,verify:ObjectValue,candidate:ObjectValue,meta:ObjectValue|undefined,symbol:ObjectValue|undefined,computedModels:SchPersistenceModel[]|undefined;
						try{
							association=oneStage(prior,'schematic_restore_association',item.replacementIndex,item.partIndex);
							create=oneStage(prior,'schematic_create_part',item.replacementIndex,item.partIndex);
							verify=oneStage(prior,'schematic_verify_part',item.replacementIndex,item.partIndex);
							candidate=oneStage(prior,'pcb_verify_candidate',item.replacementIndex);
							const proof=association.normalizationProof as ObjectValue;
							if(!proof||proof.pageUuid!==doc.uuid||proof.partId!==item.part.newSubPartName||proof.candidateId!==String(create.candidateId)
								||proof.candidateId!==String(verify.candidateId)||verify.subPartName!==proof.partId)throw new Error('SCH默认持久化证明与当前 part/candidate 计划不符');
							if(!candidate.candidateDevice||referenceUuid(candidate.candidateDevice)!==proof.deviceUuid||verify.candidateDeviceUuid!==proof.deviceUuid)throw new Error('SCH默认持久化证明 DEVICE 与已验证候选不符');
							const deviceUuid=referenceUuid(candidate.candidateDevice),docs=candidate.resourceDocuments;
							if(!Array.isArray(docs))throw new Error('SCH默认持久化证明缺少候选资源闭包');
							const deviceDocs=docs.filter((resource:any)=>resource.docType==='DEVICE'&&resource.uuid===deviceUuid);
							if(deviceDocs.length!==1)throw new Error('SCH默认持久化证明 DEVICE 资源不唯一');
							const metas=deviceDocs[0].effectiveRecords?.filter((row:any)=>row.header?.type==='META')??[];
							if(metas.length!==1)throw new Error('SCH默认持久化证明 DEVICE META 不唯一');
							const metaAttrs=metas[0].data?.attributes??metas[0].data?.attrs??{};
							const sourceParts=(typeof metas[0].data?.source==='string'?metas[0].data.source:'').split('|');
							const sourceOwner=sourceParts.length>1&&sourceParts.at(-1)?sourceParts.at(-1):undefined;
							if(typeof metaAttrs.Symbol!=='string'||metaAttrs.Symbol!==proof.symbolUuid)throw new Error('SCH默认持久化证明 SYMBOL 与 DEVICE META 不符');
							const symbolDocs=docs.filter((resource:any)=>resource.docType==='SYMBOL'&&resource.uuid===proof.symbolUuid);
							if(symbolDocs.length!==1||!symbolDocs[0].effectiveRecords?.some((row:any)=>row.header?.type==='PART'&&row.header.id===proof.partId))throw new Error('SCH默认持久化证明未绑定实际 SYMBOL/PART');
							if(proof.effectiveDeviceAssociation){
								const association=proof.effectiveDeviceAssociation;
								if(association.pageUuid!==doc.uuid||association.projectUuid!==prepared.projectUuid||association.candidateId!==proof.candidateId
									||association.deviceUuid!==deviceUuid||association.symbolUuid!==proof.symbolUuid||association.rawUuid!==deviceUuid||association.actualRawUuid!==''
									||association.sourceLibraryUuid!==sourceOwner)throw new Error('有效Device关联证明未绑定当前页面/工程/候选/资源或来源库');
								const footprintDocs=docs.filter((resource:any)=>resource.docType==='FOOTPRINT'&&resource.uuid===association.footprintUuid);
								const footprintRef=metaAttrs.Footprint;
								let parsedFootprint:any=footprintRef;if(typeof parsedFootprint==='string'){try{parsedFootprint=JSON.parse(parsedFootprint)}catch{parsedFootprint={uuid:parsedFootprint}}}
								if(typeof association.attrId!=='string'||typeof association.footprintUuid!=='string'||footprintDocs.length!==1
									||(typeof parsedFootprint?.uuid==='string'?parsedFootprint.uuid:parsedFootprint)!==association.footprintUuid)throw new Error('有效Device关联证明缺少DEVICE META指定的唯一FOOTPRINT资源');
							}
							if(typeof proof.deviceUuid!=='string'||typeof proof.symbolUuid!=='string')throw new Error('SCH默认持久化证明资源 UUID 无效');
							const hasSubmittedWireProof=['submittedTarget','inputWireTransitions','deviceNameProof'].some(key=>Object.hasOwn(proof,key));
							if(hasSubmittedWireProof)assertSubmittedWireProof(proof.submittedTarget,proof.effectiveWireExpected??proof.immediateWireExpected,proof.inputWireTransitions,proof.defaultTransitions,proof.deviceNameProof,String(proof.candidateId),metas[0].data?.title,deviceUuid,proof.effectiveDeviceAssociation);
							if(Object.hasOwn(proof,'persistenceModels')){
								assertNativeTargetExpected(proof.immediateWireExpected as NativeTargetExpected,proof.immediateWireExpected,String(proof.candidateId),'两模型wire输入');
								computedModels=predictCandidateSchPersistenceModels({wireCandidate:(proof.effectiveWireExpected??proof.immediateWireExpected) as NativeTargetExpected,resources:{symbolEffectiveRecords:symbolDocs[0].effectiveRecords,selectedPartId:String(proof.partId),deviceMetaAttributes:metaAttrs,deviceDisplay:{uuid:deviceUuid,title:String(metas[0].data?.title)}}}) as SchPersistenceModel[];
								if(computedModels.length!==2||computedModels[0].model!=='associated-template'||computedModels[1].model!=='plain-template'||stable(proof.persistenceModels)!==stable(computedModels))throw new Error('SCH完整持久化模型与实际候选资源独立重算结果不符');
							}
						}catch(error){failedDocument={uuid:doc.uuid,type:doc.type,stage:'default-proof-binding',error:error instanceof Error?error.message:String(error),differenceSummary:{count:1,identities:[]}};throw new CloseVerificationError(`SCH默认持久化证明无效：${doc.uuid}`,closeEvidence());}
						const proof=association.normalizationProof as ObjectValue,candidateId=String(proof.candidateId);
						let actualTarget:NativeTargetExpected,sourceMode:'immediate-wire'|'already-persisted';
						const expectedWire=proof.effectiveWireExpected??proof.immediateWireExpected;
						try{actualTarget=targetNativeExpected(actualRows,candidateId);assertNativeTargetExpected(actualTarget,expectedWire,candidateId,'立即wire');sourceMode='immediate-wire';}
						catch(wireError){actualTarget=targetNativeExpected(actualRows,candidateId);sourceMode='already-persisted';}
						if(computedModels){
							const priorCloseStages=prior.filter((row:any)=>row?.stage==='save_close_reopen');
							if(priorCloseStages.length>1)throw new CloseVerificationError(`SCH持久化锁定快照阶段不唯一：${candidateId}`,closeEvidence());
							let lockedModel:SchPersistenceModel|undefined;
							if(priorCloseStages.length===1){
								const priorProofs=(priorCloseStages[0] as any).candidateDefaultPersistenceProofs;
								const priorMatches=Array.isArray(priorProofs)?priorProofs.filter((row:any)=>row?.pageUuid===doc.uuid&&row?.replacementIndex===item.replacementIndex&&row?.partIndex===item.partIndex&&row?.candidateId===candidateId):[];
								if(priorMatches.length>1)throw new CloseVerificationError(`SCH持久化锁定快照不唯一：${candidateId}`,closeEvidence());
								if(priorMatches.length===1&&priorMatches[0].selectedModel!==undefined){
									lockedModel=computedModels.find(model=>model.model===priorMatches[0].selectedModel);
									if(!lockedModel||stable(lockedModel.persistedExpected)!==stable(priorMatches[0].persistedTargetExpected))throw new CloseVerificationError(`SCH持久化锁定模型与当前冻结预期不同：${candidateId}`,closeEvidence());
									assertNativeTargetExpected(actualTarget,lockedModel.persistedExpected,candidateId,'已锁定持久化');sourceMode='already-persisted';
								}
							}
							let beforeMatches=computedModels.filter(model=>stable(model.persistedExpected)===stable(actualTarget));
							if(sourceMode==='already-persisted'&&!beforeMatches.length)throw new CloseVerificationError(`保存前 SCH候选目标不匹配任一完整持久化模型：${candidateId}`,closeEvidence());
							if(lockedModel)beforeMatches=[lockedModel];
							const chosenBefore=sourceMode==='already-persisted'?beforeMatches[0]:undefined;
							const output:ObjectValue={pageUuid:doc.uuid,replacementIndex:item.replacementIndex,partIndex:item.partIndex,candidateId,partId:proof.partId,deviceUuid:proof.deviceUuid,symbolUuid:proof.symbolUuid,beforeRepresentation:sourceMode,modelCandidates:computedModels.map(model=>model.model),defaultTransitions:proof.defaultTransitions??[],wireTargetMatched:sourceMode==='immediate-wire'};
							if(chosenBefore){output.selectedModel=chosenBefore.model;output.matchingModels=beforeMatches.map(model=>model.model);output.persistedTargetExpected=chosenBefore.persistedExpected;}
							candidateDefaultPersistenceProofs.push(output);
						const choices=persistenceChoicesByPage.get(doc.uuid)??[];choices.push({candidateId,models:computedModels,beforeRows:actualRows,beforeMode:sourceMode,...(chosenBefore?{lockedModel:chosenBefore}:{}),proof,output,resourceDocuments:candidate.resourceDocuments as any[]});persistenceChoicesByPage.set(doc.uuid,choices);
						}else{
							let wireTarget:NativeTargetExpected,persistedTarget:NativeTargetExpected,derivedPersisted:NativeTargetExpected;
							try{assertNativeTargetExpected(actualTarget,proof.immediateWireExpected,candidateId,'立即wire');wireTarget=proof.immediateWireExpected as NativeTargetExpected;derivedPersisted=applyDefaultTransitions(wireTarget,proof.defaultTransitions,candidateId);assertNativeTargetExpected(derivedPersisted,proof.persistedExpected,candidateId,'持久化');sourceMode='immediate-wire';}
							catch(wireError){try{assertNativeTargetExpected(actualTarget,proof.persistedExpected,candidateId,'已持久化');wireTarget=proof.immediateWireExpected as NativeTargetExpected;derivedPersisted=applyDefaultTransitions(wireTarget,proof.defaultTransitions,candidateId);assertNativeTargetExpected(derivedPersisted,proof.persistedExpected,candidateId,'持久化');persistedTarget=proof.persistedExpected as NativeTargetExpected;sourceMode='already-persisted';}catch(persistedError){failedDocument={uuid:doc.uuid,type:doc.type,stage:'default-before-proof',error:persistedError instanceof Error?persistedError.message:String(persistedError),differenceSummary:{count:1,identities:[`COMPONENT/${candidateId}`]}};throw new CloseVerificationError(`保存前 SCH候选原生默认值与冻结wire/persisted证明均不符：${candidateId}`,closeEvidence());}}
							persistedTarget=sourceMode==='immediate-wire'?derivedPersisted:persistedTarget!;
							if(sourceMode==='immediate-wire')persistedRows.splice(0,persistedRows.length,...applyDefaultExpectedToRows(persistedRows,candidateId,persistedTarget));
							candidateDefaultPersistenceProofs.push({pageUuid:doc.uuid,replacementIndex:item.replacementIndex,partIndex:item.partIndex,candidateId,partId:proof.partId,deviceUuid:proof.deviceUuid,symbolUuid:proof.symbolUuid,beforeRepresentation:sourceMode,transitionCount:proof.defaultTransitions.length,defaultTransitions:proof.defaultTransitions,wireTargetMatched:sourceMode==='immediate-wire',persistedTargetExpected:persistedTarget});
						}
					}
					if(!persistenceChoicesByPage.has(doc.uuid))expectedRowsByPage.set(doc.uuid,persistedRows);
				}
				let saveAck:boolean;
				try{context?.assertActive?.(); saveAck=(doc.type===3?await api.pcb_Document.save():await api.sch_Document.save())===true; context?.assertActive?.();}
				catch(error){failedDocument={uuid:doc.uuid,type:doc.type,stage:'save',error:error instanceof Error?error.message:String(error)};throw new CloseVerificationError(`保存未确认：${doc.uuid}`,closeEvidence());}
				if(!saveAck){failedDocument={uuid:doc.uuid,type:doc.type,stage:'save',error:'保存未确认'};throw new CloseVerificationError(`保存未确认：${doc.uuid}`,closeEvidence());}
				targetTabIds.push(info.tabId);
				let closeAck:unknown;
			try { context?.assertActive?.(); closeAck=await api.dmt_EditorControl.closeDocument(info.tabId); context?.assertActive?.(); }
				catch(error) {
					closeAcknowledgements.push({docUuid:doc.uuid,tabId:info.tabId,closeAck:null,error:error instanceof Error?error.message:String(error)});
					failedDocument={uuid:doc.uuid,type:doc.type,stage:'close',error:error instanceof Error?error.message:String(error)};
					throw new CloseVerificationError(`关闭文档未获确认：${doc.uuid}`,closeEvidence());
				}
				closeAcknowledgements.push({docUuid:doc.uuid,tabId:info.tabId,closeAck:typeof closeAck==='boolean'?closeAck:null});
				if(closeAck!==true){failedDocument={uuid:doc.uuid,type:doc.type,stage:'close',error:'关闭文档未获确认'};throw new CloseVerificationError(`关闭文档未获确认：${doc.uuid}`,closeEvidence());}
				closedTabIds.push(info.tabId);
			}
			const pollStarted=Date.now(),deadline=pollStarted+3000;
			let targetsAbsent=false;
			do {
				const remainingMs=Math.max(1,deadline-Date.now());
				let tree:unknown=null,valid=false,remainingTargetIds=[...targetTabIds],errorText:string|undefined;
				try {
					tree=await new Promise((resolve,reject)=>{
						const timer=setTimeout(()=>reject(new Error('标签树读取超时')),remainingMs);
						Promise.resolve(api.dmt_EditorControl.getSplitScreenTree()).then(resolve,reject).finally(()=>clearTimeout(timer));
					});
					const inspected=inspectSplitScreenTree(tree);valid=inspected.valid;
					if(valid)remainingTargetIds=targetTabIds.filter(id=>inspected.tabIds.includes(id));
					else errorText='标签树结构无效';
				} catch(error) { errorText=error instanceof Error?error.message:String(error);tree=null;valid=false; }
				let treeSnapshot:unknown=null;
				if(tree!==null)try{treeSnapshot=JSON.parse(JSON.stringify(tree));}catch{valid=false;remainingTargetIds=[...targetTabIds];errorText='标签树无法安全序列化';}
				const elapsedMs=Date.now()-pollStarted;
				closeTreePolls.push({elapsedMs,tree:treeSnapshot,valid,remainingTargetIds,...(errorText?{error:errorText}:{})});
				if(valid&&remainingTargetIds.length===0){targetsAbsent=true;break;}
				const waitMs=Math.min(250,Math.max(0,deadline-Date.now()));
				if(waitMs===0)break;
				await pause(waitMs);
			} while(Date.now()<=deadline);
			if(!targetsAbsent){failedDocument={uuid:null,type:null,stage:'close-tree-poll',error:'关闭目标文档后的独立标签检查未通过'};throw new CloseVerificationError('关闭目标文档后的独立标签检查未通过',closeEvidence());}
			for (const doc of documentList(prepared)) {
				let snapshot:DocumentSnapshot;
				try{snapshot=await read(prepared,doc);}catch(error){failedDocument={uuid:doc.uuid,type:doc.type,stage:'reopen-read',error:error instanceof Error?error.message:String(error)};throw new CloseVerificationError(`关闭后重开源码读取失败：${doc.uuid}`,closeEvidence());}
				after.push(snapshot);
				const prior=before.find(d=>d.uuid===doc.uuid)!;
				try{
					const afterRows=records(snapshot.source,doc.uuid,doc.type),choices=persistenceChoicesByPage.get(doc.uuid)??[];
					let expectedRows=expectedRowsByPage.get(doc.uuid)??records(prior.source,doc.uuid,doc.type);
					for(const choice of choices){
						if(choice.proof.effectiveDeviceAssociation){
							const association=choice.proof.effectiveDeviceAssociation;
						const rawTarget=targetNativeExpected(afterRows,choice.candidateId),rawDevice=rawTarget.attributes.filter(row=>row.id===association.attrId);
						if(rawDevice.length!==1||rawDevice[0].data.parentId!==choice.candidateId||rawDevice[0].data.key!=='Device'||rawDevice[0].data.value!=='')throw new Error(`重开 SCH raw Device ATTR 不再是唯一空值投影：${choice.candidateId}`);
						const freshTyped=await assertFreshEffectiveDeviceAssociation(api,association,choice.resourceDocuments);
						Object.assign(choice.output,{reopenTypedAttr:freshTyped.typedAttr,reopenTypedReference:freshTyped.typedReference});
						}
						const actualTarget=targetNativeExpected(afterRows,choice.candidateId),matches=choice.models.filter(model=>stable(model.persistedExpected)===stable(actualTarget));
						if(!matches.length)throw new Error(`重开 SCH候选目标未命中任一完整持久化模型：${choice.candidateId}`);
						const selected=choice.lockedModel??matches[0];
						if(choice.lockedModel&&!matches.some(model=>model.model===choice.lockedModel!.model))throw new Error(`重开 SCH候选目标偏离已锁定模型：${choice.candidateId}`);
						if(matches.some(model=>stable(model.persistedExpected)!==stable(selected.persistedExpected)))throw new Error(`重开 SCH候选目标同时命中不同持久化快照：${choice.candidateId}`);
						expectedRows=replaceNativeTargetRows(expectedRows,choice.candidateId,selected.persistedExpected);
						Object.assign(choice.output,{selectedModel:selected.model,matchingModels:matches.map(model=>model.model),persistedTargetExpected:selected.persistedExpected,transitionCount:selected.defaultTransitions.length,defaultTransitions:selected.defaultTransitions,orderedChildrenProof:selected.orderedChildrenProof});
					}
					const summary=replacementRecordDifferenceSummary(expectedRows,afterRows),differences=summary.identities as string[];
					if(differences.length||(expectedRowsByPage.has(doc.uuid)||choices.length>0)&&summary.sequenceChanged){failedDocument={uuid:doc.uuid,type:doc.type,stage:expectedRowsByPage.has(doc.uuid)||choices.length>0?'reopen-default-persistence-compare':'reopen-strict-compare',error:'关闭后重开源码与冻结预期不同',differenceSummary:summary};throw new Error(`非目标原生记录发生变化：${differences.slice(0,12).map(k=>k.replace('\0','/')).join(',')}${summary.sequenceChanged?'; record sequence changed':''}`);}
				}catch(error){
					if(!failedDocument||failedDocument.uuid!==doc.uuid)failedDocument={uuid:doc.uuid,type:doc.type,stage:'reopen-parse-or-compare',error:error instanceof Error?error.message:String(error)};
					throw new CloseVerificationError(`关闭后重开源码严格读回失败：${error instanceof Error?error.message:String(error)}`,closeEvidence());
				}
			}
			accepted=after;
			return { stage: 'save_close_reopen', before, after, closedTabIds, closeAcknowledgements, closeTreePolls, candidateDefaultPersistenceProofs };
		},
		async verifyFinal(prepared: PreparedReplacement, prior: unknown[]) {
			selectPrepared(prepared);
			const reopened = oneStage(prior, 'save_close_reopen') as CloseReadback;
			const snapshots: DocumentSnapshot[] = [];
			for (const doc of documentList(prepared)) {
				const snapshot = await read(prepared, doc), captured = reopened.after.find(d => d.uuid === doc.uuid);
				if (!captured) throw new Error(`缺少重开快照：${doc.uuid}`);
				assertReplacementRecordsUnchanged(records(captured.source, doc.uuid, doc.type), records(snapshot.source, doc.uuid, doc.type), new Set());
				snapshots.push(snapshot);
			}
			const finalPcb = snapshots.find(d => d.uuid === prepared.pcbUuid)!, pcbRows = records(finalPcb.source, finalPcb.uuid, 3), finalTicketReindexProofs:ObjectValue[]=[], liveDocumentDeltaProofs:ObjectValue[]=[];
			await activate(prepared,{uuid:prepared.pcbUuid,type:3});
			const pcbExcluded = new Set<string>(), pcbExpectedRemoved=new Set<string>(), pcbExpectedAdded=new Set<string>(), targetProofs: ObjectValue[] = [], verifiedResources:ObjectValue[]=[];
			for (let i = 0; i < prepared.replacements.length; i++) {
				const r = prepared.replacements[i], created = oneStage(prior, 'pcb_create_candidate', i), candidateId = String(created.candidateId);
				const deleted = oneStage(prior, 'pcb_delete_old', i), local = prior.find((p: any) => p?.stage === 'pcb_local_routes' && p.replacementIndex === i) as ObjectValue | undefined;
				const removedExpected=prepared.pcbNative.records.filter(row=>row.type==='COMPONENT'&&row.id===r.input.pcbComponentId||row.type==='ATTR'&&parent(row)===r.input.pcbComponentId||row.type==='PAD_NET'&&padOwner(row)===r.input.pcbComponentId);
				const expectedRemovedKeys=removedExpected.map(key).sort(), reportedRemovedKeys=(deleted.removed??[]).map((row:any)=>`${row.type}\0${row.id}`).sort();
				if(stable(expectedRemovedKeys)!==stable(reportedRemovedKeys))throw new Error('旧件删除报告与冻结所有权不符');
				for(const row of removedExpected){pcbExcluded.add(key(row));pcbExpectedRemoved.add(key(row));if(pcbRows.some(r=>key(r)===key(row)))throw new Error('最终PCB仍残留旧件所属记录');}
				pcbExcluded.add(`COMPONENT\0${candidateId}`);
				for (const row of pcbRows) if (row.type === 'ATTR' && parent(row) === candidateId) pcbExcluded.add(key(row));
				for (const row of pcbRows) if (row.type === 'COMPONENT' && row.id === candidateId || row.type === 'ATTR' && parent(row) === candidateId || row.type === 'PAD_NET' && padOwner(row) === candidateId) pcbExpectedAdded.add(key(row));
				for (const id of local?.segmentIds ?? []) pcbExcluded.add(`LINE\0${id}`);
				for (const id of local?.segmentIds ?? []) pcbExpectedAdded.add(`LINE\0${id}`);
				// PAD_NET ownership is taken from the recorded setter readback, not an ID substring.
				oneStage(prior, 'pcb_set_pad_nets', i);
				for (const row of pcbRows) if (row.type === 'PAD_NET' && padOwner(row)===candidateId) pcbExcluded.add(key(row));
				if (pcbRows.some(row => row.type === 'COMPONENT' && row.id === r.input.pcbComponentId)) throw new Error('最终 PCB 仍有被替换旧器件');
				const current = await api.pcb_PrimitiveComponent.get(candidateId), native = nativeComponent(pcbRows, candidateId), expectedRef = (r.oldPcb.typed as ObjectValue).getState_Designator;
				if (typeof expectedRef!=='string' || !current || value(current, 'UniqueId') !== r.input.oldUid || value(current, 'Designator') !== expectedRef) throw new Error('最终 PCB 身份不符');
				assertReplacementComponentIdentity(pcbRows,candidateId,r.input.oldUid,expectedRef,'PCB');
				const candidateVerified=oneStage(prior,'pcb_verify_candidate',i);
				if(stable(candidateVerified.requestedDevice)!==stable(r.newDevice.reference))throw new Error('候选资源映射没有绑定本计划所选器件');
				if(!Array.isArray(candidateVerified.resourceDocuments)||!['DEVICE','SYMBOL','FOOTPRINT'].every(type=>candidateVerified.resourceDocuments.some((d:any)=>d.docType===type)))throw new Error('最终验收缺少候选完整资源闭包');
				verifiedResources.push(...candidateVerified.resourceDocuments);
				if(referenceUuid(value(current,'Component'))!==referenceUuid(candidateVerified.candidateDevice)||referenceUuid(value(current,'Footprint'))!==referenceUuid(candidateVerified.candidateFootprint))throw new Error('最终候选资源与已验证的导入映射不符');
				if(value(current,'Layer')!==(r.oldPcb.typed as ObjectValue).getState_Layer||value(current,'PrimitiveLock')!==(r.oldPcb.typed as ObjectValue).getState_PrimitiveLock)throw new Error('最终 PCB 层或锁定状态不符');
				const pose = r.input.pcbPose ?? { x: (r.oldPcb.typed as ObjectValue).getState_X, y: (r.oldPcb.typed as ObjectValue).getState_Y, rotation: (r.oldPcb.typed as ObjectValue).getState_Rotation };
				for (const [field, getter] of [['x','X'],['y','Y'],['rotation','Rotation']] as const) if (!closeGeometryNumber(pose[field], value(current, getter))) throw new Error(`最终 PCB ${field} 与计划不符`);
				if (native.groupId !== (r.oldPcb.native as ObjectValue).groupId) throw new Error('最终 PCB 原生分组丢失');
				for (const field of ['Reuse Block','Group ID','Channel ID']) if (Object.hasOwn((r.oldPcb.native as ObjectValue).attrs, field) && native.attrs?.[field] !== (r.oldPcb.native as ObjectValue).attrs[field]) throw new Error(`最终 PCB ${field} 丢失`);
				const pads = await api.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(candidateId), actualNets: ObjectValue = {};
				if (!Array.isArray(pads)) throw new Error('最终 PCB 焊盘列表读取失败');
				const expectedPadGeometry=candidateVerified.typedPads;
				if(!Array.isArray(expectedPadGeometry))throw new Error('最终验收缺少候选几何验证快照');
				const actualPadGeometry=pads.map(p=>{
					if(value(p,'ParentComponentPrimitiveId')!==candidateId)throw new Error('最终PAD父组件不符');
					return {...Object.fromEntries([['id','PrimitiveId'],['number','PadNumber'],['layer','Layer'],['x','X'],['y','Y'],['rotation','Rotation'],['shape','Pad'],['hole','Hole'],['holeOffsetX','HoleOffsetX'],['holeOffsetY','HoleOffsetY'],['holeRotation','HoleRotation']].map(([field,getter])=>[field,value(p,getter)])),specialPad:value(p,'SpecialPad')};
				});
				const padGeometry=(rows:ObjectValue[])=>rows.map((row):ObjectValue=>({...Object.fromEntries(['id','number','layer','x','y','rotation','shape','hole','holeOffsetX','holeOffsetY','holeRotation'].map(k=>[k,row[k]])),specialPad:row.specialPad}));
				if(!samePadGeometry(padGeometry(expectedPadGeometry),padGeometry(actualPadGeometry)))throw new Error('重开后候选物理PAD几何/孔/层/数量与已验证快照不符');
				for (const p of pads) {
					const number = String(value(p, 'PadNumber')), pair = r.input.pinMap.find(pair => pair.newNumber === number), old = (r.oldPcb.pads as ObjectValue[]).filter(p => p.number === pair?.oldNumber);
					if (!pair || !old.length || old.some(p => p.net !== old[0].net) || value(p,'Net') !== old[0].net) throw new Error(`最终 PAD ${number} 网络与 pinMap 不符`);
					actualNets[number] = value(p,'Net');
				}
				for (const pair of r.input.pinMap) if (!Object.hasOwn(actualNets, pair.newNumber)) throw new Error(`最终 PAD 编号丢失：${pair.newNumber}`);
				targetProofs.push({ candidateId, uniqueId: r.input.oldUid, designator: expectedRef, deviceUuid: referenceUuid(value(current,'Component')), footprintUuid: referenceUuid(value(current,'Footprint')), padNets: actualNets });
			}
			const pcbTicketProof=assertReplacementRecordsWithTicketReindex(prepared.pcbNative.records, pcbRows, pcbExcluded, pcbExpectedRemoved, pcbExpectedAdded, prepared.pcbUuid, 'verifyFinal');
			if(pcbTicketProof)finalTicketReindexProofs.push(pcbTicketProof);
			liveDocumentDeltaProofs.push({documentUuid:prepared.pcbUuid,stage:'verifyFinal',method:pcbTicketProof?'canonical-ticket-reindex':'strict-native-preservation',recordCountBefore:prepared.pcbNative.records.length,recordCountAfter:pcbRows.length,ticketProof:pcbTicketProof??null});
			for (const doc of snapshots.filter(d => d.type === 1)) {
				await activate(prepared,doc);
				const involved = prepared.replacements.flatMap((r,i) => r.schematicParts.map((part,j) => ({ r, i, part, j }))).filter(p => p.part.pageUuid === doc.uuid), rows = records(doc.source,doc.uuid,1), excluded = new Set<string>();
				for (const { r,i,part,j } of involved) {
					const candidateId = String(oneStage(prior,'schematic_create_part',i,j).candidateId);
					for (const list of [part.native.records,rows]) for (const row of list) if (row.type === 'COMPONENT' && (row.id === part.componentId || row.id === candidateId) || row.type === 'ATTR' && (parent(row) === part.componentId || parent(row) === candidateId)) excluded.add(key(row));
					if (rows.some(row => row.type === 'COMPONENT' && row.id === part.componentId)) throw new Error('最终 SCH 仍有被替换旧器件');
					const c = await api.sch_PrimitiveComponent.get(candidateId), attrs = attrsFor(rows,candidateId), oldAttrs = attrsFor(part.native.records,part.componentId), native = nativeComponent(rows,candidateId), oldNative = nativeComponent(part.native.records,part.componentId);
					if (typeof part.oldTyped.getState_Designator!=='string' || !c || value(c,'UniqueId') !== r.input.oldUid || value(c,'Designator') !== part.oldTyped.getState_Designator || value(c,'SubPartName') !== part.newSubPartName) throw new Error('最终 SCH 身份或 PART 不符');
					assertReplacementComponentIdentity(rows,candidateId,r.input.oldUid,part.oldTyped.getState_Designator, 'SCH_PAGE');
					const mapping=oneStage(prior,'pcb_verify_candidate',i), deviceDoc=mapping.resourceDocuments.find((d:any)=>d.docType==='DEVICE'&&d.uuid===referenceUuid(mapping.candidateDevice));
					const deviceMeta=deviceDoc?.effectiveRecords?.find((r:any)=>r.header.type==='META')?.data;
					const symbolUuid=referenceUuid(deviceMeta?.attributes?.Symbol??deviceMeta?.attrs?.Symbol);
					if(referenceUuid(value(c,'Component'))!==referenceUuid(mapping.candidateDevice)||referenceUuid(value(c,'Symbol'))!==symbolUuid)throw new Error('最终SCH DEVICE/SYMBOL与候选资源闭包不符');
					if (native.groupId !== oldNative.groupId) throw new Error('最终 SCH 原生分组丢失');
					for (const field of ['Reuse Block','Group ID','Channel ID','Multi-Part Group']) if (Object.hasOwn(oldAttrs,field) && stable(attrs[field]) !== stable(oldAttrs[field])) throw new Error(`最终 SCH ${field} 丢失`);
					const pose = r.input.schematicPoses?.[j] ?? { x:part.oldTyped.getState_X,y:part.oldTyped.getState_Y,rotation:part.oldTyped.getState_Rotation,mirror:part.oldTyped.getState_Mirror };
					for (const [field,getter] of [['x','X'],['y','Y'],['rotation','Rotation']] as const) if (pose[field] !== undefined && !closeGeometryNumber(pose[field],value(c,getter))) throw new Error(`最终 SCH ${field} 不符`);
					if (pose.mirror !== undefined && value(c,'Mirror') !== pose.mirror) throw new Error('最终 SCH mirror 不符');
					for (const getter of ['AddIntoBom','AddIntoPcb','Name']) if (stable(value(c,getter)) !== stable(part.oldTyped[`getState_${getter}`])) throw new Error(`最终 SCH ${getter} 不符`);
					const properties=oneStage(prior,'schematic_restore_properties',i,j).expectedTyped;
					if(!properties)throw new Error('最终 SCH 缺少属性恢复证据');
					for(const [getter,expected] of Object.entries(properties))if(stable(value(c,getter.replace(/^getState_/,'')))!==stable(expected))throw new Error(`最终 SCH 属性与写后读回不符：${getter}`);
				}
				const expectedRemoved=new Set<string>(), expectedAdded=new Set<string>();
				const ownsComponent=(row:ReplacementNativeRecord,id:string)=>row.type==='COMPONENT'&&row.id===id||row.type==='ATTR'&&parent(row)===id;
				for(const {part} of involved)for(const row of involved[0].part.native.records)if(ownsComponent(row,part.componentId))expectedRemoved.add(key(row));
				for(const {i,j} of involved){const candidateId=String(oneStage(prior,'schematic_create_part',i,j).candidateId);for(const row of rows)if(ownsComponent(row,candidateId))expectedAdded.add(key(row));}
				const schTicketProof=assertReplacementRecordsWithTicketReindex(involved[0].part.native.records,rows,excluded,expectedRemoved,expectedAdded,doc.uuid,'verifyFinal');
				if(schTicketProof)finalTicketReindexProofs.push(schTicketProof);
				liveDocumentDeltaProofs.push({documentUuid:doc.uuid,stage:'verifyFinal',method:schTicketProof?'canonical-ticket-reindex':'strict-native-preservation',recordCountBefore:involved[0].part.native.records.length,recordCountAfter:rows.length,ticketProof:schTicketProof??null});
			}
			await activate(prepared,{uuid:prepared.pcbUuid,type:3});
			const pf = await api.pcb_ManufactureData.getNetlistFile('component-replacement-final','JLCEDA' as ESYS_NetlistType);
			if (!pf) throw new Error('最终 PCB 网表读取失败');
			const pcbNet = JSON.parse(await pf.text());
			const schematicNets: ObjectValue = {};
			for (const doc of snapshots.filter(d=>d.type===1)) {
				await activate(prepared,doc);
				const sf=await api.sch_ManufactureData.getNetlistFile('component-replacement-final','JLCEDA' as ESYS_NetlistType);
				if (!sf) throw new Error('最终 SCH 网表读取失败');
				const net=JSON.parse(await sf.text());
				mergeReplacementSchematicNetlists(schematicNets,net.components??{});
			}
			for (const proof of targetProofs) {
				const p=pcbNet.components?.[proof.uniqueId], s=schematicNets[proof.uniqueId];
				if (!p || !s) throw new Error('最终 SCH/PCB 网表缺少目标 UID');
				if(p.props?.['Unique ID']!==proof.uniqueId||s.props?.['Unique ID']!==proof.uniqueId)throw new Error('最终网表Unique ID与目标UID不符');
				for (const field of ['Device','Footprint','Designator','Unique ID']) if (p.props?.[field] !== s.props?.[field]) throw new Error(`最终 SCH/PCB ${field} 不一致`);
				if (p.props.Device !== proof.deviceUuid || p.props.Footprint !== proof.footprintUuid || p.props.Designator !== proof.designator) throw new Error('最终 typed 与网表器件引用不一致');
				for (const [number,net] of Object.entries(proof.padNets)) if (p.pinInfoMap?.[number]?.net !== net || s.pinInfoMap?.[number]?.net !== net) throw new Error(`最终 SCH/PCB ${number} 网络不一致`);
				const expectedPins=Object.keys(proof.padNets).sort();
				if(stable(Object.keys(p.pinInfoMap??{}).sort())!==stable(expectedPins)||stable(Object.keys(s.pinInfoMap??{}).sort())!==stable(expectedPins))throw new Error('最终SCH/PCB逻辑引脚集合与计划不符');
			}
			const file=await api.sys_FileManager.getProjectFile('component-replacement-final',undefined,'epro2');
			if (!file) throw new Error('最终工程归档读取失败');
			const zip=await JSZip.loadAsync(await file.arrayBuffer()), meta=zip.file('project2.json');
			if (!meta) throw new Error('最终归档缺少工程 metadata');
			const metadata=JSON.parse(await meta.async('string')), inspector=createNativeInspector(), finalDocs: ObjectValue[]=[];
			for(const path of Object.keys(zip.files).filter(path=>path.toLowerCase().endsWith('.epru')&&!zip.files[path].dir)) finalDocs.push(...inspector.inspectNativeProject({projectMetadata:metadata,source:await zip.file(path)!.async('string')}).documents);
			for(const resource of verifiedResources){
				const matches=finalDocs.filter(d=>d.docType===resource.docType&&d.uuid===resource.uuid);
				const normalized=(rows:any[])=>rows.filter(r=>r.header.type!=='DOCHEAD').map(r=>({header:r.header,data:r.data})).sort((a,b)=>`${a.header.type}\0${a.header.id}`.localeCompare(`${b.header.type}\0${b.header.id}`));
				if(matches.length!==1||stable(normalized(matches[0].effectiveRecords))!==stable(normalized(resource.effectiveRecords)))throw new Error(`最终资源闭包丢失或改变：${resource.docType}/${resource.uuid}`);
			}
			const archiveGroupTicketRevisionProofs:ObjectValue[]=[];
			const closeAckRows=Array.isArray(reopened.closeAcknowledgements)?reopened.closeAcknowledgements:[], closeTargetIds=Array.isArray(reopened.closedTabIds)?reopened.closedTabIds:[];
			const lastClosePoll=Array.isArray(reopened.closeTreePolls)?reopened.closeTreePolls.at(-1):undefined;
			const closeProofByDocument=new Map<string,ObjectValue>();
			const targetDocuments=documentList(prepared),targetDocumentUuids=targetDocuments.map(doc=>doc.uuid),lastTreeCheck=lastClosePoll?inspectSplitScreenTree(lastClosePoll.tree):{valid:false,tabIds:[]};
			const closeProofValid=closeAckRows.length===targetDocuments.length&&closeAckRows.every((row:any)=>row?.closeAck===true&&typeof row.docUuid==='string'&&targetDocumentUuids.includes(row.docUuid)
				&&typeof row.tabId==='string'&&closeTargetIds.includes(row.tabId))&&new Set(closeAckRows.map((row:any)=>row.docUuid)).size===targetDocuments.length
				&&closeTargetIds.length===targetDocuments.length&&new Set(closeTargetIds).size===targetDocuments.length&&lastClosePoll?.valid===true
				&&Array.isArray(lastClosePoll.remainingTargetIds)&&lastClosePoll.remainingTargetIds.length===0&&lastTreeCheck.valid&&closeTargetIds.every(id=>!lastTreeCheck.tabIds.includes(id));
			if(closeProofValid)for(const row of closeAckRows)closeProofByDocument.set(row.docUuid,row);
			for(const before of prepared.archiveDocuments) {
				const groups=before.effectiveRecords.filter(row=>row.header.type==='GROUP');
				const after=finalDocs.filter(d=>d.docType===before.docType&&d.uuid===before.uuid);
				if(after.length!==1)throw new Error('最终归档分组所属文档丢失');
				const afterGroups=after[0].effectiveRecords.filter((row:any)=>row.header.type==='GROUP');
				if(afterGroups.length!==groups.length)throw new Error('最终归档 GROUP 丢失或出现未计划分组');
				const groupById=(rows:any[])=>{
					const result=new Map<string,any>();
					for(const row of rows){if(typeof row.header?.id!=='string'||result.has(row.header.id))throw new Error('归档 GROUP ID缺失或重复');result.set(row.header.id,row);}
					return result;
				};
				const beforeGroups=groupById(groups),persistedGroups=groupById(afterGroups);
				const targetDoc=documentList(prepared).find(doc=>doc.uuid===before.uuid&&doc.type===(before.docType==='PCB'?3:1));
				for(const [groupId,group] of beforeGroups){
					const persisted=persistedGroups.get(groupId);
					if(!persisted)throw new Error(`最终归档 GROUP 丢失：${groupId}`);
					if(stable({header:persisted.header,data:persisted.data})===stable({header:group.header,data:group.data}))continue;
					const beforeTicket=group.header.ticket,afterTicket=persisted.header.ticket;
					if(!targetDoc||!Number.isSafeInteger(beforeTicket)||beforeTicket<=0||!Number.isSafeInteger(afterTicket)||afterTicket<=beforeTicket
						||stable(headerWithoutTicket(group.header))!==stable(headerWithoutTicket(persisted.header))||stable(group.data)!==stable(persisted.data))
						throw new Error(`最终归档 GROUP 丢失或变化：${groupId}`);
					const liveDoc=snapshots.find(doc=>doc.uuid===before.uuid&&doc.type===targetDoc.type),liveDeltaProof=liveDocumentDeltaProofs.find(proof=>proof.documentUuid===before.uuid&&proof.stage==='verifyFinal');
					if(!liveDoc||!liveDeltaProof||!closeProofValid||!closeProofByDocument.has(before.uuid))throw new Error(`最终 GROUP票号变化缺少目标文档重开证明：${groupId}`);
					const liveRows=records(liveDoc.source,liveDoc.uuid,liveDoc.type),liveGroupCount=liveRows.filter(row=>row.type==='GROUP'&&row.id===groupId).length;
					const bindings:ObjectValue[]=[];
					for(const [replacementIndex,replacement] of prepared.replacements.entries()){
						if(liveDoc.type===3&&liveDoc.uuid===prepared.pcbUuid){
							const oldId=replacement.input.pcbComponentId,candidateId=String(oneStage(prior,'pcb_create_candidate',replacementIndex).candidateId);
							const oldNative=nativeComponent(prepared.pcbNative.records,oldId),candidateNative=nativeComponent(liveRows,candidateId);
							if(oldNative.groupId===groupId&&candidateNative.groupId===groupId)bindings.push({stage:'pcb',oldComponentId:oldId,candidateComponentId:candidateId,groupId});
						}
						for(const [partIndex,part] of replacement.schematicParts.entries())if(liveDoc.type===1&&part.pageUuid===liveDoc.uuid){
							const candidateId=String(oneStage(prior,'schematic_create_part',replacementIndex,partIndex).candidateId);
							const oldNative=nativeComponent(part.native.records,part.componentId),candidateNative=nativeComponent(liveRows,candidateId);
							if(oldNative.groupId===groupId&&candidateNative.groupId===groupId)bindings.push({stage:'schematic',oldComponentId:part.componentId,candidateComponentId:candidateId,groupId});
						}
					}
					if(!bindings.length)throw new Error(`变更票号的 GROUP 无法绑定到本次旧件→候选件替换：${groupId}`);
					const closeAck=closeProofByDocument.get(before.uuid)!;
					archiveGroupTicketRevisionProofs.push({documentUuid:before.uuid,groupId,beforeArchiveTicket:beforeTicket,afterArchiveTicket:afterTicket,
						liveRevisionProof:{method:'replacement-groupId-binding',documentUuid:before.uuid,liveGroupRecordsForId:liveGroupCount,bindings,liveNativePreservation:liveDeltaProof.method,
							oldToCandidateGroupIdVerified:true,saveCloseReopenVerified:true},
						persistenceProof:{archiveDocType:before.docType,groupId,beforeArchiveTicket:beforeTicket,afterArchiveTicket:afterTicket,headerAndDataUnchangedExceptTicket:true,archiveReadbackVerified:true},
						saveCloseReopenProof:{docUuid:before.uuid,tabId:closeAck.tabId,closeAck:closeAck.closeAck,treePoll:lastClosePoll}});
				}
			}
			for(const snapshot of snapshots){const after=await read(prepared,snapshot);assertReplacementRecordsUnchanged(records(snapshot.source,snapshot.uuid,snapshot.type),records(after.source,after.uuid,after.type),new Set());}
			const ticketReindexProofs=[...prior.flatMap((row:any)=>Array.isArray(row?.ticketReindexProofs)?row.ticketReindexProofs:[]),...finalTicketReindexProofs];
			return { targets:targetProofs, documentCount:snapshots.length, nonTargetNativePreserved:true, schematicPcbNetsVerified:true, archiveGroupsPreserved:true, saveCloseReopenVerified:true, ticketReindexProofs, archiveGroupTicketRevisionProofs,candidateDefaultPersistenceProofs:reopened.candidateDefaultPersistenceProofs??[] };
		},
	};
}
