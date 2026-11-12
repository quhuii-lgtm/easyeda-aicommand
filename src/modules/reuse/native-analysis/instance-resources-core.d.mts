import type { AsyncSha256, JsonClone, ProjectInspector, ZipConstructor } from './module-extract-core.mjs';

export interface InstanceResourceAdapter {
	deriveInstanceResources(input: Record<string, unknown> & {
		sourceBytes: Uint8Array;
		projectText: string;
		epruText: string;
		workcard: Record<string, unknown>;
		sourceEpru?: string;
	}): Promise<{
		outputBytes: Uint8Array;
		outputText: string;
		proof: Record<string, unknown>;
	}>;
	parseInstanceResources(source: string, projectMetadata: Record<string, unknown>): Record<string, unknown>;
}

export function createInstanceResourceAdapter(options: {
	JSZip: ZipConstructor;
	sha256: AsyncSha256;
	inspectNativeProject: ProjectInspector;
	cloneJson: JsonClone;
}): InstanceResourceAdapter;
