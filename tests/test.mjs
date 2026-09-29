import assert from 'node:assert/strict';
import { parseMarkdown, PROBLEM } from '../js/footnotes.js';
import {
  applyEdits, planRename, planBatchRename, planDeleteDefinition,
  planDeleteOccurrence, planCreateDefinition, isLegalLabel,
} from '../js/edits.js';
import { migrate, legacyV1, createState, CURRENT_VERSION } from '../js/state.js';
import { exportHtml } from '../js/exporter.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('基础解析');
const doc = [
  '正文引用 [^a] 和 [^b]，再来一个 [^a]。',
  '',
  '[^a]: 脚注 A 的内容',
  '    延续行，里面引用 [^b]',
  '[^b]: 脚注 B',
].join('\n');
const m = parseMarkdown(doc);
test('识别出 2 个定义', () => assert.equal(m.defs.length, 2));
test('识别出 4 处引用（含 body 内的 [^b]）', () => assert.equal(m.refs.length, 4));
test('编号按首次引用顺序 a=1 b=2', () => {
  assert.equal(m.numbers.get('a'), 1);
  assert.equal(m.numbers.get('b'), 2);
});
test('重复引用解析到同一个定义', () => {
  assert.equal(m.refs[0].resolvedDefKey, m.refs[2].resolvedDefKey);
});
test('body 内引用的 ownerDefKey 指向所属定义', () => {
  const bodyRef = m.refs.find((r) => r.start >= m.defs[0].bodyStart);
  assert.equal(bodyRef.ownerDefKey, m.defs[0].key);
});
test('无问题', () => assert.equal(m.problems.length, 0));

console.log('循环引用');
test('自循环被检测', () => {
  const mm = parseMarkdown('看 [^x]\n\n[^x]: 自指 [^x]');
  const cyc = mm.problems.find((p) => p.type === PROBLEM.CYCLE);
  assert.ok(cyc, '应报循环');
  assert.deepEqual(cyc.path, ['x', 'x']);
  assert.ok(mm.cycleLabels.has('x'));
});
test('多节点循环被检测且给出路径', () => {
  const mm = parseMarkdown('文档 [^a]\n\n[^a]: 引 b [^b]\n[^b]: 引 c [^c]\n[^c]: 引 a [^a]');
  const cyc = mm.problems.find((p) => p.type === PROBLEM.CYCLE);
  assert.ok(cyc);
  assert.deepEqual(cyc.members.sort(), ['a', 'b', 'c']);
  assert.equal(cyc.path[0], cyc.path[cyc.path.length - 1]);
  assert.ok(mm.graph.nodes.find((n) => n.id === 'a').cycle);
  testCycleEdges(mm);
});
function testCycleEdges(mm) {
  const cycEdges = mm.graph.edges.filter((e) => ['a', 'b', 'c'].includes(e.from) && ['a', 'b', 'c'].includes(e.to));
  assert.equal(cycEdges.length, 3);
}
test('不构成环的互引不报循环', () => {
  const mm = parseMarkdown('文档 [^a]\n\n[^a]: 见 b [^b]\n[^b]: 终点');
  assert.ok(!mm.problems.some((p) => p.type === PROBLEM.CYCLE));
});

console.log('悬空与重复');
test('悬空引用被标记', () => {
  const mm = parseMarkdown('引用不存在的 [^ghost]');
  const p = mm.problems.find((x) => x.type === PROBLEM.DANGLING);
  assert.ok(p);
  assert.equal(p.severity, 'error');
  assert.ok(mm.graph.nodes.find((n) => n.id === 'ghost' && n.kind === 'dangling'));
});
test('重复定义被标记且首个为主定义', () => {
  const mm = parseMarkdown('用了 [^d]\n\n[^d]: 第一\n[^d]: 第二');
  const p = mm.problems.find((x) => x.type === PROBLEM.DUPLICATE);
  assert.ok(p);
  const defs = mm.defByLabel.get('d');
  assert.equal(defs.length, 2);
  assert.equal(defs[0].isPrimary, true);
  assert.equal(defs[1].isPrimary, false);
});
test('未被正文引用的定义被提示', () => {
  const mm = parseMarkdown('普通文本\n\n[^u]: 没人用我');
  assert.ok(mm.problems.find((x) => x.type === PROBLEM.UNUSED));
});
test('被正文引用的定义不报 unused', () => {
  const mm = parseMarkdown('用 [^u]\n\n[^u]: 有人用');
  assert.ok(!mm.problems.some((x) => x.type === PROBLEM.UNUSED));
});

