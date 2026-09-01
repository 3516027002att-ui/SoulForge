import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  C0000_COMPATIBILITY_CANDIDATE_LIMIT_PER_SLOT,
  canonicalCharacterStemForActionPath,
  planC0000CompatibilityCandidates
} from './actionPreviewCompatibility.js';

declare const __SOULFORGE_REPO_ROOT__: string;
const actionSource = readFileSync(
  join(__SOULFORGE_REPO_ROOT__, 'apps', 'desktop', 'src', 'main', 'ipc', 'action.ts'),
  'utf8'
);

describe('action preview compatibility planning', () => {
  it('canonicalizes c0000 animation variants to the c0000 companion model', () => {
    assert.equal(canonicalCharacterStemForActionPath('chr/c0000.anibnd.dcx'), 'c0000');
    assert.equal(canonicalCharacterStemForActionPath('chr/c0000_a000_lo.anibnd.dcx'), 'c0000');
    assert.equal(canonicalCharacterStemForActionPath('chr/c0000_a07x.anibnd.dcx'), 'c0000');
    assert.equal(canonicalCharacterStemForActionPath('chr/c0000_c1020.anibnd.dcx'), 'c0000');
    assert.equal(canonicalCharacterStemForActionPath('chr/c1020.anibnd.dcx'), 'c1020');
    assert.equal(canonicalCharacterStemForActionPath('chr/aicommon.anibnd.dcx'), 'aicommon');
  });

  it('orders candidates overlay-first then bytewise by name and de-duplicates base shadows', () => {
    assert.deepEqual(
      planC0000CompatibilityCandidates(
        'bd',
        ['bd_m_9100.partsbnd.dcx', 'not-a-part.txt', 'bd_m_9000.partsbnd.dcx'],
        ['bd_m_9000.partsbnd.dcx', 'bd_m_9030.partsbnd.dcx']
      ),
      [
        { origin: 'overlay', name: 'bd_m_9000.partsbnd.dcx' },
        { origin: 'overlay', name: 'bd_m_9100.partsbnd.dcx' },
        { origin: 'base', name: 'bd_m_9030.partsbnd.dcx' }
      ]
    );
  });

  it('rejects other slots and caps the per-slot plan', () => {
    const names = Array.from(
      { length: C0000_COMPATIBILITY_CANDIDATE_LIMIT_PER_SLOT + 5 },
      (_, index) => `am_m_${String(9000 + index).padStart(4, '0')}.partsbnd.dcx`
    );
    const planned = planC0000CompatibilityCandidates('am', names, ['lg_m_9000.partsbnd.dcx']);
    assert.equal(planned.length, C0000_COMPATIBILITY_CANDIDATE_LIMIT_PER_SLOT);
    assert.ok(planned.every((candidate) => candidate.name.startsWith('am_')));
  });

  it('keeps the native Wolf face/hair component ahead of cape and other form variants', () => {
    assert.deepEqual(
      planC0000CompatibilityCandidates(
        'fc',
        ['fc_m_0000.partsbnd.dcx'],
        ['fc_m_0000.partsbnd.dcx', 'fc_m_0100.partsbnd.dcx', 'fc_m_0200.partsbnd.dcx']
      ),
      [
        { origin: 'base', name: 'fc_m_0200.partsbnd.dcx' },
        { origin: 'overlay', name: 'fc_m_0000.partsbnd.dcx' },
        { origin: 'base', name: 'fc_m_0100.partsbnd.dcx' }
      ]
    );
  });

  it('wires the bounded planner and fail-closed remapper without hard-coded equipment ids', () => {
    assert.match(actionSource, /planC0000CompatibilityCandidates/);
    assert.match(actionSource, /remapCharacterBundleToLeader/);
    assert.match(actionSource, /ACTION_PREVIEW_LEADER_REMAP_APPLIED/);
    assert.match(actionSource, /ACTION_PREVIEW_LEADER_REMAP_FAILED/);
    assert.match(actionSource, /ACTION_COMPATIBILITY_PREVIEW_ASSEMBLED/);
    assert.doesNotMatch(actionSource, /(?:bd|am|lg)_m_\d{4}/i);
  });
});
