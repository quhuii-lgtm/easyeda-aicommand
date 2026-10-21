# Schematic host normalization: scope and evidence

## Version comparison

Baseline: upstream `f3e77f4d62bbc40a0756eaff29779c54318bf375`, version 0.20.50. Runtime source/configuration/lockfile match tag v0.20.50. Compared a fresh production-equivalent esbuild output with the installed marketplace 0.20.51 bundle.

Marketplace archive SHA256: `7D30A89726D965110F854C2BFEC24526DA2825F260EA71DE0F5B96280000223C`.

Ignoring export-variable naming and manifest version, runtime differences are confined to:

- `pcb.listPours`: validate fill objects and source paths, count genuinely filled regions separately.
- `schematic.connectPin`: exact cardinal-direction vectors and removal of coordinate rounding.

The `schematic.drawWire`, `schematic.setAttribute`, `schematic.getNetlist` and `schematic.listWires` handlers are unchanged. Those marketplace-only changes are not included in this contribution. This runtime comparison does not claim all package resources or documentation are identical.

## Behavior

Drawing must preserve existing zero-length point records exactly. A new zero-length draw request remains invalid. Explicit null default style values are distinct from unavailable getters.

WIRE and wire-attribute zIndex are display order, not electrical identity or a count of added LINE records. Existing unrelated attributes must retain their IDs, parent, value and every field except valid display numbering.

The host may recreate automatic NET/Name/Relevance records on wires touched by the current segment. Validate legal fields, correct ownership, source/SDK agreement and network names inherited from touched wires or explicitly requested. Duplicate identical label values do not change the electrical net; the command does not clean up duplicate visible labels. Conflicting or unrequested names, missing/changed geometry, style mismatches, orphan records and unrelated component changes remain failures. Do not bypass whole-page preservation checks when wire IDs merge.

## Tests and evidence limits

`node --test test/schematic-wire-host-normalization-regression.mjs` uses small synthetic WIRE/LINE/ATTR records and a dummy component. It imports the actual TypeScript handler; only the host boundary is mocked. It contains no customer project data or captured source snapshots. Tests assert that a partial write does not repeat create.

Existing geometry, lag and merge regressions are retained. Their mocks now use the SDK string contract for unnamed nets, valid automatic label fields and unique attribute IDs. Expectations that previously rejected valid automatic-anchor changes or required zIndex offsets to equal added LINE counts are updated. Missing geometry and invalid electrical changes must still fail.

The related cumulative local marketplace bundle adaptation previously completed real drawing and save/close/reopen. This newly compiled source package has not been installed in EDA; tests are not a new host acceptance run. The exact original host build is not inferred. PNG and netlist host-call stalls remain open in issues #18 and #19.

Related reports: [#15](https://github.com/quhuii-lgtm/easyeda-aicommand/issues/15), [#16](https://github.com/quhuii-lgtm/easyeda-aicommand/issues/16). Attribute scheduling is handled separately in [#20](https://github.com/quhuii-lgtm/easyeda-aicommand/pull/20).
