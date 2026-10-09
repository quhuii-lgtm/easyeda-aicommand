import namespace from '../namespace.js'
(function (global) {
	'use strict';
	const namespace = global.AutoCopperPour = global.AutoCopperPour || {};
	const eda = namespace.sdkProxy;
	const {
		error: logError,
		reportDiagnostic,
	} = namespace.logger;
	const {
		text,
	} = namespace.i18n;
	const {
		toNumber,
		roundCoordinate,
	} = namespace.geometryUtils;

	function normalizeNetName(net) {
		return String(net || '').trim();
	}

	function isRecord(value) {
		return !!value && typeof value === 'object' && !Array.isArray(value);
	}

	function normalizeRuleText(value) {
		return normalizeNetName(value).toLowerCase();
	}

	function parseMilValue(value) {
		if (typeof value === 'number') {
			return Number.isFinite(value) && value >= 0 ? value : undefined;
		}

		if (typeof value !== 'string') {
			return undefined;
		}

		const source = value.trim();
		const match = source.match(/-?\d+(?:\.\d+)?/);
		if (!match) {
			return undefined;
		}

		const numericValue = Number(match[0]);
		if (!Number.isFinite(numericValue) || numericValue < 0) {
			return undefined;
		}

		if (/mm\b/i.test(source)) {
			return numericValue / 0.0254;
		}

		if (/(inch|in)\b/i.test(source)) {
			return numericValue * 1000;
		}

		return numericValue;
	}

	function collectRuleStrings(source, output, depth = 0) {
		if (depth > 8 || source === undefined || source === null) {
			return;
		}

		if (typeof source === 'string') {
			output.push(source);
			return;
		}

		if (Array.isArray(source)) {
			for (const item of source) {
				collectRuleStrings(item, output, depth + 1);
			}
			return;
		}

		if (!isRecord(source)) {
			return;
		}

		for (const [key, value] of Object.entries(source)) {
			output.push(key);
			collectRuleStrings(value, output, depth + 1);
		}
	}

	function collectRuleObjects(source, output, path = [], depth = 0) {
		if (depth > 8 || source === undefined || source === null) {
			return;
		}

		if (Array.isArray(source)) {
			source.forEach((item, index) => {
				collectRuleObjects(item, output, path.concat(String(index)), depth + 1);
			});
			return;
		}

		if (!isRecord(source)) {
			return;
		}

		output.push({ source, path });
		for (const [key, value] of Object.entries(source)) {
			collectRuleObjects(value, output, path.concat(key), depth + 1);
		}
	}

	function collectMilValues(source, output, depth = 0, maxDepth = 6) {
		if (depth > maxDepth || source === undefined || source === null) {
			return;
		}

		const value = parseMilValue(source);
		if (value !== undefined) {
			output.push(value);
			return;
		}

		if (Array.isArray(source)) {
			for (const item of source) {
				collectMilValues(item, output, depth + 1, maxDepth);
			}
			return;
		}

		if (!isRecord(source)) {
			return;
		}

		for (const value of Object.values(source)) {
			collectMilValues(value, output, depth + 1, maxDepth);
		}
	}

	function getClearanceKeyScore(path) {
		const source = normalizeRuleText(path);
		if (!source) {
			return 0;
		}

		if (/(width|length|hole|diameter|solder|paste|mask|silk|edge|board|thermal|spoke|neck)/i.test(source)) {
			return 0;
		}

		const hasClearanceMeaning = /(clearance|clear|\u95f4\u8ddd|\u5b89\u5168|spacing|space|gap|distance|(?:wire|trace|track|line|pad|via|copper).*(?:to|2).*(?:wire|trace|track|line|pad|via|copper))/i.test(source);
		if (!hasClearanceMeaning) {
			return 0;
		}

		let score = 0;
		if (/(clearance|clear|\u95f4\u8ddd|\u5b89\u5168)/i.test(source)) {
			score += 120;
		}
		if (/(spacing|space|gap|distance)/i.test(source)) {
			score += 90;
		}
		if (/(?:wire|trace|track|line|pad|via|copper).*(?:to|2).*(?:wire|trace|track|line|pad|via|copper)/i.test(source)) {
			score += 80;
		}
		if (/(min|minimum|safe|required|rule)/i.test(source)) {
			score += 10;
		}
		if (/(net|class|copper|wire|trace|track|line)/i.test(source)) {
			score += 5;
		}

		return score;
	}

	function getObstacleRuleTerms(obstacleType) {
		const type = normalizeRuleText(obstacleType);
		if (/line|polyline|arc|track|trace|wire/.test(type)) {
			return [/(wire|trace|track|line|\u5bfc\u7ebf|\u8d70\u7ebf)/i];
		}

		if (/pad/.test(type)) {
			return [/(pad|\u710a\u76d8)/i];
		}

		if (/via/.test(type)) {
			return [/(via|\u8fc7\u5b54)/i];
		}

		if (/region|fill|pour/.test(type)) {
			return [/(region|fill|pour|copper|\u533a\u57df|\u94fa\u94dc|\u94dc\u76ae)/i];
		}

		return [
			/(wire|trace|track|line|\u5bfc\u7ebf|\u8d70\u7ebf)/i,
			/(pad|\u710a\u76d8)/i,
			/(via|\u8fc7\u5b54)/i,
		];
	}

	function getClearanceRoleScore(path, obstacleType) {
		const source = normalizeRuleText(path);
		const copperRule = /(copper|pour|poured|fill|region|\u94fa\u94dc|\u94dc\u76ae|\u94dc|\u533a\u57df)/i.test(source);
		const obstacleMatched = getObstacleRuleTerms(obstacleType).some(pattern => pattern.test(source));
		let score = 0;

		if (copperRule) {
			score += 80;
		}
		if (obstacleMatched) {
			score += 60;
		}
		if (copperRule && obstacleMatched) {
			score += 160;
		}
		if (/(net|class|\u7f51\u7edc)/i.test(source)) {
			score += 10;
		}

		return score;
	}

	function extractClearanceCandidates(source, path = [], output = []) {
		if (source === undefined || source === null) {
			return output;
		}

		const pathText = path.join('.');
		const pathScore = getClearanceKeyScore(pathText);
		const directValue = pathScore > 0 ? parseMilValue(source) : undefined;
		if (directValue !== undefined) {
			output.push({
				value: directValue,
				keyScore: pathScore,
				path: pathText,
			});
		}

		if (Array.isArray(source)) {
			return output;
		}

		if (!isRecord(source)) {
			return output;
		}

		for (const [key, value] of Object.entries(source)) {
			const nextPath = path.concat(key);
			const nextPathText = nextPath.join('.');
			const keyScore = getClearanceKeyScore(nextPathText);
			if (keyScore > 0) {
				const values = [];
				collectMilValues(value, values, 0, 2);
				for (const clearance of values) {
					output.push({
						value: clearance,
						keyScore,
						path: nextPathText,
					});
				}
			}
		}

		return output;
	}

	function getNetClassNames(net, netClasses) {
		const normalizedNet = normalizeRuleText(net);
		if (!normalizedNet || !Array.isArray(netClasses)) {
			return [];
		}

		return netClasses
			.filter((netClass) => {
				const nets = Array.isArray(netClass && netClass.nets) ? netClass.nets : [];
				return nets.some(item => normalizeRuleText(item) === normalizedNet);
			})
			.map(netClass => normalizeNetName(netClass.name))
			.filter(Boolean);
	}

	function makeRuleIdentifiers(net, netClasses) {
		return [...new Set([
			normalizeNetName(net),
			...getNetClassNames(net, netClasses),
		]
			.map(normalizeRuleText)
			.filter(Boolean))];
	}

	function ruleTextMentionsAny(sourceText, identifiers) {
		const tokens = new Set(sourceText.split(/[^a-z0-9_$]+/i).filter(Boolean));
		return identifiers.some((identifier) => {
			if (!identifier) {
				return false;
			}

			if (tokens.has(identifier)) {
				return true;
			}

			return /[^a-z0-9_]/i.test(identifier) && sourceText.includes(identifier);
		});
	}

	function makeRuleRecordText(record) {
		const strings = record.path.slice();
		collectRuleStrings(record.source, strings);
		return normalizeRuleText(strings.join(' '));
	}

	function findClearanceCandidates(source, sourceName, targetIdentifiers, obstacleIdentifiers, obstacleType) {
		const records = [];
		collectRuleObjects(source, records);
		const candidates = [];
		const allIdentifiers = [...targetIdentifiers, ...obstacleIdentifiers];

		for (const record of records) {
			const recordText = makeRuleRecordText(record);
			const targetMatched = ruleTextMentionsAny(recordText, targetIdentifiers);
			const obstacleMatched = obstacleIdentifiers.length > 0
				&& ruleTextMentionsAny(recordText, obstacleIdentifiers);
			const genericMatched = allIdentifiers.length === 0 || !ruleTextMentionsAny(recordText, allIdentifiers);
			const specificity = targetMatched && obstacleMatched
				? 3
				: targetMatched || obstacleMatched
					? 2
					: genericMatched
						? 1
						: 0;
			if (specificity <= 0) {
				continue;
			}

			for (const candidate of extractClearanceCandidates(record.source, record.path)) {
				if (candidate.value > 0) {
					candidates.push({
						...candidate,
						source: sourceName,
						roleScore: getClearanceRoleScore(candidate.path, obstacleType),
						specificity,
						targetMatched,
						obstacleMatched,
					});
				}
			}
		}

		return candidates;
	}

	function selectClearanceCandidate(candidates) {
		if (!Array.isArray(candidates) || candidates.length === 0) {
			return undefined;
		}

		const maxSpecificity = Math.max(...candidates.map(candidate => candidate.specificity));
		const specificityMatched = candidates.filter(candidate => candidate.specificity === maxSpecificity);
		const maxRoleScore = Math.max(...specificityMatched.map(candidate => toNumber(candidate.roleScore, 0)));
		const roleMatched = specificityMatched.filter(candidate => toNumber(candidate.roleScore, 0) === maxRoleScore);
		const maxKeyScore = Math.max(...roleMatched.map(candidate => candidate.keyScore));
		const keyMatched = roleMatched.filter(candidate => candidate.keyScore === maxKeyScore);
		return keyMatched.reduce((best, candidate) => candidate.value > best.value ? candidate : best, keyMatched[0]);
	}

	function normalizeSafeSpacingLabel(value) {
		return normalizeRuleText(value).replace(/[^a-z0-9]+/gi, '');
	}

	function getRecordValueByNormalizedKey(source, keyName) {
		if (!isRecord(source)) {
			return undefined;
		}

		const normalizedKeyName = normalizeSafeSpacingLabel(keyName);
		const entry = Object.entries(source)
			.find(([key]) => normalizeSafeSpacingLabel(key) === normalizedKeyName);
		return entry ? entry[1] : undefined;
	}

	function getRuleConfigurationConfig(currentRuleConfiguration) {
		if (!isRecord(currentRuleConfiguration)) {
			return undefined;
		}

		return isRecord(currentRuleConfiguration.config)
			? currentRuleConfiguration.config
			: currentRuleConfiguration;
	}

	function getSafeSpacingRuleEntries(currentRuleConfiguration) {
		const config = getRuleConfigurationConfig(currentRuleConfiguration);
		const spacing = getRecordValueByNormalizedKey(config, 'Spacing');
		const safeSpacing = getRecordValueByNormalizedKey(spacing, 'Safe Spacing');
		if (!isRecord(safeSpacing)) {
			return [];
		}

		return Object.entries(safeSpacing)
			.filter(([, value]) => isRecord(value));
	}

	function selectSafeSpacingRule(currentRuleConfiguration) {
		const entries = getSafeSpacingRuleEntries(currentRuleConfiguration);
		if (entries.length === 0) {
			return undefined;
		}

		const defaultEntry = entries.find(([, rule]) => rule.isSetDefault === true);
		const [ruleName, rule] = defaultEntry || entries[0];
		return { ruleName, rule };
	}

	function parseRuleNumberMil(value, unit) {
		const numericValue = Number(value);
		if (!Number.isFinite(numericValue) || numericValue < 0) {
			return undefined;
		}

		const unitText = normalizeRuleText(unit);
		if (unitText.includes('mm')) {
			return numericValue / 0.0254;
		}

		if (unitText.includes('inch') || unitText === 'in') {
			return numericValue * 1000;
		}

		return numericValue;
	}

	function selectSafeSpacingTable(rule, layer) {
		const tables = isRecord(rule) ? rule.tables : undefined;
		if (!isRecord(tables)) {
			return undefined;
		}

		const preferredKeys = [...new Set([String(layer || ''), '1'].filter(Boolean))];
		for (const key of preferredKeys) {
			if (isRecord(tables[key]) && Array.isArray(tables[key].content)) {
				return {
					tableKey: key,
					table: tables[key],
				};
			}
		}

		const activeEntry = Object.entries(tables)
			.find(([, table]) => isRecord(table) && Array.isArray(table.content) && table.status === 1);
		const fallbackEntry = activeEntry || Object.entries(tables)
			.find(([, table]) => isRecord(table) && Array.isArray(table.content));
		if (!fallbackEntry) {
			return undefined;
		}

		return {
			tableKey: fallbackEntry[0],
			table: fallbackEntry[1],
		};
	}

	function findSafeSpacingLabelIndex(labels, preferredLabels) {
		if (!Array.isArray(labels)) {
			return -1;
		}

		const normalizedLabels = labels.map(normalizeSafeSpacingLabel);
		for (const preferredLabel of preferredLabels) {
			const index = normalizedLabels.indexOf(normalizeSafeSpacingLabel(preferredLabel));
			if (index >= 0) {
				return index;
			}
		}

		return -1;
	}

	function getSafeSpacingCell(rule, tableInfo, rowLabel, columnLabel) {
		const rowLabels = Array.isArray(rule.row) ? rule.row : [];
		const columnLabels = Array.isArray(rule.column) ? rule.column : [];
		const rowIndex = findSafeSpacingLabelIndex(rowLabels, [rowLabel]);
		const columnIndex = findSafeSpacingLabelIndex(columnLabels, [columnLabel]);
		if (rowIndex < 0 || columnIndex < 0) {
			return undefined;
		}

		const row = tableInfo.table.content[rowIndex];
		if (!Array.isArray(row) || columnIndex >= row.length) {
			return undefined;
		}

		const value = parseRuleNumberMil(row[columnIndex], rule.unit);
		if (value === undefined) {
			return undefined;
		}

		return {
			value,
			rowIndex,
			columnIndex,
			rowLabel: rowLabels[rowIndex],
			columnLabel: columnLabels[columnIndex],
		};
	}

	function lookupSafeSpacingPair(rule, tableInfo, targetLabels, obstacleLabels) {
		for (const targetLabel of targetLabels) {
			for (const obstacleLabel of obstacleLabels) {
				const direct = getSafeSpacingCell(rule, tableInfo, targetLabel, obstacleLabel);
				if (direct) {
					return direct;
				}

				const reverse = getSafeSpacingCell(rule, tableInfo, obstacleLabel, targetLabel);
				if (reverse) {
					return reverse;
				}
			}
		}

		return undefined;
	}

	function getGeneratedCopperRuleLabels(generationType) {
		return generationType === 'fill'
			? ['Fill Region/Teardrop', 'Copper/Plane Zone']
			: ['Copper/Plane Zone', 'Fill Region/Teardrop'];
	}

	function getObstacleSafeSpacingRuleLabels(obstacleType) {
		const type = normalizeRuleText(obstacleType);
		if (/line|polyline|arc|track|trace|wire/.test(type)) {
			return ['Track', 'Line'];
		}

		if (/pad/.test(type)) {
			return ['SMD Pad', 'TH Pad', 'SMD Test Point', 'TH Test Point'];
		}

		if (/via/.test(type)) {
			return ['Via'];
		}

		if (/region|fill|pour/.test(type)) {
			return ['Fill Region/Teardrop', 'Copper/Plane Zone'];
		}

		return ['Track', 'SMD Pad', 'TH Pad', 'Via', 'Fill Region/Teardrop', 'Copper/Plane Zone'];
	}

	function resolveSafeSpacingMatrixClearanceMil(drcRules, obstacleType, options = {}) {
		const selectedRule = selectSafeSpacingRule(drcRules.currentRuleConfiguration);
		if (!selectedRule) {
			return undefined;
		}

		const tableInfo = selectSafeSpacingTable(selectedRule.rule, options.layer);
		if (!tableInfo) {
			return undefined;
		}

		const targetLabels = Array.isArray(options.targetRuleLabels) && options.targetRuleLabels.length > 0
			? options.targetRuleLabels
			: getGeneratedCopperRuleLabels(options.generationType);
		const obstacleLabels = getObstacleSafeSpacingRuleLabels(obstacleType);
		const cell = lookupSafeSpacingPair(selectedRule.rule, tableInfo, targetLabels, obstacleLabels);
		if (!cell) {
			return undefined;
		}

		return {
			value: cell.value,
			source: 'getCurrentRuleConfiguration.safeSpacingMatrix',
			path: `config.Spacing.Safe Spacing.${selectedRule.ruleName}.tables.${tableInfo.tableKey}.content[${cell.rowIndex}][${cell.columnIndex}] (${cell.rowLabel} <-> ${cell.columnLabel})`,
			keyScore: 1000,
			roleScore: 1000,
			specificity: 1,
		};
	}

	function resolveDrcClearanceMil(targetNet, obstacleNet, drcRules, obstacleType, options = {}) {
		const targetIdentifiers = makeRuleIdentifiers(targetNet, drcRules.netClasses);
		const obstacleIdentifiers = makeRuleIdentifiers(obstacleNet, drcRules.netClasses);
		const netByNetCandidates = findClearanceCandidates(
			drcRules.netByNetRules,
			'getNetByNetRules',
			targetIdentifiers,
			obstacleIdentifiers,
			obstacleType,
		);
		const exactPairCandidate = selectClearanceCandidate(netByNetCandidates.filter(candidate => candidate.specificity === 3));
		if (exactPairCandidate) {
			return exactPairCandidate;
		}

		const netRuleCandidates = findClearanceCandidates(
			drcRules.netRules,
			'getNetRules',
			targetIdentifiers,
			obstacleIdentifiers,
			obstacleType,
		);
		const netSpecificCandidate = selectClearanceCandidate(netRuleCandidates.filter(candidate => candidate.specificity >= 2));
		if (netSpecificCandidate) {
			return netSpecificCandidate;
		}

		const safeSpacingMatrixCandidate = resolveSafeSpacingMatrixClearanceMil(drcRules, obstacleType, options);
		if (safeSpacingMatrixCandidate) {
			return safeSpacingMatrixCandidate;
		}

		const configCandidates = findClearanceCandidates(
			drcRules.currentRuleConfiguration,
			'getCurrentRuleConfiguration',
			targetIdentifiers,
			obstacleIdentifiers,
			obstacleType,
		);
		const configSpecificCandidate = selectClearanceCandidate(configCandidates.filter(candidate => candidate.specificity >= 2));
		if (configSpecificCandidate) {
			return configSpecificCandidate;
		}

		return selectClearanceCandidate([
			...netByNetCandidates,
			...netRuleCandidates,
			...configCandidates,
		].filter(candidate => candidate.specificity === 1));
	}

	async function getPcbDrcRuleContext() {
		try {
			const [
				netRules,
				netByNetRules,
				netClasses,
				currentRuleConfiguration,
				currentRuleConfigurationName,
			] = await Promise.all([
				eda.pcb_Drc.getNetRules(),
				eda.pcb_Drc.getNetByNetRules(),
				eda.pcb_Drc.getAllNetClasses(),
				eda.pcb_Drc.getCurrentRuleConfiguration(),
				eda.pcb_Drc.getCurrentRuleConfigurationName(),
			]);

			return {
				netRules: Array.isArray(netRules) ? netRules : [],
				netByNetRules: netByNetRules && typeof netByNetRules === 'object' ? netByNetRules : {},
				netClasses: Array.isArray(netClasses) ? netClasses : [],
				currentRuleConfiguration: currentRuleConfiguration && typeof currentRuleConfiguration === 'object'
					? currentRuleConfiguration
					: {},
				currentRuleConfigurationName: normalizeNetName(currentRuleConfigurationName),
			};
		}
		catch (err) {
			logError('Failed to read PCB DRC rules:', err);
			throw new Error(text('Failed to read PCB DRC clearance rules.'));
		}
	}

	function getObstacleClearanceMil(obstacle) {
		const clearance = toNumber(obstacle && obstacle.clearanceMil, Number.NaN);
		if (!Number.isFinite(clearance) || clearance < 0) {
			throw new Error(text('Missing PCB DRC clearance for an obstacle.'));
		}

		return clearance;
	}

	function summarizeClearanceRules(obstacles) {
		return [...new Set(obstacles.map((obstacle) => {
			const value = roundCoordinate(obstacle.clearanceMil);
			const source = obstacle.clearanceRuleSource || 'unknown';
			const path = obstacle.clearanceRulePath || 'unknown';
			return `${value}mil @ ${source}:${path}`;
		}))];
	}

	function applyDrcClearanceToObstacles(obstacles, targetNet, drcRules, contextLabel, options = {}) {
		const unresolved = [];
		const resolved = obstacles.map((obstacle) => {
			const rule = resolveDrcClearanceMil(targetNet, obstacle.net, drcRules, obstacle.type, options);
			if (!rule) {
				unresolved.push(obstacle);
				return obstacle;
			}

			return {
				...obstacle,
				clearanceMil: rule.value,
				clearanceRuleSource: rule.source,
				clearanceRulePath: rule.path,
			};
		});

		if (unresolved.length > 0) {
			logError('Could not resolve DRC clearance for obstacles:', {
				contextLabel,
				targetNet,
				unresolvedCount: unresolved.length,
				unresolvedNets: [...new Set(unresolved.map(obstacle => normalizeNetName(obstacle.net)).filter(Boolean))],
				currentRuleConfigurationName: drcRules.currentRuleConfigurationName,
			});
			throw new Error(text('Failed to read PCB DRC clearance rules for ${1} obstacle(s).', unresolved.length));
		}

		reportDiagnostic('Resolved PCB DRC clearance rules:', {
			contextLabel,
			obstacleCount: resolved.length,
			clearances: [...new Set(resolved.map(obstacle => roundCoordinate(obstacle.clearanceMil)))],
			sources: [...new Set(resolved.map(obstacle => obstacle.clearanceRuleSource).filter(Boolean))],
			rules: summarizeClearanceRules(resolved),
			currentRuleConfigurationName: drcRules.currentRuleConfigurationName,
		});

		return resolved;
	}

	namespace.drcRules = {
		normalizeNetName,
		isRecord,
		normalizeRuleText,
		parseMilValue,
		collectRuleStrings,
		collectRuleObjects,
		collectMilValues,
		getClearanceKeyScore,
		getObstacleRuleTerms,
		getClearanceRoleScore,
		extractClearanceCandidates,
		getNetClassNames,
		makeRuleIdentifiers,
		ruleTextMentionsAny,
		makeRuleRecordText,
		findClearanceCandidates,
		selectClearanceCandidate,
		normalizeSafeSpacingLabel,
		getRecordValueByNormalizedKey,
		getRuleConfigurationConfig,
		getSafeSpacingRuleEntries,
		selectSafeSpacingRule,
		parseRuleNumberMil,
		selectSafeSpacingTable,
		findSafeSpacingLabelIndex,
		getSafeSpacingCell,
		lookupSafeSpacingPair,
		getGeneratedCopperRuleLabels,
		getObstacleSafeSpacingRuleLabels,
		resolveSafeSpacingMatrixClearanceMil,
		resolveDrcClearanceMil,
		getPcbDrcRuleContext,
		getObstacleClearanceMil,
		summarizeClearanceRules,
		applyDrcClearanceToObstacles,
	};
})(namespace);