console.log('代码区域');
test('围栏代码块内的脚注被忽略', () => {
  const mm = parseMarkdown('```\n[^not-a-ref]\n[^x]: not def\n```\n');
  assert.equal(m.defs !== undefined && mm.defs.length, 0);
  assert.equal(mm.refs.length, 0);
});
test('行内代码中的脚注被忽略', () => {
  const mm = parseMarkdown('代码 `[^code]` 不是引用，真的 [^real] 才是\n\n[^real]: r');
  const labels = mm.refs.map((r) => r.label);
  assert.deepEqual(labels, ['real']);
});

console.log('重命名');
test('重命名同步更新定义与所有引用', () => {
  const plan = planRename(m, 'a', 'alpha');
  assert.ok(plan.ok);
  assert.equal(plan.edits.length, 3);
  const next = applyEdits(doc, plan.edits);
  const mm = parseMarkdown(next);
  assert.ok(mm.defByLabel.has('alpha'));
  assert.ok(!mm.defByLabel.has('a'));
  assert.equal(mm.refs.filter((r) => r.label === 'alpha').length, 2);
  assert.equal(mm.problems.length, 0);
});
test('重命名为已存在标签会冲突拒绝', () => {
  const plan = planRename(m, 'a', 'b');
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, 'conflict');
});
test('非法标签被拒绝', () => {
  assert.equal(isLegalLabel(''), false);
  assert.equal(isLegalLabel('a]b'), false);
  assert.equal(isLegalLabel('ok-tag_1'), true);
});
test('批量重命名检测批次内冲突', () => {
  const plan = planBatchRename(m, [
    { oldLabel: 'a', newLabel: 'x' },
    { oldLabel: 'b', newLabel: 'x' },
  ]);
  assert.equal(plan.ok, false);
  assert.ok(plan.items.some((i) => i.error));
});
test('批量重命名成功时所有引用同步', () => {
  const plan = planBatchRename(m, [
    { oldLabel: 'a', newLabel: 'alpha' },
    { oldLabel: 'b', newLabel: 'beta' },
  ]);
  assert.ok(plan.ok, JSON.stringify(plan.items));
  const next = applyEdits(doc, plan.edits);
  const mm = parseMarkdown(next);
  assert.deepEqual([...mm.defByLabel.keys()].sort(), ['alpha', 'beta']);
});

console.log('删除');
test('删除定义但保留引用 -> 引用悬空', () => {
  const plan = planDeleteDefinition(doc, m, 'b', { refs: 'keep' });
  assert.ok(plan.ok);
  const next = applyEdits(doc, plan.edits);
  const mm = parseMarkdown(next);
  assert.ok(!mm.defByLabel.has('b'));
  assert.ok(mm.problems.some((p) => p.type === PROBLEM.DANGLING && p.label === 'b'));
});
test('删除定义并移除全部引用 -> 无悬空', () => {
  const plan = planDeleteDefinition(doc, m, 'a', { refs: 'remove' });
  const next = applyEdits(doc, plan.edits);
  const mm = parseMarkdown(next);
  assert.ok(!mm.defByLabel.has('a'));
  assert.ok(!mm.refs.some((r) => r.label === 'a'));
  assert.ok(!mm.problems.some((p) => p.type === PROBLEM.DANGLING));
});
test('只删除一条重复定义', () => {
  const mm = parseMarkdown('用 [^d]\n\n[^d]: 第一\n[^d]: 第二');
  const dupKey = mm.defByLabel.get('d')[1].key;
  const plan = planDeleteOccurrence(mm.text, mm, dupKey);
  const next = applyEdits(mm.text, plan.edits);
  const after = parseMarkdown(next);
  assert.equal(after.defByLabel.get('d').length, 1);
});
test('为悬空引用创建定义', () => {
  const mm = parseMarkdown('新引用 [^fresh]');
  const plan = planCreateDefinition(mm.text, mm, 'fresh');
  assert.ok(plan.ok);
  const next = applyEdits(mm.text, plan.edits);
  const after = parseMarkdown(next);
  assert.ok(after.defByLabel.has('fresh'));
  assert.equal(after.problems.filter((p) => p.type === 'dangling').length, 0);
});

console.log('状态迁移');
test('v1 迁移到当前版本', () => {
  const { state, fromVersion } = migrate(legacyV1('hello [^x]', 5));
  assert.equal(fromVersion, 1);
  assert.equal(state.version, CURRENT_VERSION);
  assert.equal(state.doc.text, 'hello [^x]');
  assert.equal(state.doc.cursor, 5);
  assert.equal(state.ui.sidebar, 'problems');
});
test('空状态返回 null', () => assert.equal(migrate(null).state, null));
test('高版本数据前向兼容读取', () => {
  const { state, warning } = migrate({ version: 99, doc: { text: '未来版本', cursor: 2 } });
  assert.equal(state.doc.text, '未来版本');
  assert.ok(warning.includes('v99'));
});
test('损坏状态归一化', () => {
  const { state } = migrate({ version: 2, doc: { text: 123, cursor: 'bad' } });
  assert.equal(state.doc.text, '');
  assert.equal(state.doc.cursor, 0);
});
test('createState 是当前版本', () => assert.equal(createState('x').version, CURRENT_VERSION));

