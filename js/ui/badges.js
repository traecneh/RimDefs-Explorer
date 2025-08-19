import { h } from '../core/dom.js';

export function makePill(kind, label, bg) {
  const dot = h('span', { class: 'dot', style: `background:${bg}` });
  return h('span', { class: 'pill', title: kind }, dot, label);
}
