/* =========================================================================
 * parse.js —— 微信 / 支付宝账单明细解析
 *
 * 职责链：字节流 → 文本(编码识别) → 表格(CSV/TSV 切分) → 表头定位
 *        → 列映射 → 行归一化 → 交易对象数组
 *
 * 设计要点：
 *  1. 微信/支付宝导出的文件头部都有"说明行"，表头位置不固定，所以逐行扫描定位。
 *  2. 列名用别名表 + 归一化（去空格、全角括号转半角）匹配，兼容新旧两种导出格式。
 *  3. 退款有两种形态：①账单里单独有一笔"退款"收入行 ②原支出行状态标为已退款。
 *     自动探测文件属于哪种，退款金额有"成功退款"列就用它，否则按状态推。
 * ========================================================================= */
window.LedgerParse = (function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. 解码：微信/支付宝账单几乎都是 GBK 编码，UTF-8 BOM 次之
   * ------------------------------------------------------------------ */
  function decodeBuffer(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)' };
    }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
    } catch (e) { /* 不是合法 UTF-8，继续尝试 GBK */ }
    try {
      return { text: new TextDecoder('gb18030').decode(bytes), encoding: 'GBK/GB18030' };
    } catch (e) { /* 极老浏览器兜底 */ }
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8(容错)' };
  }

  /* ------------------------------------------------------------------ *
   * 2. 表格切分
   * ------------------------------------------------------------------ */
  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).slice(0, 15);
    let best = ',';
    let bestScore = 0;
    for (const line of lines) {
      if (!line) continue;
      const c = (line.match(/,/g) || []).length;
      const t = (line.match(/\t/g) || []).length;
      const score = Math.max(c, t);
      if (score > bestScore) {
        bestScore = score;
        best = c >= t ? ',' : '\t';
      }
    }
    return best;
  }

  /** 支持引号包裹、字段内含逗号/换行 */
  function parseDelimited(text, delim) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;

    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows;
  }

  /* ------------------------------------------------------------------ *
   * 3. 表头定位与列映射
   * ------------------------------------------------------------------ */
  const HEADER_TOKENS = [
    '交易时间', '付款时间', '交易创建时间', '时间', '金额', '收/支', '收支',
    '交易对方', '对方', '商品名称', '商品', '当前状态', '交易状态', '状态',
    '支付方式', '付款方式', '交易类型', '类型', '交易单号', '商户单号',
    '商家订单号', '交易号', '备注', '资金状态', '交易来源地', '服务费',
    '成功退款', '消费类型', '手续费'
  ];

  /** 表头归一化：去 BOM、去空白、全角括号转半角 */
  function normHeader(s) {
    return String(s == null ? '' : s)
      .replace(/^\uFEFF/, '')
      .replace(/[\s\u00a0]+/g, '')
      .replace(/（/g, '(')
      .replace(/）/g, ')');
  }

  /** 归一化后的列别名表；顺序即优先级 */
  const COLUMN_ALIASES = {
    time:          ['付款时间', '交易时间', '交易创建时间', '时间'],
    amount:        ['金额(元)', '金额（元）', '金额', '发生金额', '交易金额'],
    dir:           ['收/支', '收支', '资金方向'],
    status:        ['当前状态', '交易状态', '状态', '订单状态'],
    method:        ['支付方式', '付款方式', '扣款方式', '资金方式', '账户'],
    txType:        ['交易类型', '类型', '交易类型说明'],
    counterparty:  ['交易对方', '对方', '交易方', '对方名称'],
    item:          ['商品名称', '商品', '商品说明'],
    refund:        ['成功退款(元)', '成功退款（元）', '成功退款', '退款金额(元)', '退款金额'],
    fee:           ['服务费(元)', '服务费（元）', '手续费(元)', '手续费', '服务费'],
    orderNo:       ['交易单号', '商户单号', '商家订单号', '支付宝交易号', '交易号', '订单号'],
    note:          ['备注', '备注说明', '说明'],
    fundState:     ['资金状态', '消费类型'],
    srcPlace:      ['交易来源地', '来源']
  };

  /** 全部"时间类"列，作为主时间列为空时的兜底 */
  const TIME_ALIASES = ['付款时间', '交易时间', '交易创建时间', '时间', '交易订单创建时间', '最近修改时间'];

  /**
   * 扫描前若干行找表头。
   * 判定：① 不能是数据行（含日期样式的单元格）② 至少命中 3 个表头特征词
   */
  function findHeader(rows, maxScan) {
    const limit = Math.min(rows.length, maxScan || 60);
    for (let i = 0; i < limit; i++) {
      const r = rows[i];
      if (!r || r.length < 3) continue;
      if (hasDateCell(r)) continue;
      let score = 0;
      const normalized = r.map(normHeader);
      for (const t of HEADER_TOKENS) {
        for (const cell of normalized) {
          if (cell === t || cell.includes(t)) { score++; break; }
        }
      }
      if (score >= 3 && hasHardToken(normalized)) return { index: i, cells: r };
    }
    return null;
  }

  /**
   * 表头必须含"时间 / 金额 / 收支"这类硬特征。
   * 否则像「交易类型：全部,备注：说明,导出类型：全部」这种说明行，
   * 命中三个特征词就会被当成表头 —— 而它没有金额列，
   * 结果是整份文件被拒，还报一句误导性的"表头里找不到金额列"。
   */
  function hasHardToken(normalized) {
    for (const cell of normalized) {
      if (cell.indexOf('金额') >= 0 || cell.indexOf('时间') >= 0 || cell.indexOf('日期') >= 0
        || cell.indexOf('收支') >= 0 || cell.indexOf('收/支') >= 0) return true;
    }
    return false;
  }

  function hasDateCell(row) {
    for (const c of row) {
      const s = String(c == null ? '' : c).trim();
      if (/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(s)) return true;
    }
    return false;
  }

  /**
   * 列映射：先全表头做精确匹配，再按别名顺序逐个认领未被占用的列。
   * @returns {{cols:Object, timeCols:number[]}}
   */
  function mapColumns(headerCells) {
    const norm = headerCells.map(normHeader);
    const used = new Array(norm.length).fill(false);
    const cols = {};

    for (const key of Object.keys(COLUMN_ALIASES)) {
      const aliases = COLUMN_ALIASES[key].map(normHeader);
      let hit = -1;
      for (const alias of aliases) {                 // 别名优先级
        for (let i = 0; i < norm.length; i++) {
          if (!used[i] && norm[i] === alias) { hit = i; break; }
        }
        if (hit >= 0) break;
      }
      if (hit < 0) {                                // 退一步用包含匹配
        for (const alias of aliases) {
          for (let i = 0; i < norm.length; i++) {
            if (!used[i] && alias.length >= 2 && norm[i].includes(alias)) { hit = i; break; }
          }
          if (hit >= 0) break;
        }
      }
      if (hit >= 0) { used[hit] = true; cols[key] = hit; }
    }

    const timeCols = [];
    for (const alias of TIME_ALIASES.map(normHeader)) {
      for (let i = 0; i < norm.length; i++) {
        if (norm[i] === alias) { timeCols.push(i); break; }
      }
    }
    if (cols.time != null && timeCols.indexOf(cols.time) < 0) timeCols.unshift(cols.time);

    return { cols, timeCols };
  }

  /* ------------------------------------------------------------------ *
   * 4. 值解析
   * ------------------------------------------------------------------ */
  function parseAmount(s) {
    if (s == null) return null;
    let t = String(s).trim();
    if (!t || t === '--' || t === '-') return null;
    t = t.replace(/[¥￥,，\s]/g, '').replace(/元$/, '').replace(/元/g, '');
    if (t.startsWith('+')) t = t.slice(1);
    const v = parseFloat(t);
    return isFinite(v) ? v : null;
  }

  /** 支持 2024-03-05 12:33:21 / 2024/3/5 / 2024年3月5日 / 紧凑 20240305123321 / ISO */
  function parseTime(s) {
    if (s == null) return null;
    const t = String(s).trim();
    if (!t) return null;

    let m = t.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[\sT]+(\d{1,2})[:：]?(\d{1,2})?(?:[:：]?(\d{1,2}))?)?/);
    if (!m) {
      m = t.match(/^(\d{4})(\d{2})(\d{2})[T ]?(\d{2})(\d{2})(\d{2})?/);
    }
    if (!m) return null;

    const y = +m[1], mo = +m[2], d = +m[3];
    const hh = m[4] != null ? +m[4] : 0;
    const mi = m[5] != null ? +m[5] : 0;
    const ss = m[6] != null ? +m[6] : 0;
    if (!(y >= 1990 && y <= 2100) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d, hh, mi, ss, 0);
    if (isNaN(dt.getTime())) return null;
    // 校验没有发生进位（防止 2024-02-31 这类被静默滚到 3 月）
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  function normDir(s) {
    const t = String(s == null ? '' : s).trim();
    // 空、'/'、'-' 这些写法在微信账单里很常见，意思是"不计收支"的中性流水。
    // 以前一律当成 unknown：这笔钱既不算收入也不算支出，余额链条在这里断一节，
    // 而且界面上一点提示都没有。现在按中性流水处理 —— 至少会进划转规则匹配，
    // 匹配不上也会在警告区被点名。
    if (!t || t === '/' || t === '／' || t === '-' || t === '—' || t === '无' || t === 'N/A') {
      return { dir: 'neutral', text: t };
    }
    if (/收入/.test(t)) return { dir: 'in', text: t };
    if (/支出/.test(t)) return { dir: 'out', text: t };
    if (/不计收支/.test(t)) return { dir: 'neutral', text: t };
    if (/其他/.test(t)) return { dir: 'neutral', text: t };
    if (/入/.test(t) && !/出/.test(t)) return { dir: 'in', text: t };
    if (/出/.test(t) && !/入/.test(t)) return { dir: 'out', text: t };
    return { dir: 'unknown', text: t };
  }

  /** 交易状态 → success / refunded / closed */
  function normState(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return { state: 'success', text: '' };
    if (/全额退款/.test(t)) return { state: 'refunded', full: true, text: t };
    if (/退款/.test(t)) return { state: 'refunded', full: false, text: t };
    if (/关闭|失败|撤销|取消|拒绝|作废/.test(t)) return { state: 'closed', text: t };
    if (/等待|冻结/.test(t)) return { state: 'pending', text: t };
    return { state: 'success', text: t };
  }

  /* ------------------------------------------------------------------ *
   * 5. 账单文件 → 交易数组
   * ------------------------------------------------------------------ */
  function detectSource(text, headerCells) {
    const head = text.slice(0, 3000);
    if (/微信支付|微信账单|wechat\s*pay/i.test(head)) return 'wechat';
    if (/支付宝|alipay/i.test(head)) return 'alipay';
    const h = headerCells.map(normHeader).join('|');
    if (/当前状态|交易单号|商户单号/.test(h)) return 'wechat';
    if (/支付宝交易号|交易来源地|资金状态|商家订单号/.test(h)) return 'alipay';
    return 'unknown';
  }

  /**
   * @param {string} text     账单全文
   * @param {string} fileName 文件名（用于日志）
   * @returns {{ok:boolean, source:string, encoding?:string, txs:Array, log:Array, error?:string}}
   */
  function parseBillText(text, fileName) {
    const log = [];
    const delim = detectDelimiter(text);
    const rows = parseDelimited(text, delim);
    if (!rows.length) return { ok: false, error: '文件为空或无法解析', txs: [], log };

    const header = findHeader(rows);
    if (!header) {
      return {
        ok: false,
        error: '未找到表头。这不是微信/支付宝「账单明细」格式？请导出"账单明细列表"而不是"账单概览"。',
        txs: [], log
      };
    }

    const source = detectSource(text, header.cells);
    const { cols, timeCols } = mapColumns(header.cells);
    if (cols.amount == null) {
      return { ok: false, error: '表头里找不到「金额」列，无法解析。', txs: [], log };
    }

    const txs = [];
    let skippedNoTime = 0;
    let skippedNoAmount = 0;
    let skippedFooter = 0;
    let repaired = 0;

    const N = header.cells.length;

    /* ---------------------------------------------------------------- *
     * 列错位修复
     *
     * 真实账单里偶尔会出现「字段里有逗号但没加引号」的行（多半是商品/对方名称里带了逗号）。
     * 这会让那个字段被劈成两半，后面的列整体错开一格，金额列就会读到「支出」这种非数字，
     * 整行被丢掉 —— 一笔都不要漏。
     *
     * 正确的模型不是"整行平移"，而是"多出来的字段落在第 s 位"：
     *   · 行比表头长（多一个字段）：第 s 列取前半截 row[s]，第 s 列之后取 row[c+1]
     *   · 行比表头短（少一个字段）：第 s 列没有对应值，第 s 列之后取 row[c-1]
     * 注意时间列通常在最前面，它多半**没有**被挪走——所以整行平移一定会把时间读错。
     *
     * 怎么定出 s：
     *   硬锚点 —— 时间能解析成日期、金额是数字、收/支是合法取值，三个都对上才算候选成立
     *   软打分 —— 这个文件里出现过的「交易类型/状态/支付方式/资金状态」取值构成一份词表，
     *             候选映射能把更多列落到词表里的取值上，就更可能是对的
     *   兜底   —— 打平了就取"错位格数最少"的那个（s 越大，被挪动的列越少）
     * ---------------------------------------------------------------- */
    const FREE_TEXT_HEADERS = ['交易对方', '对方', '交易方', '对方名称', '商品名称', '商品', '商品说明', '备注', '备注说明', '说明'];

    /** 切分点组合数上限：超过就放弃修复这一行（宁可丢，也别给一份整列错位的映射） */
    const MAX_COMBOS = 20000;

    function isFreeTextCol(idx) {
      const h = normHeader(header.cells[idx]);
      for (const f of FREE_TEXT_HEADERS) if (h.indexOf(f) >= 0) return true;
      return false;
    }

    // 从"整齐的行"里学一份分类取值词表（错位的行不参与学习，避免学脏）
    const vocab = { status: new Set(), txType: new Set(), method: new Set(), fundState: new Set() };
    for (let i = header.index + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length !== N) continue;
      for (const key of Object.keys(vocab)) {
        const c = cols[key];
        if (c == null) continue;
        const v = String(row[c] == null ? '' : row[c]).trim();
        if (v) vocab[key].add(v);
      }
    }

    function valAt(map, row, c) {
      if (c == null) return '';
      const idx = map(c);
      return (idx < 0 || idx >= row.length) ? '' : String(row[idx] == null ? '' : row[idx]).trim();
    }

    /** 候选映射是否讲得通：时间能解析、金额是数字、收/支合法 */
    function validateMap(map, row) {
      if (cols.amount == null) return false;
      if (parseAmount(valAt(map, row, cols.amount)) == null) return false;

      const tcols = cols.time != null
        ? [cols.time].concat(timeCols.filter(c => c !== cols.time))
        : timeCols;
      let timeOk = false;
      for (const c of tcols) {
        if (parseTime(valAt(map, row, c))) { timeOk = true; break; }
      }
      if (!timeOk) return false;

      if (cols.dir != null) {
        const d = normDir(valAt(map, row, cols.dir));
        if (d.dir === 'unknown') return false;
      }
      return true;
    }

    /**
     * 软打分：分类列落在词表里的命中数 + 切分点是否落在自由文本列。
     *
     * 自由文本列（商品/对方/备注）才可能含逗号 —— 金额、时间、状态、单号里不可能有。
     * 所以切分点落在非自由文本列上是个强信号：说明这个候选是错的。
     * 给它一个足够大的负分，让它直接出局（但不是硬过滤：万一表头名字不认识，
     * 也不能把所有候选都毙掉）。
     */
    function scoreMap(map, splits, row) {
      let s = 0;
      for (const key of ['status', 'txType', 'method', 'fundState']) {
        const c = cols[key];
        if (c == null) continue;
        const v = valAt(map, row, c);
        if (!v) continue;
        if (vocab[key] && vocab[key].has(v)) s += 2;
      }
      for (const sp of splits) s += isFreeTextCol(sp) ? 1 : -5;
      return s;
    }

    /** 切分点组合数 C(n+k-1, k)：k 个可重复的切分点 */
    function combosCount(n, k) {
      let r = 1;
      for (let i = 1; i <= k; i++) r = r * (n + k - i) / i;
      return r;
    }

    /**
     * 给这一行算一个"表头列 → 行内下标"的映射。
     * @returns {{map:Function, fixed:boolean}}
     */
    function alignMapping(row) {
      const L = row.length;
      const ident = (c) => c;
      if (L === N) return { map: ident, fixed: false };

      // 行比表头短：常见情况是末尾少一列，原样就对了，先原样试一次
      if (L < N && validateMap(ident, row)) return { map: ident, fixed: false };

      const right = L > N;
      const k = Math.abs(L - N);

      // 切分点可以重复！一个字段被劈成 "A,B,C,D" 这种 4 段时，
      // 多出来的 3 个格子全都落在同一列后面，必须允许 s1=s2=s3。
      // 组合数 C(N+k-1, k) 太大就放弃修复 —— 宁可丢这一行，
      // 也不能给出一份"看着能过锚点、其实整列都错位"的映射。
      if (combosCount(N, k) > MAX_COMBOS) return { map: ident, fixed: false };

      const combos = [];
      const cur = [];
      (function gen(start) {
        if (cur.length === k) { combos.push(cur.slice()); return; }
        for (let s = start; s < N; s++) { cur.push(s); gen(s); cur.pop(); }
      })(0);

      let best = null;
      for (const sp of combos) {
        const map = right
          ? (c) => c + sp.filter(x => c > x).length
          : (c) => c - sp.filter(x => c >= x).length;
        if (!validateMap(map, row)) continue;
        const sc = scoreMap(map, sp, row);
        // 严格大于：打平时保留先枚举到的那个，也就是切分点更小的那个
        // （切分点越小，"商品/对方"这类自由文本列越不容易被挪错位置）
        if (!best || sc > best.score) best = { map: map, score: sc };
      }
      if (best) return { map: best.map, fixed: true };
      return { map: ident, fixed: false };
    }

    /* ---------------------------------------------------------------- *
     * 退款行识别
     *
     * 同一个订单退了款，账单里有两种表现（两种版本都真实存在）：
     *   ① 原交易的状态变成「已全额退款 / 已退款」——退款信息标在原行上
     *   ② 另外多出一行「退款」——收/支 列可能是「收入」，也可能是「不计收支」
     *
     * 早先只认「收入」那一种（靠 dir === 'in' 判断）。碰上「不计收支」的退款文件时：
     *   · 退款行没被认出来 → 文件被当成"退款标在原行上" → 可原行没标退款 → 支出照全额算
     *   · 退款行又是"不计收支" → 匹配不到任何划转规则 → 这笔钱根本没冲回来
     * 结果就是"退了一笔，账上却还多支出一次"，余额直接算错。
     *
     * 所以改成：只要「交易类型」本身就是退款这一类，就算退款行 —— 跟收/支 列写什么无关。
     * ---------------------------------------------------------------- */
    const REFUND_TYPE_RE = /^(退款|退货退款|部分退款|退款成功|退回|返款)/;

    function isRefundRow(t) {
      const type = String(t.txType == null ? '' : t.txType).trim();
      if (REFUND_TYPE_RE.test(type)) return true;
      if (t.dir === 'in') {
        const blob = [t.txType, t.item, t.counterparty, t.note, t.fundState].join(' ');
        if (/退款|退回|返还|返还款/.test(blob)) return true;
      }
      return false;
    }

    for (let i = header.index + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;

      const nonEmpty = row.filter(c => String(c == null ? '' : c).trim() !== '').length;
      if (nonEmpty === 0) continue;

      // 页脚/结束标记：如 "------交易记录明细列表结束------" / "共 42 笔记录"
      const firstCell = String(row[0] == null ? '' : row[0]).trim();
      if (/^-+/.test(firstCell) || /^共\s*\d+\s*笔/.test(firstCell) || /^导出类型/.test(firstCell)) {
        skippedFooter++; continue;
      }

      const align = alignMapping(row);
      if (align.fixed) repaired++;
      const map = align.map;
      const get = (key) => {
        const c = cols[key];
        if (c == null) return '';
        return valAt(map, row, c);
      };

      // 时间：主时间列为空时依次尝试其它时间列
      let time = null;
      let timeText = '';
      const candidateCols = cols.time != null ? [cols.time].concat(timeCols.filter(c => c !== cols.time)) : timeCols;
      for (const c of candidateCols) {
        const raw = valAt(map, row, c);
        if (!raw) continue;
        const dt = parseTime(raw);
        if (dt) { time = dt; timeText = raw; break; }
      }
      if (!time) { skippedNoTime++; continue; }

      const amount = parseAmount(get('amount'));
      if (amount == null) { skippedNoAmount++; continue; }

      const d = cols.dir == null ? { dir: 'unknown', text: '' } : normDir(get('dir'));
      const st = normState(get('status'));

      const tx = {
        src: source,
        file: fileName,
        seq: txs.length,
        time: time.getTime(),
        timeText: timeText,
        dir: d.dir,
        dirText: d.text,
        amount: amount,
        txType: get('txType'),
        counterparty: get('counterparty'),
        item: get('item'),
        status: st.text,
        state: st.state,
        stateFullRefund: !!st.full,
        method: get('method'),
        refundCol: parseAmount(get('refund')),
        fee: parseAmount(get('fee')) || 0,
        orderNo: get('orderNo'),
        note: get('note'),
        fundState: get('fundState'),
        srcPlace: get('srcPlace')
      };
      tx.isRefundRow = isRefundRow(tx);
      txs.push(tx);
    }

    if (repaired) log.push('自动修复了 ' + repaired + ' 行列错位（字段里有未转义的逗号）');
    if (skippedNoTime) log.push('跳过 ' + skippedNoTime + ' 行：时间无法解析');
    if (skippedNoAmount) log.push('跳过 ' + skippedNoAmount + ' 行：金额为空或无法解析');
    if (skippedFooter) log.push('忽略 ' + skippedFooter + ' 行页脚/结束标记');

    // 方向没识别出来的行：这些钱既没算收入也没算支出，必须让用户看见
    const unknownDir = txs.filter(t => t.dir === 'unknown').length;
    const noDirColumn = cols.dir == null;

    const stats = {
      totalRows: rows.length - header.index - 1,   // 表头之后的所有行
      parsed: txs.length,
      skipped: skippedNoTime + skippedNoAmount,
      skippedNoTime: skippedNoTime,
      skippedNoAmount: skippedNoAmount,
      skippedFooter: skippedFooter,
      repaired: repaired,
      unknownDir: unknownDir,
      noDirColumn: noDirColumn
    };
    if (noDirColumn) log.push('这份账单里没有「收/支」列，无法判断收入支出方向，全部流水都没参与余额计算');
    else if (unknownDir) log.push('有 ' + unknownDir + ' 行没能判断出收支方向，这些行不参与余额计算');

    // 退款形态探测：账单里是否单独存在一笔"退款"行
    // （判断依据是"交易类型=退款"，不再依赖收/支 列写的是「收入」还是「不计收支」）
    let hasSeparateRefundRow = false;
    for (const t of txs) {
      if (t.isRefundRow) { hasSeparateRefundRow = true; break; }
    }

    return {
      ok: true,
      source: source,
      headerRow: header.index,
      headerCells: header.cells,
      txs: txs,
      hasSeparateRefundRow: hasSeparateRefundRow,
      stats: stats,
      log: log
    };
  }

  /* ------------------------------------------------------------------ *
   * 6. 文件指纹（识别"同一个文件被导入了两次"）
   * ------------------------------------------------------------------ */
  /** FNV-1a 32 位哈希 + 字节长度，够用且不需要 crypto（file:// 下也不一定可用） */
  function hashBytes(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0') + '-' + bytes.length.toString(16);
  }

  /** File → 解析结果（浏览器入口） */
  function parseBillFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve({ ok: false, error: '读取文件失败', txs: [], log: [] });
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result);
        const dec = decodeBuffer(reader.result);
        const res = parseBillText(dec.text, file.name);
        res.encoding = dec.encoding;
        res.hash = hashBytes(bytes);
        res.size = bytes.length;
        resolve(res);
      };
      reader.readAsArrayBuffer(file);
    });
  }

  return {
    decodeBuffer,
    detectDelimiter,
    parseDelimited,
    findHeader,
    mapColumns,
    parseAmount,
    parseTime,
    normDir,
    normState,
    parseBillText,
    parseBillFile,
    hashBytes
  };
})();
