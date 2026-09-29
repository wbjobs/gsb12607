/*
 * graph.js — Canvas 引用关系图。
 * 节点：脚注 id（被定义 = 实色圆；悬空被引用 = 虚线圆）。
 * 边：定义 -> 其定义体内引用的脚注（带箭头）。
 * 循环引用节点标红，悬空节点标橙。点击节点触发 onSelect(id)。
 */
(function (global) {
  'use strict';

  function Graph(canvas, onSelect) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect || function () {};
    this.nodes = [];   // { id, x, y, r, cyclic, dangling, duplicate }
    this.edges = [];   // { from, to }
    this._bindEvents();
  }

  Graph.prototype._bindEvents = function () {
    var self = this;
    this.canvas.addEventListener('click', function (e) {
      var rect = self.canvas.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      var hit = self._hitTest(x, y);
      if (hit) self.onSelect(hit.id);
    });
    this.canvas.addEventListener('mousemove', function (e) {
      var rect = self.canvas.getBoundingClientRect();
      var hit = self._hitTest(e.clientX - rect.left, e.clientY - rect.top);
      self.canvas.style.cursor = hit ? 'pointer' : 'default';
    });
  };

  Graph.prototype._hitTest = function (x, y) {
    for (var i = this.nodes.length - 1; i >= 0; i--) {
      var n = this.nodes[i];
      var dx = x - n.x, dy = y - n.y;
      if (dx * dx + dy * dy <= n.r * n.r) return n;
    }
    return null;
  };

  /** analysis: parser.analyze 的结果 */
  Graph.prototype.render = function (analysis) {
    var canvas = this.canvas;
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    var cssH = Math.max(260, Math.min(480, cssW * 0.8));
    canvas.style.height = cssH + 'px';
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    var ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var ids = analysis.nodes.slice().sort();
    this.nodes = [];
    this.edges = analysis.edges;

    if (ids.length === 0) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无脚注', cssW / 2, cssH / 2);
      return;
    }

    // 圆形布局
    var cx = cssW / 2, cy = cssH / 2;
    var radius = Math.max(40, Math.min(cssW, cssH) / 2 - 46);
    var pos = {};
    ids.forEach(function (id, i) {
      var angle = (2 * Math.PI * i) / ids.length - Math.PI / 2;
      pos[id] = {
        id: id,
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
        r: 18,
        cyclic: !!analysis.cyclicIds[id],
        dangling: !analysis.defMap[id],
        duplicate: analysis.duplicates.indexOf(id) !== -1
      };
    });
    this.nodes = ids.map(function (id) { return pos[id]; });

    // 边
    ctx.lineWidth = 1.2;
    analysis.edges.forEach(function (e) {
      var a = pos[e.from], b = pos[e.to];
      if (!a || !b) return;
      var cyclic = analysis.cyclicIds[e.from] && analysis.cyclicIds[e.to];
      ctx.strokeStyle = cyclic ? '#d32f2f' : '#9aa4b2';
      ctx.fillStyle = ctx.strokeStyle;
      if (a === b) { drawSelfLoop(ctx, a); return; }
      drawArrow(ctx, a, b);
    });

    // 节点
    this.nodes.forEach(function (n) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      if (n.dangling) {
        ctx.setLineDash([4, 3]);
        ctx.fillStyle = '#fff8e6';
        ctx.strokeStyle = '#e6a23c';
      } else if (n.cyclic) {
        ctx.setLineDash([]);
        ctx.fillStyle = '#fdecea';
        ctx.strokeStyle = '#d32f2f';
      } else {
        ctx.setLineDash([]);
        ctx.fillStyle = '#e8f0fe';
        ctx.strokeStyle = '#4a7ddb';
      }
      ctx.lineWidth = n.duplicate ? 3 : 1.6;
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#1f2328';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var label = n.id.length > 8 ? n.id.slice(0, 7) + '…' : n.id;
      ctx.fillText(label, n.x, n.y);
      if (n.duplicate) {
        ctx.fillStyle = '#b26a00';
        ctx.font = 'bold 10px sans-serif';
        ctx.fillText('×dup', n.x, n.y - n.r - 7);
      }
    });
  };

  function drawArrow(ctx, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.hypot(dx, dy) || 1;
    var ux = dx / len, uy = dy / len;
    var sx = a.x + ux * a.r, sy = a.y + uy * a.r;
    var ex = b.x - ux * (b.r + 4), ey = b.y - uy * (b.r + 4);
    // 轻微弯曲避免双向边重叠
    var mx = (sx + ex) / 2 - uy * 10;
    var my = (sy + ey) / 2 + ux * 10;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    ctx.stroke();
    // 箭头
    var t = 0.9;
    var px = 2 * (1 - t) * (mx - sx) + 2 * t * (ex - mx);
    var py = 2 * (1 - t) * (my - sy) + 2 * t * (ey - my);
    var pl = Math.hypot(px, py) || 1;
    var ax = px / pl, ay = py / pl;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - 8 * ax + 4 * ay, ey - 8 * ay - 4 * ax);
    ctx.lineTo(ex - 8 * ax - 4 * ay, ey - 8 * ay + 4 * ax);
    ctx.closePath();
    ctx.fill();
  }

  function drawSelfLoop(ctx, n) {
    ctx.beginPath();
    ctx.arc(n.x, n.y - n.r - 8, 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(n.x + 8, n.y - n.r - 4, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  global.FnGraph = Graph;
})(typeof self !== 'undefined' ? self : this);
