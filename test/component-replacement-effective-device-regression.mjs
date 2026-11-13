import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const fixture = JSON.parse(await readFile(resolve(root, 'test/fixtures/device-association-effective-projection.json'), 'utf8'));
const bundled = await build({
	stdin: { contents: `export { assertEffectiveDeviceRawProjection, assertFreshEffectiveDeviceAssociation, performSchematicReplacementStage } from './src/modules/reuse/componentReplacementSchematic.ts';\nexport { assertSubmittedWireProof, createReplacementVerification } from './src/modules/reuse/componentReplacementVerification.ts';`, resolveDir: root, sourcefile: 'effective-device-test-entry.ts' },
	bundle: true, platform: 'node', format: 'esm', write: false,
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const proof = () => ({ projection: 'device-attr-uuid-to-empty', candidateId: fixture.candidateId, attrId: fixture.attrId,
	pageUuid: fixture.pageUuid, partId: fixture.partId, projectUuid: fixture.projectUuid, sourceLibraryUuid: fixture.sourceLibraryUuid,
	deviceUuid: fixture.deviceUuid, symbolUuid: fixture.symbolUuid, footprintUuid: fixture.footprintUuid,
	rawUuid: fixture.deviceUuid, actualRawUuid: '', typedAttr: { primitiveId: fixture.attrId, parentPrimitiveId: fixture.candidateId, key: 'Device', value: fixture.deviceUuid },
	typedReference: fixture.reference });
const context = (actual = fixture.actualRawTarget, submitted = fixture.submittedTarget, resources = fixture.resourceDocuments, current = {}) => ({
	expected: fixture.submittedTarget, actual, submitted, proof: { ...proof(), ...current }, resourceDocuments: resources,
	projectUuid: fixture.projectUuid, pageUuid: fixture.pageUuid, candidateId: fixture.candidateId, deviceUuid: fixture.deviceUuid,
	symbolUuid: fixture.symbolUuid, partId: fixture.partId,
});
const deviceNameProof = { deviceUuid: fixture.deviceUuid, title: fixture.deviceTitle, source: '',
	serialized: fixture.submittedTarget.component.data.attrs.DeviceName };

assert.doesNotThrow(() => api.assertEffectiveDeviceRawProjection(context()));
assert.doesNotThrow(() => api.assertSubmittedWireProof(fixture.submittedTarget, fixture.actualRawTarget, [], [], deviceNameProof,
	fixture.candidateId, fixture.deviceTitle, fixture.deviceUuid, proof()));
assert.doesNotThrow(() => api.assertSubmittedWireProof(fixture.submittedTarget, fixture.submittedTarget, [], [], deviceNameProof,
	fixture.candidateId, fixture.deviceTitle, fixture.deviceUuid));

const rejected = [
	['missing Device ATTR', value => { value.actual.attributes = []; }],
	['null Device ATTR value', value => { value.actual.attributes[0].data.value = null; }],
	['wrong Device UUID', value => { value.actual.attributes[0].data.value = 'wrong-device'; }],
	['duplicate Device ATTR', value => { value.actual.attributes.push(structuredClone(value.actual.attributes[0])); }],
	['wrong Device parent', value => { value.actual.attributes[0].data.parentId = 'other-candidate'; }],
	['wrong Device key', value => { value.actual.attributes[0].data.key = 'Symbol'; }],
	['stale candidate proof', value => { value.proof.candidateId = 'stale-candidate'; }],
	['missing footprint resource', value => { value.resourceDocuments = value.resourceDocuments.filter(row => row.docType !== 'FOOTPRINT'); }],
	['extra component change', value => { value.actual.component.data.newField = true; }],
	['extra ATTR field change', value => { value.actual.attributes[0].data.extra = true; }],
];
for (const [label, mutate] of rejected) {
	const input = context();
	input.actual = structuredClone(input.actual); input.proof = { ...input.proof }; input.resourceDocuments = structuredClone(input.resourceDocuments);
	mutate(input);
	assert.throws(() => api.assertEffectiveDeviceRawProjection(input), undefined, label);
}

const freshApi = (typedValue = fixture.deviceUuid, overrides = {}) => ({
	dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: overrides.currentProject ?? fixture.projectUuid }) },
	dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: overrides.currentPage ?? fixture.pageUuid,
		parentProjectUuid: fixture.projectUuid, documentType: 1 }) },
	sch_PrimitiveAttribute: { get: async () => ({ getState_PrimitiveId: () => overrides.primitiveId ?? fixture.attrId,
		getState_ParentPrimitiveId: () => overrides.parentPrimitiveId ?? fixture.candidateId,
		getState_Key: () => overrides.key ?? 'Device', getState_Value: () => typedValue }) },
	sch_PrimitiveComponent: { get: async () => ({ getState_PrimitiveId: () => fixture.candidateId, getState_Component: () => overrides.reference ?? fixture.reference }) },
});
assert.doesNotThrow(() => api.assertFreshEffectiveDeviceAssociation(freshApi(), proof(), fixture.resourceDocuments));
for (const [label, host] of [
	['reopened typed value wrong', freshApi('wrong-device')],
	['reopened ATTR parent wrong', freshApi(fixture.deviceUuid, { parentPrimitiveId: 'other' })],
	['reopened ATTR key wrong', freshApi(fixture.deviceUuid, { key: 'Symbol' })],
	['reopened component reference wrong', freshApi(fixture.deviceUuid, { reference: { ...fixture.reference, uuid: 'wrong-device' } })],
	['reopened ATTR id wrong', freshApi(fixture.deviceUuid, { primitiveId: 'wrong-attr' })],
	['reopened project wrong', freshApi(fixture.deviceUuid, { currentProject: 'other-project' })],
	['reopened page wrong', freshApi(fixture.deviceUuid, { currentPage: 'other-page' })],
	['reopened libraryUuid missing', freshApi(fixture.deviceUuid, { reference: { uuid: fixture.deviceUuid } })],
]) assert.rejects(() => api.assertFreshEffectiveDeviceAssociation(host, proof(), fixture.resourceDocuments), undefined, label);
const changedSourceResources = structuredClone(fixture.resourceDocuments);
changedSourceResources[0].effectiveRecords[0].data.source = 'library|other-source';
await assert.rejects(() => api.assertFreshEffectiveDeviceAssociation(freshApi(), proof(), changedSourceResources), /资源来源库/);
const contextSwapApi = freshApi();
let contextChecks = 0;
contextSwapApi.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: ++contextChecks === 1 ? fixture.pageUuid : 'other-page',
	parentProjectUuid: fixture.projectUuid, documentType: 1 });
