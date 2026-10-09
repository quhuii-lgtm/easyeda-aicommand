This directory contains a static, UI-free adaptation of geometry code from
JLCEDA/eext-auto-copper-shape, pinned at commit
`98317b6b5941977a3ae90948a05295f9d8b1169f`.

The upstream project is licensed under Apache License 2.0; see `LICENSE`.
The polygon clipping implementation is bundled from the upstream snapshot and
retains its embedded clipper-lib license notice. Local changes wrap upstream
modules with an injected SDK namespace, expose a pure geometry core, and remove
the original UI and write flow.
