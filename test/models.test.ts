import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogEfforts, parseClaudeModels, parseCodexModels } from '../src/core/models';

test('codex model list: only listed models, in priority order, with their efforts', () => {
  const models = parseCodexModels({
    models: [
      { slug: 'gpt-6-sol', visibility: 'list', priority: 3, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
      { slug: 'gpt-6-astra', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'ultra' }] },
      { slug: 'codex-auto-review', visibility: 'hide', priority: 1 },
      { visibility: 'list' },
    ],
  });
  assert.deepEqual(models, [
    { id: 'gpt-6-astra', efforts: ['medium', 'ultra'] },
    { id: 'gpt-6-sol', efforts: ['low', 'high'] },
  ]);
  assert.deepEqual(catalogEfforts({ models, fetchedAt: '' }), ['low', 'medium', 'high', 'ultra']);
  assert.throws(() => parseCodexModels({ error: 'nope' }));
});

test('claude model list: ids and supported efforts', () => {
  const models = parseClaudeModels({
    data: [
      { id: 'claude-sonnet-5-5', capabilities: { effort: { supported: true, max: { supported: true }, low: { supported: true }, xhigh: { supported: false } } } },
      { id: 'claude-haiku-4-5-20251001', capabilities: { effort: { supported: false } } },
      { id: 'not-a-model' },
    ],
  });
  assert.deepEqual(models, [{ id: 'claude-sonnet-5-5', efforts: ['low', 'max'] }, { id: 'claude-haiku-4-5-20251001', efforts: undefined }]);
  assert.equal(catalogEfforts({ models: [{ id: 'x' }], fetchedAt: '' }), undefined);
});
