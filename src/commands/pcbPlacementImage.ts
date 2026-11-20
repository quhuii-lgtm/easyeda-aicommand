import type { ICommandContext, ICommandDef } from '../engine/types';
import { parseSourceLog, resolveRecords } from '../pcb/sourcelog';

type ImageLayer = number;

const IMAGE_LAYER_IDS = new Set<number>([
	1,
	2,
	...Array.from({ length: 30 }, (_, index) => index + 15),
	3,
	4,
	5,
	6,
	9,
	10,
	13,
	14,
	56,
	...Array.from({ length: 30 }, (_, index) => index + 71),
]);

const targetParams = [
	{ name: '__docUuid', type: 'string', description: '可选目标 PCB 页 UUID；必须与当前焦点页一致。不会切换页面。' },
	{ name: '__projectUuid', type: 'string', description: '可选目标工程 UUID；必须与当前 PCB 所属工程一致。' },
];

function ensureOnly(params: Record<string, any>, allowed: string[]): void {
	const unexpected = Object.keys(params).filter(key => !allowed.includes(key) && key !== '__docUuid' && key !== '__projectUuid' && key !== '__tabId');
	if (unexpected.length)
		throw new Error(`不支持的图片参数：${unexpected.join(', ')}`);
}

function number(value: unknown, label: string, positive = false): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0))
		throw new Error(`${label} 必须是${positive ? '大于 0 的' : ''}有限数值`);
	return value;
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== 'boolean')
		throw new Error(`${label} 必须是布尔值`);
	return value;
}

function required<T>(image: any, getter: string, label: string): T {
	const fn = image?.[`getState_${getter}`];
	if (typeof fn !== 'function')
		throw new Error(`${label} 缺少 ${getter} 读回接口`);
	const value = fn.call(image);
	if (value === undefined || value === null)
		throw new Error(`${label} 的 ${getter} 读回为空`);
	return value as T;
}

