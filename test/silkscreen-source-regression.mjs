import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const nodeRequire = createRequire(import.meta.url);
const evidence = resolve(root, 'test/fixtures');
const beforeEvidence = await readFile(resolve(evidence, 'silkscreen-source-before.sourcelog'), 'utf8');
const afterEvidence = await readFile(resolve(evidence, 'silkscreen-source-after.sourcelog'), 'utf8');
function loadTs(file) {
	const absolute = resolve(root, file);
	const compiled = ts.transpileModule(readFileSync(absolute, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
	const module = { exports: {} };
	const localRequire = id => id.startsWith('.') ? loadTs(resolve(dirname(absolute).slice(root.length + 1), id.endsWith('.ts') ? id : `${id}.ts`)) : nodeRequire(id);
	new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
	return module.exports;
}
const { compareSilkscreenSourceSnapshots } = loadTs('src/engine/silkscreenCheck.ts');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`ok ${checks} - ${name}`); }

function parseRows(source) {
	return source.split(/\r?\n/).filter(line => line.trim()).map(line => {
		const separator = line.indexOf('||');
		assert.notEqual(separator, -1);
		const header = JSON.parse(line.slice(0, separator));
		let dataText = line.slice(separator + 2);
		if (dataText.endsWith('|')) dataText = dataText.slice(0, -1);
		return { header, data: dataText === '' ? '' : JSON.parse(dataText) };
	});
}
function serializeRows(rows, omitFinalTerminator = false) {
	return rows.map((row, index) => `${JSON.stringify(row.header)}||${JSON.stringify(row.data)}${omitFinalTerminator && index === rows.length - 1 ? '' : '|'}`).join('\n');
}
function cloneRows(source) { return parseRows(source).map(row => structuredClone(row)); }
function padNets(rows) { return rows.filter(row => row.header.type === 'PAD_NET'); }
function one(rows, type, id) {
	const row = rows.find(item => item.header.type === type && item.header.id === id);
	assert.ok(row, `missing ${type} ${id}`);
	return row;
}
function negative(label, mutate) {
	const rows = cloneRows(beforeEvidence);
	mutate(rows);
	const result = compareSilkscreenSourceSnapshots(beforeEvidence, serializeRows(rows));
	assert.equal(result.matches, false, `${label}: must reject`);
	return result;
}

check('真实 0.20.74 前后源码允许 PAD_NET 重排/ticket 与 pinSwapInfo 键重排', () => {
	const beforeRows = parseRows(beforeEvidence);
	const afterRows = parseRows(afterEvidence);
	assert.equal(beforeRows.length, 194);
	assert.equal(afterRows.length, 194);
	assert.equal(padNets(beforeRows).length, 4);
	assert.equal(padNets(afterRows).length, 4);
	const beforeComponents = beforeRows.filter(row => row.header.type === 'COMPONENT');
	const afterComponents = afterRows.filter(row => row.header.type === 'COMPONENT');
	assert.equal(beforeComponents.length, 2);
	assert.equal(afterComponents.length, 2);
	assert.notDeepEqual(Object.keys(beforeComponents[0].data.pinSwapInfo), Object.keys(afterComponents[0].data.pinSwapInfo));
	const result = compareSilkscreenSourceSnapshots(beforeEvidence, afterEvidence);
	assert.equal(result.matches, true, result.reason);
	assert.ok(result.representationChanges.some(change => change.includes('PAD_NET 行序变化')));
	assert.ok(result.representationChanges.some(change => change.includes('ticket 变化')));
	assert.ok(result.representationChanges.some(change => change.includes('pinSwapInfo')));
	assert.equal(padNets(afterRows)[0].header.ticket, 186);
	assert.equal(padNets(afterRows)[1].header.ticket, 187);
});

check('PAD_NET 仅接受有限非负整数 ticket', () => {
	for (const badTicket of [null, '186', 186.5, -1, undefined]) {
		const rows = cloneRows(afterEvidence);
		const target = padNets(rows)[0];
		if (badTicket === undefined) delete target.header.ticket;
		else target.header.ticket = badTicket;
		const result = compareSilkscreenSourceSnapshots(beforeEvidence, serializeRows(rows));
		assert.equal(result.matches, false, `ticket ${String(badTicket)} must be rejected`);
		assert.ok(result.reason.includes('ticket'));
	}
});

