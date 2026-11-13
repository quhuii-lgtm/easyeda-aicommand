import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const bundled = await build({ stdin: { contents: `import { pcbRegionMarkerCommands } from '../src/commands/pcbRegionMarkers.ts'; export { pcbRegionMarkerCommands }`, resolveDir: resolve(root, 'test'), sourcefile: 'pcb-region-markers-entry.ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
const { pcbRegionMarkerCommands } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const handlers = Object.fromEntries(pcbRegionMarkerCommands.map(command => [command.name, command.handler]));

function source(uuid, records) {
	return [
		`${JSON.stringify({ type: 'DOCHEAD', id: uuid, ticket: 0 })}||${JSON.stringify({ docType: uuid.startsWith('pcb') ? 'PCB' : 'SCH', uuid, client: 'test' })}`,
		...records.map(([type, id, data], index) => `${JSON.stringify({ type, id, ticket: index + 1 })}||${JSON.stringify(data)}`),
	].join('|\n');
}
const sch1 = source('sch-1', [
	['RECT', 'rect-power', { dotX1: 0, dotY1: 0, dotX2: 100, dotY2: 100 }],
	['ATTR', 'a1', { parentId: 'rect-power', key: 'Name', value: 'Power' }],
	['TEXT', 'title-power', { x: 10, y: 30, value: 'Power title' }],
	['COMPONENT', 'sch-u1', { x: 20, y: 20 }], ['ATTR', 'a2', { parentId: 'sch-u1', key: 'Designator', value: 'U1' }], ['ATTR', 'a6', { parentId: 'sch-u1', key: 'Unique ID', value: 'uid-u1' }],
	['COMPONENT', 'sch-c5', { x: 50, y: 50 }], ['ATTR', 'a3', { parentId: 'sch-c5', key: 'Designator', value: 'C5' }], ['ATTR', 'a7', { parentId: 'sch-c5', key: 'Unique ID', value: 'uid-c5' }],
	['COMPONENT', 'sch-u2a', { x: 60, y: 60 }], ['ATTR', 'a11', { parentId: 'sch-u2a', key: 'Designator', value: 'U2' }], ['ATTR', 'a12', { parentId: 'sch-u2a', key: 'Unique ID', value: 'uid-u2' }],
	['COMPONENT', 'sch-u2b', { x: 65, y: 65 }], ['ATTR', 'a13', { parentId: 'sch-u2b', key: 'Designator', value: 'U2' }], ['ATTR', 'a14', { parentId: 'sch-u2b', key: 'Unique ID', value: 'uid-u2' }],
]);
const sch2 = source('sch-2', [
	['RECT', 'rect-sense', { dotX1: 200, dotY1: 0, dotX2: 300, dotY2: 100 }],
	['TEXT', 'title-sense', { x: 210, y: 30, value: 'Sense title' }],
	['COMPONENT', 'sch-y2', { x: 240, y: 40 }], ['ATTR', 'a5', { parentId: 'sch-y2', key: 'Designator', value: 'Y2' }], ['ATTR', 'a8', { parentId: 'sch-y2', key: 'Unique ID', value: 'uid-y2' }],
]);
const pcbRecords = [
	['COMPONENT', 'pcb-u1', { designator: 'U1', x: 20, y: 20, angle: 0, layerId: 1, locked: false, attrs: { 'Unique ID': 'uid-u1' } }],
	['COMPONENT', 'pcb-c5', { designator: 'C5', x: 50, y: 50, angle: 0, layerId: 1, locked: true, attrs: { 'Unique ID': 'uid-c5' } }],
	['COMPONENT', 'pcb-y2', { designator: 'Y2', x: 240, y: 40, angle: 90, layerId: 2, locked: true, attrs: { 'Unique ID': 'uid-y2' } }],
	['COMPONENT', 'pcb-u2', { designator: 'U2', x: 65, y: 65, angle: 0, layerId: 1, locked: false, attrs: { 'Unique ID': 'uid-u2' } }],
];
let pcbSource = source('pcb-1', pcbRecords);
const pageSources = new Map([['sch-1', sch1], ['sch-2', sch2]]);
let current = { documentType: 3, uuid: 'pcb-1', tabId: 'pcb-tab' };
let tabs = [{ title: 'PCB', tabId: 'pcb-tab', uuid: 'pcb-1' }, { title: 'SCH existing', tabId: 'sch1-existing', uuid: 'sch-1' }];
const tabById = new Map([['pcb-tab', { uuid: 'pcb-1', documentType: 3 }], ['sch1-existing', { uuid: 'sch-1', documentType: 1 }]]);
let createdTabs = 0, closedTabs = [], selected = [], crossProbeArgs, zoomArgs, saveCount = 0, writeCount = 0;
let normalizeDocheadBeforeWrite = false, pcbReadCount = 0;
let rejectNextWrite = false, dropNextTombstone = false;
let markerTransform = '';
globalThis.eda = {
	dmt_SelectControl: { getCurrentDocumentInfo: async () => current },
	dmt_Project: { getCurrentProjectInfo: async () => ({ data: [{ pcb: { uuid: 'pcb-1' }, schematic: { page: [{ uuid: 'sch-1', name: 'Main' }, { uuid: 'sch-2', name: 'Sensors' }] } }] }) },
	dmt_EditorControl: {
		getSplitScreenTree: async () => ({ id: 'root', tabs: tabs.map(t => ({ tabId: t.tabId })) }),
		openDocument: async uuid => {
			const existing = tabs.find(t => t.uuid === uuid); if (existing) return existing.tabId;
			const tabId = `new-${++createdTabs}`; tabs.push({ title: uuid, tabId, uuid }); tabById.set(tabId, { uuid, documentType: 1 }); return tabId;
		},
		activateDocument: async tabId => { const doc = tabById.get(tabId); if (!doc) return false; current = { ...doc, tabId }; return true },
		closeDocument: async tabId => { closedTabs.push(tabId); tabs = tabs.filter(t => t.tabId !== tabId); tabById.delete(tabId); return true },
		zoomToSelectedPrimitives: async tabId => { zoomArgs = tabId; return { left: 1, right: 2, top: 3, bottom: 0 } },
	},
	sys_FileManager: { getDocumentSource: async () => {
		if (current.uuid !== 'pcb-1') return pageSources.get(current.uuid);
		pcbReadCount++;
		if (normalizeDocheadBeforeWrite && pcbReadCount === 2) pcbSource = pcbSource.replace(/^(\{[^\n]+\}\|\|\{[^\n]+client":")[^"]+/, '$1normalized-runtime');
		return pcbSource;
	}, setDocumentSource: async value => {
		writeCount++; if (rejectNextWrite) { rejectNextWrite = false; return false }
		if (dropNextTombstone) { dropNextTombstone = false; pcbSource = value.split(/\r?\n/).filter((line, index, all) => !(line.includes('||""') && index === all.findIndex(candidate => candidate.includes('||""')))).join('\n'); return true }
		pcbSource = value.split(/\r?\n/).map(line => {
			const separator = line.indexOf('||'); if (separator < 0 || !line.includes('aicr_region_')) return line
			const rawData = line.slice(separator + 2), trailing = rawData.endsWith('|') ? '|' : ''
			const header = JSON.parse(line.slice(0, separator)), data = JSON.parse(trailing ? rawData.slice(0, -1) : rawData)
			if (header.id.startsWith('aicr_region_')) {
				if (markerTransform === 'normalize') { if (data.path) data.path = data.path.map((v, i) => typeof v === 'number' && i > 0 && i < 5 ? Number((v + 1e-12).toFixed(4)) : v); if (data.fontFamily) data.fontFamily = '黑体' }
				if (markerTransform === 'bad-coordinate' && data.path) data.path[1] += 1
				if (markerTransform === 'bad-font' && data.fontFamily) data.fontFamily = 'Arial'
				if (markerTransform === 'bad-text' && data.text) data.text = 'incorrect text'
			}
			return `${JSON.stringify(header)}||${JSON.stringify(data)}${trailing}`
		}).join('\n')
		return true
	} },
	pcb_Primitive: { getPrimitivesBBox: async ids => ({ minX: ids[0] === 'pcb-u1' ? 10 : ids[0] === 'pcb-c5' ? 40 : ids[0] === 'pcb-u2' ? 60 : 230, minY: ids[0] === 'pcb-u2' ? 10 : 5, maxX: ids[0] === 'pcb-y2' ? 260 : ids[0] === 'pcb-u2' ? 75 : 70, maxY: ids[0] === 'pcb-u1' ? 60 : ids[0] === 'pcb-u2' ? 85 : 80 }) },
	pcb_SelectControl: {
		doCrossProbeSelect: async (...args) => { crossProbeArgs = args; selected = ['pcb-u1', 'pcb-c5', 'pcb-u2']; return true },
		getAllSelectedPrimitives_PrimitiveId: async () => selected,
	},
	pcb_Document: { save: async () => { saveCount++; return true } },
	sys_FontManager: { getFontsList: async () => ['default', 'Arial', '黑体'] },
};

const preview = await handlers['pcb.getSchematicRegions']({ __docUuid: 'pcb-1', __tabId: 'pcb-tab' });
assert.equal(preview.regions.length, 2);
const power = preview.regions.find(r => r.name === 'Main/Power');
assert.deepEqual(power.members.map(m => [m.componentId, m.locked]), [['pcb-u1', false], ['pcb-c5', true], ['pcb-u2', false]], 'locked members are included and same-region multipart U2 is deduplicated by UID');
assert.equal(power.name, 'Main/Power', 'RECT Name attribute takes priority over nearby text');
assert.deepEqual(power.bbox, { minX: 10, minY: 5, maxX: 75, maxY: 85 });
assert.equal(preview.regions.find(r => r.rectId === 'rect-sense').name, 'Sensors/Sense title', 'unique near-top-left TEXT labels a RECT without Name ATTR');
assert.equal(current.uuid, 'pcb-1', 'SCH traversal restores PCB focus');
assert.deepEqual(closedTabs, ['new-1'], 'only newly opened SCH tab is closed; pre-existing SCH tab stays open');

const stale = await handlers['pcb.markSchematicRegions']({ dryRun: false, expectedSignature: 'stale' }).then(() => false, () => true);
assert.equal(stale, true);
assert.equal(writeCount, 0, 'stale preview signature rejects before write');
markerTransform = 'normalize';
const marked = await handlers['pcb.markSchematicRegions']({ dryRun: false, expectedSignature: preview.signature });
markerTransform = '';
assert.equal(marked.verified, true);
assert.equal(saveCount, 1);
const after = (await import(`data:text/javascript;base64,${Buffer.from((await build({ stdin: { contents: `import { parseSourceLog, resolveRecords } from '../src/pcb/sourcelog.ts'; export { parseSourceLog, resolveRecords }`, resolveDir: resolve(root, 'test'), sourcefile: 'source-log-entry.ts' }, bundle: true, platform: 'node', format: 'esm', write: false })).outputFiles[0].text).toString('base64')}`));
const effective = after.resolveRecords(after.parseSourceLog(pcbSource));
const markers = [...effective.values()].filter(record => record.header.id.startsWith('aicr_region_'));
assert.equal(markers.length, 4, 'two regions create exactly two active markers each');
assert.equal(markers.filter(r => r.data.layerId === 13).length, 4);
const componentSnapshot = [...after.resolveRecords(after.parseSourceLog(source('pcb-1', pcbRecords))).values()].filter(r => r.header.type === 'COMPONENT').map(r => JSON.stringify(r.data));
assert.deepEqual([...effective.values()].filter(r => r.header.type === 'COMPONENT').map(r => JSON.stringify(r.data)), componentSnapshot, 'marker write leaves all component data unchanged');
const countAfterFirst = markers.length;
await handlers['pcb.markSchematicRegions']({ dryRun: false, expectedSignature: preview.signature });
assert.equal([...after.resolveRecords(after.parseSourceLog(pcbSource)).values()].filter(r => r.header.id.startsWith('aicr_region_')).length, countAfterFirst, 'repeated update revisions existing marker IDs without duplication');

normalizeDocheadBeforeWrite = true; pcbReadCount = 0;
await handlers['pcb.markSchematicRegions']({ dryRun: false, expectedSignature: preview.signature });
assert.equal(saveCount, 3, 'runtime DOCHEAD field normalization is excluded from non-target data checks');

const cleanMarkerSource = pcbSource;
for (const mode of ['bad-coordinate', 'bad-font', 'bad-text']) {
	pcbSource = cleanMarkerSource;
	pageSources.set('sch-1', sch1.replace('"value":"Power"', '"value":"Power revised"'));
	markerTransform = mode;
	await assert.rejects(handlers['pcb.markSchematicRegions']({ dryRun: false }), error => {
		assert.equal(error.cause.partial, true);
		assert.match(error.message, /标记读回不符/);
		return true;
	}, `${mode} must fail exact marker DATA verification`);
	markerTransform = '';
	pageSources.set('sch-1', sch1);
}
pcbSource = cleanMarkerSource;

const located = await handlers['pcb.locateSchematicRegion']({ regionId: power.regionId, __docUuid: 'pcb-1', __tabId: 'pcb-tab' });
assert.deepEqual(crossProbeArgs, [['U1', 'C5', 'U2'], undefined, undefined, true, true], 'cross probe receives designators, not component IDs');
assert.equal(located.selectedIds.length, 3);
assert.equal(zoomArgs, 'pcb-tab');

const wrong = await handlers['pcb.getSchematicRegions']({ __docUuid: 'other-pcb', __tabId: 'pcb-tab' }).then(() => false, () => true);
assert.equal(wrong, true, 'target mismatch refuses fallback to another PCB');

const pcbSourceBeforeIdentity = pcbSource;
pcbSource = pcbSource.replace('uid-u1', 'uid-other');
const identityConflict = await handlers['pcb.getSchematicRegions']({});
const identityRegion = identityConflict.regions.find(r => r.rectId === 'rect-power');
assert.ok(identityRegion.identityConflicts.includes('U1'), 'a non-empty conflicting PCB UID blocks designator fallback');
assert.ok(identityRegion.unmatched.includes('U1'));
pcbSource = pcbSourceBeforeIdentity;

rejectNextWrite = true;
const savedBeforeFailure = saveCount;
pageSources.set('sch-1', sch1.replace('"value":"Power"', '"value":"Power revised"'));
await assert.rejects(handlers['pcb.markSchematicRegions']({ dryRun: false }), error => {
	assert.equal(error.cause.partial, true, 'uncertain SDK write failure is explicitly partial');
	assert.ok(error.cause.writtenIds.length > 0);
	return true;
});
pageSources.set('sch-1', sch1);
assert.equal(saveCount, savedBeforeFailure, 'failed/unverified write is not saved');
assert.equal(writeCount, 7, 'only explicit marking attempts use source writes');

pageSources.set('sch-2', source('sch-2', [['COMPONENT', 'orphan', { x: 400, y: 400 }]]));
dropNextTombstone = true;
const beforeTombstoneFailureSave = saveCount;
await assert.rejects(handlers['pcb.markSchematicRegions']({ dryRun: false }), error => {
	assert.equal(error.cause.partial, true);
	assert.match(error.message, /墓碑未生效/);
	return true;
});
assert.equal(saveCount, beforeTombstoneFailureSave, 'failed tombstone readback prevents save');
assert.equal(writeCount, 8);
pageSources.set('sch-2', sch2);

const crossRegionU2 = source('sch-2', [
	['RECT', 'rect-sense', { dotX1: 200, dotY1: 0, dotX2: 300, dotY2: 100 }],
	['TEXT', 'title-sense', { x: 210, y: 30, value: 'Sense title' }],
	['COMPONENT', 'sch-y2', { x: 240, y: 40 }], ['ATTR', 'a5', { parentId: 'sch-y2', key: 'Designator', value: 'Y2' }], ['ATTR', 'a8', { parentId: 'sch-y2', key: 'Unique ID', value: 'uid-y2' }],
	['COMPONENT', 'sch-u2-sense', { x: 250, y: 50 }], ['ATTR', 'a15', { parentId: 'sch-u2-sense', key: 'Designator', value: 'U2' }], ['ATTR', 'a16', { parentId: 'sch-u2-sense', key: 'Unique ID', value: 'uid-u2' }],
]);
pageSources.set('sch-2', crossRegionU2);
const ambiguous = await handlers['pcb.getSchematicRegions']({});
assert.ok(ambiguous.regions.find(r => r.name === 'Main/Power').ambiguous.includes('U2'), 'a PCB member claimed by different regions is ambiguous');
assert.ok(ambiguous.regions.find(r => r.name === 'Sensors/Sense title').ambiguous.includes('U2'));
pageSources.set('sch-2', sch2);

assert.equal(writeCount, 8, 'read-only and locate operations do not write source');
console.log('PASS PCB schematic region markers preserve component data, include locked members, update without duplication, restore tabs, and locate by designator');
