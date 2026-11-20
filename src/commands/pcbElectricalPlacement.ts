import type { ICommandDef, ICommandContext } from '../engine/types';
import { assertDocumentTarget, captureDocumentTarget } from '../engine/documentTarget';
import { parseSourceLog, recordKey, resolveRecords } from '../pcb/sourcelog';
import { compareDocumentSources } from '../engine/documentRecovery';
import { createElectricalPlacementPlan, electricalHash, electricalStable, type ElectricalBoard, type ElectricalComponent, type ElectricalConstraint, type ElectricalPlacementInput, type ElectricalPlan, type ElectricalPad } from '../pcb/electricalPlacement';

declare const eda: any;
const plans = new Map<string, { plan: ElectricalPlan; baselineSource: string; targetIdentity: ReturnType<typeof captureDocumentTarget> }>();
const state = (obj: any, name: string): any => {
	const fn = obj?.[`getState_${name}`];
	if (typeof fn !== 'function') throw new Error(`EDA 对象缺少 getState_${name}()`);
	return fn.call(obj);
};
const optional = (obj: any, name: string): any => typeof obj?.[`getState_${name}`] === 'function' ? state(obj, name) : undefined;
const sha = (value: string) => electricalHash(value);
function lineSnapshot(lines: any[],vias:any[]=[]): string {
	const lineRows=lines.map(l=>({type:'line',id:optional(l,'PrimitiveId'),net:optional(l,'Net'),layer:optional(l,'Layer'),width:optional(l,'LineWidth'),x1:optional(l,'StartX'),y1:optional(l,'StartY'),x2:optional(l,'EndX'),y2:optional(l,'EndY')}));
	const viaRows=vias.map(v=>({type:'via',id:optional(v,'PrimitiveId'),net:optional(v,'Net'),x:optional(v,'X'),y:optional(v,'Y'),diameter:optional(v,'Diameter'),hole:optional(v,'HoleDiameter'),layer:optional(v,'Layer')}));
	return JSON.stringify([...lineRows,...viaRows].sort((a,b)=>String(a.id).localeCompare(String(b.id))));
}
export function onlyTargetSourceChanged(before:string,after:string,move:ElectricalPlan['moves'][number]):boolean{
	try{
		const beforeDocument=parseSourceLog(before),afterDocument=parseSourceLog(after);
		if(beforeDocument.records.length!==afterDocument.records.length)return false;
		const beforeKeys=beforeDocument.records.map(recordKey).sort(),afterKeys=afterDocument.records.map(recordKey).sort();
		if(JSON.stringify(beforeKeys)!==JSON.stringify(afterKeys))return false;
		const a=resolveRecords(beforeDocument),b=resolveRecords(afterDocument);
		if(a.size!==b.size)return false;
		for(const [key,oldRecord] of a){
			const next=b.get(key);if(!next)return false;
			if(next.header.type==='DOCHEAD')continue;
			if(JSON.stringify(electricalStable(oldRecord.data))===JSON.stringify(electricalStable(next.data)))continue;
			if(!oldRecord.data||typeof oldRecord.data!=='object'||!next.data||typeof next.data!=='object'||Array.isArray(oldRecord.data)||Array.isArray(next.data))return false;
			const oldData=oldRecord.data as Record<string,any>,nextData=next.data as Record<string,any>;
			if(next.header.type==='COMPONENT'&&String(next.header.id??'')===move.componentId){
				const oldRest={...oldData},newRest={...nextData};
				for(const k of ['x','y']){delete oldRest[k];delete newRest[k];}
				if(JSON.stringify(electricalStable(oldRest))!==JSON.stringify(electricalStable(newRest))||nextData.x!==move.to.x||nextData.y!==move.to.y)return false;
				continue;
			}
			if(next.header.type==='ATTR'&&oldData.parentId===move.componentId&&nextData.parentId===move.componentId){
				const oldRest={...oldData},newRest={...nextData};
				for(const k of ['x','y']){
					if(!Object.is(oldData[k],nextData[k])){
						const delta=k==='x'?move.to.x-move.from.x:move.to.y-move.from.y;
						if(typeof oldData[k]!=='number'||typeof nextData[k]!=='number'||Math.abs((nextData[k]-oldData[k])-delta)>1e-5)return false;
					}
					delete oldRest[k];delete newRest[k];
				}
				if(JSON.stringify(electricalStable(oldRest))!==JSON.stringify(electricalStable(newRest)))return false;
				continue;
			}
			return false;
		}
		return true;
	}catch{return false;}
}