await assert.rejects(() => api.assertFreshEffectiveDeviceAssociation(contextSwapApi, proof(), fixture.resourceDocuments), /当前工程\/原理图页上下文不符/);
assert.equal(contextChecks, 2, 'fresh reads verify the target page again after typed getters return');

function sourceLog(rows) {
	const records = [{ type: 'DOCHEAD', id: 'DOCHEAD', data: { docType: 'SCH_PAGE', uuid: fixture.pageUuid } }, ...rows];
	return records.map((row, index) => `${JSON.stringify({ type: row.type, ticket: index + 1, id: row.id })}||${JSON.stringify(row.data)}|`).join('\n');
}
const attr = (id, key, value, parent = fixture.candidateId) => ({ type: 'ATTR', id, data: { parentId: parent, key, value, zIndex: 0, strikeout: false } });
function stageHarness({ blankDevice = true, extraCandidateValue, mutateExtra = false, mutateHeader = false } = {}) {
	const oldId = 'old-component-1', oldUid = 'gge-old', deviceName = fixture.submittedTarget.component.data.attrs.DeviceName;
	const candidateData = { partId: fixture.partId, x: 10, y: 20, rotation: 0, isMirror: false, attrs: { DeviceName: deviceName, isSwitchClose: false }, zIndex: 1 };
	const attrs = [attr(fixture.attrId, 'Device', fixture.deviceUuid), attr('symbol-attr', 'Symbol', fixture.symbolUuid), attr('designator-attr', 'Designator', fixture.designator),
		attr('uid-attr', 'Unique ID', fixture.uid), attr('footprint-attr', 'Footprint', fixture.footprintUuid)];
	if (extraCandidateValue !== undefined) attrs.push(attr('extra-attr', 'Extra', extraCandidateValue));
	const oldData = { partId: 'OLD.1', x: 0, y: 0, rotation: 0, isMirror: false, attrs: {}, zIndex: 0 };
	let liveSource = sourceLog([{ type: 'COMPONENT', id: oldId, data: oldData }, { type: 'COMPONENT', id: fixture.candidateId, data: candidateData }, ...attrs]);
	let attrGets = 0;
	let freshTypedDeviceValue = fixture.deviceUuid;
	const component = {
		getState_PrimitiveId: () => fixture.candidateId, getState_Component: () => fixture.reference, getState_SubPartName: () => fixture.partId,
		getState_X: () => 10, getState_Y: () => 20, getState_Rotation: () => 0, getState_Mirror: () => false,
		getState_AddIntoBom: () => true, getState_AddIntoPcb: () => true, getState_Designator: () => fixture.designator,
		getState_UniqueId: () => fixture.uid, getState_Name: () => fixture.deviceTitle, getState_Manufacturer: () => '', getState_ManufacturerId: () => '',
		getState_Supplier: () => '', getState_SupplierId: () => '', getState_OtherProperty: () => ({}),
	};
	const candidateResult = { candidateDevice: { libraryUuid: fixture.projectUuid, uuid: fixture.deviceUuid }, resourceDocuments: fixture.resourceDocuments };
	const pcbUuid = 'pcb-regression';
	const pcbSource = sourceLog([]).replace('"docType":"SCH_PAGE"', '"docType":"PCB"').replace(fixture.pageUuid, pcbUuid);
	const prepared = { projectUuid: fixture.projectUuid, boardUuid: 'board-regression', pcbUuid, pcbSource, replacements: [{ input: { oldUid, schematicPoses: [{ x: 10, y: 20, rotation: 0, mirror: false }] }, schematicParts: [{
		pageUuid: fixture.pageUuid, componentId: oldId, subPartName: 'OLD.1', newSubPartName: fixture.partId,
		source: liveSource, native: { records: [{ type: 'COMPONENT', id: oldId, data: oldData }] }, oldTyped: {
			getState_X: () => 0, getState_Y: () => 0, getState_Rotation: () => 0, getState_Mirror: () => false,
		}, oldDeviceDefaults: {},
	}] }] };
	const previousResults = [
		{ stage: 'schematic_restore_properties', replacementIndex: 0, partIndex: 0, expectedTyped: { getState_X: 10, getState_Y: 20,
			getState_Rotation: 0, getState_Mirror: false, getState_AddIntoBom: true, getState_AddIntoPcb: true,
			getState_Designator: fixture.designator, getState_UniqueId: fixture.uid, getState_Name: fixture.deviceTitle,
			getState_Manufacturer: '', getState_ManufacturerId: '', getState_Supplier: '', getState_SupplierId: '', getState_OtherProperty: {},
			getState_SubPartName: fixture.partId } },
		{ stage: 'schematic_delete_old_part', replacementIndex: 0, partIndex: 0 },
		{ stage: 'schematic_create_part', replacementIndex: 0, partIndex: 0, candidateId: fixture.candidateId },
		{ stage: 'schematic_verify_part', replacementIndex: 0, partIndex: 0, candidateId: fixture.candidateId, subPartName: fixture.partId, candidateDeviceUuid: fixture.deviceUuid },
		{ stage: 'pcb_verify_candidate', replacementIndex: 0, ...candidateResult },
	];
	const api = {
		dmt_Project: { getCurrentProjectInfo: async () => ({ uuid: fixture.projectUuid }) },
		dmt_EditorControl: { getSplitScreenTree: async () => ({ id: 'root', tabs: [] }), openDocument: async () => 'tab', activateDocument: async () => true },
		dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ uuid: fixture.pageUuid, parentProjectUuid: fixture.projectUuid, documentType: 1 }) },
		sys_FileManager: {
			getDocumentSource: async () => liveSource,
			setDocumentSource: async submitted => {
				const changed = submitted.split(/\r?\n/).map(line => {
					const split = line.indexOf('||'); if (split < 0) return line;
					const header = JSON.parse(line.slice(0, split)), raw = line.slice(split + 2).replace(/\|$/, '');
					if (mutateHeader && header.type === 'ATTR' && header.id === fixture.attrId) header.ticket += 1;
					if (!raw) return line;
					const data = JSON.parse(raw);
					if (header.type === 'COMPONENT' && header.id === fixture.candidateId && data.attrs?.isSwitchClose === false) delete data.attrs.isSwitchClose;
					if (header.type === 'ATTR' && data.parentId === fixture.candidateId && data.strikeout === false) delete data.strikeout;
					if (blankDevice && data.key === 'Device' && data.parentId === fixture.candidateId) data.value = '';
					if (mutateExtra && data.key === 'Extra' && data.parentId === fixture.candidateId) data.value = 'after';
					return `${JSON.stringify(header)}||${JSON.stringify(data)}|`;
				}).join('\n');
				liveSource = changed; return true;
			},
		},
		sch_PrimitiveComponent: { get: async id => id === oldId ? {} : component },
		sch_PrimitiveAttribute: { get: async id => { attrGets++; return id === fixture.attrId ? { getState_PrimitiveId: () => id,
			getState_ParentPrimitiveId: () => fixture.candidateId, getState_Key: () => 'Device', getState_Value: () => freshTypedDeviceValue } : null; } },
	};
	return { api, prepared, previousResults, attrGets: () => attrGets, setFreshTypedDeviceValue: value => { freshTypedDeviceValue = value; },
		getLiveSource: () => liveSource, setLiveSource: value => { liveSource = value; }, pcbUuid, pcbSource };
}
const live = stageHarness();
const stageResult = await api.performSchematicReplacementStage(live.api, live.prepared, 0, 'schematic_restore_association',
	{ operationId: 'regression', partIndex: 0, previousResults: live.previousResults });
