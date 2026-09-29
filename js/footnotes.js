// 纯逻辑模块：Markdown 脚注解析、引用关系图、循环/悬空/重复检测、重命名/删除编辑规划。
// 不依赖 DOM，可在主线程与 Web Worker 中使用，也可在 Node 下单测。

export const PROBLEM = Object.freeze({
  DANGLING: 'dangling',
  DUPLICATE: 'duplicate',
  CYCLE: 'cycle',
  UNUSED: 'unused',
});

export const SEVERITY = Object.freeze({
  error: 'error',
  warning: 'warning',
  info: 'info',
});

const DEF_RE = /(^|\n)([ \t]{0,3})\[\^([^\]\n]+)\]:([ \t]*)([^\n]*)/g;
const REF_RE = /\[\^([^\]\n]+)\]/g;
const FENCE_RE = /(^|\n)([ \t]{0,3})(`{3,}|~{3,})([^\n]*)/g;

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

export function offsetToLineCol(text, offset, starts) {
  const ls = starts || lineStarts(text);
  let lo = 0;
  let hi = ls.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ls[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - ls[lo] };
}

export function lineStartOffset(text, line) {
  const ls = lineStarts(text);
  return ls[Math.min(Math.max(line, 0), ls.length - 1)];
}

function findFences(text) {
  // 返回围栏代码块的 [start, end) 区间（end 不含结尾换行）。
  const ranges = [];
  const starts = lineStarts(text);
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const markerLineStart = m.index + (m[1] ? m[1].length : 0);
    const indent = m[2] ? m[2].length : 0;
    if (indent > 3) continue;
    const tick = m[3][0];
    const len = m[3].length;
    const info = m[4] || '';
    if (tick === '`' && info.includes('`')) continue;
    const openEnd = markerLineStart + m[0].length - (m[1] ? m[1].length : 0);
    const lineIdx = starts.findIndex((s) => s === markerLineStart);
    let end = null;
    for (let i = lineIdx + 1; i < starts.length; i++) {
      const ls = starts[i];
      const lineEnd = (starts[i + 1] ?? text.length + 1) - 1;
      const content = text.slice(ls, lineEnd);
      const cm = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*$/.exec(content);
      if (cm && cm[2][0] === tick && cm[2].length >= len) {
        end = ls + cm[0].length;
        break;
      }
    }
    if (end === null) {
      // 未闭合围栏：到文档末尾
      end = text.length;
    }
    ranges.push([openEnd, end]);
  }
  return mergeRanges(ranges);
}

function mergeRanges(ranges) {
  if (ranges.length === 0) return ranges;
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
    else out.push(sorted[i].slice());
  }
  return out;
}

function inAny(ranges, pos) {
  for (const [s, e] of ranges) {
    if (pos >= s && pos < e) return true;
    if (s > pos) break;
  }
  return false;
}

function scanDefinitions(text, fences, starts) {
  const defs = [];
  DEF_RE.lastIndex = 0;
  let m;
  while ((m = DEF_RE.exec(text)) !== null) {
    const lineStart = m.index + (m[1] ? m[1].length : 0);
    const indent = m[2] ? m[2].length : 0;
    if (indent > 3) continue;
    if (inAny(fences, lineStart)) continue;

    const label = m[3];
    const labelStart = lineStart + (m[2] ? m[2].length : 0) + 2; // [^ 后
    const labelEnd = labelStart + label.length;
    const firstBody = m[5] || '';
    const firstLineEnd = m.index + m[0].length;
    const blockStart = lineStart;

    // 收集延续行：缩进 >= 4（制表符按 4 列展开）
    const bodyLines = [{
      text: firstBody,
      start: (m.index + m[0].length) - firstBody.length,
      end: firstLineEnd,
    }];
    let blockEnd = firstLineEnd; // 不含结尾换行
    let blankCarry = firstBody.trim().length === 0;
    let pending = 0;
    if (firstBody.trim().length === 0) pending = 1;

    let cursor = firstLineEnd;
    while (cursor < text.length && text[cursor] === '\n') {
      const nextStart = cursor + 1;
      const nextEnd = (() => {
        const nl = text.indexOf('\n', nextStart);
        return nl === -1 ? text.length : nl;
      })();
      const lineText = text.slice(nextStart, nextEnd);
      const indentMatch = /^[ \t]*/.exec(lineText)[0];
      let cols = 0;
      for (const ch of indentMatch) cols += ch === '\t' ? (4 - (cols % 4)) : 1;

      if (cols >= 4) {
        bodyLines.push({ text: lineText, start: nextStart, end: nextEnd });
        blockEnd = nextEnd;
        pending += blankCarry ? 1 : 0;
        if (lineText.trim().length !== 0) {
          blankCarry = false;
          pending = 0;
        }
        cursor = nextEnd;
      } else if (lineText.trim().length === 0) {
        // 空行：只有后面还能接上缩进行才属于该块
        let probe = nextEnd;
        let found = null;
        while (probe < text.length && text[probe] === '\n') {
          const s2 = probe + 1;
          const e2 = (() => {
            const nl = text.indexOf('\n', s2);
            return nl === -1 ? text.length : nl;
          })();
          const lt2 = text.slice(s2, e2);
          if (lt2.trim().length === 0) {
            probe = e2;
            continue;
          }
          const im = /^[ \t]*/.exec(lt2)[0];
          let c = 0;
          for (const ch of im) c += ch === '\t' ? (4 - (c % 4)) : 1;
          if (c >= 4) found = e2;
          break;
        }
        if (found !== null) {
          bodyLines.push({ text: lineText, start: nextStart, end: nextEnd });
          blockEnd = nextEnd;
          blankCarry = true;
          pending += 1;
          cursor = nextEnd;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    const bodyStart = bodyLines[0].start;
    const blockCutEnd = blockEnd;
    defs.push({
      key: null,
      label,
      labelStart,
      labelEnd,
      markerStart: lineStart,
      markerEnd: firstLineEnd,
      bodyStart,
      bodyEnd: blockCutEnd,
      blockStart,
      blockEnd,
      bodyLines,
    });
  }
  defs.sort((a, b) => a.markerStart - b.markerStart);
  defs.forEach((d, i) => { d.key = i; });
  return defs;
}

function scanInlineCodes(text, fences) {
  // 成对反引号序列视为行内代码；不配对则忽略。
  const out = [];
  let i = 0;
  while (i < text.length) {
    const hit = fences.find(([s, e]) => i >= s && i < e);
    if (hit) { i = hit[1]; continue; }
    if (text[i] !== '`') { i++; continue; }
    let len = 0;
    while (i + len < text.length && text[i + len] === '`') len++;
    const seq = text.slice(i, i + len);
    const close = text.indexOf(seq, i + len);
    if (close === -1) { i += len; continue; }
    // 闭合反引号后必须紧邻非反引号（或文末）
    let cl = close;
    let chosen = -1;
    while (cl !== -1) {
      const after = cl + len;
      if (after >= text.length || text[after] !== '`') { chosen = cl; break; }
      cl = text.indexOf(seq, after);
    }
    if (chosen === -1) { i += len; continue; }
    out.push([i, chosen + len]);
    i = chosen + len;
  }
  return mergeRanges(out);
}

