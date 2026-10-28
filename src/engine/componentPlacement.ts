import JSZip from 'jszip';

interface DeviceRef { libraryUuid: string; uuid: string }

interface PlacementApi {
	lib_Device: {
		getByLcscIds: (ids: Array<string>, libraryUuid?: string) => Promise<Array<any> | null | undefined>;
		get: (uuid: string, libraryUuid: string) => Promise<any>;
	};
	sch_PrimitiveComponent: {
		create: (...args: Array<any>) => Promise<any>;
		get: (id: string) => Promise<any>;
		getAllPinsByPrimitiveId: (id: string) => Promise<Array<any> | null | undefined>;
	};
	dmt_SelectControl: {
		getCurrentDocumentInfo: () => Promise<any>;
	};
	sys_FileManager: {
		getDocumentFootprintSources: () => Promise<Array<{ footprintUuid: string; documentSource: string }> | null | undefined>;
		getProjectFile: (fileName?: string, password?: string, fileType?: 'epro' | 'epro2') => Promise<File | undefined>;
	};
}

function stateValue(object: any, getter: string): any {
	const fn = object?.[getter];
	if (typeof fn !== 'function')
		throw new Error(`读回对象缺少 ${getter}`);
	return fn.call(object);
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new Error(`${label} 缺失或无效`);
	return value;
}

function sameFocus(a: any, b: any): boolean {
	return a?.documentType === 1 && b?.documentType === 1
		&& typeof a?.uuid === 'string' && a.uuid.trim() !== ''
		&& a.uuid === b.uuid
		&& typeof a?.parentProjectUuid === 'string' && a.parentProjectUuid.trim() !== ''
		&& a.parentProjectUuid === b.parentProjectUuid;
}

async function requireFocus(api: PlacementApi, before: any, phase: string, partial: boolean): Promise<void> {
	let current: any;
	try {
		current = await api.dmt_SelectControl.getCurrentDocumentInfo();
	}
	catch (error) {
		fail(`${phase}时读取焦点失败：${String((error as any)?.message ?? error)}`, phase, partial, undefined, error);
	}
	if (!sameFocus(current, before))
		throw placementError(`${phase}时焦点原理图或所属工程已改变`, partial, phase);
}

function placementError(message: string, partial: boolean, phase: string, primitiveId?: string, cause?: unknown): Error {
	const error = new Error(message) as Error & { partial: boolean; retryable: boolean };
	error.partial = partial;
	error.retryable = false;
	error.cause = {
		partial,
		retryable: false,
		operation: 'schematic.placeDevice',
		phase,
		...(primitiveId ? { primitiveId } : {}),
		...(cause === undefined ? {} : { operationError: String((cause as any)?.message ?? cause) }),
	};
	return error;
}

function fail(message: string, phase: string, partial: boolean, primitiveId?: string, cause?: unknown): never {
	throw placementError(message, partial, phase, primitiveId, cause);
}

function readLibraryFootprint(device: any): { footprintUuid: string; libraryUuid: string } | null {
	const association = device?.association;
	if (!association || typeof association !== 'object' || Array.isArray(association))
		throw new Error('完整库器件缺少有效 association 对象');
	const flat = association.footprintUuid;
	const nested = association.footprint;
	if (nested != null && (typeof nested !== 'object' || Array.isArray(nested)))
		throw new Error('库器件 association.footprint 结构无效');
	const nestedUuid = nested?.uuid;
	const flatUuid = flat == null || flat === '' ? '' : requireString(flat, '库器件 footprintUuid');
	const nestedFootprintUuid = nestedUuid == null || nestedUuid === '' ? '' : requireString(nestedUuid, '库器件 association.footprint.uuid');
	if (flatUuid && nestedFootprintUuid && flatUuid !== nestedFootprintUuid)
		throw new Error(`库器件平铺与嵌套封装 UUID 冲突（${flatUuid} / ${nestedFootprintUuid}）`);
	const footprintUuid = flatUuid || nestedFootprintUuid;
	if (!footprintUuid)
		return null;
	if (nested != null && !nestedFootprintUuid)
		throw new Error('库器件 association.footprint 存在但缺少 uuid，无法与平铺封装关联核对');
	const libraryUuid = nested != null
		? requireString(nested.libraryUuid, '库器件 association.footprint.libraryUuid')
		: requireString(device?.libraryUuid, '库器件 libraryUuid');
	return { footprintUuid, libraryUuid };
}

