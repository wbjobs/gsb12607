// 重命名、批量重命名、删除定义的交互对话框。

import { h, modal, promptModal } from './dom.js';
import { planRename, planBatchRename, planDeleteDefinition, isLegalLabel } from '../edits.js';

export async function renameFootnote(app, label) {
  const model = app.model;
  const next = await promptModal(`重命名脚注 [^${label}]`, {
    value: label,
    label: '新标签名（不含 [^]）',
    okText: '重命名',
    validate: (v) => {
      const t = v.trim();
      if (!isLegalLabel(t)) return '标签不能为空，且不能包含 ] 或换行';
      if (t !== label && model.defByLabel.has(t)) return `[^${t}] 已存在，会造成重复定义`;
      return '';
    },
  });
  if (next == null) return;
  const plan = planRename(model, label, next.trim());
  if (!plan.ok) { app.toast(plan.message, 'error'); return; }
  app.applyEditsAndReport(plan.edits, `已重命名 [^${label}] → [^${next.trim()}]`);
}

export async function batchRename(app) {
  const model = app.model;
  const labels = [...model.defByLabel.keys()].sort((a, b) =>
    (model.numbers.get(a) ?? 1e9) - (model.numbers.get(b) ?? 1e9));
  if (labels.length === 0) { app.toast('没有可重命名的脚注', 'info'); return; }

  const findInput = h('input', { class: 'input', placeholder: '查找（正则，如 ^src-(\\d+)$）' });
  const replaceInput = h('input', { class: 'input', placeholder: '替换（如 ref-$1）' });
  const errBox = h('div', { class: 'modal-error' });
  const tableBody = h('div', { class: 'batch-table' });

  const state = labels.map((l) => ({ label: l, target: l, checked: true }));

  function renderTable() {
    tableBody.innerHTML = '';
    for (const item of state) {
      const targetInput = h('input', { class: 'input input-sm', value: item.target });
      targetInput.addEventListener('input', () => { item.target = targetInput.value; validateRows(); });
      const cb = h('input', { type: 'checkbox' });
      cb.checked = item.checked;
      cb.addEventListener('change', () => { item.checked = cb.checked; validateRows(); });
      const conflict = item.target.trim() !== item.label &&
        model.defByLabel.has(item.target.trim());
      tableBody.append(h('div', { class: `batch-row ${conflict ? 'row-conflict' : ''}` }, [
        cb,
        h('code', {}, `[^${item.label}]`),
        h('span', { class: 'arrow' }, '→'),
        targetInput,
      ]));
    }
    validateRows();
  }

  function applyPattern() {
    errBox.textContent = '';
    const find = findInput.value;
    const replace = replaceInput.value;
    if (!find) { errBox.textContent = '请输入查找正则'; return; }
    let re;
    try { re = new RegExp(find, 'g'); } catch (e) { errBox.textContent = `正则无效：${e.message}`; return; }
    for (const item of state) {
      re.lastIndex = 0;
      if (re.test(item.label)) {
        re.lastIndex = 0;
        item.target = item.label.replace(re, replace);
        item.checked = true;
      }
    }
    renderTable();
  }

  function validateRows() {
    const targets = new Map();
    let ok = true;
    const rows = tableBody.querySelectorAll('.batch-row');
    state.forEach((item, i) => {
      const row = rows[i];
      if (!row) return;
      row.classList.remove('row-conflict');
      if (!item.checked) return;
      const t = item.target.trim();
      if (!isLegalLabel(t)) { row.classList.add('row-conflict'); ok = false; return; }
      if (t !== item.label) {
        if (model.defByLabel.has(t)) { row.classList.add('row-conflict'); ok = false; }
        if (targets.has(t)) { row.classList.add('row-conflict'); ok = false; }
        targets.set(t, (targets.get(t) || 0) + 1);
      }
    });
    return ok;
  }

  const m = modal({
    title: '批量重命名',
    body: [
      h('div', { class: 'batch-pattern' }, [
        findInput, replaceInput,
        h('button', { class: 'btn btn-sm', onClick: applyPattern }, '应用'),
      ]),
      h('div', { class: 'muted small' }, '用正则批量生成新名称，也可以直接在表格中逐行修改；冲突行会标红。'),
      tableBody,
      errBox,
    ],
    actions: [
      { label: '取消', onClick: () => {} },
      {
        label: '全部重命名', primary: true,
        onClick: (close) => {
          if (!validateRows()) { errBox.textContent = '存在非法或冲突的目标名称，请修正标红行'; return false; }
          const mapping = state
            .filter((s) => s.checked && s.target.trim() !== s.label)
            .map((s) => ({ oldLabel: s.label, newLabel: s.target.trim() }));
          if (mapping.length === 0) { errBox.textContent = '没有需要更改的项'; return false; }
          const plan = planBatchRename(model, mapping);
          if (!plan.ok) {
            const first = plan.items.find((i) => i.error);
            errBox.textContent = first ? `[^${first.oldLabel}]：${first.error}` : '批量重命名失败';
            return false;
          }
          close();
          app.applyEditsAndReport(plan.edits, `已批量重命名 ${mapping.length} 个脚注`);
        },
      },
    ],
  });
  renderTable();
}

export async function deleteFootnote(app, label) {
  const model = app.model;
  const defs = model.defByLabel.get(label) || [];
  const refCount = (model.refByLabel.get(label) || []).length;
  const choice = h('div', { class: 'choice-list' }, [
    radioChoice('keep', `保留引用（${refCount} 处将变成悬空引用，之后可再处理）`, true),
    radioChoice('remove', `同时删除全部 ${refCount} 处引用标记`, false),
  ]);
  if (defs.length > 1) {
    choice.append(h('div', { class: 'muted small' }, `该标签有 ${defs.length} 条定义（含重复），将一并删除。`));
  }
  const m = modal({
    title: `删除脚注 [^${label}]`,
    body: [
      h('p', {}, refCount > 0
        ? `有 ${refCount} 处地方引用了它，选择如何处理这些引用：`
        : '该脚注没有被引用，将直接删除定义。'),
      choice,
    ],
    actions: [
      { label: '取消', onClick: () => {} },
      {
        label: '删除', danger: true,
        onClick: (close) => {
          const mode = choice.querySelector('input[name="delmode"]:checked').value;
          const plan = planDeleteDefinition(app.text, model, label, { refs: mode });
          if (!plan.ok) { app.toast('删除失败：' + plan.reason, 'error'); return; }
          close();
          app.applyEditsAndReport(plan.edits,
            mode === 'remove'
              ? `已删除 [^${label}] 及其 ${refCount} 处引用`
              : `已删除 [^${label}]，${plan.dangling.length} 处引用变为悬空`);
        },
      },
    ],
  });
}

function radioChoice(value, labelText, checked) {
  const id = `del-${value}`;
  return h('label', { class: 'choice', for: id }, [
    h('input', { type: 'radio', name: 'delmode', id, value, checked }),
    h('span', {}, labelText),
  ]);
}
