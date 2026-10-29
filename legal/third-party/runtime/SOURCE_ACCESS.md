# Runtime source access

This application source repository contains runtime notices, extracted licence texts, source manifests, checksums and retrieval instructions. The separate runtime source archives were assembled locally; they are not included in this repository and have not been published. `SOURCE_INDEX.md` links their upstream sources. `runtime-source-manifest.json` records the exact revisions, file hashes and results of that historical local assembly, not files available in a fresh clone.

Publishing the app source does not complete covered-runtime source delivery to binary recipients. Beta.9 installer publication remains blocked by `legal/release-status.json`, including the combined-runtime relinking gap described below.

## What was assembled locally, outside this repository

- Electron **45.1.0**, full source tree at commit `45d20ec03000aac41e73b2abdb707936b4f98ed0`. This includes its complete downstream patch sets, patch-application scripts, build arguments and official Windows/GN build instructions.
- Chromium **156.0.8078.49**, independently resolved to commit `29eb03535d5f2f4f899b95f22a92413ffde5284e`. Build/config scripts, build overrides, build-tool metadata, Clang/Rust helper scripts and root GN/DEPS files are included.
- FFmpeg's **complete** pinned upstream source tree at `9db86ce5b5b454dfc96c435f9f0723012980c37f`, including `BUILD.gn`, generated source lists and Windows x64 Chrome configuration. Its declared source dependency Opus is included at the Chromium snapshot; NASM is included at `525a09a813be0f75b646ee93fc2a31c27b87d722`. Electron's FFmpeg patch is in the Electron archive. The checked Windows configuration has GPL, GPLv3 and nonfree options disabled.
- Complete conservative source subsets for the applicable MPL/LGPL notice candidates, including all Blink renderer/common/public files, Mozilla files, Hunspell, whole dictionaries, Eigen, gRPC, ISimpleDOM, libusb, hyphenation patterns, axe-core and all 12 vendored Symphonia crates and their generated GN wrappers. Exact source modifications already made by Chromium are preserved in its snapshots. Electron patches are supplied separately as upstream patch files.
- Full delivered Electron/Chromium notices, extracted licence documents from source archives, SHA256 checksums, and an offline verification command. Exact counts are recorded in the manifest. For axe-core, the preferred modular upstream source and build scripts are included in addition to Chromium's generated JavaScript copies.

The locally assembled archives are unmodified upstream snapshots. A Chromium subtree archive starts at the named directory; extract it at that path inside a source checkout. External checkout archives such as FFmpeg, Eigen and NASM must be placed at the paths named in Chromium's DEPS. Electron's archive has a top-level commit-named directory. Keep the original licences and source headers.

After obtaining the recorded source files at their recorded paths, verify without network access or running upstream code:

```powershell
node tools/prepare-runtime-sources.cjs --verify
```

Run this command from a checkout containing the source files; it is expected to fail in a fresh clone because the archives are absent. `SHA256SUMS.txt` and the committed manifest can also be checked with a SHA256 utility.

`tools/prepare-runtime-sources.cjs` without `--verify` retrieves upstream files and rewrites the assembly records. Run it only in a separate working copy after installing the pinned npm dependencies. Preserve the committed checksums and compare retrieved files with that original record; comparing only with a freshly rewritten manifest does not verify agreement with the audited inputs. The tool performs no HID operations, compilation, installation or upstream script execution.

## Source coverage versus unperformed tests

**MPL covered-file source:** the selected complete source directories were assembled locally and are absent from this repository. Providing those covered files and the licence/source-access notice does not require rebuilding the entire MIT/BSD runtime. A complete Windows build graph is useful for removing unnecessary source inclusions, but absence of that graph does not make the included covered source disappear.

**FFmpeg library source:** its full tree, direct declared source dependency and relevant upstream build/patch machinery were assembled locally and are absent from this repository. GN generation, a binary rebuild and replacing the DLL have not been attempted. Those unperformed tests are evidence limits, not by themselves a licence violation. A general upstream checkout remains the supported build route because GN loads project-wide configuration; this bundle has not been certified as a self-contained standalone GN workspace.

**Combined runtime relinking:** Blink is not merely a hypothetical notice match. Its renderer snapshot contains 961 C/C++ files whose headers refer to the GNU Library/Lesser GPL, including CSS parsing/rendering files. The Blink source was assembled locally, but the complete source or object-code closure needed to relink the combined Electron executable has not been locally assembled or certified. Other Chromium source directories, Node, V8 and their pinned dependencies are absent from this local bundle. This is distinct from an optional byte-for-byte rebuild test. Obtain the exact combined-work source through the pinned checkout instructions below and determine the applicable LGPL relink arrangement before describing the complete runtime source obligation as finished. Existing upstream access alone has not been represented as our completed binary-recipient delivery arrangement.

**Publication:** this repository publishes the application source and runtime notices, not the covered-runtime source archive. The separate source material bundle and any remaining required relink materials must be made available to binary recipients under a valid arrangement before source-delivery completion is claimed. Do not publish an unfulfillable written offer.

## Complete upstream checkout reference

These are source-access instructions, **not commands executed during this audit**. A full Electron/Chromium checkout can occupy many gigabytes. Use a separate directory, the official Windows prerequisites and depot_tools described in the [pinned Electron build documents](https://github.com/electron/electron/tree/45d20ec03000aac41e73b2abdb707936b4f98ed0/docs/development). Standard compiler/Windows SDK tools are separate prerequisites; their absence from this source bundle is not the same as missing covered-library source.

With an already installed, trusted depot_tools on PATH, Electron documents a gclient workspace named `src/electron`. Pin the audited Electron commit and disable hooks while acquiring source:

```powershell
mkdir electron-45.1.0-source
cd electron-45.1.0-source
gclient config --name src/electron --unmanaged https://github.com/electron/electron
gclient sync --with_branch_heads --with_tags --nohooks --revision src/electron@45d20ec03000aac41e73b2abdb707936b4f98ed0
```

Inspect the resulting `src/electron/DEPS`, `src/DEPS` and recorded revisions. Electron pins Chromium `156.0.8078.49` and Node `v24.22.1`; Chromium's DEPS fixes the rest of its dependency graph. Its checked Chromium commit is `29eb03535d5f2f4f899b95f22a92413ffde5284e`. Preserve all Electron patch stacks. `--nohooks` intentionally does not run post-checkout scripts or apply every build preparation step. Follow the pinned Electron `docs/development/build-instructions-windows.md` and `build-instructions-gn.md` only when performing an explicitly intended build. Do not treat this fetch command as a tested reconstruction recipe or a substitute for actual recipient source delivery.

The stock Windows package has a separate, delay-imported `ffmpeg.dll` beside the EXE. The ASAR integrity fuse checks `resources/app.asar`, not that DLL. A replacement must match the Electron ABI and architecture. No modified DLL has been run. Any compatibility test should use an isolated application copy without keyboard hardware and retain the original DLL for restoration.
