// 极简 DOM 构造与通用模态框（无框架）。

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function modal({ title, body, actions, onClose }) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const overlay = h('div', { class: 'modal-overlay' }, [
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
      h('div', { class: 'modal-head' }, [
        h('strong', {}, title),
        h('button', { class: 'icon-btn', title: '关闭', onClick: close }, '×'),
      ]),
      h('div', { class: 'modal-body' }, [].concat(body)),
      h('div', { class: 'modal-actions' }, (actions || []).map((a) =>
        h('button', {
          class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`,
          onClick: () => { if (a.onClick(close) !== false && a.keepOpen !== true) close(); },
        }, a.label))),
    ]),
  ]);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const firstInput = overlay.querySelector('input,select,textarea');
  if (firstInput) firstInput.focus();
  return { close, overlay };
}

export function promptModal(title, { value = '', label = '', placeholder = '', danger = false, okText = '确定', validate } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input', value, placeholder });
    const err = h('div', { class: 'modal-error' });
    const m = modal({
      title,
      body: [label ? h('label', { class: 'field-label' }, label) : null, input, err],
      actions: [
        { label: '取消', onClick: () => resolve(null) },
        {
          label: okText, danger,
          onClick: () => {
            const v = input.value;
            if (validate) {
              const msg = validate(v);
              if (msg) { err.textContent = msg; return false; }
            }
            resolve(v);
          },
        },
      ],
      onClose: () => resolve(null),
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = input.value;
        if (validate) {
          const msg = validate(v);
          if (msg) { err.textContent = msg; return; }
        }
        resolve(v);
        m.close();
      }
    });
    input.select();
  });
}