function decodeImageBase64(value: unknown, expectedWidth: number, expectedHeight: number): Uint8Array {
	if (typeof value !== 'string' || !value.trim())
		throw new Error('imageBase64 必须是 PNG 文件的 Base64 内容，不含本地路径');
	const encoded = value.trim().replace(/^data:image\/png;base64,/i, '');
	if (!/^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i.test(encoded))
		throw new Error('imageBase64 不是有效的 PNG Base64 内容');
	let binary: string;
	try {
		binary = atob(encoded);
	}
	catch (error) {
		throw new Error(`PNG Base64 解码失败：${error instanceof Error ? error.message : String(error)}`);
	}
	if (binary.length < 24)
		throw new Error('PNG 数据长度不足，无法读取图片尺寸');
	const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
	const signature = [137, 80, 78, 71, 13, 10, 26, 10];
	if (!signature.every((byte, index) => bytes[index] === byte) || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR')
		throw new Error('imageBase64 内容不是有效 PNG');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const actualWidth = view.getUint32(16);
	const actualHeight = view.getUint32(20);
	if (actualWidth !== expectedWidth || actualHeight !== expectedHeight)
		throw new Error(`PNG 实际尺寸为 ${actualWidth}×${actualHeight} 像素，与 imageWidth/imageHeight 不一致`);
	return bytes;
}

function readImage(image: any) {
	return {
		primitiveId: String(required(image, 'PrimitiveId', 'PCB 图片')),
		x: number(required(image, 'X', 'PCB 图片'), '图片 X'),
		y: number(required(image, 'Y', 'PCB 图片'), '图片 Y'),
		layer: number(required(image, 'Layer', 'PCB 图片'), '图片层'),
		width: number(required(image, 'Width', 'PCB 图片'), '图片宽度', true),
		height: number(required(image, 'Height', 'PCB 图片'), '图片高度', true),
		rotation: number(required(image, 'Rotation', 'PCB 图片'), '图片角度'),
		horizonMirror: boolean(required(image, 'HorizonMirror', 'PCB 图片'), '图片水平镜像状态'),
		primitiveLock: boolean(required(image, 'PrimitiveLock', 'PCB 图片'), '图片锁定状态'),
	};
}

async function readImageSourcePath(imageId: string, ctx: ICommandContext): Promise<unknown> {
	await ctx.assertDocumentTarget?.();
	const source = await eda.sys_FileManager.getDocumentSource();
	if (typeof source !== 'string' || !source.trim())
		throw new Error('当前 PCB 源码读回为空');
	const document = parseSourceLog(source);
	if (document.docType !== 'PCB' || document.uuid !== ctx.documentTarget?.uuid)
		throw new Error(`PCB 源码身份与当前目标不一致（source=${document.uuid}, target=${ctx.documentTarget?.uuid ?? 'unknown'}）`);
	const record = resolveRecords(document, 'IMAGE').get(`IMAGE\u0000${imageId}`);
	if (!record || !record.data || typeof record.data !== 'object' || !Array.isArray((record.data as Record<string, unknown>).path))
		throw new Error(`PCB 源码中未读到图片 ${imageId} 的有效 path`);
	await ctx.assertDocumentTarget?.();
	return (record.data as Record<string, unknown>).path;
}

async function validateImageLayer(layer: number, ctx: ICommandContext): Promise<void> {
	if (!Number.isInteger(layer) || !IMAGE_LAYER_IDS.has(layer))
		throw new Error(`图片层 ${layer} 不是官方支持的图片图层 ID`);
	await ctx.assertDocumentTarget?.();
	const layers = await eda.pcb_Layer.getAllLayers();
	if (!Array.isArray(layers))
		throw new Error('当前 PCB 图层列表读回不完整，无法确认图片层');
	if (!layers.some((item: any) => item?.id === layer))
		throw new Error(`图片层 ${layer} 不存在于当前 PCB`);
	await ctx.assertDocumentTarget?.();
}

function sameSourcePath(expected: unknown, actual: unknown): boolean {
	return JSON.stringify(expected) === JSON.stringify(actual);
}

function failedAfterWrite(command: string, phase: string, imageId: string | undefined, error: unknown): Error {
	return new Error(`${command} 已调用宿主写入，但${phase}未确认；请先检查当前 PCB，不要重发。${error instanceof Error ? error.message : String(error)}`, {
		cause: { partial: true, retryable: false, phase, imageId: imageId ?? null },
	});
}

async function requireImage(imageId: string): Promise<any> {
	const image = await eda.pcb_PrimitiveImage.get(imageId);
	if (!image || required(image, 'PrimitiveId', 'PCB 图片') !== imageId)
		throw new Error(`未读到指定 PCB 图片 ${imageId}`);
	return image;
}

function requireTarget(ctx?: ICommandContext): asserts ctx is ICommandContext & { documentTarget: NonNullable<ICommandContext['documentTarget']>; assertDocumentTarget: () => Promise<void> } {
	if (!ctx?.documentTarget || ctx.documentTarget.documentType !== 3 || !ctx.documentTarget.uuid || !ctx.assertDocumentTarget)
		throw new Error('缺少当前 PCB 目标身份校验，拒绝操作图片');
}

export const pcbPlacementImageCommands: Array<ICommandDef> = [
	{
		name: 'pcb.placeImage',
		summary: '将 PNG 位图描摹为矢量轮廓并按坐标放入 PCB；颜色照片会转成轮廓，不保留真彩。',
		params: [
			{ name: 'imageBase64', type: 'string', required: true, description: 'PNG 文件原始 Base64 内容，可带 data:image/png;base64, 前缀；不接受文件路径。' },
			{ name: 'imageWidth', type: 'number', required: true, description: 'PNG 原始像素宽度；须与文件尺寸一致。' },
			{ name: 'imageHeight', type: 'number', required: true, description: 'PNG 原始像素高度；须与文件尺寸一致。' },
			{ name: 'x', type: 'number', required: true, description: '图片边界框左上角 X，单位 mil。' },
			{ name: 'y', type: 'number', required: true, description: '图片边界框左上角 Y，单位 mil。' },
			{ name: 'layer', type: 'number', required: true, description: '图片所在层 ID；用 pcb.listLayers 确认。' },
			{ name: 'width', type: 'number', required: true, description: '放置宽度，单位 mil。' },
			{ name: 'height', type: 'number', required: true, description: '放置高度，单位 mil。' },
			{ name: 'rotation', type: 'number', description: '旋转角度，默认 0。' },
			{ name: 'horizonMirror', type: 'boolean', description: '是否水平镜像，默认 false。' },
			{ name: 'primitiveLock', type: 'boolean', description: '是否锁定图元，默认 false。' },
			{ name: 'tolerance', type: 'number', description: '官方描摹容差 0–1，默认 0。' },
			{ name: 'simplification', type: 'number', description: '官方描摹简化值 0–1，默认 0。' },
			{ name: 'smoothing', type: 'number', description: '官方描摹平滑值 0–1.33，默认 0。' },
			{ name: 'despeckling', type: 'number', description: '官方描摹去斑值 0–5，默认 0。' },
			{ name: 'whiteAsBackgroundColor', type: 'boolean', description: '是否把白色视为背景，默认 false。' },
			{ name: 'inversion', type: 'boolean', description: '是否反相，默认 false。' },
			...targetParams,
		],
		returns: '{ primitiveId, image:{x,y,layer,width,height,rotation,horizonMirror,primitiveLock}, vectorContours }；确认宿主对象已创建并按 ID 读回，不代表保存重开已验证。',
		example: { cmd: 'pcb.placeImage', params: { imageBase64: '...', imageWidth: 64, imageHeight: 64, x: 100, y: 100, layer: 3, width: 200, height: 200 } },
		handler: async (params, ctx) => {
			ensureOnly(params, ['imageBase64', 'imageWidth', 'imageHeight', 'x', 'y', 'layer', 'width', 'height', 'rotation', 'horizonMirror', 'primitiveLock', 'tolerance', 'simplification', 'smoothing', 'despeckling', 'whiteAsBackgroundColor', 'inversion']);
			requireTarget(ctx);
			const imageWidth = number(params.imageWidth, 'PNG 像素宽度', true);
			const imageHeight = number(params.imageHeight, 'PNG 像素高度', true);
			const bytes = decodeImageBase64(params.imageBase64, imageWidth, imageHeight);
			const x = number(params.x, '图片 X');
			const y = number(params.y, '图片 Y');
			const layer = number(params.layer, '图片层') as ImageLayer;
			const width = number(params.width, '图片宽度', true);
			const height = number(params.height, '图片高度', true);
			const rotation = params.rotation === undefined ? 0 : number(params.rotation, '图片角度');
			const horizonMirror = params.horizonMirror === undefined ? false : boolean(params.horizonMirror, 'horizonMirror');
			const primitiveLock = params.primitiveLock === undefined ? false : boolean(params.primitiveLock, 'primitiveLock');
			const range = (key: 'tolerance' | 'simplification' | 'smoothing' | 'despeckling', max: number) => {
				const value = params[key] === undefined ? 0 : number(params[key], key);
				if (value < 0 || value > max)
					throw new Error(`${key} 必须在 0–${max} 范围内`);
				return value;
			};
			const tolerance = range('tolerance', 1);
			const simplification = range('simplification', 1);
			const smoothing = range('smoothing', 1.33);
			const despeckling = range('despeckling', 5);
			const whiteAsBackgroundColor = params.whiteAsBackgroundColor === undefined ? false : boolean(params.whiteAsBackgroundColor, 'whiteAsBackgroundColor');
			const inversion = params.inversion === undefined ? false : boolean(params.inversion, 'inversion');
			await validateImageLayer(layer, ctx);
			await ctx.assertDocumentTarget();
			let complexPolygon: any;
			try {
				const blobBytes = new ArrayBuffer(bytes.byteLength);
				new Uint8Array(blobBytes).set(bytes);
				const blob = new Blob([blobBytes], { type: 'image/png' });
				complexPolygon = await eda.pcb_MathPolygon.convertImageToComplexPolygon(blob, imageWidth, imageHeight, tolerance, simplification, smoothing, despeckling, whiteAsBackgroundColor, inversion);
			}
			catch (error) {
				throw new Error(`PNG 描摹失败，未创建图元：${error instanceof Error ? error.message : String(error)}`);
			}
			if (!complexPolygon || typeof complexPolygon.getSourceStrictComplex !== 'function')
				throw new Error('PNG 未描摹出可放置轮廓，未创建图元');
			const polygonSource = complexPolygon.getSourceStrictComplex();
			if (!Array.isArray(polygonSource) || !polygonSource.length)
				throw new Error('PNG 描摹结果为空，未创建图元');
			await ctx.assertDocumentTarget();
			let created: any;
			try {
				created = await eda.pcb_PrimitiveImage.create(x, y, complexPolygon, layer, width, height, rotation, horizonMirror, primitiveLock);
			}
			catch (error) {
				throw failedAfterWrite('pcb.placeImage', '图像创建', undefined, error);
			}
			let primitiveId: string | undefined;
			try {
				if (!created)
					throw new Error('创建接口未返回图像对象');
				primitiveId = String(required(created, 'PrimitiveId', 'PCB 图片'));
				if (!primitiveId.trim())
					throw new Error('创建接口返回空 ID');
				await ctx.assertDocumentTarget();
				const image = await requireImage(primitiveId);
				const readback = readImage(image);
				const expected = { primitiveId, x, y, layer, width, height, rotation, horizonMirror, primitiveLock };
				const actual = { primitiveId: readback.primitiveId, x: readback.x, y: readback.y, layer: readback.layer, width: readback.width, height: readback.height, rotation: readback.rotation, horizonMirror: readback.horizonMirror, primitiveLock: readback.primitiveLock };
				if (JSON.stringify(actual) !== JSON.stringify(expected))
					throw new Error(`图像属性与请求不一致：${JSON.stringify({ expected, actual })}`);
				const sourcePath = await readImageSourcePath(primitiveId, ctx);
				if (!sameSourcePath(polygonSource, sourcePath))
					throw new Error('创建后图片源记录中的描摹轮廓与转换结果不一致');
				return { primitiveId, image: actual, vectorContours: polygonSource.length, imageKind: 'traced-vector', trueColorPreserved: false, sourcePathVerified: true, saved: false };
			}
			catch (error) {
				throw failedAfterWrite('pcb.placeImage', '按 ID 属性与轮廓读回', primitiveId, error);
			}
		},
	},
	{
		name: 'pcb.listImages',
		summary: '读取当前 PCB 图片图元的坐标、图层、尺寸、旋转、镜像和锁定属性。',
		params: [
			{ name: 'layer', type: 'number', description: '可选图层 ID；省略时读取全部图片。' },
			...targetParams,
		],
		returns: '{ count, images:[{primitiveId,x,y,layer,width,height,rotation,horizonMirror,primitiveLock}] }',
		example: { cmd: 'pcb.listImages' },
		handler: async (params, ctx) => {
			ensureOnly(params, ['layer']);
			requireTarget(ctx);
			const layer = params.layer === undefined ? undefined : number(params.layer, '图片层') as ImageLayer;
			await ctx.assertDocumentTarget();
			if (layer !== undefined)
				await validateImageLayer(layer, ctx);
			const objects = await eda.pcb_PrimitiveImage.getAll(layer);
			if (!Array.isArray(objects))
				throw new Error('PCB 图片列表读回不完整');
			const images = objects.map((object: any) => {
				const image = readImage(object);
				return { primitiveId: image.primitiveId, x: image.x, y: image.y, layer: image.layer, width: image.width, height: image.height, rotation: image.rotation, horizonMirror: image.horizonMirror, primitiveLock: image.primitiveLock };
			});
			await ctx.assertDocumentTarget();
			return { count: images.length, images };
		},
	},
	{
		name: 'pcb.modifyImage',
		summary: '只修改指定 PCB 图片明确传入的坐标、尺寸、图层、角度、镜像或锁定属性；按 ID 读回验证。',
		params: [
			{ name: 'primitiveId', type: 'string', required: true, description: '当前 PCB 的图片图元 ID。' },
			{ name: 'x', type: 'number', description: '新的左上角 X，单位 mil。' },
			{ name: 'y', type: 'number', description: '新的左上角 Y，单位 mil。' },
			{ name: 'layer', type: 'number', description: '新的图层 ID。' },
			{ name: 'width', type: 'number', description: '新的宽度，单位 mil。' },
			{ name: 'height', type: 'number', description: '新的高度，单位 mil。' },
			{ name: 'rotation', type: 'number', description: '新的旋转角度。' },
			{ name: 'horizonMirror', type: 'boolean', description: '新的水平镜像状态。' },
			{ name: 'primitiveLock', type: 'boolean', description: '新的锁定状态。' },
			...targetParams,
		],
		returns: '{ primitiveId, changedProperties }；仅确认属性已读回，不改变源图形轮廓，不代表保存重开已验证。',
		example: { cmd: 'pcb.modifyImage', params: { primitiveId: '图元ID', x: 120, y: 240, rotation: 90 } },
		handler: async (params, ctx) => {
			ensureOnly(params, ['primitiveId', 'x', 'y', 'layer', 'width', 'height', 'rotation', 'horizonMirror', 'primitiveLock']);
			requireTarget(ctx);
			if (typeof params.primitiveId !== 'string' || !params.primitiveId.trim())
				throw new Error('primitiveId 必须是非空图片图元 ID');
			const requested: Record<string, unknown> = {};
			for (const key of ['x', 'y', 'rotation'] as const) {
				if (params[key] !== undefined)
					requested[key] = number(params[key], key);
			}
			for (const key of ['width', 'height'] as const) {
				if (params[key] !== undefined)
					requested[key] = number(params[key], key, true);
			}
			if (params.layer !== undefined)
				requested.layer = number(params.layer, '图片层');
			if (params.horizonMirror !== undefined)
				requested.horizonMirror = boolean(params.horizonMirror, 'horizonMirror');
			if (params.primitiveLock !== undefined)
				requested.primitiveLock = boolean(params.primitiveLock, 'primitiveLock');
			if (!Object.keys(requested).length)
				throw new Error('请至少传入一个需要修改的图片属性');
			if (typeof requested.layer === 'number')
				await validateImageLayer(requested.layer, ctx);
			await ctx.assertDocumentTarget();
			await requireImage(params.primitiveId);
			const beforeSourcePath = await readImageSourcePath(params.primitiveId, ctx);
			await ctx.assertDocumentTarget();
			try {
				const result = await eda.pcb_PrimitiveImage.modify(params.primitiveId, requested as any);
				if (!result)
					throw new Error('宿主未返回修改后的图片对象');
			}
			catch (error) {
				throw failedAfterWrite('pcb.modifyImage', '图片修改', params.primitiveId, error);
			}
			try {
				await ctx.assertDocumentTarget();
				const image = await requireImage(params.primitiveId);
				const readback = readImage(image);
				for (const [key, value] of Object.entries(requested)) {
					if (readback[key as keyof typeof readback] !== value)
						throw new Error(`${key} 读回值与请求不一致：请求 ${String(value)}，实际 ${String(readback[key as keyof typeof readback])}`);
				}
				const afterSourcePath = await readImageSourcePath(params.primitiveId, ctx);
				if (!sameSourcePath(beforeSourcePath, afterSourcePath))
					throw new Error('修改属性时图片源记录中的描摹轮廓发生变化');
				return { primitiveId: params.primitiveId, changedProperties: requested, readback: { primitiveId: readback.primitiveId, x: readback.x, y: readback.y, layer: readback.layer, width: readback.width, height: readback.height, rotation: readback.rotation, horizonMirror: readback.horizonMirror, primitiveLock: readback.primitiveLock }, sourcePathVerified: true, saved: false };
			}
			catch (error) {
				throw failedAfterWrite('pcb.modifyImage', '按 ID 属性读回', params.primitiveId, error);
			}
		},
	},
];