assert.equal(stageResult.normalizationProof.effectiveDeviceAssociation.attrId, fixture.attrId);
assert.equal(stageResult.normalizationProof.effectiveDeviceAssociation.actualRawUuid, '');
assert.equal(stageResult.normalizationProof.submittedTarget.attributes.find(row => row.id === fixture.attrId).data.value, fixture.deviceUuid);
assert.equal(stageResult.normalizationProof.immediateWireExpected.attributes.find(row => row.id === fixture.attrId).data.value, fixture.deviceUuid);
assert.equal(stageResult.normalizationProof.effectiveWireExpected.attributes.find(row => row.id === fixture.attrId).data.value, '');
assert.equal(live.attrGets(), 1, 'fresh ATTR getter is used only for the raw-empty projection');
await api.assertFreshEffectiveDeviceAssociation(live.api, stageResult.normalizationProof.effectiveDeviceAssociation, fixture.resourceDocuments);
assert.equal(live.attrGets(), 2, 'reopen-style revalidation performs a new ATTR.get call');
live.setFreshTypedDeviceValue('wrong-device');
await assert.rejects(() => api.assertFreshEffectiveDeviceAssociation(live.api, stageResult.normalizationProof.effectiveDeviceAssociation, fixture.resourceDocuments), /fresh typed Device ATTR身份/);
assert.equal(live.attrGets(), 3, 'wrong reopened typed value is rejected after another fresh ATTR.get');
const ordinary = stageHarness({ blankDevice: false });
const ordinaryResult = await api.performSchematicReplacementStage(ordinary.api, ordinary.prepared, 0, 'schematic_restore_association',
	{ operationId: 'regression-explicit', partIndex: 0, previousResults: ordinary.previousResults });
