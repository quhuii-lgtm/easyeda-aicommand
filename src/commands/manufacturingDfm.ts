import type { ICommandContext, ICommandDef } from '../engine/types';
import { layerKind, readArchive } from '../pcb/manufacturingPreflight';
import { auditPanelAssembly } from '../pcb/panelDfmAssembly';
import { readPanelFiles } from '../pcb/panelDfmFiles';
import { identifyMouseBiteCandidates, inspectDrillPasteOverlaps } from '../pcb/panelDfmHoles';
import { analyzeGerberMaskBridges } from '../pcb/panelDfmMask';
import { parseGerberLayerGeometry } from '../pcb/silkscreenGerber';

type AssemblyInputs = Omit<Parameters<typeof auditPanelAssembly>[0], 'outlineSegments'>;

async function readPasteArchive(base64: string, check: () => void) {
	const zip = await readArchive(base64);
	const layers = [];
	for (const layer of ['GTP', 'GBP'] as const) {
		const entries = Object.values(zip.files).filter(entry => !entry.dir && layerKind(entry.name).layer === layer);
		if (entries.length > 1)
			throw new Error(`归档中有多个 ${layer} 文件，请提供处理后的实际文件`);
		if (!entries.length)
			continue;
		check();
		layers.push(parseGerberLayerGeometry(layer, entries[0].name, await entries[0].async('string'), check));
	}
	return layers;
}

