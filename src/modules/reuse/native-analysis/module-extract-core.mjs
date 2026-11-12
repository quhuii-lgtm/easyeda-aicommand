import { createInstanceResourceAdapter } from './instance-resources-core.mjs';

export function createModuleExtractor({ JSZip, sha256, inspectNativeProject, cloneJson } = {}) {
for (const [name,value] of Object.entries({JSZip,sha256,inspectNativeProject,cloneJson})) if (typeof value !== 'function' && name !== 'JSZip') throw new Error(`${name} dependency is required`);
if (!JSZip || typeof JSZip.loadAsync !== 'function') throw new Error('JSZip dependency is required');
const { deriveInstanceResources } = createInstanceResourceAdapter({ JSZip, sha256, inspectNativeProject, cloneJson });

function parseNative(source) {
	const docs = [];
	const byUuid = new Map();
	let current;
	for (const [index, raw] of source.split(/\r?\n/).entries()) {
		if (!raw.trim()) continue;
		const split = raw.indexOf('||');
		if (split < 0) throw new Error(`line ${index + 1}: missing ||`);
		const header = JSON.parse(raw.slice(0, split));
		let rawData = raw.slice(split + 2);
		if (rawData.endsWith('|')) rawData = rawData.slice(0, -1);
		const data = rawData === '' ? '' : JSON.parse(rawData);
		if (header.type === 'DOCHEAD') {
			if (!data || typeof data.docType !== 'string' || typeof data.uuid !== 'string') throw new Error(`line ${index + 1}: invalid DOCHEAD`);
			current = byUuid.get(data.uuid);
			if (current && current.docType !== data.docType) throw new Error(`DOCHEAD type conflict for ${data.uuid}`);
			if (!current) {
				current = { docType: data.docType, uuid: data.uuid, heads: [], effective: new Map(), rawRecords: [] };
				byUuid.set(data.uuid, current); docs.push(current);
			}
			current.heads.push({ header, data, raw });
			continue;
		}
		if (!current) throw new Error(`line ${index + 1}: record before DOCHEAD`);
		const item = { header, data, raw, line: index + 1 };
		current.rawRecords.push(item);
		const key = JSON.stringify([header.type, header.id]);
		const prior = current.effective.get(key);
		if (!prior || header.ticket > prior.header.ticket) current.effective.set(key, item);
		else if (header.ticket === prior.header.ticket && raw !== prior.raw) throw new Error(`same-ticket conflict ${header.type}/${header.id}`);
	}
	for (const doc of docs) doc.effectiveRecords = [...doc.effective.values()].filter(r => r.data !== '');
	return { docs, byUuid };
}

function setOf(values) { return new Set(values); }
function count(doc, type) { return doc.effectiveRecords.filter(r => r.header.type === type).length; }
function get(doc, type) { return doc.effectiveRecords.filter(r => r.header.type === type); }
function values(doc, type, key) { return get(doc, type).map(r => r.data?.[key]); }
function onlyDoc(parsed, type, uuid) {
	const doc = parsed.docs.find(d => d.docType === type && d.uuid === uuid);
	if (!doc) throw new Error(`missing ${type} ${uuid}`);
	return doc;
}
function replaceData(record, data) {
	return `${JSON.stringify(record.header)}||${JSON.stringify(data)}|`;
}
function serializeDoc(doc, records, preserveRaw = false) {
	const head = doc.heads.at(-1);
	if (preserveRaw) return [head.raw, ...doc.rawRecords.map(r => r.raw)].join('\n');
	const rows = records.map(r => r.changedData === undefined ? r.raw : replaceData(r, r.changedData));
	return [head.raw, ...rows].join('\n');
}
function setFromWorkcard(card, key) { return new Set(card.selected?.[key] ?? []); }
function validateUniqueList(values, label) {
	if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
	if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate IDs`);
}
function safeEpruName(value) {
	const base = String(value || '').replace(/\\/g, '/').split('/').at(-1);
	const safe = base.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '');
	if (!safe || safe === '.' || safe === '..') throw new Error('output epru name must be a safe basename');
	return safe.toLowerCase().endsWith('.epru') ? safe : `${safe}.epru`;
}
function netName(record) {
	const d = record.data;
	if (typeof d === 'string') return d;
	for (const key of ['net', 'netName', 'padNet', 'name']) if (typeof d?.[key] === 'string') return d[key];
	try { const id = JSON.parse(record.header.id); if (Array.isArray(id)) return id.at(-1); } catch {}
	return '';
}
function groupClosure(doc, roots, label) {
	const all = get(doc, 'GROUP');
	const byId = new Map(all.map(row => [row.header.id, row]));
	const closure = new Set();
	const visiting = new Set();
	const visit = rawId => {
		if (rawId === undefined || rawId === null || String(rawId) === '' || String(rawId) === '0') return;
		const id = String(rawId);
		if (closure.has(id)) return;
		if (visiting.has(id)) throw new Error(`${label} GROUP parent cycle at ${id}`);
		const row = byId.get(id);
		if (!row) throw new Error(`${label} references missing GROUP ${id}`);
		visiting.add(id);
		const parent = row.data?.parentId;
		if (parent !== undefined && parent !== null && String(parent) !== '' && String(parent) !== '0') visit(parent);
		visiting.delete(id);
		closure.add(id);
	};
	for (const id of roots) visit(id);
	return closure;
}

async function trimSource({ sourceBytes, projectText, epruText, workcard }) {
	const sourceHash = await sha256(sourceBytes);
	if (workcard.sourceSha256 && sourceHash !== workcard.sourceSha256) throw new Error(`source SHA256 mismatch: ${sourceHash}`);
	const project = JSON.parse(projectText);
	const inspected = inspectNativeProject({ projectMetadata: project, source: epruText });
	const parsed = {
		docs: inspected.documents.map(doc => ({ ...doc, heads: doc.docHeads })),
	};
	const board = onlyDoc(parsed, 'BOARD', workcard.boardUuid);
	const sch = onlyDoc(parsed, 'SCH', workcard.schematicUuid);
	const page = onlyDoc(parsed, 'SCH_PAGE', workcard.schematicPageUuid);
	const pcb = onlyDoc(parsed, 'PCB', workcard.pcbUuid);
	if (workcard.sourceProjectUuid && project.uuid && project.uuid !== workcard.sourceProjectUuid) throw new Error('sourceProjectUuid does not match project2.json');
	const one = (doc, type) => {
		const rows = get(doc, type);
		if (rows.length !== 1) throw new Error(`${doc.docType} must contain one ${type} association record`);
		return rows[0].data;
	};
	const boardMeta = one(board, 'META'), schMeta = one(sch, 'META'), pageMeta = one(page, 'META'), pcbMeta = one(pcb, 'META');
	if (schMeta.board !== board.uuid || pageMeta.schematic !== sch.uuid || pcbMeta.board !== board.uuid) throw new Error('workcard documents do not form one BOARD/SCH/SCH_PAGE/PCB association chain');
	if ((boardMeta.schematic && boardMeta.schematic !== sch.uuid) || (boardMeta.pcb && boardMeta.pcb !== pcb.uuid)) throw new Error('BOARD META association points outside selected document chain');
	for (const key of ['uids','pcbComponentIds','pcbLineIds','pcbViaIds','pcbStringIds','pcbOwnedPolyIds','pcbArcIds','pcbStandalonePadIds','schComponentIds','schWireIds','schLineIds','schTextIds']) validateUniqueList(workcard.selected?.[key] ?? [], key);
	const ids = {
		uid: setFromWorkcard(workcard, 'uids'),
		pcbComponent: setFromWorkcard(workcard, 'pcbComponentIds'),
		pcbLine: setFromWorkcard(workcard, 'pcbLineIds'),
		pcbVia: setFromWorkcard(workcard, 'pcbViaIds'),
		pcbString: setFromWorkcard(workcard, 'pcbStringIds'),
		pcbPoly: setFromWorkcard(workcard, 'pcbOwnedPolyIds'),
		pcbArc: setFromWorkcard(workcard, 'pcbArcIds'),
		pcbStandalonePad: setFromWorkcard(workcard, 'pcbStandalonePadIds'),
		schComponent: setFromWorkcard(workcard, 'schComponentIds'),
		schWire: setFromWorkcard(workcard, 'schWireIds'),
		schLine: setFromWorkcard(workcard, 'schLineIds'),
		schText: setFromWorkcard(workcard, 'schTextIds'),
	};
	for (const [name, values] of Object.entries(ids)) validateUniqueList([...values], name);
	if (!Array.isArray(workcard.interfaces) || !Array.isArray(workcard.internalNets)) throw new Error('interfaces and internalNets must be arrays');
	const nets = new Set([...workcard.interfaces, ...workcard.internalNets]);
	if (nets.size !== workcard.interfaces.length + workcard.internalNets.length) throw new Error('interfaces/internalNets contain duplicate nets');
	const componentRows = get(pcb, 'COMPONENT');
	const selectedComponents = componentRows.filter(r => ids.pcbComponent.has(r.header.id));
	if (selectedComponents.length !== ids.pcbComponent.size) throw new Error(`selected PCB components found ${selectedComponents.length}, expected ${ids.pcbComponent.size}`);
	const uidToPcb = new Map(selectedComponents.map(r => [r.data.attrs?.['Unique ID'], r.header.id]));
	if (uidToPcb.size !== selectedComponents.length || [...ids.uid].some(uid => !uidToPcb.has(uid)) || ids.uid.size !== selectedComponents.length) throw new Error('PCB component UID whitelist mismatch or duplicate UID');
	for (const id of ids.pcbComponent) if (!selectedComponents.some(r => r.header.id === id)) throw new Error(`missing selected PCB component ${id}`);
	const selectedPcbComponentSet = setOf(selectedComponents.map(r => r.header.id));
	const selectedPcbObjects = [...selectedComponents,
		...['LINE','VIA','ARC','PAD','STRING','POLY'].flatMap(type => {
			const chosen = {LINE:ids.pcbLine,VIA:ids.pcbVia,ARC:ids.pcbArc,PAD:ids.pcbStandalonePad,STRING:ids.pcbString,POLY:ids.pcbPoly}[type];
			return get(pcb,type).filter(r => chosen.has(r.header.id));
		})];
	const referencedPcbGroups = groupClosure(pcb, [workcard.selected.pcbGroupId, ...selectedPcbObjects.map(r => r.data.groupId)], 'selected PCB object');
	const selectedPcbParentIds = new Set([...selectedPcbObjects.map(r=>r.header.id), ...referencedPcbGroups]);
	for (const id of ids.pcbStandalonePad) {
		const pad = get(pcb,'PAD').find(r => r.header.id === id);
		if (!pad?.data || !pad.data.hole) throw new Error(`selected PAD ${id} is not a standalone hole pad`);
	}
	const selectedDeviceUuids = new Set();
	for (const component of selectedComponents) {
		const deviceName = JSON.parse(component.data.attrs?.DeviceName || 'null');
		if (!deviceName?.uuid) throw new Error(`component ${component.header.id} missing DeviceName UUID`);
		selectedDeviceUuids.add(deviceName.uuid);
	}
	const resources = { DEVICE: new Set(selectedDeviceUuids), SYMBOL: new Set(), FOOTPRINT: new Set() };
	const instanceReferences = [];
	const addInstanceReference = (type, uuid, owner, name = null, raw = null) => {
		if (uuid === undefined || uuid === null || uuid === '') return;
		if (typeof uuid !== 'string') throw new Error(`${owner}: ${type} instance reference must be a string UUID`);
		resources[type].add(uuid);
		instanceReferences.push({ type, uuid, owner, ...(name ? { name } : {}), ...(raw ? { serializedName: raw } : {}) });
	};
	const addSerializedReference = (key, value, owner) => {
		if (value === undefined || value === null || value === '' || value === '[]') return;
		if (key === 'DeviceName') {
			const decoded = typeof value === 'string' ? JSON.parse(value) : value;
			if (decoded?.uuid) addInstanceReference('DEVICE', decoded.uuid, owner, decoded.name || null, value);
		} else if (key === 'SymbolName' || key === 'FootprintName') {
			const decoded = typeof value === 'string' ? JSON.parse(value) : value;
			if (decoded?.uuid) addInstanceReference(key === 'SymbolName' ? 'SYMBOL' : 'FOOTPRINT', decoded.uuid, owner, decoded.name || null, value);
		} else if (key === 'Symbols' || key === 'Footprints') {
			const decoded = typeof value === 'string' ? JSON.parse(value) : value;
			if (Array.isArray(decoded)) for (const item of decoded) if (item?.uuid) addInstanceReference(key === 'Symbols' ? 'SYMBOL' : 'FOOTPRINT', item.uuid, owner, item.name || null, value);
		}
	};
	for (const component of selectedComponents) addSerializedReference('DeviceName', component.data.attrs?.DeviceName, `PCB COMPONENT ${component.header.id}`);
	const selectedPcbAttrs = get(pcb, 'ATTR').filter(r => selectedComponents.some(c => c.header.id === r.data.parentId));
	for (const attr of selectedPcbAttrs) {
		const owner = `PCB ATTR ${attr.header.id} (${attr.data.parentId})`;
		if (['Device', 'Symbol', 'Footprint'].includes(attr.data.key)) addInstanceReference(attr.data.key.toUpperCase() === 'DEVICE' ? 'DEVICE' : attr.data.key.toUpperCase(), attr.data.value, owner);
		else addSerializedReference(attr.data.key, attr.data.value, owner);
	}
	const selectedSchComponentSet = setOf(ids.schComponent);
	const selectedSchObjects = [
		...get(page,'COMPONENT').filter(r=>selectedSchComponentSet.has(r.header.id)),
		...get(page,'WIRE').filter(r=>ids.schWire.has(r.header.id)),
		...get(page,'LINE').filter(r=>ids.schLine.has(r.header.id)),
		...get(page,'TEXT').filter(r=>ids.schText.has(r.header.id)),
	];
	const referencedSchGroups = groupClosure(page, [workcard.selected.schGroupId, ...selectedSchObjects.map(r=>r.data.groupId)], 'selected SCH object');
	const selectedSchParentIds = new Set([...selectedSchObjects.map(r=>r.header.id), ...referencedSchGroups]);
	if (get(page, 'COMPONENT').filter(r => selectedSchComponentSet.has(r.header.id)).length !== ids.schComponent.size) throw new Error('selected schematic component IDs are missing or ambiguous');
	for (const component of get(page, 'COMPONENT').filter(r => selectedSchComponentSet.has(r.header.id))) {
		for (const key of ['DeviceName', 'SymbolName', 'FootprintName', 'Symbols', 'Footprints']) addSerializedReference(key, component.data.attrs?.[key], `SCH COMPONENT ${component.header.id}`);
	}
	for (const attr of get(page, 'ATTR').filter(r => selectedSchComponentSet.has(r.data.parentId))) {
		const owner = `SCH ATTR ${attr.header.id} (${attr.data.parentId})`;
		if (['Device', 'Symbol', 'Footprint'].includes(attr.data.key)) addInstanceReference(attr.data.key.toUpperCase(), attr.data.value, owner);
		else addSerializedReference(attr.data.key, attr.data.value, owner);
	}
	for (const uuid of resources.DEVICE) {
		const device = onlyDoc(parsed, 'DEVICE', uuid);
		const meta = get(device, 'META').at(-1)?.data;
		const attrs = meta?.attributes;
		if (!attrs || !attrs.Symbol || !attrs.Footprint) throw new Error(`device ${uuid} lacks Symbol/Footprint closure`);
		addInstanceReference('SYMBOL', attrs.Symbol, `DEVICE ${uuid} META.Symbol`, attrs.SymbolName ? JSON.parse(attrs.SymbolName).name : null, attrs.SymbolName || null);
		addInstanceReference('FOOTPRINT', attrs.Footprint, `DEVICE ${uuid} META.Footprint`, attrs.FootprintName ? JSON.parse(attrs.FootprintName).name : null, attrs.FootprintName || null);
		for (const key of ['SymbolName', 'FootprintName']) if (attrs[key]) {
			const embedded = JSON.parse(attrs[key]);
			if (embedded.uuid !== attrs[key.replace('Name', '')]) throw new Error(`${uuid} embedded ${key} UUID mismatch`);
		}
	}
	for (const uuid of resources.SYMBOL) onlyDoc(parsed, 'SYMBOL', uuid);
	for (const uuid of resources.FOOTPRINT) onlyDoc(parsed, 'FOOTPRINT', uuid);

	const rowsByDoc = new Map();
	const unknownReferences = [];
	const preservedExternalReferences = [];
	for (const uuid of resources.DEVICE) {
		const device = onlyDoc(parsed, 'DEVICE', uuid);
		const meta = get(device, 'META').at(-1)?.data;
		if (meta?.source) preservedExternalReferences.push({ kind: 'device-source', deviceUuid: uuid, value: meta.source, status: 'retained-in-device-META; source document not part of selected native closure' });
		const model = meta?.attributes?.['3D Model'];
		if (model) preservedExternalReferences.push({ kind: '3d-model', deviceUuid: uuid, value: model, title: meta.attributes['3D Model Title'] || '', transform: meta.attributes['3D Model Transform'] || '', status: 'retained-in-device-META; model payload unavailable in source epro2 document set' });
	}
	const keepAllTypes = new Set(['CANVAS', 'LAYER', 'LAYER_PHYS', 'ACTIVE_LAYER', 'PREFERENCE', 'META', 'PRIMITIVE', 'SILK_OPTS', 'D3_ATTRIBUTE', 'PANELIZE', 'RULE_TEMPLATE', 'RULE', 'ELE_PLACEHOLDER']);
	function chosen(doc) {
		const keep = [];
		for (const r of doc.effectiveRecords) {
			const t = r.header.type, id = r.header.id, d = r.data;
			let include = false;
			if (['BOARD', 'SCH'].includes(doc.docType)) include = t === 'META';
			else if (doc.docType === 'SCH_PAGE') {
				if (t === 'COMPONENT') include = ids.schComponent.has(id);
				else if (t === 'WIRE') include = ids.schWire.has(id);
				else if (t === 'LINE') include = ids.schLine.has(id);
				else if (t === 'TEXT') include = ids.schText.has(id);
				else if (t === 'ATTR') include = selectedSchParentIds.has(String(d.parentId));
				else if (t === 'GROUP') include = referencedSchGroups.has(id);
				else if (t === 'CANVAS' || t === 'META' || t === 'ELE_PLACEHOLDER') include = true;
			} else if (doc.docType === 'PCB') {
				if (t === 'COMPONENT') include = ids.pcbComponent.has(id);
				else if (t === 'ATTR') include = selectedPcbParentIds.has(String(d.parentId));
				else if (t === 'PAD_NET') include = selectedPcbComponentSet.has(JSON.parse(id)[1]);
				else if (t === 'LINE') include = ids.pcbLine.has(id);
				else if (t === 'VIA') include = ids.pcbVia.has(id);
				else if (t === 'ARC') include = ids.pcbArc.has(id);
				else if (t === 'PAD') include = ids.pcbStandalonePad.has(id);
				else if (t === 'STRING') include = ids.pcbString.has(id);
				else if (t === 'POLY') include = ids.pcbPoly.has(id);
				else if (t === 'NET') include = nets.has(typeof d === 'string' ? d : d.name || d.netName || JSON.parse(id)[1]);
				else if (t === 'RULE_SELECTOR') {
					const sel = JSON.parse(id);
					include = !Array.isArray(sel) || sel[1]?.[0] !== 'NET' || sel[1][1] === '' || nets.has(sel[1][1]);
					if (!include) unknownReferences.push({ kind: 'excluded-rule-selector', id, net: sel[1]?.[1] });
				} else if (t === 'GROUP') include = referencedPcbGroups.has(id);
				else if (keepAllTypes.has(t)) include = true;
				if (['POUR', 'POURED', 'FILL', 'REGION', 'IMAGE'].includes(t)) include = false;
			} else if (['DEVICE', 'SYMBOL', 'FOOTPRINT'].includes(doc.docType)) include = true;
			else if (['CONFIG', 'FONT', 'BLOB'].includes(doc.docType)) include = true;
			if (include) {
				if (t === 'META' && ['BOARD', 'SCH', 'PCB'].includes(doc.docType)) {
					const meta = { ...d, title: workcard.newModule.name };
					keep.push({ ...r, changedData: meta });
				} else if (doc.docType === 'PCB' && t === 'COMPONENT' && ids.pcbComponent.has(id)) {
					const attrs = { ...d.attrs, 'Reuse Block': workcard.newModule.name };
					keep.push({ ...r, changedData: { ...d, attrs } });
				} else if (doc.docType === 'SCH_PAGE' && t === 'ATTR' && ids.schComponent.has(d.parentId) && d.key === 'Reuse Block') {
					keep.push({ ...r, changedData: { ...d, value: workcard.newModule.name } });
				} else if (doc.docType === 'SCH_PAGE' && t === 'GROUP' && id === workcard.selected.schGroupId) {
					keep.push({ ...r, changedData: { ...d, title: workcard.newModule.name } });
				} else if (doc.docType === 'PCB' && t === 'GROUP' && id === workcard.selected.pcbGroupId) {
					keep.push({ ...r, changedData: { ...d, groupName: workcard.newModule.name } });
				} else keep.push(r);
			}
		}
		return keep;
	}
	const includedDocKeys = new Set([
		`BOARD:${workcard.boardUuid}`, `SCH:${workcard.schematicUuid}`, `SCH_PAGE:${workcard.schematicPageUuid}`, `PCB:${workcard.pcbUuid}`,
		...['DEVICE', 'SYMBOL', 'FOOTPRINT'].flatMap(t => [...resources[t]].map(uuid => `${t}:${uuid}`)),
		...parsed.docs.filter(d => ['CONFIG', 'FONT', 'BLOB'].includes(d.docType)).map(d => `${d.docType}:${d.uuid}`),
	]);
	const missingDocs = [...includedDocKeys].filter(key => !parsed.docs.some(d => `${d.docType}:${d.uuid}` === key));
	if (missingDocs.length) throw new Error(`missing closure documents: ${missingDocs.join(', ')}`);
	for (const doc of parsed.docs) {
		if (!includedDocKeys.has(`${doc.docType}:${doc.uuid}`)) continue;
		rowsByDoc.set(`${doc.docType}:${doc.uuid}`, chosen(doc));
	}

	const outPage = rowsByDoc.get(`SCH_PAGE:${workcard.schematicPageUuid}`);
	const outPcb = rowsByDoc.get(`PCB:${workcard.pcbUuid}`);
	const retainedKeys = new Set(outPcb.map(r => `${r.header.type}\u0000${r.header.id}`));
	const excludedPcb = Object.create(null);
	for (const r of pcb.effectiveRecords) if (!retainedKeys.has(`${r.header.type}\u0000${r.header.id}`)) {
		(excludedPcb[r.header.type] ??= []).push(r.header.id);
	}
	const assertTypeCount = (records, type, expected) => {
		const n = records.filter(r => r.header.type === type).length;
		if (n !== expected) throw new Error(`${type} count ${n}, expected ${expected}`);
	};
	for (const [type, selected] of [['COMPONENT', ids.pcbComponent], ['LINE', ids.pcbLine], ['VIA', ids.pcbVia], ['STRING', ids.pcbString], ['POLY', ids.pcbPoly], ['ARC', ids.pcbArc], ['PAD', ids.pcbStandalonePad]]) assertTypeCount(outPcb, type, selected.size);
	for (const [type, selected] of [['COMPONENT', ids.schComponent], ['WIRE', ids.schWire], ['LINE', ids.schLine], ['TEXT', ids.schText]]) assertTypeCount(outPage, type, selected.size);
	const keptPadNet = outPcb.filter(r => r.header.type === 'PAD_NET');
	const expectedPadNetCount = get(pcb, 'PAD_NET').filter(r => selectedPcbComponentSet.has(JSON.parse(r.header.id)[1])).length;
	if (keptPadNet.length !== expectedPadNetCount) throw new Error(`selected PAD_NET count ${keptPadNet.length}, expected ${expectedPadNetCount}`);
	const keptNets = outPcb.filter(r => r.header.type === 'NET');
	const retainedNetNames = new Set(keptNets.map(netName).filter(Boolean));
	for (const r of keptPadNet) {
		const net = netName(r);
		if (net && !nets.has(net)) throw new Error(`selected PAD_NET ${r.header.id} has undeclared net ${net}`);
		if (net && !retainedNetNames.has(net)) throw new Error(`selected PAD_NET ${r.header.id} net ${net} has no retained NET record`);
	}
	for (const r of outPcb.filter(r => ['LINE', 'ARC', 'VIA', 'PAD'].includes(r.header.type))) {
		const net = netName(r);
		if (net && !nets.has(net)) throw new Error(`selected ${r.header.type} ${r.header.id} has undeclared net ${net}`);
		if (net && !retainedNetNames.has(net)) throw new Error(`selected ${r.header.type} ${r.header.id} net ${net} has no retained NET record`);
		if (r.header.type === 'VIA' && ['BLIND','BURIED'].includes(String(r.data.viaType).toUpperCase())) {
			const blind = get(pcb,'RULE').find(rule => { try { return JSON.parse(rule.header.id)[1] === 'BLIND'; } catch { return false; } });
			const rule = (blind?.data?.ruleContext?.blinds?.content ?? []).find(item => item.name === r.data.ruleName);
			const radius = get(pcb,'RULE').some(size => { try { const id=JSON.parse(size.header.id); return id[1] === 'RADIUS' && id[2] === rule?.viaSizeRule; } catch { return false; } });
			if (!rule || !radius) throw new Error(`blind VIA ${r.header.id} has missing blind/RADIUS rule dependency`);
		}
	}
	const lineGroups = new Set(outPage.filter(r => r.header.type === 'WIRE').map(r => r.header.id));
	for (const line of outPage.filter(r => r.header.type === 'LINE')) if (!lineGroups.has(line.data.lineGroup)) throw new Error(`SCH LINE ${line.header.id} has missing WIRE ${line.data.lineGroup}`);
	const uidMap = Object.fromEntries(selectedComponents.map(r => [r.data.attrs['Unique ID'], r.header.id]));
	for (const [uid, id] of Object.entries(uidMap)) if (!ids.uid.has(uid) || !ids.pcbComponent.has(id)) throw new Error(`UID/component closure mismatch ${uid}/${id}`);

	const outputZip = new JSZip();
	const outMeta = { ...cloneJson(project), title: workcard.newModule.name, description: `Extracted module ${workcard.newModule.localId}@${workcard.newModule.version}` };
	outputZip.file('project2.json', JSON.stringify(outMeta, null, 2));
	const serialized = [];
	for (const doc of parsed.docs) {
		const key = `${doc.docType}:${doc.uuid}`;
		if (!rowsByDoc.has(key)) continue;
		const chosenRows = rowsByDoc.get(key);
		const body = serializeDoc(doc, chosenRows, ['CONFIG', 'FONT', 'BLOB'].includes(doc.docType));
		serialized.push(body);
	}
	const outputEpru = safeEpruName(workcard.outputEpru || `${workcard.newModule.name}.epru`);
	outputZip.file(outputEpru, serialized.join('\n'));
	const proof = {
		status: 'static-input-derived',
		limitation: '静态输入验证；尚未导入 EDA，不证明复用、官方重建、保存读回或硬件行为。',
		sourceSha256: sourceHash,
		outputEpru,
		module: workcard.newModule, projectTitle: outMeta.title,
		associations: { projectUuid: project.uuid ?? null, requestedSourceProjectUuid: workcard.sourceProjectUuid ?? null, sourceProjectUuidVerification: project.uuid && workcard.sourceProjectUuid ? project.uuid === workcard.sourceProjectUuid : 'project2 metadata does not expose a comparable UUID', boardUuid: board.uuid, schematicUuid: sch.uuid, schematicPageUuid: page.uuid, pcbUuid: pcb.uuid, boardSchematicPcbChainVerified: true },
		selectedDocuments: [...rowsByDoc.keys()],
		selectedResources: Object.fromEntries(Object.entries(resources).map(([k, v]) => [k, [...v].sort()])),
		instanceReferences,
		preservedExternalReferences,
		counts: {
			pcbComponents: ids.pcbComponent.size, pcbLines: ids.pcbLine.size, pcbVias: ids.pcbVia.size, pcbStrings: ids.pcbString.size, ownedPolygons: ids.pcbPoly.size, pcbArcs: ids.pcbArc.size, standalonePads: ids.pcbStandalonePad.size, padNetRows: keptPadNet.length,
			schParts: ids.schComponent.size, schWireGroups: ids.schWire.size, schLineSegments: ids.schLine.size, schDescriptions: ids.schText.size,
			interfaceNets: workcard.interfaces.length, internalNets: workcard.internalNets.length,
			selectedNets: keptNets.map(netName).filter(Boolean).sort(),
		},
		unknownReferences,
		unknownReferencesScope: '只记录已检查并剔除的 PCB NET selector；不构成通用引用审计。',
		excluded: { otherBoardsAndPages: parsed.docs.length - rowsByDoc.size, pcbRecordIdsByType: excludedPcb, pcbRecordCountsByType: Object.fromEntries(Object.entries(excludedPcb).map(([type, ids])=>[type,ids.length])), explicitlySelectedPourRecords: get(pcb, 'POUR').filter(r => workcard.selected?.pcbPourIds?.includes(r.header.id)).map(r => r.header.id), explicitlySelectedPouredRecords: get(pcb, 'POURED').filter(r => workcard.selected?.pcbPouredIds?.includes(r.header.id)).map(r => r.header.id), sourceImageCaches: true },
		preservation: { layerStackAndRulesKept: true, sourceCoordinatesUnchanged: true, componentUidAndDesignatorUnchanged: true, sourceArchiveUnmodified: true },
	};
	return { outputZip, proof };
}

async function extractModuleArchive({ sourceBytes, workcard, sourceEpru, outputEpru }) {
	if (!(sourceBytes instanceof Uint8Array)) throw new Error('sourceBytes must be a Uint8Array');
	if (!workcard || typeof workcard !== 'object') throw new Error('workcard must be an object');
	const sourceZip = await JSZip.loadAsync(sourceBytes);
	const projectFile = sourceZip.file('project2.json');
	if (!projectFile) throw new Error('source archive is missing project2.json');
	const epruFiles = Object.keys(sourceZip.files).filter(name => name.toLowerCase().endsWith('.epru') && !sourceZip.files[name].dir);
	const selectedEpru = sourceEpru ?? (epruFiles.length === 1 ? epruFiles[0] : null);
	if (!selectedEpru || !epruFiles.includes(selectedEpru)) throw new Error(`sourceEpru must identify one archive .epru; found ${epruFiles.length}`);
	const projectText = await projectFile.async('string');
	const epruText = await sourceZip.file(selectedEpru).async('string');
	const card = { ...workcard, ...(outputEpru ? { outputEpru } : {}) };
	const result = await trimSource({ sourceBytes, projectText, epruText, workcard: card });
	let outputZip = await result.outputZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
	const adaptations = card.resourceAdaptations ?? [];
	if (!Array.isArray(adaptations)) throw new Error('resourceAdaptations must be an array');
	if (adaptations.length) {
		const interim = await JSZip.loadAsync(outputZip);
		const interimProject = await interim.file('project2.json').async('string');
		const interimEpru = await interim.file(result.proof.outputEpru).async('string');
		const adapted = await deriveInstanceResources({ sourceBytes: outputZip, projectText: interimProject, epruText: interimEpru, workcard: { resourceAdaptations: adaptations }, sourceEpru: result.proof.outputEpru });
		outputZip = adapted.outputBytes;
		result.proof.extractionPreservation = result.proof.preservation;
		result.proof.preservation = { sourceArchiveUnmodified: true, extractionPreservedBeforeApprovedResourceAdaptations: true, approvedResourceAdaptations: adapted.proof.resourceAdaptations };
		result.proof.resourceAdaptations = adapted.proof;
	}
	result.proof.sourceEpru = selectedEpru;
	result.proof.outputSha256 = await sha256(outputZip);
	result.proof.outputBytes = outputZip.length;
	return { outputZip, proof: result.proof };
}

return { parseNative, trimSource, extractModuleArchive };
}
