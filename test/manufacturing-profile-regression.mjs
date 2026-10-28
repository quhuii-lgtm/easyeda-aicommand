import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const nodeRequire = createRequire(import.meta.url);
function loadTs(file) {
	const absolute = resolve(root, file);
	const compiled = ts.transpileModule(readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
	const module = { exports: {} };
	const localRequire = id => id.startsWith('.') ? loadTs(resolve(dirname(absolute).slice(root.length + 1), id.endsWith('.ts') ? id : `${id}.ts`)) : nodeRequire(id);
	new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
	return module.exports;
}
const { compareManufacturingProfile, validateManufacturingProfile, validateOrderConfirmation } = loadTs('src/engine/manufacturingProfile.ts');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`ok ${checks} - ${name}`); }

const jlcSource = { url: 'https://jlcpcb.com/impedance', observedAt: '2026-10-21T15:37:06.549Z' };
const calculatorSource = { url: 'https://jlcpcb.com/pcb-impedance-calculator', observedAt: '2026-10-21T15:40:28.628Z' };
const selection = { copperLayers: 4, nominalThicknessMm: 1.6, outerCopperOz: 1, innerCopperOz: 0.5 };
const profile = () => ({
	schemaVersion: 1,
	profileId: 'jlc-7628-4l',
	revision: '2026-10-21',
	manufacturer: 'JLCPCB',
	productType: 'rigid-pcb',
	stackupId: 'JLC04161H-7628',
	source: structuredClone(jlcSource),
	selection: structuredClone(selection),
	officialStackup: {
		stackupId: 'JLC04161H-7628',
		orderedLayers: [
			{ name: 'L1', kind: 'copper', thicknessMm: 0.035, material: 'Copper', dk: 'unknown' },
			{ name: '7628 prepreg 1', kind: 'prepreg', thicknessMm: 0.2104, material: '7628', dk: 'unknown' },
			{ name: 'L2', kind: 'copper', thicknessMm: 0.0152, material: 'Copper', dk: 'unknown' },
			{ name: '1.065mm core', kind: 'core', thicknessMm: 1.065, material: 'Core', dk: 'unknown' },
			{ name: 'L3', kind: 'copper', thicknessMm: 0.0152, material: 'Copper', dk: 'unknown' },
			{ name: '7628 prepreg 2', kind: 'prepreg', thicknessMm: 0.2104, material: '7628', dk: 'unknown' },
			{ name: 'L4', kind: 'copper', thicknessMm: 0.035, material: 'Copper', dk: 'unknown' },
		],
		finishedThicknessMm: 1.59,
		finishedTolerancePercent: 10,
	},
	calculations: [{
		id: 'imp-50-l1-l2',
		stackupId: 'JLC04161H-7628',
		source: structuredClone(calculatorSource),
		evidenceStatus: 'unverified',
		model: 'single-ended-non-coplanar',
		targetOhm: 50,
		signalLayer: 'L1',
		topReference: null,
		bottomReference: 'L2',
		widthMil: 14.12,
		widthSpacingComplement: false,
		bindings: [{ net: 'USB_DP', edaLayerId: 1, layerMappingSource: 'user-confirmed map' }],
	}],
});
const twoLayerProfile = () => {
	const value = profile();
	value.selection.copperLayers = 2;
	delete value.selection.innerCopperOz;
	value.officialStackup.orderedLayers = [value.officialStackup.orderedLayers[0], value.officialStackup.orderedLayers[1], value.officialStackup.orderedLayers[6]];
	delete value.calculations;
	return value;
};
const routing = (netStatus = 'known', preferredMil = 14.12) => ({
	schemaVersion: 1,
	editorVersion: '4.1.78',
	sourceUnit: 'mil',
	unitAssumption: 'host verified',
	globalStatus: 'known',
	defaultRule: { ruleKey: 'default', status: 'known', minMil: 5, preferredMil: 10, maxMil: 100, layers: [{ layerId: 1, status: 'known', minMil: 5, preferredMil: 10, maxMil: 100 }] },
	nets: [{ net: 'USB_DP', status: netStatus, ruleKey: 'USB_DP-rule', layers: [{ layerId: 1, status: netStatus, minMil: 5, preferredMil, maxMil: 100 }] }],
	unknowns: [],
	routingConstraintsComplete: false,
});
const enabled = [{ layerId: 1, name: 'Top' }, { layerId: 15, name: 'Inner 1' }, { layerId: 16, name: 'Inner 2' }, { layerId: 2, name: 'Bottom' }];
const order = (overrides = {}) => ({
	schemaVersion: 1,
	confirmed: true,
	source: { url: 'https://jlcpcb.com/order/confirmed', observedAt: '2026-10-21T16:00:00Z' },
	manufacturer: 'JLCPCB',
	productType: 'rigid-pcb',
	stackupId: 'JLC04161H-7628',
	selection: structuredClone(selection),
	impedanceService: {
		source: { url: 'https://jlcpcb.com/order/impedance', observedAt: '2026-10-21T16:00:00Z' },
		calculations: [{ id: 'imp-50-l1-l2', targetOhm: 50, model: 'single-ended-non-coplanar', signalLayer: 'L1', topReference: null, bottomReference: 'L2', widthMil: 14.12, widthSpacingComplement: false }],
	},
	...overrides,
});

