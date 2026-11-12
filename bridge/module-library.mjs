import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile, rename, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'
import { createLocalLibrary } from './local-library.mjs'

const execFile = promisify(execFileCallback)
const CONFIG_FILE = 'module-library.config.json'
const TRUSTED_ORIGINS = new Set(['https://pro.lceda.cn'])

export class ModuleLibraryError extends Error {
	constructor(message, code = 'MODULE_LIBRARY_ERROR', options = {}) {
		super(message, options)
		this.name = 'ModuleLibraryError'
		this.code = code
	}
}

function assertString(value, label) {
	if (typeof value !== 'string' || value.length === 0)
		throw new ModuleLibraryError(`${label} must be a non-empty string`, 'INVALID_ARGUMENT')
}

function assertAbsoluteDirectory(directory) {
	assertString(directory, 'directory')
	if (!path.isAbsolute(directory) || directory.includes('\0'))
		throw new ModuleLibraryError(`directory must be an absolute path: ${directory}`, 'INVALID_DIRECTORY')
	return path.resolve(directory)
}

function normalizeSha256(value) {
	if (value === undefined)
		return undefined
	if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value))
		throw new ModuleLibraryError('sha256 must be a 64-character hexadecimal digest', 'INVALID_ARGUMENT')
	return value.toLowerCase()
}

function safeFileName(fileName) {
	assertString(fileName, 'fileName')
	if (fileName !== path.posix.basename(fileName) || fileName !== path.win32.basename(fileName)
		|| fileName === '.' || fileName === '..' || /[\0:*?"<>|/\\]/.test(fileName)
		|| fileName.endsWith('.') || fileName.endsWith(' '))
		throw new ModuleLibraryError(`fileName must be a safe file name without directory components: ${fileName}`, 'INVALID_FILE_NAME')
	return fileName
}

function errorPayload(error) {
	const result = {
		message: String(error?.message ?? error),
		code: String(error?.code ?? 'MODULE_LIBRARY_ERROR'),
	}
	if (error?.cause) {
		result.cause = {
			message: String(error.cause.message ?? error.cause),
			...(error.cause.code ? { code: String(error.cause.code) } : {}),
		}
	}
	return result
}

function integrityError(error, directory) {
	const code = error?.code
	if (code === 'EACCES' || code === 'EPERM')
		return new ModuleLibraryError(`所选模块库目录不可写：${directory}（${code}: ${error.message}）。请自行选择有写入权限的目录；代理不会改用其他目录或修改权限。`, code, { cause: error })
	return error
}

function parseProcessPaths(output) {
	const text = String(output ?? '').trim()
	if (!text)
		return []
	let values
	try {
		values = JSON.parse(text)
	}
	catch {
		values = text.split(/\r?\n/).filter(Boolean)
	}
	return (Array.isArray(values) ? values : [values])
		.filter(value => typeof value === 'string' && value.trim())
		.map(value => path.dirname(path.resolve(value.trim())))
}

async function detectWindowsInstallDirectories() {
	// Fixed command only: no user-controlled string is interpolated into PowerShell.
	const script = "$ErrorActionPreference='Stop'; $p=Get-Process -Name 'lceda-pro' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -ExpandProperty Path -Unique; if ($p) { ConvertTo-Json -InputObject @($p) -Compress }"
	const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })
	return parseProcessPaths(stdout)
}

function uniquePaths(paths) {
	const seen = new Set()
	const result = []
	for (const item of paths ?? []) {
		if (typeof item !== 'string' || !item.trim())
			continue
		const resolved = path.resolve(item.trim())
		const key = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
		if (!seen.has(key)) {
			seen.add(key)
			result.push(resolved)
		}
	}
	return result
}