async function fileIdentity(base64: string) {
	const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return { bytes: bytes.length, sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
}

export async function inspectManufacturingDfm(input: {
	gerberBase64: string;
	object: 'single-board' | 'panel';
	assembly?: AssemblyInputs;
	artworkPasteBase64?: string;
	stencilBase64?: string;
	minimumMaskBridgeMm?: number;
}, ctx?: ICommandContext) {
	if (input.object !== 'single-board' && input.object !== 'panel')
		throw new Error('object 必须为 single-board 或 panel');
	if (typeof input.gerberBase64 !== 'string' || !input.gerberBase64)
		throw new Error('需要实际制造 Gerber ZIP');
	if (input.minimumMaskBridgeMm !== undefined && (!Number.isFinite(input.minimumMaskBridgeMm) || input.minimumMaskBridgeMm < 0))
		throw new Error('阻焊桥阈值必须为非负毫米数');
	const check = () => ctx?.stopSignal?.assertActive();
	const files = await readPanelFiles(input.gerberBase64, check);
	const maskLayers = [await files.read('GTS'), await files.read('GBS')].filter(layer => layer !== undefined);
	const mask = analyzeGerberMaskBridges(maskLayers, { check, minimumBridgeMil: input.minimumMaskBridgeMm === undefined ? undefined : input.minimumMaskBridgeMm / 0.0254 });
	const outlineSegments = files.outline.rings.flatMap(ring => ring.pointsMm.slice(1).flatMap((b, index) =>
		(['top', 'bottom'] as const).map(side => ({ a: ring.pointsMm[index], b, side, scope: 'panel' as const, id: `${ring.id}:${index + 1}` }))));
	const assembly = input.assembly ? auditPanelAssembly({ ...input.assembly, outlineSegments }) : null;
	const boardOutlineMm = files.outline.rings.map(ring => ({
		id: ring.id,
		pointsMm: ring.pointsMm.map(({ x, y }): [number, number] => [x, y]),
	}));
	const mouseBites = input.object === 'panel'
		? identifyMouseBiteCandidates({ drillHits: files.drillHits, boardOutlineMm, copperLayers: files.copperLayers })
		: null;
	const packagePaste = [await files.read('GTP'), await files.read('GBP')].filter(layer => layer !== undefined);
	const artworkPaste = input.artworkPasteBase64 ? await readPasteArchive(input.artworkPasteBase64, check) : packagePaste;
	const stencilPaste = input.stencilBase64 ? await readPasteArchive(input.stencilBase64, check) : [];
	const comparePaste = (pasteLayers: typeof packagePaste, pasteBasis: 'artwork' | 'stencil-file') => {
		if (!pasteLayers.length)
			return null;
		const report = inspectDrillPasteOverlaps({ drillHits: files.drillHits, pasteLayers, pasteBasis });
		return { ...report, drillFilesComplete: files.drillComplete, complete: files.drillComplete && report.complete };
	};
	const artwork = comparePaste(artworkPaste, 'artwork');
	const stencil = comparePaste(stencilPaste, 'stencil-file');
	check();
	const inputs = {
		gerber: await fileIdentity(input.gerberBase64),
		artworkPaste: input.artworkPasteBase64 ? await fileIdentity(input.artworkPasteBase64) : null,
		stencil: input.stencilBase64 ? await fileIdentity(input.stencilBase64) : null,
		assembly: input.assembly
			? {
					bom: await fileIdentity(input.assembly.bomBase64),
					placement: await fileIdentity(input.assembly.placementBase64),
					assignment: input.assembly.assignmentBase64 ? await fileIdentity(input.assembly.assignmentBase64) : null,
				}
			: null,
	};
	check();
	const coverage = {
		machinePlacement: assembly ? assembly.complete ? 'reconciled' : 'incomplete' : 'not-provided',
		maskBridge: mask.complete ? 'both-sides-measured' : 'incomplete',
		bodyGeometry: assembly?.bodyGeometry.status ?? 'not-provided',
		boardEdge: assembly?.boardEdge.status ?? 'not-provided',
		drillToArtworkPaste: artwork ? artwork.complete ? 'measured' : 'partial' : 'not-provided',
		drillToManufacturingStencil: stencil ? stencil.complete ? 'measured' : 'partial' : 'not-provided',
		mouseBites: mouseBites ? 'candidates-only' : 'not-applicable',
	};
	return {
		scope: { object: input.object, source: 'supplied-files', readOnly: true, units: 'mm unless otherwise noted', alignment: '各文件应来自同一版本并使用同一坐标原点，独立钢网由调用者确认配套', notCovered: ['板厂生产放行', '仅凭制造图形确认焊盘网络', '未提供实配本体尺寸的器件', '钻孔填孔、盖孔、过孔最终孔壁和焊接结果'] },
		inputs,
		coverage,
		thresholds: { minimumMaskBridgeMm: input.minimumMaskBridgeMm ?? null, minimumBodyClearanceMm: input.assembly?.minimumBodyClearanceMm ?? null, minimumBodyToEdgeMm: input.assembly?.minimumBodyToEdgeMm ?? null },
		fileIssues: files.issues,
		outline: files.outline,
		assembly,
		mask,
		mouseBites,
		drill: { complete: files.drillComplete, total: files.drillHits.length, plated: files.drillHits.filter(hit => hit.plating === 'PLATED').length, nonPlated: files.drillHits.filter(hit => hit.plating === 'NON_PLATED').length },
		paste: { artwork, stencil, stencilStatus: stencil ? 'stencil-file-supplied' : 'no-readable-stencil' },
	};
}

export const manufacturingDfmCommands: ICommandDef[] = [{
	name: 'dfm.inspectManufacturingFiles',
	summary: '只读检查实际制造 ZIP、贴片资料和锡膏开口，报告阻焊桥、本体间距及板边距、钻孔开口相交和拼板邮票孔候选',
	params: [
		{ name: 'gerberBase64', type: 'string', required: true, description: '实际制造 Gerber ZIP，含板框和钻孔' },
		{ name: 'object', type: 'string', required: true, description: 'single-board 或 panel' },
		{ name: 'minimumMaskBridgeMm', type: 'number', description: '可选。实际开窗边缘之间的阻焊桥阈值，毫米' },
		{ name: 'assembly', type: 'object', description: '可选。bomBase64、placementBase64；可另传 assignmentBase64、bodyDimensions（位号 designator、料号 partNumber、尺寸来源 source、widthMm、lengthMm、可选 rotationOffsetDeg）、minimumBodyClearanceMm、minimumBodyToEdgeMm' },
		{ name: 'artworkPasteBase64', type: 'string', description: '可选。与主包同坐标的设计锡膏 GTP/GBP ZIP，供风险筛查' },
		{ name: 'stencilBase64', type: 'string', description: '可选。实际随单钢网开口 GTP/GBP ZIP，与主包坐标配对' },
	],
	returns: '来源文件摘要、机贴清单核对、各项几何结果、缺项和阈值；供复核，无整包合格结论',
	handler: (params, ctx) => inspectManufacturingDfm(params as Parameters<typeof inspectManufacturingDfm>[0], ctx),
}];
