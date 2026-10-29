# Licence scope

The MIT licence in `LICENSE.txt` applies to mi0ir's original Crush Control
application code and original contributions to its build and test tools.
It does not relicense third party material or supply rights in WOBKEY firmware.
An individual file's copyright and licence notice takes precedence.

- `app/` original application code: MIT. Bundled fonts, environment image,
  generated icon paths and dependency code retain their own licences described
  in `THIRD_PARTY_NOTICES.txt` and adjacent notices.
- `signalrgb/Wobkey_Crush80_VIA_Sync.js`: original plugin under MIT; this is
  separate from the community's per-key plugin.
- `tools/per-key-firmware/pkrg_routines.py` and `build_v104.py`: GPL-2.0-only,
  including the credited upstream patch-generator contributions. Their
  `NOTICE.md` and `LICENSE-GPL-2.0.txt` remain authoritative.
- `tools/firmware-validation/`: new GPL-2.0-only offline validation code. See
  its provenance and coverage documents. Calling it "new" does not change the
  GPL status of the generator it validates.
- Other research tools: follow their individual notices. They are not included
  in this source repository merely because they existed in the development folder.
  The original `tools/rear-sync/build_proof.py` is included under MIT as a
  dependency of the GPL patch generator; no OEM image rights are granted.
- `legal/`, third party source archives and installed dependencies: their own
  upstream licences, copyright notices and applicable exceptions.
- `artifacts/`, `backups/`, OEM firmware, vendor updaters, device dumps and the
  archived legacy harness: excluded from this public source repository.
  No permission to redistribute these is asserted by the root MIT licence.

This source repository was prepared from an explicit allowlist. It contains no
private development history, firmware images, user settings or signing secrets.

The application uses protocol interoperability with supported hardware. It does
not include keyboard firmware or a firmware flasher. Per-key RGB requires the
exact supported custom firmware. No brand endorsement or trademark licence is
granted. MIT permits commercial and closed source reuse of original app code.