async function readBoard(context?: ICommandContext): Promise<{ snapshot: any; board: ElectricalBoard }> {
	const info = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!info?.uuid || info.documentType !== 3) throw new Error('当前焦点不是有效 PCB 文档');
	const target = context?.documentTarget ?? captureDocumentTarget(info);
	await assertDocumentTarget(target, context?.stopSignal);
	const source = await eda.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string' || !source.trim()) throw new Error('读取 PCB 源码失败或为空');
	if (parseSourceLog(source).uuid !== info.uuid) throw new Error('PCB 焦点 UUID 与源码 UUID 不一致');
	const compsRaw = await eda.pcb_PrimitiveComponent.getAll();
	const polys = await eda.pcb_PrimitivePolyline.getAll();
	const lineRaw = await eda.pcb_PrimitiveLine.getAll();
	if (!Array.isArray(compsRaw) || !Array.isArray(polys) || !Array.isArray(lineRaw)) throw new Error('PCB 组件、板框或线段列表读回无效');
	const rectangles: Array<{x1:number;y1:number;x2:number;y2:number}> = [];
	let boardOutlineCount=0;
	for (const poly of polys) {
		if (state(poly,'Layer') !== 11) continue;
		boardOutlineCount++;
		const shape = state(poly,'Polygon');
		const src = typeof shape?.getSource === 'function' ? shape.getSource() : undefined;
		if (Array.isArray(src) && src[0] === 'R' && src.length === 7 && src[5] === 0 && src[6] === 0 && [src[1],src[2],src[3],src[4]].every(Number.isFinite) && src[3] > 0 && src[4] > 0)
			rectangles.push({x1:src[1],x2:src[1]+src[3],y1:src[2]-src[4],y2:src[2]});
		else throw new Error(`板框候选不是受支持的零旋转、无圆角矩形（${String(optional(poly,'PrimitiveId')??'无ID')}）`);
	}
	if (boardOutlineCount!==1||rectangles.length !== 1) throw new Error(`首版只接受唯一零旋转、无圆角矩形板框；检测到 ${boardOutlineCount} 个板框候选`);
	const components: ElectricalComponent[] = [];
	for (const obj of compsRaw) {
		const id = state(obj,'PrimitiveId');
		const padRaw = await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(id);
		if (!Array.isArray(padRaw) || !padRaw.length) throw new Error(`器件 ${id} 焊盘列表缺失，几何校核不完整`);
		const pads: ElectricalPad[] = padRaw.map((p: any) => ({id:state(p,'PrimitiveId'),componentId:id,number:String(state(p,'PadNumber') ?? ''),x:state(p,'X'),y:state(p,'Y'),shape:state(p,'Pad'),rotation:state(p,'Rotation'),net:String(optional(p,'Net') ?? '')}));
		components.push({id,designator:String(state(obj,'Designator') ?? ''),x:state(obj,'X'),y:state(obj,'Y'),rotation:state(obj,'Rotation'),layer:state(obj,'Layer'),locked:state(obj,'PrimitiveLock') === true,pads});
	}
	const vias=await eda.pcb_PrimitiveVia.getAll();
	if(!Array.isArray(vias)) throw new Error('过孔列表读回无效');
	const routedObjects=[...lineRaw.map((l:any)=>({id:String(optional(l,'PrimitiveId')??''),net:String(optional(l,'Net')??''),type:'line' as const})),...vias.map((v:any)=>({id:String(optional(v,'PrimitiveId')??''),net:String(optional(v,'Net')??''),type:'via' as const}))].filter(x=>x.id&&x.net);
	const routedNets = [...new Set(routedObjects.map(x=>x.net))];
	return {snapshot:{documentUuid:String(info.uuid),tabId:info.tabId},board:{uuid:String(info.uuid),source,components,outline:rectangles[0],routedNets,routedObjects,lineSnapshot:lineSnapshot(lineRaw,vias)} as any};
}
function verifyPlan(plan: any): asserts plan is ElectricalPlan {
	if (!plan || plan.version !== 1 || typeof plan.documentUuid !== 'string' || typeof plan.sourceHash !== 'string' || !Array.isArray(plan.moves) || !Array.isArray(plan.constraints)) throw new Error('plan 格式无效；必须传入 pcb.getElectricalPlacementPlan 返回的原计划');
}

