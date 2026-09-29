// 导出带脚注的独立 HTML（内联样式，无外部依赖）。

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderInline(text, model, numberByLabel) {
  // 先保护行内代码
  const codes = [];
  let work = text.replace(/(`+)([^`\n]+?)\1/g, (m) => {
    codes.push(m);
    return `\u0000${codes.length - 1}\u0000`;
  });
  work = escapeHtml(work);

  // 脚注引用
  work = work.replace(/\[\^([^\]\n]+)\]/g, (m, label) => {
    const num = numberByLabel.get(label);
    if (num == null) {
      return `<span class="fn-missing" title="悬空引用：[^${escapeHtml(label)}] 没有定义">[^${escapeHtml(label)}]</span>`;
    }
    return `<sup class="fn-ref"><a href="#fn-${num}" id="fnref-${num}">${num}</a></sup>`;
  });

  // 图片 / 链接
  work = work.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    '<img alt="$1" src="$2" title="$3">');
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    '<a href="$2" title="$3">$1</a>');
  // 粗体 / 斜体 / 行内代码
  work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  work = work.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  work = work.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  work = work.replace(/`([^`]+)`/g, '<code>$1</code>');
  work = work.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const raw = codes[Number(i)];
    const inner = raw.replace(/^`+/, '').replace(/`+$/, '');
    return `<code>${escapeHtml(inner)}</code>`;
  });
  return work;
}

function bodyToHtml(bodyLines, model, numberByLabel) {
  // 去缩进（4 空格或等效 tab），按空行分段；保留内部围栏代码块。
  const raw = bodyLines.map((l) => l.text).join('\n');
  const lines = raw.split('\n');
  const dedented = lines.map((ln) => {
    let cols = 0;
    let i = 0;
    while (i < ln.length) {
      if (ln[i] === ' ') { cols++; i++; }
      else if (ln[i] === '\t') { cols += 4 - (cols % 4); i++; }
      else break;
      if (cols >= 4) return ln.slice(i);
    }
    return ln.trim() === '' ? '' : ln;
  });

  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push(`<p>${renderInline(para.join(' '), model, numberByLabel)}</p>`);
      para = [];
    }
  };
  let inFence = null;
  let codeBuf = [];
  for (const ln of dedented) {
    const fm = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(ln);
    if (!inFence && fm) {
      flush();
      inFence = { tick: fm[2][0], len: fm[2].length, lang: fm[3].trim() };
      codeBuf = [];
      continue;
    }
    if (inFence) {
      const cm = /^(\s*)(`{3,}|~{3,})\s*$/.exec(ln);
      if (cm && cm[2][0] === inFence.tick && cm[2].length >= inFence.len) {
        out.push(`<pre><code${inFence.lang ? ` class="language-${escapeHtml(inFence.lang)}"` : ''}>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        inFence = null;
        codeBuf = [];
        continue;
      }
      codeBuf.push(ln);
      continue;
    }
    if (ln.trim() === '') { flush(); continue; }
    para.push(ln.trim());
  }
  flush();
  if (inFence) out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  return out.join('\n');
}

export function exportHtml(model, { title } = {}) {
  const { text, defs } = model;
  const defRanges = model.defs
    .filter((d) => d.isPrimary || !model.primaryByLabel.get(d.label))
    .map((d) => [d.blockStart, d.blockEnd + (text[d.blockEnd] === '\n' ? 1 : 0)]);
  const inDef = (pos) => defRanges.some(([s, e]) => pos >= s && pos < e);

  // 标题：第一个 ATX heading，否则用文件名/默认。
  let docTitle = title || '';
  const hm = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text);
  if (hm) docTitle = docTitle || hm[1];

  const blocks = [];
  const lines = text.split('\n');
  const starts = model.starts;
  let i = 0;
  let fence = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push(`<p>${renderInline(para.map((p) => p.trim()).join(' '), model, model.numbers)}</p>`);
      para = [];
    }
  };
  while (i < lines.length) {
    const offset = starts[i];
    const ln = lines[i];
    if (inDef(offset)) { i++; continue; }

    const fm = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(ln);
    if (!fence && fm) {
      flushPara();
      fence = { tick: fm[1][0], len: fm[1].length, lang: fm[2].trim(), buf: [] };
      i++;
      continue;
    }
    if (fence) {
      const cm = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(ln);
      if (cm && cm[1][0] === fence.tick && cm[1].length >= fence.len) {
        blocks.push(`<pre><code${fence.lang ? ` class="language-${escapeHtml(fence.lang)}"` : ''}>${escapeHtml(fence.buf.join('\n'))}</code></pre>`);
        fence = null;
      } else {
        fence.buf.push(ln);
      }
      i++;
      continue;
    }

    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(ln);
    if (h) {
      flushPara();
      const level = h[1].length;
      blocks.push(`<h${level}>${renderInline(h[2].trim(), model, model.numbers)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}(---+|\*\*\*+|___+)\s*$/.test(ln)) {
      flushPara();
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*$/.test(ln)) {
      flushPara();
      i++;
      continue;
    }
    const bq = /^\s{0,3}>\s?(.*)$/.exec(ln);
    if (bq) {
      flushPara();
      const buf = [bq[1]];
      i++;
      while (i < lines.length) {
        const m2 = /^\s{0,3}>\s?(.*)$/.exec(lines[i]);
        if (!m2) break;
        buf.push(m2[1]);
        i++;
      }
      blocks.push(`<blockquote>${renderInline(buf.join(' '), model, model.numbers)}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(ln);
    if (li) {
      flushPara();
      const ordered = /\d+\./.test(li[2]);
      const items = [li[3]];
      i++;
      while (i < lines.length) {
        const m2 = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!m2 || (ordered ? !/\d+\./.test(m2[2]) : /\d+\./.test(m2[2]))) break;
        items.push(m2[3]);
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      blocks.push(`<${tag}>${items.map((t) => `<li>${renderInline(t, model, model.numbers)}</li>`).join('')}</${tag}>`);
      continue;
    }
    para.push(ln);
    i++;
  }
  flushPara();

  // 脚注区：按编号顺序输出主定义。
  const primaries = defs.filter((d) => d.isPrimary).sort((a, b) => model.numbers.get(a.label) - model.numbers.get(b.label));
  const noteHtml = primaries.map((d) => {
    const num = model.numbers.get(d.label);
    const inner = bodyToHtml(d.bodyLines, model, model.numbers);
    return `<li id="fn-${num}">${inner}<a class="fn-back" href="#fnref-${num}">↩</a></li>`;
  }).join('\n');

  const style = `
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7;color:#1f2328}
h1,h2,h3{line-height:1.3} pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto}
code{background:#f6f8fa;padding:2px 5px;border-radius:4px;font-size:.92em}
pre code{background:none;padding:0} blockquote{margin:0;padding:0 1em;color:#57606a;border-left:4px solid #d0d7de}
.fn-ref a{text-decoration:none;color:#0969da}.fn-missing{color:#cf222e;background:#ffebe9;border-radius:3px;padding:0 2px}
.footnotes{margin-top:2.5em;padding-top:1em;border-top:1px solid #d0d7de;font-size:.95em}
.footnotes ol{padding-left:1.6em}.fn-back{margin-left:6px;text-decoration:none;color:#57606a}`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(docTitle || 'Markdown 文档')}</title>
<style>${style}</style>
</head>
<body>
${blocks.join('\n')}
<section class="footnotes">
<ol>
${noteHtml}
</ol>
</section>
</body>
</html>
`;
}
