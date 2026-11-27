/**
 * DSH 评审面板浏览器入口：由 esbuild 打包为单文件 IIFE，供宿主以 classic script 加载。
 */
import { createApp } from './app.js';
import { createReviewPanel } from './connection-panel.js';
import { createDetailView } from './detail-view.js';
import { createDiffView } from './diff-view.js';
import { createFindingCard } from './finding-card.js';
import { createQueueView } from './queue-view.js';
import { createRichText } from './rich-text.js';
import { createSettingsView } from './settings-view.js';
import { CSS } from './styles.js';
import type { ClientCtx, Loader, ReactLike } from './types.js';

const PACKAGE_ID = 'dsh-code-review';
const PANEL_ID = 'code-review';
const NS = 'dsh-code-review';

function createPlugin(require: (id: string) => unknown): unknown {
  const React = require('react') as ReactLike;
  const h = React.createElement;
  const RichText = createRichText(React);
  const FindingCard = createFindingCard(React, RichText);
  const DiffView = createDiffView(React, RichText);
  const SettingsView = createSettingsView(React);
  const QueueView = createQueueView(React, FindingCard);
  const DetailView = createDetailView(React, RichText, FindingCard, DiffView);
  const App = createApp(React, SettingsView, QueueView, DetailView);
  const ReviewPanel = createReviewPanel(React, App);

  return {
    inject: ['slots', 'locale'],
    apply(ctx: ClientCtx) {
      ctx.effect(() => ctx.locale.register(NS, {
        zh: { nav: '评审' },
        en: { nav: 'Review' },
        ja: { nav: 'レビュー' },
      }), 'dsh-code-review: dictionaries');
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-dsh-code-review', '');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-code-review: styles');
      const t = ctx.locale.bind(NS);
      ctx.slots.inject('main', () => {
        const off = ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NS },
          ReviewPanel,
        );
        return typeof off === 'function' ? off : undefined;
      });
      ctx.slots.inject('sidebar.panellist', () => {
        const off = ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('nav'), locale: NS },
          ({ size = 16 }: { size?: number }) => h('svg', {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
          },
          h('rect', { x: 2.5, y: 3.5, width: 19, height: 17, rx: 3 }),
          h('path', { d: 'M7 9.5h10M7 13h4m2 2 2.5 2.5L19 14' })),
        );
        return typeof off === 'function' ? off : undefined;
      });
    },
  };
}

const loader = (window as unknown as { __ModuleLoader__: Loader }).__ModuleLoader__;
loader.load({ id: PACKAGE_ID, factory: createPlugin });
