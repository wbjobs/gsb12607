// 应用入口：编辑器、解析 Worker、侧边栏、Canvas 图、命令与 IndexedDB 持久化编排。

import { ParserClient } from './parser-client.js';
import { buildHighlight } from './editor/highlight.js';
import { renderFootnotesPanel, renderProblemsPanel } from './ui/panels.js';
import { renameFootnote, batchRename, deleteFootnote } from './ui/commands.js';
import { FootnoteGraph } from './graph.js';
import {
  applyEdits, planDeleteDefinition, planDeleteOccurrence, planDeleteReference,
  planCreateDefinition, planRename,
} from './edits.js';
import { offsetToLineCol } from './footnotes.js';
import { exportHtml } from './exporter.js';
import { createState, migrate, legacyV1 } from './state.js';
import { loadRawState, saveState, clearState, storageAvailable } from './db.js';
import { h } from './ui/dom.js';

const SAMPLE = `# 循环经济研究笔记

近年来，循环经济强调“资源—产品—再生资源”的闭环流动[^ce]。
有学者把这一思路追溯到宇宙飞船经济理论[^boulding]，而博尔丁本人在脚注里
又回到循环经济的定义[^ce-self]，形成一个互相引用的例子。

供应链追溯是另一关键环节[^trace]。本段落还引用了一个**尚不存在**的脚注[^missing]，
以及一个重复定义的脚注[^dup]。

正文不会引用 [^unused]，它会出现在“未被引用”提示中。

\`\`\`js
// 围栏代码块中的 [^ignored] 不会被解析
\`\`\`

行内代码同样被忽略：\`[^code]\` 不是引用。

[^ce]: 循环经济（Circular Economy）以减量化、再利用、资源化为原则，参见[^trace]。
[^boulding]: Kenneth Boulding 的“宇宙飞船经济”比喻，见[^ce]。
[^ce-self]: 这里再次引用 [^boulding]，与 [^ce] 构成循环。
[^trace]: 供应链追溯依赖标识与数据共享。
[^dup]: 这是 [^dup] 的第一条定义。
[^dup]: 这是重复的第二条定义，应被标记。
[^unused]: 写了定义但正文没有引用。
`;

class App {
  constructor() {
    this.textarea = document.getElementById('editor');
    this.highlight = document.getElementById('highlight');
    this.highlightCode = document.getElementById('highlight-code');
    this.editorWrap = document.getElementById('editor-wrap');
    this.tabBody = document.getElementById('tab-body');
    this.miniBar = document.getElementById('mini-toolbar');
    this.statusSave = document.getElementById('status-save');
    this.statusCounts = document.getElementById('status-counts');
    this.statusCursor = document.getElementById('status-cursor');
    this.statusMigrate = document.getElementById('status-migrate');
    this.countDefs = document.getElementById('count-defs');
    this.countProblems = document.getElementById('count-problems');

    this.parser = new ParserClient();
    this.model = null;
    this.state = createState(SAMPLE);
    this.activeTab = 'footnotes';
    this.jumpStack = [];
    this.saveTimer = null;
    this.parseTimer = null;
    this.lastSavedText = null;
  }

  async init() {
    this.parser.start();
    this.bindEvents();
    await this.restore();
    this.scheduleParse(true);
  }

  // ---------- 启动 / 持久化 ----------

