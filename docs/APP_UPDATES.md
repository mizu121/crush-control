# App updates

Crush Control is an independent app by [mi0ir](https://mi0ir.com). Its Windows
app updater uses the public [mizu121/crush-control-releases repository](https://github.com/mizu121/crush-control-releases)
and the **beta** channel. This updates the desktop application only; it does
not install, modify, or distribute keyboard firmware.

## First installation and normal use

Install the first updater-capable Windows x64 version manually. Older builds
without this updater cannot discover the new update service. Use Settings to
check for updates, download a verified release, then choose the install action.
Do not treat a GitHub draft as an available update: drafts are for review and
are not publicly downloadable through this feed.

The app releases its keyboard connection before handing off to the installer.
The installer may wait up to ten seconds for an update's parent process to
exit, plus the time taken by Windows API calls. It never forcibly terminates the app. If the app remains open, setup
stops and asks the user to quit it. Ordinary installation and uninstallation
continue to refuse immediately while the app is running. Closing the window
can leave the tray process running; use Quit or Ctrl+Q.

The current Windows build has **no Authenticode certificate**. Windows may
show an unknown publisher or SmartScreen warning. The app's release signature
is separate from Windows code signing; it does not remove these warnings or
authenticate a first installer obtained from an untrusted source.

## Installed-update verification

On 29 October 2026, the installed beta.4 app downloaded beta.6 from the public
GitHub beta feed, verified it, ran the installer, and restarted automatically.
The normal Windows profile retained byte-identical saved presets, receiver
links and keymap backup. The saved Gaming preset, linked-receiver status and
light preview were present after restart. A subsequent beta.6 to beta.7 update
passed the same installed flow and exact file checks. Beta.7 fixes the startup
toggle to reflect the retained enabled custom Run entry. The user subsequently
confirmed the features worked over 2.4 GHz, then reconnected USB; the installed
app was observed connected over USB with the FPS focus preset displayed. This
closes the pending user functional check on this board. It is not an exhaustive
retest of each color pattern, and software readback is not a physical color measurement.

The earlier development session was launched by the packaged Codex desktop
app, which redirected its apparent Roaming profile into Codex's private
LocalCache. The normal Explorer-launched installer correctly used the real
Windows profile. A one-time, hash-verified migration of the three approved
settings/backup files resolved this development-to-installed transition.
No keyboard firmware or signing keys were copied. Ordinary installed-app
updates continue to use the same real profile.

For development migrations, a matching printed path is not enough: compare
native final paths. Do not silently replace an existing installed profile or
copy Chromium caches and signing material. Keep source backups and verify the
destination from an unpackaged process.

## Authentication and packaged files

The packaged app pins the repository, channel and Ed25519 public verification
key in `app/update-config.json`. Only that public key is distributed. A release
must include a signed envelope named `crush-control-VERSION-update.json` under
tag `vVERSION`. Its signed payload identifies this app, repository, channel,
version, exact installer filename, SHA-512 digest, size and plain-text notes.
The app verifies the signature and matching metadata before accepting a
release, verifies downloaded or cached bytes, and checks again before install.

`resources/app-update.yml` contains only the public GitHub provider, owner,
repository, beta channel, `private: false` and cache directory name
`crush80-control-updater`. It contains no token or private signing key. Existing
Windows publisher verification remains available if a publisher is configured
in a future signed distribution; the current package does not configure one.

The updater engine is electron-updater 6.8.11, bundled into
`app/vendor/electron-updater.cjs`. Packaging records the 16 reviewed packages,
every compiled source hash and the generated bundle hash in the local staging
manifest. New dependency versions or licenses require review. Full third-party
notices ship in `resources/legal/THIRD_PARTY_NOTICES.txt`. The upstream lazy-val
package declares MIT but omits a separate license file; its author and license
metadata provenance are explicitly recorded in those notices.

## Maintainer release workflow

The app source is published separately from its Windows installers. Beta.9 binary
release remains blocked by `legal/release-status.json`; publishing this repository
does not clear the runtime source/relink requirements or native installer checks.
The steps below describe a later binary release after those gates are resolved.

1. Bump the package and lockfile version together. Keep the beta channel and
   pinned release repository consistent. Run the updater/security tests and
   `npm run test:package`, then `npm run package:check`.
2. Build the Windows x64 candidate with `npm run dist:win`. For an unpacked
   local candidate, use `npm run dist:dir`. Build commands always pass
   `publish: 'never'`.
   A configured public feed does not grant permission to upload anything.
3. Write plain-text release notes in `docs/releases/VERSION.md`. Inspect the
   package and installer verification reports, then run the
   maintainer signing helper, `node tools/update-release.cjs --sign`. It must
   verify the built package, installer and `beta.yml` before creating the
   signed envelope. Keep the private key outside this repository and backups
   intended for distribution. Never include it in the app, source archive,
   release assets, logs or browser code.
4. Review the exact installer, its blockmap, `beta.yml`, and signed envelope.
   An explicitly requested `node tools/update-release.cjs --draft` uploads only
   those four allowlisted assets to a GitHub **draft** release. The helper does
   not publish the draft. Publishing requires a separate deliberate release
   decision after review. Do not replace signed bytes after signing.
5. Verify a published update end to end on an isolated test installation before
   recommending the channel broadly. Retain the tested installer and signed
   envelope for recovery. A source test or successful package build alone is
   not evidence that a public update was installed successfully.

The first manual installation establishes trust in the bundled public key.
Losing that private key prevents signing future updates for those installs;
compromise requires a planned key rotation or a fresh trusted installation.
Protecting that key remains the maintainer's responsibility.

Implementation references: the pinned electron-updater source under
`node_modules/electron-updater/out/NsisUpdater.js` defines the `--updated`
installer handoff; Electron Builder's `PublishManager.js` writes public feed
metadata separately from its publish policy. Builder's `nsisScriptGenerator.js`
defines `isUpdated` through `StdUtils.TestParameter`; the bounded wait uses that
exact flag parser. NSIS
[GetOptions](https://nsis.sourceforge.io/Docs/AppendixE.html) was also inspected,
but its option-value parsing is unsuitable for the mixed `--updated /S` flags.
