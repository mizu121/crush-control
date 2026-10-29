2026-10-29 remediation: the legacy CPU harness, dependent verifiers and trial exporter are excluded from this source repository. New independently written offline validation is in tools/firmware-validation and has explicitly narrower, documented CPU coverage. Historical descriptions below remain as provenance, not instructions to run or distribute the retired workflows.

# Source attribution and scope

PKRG routine generation is adapted from:

- Repository: https://github.com/Desz01ate/Wobkey_Crush_80_Patched_Firmware
- Reviewed commit: `e7e4700ff903be8a679a56308f0753a6671f84ab`
- Source: `firmware/tools/patching/patch_firmware_per_key.py`
- Copyright notice: Copyright (C) 2026 Wobkey Crush 80 firmware patch contributors
- Source license: **GPL-2.0-only**, retained in `LICENSE-GPL-2.0.txt`.

An earlier private CPU harness and its initial behavioral regressions were adapted from that commit's `tests/test_per_key_firmware.py`. That implementation was retired and is not included here. The replacement in `tools/firmware-validation` was independently authored without reading the retired implementation; its permitted inputs are recorded in PROVENANCE.md. Both the patch generator and replacement validator are separate from the desktop application's runtime.

**Licence scope correction, 2026-10-29:** the upstream test file has no identified licence header, the upstream repository has no root licence, and its explicit GPL grant covers `firmware/tools/patching/`. That grant does not establish permission for the separate test file. Adding local GPL headers did not supply missing rights in the retired harness. This repository publishes the confirmed GPL patch generators and separately authored replacement validator, not that upstream-derived harness.

Local modifications made on 2026-10-28:

- Ported exact addresses, startup call operands and continuations to the audited OEM v1.04 image.
- Tightened the v1.04 zero-area boundary to `0x7C4`.
- Composed PKRG routines with the separately reviewed rear-sync proof while preserving OEM hue conversion.
- Removed OTA/raw-image output and all runtime reliance on the temporary source checkout.
- Added guarded in-memory composition, exact manifests, assembly listings, explicit unsupported-opcode handling, and coexistence/memory-bound tests.
- Added a separate, explicitly requested local trial exporter after the two-key hardware experiment. It accepts only the pinned combined candidate and runs the CPU and host/integration tests before file export; the original builder defaults remain unchanged. The exporter performs no device operation.

The GPL notice applies to the confirmed GPL patch source and contributions for which the applicable rights holder can grant it; it does not resolve the test-harness permission gap above. It does not claim ownership of or relicense Wobkey's OEM firmware. No original or modified firmware binary is bundled with these source files. The explicitly exported OEM-derived artifact is for the owner's local authorized hardware experiment, not public distribution. The upstream repository itself notes that complete corresponding source for the OEM firmware is unavailable; this proof does not describe that firmware as an open-source or GPL-compliant release.

Unicorn and Capstone are separate analysis dependencies, not vendored copies. Their own licenses apply. The existing project rear-sync builder is imported locally as a separate implementation.