function scanRefsInSegment(text, start, end, blocked, sink) {
  const seg = text.slice(start, end);
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(seg)) !== null) {
    const s = start + m.index;
    const e = s + m[0].length;
    if (inAny(blocked, s)) continue;
    sink.push({
      key: null,
      label: m[1],
      start: s,
      end: e,
      labelStart: s + 2,
      labelEnd: e - 1,
    });
  }
}

function scanReferences(text, fences, codes, defs) {
  // 定义标记行不作为引用；body 内的 [^x] 才算引用。
  const refs = [];
  const defMarkerRanges = mergeRanges(defs.map((d) => [d.markerStart, d.bodyStart]));
  const blocked = mergeRanges(fences.concat(codes).concat(defMarkerRanges));

  // 切成若干“非屏蔽”区间
  let cursor = 0;
  const segments = [];
  const sorted = blocked.slice().sort((a, b) => a[0] - b[0]);
  for (const [s, e] of sorted) {
    if (s > cursor) segments.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < text.length) segments.push([cursor, text.length]);

  for (const [s, e] of segments) scanRefsInSegment(text, s, e, blocked, refs);
  refs.sort((a, b) => a.start - b.start);
  refs.forEach((r, i) => { r.key = i; });
  return refs;
}

function groupByLabel(defs, refs) {
  const defByLabel = new Map();
  for (const d of defs) {
    if (!defByLabel.has(d.label)) defByLabel.set(d.label, []);
    defByLabel.get(d.label).push(d);
  }
  const refByLabel = new Map();
  for (const r of refs) {
    if (!refByLabel.has(r.label)) refByLabel.set(r.label, []);
    refByLabel.get(r.label).push(r);
  }
  return { defByLabel, refByLabel };
}