check('真实官方样例14.12 mil保持unverified且缺订单不能总体通过', () => {
	const report = compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: enabled });
	assert.equal(report.overall, 'incomplete');
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.evidenceStatus').status, 'unknown');
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.preferredWidth').status, 'unknown');
	assert.equal(report.items.find(item => item.id === 'order.selection.nominalThicknessMm').status, 'unknown');
});

check('名义1.6mm与成品1.59mm独立记录，芯板铜组不重复计算', () => {
	const p = profile();
	const report = compareManufacturingProfile({ profile: p, routing: routing(), enabledCopperLayers: enabled, orderConfirmation: order() });
	assert.equal(p.selection.nominalThicknessMm, 1.6);
	assert.equal(p.officialStackup.finishedThicknessMm, 1.59);
	assert.equal(p.officialStackup.orderedLayers.filter(layer => layer.kind === 'copper').length, 4);
	assert.equal(report.items.find(item => item.id === 'profile.selection.nominalThicknessMm').profileValue, 1.6);
	assert.equal(report.items.find(item => item.id === 'profile.officialStackup.finishedThicknessMm').profileValue, 1.59);
	assert.equal(report.items.find(item => item.id === 'order.selection.nominalThicknessMm').status, 'matched');
});

check('相同名义厚度但不同叠层ID由订单对照报告不一致', () => {
	const report = compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: enabled, orderConfirmation: order({ stackupId: 'JLC04161H-3313A' }) });
	assert.equal(report.items.find(item => item.id === 'order.stackupId').status, 'mismatch');
	assert.equal(report.items.find(item => item.id === 'order.selection.nominalThicknessMm').status, 'matched');
	assert.equal(report.overall, 'mismatch');
});

check('4层与6层明确启用铜层计数不同会报告mismatch', () => {
	const sixLayers = [1, 15, 16, 17, 18, 2].map(layerId => ({ layerId }));
	const report = compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: sixLayers });
	assert.equal(report.items.find(item => item.id === 'profile.selection.copperLayers-vs-eda').status, 'mismatch');
	assert.equal(report.overall, 'mismatch');
});

check('当前物理层单位/顺序未知且raw记录只保留原值', () => {
	const raw = [{ header: { type: 'LAYER_PHYS', id: '["LAYER_PHYS",1]', ticket: 4 }, data: { thickness: 1.379 } }];
	const report = compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: enabled, rawPhysicalLayerRecords: raw });
	const item = report.items.find(entry => entry.id === 'eda.rawPhysicalLayerRecords.["LAYER_PHYS",1]');
	assert.equal(item.status, 'unknown');
	assert.deepEqual(item.currentValue.data, { thickness: 1.379 });
	assert.equal(report.items.find(entry => entry.id === 'eda.physicalLayerOrderAndUnits').status, 'unknown');
});

