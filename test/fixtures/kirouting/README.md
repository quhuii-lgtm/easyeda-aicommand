# KiRouting regression fixtures

`host-ulx3s-net-aliases.json` is a minimized, de-identified static excerpt from the ULX3S host collector snapshot dated 2026-11-16. It retains only the 329 geometry net names and pad ownership tokens, the NET/RULE_SELECTOR/PAD_NET and relevant RULE source records, the SDK net rules and configuration fields used by the regression, and the 329-entry routing width snapshot.

Project/document identifiers, paths, board geometry, components, and full pad geometry are omitted. Pad ownership IDs are synthetic tokens that preserve the one-to-one PAD_NET relationship needed by the alias proof. The fixture supports deterministic software regression only; it is not a live EDA check or hardware acceptance evidence.

Run from `repository/` with `node test/routing-net-alias-regression.mjs`.