function collectBodyRefs(defModel, refs) {
  const body = [];
  for (const r of refs) {
    for (const d of defModel.defs) {
      if (r.start >= d.bodyStart && r.start < d.bodyEnd) {
        body.push(r);
        break;
      }
    }
  }
  return body;
}

function buildAdjacency(defByLabel, refs) {
  // 边：定义 body 中引用了哪些已定义标签。
  const adj = new Map();
  for (const label of defByLabel.keys()) adj.set(label, []);
  for (const [label, list] of defByLabel) {
    const primary = list[0];
    const targets = new Set();
    for (const r of refs) {
      if (r.start < primary.bodyStart || r.start >= primary.bodyEnd) continue;
      if (defByLabel.has(r.label)) targets.add(r.label);
    }
    adj.set(label, [...targets]);
  }
  return adj;
}

function stronglyConnectedComponents(adj) {
  // Tarjan 迭代式，避免深递归。
  const labels = [...adj.keys()];
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const comps = [];
  let counter = 0;

  for (const root of labels) {
    if (index.has(root)) continue;
    const work = [{ v: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length) {
      const frame = work[work.length - 1];
      const neighbors = adj.get(frame.v) || [];
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i++];
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v), index.get(w)));
        }
      } else {
        if (low.get(frame.v) === index.get(frame.v)) {
          const comp = [];
          for (;;) {
            const w = stack.pop();
            onStack.delete(w);
            comp.push(w);
            if (w === frame.v) break;
          }
          comps.push(comp);
        }
        work.pop();
        if (work.length) {
          const child = frame.v;
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent), low.get(child)));
        }
      }
    }
  }
  return comps;
}

function findCyclePath(adj, start) {
  // DFS：从 start 出发寻找一条回到 start 的路径。
  const stack = [[start, 0]];
  const path = [start];
  const onPath = new Set([start]);
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const neighbors = adj.get(frame[0]) || [];
    if (frame[1] >= neighbors.length) {
      onPath.delete(path.pop());
      stack.pop();
      continue;
    }
    const next = neighbors[frame[1]++];
    if (next === start && path.length >= 1) {
      return [...path, start];
    }
    if (onPath.has(next)) continue;
    onPath.add(next);
    path.push(next);
    stack.push([next, 0]);
  }
  return [start, start];
}

