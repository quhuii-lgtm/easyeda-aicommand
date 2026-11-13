import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const CATALOG_FILE = 'catalog.json';
const CATALOG_SCHEMA_VERSION = 1;
const MANIFEST_FILE = 'module.json';
const FILE_ROLES = new Set(['native', 'dependency', 'evidence']);
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

export class LocalLibraryError extends Error {
	constructor(message, code = 'LOCAL_LIBRARY_ERROR', options = {}) {
		super(message, options);
		this.name = 'LocalLibraryError';
		this.code = code;
	}
}

export class LocalLibraryIntegrityError extends LocalLibraryError {
	constructor(message, options = {}) {
		super(message, 'INTEGRITY_ERROR', options);
		this.name = 'LocalLibraryIntegrityError';
	}
}

function assertString(value, label) {
	if (typeof value !== 'string' || value.length === 0)
		throw new LocalLibraryError(`${label} must be a non-empty string`, 'INVALID_ARGUMENT');
}

function hashText(value) {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function hashFile(filePath) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath))
		hash.update(chunk);
	return hash.digest('hex');
}

function assertWithin(basePath, candidatePath, label) {
	const rel = relative(basePath, candidatePath);
	if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new LocalLibraryError(`${label} escapes the selected library directory`, 'PATH_BOUNDARY');
	return candidatePath;
}

function normalizeRelativePath(value) {
	assertString(value, 'relativePath');
	if (value.includes('\0'))
		throw new LocalLibraryError('relativePath cannot contain a NUL character', 'INVALID_ARGUMENT');
	const portable = value.replaceAll('\\', '/');
	if (portable.startsWith('/') || /^[a-z]:/i.test(portable))
		throw new LocalLibraryError(`relativePath must be relative: ${value}`, 'PATH_BOUNDARY');
	const parts = portable.split('/');
	if (parts.some(part => !part || part === '.' || part === '..'))
		throw new LocalLibraryError(`relativePath contains an unsafe path segment: ${value}`, 'PATH_BOUNDARY');
	if (parts.some(part => part.endsWith('.') || part.endsWith(' ') || part.includes(':') || WINDOWS_RESERVED_NAME.test(part)))
		throw new LocalLibraryError(`relativePath contains a Windows alias or reserved name: ${value}`, 'PATH_BOUNDARY');
	return parts.join('/');
}

function relativePathKey(value) {
	return value.toLocaleLowerCase('en-US');
}

function assertNoPathCollisions(paths) {
	const seen = new Set();
	for (const path of paths) {
		const key = relativePathKey(path);
		if (seen.has(key))
			throw new LocalLibraryError(`duplicate relativePath under filesystem path rules: ${path}`, 'INVALID_ARGUMENT');
		seen.add(key);
	}
	for (const key of seen) {
		const parts = key.split('/');
		for (let index = 1; index < parts.length; index++) {
			if (seen.has(parts.slice(0, index).join('/')))
				throw new LocalLibraryError(`relativePath is both a file and a directory: ${parts.slice(0, index).join('/')}`, 'INVALID_ARGUMENT');
		}
	}
}

async function ensureDirectoryChain(realRoot, targetDirectory) {
	const rel = relative(realRoot, targetDirectory);
	if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new LocalLibraryError('directory path escapes the selected library directory', 'PATH_BOUNDARY');
	let current = realRoot;
	for (const part of rel.split(sep)) {
		current = join(current, part);
		try {
			await mkdir(current);
		}
		catch (error) {
			if (error?.code !== 'EEXIST')
				throw error;
		}
		const info = await lstat(current);
		if (info.isSymbolicLink() || !info.isDirectory())
			throw new LocalLibraryError(`library path component is not a plain directory: ${current}`, 'PATH_BOUNDARY');
		const resolved = await realpath(current);
		assertWithin(realRoot, resolved, 'library directory');
		current = resolved;
	}
	return current;
}

