import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import AdmZip from 'adm-zip'

const root = fileURLToPath(new URL('../', import.meta.url))
const architectures = {
  'x86_64-pc-windows-msvc': 'x64',
  'i686-pc-windows-msvc': 'x86',
  'aarch64-pc-windows-msvc': 'arm64',
}

// Archive only build inputs, never configuration from a previously launched app.
export function createPortableZip(releaseDir, version, arch) {
  const binaries = [
    'clash-verge.exe',
    'verge-mihomo.exe',
    'verge-mihomo-alpha.exe',
  ]
  const resources = path.join(releaseDir, 'resources')
  const required = [
    ...binaries.map((name) => path.join(releaseDir, name)),
    ...[
      'clash-verge-service.exe',
      'clash-verge-service-install.exe',
      'clash-verge-service-uninstall.exe',
    ].map((name) => path.join(resources, name)),
  ]
  for (const file of required) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(
        `Missing build artifact: ${file}. Run prebuild and build first.`,
      )
    }
  }

  const zip = new AdmZip()
  for (const name of binaries) {
    zip.addLocalFile(path.join(releaseDir, name))
  }
  zip.addLocalFolder(resources, 'resources')
  zip.addFile('PORTABLE', Buffer.alloc(0))

  const outputDir = path.join(releaseDir, 'bundle', 'portable')
  fs.mkdirSync(outputDir, { recursive: true })
  const output = path.join(
    outputDir,
    `Clash.Verge_${version}_${arch}_portable.zip`,
  )
  zip.writeZip(output)
  return output
}

if (import.meta.main) {
  const target = process.argv[2]
  const arch = target
    ? architectures[target]
    : { x64: 'x64', ia32: 'x86', arm64: 'arm64' }[process.arch]
  if (process.platform !== 'win32' || !arch || process.argv.length > 3) {
    throw new Error(
      'Usage on Windows: pnpm portable [Windows MSVC target triple]',
    )
  }
  const targetDir = process.env.CARGO_TARGET_DIR
    ? path.resolve(process.env.CARGO_TARGET_DIR)
    : path.join(root, 'target')
  const releaseDir = path.join(
    targetDir,
    ...(target ? [target] : []),
    'release',
  )
  const { version } = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  )
  console.log(`Created ${createPortableZip(releaseDir, version, arch)}`)
}
