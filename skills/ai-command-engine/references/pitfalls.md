# Important operational pitfalls

This page covers risks that cannot be determined from `/help` parameter tables alone. Standard workflows are in [schematic](commands-schematic.md) and [PCB](commands-pcb.md).

Do not send users plugin checks that have already completed independent readback. Only add checks for objects, save state, and design quality that remain uncovered.

## Results and write state

- An SDK `true`, a non-empty ID, a single screenshot, or a DRC result with no errors alone does not prove the task is complete. Use plugin readback and the required save/reopen checks for the task.
- A timeout does not cancel a write. If the result is unknown, stop dependent writes and inspect with `task.get`, current lists, or document source read-only. Do not blindly resend or clear write protection yourself.
- After deletion, a single-object `get()` may return a cached old object. Check existence with a full list or rescan of effective source. After creation, a list may temporarily omit the item; check using the returned ID as well.
- There is no general undo API. Before destructive work, confirm the backup file was actually created. Closing a tab and choosing “Don't Save” does not guarantee rollback.

## Windows, projects, and documents

- Include the currently verified top-level `instanceId` in every `/command`. `/help` uses the globally selected window; do not copy parameters across versions. After a window or document switch times out, reread identity.
- `project.create` and `project.open` switch the active project in the current window. Handle unsaved changes first, then verify the project with `project.getInfo`.
- `project.getDocumentSource` may return the current page when the target is not active. Run `editor.openDocument` first, then check `DOCHEAD.uuid`. The schematic Y axis in source coordinates has the opposite sign from the public API.
- `project.modifyTitleBlock` can change only fields already present on the current page. First inspect `getPageInfo.titleBlockData`; an accepted submission does not prove the change took effect after saving. It cannot switch paper size or symbol.
- Determine object state from effective source records; old records and deletion tombstones are not current state.

## Schematic

- When `placeDevice` uses `deviceUuid`, it also requires `libraryUuid`. Immediate placement verification does not replace save/reopen or netlist checks.
- Preserve the component's complete existing properties and `otherProperty` when modifying it. An empty footprint string, bare footprint name, or missing association may cause netlist problems. After netlist export, check that no components are missing.
- Do not route wires through unrelated pins or overlap differently named wires collinearly; the host may merge them. Do not add a same-name label on a `drawWire` that is already named. Confirm label attachment using this label's ID, its parent wire, and attribute readback; visual proximity is insufficient.
- `getNetlist` and `exportNetlist` may cause the host to update designators or Unique IDs. Consider this side effect first if the source must remain strictly read-only.
- `dedupeWireNets` handles duplicate same-name attributes on a single wire only; it does not decide conflicts between different names. Rebuilding changes primitive IDs, so query them again.
- Follow [Complete component replacement](commands-schematic.md#complete-component-replacement): place and verify the new component before deleting the old one. The user initiates and confirms PCB updates in the EDA interface.
- Use `schematic.exportPng` for visual inspection; background `editor.screenshot` may be a cached old frame.

## PCB and libraries

- `ComponentPad.getConnectedPrimitives` does not return `Poured`; it cannot establish whether a component pad does or does not contact actual poured copper.

- PCB DRC does not check all body-to-body and silkscreen overlaps. `checkPlacement` is an approximation based on pad bounding boxes; skipped objects or `complete:false` do not mean placement passed.
- The presence of a copper-area outline does not prove that it has been filled. If `filled` is unknown, do not treat it as empty or complete. Even a successful refill must be checked against saved state and the target area.
- Autorouting import-back may clear unlocked tracks; inspect the task, lock scope, and import-back result first. Do not apply the same clear-track assumption to ordinary SES imports.
- A library UUID may change after editing a resource. An official API error may occur after a write; search and read back the target before proceeding, and do not blindly retry with an old UUID.
- UUIDs may be rebuilt after project recovery. Compare pages, components, nets, and required resources; UUID equality alone is not sufficient.
- If `project.importFile` returns empty or throws, treat the result as unknown and inspect the current state. Do not infer success from the project name or import again.


## Attribute readback scheduling
`schematic.setAttribute` uses the EDA host timer for its existing 300 ms settling delay. Diagnostic stages distinguish mutation, host timer and readback without logging property values. A failure after mutation begins is partial: inspect the actual value and operation state before retrying. The handler never automatically repeats the write. This does not guarantee that a pending host SDK call is cancelled or that all background-window stalls are fixed.
