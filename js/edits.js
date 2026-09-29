// 基于 range 的原子编辑：重命名（单个/批量）与删除定义。
// 所有规划先在旧文本坐标上计算，再按下标倒序应用。

import { parseMarkdown } from './footnotes.js';

export function applyEdits(text, edits) {
  const sorted = edits
    .filter((e) => e.start >= 0 && e.end <= text.length && e.end >= e.start)
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

export function isLegalLabel(label) {
  if (typeof label !== 'string') return false;
  const t = label.trim();
  if (t.length === 0) return false;
  if (/[\]\n\r]/.test(t)) return false;
  return true;
}

function labelEditsFor(model, label, newLabel) {
  const edits = [];
  for (const d of model.defs) {
    if (d.label === label) edits.push({ start: d.labelStart, end: d.labelEnd, text: newLabel, kind: 'def-label', defKey: d.key });
  }
  for (const r of model.refs) {
    if (r.label === label) edits.push({ start: r.labelStart, end: r.labelEnd, text: newLabel, kind: 'ref-label', refKey: r.key });
  }
  return edits;
}

// 单个脚注重命名：冲突（目标标签已存在）时给出错误，不生成编辑。
export function planRename(model, oldLabel, newLabel) {
  const target = newLabel.trim();
  if (!isLegalLabel(target)) {
    return { ok: false, reason: 'illegal', message: '标签不能为空，且不能包含 ] 或换行' };
  }
  if (target === oldLabel) {
    return { ok: true, edits: [], unchanged: true };
  }
  if (model.defByLabel.has(target)) {
    return { ok: false, reason: 'conflict', message: `标签 [^${target}] 已经存在，重命名会造成重复定义` };
  }
  return { ok: true, edits: labelEditsFor(model, oldLabel, target) };
}

// 批量重命名：mapping = [{ oldLabel, newLabel }]。
// 先校验：非法、目标与现存非自身冲突、批次内目标重复。返回每项状态。
export function planBatchRename(model, mapping) {
  const items = mapping.map((m) => ({ ...m, newLabel: (m.newLabel || '').trim(), edits: [], error: null }));
  const seenTargets = new Set();
  for (const item of items) {
    if (!model.defByLabel.has(item.oldLabel)) {
      item.error = '源标签不存在';
      continue;
    }
    if (!isLegalLabel(item.newLabel)) {
      item.error = '标签非法';
      continue;
    }
    if (item.newLabel === item.oldLabel) continue;
    if (model.defByLabel.has(item.newLabel)) {
      item.error = `与已有标签 [^${item.newLabel}] 冲突`;
      continue;
    }
    if (seenTargets.has(item.newLabel)) {
      item.error = '批次内目标标签重复';
      continue;
    }
    seenTargets.add(item.newLabel);
  }
  let hasError = items.some((i) => i.error);
  if (hasError) return { ok: false, items };

  const edits = [];
  for (const item of items) {
    if (item.newLabel === item.oldLabel) continue;
    const planned = planRename(model, item.oldLabel, item.newLabel);
    if (!planned.ok) {
      item.error = planned.message;
      hasError = true;
      continue;
    }
    item.edits = planned.edits;
    edits.push(...planned.edits);
  }
  return { ok: !hasError, items, edits: hasError ? [] : dedupeEdits(edits) };
}

function dedupeEdits(edits) {
  const seen = new Set();
  const out = [];
  for (const e of edits) {
    const k = `${e.start}:${e.end}:${e.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

// 删除定义。options:
//   occurrence: 'primary'（默认，仅删主定义；重复定义存在时不移动引用）
//             | 'all'（删除该标签全部定义行）
//   refs: 'keep'（默认，保留引用 -> 悬空，可配合 createDangling）
//         | 'remove'（连引用标记一起删除）
//         | 'convert'（去掉脚注标记，只保留内部文字；脚注无内部文字，等同 remove）
export function planDeleteDefinition(text, model, label, options = {}) {
  const { refs = 'keep' } = options;
  const list = model.defByLabel.get(label) || [];
  if (list.length === 0) return { ok: false, reason: 'missing', edits: [] };

  const targets = list.slice(); // 所有同名定义（含重复）
  const edits = [];

  // 删除定义块：从 blockStart 到行尾，连同换行。
  for (const d of targets) {
    let end = d.blockEnd;
    if (text[end] === '\n') end += 1;
    let start = d.blockStart;
    edits.push({ start, end, text: '', kind: 'delete-def', defKey: d.key });
  }

  let dangling = [];
  if (refs === 'remove' || refs === 'convert') {
    for (const r of model.refs) {
      if (r.label !== label) continue;
      edits.push({ start: r.start, end: r.end, text: '', kind: 'delete-ref', refKey: r.key });
    }
  } else {
    dangling = model.refs.filter((r) => r.label === label).map((r) => ({ start: r.start, end: r.end }));
  }

  return {
    ok: true,
    edits: edits.sort((a, b) => b.start - a.start),
    dangling,
    removedRefs: refs !== 'keep',
  };
}

// 删除单条重复定义（保留主定义）。
export function planDeleteOccurrence(text, model, defKey) {
  const d = model.defs.find((x) => x.key === defKey);
  if (!d) return { ok: false, reason: 'missing', edits: [] };
  let end = d.blockEnd;
  if (text[end] === '\n') end += 1;
  return { ok: true, edits: [{ start: d.blockStart, end, text: '', kind: 'delete-def', defKey: d.key }] };
}

// 删除单个引用标记。
export function planDeleteReference(model, refKey) {
  const r = model.refs.find((x) => x.key === refKey);
  if (!r) return { ok: false, reason: 'missing', edits: [] };
  return { ok: true, edits: [{ start: r.start, end: r.end, text: '', kind: 'delete-ref', refKey: r.key }] };
}

// 为悬空引用快速创建定义（追加到文末）。
export function planCreateDefinition(text, model, label) {
  if (model.defByLabel.has(label)) return { ok: false, reason: 'exists', edits: [] };
  const suffix = (text.length === 0 || text.endsWith('\n')) ? '' : '\n';
  const insert = `${suffix}[^${label}]: `;
  return {
    ok: true,
    edits: [{ start: text.length, end: text.length, text: insert, kind: 'create-def' }],
    cursorAt: text.length + insert.length,
  };
}

// 便捷：重命名并立即返回新文本（用于测试）。
export function renameInText(text, oldLabel, newLabel) {
  const model = parseMarkdown(text);
  const plan = planRename(model, oldLabel, newLabel);
  if (!plan.ok) throw new Error(plan.message);
  return applyEdits(text, plan.edits);
}
