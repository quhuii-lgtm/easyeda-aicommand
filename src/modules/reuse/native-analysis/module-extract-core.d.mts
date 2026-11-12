import type { NativeInspection, NativeInspectionInput } from './inspector-core.mjs';

export type HashInput = Uint8Array | string;
export type AsyncSha256 = (value: HashInput) => string | Promise<string>;
export type JsonClone = <T>(value: T) => T;
export type ProjectInspectionInput = NativeInspectionInput;
export type ProjectInspector = (input: ProjectInspectionInput) => NativeInspection;

export interface ZipEntry {
	dir: boolean;
	async(type: 'string'): Promise<string>;
	async(type: 'uint8array'): Promise<Uint8Array>;
}
export interface ZipArchive {
	files: Record<string, ZipEntry>;
	file(name: string): ZipEntry | null;
	file(name: string, data: string | Uint8Array): this;
	generateAsync(options: { type: 'uint8array'; compression?: 'DEFLATE' | 'STORE' }): Promise<Uint8Array>;
}
export interface ZipConstructor {
	new(): ZipArchive;
	loadAsync(bytes: Uint8Array): Promise<ZipArchive>;
}

export interface ModuleExtractor {
	parseNative(source: string): { docs: Array<Record<string, unknown>>; byUuid: Map<string, Record<string, unknown>> };
	trimSource(input: Record<string, unknown> & { sourceBytes: Uint8Array; projectText: string; epruText: string; workcard: Record<string, unknown> }): Promise<{ outputZip: ZipArchive; proof: Record<string, unknown> }>;
	extractModuleArchive(input: Record<string, unknown> & { sourceBytes: Uint8Array; workcard: Record<string, unknown>; sourceEpru?: string; outputEpru?: string }): Promise<{ outputZip: Uint8Array; proof: Record<string, unknown> }>;
}

export function createModuleExtractor(options: {
	JSZip: ZipConstructor;
	sha256: AsyncSha256;
	inspectNativeProject: ProjectInspector;
	cloneJson: JsonClone;
}): ModuleExtractor;
