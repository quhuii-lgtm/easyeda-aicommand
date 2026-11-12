export type NativeInspectionInput = {
	projectMetadata: unknown;
	source: string;
};

export type NativeRecord = {
	header: Record<string, unknown>;
	data: unknown;
	line: number;
	raw: string;
	deleted?: boolean;
};

export type NativeDocument = {
	docType: string;
	uuid: string;
	docHead: NativeRecord;
	docHeads: NativeRecord[];
	rawRecordCount: number;
	effectiveRecordCount: number;
	rawRecords: NativeRecord[];
	effectiveRecords: NativeRecord[];
	[key: string]: unknown;
};

export type NativeInspection = {
	schema: number;
	documents: NativeDocument[];
	sourceHash?: string;
	projectMetadataHash?: string;
	[key: string]: unknown;
};

export type NativeInspector = {
	inspectNativeProject(input: NativeInspectionInput): NativeInspection;
	createPairInspection(input: NativeInspectionInput & {
		schematicPageUuid: string;
		pcbUuid: string;
	}): NativeInspection;
};

export function createNativeInspector(options?: {
	hashText?: (value: string) => string;
}): NativeInspector;
