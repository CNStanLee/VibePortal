import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SkillInfo } from '../src/shared/types';
import { graphPrompt, mappable, parseGraph } from '../src/core/skillGraph';

const skill = (id: string, name: string, extra: Partial<SkillInfo> = {}): SkillInfo => ({ id, slug: name, name, description: `${name} does things.`, source: 'library', path: `/s/${name}/SKILL.md`, dir: `/s/${name}`, updatedAt: '2026-10-06T00:00:00Z', ...extra });

test('skill map: the reply becomes a graph of real skills and topics only', () => {
  const skills = mappable([skill('a1', 'release'), skill('a2', 'changelog'), skill('a3', 'pdf', { source: 'claude', managed: true }), skill('a4', 'copy', { installedCopy: true })]);
  assert.deepEqual(skills.map((s) => s.name), ['changelog', 'release', 'pdf'], 'no installed copies; library first, managed last');
  const prompt = graphPrompt(skills);
  assert.match(prompt, /s1\tchangelog/);
  assert.match(prompt, /s3\tpdf/);

  const reply = JSON.stringify({
    result: `Here you go:\n${JSON.stringify({
      topics: [
        { id: 't1', parent: null, name: { en: 'Shipping', zh: '发布' }, summary: { en: 'Get it out', zh: '发出去' } },
        { id: 't2', parent: 't1', name: { en: 'Notes' }, summary: { zh: '写说明' } },
        { id: 't3', parent: 't2', name: { en: 'Too deep', zh: '太深' }, summary: { en: '', zh: '' } },
        { id: 't9', name: { en: 'Empty', zh: '空' }, summary: { en: '', zh: '' } },
      ],
      skills: [
        { key: 's1', topic: 't2', summary: { en: 'From merged PRs', zh: '来自合并的 PR' } },
        { key: 's2', topic: 't1', summary: { en: 'Cut <b>it</b>', zh: '发布它' } },
        { key: 's1', topic: 't1', summary: { en: 'dupe', zh: '重复' } },
        { key: 's7', topic: 't1', summary: { en: 'ghost', zh: '不存在' } },
      ],
      links: [
        { from: 's2', to: 's1', kind: 'depends', note: { en: 'notes first', zh: '先写说明' } },
        { from: 's1', to: 's2', kind: 'related' },
        { from: 's2', to: 's1', kind: 'related' },
        { from: 's2', to: 's2', kind: 'depends' },
        { from: 's2', to: 's8', kind: 'depends' },
      ],
    })}`,
  });
  const g = parseGraph(reply, skills, 'haiku', new Date('2026-10-06T12:00:00Z'));
  assert.equal(g.model, 'haiku');
  assert.deepEqual(g.skillIds, ['a2', 'a1', 'a3']);
  // a one-language line is filled in for the other language
  assert.deepEqual(g.topics.find((t) => t.id === 't2'), { id: 't2', parent: 't1', name: { en: 'Notes', zh: 'Notes' }, summary: { en: '写说明', zh: '写说明' } });
  // sub-sub-topics lose their parent; empty topics are dropped; a skill it left out goes to "Other"
  assert.equal(g.topics.find((t) => t.id === 't3'), undefined, 't3 holds nothing');
  assert.equal(g.topics.find((t) => t.id === 't9'), undefined);
  assert.deepEqual(g.skills.find((s) => s.id === 'a3'), { id: 'a3', topic: 'other', summary: { en: 'pdf does things.', zh: 'pdf does things.' } });
  assert.ok(g.topics.some((t) => t.id === 'other'));
  assert.equal(g.skills.find((s) => s.id === 'a1')!.summary.en, 'Cut  b it /b', 'markup is stripped');
  assert.equal(g.skills.length, 3);
  // one link per pair and kind, none to itself or to unknown skills
  assert.deepEqual(g.links, [
    { from: 'a1', to: 'a2', kind: 'depends', note: { en: 'notes first', zh: '先写说明' } },
    { from: 'a2', to: 'a1', kind: 'related' },
  ]);
  assert.throws(() => parseGraph('sorry, no', skills, 'haiku'), /did not reply/);
});
