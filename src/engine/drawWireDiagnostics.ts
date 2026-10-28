export interface DrawWireDiagnosticSnapshot {
	stage: string;
	stageStartedAt: string;
	elapsedMs: number;
	documentUuid?: string;
	segmentIndex?: number;
	createAttempted: boolean;
	createReturned: boolean;
	returnedId?: string;
	requestedNet?: string;
	segmentWasNamed?: boolean;
	sampleAttempts: number;
	lastCompletedSampleAt?: string;
	lastReadLabel?: string;
	lastValidationError?: { message: string; validation?: Record<string, unknown> };
	lastSourceWireIds: string[];
	lastSdkWireIds: string[];
	wireIdsSynchronized?: boolean;
}

export interface DrawWireDiagnostics {
	setDocumentUuid: (uuid: string) => void;
	setRequest: (net?: string) => void;
	setSegment: (segmentIndex: number, segmentWasNamed: boolean) => void;
	setStage: (stage: string, segmentIndex?: number) => void;
	setReadLabel: (label: string) => void;
	startSample: () => void;
	completeSample: (sourceWireIds: string[], sdkWireIds: string[], synchronized: boolean) => void;
	setValidationError: (message: string, validation?: Record<string, unknown>) => void;
	markCreateAttempted: (segmentIndex: number, segmentWasNamed: boolean) => void;
	markCreateReturned: (returnedId?: string) => void;
	snapshot: () => DrawWireDiagnosticSnapshot;
}

export function createDrawWireDiagnostics(onProgress?: (snapshot: DrawWireDiagnosticSnapshot) => void): DrawWireDiagnostics {
	const startedAt = performance.now();
	const value: DrawWireDiagnosticSnapshot = {
		stage: 'starting',
		stageStartedAt: new Date().toISOString(),
		elapsedMs: 0,
		createAttempted: false,
		createReturned: false,
		sampleAttempts: 0,
		lastSourceWireIds: [],
		lastSdkWireIds: [],
	};
	let reportedStageKeys = new Set<string>();
	let reportedSegmentIndex: number | undefined;
	let lastReportedValidation = '';

	const snapshot = (): DrawWireDiagnosticSnapshot => ({
		...value,
		elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
		lastSourceWireIds: [...value.lastSourceWireIds],
		lastSdkWireIds: [...value.lastSdkWireIds],
		...(value.lastValidationError ? { lastValidationError: { ...value.lastValidationError, ...(value.lastValidationError.validation ? { validation: { ...value.lastValidationError.validation } } : {}) } } : {}),
	});
	const report = () => {
		try {
			onProgress?.(snapshot());
		}
		catch { /* Progress reporting is advisory and must not interrupt the command. */ }
	};

	return {
		setDocumentUuid(uuid) { value.documentUuid = uuid; },
		setRequest(net) { value.requestedNet = net; },
		setSegment(segmentIndex, segmentWasNamed) {
			value.segmentIndex = segmentIndex;
			value.segmentWasNamed = segmentWasNamed;
		},
		setStage(stage, segmentIndex) {
			const changed = stage !== value.stage || segmentIndex !== value.segmentIndex;
			if (segmentIndex !== reportedSegmentIndex) {
				reportedSegmentIndex = segmentIndex;
				reportedStageKeys = new Set<string>();
			}
			value.stage = stage;
			if (changed)
				value.stageStartedAt = new Date().toISOString();
			value.segmentIndex = segmentIndex;
			const stageKey = `${stage}\u0000${segmentIndex ?? ''}`;
			if (changed && !reportedStageKeys.has(stageKey)) {
				reportedStageKeys.add(stageKey);
				report();
			}
		},
		setReadLabel(label) { value.lastReadLabel = label; },
		startSample() { value.sampleAttempts++; },
		completeSample(sourceWireIds, sdkWireIds, synchronized) {
			value.lastCompletedSampleAt = new Date().toISOString();
			value.lastSourceWireIds = [...sourceWireIds];
			value.lastSdkWireIds = [...sdkWireIds];
			value.wireIdsSynchronized = synchronized;
		},
		setValidationError(message, validation) {
			const compactValidation = validation ? Object.fromEntries(Object.entries(validation).filter(([, item]) => item == null || ['string', 'number', 'boolean'].includes(typeof item))) : undefined;
			const next = { message, ...(compactValidation ? { validation: compactValidation } : {}) };
			const key = JSON.stringify(next);
			value.lastValidationError = next;
			if (key !== lastReportedValidation) {
				lastReportedValidation = key;
				report();
			}
		},
		markCreateAttempted(segmentIndex, segmentWasNamed) {
			value.segmentIndex = segmentIndex;
			value.segmentWasNamed = segmentWasNamed;
			value.createAttempted = true;
			value.createReturned = false;
			delete value.returnedId;
		},
		markCreateReturned(returnedId) {
			value.createReturned = true;
			if (returnedId)
				value.returnedId = returnedId;
		},
		snapshot,
	};
}
