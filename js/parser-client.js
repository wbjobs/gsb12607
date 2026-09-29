// Worker 客户端；Worker 不可用时回退到主线程解析。
import { parseMarkdown } from './footnotes.js';

export class ParserClient {
  constructor() {
    this.worker = null;
    this.fallback = false;
    this.pending = new Map();
    this.latestId = 0;
  }

  start() {
    if (this.worker || this.fallback) return;
    if (typeof Worker === 'undefined' || typeof URL === 'undefined') {
      this.fallback = true;
      return;
    }
    try {
      this.worker = new Worker(new URL('../sw/parser.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const { id, type, model, message } = e.data || {};
        const resolver = this.pending.get(id);
        if (!resolver) return;
        this.pending.delete(id);
        if (type === 'result') resolver.resolve(model);
        else resolver.reject(new Error(message || 'worker parse error'));
      };
      this.worker.onerror = () => {
        // Worker 整体失败：切换兜底并拒绝所有等待中的请求
        this.fallback = true;
        const w = this.worker;
        this.worker = null;
        try { w && w.terminate(); } catch {}
        for (const [id, p] of this.pending) {
          try { p.resolve(parseMarkdown(p.text)); } catch (e) { p.reject(e); }
        }
        this.pending.clear();
      };
    } catch {
      this.fallback = true;
    }
  }

  parse(text) {
    if (this.fallback || !this.worker) {
      return Promise.resolve().then(() => parseMarkdown(text));
    }
    const id = ++this.latestId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, text });
      this.worker.postMessage({ type: 'parse', id, text });
    });
  }
}
