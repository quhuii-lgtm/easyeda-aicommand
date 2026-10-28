import type { ICommandDef } from '../engine/types';
import { compareManufacturingProfile, validateManufacturingProfile, validateOrderConfirmation } from '../engine/manufacturingProfile';
import { buildPhysicalLayerEvidence } from '../engine/physicalLayerEvidence';
import { buildRoutingWidthSnapshot } from '../engine/routingWidthRules';
import { createGeometryHost } from '../pcb/geometryHost';
import { comparePcbSourceSnapshots } from '../pcb/dsnSourceSnapshot';
import { parseSourceLog } from '../pcb/sourcelog';
import { readEditorVersion } from '../pcb/pouredUnits';

function canonical(value: any): string {
	return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
		? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

function enabledCopperLayers(layers: any[]): Array<{ layerId: number; name?: string }> {
	const result: Array<{ layerId: number; name?: string }> = [];
	const seen = new Set<number>();
	for (const layer of layers) {
		if (!['SIGNAL', 'PLANE'].includes(String(layer?.type ?? '').toUpperCase())) continue;
		if (layer.status !== undefined && layer.layerStatus !== undefined && layer.status !== layer.layerStatus) throw new Error('铜层状态字段冲突');
		if (layer.layerId !== undefined && layer.id !== undefined && layer.layerId !== layer.id) throw new Error('铜层身份字段冲突');
		const status = layer.status ?? layer.layerStatus;
		if (status === 0) continue;
		if (status !== 1 && status !== 2) throw new Error('铜层启用状态无法确认，制造参数核对停止');
		const layerId = layer.layerId ?? layer.id;
		if (!Number.isInteger(layerId) || layerId <= 0 || seen.has(layerId)) throw new Error('铜层身份无效或重复');
		if (layerId !== 1 && layerId !== 2 && !(layerId >= 15 && layerId <= 44)) throw new Error('图层 ID 不是已核对 SDK 的铜层身份');
		seen.add(layerId);
		const name = layer.layerName ?? layer.name;
		result.push({ layerId, ...(typeof name === 'string' ? { name } : {}) });
	}
	if (!result.length) throw new Error('没有可确认的启用铜层');
	return result;
}

async function checkManufacturingProfile(params: Record<string, any>): Promise<unknown> {
	const profile = validateManufacturingProfile(params.profile);
	const orderConfirmation = params.orderConfirmation === undefined ? undefined : validateOrderConfirmation(params.orderConfirmation);
	const host = await createGeometryHost(eda, params);
	try {
		const readProject = () => host.read('读取制造参数核对的当前工程', async () => {
			const project = await host.sdk.dmt_Project.getCurrentProjectInfo();
			if (!project || typeof project.uuid !== 'string' || !project.uuid) throw new Error('当前工程身份无法确认');
			return project.uuid as string;
		});
		const readSource = () => host.read('读取制造参数核对的 PCB 源码', async () => {
			const source = await host.sdk.sys_FileManager.getDocumentSource();
			if (typeof source !== 'string') throw new Error('PCB 源码不是字符串');
			const document = parseSourceLog(source);
			if (document.docType.toUpperCase() !== 'PCB' || document.uuid !== host.documentUuid) throw new Error('PCB 源码与目标文档不符');
			return { source, document };
		});
		const readLayers = () => host.read('读取制造参数核对的图层列表', async () => {
			const layers = await host.sdk.pcb_Layer.getAllLayers();
			if (!Array.isArray(layers)) throw new Error('图层列表不是数组');
			return layers;
		});
		const readNetRules = () => host.read('读取制造参数核对的网络规则', async () => {
			const rules = await host.sdk.pcb_Drc.getNetRules();
			if (!Array.isArray(rules)) throw new Error('网络规则不是数组');
			return rules;
		});
		const readRules = () => host.read('读取制造参数核对的独立设计规则', async () => {
			const rules = await host.sdk.pcb_Drc.getCurrentRuleConfiguration();
			if (!rules || typeof rules !== 'object' || Array.isArray(rules) || !Object.keys(rules).length) throw new Error('设计规则缺失或结构无效');
			return rules;
		});
		const projectUuid = await readProject();
		const before = await readSource();
		const layers = await readLayers();
		const layersBefore = canonical(layers);
		const copperLayers = enabledCopperLayers(layers);
		const netRules = await readNetRules();
		const netRulesBefore = canonical(netRules);
		const rules = await readRules();
		const rulesBefore = canonical(rules);
		const editorVersion = readEditorVersion(host.sdk);
		const routing = buildRoutingWidthSnapshot({ source: before.source, layers, netRules, editorVersion: editorVersion ?? '' });
		const rawPhysicalLayerRecords = before.document.records.filter(record => record.header.type === 'LAYER_PHYS').map(record => ({ header: record.header, data: record.data }));
		const physicalLayerEvidence = buildPhysicalLayerEvidence({ document: before.document, layers, editorVersion: editorVersion ?? '' });
		const report = compareManufacturingProfile({ profile, routing, enabledCopperLayers: copperLayers, rawPhysicalLayerRecords, physicalLayerEvidence, orderConfirmation });
		if (rulesBefore !== canonical(await readRules())) throw new Error('制造参数核对期间设计规则变化，结果作废');
		if (netRulesBefore !== canonical(await readNetRules())) throw new Error('制造参数核对期间网络规则变化，结果作废');
		if (layersBefore !== canonical(await readLayers())) throw new Error('制造参数核对期间图层配置变化，结果作废');
		if (projectUuid !== await readProject()) throw new Error('制造参数核对期间工程变化，结果作废');
		const after = await readSource();
		const comparison = comparePcbSourceSnapshots(before.source, after.source);
		if (!comparison.matches) throw new Error(`制造参数核对期间 PCB 源码发生变化，结果作废：${comparison.reason}`);
		await host.finish();
		return {
			...report, documentUuid: host.documentUuid, projectUuid, editorVersion,
			profile, enabledCopperLayers: copperLayers, routingWidthEvidence: routing,
			rawPhysicalLayerRecords,
			physicalLayerEvidence,
			physicalLayerMeaning: '源码 LAYER_PHYS 原始记录保留历史及墓碑；仅 EDA 4.1.78 有原生 UI、源码、保存重开支持的 mil 单位观察并提供 mm 换算，不代表固定量化算法或误差界限；换算值不写回 UI。物理顺序只按无冲突的唯一源码 zIndex 推导，未建立逐层板厂映射。',
			sourceStable: true, rulesStable: true, layersStable: true, netRulesStable: true,
			readOnly: true, saved: false,
			unverifiedScope: ['逐层板厂映射和物理叠层对应关系', '实际走线及参考平面连续性', '阻抗实测', '在线订单独立读回'],
		};
	}
	catch (error) {
		return host.fail(error, { operation: 'checkManufacturingProfile', readOnly: true });
	}
}

export const manufacturingProfileCommands: ICommandDef[] = [{
	name: 'pcb.checkManufacturingProfile',
	summary: '只读核对同一具名制造参数文件、官方计算记录、当前 PCB 铜层数/网络线宽规则及调用方提供的订单确认记录；逐项报告一致、不同或未知。来源地址采用本地绝对地址结构校验，不依赖浏览器 URL 构造器。',
	params: [
		{ name: 'profile.source', type: 'object', description: '来源为{url,observedAt}。url必须是绝对来源地址；HTTP(S)检查主机、authority及端口，也接受file/mailto/urn等绝对scheme。中文路径和结构合法的国际化主机保留原值。拒绝相对地址、控制字符、原始空白、破损百分号和畸形authority；只做本地结构检查，不做完整WHATWG/IDNA解析或规范化，不访问网络或认证来源。计算和订单来源采用同样检查。' },
		{ name: 'profile', type: 'object', required: true, description: 'schemaVersion:1 的制造参数对象，不是本机路径。必须含 profileId/revision/manufacturer/productType/stackupId/source{url,observedAt}、selection{copperLayers,nominalThicknessMm,outerCopperOz,innerCopperOz?}、officialStackup{stackupId,orderedLayers:[{name,kind,thicknessMm}]}。铜层多于2层时innerCopperOz必须为正数，1/2层时必须省略；订单selection同样。orderedLayers从顶到底且层名唯一，上下参考层按该顺序核对。厚度显式Mm、规则线宽显式Mil；未知厚度填字符串unknown。不将名义板厚和成品厚度混比。' },
		{ name: 'profile.calculations', type: 'array', description: '可选计算记录：id/stackupId/source/evidenceStatus(verified或unverified)/model/targetOhm/signalLayer/topReference/bottomReference/widthMil/spacingMil/copperGapMil/widthSpacingComplement/bindings[{net,edaLayerId,layerMappingSource}]。模型为single-ended-non-coplanar、single-ended-coplanar、differential-non-coplanar或differential-coplanar。明确无参考层用null，未确认则省略；不适用间距按模型单列，不补0。verified只表示调用方声明的计算证据，不是插件认证。没有绑定不猜网络或层身份。' },
		{ name: 'orderConfirmation', type: 'object', description: '可选，调用方明确提供的实际订单记录：schemaVersion:1/confirmed:true/source{url,observedAt}/manufacturer/productType/stackupId/selection；impedanceService可省略表示未知、null表示明确未开通，或{source,calculations:[计算目标及参数]}。计划值不能作为实际确认。插件不在线读取或修改订单。' },
	],
	returns: 'overall为mismatch/incomplete/matched-within-scope，items逐项附值、单位、来源和原因；订单侧额外计算ID逐项报告为mismatch。只比较调用方提供的订单记录，不读取或修改订单。订单、映射、计算证据或逐层板厂映射未知时不能总通过。首选线宽与范围合法性分开核对。routingWidthEvidence跳过明确停用SIGNAL层；4.1.78已识别的无TRACK独立长度容差配置不再污染线宽，未确认选择器仍保留原边界。EDA4.1.78中，网络属于类但自身明确指定的简单TRACK规则，在源码、SDK归属和规则值一致时可以确认；严格空NET选择器在EDA4.1.78、mil单行规则及源码/SDK归属一致的已验证结构下采用DEFAULT TRACK；缺失、复杂或矛盾结构仍未知。preferred是配置值，不证明交互落线宽度。这只比较配置，不证明执行DRC/实际走线或制造阻抗。保留原rawPhysicalLayerRecords，并附physicalLayerEvidence：有效ticket、source/SDK身份关联、zIndex分组；仅EDA4.1.78的原生UI、源码及保存重开观察支持LAYER_PHYS thickness按mil解释，并对有限非负数提供不写回的mm换算，不声称固定量化算法或误差界限；其他版本单位未知。没有逐层板厂映射时比较items仍为unknown；重复zIndex时order为unknown且不生成orderedLayers。只读，不保存、存储参数或设置规则；当前页/工程/源码/规则/层变化使结果作废。',
	handler: checkManufacturingProfile,
}];
