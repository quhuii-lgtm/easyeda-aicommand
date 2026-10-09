# Third-party source notice

This directory contains code adapted from the upstream project `jlc-order-dfm-checker`.

- Repository: https://github.com/easyeda/eext-jlc-order-dfm-checker
- Upstream commit: `afd538786d510f537ad4fa47c6329e6a99dc7625`
- Upstream version: `1.0.4`
- License: Apache-2.0 (see `LICENSE`)

Local adaptations include extracting the DFM calculation core, passing the SDK explicitly, sequentializing SDK reads, reporting incomplete required reads, accepting explicit order copper-thickness inputs, selecting line-width and line-spacing tiers by design copper layer, and returning parsed drawing copper as a separate comparison report. The upstream calculation behavior is adapted for this project's requirements; this notice does not claim that every algorithm is reproduced verbatim. UI, storage, logging-panel clearing, export, external network access, and design writes are not included.


