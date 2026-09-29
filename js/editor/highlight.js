// 编辑器高亮：透明 textarea 覆盖在带高亮的 <pre> 之上。
// 两层使用完全相同的字体、内边距、行高与换行规则，以保证像素级对齐。

export function buildHighlight(text, model) {
  const marks = [];
  for (const p of model.problems) {
    marks.push({ start: p.start, end: p.end, cls: problemClass(p.type) });
  }
  for (const t of model.tokens) {
    marks.push({ start: t.start, end: t.end, cls: `tok tok-${t.kind} tok-${t.state}` });
  }
  marks.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  // 用扫描事件维护嵌套 span 栈；同点先开后合。
  const events = [];
  for (const m of marks) {
    events.push({ pos: m.start, open: true, m });
    events.push({ pos: m.end, open: false, m });
  }
  events.sort((a, b) => a.pos - b.pos || (a.open === b.open ? 0 : a.open ? -1 : 1));

  let html = '';
  let cursor = 0;
  const active = [];
  for (const ev of events) {
    if (ev.pos < cursor) continue;
    if (ev.pos > cursor) {
      html += escape(text.slice(cursor, ev.pos));
      cursor = ev.pos;
    }
    if (ev.open) {
      html += `<span class="${ev.m.cls}">`;
      active.push(ev.m);
    } else {
      const idx = active.lastIndexOf(ev.m);
      if (idx === -1) continue;
      for (let k = active.length - 1; k >= idx; k--) html += '</span>';
      const reopen = active.splice(idx, active.length - idx).slice(0, -1);
      for (const m of reopen) {
        html += `<span class="${m.cls}">`;
        active.push(m);
      }
    }
  }
  html += escape(text.slice(cursor));
  return html;
}

function problemClass(type) {
  return {
    dangling: 'prob prob-dangling',
    duplicate: 'prob prob-duplicate',
    cycle: 'prob prob-cycle',
    unused: 'prob prob-unused',
  }[type] || 'prob';
}

function escape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
