// 解析 Worker：在后台线程执行 Markdown 脚注解析与循环图计算。
import { parseMarkdown } from '../js/footnotes.js';

let seq = 0;
self.onmessage = (e) => {
  const { id, type, text } = e.data || {};
  if (type !== 'parse') return;
  try {
    const model = parseMarkdown(text ?? '');
    self.postMessage({ id, type: 'result', seq: ++seq, model });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message || err) });
  }
};
