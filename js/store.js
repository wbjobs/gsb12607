/*
 * store.js — IndexedDB 持久化，状态可序列化 + 版本迁移。
 *
 * 数据库: md-footnote-editor
 * 对象仓库: kv (keyPath: key)
 * 文档键: 'doc'
 *
 * 状态格式（STATE_VERSION = 2）:
 *   v1: { text: string }                                  // 无版本号字段
 *   v2: { version: 2, text: string, updatedAt: number }   // 增加版本与时间戳
 */
(function (global) {
  'use strict';

  var DB_NAME = 'md-footnote-editor';
  var DB_VERSION = 1;
  var STORE = 'kv';
  var DOC_KEY = 'doc';
  var STATE_VERSION = 2;

  var migrations = {
    // v1 -> v2：补充版本号与时间戳
    2: function (state) {
      return {
        version: 2,
        text: typeof state.text === 'string' ? state.text : '',
        updatedAt: typeof state.updatedAt === 'number' ? state.updatedAt : Date.now()
      };
    }
  };

  /** 将任意旧版本状态迁移到当前版本 */
  function migrate(state) {
    if (state == null || typeof state !== 'object') return null;
    var version = typeof state.version === 'number' ? state.version : 1;
    var cur = state;
    while (version < STATE_VERSION) {
      var next = migrations[version + 1];
      if (!next) break;
      cur = next(cur);
      version++;
    }
    if (version !== STATE_VERSION) return null; // 来自更新版本，无法兼容
    return cur;
  }

  function open() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function load() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(DOC_KEY);
        req.onsuccess = function () {
          var row = req.result;
          if (!row) { resolve(null); return; }
          var migrated = migrate(row.value);
          resolve(migrated); // null 表示不兼容，调用方回退默认文档
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function save(text) {
    var state = { version: STATE_VERSION, text: text, updatedAt: Date.now() };
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ key: DOC_KEY, value: state });
        tx.oncomplete = function () { resolve(state); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function clear() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  global.FnStore = { load: load, save: save, clear: clear, migrate: migrate, STATE_VERSION: STATE_VERSION };
})(typeof self !== 'undefined' ? self : this);
