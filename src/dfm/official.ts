import type { CheckResult, SmtStandardConfig, ViolationCoord } from './vendor/types';
import { SHARED_DFM_STANDARDS } from './vendor/types';
import { isPackageSmaller, JLC_MATERIAL_STANDARDS, JLC_SUPPORTED_MATERIALS, normalizeEiaPackage, resolveMaxSize, resolveMinTrace, resolveOuterCopper, resolveSlotWithCopper, resolveViaSpec, SMT_STANDARDS } from './vendor/standards';
import { checkSameNetPadSpacing } from './vendor/pad-spacing';

export type DfmKind = 'pcb' | 'smt' | 'spacing';
export type { CheckResult } from './vendor/types';
export interface DfmIssue { code: string; message: string; item?: number }
export interface ReportedCopperLayer { layerId: number; thicknessMil: number | null; copperOz: number | null }
export interface ReportedCopperDifference { layerId: number; requestedOz: number; reportedOz: number }
export interface ReportedCopper { status: 'available' | 'partial' | 'unavailable'; layers: ReportedCopperLayer[]; matchesTarget: boolean | null; differences: ReportedCopperDifference[]; messages: string[] }
export interface DfmRun { results: CheckResult[]; expectedCount: number; issues: DfmIssue[]; coverage: string[]; upstreamPassed: boolean; complete: boolean; passed: boolean; reportedCopper?: ReportedCopper }
type DfmParams = {material?:string;thickness?:number;standard?:'economy'|'standard';minSpacingMm?:number;outerCopperOz?:number;innerCopperOz?:number}
export const UPSTREAM_INFO = { repository: 'https://github.com/easyeda/eext-jlc-order-dfm-checker', commit: 'afd538786d510f537ad4fa47c6329e6a99dc7625', version: '1.0.4', license: 'Apache-2.0' } as const;
export { JLC_SUPPORTED_MATERIALS };
export const DFM_COVERAGE = ['线距只检查正间隙 Line；不含接触、重叠、Arc 和 Polyline。', '长圆及不等边焊环按最大轴近似。', '同网焊盘间距使用胶囊体及内接圆近似。', '部分检查按有效铜图元层数启发式判定；第12/13项按设计铜层数分档。', 'EIA/BGA 按封装名称启发式识别。', '定位 ID 使用两组列表索引辅助匹配。'];
const CHECK_FAILURE = (number: number, item: string, message: string): CheckResult => ({ number, item, actualValue: message, standardValue: '完整读取后检查', result: 'warning' });
const READ_METHOD = /^(get|fetch|query|find)/i;
async function readReportedCopper(sdk: any, outerCopperOz: number, innerCopperOz: number): Promise<ReportedCopper> {
	const messages: string[] = [];
	let rows: any[];
	try {
		rows = await sdk.pcb_Layer.getAllLayers();
		if (!Array.isArray(rows)) throw new Error('pcb_Layer.getAllLayers did not return an array');
	}
	catch (error) {
		return { status: 'unavailable', layers: [], matchesTarget: null, differences: [], messages: ['读取设计铜层身份失败：' + String(error)] };
	}
	let identityUnknown = false;
	const requiredIds = new Set<number>();
	for (const row of rows) {
		if (!row || (row.type !== 'SIGNAL' && row.type !== 'PLANE')) continue;
		const id = Number(row.id);
		if (!(id === 1 || id === 2 || (id >= 15 && id <= 44))) continue;
		if (row.layerStatus === 0) continue;
		if (row.layerStatus === 1 || row.layerStatus === 2) requiredIds.add(id);
		else { identityUnknown = true; messages.push(`设计铜层 ${id} 的启用状态未知`); }
	}
	if (requiredIds.size === 0) return { status: 'unavailable', layers: [], matchesTarget: null, differences: [], messages: messages.length ? messages : ['没有可确认的启用铜层'] };
	let source: string;
	try {
		source = await sdk.sys_FileManager.getDocumentSource();
		if (typeof source !== 'string' || source.length === 0) throw new Error('PCB 源为空');
	}
	catch (error) {
		return { status: 'unavailable', layers: [...requiredIds].map(layerId => ({ layerId, thicknessMil: null, copperOz: null })), matchesTarget: null, differences: [], messages: [...messages, '可选 LAYER_PHYS 对照读取失败：' + String(error)] };
	}
	const phys = new Map<number, number>();
	for (const line of source.split(/\r?\n/)) {
		if (!line.includes('LAYER_PHYS')) continue;
		const separator = line.indexOf('||');
		if (separator < 0) { messages.push('发现无法解析的 LAYER_PHYS 记录'); continue; }
		try {
			const outer = JSON.parse(line.slice(0, separator));
			let innerRaw = line.slice(separator + 2);
			if (innerRaw.endsWith('|')) innerRaw = innerRaw.slice(0, -1);
			const inner = JSON.parse(innerRaw);
			const parsedId = typeof outer.id === 'string' ? JSON.parse(outer.id) : outer.id;
			const layerId = Number(Array.isArray(parsedId) ? parsedId[1] : parsedId);
			if (Number.isInteger(layerId) && (layerId === 1 || layerId === 2 || (layerId >= 15 && layerId <= 44))) phys.set(layerId, Number(inner?.thickness));
		}
		catch { messages.push('发现无法解析的 LAYER_PHYS 记录'); }
	}
	const layers: ReportedCopperLayer[] = [];
	const differences: ReportedCopperDifference[] = [];
	let validCount = 0;
	let allValid = true;
	for (const layerId of [...requiredIds].sort((a, b) => a === 1 ? -1 : b === 1 ? 1 : a === 2 ? 1 : b === 2 ? -1 : a - b)) {
		const thickness = phys.get(layerId);
		const validThickness = thickness !== undefined && Number.isFinite(thickness) && thickness > 0 && Math.round((thickness / 1.378) * 2) / 2 > 0;
		const copperOz = validThickness ? Math.round((thickness! / 1.378) * 2) / 2 : null;
		layers.push({ layerId, thicknessMil: validThickness ? thickness! : null, copperOz });
		if (!validThickness) {
			allValid = false;
			messages.push(`设计铜层 ${layerId} 缺少有效 LAYER_PHYS 铜厚`);
			continue;
		}
		validCount++;
		const requestedOz = layerId === 1 || layerId === 2 ? outerCopperOz : innerCopperOz;
		if (copperOz !== requestedOz) differences.push({ layerId, requestedOz, reportedOz: copperOz! });
	}
	const matchesTarget = allValid && !identityUnknown ? differences.length === 0 : null;
	const status = identityUnknown ? 'partial' : allValid ? 'available' : validCount > 0 ? 'partial' : 'unavailable';
	return { status, layers, matchesTarget, differences, messages };
}
function makeSdkFacade(sdk: any, issues: DfmIssue[]): any {
 const cache = new WeakMap<object, any>();
 const wrap = (obj: any, path: string): any => {
  if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return obj;
  if (cache.has(obj)) return cache.get(obj);
  const proxy = new Proxy(obj, { get(target, key) {
   if (key === 'sys_Log') return { add: () => undefined };
   const value = Reflect.get(target, key, target);
   if (typeof value === 'function') return (...args: any[]) => {
    const method = String(key);
    const ensureArray = (readResult: any): any => {
     if (/^getAll/i.test(method) && !Array.isArray(readResult)) {
      const error = new Error(`${path}.${method} did not return an array`);
      issues.push({ code: 'sdk_read_invalid_result', message: error.message });
      throw error;
     }
     return readResult;
    };
    let result: any; try { result = Reflect.apply(value, target, args); } catch (error) { if (READ_METHOD.test(method)) issues.push({code:'sdk_read_failed',message:path+'.'+method+': '+String(error)}); throw error; }
    if (result && typeof result.then === 'function') return result.then(ensureArray).catch((error:any) => { if (READ_METHOD.test(method) && !(error instanceof Error && error.message.endsWith('did not return an array'))) issues.push({code:'sdk_read_failed',message:path+'.'+method+': '+String(error)}); throw error; });
    return ensureArray(result);
   };
   return wrap(value, path+'.'+String(key));
  }});
  cache.set(obj, proxy); return proxy;
 };
 return wrap(sdk, 'sdk');
}
export async function runOfficialDfm(kind: DfmKind, params: DfmParams = {}, sdk: any): Promise<DfmRun> {
 if (kind === 'pcb') {
  if (params.outerCopperOz !== 1 && params.outerCopperOz !== 2) throw new Error('PCB DFM 必须指定 outerCopperOz 为 1 或 2');
  if (params.innerCopperOz !== 1) throw new Error('PCB DFM 必须指定 innerCopperOz 为 1');
 }
 const issues: DfmIssue[] = [];
 const checks = createChecks(sdk, params, issues);
 let results: CheckResult[]; const expectedCount = kind === 'pcb' ? 18 : kind === 'smt' ? 7 : 1;
 try { results = await checks(kind); } catch (error) { issues.push({code:'check_failed',message:String(error)}); results=[]; }
 for (const result of results) {
  if (/检查失败|检查出错|检查未完成|无法计算|未知|未找到|无图元|读取失败|数据无效|无法读取/.test(result.actualValue))
   issues.push({ code: 'result_unverified', item: result.number, message: `${result.item}未能完整核验：${result.actualValue}` });
 }
 const uniqueIssues = Array.from(new Map(issues.map(issue => [JSON.stringify(issue), issue])).values());
 const complete = results.length === expectedCount && uniqueIssues.length === 0;
 const upstreamPassed = results.length === expectedCount && results.every(r => r.result === 'success');
 const reportedCopper = kind === 'pcb' ? await readReportedCopper(sdk, params.outerCopperOz!, params.innerCopperOz!) : undefined;
 return {results, expectedCount, issues: uniqueIssues, coverage: DFM_COVERAGE.slice(), upstreamPassed, complete, passed: complete && upstreamPassed, ...(reportedCopper ? { reportedCopper } : {})};
}
function createChecks(sdk: any, params: DfmParams, issues: DfmIssue[]) {
 const eda = makeSdkFacade(sdk, issues);
 let selectedMaterial = params.material ?? 'FR4';
 let selectedThickness = params.thickness ?? 1.6;
const ESYS_LogType: any = {INFO:0,WARNING:1,ERROR:2};
 const readDesignCopperLayers = async (item: number) => {
  let rows: any[];
  try { rows = await eda.pcb_Layer.getAllLayers(); }
  catch (error) { issues.push({ code: 'design_layer_identity_unavailable', item, message: '无法读取设计图层身份：' + String(error) }); return null; }
  const copperRows = rows.filter((layer: any) => layer && (layer.type === 'SIGNAL' || layer.type === 'PLANE'));
  const activeIds = new Set<number>();
  const disabledIds = new Set<number>();
  const byId = new Map<number, any>();
  for (const layer of rows) {
   const id = Number(layer?.id);
   if (Number.isInteger(id)) byId.set(id, layer);
  }
  for (const layer of copperRows) {
   const id = Number(layer.id);
   if (!Number.isInteger(id)) {
    issues.push({ code: 'design_layer_identity_unknown', item, message: '发现铜层身份无效' });
    continue;
   }
   if (layer.layerStatus === 0) disabledIds.add(id);
   else if (layer.layerStatus === 1 || layer.layerStatus === 2) activeIds.add(id);
   else issues.push({ code: 'design_layer_status_unknown', item, message: `设计铜层 ${id} 的启用状态未知` });
  }
  const designCount = await parseCopperLayerCount();
  if (!Number.isInteger(designCount) || designCount < 1) {
   issues.push({ code: 'design_copper_layer_count_unavailable', item, message: '设计铜层数未知，无法选择线宽/线距档位' });
   return { rows, byId, activeIds, disabledIds, designCount: activeIds.size > 0 ? activeIds.size : null as number | null };
  }
  if (activeIds.size !== designCount)
   issues.push({ code: 'design_copper_layer_count_mismatch', item, message: `启用铜层身份为 ${activeIds.size} 层，SDK 设计铜层数为 ${designCount} 层` });
  return { rows, byId, activeIds, disabledIds, designCount };
 };
 const selectCopperLines = (lines: any[], item: number, layerContext: Awaited<ReturnType<typeof readDesignCopperLayers>>): any[] => {
  const selected: any[] = [];
  for (const line of lines) {
   const rawLayerId = line?.getState_Layer?.() ?? line?.layer ?? line?.layerId;
   if (rawLayerId === undefined || rawLayerId === null || rawLayerId === '') {
    issues.push({ code: 'line_layer_identity_unknown', item, message: '走线图层身份未知，无法确认是否属于有效铜层' });
    continue;
   }
   const layerId = Number(rawLayerId);
   if (!Number.isInteger(layerId)) {
    issues.push({ code: 'line_layer_identity_unknown', item, message: '走线图层身份未知，无法确认是否属于有效铜层' });
    continue;
   }
   if (!layerContext) {
    issues.push({ code: 'line_layer_identity_unknown', item, message: `走线图层 ${layerId} 无法核验是否为铜层` });
    continue;
   }
   const layerRow = layerContext.byId.get(layerId);
   if (!layerRow) {
    issues.push({ code: 'line_layer_identity_unknown', item, message: `走线图层 ${layerId} 不在设计图层列表中` });
    continue;
   }
   if (layerRow.type !== 'SIGNAL' && layerRow.type !== 'PLANE') continue;
   if (!isCopperLayerId(layerId)) {
    issues.push({ code: 'line_layer_identity_unknown', item, message: `铜走线图层 ${layerId} 的身份不受支持` });
    continue;
   }
   if (layerContext.disabledIds.has(layerId) || !layerContext.activeIds.has(layerId)) {
    issues.push({ code: 'line_copper_layer_unverified', item, message: `走线位于未知或未启用铜层 ${layerId}` });
    continue;
   }
   selected.push(line);
  }
  return selected;
 };
 const copperThreshold = (standard: any, layerId: number, designCount: number): { width: number; spacing: number } =>
  resolveMinTrace(standard, layerId === 1 || layerId === 2 ? params.outerCopperOz! : params.innerCopperOz!, designCount);
 const traceThresholdSummary = (standard: any, designCount: number): string => {
  const outer = resolveMinTrace(standard, params.outerCopperOz!, designCount);
  const inner = resolveMinTrace(standard, params.innerCopperOz!, designCount);
  return `外层${params.outerCopperOz}oz最小${outer.width}mm/${outer.spacing}mm；${designCount > 2 ? `内层${params.innerCopperOz}oz最小${inner.width}mm/${inner.spacing}mm` : '内层不适用'}（设计${designCount}层）`;
 };
 const runPcb = async (): Promise<CheckResult[]> => {
  const checks: Array<[number,string,()=>Promise<CheckResult>|CheckResult]> = [[1,'板材类型',()=>checkMaterialType()],[2,'层数',()=>checkLayerCount()],[3,'纵横尺寸',()=>checkBoardSize()],[4,'板厚',()=>checkBoardThickness()],[5,'外层铜厚',()=>checkOuterCopperThickness()],[6,'内层铜厚',()=>checkInnerCopperThickness()],[7,'过孔类型',()=>checkViaType()],[8,'过孔钻孔直径',()=>checkHoleDiameter()],[9,'过孔/焊盘外径',()=>checkViaPadDiameter()],[10,'有铜槽孔',()=>checkSlotWithCopper()],[11,'无铜槽孔',()=>checkSlotWithoutCopper()],[12,'最小线宽',()=>checkMinTraceWidth()],[13,'最小线距',()=>checkMinTraceSpacing()],[14,'焊盘/过孔到线间距',()=>checkPadToLineSpacing()],[15,'有铜插件焊盘焊环',()=>checkPluginPadRingWithCopper()],[16,'无铜插件焊盘焊环',()=>checkPluginPadRingWithoutCopper()],[17,'BGA焊盘',()=>checkBgaPad()],[18,'丝印字符',()=>checkString()]];
  const out: CheckResult[]=[]; for(const [n,item,fn] of checks){try{out.push(await fn())}catch(e){issues.push({code:'check_failed',item:n,message:String(e)});out.push(CHECK_FAILURE(n,item,'检查失败：'+String(e)))}} return out;
 };
 const runSmt = async (): Promise<CheckResult[]> => {
  const standard = params.standard ?? 'standard'; let compPads: ComponentPadCoords[] | null;
  try { compPads = await collectComponentPadCoords(); } catch(e) { compPads=null; issues.push({code:'smt_prefetch_failed',message:'多引脚焊盘预取失败：'+String(e)}); }
  const conf=SMT_STANDARDS[standard]; const checks:Array<[number,string,()=>Promise<CheckResult>|CheckResult]>=[[1,'焊接面',()=>checkSolderingSides(conf)],[2,'层数',()=>checkSmtLayerCount(conf)],[3,'板厚',()=>checkSmtBoardThickness(conf,selectedThickness)],[4,'尺寸',()=>checkSmtBoardSize(conf)],[5,'最小封装',()=>checkSmtMinPackage(conf)],[6,'最小 IC 引脚间距',()=>checkSmtIcPinPitch(conf,compPads??[])],[7,'BGA 球径间距',()=>checkSmtBgaPitch(conf,compPads??[])]];
  const out:CheckResult[]=[];for(const [n,item,fn] of checks){if(compPads===null&&n>=6){out.push(CHECK_FAILURE(n,item,'检查未完成：焊盘预取失败'));continue}try{out.push(await fn())}catch(e){issues.push({code:'check_failed',item:n,message:String(e)});out.push(CHECK_FAILURE(n,item,'检查失败：'+String(e)))}}return out;
 };
function checkMaterialType(): CheckResult {
	const result: CheckResult = {
		number: 1,
		item: '板材类型',
		actualValue: selectedMaterial,
		standardValue: JLC_SUPPORTED_MATERIALS.join(' / '),
		result: 'success',
	};

	try {
		// 检查是否支持
		if (!JLC_SUPPORTED_MATERIALS.includes(selectedMaterial)) {
			result.result = 'error';
			result.actualValue = `${selectedMaterial} (不支持)`;
		}
		else {
			result.actualValue = selectedMaterial;
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 第2项：层数检查
/**
 * 第2项：层数检查
 */
async function checkLayerCount(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 2,
		item: '层数',
		actualValue: '未知',
		standardValue: '1-64层',
		result: 'success',
	};

	try {
		// 有效铜层数：实际有走线/覆铜的层数（BOT-only 板按单面板计），不足时回退设计层叠层数
		const layerCount = await parseEffectiveCopperLayerCount();

		result.actualValue = layerCount > 0 ? `${layerCount}层` : '0层';

		// 根据板材检查层数范围
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];
		if (standard) {
			if (layerCount < standard.layerCount.min || layerCount > standard.layerCount.max) {
				result.result = 'error';
				result.standardValue = `${standard.layerCount.min}-${standard.layerCount.max}层`;
			}
			else {
				result.standardValue = `${standard.layerCount.min}-${standard.layerCount.max}层`;
			}
		}
		else {
			result.standardValue = '1-64层';
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 第3项：纵横尺寸检查
 */
async function checkBoardSize(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 3,
		item: '纵横尺寸',
		actualValue: '未知',
		standardValue: '10x10 - 470x570mm',
		result: 'success',
	};

	try {
		// 从板框层获取图元（EPCB_LayerId.BOARD_OUTLINE = 11）
		const BOARD_OUTLINE_LAYER = 11;

		// 获取板框层的所有多段线
		const polylines = await eda.pcb_PrimitivePolyline.getAll(undefined, BOARD_OUTLINE_LAYER as any);

		// 获取板框层的所有线段
		const lines = await eda.pcb_PrimitiveLine.getAll(undefined, BOARD_OUTLINE_LAYER as any);

		// 获取板框层的所有圆弧
		const arcs = await eda.pcb_PrimitiveArc.getAll(undefined, BOARD_OUTLINE_LAYER as any);

		// 收集所有图元ID
		const allIds: string[] = [];
		if (polylines && polylines.length > 0) {
			const polylineIds = polylines.map((p: any) => p.primitiveId || p.id);
			allIds.push(...polylineIds);
		}

		if (lines && lines.length > 0) {
			const lineIds = lines.map((l: any) => l.primitiveId || l.id);
			allIds.push(...lineIds);
		}

		if (arcs && arcs.length > 0) {
			const arcIds = arcs.map((a: any) => a.primitiveId || a.id);
			allIds.push(...arcIds);
		}

		// 如果板框层没有图元，尝试从所有层获取所有图元来计算边界框
		if (allIds.length === 0) {
			issues.push({ code: 'board_outline_inferred', item: 3, message: '未找到板框层，尺寸由全图元包围盒推断' });
			// 获取所有层的所有图元类型
			const allPolylines = await eda.pcb_PrimitivePolyline.getAll();
			const allLines = await eda.pcb_PrimitiveLine.getAll();
			const allArcs = await eda.pcb_PrimitiveArc.getAll();
			const allPads = await eda.pcb_PrimitivePad.getAll();
			const allVias = await eda.pcb_PrimitiveVia.getAll();
			const allPours = await eda.pcb_PrimitivePour.getAll();
			const allPoureds = await eda.pcb_PrimitivePoured.getAll();
			const allFills = await eda.pcb_PrimitiveFill.getAll();

			// 收集所有图元ID
			if (allPolylines?.length)
				allIds.push(...allPolylines.map((p: any) => p.primitiveId || p.id));
			if (allLines?.length)
				allIds.push(...allLines.map((p: any) => p.primitiveId || p.id));
			if (allArcs?.length)
				allIds.push(...allArcs.map((p: any) => p.primitiveId || p.id));
			if (allPads?.length)
				allIds.push(...allPads.map((p: any) => p.primitiveId || p.id));
			if (allVias?.length)
				allIds.push(...allVias.map((p: any) => p.primitiveId || p.id));
			if (allPours?.length)
				allIds.push(...allPours.map((p: any) => p.primitiveId || p.id));
			if (allPoureds?.length)
				allIds.push(...allPoureds.map((p: any) => p.primitiveId || p.id));
			if (allFills?.length)
				allIds.push(...allFills.map((p: any) => p.primitiveId || p.id));
		}

		if (allIds.length > 0) {
			const bbox = await eda.pcb_Primitive.getPrimitivesBBox(allIds);

			if (bbox) {
				// 将 mil 转换为 mm
				const widthMm = eda.sys_Unit.milToMm(bbox.maxX - bbox.minX);
				const heightMm = eda.sys_Unit.milToMm(bbox.maxY - bbox.minY);

				result.actualValue = `${widthMm.toFixed(2)}x${heightMm.toFixed(2)}mm`;

				// 根据板材检查尺寸范围
				const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];
				if (standard) {
					// 最大尺寸按层数分段(FR4):层数越多最大尺寸越小
					const layerCount = await parseEffectiveCopperLayerCount();
					const max = resolveMaxSize(standard, layerCount);
					const minWidth = standard.minSize.width;
					const minLength = standard.minSize.length;
					if (widthMm < minWidth || widthMm > max.width
						|| heightMm < minLength || heightMm > max.length) {
						result.result = 'error';
					}
					result.standardValue = `${minWidth}x${minLength} - ${max.width}x${max.length}mm`;
				}
			}
			else {
				result.actualValue = '无法计算尺寸';
				result.result = 'warning';
			}
		}
		else {
			result.actualValue = '无图元';
			result.result = 'warning';
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 第4项：板厚检查
 */
function checkBoardThickness(): CheckResult {
	const result: CheckResult = {
		number: 4,
		item: '板厚',
		actualValue: `${selectedThickness}mm`,
		standardValue: '0.4-6.0mm',
		result: 'success',
	};

	try {
		// 使用默认值的板厚
		const thickness = selectedThickness;

		// 根据板材检查板厚范围
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];
		if (standard) {
			let outOfRange = false;
			let desc: string;
			if (standard.thicknessValues && standard.thicknessValues.length > 0) {
				// 离散板厚(高频/铝/铜):必须匹配其中之一(允许 0.001mm 误差)
				outOfRange = !standard.thicknessValues.some(v => Math.abs(v - thickness) < 0.001);
				desc = standard.thicknessDescription ?? standard.thicknessValues.map(v => `${v}mm`).join(' / ');
			}
			else {
				const { min, max } = standard.thicknessRange;
				outOfRange = thickness < min || thickness > max;
				desc = `${min}-${max}mm`;
			}
			if (outOfRange) {
				result.result = 'error';
			}
			result.standardValue = desc;
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 第5项：外层铜厚检查
 */
async function checkOuterCopperThickness(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 5,
		item: '外层铜厚',
		actualValue: '未知',
		standardValue: '0.5/1.0/1.5/2.0/3.0/4.0 oz',
		result: 'success',
		violations: [],
	};

	try {
		const requestedOz = params.outerCopperOz!;
		result.actualValue = `下单外层${requestedOz}oz`;
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];
		const layerCount = await parseCopperLayerCount();
		if (!Number.isInteger(layerCount) || layerCount < 1) {
			issues.push({ code: 'design_copper_layer_count_unavailable', item: 5, message: '设计铜层数未知，无法核验外层铜厚支持性' });
			result.result = 'warning';
			result.standardValue = '无法根据设计层数核验外层铜厚';
		}
		else if (standard) {
			const validCoppers = resolveOuterCopper(standard, layerCount);
			if (!validCoppers.includes(requestedOz)) result.result = 'error';
			result.standardValue = `允许外层铜厚：${validCoppers.map(c => `${c}oz`).join('，')}`;
		}
		else {
			result.result = 'error';
			result.standardValue = '未找到板材铜厚标准';
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 通过检查每层实际是否有铜元素来获取铜层数量
 * 铜元素包括：走线(Line)、焊盘(Pad)、覆铜(Region)、多段线(Polyline)等
 */
async function parseCopperLayerCount(): Promise<number> {
	try {
		// 直接读取板子设计的铜箔层数（含内层），比遍历图元推断更准确
		const count = await eda.pcb_Layer.getTheNumberOfCopperLayers();
		return count > 0 ? count : 0;
	}
	catch (e) {
		eda.sys_Log.add(`获取铜箔层数失败: ${e}`, ESYS_LogType.WARNING);
		return 0;
	}
}

/** 判定图层 ID 是否为铜层：顶层(1)/底层(2)/内层1~30(15~44) */
function isCopperLayerId(layerId: number): boolean {
	return layerId === 1 || layerId === 2 || (layerId >= 15 && layerId <= 44);
}

/**
 * 统计实际有走线/覆铜的铜层数（用于第2项“层数”判定）。
 *
 * 与 parseCopperLayerCount（设计层叠层数）不同：EDA 最小为双面板，
 * 即便设计为 2 层，若某外层（如铝基板的 TOP）既无走线也无覆铜，
 * 实际有铜层会更少。铝基板只支持 1 层，故按实际有铜层计才能正确判定。
 *
 * 统计铜图元：走线(Line)、折线(Polyline)、覆铜(Pour)、填充(Fill)。
 * 不含焊盘/过孔（其层归属为多层/连接，不构成“该层有走线覆铜”）。
 */
async function parseActualCopperLayerCount(): Promise<number> {
	try {
		const lines = await eda.pcb_PrimitiveLine.getAll();
		const polylines = await eda.pcb_PrimitivePolyline.getAll();
		const pours = await eda.pcb_PrimitivePour.getAll();
		const fills = await eda.pcb_PrimitiveFill.getAll();
		const used = new Set<number>();
		for (const el of [...lines, ...polylines, ...pours, ...fills]) {
			const lid = (el as any)?.getState_Layer?.() ?? (el as any)?.layer ?? (el as any)?.layerId;
			if (typeof lid === 'number' && isCopperLayerId(lid)) {
				used.add(lid);
			}
		}
		return used.size;
	}
	catch (e) {
		eda.sys_Log.add(`parseActualCopperLayerCount failed: ${e}`, ESYS_LogType.WARNING);
		return 0;
	}
}

/**
 * 解析“有效铜层数”：实际有走线/覆铜的层数；若不少于设计层叠层数则取设计层叠层数。
 * 用于按单/双/多层分段的检查项(第2/8/9项)：EDA 最小为双面板，但某外层无铜
 * (如 BOT-only 单面板)时应按实际有铜层判定。
 */
async function parseEffectiveCopperLayerCount(): Promise<number> {
	const designCount = await parseCopperLayerCount();
	const actualCount = await parseActualCopperLayerCount();
	return actualCount > 0 && actualCount < designCount ? actualCount : designCount;
}

/**
 * 第6项：内层铜厚检查
 */
async function checkInnerCopperThickness(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 6,
		item: '内层铜厚',
		actualValue: '无内层',
		standardValue: '无内层',
		result: 'success',
	};

	try {
		const layerCount = await parseCopperLayerCount();
		if (!Number.isInteger(layerCount) || layerCount < 1) {
			issues.push({ code: 'design_copper_layer_count_unavailable', item: 6, message: '设计铜层数未知，无法判断内层铜厚是否适用' });
			result.actualValue = '无法判断内层是否适用';
			result.standardValue = '设计铜层数未知';
			result.result = 'warning';
		}
		else if (layerCount <= 2) {
			result.actualValue = '无内层';
			result.standardValue = '不适用';
			result.result = 'success';
		}
		else {
			const requestedOz = params.innerCopperOz!;
			result.actualValue = `下单内层${requestedOz}oz`;
			const validCoppers = JLC_MATERIAL_STANDARDS[selectedMaterial]?.innerCopperThickness ?? [];
			if (!validCoppers.includes(requestedOz)) result.result = 'error';
			result.standardValue = validCoppers.length ? `允许内层铜厚：${validCoppers.map(c => `${c}oz`).join('，')}` : '该板材未提供内层铜厚标准';
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 解析文档源中的盲埋孔设计规则（每项含 name/staLayerId/endLayerId）。
 * name 对应 via.designRuleBlindViaName；via 上该字段为 null/empty 即通孔。
 */
async function parseBlindViaRules(): Promise<Map<string, { staLayerId: number; endLayerId: number }>> {
	const map = new Map<string, { staLayerId: number; endLayerId: number }>();
	try {
		const docSource = await eda.sys_FileManager.getDocumentSource();
		if (!docSource) {
			return map;
		}
		for (const line of docSource.split(String.fromCharCode(10))) {
			if (!line.includes('BLIND') || !line.includes('blindVia')) {
				continue;
			}
			const sep = line.indexOf('||');
			if (sep === -1) {
				continue;
			}
			let right = line.slice(sep + 2);
			if (right.endsWith('|')) {
				right = right.slice(0, -1);
			}
			let obj: any;
			try {
				obj = JSON.parse(right);
			}
			catch {
				continue;
			}
			const content = obj?.ruleContext?.blinds?.content;
			if (!Array.isArray(content)) {
				continue;
			}
			for (const item of content) {
				const name = item?.name;
				if (typeof name === 'string' && name !== '') {
					map.set(name, { staLayerId: Number(item.staLayerId), endLayerId: Number(item.endLayerId) });
				}
			}
		}
	}
	catch (e) {
		eda.sys_Log.add(`parseBlindViaRules failed: ${e}`, ESYS_LogType.WARNING);
	}
	return map;
}

/**
 * 按层范围判定盲/埋孔。表层 = TOP(1)/BOTTOM(2)。
 * 盲孔 = 起止层恰有一个为表层；埋孔 = 起止层都非表层。
 */
function classifyBlindBuried(staLayerId: number, endLayerId: number): 'blind' | 'buried' {
	const isSurface = (id: number) => id === 1 || id === 2;
	const surfaceCount = (isSurface(staLayerId) ? 1 : 0) + (isSurface(endLayerId) ? 1 : 0);
	if (surfaceCount === 0) {
		return 'buried';
	}
	return 'blind';
}

/** 读取图元 primitive id(兼容 getState_PrimitiveId / getPrimitiveId / primitiveId / id 多种取法) */
function readPrimitiveId(p: any): string {
	return String(p?.getState_PrimitiveId?.() ?? p?.getPrimitiveId?.() ?? p?.primitiveId ?? p?.id ?? '');
}

/**
 * 建立 primitiveId → 定位 id 映射:按 getAll() 与 getAllPrimitiveId() 的同序下标对齐。
 * data-log-find-id 期望 getAllPrimitiveId 的值(与 getState_PrimitiveId 可能不同,见第9项注释)。
 */
function buildPrimitiveLocateMap(primitives: any[], locateIds: string[]): Map<string, string> {
	const m = new Map<string, string>();
	const n = Math.min(primitives.length, locateIds.length);
	for (let i = 0; i < n; i++) {
		const primId = readPrimitiveId(primitives[i]);
		if (primId && locateIds[i])
			m.set(primId, String(locateIds[i]));
	}
	return m;
}

/**
 * 第7项：过孔类型检查
 */
async function checkViaType(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 7,
		item: '过孔类型',
		actualValue: '未知',
		standardValue: '通孔/盲埋孔',
		result: 'success',
		violations: [],
	};

	try {
		const vias = await eda.pcb_PrimitiveVia.getAll();
		const viaLocateMap = buildPrimitiveLocateMap(vias, await eda.pcb_PrimitiveVia.getAllPrimitiveId());
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];
		const ruleMap = await parseBlindViaRules();

		let through = 0;
		let blind = 0;
		let buried = 0;
		let unknown = 0;
		const supportsBlind = standard ? standard.viaTypes.includes('blind') : true;
		const violations: { x: number; y: number; id: string; reason: string; type: string; locateType?: string }[] = [];

		for (const via of vias) {
			const ruleName = via.designRuleBlindViaName ?? via.state?.designRuleBlindViaName ?? null;
			if (!ruleName) {
				through++;
				continue;
			}
			const rule = ruleMap.get(ruleName);
			if (!rule) {
				unknown++;
				continue;
			}
			const kind = classifyBlindBuried(rule.staLayerId, rule.endLayerId);
			if (kind === 'blind') {
				blind++;
			}
			else {
				buried++;
			}
			if (!supportsBlind) {
				violations.push({
					x: via.x ?? via.state?.x ?? 0,
					y: via.y ?? via.state?.y ?? 0,
					id: viaLocateMap.get(readPrimitiveId(via)) || via.primitiveId || via.id || '',
					reason: `${kind === 'blind' ? '盲孔' : '埋孔'}(${ruleName}) 当前板材不支持`,
					type: 'via',
				});
			}
		}

		const parts: string[] = [];
		if (through > 0) {
			parts.push(`通孔 ${through}`);
		}
		if (blind > 0) {
			parts.push(`盲孔 ${blind}`);
		}
		if (buried > 0) {
			parts.push(`埋孔 ${buried}`);
		}
		if (unknown > 0) {
			parts.push(`盲埋孔 ${unknown}(未识别层)`);
		}
		result.actualValue = parts.length > 0 ? parts.join(' + ') : '无过孔';

		if ((blind > 0 || buried > 0) && !supportsBlind) {
			result.result = 'error';
			result.actualValue += ` (当前板材不支持盲埋孔)`;
			result.violations = violations;
		}

		if (standard) {
			result.standardValue = supportsBlind ? '通孔/盲埋孔' : '仅通孔';
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}
/**
 * 第8项：钻孔直径检查（包含过孔和焊盘）
 * 单面板：0.3~6.3mm
 * 双面板：0.15~6.3mm
 * 多层板：0.15~6.3mm
 * 2-12层板支持0.1mm微孔工艺（板厚≤1mm，限沉金）
 */
async function checkHoleDiameter(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 8,
		item: '钻孔直径',
		actualValue: '未知',
		standardValue: '0.15-6.3mm (取决于层数)',
		result: 'success',
		violations: [],
	};

	try {
		// 有效铜层数：BOT-only 板按单面板(0.3mm)，双面/多层按 0.15mm
		const copperLayerCount = await parseEffectiveCopperLayerCount();
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];

		if (!standard) {
			result.actualValue = '未找到板材标准';
			result.result = 'warning';
			return result;
		}

		// 按板材+有效铜层数取通孔孔径标准(铝基板0.65 / 铜基板0.3 / FR4 单面0.3·双面多层0.15 / HDI·高频0.15)
		const viaSpec = resolveViaSpec(standard, copperLayerCount);
		let minDiameter = viaSpec?.throughHole?.min ?? 0.15;
		let maxDiameter = viaSpec?.throughHole?.max ?? 6.3;
		let supportsMicroHole = false; // 是否支持0.1mm微孔

		// FR4 2-12层板支持0.1mm微孔工艺（板厚≤1mm，限沉金）
		if (selectedMaterial === 'FR4' && copperLayerCount >= 2 && copperLayerCount <= 12 && selectedThickness <= 1.0) {
			supportsMicroHole = true;
			minDiameter = 0.1;
		}

		// HDI 按盲/埋/通孔分别判定孔径(内径):盲孔0.075-0.15/埋孔0.15-0.55/通孔≥0.15
		const isHdi = selectedMaterial === 'HDI板';
		const hdiRuleMap = isHdi ? await parseBlindViaRules() : null;
		const hdiRangeOf = (kind: 'blind' | 'buried' | 'through'): { min: number; max: number } =>
			kind === 'blind' ? { min: 0.075, max: 0.15 } : kind === 'buried' ? { min: 0.15, max: 0.55 } : { min: 0.15, max: 6.3 };
		const hdiViaKind = (v: any): 'blind' | 'buried' | 'through' => {
			if (!hdiRuleMap)
				return 'through';
			const name = v.designRuleBlindViaName ?? v.state?.designRuleBlindViaName ?? '';
			if (!name)
				return 'through';
			const rule = hdiRuleMap.get(name);
			if (!rule)
				return 'through';
			return classifyBlindBuried(rule.staLayerId, rule.endLayerId);
		};

		const violations: { x: number; y: number; id: string; reason: string; type: string; locateType?: string }[] = [];
		const allHoles: { diameter: number; x: number; y: number; id: string; type: string; minD: number; maxD: number }[] = [];

		// 1. 检查过孔
		const vias = await eda.pcb_PrimitiveVia.getAll();
		const viaLocateMap = buildPrimitiveLocateMap(vias, await eda.pcb_PrimitiveVia.getAllPrimitiveId());
		for (const via of vias) {
			const v: any = via;
			// holeDiameter 为 private，优先用 getState_HoleDiameter()，兼容直接属性
			const holeDiameterMil = v.getState_HoleDiameter?.() ?? v.holeDiameter ?? v.state?.holeDiameter ?? 0;
			if (holeDiameterMil <= 0)
				continue;
			const holeDiameterMm = eda.sys_Unit.milToMm(holeDiameterMil);
			const vKind = isHdi ? hdiViaKind(v) : 'through';
			const vRange = isHdi ? hdiRangeOf(vKind) : { min: minDiameter, max: maxDiameter };
			allHoles.push({
				diameter: holeDiameterMm,
				x: v.getState_X?.() ?? v.x ?? 0,
				y: v.getState_Y?.() ?? v.y ?? 0,
				id: viaLocateMap.get(readPrimitiveId(v)) || v.getState_PrimitiveId?.() || v.primitiveId || '',
				type: isHdi ? (vKind === 'blind' ? '盲孔' : vKind === 'buried' ? '埋孔' : '过孔') : '过孔',
				minD: vRange.min,
				maxD: vRange.max,
			});
		}

		// 2. 检查焊盘的孔（插件焊盘有孔）
		const pads = await eda.pcb_PrimitivePad.getAll();
		const padLocateMap = buildPrimitiveLocateMap(pads, await eda.pcb_PrimitivePad.getAllPrimitiveId());
		for (const pad of pads) {
			const p: any = pad;
			// hole 是元组：["ROUND", diameter] 圆孔，或 ["SLOT", diameter, length] 槽孔
			// 兼容类实例（getState_Hole）与普通对象（.hole / .state.hole）
			const hole: any = p.getState_Hole?.() ?? p.hole ?? p.state?.hole ?? null;
			if (!hole || !Array.isArray(hole) || hole.length < 2)
				continue;

			const holeType = hole[0];
			const holeSizeMil = Number(hole[1]) || 0;
			if (holeSizeMil <= 0)
				continue;

			// hole 元组: ["ROUND",直径]圆孔 / ["SLOT",直径,长度]槽孔; 第8项仅统计圆孔(槽孔由第10/11项检查)
			if (holeType === 'ROUND') {
				const holeDiameterMm = eda.sys_Unit.milToMm(holeSizeMil);
				allHoles.push({
					diameter: holeDiameterMm,
					x: p.getState_X?.() ?? p.x ?? 0,
					y: p.getState_Y?.() ?? p.y ?? 0,
					id: padLocateMap.get(readPrimitiveId(p)) || p.getState_PrimitiveId?.() || p.primitiveId || '',
					type: '焊盘孔',
					minD: minDiameter,
					maxD: maxDiameter,
				});
			}
		}

		// 检查所有孔是否在标准范围内
		for (const hole of allHoles) {
			if (hole.diameter < hole.minD) {
				violations.push({
					x: hole.x,
					y: hole.y,
					id: hole.id,
					reason: `${hole.type}直径 ${hole.diameter.toFixed(3)}mm 小于最小值 ${hole.minD}mm`,
					type: hole.type,
				});
			}
			if (hole.diameter > hole.maxD) {
				violations.push({
					x: hole.x,
					y: hole.y,
					id: hole.id,
					reason: `${hole.type}直径 ${hole.diameter.toFixed(3)}mm 大于最大值 ${hole.maxD}mm`,
					type: hole.type,
				});
			}
		}

		// 统计实际值
		if (allHoles.length > 0) {
			const diameters = allHoles.map(h => h.diameter);
			const min = Math.min(...diameters);
			const max = Math.max(...diameters);
			result.actualValue = `${min.toFixed(3)}-${max.toFixed(3)}mm`;
		}
		else {
			result.actualValue = '无孔';
		}

		if (violations.length > 0) {
			result.result = 'error';
			result.violations = violations;
		}

		// 构建标准值描述
		let standardDesc: string;
		if (isHdi) {
			standardDesc = '盲孔0.075-0.15 / 埋孔0.15-0.55 / 通孔≥0.15mm';
		}
		else if (selectedMaterial === '铜基板') {
			// 常规单侧型按层数(检查取有效铜层数对应档),特殊夹心型需人工判定
			standardDesc = '常规单侧型：1层板≥1mm / 2层板≥0.3mm；特殊夹心型：有铜孔0.3-2.0mm、无铜孔≥1mm';
		}
		else if (standard.drillNote) {
			// 高频板等:≥min,带补充说明
			standardDesc = `≥${minDiameter}mm (${standard.drillNote})`;
		}
		else {
			standardDesc = `${minDiameter}-${maxDiameter}mm`;
			if (supportsMicroHole) {
				standardDesc += ' (支持0.1mm微孔，板厚≤1mm)';
			}
			else if (copperLayerCount === 1) {
				standardDesc += ' (单面板)';
			}
			else if (copperLayerCount === 2) {
				standardDesc += ' (双面板)';
			}
			else {
				standardDesc += ` (${copperLayerCount}层板)`;
			}
		}
		result.standardValue = standardDesc;
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 第9项：过孔/焊盘外径检查
 */
async function checkViaPadDiameter(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 9,
		item: '过孔/焊盘外径',
		actualValue: '未知',
		standardValue: '最小0.4mm (取决于板材)',
		result: 'success',
		violations: [],
	};

	try {
		const vias = await eda.pcb_PrimitiveVia.getAll();
		const pads = await eda.pcb_PrimitivePad.getAll();
		// data-log-find-id 期望的图元定位 id(getAllPrimitiveId,与 getState_PrimitiveId 可能不同)
		const viaLocateIds = await eda.pcb_PrimitiveVia.getAllPrimitiveId();
		const padLocateIds = await eda.pcb_PrimitivePad.getAllPrimitiveId();
		const violations: { x: number; y: number; id: string; reason: string; type: string; locateType?: string }[] = [];
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];

		if (!standard) {
			result.actualValue = '未找到板材标准';
			result.result = 'warning';
			return result;
		}

		// 过孔/焊盘外径按有效铜层数分段(FR4 单/双/多层;BOT-only 板按单面板 0.5mm)
		const layerCount = await parseEffectiveCopperLayerCount();
		const viaSpec = resolveViaSpec(standard, layerCount);
		const minDiameter = viaSpec?.minPadOuter ?? 0;
		// HDI 过孔外径=内径+偏移(盲埋孔+0.15/通孔+0.1);其它板材用统一最小外径 minDiameter
		const isHdi = selectedMaterial === 'HDI板';
		const hdiRuleMap = isHdi ? await parseBlindViaRules() : null;
		const hdiViaKind9 = (vv: any): 'blind' | 'buried' | 'through' => {
			if (!hdiRuleMap)
				return 'through';
			const name = vv.designRuleBlindViaName ?? vv.state?.designRuleBlindViaName ?? '';
			if (!name)
				return 'through';
			const rule = hdiRuleMap.get(name);
			if (!rule)
				return 'through';
			return classifyBlindBuried(rule.staLayerId, rule.endLayerId);
		};
		const allDiameters: number[] = [];

		// 从焊盘形状元组中解析外径（宽高的较大值）
		// pad 元组：["ELLIPSE"|"OVAL"|"NGON", width, height] / ["RECT", width, height, rotation] / ["POLYGON", data]
		const getPadOuterMm = (p: any): number => {
			const shape: any = p.getState_Pad?.() ?? p.pad ?? p.state?.pad ?? null;
			if (!Array.isArray(shape) || shape.length < 3)
				return 0;
			const w = Number(shape[1]) || 0;
			const h = Number(shape[2]) || 0;
			if (w <= 0 || h <= 0)
				return 0;
			return eda.sys_Unit.milToMm(Math.max(w, h));
		};

		// 1. 检查过孔外径
		for (const [i, via] of vias.entries()) {
			const v: any = via;
			// 定位 id 用 getAllPrimitiveId()(data-log-find-id 期望的图元 id)
			const locateId = viaLocateIds[i] ?? v.getState_PrimitiveId?.() ?? '';
			// diameter 为 private，优先用 getState_Diameter()
			const diameterMil = v.getState_Diameter?.() ?? v.diameter ?? v.state?.diameter ?? 0;
			const diameterMm = eda.sys_Unit.milToMm(diameterMil);
			if (diameterMm > 0)
				allDiameters.push(diameterMm);

			if (isHdi) {
				// HDI: 外径需 ≥ 内径+偏移(盲埋孔+0.15/通孔+0.1)
				const innerMil = v.getState_HoleDiameter?.() ?? v.holeDiameter ?? v.state?.holeDiameter ?? 0;
				const innerMm = eda.sys_Unit.milToMm(innerMil);
				const kind = hdiViaKind9(v);
				const offset = kind === 'through' ? 0.1 : 0.15;
				const minOuter = innerMm + offset;
				if (diameterMm > 0 && diameterMm < minOuter) {
					violations.push({
						x: v.getState_X?.() ?? v.x ?? 0,
						y: v.getState_Y?.() ?? v.y ?? 0,
						id: locateId,
						reason: `${kind === 'blind' ? '盲孔' : kind === 'buried' ? '埋孔' : '通孔'}外径 ${diameterMm.toFixed(3)}mm 小于最小值 内径+${offset}=${minOuter.toFixed(3)}mm`,
						type: 'via',
						locateType: String(v.getState_PrimitiveType?.() ?? 'Via'),
					});
				}
			}
			else if (diameterMm < minDiameter && diameterMm > 0) {
				violations.push({
					x: v.getState_X?.() ?? v.x ?? 0,
					y: v.getState_Y?.() ?? v.y ?? 0,
					id: locateId,
					reason: `过孔外径 ${diameterMm.toFixed(3)}mm 小于最小值 ${minDiameter}mm`,
					type: 'via',
					locateType: String(v.getState_PrimitiveType?.() ?? 'Via'),
				});
			}
		}

		// 2. 检查焊盘外径(排除 BGA 焊盘——BGA 焊盘归第17项检查,标准 0.2mm 而非本项 0.4mm)
		const bgaPadIdArr = (await collectBgaPadIds()).ids;
		for (const [i, pad] of pads.entries()) {
			const p: any = pad;
			const pid = String(p.getState_PrimitiveId?.() ?? p.primitiveId ?? '');
			// 跳过 BGA 焊盘:pad 长 id 以 BGA 元件的短 id 结尾即归属
			if (bgaPadIdArr.some(short => short && pid.endsWith(short)))
				continue;
			// 定位 id 用 getAllPrimitiveId()(data-log-find-id 期望的图元 id)
			const locateId = padLocateIds[i] ?? pid;
			const padDiameterMm = getPadOuterMm(p);
			if (padDiameterMm > 0)
				allDiameters.push(padDiameterMm);

			if (padDiameterMm < minDiameter && padDiameterMm > 0) {
				violations.push({
					x: p.getState_X?.() ?? p.x ?? 0,
					y: p.getState_Y?.() ?? p.y ?? 0,
					id: locateId,
					reason: `焊盘外径 ${padDiameterMm.toFixed(3)}mm 小于最小值 ${minDiameter}mm`,
					type: 'pad',
					locateType: String(p.getState_PrimitiveType?.() ?? 'ComponentPad'),
				});
			}
		}

		// 统计实际值（包含过孔和焊盘的最小外径）
		if (allDiameters.length > 0) {
			const min = Math.min(...allDiameters);
			result.actualValue = `最小${min.toFixed(3)}mm`;
		}
		else {
			result.actualValue = '无过孔/焊盘';
		}

		if (violations.length > 0) {
			result.result = 'error';
			result.violations = violations;
		}

		result.standardValue = isHdi
			? '盲埋孔=内径+0.15 / 通孔=内径+0.1mm'
			: `最小${minDiameter}mm`;
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}
/**
 * 第10项：有铜槽孔检查
 */
async function checkSlotWithCopper(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 10,
		item: '有铜槽孔',
		actualValue: '无槽孔',
		standardValue: '最小槽宽0.6mm, 槽长1.0mm',
		result: 'success',
		violations: [],
	};

	try {
		const pads = await eda.pcb_PrimitivePad.getAll();
		const violations: { x: number; y: number; id: string; reason: string; type: string; locateType?: string }[] = [];
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];

		if (!standard) {
			result.actualValue = '未找到板材标准';
			result.result = 'warning';
			return result;
		}

		const padLocateMap = buildPrimitiveLocateMap(pads, await eda.pcb_PrimitivePad.getAllPrimitiveId());
		// 有铜槽按双面/多层分段(FR4)
		const layerCount = await parseCopperLayerCount();
		const slotMin = resolveSlotWithCopper(standard, layerCount);
		const minSlotWidth = slotMin?.width ?? 0;
		const minSlotLength = slotMin?.length ?? 0;

		// 有铜槽孔：槽孔(SLOT)且金属化孔壁(metallization=true)
		// hole 元组：["SLOT", diameter, length]
		//   - hole[1] = diameter = 槽宽（半圆直径，短边）
		//   - hole[2] = length = 槽长总长（含两端半圆，长边）
		let slotCount = 0;
		const slotSizes: string[] = [];
		for (const pad of pads) {
			const p: any = pad;
			const hole: any = p.getState_Hole?.() ?? null;
			const metallization = p.getState_Metallization?.() ?? true;
			if (!hole || !Array.isArray(hole) || hole[0] !== 'SLOT' || !metallization)
				continue;

			const slotWidthMm = eda.sys_Unit.milToMm(Number(hole[1]) || 0); // 槽宽 = 半圆直径
			const slotLengthMm = eda.sys_Unit.milToMm(Number(hole[2]) || 0); // 槽长 = 总长（含半圆）
			slotCount++;
			slotSizes.push(`槽宽${slotWidthMm.toFixed(3)}/槽长${slotLengthMm.toFixed(3)}mm`);

			const px = p.getState_X?.() ?? p.x ?? 0;
			const py = p.getState_Y?.() ?? p.y ?? 0;
			const pid = p.getState_PrimitiveId?.() ?? p.primitiveId ?? '';

			if (slotWidthMm < minSlotWidth) {
				violations.push({
					x: px,
					y: py,
					id: padLocateMap.get(pid) || pid,
					reason: `槽宽 ${slotWidthMm.toFixed(3)}mm 小于最小值 ${minSlotWidth}mm`,
					type: 'pad',
				});
			}
			if (slotLengthMm < minSlotLength) {
				violations.push({
					x: px,
					y: py,
					id: padLocateMap.get(pid) || pid,
					reason: `槽长 ${slotLengthMm.toFixed(3)}mm 小于最小值 ${minSlotLength}mm`,
					type: 'pad',
				});
			}
		}

		if (slotCount > 0)
			result.actualValue = `${slotCount}个(${slotSizes.join(', ')})`;

		if (violations.length > 0) {
			result.result = 'error';
			result.violations = violations;
		}

		result.standardValue = `最小槽宽${minSlotWidth}mm, 槽长${minSlotLength}mm`;
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}
/**
 * 第11项：无铜槽孔检查
 */
async function checkSlotWithoutCopper(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 11,
		item: '无铜槽孔',
		actualValue: '无槽孔',
		standardValue: '最小槽宽0.6mm',
		result: 'success',
		violations: [],
	};

	try {
		const pads = await eda.pcb_PrimitivePad.getAll();
		const violations: { x: number; y: number; id: string; reason: string; type: string; locateType?: string }[] = [];
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];

		if (!standard) {
			result.actualValue = '未找到板材标准';
			result.result = 'warning';
			return result;
		}

		const minSlotWidth = standard.slotWithoutCopperMinWidth;
		const padLocateMap = buildPrimitiveLocateMap(pads, await eda.pcb_PrimitivePad.getAllPrimitiveId());

		// 无铜槽孔：槽孔(SLOT)且非金属化孔壁(metallization=false)
		// hole 元组：["SLOT", diameter, length]
		//   - hole[1] = diameter = 槽宽（半圆直径，短边）
		//   - hole[2] = length = 槽长总长（含两端半圆，长边）
		let slotCount = 0;
		const slotSizes: string[] = [];
		for (const pad of pads) {
			const p: any = pad;
			const hole: any = p.getState_Hole?.() ?? null;
			const metallization = p.getState_Metallization?.() ?? true;
			if (!hole || !Array.isArray(hole) || hole[0] !== 'SLOT' || metallization)
				continue;

			const slotWidthMm = eda.sys_Unit.milToMm(Number(hole[1]) || 0); // 槽宽 = 半圆直径
			const slotLengthMm = eda.sys_Unit.milToMm(Number(hole[2]) || 0); // 槽长 = 总长（含半圆）
			slotCount++;
			slotSizes.push(`槽宽${slotWidthMm.toFixed(3)}/槽长${slotLengthMm.toFixed(3)}mm`);

			if (slotWidthMm < minSlotWidth) {
				violations.push({
					x: p.getState_X?.() ?? p.x ?? 0,
					y: p.getState_Y?.() ?? p.y ?? 0,
					id: padLocateMap.get(readPrimitiveId(p)) || p.getState_PrimitiveId?.() || p.primitiveId || '',
					reason: `槽宽 ${slotWidthMm.toFixed(3)}mm 小于最小值 ${minSlotWidth}mm`,
					type: 'pad',
				});
			}
		}

		if (slotCount > 0)
			result.actualValue = `${slotCount}个(${slotSizes.join(', ')})`;

		if (violations.length > 0) {
			result.result = 'error';
			result.violations = violations;
		}

		result.standardValue = `最小槽宽${minSlotWidth}mm`;
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}
/**
 * 第12项：最小线宽检查
 */
async function checkMinTraceWidth(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 12,
		item: '最小线宽',
		actualValue: '未知',
		standardValue: '最小0.15mm (取决于板材和铜厚)',
		result: 'success',
		violations: [],
	};

	try {
		// 获取所有直线（走线）- 立创EDA中走线使用 pcb_PrimitiveLine 表示
		const allLines = await eda.pcb_PrimitiveLine.getAll();
		const violations: { x: number; y: number; id: string; reason: string; type: string; locateType?: string }[] = [];
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];

		// 添加调试日志

		if (!standard) {
			result.actualValue = '未找到板材标准';
			result.result = 'warning';
			return result;
		}

		const layerContext = await readDesignCopperLayers(12);
		if (!layerContext || layerContext.designCount === null) {
			result.actualValue = '无法核验走线铜层与设计层数';
			result.result = 'warning';
			return result;
		}
		const lineLocateMap = buildPrimitiveLocateMap(allLines, await eda.pcb_PrimitiveLine.getAllPrimitiveId());
		const lines = selectCopperLines(allLines, 12, layerContext);

		// 检查所有 Line（走线）
		for (const line of lines) {
			const layerId = Number((line as any).getState_Layer?.() ?? (line as any).layer ?? (line as any).layerId);
			const minWidth = copperThreshold(standard, layerId, layerContext.designCount).width;
			// 使用 getState_LineWidth() 获取线宽
			const widthMil = (line as any).getState_LineWidth?.() ?? (line as any).lineWidth ?? (line as any).width ?? 0;
			const widthMm = eda.sys_Unit.milToMm(widthMil);

			if (widthMm > 0) {
			}

			if (widthMm < minWidth && widthMm > 0) {
				// 获取 Line 的起点坐标
				const x = (line as any).getState_StartX?.() ?? (line as any).startX ?? (line as any).x1 ?? 0;
				const y = (line as any).getState_StartY?.() ?? (line as any).startY ?? (line as any).y1 ?? 0;
				violations.push({
					x,
					y,
					id: lineLocateMap.get(readPrimitiveId(line)) || (line as any).getPrimitiveId?.() || (line as any).primitiveId || '',
					reason: `线宽 ${widthMm.toFixed(3)}mm 小于最小值 ${minWidth}mm`,
					type: 'line',
				});
			}
		}

		// 收集所有宽度值
		const allWidths: number[] = [];
		for (const l of lines) {
			const w = (l as any).getState_LineWidth?.() ?? (l as any).lineWidth ?? (l as any).width ?? 0;
			if (w > 0)
				allWidths.push(eda.sys_Unit.milToMm(w));
		}

		if (allWidths.length > 0) {
			const min = Math.min(...allWidths);
			result.actualValue = `最小${min.toFixed(3)}mm`;
		}
		else {
			result.actualValue = '无线段';
		}

		if (violations.length > 0) {
			result.result = 'error';
			result.violations = violations;
		}

		result.standardValue = traceThresholdSummary(standard, layerContext.designCount);
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}
/**
 * 第13项：最小线距检查
 */
async function checkMinTraceSpacing(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 13,
		item: '最小线距',
		actualValue: '符合要求',
		standardValue: '最小0.15mm',
		result: 'success',
		violations: [],
	};

	try {
		const allLines = await eda.pcb_PrimitiveLine.getAll();
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];

		// 添加调试日志

		if (!standard) {
			result.actualValue = '未找到板材标准';
			result.result = 'warning';
			return result;
		}

		const layerContext = await readDesignCopperLayers(13);
		if (!layerContext || layerContext.designCount === null) {
			result.actualValue = '无法核验走线铜层与设计层数';
			result.result = 'warning';
			return result;
		}
		const lineLocateMap = buildPrimitiveLocateMap(allLines, await eda.pcb_PrimitiveLine.getAllPrimitiveId());
		const lines = selectCopperLines(allLines, 13, layerContext);
		result.standardValue = traceThresholdSummary(standard, layerContext.designCount);

		const violations: { x: number; y: number; id: string; reason: string; type: string; locateType?: string }[] = [];

		// 检查所有走线对之间的距离
		// 注意：间距是从走线边缘到边缘的距离，需要考虑线宽
		for (let i = 0; i < lines.length; i++) {
			const line1 = lines[i];
			const width1Mil = (line1 as any).getState_LineWidth?.() ?? (line1 as any).lineWidth ?? (line1 as any).width ?? 0;
			const layer1 = (line1 as any).getState_Layer?.() ?? (line1 as any).layer ?? (line1 as any).layerId ?? 0;

			// 只检查同层的走线
			for (let j = i + 1; j < lines.length; j++) {
				const line2 = lines[j];
				const width2Mil = (line2 as any).getState_LineWidth?.() ?? (line2 as any).lineWidth ?? (line2 as any).width ?? 0;
				const layer2 = (line2 as any).getState_Layer?.() ?? (line2 as any).layer ?? (line2 as any).layerId ?? 0;

				// 跨层走线不需要检查间距
				if (layer1 !== layer2) {
					continue;
				}
				const minSpacing = copperThreshold(standard, Number(layer1), layerContext.designCount).spacing;
				const minSpacingMil = eda.sys_Unit.mmToMil(minSpacing);
				// 同网络走线不判间距(同网络可相连/贴近)
				const net1 = (line1 as any).getState_Net?.() ?? '';
				const net2 = (line2 as any).getState_Net?.() ?? '';
				if (net1 && net2 && net1 === net2) {
					continue;
				}

				// 获取线段坐标
				const seg1 = {
					x1: (line1 as any).getState_StartX?.() ?? (line1 as any).startX ?? (line1 as any).x1 ?? 0,
					y1: (line1 as any).getState_StartY?.() ?? (line1 as any).startY ?? (line1 as any).y1 ?? 0,
					x2: (line1 as any).getState_EndX?.() ?? (line1 as any).endX ?? (line1 as any).x2 ?? 0,
					y2: (line1 as any).getState_EndY?.() ?? (line1 as any).endY ?? (line1 as any).y2 ?? 0,
				};
				const seg2 = {
					x1: (line2 as any).getState_StartX?.() ?? (line2 as any).startX ?? (line2 as any).x1 ?? 0,
					y1: (line2 as any).getState_StartY?.() ?? (line2 as any).startY ?? (line2 as any).y1 ?? 0,
					x2: (line2 as any).getState_EndX?.() ?? (line2 as any).endX ?? (line2 as any).x2 ?? 0,
					y2: (line2 as any).getState_EndY?.() ?? (line2 as any).endY ?? (line2 as any).y2 ?? 0,
				};

				// 计算中心线距离
				const centerDistMil = calculateLineSegmentDistance(seg1, seg2);

				// 边缘间距 = 中心线距离 - (线宽1 + 线宽2) / 2
				const edgeSpacingMil = centerDistMil - (width1Mil + width2Mil) / 2;
				const edgeSpacingMm = Math.max(0, eda.sys_Unit.milToMm(edgeSpacingMil));

				if (edgeSpacingMil > 0 && edgeSpacingMil < minSpacingMil) {
					// 找到违规位置（取两条线段的中点）
					const midX = (seg1.x1 + seg1.x2 + seg2.x1 + seg2.x2) / 4;
					const midY = (seg1.y1 + seg1.y2 + seg2.y1 + seg2.y2) / 4;

					violations.push({
						x: midX,
						y: midY,
						id: lineLocateMap.get(readPrimitiveId(line1)) || (line1 as any).getPrimitiveId?.() || (line1 as any).primitiveId || '',
						reason: `线对线距 ${edgeSpacingMm.toFixed(3)}mm 小于最小值 ${minSpacing}mm`,
						type: 'spacing',
					});
				}
			}
		}

		// 计算实际最小线距
		let minActualSpacing = Infinity;
		for (let i = 0; i < lines.length; i++) {
			const line1 = lines[i];
			const width1Mil = (line1 as any).getState_LineWidth?.() ?? (line1 as any).lineWidth ?? (line1 as any).width ?? 0;
			const layer1 = (line1 as any).getState_Layer?.() ?? (line1 as any).layer ?? (line1 as any).layerId ?? 0;

			for (let j = i + 1; j < lines.length; j++) {
				const line2 = lines[j];
				const width2Mil = (line2 as any).getState_LineWidth?.() ?? (line2 as any).lineWidth ?? (line2 as any).width ?? 0;
				const layer2 = (line2 as any).getState_Layer?.() ?? (line2 as any).layer ?? (line2 as any).layerId ?? 0;

				if (layer1 !== layer2)
					continue;
				const net1 = (line1 as any).getState_Net?.() ?? '';
				const net2 = (line2 as any).getState_Net?.() ?? '';
				if (net1 && net2 && net1 === net2)
					continue;

				const seg1 = {
					x1: (line1 as any).getState_StartX?.() ?? (line1 as any).startX ?? (line1 as any).x1 ?? 0,
					y1: (line1 as any).getState_StartY?.() ?? (line1 as any).startY ?? (line1 as any).y1 ?? 0,
					x2: (line1 as any).getState_EndX?.() ?? (line1 as any).endX ?? (line1 as any).x2 ?? 0,
					y2: (line1 as any).getState_EndY?.() ?? (line1 as any).endY ?? (line1 as any).y2 ?? 0,
				};
				const seg2 = {
					x1: (line2 as any).getState_StartX?.() ?? (line2 as any).startX ?? (line2 as any).x1 ?? 0,
					y1: (line2 as any).getState_StartY?.() ?? (line2 as any).startY ?? (line2 as any).y1 ?? 0,
					x2: (line2 as any).getState_EndX?.() ?? (line2 as any).endX ?? (line2 as any).x2 ?? 0,
					y2: (line2 as any).getState_EndY?.() ?? (line2 as any).endY ?? (line2 as any).y2 ?? 0,
				};

				const centerDistMil = calculateLineSegmentDistance(seg1, seg2);
				const edgeSpacingMil = centerDistMil - (width1Mil + width2Mil) / 2;

				if (edgeSpacingMil > 0 && edgeSpacingMil < minActualSpacing) {
					minActualSpacing = edgeSpacingMil;
				}
			}
		}

		const lineLineMm = minActualSpacing !== Infinity ? eda.sys_Unit.milToMm(minActualSpacing).toFixed(3) : null;
		const actualParts: string[] = [];
		if (lineLineMm)
			actualParts.push(`线对线${lineLineMm}mm`);
		result.actualValue = actualParts.length ? actualParts.join(' / ') : '符合要求';
		if (violations.length > 0) {
			result.result = 'error';
			result.violations = violations;
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

function pointInPolygon(pt: { x: number; y: number }, poly: Array<{ x: number; y: number }>): boolean {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const xi = poly[i].x; const yi = poly[i].y; const xj = poly[j].x; const yj = poly[j].y;
		if (((yi > pt.y) !== (yj > pt.y)) && (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi))
			inside = !inside;
	}
	return inside;
}

/**
 * 判断两条线段是否相交（跨立实验）
 */
function segmentsIntersect(p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, p4: { x: number; y: number }): boolean {
	function ccw(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
		return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x);
	}
	return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

/**
 * 计算两条线段之间的距离
 * 使用点线距离公式
 */
function calculateLineSegmentDistance(seg1: { x1: number; y1: number; x2: number; y2: number }, seg2: { x1: number; y1: number; x2: number; y2: number }): number {
	// Intersecting segments have zero distance (endpoint formula misses the crossing point)
	if (segmentsIntersect({ x: seg1.x1, y: seg1.y1 }, { x: seg1.x2, y: seg1.y2 }, { x: seg2.x1, y: seg2.y1 }, { x: seg2.x2, y: seg2.y2 }))
		return 0;
	// 计算线段1的两个端点到线段2的距离
	const d1 = pointToLineSegmentDistance(
		{ x: seg1.x1, y: seg1.y1 },
		seg2,
	);
	const d2 = pointToLineSegmentDistance(
		{ x: seg1.x2, y: seg1.y2 },
		seg2,
	);

	// 计算线段2的两个端点到线段1的距离
	const d3 = pointToLineSegmentDistance(
		{ x: seg2.x1, y: seg2.y1 },
		seg1,
	);
	const d4 = pointToLineSegmentDistance(
		{ x: seg2.x2, y: seg2.y2 },
		seg1,
	);

	return Math.min(d1, d2, d3, d4);
}

/**
 * 计算点到线段的距离
 */
function pointToLineSegmentDistance(point: { x: number; y: number }, line: { x1: number; y1: number; x2: number; y2: number }): number {
	const { x1, y1, x2, y2 } = line;
	const A = { x: x1, y: y1 };
	const B = { x: x2, y: y2 };

	const ABLength2 = (B.x - A.x) ** 2 + (B.y - A.y) ** 2;

	if (ABLength2 === 0) {
		return Math.sqrt((point.x - A.x) ** 2 + (point.y - A.y) ** 2);
	}

	const t = ((point.x - A.x) * (B.x - A.x) + (point.y - A.y) * (B.y - A.y)) / ABLength2;

	if (t < 0) {
		return Math.sqrt((point.x - A.x) ** 2 + (point.y - A.y) ** 2);
	}
	if (t > 1) {
		return Math.sqrt((point.x - B.x) ** 2 + (point.y - B.y) ** 2);
	}

	const closestX = A.x + t * (B.x - A.x);
	const closestY = A.y + t * (B.y - A.y);

	return Math.sqrt((point.x - closestX) ** 2 + (point.y - closestY) ** 2);
}

/**
 * 第14项：焊盘/过孔到线间距检查
 */
// ---- rectangle-exact pad-to-line clearance helpers (item 14) ----
function p2sOrient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
	return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
function p2sOnSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
	const e = 1e-9;
	return Math.min(ax, bx) - e <= cx && cx <= Math.max(ax, bx) + e && Math.min(ay, by) - e <= cy && cy <= Math.max(ay, by) + e;
}
function p2sSegsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
	const e = 1e-9;
	const d1 = p2sOrient(cx, cy, dx, dy, ax, ay);
	const d2 = p2sOrient(cx, cy, dx, dy, bx, by);
	const d3 = p2sOrient(ax, ay, bx, by, cx, cy);
	const d4 = p2sOrient(ax, ay, bx, by, dx, dy);
	if (((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e)))
		return true;
	if (Math.abs(d1) <= e && p2sOnSeg(cx, cy, dx, dy, ax, ay))
		return true;
	if (Math.abs(d2) <= e && p2sOnSeg(cx, cy, dx, dy, bx, by))
		return true;
	if (Math.abs(d3) <= e && p2sOnSeg(ax, ay, bx, by, cx, cy))
		return true;
	if (Math.abs(d4) <= e && p2sOnSeg(ax, ay, bx, by, dx, dy))
		return true;
	return false;
}
function p2sPointToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax; const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	if (len2 < 1e-18)
		return Math.hypot(px - ax, py - ay);
	let tp = ((px - ax) * dx + (py - ay) * dy) / len2;
	tp = Math.max(0, Math.min(1, tp));
	return Math.hypot(px - (ax + tp * dx), py - (ay + tp * dy));
}
function segmentToSegmentDistance(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
	if (p2sSegsIntersect(ax, ay, bx, by, cx, cy, dx, dy))
		return 0;
	return Math.min(
		p2sPointToSeg(ax, ay, cx, cy, dx, dy),
		p2sPointToSeg(bx, by, cx, cy, dx, dy),
		p2sPointToSeg(cx, cy, ax, ay, bx, by),
		p2sPointToSeg(dx, dy, ax, ay, bx, by),
	);
}
function p2sPointToBox(x: number, y: number, a: number, b: number): number {
	const dx = Math.max(Math.abs(x) - a, 0);
	const dy = Math.max(Math.abs(y) - b, 0);
	return Math.sqrt(dx * dx + dy * dy);
}
// min distance from segment (x1,y1)-(x2,y2) to axis-aligned box [-a,a]x[-b,b]
function segmentToBoxDistance(x1: number, y1: number, x2: number, y2: number, a: number, b: number): number {
	let m = Math.min(p2sPointToBox(x1, y1, a, b), p2sPointToBox(x2, y2, a, b));
	m = Math.min(m, segmentToSegmentDistance(x1, y1, x2, y2, -a, -b, a, -b));
	m = Math.min(m, segmentToSegmentDistance(x1, y1, x2, y2, -a, b, a, b));
	m = Math.min(m, segmentToSegmentDistance(x1, y1, x2, y2, -a, -b, -a, b));
	m = Math.min(m, segmentToSegmentDistance(x1, y1, x2, y2, a, -b, a, b));
	return m;
}
// clearance (mil) between a rotated rectangular pad (center padX,padY; half-extents halfW/halfH; absolute rotDeg) and a line segment, minus lineHalfWidth
function padRectToSegClearanceMil(padX: number, padY: number, halfW: number, halfH: number, rotRad: number, seg: { x1: number; y1: number; x2: number; y2: number }, lineHalfWidth: number): number {
	const th = rotRad; // radians, as returned by getState_Rotation()
	const c = Math.cos(th); const sn = Math.sin(th);
	const lx1 = (seg.x1 - padX) * c + (seg.y1 - padY) * sn;
	const ly1 = -(seg.x1 - padX) * sn + (seg.y1 - padY) * c;
	const lx2 = (seg.x2 - padX) * c + (seg.y2 - padY) * sn;
	const ly2 = -(seg.x2 - padX) * sn + (seg.y2 - padY) * c;
	return segmentToBoxDistance(lx1, ly1, lx2, ly2, halfW, halfH) - lineHalfWidth;
}

// clearance (mil) between a stadium/oval pad (capsule = points within r of the long-axis segment) and a line segment, minus lineHalfWidth.
// 非矩形长圆形焊盘(OVAL/ELLIPSE 等)用胶囊形精确求距:中心轴线段沿长轴(半长 halfLong-halfShort),半径 r=halfShort;
// 线段到胶囊边 = 线段到中心轴线段距离 - r - lineHalfWidth。halfW==halfH 时退化为圆(等价旧 max/2,但不再对长焊盘窄边过度伸出)。
function padOvalToSegClearanceMil(padX: number, padY: number, halfW: number, halfH: number, rotRad: number, seg: { x1: number; y1: number; x2: number; y2: number }, lineHalfWidth: number): number {
	const th = rotRad;
	const c = Math.cos(th); const sn = Math.sin(th);
	const lx1 = (seg.x1 - padX) * c + (seg.y1 - padY) * sn;
	const ly1 = -(seg.x1 - padX) * sn + (seg.y1 - padY) * c;
	const lx2 = (seg.x2 - padX) * c + (seg.y2 - padY) * sn;
	const ly2 = -(seg.x2 - padX) * sn + (seg.y2 - padY) * c;
	const halfLong = Math.max(halfW, halfH);
	const halfShort = Math.min(halfW, halfH);
	const r = halfShort;
	const axisHalf = halfLong - r; // 中心轴线段半长(沿长轴方向)
	let dAxis: number;
	if (halfW >= halfH)
		dAxis = segmentToSegmentDistance(lx1, ly1, lx2, ly2, -axisHalf, 0, axisHalf, 0); // 长轴沿 X
	else
		dAxis = segmentToSegmentDistance(lx1, ly1, lx2, ly2, 0, -axisHalf, 0, axisHalf); // 长轴沿 Y
	return dAxis - r - lineHalfWidth;
}

async function checkPadToLineSpacing(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 14,
		item: '焊盘/过孔到线间距',
		actualValue: '符合要求',
		standardValue: '最小0.15mm',
		result: 'success',
		violations: [],
	};

	try {
		const lines = await eda.pcb_PrimitiveLine.getAll();
		const pads = await eda.pcb_PrimitivePad.getAll();
		const vias = await eda.pcb_PrimitiveVia.getAll();
		const padLocateMap = buildPrimitiveLocateMap(pads, await eda.pcb_PrimitivePad.getAllPrimitiveId());
		const viaLocateMap = buildPrimitiveLocateMap(vias, await eda.pcb_PrimitiveVia.getAllPrimitiveId());
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];

		if (!standard) {
			result.actualValue = '未找到板材标准';
			result.result = 'warning';
			return result;
		}

		const minSpacing = standard.minPadToLineSpacing;
		result.standardValue = `最小${minSpacing}mm`;

		const violations: { x: number; y: number; id: string; reason: string; type: string; locateType?: string }[] = [];
		const minSpacingMil = eda.sys_Unit.mmToMil(minSpacing);
		let minActualSpacing = Infinity;

		// 取图元网络名(未分配返回空串)
		const netOf = (el: any): string => el?.getState_Net?.() ?? '';
		// pad 外径(mil):getState_Pad() 形状元组 max(w,h);多边形焊盘返回 0
		const padOuterMil = (p: any): number => {
			const shape: any = p.getState_Pad?.() ?? p.pad ?? null;
			if (!Array.isArray(shape) || shape.length < 3) {
				issues.push({ code: 'pad_shape_missing', item: 14, message: '焊盘缺少形状或尺寸字段，无法计算焊盘到线间距' });
				return 0;
			}
			const w = Number(shape[1]) || 0;
			const h = Number(shape[2]) || 0;
			if (w <= 0 || h <= 0)
				issues.push({ code: 'pad_size_missing', item: 14, message: '焊盘尺寸无效，无法计算焊盘到线间距' });
			return w > 0 && h > 0 ? Math.max(w, h) : 0;
		};
		// 预缓存走线/过孔的网络与几何,避免双重遍历反复读取
		// Authoritative net map: iterate all nets and their primitives -> primitiveId:netName.
		// (Pad.getState_Net() returns undefined for SMT pads; query the net system instead.)
		const netById = new Map<string, string>();
		try {
			const netNames = await eda.pcb_Net.getAllNetsName();
			for (const name of netNames) {
				let prims: any[];
				try { prims = await eda.pcb_Net.getAllPrimitivesByNet(name); }
				catch (error) { issues.push({ code: 'network_partial_failure', item: 14, message: `网络 ${name} 图元读取失败：${String(error)}` }); continue; }
				if (!Array.isArray(prims)) {
					issues.push({ code: 'network_data_invalid', item: 14, message: `网络 ${name} 图元数据无效` });
					continue;
				}
				for (const prim of prims) {
					const id = (prim as any).getState_PrimitiveId?.() ?? (prim as any).primitiveId ?? '';
					if (id)
						netById.set(id, name);
				}
			}
		}
		catch {
			issues.push({ code: 'network_lookup_failed', item: 14, message: '网络列表读取失败，网络信息可能不完整' });
		}
		const lineCache = lines.map((line: any) => {
			const l = line;
			return {
				net: netById.get(l.getState_PrimitiveId?.() ?? l.primitiveId ?? '') ?? netOf(l),
				layer: String(l.getState_Layer?.() ?? l.layer ?? l.layerId ?? 0),
				widthMil: l.getState_LineWidth?.() ?? l.lineWidth ?? l.width ?? 0,
				seg: {
					x1: l.getState_StartX?.() ?? l.startX ?? l.x1 ?? 0,
					y1: l.getState_StartY?.() ?? l.startY ?? l.y1 ?? 0,
					x2: l.getState_EndX?.() ?? l.endX ?? l.x2 ?? 0,
					y2: l.getState_EndY?.() ?? l.endY ?? l.y2 ?? 0,
				},
			};
		});
		const viaCache = vias.map((via: any) => {
			const v = via;
			const dia = v.getState_Diameter?.() ?? v.diameter ?? 0;
			return {
				net: netById.get(v.getState_PrimitiveId?.() ?? v.primitiveId ?? '') ?? netOf(v),
				pid: v.getState_PrimitiveId?.() ?? v.primitiveId ?? '',
				locateId: viaLocateMap.get(readPrimitiveId(v)) || v.getState_PrimitiveId?.() || v.primitiveId || '',
				x: v.getState_X?.() ?? v.x ?? 0,
				y: v.getState_Y?.() ?? v.y ?? 0,
				radiusMil: dia > 0 ? dia / 2 : 0,
			};
		});
		// 点到线段距离封装
		const distToSeg = (px: number, py: number, seg: { x1: number; y1: number; x2: number; y2: number }): number =>
			pointToLineSegmentDistance({ x: px, y: py }, seg);
		// 预构建铜皮(pour)区域:网络 + 层 + 轮廓点/外接框
		// 用于判定焊盘/过孔是否落在铜皮内(焊盘常仅经铜皮连到某网络,需由铜皮网络反推)
		const pours = await eda.pcb_PrimitivePour.getAll();
		const pourRegions: { net: string; layer: string; pts?: { x: number; y: number }[]; bbox?: { minX: number; maxX: number; minY: number; maxY: number } }[] = [];
		for (const pour of pours) {
			const pr: any = pour;
			const net = pr.getState_Net?.() ?? '';
			const layer = String(pr.getState_Layer?.() ?? pr.layer ?? 0);
			if (!net)
				continue;
			let poly: any = null;
			try {
				poly = pr.getState_ComplexPolygon?.();
			}
			catch {
				/* 取不到多边形则跳过 */
			}
			const src = poly && typeof poly.getSource === 'function' ? poly.getSource() : (Array.isArray(poly) ? poly : null);
			// 外接框:从源数组所有数字两两配对求 minX/maxX/minY/maxY(可靠兜底)
			let bbox: { minX: number; maxX: number; minY: number; maxY: number } | undefined;
			if (Array.isArray(src)) {
				const nums = src.filter((t: any) => typeof t === 'number' && isFinite(t));
				const xs: number[] = [];
				const ys: number[] = [];
				for (let k = 0; k + 1 < nums.length; k += 2) {
					xs.push(nums[k]);
					ys.push(nums[k + 1]);
				}
				if (xs.length > 0)
					bbox = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
			}
			// 精确轮廓点(优先用,discretize 可能为 stub 返回空,空则退回外接框)
			let pts: { x: number; y: number }[] | undefined;
			try {
				if (poly && eda.pcb_MathPolygon && typeof eda.pcb_MathPolygon.discretize === 'function') {
					const d = eda.pcb_MathPolygon.discretize(poly);
					if (Array.isArray(d) && d.length >= 3)
						pts = d.map((pp: any) => ({ x: Number(pp.x) || 0, y: Number(pp.y) || 0 }));
				}
			}
			catch {
				/* 离散化失败则只用外接框 */
			}
			if (pts || bbox)
				pourRegions.push({ net, layer, pts, bbox });
		}
		// 点是否落在铜皮区域内(优先精确轮廓 pointInPolygon,否则外接框)
		const inRegion = (x: number, y: number, rg: any): boolean => {
			if (rg.pts && rg.pts.length >= 3)
				return pointInPolygon({ x, y }, rg.pts);
			if (rg.bbox)
				return x >= rg.bbox.minX && x <= rg.bbox.maxX && y >= rg.bbox.minY && y <= rg.bbox.maxY;
			return false;
		};
		// 检查焊盘到线的间距(同层 + 仅不同网络)
		// 注:Pad.getState_Net() 对 SMT 焊盘常返回 undefined,故焊盘网络改由相接走线/过孔推断
		// (走线 getState_Net 可靠);相接线视为同网络,不判间距。
		for (const pad of pads) {
			const p: any = pad;
			const _padLayerRaw = p.getState_Layer?.() ?? p.layer ?? p.layerId ?? 0;
			const padLayer = String(_padLayerRaw);
			const padIsMulti = Number(_padLayerRaw) === 12; // EPCB_LayerId.MULTI=12: 多层/通孔焊盘贯穿所有铜层
			const outerMil = padOuterMil(p);
			if (outerMil <= 0)
				continue;
			const padX = p.getState_X?.() ?? p.x ?? 0;
			const padY = p.getState_Y?.() ?? p.y ?? 0;
			const padRadiusMil = outerMil / 2;
			const pid = p.getState_PrimitiveId?.() ?? p.primitiveId ?? '';
			// pad shape: rectangle exact clearance; non-rect falls back to circular max/2
			const padShapeRaw: any = p.getState_Pad?.() ?? p.pad ?? null;
			let padHalfW = padRadiusMil; let padHalfH = padRadiusMil; let padRotRad = 0; let padIsRect = false;
			if (Array.isArray(padShapeRaw) && padShapeRaw.length >= 3) {
				const sw = Number(padShapeRaw[1]) || 0;
				const sh = Number(padShapeRaw[2]) || 0;
				if (sw > 0 && sh > 0) {
					padHalfW = sw / 2; padHalfH = sh / 2;
					padIsRect = padShapeRaw.length >= 4 || String(padShapeRaw[0]).toUpperCase() === 'RECT';
					// getState_Rotation(): V3.2.148 returns RADIANS (e.g. -pi/2); V3.2.166 returns DEGREES (e.g. 90). Normalize: |rot|>pi => degrees->radians, else treat as radians (148 compat). 166 deg=90 read as 90rad flipped the rect long axis => mass pad-to-line false positives.
					const rotRadFromApi = Number(p.getState_Rotation?.() ?? 0) || 0;
					padRotRad = Math.abs(rotRadFromApi) > Math.PI ? rotRadFromApi * Math.PI / 180 : rotRadFromApi;
				}
			}
			const clrPadLine = (seg: { x1: number; y1: number; x2: number; y2: number }, lineHalfW: number): number =>
				padIsRect ? padRectToSegClearanceMil(padX, padY, padHalfW, padHalfH, padRotRad, seg, lineHalfW) : padOvalToSegClearanceMil(padX, padY, padHalfW, padHalfH, padRotRad, seg, lineHalfW);
			// 焊盘网络集合 = 自身网络 ∪ 相接走线网络 ∪ 相接过孔网络
			const padNets = new Set<string>();
			const pn = netById.get(pid) ?? netOf(p);
			if (pn)
				padNets.add(pn);
			// Connectivity-based (most reliable; sees through teardrops): read nets of primitives the API says connect to this pad.
			try {
				const conn: any[] = await p.getConnectedPrimitives?.(false);
				if (Array.isArray(conn)) {
					for (const c of conn) {
						const cid = c.getState_PrimitiveId?.() ?? c.primitiveId ?? '';
						const cn = (cid && netById.get(cid)) || netOf(c);
						if (cn)
							padNets.add(cn);
					}
				}
			}
			catch {
				/* connected-primitives query unavailable; fall back to geometric touch / net map */
			}
			const sameLayerLines = padIsMulti ? lineCache : lineCache.filter((lc: { layer: string }) => lc.layer === padLayer); // 多层焊盘比全部走线(同过孔),单层只比同层
			// 几何相接(边距<=0)无条件推断同网络:V3.2.166 的 getAllPrimitivesByNet/getConnectedPrimitives 退化、
			// getState_Net 对自动网络($1N)返回不一致名,网络名已不可靠,故以"物理贴/穿焊盘"作为同网络的可靠判据。
			// 代价:异网络走线真短路(相接)也会并入同网络跳过;但本项是间距检查(查边距>0 过近),不查短路。
			for (const lc of sameLayerLines) {
				if (clrPadLine(lc.seg, lc.widthMil / 2) <= 0 && lc.net)
					padNets.add(lc.net);
			}
			for (const vc of viaCache) {
				if (vc.radiusMil <= 0)
					continue;
				const dx = vc.x - padX;
				const dy = vc.y - padY;
				if (Math.sqrt(dx * dx + dy * dy) <= padRadiusMil + vc.radiusMil && vc.net)
					padNets.add(vc.net);
			}
			// 焊盘若落在同层铜皮内,并入该铜皮网络
			for (const rg of pourRegions) {
				if (rg.layer === padLayer && inRegion(padX, padY, rg))
					padNets.add(rg.net);
			}
			if (padNets.size === 0)
				issues.push({ code: 'pad_net_missing', item: 14, message: `焊盘 ${pid || '未知 ID'} 无法从自身、网络、连接关系或铜皮推断网络` });
			// 检查同层走线:同网络跳过;不同网络边距小于阈值即报。
			// 相接(边距≤0):仅当两方网络都明确且不同才判短路;任一方网络不明则视为同网络跳过,避免误报从焊盘出来的走线
			for (const lc of sameLayerLines) {
				if (lc.net && padNets.has(lc.net))
					continue;
				const edgeSpacingMil = clrPadLine(lc.seg, lc.widthMil / 2);
				if (edgeSpacingMil <= 0 && !(lc.net && padNets.size > 0))
					continue;
				if (edgeSpacingMil < minActualSpacing)
					minActualSpacing = edgeSpacingMil;
				if (edgeSpacingMil < minSpacingMil) {
					const edgeSpacingMm = Math.max(0, eda.sys_Unit.milToMm(edgeSpacingMil));
					violations.push({
						x: padX,
						y: padY,
						id: padLocateMap.get(pid) || pid,
						reason: `焊盘到线距 ${edgeSpacingMm.toFixed(3)}mm 小于最小值 ${minSpacing}mm`,
						type: 'pad-line',
					});
				}
			}
		}
		// 检查过孔到线的间距(过孔贯穿各层,不按层过滤;仅不同网络,网络同理由相接走线推断)
		for (const vc of viaCache) {
			if (vc.radiusMil <= 0)
				continue;
			const viaNets = new Set<string>();
			if (vc.net)
				viaNets.add(vc.net);
			// 几何相接无条件推断同网络(理由同焊盘分支:V3.2.166 网络名不可靠,以物理相接为准)
			for (const lc of lineCache) {
				if (distToSeg(vc.x, vc.y, lc.seg) <= vc.radiusMil + lc.widthMil / 2 && lc.net)
					viaNets.add(lc.net);
			}
			for (const rg of pourRegions) {
				if (inRegion(vc.x, vc.y, rg))
					viaNets.add(rg.net);
			}
			for (const lc of lineCache) {
				if (lc.net && viaNets.has(lc.net))
					continue;
				const edgeSpacingMil = distToSeg(vc.x, vc.y, lc.seg) - vc.radiusMil - lc.widthMil / 2;
				if (edgeSpacingMil <= 0 && !(lc.net && viaNets.size > 0))
					continue;
				if (edgeSpacingMil < minActualSpacing)
					minActualSpacing = edgeSpacingMil;
				if (edgeSpacingMil < minSpacingMil) {
					const edgeSpacingMm = Math.max(0, eda.sys_Unit.milToMm(edgeSpacingMil));
					violations.push({
						x: vc.x,
						y: vc.y,
						id: vc.locateId,
						reason: `过孔到线距 ${edgeSpacingMm.toFixed(3)}mm 小于最小值 ${minSpacing}mm`,
						type: 'via-line',
					});
				}
			}
		}

		if (violations.length > 0) {
			result.result = 'error';
			result.violations = violations;
		}

		if (minActualSpacing !== Infinity) {
			result.actualValue = `最小${Math.max(0, eda.sys_Unit.milToMm(minActualSpacing)).toFixed(3)}mm`;
		}
		else if (pads.length === 0 && vias.length === 0) {
			result.actualValue = '无焊盘/过孔';
		}
		else if (lines.length === 0) {
			result.actualValue = '无走线';
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 第15项：有铜插件焊盘焊环检查
 */
async function checkPluginPadRingWithCopper(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 15,
		item: '有铜插件焊盘焊环',
		actualValue: '符合要求',
		standardValue: '最小0.15mm',
		result: 'success',
		violations: [],
	};

	try {
		const pads = await eda.pcb_PrimitivePad.getAll();
		// 有效铜层数决定双面/多层(BOT-only 等按实际有铜层计)
		const layerCount = await parseEffectiveCopperLayerCount();

		const padLocateMap = buildPrimitiveLocateMap(pads, await eda.pcb_PrimitivePad.getAllPrimitiveId());
		// 焊环阈值按有效铜层数:双面板(≤2)建议0.25/极限0.18;多层板(≥3)建议0.20/极限0.15
		const isMultilayer = layerCount >= 3;
		const ideal = isMultilayer ? 0.20 : 0.25; // 建议值
		const limit = isMultilayer ? 0.15 : 0.18; // 极限值

		// pad 外径(mm):从 getState_Pad() 形状元组取 max(w,h) 再 milToMm(同第9项 getPadOuterMm)
		// pad 形状元组:["ELLIPSE"|"OVAL"|"NGON", w, h] / ["RECT", w, h, rot] 等
		const getPadOuterMm = (p: any): number => {
			const shape: any = p.getState_Pad?.() ?? p.pad ?? null;
			if (!Array.isArray(shape) || shape.length < 3)
				return 0;
			const w = Number(shape[1]) || 0;
			const h = Number(shape[2]) || 0;
			if (w <= 0 || h <= 0)
				return 0;
			return eda.sys_Unit.milToMm(Math.max(w, h));
		};

		const violations: { x: number; y: number; id: string; reason: string; type: string; locateType?: string }[] = [];
		let minRingMm = Infinity;
		let pluginCount = 0;

		for (const pad of pads) {
			const p: any = pad;
			// 有铜插件焊盘:有孔(getState_Hole 元组孔径>0) + 金属化(getState_Metallization!==false)
			const hole: any = p.getState_Hole?.();
			const hasHole = Array.isArray(hole) && hole.length >= 2 && Number(hole[1] ?? 0) > 0;
			if (!hasHole)
				continue;
			if (p.getState_Metallization?.() === false)
				continue; // 无铜,归第16项

			const outerMm = getPadOuterMm(p);
			const holeMm = eda.sys_Unit.milToMm(Number(hole[1]));
			if (outerMm <= 0 || holeMm <= 0)
				continue;

			const ringMm = (outerMm - holeMm) / 2;
			pluginCount++;
			if (ringMm < minRingMm)
				minRingMm = ringMm;

			// 小于建议值(含小于极限)收集为违规,点击可定位高亮该焊盘
			if (ringMm < ideal) {
				violations.push({
					x: p.getState_X?.() ?? p.x ?? 0,
					y: p.getState_Y?.() ?? p.y ?? 0,
					id: padLocateMap.get(readPrimitiveId(p)) || p.getState_PrimitiveId?.() || p.primitiveId || '',
					reason: ringMm < limit
						? `焊环 ${ringMm.toFixed(3)}mm 小于极限 ${limit}mm`
						: `焊环 ${ringMm.toFixed(3)}mm 小于建议 ${ideal}mm`,
					type: 'pad',
				});
			}
		}

		result.standardValue = `建议≥${ideal} / 极限${limit}mm(${isMultilayer ? '多层板' : '双面板'})`;

		if (pluginCount === 0) {
			result.actualValue = '无插件焊盘';
			result.result = 'success';
		}
		else {
			result.actualValue = `最小${minRingMm.toFixed(3)}mm`;
			if (minRingMm < limit)
				result.result = 'error';
			else if (minRingMm < ideal)
				result.result = 'warning';
			else
				result.result = 'success';
			if (violations.length > 0)
				result.violations = violations;
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 第16项：无铜插件焊盘焊环检查
 */
async function checkPluginPadRingWithoutCopper(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 16,
		item: '无铜插件焊盘焊环',
		actualValue: '符合要求',
		standardValue: '最小0.2mm',
		result: 'success',
		violations: [],
	};

	try {
		const pads = await eda.pcb_PrimitivePad.getAll();

		// 无铜插件焊环阈值:建议 ≥0.45mm。无铜孔用干膜封孔,周围会掏空0.2mm 焊盘/铜面,
		// 焊环过小→焊接失败(成为线圈或无焊盘),故小于建议值按 error。
		const ideal = 0.45;
		const padLocateMap = buildPrimitiveLocateMap(pads, await eda.pcb_PrimitivePad.getAllPrimitiveId());

		// pad 外径(mm):getState_Pad() 形状元组 max(w,h) 再 milToMm(同第9/15项)
		const getPadOuterMm = (p: any): number => {
			const shape: any = p.getState_Pad?.() ?? p.pad ?? null;
			if (!Array.isArray(shape) || shape.length < 3)
				return 0;
			const w = Number(shape[1]) || 0;
			const h = Number(shape[2]) || 0;
			if (w <= 0 || h <= 0)
				return 0;
			return eda.sys_Unit.milToMm(Math.max(w, h));
		};

		const violations: { x: number; y: number; id: string; reason: string; type: string; locateType?: string }[] = [];
		let minRingMm = Infinity;
		let pluginCount = 0;

		for (const pad of pads) {
			const p: any = pad;
			// 无铜插件焊盘:有孔 + 非金属化(getState_Metallization===false);有铜(含 undefined 兜底)归第15项
			const hole: any = p.getState_Hole?.();
			const hasHole = Array.isArray(hole) && hole.length >= 2 && Number(hole[1] ?? 0) > 0;
			if (!hasHole)
				continue;
			if (p.getState_Metallization?.() !== false)
				continue;

			const outerMm = getPadOuterMm(p);
			const holeMm = eda.sys_Unit.milToMm(Number(hole[1]));
			if (outerMm <= 0 || holeMm <= 0)
				continue;

			const ringMm = (outerMm - holeMm) / 2;
			pluginCount++;
			if (ringMm < minRingMm)
				minRingMm = ringMm;

			if (ringMm < ideal) {
				violations.push({
					x: p.getState_X?.() ?? p.x ?? 0,
					y: p.getState_Y?.() ?? p.y ?? 0,
					id: padLocateMap.get(readPrimitiveId(p)) || p.getState_PrimitiveId?.() || p.primitiveId || '',
					reason: `焊环 ${ringMm.toFixed(3)}mm 小于建议 ${ideal}mm`,
					type: 'pad',
				});
			}
		}

		result.standardValue = `建议≥${ideal}mm`;

		if (pluginCount === 0) {
			result.actualValue = '无无铜插件焊盘';
		}
		else {
			result.actualValue = `最小${minRingMm.toFixed(3)}mm`;
			if (minRingMm < ideal)
				result.result = 'error';
			if (violations.length > 0)
				result.violations = violations;
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 收集 BGA 元件的焊盘短 id 集合(供第9项排除、第17项检查复用)
 *
 * 识别:BGA 元件 = 器件名(getState_Component)/封装名(getState_Footprint)含 "BGA"。
 * 返回 component.getState_Pads() 的 primitiveId(短 id,如 "e698")数组;
 * pad 的长 id(如 "7a98354ee7288852e698")以该短 id 结尾即归属该 BGA 元件。
 */
async function collectBgaPadIds(): Promise<{ ids: string[]; componentCount: number }> {
	const components = await eda.pcb_PrimitiveComponent.getAll();
	const ids = new Set<string>();
	let componentCount = 0;
	for (const comp of components) {
		const c: any = comp;
		const compName = c.getState_Component?.()?.name ?? '';
		const fpName = c.getState_Footprint?.()?.name ?? '';
		if (!/BGA/i.test(`${compName}/${fpName}`))
			continue;
		componentCount++;
		const pads = c.getState_Pads?.();
		if (Array.isArray(pads)) {
			for (const pad of pads) {
				const shortId = String(pad.primitiveId ?? '');
				if (shortId)
					ids.add(shortId);
			}
		}
	}
	return { ids: Array.from(ids), componentCount };
}

/**
 * 多引脚元件的焊盘坐标集合(供 SMT 最小 IC 引脚间距 / BGA 球间距计算)
 */
interface ComponentPadCoords {
	isBga: boolean;
	designator: string;
	fpName: string;
	compId: string;
	x: number;
	y: number;
	coords: Array<{ x: number; y: number; layer: string }>;
}

/**
 * 收集多引脚元件(pad≥4)的焊盘坐标列表
 *
 * 焊盘坐标: 用 getState_Pads() 的短 id 去 pcb_PrimitivePad.getAll() 按
 * 长 id endsWith 短 id 匹配取 getState_X/Y(同第17项 BGA 焊盘取法)。
 */
async function collectComponentPadCoords(): Promise<ComponentPadCoords[]> {
	const components = await eda.pcb_PrimitiveComponent.getAll();
	const allPads = await eda.pcb_PrimitivePad.getAll();
	const out: ComponentPadCoords[] = [];

	for (const comp of components) {
		const c: any = comp;
		const pads = c.getState_Pads?.();
		if (!Array.isArray(pads) || pads.length < 4)
			continue;
		const shortIds = pads.map((p: any) => String(p.primitiveId ?? '')).filter(Boolean);
		if (shortIds.length === 0)
			continue;

		const coords: Array<{ x: number; y: number; layer: string }> = [];
		for (const pad of allPads) {
			const p: any = pad;
			const pid = String(p.getState_PrimitiveId?.() ?? '');
			if (shortIds.some(s => pid.endsWith(s))) {
				coords.push({ x: p.getState_X?.() ?? 0, y: p.getState_Y?.() ?? 0, layer: String(p.getState_Layer?.() ?? p.layer ?? 0) });
			}
		}
		if (coords.length === 0)
			continue;

		const compName = c.getState_Component?.()?.name ?? '';
		const fpName = c.getState_Footprint?.()?.name ?? '';
		out.push({
			isBga: /BGA/i.test(`${compName}/${fpName}`),
			designator: c.getState_Designator?.() ?? '',
			fpName,
			compId: String(c.getState_PrimitiveId?.() ?? ''),
			x: c.getState_X?.() ?? 0,
			y: c.getState_Y?.() ?? 0,
			coords,
		});
	}
	return out;
}

/**
 * 一组坐标两两最小欧氏距离(mil)，近似相邻引脚/球的间距
 */
function minPairDistanceMil(coords: Array<{ x: number; y: number }>): number {
	let min = Infinity;
	for (let i = 0; i < coords.length; i++) {
		for (let j = i + 1; j < coords.length; j++) {
			const dx = coords[i].x - coords[j].x;
			const dy = coords[i].y - coords[j].y;
			const d = Math.sqrt(dx * dx + dy * dy);
			if (d > 0 && d < min) {
				min = d;
			}
		}
	}
	return min;
}

/**
 * 一组带层别坐标的两两最小距离,仅比较共面(同侧)焊盘对(顶1/底2 不共面;通孔12 与顶/底都共面)。
 * 用于 IC 引脚间距:避免内孔/双面件顶层↔底层 2D 重叠算出假 pitch。
 */
function minPairDistanceMilByLayer(coords: Array<{ x: number; y: number; layer: string }>): number {
	const outerLayersOf = (layer: string): Set<string> => (layer === '12' ? new Set(['1', '2']) : new Set([layer]));
	const shareLayer = (a: string, b: string): boolean => {
		const sa = outerLayersOf(a);
		for (const l of outerLayersOf(b))
			if (sa.has(l))
				return true;
		return false;
	};
	let min = Infinity;
	for (let i = 0; i < coords.length; i++) {
		for (let j = i + 1; j < coords.length; j++) {
			if (!shareLayer(coords[i].layer, coords[j].layer))
				continue; // 不共面(如顶↔底 SMT):板子正反两面,非相邻引脚,跳过
			const dx = coords[i].x - coords[j].x;
			const dy = coords[i].y - coords[j].y;
			const d = Math.sqrt(dx * dx + dy * dy);
			if (d > 0 && d < min)
				min = d;
		}
	}
	return min;
}

/**
 * 第17项：BGA焊盘检查
 */
async function checkBgaPad(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 17,
		item: 'BGA焊盘',
		actualValue: '无BGA焊盘',
		standardValue: '最小直径0.25mm',
		result: 'success',
		violations: [],
	};

	try {
		const lines = await eda.pcb_PrimitiveLine.getAll();
		const allPads = await eda.pcb_PrimitivePad.getAll();

		const padLocateMap = buildPrimitiveLocateMap(allPads, await eda.pcb_PrimitivePad.getAllPrimitiveId());
		// 阈值:焊盘直径 0.2mm;焊盘到线 双面0.10/多层0.09mm(按铜层数)
		const minDiameter = 0.2;
		const layerCount = await parseCopperLayerCount();
		const isMultilayer = layerCount >= 3;
		const minPadToLine = isMultilayer ? 0.09 : 0.10;
		const minPadToLineMil = eda.sys_Unit.mmToMil(minPadToLine);

		// 识别 BGA 焊盘短 id 集合(复用共享逻辑;第9项也用它排除 BGA 焊盘)
		const { ids: bgaPadIdArr, componentCount: bgaComponentCount } = await collectBgaPadIds();

		// pad 外径(mil):getState_Pad() 形状元组;BGA 为圆形焊盘,长/短轴悬殊时取短轴(见下),留 mil 便于到线计算
		const getPadOuterMil = (p: any): number => {
			const shape: any = p.getState_Pad?.() ?? p.pad ?? null;
			if (!Array.isArray(shape) || shape.length < 3)
				return 0;
			const w = Number(shape[1]) || 0;
			const h = Number(shape[2]) || 0;
			if (w <= 0 || h <= 0)
				return 0;
			const _mx = Math.max(w, h); const _mn = Math.min(w, h);
			// BGA 焊盘按定义圆形;getState_Pad 对元件焊盘不稳定(实测 0.4mm 圆焊盘被返成 2mm 长圆),长轴为幽灵值;两轴悬殊(长/短>2)时取短轴为直径,避免到线误报;真圆形两轴接近则取 max 不变
			return _mx / _mn > 2 ? _mn : _mx;
		};

		const violations: { x: number; y: number; id: string; reason: string; type: 'pad' }[] = [];
		let minDiameterMm = Infinity;
		let minSpacingToLineMm = Infinity;
		let bgaPadCount = 0;

		for (const pad of allPads) {
			const p: any = pad;
			const pid = String(p.getState_PrimitiveId?.() ?? p.primitiveId ?? '');
			if (!bgaPadIdArr.some(short => short && pid.endsWith(short)))
				continue;

			const padX = p.getState_X?.() ?? p.x ?? 0;
			const padY = p.getState_Y?.() ?? p.y ?? 0;
			const padLayer = p.getState_Layer?.() ?? p.layer ?? p.layerId ?? 0;
			const outerMil = getPadOuterMil(p);
			if (outerMil <= 0)
				continue;

			const padRadiusMil = outerMil / 2;
			const diameterMm = eda.sys_Unit.milToMm(outerMil);
			bgaPadCount++;
			if (diameterMm < minDiameterMm)
				minDiameterMm = diameterMm;

			// ① 焊盘直径
			if (diameterMm < minDiameter) {
				violations.push({
					x: padX,
					y: padY,
					id: padLocateMap.get(pid) || pid,
					reason: `BGA焊盘直径 ${diameterMm.toFixed(3)}mm 小于 ${minDiameter}mm`,
					type: 'pad',
				});
			}

			// ② 焊盘到线间距(同层)
			for (const line of lines) {
				const l: any = line;
				const lineLayer = l.getState_Layer?.() ?? l.layer ?? l.layerId ?? 0;
				if (String(lineLayer) !== String(padLayer))
					continue;
				const lineWidthMil = l.getState_LineWidth?.() ?? l.lineWidth ?? l.width ?? 0;
				const seg = {
					x1: l.getState_StartX?.() ?? l.startX ?? l.x1 ?? 0,
					y1: l.getState_StartY?.() ?? l.startY ?? l.y1 ?? 0,
					x2: l.getState_EndX?.() ?? l.endX ?? l.x2 ?? 0,
					y2: l.getState_EndY?.() ?? l.endY ?? l.y2 ?? 0,
				};
				const centerDistMil = pointToLineSegmentDistance({ x: padX, y: padY }, seg);
				const edgeSpacingMil = centerDistMil - padRadiusMil - lineWidthMil / 2;
				if (edgeSpacingMil <= 0)
					continue;
				const spacingMm = eda.sys_Unit.milToMm(edgeSpacingMil);
				if (spacingMm < minSpacingToLineMm)
					minSpacingToLineMm = spacingMm;
				if (edgeSpacingMil < minPadToLineMil) {
					violations.push({
						x: padX,
						y: padY,
						id: padLocateMap.get(pid) || pid,
						reason: `BGA焊盘到线 ${spacingMm.toFixed(3)}mm 小于 ${minPadToLine}mm`,
						type: 'pad',
					});
				}
			}
		}

		result.standardValue = `直径≥${minDiameter} / 到线≥${minPadToLine}mm(${isMultilayer ? '多层板' : '双面板'},仅限沉金工艺)`;

		if (bgaPadCount === 0) {
			result.actualValue = bgaComponentCount > 0 ? `识别${bgaComponentCount}个BGA元件但无焊盘` : '无BGA焊盘';
		}
		else {
			result.actualValue = `最小直径${minDiameterMm.toFixed(3)}mm / 最小到线${minSpacingToLineMm === Infinity ? '∞' : `${minSpacingToLineMm.toFixed(3)}mm`}`;
			if (violations.length > 0) {
				result.result = 'error';
				result.violations = violations;
			}
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * 第18项：丝印字符检查
 */
async function checkString(): Promise<CheckResult> {
	const result: CheckResult = {
		number: 18,
		item: '丝印字符',
		actualValue: '符合要求',
		standardValue: '高度≥0.8mm, 粗细≥0.15mm',
		result: 'success',
		violations: [],
	};

	try {
		const strings = await eda.pcb_PrimitiveString.getAll();
		const stringLocateMap = buildPrimitiveLocateMap(strings, await eda.pcb_PrimitiveString.getAllPrimitiveId());
		// Attribute 只取器件位号(Designator),排除器件名/封装名(Name)等属性——
		// 后者默认字号小会一直卡着最小值,且不属于"丝印标号"
		const attrs = (await eda.pcb_PrimitiveAttribute.getAll()).filter((a: any) => ((a as any).getState_Key?.() ?? '') === 'Designator');
		const standard = JLC_MATERIAL_STANDARDS[selectedMaterial];

		if (!standard) {
			result.actualValue = '未找到板材标准';
			result.result = 'warning';
			return result;
		}

		const minHeight = SHARED_DFM_STANDARDS.minStringHeight;
		const minWidth = SHARED_DFM_STANDARDS.minStringWidth;

		// 丝印层文字 = 独立文本(PrimitiveString)+ 器件属性/位号(PrimitiveAttribute)。
		// 器件位号(R1/U1)是 Attribute 图元(key=Designator),不是 String;只查 PrimitiveString 会漏。
		// 两类都有 getState_FontSize(字高)/getState_LineWidth(笔画粗细)/getState_X/Y。
		const allTexts: any[] = [...strings, ...attrs];
		const violations: { x: number; y: number; id: string; reason: string; type: 'string' }[] = [];
		let minFontMm = Infinity;
		let minWidthMm = Infinity;
		let count = 0;

		for (const t of allTexts) {
			const fontSizeMil = (t as any).getState_FontSize?.() ?? 0;
			const lineWidthMil = (t as any).getState_LineWidth?.() ?? 0;
			if (fontSizeMil <= 0)
				continue;
			count++;
			const fontMm = eda.sys_Unit.milToMm(fontSizeMil);
			const widthMm = eda.sys_Unit.milToMm(lineWidthMil);
			if (fontMm < minFontMm)
				minFontMm = fontMm;
			if (widthMm > 0 && widthMm < minWidthMm)
				minWidthMm = widthMm;

			if (fontMm < minHeight || (widthMm > 0 && widthMm < minWidth)) {
				violations.push({
					x: (t as any).getState_X?.() ?? 0,
					y: (t as any).getState_Y?.() ?? 0,
					id: stringLocateMap.get(readPrimitiveId(t)) || (t as any).getState_PrimitiveId?.() || '',
					reason: `字符 高度${fontMm.toFixed(3)}/粗细${widthMm.toFixed(3)}mm 小于 高度${minHeight}/粗细${minWidth}mm`,
					type: 'string',
				});
			}
		}

		result.standardValue = `高度≥${minHeight}mm, 粗细≥${minWidth}mm`;

		if (count === 0) {
			result.actualValue = '无丝印字符';
		}
		else {
			result.actualValue = `检查${count}个字符,最小高度${minFontMm.toFixed(3)}/粗细${minWidthMm.toFixed(3)}mm`;
			if (violations.length > 0) {
				result.result = 'error';
				result.violations = violations;
			}
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}



async function checkSolderingSides(standard: SmtStandardConfig): Promise<CheckResult> {
	const result: CheckResult = {
		number: 1,
		item: '焊接面',
		actualValue: '',
		standardValue: '',
		result: 'success',
	};

	try {
		// 按焊盘所属层统计实际焊接面：
		//   TOP(1) / BOTTOM(2) = 表层贴片焊盘，计入 SMT 焊接面（双面贴片元件两面都会贡献）
		//   MULTI(12) = 通孔/插装焊盘，属插装工艺，不计入 SMT 焊接面（如 Type-C/SMA 的插针）
		const pads = await eda.pcb_PrimitivePad.getAll();
		let hasTop = false;
		let hasBot = false;
		for (const p of pads) {
			const layer = (p as any).getState_Layer?.();
			if (layer === 1)
				hasTop = true;
			else if (layer === 2)
				hasBot = true;
		}

		// 实际焊接面
		const isDualSided = hasTop && hasBot;
		if (isDualSided)
			result.actualValue = 'TOP + BOT（双面）';
		else if (hasTop)
			result.actualValue = 'TOP（单面）';
		else if (hasBot)
			result.actualValue = 'BOT（单面）';
		else result.actualValue = '无贴片焊盘';

		// 标准是否支持双面：solderingSides 含 'both' 才支持双面，否则仅支持单面
		const supportDual = standard.solderingSides.includes('both');
		result.standardValue = supportDual ? '支持双面' : '仅支持单面';

		// 判定：实际为双面而标准不支持双面 → 报错
		if (isDualSided && !supportDual) {
			result.result = 'error';
			result.actualValue += '（超出标准：当前标准仅支持单面焊接）';
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * SMT 第2项：层数检查
 */
async function checkSmtLayerCount(standard: SmtStandardConfig): Promise<CheckResult> {
	const result: CheckResult = {
		number: 2,
		item: '层数',
		actualValue: '',
		standardValue: `支持${standard.layerCounts.length > 0 ? standard.layerCounts.join('/') : '无限制'}层`,
		result: 'success',
	};

	try {
		// 直接读取板子设计的铜箔层数（2/4/6/.../32）
		const layerCount = await eda.pcb_Layer.getTheNumberOfCopperLayers();
		result.actualValue = layerCount > 0 ? `${layerCount}层` : '未知';

		// 检查是否符合标准
		if (standard.layerCounts.length > 0 && !standard.layerCounts.includes(layerCount)) {
			result.result = 'error';
			result.actualValue += '（不符合当前标准）';
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * SMT 第3项：板厚检查
 */
function checkSmtBoardThickness(standard: SmtStandardConfig, thickness: number): CheckResult {
	const result: CheckResult = {
		number: 3,
		item: '板厚',
		actualValue: `${thickness}mm`,
		standardValue: `${standard.thicknessRange.min}-${standard.thicknessRange.max}mm`,
		result: 'success',
	};

	try {
		// 板厚由用户在 SMT 标准选择对话框输入（嘉立创 pro API 无读取成品板厚的方法）
		if (thickness < standard.thicknessRange.min || thickness > standard.thicknessRange.max) {
			result.result = 'error';
			result.actualValue += '（不符合当前标准）';
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * SMT 第4项：尺寸检查
 */
async function checkSmtBoardSize(standard: SmtStandardConfig): Promise<CheckResult> {
	const result: CheckResult = {
		number: 4,
		item: '纵横尺寸',
		actualValue: '未知',
		standardValue: `${standard.sizeRange.minWidth}x${standard.sizeRange.minLength} - ${standard.sizeRange.maxWidth}x${standard.sizeRange.maxLength}mm`,
		result: 'success',
	};

	try {
		// 优先用板框层(BOARD_OUTLINE=11)图元算外接框；板框层为空则取所有图元
		const BOARD_OUTLINE_LAYER = 11;
		const allIds: string[] = [];
		const pushIds = (arr: any[]) => {
			if (arr?.length)
				allIds.push(...arr.map((p: any) => p.primitiveId || p.id));
		};
		pushIds(await eda.pcb_PrimitivePolyline.getAll(undefined, BOARD_OUTLINE_LAYER as any));
		pushIds(await eda.pcb_PrimitiveLine.getAll(undefined, BOARD_OUTLINE_LAYER as any));
		pushIds(await eda.pcb_PrimitiveArc.getAll(undefined, BOARD_OUTLINE_LAYER as any));

		if (allIds.length === 0) {
			issues.push({ code: 'board_outline_inferred', item: 4, message: 'SMT 尺寸未找到板框层，改用全图元包围盒推断' });
			pushIds(await eda.pcb_PrimitivePolyline.getAll());
			pushIds(await eda.pcb_PrimitiveLine.getAll());
			pushIds(await eda.pcb_PrimitiveArc.getAll());
			pushIds(await eda.pcb_PrimitivePad.getAll());
			pushIds(await eda.pcb_PrimitiveVia.getAll());
			pushIds(await eda.pcb_PrimitivePour.getAll());
			pushIds(await eda.pcb_PrimitivePoured.getAll());
			pushIds(await eda.pcb_PrimitiveFill.getAll());
		}

		if (allIds.length === 0) {
			result.actualValue = '无图元';
			result.result = 'warning';
			return result;
		}

		const bbox = await eda.pcb_Primitive.getPrimitivesBBox(allIds);
		if (!bbox) {
			result.actualValue = '无法计算尺寸';
			result.result = 'warning';
			return result;
		}

		const widthMm = eda.sys_Unit.milToMm(bbox.maxX - bbox.minX);
		const heightMm = eda.sys_Unit.milToMm(bbox.maxY - bbox.minY);
		result.actualValue = `${widthMm.toFixed(2)}x${heightMm.toFixed(2)}mm`;

		const { minWidth, maxWidth, minLength, maxLength } = standard.sizeRange;
		if (widthMm < minWidth || widthMm > maxWidth
			|| heightMm < minLength || heightMm > maxLength) {
			result.result = 'error';
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * SMT 第5项：最小封装检查
 */
async function checkSmtMinPackage(standard: SmtStandardConfig): Promise<CheckResult> {
	const result: CheckResult = {
		number: 5,
		item: '最小封装',
		actualValue: '未知',
		standardValue: `最小${standard.minPackage}`,
		result: 'success',
		violations: [],
	};

	try {
		const components = await eda.pcb_PrimitiveComponent.getAll();
		let smallestPkg: string | null = null;
		const violations: ViolationCoord[] = [];

		for (const c of components as any[]) {
			const fpName = c.getState_Footprint?.()?.name ?? '';
			if (!fpName) {
				continue;
			}
			// 归一化为 EIA 阻容尺寸代码；非阻容封装(如 SOT/QFN)返回 null，跳过
			const pkg = normalizeEiaPackage(fpName);
			if (!pkg) {
				continue;
			}
			// 跟踪板上最小阻容尺寸
			if (smallestPkg === null || isPackageSmaller(pkg, smallestPkg)) {
				smallestPkg = pkg;
			}
			// 比标准最小封装还小 → 违规
			if (isPackageSmaller(pkg, standard.minPackage)) {
				violations.push({
					x: c.getState_X?.() ?? 0,
					y: c.getState_Y?.() ?? 0,
					id: c.getState_PrimitiveId?.() ?? '',
					reason: `位号${c.getState_Designator?.() ?? ''} 封装 ${fpName}(${pkg}) 小于最小 ${standard.minPackage}`,
					type: 'component',
				});
			}
		}

		result.actualValue = smallestPkg ?? '无贴片阻容封装';
		if (violations.length > 0) {
			result.result = 'error';
			result.violations = violations;
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * SMT 第6项：最小 IC 引脚间距检查(不含 BGA)
 *
 * IC = 多引脚(pad≥4)且非 BGA 元件；引脚间距取该元件焊盘两两最小距离(近似相邻引脚)。
 */
async function checkSmtIcPinPitch(standard: SmtStandardConfig, compPads: ComponentPadCoords[]): Promise<CheckResult> {
	const result: CheckResult = {
		number: 6,
		item: '最小IC引脚间距',
		actualValue: '未知',
		standardValue: `最小${standard.icPinPitchMin}mm`,
		result: 'success',
		violations: [],
	};

	try {
		let minPitchMm = Infinity;
		const violations: ViolationCoord[] = [];

		for (const cp of compPads) {
			if (cp.isBga)
				continue; // 不考虑 BGA
			if (cp.coords.length < 2)
				continue;
			const pitchMil = minPairDistanceMilByLayer(cp.coords);
			if (!isFinite(pitchMil))
				continue;
			const pitchMm = eda.sys_Unit.milToMm(pitchMil);
			if (pitchMm < minPitchMm)
				minPitchMm = pitchMm;
			if (pitchMm < standard.icPinPitchMin) {
				violations.push({
					x: cp.x,
					y: cp.y,
					id: cp.compId,
					reason: `位号${cp.designator} IC引脚间距 ${pitchMm.toFixed(3)}mm 小于 ${standard.icPinPitchMin}mm`,
					type: 'component',
				});
			}
		}

		result.actualValue = isFinite(minPitchMm) ? `最小${minPitchMm.toFixed(3)}mm` : '无IC器件';
		if (violations.length > 0) {
			result.result = 'error';
			result.violations = violations;
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}

/**
 * SMT 第7项：BGA 球径间距检查
 *
 * BGA 球间距 = BGA 元件焊盘两两最小距离(近似相邻锡球)。
 */
async function checkSmtBgaPitch(standard: SmtStandardConfig, compPads: ComponentPadCoords[]): Promise<CheckResult> {
	const result: CheckResult = {
		number: 7,
		item: 'BGA球径间距',
		actualValue: '未知',
		standardValue: `最小${standard.bgaPitchMin}mm`,
		result: 'success',
		violations: [],
	};

	try {
		let minPitchMm = Infinity;
		const violations: ViolationCoord[] = [];

		for (const cp of compPads) {
			if (!cp.isBga)
				continue;
			if (cp.coords.length < 2)
				continue;
			const pitchMil = minPairDistanceMil(cp.coords);
			if (!isFinite(pitchMil))
				continue;
			// pitch 四舍五入到 0.01mm:BGA pitch 按 0.5/0.65/0.8… 分档;0.5mm 网格在 mil 换算会算成 0.499mm,四舍五入回 0.500 避免卡阈值误报
			const pitchMm = Math.round(eda.sys_Unit.milToMm(pitchMil) * 100) / 100;
			if (pitchMm < minPitchMm)
				minPitchMm = pitchMm;
			if (pitchMm < standard.bgaPitchMin) {
				violations.push({
					x: cp.x,
					y: cp.y,
					id: cp.compId,
					reason: `位号${cp.designator} BGA球间距 ${pitchMm.toFixed(3)}mm 小于 ${standard.bgaPitchMin}mm`,
					type: 'component',
				});
			}
		}

		result.actualValue = isFinite(minPitchMm) ? `最小${minPitchMm.toFixed(3)}mm` : '无BGA器件';
		if (violations.length > 0) {
			result.result = 'error';
			result.violations = violations;
		}
	}
	catch (error) {
		result.actualValue = '检查失败';
		result.result = 'warning';
	}

	return result;
}


 return async (kind:DfmKind):Promise<CheckResult[]> => kind==='pcb'?runPcb():kind==='smt'?runSmt():[await checkSameNetPadSpacing(eda,params.minSpacingMm??0.2,(issue:DfmIssue)=>issues.push(issue))];
}

