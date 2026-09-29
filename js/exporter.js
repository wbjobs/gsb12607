/*
 * exporter.js — 将 Markdown（含脚注）导出为独立 HTML 文件。
 * 支持：标题、段落、列表、代码块、行内代码、粗体、斜体、链接、脚注引用与定义。
 */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inline(text, defMap) {
    var s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    // 脚注引用 -> 上标链接
    s = s.replace(/\[\^([^\]]+)\]/g, function (m, id) {
      if (!defMap[id]) return '<span class="fn-dangling">[^' + escapeHtml(id) + ']</span>';
      var n = defMap[id].num;
      return '<sup id="fnref-' + escapeHtml(id) + '"><a href="#fn-' + escapeHtml(id) + '">[' + n + ']</a></sup>';
    });
    return s;
  }

  /** 返回完整 HTML 文档字符串 */
  function exportHtml(markdown, analysis) {
    var defMap = {};
    var order = [];
    // 按正文首次引用顺序编号
    analysis.refs.forEach(function (r) {
      if (analysis.defMap[r.id] && !defMap[r.id]) {
        defMap[r.id] = { num: order.length + 1, def: analysis.defMap[r.id][0] };
        order.push(r.id);
      }
    });
    // 未被正文引用的定义也附上
    Object.keys(analysis.defMap).forEach(function (id) {
      if (!defMap[id]) {
        defMap[id] = { num: order.length + 1, def: analysis.defMap[id][0] };
        order.push(id);
      }
    });

    var lines = markdown.split('\n');
    var body = [];
    var inCode = false, inList = false, para = [];
    var DEF_HEAD = /^\[\^([^\]]+)\]:/;

    function flushPara() {
      if (para.length) {
        body.push('<p>' + para.map(function (l) { return inline(l, defMap); }).join('<br>') + '</p>');
        para = [];
      }
    }
    function closeList() { if (inList) { body.push('</ul>'); inList = false; } }

    lines.forEach(function (line) {
      if (/^```/.test(line)) {
        flushPara(); closeList();
        body.push(inCode ? '</code></pre>' : '<pre><code>');
        inCode = !inCode;
        return;
      }
      if (inCode) { body.push(escapeHtml(line)); return; }
      if (DEF_HEAD.test(line)) { flushPara(); closeList(); return; } // 定义单独输出
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara(); closeList();
        var lvl = h[1].length;
        body.push('<h' + lvl + '>' + inline(h[2], defMap) + '</h' + lvl + '>');
        return;
      }
      var li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) {
        flushPara();
        if (!inList) { body.push('<ul>'); inList = true; }
        body.push('<li>' + inline(li[1], defMap) + '</li>');
        return;
      }
      if (line.trim() === '') { flushPara(); closeList(); return; }
      para.push(line);
    });
    flushPara(); closeList();
    if (inCode) body.push('</code></pre>');

    // 脚注区
    var fnHtml = '';
    if (order.length) {
      fnHtml = '<hr><section class="footnotes"><ol>' + order.map(function (id) {
        var entry = defMap[id];
        var dup = analysis.duplicates.indexOf(id) !== -1
          ? ' <em class="fn-warn">(重复定义，已采用第一个)</em>' : '';
        return '<li id="fn-' + escapeHtml(id) + '">' +
          inline(entry.def.body, defMap) +
          ' <a href="#fnref-' + escapeHtml(id) + '" class="fn-back">↩</a>' + dup + '</li>';
      }).join('') + '</ol></section>';
    }

    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
      '<title>导出文档</title>\n<style>\n' +
      'body{max-width:760px;margin:2rem auto;padding:0 1rem;font-family:Georgia,serif;line-height:1.7;color:#1f2328}\n' +
      'code,pre{background:#f6f8fa;border-radius:4px;font-family:ui-monospace,monospace}\n' +
      'pre{padding:12px;overflow:auto}\n' +
      'sup a{text-decoration:none}\n' +
      '.footnotes{font-size:.9em;color:#444}\n' +
      '.fn-back{text-decoration:none}\n' +
      '.fn-dangling{color:#d32f2f}\n.fn-warn{color:#b26a00}\n' +
      '</style>\n</head>\n<body>\n' + body.join('\n') + '\n' + fnHtml + '\n</body>\n</html>\n';
  }

  global.FnExporter = { exportHtml: exportHtml };
})(typeof self !== 'undefined' ? self : this);
