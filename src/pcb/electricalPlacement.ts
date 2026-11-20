export interface ElectricalPadRef { componentId: string; padId?: string; padNumber?: string }
export interface ElectricalConstraint { from: ElectricalPadRef; to: ElectricalPadRef; maxDistanceMil: number }
export interface ElectricalPlacementInput { movableComponentIds: string[]; constraints: ElectricalConstraint[]; maxShiftMil: number; stepMil: number; minClearanceMil: number; searchBudget?: number }
export interface ElectricalPad { id: string; componentId: string; number: string; x: number; y: number; shape: unknown[]; rotation: number; net?: string }
export interface ElectricalComponent { id: string; designator: string; x: number; y: number; rotation: number; layer: number; locked: boolean; pads: ElectricalPad[] }
export interface ElectricalBoard { uuid: string; source: string; components: ElectricalComponent[]; outline: { x1: number; y1: number; x2: number; y2: number }; routedNets: string[]; routedObjects?: Array<{id:string;net:string;type:'line'|'via'}> }
export interface ElectricalMove { componentId: string; designator: string; from: { x: number; y: number }; to: { x: number; y: number }; movedMil: number }
export interface ElectricalPlan { version: 1; documentUuid: string; sourceHash: string; input: ElectricalPlacementInput; moves: ElectricalMove[]; constraints: Array<{ index: number; from: ElectricalPadRef; to: ElectricalPadRef; maxDistanceMil: number; beforeMil: number; afterMil: number; beforeViolation: boolean; afterViolation: boolean }>; violationsBefore: number; violationsAfter: number; searchExhausted: boolean; searchStats:{candidateOffsetsConsidered:number;candidatesEvaluated:number}; geometryComplete: boolean; issues: string[]; connectedNets: string[]; connectedCopperObjects:Array<{id:string;net:string;type:'line'|'via'}> }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function electricalStable(value: any): any {
	if (Array.isArray(value)) return value.map(electricalStable);
	if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, electricalStable(value[k])]));
	return value;
}
export function electricalHash(value: string): string {
	let h = 2166136261;
	for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
	return (h >>> 0).toString(16).padStart(8, '0');
}
function padBox(p: ElectricalPad): { x1: number; y1: number; x2: number; y2: number } | null {
	if (!finite(p.x) || !finite(p.y) || !finite(p.rotation) || !Array.isArray(p.shape)) return null;
	const type = String(p.shape[0] ?? '').toUpperCase(), w = p.shape[1], h = p.shape[2];
	if (!finite(w) || !finite(h) || w <= 0 || h <= 0 || !['RECT', 'RECTANGLE', 'ELLIPSE', 'OVAL', 'OBLONG'].includes(type)) return null;
	const rad = p.rotation * Math.PI / 180, c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
	const a = w * c + h * s, b = w * s + h * c;
	return { x1: p.x - a / 2, x2: p.x + a / 2, y1: p.y - b / 2, y2: p.y + b / 2 };
}
const overlap = (a: ReturnType<typeof padBox>, b: ReturnType<typeof padBox>) => !!a && !!b && a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
function clearanceBox(box: NonNullable<ReturnType<typeof padBox>>, amount: number) { return {x1:box.x1-amount,y1:box.y1-amount,x2:box.x2+amount,y2:box.y2+amount}; }
function resolvePad(components: ElectricalComponent[], ref: ElectricalPadRef): ElectricalPad {
	const c = components.find(x => x.id === ref.componentId);
	if (!c) throw new Error(`约束指定器件不存在：${ref.componentId}`);
	let matches = c.pads.filter(p => ref.padId ? p.id === ref.padId : ref.padNumber != null && p.number === String(ref.padNumber));
	if (!ref.padId && ref.padNumber == null) throw new Error(`焊盘引用必须提供 padId 或 padNumber：${ref.componentId}`);
	if (matches.length !== 1) {
		const choices = c.pads.map(p => `${p.number || '(无编号)'} [${p.id}]`).join(', ');
		throw new Error(matches.length ? `焊盘编号 ${ref.padNumber} 有歧义，请使用实际 padId。候选：${choices}` : `未找到焊盘 ${JSON.stringify(ref)}。实际焊盘：${choices}`);
	}
	return matches[0];
}
function validateInput(i: ElectricalPlacementInput): void {
	if (!i || !Array.isArray(i.movableComponentIds) || !i.movableComponentIds.length || !Array.isArray(i.constraints) || !i.constraints.length) throw new Error('必须提供 movableComponentIds 和 constraints');
	if (!finite(i.maxShiftMil) || i.maxShiftMil <= 0 || !finite(i.stepMil) || i.stepMil <= 0) throw new Error('maxShiftMil 和 stepMil 必须是正有限数值（mil）');
	if (!finite(i.minClearanceMil) || i.minClearanceMil < 0) throw new Error('minClearanceMil 必须是显式提供的非负有限数值（mil）');
	if (i.searchBudget != null && (!Number.isInteger(i.searchBudget) || i.searchBudget < 1)) throw new Error('searchBudget 必须为正整数');
	for (const c of i.constraints) if (!finite(c.maxDistanceMil) || c.maxDistanceMil <= 0) throw new Error('每条 maxDistanceMil 必须为正有限数值');
}
function dist(a: ElectricalPad, b: ElectricalPad): number { return Math.hypot(a.x - b.x, a.y - b.y); }
function shiftPad(p: ElectricalPad, dx: number, dy: number): ElectricalPad { return { ...p, x: p.x + dx, y: p.y + dy }; }
function* offsetsByIncreasingRadius(maxSteps:number,stepMil:number,maxShiftMil:number):Generator<{dx:number;dy:number}>{
	for(let radius=0;radius<=maxSteps;radius++){
		if(radius===0){yield {dx:0,dy:0};continue;}
		for(let ix=-radius;ix<=radius;ix++){
			const edge=ix===-radius||ix===radius;
			const ys=edge?Array.from({length:2*radius+1},(_,i)=>i-radius):[-radius,radius];
			for(const iy of ys){
				const dx=ix*stepMil,dy=iy*stepMil;
				if(Math.hypot(dx,dy)<=maxShiftMil+1e-8)yield {dx,dy};
			}
		}
	}
}

