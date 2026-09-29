// Canvas 引用关系图：力导向布局、循环/悬空高亮、缩放平移与节点拖拽。

const COLORS = {
  doc: '#6e7781',
  def: '#0969da',
  dangling: '#cf222e',
  edge: '#8c959f',
  edgeCycle: '#cf222e',
  text: '#1f2328',
};

export class FootnoteGraph {
  constructor(canvas, { onSelect, onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect || (() => {});
    this.onHover = onHover || (() => {});
    this.nodes = new Map();
    this.edges = [];
    this.view = { x: 0, y: 0, scale: 1 };
    this.running = false;
    this.dragNode = null;
    this.dragMoved = false;
    this.panStart = null;
    this.hoverId = null;
    this.selectedId = null;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.bind();
    this.resize();
  }

  bind() {
    this.canvas.addEventListener('click', (e) => this.handleClick(e));
    this.canvas.addEventListener('mousedown', (e) => this.handleDown(e));
    window.addEventListener('mousemove', (e) => this.handleMove(e));
    window.addEventListener('mouseup', () => { this.dragNode = null; this.panStart = null; });
    this.canvas.addEventListener('wheel', (e) => this.handleWheel(e), { passive: false });
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width || 300;
    this.h = rect.height || 400;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw();
  }

  setViewport(v) {
    if (!v) return;
    this.view = {
      x: num(v.x), y: num(v.y), scale: v.scale > 0 ? v.scale : 1,
    };
    this.draw();
  }

  getViewport() {
    return { ...this.view };
  }

  setModel(model) {
    this.model = model;
    const next = new Map();
    const radiusFor = (n) => n.kind === 'doc' ? 20 : (n.cycle ? 16 : 14);
    for (const n of model.graph.nodes) {
      const prev = this.nodes.get(n.id);
      next.set(n.id, prev || {
        id: n.id,
        x: n.kind === 'doc' ? 70 : 70 + (next.size % 6) * 120 + 120,
        y: n.kind === 'doc' ? this.h / 2 : 60 + (next.size * 73) % Math.max(200, this.h - 120),
        vx: 0, vy: 0,
        r: radiusFor(n),
      });
      Object.assign(next.get(n.id), { kind: n.kind, cycle: n.cycle, number: n.number, label: n.label, r: radiusFor(n) });
    }
    this.nodes = next;
    this.edges = model.graph.edges.map((e) => ({ ...e }));
    this.start();
  }

  start() {
    if (this.running) return;
    this.running = true;
    let ticks = 0;
    const step = () => {
      this.simulate();
      this.draw();
      ticks++;
      if (ticks < 400) this.raf = requestAnimationFrame(step);
      else { this.running = false; this.draw(); }
    };
    this.raf = requestAnimationFrame(step);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  simulate() {
    const list = [...this.nodes.values()];
    // 斥力
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = Math.random(); dy = Math.random(); d2 = 0.01; }
        const d = Math.sqrt(d2);
        const force = 2600 / d2;
        const fx = (dx / d) * force;
        const fy = (dy / d) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    // 弹簧
    for (const e of this.edges) {
      const a = this.nodes.get(e.from);
      const b = this.nodes.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const target = 130;
      const force = (d - target) * 0.02;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // 重力 + 正文锚点
    for (const n of list) {
      if (n.kind === 'doc') {
        n.vx += (70 - n.x) * 0.1;
        n.vy += (this.h / 2 - n.y) * 0.1;
      } else {
        n.vx += (this.w / 2 - n.x) * 0.002;
        n.vy += (this.h / 2 - n.y) * 0.004;
      }
      if (this.dragNode === n.id) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.85;
      n.vy *= 0.85;
      n.x += n.vx;
      n.y += n.vy;
      n.x = Math.max(30, Math.min(this.w - 30, n.x));
      n.y = Math.max(30, Math.min(this.h - 30, n.y));
    }
  }

  toWorld(evt) {
    const rect = this.canvas.getBoundingClientRect();
    const px = evt.clientX - rect.left;
    const py = evt.clientY - rect.top;
    return { x: (px - this.view.x) / this.view.scale, y: (py - this.view.y) / this.view.scale, px, py };
  }

  nodeAt(p) {
    const list = [...this.nodes.values()].sort((a, b) => b.r - a.r);
    for (const n of list) {
      const dx = p.x - n.x;
      const dy = p.y - n.y;
      if (dx * dx + dy * dy <= (n.r + 2) * (n.r + 2)) return n;
    }
    return null;
  }

  handleDown(e) {
    this.dragMoved = false;
    const p = this.toWorld(e);
    const n = this.nodeAt(p);
    if (n) { this.dragNode = n.id; this.dragDown = { x: e.clientX, y: e.clientY }; return; }
    this.panStart = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
  }

  handleMove(e) {
    if (this.dragNode) {
      const p = this.toWorld(e);
      const n = this.nodes.get(this.dragNode);
      if (n) {
        n.x = p.x; n.y = p.y;
        if (Math.abs(e.clientX - this.dragDown.x) + Math.abs(e.clientY - this.dragDown.y) > 4) this.dragMoved = true;
        this.draw();
      }
      return;
    }
    if (this.panStart) {
      this.view.x = this.panStart.vx + (e.clientX - this.panStart.x);
      this.view.y = this.panStart.vy + (e.clientY - this.panStart.y);
      this.draw();
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (e.target === this.canvas) {
      const p = this.toWorld(e);
      const n = this.nodeAt(p);
      const id = n ? n.id : null;
      if (id !== this.hoverId) {
        this.hoverId = id;
        this.canvas.style.cursor = n ? 'pointer' : 'grab';
        this.onHover(n || null, n ? { x: rect.left + p.px, y: rect.top + p.py } : null);
        this.draw();
      }
    }
  }

  handleClick(e) {
    if (this.dragMoved) return;
    const p = this.toWorld(e);
    const n = this.nodeAt(p);
    if (n) {
      this.selectedId = n.id;
      this.draw();
      this.onSelect(n);
    }
  }

  handleWheel(e) {
    e.preventDefault();
    const p = this.toWorld(e);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(2.5, Math.max(0.3, this.view.scale * factor));
    // 以光标为中心缩放
    this.view.x = p.px - p.x * newScale;
    this.view.y = p.py - p.y * newScale;
    this.view.scale = newScale;
    this.draw();
  }

  selectLabel(label) {
    this.selectedId = label;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(this.view.scale, this.view.scale);

    // 边
    for (const e of this.edges) {
      const a = this.nodes.get(e.from);
      const b = this.nodes.get(e.to);
      if (!a || !b) continue;
      const cyclic = a.cycle && b.cycle && this.model && this.model.cycleLabels &&
        this.model.cycleLabels.has(a.id) && this.model.cycleLabels.has(b.id);
      this.drawArrow(a, b, cyclic ? COLORS.edgeCycle : COLORS.edge);
    }

    // 节点
    for (const n of this.nodes.values()) this.drawNode(n);
    ctx.restore();
  }

  drawArrow(a, b, color) {
    const ctx = this.ctx;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const ux = dx / d;
    const uy = dy / d;
    const sx = a.x + ux * a.r;
    const sy = a.y + uy * a.r;
    const tx = b.x - ux * (b.r + 5);
    const ty = b.y - uy * (b.r + 5);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    const ang = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 7 * Math.cos(ang - 0.4), ty - 7 * Math.sin(ang - 0.4));
    ctx.lineTo(tx - 7 * Math.cos(ang + 0.4), ty - 7 * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  drawNode(n) {
    const ctx = this.ctx;
    const fill = n.kind === 'doc' ? COLORS.doc : (n.kind === 'dangling' ? '#fff5f5' : (n.cycle ? '#ffebe9' : '#ddf4ff'));
    const stroke = n.kind === 'dangling' ? COLORS.dangling : (n.cycle ? COLORS.edgeCycle : COLORS.def);
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = this.selectedId === n.id ? 3 : 1.6;
    ctx.strokeStyle = stroke;
    ctx.stroke();

    ctx.fillStyle = n.kind === 'doc' ? '#fff' : (n.kind === 'dangling' ? COLORS.dangling : COLORS.def);
    ctx.font = `${n.kind === 'doc' ? 11 : 10}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const caption = n.kind === 'doc' ? '文' : (n.number != null ? String(n.number) : '?');
    ctx.fillText(caption, n.x, n.y + 0.5);

    // 标签放在节点下方
    ctx.fillStyle = this.hoverId === n.id || this.selectedId === n.id ? '#0969da' : COLORS.text;
    ctx.font = '11px system-ui, sans-serif';
    const label = n.kind === 'doc' ? '正文' : n.label;
    ctx.fillText(truncate(label, 14), n.x, n.y + n.r + 11);
  }
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function num(v) {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}
