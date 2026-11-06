/* =========================================================================
 * calc.js —— 交易归一化 + 余额反推 + 分组汇总
 *
 * 核心思想（余额反推）：
 *   用户只知道"现在还剩多少钱"（基准余额），
 *   于是从最后一笔交易往前倒推：
 *       交易前余额 = 交易后余额 - 该笔的资金变动
 *   收入 → 往前推时余额变少；支出 → 往前推时余额变多。
 *   内部划转（不计收支）在"账户口径"下落到具体账户，在"合计口径"下自动抵消。
 * ========================================================================= */
window.LedgerCalc = (function () {
  'use strict';

  const R = window.LedgerRules;
  const SOURCE_LABEL = { wechat: '微信', alipay: '支付宝', manual: '手记', unknown: '未知' };

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */
  /**
   * 往一个"账户 → 金额"的表里累加。
   *
   * 两个坑：
   *  1) map 必须是 null 原型对象。用普通 {} 时，账户名如果是 "constructor"，
   *     map['constructor'] 读到的是 Object 构造函数（真值），(map[key] || 0) + val
   *     会变成字符串拼接，余额链条整条变成 NaN。账户名可以由用户手填
   *     （手动记账的账户、规则面板里的账户），所以这个必须防住。
   *  2) 累加前要确认原值是数字，别把上一轮的字符串污染继续传下去。
   */
  function addTo(map, key, val) {
    if (!key || typeof val !== 'number' || !isFinite(val)) return;
    const cur = map[key];
    map[key] = (typeof cur === 'number' && isFinite(cur) ? cur : 0) + val;
  }

  /** 按分取整，消掉浮点累加误差（余额必须精确到分） */
  function round2(n) {
    if (n == null || !isFinite(n)) return n;
    return Math.round(n * 100) / 100;
  }

  /** HTML 转义：警告文案会插进 innerHTML，而里面带着账单里的商家名 */
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmt(n) {
    if (n == null || !isFinite(n)) return '';
    const neg = n < 0;
    const s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + s;
  }

  /**
   * 基准余额可能是字符串（手工改过的备份 JSON），统一转成数字。
   * 以前直接 `mergedBase + v`，v 是字符串时会变成字符串拼接：
   * 50 + '100' → '50100'，合计口径整体崩坏。
   */
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return isFinite(n) ? n : NaN; }
    return NaN;
  }

  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function ym(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
  function ymdhm(d) {
    return ymd(d) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function minutesOf(d) { return Math.floor(d.getTime() / 60000); }

  /* ------------------------------------------------------------------ *
   * 1. 归一化：把原始行变成"可用于计算"的交易
   * ------------------------------------------------------------------ */
  /**
   * 退款口径：
   *   'raw' —— 退款单列一行（原额计入 + 退款行入账冲回）
   *   'net' —— 退款标在原行上（按净额算）
   *
   * fileHasRefundRow 是从数据本身扫出来的「哪些文件里有独立的退款行」，
   * 用来在缺文件信息时（老备份 / 手工改过的备份）也能推断出正确口径。
   * 以前这里找不到 fileInfo 就一律返回 'raw'，于是"退款标在原行上"的账单里，
   * 退款永远冲不回来，余额直接少一笔。
   */
  function refundModeOf(tx, fileInfo, override, fileHasRefundRow) {
    if (override === 'raw' || override === 'net') return override;
    const info = fileInfo[tx.file];
    if (info && info.hasSeparateRefundRow != null) {
      return info.hasSeparateRefundRow ? 'raw' : 'net';
    }
    return (fileHasRefundRow && fileHasRefundRow.has(tx.file)) ? 'raw' : 'net';
  }

  /**
   * @param {Array} txs       原始交易
   * @param {Object} settings {rules, fileInfo, excluded:Set, includeClosed}
   * @returns {Array} 归一化交易
   */
  function prepare(txs, settings) {
    const internalRules = (settings.rules && settings.rules.internal) || R.DEFAULT_INTERNAL_RULES;
    const categoryRules = (settings.rules && settings.rules.category) || R.DEFAULT_CATEGORY_RULES;
    const fileInfo = settings.fileInfo || {};
    const excluded = settings.excluded || new Set();

    // 哪些文件里有"独立的退款行"（从数据本身扫，缺文件信息时用来推断退款口径）
    const fileHasRefundRow = new Set();
    for (const t of txs) if (t && t.isRefundRow) fileHasRefundRow.add(t.file);

    return txs.map((t, i) => {
      const o = {
        id: t.id || (t.file + '#' + t.seq),
        src: t.src,
        file: t.file,
        seq: t.seq,
        time: t.time,
        dir: t.dir,
        dirText: t.dirText,
        amount: t.amount,
        counterparty: t.counterparty,
        item: t.item,
        txType: t.txType,
        status: t.status,
        state: t.state,
        method: t.method,
        note: t.note,
        fundState: t.fundState,
        orderNo: t.orderNo,
        fee: t.fee,
        flags: []
      };

      // 用户手动排除
      o.userExcluded = excluded.has(o.id);
      // 交易关闭 / 失败：钱并未真的付出，默认不计入
      if (t.state === 'closed') {
        o.skip = true;
        o.flags.push('交易关闭/失败，不计');
      }
      if (o.userExcluded) {
        o.skip = true;
        o.flags.push('用户排除');
      }
      if (t.state === 'pending') o.flags.push('状态待确认');

      // 金额不是有效数字的行（脏数据/手工改坏的数据）：整行不参与计算，
      // 否则后面所有求和都会变成 NaN。
      // 注意：isFinite(null) 是 true（Number(null)=0），必须先判类型。
      if (typeof t.amount !== 'number' || !isFinite(t.amount)) {
        o.skip = true;
        o.flags.push('金额异常，不计');
      }

      // 账单里偶尔出现负数金额（有些导出用符号表示方向）。
      // 收支方向由「收/支」列决定，金额取绝对值 —— 否则一笔 128.50 的支出
      // 会变成 +128.50，余额不降反升。
      if (typeof t.amount === 'number' && isFinite(t.amount) && t.amount < 0) {
        o.amount = -t.amount;
        o.flags.push('账单金额为负（' + fmt(t.amount) + '），已按绝对值 ' + fmt(o.amount) + ' 计入');
      }

      // ---- 退款净额 ----
      const mode = refundModeOf(t, fileInfo, settings.refundMode && settings.refundMode[t.file], fileHasRefundRow);
      o.refundMode = mode;
      o.isRefundRow = !!t.isRefundRow;
      o.netAmount = (typeof o.amount === 'number' && isFinite(o.amount)) ? o.amount : 0;

      // 支付宝的「服务费」是实际多扣的钱（如信用卡还款手续费），要算进支出
      o.feeCharged = 0;
      if (t.dir === 'out' && t.fee && t.fee > 0) {
        o.feeCharged = t.fee;
        o.netAmount = round2(o.amount + t.fee);
        o.flags.push('含服务费 ' + fmt(t.fee));
      }

      // 「退款行」在不同版本的账单里，收/支 列可能写「收入」，也可能写「不计收支」。
      // 在"退款单列一行"的口径下，这一行就是把原支出冲回来的钱，必须入账；
      // 要是照着「不计收支」丢进划转规则里匹配，钱就永远回不来 —— 账上会多支出一次。
      if (mode === 'raw' && o.isRefundRow && (t.dir === 'neutral' || t.dir === 'unknown')) {
        o.dir = 'in';
        o.dirText = '退款收入';
        o.flags.push('退款入账（原账单标为不计收支）');
      }

      if (mode === 'net' && o.isRefundRow) {
        // 「按状态净额」口径 = 退款标在原行上。这份账单里另外还有一行退款，
        // 那是同一个事件在账单里的重复信息，不该再单独算一笔收入。
        o.netAmount = 0;
        o.flags.push('退款行（当前按「状态净额」口径，不单独计收入）');
      } else if (mode === 'net' && (t.state === 'refunded' || (t.refundCol != null && t.refundCol > 0))) {
        if (t.refundCol != null && t.refundCol > 0) {
          o.netAmount = Math.max(0, round2(o.netAmount - t.refundCol));
          o.refundAmount = t.refundCol;
          o.flags.push('已退款 ' + fmt(t.refundCol) + '，净额 ' + fmt(o.netAmount));
        } else if (t.stateFullRefund) {
          o.netAmount = 0;
          o.refundAmount = o.amount;
          o.flags.push('已全额退款，净额 0');
        } else if (t.src === 'alipay') {
          // 支付宝的「已退款 / 交易成功但对方已退款」= 对方已把钱退回来，是全额退回
          o.netAmount = 0;
          o.refundAmount = o.amount;
          o.flags.push('对方已全额退款，净额 0');
        } else {
          o.netAmount = o.netAmount;
          o.flags.push('部分退款金额未知，仍按全额计');
        }
      } else if (mode === 'raw' && t.state === 'refunded') {
        o.flags.push(o.isRefundRow ? '退款行，按退款额入账' : '已退款（退款行已单列，本行按原额计）');
      }

      // ---- 账户归属 ----
      let account;
      if (t.src === 'wechat') {
        account = t.method ? '微信·' + t.method.trim() : '微信·未标注渠道';
      } else if (t.src === 'alipay') {
        account = t.method ? '支付宝·' + t.method.trim() : '支付宝';
      } else {
        account = t.method ? t.method.trim() : '未标注渠道';
      }
      o.account = account;

      // ---- 内部划转识别 ----
      o.kind = 'normal';
      if (o.dir === 'neutral' || o.dir === 'unknown') {
        const hit = R.matchInternalRule(t, internalRules);
        if (hit) {
          const rule = hit.rule;
          const acc = R.resolveAccountName(rule.account, t) || account;
          let counter = R.resolveAccountName(rule.counter, t);
          // 对向账户和目标账户是同一个 → 这笔是"自己转给自己"。
          // 如果还按 dir 单边入账，就等于凭空多出一笔钱：反推余额会整条偏掉，
          // 账户口径和合计口径同时被污染，而界面上一点提示都没有。
          // 这种行按净额零处理，并在明细里标出来让人自己判断。
          let selfTransfer = false;
          if (counter && counter === acc) { selfTransfer = true; counter = null; }
          o.kind = 'internal';
          o.internalAccount = acc;
          o.internalDir = rule.dir;
          o.internalCounter = counter;
          o.selfTransfer = selfTransfer;
          o.account = acc;
          o.ruleNote = rule.note || '';
          o.flags.push('内部划转：' + (rule.note || acc));
          if (selfTransfer) {
            o.flags.push('对向账户与目标账户相同，按净额零处理（不计入余额）');
          }
        } else if (o.dir === 'unknown') {
          o.kind = 'unknown';
          o.flags.push('收支方向无法识别');
        } else {
          o.kind = 'unknown';
          o.flags.push('不计收支但未匹配到划转规则，余额不变');
        }
      }

      // ---- 分类 ----
      if (o.kind === 'internal') o.category = '内部划转';
      else if (o.kind === 'unknown') o.category = '未分类';
      else if (t.src === 'manual' && t.txType) {
        // 手动记录：用户自己填了分类就直接用，不该被关键词表改掉
        o.category = t.txType;
        o.manualCategory = true;
      } else o.category = R.matchCategory(t, categoryRules);

      // ---- 显示用摘要 ----
      o.title = [o.counterparty, o.item].filter(Boolean).join(' / ') || o.txType || o.orderNo || '-';

      return o;
    });
  }

  /* ------------------------------------------------------------------ *
   * 2. 单笔交易的资金变动（按账户拆分）
   * ------------------------------------------------------------------ */
  function txDeltas(t) {
    // null 原型：账户名是用户可填的文本，"constructor"/"__proto__" 这类名字
    // 在普通对象上会撞到原型链，导致余额变成 NaN 或整条记录丢失。
    const d = Object.create(null);
    if (t.skip) return d;
    if (t.dir === 'in') { addTo(d, t.account, t.netAmount); return d; }
    if (t.dir === 'out') { addTo(d, t.account, -t.netAmount); return d; }
    if (t.kind === 'internal') {
      // 自己转给自己：对向账户就是自己，净额为零，不参与余额计算
      if (t.selfTransfer) return d;
      const sign = t.internalDir === 'in' ? 1 : -1;
      // 用 netAmount 而不是 amount：划转本身也可能带退款，净额才是真正动了多少钱
      addTo(d, t.internalAccount, sign * t.netAmount);
      if (t.internalCounter) addTo(d, t.internalCounter, -sign * t.netAmount);
    }
    return d;
  }

  function txTotalDelta(t) {
    const d = txDeltas(t);
    let sum = 0;
    for (const k of Object.keys(d)) sum += d[k];
    return sum;
  }

  /* ------------------------------------------------------------------ *
   * 3. 余额反推
   * ------------------------------------------------------------------ */
  /**
   * @param {Array} txs       归一化后的交易（按时间升序）
   * @param {Object} bases    {账户名: 基准余额}
   * @returns {{balances:Map, accounts:Array, mergedBase:number, warnings:Array}}
   *
   * balances 结构： Map<交易id, {byAccount:{账户:{before,after}}, primary:{before,after,account}}>
   * 一笔内部划转可能同时影响两个账户（例如 零钱充值：零钱 +200、付款银行卡 -200），
   * 所以余额必须按「交易 × 账户」存，不能按交易 id 存一份。
   */
  function computeBalances(txs, bases) {
    const warnings = [];

    // 交易 id → 交易 的查表。
    // 以前这里用 txs.find() 在循环里线性查找，5 万笔就是 25 亿次比较（23 秒），
    // 换成 Map 查表后同一份数据 82 毫秒。
    const txById = new Map();
    for (const t of txs) txById.set(t.id, t);

    // 3.1 按账户收集变动
    const perAccount = new Map();   // acct -> [{t, delta}]
    const mergedEntries = [];       // [{t, delta}]
    for (const t of txs) {
      const d = txDeltas(t);
      for (const acct of Object.keys(d)) {
        if (!perAccount.has(acct)) perAccount.set(acct, []);
        perAccount.get(acct).push({ t: t, delta: d[acct] });
      }
      mergedEntries.push({ t: t, delta: txTotalDelta(t) });
    }

    // 3.2 每个账户单独倒推
    const accounts = [];
    const balances = new Map();    // tx.id -> {byAccount, primary}
    let mergedBase = 0;
    let anyBase = false;

    // 合计基准 = 所有填了余额的账户之和，跟"这个区间里有没有流水"无关。
    // 以前只统计出现过流水的账户，导致「合计基准余额」会随筛选条件忽大忽小。
    // 用 Object.keys 而不是 for...in：for...in 会把原型链上的属性也算进来。
    for (const acct of Object.keys(bases || {})) {
      const v = toNum(bases[acct]);
      if (isFinite(v)) { mergedBase = round2(mergedBase + v); anyBase = true; }
    }

    // 基准余额是负数：要么是信用卡欠款，要么是填错了。
    // 之前的负余额警告只看"交易前余额"，基准本身就是负数时反而一声不吭。
    for (const acct of Object.keys(bases || {})) {
      const v = toNum(bases[acct]);
      if (isFinite(v) && v < 0) {
        warnings.push({
          level: 'warn',
          text: '账户「' + escHtml(acct) + '」的基准余额是负数（' + fmt(v) + ' 元）。' +
            '如果这是信用卡欠款可以忽略；如果不是，多半是余额填错了。'
        });
      }
    }

    const seenAcct = new Set();
    for (const [acct, entries] of perAccount) {
      const baseNum = bases ? toNum(bases[acct]) : NaN;
      const base = isFinite(baseNum) ? baseNum : null;
      accounts.push({ account: acct, count: entries.length, base: base, known: base != null });
      seenAcct.add(acct);

      if (base == null) continue;
      let after = round2(base);
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const before = round2(after - e.delta);
        let rec = balances.get(e.t.id);
        // byAccount 也用 null 原型：账户名可能叫 "constructor"，普通对象会撞原型链
        if (!rec) { rec = { byAccount: Object.create(null) }; balances.set(e.t.id, rec); }
        rec.byAccount[acct] = { before: before, after: after };
        after = before;
      }
    }
    // 有基准余额、但这个区间里没有任何流水的账户：也要列出来（0 笔），
    // 否则用户填的钱会"凭空消失"，而且没法在界面上改回来。
    for (const acct of Object.keys(bases || {})) {
      if (seenAcct.has(acct)) continue;
      const v = toNum(bases[acct]);
      const base = isFinite(v) ? v : null;
      accounts.push({ account: acct, count: 0, base: base, known: base != null });
    }
    accounts.sort((a, b) => (b.base || 0) - (a.base || 0) || a.account.localeCompare(b.account, 'zh'));

    // 3.2b 选定"主账户"余额（这笔交易自己的账户），供表格展示
    for (const [id, rec] of balances) {
      const tx = txById.get(id);
      const own = tx && rec.byAccount[tx.account];
      const fallback = own || rec.byAccount[Object.keys(rec.byAccount)[0]];
      rec.primary = fallback
        ? { before: fallback.before, after: fallback.after, account: tx ? tx.account : '' }
        : null;
    }

    // 3.3 合计口径倒推
    const merged = new Map();      // tx.id -> {before, after}
    if (anyBase) {
      let after = mergedBase;
      for (let i = mergedEntries.length - 1; i >= 0; i--) {
        const e = mergedEntries[i];
        const before = round2(after - e.delta);
        merged.set(e.t.id, { before: before, after: after });
        after = before;
      }
    }

    // 3.4 校验
    for (const [id, rec] of balances) {
      const b = rec.primary;
      if (b && b.before < -0.005) {
        const t = txById.get(id);
        warnings.push({
          level: 'warn',
          text: '余额出现负数：' + escHtml(t ? t.title : id) + ' 交易前余额 ' + fmt(b.before) + ' 元。可能缺少更早的收入流水，或基准余额填大了。'
        });
        break;
      }
    }
    if (merged.size) {
      for (const [, b] of merged) {
        if (b.before < -0.005) {
          warnings.push({ level: 'warn', text: '合计口径出现负余额，通常意味着漏记了收入或基准余额有误。' });
          break;
        }
      }
    }

    return { balances: balances, merged: merged, accounts: accounts, mergedBase: mergedBase, warnings: warnings };
  }

  /* ------------------------------------------------------------------ *
   * 4. 分组汇总
   * ------------------------------------------------------------------ */
  function groupKeyOf(ts, groupBy) {
    const d = new Date(ts.time);
    if (groupBy === 'day') return ymd(d);
    if (groupBy === 'month') return ym(d);
    if (groupBy === 'week') {
      const tmp = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const day = (tmp.getDay() + 6) % 7;             // 周一为一周之始
      tmp.setDate(tmp.getDate() - day);
      return ymd(tmp) + ' 起一周';
    }
    return String(d.getFullYear());
  }

  function groupLabel(key, groupBy) {
    if (groupBy === 'day') return key;
    if (groupBy === 'month') return key.replace('-', ' 年 ') + ' 月';
    if (groupBy === 'week') return key;
    return key + ' 年';
  }

  /**
   * @returns {Array} 每组：key,label,income,expense,net,count,begin,end
   */
  function summarize(txs, groupBy, balResult) {
    const map = new Map();
    const sorted = txs.slice().sort((a, b) => a.time - b.time);

    for (const t of sorted) {
      const key = groupKeyOf(t, groupBy);
      if (!map.has(key)) {
        map.set(key, { key: key, label: groupLabel(key, groupBy), income: 0, expense: 0, net: 0, count: 0, txs: [] });
      }
      const g = map.get(key);
      if (!t.skip) {
        // 按分取整累加：0.1 累加 30 次会得到 3.0000000000000013，
        // 显示层虽然会 toFixed 掩盖掉，但导出/汇总拿到的是脏数字
        if (t.dir === 'in') g.income = round2(g.income + t.netAmount);
        else if (t.dir === 'out') g.expense = round2(g.expense + t.netAmount);
        g.count++;
      }
      g.txs.push(t);
    }

    // 期初/期末余额：合计口径
    for (const g of map.values()) {
      let first = null, last = null;
      for (const t of g.txs) {
        const b = balResult.merged.get(t.id);
        if (!b) continue;
        if (!first) first = b;
        last = b;
      }
      g.begin = first ? first.before : null;
      g.end = last ? last.after : null;
    }

    const out = Array.from(map.values());
    for (const g of out) { g.net = round2(g.income - g.expense); delete g.txs; }
    out.sort((a, b) => (a.key < b.key ? 1 : -1));   // 最新的在前
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 5. 重复检测
   * ------------------------------------------------------------------ */

  /** 跨平台疑似重复：同额、一收一支、时间接近。窗口按"时间距离"判断，不是分桶。 */
  const DUP_WINDOW_MIN = 10;

  function findDuplicates(txs, windowMin) {
    const win = (windowMin == null ? DUP_WINDOW_MIN : windowMin) * 60000;
    const buckets = new Map();
    for (const t of txs) {
      if (t.skip) continue;
      if (t.dir !== 'in' && t.dir !== 'out') continue;
      if (typeof t.amount !== 'number' || !isFinite(t.amount)) continue;   // 金额异常的行直接跳过，别让整页崩掉
      const key = t.amount.toFixed(2);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    }
    const dups = [];
    for (const [, arr] of buckets) {
      arr.sort((a, b) => a.time - b.time);
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (arr[j].time - arr[i].time > win) break;   // 已排序，后面只会更远
          const a = arr[i], b = arr[j];
          if (a.src === b.src) continue;
          if (a.dir === b.dir) continue;
          dups.push({ a: a, b: b, gap: Math.round((b.time - a.time) / 60000) });
        }
      }
    }
    return dups;
  }

  /** 完全重复：同来源、同时间、同金额、同单号 —— 通常是同一个文件被导入了两次 */
  function findExactDuplicates(txs) {
    const seen = new Map();
    const dups = [];
    for (const t of txs) {
      if (t.skip) continue;
      if (typeof t.amount !== 'number' || !isFinite(t.amount)) continue;
      const key = [t.src, t.time, t.amount.toFixed(2), t.orderNo || ('#' + t.id)].join('|');
      if (seen.has(key)) dups.push({ a: seen.get(key), b: t });
      else seen.set(key, t);
    }
    return dups;
  }

  /* ------------------------------------------------------------------ *
   * 6. 导出用的行构建（纯函数，方便单测）
   * ------------------------------------------------------------------ */
  function buildDetailRows(list, bal) {
    const rows = [['时间', '来源', '账户', '分类', '收支', '对方', '商品', '金额(元)', '净额(元)',
      '账户余额(前)', '账户余额(后)', '合计余额(前)', '合计余额(后)', '交易类型', '状态', '备注', '交易单号']];
    const num2 = (v) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(2) : '0.00';
    for (const t of list) {
      const rec = bal.balances.get(t.id);
      const acc = rec ? rec.primary : null;
      const mg = bal.merged.get(t.id);
      rows.push([
        new Date(t.time).toLocaleString('zh-CN'),
        SOURCE_LABEL[t.src] || t.src,
        t.account, t.category, t.dirText || t.dir,
        t.counterparty, t.item,
        num2(t.amount), num2(t.netAmount),
        acc ? num2(acc.before) : '', acc ? num2(acc.after) : '',
        mg ? num2(mg.before) : '', mg ? num2(mg.after) : '',
        t.txType, t.status, t.note, t.orderNo
      ]);
    }
    return rows;
  }

  function buildSummaryRows(list, groupBy, bal) {
    const rows = [['期间', '笔数', '收入(元)', '支出(元)', '净额(元)', '期初余额(合计)', '期末余额(合计)']];
    for (const r of summarize(list, groupBy, bal)) {
      rows.push([r.label, r.count, r.income.toFixed(2), r.expense.toFixed(2), r.net.toFixed(2),
        r.begin == null ? '' : r.begin.toFixed(2), r.end == null ? '' : r.end.toFixed(2)]);
    }
    return rows;
  }

  return {
    prepare,
    txDeltas,
    txTotalDelta,
    computeBalances,
    summarize,
    groupKeyOf,
    groupLabel,
    findDuplicates,
    findExactDuplicates,
    buildDetailRows,
    buildSummaryRows,
    round2,
    fmt,
    ymd,
    ym,
    ymdhm
  };
})();
