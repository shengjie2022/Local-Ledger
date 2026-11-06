/* =========================================================================
 * charts.js —— 纯 SVG 图表（零依赖，不联网）
 *
 * 为什么手写 SVG 而不用图表库：
 *   这个账本的核心承诺是"一个文件夹拷走就能用、离线可用、不上传任何数据"。
 *   引第三方库等于把一个几百 KB 的依赖塞进离线包，还得处理 CDN 不可达的问题。
 *   纯 SVG 反而更可控：颜色、留白、空数据状态都能精确调。
 *
 * 所有函数返回 SVG 字符串（而不是 DOM 节点），这样：
 *   ① 浏览器里一行 innerHTML 就能渲染
 *   ② Node 里可以直接对字符串做断言，图表不会静默画错
 * ========================================================================= */
window.LedgerCharts = (function () {
  'use strict';

  /** 分类配色：同一套色板贯穿环形图和图例，色相拉开、明度接近，相邻色不糊 */
  const PALETTE = [
    '#4f7cff', '#26c6a8', '#ff9f43', '#f3685f', '#9b8cff',
    '#38bdf8', '#f472b6', '#84cc16', '#fbbf24', '#94a3b8'
  ];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmt(n) {
    if (n == null || !isFinite(n)) return '';
    const neg = n < 0;
    const s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + s;
  }

  /** 轴刻度用「万 / 千」缩写，避免 7 位数字把图挤扁 */
  function shortNum(n) {
    const a = Math.abs(n);
    if (a >= 10000) return (n / 10000).toFixed(a >= 100000 ? 0 : 1) + '万';
    if (a >= 1000) return (n / 1000).toFixed(a >= 10000 ? 0 : 1) + 'k';
    return String(Math.round(n));
  }

  /* ------------------------------------------------------------------ *
   * 1. 环形图（分类占比）
   * @param {Array} data [{label, value}]
   * @returns {{svg:string, legend:Array, total:number}}
   * ------------------------------------------------------------------ */
  function donut(data, opts) {
    opts = opts || {};
    const size = opts.size || 240;
    const r = opts.radius || 84;
    const sw = opts.strokeWidth || 30;
    const cx = size / 2, cy = size / 2;
    const circ = 2 * Math.PI * r;

    const items = (data || [])
      .filter(d => d && isFinite(d.value) && d.value > 0)
      .map((d, i) => Object.assign({}, d, { color: d.color || PALETTE[i % PALETTE.length] }));

    const total = items.reduce((s, d) => s + d.value, 0);
    if (!items.length || total <= 0) {
      return {
        svg: '<svg class="chart-svg" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="暂无数据">' +
          '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="' + sw + '"/>' +
          '<text x="' + cx + '" y="' + cy + '" text-anchor="middle" dominant-baseline="middle" class="chart-empty">暂无数据</text>' +
          '</svg>',
        legend: [], total: 0
      };
    }

    let acc = 0;
    const segs = [];
    const legend = [];
    for (const d of items) {
      const frac = d.value / total;
      const len = frac * circ;
      const pct = frac * 100;
      segs.push(
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none"' +
        ' stroke="' + d.color + '" stroke-width="' + sw + '"' +
        ' stroke-dasharray="' + len.toFixed(2) + ' ' + (circ - len).toFixed(2) + '"' +
        ' stroke-dashoffset="' + (-acc).toFixed(2) + '"' +
        ' transform="rotate(-90 ' + cx + ' ' + cy + ')">' +
        '<title>' + esc(d.label) + '：' + fmt(d.value) + ' 元（' + pct.toFixed(1) + '%）</title>' +
        '</circle>'
      );
      acc += len;
      legend.push({ label: d.label, value: d.value, pct: pct, color: d.color });
    }

    const svg =
      '<svg class="chart-svg" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="分类占比环形图">' +
      segs.join('') +
      '<text x="' + cx + '" y="' + (cy - 10) + '" text-anchor="middle" class="chart-center-num">' + fmt(total) + '</text>' +
      '<text x="' + cx + '" y="' + (cy + 14) + '" text-anchor="middle" class="chart-center-label">' + esc(opts.centerLabel || '合计') + '</text>' +
      '</svg>';
    return { svg: svg, legend: legend, total: total };
  }

  /* ------------------------------------------------------------------ *
   * 2. 月度收支趋势（双向柱：收入向上、支出向下）
   * @param {Array} rows [{key, label, income, expense, net}]
   * @returns {string} SVG
   * ------------------------------------------------------------------ */
  function trend(rows, opts) {
    opts = opts || {};
    const W = 760, H = 250;
    const m = { l: 54, r: 14, t: 16, b: 40 };
    const data = (rows || []).filter(r => r);
    if (!data.length) {
      return '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="暂无数据">' +
        '<text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" class="chart-empty">暂无数据</text></svg>';
    }

    const plotW = W - m.l - m.r;
    const plotH = H - m.t - m.b;
    const zeroY = m.t + plotH / 2;

    let maxIn = 0, maxOut = 0;
    for (const r of data) {
      maxIn = Math.max(maxIn, r.income || 0);
      maxOut = Math.max(maxOut, r.expense || 0);
    }
    const peak = Math.max(maxIn, maxOut) || 1;
    const scale = (plotH / 2) / peak;

    const slot = plotW / data.length;
    const barW = Math.max(4, Math.min(26, slot / 2 - 4));

    const parts = [];
    parts.push('<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="月度收支趋势">');

    // 零线
    parts.push('<line x1="' + m.l + '" y1="' + zeroY + '" x2="' + (W - m.r) + '" y2="' + zeroY + '" class="chart-axis-line"/>');

    // 刻度：上下各两条（下方是支出方向，标负号更直观）
    for (const frac of [0.5, 1]) {
      const dy = plotH / 2 * frac;
      parts.push('<line x1="' + m.l + '" y1="' + (zeroY - dy) + '" x2="' + (W - m.r) + '" y2="' + (zeroY - dy) + '" class="chart-grid"/>');
      parts.push('<line x1="' + m.l + '" y1="' + (zeroY + dy) + '" x2="' + (W - m.r) + '" y2="' + (zeroY + dy) + '" class="chart-grid"/>');
      parts.push('<text x="' + (m.l - 8) + '" y="' + (zeroY - dy + 4) + '" text-anchor="end" class="chart-tick">' + shortNum(peak * frac) + '</text>');
      parts.push('<text x="' + (m.l - 8) + '" y="' + (zeroY + dy + 4) + '" text-anchor="end" class="chart-tick">-' + shortNum(peak * frac) + '</text>');
    }
    parts.push('<text x="' + (m.l - 8) + '" y="' + (zeroY + 4) + '" text-anchor="end" class="chart-tick">0</text>');

    for (let i = 0; i < data.length; i++) {
      const r = data[i];
      const cx = m.l + slot * i + slot / 2;
      const inc = Math.max(0, r.income || 0);
      const exp = Math.max(0, r.expense || 0);
      const hIn = inc * scale;
      const hOut = exp * scale;

      // 收入柱（向上）
      parts.push('<rect x="' + (cx - barW - 1) + '" y="' + (zeroY - hIn) + '" width="' + barW + '" height="' + Math.max(0, hIn) + '" rx="2" class="chart-bar-in">' +
        '<title>' + esc(r.label) + ' 收入：' + fmt(inc) + ' 元</title></rect>');
      // 支出柱（向下）
      parts.push('<rect x="' + (cx + 1) + '" y="' + zeroY + '" width="' + barW + '" height="' + Math.max(0, hOut) + '" rx="2" class="chart-bar-out">' +
        '<title>' + esc(r.label) + ' 支出：' + fmt(exp) + ' 元</title></rect>');

      // x 轴标签：太密就隔一个显示一个
      const step = data.length > 14 ? 3 : (data.length > 8 ? 2 : 1);
      if (i % step === 0 || i === data.length - 1) {
        parts.push('<text x="' + cx + '" y="' + (H - m.b + 18) + '" text-anchor="middle" class="chart-tick">' + esc(r.label) + '</text>');
      }
    }

    parts.push('</svg>');
    return parts.join('');
  }

  /* ------------------------------------------------------------------ *
   * 3. 分类聚合（供环形图使用）
   * ------------------------------------------------------------------ */
  function aggregateByCategory(txs, dir) {
    const want = dir || 'out';
    const map = new Map();
    for (const t of txs || []) {
      if (t.skip) continue;
      if (t.dir !== want) continue;
      if (t.kind === 'internal') continue;         // 内部划转不参与占比
      const v = t.netAmount;
      if (typeof v !== 'number' || !isFinite(v) || v <= 0) continue;   // 0 元和异常值不占图例名额
      const key = t.category || '未分类';
      map.set(key, (map.get(key) || 0) + v);
    }
    const arr = Array.from(map.entries()).map(([label, value]) => ({ label: label, value: value }));
    arr.sort((a, b) => b.value - a.value);
    return arr;
  }

  /** 超过 max 项时把尾巴合并成「其他」，避免图例长到没法看 */
  function topN(arr, max) {
    const limit = max || 9;
    if (!arr || arr.length <= limit) return (arr || []).slice();
    const head = arr.slice(0, limit - 1);
    const tail = arr.slice(limit - 1);
    const rest = tail.reduce((s, d) => s + d.value, 0);
    head.push({ label: '其他（' + tail.length + ' 类）', value: rest, color: PALETTE[PALETTE.length - 1] });
    return head;
  }

  return { donut: donut, trend: trend, aggregateByCategory: aggregateByCategory, topN: topN, PALETTE: PALETTE, fmt: fmt };
})();
