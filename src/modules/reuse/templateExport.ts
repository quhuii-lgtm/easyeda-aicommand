type ExportTemplateParams = {
	projectUuid: string;
	cbbUuid: string;
	libraryUuid: string;
	templateSchematicUuid: string;
	templatePcbUuid: string;
	fileName: string;
};

function fail(message: string): never {
	throw new Error(message);
}

function plainObject(value: unknown): value is Record<string, any> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requireId(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim())
		fail(`${name} 必须是非空字符串`);
	return value;
}

function documentUuid(value: unknown, parentProjectUuid: string): string | undefined {
	if (typeof value === 'string')
		return value.trim() ? value : undefined;
	if (plainObject(value) && typeof value.uuid === 'string' && value.uuid.trim()
		&& value.parentProjectUuid === parentProjectUuid)
		return value.uuid;
	return undefined;
}

export function validateExportTemplateParams(params: Record<string, any>): ExportTemplateParams {
	const expected = ['projectUuid', 'cbbUuid', 'libraryUuid', 'templateSchematicUuid', 'templatePcbUuid', 'fileName'];
	if (!plainObject(params) || Object.keys(params).length !== expected.length || expected.some(key => !Object.prototype.hasOwnProperty.call(params, key)))
		fail('exportTemplateFile 仅接受 projectUuid、cbbUuid、libraryUuid、templateSchematicUuid、templatePcbUuid、fileName');
	const projectUuid = requireId(params.projectUuid, 'projectUuid');
	const cbbUuid = requireId(params.cbbUuid, 'cbbUuid');
	const libraryUuid = requireId(params.libraryUuid, 'libraryUuid');
	const templateSchematicUuid = requireId(params.templateSchematicUuid, 'templateSchematicUuid');
	const templatePcbUuid = requireId(params.templatePcbUuid, 'templatePcbUuid');
	const fileName = requireId(params.fileName, 'fileName');
	if (/[\\/]/.test(fileName) || fileName === '.' || fileName === '..' || !/\.epro2$/i.test(fileName))
		fail('fileName 必须是无路径的 .epro2 文件名');
	return { projectUuid, cbbUuid, libraryUuid, templateSchematicUuid, templatePcbUuid, fileName };
}

function collectMatchingBoards(value: unknown, projectUuid: string, schematicUuid: string, pcbUuid: string): any[] {
	const matches: any[] = [];
	const seen = new WeakSet<object>();
	const walk = (node: any): void => {
		if (!node || typeof node !== 'object' || seen.has(node))
			return;
		seen.add(node);
		if (node.itemType === 'Board'
			&& documentUuid(node.schematic, projectUuid) === schematicUuid
			&& documentUuid(node.pcb, projectUuid) === pcbUuid
			&& node.parentProjectUuid === projectUuid)
			matches.push(node);
		for (const child of Object.values(node))
			walk(child);
	};
	walk(value);
	return matches;
}

async function readProjectPair(params: ExportTemplateParams): Promise<any> {
	const project = await eda.dmt_Project.getCurrentProjectInfo();
	if (!plainObject(project) || project.uuid !== params.projectUuid)
		fail('当前工程与 projectUuid 不一致');
	if (!Array.isArray(project.data))
		fail('当前工程树缺少有效 data 列表');
	const matches = collectMatchingBoards(project.data, params.projectUuid, params.templateSchematicUuid, params.templatePcbUuid);
	if (matches.length !== 1)
		fail('当前工程树中未找到唯一的同板原理图与 PCB 模板配对');
	return project;
}

async function readLibraryPair(params: ExportTemplateParams): Promise<any> {
	const cbb = await eda.lib_Cbb.get(params.cbbUuid, params.libraryUuid);
	if (!plainObject(cbb) || cbb.uuid !== params.cbbUuid || cbb.libraryUuid !== params.libraryUuid)
		fail('复用模块 UUID 或 libraryUuid 与请求不一致');
	if (!Array.isArray(cbb.boards))
		fail('复用模块缺少有效 boards 列表');
	const matches = cbb.boards.filter((board: any) => plainObject(board)
		&& board.itemType === 'Board'
		&& board.parentProjectUuid === params.projectUuid
		&& documentUuid(board.schematic, params.projectUuid) === params.templateSchematicUuid
		&& documentUuid(board.pcb, params.projectUuid) === params.templatePcbUuid);
	if (matches.length !== 1)
		fail('复用模块库中未找到唯一的同板原理图与 PCB 模板配对');
	return cbb;
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	return btoa(binary);
}

export async function exportTemplateFile(rawParams: Record<string, any>): Promise<Record<string, unknown>> {
	const params = validateExportTemplateParams(rawParams);
	const projectBefore = await readProjectPair(params);
	await readLibraryPair(params);

	const file = await eda.sys_FileManager.getCbbFileByCbbUuid(
		params.cbbUuid,
		params.libraryUuid,
		{
			fileType: 'epro2',
			fileName: params.fileName,
			templateSchematicUuid: params.templateSchematicUuid,
			templatePcbUuid: params.templatePcbUuid,
		},
	);
	if (!file || typeof File !== 'function' || !(file instanceof File))
		fail('模板导出未返回有效 File');
	if (!Number.isSafeInteger(file.size) || file.size <= 0 || typeof file.arrayBuffer !== 'function')
		fail('模板导出 File 内容为空或无效');
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (bytes.length !== file.size || bytes.length === 0)
		fail('模板导出 File 内容长度无效');

	const projectAfter = await readProjectPair(params);
	await readLibraryPair(params);
	if (projectAfter.uuid !== projectBefore.uuid)
		fail('导出期间当前工程身份发生变化');

	return {
		projectUuid: params.projectUuid,
		cbbUuid: params.cbbUuid,
		libraryUuid: params.libraryUuid,
		templateSchematicUuid: params.templateSchematicUuid,
		templatePcbUuid: params.templatePcbUuid,
		fileName: params.fileName,
		size: bytes.length,
		mimeType: typeof file.type === 'string' && file.type ? file.type : 'application/octet-stream',
		base64: toBase64(bytes),
		exported: true,
		contentVerified: false,
		templateBindingVerified: false,
	};
}
