# Fork-only customizations

This fork intentionally maintains features and release behavior that the
upstream maintainers have said they will not develop or have declined to merge.
Keep these changes in the fork when synchronizing upstream. A clean Git merge
does not prove that a customization still works: review behavior and call order
in the files below after every upstream update.

This inventory is based on the fork compared with upstream v2.5.5
(`22e3f1ac8aefe4102ae2eb646a11a1ec614e8576`), the latest upstream release
currently incorporated into this branch. Paths can move; search for the named
symbols and behavior if an upstream refactor changes them.

## User-facing features

| Customization | Behavior to preserve | Main code locations |
|---|---|---|
| Node network diagnostics | Show proxy-path entry and exit IP/location and UDP NAT classification. Provide an explicit status test alongside ordinary latency testing. Avoid switching the user's active proxy group. | `src-tauri/src/core/node_diagnostics/`; `src-tauri/src/cmd/proxy.rs`; `src-tauri/src/enhance/mod.rs`; `src-tauri/src/lib.rs`; `src/services/node-diagnostics.ts`; `src/services/delay.ts`; `src/components/proxy/`; `src/providers/app-data-provider.tsx`; `src/types/proxy-view.ts`; `src/locales/*/proxies.json` |
| Automatic application updates disabled | Do not automatically check for or silently install upstream application updates. Keep manual update code available only as intended by the fork's current policy. | `src/hooks/use-update.ts`; `src-tauri/src/config/verge.rs`; `src-tauri/src/utils/resolve/mod.rs`; review `src/services/update.ts` and upstream updater changes |
| Updater artifacts disabled | Do not produce Tauri updater artifacts for fork releases unless the fork explicitly changes policy. | `src-tauri/tauri.conf.json` |
| Windows ZIP packaging | Build and publish the fork's Windows ZIP package. The marker selects the app data directory beside the executable; this is not a guarantee that every service or WebView cache is portable. | `scripts/portable.mjs`; `package.json` (`portable` script); `src-tauri/src/utils/dirs.rs`; `docs/windows-zip.md`; `.github/workflows/dev.yml`, `autobuild.yml`, `release.yml` |

## Fork release and repository policy

| Customization | Behavior to preserve | Main locations |
|---|---|---|
| Fork-specific CI and releases | Build and upload this fork's intended artifacts and platforms; preserve its signing configuration and workflow triggers. Compare each workflow with upstream before adopting upstream release changes. | `.github/workflows/autobuild.yml`; `.github/workflows/dev.yml`; `.github/workflows/release.yml` |
| Telegram release notifications removed | Do not restore upstream notification jobs or scripts unless the fork chooses to use them. | `.github/workflows/telegram-notify.yml` (intentionally absent); `scripts/telegram.mjs` (intentionally absent); related workflow helper scripts |
| Fork identity and documentation | Keep fork-specific instructions and references accurate; do not blindly replace them with upstream branding or release links. | `README.md`; `docs/` |

## Baseline-only differences

The original fork snapshot also removed upstream agent instruction files and
tool-version metadata, changed some executable file modes, and contains a
different `src-tauri/assets/fonts/SF-Pro.ttf` blob. These are baseline
differences rather than user-facing features. Review them when an upstream
change touches those files; do not treat every mode-only difference as a
functional customization.

## Synchronization review

For each upstream release, compare both the upstream change and the fork's
remaining delta. Review this inventory first, then inspect the corresponding
diffs and test each affected behavior:

```powershell
git diff <previous-upstream-tag> <new-upstream-tag> -- <path>
git diff <new-upstream-tag> main -- <path>
```

Update this document when a customization is added, removed, or changes
location. If upstream implements a listed feature, verify whether the fork's
version can be retired before deleting its code. Preserve upstream security
fixes while adapting the fork behavior; do not resolve a conflict by keeping
the fork side wholesale without reviewing the incoming logic.
