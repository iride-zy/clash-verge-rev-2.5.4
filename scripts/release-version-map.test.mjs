import assert from 'node:assert/strict'
import test from 'node:test'

import {
  releaseTagForVersion,
  updaterVersionForTag,
} from './release-version-map.mjs'

test('fork revisions round-trip between release tags and application versions', () => {
  for (const revision of ['1', '2', '10']) {
    const version = `2.5.5+${revision}`
    const tag = `v2.5.5.${revision}`
    assert.equal(releaseTagForVersion(version), tag)
    assert.equal(updaterVersionForTag(tag), version)
  }
})

test('ordinary versions and rolling release tags keep their existing behavior', () => {
  for (const version of ['2.5.5', '2.5.5-rc.1', '2.5.5+autobuild.0928.abcdef']) {
    assert.equal(releaseTagForVersion(version), `v${version}`)
    assert.equal(updaterVersionForTag(`v${version}`), `v${version}`)
  }
  for (const tag of ['autobuild', 'alpha', 'beta', 'rc']) {
    assert.equal(updaterVersionForTag(tag), tag)
  }
})
