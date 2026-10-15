# Fork-only customizations

This fork intentionally maintains features and release behavior that the
upstream maintainers have said they will not develop or have declined to merge.
Keep these changes in the fork when synchronizing upstream. A clean Git merge
does not prove that a customization still works: review behavior and call order
in the files below after every upstream update.

This inventory was established against upstream v2.5.5
(`22e3f1ac8aefe4102ae2eb646a11a1ec614e8576`). This fork synchronizes with
upstream v2.5.8
(`3fee9e8747c88580b67d28eff892ffc3418c07d4`). Paths can move; search for the
named symbols and behavior if an upstream refactor changes them.

## User-facing features

| Customization | Behavior to preserve | Main code locations |
|---|---|---|
| Node network diagnostics | Show proxy-path entry and exit IP/location and UDP NAT classification. Provide an explicit status test alongside ordinary latency testing. Avoid switching the user's active proxy group. | `src-tauri/src/core/node_diagnostics/`; `src-tauri/src/cmd/proxy.rs`; `src-tauri/src/enhance/mod.rs`; `src-tauri/src/lib.rs`; `src/services/node-diagnostics.ts`; `src/services/delay.ts`; `src/components/proxy/`; `src/providers/app-data-provider.tsx`; `src/types/proxy-view.ts`; `src/locales/*/proxies.json` |
| Automatic application updates disabled | Do not automatically check for or silently install upstream application updates, including when an old configuration enables the upstream switch. Keep manual checks and their cached results available to the update dialog. | `src/hooks/use-update.ts`; `src/components/home/system-info-card.tsx`; `src/components/setting/setting-verge-advanced.tsx`; `src/components/setting/mods/misc-viewer.tsx`; `src-tauri/src/config/verge.rs`; `src-tauri/src/utils/resolve/mod.rs`; review `src/services/update.ts` and upstream updater changes |
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

For each upstream release, review this inventory and inspect the release diff
before integrating:

```powershell
$env:HTTP_PROXY="http://127.0.0.1:7897"; $env:HTTPS_PROXY="http://127.0.0.1:7897"
git fetch upstream tag v2.5.8
git switch main
git merge --no-commit --no-ff v2.5.8
git restore --staged --source=HEAD -- . # 解决冲突后执行；随后审阅工作区改动
git add -A; git commit -m "chore(sync): upstream v2.5.8" # 审阅完成后执行
```

Update this document when a customization is added, removed, or changes
location. If upstream implements a listed feature, verify whether the fork's
version can be retired before deleting its code. Preserve upstream security
fixes while adapting the fork behavior; do not resolve a conflict by keeping
the fork side wholesale without reviewing the incoming logic.

For the v2.5.8 synchronization, accept the upstream event bus, shared state,
typed notifications, provider-read timeout and source/URL-aware latency cache.
Adapt the fork's status diagnostics to those interfaces; newer core latency
history must retain its diagnostic result, and profile-generation or test-URL
changes must reject stale diagnostic replies. Different URLs must not share
in-flight status measurements or inherit each other's diagnostic state. Keep
both upstream and fork regression tests.
Status results have an independent, generation- and URL-scoped persistent cache
so latency expiry and lightweight-mode WebView recreation do not erase them.
Diagnostics own each private inlet through cleanup; TCP and UDP run concurrently
within it, and independent provider inlets may run in parallel. Preserve those
boundaries when changing test scheduling.
The current v2.5.8 fork revision uses `2.5.8+2` in all four internal version
fields and the public release tag `v2.5.8.2`.


# add
git remote add upstream https://github.com/clash-verge-rev/clash-verge-rev.git
添加upstream对应原作者

# release

## 同步四处内部版本号
pnpm release-version 2.5.8+2

## 提交并推送
git add package.json src-tauri/Cargo.toml Cargo.lock src-tauri/tauri.conf.json
git commit -m "chore(release): 2.5.8+2"
git push origin main

## 创建独立发布，触发 Release Build
git tag v2.5.8.2
git push origin v2.5.8.2