interface ParsedFootprint {
	footprintUuid: string;
	sourceFootprintUuid: string;
	sourceLibraryUuid: string;
	pads: Map<string, Array<string>>;
	nonElectricalPads: Array<string>;
}

function parseFootprintSource(source: unknown): ParsedFootprint {
	if (typeof source !== 'string' || !source.trim())
		throw new Error('封装 documentSource 为空或非法');
	const rows: Array<Array<any>> = [];
	for (const [index, line] of source.split(/\r?\n/).entries()) {
		if (!line.trim())
			continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		}
		catch (error) {
			throw new Error(`封装源码第 ${index + 1} 行不是有效 JSON：${String((error as any)?.message ?? error)}`);
		}
		if (!Array.isArray(row) || typeof row[0] !== 'string')
			throw new Error(`封装源码第 ${index + 1} 行不是受支持的数组记录`);
		rows.push(row);
	}
	const doctype = rows.filter(row => row[0] === 'DOCTYPE');
	const heads = rows.filter(row => row[0] === 'HEAD' || row[0] === 'DOCHEAD');
	if (doctype.length !== 1 || doctype[0][1] !== 'FOOTPRINT' || typeof doctype[0][2] !== 'string')
		throw new Error('封装源码缺少唯一且受支持的 DOCTYPE FOOTPRINT 记录');
	if (heads.length !== 1 || !heads[0][1] || typeof heads[0][1] !== 'object' || Array.isArray(heads[0][1]))
		throw new Error('封装源码缺少唯一且有效的 HEAD/DOCHEAD 记录');
	const head = heads[0][1] as Record<string, unknown>;
	const footprintUuid = requireString(head.uuid, '封装 HEAD.uuid');
	const sourceText = requireString(head.source, '封装 HEAD.source');
	const sourceParts = sourceText.split('|');
	if (sourceParts.length !== 2)
		throw new Error('封装 HEAD.source 必须明确包含 库封装UUID|库UUID');
	const sourceFootprintUuid = requireString(sourceParts[0], '封装 HEAD.source 库封装 UUID');
	const sourceLibraryUuid = requireString(sourceParts[1], '封装 HEAD.source 库 UUID');
	const pads = new Map<string, Array<string>>();
	const nonElectricalPads: Array<string> = [];
	const padIds = new Set<string>();
	for (const row of rows.filter(item => item[0] === 'PAD')) {
		if (row.length < 6)
			throw new Error('封装 PAD 记录字段不足，无法读取编号');
		const id = requireString(row[1], '封装 PAD 图元 ID');
		if (padIds.has(id))
			throw new Error(`封装源码存在重复 PAD 图元 ID ${id}`);
		padIds.add(id);
		const rawNumber = typeof row[5] === 'number' ? String(row[5]) : row[5];
		if (rawNumber == null || rawNumber === '') {
			nonElectricalPads.push(id);
			continue;
		}
		const number = requireString(rawNumber, `封装 PAD ${id} 编号`);
		pads.set(number, [...(pads.get(number) ?? []), id]);
	}
	return { footprintUuid, sourceFootprintUuid, sourceLibraryUuid, pads, nonElectricalPads };
}

