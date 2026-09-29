/*
 * worker.js — Web Worker：解析 Markdown、构建引用图、检测循环/悬空/重复。
 * 主线程通过 { type: 'analyze', id, text } 请求，回发 { type: 'result', id, analysis }。
 */
importScripts('parser.js');

self.onmessage = function (e) {
  var msg = e.data;
  if (!msg || msg.type !== 'analyze') return;
  var analysis;
  try {
    analysis = FnParser.analyze(msg.text);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String(err) });
    return;
  }
  self.postMessage({ type: 'result', id: msg.id, analysis: analysis });
};
