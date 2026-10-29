# Crush80 v1.04 patch source

The GPL patch generator remains attributed in NOTICE.md. Its OEM input must match the exact SHA-256 checked by build_v104.py. No firmware image is included or licensed by this project.

The previous emulator and its dependent verifiers had unresolved source permissions. They are retired and archived privately. The trial exporter is disabled. Historical validation results do not establish rights to publish those files.

Use ../firmware-validation/README.md for the new offline checks. The replacement executes generated RV32 routines with strict memory and instruction limits and reports explicit OEM continuation boundaries. It does not emulate the complete OEM firmware, physical USB, radio, or LED scanout. Passing these checks does not authorize firmware export or flashing.

Permitted source files: pkrg_routines.py and build_v104.py, plus the separate rear-sync builder they import. Keep GPL-2.0-only, upstream copyright, modification history and source links. The root application's MIT licence does not override these terms.

The application uses per-key protocol commands and does not ship or flash this firmware. Full original/modified OEM firmware must stay outside the proposed public source repository.