export function createModuleLibraryService({
	stateDirectory,
	detectEdaInstallPaths,
	platform = process.platform,
	localLibraryFactory = createLocalLibrary,
		fileSystem = { mkdir, readFile, rm, writeFile, rename, mkdtemp, stat },
} = {}) {
	if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory))
		throw new TypeError('stateDirectory must be an absolute path')
	const configFile = path.join(stateDirectory, CONFIG_FILE)
	let configCache

	async function readConfig() {
		if (configCache)
			return configCache
		try {
			const value = JSON.parse(await fileSystem.readFile(configFile, 'utf8'))
			if (!value || typeof value !== 'object' || Array.isArray(value))
				throw new ModuleLibraryError(`module library configuration is malformed: ${configFile}`, 'CONFIG_INVALID')
			if (value.directory !== undefined && value.directory !== null)
				value.directory = assertAbsoluteDirectory(value.directory)
			if (value.edaInstallDirectory !== undefined)
				value.edaInstallDirectory = assertAbsoluteDirectory(value.edaInstallDirectory)
			configCache = value
		}
		catch (error) {
			if (error?.code !== 'ENOENT')
				throw error
			configCache = {}
		}
		return configCache
	}

	async function writeConfig(value) {
		await fileSystem.mkdir(stateDirectory, { recursive: true })
		const temporaryFile = path.join(stateDirectory, `.${CONFIG_FILE}.${randomUUID()}.tmp`)
		try {
			await fileSystem.writeFile(temporaryFile, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
			await fileSystem.rename(temporaryFile, configFile)
			configCache = value
		}
		finally {
			await fileSystem.rm(temporaryFile, { force: true }).catch(() => {})
		}
	}

	async function discoverInstallDirectories() {
		if (typeof detectEdaInstallPaths === 'function')
			return uniquePaths(await detectEdaInstallPaths())
		if (platform !== 'win32')
			throw new ModuleLibraryError(`无法在 ${platform} 上可靠读取正在运行的 lceda-pro.exe 安装路径。请通过 setDirectory 选择模块库目录，或提供已确认的 edaInstallDirectory。`, 'EDA_INSTALL_PATH_UNAVAILABLE')
		try {
			return uniquePaths(await detectWindowsInstallDirectories())
		}
		catch (error) {
			throw new ModuleLibraryError(`读取正在运行的 lceda-pro.exe 安装路径失败。请通过 setDirectory 选择模块库目录，或提供已确认的 edaInstallDirectory。`, 'EDA_INSTALL_PATH_UNAVAILABLE', { cause: error })
		}
	}

	async function resolveLocation(requestDirectory, requestInstallDirectory) {
		const config = await readConfig()
		if (requestDirectory !== undefined && requestDirectory !== null)
			return { directory: assertAbsoluteDirectory(requestDirectory), source: 'user' }
		if (config.directory)
			return { directory: config.directory, source: 'user', edaInstallDirectory: config.edaInstallDirectory }
		let installDirectories
		if (requestInstallDirectory !== undefined) {
			installDirectories = [assertAbsoluteDirectory(requestInstallDirectory)]
		}
		else if (config.edaInstallDirectory) {
			installDirectories = [config.edaInstallDirectory]
		}
		else {
			installDirectories = await discoverInstallDirectories()
		}
		if (installDirectories.length !== 1) {
			const missing = installDirectories.length === 0
			const reason = missing ? '未找到正在运行的 lceda-pro.exe 安装路径' : `发现多个 EDA 安装路径：${installDirectories.join('；')}`
			throw new ModuleLibraryError(`${reason}。请通过 setDirectory 选择模块库目录，或提供唯一、已确认的 edaInstallDirectory。`, missing ? 'EDA_INSTALL_PATH_NOT_FOUND' : 'EDA_INSTALL_PATH_AMBIGUOUS')
		}
		const edaInstallDirectory = installDirectories[0]
		return { directory: path.join(edaInstallDirectory, 'module-library'), source: 'default', edaInstallDirectory }
	}

	async function info(params = {}) {
		const location = await resolveLocation(params.directory, params.edaInstallDirectory)
		let exists = false
		try {
			const directoryStat = await fileSystem.stat(location.directory)
			exists = directoryStat.isDirectory()
		}
		catch (error) {
			if (error?.code !== 'ENOENT')
				throw integrityError(error, location.directory)
		}
		return { directory: location.directory, source: location.source, ...(location.edaInstallDirectory ? { edaInstallDirectory: location.edaInstallDirectory } : {}), exists, configFile }
	}

	async function setDirectory(params) {
		if (!params || typeof params !== 'object' || Array.isArray(params))
			throw new ModuleLibraryError('params must be an object', 'INVALID_ARGUMENT')
		if (params.directory !== null && typeof params.directory !== 'string')
			throw new ModuleLibraryError('directory must be an absolute path or null', 'INVALID_ARGUMENT')
		const next = {}
		if (params.directory !== null)
			next.directory = assertAbsoluteDirectory(params.directory)
		if (params.edaInstallDirectory !== undefined)
			next.edaInstallDirectory = assertAbsoluteDirectory(params.edaInstallDirectory)
		await writeConfig(next)
		return info({})
	}

	async function withLocation(params, operation) {
		const location = await resolveLocation(params?.directory, params?.edaInstallDirectory)
		try {
			return await operation(location)
		}
		catch (error) {
			throw integrityError(error, location.directory)
		}
	}

	async function getRecord(library, localId, version) {
		try {
			return await library.get(localId, version)
		}
		catch (error) {
			if (error?.code === 'NOT_FOUND')
				return null
			throw error
		}
	}

	function publicRecord(record, includeBytes = false) {
		return {
			...Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'storagePath' && key !== 'files')),
			files: record.files.map(file => ({
				relativePath: file.relativePath,
				role: file.role,
				size: file.size,
				sha256: file.sha256,
				...(includeBytes ? { base64: file.content.toString('base64') } : {}),
			})),
		}
	}

	async function save(params) {
		return withLocation(params, async ({ directory }) => {
			if (!params || typeof params !== 'object' || Array.isArray(params))
				throw new ModuleLibraryError('params must be an object', 'INVALID_ARGUMENT')
			assertString(params.localId, 'localId')
			assertString(params.version, 'version')
			const fileName = safeFileName(params.fileName)
			if (typeof params.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(params.base64))
				throw new ModuleLibraryError('base64 must contain valid standard Base64 data', 'INVALID_ARGUMENT')
			const content = Buffer.from(params.base64, 'base64')
			const digest = createHash('sha256').update(content).digest('hex')
			const requestedDigest = normalizeSha256(params.sha256)
			if (requestedDigest && requestedDigest !== digest)
				throw new ModuleLibraryError('sha256 does not match the supplied file bytes', 'INTEGRITY_ERROR')
			const library = localLibraryFactory(directory)
			const existing = await getRecord(library, params.localId, params.version)
			if (existing) {
				const verified = await library.get(params.localId, params.version)
				const same = verified.files.length === 1
					&& verified.files[0].relativePath === fileName
					&& verified.files[0].role === 'native'
					&& verified.files[0].sha256 === digest
					&& verified.files[0].content.equals(content)
					&& (params.name === undefined || verified.name === params.name)
					&& (params.description === undefined || verified.description === params.description)
					&& (params.tags === undefined || JSON.stringify(verified.tags) === JSON.stringify(params.tags))
				if (!same)
					throw new ModuleLibraryError(`module version already exists with different content or metadata: ${params.localId}@${params.version}`, 'VERSION_EXISTS')
				return { ...publicRecord(verified), created: false, alreadyExists: true, integrity: 'sha256-verified' }
			}

			let temporaryDirectory
			let primaryError
			try {
				await fileSystem.mkdir(directory, { recursive: true })
				temporaryDirectory = await fileSystem.mkdtemp(path.join(directory, '.module-library-import-'))
				const sourcePath = path.join(temporaryDirectory, fileName)
				await fileSystem.writeFile(sourcePath, content, { flag: 'wx' })
				const imported = await library.importModule({
					localId: params.localId,
					version: params.version,
					source: { type: 'native-import' },
					...(params.name !== undefined ? { name: params.name } : {}),
					...(params.description !== undefined ? { description: params.description } : {}),
					...(params.tags !== undefined ? { tags: params.tags } : {}),
					files: [{ sourcePath, relativePath: fileName, role: 'native' }],
				})
				const verified = await library.get(params.localId, params.version)
				if (verified.files.length !== 1 || !verified.files[0].content.equals(content))
					throw new ModuleLibraryError(`saved native file failed exact-byte readback: ${params.localId}@${params.version}`, 'INTEGRITY_ERROR')
				return { ...publicRecord(verified), created: true, alreadyExists: false, integrity: 'sha256-verified' }
			}
			catch (error) {
				primaryError = error
				if (error?.code === 'VERSION_EXISTS') {
					const verified = await library.get(params.localId, params.version)
					if (verified.files.length === 1 && verified.files[0].relativePath === fileName && verified.files[0].role === 'native' && verified.files[0].sha256 === digest && verified.files[0].content.equals(content)
						&& (params.name === undefined || verified.name === params.name)
						&& (params.description === undefined || verified.description === params.description)
						&& (params.tags === undefined || JSON.stringify(verified.tags) === JSON.stringify(params.tags)))
						return { ...publicRecord(verified), created: false, alreadyExists: true, integrity: 'sha256-verified' }
				}
				throw error
			}
			finally {
				if (temporaryDirectory) {
					try {
						await fileSystem.rm(temporaryDirectory, { recursive: true, force: true })
					}
					catch (cleanupError) {
						if (!primaryError)
							throw new ModuleLibraryError(`temporary import data could not be cleaned from ${temporaryDirectory}`, 'TEMP_CLEANUP_FAILED', { cause: cleanupError })
					}
				}
			}
		})
	}

	async function list(params = {}) {
		return withLocation(params, async ({ directory }) => {
			if (params?.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1))
				throw new ModuleLibraryError('limit must be a positive integer', 'INVALID_ARGUMENT')
			try {
				await fileSystem.readFile(path.join(directory, 'catalog.json'), 'utf8')
			}
			catch (error) {
				if (error?.code === 'ENOENT')
					return []
				throw error
			}
			const records = await localLibraryFactory(directory).list()
			if (!params?.query)
				return params?.limit === undefined ? records : records.slice(0, params.limit)
			const needle = String(params.query).toLocaleLowerCase()
			const matched = records.filter(record => JSON.stringify(record).toLocaleLowerCase().includes(needle))
			return params?.limit === undefined ? matched : matched.slice(0, params.limit)
		})
	}

	async function get(params) {
		return withLocation(params, async ({ directory }) => {
			assertString(params?.localId, 'localId')
			assertString(params?.version, 'version')
			const record = await localLibraryFactory(directory).get(params.localId, params.version)
			return publicRecord(record, true)
		})
	}

	async function dispatch(action, params = {}) {
		try {
			let data
			switch (action) {
				case 'info': data = await info(params); break
				case 'setDirectory': data = await setDirectory(params); break
				case 'save': data = await save(params); break
				case 'list': data = await list(params); break
				case 'search':
					assertString(params?.query, 'query')
					data = await list(params)
					break
				case 'get': data = await get(params); break
				default: throw new ModuleLibraryError(`unsupported module library action: ${String(action)}`, 'UNKNOWN_ACTION')
			}
			return { ok: true, data }
		}
		catch (error) {
			return { ok: false, error: errorPayload(error) }
		}
	}

	return Object.freeze({ dispatch, info: params => info(params), setDirectory, list, search: params => {
		assertString(params?.query, 'query')
		return list(params)
	}, get, save })
}

export function isTrustedModuleLibraryOrigin(origin, proxyPort) {
	if (!origin)
		return true
	if (TRUSTED_ORIGINS.has(origin))
		return true
	if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)
		return false
	return origin === `http://127.0.0.1:${proxyPort}` || origin === `http://localhost:${proxyPort}`
}

export function getModuleLibraryOriginDiagnostic(origin) {
	if (origin === undefined)
		return { receivedOriginType: 'missing' }
	if (origin === null)
		return { receivedOriginType: 'null' }
	if (typeof origin !== 'string' || origin.length === 0)
		return { receivedOriginType: 'invalid' }
	if (origin === 'null')
		return { receivedOriginType: 'opaque' }
	try {
		const parsed = new URL(origin)
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
			return { receivedOrigin: parsed.origin, receivedOriginType: parsed.protocol.slice(0, -1) }
		if (parsed.origin === 'null')
			return { receivedOriginType: 'opaque' }
		return { receivedOriginType: 'non-http' }
	}
	catch {
		return { receivedOriginType: 'invalid' }
	}
}

