import type { GeometryHost } from '../geometryHost';
import namespace from './namespace';
import { createCopperCore } from './upstream/core.js';
import clipping from './upstream/polygon-clipping.js';
import './upstream/constants.js';
import './upstream/geometry-utils.js';
import './upstream/polygon-utils.js';
import './upstream/primitive-targets.js';
import './upstream/target-geometry.js';
import './upstream/drc-rules.js';
import './upstream/target-collectors.js';
import './upstream/boundary-generation.js';

export function configureCopperRuntime(sdk: any, host: GeometryHost) {
	namespace.sdk = sdk;
	namespace.host = host;
	namespace.diagnostics.length = 0;
	const upstream = namespace.AutoCopperPour as {
		constants: Record<string, any>;
		geometryUtils: Record<string, (...args: any[]) => any>;
		polygonUtils: Record<string, (...args: any[]) => any>;
		primitiveTargets: Record<string, (...args: any[]) => any>;
		targetGeometry: Record<string, (...args: any[]) => any>;
		drcRules: Record<string, (...args: any[]) => any>;
		targetCollectors: Record<string, (...args: any[]) => any>;
		boundaryGeneration: { create: (deps: Record<string, any>) => Record<string, (...args: any[]) => any> };
	};
	const core = createCopperCore(namespace, clipping, sdk.pcb_MathPolygon);
	return { namespace, upstream, core, diagnostics: namespace.diagnostics as Array<Record<string, unknown>> };
}