  async restore() {
    if (!storageAvailable()) {
      this.setSaveStatus('IndexedDB 不可用，本次不会保存', 'warn');
      return;
    }
    try {
      const raw = await loadRawState();
      if (raw == null) {
        this.textarea.value = this.state.doc.text;
        this.setSaveStatus('首次使用：已载入示例', 'ok');
        return;
      }
      const result = migrate(raw);
      if (result.state) {
        this.state = result.state;
        this.textarea.value = this.state.doc.text;
        this.activeTab = this.state.ui.sidebar || 'footnotes';
        this.textarea.scrollTop = this.state.doc.scroll.top;
        this.textarea.scrollLeft = this.state.doc.scroll.left;
        this.lastSavedText = this.state.doc.text;
        if (result.warning) this.showBanner(result.warning);
        else if (result.fromVersion && result.fromVersion !== 2) {
          this.showBanner(`已从旧版状态 v${result.fromVersion} 迁移到 v2，刷新后继续使用新格式。`);
        }
        this.setSaveStatus('已恢复上次文档', 'ok');
      }
    } catch (err) {
      console.error(err);
      this.setSaveStatus('读取已存状态失败，使用示例文档', 'warn');
      this.textarea.value = this.state.doc.text;
    }
  }
}


  get text() { return this.textarea.value; }

  bindEvents() {
    let rafQueued = false;
    const onInput = () => {
      if (!rafQueued) {
        rafQueued = true;
        requestAnimationFrame(() => { rafQueued = false; this.scheduleParse(); });
      }
    };
    this.textarea.addEventListener('input', onInput);
    this.textarea.addEventListener('scroll', () => this.syncScroll());
    this.textarea.addEventListener('click', () => this.updateMiniToolbar());
    this.textarea.addEventListener('keyup', (e) => {
      this.updateCursorStatus();
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') this.updateMiniToolbar();
    });
    this.textarea.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.textarea.addEventListener('mousedown', (e) => {
      if (e.metaKey || e.ctrlKey) {
        const token = this.tokenFromEvent(e);
        if (token && token.kind === 'ref') {
          e.preventDefault();
          this.jumpToRef(token);
        }
      }
    });

    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
    document.getElementById('btn-export').addEventListener('click', () => this.exportHtml());
    document.getElementById('btn-sample').addEventListener('click', () => this.loadSample());
    document.getElementById('btn-clear').addEventListener('click', () => this.clearStorage());

    window.addEventListener('resize', () => this.graph && this.graph.resize());
    window.addEventListener('beforeunload', () => { try { this.saveNow(); } catch {} });
    this.syncScroll();
  }

  onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.exportHtml();
    } else if (e.key === 'F2') {
      e.preventDefault();
      const token = this.tokenAtCursor();
      if (token) this.renameAt(token);
    } else if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      this.goBack();
    }
  }

  scheduleParse(immediate = false) {
    clearTimeout(this.parseTimer);
    const run = () => {
      const text = this.textarea.value;
      this.parser.parse(text).then((model) => {
        // 丢弃过期结果
        if (model.text !== this.textarea.value) return;
        this.model = model;
        this.renderAll();
        this.scheduleSave();
      }).catch((err) => {
        if (!this.parser.fallback) console.warn('worker parse failed, using fallback', err);
      });
    };
    if (immediate) run();
    else this.parseTimer = setTimeout(run, 120);
  }

  renderAll() {
    this.highlightCode.innerHTML = buildHighlight(this.model.text, this.model);
    this.syncScroll();
    this.countDefs.textContent = String(this.model.defByLabel.size);
    const errorCount = this.model.problems.filter((p) => p.severity === 'error').length;
    this.countProblems.textContent = String(errorCount);
    this.countProblems.classList.toggle('tab-count-err', errorCount > 0);
    this.updateStatusCounts();
    this.updateCursorStatus();
    this.renderTab();
    if (this.graph) this.graph.setModel(this.model);
  }

  updateStatusCounts() {
    const c = { cycle: 0, dangling: 0, duplicate: 0, unused: 0 };
    for (const p of this.model.problems) c[p.type]++;
    const parts = [];
    if (c.cycle) parts.push(`循环 ${c.cycle}`);
    if (c.dangling) parts.push(`悬空 ${c.dangling}`);
    if (c.duplicate) parts.push(`重复 ${c.duplicate}`);
    if (c.unused) parts.push(`未引用 ${c.unused}`);
    this.statusCounts.textContent = parts.length ? parts.join(' · ') : '引用关系正常';
    this.statusCounts.className = 'status-item ' + ((c.cycle || c.dangling) ? 'status-warn' : 'status-ok');
  }

  updateCursorStatus() {
    const pos = this.textarea.selectionStart ?? 0;
    const { line, col } = offsetToLineCol(this.textarea.value, pos, this.model ? this.model.starts : null);
    this.statusCursor.textContent = `L${line + 1}:${col + 1}`;
  }

  syncScroll() {
    this.highlight.scrollTop = this.textarea.scrollTop;
    this.highlight.scrollLeft = this.textarea.scrollLeft;
  }

  // ---------- 侧边栏 ----------

  switchTab(tab) {
    this.activeTab = tab;
    this.state.ui.sidebar = tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    this.renderTab();
  }

  renderTab() {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === this.activeTab));
    if (!this.model) return;
    this.tabBody.innerHTML = '';
    if (this.activeTab === 'footnotes') {
      this.tabBody.append(renderFootnotesPanel(this.model, this.panelCallbacks()));
    } else if (this.activeTab === 'problems') {
      this.tabBody.append(renderProblemsPanel(this.model, this.panelCallbacks()));
    } else if (this.activeTab === 'graph') {
      this.renderGraphTab();
    }
  }

  panelCallbacks() {
    return {
      jump: (offset) => this.jumpToOffset(offset),
      rename: (label) => renameFootnote(this, label),
      remove: (label) => deleteFootnote(this, label),
      batchRename: () => batchRename(this),
      createDef: (label) => this.createDefinition(label),
      removeRef: (offset) => this.removeRefAtOffset(offset),
      removeOccurrence: (defKey) => this.removeOccurrence(defKey),
      showGraph: (label) => { this.switchTab('graph'); this.pendingGraphSelect = label; },
    };
  }

  renderGraphTab() {
    const wrap = h('div', { class: 'graph-wrap', style: 'height:100%; min-height:420px' }, [
      h('canvas', { id: 'graph-canvas' }),
      h('div', { class: 'graph-legend' }, [
        h('span', {}, [h('i', { style: `background:#0969da` }), '脚注定义']),
        h('span', {}, [h('i', { style: `background:#cf222e` }), '循环 / 悬空']),
        h('span', { class: 'muted' }, '拖拽移动节点 · 滚轮缩放 · 点击跳转'),
      ]),
    ]);
    this.tabBody.append(wrap);
    this.tabBody.style.height = '100%';
    const canvas = wrap.querySelector('#graph-canvas');
    const tip = h('div', { class: 'graph-tip hidden' });
    wrap.append(tip);
    this.graph = new FootnoteGraph(canvas, {
      onSelect: (n) => {
        if (n.kind === 'doc') return;
        const d = this.model.primaryByLabel.get(n.id);
        if (d) this.jumpToOffset(d.labelStart);
        else {
          const ref = this.model.refs.find((r) => r.label === n.id);
          if (ref) this.jumpToOffset(ref.start);
        }
      },
      onHover: (n, pos) => {
        if (!n) { tip.classList.add('hidden'); return; }
        let txt;
        if (n.kind === 'doc') txt = `正文：${this.model.refs.filter((r) => r.ownerDefKey === null && this.model.primaryByLabel.has(r.label)).length} 个脚注被引用`;
        else {
          const refCount = (this.model.refByLabel.get(n.id) || []).length;
          txt = `[^${n.id}] · ${refCount} 处引用${n.cycle ? ' · 处于循环中' : ''}${n.kind === 'dangling' ? ' · 悬空' : ''}`;
        }
        tip.textContent = txt;
        tip.classList.remove('hidden');
        if (pos) {
          const rect = wrap.getBoundingClientRect();
          tip.style.left = `${pos.x - rect.left + 12}px`;
          tip.style.top = `${pos.y - rect.top + 12}px`;
        }
      },
    });
    this.graph.setModel(this.model);
    if (this.state.ui.graphViewport) this.graph.setViewport(this.state.ui.graphViewport);
    if (this.pendingGraphSelect) {
      this.graph.selectLabel(this.pendingGraphSelect);
      this.pendingGraphSelect = null;
    }
  }

  // ---------- 跳转 / 迷你工具栏 ----------

  jumpToOffset(offset, pushStack = true) {
    if (pushStack) {
      this.jumpStack.push(this.textarea.selectionStart);
      if (this.jumpStack.length > 50) this.jumpStack.shift();
    }
    this.textarea.focus();
    this.textarea.setSelectionRange(offset, offset);
    this.scrollCaretIntoView(offset);
    this.updateCursorStatus();
    this.updateMiniToolbar();
  }

  goBack() {
    const prev = this.jumpStack.pop();
    if (prev != null) {
      this.textarea.focus();
      this.textarea.setSelectionRange(prev, prev);
      this.scrollCaretIntoView(prev);
    }
  }

  scrollCaretIntoView(offset) {
    const { line } = offsetToLineCol(this.textarea.value, offset, this.model.starts);
    const lineHeight = this.measureLineHeight();
    const approxY = line * lineHeight;
    const viewH = this.textarea.clientHeight;
    if (approxY < this.textarea.scrollTop + 40 || approxY > this.textarea.scrollTop + viewH - 40) {
      this.textarea.scrollTop = Math.max(0, approxY - viewH / 2);
    }
    this.syncScroll();
  }

  measureLineHeight() {
    if (this._lineHeight) return this._lineHeight;
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace';
    probe.textContent = 'x';
    this.editorWrap.append(probe);
    this._lineHeight = probe.offsetHeight || 22;
    probe.remove();
    return this._lineHeight;
  }

  tokenFromEvent(e) {
    const off = this.offsetFromPoint(e.clientX, e.clientY);
    if (off == null) return null;
    return this.model.tokens.find((t) => off >= t.start && off <= t.end) || null;
  }

  offsetFromPoint(x, y) {
    // textarea 坐标 -> 文档偏移：用镜像层做命中测试
    const rect = this.textarea.getBoundingClientRect();
    const lh = this.measureLineHeight();
    const style = getComputedStyle(this.textarea);
    const padX = parseFloat(style.paddingLeft) || 18;
    const padY = parseFloat(style.paddingTop) || 14;
    const top = y - rect.top - padY + this.textarea.scrollTop;
    const left = x - rect.left - padX + this.textarea.scrollLeft;
    const line = Math.round(top / lh);
    const starts = this.model.starts;
    if (line < 0 || line >= starts.length) return null;
    const lineStart = starts[line];
    const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : this.textarea.value.length;
    const text = this.textarea.value.slice(lineStart, lineEnd);
    // 等宽字体近似：用字符宽度定位列
    const charW = lh / 1.6 * 0.602;
    const col = Math.round(left / charW);
    return Math.min(lineEnd, lineStart + Math.max(0, col));
  }

  tokenAtCursor() {
    const pos = this.textarea.selectionStart ?? 0;
    return this.model.tokens.find((t) => pos >= t.start && pos <= t.end) || null;
  }

  jumpToRef(token) {
    if (token.kind !== 'ref') return;
    const r = this.model.refs.find((x) => x.start === token.start);
    if (!r) return;
    if (r.resolvedDefKey == null) {
      this.toast(`[^${r.label}] 是悬空引用，没有定义`, 'error');
      this.jumpToOffset(r.labelStart);
      return;
    }
    const def = this.model.defs.find((d) => d.key === r.resolvedDefKey);
    if (def) this.jumpToOffset(def.labelStart);
  }

  updateMiniToolbar() {
    const token = this.tokenAtCursor();
    this.miniBar.innerHTML = '';
    if (!token) { this.miniBar.classList.add('hidden'); return; }
    const isRef = token.kind === 'ref';
    const dangling = isRef && token.state === 'dangling';

    if (isRef && !dangling) {
      this.miniBar.append(this.miniBtn('跳到定义', () => this.jumpToRef(token)));
    }
    this.miniBar.append(this.miniBtn('重命名', () => this.renameAt(token)));
    if (dangling) {
      this.miniBar.append(this.miniBtn('创建定义', () => this.createDefinition(token.label)));
      this.miniBar.append(this.miniBtn('删除引用', () => this.removeRefAtOffset(token.start), true));
    } else if (token.kind === 'def') {
      this.miniBar.append(this.miniBtn('删除脚注', () => deleteFootnote(this, token.label), true));
    }

    const pos = this.miniToolbarPosition(token);
    this.miniBar.style.left = `${pos.x}px`;
    this.miniBar.style.top = `${pos.y}px`;
    this.miniBar.classList.remove('hidden');
  }

  miniBtn(text, onClick, danger) {
    return h('button', { class: `btn btn-sm ${danger ? '' : ''}`, onClick }, text);
  }

  miniToolbarPosition(token) {
    const { line } = offsetToLineCol(this.textarea.value, token.start, this.model.starts);
    const lh = this.measureLineHeight();
    const style = getComputedStyle(this.textarea);
    const padX = parseFloat(style.paddingLeft) || 18;
    const padY = parseFloat(style.paddingTop) || 14;
    const x = padX - this.textarea.scrollLeft;
    const y = padY + (line + 1) * lh - this.textarea.scrollTop + 6;
    const wrapRect = this.editorWrap.getBoundingClientRect();
    return { x: Math.min(Math.max(8, x), wrapRect.width - 160), y: Math.min(y, wrapRect.height - 44) };
  }

  renameAt(token) {
    renameFootnote(this, token.label);
  }

  // ---------- 编辑操作 ----------

  applyEditsAndReport(edits, message) {
    const oldText = this.textarea.value;
    const cursorBefore = this.textarea.selectionStart;
    const newText = applyEdits(oldText, edits);
    this.textarea.value = newText;
    // 光标位置：按编辑点平移
    const deltaAt = (pos) => {
      let delta = 0;
      for (const e of edits.sort((a, b) => a.start - b.start)) {
        if (e.end <= pos) delta += e.text.length - (e.end - e.start);
        else if (e.start <= pos) delta -= (pos - e.start);
      }
      return delta;
    };
    const newCursor = Math.max(0, Math.min(newText.length, cursorBefore + deltaAt(cursorBefore)));
    this.textarea.setSelectionRange(newCursor, newCursor);
    this.scheduleParse(true);
    if (message) this.toast(message, 'success');
  }

  createDefinition(label) {
    const plan = planCreateDefinition(this.textarea.value, this.model, label);
    if (!plan.ok) { this.toast(plan.message || '创建失败', 'error'); return; }
    this.applyEditsAndReport(plan.edits, `已在文末创建 [^${label}] 的定义`);
    if (plan.cursorAt != null) {
      requestAnimationFrame(() => {
        this.jumpToOffset(plan.cursorAt, false);
      });
    }
  }

  removeRefAtOffset(offset) {
    const r = this.model.refs.find((x) => offset >= x.start && offset <= x.end);
    if (!r) return;
    const plan = planDeleteReference(this.model, r.key);
    if (plan.ok) this.applyEditsAndReport(plan.edits, '已删除引用标记');
  }

  removeOccurrence(defKey) {
    const plan = planDeleteOccurrence(this.textarea.value, this.model, defKey);
    if (plan.ok) this.applyEditsAndReport(plan.edits, '已删除该条重复定义');
  }

  // ---------- 导出 ----------

  exportHtml() {
    if (!this.model) return;
    const html = exportHtml(this.model);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'footnotes-document.html';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    this.toast('已导出带脚注的 HTML', 'success');
  }

  // ---------- 存储 ----------

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.setSaveStatus('已修改，稍后自动保存…');
    this.saveTimer = setTimeout(() => this.saveNow(), 600);
  }

  async saveNow() {
    if (!storageAvailable() || !this.model) return;
    const text = this.textarea.value;
    const state = createState(text);
    state.doc.cursor = this.textarea.selectionStart ?? 0;
    state.doc.scroll = { top: this.textarea.scrollTop, left: this.textarea.scrollLeft };
    state.ui.sidebar = this.activeTab;
    if (this.graph) state.ui.graphViewport = this.graph.getViewport();
    state.updatedAt = Date.now();
    this.state = state;
    try {
      await saveState(state);
      this.lastSavedText = text;
      this.setSaveStatus(`已保存 ${new Date(state.updatedAt).toLocaleTimeString()}`, 'ok');
    } catch (err) {
      console.error(err);
      this.setSaveStatus('保存失败（可能是存储空间不足）', 'warn');
      if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
        this.toast('存储空间已满，旧状态未能写入 IndexedDB', 'error');
      }
    }
  }

  async clearStorage() {
    if (!storageAvailable()) { this.toast('IndexedDB 不可用', 'error'); return; }
    const ok = await new Promise((resolve) => {
      const overlay = h('div', { class: 'modal-overlay' }, [
        h('div', { class: 'modal' }, [
          h('div', { class: 'modal-head' }, h('strong', {}, '清除本地存储？')),
          h('div', { class: 'modal-body' }, '将删除 IndexedDB 中保存的文档与界面状态，页面会重新载入示例。此操作不可撤销。'),
          h('div', { class: 'modal-actions' }, [
            h('button', { class: 'btn', onClick: () => { overlay.remove(); resolve(false); } }, '取消'),
            h('button', {
              class: 'btn btn-danger',
              onClick: () => { overlay.remove(); resolve(true); },
            }, '清除并重置'),
          ]),
        ]),
      ]);
      document.body.append(overlay);
    });
    if (!ok) return;
    try {
      await clearState();
      this.toast('存储已清空', 'success');
      this.state = createState(SAMPLE);
      this.textarea.value = SAMPLE;
      this.scheduleParse(true);
    } catch (err) {
      console.error(err);
      this.toast('清除存储失败：' + (err.message || err), 'error');
    }
  }

  loadSample() {
    this.textarea.value = SAMPLE;
    this.scheduleParse(true);
    this.toast('已载入示例文档', 'success');
  }

  // ---------- 通用 UI ----------

  setSaveStatus(text, level) {
    this.statusSave.textContent = text;
    this.statusSave.className = 'status-item' + (level === 'ok' ? ' status-ok' : level === 'warn' ? ' status-warn' : '');
  }

  toast(message, level = 'info') {
    const host = document.getElementById('toast-host');
    const el = h('div', { class: `toast ${level === 'error' ? 'error' : level === 'success' ? 'success' : ''}` }, message);
    host.append(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
    setTimeout(() => el.remove(), 3600);
  }

  showBanner(message) {
    const existing = document.querySelector('.banner');
    if (existing) existing.remove();
    const banner = h('div', { class: 'banner' }, [
      h('span', {}, message),
      h('button', { onClick: () => banner.remove() }, '知道了'),
    ]);
    document.body.insertBefore(banner, document.querySelector('.layout'));
    this.statusMigrate.textContent = '状态已迁移';
  }
}

const app = new App();
window.__app = app;
app.init();
