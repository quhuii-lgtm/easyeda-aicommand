import namespace from '../namespace.js'
(function (global) {
	'use strict';

	const namespace = global.AutoCopperPour = global.AutoCopperPour || {};

	function createBoundaryGeneration(dependencies) {
		const {
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
		} = dependencies;

				function makeCornerPath(corners, fromIndex, toIndex) {
					const path = [];
					let index = fromIndex;

					while (true) {
						path.push(corners[index]);
						if (index === toIndex) {
							break;
						}
						index = (index + 1) % corners.length;
					}

					return path;
				}

				function getRectTargetEdges(target, margin, shouldUseDynamicShape) {
					const corners = makeRectExpandedCornerPoints(target, margin, shouldUseDynamicShape, []);
					if (corners.length < 4) {
						return [];
					}

					const signedArea = polygonSignedArea(corners);
					const edges = [];
					for (let index = 0; index < corners.length; index += 1) {
						const nextIndex = (index + 1) % corners.length;
						const start = corners[index];
						const end = corners[nextIndex];
						edges.push({
							corners,
							start,
							end,
							startIndex: index,
							endIndex: nextIndex,
							midpoint: {
								x: (start.x + end.x) / 2,
								y: (start.y + end.y) / 2,
							},
							outward: getOutwardNormal(start, end, signedArea),
						});
					}

					return edges;
				}

				function makeTwoRectBoundaryFromEdges(startEdge, endEdge) {
					return cleanBoundaryPoints([
						startEdge.start,
						...makeCornerPath(endEdge.corners, endEdge.endIndex, endEdge.startIndex),
						...makeCornerPath(startEdge.corners, startEdge.endIndex, startEdge.startIndex),
					]);
				}

				function getRectEdgeBridgeSpan(edgePair) {
					if (!edgePair || !edgePair.startEdge || !edgePair.endEdge) {
						return Number.POSITIVE_INFINITY;
					}

					return distance(edgePair.startEdge.midpoint, edgePair.endEdge.midpoint);
				}

				function getTargetGapDistance(first, second) {
					if (!first || !second) {
						return Number.POSITIVE_INFINITY;
					}

					const forward = normalizeVector({
						x: second.x - first.x,
						y: second.y - first.y,
					});
					const centerDistance = distance(first, second);
					if (centerDistance <= 0.001 || vectorLength(forward) <= 0) {
						return 0;
					}

					const firstRadius = getShapeProjectionRadius(first, forward, true);
					const secondRadius = getShapeProjectionRadius(second, forward, true);
					return Math.max(0, centerDistance - firstRadius - secondRadius);
				}

				function isShortRectBridgeSpan(span, clearanceMil = 0) {
					const dynamicGap = Math.max(
						SHORT_BRIDGE_FALLBACK_GAP,
						(clearanceMil || 0) * 4 + POUR_LINE_WIDTH,
					);
					return Number.isFinite(span) && span <= dynamicGap;
				}

				function isCloseTwoRectTargetSet(targets) {
					return Array.isArray(targets)
						&& targets.length === 2
						&& isShortRectBridgeSpan(getTargetGapDistance(targets[0], targets[1]));
				}

				function getPointDistanceToBoundary(point, boundary) {
					if (!Array.isArray(boundary) || boundary.length < 2) {
						return Number.POSITIVE_INFINITY;
					}

					let minDistance = Number.POSITIVE_INFINITY;
					for (let index = 0; index < boundary.length; index += 1) {
						minDistance = Math.min(
							minDistance,
							pointToSegmentDistance(point, boundary[index], boundary[(index + 1) % boundary.length]),
						);
					}

					return minDistance;
				}

				function getMaxBoundaryDeviation(points, baseBoundary) {
					if (!Array.isArray(points) || points.length === 0) {
						return 0;
					}

					return Math.max(...points.map(point => getPointDistanceToBoundary(point, baseBoundary)));
				}

				function hasSharpBoundaryCorner(points, minAngleDegrees) {
					if (!Array.isArray(points) || points.length < 3) {
						return false;
					}

					const minAngleCos = Math.cos(minAngleDegrees * Math.PI / 180);
					for (let index = 0; index < points.length; index += 1) {
						const previous = points[(index - 1 + points.length) % points.length];
						const current = points[index];
						const next = points[(index + 1) % points.length];
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

				function shouldUseDirectShortBridgeFallback(basePoints, avoidedPoints, avoidance, targetKeepInContours, bridgeSpan) {
					if (!avoidance || avoidance.avoidedCount <= 0 || !isShortRectBridgeSpan(bridgeSpan)) {
						return false;
					}

					if (!isBoundaryPathValid(basePoints, targetKeepInContours)) {
						return false;
					}

					const maxDeviation = getMaxBoundaryDeviation(avoidedPoints, basePoints);
					const allowedDeviation = Math.max(POUR_LINE_WIDTH, bridgeSpan * SHORT_BRIDGE_DETOUR_OFFSET_RATIO);
					if (maxDeviation > allowedDeviation) {
						return true;
					}

					return avoidedPoints.length > basePoints.length
						&& hasSharpBoundaryCorner(avoidedPoints, SHORT_BRIDGE_SPIKE_CORNER_ANGLE);
				}

				function getLongestBoundaryEdgeLength(points) {
					if (!Array.isArray(points) || points.length < 2) {
						return 0;
					}

					let longest = 0;
					for (let index = 0; index < points.length; index += 1) {
						longest = Math.max(longest, distance(points[index], points[(index + 1) % points.length]));
					}

					return longest;
				}

				function shouldRejectGenericFallbackDetour(basePoints, avoidedPoints, avoidance) {
					if (!avoidance || avoidance.avoidedCount <= 0 || !Array.isArray(avoidedPoints) || avoidedPoints.length < 3) {
						return false;
					}

					const maxDeviation = getMaxBoundaryDeviation(avoidedPoints, basePoints);
					const allowedDeviation = Math.max(
						POUR_LINE_WIDTH * 2,
						MIN_AVOIDANCE_NECK_WIDTH * 3,
						getLongestBoundaryEdgeLength(basePoints) * MAX_DETOUR_OFFSET_RATIO,
					);
					return maxDeviation > allowedDeviation
						|| (avoidedPoints.length > basePoints.length
							&& hasSharpBoundaryCorner(avoidedPoints, SHORT_BRIDGE_SPIKE_CORNER_ANGLE));
				}

				function getRectEdgeAxis(edge, target) {
					const localOutward = rotateWorldDirectionToLocal(edge.outward, target.rotation);
					const axis = Math.abs(localOutward.x) >= Math.abs(localOutward.y) ? 'x' : 'y';
					const sideSign = axis === 'x'
						? Math.sign(localOutward.x)
						: Math.sign(localOutward.y);

					return {
						axis,
						sideSign: sideSign || 1,
					};
				}

				function getRectEdgeDebugSummary(edge, target) {
					const axisInfo = getRectEdgeAxis(edge, target);
					return {
						axis: axisInfo.axis,
						sideSign: axisInfo.sideSign,
						label: `${axisInfo.axis}${axisInfo.sideSign > 0 ? '+' : '-'}`,
						start: {
							x: roundCoordinate(edge.start.x),
							y: roundCoordinate(edge.start.y),
						},
						end: {
							x: roundCoordinate(edge.end.x),
							y: roundCoordinate(edge.end.y),
						},
						midpoint: {
							x: roundCoordinate(edge.midpoint.x),
							y: roundCoordinate(edge.midpoint.y),
						},
						outward: {
							x: roundCoordinate(edge.outward.x),
							y: roundCoordinate(edge.outward.y),
						},
					};
				}

				function getPrimaryRectEdgeAxis(target, direction) {
					const localDirection = rotateWorldDirectionToLocal(direction, target.rotation);
					const halfWidth = Math.max(getShapeWidth(target) / 2, 0.001);
					const halfHeight = Math.max(getShapeHeight(target) / 2, 0.001);
					const xHitScore = Math.abs(localDirection.x) / halfWidth;
					const yHitScore = Math.abs(localDirection.y) / halfHeight;
					const axis = yHitScore >= xHitScore ? 'y' : 'x';
					const component = axis === 'x' ? localDirection.x : localDirection.y;

					if (Math.abs(component) <= 0.001) {
						return undefined;
					}

					return {
						axis,
						sideSign: component >= 0 ? 1 : -1,
					};
				}

				function findRectEdgeByAxis(edges, target, axisInfo) {
					if (!axisInfo) {
						return undefined;
					}

					return edges.find((edge) => {
						const edgeAxis = getRectEdgeAxis(edge, target);
						return edgeAxis.axis === axisInfo.axis && edgeAxis.sideSign === axisInfo.sideSign;
					});
				}

				function isSameTarget(first, second) {
					if (!first || !second) {
						return false;
					}

					if (Array.isArray(first.sourceTargets) && first.sourceTargets.some(sourceTarget => isSameTarget(sourceTarget, second))) {
						return true;
					}

					if (Array.isArray(second.sourceTargets) && second.sourceTargets.some(sourceTarget => isSameTarget(first, sourceTarget))) {
						return true;
					}

					const firstPrimitiveId = normalizeNetName(first.primitiveId);
					const secondPrimitiveId = normalizeNetName(second.primitiveId);
					if (firstPrimitiveId && secondPrimitiveId && firstPrimitiveId === secondPrimitiveId) {
						return true;
					}

					return getTargetKey(first) === getTargetKey(second);
				}

				function shouldIgnoreShieldTarget(target, shieldTarget) {
					return !shieldTarget || isSameTarget(target, shieldTarget);
				}

				function isSameNamedNet(first, second) {
					const firstNet = normalizeNetName(first && first.net);
					const secondNet = normalizeNetName(second && second.net);
					return Boolean(firstNet && firstNet === secondNet);
				}

				function shouldIgnoreSelectedSameNetShieldTarget(target, shieldTarget, selectedTargets = []) {
					if (shouldIgnoreShieldTarget(target, shieldTarget)) {
						return true;
					}

					if (!isSameNamedNet(target, shieldTarget)) {
						return false;
					}

					return (Array.isArray(selectedTargets) ? selectedTargets : [])
						.some(selectedTarget => isSameTarget(selectedTarget, shieldTarget));
				}

				function shouldIgnorePairEndpointShieldTarget(target, shieldTarget, oppositeTarget) {
					return shouldIgnoreSelectedSameNetShieldTarget(
						target,
						shieldTarget,
						oppositeTarget ? [oppositeTarget] : [],
					);
				}

				function getSelectedSameNetForwardScopeTarget(target, edge, selectedTargets = []) {
					if (!target || !edge || !Array.isArray(selectedTargets) || selectedTargets.length === 0) {
						return undefined;
					}

					const tangent = normalizeVector({
						x: edge.end.x - edge.start.x,
						y: edge.end.y - edge.start.y,
					});
					if (vectorLength(tangent) <= 0) {
						return undefined;
					}

					const targetLateralRadius = getShapeProjectionRadius(target, tangent, true);
					let bestTarget;
					let bestForwardDistance = Number.POSITIVE_INFINITY;
					for (const selectedTarget of selectedTargets) {
						if (!selectedTarget || isSameTarget(target, selectedTarget) || !isSameNamedNet(target, selectedTarget)) {
							continue;
						}

						const offset = {
							x: selectedTarget.x - target.x,
							y: selectedTarget.y - target.y,
						};
						const forwardDistance = dotProduct(offset, edge.outward);
						if (forwardDistance <= 0.001 || forwardDistance >= bestForwardDistance) {
							continue;
						}

						const lateralDistance = Math.abs(dotProduct(offset, tangent));
						const selectedLateralRadius = getShapeProjectionRadius(selectedTarget, tangent, true);
						const lateralGap = lateralDistance - targetLateralRadius - selectedLateralRadius;
						if (lateralGap > OBSTACLE_LATERAL_MARGIN) {
							continue;
						}

						bestTarget = selectedTarget;
						bestForwardDistance = forwardDistance;
					}

					return bestTarget;
				}

				function isRectEdgeCornerFalsePositive(forwardDistance, lateralDistance, forwardGap, lateralGap) {
					if (lateralGap <= 0.001) {
						return false;
					}

					const normalDominantByCenter = forwardDistance >= lateralDistance * EDGE_BLOCK_CORNER_DOMINANCE_RATIO;
					const normalDominantByGap = forwardGap + EDGE_BLOCK_CORNER_GAP_BIAS <= lateralGap;
					return !normalDominantByCenter && !normalDominantByGap;
				}

				function makeRectEdgeBlockerRecord(
					shieldTarget,
					forwardDistance,
					forwardGap,
					forwardGapLimit,
					lateralDistance,
					lateralGap,
					lateralGapLimit,
					forwardOverlapAccepted,
					reason = undefined,
				) {
					return {
						target: summarizePadEdgeTarget(shieldTarget),
						forwardDistance: roundCoordinate(forwardDistance),
						forwardGap: roundCoordinate(forwardGap),
						forwardGapLimit: roundCoordinate(forwardGapLimit),
						lateralDistance: roundCoordinate(lateralDistance),
						lateralGap: roundCoordinate(lateralGap),
						lateralGapLimit: roundCoordinate(lateralGapLimit),
						forwardOverlapAccepted,
						reason,
					};
				}

				function getRectEdgeBlockers(edge, target, shieldTargets = [], options = {}) {
					const tangent = normalizeVector({
						x: edge.end.x - edge.start.x,
						y: edge.end.y - edge.start.y,
					});
					if (vectorLength(tangent) <= 0) {
						return [];
					}

					const shouldIgnore = typeof options.shouldIgnoreShieldTarget === 'function'
						? options.shouldIgnoreShieldTarget
						: shouldIgnoreShieldTarget;
					const lateralGapLimit = Math.max(0, toNumber(options.lateralGapLimit, OBSTACLE_LATERAL_MARGIN));
					const forwardGapLimit = Math.max(0, toNumber(options.forwardGapLimit, EDGE_BLOCK_FORWARD_GAP));
					const forwardOverlapTolerance = Math.max(0, toNumber(options.forwardOverlapTolerance, 0));
					const allowForwardOverlap = Boolean(options.allowForwardOverlap);
					const blockers = [];
					for (const shieldTarget of shieldTargets) {
						if (shouldIgnore(target, shieldTarget)) {
							continue;
						}

						const offset = {
							x: shieldTarget.x - target.x,
							y: shieldTarget.y - target.y,
						};
						const forwardDistance = dotProduct(offset, edge.outward);
						if (forwardDistance <= 0.001) {
							continue;
						}

						const lateralDistance = Math.abs(dotProduct(offset, tangent));
						const targetLateralRadius = getShapeProjectionRadius(target, tangent, true);
						const shieldLateralRadius = getShapeProjectionRadius(shieldTarget, tangent, true);
						const lateralGap = lateralDistance - targetLateralRadius - shieldLateralRadius;
						const targetForwardRadius = getShapeProjectionRadius(target, edge.outward, true);
						const shieldForwardRadius = getShapeProjectionRadius(shieldTarget, edge.outward, true);
						const forwardGap = forwardDistance - targetForwardRadius - shieldForwardRadius;

						if (options.forwardScopeTarget) {
							const scopeOffset = {
								x: options.forwardScopeTarget.x - target.x,
								y: options.forwardScopeTarget.y - target.y,
							};
							const scopeForwardDistance = dotProduct(scopeOffset, edge.outward);
							const scopeForwardRadius = getShapeProjectionRadius(options.forwardScopeTarget, edge.outward, true);
							const shieldForwardRadiusForScope = getShapeProjectionRadius(shieldTarget, edge.outward, true);
							const shieldStartsAfterScope = forwardDistance - shieldForwardRadiusForScope
								> scopeForwardDistance + scopeForwardRadius + 0.001;
							if (scopeForwardDistance > 0.001
								&& forwardDistance > scopeForwardDistance + 0.001
								&& (lateralGap >= -0.001 || shieldStartsAfterScope)) {
								continue;
							}
						}

						if (lateralGap > lateralGapLimit) {
							continue;
						}

						if (forwardGap < -0.001) {
							const blockerCenterPastEdge = forwardDistance > targetForwardRadius + 0.001;
							const overlapWithinTolerance = forwardGap >= -forwardOverlapTolerance;
							if (!allowForwardOverlap || !blockerCenterPastEdge || !overlapWithinTolerance) {
								continue;
							}
						}

						if (forwardGap <= forwardGapLimit) {
							const forwardOverlapAccepted = forwardGap < -0.001;
							if (isRectEdgeCornerFalsePositive(forwardDistance, lateralDistance, forwardGap, lateralGap)) {
								if (Array.isArray(options.ignoredCornerBlockers)) {
									options.ignoredCornerBlockers.push(makeRectEdgeBlockerRecord(
										shieldTarget,
										forwardDistance,
										forwardGap,
										forwardGapLimit,
										lateralDistance,
										lateralGap,
										lateralGapLimit,
										forwardOverlapAccepted,
										'corner-lateral-dominant',
									));
								}
								continue;
							}

							blockers.push(makeRectEdgeBlockerRecord(
								shieldTarget,
								forwardDistance,
								forwardGap,
								forwardGapLimit,
								lateralDistance,
								lateralGap,
								lateralGapLimit,
								forwardOverlapAccepted,
							));
						}
					}

					return blockers;
				}

				function isRectEdgeBlockedByShieldTargets(edge, target, shieldTargets = []) {
					return getRectEdgeBlockers(edge, target, shieldTargets).length > 0;
				}

				function makeStrictRectEdgeBlockerOptions(selectedTargets = []) {
					return {
						forwardGapLimit: Math.max(EDGE_BLOCK_FORWARD_GAP, EDGE_BLOCK_FORWARD_SEARCH_MARGIN),
						forwardOverlapTolerance: EDGE_BLOCK_FORWARD_GAP,
						allowForwardOverlap: true,
						shouldIgnoreShieldTarget: (target, shieldTarget) =>
							shouldIgnoreSelectedSameNetShieldTarget(target, shieldTarget, selectedTargets),
					};
				}

				function makeCenterlineRectEdgeCandidates(
					target,
					direction,
					margin,
					shouldUseDynamicShape,
					shieldTargets = [],
					oppositeTarget,
					options = {},
				) {
					const edges = getRectTargetEdges(target, margin, shouldUseDynamicShape);
					const primaryEdge = findRectEdgeByAxis(edges, target, getPrimaryRectEdgeAxis(target, direction));
					const rankedEdges = edges.slice()
						.sort((first, second) => dotProduct(second.outward, direction) - dotProduct(first.outward, direction));
					const rawCandidates = [];
					const candidateLimit = Math.max(1, Math.min(
						edges.length || 1,
						Math.floor(toNumber(options.candidateLimit, 2)),
					));
					const blockerOptions = options.blockerOptions || {};

					if (primaryEdge) {
						rawCandidates.push(primaryEdge);
					}

					for (const edge of rankedEdges) {
						if (rawCandidates.length >= candidateLimit) {
							break;
						}

						if (rawCandidates.includes(edge)) {
							continue;
						}

						rawCandidates.push(edge);
					}
					const shouldIgnoreCandidateShieldTarget = (candidateTarget, shieldTarget) =>
						shouldIgnorePairEndpointShieldTarget(candidateTarget, shieldTarget, oppositeTarget);

					const rawCandidateDetails = rawCandidates
						.map((edge, index) => {
							const ignoredCornerBlockers = [];
							const blockers = getRectEdgeBlockers(edge, target, shieldTargets, {
								...blockerOptions,
								shouldIgnoreShieldTarget: shouldIgnoreCandidateShieldTarget,
								forwardScopeTarget: oppositeTarget,
								ignoredCornerBlockers,
							});
							return {
								edge,
								preferenceRank: index,
								blockers,
								ignoredCornerBlockers,
							};
						});
					const candidates = rawCandidateDetails
						.filter(candidate => candidate.blockers.length === 0)
						.map(candidate => ({
							edge: candidate.edge,
							preferenceRank: candidate.preferenceRank,
						}));

					if (rawCandidateDetails.some(candidate => candidate.blockers.length > 0)) {
						reportPadEdgeDiagnostic('Pad edge blocked candidates', {
							target: summarizePadEdgeTarget(target),
							oppositeTarget: summarizePadEdgeTarget(oppositeTarget),
							direction: {
								x: roundCoordinate(direction.x),
								y: roundCoordinate(direction.y),
							},
							rawCandidates: rawCandidateDetails.map(candidate => summarizeRectEdgeCandidate(candidate, target)),
							keptLabels: candidates.map(candidate => getRectEdgeDebugSummary(candidate.edge, target).label),
							shieldTargetCount: Array.isArray(shieldTargets) ? shieldTargets.length : 0,
							blockerOptions: summarizeRectEdgeBlockerOptions(blockerOptions),
						});
					}

					return candidates;
				}

				function makeOrderedRectEdgePairs(targets, margin, shouldUseDynamicShape, shieldTargets = targets, options = {}) {
					const start = targets[0];
					const end = targets[1];
					const forward = normalizeVector({
						x: end.x - start.x,
						y: end.y - start.y,
					});
					if (vectorLength(forward) <= 0) {
						return [];
					}

					const startCandidates = makeCenterlineRectEdgeCandidates(
						start,
						forward,
						margin,
						shouldUseDynamicShape,
						shieldTargets,
						end,
						options,
					);
					const endCandidates = makeCenterlineRectEdgeCandidates(
						end,
						reverseVector(forward),
						margin,
						shouldUseDynamicShape,
						shieldTargets,
						start,
						options,
					);
					const edgePairs = [];
					let order = 0;

					for (const startCandidate of startCandidates) {
						for (const endCandidate of endCandidates) {
							edgePairs.push({
								startEdge: startCandidate.edge,
								endEdge: endCandidate.edge,
								preferenceRank: startCandidate.preferenceRank + endCandidate.preferenceRank,
								order,
							});
							order += 1;
						}
					}

					const sortedEdgePairs = edgePairs.sort((first, second) => {
						if (first.preferenceRank !== second.preferenceRank) {
							return first.preferenceRank - second.preferenceRank;
						}

						return first.order - second.order;
					});

					return sortedEdgePairs;
				}

				function isCopperAreaObstacleTarget(target) {
					const type = target && target.type ? target.type : '';
					return Boolean(target && (
						target.sourceKind === 'polygon'
						|| type === 'Pour'
						|| type === 'Poured'
						|| type === 'Fill'
						|| type === 'Region'
					));
				}

				function isEdgeBlockingTarget(target) {
					return isCopperNodePrimitive(target) || isCopperAreaObstacleTarget(target);
				}

				function getPadEdgeShieldTargetKey(target) {
					const primitiveId = normalizeNetName(target && target.primitiveId);
					return primitiveId ? `id:${primitiveId}` : getTargetKey(target);
				}

				function makeRectEdgeShieldTargets(targets, obstacles = []) {
					const shieldTargets = [];
					const seen = new Set();
					const addShieldTarget = (target, requireBlockingTarget) => {
						if (!target || (requireBlockingTarget && !isEdgeBlockingTarget(target))) {
							return;
						}

						const key = getPadEdgeShieldTargetKey(target);
						if (seen.has(key)) {
							return;
						}

						seen.add(key);
						shieldTargets.push(target);
					};

					for (const target of Array.isArray(targets) ? targets : []) {
						addShieldTarget(target, false);
					}

					for (const obstacle of Array.isArray(obstacles) ? obstacles : []) {
						addShieldTarget(obstacle, true);
					}

					return shieldTargets;
				}

				function makeRectEdgeBlockingRecords(targets, margin, shouldUseDynamicShape, shieldTargets = [], blockerOptions = {}) {
					const edgeRecords = [];
					const blockedEdges = [];
					for (const target of Array.isArray(targets) ? targets : []) {
						const edges = getRectTargetEdges(target, margin, shouldUseDynamicShape);
						for (const edge of edges) {
							const blockers = getRectEdgeBlockers(edge, target, shieldTargets, {
								...blockerOptions,
								forwardScopeTarget: getSelectedSameNetForwardScopeTarget(target, edge, targets),
							});
							const record = {
								target,
								edge,
								blockers,
							};
							edgeRecords.push(record);

							if (blockers.length > 0) {
								blockedEdges.push(record);
							}
						}
					}

					return {
						edgeRecords,
						blockedEdges,
					};
				}

				function selectBoundaryEdgePairPasses(targets, margin, shouldUseDynamicShape, obstacles = []) {
					const shieldTargets = makeRectEdgeShieldTargets(targets, obstacles);
					const edgeBlockerOptions = makeStrictRectEdgeBlockerOptions(targets);
					const passes = [
						{
							name: 'strict',
						},
					].map(pass => ({
						...pass,
						edgePairs: makeOrderedRectEdgePairs(
							targets,
							margin,
							shouldUseDynamicShape,
							shieldTargets,
							{
								candidateLimit: 4,
								blockerOptions: edgeBlockerOptions,
							},
						),
					}));

					reportPadEdgeDiagnostic('Pad edge selection', {
						targets: summarizePadEdgeTargets(targets),
						shieldTargets: summarizePadEdgeCollection(shieldTargets),
						obstacleCount: Array.isArray(obstacles) ? obstacles.length : 0,
						edgeBlockerOptions: summarizeRectEdgeBlockerOptions(edgeBlockerOptions),
						passes: passes.map(pass => ({
							name: pass.name,
							edgePairCount: pass.edgePairs.length,
						})),
					});

					return passes;
				}

				function makeTwoRectTargetBoundary(
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours = [],
					edgePairPasses = [],
					selection = undefined,
				) {
					const targetKeySet = new Set((Array.isArray(targets) ? targets : []).map(getTargetKey));
					const shieldTargets = makeRectEdgeShieldTargets(targets, obstacles);
					const edgeBlockerOptions = makeStrictRectEdgeBlockerOptions(targets);
					const blockedEdgeData = makeRectEdgeBlockingRecords(
						targets,
						margin,
						shouldUseDynamicShape,
						shieldTargets,
						edgeBlockerOptions,
					);
					const blockedEdges = blockedEdgeData.blockedEdges;
					const obstacleBoxes = Array.isArray(obstacles)
						? obstacles
							.filter(obstacle => !targetKeySet.has(getTargetKey(obstacle)))
							.map((obstacle) => {
								try {
									return inflateObstacle(obstacle);
								}
								catch {
									return undefined;
								}
							})
							.filter(Boolean)
						: [];
					let recoverableCandidate;

					const passSummaries = [];
					for (const pass of edgePairPasses) {
						const passSummary = {
							pass: pass.name,
							edgePairCount: pass.edgePairs.length,
							obstacleBoxCount: obstacleBoxes.length,
							blockedEdgeCount: blockedEdges.length,
							rejectedCount: 0,
							rejectedSamples: [],
						};

						for (const edgePair of pass.edgePairs) {
							const candidate = makeTwoRectBoundaryFromEdges(edgePair.startEdge, edgePair.endEdge);
							const candidateInvalidReasons = getBoundaryPathInvalidReasons(candidate, targetKeepInContours);
							const avoidance = bendBoundaryAroundObstacles(candidate, obstacleBoxes);
							const avoidedPoints = cleanBoundaryPoints(avoidance.points);
							const bridgeSpan = getRectEdgeBridgeSpan(edgePair);
							const usedDirectShortBridgeFallback = shouldUseDirectShortBridgeFallback(
								candidate,
								avoidedPoints,
								avoidance,
								targetKeepInContours,
								bridgeSpan,
							);
							const selectedPoints = usedDirectShortBridgeFallback ? candidate : avoidedPoints;
							const selectedInvalidReasons = getBoundaryPathInvalidReasons(selectedPoints, targetKeepInContours);
							const blockedViolation = getFirstBlockedBoundaryViolation(selectedPoints, blockedEdges);
							const foreignNodeOverlap = getForeignCopperNodeOverlapSummary(
								selectedPoints,
								shieldTargets,
								targetKeySet,
								shouldUseDynamicShape,
							);
							const selectedSafetyReasons = [];
							if (blockedViolation) {
								selectedSafetyReasons.push(blockedViolation.reason || 'blocked-port-violation');
							}

							if (foreignNodeOverlap.overlapCount > 0) {
								selectedSafetyReasons.push('foreign-copper-node-overlap');
							}

							if (
								selectedSafetyReasons.length === 0
								&& isBoundaryPathValid(selectedPoints, targetKeepInContours)
							) {
								reportPadEdgeDiagnostic('Pad edge fallback selected', {
									pass: pass.name,
									edgePair: summarizeRectEdgePair(edgePair, targets),
									candidatePointCount: candidate.length,
									avoidedPointCount: avoidedPoints.length,
									selectedPointCount: selectedPoints.length,
									avoidedCount: avoidance.avoidedCount,
									unresolvedCount: avoidance.unresolvedCount,
									bridgeSpan: roundCoordinate(bridgeSpan),
									usedDirectShortBridgeFallback,
									blockedEdgeCount: blockedEdges.length,
									foreignNodeOverlap,
									rejectedBeforeSelection: passSummary.rejectedCount,
								});
								if (selection) {
									selection.twoTargetEdgeBoundary = true;
									selection.bridgeSpan = bridgeSpan;
									selection.edgePair = summarizeRectEdgePair(edgePair, targets);
									selection.twoTargetBlockedEdgeCount = blockedEdges.length;
									selection.twoTargetForeignNodeOverlap = foreignNodeOverlap;
								}
								return selectedPoints;
							}

							if (!recoverableCandidate
								&& selectedSafetyReasons.length === 0
								&& isBoundaryPathValidIgnoringNeck(selectedPoints, targetKeepInContours)) {
								recoverableCandidate = {
									points: selectedPoints,
									bridgeSpan,
									edgePair: summarizeRectEdgePair(edgePair, targets),
								};
							}

							passSummary.rejectedCount += 1;
							if (passSummary.rejectedSamples.length < 3) {
								passSummary.rejectedSamples.push({
									edgePair: summarizeRectEdgePair(edgePair, targets),
									candidatePointCount: candidate.length,
									avoidedPointCount: avoidedPoints.length,
									selectedPointCount: selectedPoints.length,
									avoidedCount: avoidance.avoidedCount,
									unresolvedCount: avoidance.unresolvedCount,
									bridgeSpan: roundCoordinate(bridgeSpan),
									usedDirectShortBridgeFallback,
									candidateInvalidReasons,
									selectedInvalidReasons,
									selectedSafetyReasons,
									blockedViolation: blockedViolation
										? {
											reason: blockedViolation.reason,
											edge: getRectEdgeDebugSummary(
												blockedViolation.record.edge,
												blockedViolation.record.target,
											),
										}
										: undefined,
									foreignNodeOverlap,
									avoidedObstacles: avoidance.avoidedObstacles,
									unresolvedObstacles: avoidance.unresolvedObstacles,
								});
							}
						}

						passSummaries.push(passSummary);
					}

					reportPadEdgeDiagnostic('Pad edge boundary candidates exhausted', {
						targets: summarizePadEdgeTargets(targets),
						passSummaries,
					});
					if (recoverableCandidate && selection) {
						selection.twoTargetEdgeBoundary = true;
						selection.bridgeSpan = recoverableCandidate.bridgeSpan;
						selection.edgePair = recoverableCandidate.edgePair;
						selection.twoTargetBlockedEdgeCount = blockedEdges.length;
					}
					return recoverableCandidate && recoverableCandidate.points;
				}

				function isTwoRectTargetSet(targets, shouldUseDynamicShape) {
					return targets.length === 2
						&& shouldUseDynamicShape
						&& targets.every(target => getBoundaryShapeKind(target) === 'rect');
				}

				function getRectEdgeFilterSourceTargetResult(targets, shouldUseDynamicShape) {
					const sources = [];
					for (const target of Array.isArray(targets) ? targets : []) {
						if (!target) {
							continue;
						}

						if (!shouldUseDynamicShape || getBoundaryShapeKind(target) !== 'rect') {
							return {
								sourceTargets: [],
								skipReason: 'non-rect-source-target',
								nonRectTarget: summarizePadEdgeTarget(target),
							};
						}

						sources.push(target);
					}

					return {
						sourceTargets: dedupeTargets(sources),
					};
				}

				function getRectEdgeFilterBlockerTargets(sourceTargets, obstacles = []) {
					const blockers = [];
					for (const sourceTarget of Array.isArray(sourceTargets) ? sourceTargets : []) {
						blockers.push(sourceTarget);
					}

					for (const obstacle of Array.isArray(obstacles) ? obstacles : []) {
						if (isEdgeBlockingTarget(obstacle)) {
							blockers.push(obstacle);
						}
					}

					return dedupeTargets(blockers);
				}

				function resolveRequiresStrictEdgeBoundary(boundaryTargets, shouldUseDynamicShape, boundarySelection) {
					if (boundarySelection && boundarySelection.twoTargetEdgeBoundary) {
						return true;
					}

					return isTwoRectTargetSet(boundaryTargets, shouldUseDynamicShape);
				}

				function summarizeBlockedRectEdge(record) {
					return {
						target: summarizePadEdgeTarget(record.target),
						edge: getRectEdgeDebugSummary(record.edge, record.target),
						blockers: record.blockers,
					};
				}

				function boundarySegmentMatchesRectEdge(start, end, edge) {
					return (pointKey(start) === pointKey(edge.start) && pointKey(end) === pointKey(edge.end))
						|| (pointKey(start) === pointKey(edge.end) && pointKey(end) === pointKey(edge.start));
				}

				function pointIsInsideRectEdge(point, edge) {
					return pointOnSegment(point, edge.start, edge.end)
						&& pointKey(point) !== pointKey(edge.start)
						&& pointKey(point) !== pointKey(edge.end);
				}

				function getBlockedEdgeInteriorContactDetails(start, end, edge) {
					const interiorPoint = pointIsInsideRectEdge(start, edge)
						? start
						: (pointIsInsideRectEdge(end, edge) ? end : undefined);
					if (interiorPoint) {
						return {
							reason: 'blocked-edge-interior-contact',
							point: interiorPoint,
						};
					}

					if (segmentsIntersect(start, end, edge.start, edge.end)
						&& !segmentsShareEndpoint(start, end, edge.start, edge.end)) {
						return { reason: 'blocked-edge-interior-crossing' };
					}

					return undefined;
				}

				function pathUsesBlockedRectEdge(path, edge) {
					if (!Array.isArray(path) || path.length < 2) {
						return false;
					}

					for (let index = 0; index < path.length - 1; index += 1) {
						if (boundarySegmentMatchesRectEdge(path[index], path[index + 1], edge)) {
							return true;
						}
					}

					return false;
				}

				function getBlockedRectEdgeKey(record) {
					const edge = record && record.edge;
					if (!edge) {
						return '';
					}

					return [
						getTargetKey(record.target),
						edge.label,
						pointKey(edge.start),
						pointKey(edge.end),
					].join(':');
				}

				function getBlockedEdgeBoundaryUsage(boundary, blockedEdges) {
					const usageByEdgeKey = new Map();
					const records = Array.isArray(blockedEdges) ? blockedEdges : [];
					const points = Array.isArray(boundary) ? boundary : [];

					for (const record of records) {
						const key = getBlockedRectEdgeKey(record);
						if (!key) {
							continue;
						}

						usageByEdgeKey.set(key, {
							record,
							blockedEdgeSegmentCount: 0,
							blockedEdgeInteriorContactCount: 0,
							blockedPortExits: [],
						});
					}

					if (points.length < 3) {
						return usageByEdgeKey;
					}

					for (let index = 0; index < points.length; index += 1) {
						const current = points[index];
						const previous = points[(index - 1 + points.length) % points.length];
						const next = points[(index + 1) % points.length];

						for (const usage of usageByEdgeKey.values()) {
							const { edge } = usage.record;
							if (boundarySegmentMatchesRectEdge(current, next, edge)) {
								usage.blockedEdgeSegmentCount += 1;
							}

							if (getBlockedEdgeInteriorContactDetails(current, next, edge)) {
								usage.blockedEdgeInteriorContactCount += 1;
							}

							for (const portExit of [
								{ neighbor: previous, direction: 'previous' },
								{ neighbor: next, direction: 'next' },
							]) {
								const exit = getBlockedPortExitDetails(current, portExit.neighbor, edge);
								if (!exit) {
									continue;
								}

								usage.blockedPortExits.push({
									point: current,
									direction: portExit.direction,
									tangentDot: exit.tangentDot,
									outwardDot: exit.outwardDot,
								});
							}
						}
					}

					return usageByEdgeKey;
				}

				function summarizeBlockedEdgeBoundaryUsage(usageByEdgeKey) {
					let blockedEdgeSegmentCount = 0;
					let blockedEdgeInteriorContactCount = 0;
					let blockedPortExitCount = 0;
					for (const usage of usageByEdgeKey.values()) {
						blockedEdgeSegmentCount += usage.blockedEdgeSegmentCount;
						blockedEdgeInteriorContactCount += usage.blockedEdgeInteriorContactCount;
						blockedPortExitCount += usage.blockedPortExits.length;
					}

					return {
						blockedEdgeSegmentCount,
						blockedEdgeInteriorContactCount,
						blockedPortExitCount,
						totalCount: blockedEdgeInteriorContactCount
							+ blockedPortExitCount,
					};
				}

				function getRectSourceContourCorners(sourceTargets, edgeRecords) {
					const cornersByTarget = new Map();
					for (const record of edgeRecords) {
						const targetKey = getTargetKey(record.target);
						if (cornersByTarget.has(targetKey)) {
							continue;
						}

						cornersByTarget.set(targetKey, record.edge.corners);
					}

					return uniquePoints(sourceTargets.flatMap((target) => {
						const corners = cornersByTarget.get(getTargetKey(target));
						return Array.isArray(corners) ? corners : [];
					}));
				}

				function getRectCornerIndex(corners, point) {
					return Array.isArray(corners)
						? corners.findIndex(corner => pointKey(corner) === pointKey(point))
						: -1;
				}

				function getBlockedEdgeEndpointIndex(edge, point) {
					const cornerIndex = getRectCornerIndex(edge.corners, point);
					return cornerIndex === edge.startIndex || cornerIndex === edge.endIndex
						? cornerIndex
						: -1;
				}

				function getBlockedPortExitDetails(point, neighbor, edge) {
					const endpointIndex = getBlockedEdgeEndpointIndex(edge, point);
					if (endpointIndex < 0) {
						return undefined;
					}

					const direction = normalizeVector({
						x: neighbor.x - point.x,
						y: neighbor.y - point.y,
					});
					if (vectorLength(direction) <= 0) {
						return undefined;
					}

					const tangentTarget = endpointIndex === edge.startIndex ? edge.end : edge.start;
					const tangent = normalizeVector({
						x: tangentTarget.x - point.x,
						y: tangentTarget.y - point.y,
					});
					const tangentDot = dotProduct(direction, tangent);
					const outwardDot = dotProduct(direction, edge.outward);

					// The corner is rejected only for this directed exit, so its other boundary edge stays usable.
					return tangentDot > 0.05 && outwardDot > 0.05
						? { endpointIndex, tangentDot, outwardDot }
						: undefined;
				}

				function getFirstBlockedBoundaryViolation(boundary, blockedEdges) {
					for (let index = 0; index < boundary.length; index += 1) {
						const start = boundary[index];
						const end = boundary[(index + 1) % boundary.length];

						for (const record of blockedEdges) {
							const { edge } = record;
							const contact = getBlockedEdgeInteriorContactDetails(start, end, edge);
							if (contact) {
								return {
									edgeIndex: index,
									record,
									...contact,
								};
							}

							const exit = getBlockedPortExitDetails(start, end, edge);
							if (exit) {
								return {
									edgeIndex: index,
									record,
									reason: 'blocked-port-exit',
									...exit,
								};
							}

							const entry = getBlockedPortExitDetails(end, start, edge);
							if (entry) {
								return {
									edgeIndex: index,
									record,
									reason: 'blocked-port-entry',
									...entry,
								};
							}
						}
					}

					return undefined;
				}

				function getBoundaryGeometryInvalidReasons(points) {
					return getBoundaryPathInvalidReasons(points, [])
						.filter(reason => reason !== 'narrow-neck'
							&& reason !== 'missing-target-coverage');
				}

				function getHardBoundaryInvalidReasons(points) {
					return getBoundaryGeometryInvalidReasons(points);
				}

				function mergeBoundaryPolygons(boundaryList, targetKeepInContours = []) {
					const union = getPolygonClippingUnion();
					if (!union) {
						return undefined;
					}

					const geometries = (boundaryList || [])
						.map(points => cleanBoundaryPoints(points))
						.map(points => makeClipRingFromPoints(points))
						.filter(ring => ring.length >= 4)
						.map(ring => [[ring]]);
					if (geometries.length === 0) {
						return undefined;
					}

					try {
						const geometry = union(...geometries);
						let best;
						let bestAny;
						const allMergedPoints = [];
						for (const polygon of flattenValidClipGeometry(geometry)) {
							const merged = cleanBoundaryPoints(makePointsFromClipRing(polygon[0]));
							if (merged.length < 3 || getHardBoundaryInvalidReasons(merged).length > 0) {
								continue;
							}

							allMergedPoints.push(...merged);
							const area = Math.abs(polygonSignedArea(merged));
							const coversKeepIn = targetKeepInContours.length === 0
								|| polygonCoversTargetContours(merged, targetKeepInContours);
							if (coversKeepIn && (!best || area > best.area)) {
								best = { points: merged, area };
							}

							if (!bestAny || area > bestAny.area) {
								bestAny = { points: merged, area };
							}
						}

						if (best) {
							return best;
						}

						if (bestAny) {
							return bestAny;
						}

						if (allMergedPoints.length >= 3) {
							const hull = cleanBoundaryPoints(convexHull(allMergedPoints));
							if (hull.length >= 3
								&& getHardBoundaryInvalidReasons(hull).length === 0
								&& (targetKeepInContours.length === 0 || polygonCoversTargetContours(hull, targetKeepInContours))) {
								return { points: hull, area: Math.abs(polygonSignedArea(hull)) };
							}
						}

						return undefined;
					}
					catch (err) {
						logWarn('Boundary polygon union failed:', err);
						return undefined;
					}
				}

				function mergeBoundaryWithTargetKeepIns(boundary, targetKeepInContours = []) {
					const points = cleanBoundaryPoints(boundary);
					const targetGeometries = makeClipGeometriesFromContours(targetKeepInContours);
					if (points.length < 3 || targetGeometries.length === 0) {
						return points.length >= 3 ? { points } : undefined;
					}

					const union = getPolygonClippingUnion();
					const boundaryRing = makeClipRingFromPoints(points);
					if (!union || boundaryRing.length < 4) {
						logWarn('Constrained keep-in merge is unavailable');
						return undefined;
					}

					try {
						const geometry = union([[boundaryRing]], ...targetGeometries);
						let best;
						for (const polygon of flattenValidClipGeometry(geometry)) {
							const merged = cleanBoundaryPoints(makePointsFromClipRing(polygon[0]));
							if (merged.length < 3 || getHardBoundaryInvalidReasons(merged).length > 0) {
								continue;
							}

							if (!polygonCoversTargetContours(merged, targetKeepInContours)) {
								continue;
							}

							const area = Math.abs(polygonSignedArea(merged));
							if (!best || area > best.area) {
								best = { points: merged, area };
							}
						}

						return best;
					}
					catch (err) {
						logWarn('Failed to merge constrained boundary keep-ins:', err);
						return undefined;
					}
				}

				function getBlockedBoundaryScore(boundary, blockedEdges) {
					return summarizeBlockedEdgeBoundaryUsage(
						getBlockedEdgeBoundaryUsage(boundary, blockedEdges),
					).totalCount;
				}

				function makeReverseCornerPath(corners, fromIndex, toIndex) {
					const path = [];
					let index = fromIndex;

					while (true) {
						path.push(corners[index]);
						if (index === toIndex) {
							break;
						}
						index = (index - 1 + corners.length) % corners.length;
					}

					return path;
				}

				function getCornerPathVariants(corners, fromIndex, toIndex) {
					const variants = [
						makeCornerPath(corners, fromIndex, toIndex),
						makeReverseCornerPath(corners, fromIndex, toIndex),
					];
					const seen = new Set();

					return variants.filter((path) => {
						const key = path.map(pointKey).join('>');
						if (seen.has(key)) {
							return false;
						}
						seen.add(key);
						return true;
					});
				}

				function replaceBoundarySegmentWithPath(boundary, edgeIndex, path, replacedPointCount = 2) {
					const rotatedBoundary = [
						...boundary.slice(edgeIndex),
						...boundary.slice(0, edgeIndex),
					];
					return cleanBoundaryPoints([
						...path,
						...rotatedBoundary.slice(replacedPointCount),
					]);
				}

				function getBlockedPortRoutePaths(boundary, violation) {
					const corners = violation && violation.record && violation.record.edge
						? violation.record.edge.corners
						: [];
					if (!Array.isArray(corners) || corners.length !== 4) {
						return [];
					}

					const start = boundary[violation.edgeIndex];
					const end = boundary[(violation.edgeIndex + 1) % boundary.length];
					const startIndex = getBlockedEdgeEndpointIndex(violation.record.edge, start);
					const endIndex = getBlockedEdgeEndpointIndex(violation.record.edge, end);
					const routes = [];
					const addRoute = (path, replacedPointCount = 2) => {
						if (pathUsesBlockedRectEdge(path, violation.record.edge)) {
							return;
						}
						routes.push({ path, replacedPointCount });
					};

					if (violation.reason === 'blocked-port-exit') {
						if (startIndex < 0) {
							return [];
						}
						for (let cornerIndex = 0; cornerIndex < corners.length; cornerIndex += 1) {
							if (cornerIndex === startIndex) {
								continue;
							}
							for (const cornerPath of getCornerPathVariants(corners, startIndex, cornerIndex)) {
								addRoute([...cornerPath, end]);
							}
						}
					}
					else if (violation.reason === 'blocked-port-entry') {
						if (endIndex < 0) {
							return [];
						}
						for (let cornerIndex = 0; cornerIndex < corners.length; cornerIndex += 1) {
							if (cornerIndex === endIndex) {
								continue;
							}
							for (const cornerPath of getCornerPathVariants(corners, cornerIndex, endIndex)) {
								addRoute([start, ...cornerPath]);
								addRoute([start, ...cornerPath], 3);
							}
						}

						const next = boundary[(violation.edgeIndex + 2) % boundary.length];
						const nextIndex = getRectCornerIndex(corners, next);
						if (nextIndex >= 0) {
							for (let cornerIndex = 0; cornerIndex < corners.length; cornerIndex += 1) {
								if (cornerIndex === endIndex) {
									continue;
								}
								for (const cornerPath of getCornerPathVariants(corners, cornerIndex, nextIndex)) {
									addRoute([start, ...cornerPath], 3);
								}
							}
						}
					}

					const seen = new Set();
					return routes.filter((route) => {
						const key = `${route.replacedPointCount}:${route.path.map(pointKey).join('>')}`;
						if (seen.has(key)) {
							return false;
						}
						seen.add(key);
						return true;
					});
				}

				function chooseBlockedPortRoute(boundary, violation, blockedEdges, targetKeepInContours = []) {
					const currentScore = getBlockedBoundaryScore(boundary, blockedEdges);
					let best;

					for (const route of getBlockedPortRoutePaths(boundary, violation)) {
						const routedBoundary = replaceBoundarySegmentWithPath(
							boundary,
							violation.edgeIndex,
							route.path,
							route.replacedPointCount,
						);
						const mergedCandidate = mergeBoundaryWithTargetKeepIns(
							routedBoundary,
							targetKeepInContours,
						);
						const candidateBoundary = mergedCandidate && mergedCandidate.points;
						if (!candidateBoundary
							|| candidateBoundary.length < 3
							|| polygonHasSelfIntersection(candidateBoundary)) {
							continue;
						}

						if (getHardBoundaryInvalidReasons(candidateBoundary).length > 0) {
							continue;
						}

						const candidateUsage = summarizeBlockedEdgeBoundaryUsage(
							getBlockedEdgeBoundaryUsage(candidateBoundary, blockedEdges),
						);
						if (candidateUsage.blockedEdgeInteriorContactCount > 0
							|| candidateUsage.totalCount >= currentScore) {
							continue;
						}

						const coversTargets = polygonCoversTargetContours(candidateBoundary, targetKeepInContours);
						if (!coversTargets) {
							continue;
						}
						const area = Math.abs(polygonSignedArea(candidateBoundary));
						if (!best
							|| candidateUsage.totalCount < best.score
							|| (candidateUsage.totalCount === best.score && area > best.area)) {
							best = {
								boundary: candidateBoundary,
								path: route.path,
								replacedPointCount: route.replacedPointCount,
								score: candidateUsage.totalCount,
								area,
							};
						}
					}

					return best;
				}

				function makeEdgeFilteredConstrainedEnvelopeData(
					sourceTargets,
					edgeRecords,
					blockedEdges,
					targetKeepInContours = [],
				) {
					const allCorners = getRectSourceContourCorners(sourceTargets, edgeRecords);
					const initialBoundary = cleanBoundaryPoints(convexHull(allCorners));
					let boundary = initialBoundary;
					const repairs = [];
					let constraintUnresolvedReason;

					for (
						let iteration = 0;
						!constraintUnresolvedReason && iteration < Math.max(4, blockedEdges.length * 4);
						iteration += 1
					) {
						const violation = getFirstBlockedBoundaryViolation(boundary, blockedEdges);
						if (!violation) {
							break;
						}

						const route = chooseBlockedPortRoute(
							boundary,
							violation,
							blockedEdges,
							targetKeepInContours,
						);
						if (!route) {
							constraintUnresolvedReason = 'blocked-port-constraint-unresolved';
							break;
						}

						boundary = route.boundary;
						repairs.push({
							reason: violation.reason,
							edge: getRectEdgeDebugSummary(violation.record.edge, violation.record.target),
							route: route.path.map(pointKey),
							replacedPointCount: route.replacedPointCount,
						});
					}

					const finalViolation = !constraintUnresolvedReason
						? getFirstBlockedBoundaryViolation(boundary, blockedEdges)
						: undefined;
					if (finalViolation) {
						constraintUnresolvedReason = 'blocked-port-remains';
					}

					const finalKeepInMerge = mergeBoundaryWithTargetKeepIns(boundary, targetKeepInContours);
					const resultBoundary = cleanBoundaryPoints(finalKeepInMerge ? finalKeepInMerge.points : boundary);
					const resultBlockedViolation = getFirstBlockedBoundaryViolation(resultBoundary, blockedEdges);
					if (!constraintUnresolvedReason && resultBlockedViolation) {
						constraintUnresolvedReason = 'blocked-boundary-remains-after-keep-in-merge';
					}
					const resultInvalidReasons = getBoundaryPathInvalidReasons(resultBoundary, targetKeepInContours);
					const resultHardInvalidReasons = getHardBoundaryInvalidReasons(resultBoundary);
					const keepInMergeUnresolved = !finalKeepInMerge
						|| resultInvalidReasons.indexOf('missing-target-coverage') >= 0;
					const unresolvedReason = resultBoundary.length < 3 || resultHardInvalidReasons.length > 0
						? 'constrained-envelope-invalid'
						: (keepInMergeUnresolved ? 'keep-in-invariant-unresolved' : undefined);
					const blockedUsage = summarizeBlockedEdgeBoundaryUsage(
						getBlockedEdgeBoundaryUsage(resultBoundary, blockedEdges),
					);

					return {
						points: resultBoundary,
						mode: unresolvedReason
							? 'constrained-envelope-unresolved'
							: (constraintUnresolvedReason
								? 'constrained-envelope-partial'
								: 'constrained-envelope-repaired'),
						initialPointCount: initialBoundary.length,
						resultInvalidReasons,
						resultHardInvalidReasons,
						keepInMergeUnresolved,
						blockedUsage,
						resultBlockedViolation,
						repairCount: repairs.length,
						repairs,
						constraintUnresolvedReason,
						unresolvedReason,
						blockedEdges,
					};
				}

				function makeEdgeFilteredRectSupportBoundary(
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles = [],
					targetKeepInContours = [],
					selection = undefined,
				) {
					const result = getRectEdgeFilterSourceTargetResult(targets, shouldUseDynamicShape);
					const sourceTargets = result.sourceTargets || [];
					if (sourceTargets.length <= 1) {
						reportPadEdgeDiagnostic('Multi-pad edge-filtered boundary skipped', {
							reason: result.skipReason || 'not-enough-rect-source-targets',
							targetCount: Array.isArray(targets) ? targets.length : 0,
							sourceTargetCount: sourceTargets.length,
							nonRectTarget: result.nonRectTarget,
							targets: summarizePadEdgeTargets(targets),
						});
						return undefined;
					}

					const blockerTargets = getRectEdgeFilterBlockerTargets(sourceTargets, obstacles);
					const siblingBlockerOptions = {
						forwardGapLimit: Math.max(EDGE_BLOCK_FORWARD_GAP, EDGE_BLOCK_FORWARD_SEARCH_MARGIN),
						forwardOverlapTolerance: EDGE_BLOCK_FORWARD_GAP,
						allowForwardOverlap: true,
						shouldIgnoreShieldTarget: (target, shieldTarget) =>
							shouldIgnoreSelectedSameNetShieldTarget(target, shieldTarget, sourceTargets),
					};
					const keptEdges = [];
					const blockedEdges = [];
					const edgeRecords = [];
					for (const sourceTarget of sourceTargets) {
						const edges = getRectTargetEdges(sourceTarget, margin, shouldUseDynamicShape);
						for (const edge of edges) {
							const blockers = getRectEdgeBlockers(edge, sourceTarget, blockerTargets, {
								...siblingBlockerOptions,
								forwardScopeTarget: getSelectedSameNetForwardScopeTarget(sourceTarget, edge, sourceTargets),
							});
							const record = {
								target: sourceTarget,
								edge,
								blockers,
							};
							edgeRecords.push(record);

							if (blockers.length > 0) {
								blockedEdges.push(record);
							}
							else {
								keptEdges.push(record);
							}
						}
					}

					if (blockedEdges.length === 0) {
						reportPadEdgeDiagnostic('Multi-pad edge-filtered boundary skipped', {
							reason: 'no-blocked-source-edges',
							sourceTargetCount: sourceTargets.length,
							blockerTargetCount: blockerTargets.length,
							siblingBlockerOptions,
							keptEdgeCount: keptEdges.length,
							internalBlockedEdgeCount: blockedEdges.length,
							sourceTargets: summarizePadEdgeTargets(sourceTargets),
							blockerTargets: summarizePadEdgeCollection(blockerTargets),
						});
						return undefined;
					}

					const constrainedEnvelopeData = makeEdgeFilteredConstrainedEnvelopeData(
						sourceTargets,
						edgeRecords,
						blockedEdges,
						targetKeepInContours,
					);
					const boundaryResult = {
						points: constrainedEnvelopeData.points,
						mode: constrainedEnvelopeData.mode,
						initialPointCount: constrainedEnvelopeData.initialPointCount,
						resultInvalidReasons: constrainedEnvelopeData.resultInvalidReasons,
						resultHardInvalidReasons: constrainedEnvelopeData.resultHardInvalidReasons,
						blockedUsage: constrainedEnvelopeData.blockedUsage,
						resultBlockedViolation: constrainedEnvelopeData.resultBlockedViolation,
						repairCount: constrainedEnvelopeData.repairCount,
						repairs: constrainedEnvelopeData.repairs,
						constraintUnresolvedReason: constrainedEnvelopeData.constraintUnresolvedReason,
						unresolvedReason: constrainedEnvelopeData.unresolvedReason,
						keepInMergeUnresolved: constrainedEnvelopeData.keepInMergeUnresolved,
						blockedEdges: constrainedEnvelopeData.blockedEdges,
					};
					const boundary = cleanBoundaryPoints(boundaryResult.points);
					const rawInvalidReasons = getBoundaryPathInvalidReasons(boundary, []);
					const selectedBoundary = boundary;
					const invalidReasons = getBoundaryPathInvalidReasons(selectedBoundary, targetKeepInContours);
					const summary = {
						sourceTargetCount: sourceTargets.length,
						blockerTargetCount: blockerTargets.length,
						siblingBlockerOptions,
						keptEdgeCount: keptEdges.length,
						internalBlockedEdgeCount: blockedEdges.length,
						edgeRecordCount: edgeRecords.length,
						boundaryMode: boundaryResult.mode,
						initialPointCount: boundaryResult.initialPointCount,
						resultInvalidReasons: boundaryResult.resultInvalidReasons,
						resultHardInvalidReasons: boundaryResult.resultHardInvalidReasons,
						blockedUsage: boundaryResult.blockedUsage,
						resultBlockedViolation: boundaryResult.resultBlockedViolation
							? {
								reason: boundaryResult.resultBlockedViolation.reason,
								edge: getRectEdgeDebugSummary(
									boundaryResult.resultBlockedViolation.record.edge,
									boundaryResult.resultBlockedViolation.record.target,
								),
							}
							: undefined,
						repairCount: boundaryResult.repairCount,
						repairs: boundaryResult.repairs,
						constraintUnresolvedReason: boundaryResult.constraintUnresolvedReason,
						unresolvedReason: boundaryResult.unresolvedReason,
						keepInMergeUnresolved: boundaryResult.keepInMergeUnresolved,
						boundaryPointCount: boundary.length,
						selectedBoundaryPointCount: selectedBoundary.length,
						rawInvalidReasons,
						invalidReasons,
						blockedSamples: blockedEdges.slice(0, 6).map(summarizeBlockedRectEdge),
						keptSamples: keptEdges.slice(0, 6).map(record => ({
							target: summarizePadEdgeTarget(record.target),
							edge: getRectEdgeDebugSummary(record.edge, record.target),
						})),
					};

					reportPadEdgeDiagnostic('Multi-pad edge-filtered boundary', summary);

					const isPartialEnvelope = Boolean(
						boundaryResult.constraintUnresolvedReason
						|| boundaryResult.unresolvedReason
						|| boundaryResult.resultBlockedViolation
						|| boundaryResult.mode === 'constrained-envelope-partial'
						|| boundaryResult.mode === 'constrained-envelope-unresolved',
					);

					if (selection) {
						selection.multiPadEdgeFilter = summary;
						if (isPartialEnvelope) {
							selection.multiPadEdgeFilterPartial = true;
						}
						else {
							selection.multiPadEdgeBoundaryRequired = true;
						}
					}

					if (isPartialEnvelope) {
						logWarn('Multi-pad constrained envelope is partial; falling back to bridged boundary:', {
							boundaryMode: boundaryResult.mode,
							constraintUnresolvedReason: boundaryResult.constraintUnresolvedReason,
							unresolvedReason: boundaryResult.unresolvedReason,
							repairCount: boundaryResult.repairCount,
						});
						return undefined;
					}

					return selectedBoundary.length >= 3 ? selectedBoundary : undefined;
				}

				function getMultiPadLayoutNeighborRadius(sourceTargets, shouldUseDynamicShape) {
					let totalDiagonal = 0;
					let minimumPairDistance = Number.POSITIVE_INFINITY;
					for (let index = 0; index < sourceTargets.length; index += 1) {
						const target = sourceTargets[index];
						const { halfWidth, halfHeight } = getTargetHalfSize(target, shouldUseDynamicShape);
						totalDiagonal += Math.hypot(halfWidth, halfHeight) * 2;
						for (let otherIndex = index + 1; otherIndex < sourceTargets.length; otherIndex += 1) {
							minimumPairDistance = Math.min(
								minimumPairDistance,
								distance(target, sourceTargets[otherIndex]),
							);
						}
					}

					const averageDiagonal = totalDiagonal / Math.max(sourceTargets.length, 1);
					return Math.max(averageDiagonal * 1.75, minimumPairDistance * 0.85, 1);
				}

				function getMultiPadNeighborGraphDegrees(sourceTargets, neighborRadius) {
					const degrees = new Array(sourceTargets.length).fill(0);
					for (let index = 0; index < sourceTargets.length; index += 1) {
						for (let otherIndex = index + 1; otherIndex < sourceTargets.length; otherIndex += 1) {
							if (distance(sourceTargets[index], sourceTargets[otherIndex]) <= neighborRadius) {
								degrees[index] += 1;
								degrees[otherIndex] += 1;
							}
						}
					}

					return degrees;
				}

				function countMultiPadNeighborGraphComponents(sourceTargets, neighborRadius) {
					if (!Array.isArray(sourceTargets) || sourceTargets.length === 0) {
						return 0;
					}

					const visited = new Array(sourceTargets.length).fill(false);
					let componentCount = 0;

					const visit = (index) => {
						visited[index] = true;
						for (let otherIndex = 0; otherIndex < sourceTargets.length; otherIndex += 1) {
							if (visited[otherIndex]) {
								continue;
							}

							if (distance(sourceTargets[index], sourceTargets[otherIndex]) <= neighborRadius) {
								visit(otherIndex);
							}
						}
					};

					for (let index = 0; index < sourceTargets.length; index += 1) {
						if (visited[index]) {
							continue;
						}

						componentCount += 1;
						visit(index);
					}

					return componentCount;
				}

				function isOpenChainMultiPadLayout(degrees, sourceTargets, neighborRadius) {
					if (!Array.isArray(degrees) || degrees.length < 3) {
						return false;
					}

					if (Math.min(...degrees) === 0) {
						return true;
					}

					return countMultiPadNeighborGraphComponents(sourceTargets, neighborRadius) > 1;
				}

				const MULTI_PAD_L_BEND_ANGLE_MIN_DEGREES = 70;
				const MULTI_PAD_L_BEND_ANGLE_MAX_DEGREES = 120;

				function computeChainVertexAngleDegrees(previous, vertex, next) {
					const towardPreviousX = previous.x - vertex.x;
					const towardPreviousY = previous.y - vertex.y;
					const towardNextX = next.x - vertex.x;
					const towardNextY = next.y - vertex.y;
					const previousLength = Math.hypot(towardPreviousX, towardPreviousY);
					const nextLength = Math.hypot(towardNextX, towardNextY);
					if (previousLength <= 0.001 || nextLength <= 0.001) {
						return undefined;
					}

					const cosine = Math.min(
						1,
						Math.max(
							-1,
							((towardPreviousX * towardNextX) + (towardPreviousY * towardNextY))
								/ (previousLength * nextLength),
						),
					);

					return Math.acos(cosine) * (180 / Math.PI);
				}

				function getMultiPadChainBendAngle(sourceTargets, shouldUseDynamicShape) {
					if (!Array.isArray(sourceTargets) || sourceTargets.length < 3) {
						return undefined;
					}

					const ordered = orderTargetsForBridgingChain(sourceTargets);
					if (!Array.isArray(ordered) || ordered.length < 3) {
						return undefined;
					}

					let minimumInteriorAngle = Number.POSITIVE_INFINITY;
					for (let index = 1; index < ordered.length - 1; index += 1) {
						const angle = computeChainVertexAngleDegrees(
							ordered[index - 1],
							ordered[index],
							ordered[index + 1],
						);
						if (Number.isFinite(angle)) {
							minimumInteriorAngle = Math.min(minimumInteriorAngle, angle);
						}
					}

					return Number.isFinite(minimumInteriorAngle) && minimumInteriorAngle < Number.POSITIVE_INFINITY
						? minimumInteriorAngle
						: undefined;
				}

				function isMultiPadLBendAngle(chainBendAngle) {
					return Number.isFinite(chainBendAngle)
						&& chainBendAngle >= MULTI_PAD_L_BEND_ANGLE_MIN_DEGREES
						&& chainBendAngle <= MULTI_PAD_L_BEND_ANGLE_MAX_DEGREES;
				}

				function isMultiPadArcBendAngle(chainBendAngle) {
					return Number.isFinite(chainBendAngle)
						&& (chainBendAngle > MULTI_PAD_L_BEND_ANGLE_MAX_DEGREES
							|| chainBendAngle < MULTI_PAD_L_BEND_ANGLE_MIN_DEGREES);
				}

				function areMultiPadCentersCollinear(sourceTargets, shouldUseDynamicShape) {
					if (!Array.isArray(sourceTargets) || sourceTargets.length < 3) {
						return false;
					}

					const bounds = calculateTargetBounds(sourceTargets, shouldUseDynamicShape);
					const width = bounds.maxX - bounds.minX;
					const height = bounds.maxY - bounds.minY;
					const isHorizontalMajor = width >= height;
					const averageCenter = {
						x: sourceTargets.reduce((sum, target) => sum + target.x, 0) / sourceTargets.length,
						y: sourceTargets.reduce((sum, target) => sum + target.y, 0) / sourceTargets.length,
					};
					const axisStart = isHorizontalMajor
						? { x: bounds.minX, y: averageCenter.y }
						: { x: averageCenter.x, y: bounds.minY };
					const axisEnd = isHorizontalMajor
						? { x: bounds.maxX, y: averageCenter.y }
						: { x: averageCenter.x, y: bounds.maxY };

					let averageHalfSize = 0;
					let maximumPerpendicularDistance = 0;
					for (const target of sourceTargets) {
						const { halfWidth, halfHeight } = getTargetHalfSize(target, shouldUseDynamicShape);
						averageHalfSize += Math.max(halfWidth, halfHeight);
						maximumPerpendicularDistance = Math.max(
							maximumPerpendicularDistance,
							pointToSegmentDistance(target, axisStart, axisEnd),
						);
					}

					averageHalfSize /= sourceTargets.length;
					return maximumPerpendicularDistance <= averageHalfSize * 0.6;
				}

				function classifyMultiPadLayout(sourceTargets, shouldUseDynamicShape) {
					const padCount = Array.isArray(sourceTargets) ? sourceTargets.length : 0;
					if (padCount <= 1) {
						return {
							strategy: 'bridge',
							layoutClass: 'single',
							metrics: { padCount },
						};
					}

					if (padCount === 2) {
						return {
							strategy: 'bridge',
							layoutClass: 'pair',
							metrics: { padCount },
						};
					}

					const bounds = calculateTargetBounds(sourceTargets, shouldUseDynamicShape);
					const width = Math.max(bounds.maxX - bounds.minX, 0.001);
					const height = Math.max(bounds.maxY - bounds.minY, 0.001);
					const aspect = Math.max(width, height) / Math.min(width, height);
					const neighborRadius = getMultiPadLayoutNeighborRadius(sourceTargets, shouldUseDynamicShape);
					const degrees = getMultiPadNeighborGraphDegrees(sourceTargets, neighborRadius);
					const maxDegree = Math.max(...degrees);
					const minDegree = Math.min(...degrees);
					const neighborComponentCount = countMultiPadNeighborGraphComponents(
						sourceTargets,
						neighborRadius,
					);
					const collinear = areMultiPadCentersCollinear(sourceTargets, shouldUseDynamicShape);
					const openChainTopology = isOpenChainMultiPadLayout(
						degrees,
						sourceTargets,
						neighborRadius,
					);
					const chainBendAngle = getMultiPadChainBendAngle(sourceTargets, shouldUseDynamicShape);
					const metrics = {
						padCount,
						aspect: roundCoordinate(aspect),
						maxDegree,
						minDegree,
						neighborComponentCount,
						neighborRadius: roundCoordinate(neighborRadius),
						collinear,
						openChainTopology,
						chainBendAngle: Number.isFinite(chainBendAngle)
							? roundCoordinate(chainBendAngle)
							: undefined,
						elongation: roundCoordinate(aspect),
					};

					if (collinear) {
						return { strategy: 'bridge', layoutClass: 'chain-collinear', metrics };
					}

					if (maxDegree >= 3) {
						return { strategy: 'envelope', layoutClass: 'cluster-hub', metrics };
					}

					if (aspect <= 1.8 && padCount >= 4) {
						return { strategy: 'envelope', layoutClass: 'cluster-grid', metrics };
					}

					if (isMultiPadLBendAngle(chainBendAngle)) {
						return { strategy: 'bridge', layoutClass: 'chain-bent', metrics };
					}

					if (isMultiPadArcBendAngle(chainBendAngle)
						&& (padCount === 3 || openChainTopology)) {
						return { strategy: 'bridge', layoutClass: 'chain-open', metrics };
					}

					if (aspect > 2) {
						return { strategy: 'bridge', layoutClass: 'chain-elongated', metrics };
					}

					return { strategy: 'bridge', layoutClass: 'chain-bent', metrics };
				}

				function clearMultiPadBoundarySelectionFlags(selection) {
					if (!selection) {
						return;
					}

					delete selection.multiPadBridgedBoundary;
					delete selection.multiPadHybridBoundary;
					delete selection.multiPadHybridBoundaryMode;
					delete selection.multiPadHybridCandidateSummary;
					delete selection.multiPadHybridDegradationReasons;
					delete selection.multiPadHybridDegradedToBridge;
					delete selection.multiPadHybridForeignPadCoverage;
					delete selection.multiPadHybridPostDetourDegraded;
					delete selection.multiPadEdgeFilter;
					delete selection.multiPadEdgeFilterPartial;
					delete selection.multiPadEdgeBoundaryRequired;
					delete selection.bridgedPairCount;
					delete selection.multiPadUnionBoundaryFallback;
				}

				function getPolygonArea(points) {
					return Array.isArray(points) && points.length >= 3
						? Math.abs(polygonSignedArea(points))
						: 0;
				}

				function getBoundaryPerimeter(points) {
					if (!Array.isArray(points) || points.length < 2) {
						return 0;
					}

					return getPathLength(points.concat([points[0]]));
				}

				function getTargetKeepInArea(targetKeepInContours = []) {
					return (Array.isArray(targetKeepInContours) ? targetKeepInContours : [])
						.reduce((sum, contour) => sum + getPolygonArea(contour), 0);
				}

				function getEnvelopeCoveredForeignPadSummary(envelopeCandidate, sourceTargets, obstacles, shouldUseDynamicShape) {
					const envelopePoints = cleanBoundaryPoints(Array.isArray(envelopeCandidate && envelopeCandidate.points)
						? envelopeCandidate.points
						: []);
					const targetKeys = new Set((Array.isArray(sourceTargets) ? sourceTargets : []).map(getTargetKey));
					const coveredPads = [];
					let checkedPadCount = 0;

					if (envelopePoints.length < 3) {
						return {
							shouldDegrade: false,
							checkedPadCount,
							coveredPadCount: 0,
							coveredPads,
						};
					}

					for (const obstacle of dedupeTargets(Array.isArray(obstacles) ? obstacles : [])) {
						if (!obstacle || !isPadLikeTarget(obstacle)) {
							continue;
						}

						const obstacleKey = getTargetKey(obstacle);
						if (targetKeys.has(obstacleKey)) {
							continue;
						}

						const obstacleContour = cleanBoundaryPoints(makeTargetContourPoints(
							obstacle,
							0,
							shouldUseDynamicShape,
							[],
						));
						if (obstacleContour.length < 3) {
							continue;
						}

						checkedPadCount += 1;
						if (!polygonCoversContour(envelopePoints, obstacleContour)) {
							continue;
						}

						coveredPads.push(summarizePadEdgeTarget(obstacle));
					}

					return {
						shouldDegrade: coveredPads.length > 0,
						checkedPadCount,
						coveredPadCount: coveredPads.length,
						coveredPads: coveredPads.slice(0, 8),
					};
				}

				function summarizeMultiPadHybridCandidate(strategy, mode, points, targetKeepInContours = [], selection = {}) {
					const boundary = cleanBoundaryPoints(Array.isArray(points) ? points : []);
					const invalidReasons = getBoundaryPathInvalidReasons(boundary, targetKeepInContours);
					const hardInvalidReasons = getHardBoundaryInvalidReasons(boundary);
					const edaPolygonCreatable = isEdaPourPolygonCreatable(boundary);
					const area = getPolygonArea(boundary);
					const targetArea = Math.max(getTargetKeepInArea(targetKeepInContours), 0.001);
					const neckStats = boundary.length >= 3
						? getNarrowBoundaryNeckDetails(boundary, MIN_AVOIDANCE_NECK_WIDTH)
						: { narrowCount: 0, minWidth: undefined };

					return {
						strategy,
						mode,
						pointCount: boundary.length,
						valid: boundary.length >= 3
							&& invalidReasons.length === 0
							&& hardInvalidReasons.length === 0
							&& edaPolygonCreatable,
						invalidReasons,
						hardInvalidReasons,
						edaPolygonCreatable,
						area: roundCoordinate(area),
						perimeter: roundCoordinate(getBoundaryPerimeter(boundary)),
						targetAreaRatio: roundCoordinate(area / targetArea),
						narrowCount: neckStats.narrowCount,
						minNeckWidth: Number.isFinite(neckStats.minWidth)
							? roundCoordinate(neckStats.minWidth)
							: undefined,
						edgeFilterPartial: Boolean(selection.multiPadEdgeFilterPartial),
						edgeBoundaryRequired: Boolean(selection.multiPadEdgeBoundaryRequired),
						bridgedPairCount: selection.bridgedPairCount,
						failureReason: selection.multiPadEnvelopeFailureReason,
					};
				}

				function makeMultiPadEnvelopeCandidate(
					sourceTargets,
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours,
				) {
					const constrainedSelection = {};
					const constrainedBoundary = makeEdgeFilteredRectSupportBoundary(
						targets,
						margin,
						shouldUseDynamicShape,
						obstacles,
						targetKeepInContours,
						constrainedSelection,
					);
					const constrainedPoints = Array.isArray(constrainedBoundary) && constrainedBoundary.length >= 3
						? cleanBoundaryPoints(constrainedBoundary)
						: undefined;

					if (constrainedPoints) {
						return {
							strategy: 'envelope',
							mode: constrainedSelection.multiPadEdgeBoundaryRequired
								? 'constrained-envelope'
								: 'constrained-envelope-repaired',
							points: constrainedPoints,
							selection: constrainedSelection,
							summary: summarizeMultiPadHybridCandidate(
								'envelope',
								constrainedSelection.multiPadEdgeBoundaryRequired
									? 'constrained-envelope'
									: 'constrained-envelope-repaired',
								constrainedPoints,
								targetKeepInContours,
								constrainedSelection,
							),
						};
					}

					if (constrainedSelection.multiPadEdgeFilter || constrainedSelection.multiPadEdgeFilterPartial) {
						captureMultiPadEnvelopeFailureReason(constrainedSelection);
						return {
							strategy: 'envelope',
							mode: 'constrained-envelope-unavailable',
							points: undefined,
							selection: constrainedSelection,
							summary: summarizeMultiPadHybridCandidate(
								'envelope',
								'constrained-envelope-unavailable',
								[],
								targetKeepInContours,
								constrainedSelection,
							),
						};
					}

					const supportEnvelope = cleanBoundaryPoints(makeFallbackTargetBoundaryPoints(
						sourceTargets,
						margin,
						shouldUseDynamicShape,
					));
					return {
						strategy: 'envelope',
						mode: 'support-envelope',
						points: supportEnvelope,
						selection: {},
						summary: summarizeMultiPadHybridCandidate(
							'envelope',
							'support-envelope',
							supportEnvelope,
							targetKeepInContours,
							{},
						),
					};
				}

				function makeMultiPadBridgeCandidate(
					sourceTargets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours,
				) {
					const bridgeSelection = {};
					const bridgeBoundary = makeMultiPadBridgedBoundary(
						sourceTargets,
						margin,
						shouldUseDynamicShape,
						obstacles,
						targetKeepInContours,
						bridgeSelection,
					);
					const points = Array.isArray(bridgeBoundary) && bridgeBoundary.length >= 3
						? cleanBoundaryPoints(bridgeBoundary)
						: undefined;

					return {
						strategy: 'bridge',
						mode: 'bridge-chain',
						points,
						selection: bridgeSelection,
						summary: summarizeMultiPadHybridCandidate(
							'bridge',
							'bridge-chain',
							points || [],
							targetKeepInContours,
							bridgeSelection,
						),
					};
				}

				function getMultiPadHybridEnvelopeDegradationReasons(envelopeCandidate) {
					const reasons = [];
					const envelopeSummary = envelopeCandidate && envelopeCandidate.summary;
					const envelopeValid = Boolean(envelopeSummary && envelopeSummary.valid);

					if (!envelopeValid) {
						if (envelopeSummary) {
							if (envelopeSummary.invalidReasons.length > 0) {
								reasons.push(`envelope-${envelopeSummary.invalidReasons[0]}`);
							}
							else if (envelopeSummary.hardInvalidReasons.length > 0) {
								reasons.push(`envelope-${envelopeSummary.hardInvalidReasons[0]}`);
							}
							else if (!envelopeSummary.edaPolygonCreatable) {
								reasons.push('envelope-eda-polygon-invalid');
							}
							else if (envelopeSummary.failureReason) {
								reasons.push(envelopeSummary.failureReason);
							}
							else {
								reasons.push('envelope-unavailable');
							}
						}
						else {
							reasons.push('envelope-unavailable');
						}

						return reasons;
					}

					if (envelopeSummary.foreignPadCoverage && envelopeSummary.foreignPadCoverage.shouldDegrade) {
						reasons.push('envelope-covered-foreign-pad');
					}

					return reasons;
				}

				function applyMultiPadHybridBoundarySelection(
					selection,
					selectedCandidate,
					envelopeCandidate,
					bridgeCandidate,
					degradationReasons,
				) {
					if (!selection || !selectedCandidate) {
						return;
					}

					clearMultiPadBoundarySelectionFlags(selection);
					Object.assign(selection, selectedCandidate.selection || {});
					selection.multiPadHybridBoundary = true;
					selection.multiPadHybridBoundaryMode = selectedCandidate.mode;
					selection.multiPadHybridDegradationReasons = degradationReasons;
					selection.multiPadHybridCandidateSummary = {
						envelope: envelopeCandidate && envelopeCandidate.summary,
						bridge: bridgeCandidate && bridgeCandidate.summary,
					};
					if (envelopeCandidate && envelopeCandidate.summary && envelopeCandidate.summary.foreignPadCoverage) {
						selection.multiPadHybridForeignPadCoverage = envelopeCandidate.summary.foreignPadCoverage;
					}
					selection.multiPadBoundaryStrategy = selectedCandidate.strategy;
					if (selectedCandidate.strategy === 'bridge' && degradationReasons.length > 0) {
						selection.multiPadHybridDegradedToBridge = true;
						if (!selection.multiPadEnvelopeFailureReason) {
							selection.multiPadEnvelopeFailureReason = degradationReasons[0];
						}
					}
				}

				function makeMultiPadHybridBoundary(
					layout,
					sourceTargets,
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours = [],
					selection = undefined,
				) {
					const envelopeCandidate = makeMultiPadEnvelopeCandidate(
						sourceTargets,
						targets,
						margin,
						shouldUseDynamicShape,
						obstacles,
						targetKeepInContours,
					);
					const bridgeCandidate = makeMultiPadBridgeCandidate(
						sourceTargets,
						margin,
						shouldUseDynamicShape,
						obstacles,
						targetKeepInContours,
					);
					if (envelopeCandidate && envelopeCandidate.summary) {
						envelopeCandidate.summary.foreignPadCoverage = getEnvelopeCoveredForeignPadSummary(
							envelopeCandidate,
							sourceTargets,
							obstacles,
							shouldUseDynamicShape,
						);
					}
					const degradationReasons = getMultiPadHybridEnvelopeDegradationReasons(envelopeCandidate);
					const envelopeValid = envelopeCandidate.summary.valid;
					const bridgeValid = bridgeCandidate.summary.valid;
					const selectedCandidate = degradationReasons.length === 0 && envelopeValid
						? envelopeCandidate
						: (bridgeValid ? bridgeCandidate : (envelopeValid ? envelopeCandidate : undefined));

					reportPadEdgeDiagnostic('Multi-pad hybrid boundary selection', {
						layoutClass: layout && layout.layoutClass,
						selectedStrategy: selectedCandidate && selectedCandidate.strategy,
						selectedMode: selectedCandidate && selectedCandidate.mode,
						degradationReasons,
						envelope: envelopeCandidate.summary,
						bridge: bridgeCandidate.summary,
					});

					if (!selectedCandidate || !Array.isArray(selectedCandidate.points) || selectedCandidate.points.length < 3) {
						return undefined;
					}

					applyMultiPadHybridBoundarySelection(
						selection,
						selectedCandidate,
						envelopeCandidate,
						bridgeCandidate,
						degradationReasons,
					);
					return selectedCandidate.points;
				}

				function makeMultiPadStructuredBoundary(
					strategy,
					sourceTargets,
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours = [],
					selection = undefined,
				) {
					if (strategy === 'envelope') {
						return makeEdgeFilteredRectSupportBoundary(
							targets,
							margin,
							shouldUseDynamicShape,
							obstacles,
							targetKeepInContours,
							selection,
						);
					}

					return makeMultiPadBridgedBoundary(
						sourceTargets,
						margin,
						shouldUseDynamicShape,
						obstacles,
						targetKeepInContours,
						selection,
					);
				}

				function getMultiPadFallbackChain(layout) {
					if (!layout || !layout.layoutClass) {
						const alternateStrategy = layout && layout.strategy === 'bridge' ? 'envelope' : 'bridge';
						return layout
							? [layout.strategy, alternateStrategy, 'union']
							: ['bridge', 'envelope', 'union'];
					}

					switch (layout.layoutClass) {
						case 'cluster-hub':
							return ['envelope', 'union', 'bridge'];
						case 'cluster-grid':
						case 'chain-bent':
							return ['envelope', 'bridge', 'union'];
						case 'chain-collinear':
						case 'chain-elongated':
						case 'chain-open':
							return ['bridge', 'envelope', 'union'];
						default:
							break;
					}

					const alternateStrategy = layout.strategy === 'bridge' ? 'envelope' : 'bridge';
					return [layout.strategy, alternateStrategy, 'union'];
				}

				function captureMultiPadEnvelopeFailureReason(selection) {
					if (!selection) {
						return;
					}

					const summary = selection.multiPadEdgeFilter;
					selection.multiPadEnvelopeFailureReason = summary && summary.constraintUnresolvedReason
						? summary.constraintUnresolvedReason
						: (summary && summary.unresolvedReason
							? summary.unresolvedReason
							: (selection.multiPadEdgeFilterPartial ? 'partial-envelope' : 'envelope-unavailable'));
				}

				function makeMultiPadAutoBoundary(
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours = [],
					selection = undefined,
				) {
					const sourceResult = getRectEdgeFilterSourceTargetResult(targets, shouldUseDynamicShape);
					const sourceTargets = sourceResult.sourceTargets || [];
					if (sourceTargets.length <= 1) {
						return undefined;
					}

					const layout = classifyMultiPadLayout(sourceTargets, shouldUseDynamicShape);
					const fallbackChain = getMultiPadFallbackChain(layout);
					const forceBridge = Boolean(selection && selection.multiPadHybridForceBridge);
					const effectiveFallbackChain = forceBridge ? ['bridge', 'union'] : fallbackChain;

					if (selection) {
						selection.multiPadLayoutClass = layout.layoutClass;
						selection.multiPadLayoutMetrics = layout.metrics;
						selection.multiPadBoundaryStrategyRequested = forceBridge ? 'bridge' : 'hybrid-envelope';
					}

					reportPadEdgeDiagnostic('Multi-pad layout classification', {
						layoutClass: layout.layoutClass,
						requestedStrategy: layout.strategy,
						primaryStrategy: forceBridge ? effectiveFallbackChain[0] : 'hybrid-envelope',
						hybridPrimary: !forceBridge,
						forceBridge,
						fallbackChain: effectiveFallbackChain,
						legacyFallbackChain: fallbackChain,
						metrics: layout.metrics,
						sourceTargets: summarizePadEdgeTargets(sourceTargets),
					});

					const tryStrategy = (strategy) => {
						clearMultiPadBoundarySelectionFlags(selection);
						const boundary = makeMultiPadStructuredBoundary(
							strategy,
							sourceTargets,
							targets,
							margin,
							shouldUseDynamicShape,
							obstacles,
							targetKeepInContours,
							selection,
						);
						const validBoundary = Array.isArray(boundary) && boundary.length >= 3 ? boundary : undefined;

						if (strategy === 'envelope' && !validBoundary) {
							captureMultiPadEnvelopeFailureReason(selection);
						}

						return validBoundary;
					};

					const tryUnionFallback = () => {
						clearMultiPadBoundarySelectionFlags(selection);
						const unionBoundary = makeMultiPadUnionTargetBoundary(
							sourceTargets,
							margin,
							shouldUseDynamicShape,
							obstacles,
							targetKeepInContours,
							selection,
						);

						return Array.isArray(unionBoundary) && unionBoundary.length >= 3 ? unionBoundary : undefined;
					};

					let boundary;
					let usedStrategy;

					if (!forceBridge) {
						boundary = makeMultiPadHybridBoundary(
							layout,
							sourceTargets,
							targets,
							margin,
							shouldUseDynamicShape,
							obstacles,
							targetKeepInContours,
							selection,
						);
						usedStrategy = boundary && selection && selection.multiPadBoundaryStrategy
							? selection.multiPadBoundaryStrategy
							: undefined;
					}

					for (let stepIndex = 0; stepIndex < effectiveFallbackChain.length; stepIndex += 1) {
						const step = effectiveFallbackChain[stepIndex];
						const nextStep = effectiveFallbackChain[stepIndex + 1];

						if (boundary) {
							break;
						}

						if (step === 'union') {
							logWarn('Multi-pad structured boundary failed; trying union fallback:', {
								layoutClass: layout.layoutClass,
								metrics: layout.metrics,
								fallbackChain: effectiveFallbackChain,
							});
							boundary = tryUnionFallback();
							usedStrategy = boundary ? 'union-fallback' : undefined;
							continue;
						}

						boundary = tryStrategy(step);
						usedStrategy = boundary ? step : undefined;

						if (boundary || !nextStep) {
							continue;
						}

						if (step === 'envelope') {
							logWarn('Multi-pad envelope boundary failed; trying next fallback:', {
								layoutClass: layout.layoutClass,
								metrics: layout.metrics,
								nextStep,
								envelopeFailureReason: selection && selection.multiPadEnvelopeFailureReason,
							});
							continue;
						}

						logWarn(`Multi-pad ${step} boundary failed; trying ${nextStep}:`, {
							layoutClass: layout.layoutClass,
							metrics: layout.metrics,
							fallbackChain: effectiveFallbackChain,
						});
					}

					if (boundary && selection) {
						selection.multiPadBoundaryStrategy = usedStrategy;
					}

					if (!boundary) {
						if (selection) {
							selection.multiPadConvexHullFallbackRejected = true;
						}
						logWarn('Multi-pad boundary refusing convex hull fallback after structured/union attempts failed.');
					}
					else if (selection && selection.multiPadUnionBoundaryFallback) {
						logWarn('Multi-pad structured boundary unavailable; using union target boundary instead of convex hull.');
					}

					return boundary;
				}

				function estimateBridgingChainSpanScore(orderedTargets) {
					let score = 0;
					for (let index = 0; index < orderedTargets.length - 1; index += 1) {
						score += distance(orderedTargets[index], orderedTargets[index + 1]);
					}

					return score;
				}

				function orderThreeTargetsForBridgingChain(targets) {
					const permutations = [
						[targets[0], targets[1], targets[2]],
						[targets[0], targets[2], targets[1]],
						[targets[1], targets[0], targets[2]],
						[targets[1], targets[2], targets[0]],
						[targets[2], targets[0], targets[1]],
						[targets[2], targets[1], targets[0]],
					];
					let bestOrder = permutations[0];
					let bestScore = Number.POSITIVE_INFINITY;
					for (const permutation of permutations) {
						const score = estimateBridgingChainSpanScore(permutation);
						if (score < bestScore) {
							bestScore = score;
							bestOrder = permutation;
						}
					}

					return bestOrder;
				}

				function orderTargetsForBridgingChain(targets) {
					if (!Array.isArray(targets) || targets.length <= 1) {
						return Array.isArray(targets) ? targets : [];
					}

					if (targets.length === 3) {
						return orderThreeTargetsForBridgingChain(targets);
					}

					const remaining = targets.slice();
					remaining.sort((first, second) => {
						if (first.x !== second.x) {
							return first.x - second.x;
						}

						return first.y - second.y;
					});
					const ordered = [remaining.shift()];
					while (remaining.length > 0) {
						const last = ordered[ordered.length - 1];
						let bestIndex = 0;
						let bestDistance = Number.POSITIVE_INFINITY;
						for (let index = 0; index < remaining.length; index += 1) {
							const candidateDistance = distance(last, remaining[index]);
							if (candidateDistance < bestDistance) {
								bestDistance = candidateDistance;
								bestIndex = index;
							}
						}

						ordered.push(remaining.splice(bestIndex, 1)[0]);
					}

					return ordered;
				}

				function repairUnionBoundaryCoverage(mergedPoints, unionSources, targetKeepInContours = []) {
					if (targetKeepInContours.length === 0
						|| polygonCoversTargetContours(mergedPoints, targetKeepInContours)) {
						return mergedPoints;
					}

					const keepInMerged = mergeBoundaryWithTargetKeepIns(mergedPoints, targetKeepInContours);
					if (keepInMerged
						&& keepInMerged.points
						&& polygonCoversTargetContours(keepInMerged.points, targetKeepInContours)) {
						return keepInMerged.points;
					}

					const hull = cleanBoundaryPoints(convexHull([
						...mergedPoints,
						...(unionSources || []).flat(),
						...targetKeepInContours.flat(),
					]));
					if (hull.length >= 3
						&& getHardBoundaryInvalidReasons(hull).length === 0
						&& polygonCoversTargetContours(hull, targetKeepInContours)) {
						return hull;
					}

					return undefined;
				}

				function makeMultiPadUnionTargetBoundary(
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours = [],
					selection = undefined,
				) {
					const boundaries = (targets || [])
						.map(target => makeSingleTargetBoundary(target, margin, shouldUseDynamicShape, obstacles))
						.filter(boundary => Array.isArray(boundary) && boundary.length >= 3);
					if (boundaries.length === 0) {
						return undefined;
					}

					const unionSources = targetKeepInContours.length > 0
						? boundaries.concat(targetKeepInContours)
						: boundaries;
					const mergeResult = mergeBoundaryPolygons(unionSources, targetKeepInContours)
						|| mergeBoundaryPolygons(unionSources, []);
					if (!mergeResult || !mergeResult.points || mergeResult.points.length < 3) {
						return undefined;
					}

					const mergedPoints = repairUnionBoundaryCoverage(
						mergeResult.points,
						unionSources,
						targetKeepInContours,
					);
					if (!mergedPoints) {
						return undefined;
					}

					if (getHardBoundaryInvalidReasons(mergedPoints).length > 0) {
						return undefined;
					}

					if (mergedPoints.length < 3) {
						return undefined;
					}

					if (selection) {
						selection.multiPadUnionBoundaryFallback = true;
					}

					reportPadEdgeDiagnostic('Multi-pad union target boundary', {
						targetCount: Array.isArray(targets) ? targets.length : 0,
						sourceBoundaryCount: boundaries.length,
						unionSourceCount: unionSources.length,
						mergedPointCount: mergedPoints.length,
					});

					return mergedPoints;
				}

				function makeSimpleTwoRectBridgeBoundary(
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours = [],
				) {
					if (!isTwoRectTargetSet(targets, shouldUseDynamicShape)) {
						return undefined;
					}

					const shieldTargets = makeRectEdgeShieldTargets(targets, obstacles);
					const edgePairs = makeOrderedRectEdgePairs(
						targets,
						margin,
						shouldUseDynamicShape,
						shieldTargets,
					);
					for (const edgePair of edgePairs) {
						const candidate = makeTwoRectBoundaryFromEdges(edgePair.startEdge, edgePair.endEdge);
						if (candidate.length < 3) {
							continue;
						}

						if (isBoundaryPathValid(candidate, targetKeepInContours)
							|| isBoundaryPathValidIgnoringNeck(candidate, targetKeepInContours)) {
							return candidate;
						}
					}

					if (edgePairs.length > 0) {
						const fallback = makeTwoRectBoundaryFromEdges(edgePairs[0].startEdge, edgePairs[0].endEdge);
						return fallback.length >= 3 ? fallback : undefined;
					}

					return undefined;
				}

				function makeBridgeTargetKeepInContours(targets, margin, shouldUseDynamicShape) {
					return (Array.isArray(targets) ? targets : [])
						.map(target => cleanBoundaryPoints(makeTargetContourPoints(
							target,
							margin,
							shouldUseDynamicShape,
							[],
						)))
						.filter(contour => contour.length >= 3);
				}

				function makeMultiPadBridgedBoundary(
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours = [],
					selection = undefined,
				) {
					const ordered = orderTargetsForBridgingChain(targets);
					if (ordered.length < 2) {
						return ordered.length === 1
							? makeSingleTargetBoundary(ordered[0], margin, shouldUseDynamicShape, obstacles)
							: undefined;
					}

					let mergedBoundary;
					let successfulPairCount = 0;
					for (let index = 0; index < ordered.length - 1; index += 1) {
						const pair = [ordered[index], ordered[index + 1]];
						const pairKeepInContours = makeBridgeTargetKeepInContours(pair, margin, shouldUseDynamicShape);
						const edgePairPasses = isTwoRectTargetSet(pair, shouldUseDynamicShape)
							? selectBoundaryEdgePairPasses(pair, margin, shouldUseDynamicShape, obstacles)
							: [];
						const pairSelection = {};
						let pairBoundary = makeTwoTargetBoundary(
							pair,
							margin,
							shouldUseDynamicShape,
							obstacles,
							pairKeepInContours,
							edgePairPasses,
							pairSelection,
						);
						if (!Array.isArray(pairBoundary) || pairBoundary.length < 3) {
							pairBoundary = makeSimpleTwoRectBridgeBoundary(
								pair,
								margin,
								shouldUseDynamicShape,
								obstacles,
								pairKeepInContours,
							);
						}
						if (!Array.isArray(pairBoundary) || pairBoundary.length < 3) {
							continue;
						}

						successfulPairCount += 1;
						if (!mergedBoundary) {
							mergedBoundary = pairBoundary;
							continue;
						}

						const chainKeepInContours = makeBridgeTargetKeepInContours(
							ordered.slice(0, index + 2),
							margin,
							shouldUseDynamicShape,
						);
						const mergeResult = mergeBoundaryPolygons(
							[mergedBoundary, pairBoundary],
							chainKeepInContours,
						);
						mergedBoundary = mergeResult && mergeResult.points ? mergeResult.points : mergedBoundary;
					}

					reportPadEdgeDiagnostic('Multi-pad bridged boundary', {
						orderedTargets: summarizePadEdgeTargets(ordered),
						bridgedPairCount: ordered.length - 1,
						successfulPairCount,
						mergedPointCount: Array.isArray(mergedBoundary) ? mergedBoundary.length : 0,
					});

					if (successfulPairCount < ordered.length - 1) {
						reportPadEdgeDiagnostic('Multi-pad bridged boundary incomplete', {
							orderedTargets: summarizePadEdgeTargets(ordered),
							requiredPairCount: ordered.length - 1,
							successfulPairCount,
							mergedPointCount: Array.isArray(mergedBoundary) ? mergedBoundary.length : 0,
						});
						return undefined;
					}

					if (!polygonCoversTargetContours(mergedBoundary, targetKeepInContours)) {
						reportPadEdgeDiagnostic('Multi-pad bridged boundary rejected by target coverage', {
							orderedTargets: summarizePadEdgeTargets(ordered),
							targetKeepInContourCount: Array.isArray(targetKeepInContours)
								? targetKeepInContours.length
								: 0,
							mergedPointCount: Array.isArray(mergedBoundary) ? mergedBoundary.length : 0,
						});
						return undefined;
					}

					if (selection && mergedBoundary && mergedBoundary.length >= 3) {
						selection.multiPadBridgedBoundary = true;
						selection.bridgedPairCount = successfulPairCount;
					}

					return mergedBoundary && mergedBoundary.length >= 3 ? mergedBoundary : undefined;
				}

				function makeTwoTargetBoundary(
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours = [],
					edgePairPasses = [],
					selection = undefined,
				) {
					const start = targets[0];
					const end = targets[1];
					const forward = normalizeVector({
						x: end.x - start.x,
						y: end.y - start.y,
					});

					if (vectorLength(forward) <= 0) {
						return makeSingleTargetBoundary(start, margin, shouldUseDynamicShape, []);
					}

					if (shouldUseDynamicShape && getBoundaryShapeKind(start) === 'rect' && getBoundaryShapeKind(end) === 'rect') {
						return makeTwoRectTargetBoundary(
							targets,
							margin,
							shouldUseDynamicShape,
							obstacles,
							targetKeepInContours,
							edgePairPasses,
							selection,
						);
					}

					const side = {
						x: -forward.y,
						y: forward.x,
					};
					const reverseSide = reverseVector(side);
					const reverseForward = reverseVector(forward);

					return [
						targetSupportPoint(start, side, margin, shouldUseDynamicShape, []),
						targetSupportPoint(end, side, margin, shouldUseDynamicShape, []),
						targetSupportPoint(end, normalizeVector(addVectors(side, forward)), margin, shouldUseDynamicShape, []),
						targetSupportPoint(end, forward, margin, shouldUseDynamicShape, []),
						targetSupportPoint(end, normalizeVector(addVectors(reverseSide, forward)), margin, shouldUseDynamicShape, []),
						targetSupportPoint(end, reverseSide, margin, shouldUseDynamicShape, []),
						targetSupportPoint(start, reverseSide, margin, shouldUseDynamicShape, []),
						targetSupportPoint(start, normalizeVector(addVectors(reverseSide, reverseForward)), margin, shouldUseDynamicShape, []),
						targetSupportPoint(start, reverseForward, margin, shouldUseDynamicShape, []),
						targetSupportPoint(start, normalizeVector(addVectors(side, reverseForward)), margin, shouldUseDynamicShape, []),
					];
				}

				function makeOuterSupportBoundary(
					targets,
					margin,
					shouldUseDynamicShape,
					obstacles,
					targetKeepInContours = [],
					edgePairPasses = [],
					selection = undefined,
				) {
					const shouldTryEdgeFilteredBoundary = Array.isArray(targets)
						&& targets.length > 1
						&& !isTwoRectTargetSet(targets, shouldUseDynamicShape);
					reportPadEdgeDiagnostic('Multi-pad edge filter gate', {
						targetCount: Array.isArray(targets) ? targets.length : 0,
						sourceTargetCount: getRectEdgeFilterSourceTargetResult(targets, shouldUseDynamicShape).sourceTargets.length,
						obstacleCount: Array.isArray(obstacles) ? obstacles.length : 0,
						isTwoRectTargetSet: isTwoRectTargetSet(targets, shouldUseDynamicShape),
						shouldTryEdgeFilteredBoundary,
						targets: summarizePadEdgeTargets(targets),
					});
					if (shouldTryEdgeFilteredBoundary) {
						const sourceResult = getRectEdgeFilterSourceTargetResult(targets, shouldUseDynamicShape);
						const sourceTargets = sourceResult.sourceTargets || [];
						if (sourceTargets.length > 1) {
							return makeMultiPadAutoBoundary(
								targets,
								margin,
								shouldUseDynamicShape,
								obstacles,
								targetKeepInContours,
								selection,
							);
						}

						const edgeFilteredBoundary = makeEdgeFilteredRectSupportBoundary(
							targets,
							margin,
							shouldUseDynamicShape,
							obstacles,
							targetKeepInContours,
							selection,
						);
						if (Array.isArray(edgeFilteredBoundary) && edgeFilteredBoundary.length >= 3) {
							return edgeFilteredBoundary;
						}

						if (selection && selection.multiPadEdgeBoundaryRequired) {
							reportPadEdgeDiagnostic('Multi-pad edge-filtered boundary unavailable', {
								multiPadEdgeFilter: selection.multiPadEdgeFilter,
							});
							return undefined;
						}

					}

					if (isTwoRectTargetSet(targets, shouldUseDynamicShape)) {
						return makeTwoTargetBoundary(
							targets,
							margin,
							shouldUseDynamicShape,
							obstacles,
							targetKeepInContours,
							edgePairPasses,
							selection,
						);
					}

					const contourPoints = targets.flatMap(target =>
						makeTargetContourPoints(target, margin, shouldUseDynamicShape, []));
					const hull = convexHull(contourPoints);

					return hull.length >= 3 ? hull : contourPoints;
				}

		return {
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
		};
	}

	namespace.boundaryGeneration = {
		create: createBoundaryGeneration,
	};
})(namespace);
