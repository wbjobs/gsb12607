// IndexedDB 持久化层。单条记录 kv: 'state'。
// 即便首次运行在旧版本数据库上，也在 upgradeneeded 中补齐 object store。

const DB_NAME = 'fn-markdown-editor';
const DB_VERSION = 1;
const STORE = 'kv';
const KEY = 'state';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function loadRawState() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = tx(db, 'readonly').get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveState(state) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const req = tx(db, 'readwrite').put(state, KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function clearState() {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const req = tx(db, 'readwrite').delete(KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export function storageAvailable() {
  return typeof indexedDB !== 'undefined';
}
