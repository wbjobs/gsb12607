// 侧边栏：脚注列表、问题列表。

import { h } from './dom.js';

function badge(text, cls) {
  return h('span', { class: `badge ${cls}` }, text);
}

export function renderFootnotesPanel(model, cbs) {
  const { defByLabel, refByLabel, numbers, cycleLabels } = model;
  const labels = [...defByLabel.keys()].sort((a, b) => {
    const na = numbers.get(a) ?? 1e9;
    const nb = numbers.get(b) ?? 1e9;
    return na - nb || defByLabel.get(a)[0].markerStart - defByLabel.get(b)[0].markerStart;
  });

  const root = h('div', { class: 'panel' });
  const head = h('div', { class: 'panel-toolbar' }, [
    h('span', { class: 'muted' }, `${labels.length} 个定义`),
    h('button', { class: 'btn btn-sm', title: '批量重命名', onClick: cbs.batchRename }, '批量重命名'),
  ]);
  root.append(head);

  if (labels.length === 0) {
    root.append(h('div', { class: 'empty' }, '暂无脚注定义'));
    return root;
  }

  const list = h('div', { class: 'fn-list' });
  for (const label of labels) {
    const defs = defByLabel.get(label);
    const primary = defs[0];
    const refs = refByLabel.get(label) || [];
    const duplicate = defs.length > 1;
    const cycle = cycleLabels.has(label);
    const num = numbers.get(label);
    const row = h('div', { class: `fn-row ${cycle ? 'is-cycle' : ''}` }, [
      h('div', { class: 'fn-row-main' }, [
        h('button', {
          class: 'fn-name',
          title: '跳转到定义',
          onClick: () => cbs.jump(primary.labelStart),
        }, [
          h('span', { class: 'fn-num' }, num != null ? String(num) : '–'),
          ` [^${label}]`,
        ]),
        h('div', { class: 'fn-meta' }, [
          `${refs.length} 处引用`,
          duplicate ? badge(`重复×${defs.length}`, 'badge-warn') : null,
          cycle ? badge('循环', 'badge-err') : null,
        ]),
      ]),
      h('div', { class: 'fn-row-actions' }, [
        h('button', { class: 'icon-btn', title: '重命名', onClick: () => cbs.rename(label) }, '✎'),
        h('button', { class: 'icon-btn', title: '删除定义', onClick: () => cbs.remove(label) }, '🗑'),
      ]),
    ]);
    list.append(row);
  }
  root.append(list);
  return root;
}

export function renderProblemsPanel(model, cbs) {
  const root = h('div', { class: 'panel' });
  const groups = [
    { type: 'cycle', title: '循环引用', cls: 'badge-err' },
    { type: 'dangling', title: '悬空引用', cls: 'badge-err' },
    { type: 'duplicate', title: '重复定义', cls: 'badge-warn' },
    { type: 'unused', title: '未被引用', cls: 'badge-info' },
  ];
  let total = 0;
  for (const g of groups) {
    const items = model.problems.filter((p) => p.type === g.type);
    total += items.length;
    if (items.length === 0) continue;
    root.append(h('div', { class: 'problem-group-title' }, [g.title, badge(String(items.length), g.cls)]));
    const box = h('div', { class: 'problem-list' });
    for (const p of items) {
      const { line } = model && model.starts ? lineCol(model, p.start) : { line: 0 };
      const actions = problemActions(p, cbs);
      box.append(h('div', { class: `problem-item problem-${p.type}` }, [
        h('div', {
          class: 'problem-msg',
          title: '跳转到位置',
          onClick: () => cbs.jump(p.start),
        }, [
          h('span', { class: 'problem-line' }, `L${line + 1}`),
          h('span', {}, p.message),
        ]),
        actions ? h('div', { class: 'problem-actions' }, actions) : null,
      ]));
    }
    root.append(box);
  }
  if (total === 0) root.append(h('div', { class: 'empty' }, '没有检测到问题 🎉'));
  return root;
}

function lineCol(model, offset) {
  let lo = 0;
  const starts = model.starts;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo] };
}

function problemActions(p, cbs) {
  if (p.type === 'dangling') {
    return [
      h('button', { class: 'link-btn', onClick: () => cbs.createDef(p.label) }, '创建定义'),
      h('button', { class: 'link-btn', onClick: () => cbs.removeRef(p.start) }, '删除引用'),
    ];
  }
  if (p.type === 'duplicate') {
    return [
      h('button', { class: 'link-btn', onClick: () => cbs.jump(p.start) }, '定位'),
      h('button', { class: 'link-btn', onClick: () => cbs.removeOccurrence(p.defKey) }, '删除此条'),
    ];
  }
  if (p.type === 'unused') {
    return [
      h('button', { class: 'link-btn', onClick: () => cbs.jump(p.start) }, '定位'),
      h('button', { class: 'link-btn', onClick: () => cbs.remove(p.label) }, '删除定义'),
    ];
  }
  if (p.type === 'cycle') {
    return [
      h('button', { class: 'link-btn', onClick: () => cbs.showGraph && cbs.showGraph(p.label) }, '在图中查看'),
    ];
  }
  return null;
}
