// Fork revision tags use four numbers; Cargo and Tauri still receive SemVer.
export function releaseTagForVersion(version) {
  return `v${version.replace(/^(\d+\.\d+\.\d+)\+(0|[1-9]\d*)$/, '$1.$2')}`
}

export function updaterVersionForTag(tag) {
  return tag.replace(/^v?(\d+\.\d+\.\d+)\.(0|[1-9]\d*)$/, '$1+$2')
}
