/* =========================================================================
 * health.js —— 账本体检
 *
 * 目的：用户导入完账单后，最怕的不是"表格不好看"，而是
 *   ① 账单中间缺了一个月（导出一段、漏一段），余额反推就全错了
 *   ② 同一个文件导了两遍，收入被算两次
 *   ③ 某笔"不计收支"没匹配到划转规则，余额链条悄悄断了一环
 *   ④ 部分退款查不到金额，支出被多算了
 * 这些问题在原始表格里看不出来，只有体检能提前喊出来。
 *
 * 全部是纯函数：不碰 DOM、不读全局状态，方便在 Node 里做断言。
 * ========================================================================= */
window.LedgerHealth = (function () {
  'use strict';

  const C = window.LedgerCalc;

  function pct(n, total) {
    if (!total) return 0;
    return (n / total) * 100;
  }

  function fmt(n) {
    return C.fmt(n);
  }

  /* ------------------------------------------------------------------ *
   * 1. 账单月份连续性
   * ------------------------------------------------------------------ */
  function checkMonths(txs) {
    const map = new Map();
    let minT = Infinity, maxT = -Infinity;
    for (const t of txs || []) {
      if (t.skip) continue;
      const d = new Date(t.time);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      map.set(k, (map.get(k) || 0) + 1);
      if (t.time < minT) minT = t.time;
      if (t.time > maxT) maxT = t.time;
    }
    const keys = Array.from(map.keys()).sort();
    if (!keys.length) {
      return { id: 'months', level: 'info', title: '账单月份连续性', summary: '暂无数据', details: [] };
    }

    const missing = [];
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1].split('-').map(Number);
      const b = keys[i].split('-').map(Number);
      const s = a[0] * 12 + (a[1] - 1);
      const e = b[0] * 12 + (b[1] - 1);
      for (let k = s + 1; k < e; k++) {
        missing.push(Math.floor(k / 12) + ' 年 ' + (k % 12 + 1) + ' 月');
      }
    }

    const details = [];
    details.push('覆盖 ' + keys.length + ' 个月：' + keys[0] + ' ~ ' + keys[keys.length - 1] +
      '（' + C.ymd(new Date(minT)) + ' 至 ' + C.ymd(new Date(maxT)) + '）');

    if (missing.length) {
      details.push('中间缺 ' + missing.length + ' 个月：' + missing.join('、'));
      return {
        id: 'months', level: 'warn', title: '账单月份连续性',
        summary: '缺 ' + missing.length + ' 个月的账单',
        details: details
      };
    }
    return { id: 'months', level: 'ok', title: '账单月份连续性', summary: keys.length + ' 个月连续无缺口', details: details };
  }

  /* ------------------------------------------------------------------ *
   * * 2. 重复记账
   * ------------------------------------------------------------------ */
  function checkDuplicates(prepared, scoped, files) {
    const details = [];
    let level = 'ok';
    let summary = '没有发现重复';

    // 2a. 同一个文件被导入了两次（内容哈希一致）
    const byHash = new Map();
    for (const key in (files || {})) {
      const f = files[key];
      if (!f || f.error || !f.hash) continue;
      if (!byHash.has(f.hash)) byHash.set(f.hash, []);
      byHash.get(f.hash).push(f);
    }
    let dupFiles = 0;
    for (const [, arr] of byHash) {
      if (arr.length > 1) {
        dupFiles += arr.length - 1;
        details.push('「' + arr[0].name + '」被导入了 ' + arr.length + ' 次（内容完全一致，共 ' +
          arr.reduce((s, f) => s + (f.count || 0), 0) + ' 笔）');
      }
    }
    if (dupFiles) { level = 'err'; summary = dupFiles + ' 个文件重复导入'; }

    // 2b. 跨平台同笔（金额相同、时间接近、一收一支）
    const cross = C.findDuplicates(scoped || []);
    if (cross.length) {
      details.push('跨平台疑似同一笔 ' + cross.length + ' 组（金额相同、时间在 10 分钟内、一收一支）');
      const d = cross[0];
      details.push('例如：「' + labelOf(d.a) + '」' + (d.a.src === 'wechat' ? '微信' : '支付宝') +
        ' ↔ 「' + labelOf(d.b) + '」' + (d.b.src === 'wechat' ? '微信' : '支付宝') +
        '（相差 ' + d.gap + ' 分钟）');
      if (level !== 'err') level = 'warn';
      if (summary === '没有发现重复') summary = cross.length + ' 组跨平台疑似重复';
    }

    // 2c. 同源同单号同金额的完全重复（同一文件导两次的兜底）
    const exact = C.findExactDuplicates(prepared || []);
    if (exact.length && !dupFiles) {
      details.push('完全相同的交易记录 ' + exact.length + ' 笔（同来源、同时间、同金额、同单号）');
      if (level === 'ok') level = 'warn';
      if (summary === '没有发现重复') summary = exact.length + ' 笔完全重复';
    }

    return { id: 'dups', level: level, title: '重复记账检查', summary: summary, details: details };
  }

  /* ------------------------------------------------------------------ *
   * 3. 余额链自洽
   * ------------------------------------------------------------------ */
  function checkChain(scoped, bal) {
    const details = [];
    let level = 'ok';
    let summary = '余额链条自洽';

    if (!bal) {
      return { id: 'chain', level: 'info', title: '余额链自洽性', summary: '尚未计算', details: [] };
    }

    // 3a. 负余额
    let negCount = 0, worst = null;
    for (const [id, rec] of bal.balances) {
      const b = rec.primary;
      if (b && b.before < -0.005) {
        negCount++;
        if (!worst || b.before < worst.before) worst = { id: id, before: b.before };
      }
    }
    if (negCount) {
      level = 'warn';
      summary = negCount + ' 处余额为负';
      details.push('有 ' + negCount + ' 笔交易反推出的"交易前余额"小于 0，最严重的一笔是 ' +
        fmt(worst.before) + ' 元。通常意味着账单缺了更早的收入，或者基准余额填大了。');
    }

    // 3b. 合计口径 vs 分账户口径
    // 合计链条覆盖所有账户；有基准余额的账户链条只覆盖它们。
    // 两者之差 = "有流水但没填基准余额的账户"里流过的钱。
    let mergedDelta = 0, chainDelta = 0;
    if (bal.merged) {
      for (const [, b] of bal.merged) mergedDelta += (b.after - b.before);
    }
    for (const [, rec] of bal.balances) {
      for (const acct in rec.byAccount) {
        const b = rec.byAccount[acct];
        chainDelta += (b.after - b.before);
      }
    }
    const gap = Math.round((mergedDelta - chainDelta) * 100) / 100;

    const noBase = (bal.accounts || []).filter(a => !a.known && a.count > 0);
    if (Math.abs(gap) > 0.01) {
      level = 'warn';
      if (summary === '余额链条自洽') summary = '有账户没填基准余额';
      details.push('合计口径与分账户口径相差 ' + fmt(gap) + ' 元——这部分钱流过了没有基准余额的账户' +
        (noBase.length ? '（' + noBase.map(a => a.account).join('、') + '）' : '') +
        '，所以它们的账户余额反推不出来。');
    } else {
      details.push('合计口径与分账户口径完全对得上（差额 ' + fmt(gap) + ' 元）。');
    }

    if (noBase.length) {
      details.push('以下 ' + noBase.length + ' 个账户有流水但没填基准余额：' +
        noBase.map(a => a.account + '（' + a.count + ' 笔）').join('、'));
      if (level === 'ok') { level = 'info'; summary = '部分账户未填基准余额'; }
    }

    // 3c. 填了余额但这个区间没有流水
    const orphan = (bal.accounts || []).filter(a => a.known && a.count === 0);
    if (orphan.length) {
      details.push('以下账户填了基准余额但当前区间没有流水（余额列会显示为 —）：' +
        orphan.map(a => a.account).join('、'));
      if (level === 'ok') { level = 'info'; summary = summary === '余额链条自洽' ? '有账户当前没有流水' : summary; }
    }

    if (!details.length) details.push('没有发现异常。');
    return { id: 'chain', level: level, title: '余额链自洽性', summary: summary, details: details };
  }

  /**
   * 给人看的交易标识。
   * 之前直接用 t.title（"对方 / 商品"），像「基金申购」这种划转流水只会显示成
   * "某某店 / 某某商品"，用户根本认不出是哪一笔 —— 而 txType 才是划转的关键信息。
   */
  function labelOf(t) {
    const parts = [];
    const push = (v) => { if (v && parts.indexOf(v) < 0) parts.push(v); };
    push(t.txType);
    push(t.counterparty);
    push(t.item);
    return parts.join(' · ') || t.title || '-';
  }

  /* ------------------------------------------------------------------ *
   * 4. 未识别的"不计收支"
   * ------------------------------------------------------------------ */
  function checkNeutral(scoped) {
    const list = (scoped || []).filter(t => t.kind === 'unknown' && t.dir === 'neutral');
    // 方向不明的行不在这一项的范围内，但不能因此就说"全部匹配到划转规则"——
    // 那会让整份账单的钱悄悄归零，体检反而给人虚假的安全感。
    const unknownDir = (scoped || []).filter(t => t.dir === 'unknown').length;
    const details = [];
    if (!list.length) {
      return {
        id: 'neutral', level: 'ok', title: '"不计收支"识别',
        summary: unknownDir ? ('另有 ' + unknownDir + ' 笔方向不明，见「收支方向识别」') : '全部匹配到划转规则',
        details: ['没有落单的划转流水。']
      };
    }
    const samples = list.slice(0, 5).map(t => labelOf(t) + '（' + (t.method || '未标注渠道') + '）');
    details.push('有 ' + list.length + ' 笔"不计收支"的流水没匹配到划转规则，这些钱既没加也没减，余额链条在这里是断的。');
    details.push('例如：' + samples.join('；') + (list.length > samples.length ? ' 等' : ''));
    details.push('处理办法：到左侧「⑥ 规则」里加一条内部划转规则，或在筛选里把这类关键词排除掉。');
    return { id: 'neutral', level: 'warn', title: '"不计收支"识别', summary: list.length + ' 笔未匹配划转规则', details: details };
  }

  /* ------------------------------------------------------------------ *
   * 5. 收支方向识别
   * ------------------------------------------------------------------ */

  /**
   * 方向没识别出来的流水。
   *
   * 这类行既没算收入也没算支出 —— 钱在余额链条上凭空消失。
   * 以前体检只查「不计收支没匹配到划转规则」，方向不明的行不在检查范围内，
   * 于是整份账单的钱全部归零，体检却显示"全部匹配到划转规则"，
   * 反而给人虚假的安全感。
   */
  function checkDirection(list) {
    // 看全部导入的行（prepared），不看 scoped ——
    // 否则被"排除关键词"挡住的行会把问题一起藏起来，体检反倒是绿的。
    // 用户手动点 ✕ 排除掉的行不算问题。
    const rows = (list || []).filter(t => t.dir === 'unknown' && !t.userExcluded);
    const details = [];
    if (!rows.length) {
      return {
        id: 'dir', level: 'ok', title: '收支方向识别',
        summary: '全部流水都识别出了方向', details: ['没有方向不明的流水。']
      };
    }
    details.push('有 ' + rows.length + ' 笔流水没能判断出收支方向，它们既没算收入也没算支出，余额链条在这里是断的。');
    const samples = rows.slice(0, 5).map(t => (t.dirText ? '「' + t.dirText + '」' : '') + labelOf(t));
    details.push('例如：' + samples.join('；') + (rows.length > samples.length ? ' 等' : ''));
    details.push('多半是账单里的「收/支」列写法比较特殊，或者这份账单根本没有这一列。');
    details.push('处理办法：确认这份账单是不是"账单明细列表"（而不是"账单概览"）；必要时在「⑥ 规则」里补规则。');
    return {
      id: 'dir', level: 'warn', title: '收支方向识别',
      summary: rows.length + ' 笔流水方向不明', details: details
    };
  }

  /* ------------------------------------------------------------------ *
   * 6. 部分退款金额未知
   * ------------------------------------------------------------------ */
  function checkRefund(scoped) {
    const list = (scoped || []).filter(t => (t.flags || []).some(f => f.indexOf('部分退款') >= 0));
    const full = (scoped || []).filter(t => (t.flags || []).some(f => f.indexOf('全额退款') >= 0 || f.indexOf('已全额退款') >= 0));
    const details = [];
    if (!list.length) {
      details.push(full.length ? ('已识别 ' + full.length + ' 笔全额退款（净额已按 0 计）。') : '没有发现退款金额缺失的流水。');
      return {
        id: 'refund', level: full.length ? 'info' : 'ok', title: '退款处理',
        summary: full.length ? full.length + ' 笔全额退款已按 0 计' : '没有异常',
        details: details
      };
    }
    details.push('有 ' + list.length + ' 笔部分退款查不到退款金额，仍按原金额计入支出，可能多算了。');
    details.push('例如：' + list.slice(0, 5).map(t => t.title + ' ' + fmt(t.amount) + ' 元').join('；'));
    details.push('可以在明细表里点「✕」把这几笔排除掉，或把该文件在文件列表里的"退款方式"改成"按原样"。');
    return { id: 'refund', level: 'warn', title: '退款处理', summary: list.length + ' 笔部分退款金额未知', details: details };
  }

  /* ------------------------------------------------------------------ *
   * * 6. 导入质量
   * ------------------------------------------------------------------ */
  function checkQuality(files) {
    const details = [];
    let ok = 0, failed = 0, totalRows = 0, parsed = 0, skipped = 0, repaired = 0;
    const encodings = new Set();

    for (const key in (files || {})) {
      const f = files[key];
      if (!f) continue;
      if (f.error) { failed++; details.push('「' + f.name + '」解析失败：' + f.error); continue; }
      ok++;
      const q = f.quality || {};
      totalRows += q.totalRows || 0;
      parsed += q.parsed || 0;
      skipped += (q.skipped || 0);
      repaired += (q.repaired || 0);
      if (f.encoding) encodings.add(f.encoding);
    }

    const level = failed ? 'warn' : 'ok';
    const summary = failed ? failed + ' 个文件解析失败' :
      (skipped ? '共 ' + skipped + ' 行被跳过' : '所有行都解析成功');
    details.push('成功 ' + ok + ' 个文件，失败 ' + failed + ' 个；共读到 ' + totalRows + ' 行，解析出 ' + parsed + ' 笔，跳过 ' + skipped + ' 行。');
    if (repaired) details.push('有 ' + repaired + ' 行因为字段里有未转义的逗号导致列错位，已自动修复。');
    if (encodings.size) details.push('文件编码：' + Array.from(encodings).join('、'));
    return { id: 'quality', level: level, title: '导入质量', summary: summary, details: details };
  }

  /* ------------------------------------------------------------------ *
   * 7. 汇总运行
   * ------------------------------------------------------------------ */
  function run(opts) {
    opts = opts || {};
    const prepared = opts.prepared || [];
    const scoped = opts.scoped || [];
    const bal = opts.bal || null;
    const files = opts.files || {};

    const checks = [
      checkQuality(files),
      checkMonths(prepared),
      checkDuplicates(prepared, scoped, files),
      checkChain(scoped, bal),
      checkNeutral(scoped),
      checkDirection(prepared),
      checkRefund(scoped)
    ];

    // 基准分 50：7 项检查全 ok = 120 → 封顶 100；
    // 换成 50 之后，同样问题组合下的分数与以前（6 项 / 基准 60）完全一致。
    const score = checks.reduce((s, c) => {
      if (c.level === 'err') return s - 30;
      if (c.level === 'warn') return s - 12;
      if (c.level === 'info') return s - 4;
      return s + 10;
    }, 50);
    const health = Math.max(0, Math.min(100, Math.round(score)));

    return { checks: checks, health: health };
  }

  return {
    run: run,
    checkMonths: checkMonths,
    checkDuplicates: checkDuplicates,
    checkChain: checkChain,
    checkNeutral: checkNeutral,
    checkDirection: checkDirection,
    checkRefund: checkRefund,
    checkQuality: checkQuality,
    labelOf: labelOf
  };
})();