check('对象键重排允许且记录，数组顺序变化拒绝', () => {
	const rows = cloneRows(beforeEvidence);
	const component = rows.find(row => row.header.type === 'COMPONENT');
	const originalData = component.data;
	component.data = Object.fromEntries(Object.entries(originalData).reverse());
	const reordered = compareSilkscreenSourceSnapshots(beforeEvidence, serializeRows(rows));
	assert.equal(reordered.matches, true, reordered.reason);
	assert.ok(reordered.representationChanges.some(change => change.includes('COMPONENT')));
	const changed = cloneRows(beforeEvidence);
	const target = changed.find(row => row.header.type === 'COMPONENT');
	target.data.pinSwapInfo = Object.fromEntries(Object.entries(target.data.pinSwapInfo).reverse());
	target.data.testArray = [1, 2, 3];
	const baselineWithArray = serializeRows([...cloneRows(beforeEvidence).map(row => row.header.type === 'COMPONENT' ? { ...row, data: { ...row.data, testArray: [1, 2, 3] } } : row)]);
	target.data.testArray.reverse();
	assert.equal(compareSilkscreenSourceSnapshots(baselineWithArray, serializeRows(changed)).matches, false);
});

check('PAD_NET 的网络值或完整身份变化拒绝', () => {
	negative('network', rows => { padNets(rows)[0].data.padNet = 'DIFFERENT_NET'; });
	negative('id', rows => { padNets(rows)[0].header.id = 'different-pad-net-id'; });
	negative('other data', rows => { padNets(rows)[0].data.padLen = 12; });
});

check('PAD_NET 新增、删除、重复身份和墓碑均拒绝', () => {
	negative('add', rows => { rows.push(structuredClone(padNets(rows)[0])); rows.at(-1).header.id = '["PAD_NET","new"]'; });
	negative('delete', rows => { rows.splice(rows.findIndex(row => row.header.type === 'PAD_NET'), 1); });
	negative('duplicate', rows => { rows.push(structuredClone(padNets(rows)[0])); });
	negative('tombstone', rows => { padNets(rows)[0].data = ''; });
});

check('COMPONENT 坐标及 pinSwapInfo 实际字段变化拒绝', () => {
	const original = parseRows(beforeEvidence).find(row => row.header.type === 'COMPONENT');
	assert.equal(original.data.x, 200);
	assert.equal(original.data.pinSwapInfo['51611a06d7952274e7'].pinClass, '');
	negative('geometry', rows => { one(rows, 'COMPONENT', original.header.id).data.x = 201; });
	negative('pinSwapInfo value', rows => { one(rows, 'COMPONENT', original.header.id).data.pinSwapInfo['51611a06d7952274e7'].pinClass = 'changed'; });
});

check('非 PAD_NET 相对顺序或 ticket 变化拒绝', () => {
	negative('order', rows => {
		const indices = rows.map((row, index) => row.header.type === 'COMPONENT' ? index : -1).filter(index => index >= 0);
		[rows[indices[0]], rows[indices[1]]] = [rows[indices[1]], rows[indices[0]]];
	});
	negative('ticket', rows => { one(rows, 'COMPONENT', '51611a06d7952274').header.ticket += 1; });
});

check('DOCHEAD 仅 client/updateTime/version 可变，uuid 或未知字段变化拒绝', () => {
	const volatile = cloneRows(beforeEvidence);
	const head = volatile.find(row => row.header.type === 'DOCHEAD');
	head.data.client = 'changed-client';
	head.data.updateTime = 1;
	head.data.version = 'changed-version';
	assert.equal(compareSilkscreenSourceSnapshots(beforeEvidence, serializeRows(volatile)).matches, true);
	negative('uuid', rows => { rows.find(row => row.header.type === 'DOCHEAD').data.uuid = 'other-pcb'; });
	negative('unknown head field', rows => { rows.find(row => row.header.type === 'DOCHEAD').data.unexpected = true; });
});

check('错误 JSON 及非法行不被 EOF 容错吞掉', () => {
	assert.equal(compareSilkscreenSourceSnapshots(beforeEvidence, `${afterEvidence.slice(0, -1)}!`).matches, false);
	assert.equal(compareSilkscreenSourceSnapshots(beforeEvidence, `${afterEvidence}\n{bad json}`).matches, false);
	const terminated = afterEvidence.endsWith('|') ? afterEvidence : `${afterEvidence}|`;
	assert.equal(compareSilkscreenSourceSnapshots(beforeEvidence, terminated.slice(0, -1)).matches, true);
});

console.log(`1..${checks}`);
