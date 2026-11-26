import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewStore } from '../packages/dsh-plugin/dist/host/store.js';
import { parseHumanJudgmentItems, isEmptyHumanJudgmentText } from '../packages/dsh-plugin/dist/host/frontmatter.js';
import { createGitFixture, runCommand } from './helpers.mjs';
import { writeCandidate as writeSchemaCandidate } from './fixtures/contract.mjs';

test('placeholder human-judgment text is treated as empty', () => {
  for (const value of ['', '  ', '无', '无。', '无：响应字段不变', '暂无', '不适用', 'None', 'n/a', '**无**。']) {
    assert.equal(isEmptyHumanJudgmentText(value), true, value);
  }
  for (const value of ['无法本地验证弱网路径', '架构影响：新增导出函数', '无特殊风险时需要确认回滚策略']) {
    assert.equal(isEmptyHumanJudgmentText(value), false, value);
  }
});

test('parseHumanJudgmentItems drops "无" categories and keeps real decisions', () => {
  const items = parseHumanJudgmentItems([
    '- **业务逻辑与产品取舍**：无。响应字段、过滤语义均不变。',
    '- **架构、兼容性与性能影响**：`matchesReviewFilter` 成为导出函数，需要确认命名。',
    '- 无',
    '- **无法由自动化测试验证的边界条件**：性能收益没有基准断言。',
    '- 无冒号但需要确认的说明',
  ].join('\n'));

  assert.deepEqual(items.map((item) => item.label), ['架构、兼容性与性能影响', '无法由自动化测试验证的边界条件', '需人工确认']);
  assert.match(items[1].text, /基准断言/);
});

async function writeCandidate(root, baseRevision, humanSection) {
  await writeSchemaCandidate(root, 'readable', {
    month: '2026-10',
    review: {
      baseRevision: JSON.stringify(baseRevision),
      title: 'test: 可读的审查文案',
      module: 'test',
      tags: '[test]',
      commitMessage: 'test: 可读的审查文案',
      bodyLines: [
        '# 问题与影响',
        '- **触发**：调用加法时结果错误。',
        '',
        '# 根因',
        '- 运算符写反。',
        '',
        '# 当前修复方案',
        '- 改回加号并补测试。',
        '',
        '# 需人工判断项',
        humanSection,
        '',
        '# 验证证据',
        '- `npm test` 通过。',
        '',
        '# 审核记录',
        `## 版本 1 (base: ${baseRevision})`,
        '- 初始版本。',
      ],
    },
  });
}

test('a candidate that only says "无" is declared and valid, without fake review items', async () => {
  const root = await createGitFixture();
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeCandidate(root, baseRevision, '- **业务逻辑与产品取舍**：无。响应字段不变。\n- 无');
  const store = new ReviewStore(root);

  const detail = await store.get('2026-10/readable', baseRevision);
  assert.equal(detail.candidate.humanJudgmentDeclared, true);
  assert.deepEqual(detail.candidate.humanJudgment, []);
  assert.deepEqual(await store.validateFullCandidate(detail.candidate), []);

  const listed = await store.list({ owner: 'tester' }, baseRevision);
  assert.equal(listed.items[0].humanJudgmentCount, 0);
  assert.equal(listed.items[0].humanJudgmentDeclared, true);
});

test('a candidate without the human-judgment section is invalid', async () => {
  const root = await createGitFixture();
  const baseRevision = runCommand('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await writeCandidate(root, baseRevision, '');
  const store = new ReviewStore(root);

  const detail = await store.get('2026-10/readable', baseRevision);
  assert.equal(detail.candidate.humanJudgmentDeclared, false);
  const errors = await store.validateFullCandidate(detail.candidate);
  assert.ok(errors.some((e) => /需人工判断项/.test(e)), errors.join('；'));
});
