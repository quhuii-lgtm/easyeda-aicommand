/* Static pure-geometry extraction from JLCEDA eext-auto-copper-shape snapshot 98317b6b5941977a3ae90948a05295f9d8b1169f. UI and original EDA write path removed; see third-party/eext-auto-copper-shape. */
export function createCopperCore(namespace, clipping, mathSdk) {
				'use strict';

				const {
					SAFE_COPPER_WIDTH,
					POUR_LINE_WIDTH,
					SHOULD_USE_DYNAMIC_SHAPE,
					EDGE_BLOCK_FORWARD_SEARCH_MARGIN,
					OBSTACLE_LATERAL_MARGIN,
					MIN_TRACE_CLIPPED_POLYGON_AREA,
					MIN_AVOIDANCE_NECK_WIDTH,
					EDGE_BLOCK_FORWARD_GAP,
					EDGE_BLOCK_CORNER_DOMINANCE_RATIO,
					EDGE_BLOCK_CORNER_GAP_BIAS,
					TRACE_NECK_REPAIR_MAX_PASSES,
					TRACE_NECK_TRACE_EDGE_TOLERANCE,
					TRACE_NECK_REPAIR_INNER_OVERLAP,
					MAX_DETOUR_LENGTH_RATIO,
					MAX_DETOUR_OFFSET_RATIO,
					MIN_DETOUR_CORNER_ANGLE,
					SHORT_BRIDGE_FALLBACK_GAP,
					SHORT_BRIDGE_DETOUR_OFFSET_RATIO,
					SHORT_BRIDGE_SPIKE_CORNER_ANGLE,
					LOCAL_DETOUR_MAX_OFFSET_RATIO,
					LOCAL_DETOUR_MIN_INTERVAL,
					LOCAL_DETOUR_CORNER_GUARD_MIN,
					ENABLE_PAD_EDGE_DIAGNOSTICS,
					DEFAULT_CONFIG,
				} = namespace.AutoCopperPour.constants;
				const {
					warn: logWarn,
					error: logError,
					reportDiagnostic,
				} = namespace.AutoCopperPour.logger;
				const {
					text,
				} = namespace.AutoCopperPour.i18n;
				const {
					toNumber,
					distance,
					roundCoordinate,
					cross,
					pointKey,
					toRadians,
					rotateWorldDirectionToLocal,
					vectorLength,
					normalizeVector,
					reverseVector,
					addVectors,
					dotProduct,
					polygonSignedArea,
					getOutwardNormal,
					interpolatePoint,
					pointToward,
					quadraticPoint,
				} = namespace.AutoCopperPour.geometryUtils;
				const {
					collectNumbers,
					compactPolygonPoints,
					makePolygonSourceFromPoints,
					isFlatPolygonSource,
					getPolygonSourceParts,
					makePointsFromFlatPolygonSource,
					makePointsFromPolygonSource,
					orientPolygonPoints,
					makeOrientedPolygonSource,
					uniquePoints,
					convexHull,
					removeCollinearPoints,
					cleanBoundaryPoints,
					polygonPointKeysMatch,
					pointInsideBox,
					pointOnSegment,
					segmentsIntersect,
					segmentIntersectsBox,
					getBoxCorners,
					pointOnPolygonBoundary,
					pointInPolygon,
					getContourSamplePoints,
					polygonCoversContour,
					polygonCoversTargetContours,
					boxTouchesPolygonInterior,
					pointToSegmentDistance,
					segmentToSegmentDistance,
					pointsNearlyEqual,
					segmentsShareEndpoint,
					makePathSegments,
					makeBoundarySegments,
					getPathLength,
				} = namespace.AutoCopperPour.polygonUtils;
				const {
					getPrimitiveId,
				} = namespace.AutoCopperPour.primitiveTargets;
				const {
					isPadLikeTarget,
					getTargetKey,
					dedupeTargets,
					collectTargets,
					getTargetHalfSize,
					calculateTargetBounds,
					isCopperNodePrimitive,
					isTraceClipObstacle,
					isCopperAreaClipObstacle,
					collectCopperObstacles,
					collectPadEdgeShieldObstacles,
					collectTraceClipObstacles,
					collectCopperAreaClipObstacles,
				} = namespace.AutoCopperPour.targetCollectors;
				const {
					normalizeNetName,
					getPcbDrcRuleContext,
					getObstacleClearanceMil,
					summarizeClearanceRules,
					applyDrcClearanceToObstacles,
				} = namespace.AutoCopperPour.drcRules;
				const {
					getConfigExpansion,
					applyBoundaryMargins,
					calculatePourMargin,
					makeTargetMarginReductionCandidates,
					getTraceClearanceRadius,
					makeTraceCapsulePoints,
					makeCopperNodeBodyContourPoints,
					getShapeWidth,
					getShapeHeight,
					getBoundaryShapeKind,
					getShapeProjectionRadius,
					targetSupportPoint,
					makeRectExpandedCornerPoints,
					makeSingleTargetBoundary,
					makeTargetContourPoints,
				} = namespace.AutoCopperPour.targetGeometry;

				const {
					getHardBoundaryInvalidReasons,
					getRectEdgeDebugSummary,
					getTargetGapDistance,
					hasSharpBoundaryCorner,
					isCloseTwoRectTargetSet,
					isTwoRectTargetSet,
					makeMultiPadAutoBoundary,
					makeOuterSupportBoundary,
					resolveRequiresStrictEdgeBoundary,
					selectBoundaryEdgePairPasses,
					shouldRejectGenericFallbackDetour,
					shouldUseDirectShortBridgeFallback,
				} = namespace.AutoCopperPour.boundaryGeneration.create({
					EDGE_BLOCK_CORNER_DOMINANCE_RATIO,
					EDGE_BLOCK_CORNER_GAP_BIAS,
					EDGE_BLOCK_FORWARD_GAP,
					EDGE_BLOCK_FORWARD_SEARCH_MARGIN,
					MAX_DETOUR_OFFSET_RATIO,
					MIN_AVOIDANCE_NECK_WIDTH,
					OBSTACLE_LATERAL_MARGIN,
					POUR_LINE_WIDTH,
					SHORT_BRIDGE_DETOUR_OFFSET_RATIO,
					SHORT_BRIDGE_FALLBACK_GAP,
					SHORT_BRIDGE_SPIKE_CORNER_ANGLE,
					addVectors,
					bendBoundaryAroundObstacles,
					calculateTargetBounds,
					cleanBoundaryPoints,
					convexHull,
					dedupeTargets,
					distance,
					dotProduct,
					flattenValidClipGeometry,
					getBoundaryPathInvalidReasons,
					getBoundaryShapeKind,
					getForeignCopperNodeOverlapSummary,
					getNarrowBoundaryNeckDetails,
					getOutwardNormal,
					getPathLength,
					getPolygonClippingUnion,
					getShapeHeight,
					getShapeProjectionRadius,
					getShapeWidth,
					getTargetHalfSize,
					getTargetKey,
					inflateObstacle,
					isBoundaryPathValid,
					isBoundaryPathValidIgnoringNeck,
					isCopperNodePrimitive,
					isEdaPourPolygonCreatable,
					isPadLikeTarget,
					logWarn,
					makeClipGeometriesFromContours,
					makeClipRingFromPoints,
					makeFallbackTargetBoundaryPoints,
					makePointsFromClipRing,
					makeRectExpandedCornerPoints,
					makeSingleTargetBoundary,
					makeTargetContourPoints,
					normalizeNetName,
					normalizeVector,
					pointKey,
					pointOnSegment,
					pointToSegmentDistance,
					polygonCoversContour,
					polygonCoversTargetContours,
					polygonHasSelfIntersection,
					polygonSignedArea,
					reportPadEdgeDiagnostic,
					reverseVector,
					rotateWorldDirectionToLocal,
					roundCoordinate,
					segmentsIntersect,
					segmentsShareEndpoint,
					summarizePadEdgeCollection,
					summarizePadEdgeTarget,
					summarizePadEdgeTargets,
					summarizeRectEdgeBlockerOptions,
					summarizeRectEdgeCandidate,
					summarizeRectEdgePair,
					targetSupportPoint,
					toNumber,
					uniquePoints,
					vectorLength,
				});

				const padEdgeDiagnosticSessionStack = [];

				function createPadEdgeDiagnosticSession(meta) {
					return {
						meta: meta || {},
						blockedCandidates: [],
						edgeSelections: [],
						boundaryExhausted: [],
						boundaryFallbacks: [],
						bridgedBoundaries: [],
						polygon: {},
						notes: [],
					};
				}

				function mergePadEdgeDiagnosticSessions(parent, child) {
					if (!parent || !child) {
						return;
					}

					parent.blockedCandidates.push(...child.blockedCandidates);
					parent.edgeSelections.push(...child.edgeSelections);
					parent.boundaryExhausted.push(...child.boundaryExhausted);
					parent.boundaryFallbacks.push(...child.boundaryFallbacks);
					parent.bridgedBoundaries.push(...child.bridgedBoundaries);
					parent.notes.push(...child.notes);
					if (child.polygon.start) {
						parent.polygon.start = child.polygon.start;
					}
					if (child.polygon.source) {
						parent.polygon.source = child.polygon.source;
					}
					if (child.polygon.detourObstacles) {
						parent.polygon.detourObstacles = child.polygon.detourObstacles;
					}
					if (child.polygon.result) {
						parent.polygon.result = child.polygon.result;
					}
				}

				function beginPadEdgeDiagnosticSession(meta) {
					const session = createPadEdgeDiagnosticSession(meta);
					padEdgeDiagnosticSessionStack.push(session);
					return session;
				}

				function getActivePadEdgeDiagnosticSession() {
					return padEdgeDiagnosticSessionStack.length > 0
						? padEdgeDiagnosticSessionStack[padEdgeDiagnosticSessionStack.length - 1]
						: undefined;
				}

				function endPadEdgeDiagnosticSession() {
					const session = padEdgeDiagnosticSessionStack.pop();
					if (!session) {
						return;
					}

					if (padEdgeDiagnosticSessionStack.length > 0) {
						mergePadEdgeDiagnosticSessions(
							padEdgeDiagnosticSessionStack[padEdgeDiagnosticSessionStack.length - 1],
							session,
						);
						return;
					}

					flushPadEdgeDiagnosticReport(session);
				}

				function compactDiagnosticTargetRef(target) {
					if (!target) {
						return undefined;
					}

					return {
						id: normalizeNetName(target.primitiveId) || target.key || '',
						net: normalizeNetName(target.net),
						type: target.type || '',
					};
				}

				function compactDiagnosticBlockerRef(blocker) {
					if (!blocker) {
						return undefined;
					}

					return {
						id: normalizeNetName(blocker.primitiveId) || blocker.key || '',
						key: blocker.key,
						net: normalizeNetName(blocker.net),
						type: blocker.type || '',
						sourceKind: blocker.sourceKind,
						layer: blocker.layer,
						x: blocker.x,
						y: blocker.y,
						width: blocker.width,
						height: blocker.height,
						shapeWidth: blocker.shapeWidth,
						shapeHeight: blocker.shapeHeight,
						rotation: blocker.rotation,
						forwardDistance: blocker.forwardDistance,
						forwardGap: blocker.forwardGap,
						forwardGapLimit: blocker.forwardGapLimit,
						lateralDistance: blocker.lateralDistance,
						lateralGap: blocker.lateralGap,
						lateralGapLimit: blocker.lateralGapLimit,
						forwardOverlapAccepted: Boolean(blocker.forwardOverlapAccepted),
						reason: blocker.reason,
					};
				}

				function summarizeBlockedCandidateEvent(entry) {
					return {
						target: compactDiagnosticTargetRef(entry.target),
						opposite: compactDiagnosticTargetRef(entry.oppositeTarget),
						keptLabels: entry.keptLabels || [],
						shieldTargetCount: entry.shieldTargetCount,
						blockerOptions: entry.blockerOptions,
						candidates: (entry.rawCandidates || []).map(candidate => ({
							label: candidate.label,
							rank: candidate.preferenceRank,
							edge: {
								axis: candidate.axis,
								sideSign: candidate.sideSign,
								label: candidate.label,
								start: candidate.start,
								end: candidate.end,
								midpoint: candidate.midpoint,
								outward: candidate.outward,
							},
							blocked: candidate.blockerCount > 0,
							blockers: candidate.blockerCount,
							blockerIds: (candidate.blockers || []).map(blocker => blocker.primitiveId).filter(Boolean),
							blockerDetails: (candidate.blockers || []).map(blocker => compactDiagnosticBlockerRef(blocker)).filter(Boolean),
							ignoredCornerBlockerCount: candidate.ignoredCornerBlockerCount,
							ignoredCornerBlockers: (candidate.ignoredCornerBlockers || [])
								.map(blocker => compactDiagnosticBlockerRef(blocker))
								.filter(Boolean),
						})),
					};
				}

				function summarizeEdgeSelectionEvent(entry) {
					return {
						targets: (entry.targets || []).map(target => compactDiagnosticTargetRef(target)),
						shieldTargets: entry.shieldTargets,
						obstacleCount: entry.obstacleCount,
						passes: entry.passes,
					};
				}

				function getBlockedCandidateEventKey(entry) {
					const targetId = compactDiagnosticTargetRef(entry.target)?.id || '';
					const oppositeId = compactDiagnosticTargetRef(entry.oppositeTarget)?.id || '';
					return `${targetId}|${oppositeId}`;
				}

				function dedupeBlockedCandidateEvents(entries) {
					const latestByKey = new Map();
					for (const entry of entries) {
						latestByKey.set(getBlockedCandidateEventKey(entry), entry);
					}
					return Array.from(latestByKey.values());
				}

				function summarizeBoundaryExhaustedEvent(entry) {
					const passSummaries = (entry.passSummaries || [])
						.filter(passSummary => passSummary.rejectedCount > 0)
						.map(passSummary => ({
							pass: passSummary.pass,
							edgePairCount: passSummary.edgePairCount,
							rejectedCount: passSummary.rejectedCount,
							rejectedSamples: passSummary.rejectedSamples,
						}));
					if (passSummaries.length === 0) {
						return undefined;
					}

					return {
						targets: (entry.targets || []).map(target => compactDiagnosticTargetRef(target)),
						passSummaries,
					};
				}

				function compactPolygonDiagnosticReport(polygon) {
					const start = polygon.start || {};
					const source = polygon.source || {};
					const detourObstacles = polygon.detourObstacles || {};
					const result = polygon.result || {};

					return {
						layout: start.multiPadLayoutClass,
						strategy: start.multiPadBoundaryStrategy || start.multiPadBoundaryStrategyRequested,
						edgeSelectionApplied: source.edgeSelectionApplied ?? result.edgeSelectionApplied,
						selectedEdgePair: source.selectedEdgePair || start.selectedEdgePair,
						boundaryPoints: {
							raw: source.rawBoundaryPointCount,
							base: result.basePointCount,
							final: result.finalPointCount,
							covered: result.coveredPointCount,
						},
						detour: {
							obstacleCount: detourObstacles.inflatedObstacleCount,
							isMultiPadScenario: detourObstacles.isMultiPadScenario,
							mode: result.boundaryAvoidanceMode,
							avoidedCount: result.avoidance && result.avoidance.avoidedCount,
							unresolvedCount: result.avoidance && result.avoidance.unresolvedCount,
							clipFallbackCount: Array.isArray(result.clipFallbackObstacleKeys)
								? result.clipFallbackObstacleKeys.length
								: 0,
							usedDirectShortBridgeFallback: result.shortBridgeFallback
								&& result.shortBridgeFallback.usedDirect,
							genericFallbackDetourRejected: result.genericFallbackDetourRejected,
							detourInvalidReasons: result.detourInvalidReasons,
						},
						multiPad: result.multiPadDetour,
					};
				}

				function flushPadEdgeDiagnosticReport(session) {
					if (!session) {
						return;
					}

					const report = {
						...session.meta,
					};
					let eventCount = 0;

					if (session.blockedCandidates.length > 0) {
						const dedupedBlockedCandidates = dedupeBlockedCandidateEvents(session.blockedCandidates);
						eventCount += dedupedBlockedCandidates.length;
						report.edgeBlocking = {
							eventCount: session.blockedCandidates.length,
							uniquePairCount: dedupedBlockedCandidates.length,
							entries: dedupedBlockedCandidates.map(entry => summarizeBlockedCandidateEvent(entry)),
						};
					}

					const exhaustedSummaries = session.boundaryExhausted
						.map(entry => summarizeBoundaryExhaustedEvent(entry))
						.filter(Boolean);
					if (session.edgeSelections.length > 0 || exhaustedSummaries.length > 0 || session.boundaryFallbacks.length > 0) {
						eventCount += session.edgeSelections.length + exhaustedSummaries.length;
						report.edgeSelection = {
							selections: session.edgeSelections.map(entry => summarizeEdgeSelectionEvent(entry)),
							exhausted: exhaustedSummaries,
							fallbacks: session.boundaryFallbacks,
						};
					}

					if (session.bridgedBoundaries.length > 0) {
						eventCount += session.bridgedBoundaries.length;
						report.bridgedBoundaries = session.bridgedBoundaries;
					}

					if (session.polygon.start || session.polygon.source || session.polygon.detourObstacles || session.polygon.result) {
						eventCount += 1;
						report.polygon = compactPolygonDiagnosticReport(session.polygon);
					}

					if (session.notes.length > 0) {
						eventCount += session.notes.length;
						report.notes = session.notes;
					}

					if (eventCount <= 0) {
						return;
					}

					logWarn('Pour boundary diagnostic', report);
				}

				function reportPadEdgeDiagnostic(message, details) {
					if (!ENABLE_PAD_EDGE_DIAGNOSTICS) {
						return;
					}

					const session = getActivePadEdgeDiagnosticSession();
					if (!session) {
						logWarn(message, details);
						return;
					}

					switch (message) {
						case 'Pad edge blocked candidates':
							session.blockedCandidates.push(details);
							return;
						case 'Pad edge selection':
							session.edgeSelections.push(details);
							return;
						case 'Pad edge boundary candidate rejected':
							return;
						case 'Pad edge boundary candidates exhausted':
							session.boundaryExhausted.push(details);
							return;
						case 'Pad edge fallback selected':
							session.boundaryFallbacks.push(details);
							return;
						case 'Multi-pad bridged boundary':
							session.bridgedBoundaries.push(details);
							return;
						case 'Pad edge polygon generation start':
							session.polygon.start = details;
							return;
						case 'Pad edge boundary source selected':
							session.polygon.source = details;
							return;
						case 'Boundary detour obstacle set':
							session.polygon.detourObstacles = details;
							return;
						case 'Pad edge polygon generation result':
							session.polygon.result = details;
							return;
						default:
							session.notes.push({ message, details });
					}
				}
				function summarizePadEdgeTarget(target) {
					if (!target) {
						return undefined;
					}

					return {
						key: getTargetKey(target),
						primitiveId: normalizeNetName(target.primitiveId),
						type: target.type || '',
						net: normalizeNetName(target.net),
						sourceKind: target.sourceKind,
						layer: target.layer,
						sourceTargetCount: Array.isArray(target.sourceTargets) ? target.sourceTargets.length : undefined,
						x: roundCoordinate(toNumber(target.x, 0)),
						y: roundCoordinate(toNumber(target.y, 0)),
						width: roundCoordinate(toNumber(target.width, 0)),
						height: roundCoordinate(toNumber(target.height, 0)),
						shapeWidth: roundCoordinate(toNumber(target.shapeWidth, target.width)),
						shapeHeight: roundCoordinate(toNumber(target.shapeHeight, target.height)),
						rotation: roundCoordinate(toNumber(target.rotation, 0)),
					};
				}

				function summarizePadEdgeTargets(targets) {
					return (Array.isArray(targets) ? targets : [])
						.map(target => summarizePadEdgeTarget(target))
						.filter(Boolean);
				}

				function summarizePadEdgeCollection(targets) {
					const list = Array.isArray(targets) ? targets : [];
					const typeCounts = {};
					let padLikeCount = 0;

					for (const target of list) {
						const type = target && target.type ? target.type : 'unknown';
						typeCounts[type] = (typeCounts[type] || 0) + 1;
						if (target && isPadLikeTarget(target)) {
							padLikeCount += 1;
						}
					}

					return {
						count: list.length,
						padLikeCount,
						typeCounts,
					};
				}

				function summarizePadEdgeBlocker(blocker) {
					if (!blocker) {
						return undefined;
					}

					const target = blocker.target || {};
					return {
						key: target.key,
						primitiveId: normalizeNetName(target.primitiveId),
						type: target.type || '',
						net: normalizeNetName(target.net),
						sourceKind: target.sourceKind,
						layer: target.layer,
						x: roundCoordinate(toNumber(target.x, 0)),
						y: roundCoordinate(toNumber(target.y, 0)),
						width: roundCoordinate(toNumber(target.width, 0)),
						height: roundCoordinate(toNumber(target.height, 0)),
						shapeWidth: roundCoordinate(toNumber(target.shapeWidth, target.width)),
						shapeHeight: roundCoordinate(toNumber(target.shapeHeight, target.height)),
						rotation: roundCoordinate(toNumber(target.rotation, 0)),
						forwardDistance: roundCoordinate(toNumber(blocker.forwardDistance, 0)),
						forwardGap: roundCoordinate(toNumber(blocker.forwardGap, 0)),
						forwardGapLimit: roundCoordinate(toNumber(blocker.forwardGapLimit, 0)),
						lateralDistance: roundCoordinate(toNumber(blocker.lateralDistance, 0)),
						lateralGap: roundCoordinate(toNumber(blocker.lateralGap, 0)),
						lateralGapLimit: roundCoordinate(toNumber(blocker.lateralGapLimit, 0)),
						forwardOverlapAccepted: Boolean(blocker.forwardOverlapAccepted),
						reason: blocker.reason,
					};
				}

				function summarizeRectEdgeBlockerOptions(options = {}) {
					return {
						lateralGapLimit: roundCoordinate(Math.max(0, toNumber(options.lateralGapLimit, OBSTACLE_LATERAL_MARGIN))),
						forwardGapLimit: roundCoordinate(Math.max(0, toNumber(options.forwardGapLimit, EDGE_BLOCK_FORWARD_GAP))),
						forwardOverlapTolerance: roundCoordinate(Math.max(0, toNumber(options.forwardOverlapTolerance, 0))),
						allowForwardOverlap: Boolean(options.allowForwardOverlap),
					};
				}

				function summarizeRectEdgeCandidate(candidate, target) {
					const edge = candidate && candidate.edge ? candidate.edge : candidate;
					const blockers = Array.isArray(candidate && candidate.blockers) ? candidate.blockers : [];
					const ignoredCornerBlockers = Array.isArray(candidate && candidate.ignoredCornerBlockers)
						? candidate.ignoredCornerBlockers
						: [];
					const summary = getRectEdgeDebugSummary(edge, target);
					return {
						preferenceRank: toNumber(candidate && candidate.preferenceRank, 0),
						axis: summary.axis,
						sideSign: summary.sideSign,
						label: summary.label,
						start: summary.start,
						end: summary.end,
						midpoint: summary.midpoint,
						outward: summary.outward,
						blockerCount: blockers.length,
						blockers: blockers.map(blocker => summarizePadEdgeBlocker(blocker)).filter(Boolean),
						ignoredCornerBlockerCount: ignoredCornerBlockers.length,
						ignoredCornerBlockers: ignoredCornerBlockers
							.map(blocker => summarizePadEdgeBlocker(blocker))
							.filter(Boolean),
					};
				}

				function summarizeRectEdgePair(edgePair, targets) {
					const start = targets && targets[0];
					const end = targets && targets[1];
					return {
						preferenceRank: edgePair.preferenceRank,
						order: edgePair.order,
						startEdge: getRectEdgeDebugSummary(edgePair.startEdge, start),
						endEdge: getRectEdgeDebugSummary(edgePair.endEdge, end),
					};
				}

				function makeFallbackBoxPoints(bounds, margin) {
					return [
						{ x: bounds.minX - margin, y: bounds.minY - margin },
						{ x: bounds.maxX + margin, y: bounds.minY - margin },
						{ x: bounds.maxX + margin, y: bounds.maxY + margin },
						{ x: bounds.minX - margin, y: bounds.maxY + margin },
					];
				}

				function makeFallbackTargetBoundaryPoints(targets, margin, shouldUseDynamicShape) {
					const contourPoints = targets
						.flatMap(target => makeTargetContourPoints(target, margin, shouldUseDynamicShape, []));
					const hull = cleanBoundaryPoints(convexHull(contourPoints));
					if (hull.length >= 3) {
						return hull;
					}

					return makeFallbackBoxPoints(calculateTargetBounds(targets, shouldUseDynamicShape), margin);
				}


















				function makeTargetExpansionForbiddenRecords(obstacle) {
					if (!obstacle) {
						return [];
					}

					if (isTraceClipObstacle(obstacle)) {
						return makeTraceForbiddenSourceRecords([obstacle], 1);
					}

					if (isCopperNodePrimitive(obstacle)) {
						return makeCopperNodeForbiddenSourceRecords([obstacle], 1);
					}

					if (isCopperAreaClipObstacle(obstacle)) {
						const result = makeCopperAreaForbiddenSourceRecords([obstacle], 1);
						if (result.error) {
							reportDiagnostic('Skipped copper area target expansion precheck:', {
								reason: result.error,
								obstacle: summarizePadEdgeTarget(obstacle),
							});
							return [];
						}

						return result.records;
					}

					return [];
				}

				function makeTargetExpansionObstaclePolygons(obstacle) {
					return makeTargetExpansionForbiddenRecords(obstacle)
						.map(record => makePointsFromPolygonSource(record.source))
						.filter(points => points.length >= 3);
				}

				function shouldReduceTargetExpansion(target, desiredMargin, obstacles) {
					if (!isPadLikeTarget(target) || desiredMargin <= 0 || !Array.isArray(obstacles) || obstacles.length === 0) {
						return false;
					}

					const targetKey = getTargetKey(target);
					const targetNet = normalizeNetName(target.net);
					const contour = cleanBoundaryPoints(makeTargetContourPoints(
						{ ...target, boundaryMargin: desiredMargin },
						desiredMargin,
						SHOULD_USE_DYNAMIC_SHAPE,
						[],
					));
					if (contour.length < 3) {
						return false;
					}

					return obstacles.some((obstacle) => {
						if (getTargetKey(obstacle) === targetKey) {
							return false;
						}

						const obstacleNet = normalizeNetName(obstacle.net);
						if (targetNet && obstacleNet && targetNet === obstacleNet) {
							return false;
						}

						const forbiddenPolygons = makeTargetExpansionObstaclePolygons(obstacle);
						return forbiddenPolygons.some(polygon => polygonsOverlap(contour, polygon));
					});
				}

				function applyDrcAwareTargetMargins(targets, config, obstacles) {
					const desiredMargin = getConfigExpansion(config);
					if (desiredMargin <= 0 || !Array.isArray(targets) || targets.length === 0) {
						return {
							targets,
							reducedCount: 0,
						};
					}

					let reducedCount = 0;
					const adjustedTargets = targets.map((target) => {
						if (!shouldReduceTargetExpansion(target, desiredMargin, obstacles)) {
							return target;
						}

						reducedCount += 1;
						return {
							...target,
							boundaryMargin: 0,
							autoReducedExpansion: true,
						};
					});

					if (reducedCount > 0) {
						reportDiagnostic('Reduced target expansion due to DRC spacing:', {
							reducedCount,
							desiredMargin: roundCoordinate(desiredMargin),
						});
					}

					return {
						targets: adjustedTargets,
						reducedCount,
					};
				}





























				function makeOffsetContoursFromBodyContour(bodyContour, clearance, fallbackTarget) {
					const body = cleanBoundaryPoints(bodyContour);
					if (body.length < 3) {
						return [];
					}

					const amount = Math.max(0, toNumber(clearance, 0));
					if (amount <= 0.001) {
						return [body];
					}

					const offsetRings = getPolygonClippingOffsetRings();
					if (!offsetRings) {
						if (!fallbackTarget) {
							return [body];
						}

						const fallback = cleanBoundaryPoints(makeSingleTargetBoundary(
							fallbackTarget,
							amount,
							true,
							[],
						));
						return fallback.length >= 3 ? [fallback] : [body];
					}

					const ring = makeClipRingFromPoints(orientPolygonPoints(body, 1));
					if (ring.length < 4) {
						return [];
					}

					const expandedRings = offsetRings([ring], amount);
					const contours = expandedRings
						.map(makePointsFromClipRing)
						.filter(points => points.length >= 3);

					if (contours.length > 0) {
						return contours;
					}

					if (!fallbackTarget) {
						return [body];
					}

					const fallback = cleanBoundaryPoints(makeSingleTargetBoundary(
						fallbackTarget,
						amount,
						true,
						[],
					));
					return fallback.length >= 3 ? [fallback] : [body];
				}

				function makeCopperNodeClearanceContours(obstacle) {
					const body = makeCopperNodeBodyContourPoints(obstacle);
					return makeOffsetContoursFromBodyContour(body, getObstacleClearanceMil(obstacle), obstacle);
				}













				function isConvexCorner(previous, current, next, signedArea) {
					const turn = cross(previous, current, next);
					return signedArea >= 0 ? turn > 0.001 : turn < -0.001;
				}



				function getChamferWidth(config) {
					return Math.max(0, toNumber(config.chamferWidth, DEFAULT_CONFIG.chamferWidth));
				}

				function applyCornerChamfer(points, config) {
					if (!config.enableChamfer || getChamferWidth(config) <= 0 || points.length < 3) {
						return points;
					}

					const signedArea = polygonSignedArea(points);
					const chamfered = [];
					const isRound = config.chamferType === 'round';

					for (let index = 0; index < points.length; index += 1) {
						const previous = points[(index - 1 + points.length) % points.length];
						const current = points[index];
						const next = points[(index + 1) % points.length];

						if (!isConvexCorner(previous, current, next, signedArea)) {
							chamfered.push(current);
							continue;
						}

						const width = Math.min(
							getChamferWidth(config),
							distance(current, previous) / 2,
							distance(current, next) / 2,
						);

						if (width <= 0.001) {
							chamfered.push(current);
							continue;
						}

						const before = pointToward(current, previous, width);
						const after = pointToward(current, next, width);
						if (!isRound) {
							chamfered.push(before, after);
							continue;
						}

						const segmentCount = 4;
						for (let segmentIndex = 0; segmentIndex <= segmentCount; segmentIndex += 1) {
							chamfered.push(quadraticPoint(before, current, after, segmentIndex / segmentCount));
						}
					}

					return cleanBoundaryPoints(chamfered);
				}

				function removeNearCollinearManufacturingPoints(points) {
					if (points.length < 4) {
						return points;
					}

					const optimized = [];
					for (let index = 0; index < points.length; index += 1) {
						const previous = points[(index - 1 + points.length) % points.length];
						const current = points[index];
						const next = points[(index + 1) % points.length];
						const previousVector = {
							x: current.x - previous.x,
							y: current.y - previous.y,
						};
						const nextVector = {
							x: next.x - current.x,
							y: next.y - current.y,
						};
						const previousLength = vectorLength(previousVector);
						const nextLength = vectorLength(nextVector);
						const combinedLength = previousLength + nextLength;

						if (combinedLength <= 0.001) {
							continue;
						}

						const bendHeight = Math.abs(cross(previous, current, next)) / combinedLength;
						const sameDirection = dotProduct(previousVector, nextVector) > 0;
						if (sameDirection && bendHeight < 0.35) {
							continue;
						}

						optimized.push(current);
					}

					return optimized.length >= 3 ? optimized : points;
				}

				function removeShortConvexManufacturingPoints(points, minEdgeLength) {
					if (points.length < 4) {
						return points;
					}

					const signedArea = polygonSignedArea(points);
					const optimized = [];
					for (let index = 0; index < points.length; index += 1) {
						const previous = points[(index - 1 + points.length) % points.length];
						const current = points[index];
						const next = points[(index + 1) % points.length];
						const hasShortEdge = distance(previous, current) < minEdgeLength || distance(current, next) < minEdgeLength;

						if (hasShortEdge && isConvexCorner(previous, current, next, signedArea)) {
							continue;
						}

						optimized.push(current);
					}

					return optimized.length >= 3 ? optimized : points;
				}

				function shouldApplyManufacturingOptimization(config) {
					return config.generationType === 'pour'
						&& Boolean(config.pour && config.pour.manufacturingOptimization);
				}

				function applyManufacturingOptimization(points, config) {
					if (!shouldApplyManufacturingOptimization(config)) {
						return points;
					}

					let optimized = cleanBoundaryPoints(points);
					const minEdgeLength = Math.max(POUR_LINE_WIDTH / 2, 6);
					for (let pass = 0; pass < 2; pass += 1) {
						optimized = removeShortConvexManufacturingPoints(optimized, minEdgeLength);
						optimized = removeNearCollinearManufacturingPoints(optimized);
						optimized = cleanBoundaryPoints(optimized);
					}

					return optimized.length >= 3 ? optimized : points;
				}

				function applyPourPolygonPostProcessing(points, config) {
					const manufacturingOptimizedPoints = cleanBoundaryPoints(applyManufacturingOptimization(points, config));
					const processedPoints = cleanBoundaryPoints(applyCornerChamfer(manufacturingOptimizedPoints, config));
					return {
						manufacturingOptimizedPoints,
						processedPoints,
					};
				}


				function makeTargetKeepInContours(targets, margin, shouldUseDynamicShape) {
					return targets
						.map(target => cleanBoundaryPoints(makeTargetContourPoints(target, margin, shouldUseDynamicShape, [])))
						.filter(contour => contour.length >= 3);
				}

				function makePostProcessCoverageContours(targetKeepInContours, config) {
					return targetKeepInContours
						.map(contour => applyCornerChamfer(cleanBoundaryPoints(contour), config))
						.filter(contour => contour.length >= 3);
				}

				function makeInflatedObstacleBox(obstacle, extraClearance = 0) {
					if (!obstacle) {
						return undefined;
					}

					const clearance = getObstacleClearanceMil(obstacle) + Math.max(0, toNumber(extraClearance, 0));
					const halfWidth = Math.max(toNumber(obstacle.width, SAFE_COPPER_WIDTH), SAFE_COPPER_WIDTH) / 2 + clearance;
					const halfHeight = Math.max(toNumber(obstacle.height, SAFE_COPPER_WIDTH), SAFE_COPPER_WIDTH) / 2 + clearance;

					return {
						key: getTargetKey(obstacle),
						type: obstacle.type || 'Obstacle',
						clearanceMil: clearance,
						minX: obstacle.x - halfWidth,
						minY: obstacle.y - halfHeight,
						maxX: obstacle.x + halfWidth,
						maxY: obstacle.y + halfHeight,
						centerX: obstacle.x,
						centerY: obstacle.y,
					};
				}

				function inflateObstacle(obstacle) {
					return makeInflatedObstacleBox(obstacle);
				}












				function makeCopperNodeOverlapContours(obstacle, shouldUseDynamicShape, options = {}) {
					if (!obstacle || !isCopperNodePrimitive(obstacle)) {
						return [];
					}

					if (options.useClearance) {
						try {
							const box = inflateObstacle(obstacle);
							return box ? [getBoxCorners(box)] : [];
						}
						catch (err) {
							logWarn('Failed to build copper node clearance contour:', err);
							return [];
						}
					}

					const contour = cleanBoundaryPoints(makeTargetContourPoints(
						obstacle,
						0,
						shouldUseDynamicShape,
						[],
					));
					return contour.length >= 3 ? [contour] : [];
				}

				function getForeignCopperNodeOverlapSummary(points, obstacles, targetKeys, shouldUseDynamicShape, options = {}) {
					const boundary = cleanBoundaryPoints(Array.isArray(points) ? points : []);
					const keySet = targetKeys instanceof Set ? targetKeys : new Set();
					const overlappingNodes = [];
					let checkedNodeCount = 0;

					if (boundary.length < 3) {
						return {
							mode: options.useClearance ? 'clearance' : 'body',
							checkedNodeCount,
							overlapCount: 0,
							overlappingNodes,
						};
					}

					for (const obstacle of dedupeTargets(Array.isArray(obstacles) ? obstacles : [])) {
						if (!obstacle || !isCopperNodePrimitive(obstacle)) {
							continue;
						}

						const key = getTargetKey(obstacle);
						if (keySet.has(key)) {
							continue;
						}

						const contours = makeCopperNodeOverlapContours(
							obstacle,
							shouldUseDynamicShape,
							options,
						);
						if (contours.length === 0) {
							continue;
						}

						checkedNodeCount += 1;
						if (!contours.some(contour => polygonsOverlap(boundary, contour))) {
							continue;
						}

						overlappingNodes.push(summarizePadEdgeTarget(obstacle));
					}

					return {
						mode: options.useClearance ? 'clearance' : 'body',
						checkedNodeCount,
						overlapCount: overlappingNodes.length,
						overlappingNodes: overlappingNodes.slice(0, 8),
					};
				}

				function ensureBoundaryCoversTargetContours(points, targetKeepInContours = [], options = {}) {
					if (polygonCoversTargetContours(points, targetKeepInContours)) {
						return points;
					}

					if (options.allowFallback === false) {
						return points;
					}

					const fallback = cleanBoundaryPoints(convexHull([
						...points,
						...targetKeepInContours.flat(),
					]));

					return fallback.length >= 3 ? fallback : points;
				}









				function hasAcuteDetourCorner(points) {
					const minAngleCos = Math.cos(MIN_DETOUR_CORNER_ANGLE * Math.PI / 180);
					for (let index = 1; index < points.length - 1; index += 1) {
						const previous = points[index - 1];
						const current = points[index];
						const next = points[index + 1];
						const previousVector = {
							x: previous.x - current.x,
							y: previous.y - current.y,
						};
						const nextVector = {
							x: next.x - current.x,
							y: next.y - current.y,
						};
						const previousLength = vectorLength(previousVector);
						const nextLength = vectorLength(nextVector);
						if (previousLength <= 0.001 || nextLength <= 0.001) {
							continue;
						}

						if (dotProduct(previousVector, nextVector) / (previousLength * nextLength) > minAngleCos) {
							return true;
						}
					}

					return false;
				}

				function isDetourPathReasonable(start, end, detourPoints, obstacleBoxes = []) {
					if (detourPoints.length === 0) {
						return true;
					}

					const directLength = distance(start, end);
					if (directLength <= 0.001) {
						return false;
					}

					const path = [start, ...detourPoints, end];
					const detourLength = getPathLength(path);
					const maxClearance = Math.max(0, ...obstacleBoxes.map(box => toNumber(box.clearanceMil, 0)));
					const maxLength = directLength * MAX_DETOUR_LENGTH_RATIO + maxClearance * 2;
					if (detourLength > maxLength) {
						return false;
					}

					const maxOffset = Math.max(...detourPoints.map(point => pointToSegmentDistance(point, start, end)));
					const maxAllowedOffset = Math.max(
						maxClearance * 4,
						MIN_AVOIDANCE_NECK_WIDTH * 3,
						directLength * MAX_DETOUR_OFFSET_RATIO,
					);
					if (maxOffset > maxAllowedOffset) {
						return false;
					}

					return !hasAcuteDetourCorner(path);
				}

				function isLocalDetourNeckWideEnough(baseBoundary, edgeIndex, detourPoints, minWidth) {
					if (minWidth <= 0 || detourPoints.length === 0) {
						return true;
					}

					const start = baseBoundary[edgeIndex];
					const end = baseBoundary[(edgeIndex + 1) % baseBoundary.length];
					const detourSegments = makePathSegments([start, ...detourPoints, end]);
					const boundarySegments = makeBoundarySegments(baseBoundary);

					for (const detourSegment of detourSegments) {
						for (const boundarySegment of boundarySegments) {
							if (boundarySegment.index === edgeIndex
								|| segmentsShareEndpoint(
									detourSegment.start,
									detourSegment.end,
									boundarySegment.start,
									boundarySegment.end,
								)) {
								continue;
							}

							if (segmentToSegmentDistance(
								detourSegment.start,
								detourSegment.end,
								boundarySegment.start,
								boundarySegment.end,
							) < minWidth) {
								return false;
							}
						}
					}

					return true;
				}

				function getEdgeProjection(start, unit, point) {
					return dotProduct({
						x: point.x - start.x,
						y: point.y - start.y,
					}, unit);
				}

				function getObstacleProjection(start, unit, box) {
					return getEdgeProjection(start, unit, {
						x: box.centerX,
						y: box.centerY,
					});
				}

				function getBoundaryEdges(boundary, signedArea) {
					const edges = [];
					for (let index = 0; index < boundary.length; index += 1) {
						const start = boundary[index];
						const end = boundary[(index + 1) % boundary.length];
						if (distance(start, end) <= 0.001) {
							continue;
						}

						edges.push({
							start,
							end,
							index,
							inward: reverseVector(getOutwardNormal(start, end, signedArea)),
						});
					}

					return edges;
				}

				function obstacleHitsOppositeBoundaryEdges(box, edges) {
					const hitEdges = edges.filter(({ start, end }) => segmentIntersectsBox(start, end, box));
					for (let firstIndex = 0; firstIndex < hitEdges.length; firstIndex += 1) {
						for (let secondIndex = firstIndex + 1; secondIndex < hitEdges.length; secondIndex += 1) {
							if (dotProduct(hitEdges[firstIndex].inward, hitEdges[secondIndex].inward) <= -0.7) {
								return true;
							}
						}
					}

					return false;
				}

				function classifyObstacleBoundaryRelation(box, boundary, edges) {
					const hitEdges = edges.filter(({ start, end }) => segmentIntersectsBox(start, end, box));
					if (hitEdges.length === 0) {
						return {
							type: boxTouchesPolygonInterior(box, boundary) ? 'inside' : 'outside',
							hitEdges,
						};
					}

					if (hitEdges.length === 1) {
						return {
							type: 'single-edge',
							hitEdges,
						};
					}

					return {
						type: obstacleHitsOppositeBoundaryEdges(box, edges) ? 'opposite-edges' : 'multi-edge',
						hitEdges,
					};
				}

				function sortDetourCorners(start, edge, corners) {
					return corners.sort((a, b) => getEdgeProjection(start, edge, a) - getEdgeProjection(start, edge, b));
				}

				function getSegmentBoxOverlapInterval(start, end, box) {
					if (!segmentIntersectsBox(start, end, box)) {
						return undefined;
					}

					const dx = end.x - start.x;
					const dy = end.y - start.y;
					const edgeLen = Math.hypot(dx, dy);
					if (edgeLen <= 0.001) {
						return undefined;
					}

					let t0 = 0;
					let t1 = 1;
					const p = [-dx, dx, -dy, dy];
					const q = [
						start.x - box.minX,
						box.maxX - start.x,
						start.y - box.minY,
						box.maxY - start.y,
					];

					for (let index = 0; index < 4; index += 1) {
						if (Math.abs(p[index]) < 0.000001) {
							if (q[index] < 0) {
								return undefined;
							}

							continue;
						}

						const ratio = q[index] / p[index];
						if (p[index] < 0) {
							t0 = Math.max(t0, ratio);
						}
						else {
							t1 = Math.min(t1, ratio);
						}
					}

					if (t0 > t1) {
						return undefined;
					}

					const tEnter = t0 * edgeLen;
					const tExit = t1 * edgeLen;
					if (tExit - tEnter < LOCAL_DETOUR_MIN_INTERVAL) {
						return undefined;
					}

					return {
						tEnter,
						tExit,
						edgeLen,
						box,
					};
				}

				function mergeInflatedObstacleBoxes(boxes) {
					if (!Array.isArray(boxes) || boxes.length === 0) {
						return undefined;
					}

					let minX = Number.POSITIVE_INFINITY;
					let minY = Number.POSITIVE_INFINITY;
					let maxX = Number.NEGATIVE_INFINITY;
					let maxY = Number.NEGATIVE_INFINITY;
					let clearanceMil = 0;
					const keys = [];

					for (const box of boxes) {
						minX = Math.min(minX, box.minX);
						minY = Math.min(minY, box.minY);
						maxX = Math.max(maxX, box.maxX);
						maxY = Math.max(maxY, box.maxY);
						clearanceMil = Math.max(clearanceMil, toNumber(box.clearanceMil, 0));
						if (box.key) {
							keys.push(box.key);
						}
					}

					return {
						key: keys.join('+'),
						type: boxes[0].type || 'Obstacle',
						clearanceMil,
						minX,
						minY,
						maxX,
						maxY,
						centerX: (minX + maxX) / 2,
						centerY: (minY + maxY) / 2,
					};
				}

				function mergeSegmentBoxOverlapIntervals(intervals) {
					const sorted = intervals.slice().sort((first, second) => first.tEnter - second.tEnter);
					const merged = [];

					for (const interval of sorted) {
						const last = merged[merged.length - 1];
						if (!last || interval.tEnter > last.tExit + LOCAL_DETOUR_MIN_INTERVAL) {
							merged.push({
								tEnter: interval.tEnter,
								tExit: interval.tExit,
								boxes: [interval.box],
							});
							continue;
						}

						last.tExit = Math.max(last.tExit, interval.tExit);
						last.boxes.push(interval.box);
					}

					return merged.map(interval => ({
						...interval,
						mergedBox: mergeInflatedObstacleBoxes(interval.boxes),
					}));
				}

				function getOutwardOffsetPointFromBox(point, outward, box) {
					const corners = getBoxCorners(box);
					let maxAlongOutward = 0;

					for (const corner of corners) {
						maxAlongOutward = Math.max(
							maxAlongOutward,
							dotProduct({
								x: corner.x - point.x,
								y: corner.y - point.y,
							}, outward),
						);
					}

					if (maxAlongOutward <= 0.001) {
						maxAlongOutward = Math.max(0, dotProduct({
							x: box.centerX - point.x,
							y: box.centerY - point.y,
						}, outward));
					}

					return {
						x: point.x + outward.x * maxAlongOutward,
						y: point.y + outward.y * maxAlongOutward,
					};
				}

				function pushDistinctBoundaryPoint(output, point) {
					const last = output[output.length - 1];
					if (!last || distance(last, point) > 0.001) {
						output.push(point);
					}
				}

				function getLocalDetourCornerGuard(hits, edgeLen) {
					const maxClearance = Math.max(0, ...(hits || []).map(box => toNumber(box.clearanceMil, 0)));
					const guard = Math.max(
						LOCAL_DETOUR_MIN_INTERVAL * 2,
						MIN_AVOIDANCE_NECK_WIDTH,
						maxClearance * 0.5,
						LOCAL_DETOUR_CORNER_GUARD_MIN,
					);
					return Math.min(guard, edgeLen * 0.35);
				}

				function adjustLocalDetourIntervalEndpoints(tEnter, tExit, edgeLen, cornerGuard) {
					let adjustedEnter = tEnter;
					let adjustedExit = tExit;

					if (adjustedEnter < cornerGuard) {
						adjustedEnter = cornerGuard;
					}

					if (edgeLen - adjustedExit < cornerGuard) {
						adjustedExit = edgeLen - cornerGuard;
					}

					if (adjustedExit - adjustedEnter < LOCAL_DETOUR_MIN_INTERVAL) {
						return undefined;
					}

					return {
						tEnter: adjustedEnter,
						tExit: adjustedExit,
					};
				}

				function hasLocalDetourStartCornerSpike(prev, start, detourPoints, cornerGuard) {
					if (!Array.isArray(detourPoints) || detourPoints.length === 0) {
						return false;
					}

					const incoming = {
						x: start.x - prev.x,
						y: start.y - prev.y,
					};
					const incomingLength = vectorLength(incoming);
					if (incomingLength <= 0.001) {
						return false;
					}

					const firstOffsetPoint = detourPoints.find(point => distance(start, point) > LOCAL_DETOUR_MIN_INTERVAL);
					if (!firstOffsetPoint) {
						return false;
					}

					const outgoing = {
						x: firstOffsetPoint.x - start.x,
						y: firstOffsetPoint.y - start.y,
					};
					const outgoingLength = vectorLength(outgoing);
					if (outgoingLength <= 0.001) {
						return false;
					}

					const maxSpikeLength = Math.max(cornerGuard * 2.5, MIN_AVOIDANCE_NECK_WIDTH * 4);
					if (outgoingLength >= maxSpikeLength) {
						return false;
					}

					const minAngleCos = Math.cos(SHORT_BRIDGE_SPIKE_CORNER_ANGLE * Math.PI / 180);
					return dotProduct(incoming, outgoing) / (incomingLength * outgoingLength) < minAngleCos;
				}

				function isLocalSegmentDetourReasonable(start, end, detourPoints, obstacleBoxes) {
					if (!Array.isArray(detourPoints) || detourPoints.length === 0) {
						return false;
					}

					const directLength = distance(start, end);
					if (directLength <= 0.001) {
						return false;
					}

					const path = [start, ...detourPoints, end];
					if (hasAcuteDetourCorner(path) || hasSharpBoundaryCorner(path, SHORT_BRIDGE_SPIKE_CORNER_ANGLE)) {
						return false;
					}

					const maxClearance = Math.max(0, ...obstacleBoxes.map(box => toNumber(box.clearanceMil, 0)));
					const maxOffset = Math.max(...detourPoints.map(point => pointToSegmentDistance(point, start, end)));
					const maxAllowedOffset = Math.min(
						Math.max(maxClearance * 2.5, MIN_AVOIDANCE_NECK_WIDTH * 2),
						directLength * LOCAL_DETOUR_MAX_OFFSET_RATIO + maxClearance,
						directLength * MAX_DETOUR_OFFSET_RATIO,
					);
					if (maxOffset > maxAllowedOffset) {
						return false;
					}

					const detourLength = getPathLength(path);
					if (detourLength > directLength * MAX_DETOUR_LENGTH_RATIO + maxClearance * 2) {
						return false;
					}

					return true;
				}

				function buildLocalSegmentDetourForEdge(start, end, hits, signedArea, baseBoundary, edgeIndex, simpleBoxes) {
					if (!Array.isArray(hits) || hits.length === 0) {
						return undefined;
					}

					const edgeLen = distance(start, end);
					if (edgeLen <= 0.001) {
						return undefined;
					}

					const outward = getOutwardNormal(start, end, signedArea);
					const intervals = hits
						.map(box => getSegmentBoxOverlapInterval(start, end, box))
						.filter(Boolean);
					if (intervals.length === 0) {
						return undefined;
					}

					const mergedIntervals = mergeSegmentBoxOverlapIntervals(intervals);
					const detourPoints = [];
					const cornerGuard = getLocalDetourCornerGuard(hits, edgeLen);

					for (const interval of mergedIntervals) {
						if (!interval.mergedBox) {
							continue;
						}

						const adjusted = adjustLocalDetourIntervalEndpoints(
							interval.tEnter,
							interval.tExit,
							edgeLen,
							cornerGuard,
						);
						if (!adjusted) {
							continue;
						}

						const entry = interpolatePoint(start, end, adjusted.tEnter / edgeLen);
						const exit = interpolatePoint(start, end, adjusted.tExit / edgeLen);
						const entryOffset = getOutwardOffsetPointFromBox(entry, outward, interval.mergedBox);
						const exitOffset = getOutwardOffsetPointFromBox(exit, outward, interval.mergedBox);

						if (distance(entry, start) > LOCAL_DETOUR_MIN_INTERVAL) {
							pushDistinctBoundaryPoint(detourPoints, entry);
						}

						pushDistinctBoundaryPoint(detourPoints, entryOffset);
						pushDistinctBoundaryPoint(detourPoints, exitOffset);

						if (distance(exit, end) > LOCAL_DETOUR_MIN_INTERVAL) {
							pushDistinctBoundaryPoint(detourPoints, exit);
						}
					}

					if (detourPoints.length === 0) {
						return undefined;
					}

					const edgeCount = baseBoundary.length;
					const previousVertex = baseBoundary[(edgeIndex - 1 + edgeCount) % edgeCount];
					if (hasLocalDetourStartCornerSpike(previousVertex, start, detourPoints, cornerGuard)) {
						return undefined;
					}

					const candidateCorners = detourPoints;
					if (!isLocalDetourNeckWideEnough(
						baseBoundary,
						edgeIndex,
						candidateCorners,
						MIN_AVOIDANCE_NECK_WIDTH,
					)) {
						return undefined;
					}

					if (detourIntersectsOtherObstacle(
						start,
						end,
						candidateCorners,
						simpleBoxes,
						new Set(hits.map(box => box.key).filter(Boolean)),
					)) {
						return undefined;
					}

					if (!isLocalSegmentDetourReasonable(start, end, candidateCorners, hits)) {
						return undefined;
					}

					const avoidedKeys = [];
					for (const interval of mergedIntervals) {
						for (const box of interval.boxes) {
							if (box.key) {
								avoidedKeys.push(box.key);
							}
						}
					}

					return {
						points: candidateCorners,
						avoidedKeys,
					};
				}

				function applyLegacyCornerDetourForEdge(
					start,
					end,
					hits,
					signedArea,
					baseBoundary,
					edgeIndex,
					simpleBoxes,
					avoidedObstacleKeys,
					avoidedObstacles,
					unresolvedObstacles,
				) {
					const acceptedCorners = [];

					for (const box of hits) {
						const candidateSets = getAvoidanceCornerCandidates(start, end, box, signedArea);
						const corners = chooseBestDetourCandidate(
							baseBoundary,
							edgeIndex,
							box,
							candidateSets,
							acceptedCorners,
							simpleBoxes,
						);
						if (!corners) {
							unresolvedObstacles.push(summarizeBoundaryAvoidanceObstacle(box));
							continue;
						}

						for (const corner of corners) {
							acceptedCorners.push(corner);
						}

						avoidedObstacleKeys.add(box.key);
						avoidedObstacles.push(summarizeBoundaryAvoidanceObstacle(box));
					}

					return acceptedCorners;
				}

				function getAvoidanceCornerCandidates(start, end, box, signedArea) {
					const edge = normalizeVector({
						x: end.x - start.x,
						y: end.y - start.y,
					});
					if (vectorLength(edge) <= 0) {
						return [];
					}

					const inward = reverseVector(getOutwardNormal(start, end, signedArea));
					const candidates = [];
					if (Math.abs(inward.x) > 0.001) {
						const x = inward.x >= 0 ? box.maxX : box.minX;
						candidates.push(sortDetourCorners(start, edge, [
							{ x, y: box.minY },
							{ x, y: box.maxY },
						]));
					}

					if (Math.abs(inward.y) > 0.001) {
						const y = inward.y >= 0 ? box.maxY : box.minY;
						candidates.push(sortDetourCorners(start, edge, [
							{ x: box.minX, y },
							{ x: box.maxX, y },
						]));
					}

					return candidates;
				}

				function getDetourPathScore(start, end, detourPoints) {
					const path = [start, ...detourPoints, end];
					const maxOffset = Math.max(...detourPoints.map(point => pointToSegmentDistance(point, start, end)));
					return getPathLength(path) + maxOffset * 0.25;
				}

				function detourIntersectsOtherObstacle(start, end, detourPoints, boxes, currentKey) {
					const excludedKeys = currentKey instanceof Set
						? currentKey
						: new Set([currentKey].filter(Boolean));
					const detourSegments = makePathSegments([start, ...detourPoints, end]);
					for (const segment of detourSegments) {
						for (const box of boxes) {
							if (excludedKeys.has(box.key)) {
								continue;
							}

							if (segmentIntersectsBox(segment.start, segment.end, box)) {
								return true;
							}
						}
					}

					return false;
				}

				function chooseBestDetourCandidate(baseBoundary, edgeIndex, box, candidateSets, acceptedCorners, simpleBoxes) {
					const start = baseBoundary[edgeIndex];
					const end = baseBoundary[(edgeIndex + 1) % baseBoundary.length];
					let bestCandidate;
					let bestScore = Number.POSITIVE_INFINITY;

					for (const detourPoints of candidateSets) {
						const candidateCorners = acceptedCorners.concat(detourPoints);
						if (!isLocalDetourNeckWideEnough(
							baseBoundary,
							edgeIndex,
							candidateCorners,
							MIN_AVOIDANCE_NECK_WIDTH,
						)) {
							continue;
						}

						if (!isDetourPathReasonable(start, end, candidateCorners, simpleBoxes)) {
							continue;
						}

						if (detourIntersectsOtherObstacle(start, end, candidateCorners, simpleBoxes, box.key)) {
							continue;
						}

						const score = getDetourPathScore(start, end, candidateCorners);
						if (score < bestScore) {
							bestScore = score;
							bestCandidate = detourPoints;
						}
					}

					return bestCandidate;
				}

				function areBoundarySegmentsAdjacent(firstIndex, secondIndex, segmentCount) {
					const indexDistance = Math.abs(firstIndex - secondIndex);
					return indexDistance <= 1 || indexDistance === segmentCount - 1;
				}

				function polygonHasSelfIntersection(points) {
					const segments = makeBoundarySegments(points);
					for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
						for (let secondIndex = firstIndex + 1; secondIndex < segments.length; secondIndex += 1) {
							if (areBoundarySegmentsAdjacent(firstIndex, secondIndex, segments.length)) {
								continue;
							}

							if (segmentsIntersect(
								segments[firstIndex].start,
								segments[firstIndex].end,
								segments[secondIndex].start,
								segments[secondIndex].end,
							)) {
								return true;
							}
						}
					}

					return false;
				}

				function getNarrowBoundaryNeckDetails(points, minWidth) {
					const segments = makeBoundarySegments(points);
					let narrowCount = 0;
					let minDistance = Number.POSITIVE_INFINITY;
					let closestPair;
					const pairs = [];

					for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
						for (let secondIndex = firstIndex + 1; secondIndex < segments.length; secondIndex += 1) {
							if (areBoundarySegmentsAdjacent(firstIndex, secondIndex, segments.length)) {
								continue;
							}

							const width = segmentToSegmentDistance(
								segments[firstIndex].start,
								segments[firstIndex].end,
								segments[secondIndex].start,
								segments[secondIndex].end,
							);

							if (width < minDistance) {
								minDistance = width;
								closestPair = {
									first: segments[firstIndex],
									second: segments[secondIndex],
									width,
								};
							}

							if (width < minWidth) {
								narrowCount += 1;
								pairs.push({
									first: segments[firstIndex],
									second: segments[secondIndex],
									width,
								});
							}
						}
					}

					return {
						narrowCount,
						minWidth: Number.isFinite(minDistance) ? minDistance : undefined,
						closestPair,
						pairs,
					};
				}

				function hasNarrowBoundaryNeck(points, minWidth) {
					return getNarrowBoundaryNeckDetails(points, minWidth).narrowCount > 0;
				}

				function isBoundaryPathValid(points, targetKeepInContours = []) {
					return points.length >= 3
						&& !polygonHasSelfIntersection(points)
						&& !hasNarrowBoundaryNeck(points, MIN_AVOIDANCE_NECK_WIDTH)
						&& polygonCoversTargetContours(points, targetKeepInContours);
				}

				function isBoundaryPathValidIgnoringNeck(points, targetKeepInContours = []) {
					return points.length >= 3
						&& !polygonHasSelfIntersection(points)
						&& polygonCoversTargetContours(points, targetKeepInContours);
				}

				function getBoundaryPathInvalidReasons(points, targetKeepInContours = []) {
					const reasons = [];
					if (!Array.isArray(points) || points.length < 3) {
						reasons.push('too-few-points');
						return reasons;
					}

					if (polygonHasSelfIntersection(points)) {
						reasons.push('self-intersection');
					}

					const neckStats = getNarrowBoundaryNeckDetails(points, MIN_AVOIDANCE_NECK_WIDTH);
					if (neckStats.narrowCount > 0) {
						reasons.push('narrow-neck');
					}

					if (!polygonCoversTargetContours(points, targetKeepInContours)) {
						reasons.push('missing-target-coverage');
					}

					return reasons;
				}

				function isPostProcessedBoundaryValid(points, targetKeepInContours = []) {
					return points.length >= 3
						&& !polygonHasSelfIntersection(points)
						&& polygonCoversTargetContours(points, targetKeepInContours);
				}

				function isEdaPourPolygonCreatable(points) {
					if (!Array.isArray(points) || points.length < 3) {
						return false;
					}

					const ring = makeClipRingFromPoints(orientPolygonPoints(points, 1));
					return Boolean(ring.length >= 4 && makeEdaPolygonFromClipPolygon([ring]));
				}

				function getMultiPadPourBoundaryBlockingReasons(points, boundarySelection, targetKeepInContours = [], polygonData = {}) {
					const reasons = [];
					if (!Array.isArray(points) || points.length < 3) {
						reasons.push('too-few-points');
						return reasons;
					}

					for (const reason of getBoundaryPathInvalidReasons(points, targetKeepInContours)) {
						if (reason === 'missing-target-coverage'
							|| reason === 'self-intersection'
							|| reason === 'too-few-points') {
							reasons.push(reason);
						}
					}

					if (getHardBoundaryInvalidReasons(points).length > 0) {
						for (const reason of getHardBoundaryInvalidReasons(points)) {
							if (reasons.indexOf(reason) < 0) {
								reasons.push(reason);
							}
						}
					}

					if (!isEdaPourPolygonCreatable(points)) {
						reasons.push('eda-polygon-invalid');
					}

					if (boundarySelection && boundarySelection.multiPadConvexHullFallbackRejected) {
						const usedStructuredStrategy = Boolean(
							boundarySelection.multiPadBridgedBoundary
							|| boundarySelection.multiPadHybridBoundary
							|| boundarySelection.multiPadUnionBoundaryFallback
							|| boundarySelection.multiPadEdgeBoundaryRequired,
						);
						if (!usedStructuredStrategy) {
							reasons.push('structured-boundary-unavailable');
						}
					}

					if (boundarySelection && boundarySelection.multiPadUnionBoundaryFallback) {
						if (polygonData.boundaryAvoidanceMode === 'base-with-clip-fallback') {
							reasons.push('union-with-clip-fallback');
						}
					}

					return [...new Set(reasons)];
				}

				function assertMultiPadPourBoundaryReady(points, boundarySelection, targetKeepInContours = [], polygonData = {}) {
					const blockingReasons = getMultiPadPourBoundaryBlockingReasons(
						points,
						boundarySelection,
						targetKeepInContours,
						polygonData,
					);
					if (blockingReasons.length === 0) {
						return;
					}

					logWarn('Multi-pad pour boundary rejected before create:', {
						blockingReasons,
						pointCount: Array.isArray(points) ? points.length : 0,
						multiPadBoundaryStrategy: boundarySelection && boundarySelection.multiPadBoundaryStrategy,
						multiPadEnvelopeFailureReason: boundarySelection && boundarySelection.multiPadEnvelopeFailureReason,
						boundaryAvoidanceMode: polygonData.boundaryAvoidanceMode,
					});
					throw new Error(text(
						'No valid multi-pad boundary is available. Move nearby obstacles or change the target selection.',
					));
				}

				function summarizeBoundaryAvoidanceObstacle(box) {
					return {
						key: box.key,
						type: box.type,
						clearanceMil: roundCoordinate(toNumber(box.clearanceMil, 0)),
						relation: box.relation ? box.relation.type : 'unknown',
						hitEdgeIndexes: box.relation && Array.isArray(box.relation.hitEdges)
							? box.relation.hitEdges.map(edge => edge.index)
							: [],
						bounds: {
							minX: roundCoordinate(box.minX),
							minY: roundCoordinate(box.minY),
							maxX: roundCoordinate(box.maxX),
							maxY: roundCoordinate(box.maxY),
						},
					};
				}

				function isMultiPadBoundaryScenario(boundaryTargets, boundarySelection, shouldUseDynamicShape) {
					if (boundarySelection && boundarySelection.multiPadBridgedBoundary) {
						return true;
					}

					if (boundarySelection && boundarySelection.multiPadEdgeBoundaryRequired) {
						return true;
					}

					if (boundarySelection && boundarySelection.multiPadHybridBoundary) {
						return true;
					}

					return Array.isArray(boundaryTargets)
						&& boundaryTargets.length > 1
						&& !isTwoRectTargetSet(boundaryTargets, shouldUseDynamicShape);
				}

				function buildInflatedBoundaryObstacles(avoidanceObstacles, copperAreaObstacles, options = {}) {
					const includeCopperNodes = Boolean(options.includeCopperNodes);
					const targetKeys = options.targetKeys instanceof Set ? options.targetKeys : new Set();
					const combined = dedupeTargets(
						(avoidanceObstacles || [])
							.filter(obstacle => includeCopperNodes || !isCopperNodePrimitive(obstacle))
							.filter(obstacle => !targetKeys.has(getTargetKey(obstacle)))
							.concat(Array.isArray(copperAreaObstacles) ? copperAreaObstacles : []),
					);

					return combined.map(obstacle => inflateObstacle(obstacle)).filter(Boolean);
				}

				function collectSuccessfullyAvoidedObstacleKeys(avoidance, usedDirectShortBridgeFallback) {
					if (usedDirectShortBridgeFallback || !avoidance) {
						return [];
					}

					const keys = [];
					const seen = new Set();
					for (const obstacle of avoidance.avoidedObstacles || []) {
						if (obstacle && obstacle.key && !seen.has(obstacle.key)) {
							seen.add(obstacle.key);
							keys.push(obstacle.key);
						}
					}

					return keys;
				}

				function isInflatedCopperNodeBox(box) {
					return Boolean(box && (
						box.type === 'Pad'
						|| box.type === 'ComponentPad'
						|| box.type === 'Via'
					));
				}

				function appendUniqueBoundaryObstacleSummary(obstacleSummaries, box, seenKeys) {
					if (!box || !box.key || seenKeys.has(box.key)) {
						return;
					}

					seenKeys.add(box.key);
					obstacleSummaries.push(summarizeBoundaryAvoidanceObstacle(box));
				}

				function collectCopperNodeClipFallbackKeys(
					avoidanceObstacles,
					avoidance,
					boundaryAvoidanceMode,
					successfullyAvoidedObstacleKeys,
				) {
					const avoidedKeySet = new Set(successfullyAvoidedObstacleKeys || []);
					const fallbackKeys = new Set();
					const copperNodeTypes = new Set(['Pad', 'ComponentPad', 'Via']);

					for (const obstacleSummary of (avoidance && avoidance.unresolvedObstacles) || []) {
						if (obstacleSummary
							&& obstacleSummary.key
							&& copperNodeTypes.has(obstacleSummary.type)
							&& !avoidedKeySet.has(obstacleSummary.key)) {
							fallbackKeys.add(obstacleSummary.key);
						}
					}

					if (boundaryAvoidanceMode === 'base-with-clip-fallback') {
						for (const obstacle of avoidanceObstacles || []) {
							if (!isCopperNodePrimitive(obstacle)) {
								continue;
							}

							const key = getTargetKey(obstacle);
							if (!avoidedKeySet.has(key)) {
								fallbackKeys.add(key);
							}
						}
					}

					return [...fallbackKeys];
				}

				function resolveCopperNodeClipObstacles(avoidanceObstacles, polygonData, generationType) {
					const fallbackKeySet = new Set(polygonData.clipFallbackObstacleKeys || []);
					if (fallbackKeySet.size === 0) {
						return [];
					}

					// Fill always uses selective bool clip; pour uses the same fallback for unresolved Pad/Via.
					if (generationType !== 'fill' && generationType !== 'pour') {
						return [];
					}

					return avoidanceObstacles.filter((obstacle) => {
						if (!isCopperNodePrimitive(obstacle)) {
							return false;
						}

						return fallbackKeySet.has(getTargetKey(obstacle));
					});
				}

				function bendBoundaryAroundObstacles(baseBoundary, inflatedObstacles, options = {}) {
					const allowLegacyCopperDetour = Boolean(options.allowLegacyCopperDetour);
					if (baseBoundary.length < 3 || !Array.isArray(inflatedObstacles) || inflatedObstacles.length === 0) {
						return {
							points: baseBoundary,
							avoidedCount: 0,
							unresolvedCount: 0,
							avoidedObstacles: [],
							unresolvedObstacles: [],
						};
					}

					const signedArea = polygonSignedArea(baseBoundary);
					const edges = getBoundaryEdges(baseBoundary, signedArea);
					const classifiedBoxes = inflatedObstacles.map(box => ({
						...box,
						relation: classifyObstacleBoundaryRelation(box, baseBoundary, edges),
					}));
					const simpleBoxes = classifiedBoxes.filter(box => box.relation.type === 'single-edge');
					const bent = [];
					const avoidedObstacleKeys = new Set();
					const avoidedObstacles = [];
					const unresolvedObstacles = classifiedBoxes
						.filter(box => box.relation.type !== 'outside' && box.relation.type !== 'single-edge')
						.map(summarizeBoundaryAvoidanceObstacle);
					const unresolvedObstacleKeys = new Set(unresolvedObstacles.map(obstacle => obstacle.key));

					for (let index = 0; index < baseBoundary.length; index += 1) {
						const start = baseBoundary[index];
						const end = baseBoundary[(index + 1) % baseBoundary.length];
						const hits = simpleBoxes
							.filter(box => box.relation.hitEdges[0].index === index)
							.sort((first, second) => {
								const edge = normalizeVector({
									x: end.x - start.x,
									y: end.y - start.y,
								});
								return getObstacleProjection(start, edge, first) - getObstacleProjection(start, edge, second);
							});

						bent.push(start);

						if (hits.length === 0) {
							continue;
						}

						let edgeDetourPoints = [];
						const localDetour = buildLocalSegmentDetourForEdge(
							start,
							end,
							hits,
							signedArea,
							baseBoundary,
							index,
							simpleBoxes,
						);
						if (localDetour && localDetour.points.length > 0) {
							edgeDetourPoints = localDetour.points;
							for (const key of localDetour.avoidedKeys) {
								if (!key) {
									continue;
								}

								avoidedObstacleKeys.add(key);
								const hit = hits.find(box => box.key === key);
								if (hit) {
									avoidedObstacles.push(summarizeBoundaryAvoidanceObstacle(hit));
								}
							}
						}

						if (edgeDetourPoints.length === 0) {
							const copperHits = hits.filter(box => isInflatedCopperNodeBox(box));
							const nonCopperHits = hits.filter(box => !isInflatedCopperNodeBox(box));

							if (allowLegacyCopperDetour && copperHits.length > 0) {
								edgeDetourPoints = applyLegacyCornerDetourForEdge(
									start,
									end,
									hits,
									signedArea,
									baseBoundary,
									index,
									simpleBoxes,
									avoidedObstacleKeys,
									avoidedObstacles,
									unresolvedObstacles,
								);
							}
							else {
								for (const box of copperHits) {
									appendUniqueBoundaryObstacleSummary(unresolvedObstacles, box, unresolvedObstacleKeys);
								}

								if (nonCopperHits.length > 0) {
									edgeDetourPoints = applyLegacyCornerDetourForEdge(
										start,
										end,
										nonCopperHits,
										signedArea,
										baseBoundary,
										index,
										simpleBoxes,
										avoidedObstacleKeys,
										avoidedObstacles,
										unresolvedObstacles,
									);
								}
							}
						}

						for (const corner of edgeDetourPoints) {
							bent.push(corner);
						}
					}

					const cleaned = cleanBoundaryPoints(bent);
					const dedupedUnresolvedObstacles = [];
					const dedupedUnresolvedKeys = new Set();
					for (const obstacleSummary of unresolvedObstacles) {
						if (!obstacleSummary || !obstacleSummary.key || dedupedUnresolvedKeys.has(obstacleSummary.key)) {
							continue;
						}

						dedupedUnresolvedKeys.add(obstacleSummary.key);
						dedupedUnresolvedObstacles.push(obstacleSummary);
					}

					return {
						points: cleaned.length >= 3 ? cleaned : baseBoundary,
						avoidedCount: avoidedObstacleKeys.size,
						unresolvedCount: dedupedUnresolvedObstacles.length,
						avoidedObstacles,
						unresolvedObstacles: dedupedUnresolvedObstacles,
					};
				}

				function makeCleanPourPolygonData(targets, config, boundaryObstacles, avoidanceObstacles, traceObstacles = [], copperAreaObstacles = [], options = {}) {
					beginPadEdgeDiagnosticSession({
						targetCount: Array.isArray(targets) ? targets.length : 0,
						targets: summarizePadEdgeTargets(targets),
					});
					try {
						return makeCleanPourPolygonDataImpl(
							targets,
							config,
							boundaryObstacles,
							avoidanceObstacles,
							traceObstacles,
							copperAreaObstacles,
							options,
						);
					} finally {
						endPadEdgeDiagnosticSession();
					}
				}

				function makeCleanPourPolygonDataImpl(targets, config, boundaryObstacles, avoidanceObstacles, traceObstacles = [], copperAreaObstacles = [], options = {}) {
					const shouldUseDynamicShape = SHOULD_USE_DYNAMIC_SHAPE;
					const margin = calculatePourMargin(config);
					const edgeShieldObstacles = Array.isArray(options.edgeShieldObstacles) ? options.edgeShieldObstacles : [];
					const supportObstacles = dedupeTargets(boundaryObstacles.concat(
						avoidanceObstacles,
						copperAreaObstacles,
						edgeShieldObstacles,
					));
					let effectiveTargets = targets;
					let targetKeepInContours = makeTargetKeepInContours(effectiveTargets, margin, shouldUseDynamicShape, config);
					let boundaryTargets = effectiveTargets;
					let boundarySelection = {
						multiPadHybridForceBridge: Boolean(options.multiPadHybridForceBridge),
					};
					let requiresStrictEdgeBoundary = resolveRequiresStrictEdgeBoundary(
						boundaryTargets,
						shouldUseDynamicShape,
						boundarySelection,
					);
					let edgePairPasses = requiresStrictEdgeBoundary
						? selectBoundaryEdgePairPasses(
							boundaryTargets,
							margin,
							shouldUseDynamicShape,
							supportObstacles,
						)
						: [];
					let rawBoundaryPoints = makeOuterSupportBoundary(
						boundaryTargets,
						margin,
						shouldUseDynamicShape,
						supportObstacles,
						targetKeepInContours,
						edgePairPasses,
						boundarySelection,
					);
					if ((!Array.isArray(rawBoundaryPoints) || rawBoundaryPoints.length < 3)
						&& Array.isArray(boundaryTargets)
						&& boundaryTargets.length > 1) {
						rawBoundaryPoints = makeMultiPadAutoBoundary(
							boundaryTargets,
							margin,
							shouldUseDynamicShape,
							supportObstacles,
							targetKeepInContours,
							boundarySelection,
						);
					}
					let boundaryReducedExpansionCount = 0;
					requiresStrictEdgeBoundary = resolveRequiresStrictEdgeBoundary(
						boundaryTargets,
						shouldUseDynamicShape,
						boundarySelection,
					);
					let requiresMultiPadEdgeBoundary = Boolean(boundarySelection.multiPadEdgeBoundaryRequired);
					let requiresEdgeControlledBoundary = requiresStrictEdgeBoundary || requiresMultiPadEdgeBoundary;

					if (requiresStrictEdgeBoundary
						&& (!Array.isArray(rawBoundaryPoints) || rawBoundaryPoints.length < 3)
						&& margin > 0
						&& effectiveTargets.length === 2) {
						for (const reductionCandidate of makeTargetMarginReductionCandidates(effectiveTargets, margin)) {
							const candidateTargets = reductionCandidate.targets;
							const candidateKeepInContours = makeTargetKeepInContours(
								candidateTargets,
								margin,
								shouldUseDynamicShape,
								config,
							);
							const candidateBoundaryTargets = candidateTargets;
							const candidateBoundarySelection = {};
							const candidateRequiresStrictEdgeBoundary = resolveRequiresStrictEdgeBoundary(
								candidateBoundaryTargets,
								shouldUseDynamicShape,
								candidateBoundarySelection,
							);
							const candidateEdgePairPasses = candidateRequiresStrictEdgeBoundary
								? selectBoundaryEdgePairPasses(
									candidateBoundaryTargets,
									margin,
									shouldUseDynamicShape,
									supportObstacles,
								)
								: [];
							const candidateRawBoundaryPoints = makeOuterSupportBoundary(
								candidateBoundaryTargets,
								margin,
								shouldUseDynamicShape,
								supportObstacles,
								candidateKeepInContours,
								candidateEdgePairPasses,
								candidateBoundarySelection,
							);
							const candidateBoundaryPoints = cleanBoundaryPoints(
								Array.isArray(candidateRawBoundaryPoints) ? candidateRawBoundaryPoints : [],
							);
							if (!isBoundaryPathValid(candidateBoundaryPoints, candidateKeepInContours)) {
								continue;
							}

							effectiveTargets = candidateTargets;
							targetKeepInContours = candidateKeepInContours;
							boundaryTargets = candidateBoundaryTargets;
							requiresStrictEdgeBoundary = resolveRequiresStrictEdgeBoundary(
								candidateBoundaryTargets,
								shouldUseDynamicShape,
								candidateBoundarySelection,
							);
							edgePairPasses = candidateEdgePairPasses;
							boundarySelection = candidateBoundarySelection;
							rawBoundaryPoints = candidateRawBoundaryPoints;
							boundaryReducedExpansionCount = reductionCandidate.reducedCount;
							reportPadEdgeDiagnostic('Pad edge boundary reduced target expansion', {
								reducedCount: boundaryReducedExpansionCount,
								margin: roundCoordinate(margin),
							});
							break;
						}
					}

					if (requiresStrictEdgeBoundary
						&& (!Array.isArray(rawBoundaryPoints) || rawBoundaryPoints.length < 3)) {
						throw new Error(text(
							'No unblocked boundary edge pair is available. Move nearby obstacles or change the target selection.',
						));
					}

					requiresStrictEdgeBoundary = resolveRequiresStrictEdgeBoundary(
						boundaryTargets,
						shouldUseDynamicShape,
						boundarySelection,
					);
					requiresMultiPadEdgeBoundary = Boolean(boundarySelection.multiPadEdgeBoundaryRequired);
					requiresEdgeControlledBoundary = requiresStrictEdgeBoundary || requiresMultiPadEdgeBoundary;

					reportPadEdgeDiagnostic('Pad edge polygon generation start', {
						targets: summarizePadEdgeTargets(effectiveTargets),
						boundaryTargets: summarizePadEdgeTargets(boundaryTargets),
						requiresStrictEdgeBoundary,
						twoTargetEdgeBoundary: Boolean(boundarySelection.twoTargetEdgeBoundary),
						requiresMultiPadEdgeBoundary,
						multiPadLayoutClass: boundarySelection.multiPadLayoutClass,
						multiPadBoundaryStrategyRequested: boundarySelection.multiPadBoundaryStrategyRequested,
						multiPadBoundaryStrategy: boundarySelection.multiPadBoundaryStrategy,
						multiPadHybridBoundaryMode: boundarySelection.multiPadHybridBoundaryMode,
						multiPadHybridDegradationReasons: boundarySelection.multiPadHybridDegradationReasons,
						multiPadHybridCandidateSummary: boundarySelection.multiPadHybridCandidateSummary,
						multiPadEnvelopeFailureReason: boundarySelection.multiPadEnvelopeFailureReason,
						margin: roundCoordinate(margin),
						boundaryObstacleCount: Array.isArray(boundaryObstacles) ? boundaryObstacles.length : 0,
						avoidanceObstacleCount: Array.isArray(avoidanceObstacles) ? avoidanceObstacles.length : 0,
						traceObstacleCount: Array.isArray(traceObstacles) ? traceObstacles.length : 0,
						copperAreaObstacleCount: Array.isArray(copperAreaObstacles) ? copperAreaObstacles.length : 0,
						edgeShieldObstacleCount: edgeShieldObstacles.length,
						supportObstacleCount: supportObstacles.length,
						targetKeepInContourCount: targetKeepInContours.length,
						edgePairCount: edgePairPasses.reduce((count, pass) => count + pass.edgePairs.length, 0),
						boundaryReducedExpansionCount,
						selectedEdgePair: boundarySelection.edgePair,
						multiPadEdgeFilter: boundarySelection.multiPadEdgeFilter,
						selectedBridgeSpan: Number.isFinite(boundarySelection.bridgeSpan)
							? roundCoordinate(boundarySelection.bridgeSpan)
							: undefined,
						twoTargetBlockedEdgeCount: boundarySelection.twoTargetBlockedEdgeCount,
						twoTargetForeignNodeOverlap: boundarySelection.twoTargetForeignNodeOverlap,
					});
					let boundaryPoints = cleanBoundaryPoints(Array.isArray(rawBoundaryPoints) ? rawBoundaryPoints : []);
					if (requiresStrictEdgeBoundary && boundaryPoints.length < 3) {
						throw new Error(text(
							'No unblocked boundary edge pair is available. Move nearby obstacles or change the target selection.',
						));
					}
					const validationTargetKeepInContours = targetKeepInContours;
					const postProcessCoverageContours = makePostProcessCoverageContours(
						validationTargetKeepInContours,
						config,
					);
					const allowCoverageFallback = !requiresEdgeControlledBoundary;
					reportPadEdgeDiagnostic('Pad edge boundary source selected', {
						edgeSelectionApplied: requiresEdgeControlledBoundary,
						twoTargetEdgeBoundary: Boolean(boundarySelection.twoTargetEdgeBoundary),
						requiresMultiPadEdgeBoundary,
						targetKeepInContourCount: targetKeepInContours.length,
						routingCoverageValidationContourCount: validationTargetKeepInContours.length,
						coverageValidationContourCount: postProcessCoverageContours.length,
						postProcessCoverageContourCount: postProcessCoverageContours.length,
						rawBoundaryPointCount: Array.isArray(rawBoundaryPoints) ? rawBoundaryPoints.length : 0,
						boundaryPointCount: boundaryPoints.length,
						selectedEdgePair: boundarySelection.edgePair,
						multiPadEdgeFilter: boundarySelection.multiPadEdgeFilter,
						selectedBridgeSpan: Number.isFinite(boundarySelection.bridgeSpan)
							? roundCoordinate(boundarySelection.bridgeSpan)
							: undefined,
						twoTargetBlockedEdgeCount: boundarySelection.twoTargetBlockedEdgeCount,
					});
					const fallbackBoundaryPoints = (() => {
						if (requiresEdgeControlledBoundary) {
							return boundaryPoints;
						}

						if (boundarySelection.multiPadConvexHullFallbackRejected
							&& Array.isArray(boundaryTargets)
							&& boundaryTargets.length > 1) {
							const structuredBoundary = makeMultiPadAutoBoundary(
								boundaryTargets,
								margin,
								shouldUseDynamicShape,
								supportObstacles,
								targetKeepInContours,
								boundarySelection,
							);
							if (Array.isArray(structuredBoundary) && structuredBoundary.length >= 3) {
								return structuredBoundary;
							}

							return boundaryPoints;
						}

						return makeFallbackTargetBoundaryPoints(effectiveTargets, margin, shouldUseDynamicShape);
					})();
					const basePoints = ensureBoundaryCoversTargetContours(
						boundaryPoints.length >= 3 ? boundaryPoints : fallbackBoundaryPoints,
						validationTargetKeepInContours,
						{ allowFallback: allowCoverageFallback },
					);
					const isMultiPadScenario = isMultiPadBoundaryScenario(
						boundaryTargets,
						boundarySelection,
						shouldUseDynamicShape,
					);
					const includeCopperNodesForBoundaryAvoidance = isMultiPadScenario || requiresStrictEdgeBoundary;
					const targetKeySet = new Set(effectiveTargets.map(target => getTargetKey(target)));
					const inflatedObstacles = buildInflatedBoundaryObstacles(
						avoidanceObstacles,
						copperAreaObstacles,
						{
							includeCopperNodes: includeCopperNodesForBoundaryAvoidance,
							targetKeys: targetKeySet,
						},
					);
					reportPadEdgeDiagnostic('Boundary detour obstacle set', {
						isMultiPadScenario,
						requiresStrictEdgeBoundary,
						includeCopperNodes: includeCopperNodesForBoundaryAvoidance,
						inflatedObstacleCount: inflatedObstacles.length,
					});
					const usesStructuredMultiPadBoundary = Boolean(
						boundarySelection.multiPadBridgedBoundary
						|| boundarySelection.multiPadHybridBoundary
						|| boundarySelection.multiPadUnionBoundaryFallback
						|| boundarySelection.multiPadEdgeBoundaryRequired,
					);
					const preservesPairwiseBridgeBoundary = Boolean(boundarySelection.multiPadBridgedBoundary);
					const avoidance = preservesPairwiseBridgeBoundary
						? {
							points: basePoints,
							avoidedCount: 0,
							unresolvedCount: 0,
							avoidedObstacles: [],
							unresolvedObstacles: [],
						}
						: bendBoundaryAroundObstacles(basePoints, inflatedObstacles, {
							allowLegacyCopperDetour: usesStructuredMultiPadBoundary,
						});
					if (preservesPairwiseBridgeBoundary) {
						reportPadEdgeDiagnostic('Multi-pad pairwise bridge boundary preserved', {
							basePointCount: basePoints.length,
							inflatedObstacleCount: inflatedObstacles.length,
							bridgedPairCount: boundarySelection.bridgedPairCount,
						});
					}
					const rawAvoidedPoints = cleanBoundaryPoints(avoidance.points);
					const finalBridgeSpan = requiresEdgeControlledBoundary
						? toNumber(boundarySelection.bridgeSpan, Number.POSITIVE_INFINITY)
						: (isCloseTwoRectTargetSet(boundaryTargets)
							? getTargetGapDistance(boundaryTargets[0], boundaryTargets[1])
							: Number.POSITIVE_INFINITY);
					const bridgeSpanSource = requiresMultiPadEdgeBoundary
						? 'multi-pad-constrained-envelope'
						: (requiresEdgeControlledBoundary ? 'selected-edge-pair' : 'target-gap');
					const usedDirectShortBridgeFallback = shouldUseDirectShortBridgeFallback(
						basePoints,
						rawAvoidedPoints,
						avoidance,
						validationTargetKeepInContours,
						finalBridgeSpan,
					);
					const genericFallbackDetourRejected = !usedDirectShortBridgeFallback
						&& shouldRejectGenericFallbackDetour(basePoints, rawAvoidedPoints, avoidance);
					const canTryExpansionReduction = genericFallbackDetourRejected
						&& options.allowGenericFallbackExpansionReduction !== false
						&& margin > 0
						&& (requiresMultiPadEdgeBoundary
							|| (targets.length === 2 && isTwoRectTargetSet(boundaryTargets, shouldUseDynamicShape)));
					if (canTryExpansionReduction) {
						for (const reductionCandidate of makeTargetMarginReductionCandidates(effectiveTargets, margin)) {
							const reducedPolygonData = makeCleanPourPolygonData(
								reductionCandidate.targets,
								config,
								boundaryObstacles,
								avoidanceObstacles,
								traceObstacles,
								copperAreaObstacles,
								{
									allowGenericFallbackExpansionReduction: false,
									edgeShieldObstacles,
									multiPadHybridForceBridge: Boolean(options.multiPadHybridForceBridge),
									allowMultiPadHybridBridgeRetry: options.allowMultiPadHybridBridgeRetry,
								},
							);
							if (reducedPolygonData.genericFallbackDetourRejected) {
								continue;
							}

							reportPadEdgeDiagnostic('Pad edge generic fallback reduced target expansion', {
								reducedCount: reductionCandidate.reducedCount,
								margin: roundCoordinate(margin),
								isMultiPadScenario,
							});
							return {
								...reducedPolygonData,
								boundaryReducedExpansionCount: (reducedPolygonData.boundaryReducedExpansionCount || 0)
									+ boundaryReducedExpansionCount
									+ reductionCandidate.reducedCount,
							};
						}

						if (requiresStrictEdgeBoundary
							&& !requiresMultiPadEdgeBoundary
							&& targets.length === 2
							&& isTwoRectTargetSet(boundaryTargets, shouldUseDynamicShape)) {
							throw new Error(text('Unable to create a clean boundary without reducing expansion. Reduce the expansion or move nearby obstacles.'));
						}
					}
					const avoidedPoints = usedDirectShortBridgeFallback ? basePoints : rawAvoidedPoints;
					const effectiveAvoidedCount = usedDirectShortBridgeFallback ? 0 : avoidance.avoidedCount;
					const effectiveUnresolvedCount = usedDirectShortBridgeFallback
						? avoidance.unresolvedCount + avoidance.avoidedCount
						: avoidance.unresolvedCount;
					const detourInvalidReasons = getBoundaryPathInvalidReasons(
						avoidedPoints,
						validationTargetKeepInContours,
					);
					let boundaryAvoidanceMode = preservesPairwiseBridgeBoundary
						? 'pairwise-bridge-preserved'
						: 'detour';
					let selectedBoundaryPoints = avoidedPoints;
					if (!isBoundaryPathValid(avoidedPoints, validationTargetKeepInContours)) {
						const canRetryHybridBridge = Boolean(
							boundarySelection.multiPadHybridBoundary
							&& boundarySelection.multiPadBoundaryStrategy === 'envelope'
							&& !options.multiPadHybridForceBridge
							&& options.allowMultiPadHybridBridgeRetry !== false,
						);
						if (canRetryHybridBridge) {
							try {
								const bridgedPolygonData = makeCleanPourPolygonDataImpl(
									targets,
									config,
									boundaryObstacles,
									avoidanceObstacles,
									traceObstacles,
									copperAreaObstacles,
									{
										...options,
										multiPadHybridForceBridge: true,
										allowMultiPadHybridBridgeRetry: false,
									},
								);
								if (bridgedPolygonData
									&& Array.isArray(bridgedPolygonData.points)
									&& bridgedPolygonData.boundaryAvoidanceMode !== 'base-with-clip-fallback'
									&& isBoundaryPathValid(
										bridgedPolygonData.points,
										getCoverageValidationContours(bridgedPolygonData),
									)) {
									reportPadEdgeDiagnostic('Multi-pad hybrid post-detour bridge degradation selected', {
										detourInvalidReasons,
										originalMode: boundarySelection.multiPadHybridBoundaryMode,
										forcedStrategy: 'bridge',
										pointCount: bridgedPolygonData.points.length,
									});
									bridgedPolygonData.multiPadHybridPostDetourDegraded = true;
									return bridgedPolygonData;
								}
							}
							catch (error) {
								logWarn('Multi-pad hybrid bridge degradation retry failed:', error);
							}
						}
						boundaryAvoidanceMode = 'base-with-clip-fallback';
						selectedBoundaryPoints = basePoints;
						reportPadEdgeDiagnostic('Boundary detour rejected', {
							reasons: detourInvalidReasons,
							isMultiPadScenario,
							requiresMultiPadEdgeBoundary,
							avoidedCount: effectiveAvoidedCount,
							unresolvedCount: effectiveUnresolvedCount,
						});
					}
					else if (boundaryReducedExpansionCount > 0) {
						boundaryAvoidanceMode = preservesPairwiseBridgeBoundary
							? 'pairwise-bridge-preserved-with-reduced-expansion'
							: 'detour-with-reduced-expansion';
					}

					const successfullyAvoidedObstacleKeys = collectSuccessfullyAvoidedObstacleKeys(
						avoidance,
						usedDirectShortBridgeFallback,
					);
					const clipFallbackObstacleKeySet = new Set(collectCopperNodeClipFallbackKeys(
						avoidanceObstacles,
						avoidance,
						boundaryAvoidanceMode,
						successfullyAvoidedObstacleKeys,
					));
					const multiPadDetour = isMultiPadScenario
						? {
							layoutClass: boundarySelection.multiPadLayoutClass,
							strategyRequested: boundarySelection.multiPadBoundaryStrategyRequested,
							strategy: boundarySelection.multiPadBoundaryStrategy,
							envelopeFailureReason: boundarySelection.multiPadEnvelopeFailureReason,
							bridgedBoundary: Boolean(boundarySelection.multiPadBridgedBoundary),
							hybridBoundary: Boolean(boundarySelection.multiPadHybridBoundary),
							hybridBoundaryMode: boundarySelection.multiPadHybridBoundaryMode,
							hybridDegradationReasons: boundarySelection.multiPadHybridDegradationReasons,
							unionBoundaryFallback: Boolean(boundarySelection.multiPadUnionBoundaryFallback),
							convexHullFallbackRejected: Boolean(boundarySelection.multiPadConvexHullFallbackRejected),
							edgeFilterPartial: Boolean(boundarySelection.multiPadEdgeFilterPartial),
						}
						: undefined;
					const safeAvoidedPoints = selectedBoundaryPoints;
					const postProcessing = applyPourPolygonPostProcessing(safeAvoidedPoints, config);
					const processedPoints = postProcessing.processedPoints;
					const postProcessBoundaryValid = isPostProcessedBoundaryValid(
						processedPoints,
						postProcessCoverageContours,
					);
					const chamferRequested = Boolean(config.enableChamfer && getChamferWidth(config) > 0);
					const chamferOutputChanged = chamferRequested && !polygonPointKeysMatch(
						processedPoints,
						postProcessing.manufacturingOptimizedPoints,
					);
					const chamferApplied = chamferOutputChanged && postProcessBoundaryValid;
					const finalCoverageValidationContours = chamferApplied
						? postProcessCoverageContours
						: validationTargetKeepInContours;
					const points = postProcessBoundaryValid
						? processedPoints
						: cleanBoundaryPoints(safeAvoidedPoints);
					const coveredPoints = ensureBoundaryCoversTargetContours(
						points,
						finalCoverageValidationContours,
						{ allowFallback: allowCoverageFallback },
					);
					const finalForeignNodeOverlap = getForeignCopperNodeOverlapSummary(
						coveredPoints,
						supportObstacles,
						targetKeySet,
						shouldUseDynamicShape,
					);
					const finalForeignNodeClearanceOverlap = getForeignCopperNodeOverlapSummary(
						coveredPoints,
						avoidanceObstacles,
						targetKeySet,
						shouldUseDynamicShape,
						{ useClearance: true },
					);
					const clippableCopperNodeKeys = new Set(
						(Array.isArray(avoidanceObstacles) ? avoidanceObstacles : [])
							.filter(isCopperNodePrimitive)
							.map(getTargetKey),
					);
					const unclippableForeignNodeOverlap = finalForeignNodeOverlap.overlappingNodes
						.filter(node => !clippableCopperNodeKeys.has(node.key));
					for (const node of finalForeignNodeOverlap.overlappingNodes) {
						if (clippableCopperNodeKeys.has(node.key)) {
							clipFallbackObstacleKeySet.add(node.key);
						}
					}
					for (const node of finalForeignNodeClearanceOverlap.overlappingNodes) {
						if (clippableCopperNodeKeys.has(node.key)) {
							clipFallbackObstacleKeySet.add(node.key);
						}
					}

					if (requiresEdgeControlledBoundary && unclippableForeignNodeOverlap.length > 0) {
						reportPadEdgeDiagnostic('Pad edge boundary rejected by foreign copper node overlap', {
							overlap: {
								...finalForeignNodeOverlap,
								overlappingNodes: unclippableForeignNodeOverlap,
							},
						});
						throw new Error(text(
							'No clean boundary is available without covering a nearby pad or via. Move nearby obstacles or change the target selection.',
						));
					}

					const clipFallbackObstacleKeys = [...clipFallbackObstacleKeySet];
					const polygonSource = makePolygonSourceFromPoints(coveredPoints);
					reportPadEdgeDiagnostic('Pad edge polygon generation result', {
						edgeSelectionApplied: requiresEdgeControlledBoundary,
						twoTargetEdgeBoundary: Boolean(boundarySelection.twoTargetEdgeBoundary),
						basePointCount: basePoints.length,
						avoidedPointCount: avoidedPoints.length,
						rawAvoidedPointCount: rawAvoidedPoints.length,
						safeAvoidedPointCount: safeAvoidedPoints.length,
						processedPointCount: processedPoints.length,
						finalPointCount: points.length,
						coveredPointCount: coveredPoints.length,
						polygonSourceLength: polygonSource.length,
						chamferRequested,
						chamferOutputChanged,
						chamferApplied,
						avoidance: {
							avoidedCount: effectiveAvoidedCount,
							unresolvedCount: effectiveUnresolvedCount,
						},
						shortBridgeFallback: {
							usedDirect: usedDirectShortBridgeFallback,
							bridgeSpan: Number.isFinite(finalBridgeSpan) ? roundCoordinate(finalBridgeSpan) : undefined,
							bridgeSpanSource,
						},
						genericFallbackDetourRejected,
						boundaryAvoidanceMode,
						successfullyAvoidedObstacleKeys,
						clipFallbackObstacleKeys,
						finalForeignNodeOverlap,
						finalForeignNodeClearanceOverlap,
						unclippableForeignNodeOverlap,
						detourInvalidReasons,
						avoidedInvalidReasons: detourInvalidReasons,
						coveredInvalidReasons: getBoundaryPathInvalidReasons(coveredPoints, finalCoverageValidationContours),
						routingCoverageInvalidReasons: getBoundaryPathInvalidReasons(coveredPoints, validationTargetKeepInContours),
						targetCoverageInvalidReasons: getBoundaryPathInvalidReasons(coveredPoints, finalCoverageValidationContours),
						multiPadEdgeFilter: boundarySelection.multiPadEdgeFilter,
						multiPadDetour,
					});

					const polygonData = {
						points: coveredPoints,
						polygonSource,
						targetKeepInContours,
						coverageValidationContours: finalCoverageValidationContours,
						chamferApplied,
						avoidedCount: effectiveAvoidedCount,
						unresolvedCount: effectiveUnresolvedCount,
						edgeSelectionApplied: requiresEdgeControlledBoundary,
						twoTargetEdgeBoundary: Boolean(boundarySelection.twoTargetEdgeBoundary),
						twoTargetBlockedEdgeCount: boundarySelection.twoTargetBlockedEdgeCount,
						multiPadEdgeFilteringApplied: Boolean(boundarySelection.multiPadEdgeFilter),
						multiPadBoundaryStrategy: boundarySelection.multiPadBoundaryStrategy,
						multiPadBoundaryStrategyRequested: boundarySelection.multiPadBoundaryStrategyRequested,
						multiPadHybridBoundary: Boolean(boundarySelection.multiPadHybridBoundary),
						multiPadHybridBoundaryMode: boundarySelection.multiPadHybridBoundaryMode,
						multiPadHybridDegradationReasons: boundarySelection.multiPadHybridDegradationReasons,
						multiPadEnvelopeFailureReason: boundarySelection.multiPadEnvelopeFailureReason,
						multiPadBridgedBoundary: Boolean(boundarySelection.multiPadBridgedBoundary),
						boundaryReducedExpansionCount,
						genericFallbackDetourRejected,
						boundaryAvoidanceMode,
						successfullyAvoidedObstacleKeys,
						clipFallbackObstacleKeys,
						finalForeignNodeOverlap,
						finalForeignNodeClearanceOverlap,
						unclippableForeignNodeOverlap,
						detourRejectedReasons: boundaryAvoidanceMode === 'base-with-clip-fallback'
							? detourInvalidReasons
							: [],
						isMultiPadScenario,
					};

					if (isMultiPadScenario) {
						assertMultiPadPourBoundaryReady(
							coveredPoints,
							boundarySelection,
							finalCoverageValidationContours,
							polygonData,
						);
					}

					return polygonData;
				}

				function makeTraceForbiddenSources(traceObstacles, orientation = 1) {
					return makeTraceForbiddenSourceRecords(traceObstacles, orientation)
						.map(record => record.source);
				}

				function makeForbiddenSourceRecord(source, obstacle, kind) {
					return source.length >= 3
						? {
								source,
								obstacle,
								kind,
								key: getTargetKey(obstacle),
							}
						: undefined;
				}

				function makeTraceForbiddenSourceRecords(traceObstacles, orientation = 1) {
					return traceObstacles
						.map((trace) => {
							const clearance = getObstacleClearanceMil(trace);
							const points = makeTraceCapsulePoints(trace, clearance);
							const source = points.length >= 3 ? makeOrientedPolygonSource(points, orientation) : [];
							return makeForbiddenSourceRecord(source, trace, 'trace');
						})
						.filter(Boolean);
				}

				function makeCopperNodeForbiddenSourceRecords(copperNodeObstacles, orientation = 1) {
					return copperNodeObstacles
						.filter(isCopperNodePrimitive)
						.flatMap((obstacle) => {
							const contours = makeCopperNodeClearanceContours(obstacle);
							return contours.map((points) => {
								const source = points.length >= 3 ? makeOrientedPolygonSource(points, orientation) : [];
								return makeForbiddenSourceRecord(source, obstacle, 'copper-node');
							});
						})
						.filter(Boolean);
				}

				function getCopperAreaClearanceRadius(obstacle) {
					return getObstacleClearanceMil(obstacle);
				}

				function makeCopperAreaForbiddenSourceRecords(copperAreaObstacles, orientation = 1) {
					const offsetRings = getPolygonClippingOffsetRings();
					if (!offsetRings) {
						return {
							records: [],
							error: 'polygon offset library is unavailable',
						};
					}

					const records = [];
					for (const obstacle of copperAreaObstacles) {
						const rings = makeClipRingsFromPolygonSource(obstacle.polygonSource);
						if (rings.length === 0) {
							return {
								records: [],
								error: `Copper area obstacle ${obstacle.primitiveId || '(no ID)'} has no valid clip ring`,
							};
						}

						const expandedRings = offsetRings(rings, getCopperAreaClearanceRadius(obstacle));
						if (!Array.isArray(expandedRings) || expandedRings.length === 0) {
							return {
								records: [],
								error: `Copper area obstacle ${obstacle.primitiveId || '(no ID)'} produced no clearance rings`,
							};
						}
						for (const ring of expandedRings) {
							const points = makePointsFromClipRing(ring);
							const source = points.length >= 3 ? makeOrientedPolygonSource(points, orientation) : [];
							const record = makeForbiddenSourceRecord(source, obstacle, 'copper-area');
							if (!record)
								return {
									records: [],
									error: `Copper area obstacle ${obstacle.primitiveId || '(no ID)'} produced an invalid clearance ring`,
								};
							records.push(record);
						}
					}

					return {
						records,
						error: '',
					};
				}

				function getForbiddenRecordObstacles(records, kind) {
					const seen = new Set();
					const obstacles = [];

					for (const record of records) {
						if (kind && record.kind !== kind) {
							continue;
						}

						if (seen.has(record.key)) {
							continue;
						}

						seen.add(record.key);
						obstacles.push(record.obstacle);
					}

					return obstacles;
				}

				function polygonsOverlap(first, second) {
					if (!Array.isArray(first) || !Array.isArray(second) || first.length < 3 || second.length < 3) {
						return false;
					}

					const firstSegments = makeBoundarySegments(first);
					const secondSegments = makeBoundarySegments(second);
					for (const firstSegment of firstSegments) {
						for (const secondSegment of secondSegments) {
							if (segmentsIntersect(
								firstSegment.start,
								firstSegment.end,
								secondSegment.start,
								secondSegment.end,
							)) {
								return true;
							}
						}
					}

					return pointInPolygon(first[0], second) || pointInPolygon(second[0], first);
				}

				function traceClearanceOverlapsPolygon(trace, polygon) {
					const clearance = getObstacleClearanceMil(trace);
					const points = makeTraceCapsulePoints(trace, clearance);
					return polygonsOverlap(points, polygon);
				}

				function forbiddenRecordOverlapsPolygon(record, polygon) {
					return polygonsOverlap(makePointsFromPolygonSource(record.source), polygon);
				}

				function getPolygonClippingDifference() {
					return clipping && typeof clipping.difference === 'function'
						? clipping.difference
						: undefined;
				}

				function getPolygonClippingUnion() {
					return clipping && typeof clipping.union === 'function'
						? clipping.union
						: undefined;
				}

				function getPolygonClippingOffsetRings() {
					return clipping && typeof clipping.offsetRings === 'function'
						? clipping.offsetRings
						: undefined;
				}

				function makeClipRingFromPoints(points) {
					const cleaned = cleanBoundaryPoints(points);
					if (cleaned.length < 3) {
						return [];
					}

					const ring = cleaned.map(point => [
						roundCoordinate(point.x),
						roundCoordinate(point.y),
					]);
					const first = ring[0];
					const last = ring[ring.length - 1];
					if (Math.abs(first[0] - last[0]) > 0.001 || Math.abs(first[1] - last[1]) > 0.001) {
						ring.push([first[0], first[1]]);
					}

					return ring;
				}

				function makeClipRingFromPolygonSource(source) {
					return makeClipRingFromPoints(makePointsFromPolygonSource(source));
				}

				function makeClipRingsFromPolygonSource(source) {
					return getPolygonSourceParts(source)
						.map(makePointsFromFlatPolygonSource)
						.map(makeClipRingFromPoints)
						.filter(ring => ring.length >= 4);
				}

				function makePointsFromClipRing(ring) {
					if (!Array.isArray(ring)) {
						return [];
					}

					const points = [];
					for (const coordinate of ring) {
						if (!Array.isArray(coordinate) || coordinate.length < 2) {
							continue;
						}

						const x = Number(coordinate[0]);
						const y = Number(coordinate[1]);
						if (Number.isFinite(x) && Number.isFinite(y)) {
							points.push({ x, y });
						}
					}

					if (points.length > 1 && distance(points[0], points[points.length - 1]) <= 0.001) {
						points.pop();
					}

					return cleanBoundaryPoints(points);
				}

				function makeClipGeometriesFromContours(contours = []) {
					return contours
						.map(makeClipRingFromPoints)
						.filter(ring => ring.length >= 4)
						.map(ring => [[ring]]);
				}

				function flattenValidClipGeometry(geometry) {
					if (!Array.isArray(geometry)) {
						return [];
					}

					return geometry.filter(polygon => Array.isArray(polygon)
						&& polygon.length > 0
						&& Array.isArray(polygon[0])
						&& polygon[0].length >= 4);
				}

				function makeEffectiveForbiddenGeometries(forbiddenSources, protectedContours, difference) {
					const protectedGeometries = makeClipGeometriesFromContours(protectedContours);
					const effectiveGeometries = [];

					for (const source of forbiddenSources) {
						const ring = makeClipRingFromPolygonSource(source);
						if (ring.length < 4) {
							continue;
						}

						if (protectedGeometries.length === 0) {
							effectiveGeometries.push([[ring]]);
							continue;
						}

						const clippedForbidden = difference([[ring]], ...protectedGeometries);
						for (const polygon of flattenValidClipGeometry(clippedForbidden)) {
							effectiveGeometries.push(polygon);
						}
					}

					return {
						effectiveGeometries,
						protectedGeometryCount: protectedGeometries.length,
					};
				}

				function countCoveredTargetContours(polygonPointsList, targetKeepInContours = []) {
					let coveredCount = 0;
					for (const contour of targetKeepInContours) {
						if (polygonPointsList.some(points => polygonCoversContour(points, contour))) {
							coveredCount += 1;
						}
					}

					return coveredCount;
				}

				function getCoverageValidationContours(polygonData) {
					if (polygonData && Array.isArray(polygonData.coverageValidationContours)) {
						return polygonData.coverageValidationContours;
					}

					return polygonData && Array.isArray(polygonData.targetKeepInContours)
						? polygonData.targetKeepInContours
						: [];
				}

				function translatePoint(point, unit, amount) {
					return {
						x: point.x + unit.x * amount,
						y: point.y + unit.y * amount,
					};
				}

				function getTraceSegmentPoints(trace) {
					return {
						start: {
							x: toNumber(trace.startX, trace.x),
							y: toNumber(trace.startY, trace.y),
						},
						end: {
							x: toNumber(trace.endX, trace.x),
							y: toNumber(trace.endY, trace.y),
						},
					};
				}

				function getSegmentMidpoint(segment) {
					return {
						x: (segment.start.x + segment.end.x) / 2,
						y: (segment.start.y + segment.end.y) / 2,
					};
				}

				function getTraceClearanceDistanceToSegment(segment, trace) {
					const { start, end } = getTraceSegmentPoints(trace);
					const radius = getTraceClearanceRadius(trace, getObstacleClearanceMil(trace));
					return segmentToSegmentDistance(segment.start, segment.end, start, end) - radius;
				}

				function getNearestTraceClearanceDistance(segment, traceObstacles) {
					let nearest = {
						trace: undefined,
						distance: Number.POSITIVE_INFINITY,
					};

					for (const trace of traceObstacles) {
						const clearanceDistance = getTraceClearanceDistanceToSegment(segment, trace);
						if (clearanceDistance < nearest.distance) {
							nearest = {
								trace,
								distance: clearanceDistance,
							};
						}
					}

					return nearest;
				}

				function isTraceBoundaryDistance(distanceToTraceClearance) {
					return Number.isFinite(distanceToTraceClearance)
						&& Math.abs(distanceToTraceClearance) <= TRACE_NECK_TRACE_EDGE_TOLERANCE;
				}

				function getTraceCausedBoundaryNeckDetails(points, minWidth, traceObstacles) {
					const genericDetails = getNarrowBoundaryNeckDetails(points, minWidth);
					const pairs = [];
					let minDistance = Number.POSITIVE_INFINITY;
					let closestPair;

					for (const pair of genericDetails.pairs) {
						const firstTraceDistance = getNearestTraceClearanceDistance(pair.first, traceObstacles);
						const secondTraceDistance = getNearestTraceClearanceDistance(pair.second, traceObstacles);
						const firstIsTraceBoundary = isTraceBoundaryDistance(firstTraceDistance.distance);
						const secondIsTraceBoundary = isTraceBoundaryDistance(secondTraceDistance.distance);
						if (firstIsTraceBoundary === secondIsTraceBoundary) {
							continue;
						}

						const traceSegment = firstIsTraceBoundary ? pair.first : pair.second;
						const outerSegment = firstIsTraceBoundary ? pair.second : pair.first;
						const traceDistance = firstIsTraceBoundary ? firstTraceDistance : secondTraceDistance;
						const outerDistance = firstIsTraceBoundary ? secondTraceDistance : firstTraceDistance;
						const traceNeckPair = {
							...pair,
							traceSegment,
							outerSegment,
							trace: traceDistance.trace,
							traceDistance: traceDistance.distance,
							outerTraceDistance: outerDistance.distance,
						};
						pairs.push(traceNeckPair);

						if (pair.width < minDistance) {
							minDistance = pair.width;
							closestPair = traceNeckPair;
						}
					}

					return {
						narrowCount: pairs.length,
						minWidth: Number.isFinite(minDistance) ? minDistance : undefined,
						closestPair,
						pairs,
					};
				}

				function makeTraceNeckRepairPatchGeometry(neckPair, passIndex) {
					if (
						!neckPair
						|| !neckPair.traceSegment
						|| !neckPair.outerSegment
						|| !neckPair.trace
					) {
						return undefined;
					}

					const outerSegment = neckPair.outerSegment;
					const traceMidpoint = getSegmentMidpoint(neckPair.traceSegment);
					const outerMidpoint = getSegmentMidpoint(outerSegment);
					const expansionDirection = normalizeVector({
						x: outerMidpoint.x - traceMidpoint.x,
						y: outerMidpoint.y - traceMidpoint.y,
					});
					const tangent = normalizeVector({
						x: outerSegment.end.x - outerSegment.start.x,
						y: outerSegment.end.y - outerSegment.start.y,
					});
					if (vectorLength(expansionDirection) <= 0 || vectorLength(tangent) <= 0) {
						return undefined;
					}

					const traceClearance = getObstacleClearanceMil(neckPair.trace);
					const lengthPadding = Math.max(traceClearance, MIN_AVOIDANCE_NECK_WIDTH) + passIndex * MIN_AVOIDANCE_NECK_WIDTH;
					const missingWidth = Math.max(0, MIN_AVOIDANCE_NECK_WIDTH - neckPair.width);
					const repairWidth = Math.max(
						traceClearance + MIN_AVOIDANCE_NECK_WIDTH * 2,
						missingWidth + traceClearance,
					) + passIndex * MIN_AVOIDANCE_NECK_WIDTH;
					const startBase = translatePoint(outerSegment.start, tangent, -lengthPadding);
					const endBase = translatePoint(outerSegment.end, tangent, lengthPadding);
					const patchPoints = orientPolygonPoints([
						translatePoint(startBase, expansionDirection, -TRACE_NECK_REPAIR_INNER_OVERLAP),
						translatePoint(endBase, expansionDirection, -TRACE_NECK_REPAIR_INNER_OVERLAP),
						translatePoint(endBase, expansionDirection, repairWidth),
						translatePoint(startBase, expansionDirection, repairWidth),
					], 1);
					const ring = makeClipRingFromPoints(patchPoints);
					return ring.length >= 4 ? [[ring]] : undefined;
				}

				function makeTraceNeckRepairGeometries(evaluation, passIndex) {
					return evaluation.neckStats.pairs
						.filter(pair => pair && pair.traceSegment && pair.outerSegment && pair.trace)
						.map(pair => makeTraceNeckRepairPatchGeometry(pair, passIndex))
						.filter(Boolean);
				}

				function makeEdaPolygonFromClipPolygon(clipPolygon) {
					if (!Array.isArray(clipPolygon) || clipPolygon.length === 0) {
						return undefined;
					}

					const sources = [];
					let outerPoints = [];
					for (let ringIndex = 0; ringIndex < clipPolygon.length; ringIndex += 1) {
						const points = makePointsFromClipRing(clipPolygon[ringIndex]);
						if (points.length < 3) {
							continue;
						}

						if (ringIndex === 0) {
							const area = Math.abs(polygonSignedArea(points));
							if (area < MIN_TRACE_CLIPPED_POLYGON_AREA) {
								return undefined;
							}

							outerPoints = points;
						}

						const orientation = ringIndex === 0 ? 1 : -1;
						const source = makeOrientedPolygonSource(points, orientation);
						if (source.length >= 3) {
							sources.push(source);
						}
					}

					if (sources.length === 0 || outerPoints.length < 3) {
						return undefined;
					}

					const polygon = sources.length === 1
						? mathSdk.createPolygon(sources[0])
						: mathSdk.createComplexPolygon(sources);

					return polygon
						? {
								polygon,
								outerPoints,
								ringCount: sources.length,
								area: Math.abs(polygonSignedArea(outerPoints)),
							}
						: undefined;
				}

				function getPolygonRecordsNeckStats(polygonRecords, minWidth, traceObstacles = []) {
					const stats = {
						narrowCount: 0,
						minWidth: undefined,
						pairs: [],
					};

					for (const record of polygonRecords) {
						const details = traceObstacles.length > 0
							? getTraceCausedBoundaryNeckDetails(record.outerPoints, minWidth, traceObstacles)
							: getNarrowBoundaryNeckDetails(record.outerPoints, minWidth);
						stats.narrowCount += details.narrowCount;
						stats.pairs.push(...details.pairs);
						if (typeof details.minWidth === 'number') {
							stats.minWidth = typeof stats.minWidth === 'number'
								? Math.min(stats.minWidth, details.minWidth)
								: details.minWidth;
						}
					}

					return stats;
				}

				function makeTraceClipEvaluation(desiredGeometry, forbiddenGeometries, polygonData, traceObstacles, difference) {
					const clippedGeometry = forbiddenGeometries.length > 0
						? difference(desiredGeometry, ...forbiddenGeometries)
						: desiredGeometry;
					const polygonRecords = Array.isArray(clippedGeometry)
						? clippedGeometry.map(makeEdaPolygonFromClipPolygon).filter(Boolean)
						: [];
					const coverageValidationContours = getCoverageValidationContours(polygonData);
					const coveredTargetCount = countCoveredTargetContours(
						polygonRecords.map(record => record.outerPoints),
						coverageValidationContours,
					);
					const targetContourCount = coverageValidationContours.length;

					return {
						clippedGeometry,
						polygonRecords,
						coveredTargetCount,
						targetContourCount,
						neckStats: getPolygonRecordsNeckStats(polygonRecords, MIN_AVOIDANCE_NECK_WIDTH, traceObstacles),
					};
				}

				function makeUnclippedPolygonResult(
					desiredRing,
					desiredPoints,
					polygonData,
					traceCount,
					reason,
					copperAreaCount = 0,
					copperNodeCount = 0,
					extraDebug = {},
				) {
					const record = makeEdaPolygonFromClipPolygon([desiredRing]);
					if (!record) {
						return {
							polygons: [],
							clippedTraceCount: 0,
							clippedCopperAreaCount: 0,
							clippedCopperNodeCount: 0,
							usedClipping: false,
							reason: 'base polygon is invalid',
							debug: {
								mode: 'base-polygon',
								desiredPointCount: desiredPoints.length,
								traceCount,
								copperAreaCount,
								copperNodeCount,
								...extraDebug,
							},
						};
					}

					const coverageValidationContours = getCoverageValidationContours(polygonData);
					const coveredTargetCount = countCoveredTargetContours(
						[record.outerPoints],
						coverageValidationContours,
					);
					const targetContourCount = coverageValidationContours.length;
					const fullTargetContourCount = Array.isArray(polygonData.targetKeepInContours)
						? polygonData.targetKeepInContours.length
						: 0;
					if (targetContourCount > 0 && coveredTargetCount < targetContourCount) {
						return {
							polygons: [],
							clippedTraceCount: 0,
							clippedCopperAreaCount: 0,
							clippedCopperNodeCount: 0,
							usedClipping: false,
							reason: 'base polygon does not cover all target pads',
							debug: {
								mode: 'base-polygon',
								desiredPointCount: desiredPoints.length,
								traceCount,
								copperAreaCount,
								copperNodeCount,
								coveredTargetCount,
								targetContourCount,
								fullTargetContourCount,
								...extraDebug,
							},
						};
					}

					return {
						polygons: [record.polygon],
						clippedTraceCount: 0,
						clippedCopperAreaCount: 0,
						clippedCopperNodeCount: 0,
						usedClipping: false,
						reason: '',
						debug: {
							mode: 'base-polygon',
							reason,
							desiredArea: roundCoordinate(Math.abs(polygonSignedArea(desiredPoints))),
							desiredPointCount: desiredPoints.length,
							traceCount,
							copperAreaCount,
							copperNodeCount,
							outputPolygonCount: 1,
							outputRingCount: record.ringCount,
							outputAreas: [roundCoordinate(record.area)],
							coveredTargetCount,
							targetContourCount,
							fullTargetContourCount,
							edgeSelectionApplied: Boolean(polygonData.edgeSelectionApplied),
							...extraDebug,
						},
					};
				}

				function isTraceClipEvaluationUsable(evaluation) {
					return evaluation.polygonRecords.length > 0
						&& (
							evaluation.targetContourCount === 0
							|| evaluation.coveredTargetCount >= evaluation.targetContourCount
						);
				}

				function compareTraceClipEvaluations(candidate, current) {
					if (!current) {
						return candidate;
					}

					if (!isTraceClipEvaluationUsable(candidate)) {
						return current;
					}

					if (!isTraceClipEvaluationUsable(current)) {
						return candidate;
					}

					if (candidate.polygonRecords.length !== current.polygonRecords.length) {
						return candidate.polygonRecords.length < current.polygonRecords.length ? candidate : current;
					}

					if (candidate.neckStats.narrowCount !== current.neckStats.narrowCount) {
						return candidate.neckStats.narrowCount < current.neckStats.narrowCount ? candidate : current;
					}

					const candidateWidth = typeof candidate.neckStats.minWidth === 'number'
						? candidate.neckStats.minWidth
						: Number.POSITIVE_INFINITY;
					const currentWidth = typeof current.neckStats.minWidth === 'number'
						? current.neckStats.minWidth
						: Number.POSITIVE_INFINITY;

					return candidateWidth > currentWidth ? candidate : current;
				}

				function isTraceClipEvaluationBetter(candidate, current) {
					return compareTraceClipEvaluations(candidate, current) === candidate;
				}

				function repairTraceClippedNarrowNecks(
					initialEvaluation,
					desiredGeometry,
					forbiddenGeometries,
					traceObstacles,
					polygonData,
					difference,
					union,
				) {
					if (!Array.isArray(traceObstacles) || traceObstacles.length === 0) {
						return {
							evaluation: initialEvaluation,
							applied: false,
							passCount: 0,
							patchCount: 0,
							reason: 'trace neck repair skipped without active traces',
						};
					}

					if (!union || initialEvaluation.neckStats.narrowCount === 0) {
						return {
							evaluation: initialEvaluation,
							applied: false,
							passCount: 0,
							patchCount: 0,
							reason: union ? '' : 'polygon clipping union is unavailable',
						};
					}

					let bestEvaluation = initialEvaluation;
					let currentDesiredGeometry = desiredGeometry;
					let totalPatchCount = 0;
					let applied = false;

					for (let passIndex = 0; passIndex < TRACE_NECK_REPAIR_MAX_PASSES; passIndex += 1) {
						const repairGeometries = makeTraceNeckRepairGeometries(bestEvaluation, passIndex);
						if (repairGeometries.length === 0) {
							return {
								evaluation: bestEvaluation,
								applied,
								passCount: passIndex,
								patchCount: totalPatchCount,
								reason: 'no trace repair patch overlaps desired area',
							};
						}

						totalPatchCount += repairGeometries.length;
						currentDesiredGeometry = union(currentDesiredGeometry, ...repairGeometries);
						const repairedEvaluation = makeTraceClipEvaluation(
							currentDesiredGeometry,
							forbiddenGeometries,
							polygonData,
							traceObstacles,
							difference,
						);
						if (!isTraceClipEvaluationUsable(repairedEvaluation)) {
							continue;
						}

						if (isTraceClipEvaluationBetter(repairedEvaluation, bestEvaluation)) {
							applied = true;
							bestEvaluation = repairedEvaluation;
						}

						if (bestEvaluation.neckStats.narrowCount === 0) {
							return {
								evaluation: bestEvaluation,
								applied,
								passCount: passIndex + 1,
								patchCount: totalPatchCount,
								reason: '',
							};
						}
					}

					return {
						evaluation: bestEvaluation,
						applied,
						passCount: TRACE_NECK_REPAIR_MAX_PASSES,
						patchCount: totalPatchCount,
						reason: bestEvaluation.neckStats.narrowCount === 0
							? ''
							: applied
								? 'narrow neck remains after repair'
								: 'repair patches did not improve neck width',
					};
				}

				function makeClearanceClippedPolygons(
					polygonData,
					traceObstacles,
					copperAreaObstacles = [],
					copperNodeObstacles = [],
				) {
					const desiredPoints = orientPolygonPoints(
						polygonData.points || makePointsFromPolygonSource(polygonData.polygonSource),
						1,
					);
					const rawTraceObstacleList = Array.isArray(traceObstacles) ? traceObstacles : [];
					const rawCopperAreaObstacleList = Array.isArray(copperAreaObstacles) ? copperAreaObstacles : [];
					const rawCopperNodeObstacleList = Array.isArray(copperNodeObstacles) ? copperNodeObstacles : [];
					const traceObstacleList = rawTraceObstacleList.filter(isTraceClipObstacle);
					const copperAreaObstacleList = rawCopperAreaObstacleList.filter(isCopperAreaClipObstacle);
					const copperNodeObstacleList = rawCopperNodeObstacleList.filter(isCopperNodePrimitive);
					const skippedNonClipObstacleCount = rawTraceObstacleList.length
						+ rawCopperAreaObstacleList.length
						+ rawCopperNodeObstacleList.length
						- traceObstacleList.length
						- copperAreaObstacleList.length
						- copperNodeObstacleList.length;
					const traceCount = traceObstacleList.length;
					const copperAreaCount = copperAreaObstacleList.length;
					const copperNodeCount = copperNodeObstacleList.length;
					if (desiredPoints.length < 3) {
						return {
							polygons: [],
							clippedTraceCount: 0,
							clippedCopperAreaCount: 0,
							clippedCopperNodeCount: 0,
							usedClipping: false,
							reason: 'desired polygon is invalid',
							debug: {
								desiredPointCount: desiredPoints.length,
								traceCount,
								copperAreaCount,
								copperNodeCount,
								skippedNonClipObstacleCount,
							},
						};
					}

					const desiredRing = makeClipRingFromPoints(desiredPoints);
					if (desiredRing.length < 4) {
						return {
							polygons: [],
							clippedTraceCount: 0,
							clippedCopperAreaCount: 0,
							clippedCopperNodeCount: 0,
							usedClipping: false,
							reason: 'base polygon is invalid',
							debug: {
								desiredPointCount: desiredPoints.length,
								desiredRingPointCount: desiredRing.length,
								traceCount,
								copperAreaCount,
								copperNodeCount,
								skippedNonClipObstacleCount,
							},
						};
					}

					if (traceCount === 0 && copperAreaCount === 0 && copperNodeCount === 0) {
						return makeUnclippedPolygonResult(
							desiredRing,
							desiredPoints,
							polygonData,
							traceCount,
							'no same-layer different-net copper obstacles found',
							copperAreaCount,
							copperNodeCount,
							{ skippedNonClipObstacleCount },
						);
					}

					const activeTraceObstacles = traceObstacleList
						.filter(trace => traceClearanceOverlapsPolygon(trace, desiredPoints));
					const activeTraceCount = activeTraceObstacles.length;
					const copperNodeRecords = makeCopperNodeForbiddenSourceRecords(copperNodeObstacleList, 1);

					const copperAreaRecordResult = copperAreaCount > 0
						? makeCopperAreaForbiddenSourceRecords(copperAreaObstacleList, 1)
						: { records: [], error: '' };
					if (copperAreaRecordResult.error) {
						return {
							polygons: [],
							clippedTraceCount: 0,
							clippedCopperAreaCount: 0,
							clippedCopperNodeCount: 0,
							usedClipping: false,
							reason: copperAreaRecordResult.error,
							debug: {
								desiredPointCount: desiredPoints.length,
								traceCount,
								copperAreaCount,
								copperNodeCount,
								activeTraceCount,
							},
						};
					}

					if (copperAreaCount > 0 && copperAreaRecordResult.records.length === 0) {
						return {
							polygons: [],
							clippedTraceCount: 0,
							clippedCopperAreaCount: 0,
							clippedCopperNodeCount: 0,
							usedClipping: false,
							reason: 'copper area clearance zones are invalid',
							debug: {
								desiredPointCount: desiredPoints.length,
								traceCount,
								copperAreaCount,
								copperNodeCount,
								activeTraceCount,
								forbiddenSourceCount: 0,
							},
						};
					}

					if (copperNodeCount > 0 && copperNodeRecords.length === 0) {
						return {
							polygons: [],
							clippedTraceCount: 0,
							clippedCopperAreaCount: 0,
							clippedCopperNodeCount: 0,
							usedClipping: false,
							reason: 'pad/via clearance zones are invalid',
							debug: {
								desiredPointCount: desiredPoints.length,
								traceCount,
								copperAreaCount,
								copperNodeCount,
								activeTraceCount,
								forbiddenSourceCount: 0,
							},
						};
					}

					const activeCopperAreaRecords = copperAreaRecordResult.records
						.filter(record => forbiddenRecordOverlapsPolygon(record, desiredPoints));
					const activeCopperAreaObstacles = getForbiddenRecordObstacles(activeCopperAreaRecords, 'copper-area');
					const activeCopperAreaCount = activeCopperAreaObstacles.length;
					const activeCopperNodeRecords = copperNodeRecords
						.filter(record => forbiddenRecordOverlapsPolygon(record, desiredPoints));
					const activeCopperNodeObstacles = getForbiddenRecordObstacles(activeCopperNodeRecords, 'copper-node');
					const activeCopperNodeCount = activeCopperNodeObstacles.length;

					if (activeTraceCount === 0 && activeCopperAreaCount === 0 && activeCopperNodeCount === 0) {
						return makeUnclippedPolygonResult(
							desiredRing,
							desiredPoints,
							polygonData,
							traceCount,
							'no clearance zone overlaps desired polygon',
							copperAreaCount,
							copperNodeCount,
							{ skippedNonClipObstacleCount },
						);
					}

					const traceClearances = [...new Set(activeTraceObstacles.map(trace => roundCoordinate(getObstacleClearanceMil(trace))))];
					const traceClearanceSources = [...new Set(activeTraceObstacles.map(trace => trace.clearanceRuleSource).filter(Boolean))];
					const traceClearanceRules = summarizeClearanceRules(activeTraceObstacles);
					const copperAreaClearances = [...new Set(activeCopperAreaObstacles.map(obstacle => roundCoordinate(getObstacleClearanceMil(obstacle))))];
					const copperAreaClearanceSources = [...new Set(activeCopperAreaObstacles.map(obstacle => obstacle.clearanceRuleSource).filter(Boolean))];
					const copperAreaClearanceRules = summarizeClearanceRules(activeCopperAreaObstacles);
					const copperNodeClearances = [...new Set(activeCopperNodeObstacles.map(obstacle => roundCoordinate(getObstacleClearanceMil(obstacle))))];
					const copperNodeClearanceSources = [...new Set(activeCopperNodeObstacles.map(obstacle => obstacle.clearanceRuleSource).filter(Boolean))];
					const copperNodeClearanceRules = summarizeClearanceRules(activeCopperNodeObstacles);
					const makeDebug = (extra = {}) => ({
						desiredArea: roundCoordinate(Math.abs(polygonSignedArea(desiredPoints))),
						desiredPointCount: desiredPoints.length,
						traceCount,
						copperAreaCount,
						copperNodeCount,
						fullTargetContourCount: Array.isArray(polygonData.targetKeepInContours)
							? polygonData.targetKeepInContours.length
							: 0,
						coverageValidationContourCount: getCoverageValidationContours(polygonData).length,
						activeTraceCount,
						activeCopperAreaCount,
						activeCopperNodeCount,
						traceClearances,
						traceClearanceSources,
						traceClearanceRules,
						copperAreaClearances,
						copperAreaClearanceSources,
						copperAreaClearanceRules,
						copperNodeClearances,
						copperNodeClearanceSources,
						copperNodeClearanceRules,
						skippedNonClipObstacleCount,
						...extra,
					});
					const difference = getPolygonClippingDifference();
					if (!difference) {
						return {
							polygons: [],
							clippedTraceCount: 0,
							clippedCopperAreaCount: 0,
							clippedCopperNodeCount: 0,
							usedClipping: false,
							reason: 'polygon clipping library is unavailable',
							debug: makeDebug(),
						};
					}

					const union = getPolygonClippingUnion();
					const traceRecords = makeTraceForbiddenSourceRecords(activeTraceObstacles, 1);
					const forbiddenRecords = traceRecords.concat(activeCopperAreaRecords, activeCopperNodeRecords);
					const forbiddenSources = forbiddenRecords.map(record => record.source);
					if (forbiddenRecords.length === 0 || forbiddenSources.length === 0) {
						return {
							polygons: [],
							clippedTraceCount: 0,
							clippedCopperAreaCount: 0,
							clippedCopperNodeCount: 0,
							usedClipping: false,
							reason: 'clearance zones are invalid',
							debug: makeDebug({
								forbiddenSourceCount: forbiddenSources.length,
							}),
						};
					}

					try {
						const { effectiveGeometries: forbiddenGeometries, protectedGeometryCount } = makeEffectiveForbiddenGeometries(
							forbiddenSources,
							getCoverageValidationContours(polygonData),
							difference,
						);
						if (forbiddenGeometries.length === 0) {
							const desiredEvaluation = makeTraceClipEvaluation(
								[[desiredRing]],
								forbiddenGeometries,
								polygonData,
								activeTraceObstacles,
								difference,
							);
							if (desiredEvaluation.polygonRecords.length === 0) {
								return {
									polygons: [],
									clippedTraceCount: 0,
									clippedCopperAreaCount: 0,
									clippedCopperNodeCount: 0,
									usedClipping: false,
									reason: 'polygon clipping returned no valid polygons',
									debug: makeDebug({
										mode: 'polygon-clipping-target-protected',
										forbiddenSourceCount: forbiddenSources.length,
										forbiddenGeometryCount: forbiddenGeometries.length,
										protectedGeometryCount,
									}),
								};
							}

							return {
								polygons: desiredEvaluation.polygonRecords.map(record => record.polygon),
								clippedTraceCount: 0,
								clippedCopperAreaCount: 0,
								clippedCopperNodeCount: 0,
								usedClipping: true,
								reason: '',
								debug: makeDebug({
									mode: 'polygon-clipping-target-protected',
									forbiddenSourceCount: forbiddenSources.length,
									forbiddenGeometryCount: forbiddenGeometries.length,
									protectedGeometryCount,
									outputPolygonCount: desiredEvaluation.polygonRecords.length,
									outputRingCount: desiredEvaluation.polygonRecords.reduce((sum, record) => sum + record.ringCount, 0),
									outputAreas: desiredEvaluation.polygonRecords.map(record => roundCoordinate(record.area)),
									coveredTargetCount: desiredEvaluation.coveredTargetCount,
									targetContourCount: desiredEvaluation.targetContourCount,
									neckNarrowCount: desiredEvaluation.neckStats.narrowCount,
									neckMinWidth: typeof desiredEvaluation.neckStats.minWidth === 'number'
										? roundCoordinate(desiredEvaluation.neckStats.minWidth)
										: undefined,
								}),
							};
						}

						const baseDesiredGeometry = [[desiredRing]];
						const initialEvaluation = makeTraceClipEvaluation(
							baseDesiredGeometry,
							forbiddenGeometries,
							polygonData,
							activeTraceObstacles,
							difference,
						);
						if (initialEvaluation.polygonRecords.length === 0) {
							return {
								polygons: [],
								clippedTraceCount: 0,
								clippedCopperAreaCount: 0,
								clippedCopperNodeCount: 0,
								usedClipping: false,
								reason: 'polygon clipping returned no valid polygons',
								debug: makeDebug({
									mode: 'polygon-clipping-difference',
									forbiddenSourceCount: forbiddenSources.length,
									forbiddenGeometryCount: forbiddenGeometries.length,
									protectedGeometryCount,
									outputPolygonCount: Array.isArray(initialEvaluation.clippedGeometry)
										? initialEvaluation.clippedGeometry.length
										: 0,
								}),
							};
						}

						if (
							initialEvaluation.targetContourCount > 0
							&& initialEvaluation.coveredTargetCount < initialEvaluation.targetContourCount
						) {
							return {
								polygons: [],
								clippedTraceCount: 0,
								clippedCopperAreaCount: 0,
								clippedCopperNodeCount: 0,
								usedClipping: false,
								reason: 'polygon clipping result does not cover all target pads',
								debug: makeDebug({
									mode: 'polygon-clipping-difference',
									forbiddenSourceCount: forbiddenSources.length,
									forbiddenGeometryCount: forbiddenGeometries.length,
									protectedGeometryCount,
									outputPolygonCount: initialEvaluation.polygonRecords.length,
									coveredTargetCount: initialEvaluation.coveredTargetCount,
									targetContourCount: initialEvaluation.targetContourCount,
								}),
							};
						}

						let repair;
						try {
							repair = repairTraceClippedNarrowNecks(
								initialEvaluation,
								baseDesiredGeometry,
								forbiddenGeometries,
								activeTraceObstacles,
								polygonData,
								difference,
								union,
							);
						}
						catch (err) {
							logWarn('Trace neck repair failed after clipping:', err);
							repair = {
								evaluation: initialEvaluation,
								applied: false,
								passCount: 0,
								patchCount: 0,
								reason: 'trace neck repair threw an exception',
							};
						}
						const polygonRecords = repair.evaluation.polygonRecords;

							return {
								polygons: polygonRecords.map(record => record.polygon),
								clippedTraceCount: forbiddenGeometries.length > 0 ? activeTraceCount : 0,
								clippedCopperAreaCount: forbiddenGeometries.length > 0 ? activeCopperAreaCount : 0,
								clippedCopperNodeCount: forbiddenGeometries.length > 0 ? activeCopperNodeCount : 0,
								usedClipping: true,
								reason: '',
								debug: makeDebug({
									mode: repair.applied
										? 'polygon-clipping-difference-dynamic-repair'
										: 'polygon-clipping-difference',
									forbiddenSourceCount: forbiddenSources.length,
									forbiddenGeometryCount: forbiddenGeometries.length,
									protectedGeometryCount,
									outputPolygonCount: polygonRecords.length,
									outputRingCount: polygonRecords.reduce((sum, record) => sum + record.ringCount, 0),
									outputAreas: polygonRecords.map(record => roundCoordinate(record.area)),
									coveredTargetCount: repair.evaluation.coveredTargetCount,
									targetContourCount: repair.evaluation.targetContourCount,
									edgeSelectionApplied: Boolean(polygonData.edgeSelectionApplied),
									neckRepairApplied: repair.applied,
									neckRepairPassCount: repair.passCount,
									neckRepairPatchCount: repair.patchCount,
									neckRepairReason: repair.reason,
									neckNarrowCountBefore: initialEvaluation.neckStats.narrowCount,
									neckMinWidthBefore: typeof initialEvaluation.neckStats.minWidth === 'number'
										? roundCoordinate(initialEvaluation.neckStats.minWidth)
										: undefined,
									neckNarrowCountAfter: repair.evaluation.neckStats.narrowCount,
									neckMinWidthAfter: typeof repair.evaluation.neckStats.minWidth === 'number'
										? roundCoordinate(repair.evaluation.neckStats.minWidth)
										: undefined,
								}),
							};
						}
						catch (err) {
							logWarn('Clearance clipping threw an error:', err);
							return {
								polygons: [],
								clippedTraceCount: 0,
								clippedCopperAreaCount: 0,
								clippedCopperNodeCount: 0,
								usedClipping: false,
								reason: 'clearance clipping threw an exception',
								debug: makeDebug({
									forbiddenSourceCount: forbiddenSources.length,
								}),
							};
					}
				}

				function makeTraceClippedPolygons(polygonData, traceObstacles) {
					return makeClearanceClippedPolygons(polygonData, traceObstacles, []);
				}

				function isClearanceClipTargetCoverageFailure(clearanceClipResult) {
					const reason = String(clearanceClipResult && clearanceClipResult.reason || '');
					return reason === 'base polygon does not cover all target pads'
						|| reason === 'polygon clipping result does not cover all target pads';
				}

				function shouldRetryMultiPadHybridBridgeAfterClipping(polygonData, clearanceClipResult) {
					return Boolean(
						isClearanceClipTargetCoverageFailure(clearanceClipResult)
						&& polygonData
						&& polygonData.multiPadHybridBoundary
						&& polygonData.multiPadBoundaryStrategy === 'envelope',
					);
				}

				function splitTargetsIntoPourGroups(targets) {
					return [targets];
				}

				function getInferredTargetNet(targets) {
					const targetsWithoutNet = targets.filter(target => !String(target.net || '').trim());
					if (targetsWithoutNet.length > 0) {
						return {
							net: '',
							error: text('Selected targets include pads or vias with no net. Assign a net before creating copper.'),
						};
					}

					const targetNets = [...new Set(targets.map(target => String(target.net || '').trim()).filter(Boolean))];
					if (targetNets.length > 1) {
						return {
							net: '',
							error: text('Selection includes different nets: ${1}. Select targets from the same net.', targetNets.join(', ')),
						};
					}

					return {
						net: targetNets[0] || '',
						error: '',
					};
				}

				return {
					applyDrcAwareTargetMargins,
					makeCleanPourPolygonData,
					makeClearanceClippedPolygons,
					resolveCopperNodeClipObstacles,
					makeEdaPolygonFromClipPolygon,
					shouldRetryMultiPadHybridBridgeAfterClipping,
				};
}