assert.equal(ordinaryResult.normalizationProof.effectiveDeviceAssociation, undefined);
assert.equal(ordinary.attrGets(), 0, 'normal explicit raw UUID path does not require new ATTR getter behavior');
	const extraDifference = stageHarness({ extraCandidateValue: 'before', mutateExtra: true });
await assert.rejects(() => api.performSchematicReplacementStage(extraDifference.api, extraDifference.prepared, 0, 'schematic_restore_association',
	{ operationId: 'regression-extra-delta', partIndex: 0, previousResults: extraDifference.previousResults }), /raw Device投影以外/);
const headerDifference = stageHarness({ mutateHeader: true });
await assert.rejects(() => api.performSchematicReplacementStage(headerDifference.api, headerDifference.prepared, 0, 'schematic_restore_association',
	{ operationId: 'regression-header-delta', partIndex: 0, previousResults: headerDifference.previousResults }), /目标COMPONENT\/ATTR headers/);

const closeFlow = stageHarness();
const closeStage = await api.performSchematicReplacementStage(closeFlow.api, closeFlow.prepared, 0, 'schematic_restore_association',
	{ operationId: 'regression-save-reopen', partIndex: 0, previousResults: closeFlow.previousResults });
closeFlow.prepared.replacements[0].schematicParts[0].source = closeFlow.getLiveSource();
const closeApi = closeFlow.api, activeTabs = new Map(), active = { docUuid: '' };
closeApi.dmt_EditorControl = {
	getSplitScreenTree: async () => ({ id: 'root', tabs: [...activeTabs.entries()].map(([docUuid, tabId]) => ({ tabId, data: { pid: fixture.projectUuid, uuid: docUuid } })) }),
	openDocument: async docUuid => { const tabId = `${docUuid}@${fixture.projectUuid}`; activeTabs.set(docUuid, tabId); active.docUuid = docUuid; return tabId; },
	activateDocument: async tabId => { const found = [...activeTabs.entries()].find(([, value]) => value === tabId); if (!found) return false; active.docUuid = found[0]; return true; },
	closeDocument: async tabId => { const found = [...activeTabs.entries()].find(([, value]) => value === tabId); if (!found) return false; activeTabs.delete(found[0]); active.docUuid = ''; return true; },
};
closeApi.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: active.docUuid, parentProjectUuid: fixture.projectUuid,
	documentType: active.docUuid === closeFlow.pcbUuid ? 3 : 1, tabId: activeTabs.get(active.docUuid) });