export function parseMarkdown(text) {
  const starts = lineStarts(text);
  const fences = findFences(text);
  const defs = scanDefinitions(text, fences, starts);
  const codes = scanInlineCodes(text, fences);
  const refs = scanReferences(text, fences, codes, defs);
  const { defByLabel, refByLabel } = groupByLabel(defs, refs);

  // 主定义：同名定义中的第一个，其余为重复。
  const primaryByLabel = new Map();
  for (const [label, list] of defByLabel) primaryByLabel.set(label, list[0]);

  const adj = buildAdjacency(defByLabel, refs);
  const comps = stronglyConnectedComponents(adj);
  const cycleLabels = new Set();
  const cycles = [];
  for (const comp of comps) {
    const isCycle = comp.length > 1 || (comp.length === 1 && (adj.get(comp[0]) || []).includes(comp[0]));
    if (!isCycle) continue;
    const members = comp.slice().sort((a, b) => primaryByLabel.get(a).markerStart - primaryByLabel.get(b).markerStart);
    for (const l of members) cycleLabels.add(l);
    cycles.push({
      members,
      path: findCyclePath(adj, members[0]),
    });
  }

  // 编号：先按正文内首次引用顺序，再按定义出现顺序补齐。
  const numbers = new Map();
  let n = 1;
  for (const r of refs) {
    if (!primaryByLabel.has(r.label)) continue;
    if (!numbers.has(r.label)) numbers.set(r.label, n++);
  }
  for (const d of defs) {
    if (!numbers.has(d.label)) numbers.set(d.label, n++);
  }

  // 引用归属
  for (const r of refs) {
    const defsForLabel = defByLabel.get(r.label) || [];
    r.resolvedDefKey = defsForLabel.length ? defsForLabel[0].key : null;
    r.number = numbers.get(r.label) ?? null;
    r.inCycle = cycleLabels.has(r.label);
    let ownerKey = null;
    for (const d of defs) {
      if (r.start >= d.bodyStart && r.start < d.bodyEnd) { ownerKey = d.key; break; }
    }
    r.ownerDefKey = ownerKey;
  }
  for (const d of defs) {
    d.isPrimary = primaryByLabel.get(d.label) === d;
    d.inCycle = cycleLabels.has(d.label);
    d.number = numbers.get(d.label) ?? null;
  }

  const problems = [];
  for (const [, list] of defByLabel) {
    for (let i = 1; i < list.length; i++) {
      const d = list[i];
      problems.push({
        type: PROBLEM.DUPLICATE,
        severity: SEVERITY.warning,
        start: d.labelStart,
        end: d.labelEnd,
        label: d.label,
        defKey: d.key,
        message: `重复定义：[^${d.label}] 已在前面定义`,
      });
    }
  }
  for (const r of refs) {
    if (!primaryByLabel.has(r.label)) {
      problems.push({
        type: PROBLEM.DANGLING,
        severity: SEVERITY.error,
        start: r.labelStart,
        end: r.labelEnd,
        label: r.label,
        refKey: r.key,
        message: `悬空引用：没有找到 [^${r.label}] 的定义`,
      });
    }
  }
  for (const [label] of defByLabel) {
    const used = (refByLabel.get(label) || []).some((r) => r.ownerDefKey === null);
    if (!used) {
      const d = primaryByLabel.get(label);
      problems.push({
        type: PROBLEM.UNUSED,
        severity: SEVERITY.info,
        start: d.labelStart,
        end: d.labelEnd,
        label,
        defKey: d.key,
        message: `定义未被正文引用：[^${label}]`,
      });
    }
  }
  for (const cyc of cycles) {
    const first = primaryByLabel.get(cyc.members[0]);
    problems.push({
      type: PROBLEM.CYCLE,
      severity: SEVERITY.error,
      start: first.labelStart,
      end: first.labelEnd,
      label: first.label,
      members: cyc.members,
      path: cyc.path,
      message: `循环引用：${cyc.path.map((l) => `[^${l}]`).join(' → ')}`,
    });
  }
  problems.sort((a, b) => a.start - b.start || a.end - b.end);

  // 高亮 token
  const tokens = [];
  for (const d of defs) {
    tokens.push({
      kind: 'def',
      start: d.labelStart,
      end: d.labelEnd,
      label: d.label,
      defKey: d.key,
      state: !d.isPrimary ? 'duplicate' : (d.inCycle ? 'cycle' : 'ok'),
    });
  }
  for (const r of refs) {
    tokens.push({
      kind: 'ref',
      start: r.labelStart,
      end: r.labelEnd,
      label: r.label,
      refKey: r.key,
      state: r.resolvedDefKey === null ? 'dangling' : (r.inCycle ? 'cycle' : 'ok'),
    });
  }
  tokens.sort((a, b) => a.start - b.start);

  // 图模型
  const nodes = [{ id: '__doc__', label: '正文', kind: 'doc', number: null, cycle: false }];
  for (const [label] of defByLabel) {
    nodes.push({
      id: label,
      label,
      kind: 'def',
      number: numbers.get(label) ?? null,
      cycle: cycleLabels.has(label),
    });
  }
  for (const r of refs) {
    if (!primaryByLabel.has(r.label)) {
      if (!nodes.some((nd) => nd.id === r.label)) {
        nodes.push({ id: r.label, label: r.label, kind: 'dangling', number: null, cycle: false });
      }
    }
  }
  const edges = [];
  const docLinked = new Set();
  for (const r of refs) {
    if (r.ownerDefKey === null) {
      if (!docLinked.has(r.label)) {
        edges.push({ from: '__doc__', to: r.label, kind: 'doc', number: r.number });
        docLinked.add(r.label);
      }
    }
  }
  for (const r of refs) {
    if (r.ownerDefKey !== null) {
      const owner = defs.find((d) => d.key === r.ownerDefKey);
      if (owner && defByLabel.has(r.label)) {
        edges.push({ from: owner.label, to: r.label, kind: 'body', refKey: r.key });
      }
    }
  }

  return {
    text,
    starts,
    fences,
    defs,
    refs,
    defByLabel,
    refByLabel,
    primaryByLabel,
    numbers,
    problems,
    cycles,
    cycleLabels,
    tokens,
    graph: { nodes, edges },
  };
}

export function problemAt(model, offset) {
  return model.problems.find((p) => offset >= p.start && offset <= p.end) || null;
}

export function tokenAt(model, offset) {
  return model.tokens.find((t) => offset >= t.start && offset <= t.end) || null;
}
