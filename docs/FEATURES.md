# Crush Control features

A Windows desktop controller for the tested WOBKEY Crush 80 Pro over USB, with experimental lighting over its linked 2.4 GHz receiver. The app controls the keyboard's existing firmware; it does not install or flash firmware.

Developed by **mi0ir** · [mi0ir.com](https://mi0ir.com). This is an independent application. Original app source is available under MIT; retained third-party and GPL tool licences are described in [LICENSE_SCOPE.md](../LICENSE_SCOPE.md). This source publication does not release a beta.9 installer.

## Lighting

- Whole-board color picker, brightness and speed controls, plus the keyboard's native effects.
- A large 2D keyboard layout with click, drag selection and Shift/Ctrl-click to add or remove keys. Choose **All keys** to return to whole-board control; Ctrl+A and Escape work while the preview has focus.
- Optional 3D silver keyboard preview, loaded only when selected, with dark and light preview backgrounds. The model and displayed colors are visual approximations.
- On the exact supported custom firmware, selected keys can have independent colors or be turned off. Caps Lock and the spacebar apply to their grouped LED slots together.
- **WASD only**, **FPS focus**, **Neon split**, **Aurora**, **Ember & ice** and **Clear keys** are static per-key starter looks. **Spectrum wave** and **Color rain** use native keyboard animations.
- Save and recall named presets on this PC, including a full per-key frame, brightness and the whole-board color used by the rear feet. Pending picker changes finish before a preset is captured.
- Rear feet follow the whole-board picker on supported custom firmware. Editing only selected keys leaves their color alone. Rear brightness and power still follow the keyboard's native rear settings. The heartbeat/status animation remains separate.

**Clear keys switches off the main key lights.** It does not promise to darken the rear feet or the heartbeat/status lights. Per-key frames are live RAM state and reset when the keyboard loses power. Saved PC presets can be reapplied; they are not firmware-stored profiles. This build has no custom streaming animation engine, audio visualizer or game integration.

## Key mapping and desktop controls

- Read and edit the VIA keymap, with readback verification and local backup/restore controls.
- Tray access to presets, an explicit Quit action, and optional start with Windows. Closing the window leaves the app in the tray; Ctrl+Q quits.
- SignalRGB status and installation of this project's separate whole-board VIA plugin. The plugin samples SignalRGB into one board color; it does not stream independent per-key colors.
- About, version, third-party notices, the developer website and an optional [Buy Me a Coffee](https://buymeacoffee.com/mi0ir) support link.
- **Settings → Firmware setup** reports the current wired firmware compatibility and shows the wrong-model/bricking warning. This release checks compatibility; firmware installation is unavailable.
- **Settings → Dongle** links the paired receiver while the verified keyboard is connected by USB. Picker edits and per-key presets then use the receiver without the cable. USB takes priority when reconnected. Key mapping and onboard SAVE remain USB-only.
- Battery percentage appears in the header and tray icon. It comes from Windows' paired Bluetooth battery report, with its real update time. A stale reading is explicitly marked **last known**; missing or ambiguous data stays unavailable. USB/receiver battery telemetry and a charging flag have not been established.

Quit SignalRGB and other keyboard controllers before using direct lighting controls. The installed application does not silently stop or restart those programs. The app blocks direct RGB writes while it detects SignalRGB running.

## App updates

**Settings → App updates** checks the release-only GitHub repository, shows release notes, and offers download followed by **Restart and install**. The app verifies its release signature and installer hash, including cached downloads. Checks never silently download or install. The first updater-enabled version requires a manual install; existing presets and receiver links are kept. App updates do not flash firmware. The existing beta installers remain unsigned by Windows. The beta.9 binary release remains blocked pending the documented licence and native installer checks.

## Compatibility and current evidence

| Capability | Current boundary |
| --- | --- |
| Platform | Windows x64; wired USB tested on one user's Crush 80 Pro |
| Device identity | USB `320F:5055`, VIA interface 1, usage page `FF60`, usage `0061` |
| Stock firmware | Whole-board VIA lighting and keymap features; no arbitrary per-key RGB or rear-follow support |
| Per-key and rear-follow | Exact locally tested combined v1.04 firmware CRC `0x5566DDF2` plus the expected PKRG v2 capability response |
| Other firmware | A version label, matching USB ID, or another PKRG build does not establish compatibility; direct per-key writes remain gated |
| Mapping | 88 physical key targets covering 91 slots; full presets contain 92 main slots. Caps/Space groups are intentional. The unmapped alternate slot is not another visible key |
| Physical checks | Esc/F1–F4, Caps Lock, spacebar, rear feet and normal typing were observed. Remaining mapping has firmware-table and CPU-emulation evidence, not an individual visual check of every key |
| Wireless typing | Bluetooth and 2.4 GHz typing were physically confirmed on the tested patched board with the USB cable disconnected; the receiver was also removed for Bluetooth isolation |
| Wireless app controls | Experimental picker and presets via the linked `320F:5088` receiver, requiring the exact PKRG v2 capability reply; Bluetooth has no implemented RGB transport |
| Receiver association | Saved on this PC after exact combined firmware is verified over USB. It is an association with the user's paired dongle, not remote firmware attestation. A different receiver/USB port may require linking again; do not re-pair a linked receiver to an unsupported board |
| Battery | Windows Bluetooth report only; paired node presence alone does not make a reading fresh. No inferred charging state |
| Other systems / units | macOS, Linux, other Crush variants and additional units have not been validated |

Stock firmware can ignore VIA colors while its own rainbow color step is active. Color calibration comes from observations on one unit, so the picker is not a calibrated measurement of every keyboard's light output.

The desktop app and this source repository contain no OEM updater, stock image, custom image, or flashing tool. Its presence does not make custom firmware installation safe or supported. Recovery from a keyboard that no longer enumerates over USB has not been established by this work.