check('缺补偿选项及绑定时标未知，不从默认规则继承网络规则', () => {
	const p = profile();
	delete p.calculations[0].widthSpacingComplement;
	delete p.calculations[0].bindings;
	const unknownRule = routing('unknown');
	const report = compareManufacturingProfile({ profile: p, routing: unknownRule, enabledCopperLayers: enabled });
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.widthSpacingComplement').status, 'unknown');
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.bindings').status, 'unknown');
	const fallbackCase = profile();
	const fallbackReport = compareManufacturingProfile({ profile: fallbackCase, routing: unknownRule, enabledCopperLayers: enabled });
	assert.equal(fallbackReport.items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.preferredWidth').status, 'unknown');
	assert.equal(fallbackReport.items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.withinMinMax').status, 'unknown');
});

check('preferred不一致与min/max合法性分开报告', () => {
	const p = profile();
	p.calculations[0].evidenceStatus = 'verified';
	const report = compareManufacturingProfile({ profile: p, routing: routing('known', 14), enabledCopperLayers: enabled, orderConfirmation: order() });
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.preferredWidth').status, 'mismatch');
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.withinMinMax').status, 'matched');
});

check('逐层NET规则按binding的edaLayerId分别供制造profile读取', () => {
	const p = profile();
	p.calculations[0].widthMil = 30;
	p.calculations[0].evidenceStatus = 'verified';
	const bottomCalculation = structuredClone(p.calculations[0]);
	bottomCalculation.id = 'imp-50-l4-l3';
	bottomCalculation.signalLayer = 'L4';
	bottomCalculation.topReference = 'L3';
	bottomCalculation.bottomReference = null;
	bottomCalculation.bindings = [{ net: 'USB_DP', edaLayerId: 2, layerMappingSource: 'synthetic bottom-layer mapping fixture' }];
	p.calculations.push(bottomCalculation);
	const perLayerRouting = routing();
	perLayerRouting.nets[0].layers = [
		{ layerId: 1, status: 'known', minMil: 5, preferredMil: 20, maxMil: 100 },
		{ layerId: 2, status: 'known', minMil: 25, preferredMil: 30, maxMil: 35 },
	];
	const report = compareManufacturingProfile({ profile: p, routing: perLayerRouting, enabledCopperLayers: enabled });
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.preferredWidth').status, 'mismatch');
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.withinMinMax').status, 'matched');
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l4-l3.binding.USB_DP.layer2.preferredWidth').status, 'matched');
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l4-l3.binding.USB_DP.layer2.withinMinMax').status, 'matched');
});

check('min/max边界容忍8 ULP机器误差但拒绝真实越界', () => {
	const p = profile();
	p.calculations[0].evidenceStatus = 'verified';
	p.calculations[0].widthMil = 10.05;
	const nearBoundary = routing('known', 10.05);
	nearBoundary.nets[0].layers[0].minMil = 10.050000000000002;
	nearBoundary.nets[0].layers[0].maxMil = 10.050000000000002;
	assert.equal(compareManufacturingProfile({ profile: p, routing: nearBoundary, enabledCopperLayers: enabled }).items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.withinMinMax').status, 'matched');
	const over = routing('known', 10.05);
	over.nets[0].layers[0].minMil = 5;
	over.nets[0].layers[0].maxMil = 10.049999999999999;
	const trulyOver = structuredClone(p);
	trulyOver.calculations[0].widthMil = 10.050001;
	assert.equal(compareManufacturingProfile({ profile: trulyOver, routing: over, enabledCopperLayers: enabled }).items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.withinMinMax').status, 'mismatch');
	const unknown = routing('unknown', 10.05);
	assert.equal(compareManufacturingProfile({ profile: p, routing: unknown, enabledCopperLayers: enabled }).items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.withinMinMax').status, 'unknown');
});

check('四种阻抗模型分别判定差分间距和共面铜间距适用性', () => {
	const cases = [
		['single-ended-non-coplanar', 'not-applicable', 'not-applicable'],
		['single-ended-coplanar', 'not-applicable', 'unknown'],
		['differential-non-coplanar', 'unknown', 'not-applicable'],
		['differential-coplanar', 'unknown', 'unknown'],
	];
	for (const [model, spacingStatus, copperGapStatus] of cases) {
		const p = profile();
		p.calculations[0].model = model;
		const report = compareManufacturingProfile({ profile: p, routing: routing(), enabledCopperLayers: enabled });
		assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.spacingMil').status, spacingStatus, model);
		assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.copperGapMil').status, copperGapStatus, model);
	}
	const differential = profile();
	differential.calculations[0].model = 'differential-non-coplanar';
	differential.calculations[0].spacingMil = 5;
	assert.equal(compareManufacturingProfile({ profile: differential, routing: routing(), enabledCopperLayers: enabled }).items.find(item => item.id === 'calculation.imp-50-l1-l2.spacingMil').status, 'unknown');
	assert.throws(() => validateManufacturingProfile(Object.assign(profile(), { calculations: [{ ...profile().calculations[0], spacingMil: 5 }] })), /仅适用于差分/);
	const orderWithNACopperGap = order();
	orderWithNACopperGap.impedanceService.calculations[0].copperGapMil = 4;
	assert.throws(() => validateOrderConfirmation(orderWithNACopperGap), /仅适用于共面/);
	const orderWithNASpacing = order();
	orderWithNASpacing.impedanceService.calculations[0].spacingMil = 5;
	assert.throws(() => validateOrderConfirmation(orderWithNASpacing), /仅适用于差分/);
});

check('参考层必须引用profile铜层且不能与信号层冲突', () => {
	const nonexistentSignal = profile(); nonexistentSignal.calculations[0].signalLayer = 'NoSuchLayer';
	assert.throws(() => validateManufacturingProfile(nonexistentSignal), /signalLayer 不在/);
	const nonexistentReference = profile(); nonexistentReference.calculations[0].bottomReference = 'NoSuchLayer';
	assert.throws(() => validateManufacturingProfile(nonexistentReference), /bottomReference 不在/);
	const sameSignal = profile(); sameSignal.calculations[0].bottomReference = 'L1';
	assert.throws(() => validateManufacturingProfile(sameSignal), /不能与 signalLayer 相同/);
	const bothNull = profile(); bothNull.calculations[0].bottomReference = null;
	assert.throws(() => validateManufacturingProfile(bothNull), /不能同时声明无上下参考层/);
	const duplicateName = profile(); duplicateName.officialStackup.orderedLayers[1].name = 'L1';
	assert.throws(() => validateManufacturingProfile(duplicateName), /重复层名/);
	const duplicateMediaName = profile(); duplicateMediaName.officialStackup.orderedLayers[3].name = duplicateMediaName.officialStackup.orderedLayers[1].name;
	assert.throws(() => validateManufacturingProfile(duplicateMediaName), /重复层名/);
	const dielectricBeforeCopperCollision = profile(); dielectricBeforeCopperCollision.officialStackup.orderedLayers[1].name = 'L2';
	assert.throws(() => validateManufacturingProfile(dielectricBeforeCopperCollision), /重复层名/);
	const innerReferences = profile();
	innerReferences.calculations[0].signalLayer = 'L2';
	innerReferences.calculations[0].topReference = 'L1';
	innerReferences.calculations[0].bottomReference = 'L3';
	assert.doesNotThrow(() => validateManufacturingProfile(innerReferences));
	const reversedTop = profile(); reversedTop.calculations[0].topReference = 'L3';
	assert.throws(() => validateManufacturingProfile(reversedTop), /topReference 必须位于/);
	const reversedBottom = profile(); reversedBottom.calculations[0].signalLayer = 'L2'; reversedBottom.calculations[0].bottomReference = 'L1';
	assert.throws(() => validateManufacturingProfile(reversedBottom), /bottomReference 必须位于/);
});

check('非共面模型的间距字段为not-applicable，Dk未知不改写其它结论', () => {
	const report = compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: enabled });
	const spacing = report.items.find(item => item.id === 'calculation.imp-50-l1-l2.spacingMil');
	assert.equal(spacing.status, 'not-applicable');
	assert.match(spacing.reason, /单端模型不使用差分线间距/);
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.copperGapMil').status, 'not-applicable');
	assert.equal(report.items.find(item => item.id === 'profile.officialStackup.orderedLayers[0].dk').status, 'unknown');
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.evidenceStatus').status, 'unknown');
});

check('缺字段、错误来源、非finite和额外字段被拒绝；订单计划不能confirmed', () => {
	const badSource = profile(); badSource.source.observedAt = 'yesterday-ish';
	assert.throws(() => validateManufacturingProfile(badSource), /observedAt/);
	const extra = profile(); extra.unexpected = true;
	assert.throws(() => validateManufacturingProfile(extra), /不支持字段/);
	const nonfinite = profile(); nonfinite.calculations[0].widthMil = Number.NaN;
	assert.throws(() => validateManufacturingProfile(nonfinite), /有限正数/);
	const unconfirmed = order({ confirmed: false });
	assert.throws(() => validateOrderConfirmation(unconfirmed), /confirmed/);
	const unknownField = order(); unknownField.selection.outerCopperOz = Number.POSITIVE_INFINITY;
	assert.throws(() => validateOrderConfirmation(unknownField), /有限正数/);
});

check('来源URL本地校验与全局URL构造器无关，保留源字符串', () => {
	const samplePath = resolve(root, '..', 'b-development-20261021/官方叠层参数样例_仅开发核对.json');
	const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
	const originalUrl = globalThis.URL;
	try {
		globalThis.URL = undefined;
		assert.equal(validateManufacturingProfile(sample).source.url, sample.source.url);
		globalThis.URL = class { constructor() { throw new Error('URL constructor unavailable'); } };
		assert.equal(validateManufacturingProfile(sample).calculations[0].source.url, sample.calculations[0].source.url);
		assert.equal(validateOrderConfirmation(order()).source.url, order().source.url);
	} finally { globalThis.URL = originalUrl; }
	const sourceUrl = 'https://user:pass@example.com:8443/path%20segment?q=a%2Fb#section';
	for (const url of [sourceUrl, 'https://[2001:db8::1]:443/path', 'https://[1:2:3:4:5:6:192.0.2.1]/', 'https://例子.测试/路径', 'file:///C:/docs/stackup.json', 'mailto:eda@example.com', 'urn:example:stackup:4']) {
		const p = profile(); p.source.url = url;
		assert.equal(validateManufacturingProfile(p).source.url, url);
	}
	const calcUrl = profile(); calcUrl.calculations[0].source.url = sourceUrl;
	assert.equal(validateManufacturingProfile(calcUrl).calculations[0].source.url, sourceUrl);
	const orderUrl = order(); orderUrl.source.url = sourceUrl; orderUrl.impedanceService.source.url = sourceUrl;
	assert.equal(validateOrderConfirmation(orderUrl).impedanceService.source.url, sourceUrl);
});

check('来源URI拒绝相对地址、畸形HTTP authority和坏百分号编码', () => {
	const invalid = ['', '/relative/path', 'example.com/path', 'http:/bad', 'https://:443/path', 'https://example.com:65536/', 'https://example.com:abc/', 'https://[2001:db8::1/', 'https://[:::1]/', 'https://[1:::2]/', 'https://[:1]/', 'https://[1:]/', 'https://2001:db8::1/', 'https://bad_host/path', 'https://exa mple.com/', 'https://example.com/%ZZ', 'https://example.com/\u007f'];
	for (const url of invalid) {
		const p = profile(); p.source.url = url;
		assert.throws(() => validateManufacturingProfile(p), /非空字符串|绝对 URI/ , url);
	}
	const invalidCalculation = profile(); invalidCalculation.calculations[0].source.url = 'https://example.com:65536/';
	assert.throws(() => validateManufacturingProfile(invalidCalculation), /绝对 URI/);
	const invalidOrder = order(); invalidOrder.source.url = 'https://example.com/%';
	assert.throws(() => validateOrderConfirmation(invalidOrder), /绝对 URI/);
});

check('内层铜厚仅多于2层必需，2层需省略且匹配为N/A', () => {
	const twoLayer = twoLayerProfile();
	assert.doesNotThrow(() => validateManufacturingProfile(twoLayer));
	const twoLayerWithOz = twoLayerProfile(); twoLayerWithOz.selection.innerCopperOz = 0.5;
	assert.throws(() => validateManufacturingProfile(twoLayerWithOz), /不超过2层时必须省略/);
	const fourLayerMissing = profile(); delete fourLayerMissing.selection.innerCopperOz;
	assert.throws(() => validateManufacturingProfile(fourLayerMissing), /必须是有限正数/);
	const noOrder = compareManufacturingProfile({ profile: twoLayer, routing: routing(), enabledCopperLayers: enabled.slice(0, 2) });
	assert.equal(noOrder.items.find(item => item.id === 'profile.selection.innerCopperOz').status, 'unknown');
	const twoLayerOrder = order();
	twoLayerOrder.selection.copperLayers = 2;
	delete twoLayerOrder.selection.innerCopperOz;
	delete twoLayerOrder.impedanceService;
	assert.doesNotThrow(() => validateOrderConfirmation(twoLayerOrder));
	const bothTwo = compareManufacturingProfile({ profile: twoLayer, routing: routing(), enabledCopperLayers: enabled.slice(0, 2), orderConfirmation: twoLayerOrder });
	const innerNotApplicable = bothTwo.items.find(item => item.id === 'profile.selection.innerCopperOz');
	assert.equal(innerNotApplicable.status, 'not-applicable');
	assert.equal(innerNotApplicable.profileValue, undefined);
	assert.equal(innerNotApplicable.currentValue, undefined);
	const oneTwoOneFour = compareManufacturingProfile({ profile: twoLayer, routing: routing(), enabledCopperLayers: enabled.slice(0, 2), orderConfirmation: order() });
	assert.equal(oneTwoOneFour.items.find(item => item.id === 'order.selection.copperLayers').status, 'mismatch');
	assert.equal(oneTwoOneFour.items.find(item => item.id === 'profile.selection.innerCopperOz').status, 'unknown');
});

check('重复profile calculation id、net-layer绑定、stackup引用和启用层拒绝', () => {
	const dupId = profile(); dupId.calculations.push(structuredClone(dupId.calculations[0]));
	assert.throws(() => validateManufacturingProfile(dupId), /重复计算 id/);
	const dupBinding = profile(); dupBinding.calculations[0].bindings.push({ net: 'USB_DP', edaLayerId: 1, layerMappingSource: 'duplicate' });
	assert.throws(() => validateManufacturingProfile(dupBinding), /重复 net\/layer binding/);
	const badStackup = profile(); badStackup.officialStackup.stackupId = 'other-stackup';
	assert.throws(() => validateManufacturingProfile(badStackup), /stackupId 冲突/);
	assert.throws(() => compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: [...enabled, { layerId: 1 }] }), /重复启用铜层/);
	assert.throws(() => compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: [{ layerId: 1.5 }] }), /正整数/);
	const sharedMap = profile();
	sharedMap.calculations.push({ ...structuredClone(sharedMap.calculations[0]), id: 'imp-50-usb-dm', bindings: [{ net: 'USB_DM', edaLayerId: 1, layerMappingSource: 'confirmed' }] });
	assert.doesNotThrow(() => validateManufacturingProfile(sharedMap));
	const oneSignalTwoEda = profile();
	oneSignalTwoEda.calculations[0].bindings.push({ net: 'USB_DM', edaLayerId: 2, layerMappingSource: 'conflict' });
	assert.throws(() => validateManufacturingProfile(oneSignalTwoEda), /映射到多个 EDA 层/);
	const twoSignalsOneEda = profile();
	twoSignalsOneEda.calculations.push({ ...structuredClone(twoSignalsOneEda.calculations[0]), id: 'imp-50-l2', signalLayer: 'L2', bottomReference: 'L4', bindings: [{ net: 'USB_DM', edaLayerId: 1, layerMappingSource: 'conflict' }] });
	assert.throws(() => validateManufacturingProfile(twoSignalsOneEda), /映射到多个制造层/);
});

