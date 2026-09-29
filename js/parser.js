/*
 * parser.js — Markdown 脚注解析与引用图分析（纯函数，无 DOM 依赖）
 * 同时被 Web Worker (worker.js) 与主线程降级方案 / 导出器复用。
 */
(function (global) {
  'use strict';

  var DEF_RE = /^\[\^([^\]\s][^\]]*)\]:[ \t]?(.*)$/;
  var REF_RE = /\[\^([^\]\s][^\]]*)\]/g;
  var CONT_RE = /^(?:    |\t)/; // 定义的缩进续行

  /**
   * 解析文本，返回：
   * {
   *   defs: [{ id, line, col, body, endLine }],   // 所有定义（含重复）
   *   refs: [{ id, line, col, inDef }],           // 所有引用，inDef 为所在定义的 id 或 null
   * }
   */
  function parse(text) {
    var lines = text.split('\n');
    var defs = [];
    var refs = [];
    var currentDef = null; // 当前处于哪个定义的续行区间

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = line.match(DEF_RE);
      if (m) {
        var def = { id: m[1], line: i, col: 0, body: m[2], endLine: i };
        defs.push(def);
        currentDef = def;
        collectRefs(m[2], i, line.length - m[2].length, def.id, refs);
        continue;
      }
      if (currentDef && CONT_RE.test(line)) {
        currentDef.endLine = i;
        currentDef.body += '\n' + line.replace(CONT_RE, '');
        collectRefs(line, i, 0, currentDef.id, refs);
        continue;
      }
      if (line.trim() !== '') currentDef = null;
      collectRefs(line, i, 0, null, refs);
    }
    return { defs: defs, refs: refs };
  }

  function collectRefs(text, line, colOffset, inDef, refs) {
    REF_RE.lastIndex = 0;
    var m;
    while ((m = REF_RE.exec(text)) !== null) {
      refs.push({ id: m[1], line: line, col: colOffset + m.index, inDef: inDef });
    }
  }

  /**
   * 分析：重复定义、悬空引用、引用图、循环检测（Tarjan SCC）
   * 返回 {
   *   defMap: {id: [def,...]},
   *   duplicates: [id,...],
   *   dangling: [ref,...],
   *   edges: [{from, to}],       // from 的定义体引用了 to
   *   cycles: [[id,...],...],    // 每个循环一组 id
   *   cyclicIds: {id: true},
   *   nodes: [id,...]
   * }
   */
  function analyze(text) {
    var parsed = parse(text);
    var defMap = {};
    parsed.defs.forEach(function (d) {
      (defMap[d.id] = defMap[d.id] || []).push(d);
    });

    var duplicates = Object.keys(defMap).filter(function (id) {
      return defMap[id].length > 1;
    });

    var dangling = parsed.refs.filter(function (r) { return !defMap[r.id]; });

    // 引用图：节点为被定义的脚注 id；边 defId -> 其定义体内引用的 id
    var edges = [];
    var adj = {};
    Object.keys(defMap).forEach(function (id) { adj[id] = {}; });
    parsed.refs.forEach(function (r) {
      if (r.inDef && defMap[r.inDef] && r.inDef !== undefined) {
        if (!adj[r.inDef][r.id]) {
          adj[r.inDef][r.id] = true;
          edges.push({ from: r.inDef, to: r.id });
        }
      }
    });

    var cycles = findCycles(adj);
    var cyclicIds = {};
    cycles.forEach(function (group) {
      group.forEach(function (id) { cyclicIds[id] = true; });
    });

    // 图节点：所有定义 id + 被引用但未定义的 id（悬空节点）
    var nodeSet = {};
    Object.keys(defMap).forEach(function (id) { nodeSet[id] = true; });
    dangling.forEach(function (r) { nodeSet[r.id] = true; });

    return {
      defs: parsed.defs,
      refs: parsed.refs,
      defMap: defMap,
      duplicates: duplicates,
      dangling: dangling,
      edges: edges,
      cycles: cycles,
      cyclicIds: cyclicIds,
      nodes: Object.keys(nodeSet)
    };
  }

  /** Tarjan 强连通分量；size>1 或自环即循环 */
  function findCycles(adj) {
    var index = 0, stack = [], onStack = {}, idx = {}, low = {}, cycles = [];
    var ids = Object.keys(adj);

    function strongconnect(v) {
      idx[v] = low[v] = index++;
      stack.push(v);
      onStack[v] = true;
      Object.keys(adj[v]).forEach(function (w) {
        if (!(w in adj)) return; // 悬空目标不参与循环
        if (idx[w] === undefined) {
          strongconnect(w);
          low[v] = Math.min(low[v], low[w]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], idx[w]);
        }
      });
      if (low[v] === idx[v]) {
        var group = [];
        var w;
        do { w = stack.pop(); onStack[w] = false; group.push(w); } while (w !== v);
        if (group.length > 1 || adj[v][v]) cycles.push(group.sort());
      }
    }

    ids.forEach(function (v) { if (idx[v] === undefined) strongconnect(v); });
    return cycles;
  }

  /** 转义正则元字符 */
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 重命名：同步替换所有 [^old] 出现（定义与引用） */
  function renameFootnote(text, oldId, newId) {
    var re = new RegExp('\\[\\^' + escapeRe(oldId) + '\\]', 'g');
    return text.replace(re, '[^' + newId + ']');
  }

  /** 删除定义（全部重复定义块，含缩进续行） */
  function removeDefinition(text, id) {
    var lines = text.split('\n');
    var out = [];
    var skipping = false;
    var defHead = new RegExp('^\\[\\^' + escapeRe(id) + '\\]:');
    for (var i = 0; i < lines.length; i++) {
      if (defHead.test(lines[i])) { skipping = true; continue; }
      if (skipping && CONT_RE.test(lines[i])) continue;
      skipping = false;
      out.push(lines[i]);
    }
    return out.join('\n');
  }

  /** 删除所有对该 id 的引用（不在定义行上的） */
  function removeReferences(text, id) {
    var lines = text.split('\n');
    var refRe = new RegExp('\\s*\\[\\^' + escapeRe(id) + '\\]', 'g');
    var defHead = new RegExp('^\\[\\^' + escapeRe(id) + '\\]:');
    return lines.map(function (l) {
      return defHead.test(l) ? l : l.replace(refRe, '');
    }).join('\n');
  }

  var API = {
    parse: parse,
    analyze: analyze,
    findCycles: findCycles,
    renameFootnote: renameFootnote,
    removeDefinition: removeDefinition,
    removeReferences: removeReferences
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.FnParser = API;
})(typeof self !== 'undefined' ? self : this);