async function findProjectFootprint(api: PlacementApi, footprintUuid: string, primitiveId: string, focus: any, phase: string, partial: boolean): Promise<{ footprintUuid: string; sourceFootprintUuid: string; sourceLibraryUuid: string; pads: Map<string, Array<string>>; nonElectricalPads: Array<string>; resourceOrigin: 'project-export-epro'; resourcePath: string }> {
	const resourcePath = `FOOTPRINT/${footprintUuid}.efoo`;
	await requireFocus(api, focus, `${phase}导出前`, partial);
	let projectFile: File | undefined;
	try {
		projectFile = await api.sys_FileManager.getProjectFile(undefined, undefined, 'epro');
	}
	catch (error) {
		fail(`导出工程 epro 失败：${String((error as any)?.message ?? error)}`, `${phase}-project-export`, partial, primitiveId, error);
	}
	if (!projectFile || typeof projectFile.arrayBuffer !== 'function')
		fail('导出工程 epro 返回空文件或不支持 arrayBuffer', `${phase}-project-export`, partial, primitiveId);
	await requireFocus(api, focus, `${phase}导出后`, partial);
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(await projectFile.arrayBuffer());
	}
	catch (error) {
		fail(`工程 epro ZIP 解析失败：${String((error as any)?.message ?? error)}`, `${phase}-project-zip`, partial, primitiveId, error);
	}
	const entry = zip.file(resourcePath);
	if (!entry)
		fail(`工程 epro 缺少封装资源 ${resourcePath}`, `${phase}-project-footprint`, partial, primitiveId);
	let source: string;
	try {
		source = await entry.async('string');
	}
	catch (error) {
		fail(`读取工程封装资源 ${resourcePath} 失败：${String((error as any)?.message ?? error)}`, `${phase}-project-footprint`, partial, primitiveId, error);
	}
	const parsed = parseFootprintSource(source);
	if (parsed.footprintUuid !== footprintUuid)
		fail(`工程封装资源路径 UUID 与 HEAD.uuid 不一致（path=${footprintUuid}, HEAD=${parsed.footprintUuid}）`, `${phase}-project-footprint`, partial, primitiveId);
	const instanceAfterExport = await api.sch_PrimitiveComponent.get(primitiveId);
	if (!instanceAfterExport)
		fail(`工程导出后无法独立读取器件实例 ${primitiveId}`, `${phase}-instance-readback`, partial, primitiveId);
	const afterFootprint = stateValue(instanceAfterExport, 'getState_Footprint');
	const afterUuid = typeof afterFootprint?.uuid === 'string' && afterFootprint.uuid ? afterFootprint.uuid : '';
	if (afterUuid !== footprintUuid)
		fail(`工程导出后实例封装 UUID 改变（before=${footprintUuid}, after=${afterUuid || '空'}）`, `${phase}-instance-readback`, partial, primitiveId);
	await requireFocus(api, focus, `${phase}核验结束`, partial);
	return { ...parsed, resourceOrigin: 'project-export-epro', resourcePath };
}

export async function getProjectFootprintDiagnostic(api: PlacementApi, footprintUuid: string, primitiveId: string, focus: any) {
	const resource = await findProjectFootprint(api, footprintUuid, primitiveId, focus, 'diagnostic-project-footprint', false);
	return {
		origin: resource.resourceOrigin,
		path: resource.resourcePath,
		headUuid: resource.footprintUuid,
		sourceFootprintUuid: resource.sourceFootprintUuid,
		sourceLibraryUuid: resource.sourceLibraryUuid,
		padNumbers: [...resource.pads.keys()],
		nonElectricalPadPrimitiveIds: resource.nonElectricalPads,
	};
}