export function createElectricalPlacementPlan(board: ElectricalBoard, input: ElectricalPlacementInput): ElectricalPlan {
	validateInput(input);
	const components = board.components.map(c => ({ ...c, pads: c.pads.map(p => ({ ...p })) }));
	const movable = new Set(input.movableComponentIds);
	if (movable.size !== input.movableComponentIds.length) throw new Error('movableComponentIds 含重复 ID');
	for (const id of movable) { const c = components.find(x => x.id === id); if (!c) throw new Error(`指定可移动器件不存在：${id}`); if (c.locked) throw new Error(`器件 ${c.designator} 已锁定，拒绝移动`); }
	const endpoints = input.constraints.map(c => [resolvePad(components, c.from), resolvePad(components, c.to)] as const);
	const selectedNets=new Set(components.filter(c=>movable.has(c.id)).flatMap(c=>c.pads.map(p=>p.net).filter(Boolean)));
	const connectedNets=board.routedNets.filter(net=>selectedNets.has(net));
	const connectedCopperObjects=(board.routedObjects??[]).filter(o=>connectedNets.includes(o.net));
	const unsupported = components.flatMap(c => c.pads.filter(p => !padBox(p)).map(p => `${c.designator}/${p.number || p.id}: ${String(p.shape?.[0] ?? '未知形状')}`));
	if (unsupported.length) {
		const checks = input.constraints.map((c,index) => { const [a,b]=endpoints[index],d=dist(a,b); return {index,from:c.from,to:c.to,maxDistanceMil:c.maxDistanceMil,beforeMil:d,afterMil:d,beforeViolation:d>c.maxDistanceMil,afterViolation:d>c.maxDistanceMil}; });
		return {version:1,documentUuid:board.uuid,sourceHash:electricalHash(board.source),input:JSON.parse(JSON.stringify(input)),moves:[],constraints:checks,violationsBefore:checks.filter(x=>x.beforeViolation).length,violationsAfter:checks.filter(x=>x.afterViolation).length,searchExhausted:false,searchStats:{candidateOffsetsConsidered:0,candidatesEvaluated:0},geometryComplete:false,issues:[`以下焊盘形状不支持几何外接框检查：${unsupported.join('; ')}`,'障碍物仅按已读回焊盘外接框检查；不代表courtyard/装配间隙验证','引脚间距约束不证明回流、EMI或整板布线质量'],connectedNets,connectedCopperObjects};
	}
	const initial = endpoints.map(([a,b], index) => ({ index, from: input.constraints[index].from, to: input.constraints[index].to, maxDistanceMil: input.constraints[index].maxDistanceMil, beforeMil: dist(a,b), afterMil: dist(a,b), beforeViolation: dist(a,b) > input.constraints[index].maxDistanceMil, afterViolation: dist(a,b) > input.constraints[index].maxDistanceMil }));
	const originals = new Map(components.map(c => [c.id, { x: c.x, y: c.y, pads: c.pads.map(p => ({...p})) }]));
	const budget = input.searchBudget ?? 20000;
	let used = 0, evaluated = 0, exhausted = false;
	const Translation = new Map<string, {dx:number;dy:number}>();
	const maxSteps = Math.floor(input.maxShiftMil / input.stepMil + 1e-9);
	const cmp = (a: {dx:number;dy:number;score:number[]}, b: {dx:number;dy:number;score:number[]}) => a.score[0]-b.score[0] || a.score[1]-b.score[1] || a.score[2]-b.score[2] || a.dx-b.dx || a.dy-b.dy;
	const geometryOkay = (extraId:string, dx:number, dy:number):boolean => {
		const boxes=components.flatMap(c=>c.pads.map(p=>{const prior=Translation.get(c.id);const tx=c.id===extraId?dx:(prior?.dx??0),ty=c.id===extraId?dy:(prior?.dy??0);return {componentId:c.id,box:padBox(shiftPad(p,tx,ty))};}));
		for(const {box} of boxes){if(!box||box.x1<board.outline.x1+input.minClearanceMil||box.y1<board.outline.y1+input.minClearanceMil||box.x2>board.outline.x2-input.minClearanceMil||box.y2>board.outline.y2-input.minClearanceMil)return false;}
		for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)if(boxes[i].componentId!==boxes[j].componentId&&(boxes[i].componentId===extraId||boxes[j].componentId===extraId||Translation.has(boxes[i].componentId)||Translation.has(boxes[j].componentId))&&overlap(clearanceBox(boxes[i].box!,input.minClearanceMil/2),clearanceBox(boxes[j].box!,input.minClearanceMil/2)))return false;
		return true;
	};
	for(const id of movable){
		const candidates:Array<{dx:number;dy:number;score:number[]}>=[];
		for(const {dx,dy} of offsetsByIncreasingRadius(maxSteps,input.stepMil,input.maxShiftMil)){
			if(used>=budget){exhausted=true;break;}
			used++;
			evaluated++;
			if(!geometryOkay(id,dx,dy))continue;
			const post=endpoints.map(([a,b],n)=>{const pa=Translation.get(a.componentId),pb=Translation.get(b.componentId);const aa=shiftPad(a,(a.componentId===id?dx:pa?.dx??0),(a.componentId===id?dy:pa?.dy??0));const bb=shiftPad(b,(b.componentId===id?dx:pb?.dx??0),(b.componentId===id?dy:pb?.dy??0));return dist(aa,bb);});
			const regresses=post.some((d,n)=>d>input.constraints[n].maxDistanceMil && initial[n].beforeMil<=input.constraints[n].maxDistanceMil);
			if(regresses)continue;
			const violations=post.map((d,n)=>Math.max(0,d-input.constraints[n].maxDistanceMil));
			candidates.push({dx,dy,score:[violations.filter(x=>x>1e-8).length,violations.reduce((s,x)=>s+x,0),Math.hypot(dx,dy)]});
		}
		candidates.sort(cmp);
		const best=candidates[0];if(best)Translation.set(id,{dx:best.dx,dy:best.dy});
		if(exhausted)break;
	}
	const selected=Translation;
	const padsAfter = new Map<string, ElectricalPad>();
	for (const c of components) for (const p of c.pads) { const s=selected.get(c.id); padsAfter.set(p.id,s ? shiftPad(p,s.dx,s.dy) : p); }
	const checks = initial.map(check => {
		const a=resolvePad(components,check.from), b=resolvePad(components,check.to), d=dist(padsAfter.get(a.id)!,padsAfter.get(b.id)!);
		return {...check,afterMil:d,afterViolation:d>check.maxDistanceMil};
	});
	const finalGeometryOkay=[...selected].every(([id,s])=>geometryOkay(id,s.dx,s.dy));
	const moves=[...selected].filter(([,s])=>Math.hypot(s.dx,s.dy)>1e-8).map(([id,s])=>{const c=components.find(x=>x.id===id)!;return {componentId:id,designator:c.designator,from:{x:c.x,y:c.y},to:{x:c.x+s.dx,y:c.y+s.dy},movedMil:Math.hypot(s.dx,s.dy)}});
	const issues=[`移动和板边校核使用焊盘外接框，最小间距 ${input.minClearanceMil} mil；不含courtyard/装配外形`,'不支持焊盘形状会使计划标记为不完整并禁止执行','引脚间距约束不证明回流、EMI或整板布线质量'];
	return {version:1,documentUuid:board.uuid,sourceHash:electricalHash(board.source),input:JSON.parse(JSON.stringify(input)),moves,constraints:checks,violationsBefore:checks.filter(x=>x.beforeViolation).length,violationsAfter:checks.filter(x=>x.afterViolation).length,searchExhausted:exhausted,searchStats:{candidateOffsetsConsidered:used,candidatesEvaluated:evaluated},geometryComplete:finalGeometryOkay,issues:finalGeometryOkay?issues:[...issues,'所选多器件平移组合未通过最终外接框间距复核'],connectedNets,connectedCopperObjects};
}