console.log('HTML 导出');
const html = exportHtml(m);
test('正文引用渲染为带上标编号的链接', () => {
  assert.match(html, /<sup class="fn-ref"><a href="#fn-1" id="fnref-1">1<\/a><\/sup>/);
});
test('脚注区按编号输出并含返回链接', () => {
  assert.match(html, /<li id="fn-1">/);
  assert.match(html, /<a class="fn-back" href="#fnref-1">/);
});
test('悬空引用在导出中被标记', () => {
  const mm = parseMarkdown('坏引用 [^nope]');
  const out = exportHtml(mm);
  assert.match(out, /fn-missing/);
});
test('重复定义只导出一次', () => {
  const mm = parseMarkdown('用 [^d]\n\n[^d]: 第一\n[^d]: 第二');
  const out = exportHtml(mm);
  const count = (out.match(/id="fn-1"/g) || []).length;
  assert.equal(count, 1);
});
test('围栏代码块以 <pre><code> 导出', () => {
  const mm = parseMarkdown('```js\nconst a=1\n```');
  assert.match(exportHtml(mm), /<pre><code class="language-js">/);
});

console.log(`\n${passed} 项测试通过`);

console.log('边界情况');
test('多行延续脚注 body 完整收集', () => {
  const text = '用 [^m]\n\n[^m]: 第一行\n    第二行\n    第三行\n\n正文继续';
  const mm = parseMarkdown(text);
  const d = mm.defs[0];
  assert.match(text.slice(d.bodyStart, d.bodyEnd), /第一行/);
  assert.match(text.slice(d.bodyStart, d.bodyEnd), /第三行/);
  assert.equal(mm.problems.length, 0);
});
test('空行分隔后不属于脚注', () => {
  const text = '[^m]: 第一行\n\n普通段落';
  const mm = parseMarkdown(text);
  const d = mm.defs[0];
  assert.ok(!text.slice(d.bodyStart, d.bodyEnd).includes('普通段落'));
});
test('空行后重新缩进仍属于脚注（lazy 延续）', () => {
  const text = '[^m]: 第一行\n\n    第二段缩进';
  const mm = parseMarkdown(text);
  const d = mm.defs[0];
  assert.match(text.slice(d.bodyStart, d.bodyEnd), /第二段缩进/);
});
test('问题与 token 高亮区间可嵌套生成 HTML', async () => {
  const { buildHighlight } = await import('../js/editor/highlight.js');
  const mm = parseMarkdown('引用 [^ghost]');
  const html = buildHighlight(mm.text, mm);
  assert.match(html, /prob-dangling/);
  assert.match(html, /tok-ref/);
});
test('循环中每个标签都有 token 状态 cycle', () => {
  const mm = parseMarkdown('文档 [^a]\n\n[^a]: [^b]\n[^b]: [^a]');
  assert.ok(mm.tokens.filter((t) => t.state === 'cycle').length >= 4);
});
test('正文 -> 脚注 与 body 边同时存在于图中', () => {
  const mm = parseMarkdown('文档 [^a][^b]\n\n[^a]: 引 [^b]\n[^b]: z');
  const docEdges = mm.graph.edges.filter((e) => e.from === '__doc__').map((e) => e.to).sort();
  assert.deepEqual(docEdges, ['a', 'b']);
  assert.ok(mm.graph.edges.some((e) => e.from === 'a' && e.to === 'b'));
});
test('Tab 缩进 4 列的定义可识别', () => {
  const mm = parseMarkdown('x [^t]\n\n[^t]: 行\n\t延续');
  const d = mm.defs[0];
  assert.match(m ? '' : '', /(?:)/);
  assert.match(m_text(d), /延续/);
  function m_text(dd) { return mm.text.slice(dd.bodyStart, dd.bodyEnd); }
});
test('删除最后一个脚注后编辑结果干净', () => {
  const text = '前面 [^z]\n\n[^z]: 唯一脚注\n后面';
  const mm = parseMarkdown(text);
  const plan = planDeleteDefinition(text, mm, 'z', { refs: 'remove' });
  const next = applyEdits(text, plan.edits);
  const after = parseMarkdown(next);
  assert.equal(after.defs.length, 0);
  assert.match(next, /前面/);
  assert.match(next, /后面/);
});
