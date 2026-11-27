import type { Health, ReactLike, Settings, SettingsResponse } from './types.js';

export interface SettingsViewProps {
  screen: 'setup' | 'settings';
  settings: Settings | null;
  setSettings(next: Settings): void;
  settingsResponse: SettingsResponse | null;
  health: Health | null;
  busy: boolean;
  onSave(): Promise<void>;
  onInitReviewers(): Promise<void>;
  onBack(): void;
}

export type SettingsViewComponent = (props: SettingsViewProps) => unknown;

export function createSettingsView(React: ReactLike): SettingsViewComponent {
  const h = React.createElement;

  return function SettingsView(props: SettingsViewProps) {
    const { screen, settings, setSettings, settingsResponse, health, busy, onSave, onInitReviewers, onBack } = props;
    if (!settings) return h('div', { className: 'dcr-empty' }, '加载设置…');
    const update = (patch: Partial<Settings>): void => setSettings({ ...settings, ...patch });

    return h('div', { className: 'dcr-body' },
      h('div', { className: 'dcr-wrap' },
        h('div', { className: 'dcr-card' },
          h('h3', null, screen === 'setup' ? '首次配置' : '本地设置'),
          h('div', { className: 'dcr-grid' },
            h('div', { className: 'dcr-field', style: { gridColumn: '1 / -1' } },
              h('label', { htmlFor: 'dcr-repo-root' }, '本地评审仓库'),
              h('input', {
                id: 'dcr-repo-root',
                className: 'dcr-input',
                value: settings.repoRoot,
                placeholder: 'Git/SVN 工作副本目录',
                onChange: (e: { target: { value: string } }) => update({ repoRoot: e.target.value }),
              }),
            ),
            h('div', { className: 'dcr-field' },
              h('label', null, '审核者（owner）'),
              h('input', {
                className: 'dcr-input',
                value: settings.owner,
                placeholder: settingsResponse?.suggestedOwner ?? '',
                onChange: (e: { target: { value: string } }) => update({ owner: e.target.value }),
              }),
            ),
            h('div', { className: 'dcr-field' },
              h('label', null, 'VCS'),
              h('select', {
                className: 'dcr-select',
                value: settings.vcsType,
                onChange: (e: { target: { value: string } }) => update({ vcsType: e.target.value as Settings['vcsType'] }),
              },
              h('option', { value: 'auto' }, '自动检测'),
              h('option', { value: 'git' }, 'Git'),
              h('option', { value: 'svn' }, 'SVN')),
            ),
            h('div', { className: 'dcr-field' },
              h('label', null, '基准分支（Git baseBranch，留空取当前分支）'),
              h('input', {
                className: 'dcr-input',
                value: settings.baseBranch ?? '',
                placeholder: 'main 或 master',
                onChange: (e: { target: { value: string } }) => update({ baseBranch: e.target.value }),
              }),
            ),
            h('div', { className: 'dcr-field' },
              h('label', null, 'AI 修复执行器'),
              h('select', {
                className: 'dcr-select',
                value: settings.runner,
                onChange: (e: { target: { value: string } }) => update({ runner: e.target.value as Settings['runner'] }),
              },
              ...(settingsResponse?.runners ?? [
                { value: 'dsh', label: 'DSH headless（默认）' },
                { value: 'manual', label: '手动修复' },
                { value: 'external', label: '外部命令' },
              ]).map((r) => h('option', { key: r.value, value: r.value }, r.label))),
            ),
            h('div', { className: 'dcr-field' },
              h('label', null, '门禁超时（秒）'),
              h('input', {
                className: 'dcr-input',
                type: 'number',
                value: Math.round(settings.gateTimeoutMs / 1000),
                onChange: (e: { target: { value: string } }) => update({ gateTimeoutMs: Math.max(60, Number(e.target.value) || 600) * 1000 }),
              }),
            ),
            h('div', { className: 'dcr-field' },
              h('label', null, 'DSH CLI 路径（留空自动检测）'),
              h('input', {
                className: 'dcr-input',
                value: settings.dshCommand,
                placeholder: '…\\runtime\\cli\\bin\\dsh.cmd',
                onChange: (e: { target: { value: string } }) => update({ dshCommand: e.target.value }),
              }),
            ),
            h('div', { className: 'dcr-field', style: { gridColumn: '1 / -1' } },
              h('label', null, '外部修复命令（prompt 从 stdin 传入）'),
              h('input', {
                className: 'dcr-input',
                value: settings.externalCommand,
                placeholder: 'codex exec -',
                onChange: (e: { target: { value: string } }) => update({ externalCommand: e.target.value }),
              }),
            ),
            h('div', { className: 'dcr-field', style: { gridColumn: '1 / -1' } },
              h('label', null, '审查子阶段优先外部执行器（逗号分隔，例如 codex, claude；不可用或留空时自动降级为本 Harness 独立子代理）'),
              h('input', {
                className: 'dcr-input',
                value: (settings.stageExecutors ?? []).join(', '),
                placeholder: 'codex, claude',
                onChange: (e: { target: { value: string } }) => update({
                  stageExecutors: String(e.target.value).split(',').map((s) => s.trim()).filter(Boolean),
                }),
              }),
            ),
          ),
          h('div', { className: 'dcr-checks' },
            h('label', { className: 'dcr-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.autoFixOnFailure,
                onChange: (e: { target: { checked: boolean } }) => update({ autoFixOnFailure: Boolean(e.target.checked) }),
              }),
              h('span', null, '批准阶段程序应用冲突时允许 Mode C 修复 Agent 辅助（门禁失败绝不自动修复）'),
            ),
            h('label', { className: 'dcr-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.syncBeforeApprove,
                onChange: (e: { target: { checked: boolean } }) => update({ syncBeforeApprove: Boolean(e.target.checked) }),
              }),
              h('span', null, '批准前同步最新基线'),
            ),
          ),
          h('div', { className: 'dcr-row', style: { marginTop: 12 } },
            h('button', { className: 'dcr-btn p', disabled: busy, onClick: () => { void onSave(); } }, busy ? '保存中…' : '保存'),
            h('button', { className: 'dcr-btn', disabled: busy, onClick: () => { void onInitReviewers(); } }, '初始化 reviewers.yml'),
            screen === 'settings' && health?.configured ? h('button', { className: 'dcr-btn', disabled: busy, onClick: onBack }, '返回评审') : null,
          ),
          settingsResponse && !settingsResponse.validation.ok
            ? h('div', { className: 'dcr-banner err', style: { marginTop: 10 } }, settingsResponse.validation.errors.join('；') || '配置不完整')
            : null,
        ),
        h('div', { className: 'dcr-card dcr-small dcr-muted' }, '本地评审使用此处保存的 Git/SVN 工作副本。owner 用于乐观锁与操作隔离；AI 修复默认调用本机 DSH headless profile。'),
      ),
    );
  };
}