export async function placeDeviceSafely(api: PlacementApi, params: Record<string, any>) {
	if (params.x == null || params.y == null)
		fail('缺少坐标参数 x / y', 'validate', false);
	let focus: any;
	try {
		focus = await api.dmt_SelectControl.getCurrentDocumentInfo();
	}
	catch (error) {
		fail(`读取初始焦点失败：${String((error as any)?.message ?? error)}`, 'focus-before-library', false, undefined, error);
	}
	if (focus?.documentType !== 1 || typeof focus?.uuid !== 'string' || !focus.uuid.trim() || typeof focus?.parentProjectUuid !== 'string' || !focus.parentProjectUuid.trim())
		fail('当前焦点不是带有效工程 UUID 的原理图页', 'focus-before-library', false);

	let ref: DeviceRef;
	let requestedLcscId: string | undefined;
	let requestedLibraryUuid: string | undefined;
	try {
		if (params.lcscId) {
			requestedLcscId = String(params.lcscId);
			if (params.libraryUuid != null) {
				requestedLibraryUuid = requireString(params.libraryUuid, '请求 libraryUuid');
			}
			const items = requestedLibraryUuid
				? await api.lib_Device.getByLcscIds([requestedLcscId], requestedLibraryUuid)
				: await api.lib_Device.getByLcscIds([requestedLcscId]);
			if (!items?.[0])
				fail(`未找到立创编号为 ${requestedLcscId}${requestedLibraryUuid ? `（库 ${requestedLibraryUuid}）` : ''} 的器件`, 'resolve-device', false);
			const selectedLibraryUuid = requireString(items[0].libraryUuid, '立创器件 libraryUuid');
			const selectedDeviceUuid = requireString(items[0].uuid, '立创器件 uuid');
			if (requestedLibraryUuid && selectedLibraryUuid !== requestedLibraryUuid)
				fail(`立创器件搜索返回了非请求库的结果（want ${requestedLibraryUuid}, got ${selectedLibraryUuid}）`, 'resolve-device', false);
			ref = { libraryUuid: selectedLibraryUuid, uuid: selectedDeviceUuid };
		}
		else if (params.deviceUuid && params.libraryUuid) {
			requestedLibraryUuid = requireString(params.libraryUuid, '请求 libraryUuid');
			ref = { libraryUuid: requestedLibraryUuid, uuid: String(params.deviceUuid) };
		}
		else {
			fail('需要提供 lcscId，或 deviceUuid + libraryUuid', 'resolve-device', false);
		}
	}
	catch (error) {
		if ((error as any)?.cause?.operation === 'schematic.placeDevice')
			throw error;
		fail(`解析器件引用失败：${String((error as any)?.message ?? error)}`, 'resolve-device', false, undefined, error);
	}

	let device: any;
	let expected: ReturnType<typeof readLibraryFootprint>;
	try {
		device = await api.lib_Device.get(ref.uuid, ref.libraryUuid);
		if (!device)
			fail(`无法读取完整库器件 ${ref.uuid}`, 'read-library-device', false);
		if (requireString(device.uuid, '完整库器件 uuid') !== ref.uuid)
			fail(`完整库器件 UUID 与请求不符（want ${ref.uuid}, got ${device.uuid}）`, 'read-library-device', false);
		if (requireString(device.libraryUuid, '完整库器件 libraryUuid') !== ref.libraryUuid)
			fail(`完整库器件 libraryUuid 与请求不符（want ${ref.libraryUuid}, got ${device.libraryUuid}）`, 'read-library-device', false);
		expected = readLibraryFootprint(device);
	}
	catch (error) {
		if ((error as any)?.cause?.operation === 'schematic.placeDevice')
			throw error;
		fail(`完整库器件封装关联读取失败：${String((error as any)?.message ?? error)}`, 'read-library-device', false, undefined, error);
	}
	await requireFocus(api, focus, '调用 create 前', false);

	let attempted = false;
	let primitiveId: string | undefined;
	try {
		attempted = true;
		const created = await api.sch_PrimitiveComponent.create(
			ref,
			Number(params.x),
			Number(params.y),
			params.subPartName ? String(params.subPartName) : undefined,
			params.rotation != null ? Number(params.rotation) : undefined,
			params.mirror != null ? Boolean(params.mirror) : undefined,
			params.addIntoBom != null ? Boolean(params.addIntoBom) : true,
			params.addIntoPcb != null ? Boolean(params.addIntoPcb) : true,
		);
		if (!created)
			fail('器件放置失败（官方返回空）', 'create', true);
		primitiveId = requireString(stateValue(created, 'getState_PrimitiveId'), '新建器件 primitiveId');
		const designator = stateValue(created, 'getState_Designator');
		await requireFocus(api, focus, 'create 后独立读回前', true);
		const back = await api.sch_PrimitiveComponent.get(primitiveId);
		if (!back)
			fail(`器件 ${primitiveId} 创建后无法独立读回`, 'instance-readback', true, primitiveId);
		const actualFootprint = stateValue(back, 'getState_Footprint');
		const instanceFootprintUuid = actualFootprint?.uuid == null || actualFootprint.uuid === '' ? '' : requireString(actualFootprint.uuid, '实例 getState_Footprint().uuid');
		let footprintReadback: Record<string, unknown>;
		let pinPadMap: Record<string, Array<string>> | undefined;
		let pinPadMapVerified = false;
		let electricalMapping: 'verified' | 'none' | undefined;
		if (!expected && !instanceFootprintUuid) {
			footprintReadback = { libraryFootprint: 'none', expectedLibraryFootprintUuid: null, projectUuid: null, resourceVerified: false, actualFootprintUuid: null };
		}
		else if (!expected) {
			const resource = await findProjectFootprint(api, instanceFootprintUuid, primitiveId, focus, 'footprint-resource', true);
			footprintReadback = {
				libraryFootprint: 'none',
				expectedLibraryFootprintUuid: null,
				// Contract field name retained: this value is the in-project footprint UUID, not focus.parentProjectUuid.
				projectUuid: resource.footprintUuid,
				actualFootprintUuid: instanceFootprintUuid,
				resourceSource: `${resource.sourceFootprintUuid}|${resource.sourceLibraryUuid}`,
				resourceOrigin: resource.resourceOrigin,
				resourcePath: resource.resourcePath,
				resourceVerified: true,
			};
		}
		else {
			if (!instanceFootprintUuid)
				fail('库器件有预期封装，但实例 getState_Footprint().uuid 为空', 'instance-footprint', true, primitiveId);
			const resource = await findProjectFootprint(api, instanceFootprintUuid, primitiveId, focus, 'footprint-resource', true);
			if (resource.sourceFootprintUuid !== expected.footprintUuid || resource.sourceLibraryUuid !== expected.libraryUuid)
				fail(`工程封装资源 source 与库关联不符（want ${expected.footprintUuid}|${expected.libraryUuid}, got ${resource.sourceFootprintUuid}|${resource.sourceLibraryUuid}）`, 'footprint-source-match', true, primitiveId);
			const pins = await api.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
			if (!Array.isArray(pins))
				fail('读取实例引脚返回非法结构', 'pin-pad-map', true, primitiveId);
			if (pins.length === 0 && resource.pads.size > 0)
				fail('实例没有符号引脚，但预期封装有编号 PAD；引脚映射无法确认', 'pin-pad-map', true, primitiveId);
			const map = new Map<string, Array<string>>();
			for (const pin of pins) {
				const number = requireString(stateValue(pin, 'getState_PinNumber'), '实例引脚编号');
				requireString(stateValue(pin, 'getState_PrimitiveId'), `实例引脚 ${number} primitiveId`);
				const pads = resource.pads.get(number);
				if (!pads?.length)
					fail(`实例引脚 ${number} 在预期库封装 PAD 编号中无对应项`, 'pin-pad-map', true, primitiveId);
				map.set(number, [...new Set([...(map.get(number) ?? []), ...pads])]);
			}
			if (pins.length > 0) {
				pinPadMap = Object.fromEntries([...map.entries()].map(([number, padIds]) => [number, padIds]));
				pinPadMapVerified = true;
				electricalMapping = 'verified';
			}
			else {
				electricalMapping = 'none';
			}
			footprintReadback = {
				libraryFootprint: 'present',
				expectedLibraryFootprintUuid: expected.footprintUuid,
				// Contract field name retained: this value is the in-project footprint UUID, not focus.parentProjectUuid.
				projectUuid: resource.footprintUuid,
				actualFootprintUuid: instanceFootprintUuid,
				resourceSource: `${resource.sourceFootprintUuid}|${resource.sourceLibraryUuid}`,
				resourceOrigin: resource.resourceOrigin,
				resourcePath: resource.resourcePath,
				resourceVerified: true,
				nonElectricalPadPrimitiveIds: resource.nonElectricalPads,
			};
		}
		await requireFocus(api, focus, '放置读回结束时', true);
		return {
			primitiveId,
			designator,
			device: {
				requestedLcscId: requestedLcscId ?? null,
				requestedLibraryUuid: requestedLibraryUuid ?? null,
				selectedDeviceUuid: ref.uuid,
				selectedLibraryUuid: ref.libraryUuid,
			},
			placementVerified: true,
			footprintVerified: Boolean(expected && footprintReadback.resourceVerified === true),
			footprintStatus: expected
				? (footprintReadback.resourceVerified === true ? 'verified' : 'unverified')
				: (instanceFootprintUuid ? 'unexpected-instance-footprint' : 'missing'),
			pcbReady: Boolean(expected && footprintReadback.resourceVerified === true && pinPadMapVerified),
			pcbReadyScope: 'footprint-and-instance-pin-pad-map-only',
			warnings: expected ? [] : [
				'器件未关联可核验的库封装；如需用于 PCB，请明确选择带封装的库器件后重新放置。插件不会自动替换器件。',
			],
			readback: {
				footprint: footprintReadback,
				...(pinPadMap ? { pinPadMap } : {}),
				...(pinPadMap ? { pinMapScope: 'placed-instance-only' } : {}),
				pinPadMapVerified,
				...(electricalMapping ? { electricalMapping } : {}),
				// Compatibility field: verifies successful placement and instance readback only.
				verified: true,
				persistenceVerified: false,
			},
		};
	}
	catch (error) {
		if (!attempted)
			throw error;
		if ((error as any)?.cause?.partial === true && (error as any)?.cause?.operation === 'schematic.placeDevice') {
			if (primitiveId && !(error as any).cause.primitiveId)
				(error as any).cause = { ...(error as any).cause, primitiveId };
			throw error;
		}
		fail(`器件放置后核验失败：${String((error as any)?.message ?? error)}`, (error as any)?.cause?.phase ?? 'post-create', true, primitiveId, error);
	}
}
