import type { ICommandContext, ICommandDef } from '../engine/types';
import type { CopperCrossSection } from '../pcb/copperShapeReview';
import { comparePolygonSource } from '../pcb/autoCopper/geometryReadback';
import { analyzeCopperShape, sameCopperPath } from '../pcb/copperShapeReview';
import { comparePcbSourceSnapshots } from '../pcb/dsnSourceSnapshot';
import { effectiveRecordsByType, parseSourceLog } from '../pcb/sourcelog';

function read<T = unknown>(object: any, getter: string, label: string): T {
	if (typeof object?.[`getState_${getter}`] !== 'function')
		throw new Error(`${label} 缺少 ${getter} 读取接口`);
	const value = object[`getState_${getter}`]();
	if (value === undefined || value === null)
		throw new Error(`${label} 的 ${getter} 读回为空`);
	return value as T;
}
function finite(value: unknown, label: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new Error(`${label} 不是有限数值`);
	return value;
}
function pouredParentId(recordId: unknown): string | undefined {
	if (typeof recordId !== 'string')
		return undefined;
	try {
		const tuple = JSON.parse(recordId);
		return Array.isArray(tuple) && tuple.length === 2 && tuple[0] === 'POURED' && typeof tuple[1] === 'string' ? tuple[1] : undefined;
	}
	catch {
		return undefined;
	}
}
function pathSource(fill: any): unknown {
	const path = fill?.path;
	if (typeof path?.getSource === 'function')
		return path.getSource();
	return path;
}

