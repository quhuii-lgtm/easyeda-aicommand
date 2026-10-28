import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

async function main() {
	const root = resolve(import.meta.dirname, '..');
	const built = await build({
		stdin: {
			contents: `import { planLayoutOfficial, pcbGroupingCommands } from '../src/commands/pcbGrouping.ts'; export { planLayoutOfficial, pcbGroupingCommands }`,
			resolveDir: resolve(root, 'test'),
			sourcefile: 'pcb-grouping-layout-regression-entry.ts',
		},
		bundle: true,
		platform: 'node',
		format: 'esm',
		write: false,
		target: 'node24',
		plugins: [{
			name: 'expose-layout-for-regression',
			setup(builder) {
				builder.onLoad({ filter: /pcbGrouping\.ts$/ }, args => ({
					contents: readFileSync(args.path, 'utf8')
						.replace('while (!placedOk) {', 'while (!placedOk) { globalThis.__layoutAttemptCount = (globalThis.__layoutAttemptCount ?? 0) + 1;')
						.replace('export const pcbGroupingCommands', 'export { planLayoutOfficial }; export const pcbGroupingCommands'),
					loader: 'ts',
				}));
			},
		}],
	});
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`;
	const { planLayoutOfficial, pcbGroupingCommands } = await import(moduleUrl);

	const components = Array.from({ length: 1000 }, (_, index) => ({
		id: `component-${index}`,
		designator: `U${index + 1}`,
		x: 0,
		y: 0,
		angle: 0,
		layerId: 1,
	}));
	const geometry = new Map(components.map(component => [component.id, { minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }]));
	const group = { name: 'MCU/IO', pageName: 'MCU', pageUuid: 'page', rectId: 'rect', components, placements: [], bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 } };
	const obstacles = Array.from({ length: 210 }, (_, index) => ({
		designator: `J${index + 1}`,
		bbox: { minX: 115 + index * 40, minY: -1000, maxX: 125 + index * 40, maxY: 1000 },
	}));
	globalThis.__layoutAttemptCount = 0;
	planLayoutOfficial([group], geometry, [], 100, 0, 1, obstacles, 30000, 20000);
	assert.ok(globalThis.__layoutAttemptCount > 200, 'the fixture requires more than 200 collision checks');
	assert.equal(group.placements.length, components.length);
	assert.equal(group.blockedBy, undefined);
	assert.ok(group.bbox.minX > obstacles.at(-1).bbox.maxX, 'the group clears all 210 real obstacles');
	assert.ok(group.bbox.maxX < 30100, 'the chosen position stays inside the available right boundary');
	console.log('PASS PCB grouping searches past 200 actual obstacles and places the group within the supplied board width');

	const source = (docType, uuid, records) => [
		`${JSON.stringify({ type: 'DOCHEAD' })}||${JSON.stringify({ docType, uuid, client: 'test' })}`,
		...records.map(({ type, id, ticket, data }) => `${JSON.stringify({ type, id, ticket })}||${JSON.stringify(data)}`),
	].join('\n');
	const makeFixture = ({ names, boardHeight, footprintSource, componentPose }) => {
		const schematicUuid = 'schematic-test';
		const pcbUuid = 'pcb-test';
		const schematicRecords = [];
		const pcbRecords = [];
		for (const [index, designator] of names.entries()) {
			const x = 100 + index * 1500;
			const rectId = `rect-${index}`;
			const schComponentId = `sch-component-${index}`;
			const pcbComponentId = `pcb-component-${index}`;
			schematicRecords.push(
				{ type: 'RECT', id: rectId, ticket: schematicRecords.length + 1, data: { dotX1: x - 50, dotY1: 0, dotX2: x + 50, dotY2: 100 } },
				{ type: 'COMPONENT', id: schComponentId, ticket: schematicRecords.length + 2, data: { x, y: 50 } },
				{ type: 'ATTR', id: `sch-attr-${index}`, ticket: schematicRecords.length + 3, data: { parentId: schComponentId, key: 'Designator', value: designator, x, y: 50 } },
			);
			const pose = componentPose && index === 0 ? componentPose : { x, y: 50, angle: 0, layerId: 1, footprintUuid: '' };
			pcbRecords.push(
				{ type: 'COMPONENT', id: pcbComponentId, ticket: pcbRecords.length + 1, data: { positionX: pose.x, positionY: pose.y, angle: pose.angle, layerId: pose.layerId, footprintUuid: pose.footprintUuid, deviceUuid: '' } },
				{ type: 'ATTR', id: `pcb-attr-${index}`, ticket: pcbRecords.length + 2, data: { parentId: pcbComponentId, key: 'Designator', value: designator } },
			);
		}
		const sources = new Map([
			[schematicUuid, source('SCH_PAGE', schematicUuid, schematicRecords)],
			[pcbUuid, source('PCB', pcbUuid, pcbRecords)],
		]);
		let activeUuid = pcbUuid;
		let sourceWrites = 0;
		globalThis.eda = {
			dmt_Project: { getCurrentProjectInfo: async () => ({ friendlyName: 'layout-test', data: [{ pcb: { uuid: pcbUuid }, schematic: { page: [{ uuid: schematicUuid, name: 'Sheet' }] } }] }) },
			dmt_SelectControl: { getCurrentDocumentInfo: async () => ({ documentType: activeUuid === pcbUuid ? 2 : 1, uuid: activeUuid }) },
			dmt_EditorControl: {
				openDocument: async uuid => ({ uuid }),
				activateDocument: async (tab) => {
					activeUuid = tab.uuid;
					return true;
				},
			},
			sys_FileManager: {
				getDocumentSource: async () => sources.get(activeUuid),
				getDocumentFootprintSources: async () => footprintSource ? [footprintSource] : [],
				setDocumentSource: async () => {
					sourceWrites++;
					return true;
				},
			},
			pcb_Primitive: { getPrimitivesBBox: async () => ({ minX: -0.5, minY: -0.5, maxX: 0.5, maxY: 0.5 }) },
			sys_ClientUrl: { request: async () => { throw new Error('backup proxy unavailable'); } },
			sys_Storage: { setExtensionUserConfig: async () => true },
		};
		return {
			pcbUuid,
			sourceWrites,
			get writes() {
				return sourceWrites;
			},
			boardHeight,
		};
	};
	const grouping = pcbGroupingCommands.find(command => command.name === 'pcb.groupBySchematicRegions').handler;
	for (const scenario of [
		{ names: ['U1'], boardHeight: 1 },
		{ names: ['U1', 'U2'], boardHeight: 200 },
	]) {
		const fixture = makeFixture(scenario);
		await assert.rejects(() => grouping({
			dryRun: false,
			origin: { x: 0, y: 0 },
			boardSize: { width: 1000, height: fixture.boardHeight },
			groupGap: 1,
		}, {}), /布局避让失败/);
		assert.equal(fixture.writes, 0, 'an unplaced group cannot reach setDocumentSource');
	}
	console.log('PASS PCB grouping rejects first-row and later-row height exhaustion before any write');

	const footprintUuid = 'fp-asymmetric-bottom';
	const footprintSource = {
		footprintUuid,
		documentSource: source('FOOTPRINT', 'footprint-source-test', [
			{ type: 'TRACK', id: 'asymmetric-geometry', ticket: 1, data: { path: [10, 20, 30, 60] } },
		]),
	};
	const footprintFixture = makeFixture({
		names: ['U1'],
		boardHeight: 500,
		footprintSource,
		componentPose: { x: 100, y: 200, angle: 90, layerId: 2, footprintUuid },
	});
	const preview = await grouping({
		dryRun: true,
		origin: { x: 0, y: 0 },
		boardSize: { width: 1000, height: 500 },
		groupGap: 1,
	}, {});
	assert.equal(preview.dryRun, true);
	assert.equal(preview.groups.length, 1);
	assert.equal(preview.groups[0].placements[0].measureSource, 'footprint-source', 'a returned footprint source must flow through measureGeometry');
	assert.equal(preview.groups[0].placements[0].measured, true);
	assert.deepEqual({ x: preview.groups[0].placements[0].x, y: preview.groups[0].placements[0].y }, { x: -5, y: 5 }, 'bottom 90° asymmetric source bbox keeps its correct anchor offset through dryRun');
	// U1 adds no visible-designator space: maxY = max(20 + 2*15 + 70 + 20, 35 + 20 + 35 + 40 + 15) = 145.
	assert.deepEqual(
		{ minX: preview.groups[0].bbox.minX, minY: preview.groups[0].bbox.minY, maxX: preview.groups[0].bbox.maxX, maxY: preview.groups[0].bbox.maxY },
		{ minX: 0, minY: 0, maxX: 201, maxY: 145 },
		'dryRun group bounds include the transformed 40×20 footprint extent and layout margins',
	);
	assert.equal(footprintFixture.writes, 0, 'dryRun must not write source');
	console.log('PASS PCB grouping dryRun measures a real bottom 90° asymmetric footprint source and reports the expected anchor and extents');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
