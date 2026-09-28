# Fork releases

Numeric fork revisions use separate GitHub release tags while keeping the application
version valid for Cargo and Tauri:

| Application version | Git tag / release |
| --- | --- |
| `2.5.5+1` | `v2.5.5.1` |
| `2.5.5+2` | `v2.5.5.2` |

Run `pnpm release-version 2.5.5+2`, commit the version files on `main`, push
`main`, then create and push `v2.5.5.2`. Pushing the tag starts Release Build.
The release tag must point to the commit containing the matching version files.

Release titles and URLs use the Git tag. Installer filenames use the application
version. Update manifests translate four-part tags back to SemVer. Build metadata
does not increase SemVer precedence, so these revisions require manual installation
when upgrading from `2.5.5` or another `2.5.5+N` revision.

Auto Build continues updating its existing `autobuild` release. Fork releases do
not submit the upstream application's package to WinGet.
