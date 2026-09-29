// 可序列化状态与版本迁移。
// v1（旧版）：{version:1, content, cursor, viewport}
// v2（当前）：{version:2, doc:{text,cursor,scroll}, ui:{sidebar,graphViewport}, updatedAt}

export const CURRENT_VERSION = 2;

export function createState(text = '') {
  return {
    version: CURRENT_VERSION,
    doc: {
      text,
      cursor: 0,
      scroll: { top: 0, left: 0 },
    },
    ui: {
      sidebar: 'footnotes',
      graphViewport: { x: 0, y: 0, scale: 1 },
    },
    updatedAt: 0,
  };
}

export function migrate(raw) {
  if (raw == null) return { state: null, changed: false, fromVersion: null };

  let data = typeof raw === 'string' ? safeJson(raw) : raw;
  if (data === undefined) return { state: null, changed: false, fromVersion: null };
  const fromVersion = data.version ?? 1;

  let v = data.version ?? 1;

  if (v < 1) {
    // 未知更早版本：尽力提取 content
    data = { content: typeof data === 'string' ? data : '' };
    v = 1;
  }

  if (v === 1) {
    data = {
      version: 2,
      doc: {
        text: data.content ?? '',
        cursor: typeof data.cursor === 'number' ? data.cursor : 0,
        scroll: { top: data.scrollTop ?? 0, left: 0 },
      },
      ui: {
        sidebar: data.activeTab || 'footnotes',
        graphViewport: { x: 0, y: 0, scale: 1 },
      },
      updatedAt: data.savedAt || data.updatedAt || 0,
    };
    v = 2;
  }

  if (v > CURRENT_VERSION) {
    // 前向兼容：高版本数据不破坏，尽量读取可识别字段。
    return {
      state: normalize(extractKnown(data)),
      changed: true,
      fromVersion,
      warning: `数据版本 v${v} 高于当前支持的 v${CURRENT_VERSION}，已按兼容模式打开，保存后将转为 v${CURRENT_VERSION}`,
    };
  }

  return { state: normalize(data), changed: true, fromVersion };
}

function extractKnown(d) {
  return {
    version: CURRENT_VERSION,
    doc: {
      text: d?.doc?.text ?? d?.content ?? '',
      cursor: typeof d?.doc?.cursor === 'number' ? d.doc.cursor : 0,
      scroll: { top: d?.doc?.scroll?.top ?? 0, left: d?.doc?.scroll?.left ?? 0 },
    },
    ui: {
      sidebar: d?.ui?.sidebar || 'footnotes',
      graphViewport: d?.ui?.graphViewport || { x: 0, y: 0, scale: 1 },
    },
    updatedAt: d?.updatedAt || 0,
  };
}

function normalize(state) {
  const base = createState('');
  const text = typeof state?.doc?.text === 'string' ? state.doc.text : '';
  return {
    version: CURRENT_VERSION,
    doc: {
      text,
      cursor: clampInt(state?.doc?.cursor, 0, text.length),
      scroll: {
        top: numOr0(state?.doc?.scroll?.top),
        left: numOr0(state?.doc?.scroll?.left),
      },
    },
    ui: {
      sidebar: ['footnotes', 'problems', 'graph'].includes(state?.ui?.sidebar) ? state.ui.sidebar : 'footnotes',
      graphViewport: {
        x: numOr0(state?.ui?.graphViewport?.x),
        y: numOr0(state?.ui?.graphViewport?.y),
        scale: typeof state?.ui?.graphViewport?.scale === 'number' ? state.ui.graphViewport.scale : 1,
      },
    },
    updatedAt: numOr0(state?.updatedAt),
  };
}

function clampInt(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function safeJson(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

// 生成一份 v1 旧数据（供测试/演示迁移）。
export function legacyV1(content, cursor = 0) {
  return { version: 1, content, cursor, scrollTop: 0, activeTab: 'problems', savedAt: 123 };
}
