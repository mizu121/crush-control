# Release notes and binary candidate status

This repository publishes **1.0.0-beta.9 development source**; its binary build
remains a local review candidate. Original app code is
MIT; patch tooling and dependencies keep their own licences. The unclear legacy
test harness is retired. Required runtime/installer notices are checked against
the release manifest. The separate runtime/installer source archives are not
included in this Git repository. Their recipient delivery and the complete
combined-runtime LGPL relink arrangement remain unfinished. The public beta.8
installer predates this source snapshot.

The installer uses an original Windows Restart Manager check and standard NSIS
progress. Shortcut identity metadata is updated through Electron after the first
packaged launch, only when an existing shortcut points to this exact executable.
User-managed Windows pins and Jump Lists are no longer automatically cleaned up
on uninstall. No keyboard transport or preset format changes are part of this
licensing candidate. Installation and live USB/dongle regression testing have
not been repeated for beta.9.

Release preparation began 28 October 2026. Developer: **mi0ir**, [mi0ir.com](https://mi0ir.com). Read the version shown in **Settings → About & support** for the installed build. This is an evaluation release for Windows x64, with hardware validation on one Crush 80 Pro; it is not a general firmware upgrade or a sale-ready compatibility promise.

## Running the installed build

1. Connect the keyboard with its USB cable and close other keyboard controllers, including SignalRGB.
2. Open Crush Control. Stock firmware provides whole-board features; per-key controls require the exact supported custom firmware described in [FEATURES.md](FEATURES.md).
3. Choose a starter look or select keys in the layout and set their color. Save a named PC preset to recall that look later.
4. Use the tray Quit action or Ctrl+Q to release the app. Closing its window only hides it.

For experimental wireless lighting, keep the verified keyboard connected by USB, insert its paired Crush 80 dongle, and choose **Settings → Link your dongle**. Then unplug the keyboard cable and select 2.4 GHz mode. The picker, selections and presets use the linked receiver; USB takes priority if reconnected. Key mapping, firmware identification and onboard SAVE require USB. Linking is a local association, not a firmware installation or a cryptographic identity of the radio peer. Relinking may be needed after moving the dongle to another USB port.

The header and tray show the real Windows Bluetooth battery report when available. An amber dot on the tray percentage marks last-known data; the tooltip also states it. The reading can remain stale while using USB or the receiver. No live receiver battery or charging state is claimed, and USB connection alone does not turn on a charging indicator.

The installed executable runs directly; the development PowerShell launcher is not included. Settings and presets are kept in Electron's per-user `crush80-control` data directory (normally `%APPDATA%\crush80-control`). Packaged keymap backups are stored in its `backups` subfolder. The installer does not include anyone's existing presets, backups, keyboard pairing data, screenshots or development logs.

## App update delivery

Install beta.4 manually once to add the updater. Later published versions appear in **Settings → App updates**. Checking runs at startup and every six hours; download and restart require separate user actions. A published beta release must contain its installer, channel metadata and Ed25519-signed release manifest. Draft releases are not offered to users. The update uses the existing per-user app identity and data folder, so presets and linked-receiver settings are preserved.

The app authenticates the release and rechecks the downloaded installer before installation. This does not make the installer Authenticode-signed or remove Windows publisher warnings. The private release-signing key is excluded from the repository and installer. Keyboard cleanup must complete before the installer is launched. Normal Quit does not install an update, and app updates never flash firmware.

The installed beta.4 to beta.6 and beta.6 to beta.7 updates were tested through the public GitHub beta feed on 29 October 2026. Download verification, installation and automatic restart succeeded, with the saved preset, receiver association, keymap backup and preview preference preserved in the normal Windows profile. Beta.7 also correctly displays the retained enabled Windows startup entry. A one-time migration was needed for earlier development data redirected by Codex's Windows app sandbox. The user then confirmed the features worked over 2.4 GHz and returned to USB. This user-reported functional check does not individually repeat every color pattern or establish broad hardware compatibility.

## Release contents and notices

The application and its required runtime libraries/assets are packaged through an explicit allowlist. `resources/legal/THIRD_PARTY_NOTICES.txt` contains the application dependency and asset notices and full license texts. `resources/legal/LICENSE.txt` contains the original application's MIT licence; `LICENSE_SCOPE.md` defines exclusions. Runtime and installer notices retain their directory structure below `resources/legal/`. Electron's `LICENSE` or `LICENSE.electron.txt` and `LICENSES.chromium.html` must remain with the executable distribution.

Firmware binaries, vendor updaters, patch generators, GPL research tools, development tests, temporary upstream checkouts, user backups and experiment artifacts must remain outside every installer and portable archive. A complete workspace ZIP is not a release package. Minification and ASAR packaging reduce loose source files; they are not encryption or reliable protection against extracting JavaScript.

## Before a public release

Firmware compatibility checks are available in **Settings → Firmware setup**. The warning limits the custom firmware to the same tested Crush 80 Pro hardware and firmware revision and states that incompatible firmware can brick the keyboard. It does not certify other Pro revisions. The application still provides no flash action or firmware payload. Revision matching, configuration restoration and recovery must be established before installation can be offered.

- Confirm the support contact, real donation URL if desired, and final commercial terms. The developer brand is mi0ir and the website is mi0ir.com; do not substitute invented contact or payment destinations.
- Keep all third-party notices. Re-audit the built package whenever dependencies, native binaries, bundled assets or build filters change.
- Inspect the actual installer/archive contents for excluded material and verify its hash. Verify installation, launch, uninstall, native HID loading, no-device behavior and permissions using the packaged build.
- Obtain and configure a code-signing identity if distributing a signed build. An unsigned beta is not a signed or reputation-verified release. Do not label signing, update delivery, crash reporting or installer QA complete without evidence.
- Expand the hardware/firmware/connection test matrix before broad compatibility claims. Review firmware-related distribution rights separately; this app release supplies no firmware.

For maintainers, `npm run package:check` validates release inputs, `npm run dist:dir` builds the unpacked Windows distribution, and `npm run dist:win` builds the installer. `npm run dist:verify` checks the produced package against its allowlist and release requirements. Run these from the project source tree; they are not commands for end users. A successful build alone does not demonstrate hardware compatibility or replace the final package and installation checks above.

## Microsoft Store local test

`npm run store:check` validates the Store build inputs. `npm run store:test -- --version 1.0.0.0` creates `dist/store-test/mi0ir.CrushControl.StoreTest_1.0.0.0_x64.msix` using a separate `build/.store-stage`, the existing release allowlists and the Windows SDK. It checks the packaged app, minified ASAR, native HID library, Electron fuses and extracted MSIX contents. Source files, firmware, user profiles and signing keys remain outside the distribution. `npm run test:store` runs the Store-specific device-free tests.

This unsigned Windows 11 test package has a distinct identity and display name. Installation uses Microsoft's documented `Add-AppxPackage -AllowUnsigned` test mechanism, which requires an administrator for executable packages. The narrowly scoped `tools/store-install-test.ps1` first checks the expected path, identity, version and SHA-256; without `-Install` it only inspects. It does not add certificates or change Developer Mode. Do not publish this local test package as a consumer release.

Quit the existing app before testing because separate profiles can permit two running hardware controllers. The local test uses `crush80-control-store-test`. `tools/store-profile.cjs` can snapshot current presets, receiver links and keymap backups from the original profile, copy only validated missing files to the observed test package's profile, and verify both copies and the original startup entry. Run this helper from the unpackaged Explorer context: a packaged terminal or agent may redirect nominal AppData paths into its own virtual filesystem. The helper rejects native paths that differ from the reviewed source or destination.

The staged Store marker and native package identity disable the GitHub installer updater. Local tests explain that they are unpublished; production Store packages route users to Microsoft's updates page. Startup registration is declared in the manifest, initially disabled, and managed through Windows Settings. The local test leaves the original app's startup registry entry alone.

Production packaging uses `node tools/store-build.cjs --store <identity.json>`, requiring the real reserved Partner Center name, publisher, publisher display name, app display name and four-part package version. No account or identity is fabricated. Store submission, signing by Microsoft and certification are separate from local package testing. Application source need not be made public, but packaged JavaScript is still extractable; ASAR and minification are not copy protection.

Reference: [Microsoft's unsigned MSIX testing requirements](https://learn.microsoft.com/en-us/windows/msix/package/unsigned-package).

## Evidence and limitations

The development UI suite passed 38 device-free checks for selection, presets, state recovery, lazy 3D loading and compact 1000×700 layout before the About/distribution additions. Backend and protocol suites cover request validation, queued operations, grouped LEDs, readback, reconnects and preset persistence. These automated results do not substitute for a clean-machine installed-build test or additional physical keyboards. Updated build-specific results belong in the release verification report produced with that package.

RGB writes use acknowledged sequential chunks and verified buffer readback. They are not atomic frame streaming, and readback does not measure physical LED color. Connection loss or a failed write can interrupt an update. Per-key state is volatile; PC presets supply recall after power loss. Native heartbeat/status behavior remains outside the per-key frame.

This software is an independent project. WOBKEY, Crush 80 and SignalRGB names describe compatibility and do not imply sponsorship or approval.
