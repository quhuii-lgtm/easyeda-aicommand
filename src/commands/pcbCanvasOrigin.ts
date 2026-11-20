import type { ICommandContext, ICommandDef } from '../engine/types';

interface CanvasOrigin { offsetX: number; offsetY: number }

type PcbCommandContext = ICommandContext & { documentTarget: NonNullable<ICommandContext['documentTarget']>; assertDocumentTarget: () => Promise<void> };

function assertPcbTarget(ctx: ICommandContext | undefined): asserts ctx is PcbCommandContext {
	if (ctx?.documentTarget?.documentType !== 3 || !ctx.documentTarget.uuid || !ctx.assertDocumentTarget)
		throw new Error('缺少当前 PCB 目标身份校验，无法读取或设置画布原点');
}

function readOrigin(value: unknown): CanvasOrigin {
	if (!value || typeof value !== 'object')
		throw new Error('官方画布原点读回格式无效');
	const origin = value as Record<string, unknown>;
	if (typeof origin.offsetX !== 'number' || !Number.isFinite(origin.offsetX) || typeof origin.offsetY !== 'number' || !Number.isFinite(origin.offsetY))
		throw new Error('官方画布原点读回缺少有限的 offsetX/offsetY');
	return { offsetX: origin.offsetX, offsetY: origin.offsetY };
}

function sameOrigin(actual: CanvasOrigin, requested: CanvasOrigin): boolean {
	return Math.abs(actual.offsetX - requested.offsetX) <= 1e-9 && Math.abs(actual.offsetY - requested.offsetY) <= 1e-9;
}

export const pcbCanvasOriginCommands: ICommandDef[] = [
	{
		name: 'pcb.getCanvasOrigin',
		summary: '读取当前 PCB 画布原点相对数据原点的偏移；单位 mil，不移动设计图元；采用画布原点的制造导出坐标可能变化',
		params: [],
		returns: '{ offsetX, offsetY, unit:"mil", affectsPrimitiveCoordinates:false, manufacturingExportCoordinates:"may-change" }',
		example: { cmd: 'pcb.getCanvasOrigin' },
		handler: async (_params, ctx) => {
			for (const key of Object.keys(_params)) {
				if (!['instanceId', '__docUuid', '__tabId', '__projectUuid', '_timeoutMs'].includes(key) && !key.startsWith('__'))
					throw new Error(`未知参数: ${key}`);
			}
			assertPcbTarget(ctx);
			await ctx.assertDocumentTarget();
			const origin = readOrigin(await eda.pcb_Document.getCanvasOrigin());
			await ctx.assertDocumentTarget();
			return { ...origin, unit: 'mil', affectsPrimitiveCoordinates: false, manufacturingExportCoordinates: 'may-change', document: ctx.documentTarget };
		},
	},
	{
		name: 'pcb.setCanvasOrigin',
		summary: '设置当前 PCB 画布原点偏移；单位 mil，不移动设计图元；采用画布原点的制造导出坐标可能随之变化，交付前须核对',
		params: [
			{ name: 'offsetX', type: 'number', required: true, description: '画布原点相对数据原点的 X 偏移（mil）' },
			{ name: 'offsetY', type: 'number', required: true, description: '画布原点相对数据原点的 Y 偏移（mil）' },
		],
		returns: '{ changed:boolean, before:{offsetX,offsetY}, after:{offsetX,offsetY}, unit:"mil", affectsPrimitiveCoordinates:false, manufacturingExportCoordinates:"may-change" }；同值请求 changed:false，不重复写入。写入或读回无法确认时失败并标记 partial:true,retryable:false',
		example: { cmd: 'pcb.setCanvasOrigin', params: { offsetX: 0, offsetY: 0 } },
		handler: async (params, ctx) => {
			for (const key of Object.keys(params)) {
				if (!['offsetX', 'offsetY', 'instanceId', '__docUuid', '__tabId', '__projectUuid', '_timeoutMs'].includes(key) && !key.startsWith('__'))
					throw new Error(`未知参数: ${key}`);
			}
			if (typeof params.offsetX !== 'number' || !Number.isFinite(params.offsetX) || typeof params.offsetY !== 'number' || !Number.isFinite(params.offsetY))
				throw new Error('offsetX 与 offsetY 必须是有限数值（mil）');
			assertPcbTarget(ctx);
			const requested = { offsetX: params.offsetX, offsetY: params.offsetY };
			await ctx.assertDocumentTarget();
			const before = readOrigin(await eda.pcb_Document.getCanvasOrigin());
			await ctx.assertDocumentTarget();
			if (sameOrigin(before, requested))
				return { changed: false, before, after: before, unit: 'mil', affectsPrimitiveCoordinates: false, manufacturingExportCoordinates: 'may-change', document: ctx.documentTarget };

			let sdkResult: unknown;
			try {
				await ctx.assertDocumentTarget();
				sdkResult = await eda.pcb_Document.setCanvasOrigin(requested.offsetX, requested.offsetY);
			}
			catch (error) {
				throw new Error(`画布原点写入结果未知；请先读取当前偏移，不要重试：${error instanceof Error ? error.message : String(error)}`, { cause: { partial: true, retryable: false, phase: 'setCanvasOrigin', before, requested, document: ctx.documentTarget } });
			}
			let after: CanvasOrigin | undefined;
			try {
				await ctx.assertDocumentTarget();
				after = readOrigin(await eda.pcb_Document.getCanvasOrigin());
				await ctx.assertDocumentTarget();
			}
			catch (error) {
				throw new Error(`画布原点设置后读回未知；写入可能已生效，请先读取当前偏移，不要重试：${error instanceof Error ? error.message : String(error)}`, { cause: { partial: true, retryable: false, phase: 'setCanvasOrigin.readback', sdkResult, before, requested, document: ctx.documentTarget } });
			}
			if (sdkResult !== true || !sameOrigin(after, requested))
				throw new Error(`画布原点设置未获确认：SDK结果=${String(sdkResult)}，读回=${JSON.stringify(after)}；请先核对当前偏移，不要重试`, { cause: { partial: true, retryable: false, phase: 'setCanvasOrigin.verify', sdkResult, before, requested, after, document: ctx.documentTarget } });
			return { changed: true, before, after, unit: 'mil', affectsPrimitiveCoordinates: false, manufacturingExportCoordinates: 'may-change', document: ctx.documentTarget };
		},
	},
];
