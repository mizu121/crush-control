# Crush Control

A Windows lighting app for the WOBKEY Crush 80 Pro, made by [mi0ir](https://mi0ir.com).

I wanted only WASD lit up. Crush Control lets you choose individual key colours, turn unused keys off and save your own presets.

[App website](https://mizu121.github.io/crush-control-releases/) · [Windows downloads](https://github.com/mizu121/crush-control-releases/releases) · [Report a bug](https://github.com/mizu121/crush-control/issues) · [Support development](https://buymeacoffee.com/mi0ir)

## What it does

- Select keys with a click, Shift-click or drag, then pick a colour.
- Save presets and switch between them from the app or Windows tray.
- Control the tested keyboard over USB or its linked 2.4 GHz dongle.
- Use the 2D keyboard layout, with an optional 3D preview.
- Sync rear-foot lighting on supported firmware. Heartbeat and status lights keep their own behaviour.

## Check compatibility first

**Per-key RGB needs the exact supported custom firmware on the tested Crush 80 Pro hardware revision. Wrong-model firmware can brick a keyboard.** The model name alone does not confirm compatibility.

The tested combined v1.04 image has CRC `0x5566DDF2` and the expected PKRG v2 capabilities. Settings → Firmware setup checks these. The app does not include or install firmware, and this repository contains no stock or modified firmware images. Patch research source is not a ready-to-flash firmware release.

Dongle control is experimental and limited to the linked `320F:5088` receiver and its tested keyboard. Bluetooth lighting control is not implemented. This is an independent project, not an official WOBKEY app.

## Source and release status

This repository starts with the **1.0.0-beta.9 development source**. The current public Windows installer is **beta.8** in the separate [release repository](https://github.com/mizu121/crush-control-releases). This snapshot includes later changes and is not represented as the exact source snapshot used to build beta.8.

Publishing the app source does not close the remaining binary-distribution work. Combined Electron/Chromium LGPL relinking materials and source delivery still need review; beta.9 native update and uninstall tests are also outstanding. The [binary release gate](legal/release-status.json) remains closed. Runtime and installer source archives prepared during that review are not included in this Git tree; the checked-in notices record their upstream revisions and verification limits.

## Build the app

Use Windows x64, Git and Node.js 22.12 or newer with npm. The lockfile pins the audited dependencies.

```sh
npm ci
npm run setup:runtime
npm test
npm run test:package
npm run package:check
```

`npm ci` downloads dependencies and runs their installation scripts. `npm run setup:runtime` downloads and extracts the pinned Electron runtime without launching it. The checks above do not connect to a keyboard. To launch the app deliberately:

```sh
npm start
```

Launching the app can connect to a supported keyboard. Quit other RGB controllers before using its direct lighting controls.

`npm run dist:win` creates an unsigned local installer in `dist/local-license-review`. It does not install, launch or publish the app. A local build is not a public-release approval. `private: true` in package.json prevents accidental npm publication; it does not restrict the MIT licence.

## Licences

Original app code is MIT. GPL-2.0-only patch generators and offline validation tools have their own retained notices and copying terms. Read LICENSE_SCOPE.md and THIRD_PARTY_NOTICES.txt. Choosing MIT for the app does not relicense firmware or third party components.

## Offline patch validation

See tools/firmware-validation/README.md for its isolated Python environment, commands, provenance and coverage limits. Synthetic patch checks do not require OEM firmware; extra stock checks require the exact user-supplied file. No OEM firmware, installer/flasher, retired harness, private signing key, user settings, device dump or development history is included. The package scripts intentionally omit historical live research and release publication commands.

## Contributing

Issues and pull requests are welcome. Include the app version, connection mode and a short way to reproduce the problem. Do not upload firmware dumps, signing keys, device identifiers or personal settings. For lighting or transport changes, describe the hardware actually tested rather than assuming every Crush 80 Pro revision behaves the same.