function cloneJson(value, label) {
	try {
		const text = JSON.stringify(value);
		if (text === undefined)
			throw new TypeError('value is not JSON-serializable');
		return JSON.parse(text);
	}
	catch (error) {
		throw new LocalLibraryError(`${label} must be JSON-serializable`, 'INVALID_ARGUMENT', { cause: error });
	}
}

function canonicalJson(value) {
	if (Array.isArray(value))
		return `[${value.map(canonicalJson).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function safeSegmentKey(value) {
	return hashText(value);
}

function validateFileDescriptors(files, evidenceAttachments = []) {
	if (!Array.isArray(files))
		throw new LocalLibraryError('files must be an array of file descriptors', 'INVALID_ARGUMENT');
	if (!Array.isArray(evidenceAttachments))
		throw new LocalLibraryError('evidenceAttachments must be an array', 'INVALID_ARGUMENT');
	const all = [
		...files.map(file => ({ ...file })),
		...evidenceAttachments.map(file => ({ ...file, role: 'evidence' })),
	];
	if (!all.some(file => file.role === 'native'))
		throw new LocalLibraryError('at least one native file is required', 'INVALID_ARGUMENT');
	const validated = all.map((file) => {
		if (!file || typeof file !== 'object' || Array.isArray(file))
			throw new LocalLibraryError('each file descriptor must be an object', 'INVALID_ARGUMENT');
		assertString(file.sourcePath, 'sourcePath');
		if (!FILE_ROLES.has(file.role))
			throw new LocalLibraryError(`unsupported file role: ${String(file.role)}`, 'INVALID_ARGUMENT');
		const relativePath = normalizeRelativePath(file.relativePath);
		const descriptor = { relativePath, role: file.role };
		if (Object.hasOwn(file, 'description'))
			descriptor.description = cloneJson(file.description, 'file description');
		return { ...descriptor, sourcePath: resolve(file.sourcePath) };
	});
	assertNoPathCollisions(validated.map(file => file.relativePath));
	return validated;
}

function publicFileDescriptor(file) {
	const { sourcePath, ...descriptor } = file;
	return descriptor;
}

function validateCatalog(value, catalogPath) {
	if (!value || typeof value !== 'object' || value.schemaVersion !== CATALOG_SCHEMA_VERSION || !Array.isArray(value.modules))
		throw new LocalLibraryIntegrityError(`catalog is malformed or uses an unsupported schema: ${catalogPath}`);
	return value;
}

export function createLocalLibrary(rootDirectory) {
	assertString(rootDirectory, 'rootDirectory');
	const rootPath = resolve(rootDirectory);
	const catalogPath = join(rootPath, CATALOG_FILE);
	const modulesPath = join(rootPath, 'modules');

	function moduleDirectory(localId, version) {
		return join(modulesPath, safeSegmentKey(localId), 'versions', safeSegmentKey(version));
	}

	async function readCatalog() {
		try {
			const realRoot = await realpath(rootPath);
			const realCatalog = await realpath(catalogPath);
			assertWithin(realRoot, realCatalog, 'catalog');
			const info = await stat(realCatalog);
			if (!info.isFile())
				throw new LocalLibraryIntegrityError(`catalog is not a file: ${catalogPath}`);
			const text = await readFile(catalogPath, 'utf8');
			let parsed;
			try {
				parsed = JSON.parse(text);
			}
			catch (error) {
				throw new LocalLibraryIntegrityError(`catalog JSON cannot be parsed: ${catalogPath}`, { cause: error });
			}
			return validateCatalog(parsed, catalogPath);
		}
		catch (error) {
			if (error?.code === 'ENOENT' && await lstat(catalogPath).then(() => false, cause => cause?.code === 'ENOENT'))
				return { schemaVersion: CATALOG_SCHEMA_VERSION, modules: [] };
			throw error;
		}
	}

	async function acquireImportLock() {
		await mkdir(rootPath, { recursive: true });
		const realRoot = await realpath(rootPath);
		const lockPath = join(realRoot, '.library-import.lock');
		try {
			await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { flag: 'wx' });
		}
		catch (error) {
			if (error?.code === 'EEXIST')
				throw new LocalLibraryError('another import is active or a prior import left a lock; inspect and remove the lock manually only after confirming no writer is active', 'BUSY');
			throw error;
		}
		return async () => {
			await unlink(lockPath);
		};
	}

	async function writeCatalog(catalog) {
		await mkdir(rootPath, { recursive: true });
		const temporaryPath = join(rootPath, `.${CATALOG_FILE}.${randomUUID()}.tmp`);
		await writeFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, { flag: 'wx' });
		await rename(temporaryPath, catalogPath);
	}

	async function listRecords() {
		const catalog = await readCatalog();
		return [...catalog.modules]
			.sort((left, right) => left.localId.localeCompare(right.localId) || left.version.localeCompare(right.version))
			.map(record => ({ ...record }));
	}

	async function verifyStoredRecord(record) {
		const folder = moduleDirectory(record.localId, record.version);
		assertWithin(rootPath, folder, 'module folder');
		let manifest;
		try {
			const realRoot = await realpath(rootPath);
			const realFolder = await realpath(folder);
			const manifestPath = join(folder, MANIFEST_FILE);
			const realManifest = await realpath(manifestPath);
			assertWithin(realRoot, realFolder, 'module folder');
			assertWithin(realRoot, realManifest, 'module manifest');
			manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
		}
		catch (error) {
			throw new LocalLibraryIntegrityError(`module manifest is missing or unreadable for ${record.localId}@${record.version}`, { cause: error });
		}
		if (canonicalJson(manifest) !== canonicalJson(record))
			throw new LocalLibraryIntegrityError(`module manifest does not match the library catalog for ${record.localId}@${record.version}`);
		if (!Array.isArray(record.files))
			throw new LocalLibraryIntegrityError(`module file manifest is malformed for ${record.localId}@${record.version}`);
		const verifiedFiles = [];
		for (const file of record.files) {
			const relativePath = normalizeRelativePath(file.relativePath);
			const filePath = assertWithin(join(folder, 'files'), resolve(folder, 'files', ...relativePath.split('/')), 'stored file');
			let content;
			try {
				const [realFolder, realFile] = await Promise.all([realpath(join(folder, 'files')), realpath(filePath)]);
				assertWithin(await realpath(rootPath), realFolder, 'stored file directory');
				assertWithin(realFolder, realFile, 'stored file');
				content = await readFile(filePath);
			}
			catch (error) {
				throw new LocalLibraryIntegrityError(`stored file is missing or unreadable: ${relativePath}`, { cause: error });
			}
			const actualHash = createHash('sha256').update(content).digest('hex');
			if (actualHash !== file.sha256 || content.byteLength !== file.size)
				throw new LocalLibraryIntegrityError(`stored file failed SHA-256 or size verification: ${relativePath}`);
			verifiedFiles.push({ ...file, path: filePath, content });
		}
		return { ...record, storagePath: folder, files: verifiedFiles };
	}

	return Object.freeze({
		rootPath,

		async importModule(input) {
			if (!input || typeof input !== 'object' || Array.isArray(input))
				throw new LocalLibraryError('module input must be an object', 'INVALID_ARGUMENT');
			assertString(input.localId, 'localId');
			assertString(input.version, 'version');
			if (!Object.hasOwn(input, 'source'))
				throw new LocalLibraryError('source must be supplied explicitly', 'INVALID_ARGUMENT');
			const files = validateFileDescriptors(input.files, input.evidenceAttachments ?? []);
			const releaseLock = await acquireImportLock();
			try {
				const catalog = await readCatalog();
				if (catalog.modules.some(record => record.localId === input.localId && record.version === input.version))
					throw new LocalLibraryError(`module version already exists: ${input.localId}@${input.version}`, 'VERSION_EXISTS');

				const targetDirectory = moduleDirectory(input.localId, input.version);
				assertWithin(rootPath, targetDirectory, 'module folder');
				try {
					await lstat(targetDirectory);
					throw new LocalLibraryError(`module version folder already exists outside the catalog; inspect it before continuing: ${input.localId}@${input.version}`, 'VERSION_FOLDER_EXISTS');
				}
				catch (error) {
					if (error instanceof LocalLibraryError)
						throw error;
					if (error?.code !== 'ENOENT')
						throw error;
				}

				const entry = {
					localId: input.localId,
					version: input.version,
					source: cloneJson(input.source, 'source'),
					files: [],
				};
				for (const key of ['edaUuid', 'name', 'description', 'tags', 'applicability', 'interfaces', 'bom', 'replacementRules', 'validation']) {
					if (Object.hasOwn(input, key))
						entry[key] = cloneJson(input[key], key);
				}
				if (Object.hasOwn(entry, 'tags') && (!Array.isArray(entry.tags) || entry.tags.some(tag => typeof tag !== 'string')))
					throw new LocalLibraryError('tags must be an array of strings', 'INVALID_ARGUMENT');
				for (const file of files) {
					try {
						const sourceStat = await stat(file.sourcePath);
						if (!sourceStat.isFile())
							throw new LocalLibraryError(`source path is not a file: ${file.sourcePath}`, 'SOURCE_FILE_ERROR');
						entry.files.push({ ...publicFileDescriptor(file), sha256: await hashFile(file.sourcePath), size: sourceStat.size });
					}
					catch (error) {
						if (error instanceof LocalLibraryError)
							throw error;
						throw new LocalLibraryError(`source file does not exist or cannot be read: ${file.sourcePath}`, 'SOURCE_FILE_ERROR', { cause: error });
					}
				}

				const realRoot = await realpath(rootPath);
				// Keep every path passed to the containment checks under the same
				// canonical root. rootPath may be a user-selected symlink or junction.
				const realTargetDirectory = join(realRoot, relative(rootPath, targetDirectory));
				const parentDirectory = dirname(realTargetDirectory);
				await ensureDirectoryChain(realRoot, parentDirectory);
				const stagingDirectory = `${realTargetDirectory}.staging-${randomUUID()}`;
				await ensureDirectoryChain(realRoot, join(stagingDirectory, 'files'));
				for (const file of files) {
					const destination = assertWithin(join(stagingDirectory, 'files'), resolve(stagingDirectory, 'files', ...file.relativePath.split('/')), 'stored file');
					await ensureDirectoryChain(realRoot, dirname(destination));
					await copyFile(file.sourcePath, destination);
					const copiedHash = await hashFile(destination);
					const expected = entry.files.find(item => item.relativePath === file.relativePath);
					if (copiedHash !== expected.sha256)
						throw new LocalLibraryIntegrityError(`copied file does not match its source: ${file.relativePath}`);
				}
				await writeFile(join(stagingDirectory, MANIFEST_FILE), `${JSON.stringify(entry, null, 2)}\n`, { flag: 'wx' });
				await rename(stagingDirectory, realTargetDirectory);
				try {
					await writeCatalog({ ...catalog, modules: [...catalog.modules, entry] });
				}
				catch (error) {
					throw new LocalLibraryError(`module files were copied but catalog update failed for ${input.localId}@${input.version}; inspect the stored folder before continuing`, 'PARTIAL_IMPORT', { cause: error });
				}
				return { ...entry, storagePath: targetDirectory };
			}
			finally {
				await releaseLock();
			}
		},

		async list() {
			return listRecords();
		},

		async search(query) {
			assertString(query, 'query');
			const needle = query.toLocaleLowerCase();
			const records = await listRecords();
			return records.filter(record => canonicalJson(record).toLocaleLowerCase().includes(needle));
		},

		async get(localId, version) {
			assertString(localId, 'localId');
			assertString(version, 'version');
			const catalog = await readCatalog();
			const record = catalog.modules.find(item => item.localId === localId && item.version === version);
			if (!record)
				throw new LocalLibraryError(`module version was not found: ${localId}@${version}`, 'NOT_FOUND');
			return verifyStoredRecord(record);
		},
	});
}
