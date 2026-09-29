/*
 * main.js — 应用编排：编辑器、Worker 分析、脚注列表、问题面板、
 * 引用图、重命名/删除、IndexedDB 持久化与恢复、HTML 导出。
 */
(function () {
  'use strict';

  var DEFAULT_DOC = [
    '# 示例文档',
    '',
    'Markdown 支持脚注[^note1]，也支持多个引用[^intro]。',
    '',
    '脚注的定义可以引用别的脚注，例如：',
    '',
    '[^note1]: 这是第一个脚注，详见[^note2]。',
    '[^note2]: 这是第二个脚注，回见[^note1]。（这两个构成循环引用）',
    '[^intro]: 引言脚注。',
    '',
    '下面是一个悬空引用[^missing]，以及重复定义：',
    '',
    '[^dup]: 第一个定义。',
    '[^dup]: 第二个定义（重复）。',
    ''
  ].join('\n');

  var editor = document.getElementById('editor');
  var fnList = document.getElementById('fn-list');
  var issueList = document.getElementById('issue-list');
  var statusBar = document.getElementById('status');
  var graphCanvas = document.getElementById('graph');
  var modal = document.getElementById('modal');

  var analysis = null;
  var analyzeTimer = null;
  var saveTimer = null;
  var reqSeq = 0;

  // ---------- Worker（失败时降级为主线程同步解析） ----------
  var worker = null;
  try {
    worker = new Worker('js/worker.js');
    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'result' && msg.id === reqSeq) applyAnalysis(msg.analysis);
      if (msg.type === 'error') setStatus('解析出错: ' + msg.message);
    };
    worker.onerror = function () { worker = null; scheduleAnalyze(true); };
  } catch (err) {
    worker = null;
  }

  function requestAnalyze() {
    var text = editor.value;
    if (worker) {
      reqSeq++;
      worker.postMessage({ type: 'analyze', id: reqSeq, text: text });
    } else {
      applyAnalysis(FnParser.analyze(text));
    }
  }

  function scheduleAnalyze(immediate) {
    clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(requestAnalyze, immediate ? 0 : 200);
  }

  // ---------- 持久化 ----------
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      FnStore.save(editor.value).then(function () {
        setStatus('已自动保存 ' + new Date().toLocaleTimeString());
      }).catch(function (err) {
        setStatus('保存失败: ' + err);
      });
    }, 500);
  }

  function restore() {
    return FnStore.load().then(function (state) {
      editor.value = state ? state.text : DEFAULT_DOC;
      if (state) setStatus('已从本地存储恢复（状态版本 v' + state.version + '）');
    }).catch(function () {
      editor.value = DEFAULT_DOC;
      setStatus('本地存储不可用，使用示例文档');
    });
  }

  // ---------- 渲染 ----------
  var graph = new FnGraph(graphCanvas, function (id) { jumpToDef(id); });

  function applyAnalysis(a) {
    analysis = a;
    renderFnList();
    renderIssues();
    graph.render(a);
  }

  function setStatus(msg) { statusBar.textContent = msg; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderFnList() {
    fnList.innerHTML = '';
    var ids = Object.keys(analysis.defMap).sort();
    if (!ids.length) {
      fnList.appendChild(el('li', 'empty', '暂无脚注定义'));
      return;
    }
    ids.forEach(function (id) {
      var li = el('li', 'fn-item');
      var badges = [];
      if (analysis.duplicates.indexOf(id) !== -1) badges.push(['重复', 'badge dup']);
      if (analysis.cyclicIds[id]) badges.push(['循环', 'badge cyc']);
      var refCount = analysis.refs.filter(function (r) { return r.id === id && !r.inDef; }).length;

      var head = el('div', 'fn-head');
      head.appendChild(el('span', 'fn-id', '[^' + id + ']'));
      badges.forEach(function (b) { head.appendChild(el('span', b[1], b[0])); });
      head.appendChild(el('span', 'fn-count', refCount + ' 处引用'));
      li.appendChild(head);

      var preview = el('div', 'fn-preview', analysis.defMap[id][0].body.split('\n')[0] || '(空)');
      li.appendChild(preview);

      var actions = el('div', 'fn-actions');
      actions.appendChild(actionBtn('跳转', function () { jumpToDef(id); }));
      actions.appendChild(actionBtn('重命名', function () { rename(id); }));
      actions.appendChild(actionBtn('删除', function () { confirmDelete(id); }));
      li.appendChild(actions);
      fnList.appendChild(li);
    });
  }

  function actionBtn(label, fn) {
    var b = el('button', 'btn small', label);
    b.addEventListener('click', fn);
    return b;
  }

  function renderIssues() {
    issueList.innerHTML = '';
    var count = 0;

    analysis.cycles.forEach(function (group) {
      count++;
      issueList.appendChild(issueItem(
        'cyc', '循环引用: ' + group.map(function (i) { return '[^' + i + ']'; }).join(' ⇄ '),
        function () { jumpToDef(group[0]); }));
    });

    analysis.duplicates.forEach(function (id) {
      count++;
      issueList.appendChild(issueItem(
        'dup', '重复定义: [^' + id + ']（' + analysis.defMap[id].length + ' 处）',
        function () { jumpToLine(analysis.defMap[id][1].line); }));
    });

    var danglingIds = {};
    analysis.dangling.forEach(function (r) {
      if (danglingIds[r.id]) return;
      danglingIds[r.id] = true;
      count++;
      issueList.appendChild(issueItem(
        'dang', '悬空引用: [^' + r.id + ']（第 ' + (r.line + 1) + ' 行）',
        function () { jumpToLine(r.line); }));
    });

    if (!count) issueList.appendChild(el('li', 'empty ok', '✓ 未发现问题'));
  }

  function issueItem(cls, text, onClick) {
    var li = el('li', 'issue ' + cls, text);
    li.addEventListener('click', onClick);
    return li;
  }

  // ---------- 跳转 ----------
  function lineOffset(line) {
    var lines = editor.value.split('\n');
    var off = 0;
    for (var i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
    return off;
  }

  function jumpToLine(line) {
    var pos = lineOffset(line);
    editor.focus();
    editor.setSelectionRange(pos, pos + (editor.value.split('\n')[line] || '').length);
    var lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 20;
    editor.scrollTop = Math.max(0, line * lineHeight - editor.clientHeight / 2);
  }

  function jumpToDef(id) {
    if (!analysis || !analysis.defMap[id]) return;
    jumpToLine(analysis.defMap[id][0].line);
  }

  // ---------- 重命名 ----------
  function rename(id) {
    var name = prompt('将脚注 [^' + id + '] 重命名为：', id);
    if (name === null) return;
    name = name.trim();
    if (!name) { alert('名称不能为空'); return; }
    if (/[\[\]\s]/.test(name)) { alert('名称不能包含空格或方括号'); return; }
    if (name === id) return;
    if (analysis.defMap[name]) {
      alert('重命名冲突：[^' + name + '] 已存在定义');
      return;
    }
    editor.value = FnParser.renameFootnote(editor.value, id, name);
    setStatus('已将 [^' + id + '] 重命名为 [^' + name + ']，所有引用已同步');
    scheduleAnalyze(true);
    scheduleSave();
  }

  // ---------- 删除 ----------
  function confirmDelete(id) {
    var refCount = analysis.refs.filter(function (r) { return r.id === id; }).length;
    showModal(
      '删除脚注 [^' + id + ']',
      refCount > 0
        ? '该脚注有 ' + refCount + ' 处引用（含定义内引用）。如何处理这些引用？'
        : '该脚注没有被引用，可直接删除定义。',
      [
        refCount > 0 && {
          label: '删除定义并移除所有引用',
          danger: true,
          fn: function () {
            editor.value = FnParser.removeReferences(
              FnParser.removeDefinition(editor.value, id), id);
            setStatus('已删除 [^' + id + '] 及其全部引用');
          }
        },
        refCount > 0 && {
          label: '仅删除定义（引用将标记为悬空）',
          fn: function () {
            editor.value = FnParser.removeDefinition(editor.value, id);
            setStatus('已删除 [^' + id + '] 的定义，残留引用已标记为悬空');
          }
        },
        refCount === 0 && {
          label: '删除定义',
          danger: true,
          fn: function () {
            editor.value = FnParser.removeDefinition(editor.value, id);
            setStatus('已删除 [^' + id + ']');
          }
        },
        { label: '取消', cancel: true }
      ].filter(Boolean)
    );
  }

  function showModal(title, message, actions) {
    modal.innerHTML = '';
    var box = el('div', 'modal-box');
    box.appendChild(el('h3', '', title));
    box.appendChild(el('p', '', message));
    var row = el('div', 'modal-actions');
    actions.forEach(function (a) {
      var b = el('button', 'btn' + (a.danger ? ' danger' : ''), a.label);
      b.addEventListener('click', function () {
        closeModal();
        if (a.fn) { a.fn(); scheduleAnalyze(true); scheduleSave(); }
      });
      row.appendChild(b);
    });
    box.appendChild(row);
    modal.appendChild(box);
    modal.classList.add('open');
  }

  function closeModal() { modal.classList.remove('open'); }
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

  // ---------- 工具栏 ----------
  document.getElementById('btn-export').addEventListener('click', function () {
    var a = analysis || FnParser.analyze(editor.value);
    var html = FnExporter.exportHtml(editor.value, a);
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'document.html';
    link.click();
    URL.revokeObjectURL(url);
    setStatus('已导出 HTML');
  });

  document.getElementById('btn-clear').addEventListener('click', function () {
    if (!confirm('确定清空本地存储并恢复示例文档？')) return;
    FnStore.clear().then(function () {
      editor.value = DEFAULT_DOC;
      setStatus('本地存储已清空');
      scheduleAnalyze(true);
    }).catch(function (err) { setStatus('清空失败: ' + err); });
  });

  // ---------- 启动 ----------
  editor.addEventListener('input', function () {
    scheduleAnalyze(false);
    scheduleSave();
  });
  window.addEventListener('resize', function () { if (analysis) graph.render(analysis); });

  restore().then(function () { scheduleAnalyze(true); });
})();