closeApi.sys_FileManager.getDocumentSource = async () => active.docUuid === closeFlow.pcbUuid ? closeFlow.pcbSource : closeFlow.getLiveSource();
const saveAsPersistedCandidateDefaults = () => {
	const persisted = closeFlow.getLiveSource().split(/\r?\n/).map(line => {
		const split = line.indexOf('||'); if (split < 0) return line;
		const header = JSON.parse(line.slice(0, split)), raw = line.slice(split + 2).replace(/\|$/, ''); if (!raw) return line;
		const data = JSON.parse(raw);
		if (header.type === 'COMPONENT' && header.id === fixture.candidateId) data.attrs.isSwitchClose = false;
		if (header.type === 'ATTR' && data.parentId === fixture.candidateId && ['Device','Symbol','Designator','Unique ID','Footprint'].includes(data.key)) data.strikeout = false;
		return `${JSON.stringify(header)}||${JSON.stringify(data)}|`;
	}).join('\n');
	closeFlow.setLiveSource(persisted);
};
closeApi.sch_Document = { save: async () => { saveAsPersistedCandidateDefaults(); return true; } };
closeApi.pcb_Document = { save: async () => true };
const frozenPrior = structuredClone([...closeFlow.previousResults, closeStage]);
const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); } return value; };
deepFreeze(frozenPrior);
const frozenAssociationBefore = JSON.stringify(frozenPrior.find(row => row.stage === 'schematic_restore_association').normalizationProof);
const verification = api.createReplacementVerification(closeApi);
verification.reset(closeFlow.prepared);
const closeResult = await verification.saveCloseReopen(closeFlow.prepared, frozenPrior);
assert.equal(closeResult.after.length, 2);
assert.equal(closeResult.candidateDefaultPersistenceProofs[0].reopenTypedAttr.value, fixture.deviceUuid);
assert.equal(JSON.stringify(frozenPrior.find(row => row.stage === 'schematic_restore_association').normalizationProof), frozenAssociationBefore,
	'save/reopen emits new proof output without mutating the recursively frozen prior-stage result');
console.log(`production schematic_restore_association replay passed; fresh typed reads=${live.attrGets() + ordinary.attrGets()}`);

console.log(`effective Device association regression passed (${rejected.length} negative projection cases, 5 fresh typed reopen failures)`);