check('明确无阻抗服务与缺少impedanceService区分为not-applicable和unknown', () => {
	const noService = order({ impedanceService: null });
	const report = compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: enabled, orderConfirmation: noService });
	assert.equal(report.items.find(item => item.id === 'order.impedanceService').status, 'mismatch');
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.orderImpedanceService').status, 'mismatch');
	const withService = compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: enabled, orderConfirmation: order() });
	const topReferenceItem = withService.items.find(item => item.id === 'calculation.imp-50-l1-l2.order.topReference');
	assert.equal(topReferenceItem.status, 'matched');
	assert.equal(topReferenceItem.profileValue, null);
	assert.equal(topReferenceItem.currentValue, null);
	const missingService = order(); delete missingService.impedanceService;
	const missingReport = compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: enabled, orderConfirmation: missingService });
	assert.equal(missingReport.items.find(item => item.id === 'order.impedanceService').status, 'unknown');
	const noCalculations = profile(); delete noCalculations.calculations;
	const noCalcReport = compareManufacturingProfile({ profile: noCalculations, routing: routing(), enabledCopperLayers: enabled, orderConfirmation: noService });
	assert.equal(noCalcReport.items.find(item => item.id === 'order.impedanceService').status, 'not-applicable');
});

check('订单额外计算ID逐项报告且不改变输入或未验证证据状态', () => {
	const p = profile();
	const o = order();
	o.impedanceService.calculations.push({ ...structuredClone(o.impedanceService.calculations[0]), id: 'imp-extra' });
	const beforeProfile = structuredClone(p);
	const beforeOrder = structuredClone(o);
	const report = compareManufacturingProfile({ profile: p, routing: routing(), enabledCopperLayers: enabled, orderConfirmation: o });
	const extra = report.items.find(item => item.id === 'order.calculation.imp-extra');
	assert.equal(extra.status, 'mismatch');
	assert.equal(extra.profileValue, undefined);
	assert.equal(extra.currentValue, 'imp-extra');
	assert.match(extra.reason, /profile 未声明的计算ID/);
	assert.equal(extra.sources.length, 2);
	assert.ok(extra.sources.every(source => source.includes('(调用方提供)')));
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.evidenceStatus').status, 'unknown');
	assert.equal(report.items.find(item => item.id === 'calculation.imp-50-l1-l2.binding.USB_DP.layer1.preferredWidth').status, 'unknown');
	assert.deepEqual(p, beforeProfile);
	assert.deepEqual(o, beforeOrder);

	const emptyProfile = twoLayerProfile();
	const orderOnly = order({ selection: { copperLayers: 2, nominalThicknessMm: 1.6, outerCopperOz: 1 } });
	delete orderOnly.selection.innerCopperOz;
	orderOnly.impedanceService.calculations = [{ ...structuredClone(orderOnly.impedanceService.calculations[0]), id: 'imp-order-only' }];
	const orderOnlyReport = compareManufacturingProfile({ profile: emptyProfile, routing: routing(), enabledCopperLayers: enabled.slice(0, 2), orderConfirmation: orderOnly });
	assert.equal(orderOnlyReport.items.find(item => item.id === 'order.calculation.imp-order-only').status, 'mismatch');

	const emptyServiceOrder = order({ selection: { copperLayers: 2, nominalThicknessMm: 1.6, outerCopperOz: 1 } });
	delete emptyServiceOrder.selection.innerCopperOz;
	emptyServiceOrder.impedanceService.calculations = [];
	const emptyServiceReport = compareManufacturingProfile({ profile: twoLayerProfile(), routing: routing(), enabledCopperLayers: enabled.slice(0, 2), orderConfirmation: emptyServiceOrder });
	assert.equal(emptyServiceReport.items.some(item => item.id.startsWith('order.calculation.')), false);
	assert.equal(emptyServiceReport.items.find(item => item.id === 'order.impedanceService'), undefined);
	assert.equal(emptyServiceReport.items.some(item => item.status === 'mismatch'), false);

	const missingOrderReport = compareManufacturingProfile({ profile: twoLayerProfile(), routing: routing(), enabledCopperLayers: enabled.slice(0, 2) });
	assert.equal(missingOrderReport.items.some(item => item.id.startsWith('order.calculation.')), false);
	const nullServiceReport = compareManufacturingProfile({ profile: profile(), routing: routing(), enabledCopperLayers: enabled, orderConfirmation: order({ impedanceService: null }) });
	assert.equal(nullServiceReport.items.find(item => item.id === 'order.impedanceService').status, 'mismatch');
	assert.equal(nullServiceReport.items.some(item => item.id.startsWith('order.calculation.')), false);
});

check('官方叠层样例文件可由profile validator读取且14.12 mil保持unverified', () => {
	const samplePath = resolve(root, '..', 'b-development-20261021/官方叠层参数样例_仅开发核对.json');
	const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
	const validated = validateManufacturingProfile(sample);
	assert.equal(validated.calculations[0].widthMil, 14.12);
	assert.equal(validated.calculations[0].evidenceStatus, 'unverified');
});

console.log(`1..${checks}`);