export const pcbElectricalPlacementCommands: Array<ICommandDef> = [
	{
		name:'pcb.getElectricalPlacementPlan',
		summary:'按明确的焊盘间距约束，为指定未锁定器件生成局部平移计划；只读，不执行修改',
		params:[
			{name:'movableComponentIds',type:'string[]',required:true,description:'明确允许平移的器件 ID 列表；所有其余器件固定'},
			{name:'constraints',type:'object[]',required:true,description:'[{from:{componentId,padId或padNumber},to:{componentId,padId或padNumber},maxDistanceMil}]，只表达焊盘中心最大距离，不推断网络用途'},
			{name:'maxShiftMil',type:'number',required:true,description:'每个器件最大平移量（mil）'},
			{name:'stepMil',type:'number',required:true,description:'搜索步长（mil）'},
			{name:'minClearanceMil',type:'number',required:true,description:'最小焊盘外接框间距与板边间距（mil）；调用方显式提供，不猜默认值'},
			{name:'searchBudget',type:'number',description:'候选点预算，默认 20000'},
		],
		returns:'{planId,plan}；计划含基线 hash、逐条约束前后距离、移动清单、搜索耗尽状态、固定障碍/板框状态和线路网络提示。不是完整装配或电气验收。',
		example:{cmd:'pcb.getElectricalPlacementPlan',params:{movableComponentIds:['component-id'],constraints:[{from:{componentId:'component-id',padNumber:'1'},to:{componentId:'other-id',padNumber:'2'},maxDistanceMil:80}],maxShiftMil:100,stepMil:10,minClearanceMil:8}},
		handler:async(params,_ctx)=>{
			const {snapshot,board}=await readBoard(_ctx);
			if (params.constraints?.some((c:any)=>!c?.from||!c?.to)) throw new Error('constraints 每项必须提供 from 与 to');
			const input:ElectricalPlacementInput={movableComponentIds:params.movableComponentIds,constraints:params.constraints as ElectricalConstraint[],maxShiftMil:Number(params.maxShiftMil),stepMil:Number(params.stepMil),minClearanceMil:Number(params.minClearanceMil),...(params.searchBudget==null?{}:{searchBudget:Number(params.searchBudget)})};
			const plan=createElectricalPlacementPlan(board,input);
			const id=`ep-${plan.documentUuid}-${plan.sourceHash}-${Date.now().toString(36)}`;
			plans.set(id,{plan,baselineSource:board.source,targetIdentity:_ctx?.documentTarget??captureDocumentTarget(await eda.dmt_SelectControl.getCurrentDocumentInfo())});
			return {planId:id,plan};
		},
	},
	{
		name:'pcb.applyElectricalPlacement',
		summary:'按指定已生成计划逐器件平移；默认 dryRun，不重算或替换计划，不保存 PCB',
		params:[
			{name:'planId',type:'string',required:true,description:'pcb.getElectricalPlacementPlan 返回的 planId'},
			{name:'plan',type:'object',description:'对应 planId 的原计划对象；用于严格匹配计划内容'},
			{name:'dryRun',type:'boolean',description:'默认为 true；仅 dryRun:false 才写入'},
			{name:'allowRoutedMovement',type:'boolean',description:'仅 true 时允许移动带已布线网络的目标；此时连通性返回 unverified，线路不会重建'},
		],
		returns:'{applied,verified,saved:false,partial,moves,connectivity}。每步写后读焊盘中心、器件姿态及全局源码；未知/部分结果立即停止，不自动重试或回滚。',
		example:{cmd:'pcb.applyElectricalPlacement',params:{planId:'ep-...',dryRun:true}},
		handler:async(params,ctx)=>{
			const cached=plans.get(String(params.planId));
			if(!cached) throw new Error('该 planId 不存在或已过期；请重新读取并生成计划');
			const plan=cached.plan;
			if(params.plan && JSON.stringify(params.plan)!==JSON.stringify(plan)) throw new Error('传入 plan 与缓存原计划不一致');
			verifyPlan(plan);
			if(!plan.geometryComplete) throw new Error(`计划几何检查不完整，拒绝应用：${plan.issues.join('; ')}`);
			const {snapshot,board}=await readBoard(ctx);
			const currentIdentity=ctx?.documentTarget??captureDocumentTarget(await eda.dmt_SelectControl.getCurrentDocumentInfo());
			if(JSON.stringify(electricalStable(currentIdentity))!==JSON.stringify(electricalStable(cached.targetIdentity))) throw new Error('PCB 页签或工程身份与计划生成时不同，拒绝应用');
			if(board.uuid!==plan.documentUuid || !compareDocumentSources(cached.baselineSource,board.source).equal) throw new Error('PCB 身份或有效源码基线已变化，拒绝应用旧计划');
			if(plan.violationsAfter>0) throw new Error('计划仍有一项或多项显式焊盘距离约束超限；只报告计划，不执行写入');
			if(plan.moves.length && plan.connectedNets.length && params.allowRoutedMovement!==true) throw new Error(`计划目标存在已布线网络 ${plan.connectedNets.join(', ')}；默认拒绝移动。确认接受线路连通性未验证后显式传 allowRoutedMovement:true`);
			if(params.dryRun!==false) return {applied:false,verified:false,saved:false,partial:false,dryRun:true,moves:plan.moves,constraints:plan.constraints,connectivity:plan.connectedNets.length?'unverified':'no-routed-lines-detected'};
			const moved:any[]=[];
			let expectedSource=board.source;
			let writeDispatched=false;
			const expectedLines=(board as any).lineSnapshot;
			try {
				for(const move of plan.moves){
					await ctx?.assertDocumentTarget?.();
					const pre=await eda.sys_FileManager.getDocumentSource();
					if(typeof pre!=='string'||!compareDocumentSources(expectedSource,pre).equal) throw new Error('逐步写入前有效源码与已确认阶段基线不同');
					ctx?.stopSignal?.assertActive();
					await assertDocumentTarget(ctx?.documentTarget ?? captureDocumentTarget(await eda.dmt_SelectControl.getCurrentDocumentInfo()),ctx?.stopSignal);
					writeDispatched=true;
					await eda.pcb_PrimitiveComponent.modify(move.componentId,{x:move.to.x,y:move.to.y});
					ctx?.stopSignal?.assertActive();
					await assertDocumentTarget(ctx?.documentTarget ?? captureDocumentTarget(await eda.dmt_SelectControl.getCurrentDocumentInfo()),ctx?.stopSignal);
					const components=await eda.pcb_PrimitiveComponent.getAll();
					const actual=(components??[]).find((c:any)=>state(c,'PrimitiveId')===move.componentId);
					if(!actual) throw new Error(`移动后无法读回器件 ${move.componentId}`);
					const x=state(actual,'X'),y=state(actual,'Y'),rotation=state(actual,'Rotation'),layer=state(actual,'Layer');
					if(x!==move.to.x||y!==move.to.y||rotation!==board.components.find(c=>c.id===move.componentId)?.rotation||layer!==board.components.find(c=>c.id===move.componentId)?.layer) throw new Error(`器件 ${move.componentId} 位置或保持属性读回不符`);
					for(const untouched of board.components.filter(c=>c.id!==move.componentId)){
						const actualOther=(components??[]).find((c:any)=>state(c,'PrimitiveId')===untouched.id);
						const priorMove=moved.find((x:any)=>x.componentId===untouched.id);
						const expectedX=priorMove?.to.x??untouched.x, expectedY=priorMove?.to.y??untouched.y;
						if(!actualOther||state(actualOther,'X')!==expectedX||state(actualOther,'Y')!==expectedY||state(actualOther,'Rotation')!==untouched.rotation||state(actualOther,'Layer')!==untouched.layer||state(actualOther,'PrimitiveLock')!==untouched.locked) throw new Error(`非目标器件 ${untouched.designator} 的位置或属性发生变化`);
					}
					const [linesNow,viasNow]=await Promise.all([eda.pcb_PrimitiveLine.getAll(),eda.pcb_PrimitiveVia.getAll()]);
					if(!Array.isArray(linesNow)||!Array.isArray(viasNow)||lineSnapshot(linesNow,viasNow)!==expectedLines) throw new Error('线路/过孔对象或网络记录在移动期间发生变化，已停止');
					const pads=await eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(move.componentId);
					if(!Array.isArray(pads)||!pads.length) throw new Error(`器件 ${move.componentId} 焊盘读回缺失`);
					const originalComponent=board.components.find(c=>c.id===move.componentId)!;
					for(const beforePad of originalComponent.pads){
						const actualPad=pads.find((p:any)=>state(p,'PrimitiveId')===beforePad.id);
						if(!actualPad||Math.abs(state(actualPad,'X')-(beforePad.x+move.to.x-move.from.x))>1e-5||Math.abs(state(actualPad,'Y')-(beforePad.y+move.to.y-move.from.y))>1e-5||state(actualPad,'Net')!==beforePad.net) throw new Error(`器件 ${move.componentId} 焊盘 ${beforePad.id} 实际中心或网络读回不符`);
					}
					const afterSource=await eda.sys_FileManager.getDocumentSource();
					if(typeof afterSource!=='string'||compareDocumentSources(pre,afterSource).equal||!onlyTargetSourceChanged(pre,afterSource,move)) throw new Error(`器件 ${move.componentId} 写入后源码无变化、读回无效，或出现目标器件以外的记录变化`);
					expectedSource=afterSource;
					ctx?.stopSignal?.assertActive();
					moved.push(move);
				}
				const final=await eda.sys_FileManager.getDocumentSource();
				if(typeof final!=='string'||!compareDocumentSources(expectedSource,final).equal) throw new Error('最终源码与最后一次确认的有效源码不同');
				const finalConstraints=[];
				for(const check of plan.constraints){
					const [fromPads,toPads]=await Promise.all([eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(check.from.componentId),eda.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(check.to.componentId)]);
					const pick=(pads:any[],ref:any)=>{const found=pads.filter((p:any)=>ref.padId?state(p,'PrimitiveId')===ref.padId:state(p,'PadNumber')===String(ref.padNumber));if(found.length!==1)throw new Error(`执行后焊盘身份歧义：${JSON.stringify(ref)}`);return {x:state(found[0],'X'),y:state(found[0],'Y')};};
					const a=pick(fromPads,check.from),b=pick(toPads,check.to),actualDistance=Math.hypot(a.x-b.x,a.y-b.y);
					if(actualDistance>check.maxDistanceMil)throw new Error(`实际焊盘间距 ${check.index} 为 ${actualDistance} mil，超过限制 ${check.maxDistanceMil} mil`);
					finalConstraints.push({index:check.index,actualDistanceMil:actualDistance,maxDistanceMil:check.maxDistanceMil,withinLimit:true});
				}
				const focus=await eda.dmt_SelectControl.getCurrentDocumentInfo();
				if(focus?.uuid!==plan.documentUuid||focus?.documentType!==3) throw new Error('执行后焦点 PCB 已改变');
				return {applied:true,verified:true,saved:false,partial:false,moves:moved,finalConstraints,connectedNets:plan.connectedNets,connectedCopperObjects:plan.connectedCopperObjects,connectivity:plan.connectedNets.length?'unverified':'no-routed-lines-detected'};
			} catch(error:any) {
				throw new Error(`电气约束布局执行停止；已确认完成 ${moved.length}/${plan.moves.length} 个器件，未自动重试或回滚：${error?.message??String(error)}`,{cause:{partial:moved.length>0||writeDispatched,unknown: writeDispatched,retryable:false,moved,remaining:plan.moves.slice(moved.length)}});
			}
		},
	},
];
