# Upstream synchronization

## Baseline

- Fork snapshot: `17ed9f4b` (also `baseline/fork-v2.5.4`).
- Official v2.5.4: `13676d3335b4242a8342541bdd510295502268c1`.
- The fork has an independent root commit. Its initial snapshot already disables
  automatic update checks and silent installation, removes several repository
  guidance/toolchain files, and differs in executable modes and a font blob.
- The ancestry-only merge on `sync/upstream-v2.5.5` preserves the fork tree and
  records the official v2.5.4 baseline. It does not claim to import later fixes.

## v2.5.5 review

Target: `22e3f1ac8aefe4102ae2eb646a11a1ec614e8576`, verified against the
official remote tag on 2026-09-28. The tag itself is annotated.

The incoming release changes 126 files. Major areas are per-profile DNS override
state and precedence, provider cache isolation, service installation/Sidecar
handoff, IPC v2.7.3, extension override notices, updater version comparison,
and ASN resources. These are upstream changes, not independently audited
security guarantees.

The merge has no textual conflicts. Reviewed overlapping customization points:

- Node diagnostics remains registered in the backend and installed after
  authoritative configuration enforcement and proxy-group cleanup.
- Diagnostic modules, frontend node information, and separate status/latency
  testing remain present.
- Portable packaging and directory selection remain customized.
- Automatic update checks and silent startup updates remain disabled;
  updater artifact creation remains disabled. Upstream updater implementation
  fixes are included without re-enabling those entry points.
- Customized release workflows and removal of Telegram notifications remain.
- Generated localization declarations retain both upstream and custom keys.

Validation: TypeScript checking and Vite production build passed;
Vitest passed all 6 files / 22 tests;
staged diff whitespace checking passed. These checks used existing local
node_modules, not a fresh dependency installation. Rust/Cargo was not found in
PATH or the default user Cargo bin directory, so backend compilation, Rust tests,
installer builds, and interactive service/TUN/portable/diagnostics checks remain
outstanding. This branch is not yet release-validated.

## Next release

Official v2.5.6 resolves to `b057bd964ccd156f68bc43a3a8ed66cf3cb1cd7b`.
It has not been merged. Review it after validating v2.5.5, especially its
service security failure handling, startup recovery, IPC v2.7.4, Mihomo plugin,
and frontend dependency updates. Do not advance main or publish solely because
a merge has no conflicts.

For future releases, verify the official tag, create a synchronization branch,
merge that exact release, review the remaining diff against upstream, and test
the custom behaviors before integrating the branch. Preserve individual release
merge commits so the imported upstream boundary stays explicit.