export async function reviewCopperShape(params: Record<string, any>, ctx?: ICommandContext) {
	if (typeof params.primitiveId !== 'string' || !params.primitiveId.trim())
		throw new Error('primitiveId 必须是覆铜图元 ID');
	if (params.crossSections !== undefined && (!Array.isArray(params.crossSections) || params.crossSections.some((section: any) =>
		!section || typeof section.id !== 'string' || !section.id.trim() || !section.start || !section.end
		|| ![section.start.x, section.start.y, section.end.x, section.end.y].every((value: unknown) => Number.isFinite(value))))) {
		throw new Error('crossSections 必须是 {id,start:{x,y},end:{x,y}} 数组，坐标单位 mil');
	}
	const target = ctx?.documentTarget;
	if (!target || target.documentType !== 3 || !target.uuid || !ctx?.assertDocumentTarget)
		throw new Error('缺少当前 PCB 目标身份校验，拒绝生成铜皮报告');
	await ctx.assertDocumentTarget();
	const sdk = eda as any;
	const parentObject = await sdk.pcb_PrimitivePour.get(params.primitiveId);
	if (!parentObject)
		throw new Error(`找不到覆铜 ${params.primitiveId}`);
	const parentId = String(read(parentObject, 'PrimitiveId', '覆铜'));
	if (parentId !== params.primitiveId)
		throw new Error(`覆铜读取返回了不同图元 ${parentId}，拒绝分析`);
	const net = String(read(parentObject, 'Net', '覆铜'));
	const layer = finite(read(parentObject, 'Layer', '覆铜'), '覆铜层');
	const sourceText = await sdk.sys_FileManager.getDocumentSource();
	if (typeof sourceText !== 'string')
		throw new Error('PCB 当前编辑器源码读回不是文本');
	const document = parseSourceLog(sourceText);
	if (document.docType.toUpperCase() !== 'PCB' || document.uuid !== target.uuid)
		throw new Error('当前编辑器源码文档身份与目标 PCB 不符');
	const pours = effectiveRecordsByType(document, 'POUR');
	const pourRecord = pours.find(record => record.header.id === parentId);
	const sourcePour: any = pourRecord?.data;
	if (!sourcePour || sourcePour.netName !== net || sourcePour.layerId !== layer)
		throw new Error('当前覆铜的源码 ID、网络或层与 SDK 读回不符');
	const sourceBoundary = sourcePour.path;
	const sdkPolygon = read<any>(parentObject, 'ComplexPolygon', `覆铜 ${parentId}`);
	const sdkBoundary = typeof sdkPolygon?.getSource === 'function' ? sdkPolygon.getSource() : undefined;
	if (sdkBoundary === undefined || !(sameCopperPath(sourceBoundary, sdkBoundary) || comparePolygonSource(sourceBoundary, sdkBoundary).matches))
		throw new Error('覆铜边界与当前编辑器源码不匹配，拒绝分析');
	const pourType = sourcePour.pourType;
	const fineness = finite(pourType?.fineness, '覆铜精度 fineness');
	if (String(pourType?.pourType ?? '').toUpperCase() !== 'SOLID')
		throw new Error('仅支持已确认标定的 SOLID 覆铜');
	const allPoured = await sdk.pcb_PrimitivePoured.getAll();
	if (!Array.isArray(allPoured))
		throw new Error('实填充列表读回不是数组');
	const sourcePoured = effectiveRecordsByType(document, 'POURED').find(record => pouredParentId(record.header.id) === parentId)?.data as any;
	if (!sourcePoured || !Array.isArray(sourcePoured.pourFill))
		throw new Error('实填充的当前编辑器源码缺失或格式不完整');
	const pouredObject = allPoured.find((item: any) => read(item, 'PourPrimitiveId', '实填充') === parentId);
	if (!pouredObject)
		throw new Error('当前覆铜没有可关联的实填充对象');
	const sdkFills = read<any[]>(pouredObject, 'PourFills', '实填充');
	if (!Array.isArray(sdkFills))
		throw new Error('SDK 子填充列表不是数组');
	const sourceById = new Map<string, any>();
	for (const item of sourcePoured.pourFill) {
		if (typeof item?.id !== 'string' || sourceById.has(item.id))
			throw new Error('实填充源码缺少唯一子区 ID');
		sourceById.set(item.id, item);
	}
	const sdkById = new Map<string, any>();
	for (const item of sdkFills) {
		if (typeof item?.id !== 'string' || sdkById.has(item.id))
			throw new Error('SDK 实填充缺少唯一子区 ID');
		sdkById.set(item.id, item);
	}
	if (sdkById.size !== sourceById.size || [...sdkById.keys()].some(id => !sourceById.has(id)))
		throw new Error('SDK 与保存源码的实填充子区 ID 不一致');
	const verified = [...sdkById.entries()].map(([id, item]) => {
		const sourceFill = sourceById.get(id);
		const fill = item.fill;
		const width = finite(item.lineWidth, `填充 ${id} 线宽`);
		const sdkPath = pathSource(item);
		if (typeof fill !== 'boolean' || sourceFill.fill !== fill || sourceFill.strokeWidth !== width || !sameCopperPath(sdkPath, sourceFill.path))
			throw new Error(`填充 ${id} 的状态、宽度或路径与保存源码不一致`);
		return { id, path: sdkPath, fill, lineWidth: width };
	});
	await ctx.assertDocumentTarget();
	const report = analyzeCopperShape({ filledPaths: verified, fineness, crossSections: params.crossSections as CopperCrossSection[] | undefined });
	const sourceAfter = await sdk.sys_FileManager.getDocumentSource();
	if (!comparePcbSourceSnapshots(sourceText, sourceAfter).matches)
		throw new Error('铜形检查期间 PCB 当前编辑器内容发生变化，结果未确认');
	await ctx.assertDocumentTarget();
	return {
		...report,
		target,
		pour: { primitiveId: parentId, net, layer, fineness, matchedSource: true },
		readStatus: { sdk: 'read-and-matched', editorSourceSnapshot: 'read-before-and-after-matched', sdkChildCount: sdkById.size, diskPersistence: 'unknown-not-checked' },
		scope: '只分析指定覆铜当前可读的实填充几何；不判整网导通或全区最窄铜颈',
	};
}

export const copperShapeReviewCommands: ICommandDef[] = [{
	name: 'pcb.reviewCopperShape',
	summary: '只读分析指定 SOLID 覆铜的已填充轮廓、面积、边界、开放铜线和用户指定截面宽度；完整电气连通、孤岛及全区最窄处仍需其他证据',
	params: [
		{ name: 'primitiveId', type: 'string', required: true, description: '覆铜图元 ID' },
		{ name: 'crossSections', type: 'object[]', description: '可选截面 {id,start:{x,y},end:{x,y}}，输入坐标单位 mil' },
	],
	returns: '{ target, pour, regions, openStrokes, crossSections, unitEvidence, coverage, readStatus }',
	example: { cmd: 'pcb.reviewCopperShape', params: { primitiveId: 'POUR_ID', crossSections: [{ id: 'section-Y', start: { x: 3031.496, y: 5511.811 }, end: { x: 3089.37, y: 5511.811 } }] } },
	handler: reviewCopperShape,
}];
