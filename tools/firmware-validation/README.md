# Independent offline firmware validation

This GPL-2.0-only harness executes the permitted PKRG and rear patch generators'
RV32 machine code with separately installed Unicorn 2.1.4. It records CPU
instructions, writes, register preservation and protocol-buffer results. It
contains no firmware image and does not access a device, flash firmware, export
candidate firmware, publish files, or authorize installation.

The implementation was newly authored on 2026-10-29 without reading the retired
emulators/verifiers or their copies. [PROVENANCE.md](PROVENANCE.md) records the
inputs and the limits of that statement. The patch generators retain their own
GPL provenance and attribution; the ISA and protocol are not new inventions.

## Run

From the project root, using PowerShell:

```powershell
py -3.11 -m venv tools/firmware-validation/.venv
& tools/firmware-validation/.venv/Scripts/python.exe -m pip install -r tools/firmware-validation/requirements.txt
& tools/firmware-validation/.venv/Scripts/python.exe -m unittest discover -s tools/firmware-validation -p test_validation.py -v
& tools/firmware-validation/.venv/Scripts/python.exe tools/firmware-validation/validate.py
```

The first two commands are one-time dependency setup; do not include `.venv` in
a source package. The firmware-free suite runs generated instructions and labels
OEM coverage `NOT_REQUESTED`. This is not a pass for OEM execution.

To run the exact-stock checks with your own ordinary local file:

```powershell
$env:CRUSH80_STOCK_V104 = 'C:\your-private-folder\firmware.bin'
& tools/firmware-validation/.venv/Scripts/python.exe tools/firmware-validation/validate.py --require-stock
& tools/firmware-validation/.venv/Scripts/python.exe -m unittest discover -s tools/firmware-validation -p test_stock.py -v
```

`--stock PATH` overrides the environment variable. Only the exact 121332-byte
OEM image with SHA-256
`f8042ea15d9edaa1ce66fb898ac3cb0e1e5626fc96399d16e5ea42c45f72bd66` is accepted by the
licensed builder. The input and combined candidate exist in memory during the
test; neither is exported. `--out report.json` writes only evidence JSON. Exit
codes are 0 for all requested checks passing, 1 for a failed check, and 2 for
invalid/missing required input or an execution setup failure. Explicit stock
unit tests fail when input is missing; they do not silently skip.

## Scope of the evidence

Firmware-free checks cover initialization of all 608 reserved bytes, capability
fields, boolean modes, sequential writes/readback for all 92 RGB slots, invalid
chunk bounds, all 92 injected RGB stores at multipliers 0/1/64/128/255/256,
disabled override stores, live-register preservation, non-PKRG channel routing,
11 streamed fragments, commit/busy/error paths, front-buffer swap, repeated
boundary without a second swap, ACK arguments at the OEM send entry, and rear
source-selection separation. The engine tests demonstrate failures on invalid
instructions, forbidden writes, cross-boundary writes, unmapped reads, escaped
control flow and exhausted instruction budgets. A mutation test changes the
generated capability instructions and confirms the protocol check fails.

With exact stock supplied, protocol/render tests start at actual patched hook
sites in the in-memory candidate. Additional checks execute the real unmodified
OEM RGB store window, silent-return epilogue and frame prologue; compare the
original and patched prologue outcomes; execute both injected startup calls up
to OEM main entry; and check the two stack-reservation instructions.

The brightness multiplier is a fixture at the hook; OEM hue conversion,
brightness derivation, complete effect dispatch, native non-PKRG dispatch,
rear rendering, USB helper completion/peripherals, boot-to-main, interrupts,
wireless transport and full scheduler execution are outside coverage. The
engine implements no Andes instruction substitutes: reaching an unsupported
instruction is a failure. A packet captured from RAM at a continuation boundary
is not a USB reply. Observing ACK send arguments is not an ACK completion.

These deliberately bounded checks are not equivalent to the retired harness's
claimed coverage and must not silently replace an export/flash safety gate.
Passing results do not establish hardware compatibility or stack headroom.

## API

Put this directory on Python's module search path, then import:

```python
from validation import validate
from session import Session

report = validate(stock=None)  # optional exact OEM bytes
session = Session(stock=None)
reply = session.request(bytes((8, 127, 0, 0)) + bytes(28))
```

`Session.request(packet)` accepts exactly 32 bytes for command 7/8 on channel127
and executes the actual generated handler. It returns the RAM reply or `None`
for a silent native continuation. `mode` and `frame` expose observed mode and
the 276-byte active frame. `render_frame(multiplier=256, native_frame=None)`
executes 92 store-hook invocations; disabled override requires an explicit
already-scaled native RGB fixture. `rear_source(main_rgb, rear_mode=5,
inhibit=0, palette=0)` executes the rear selection routine. All such inputs are
fixtures, not purported OEM upstream execution.

`advance_frame_without_usb()` runs the generated boundary with USB unavailable.
It leaves ACK pending and intentionally cannot clear busy by fabricating a
successful OEM transfer. `Machine.run(...)` is the lower-level CPU interface;
each invocation requires explicit stops, code intervals, writable intervals and
an instruction budget, with a separate two-second execution timeout.

## License

New harness code is GPL-2.0-only; see [COPYING](COPYING). It is supplied without
warranty. The separately installed Unicorn and Capstone dependencies retain
their own licenses and notices. OEM firmware has not been relicensed, included,
or redistributed by this harness.
