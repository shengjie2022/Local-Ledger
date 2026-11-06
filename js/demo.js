/* =========================================================================
 * demo.js —— 内置示例数据
 *
 * 基准余额不是随手编的：这里先按时间正序模拟一遍每个账户的余额，
 * 用模拟的"期末余额"当作基准余额。这样用户在界面里反推出来的每一个数字，
 * 都跟正向流水对得上，且全程不会出现负余额。
 * ========================================================================= */
window.LedgerDemo = (function () {
  'use strict';

  const C = window.LedgerCalc;
  const R = window.LedgerRules;

  // 各账户"起始"余额（模拟用）
  const START_BALANCE = {
    '微信·零钱': 6000,
    '微信·招商银行(1234)': 15000,
    '微信·零钱通': 6000,
    '支付宝': 8000,
    '支付宝·余额宝': 0
  };

  const WECHAT_METHODS = ['零钱', '招商银行(1234)', '零钱通'];

  const ITEMS = [
    ['美团外卖', '餐饮', 38], ['瑞幸咖啡', '餐饮', 26], ['盒马鲜生', '生鲜', 62],
    ['滴滴出行', '交通', 24], ['地铁', '交通', 8], ['京东', '购物', 129],
    ['万达影城', '娱乐', 45], ['屈臣氏', '日用', 52], ['全家便利店', '日用', 15],
    ['中石化加油', '交通', 300], ['海底捞', '餐饮', 268], ['得物', '购物', 399],
    ['宠物医院', '医疗', 320], ['新华书店', '教育', 68], ['健身房', '娱乐', 99],
    ['微信红包', '人情', 88], ['话费充值', '通讯', 50], ['水电费', '居住', 180],
    ['永辉超市', '生鲜', 86], ['星巴克', '餐饮', 35], ['淘宝网', '购物', 76],
    ['顺丰速运', '生活', 23], ['中国移动', '通讯', 100], ['中通快递', '生活', 15]
  ];
  function build() {
    let seed = 20260401;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

    const raw = [];
    const push = (o) => {
      o.id = 'demo#' + raw.length;
      o.seq = raw.length;
      raw.push(o);
    };

    const start = new Date(2026, 6, 1);
    const end = new Date(2026, 9, 28);

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      // 每天 0~2 笔消费
      const n = Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const it = ITEMS[Math.floor(rnd() * ITEMS.length)];
        const isWechat = rnd() < 0.6;
        const method = isWechat ? WECHAT_METHODS[Math.floor(rnd() * WECHAT_METHODS.length)] : '';
        const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(),
          8 + Math.floor(rnd() * 13), Math.floor(rnd() * 60), Math.floor(rnd() * 60)).getTime();
        const amount = +(it[2] * (0.8 + rnd() * 0.5)).toFixed(2);
        push({
          src: isWechat ? 'wechat' : 'alipay',
          file: isWechat ? '示例-微信账单.csv' : '示例-支付宝账单.csv',
          time: ts,
          dir: 'out', dirText: '支出', amount: amount,
          txType: isWechat ? '商户消费' : '即时交易', counterparty: it[0], item: it[0],
          status: '支付成功', state: 'success', stateFullRefund: false,
          method: method, refundCol: null, fee: 0,
          orderNo: 'DEMO' + raw.length, note: '', fundState: '', srcPlace: ''
        });
      }
      // 每月 10 号发工资
      if (d.getDate() === 10) {
        push({
          src: 'alipay', file: '示例-支付宝账单.csv',
          time: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0).getTime(),
          dir: 'in', dirText: '收入', amount: 9800,
          txType: '转账', counterparty: '公司', item: (d.getMonth() + 1) + '月工资',
          status: '交易成功', state: 'success', stateFullRefund: false,
          method: '', refundCol: null, fee: 0,
          orderNo: 'DEMO' + raw.length, note: '', fundState: '', srcPlace: ''
        });
      }
    }

    // 内部划转样本
    push({
      src: 'wechat', file: '示例-微信账单.csv',
      time: new Date(2026, 7, 3, 10, 0, 0).getTime(),
      dir: 'neutral', dirText: '不计收支', amount: 500,
      txType: '零钱充值', counterparty: '招商银行', item: '零钱充值',
      status: '充值成功', state: 'success', stateFullRefund: false,
      method: '招商银行(1234)', refundCol: null, fee: 0,
      orderNo: 'DEMO-t1', note: '', fundState: '', srcPlace: ''
    });
    push({
      src: 'alipay', file: '示例-支付宝账单.csv',
      time: new Date(2026, 7, 6, 15, 0, 0).getTime(),
      dir: 'neutral', dirText: '不计收支', amount: 1000,
      txType: '余额宝转入', counterparty: '余额宝', item: '转入余额宝',
      status: '交易成功', state: 'success', stateFullRefund: false,
      method: '', refundCol: null, fee: 0,
      orderNo: 'DEMO-t2', note: '', fundState: '', srcPlace: ''
    });

    // ---- 正向模拟，算出每个账户的期末余额 = 基准余额 ----
    const prepared = C.prepare(raw, {
      rules: { internal: R.DEFAULT_INTERNAL_RULES, category: R.DEFAULT_CATEGORY_RULES },
      fileInfo: {
        '示例-微信账单.csv': { hasSeparateRefundRow: false },
        '示例-支付宝账单.csv': { hasSeparateRefundRow: false }
      },
      excluded: new Set(),
      refundMode: {}
    });
    prepared.sort((a, b) => a.time - b.time || a.seq - b.seq);

    const running = Object.assign({}, START_BALANCE);
    let minBalance = Infinity;
    for (const t of prepared) {
      const d = C.txDeltas(t);
      for (const k in d) {
        running[k] = (running[k] || 0) + d[k];
        if (running[k] < minBalance) minBalance = running[k];
      }
    }
    // 期末余额即基准余额（保留两位小数，不取整，否则与正向模拟差几分钱）
    const bases = {};
    for (const k in running) bases[k] = Math.round(running[k] * 100) / 100;

    const wxCount = raw.filter(t => t.src === 'wechat').length;
    const aliCount = raw.filter(t => t.src === 'alipay').length;
    const files = {
      '示例-微信账单.csv': {
        name: '示例-微信账单.csv', key: '示例-微信账单.csv', source: 'wechat', encoding: 'UTF-8',
        count: wxCount, hasSeparateRefundRow: false, log: [],
        quality: { totalRows: wxCount, parsed: wxCount, skipped: 0, skippedNoTime: 0, skippedNoAmount: 0, skippedFooter: 0, repaired: 0 }
      },
      '示例-支付宝账单.csv': {
        name: '示例-支付宝账单.csv', key: '示例-支付宝账单.csv', source: 'alipay', encoding: 'UTF-8',
        count: aliCount, hasSeparateRefundRow: false, log: [],
        quality: { totalRows: aliCount, parsed: aliCount, skipped: 0, skippedNoTime: 0, skippedNoAmount: 0, skippedFooter: 0, repaired: 0 }
      }
    };

    return { raw: raw, files: files, bases: bases, minBalance: minBalance };
  }

  return { build: build, START_BALANCE: START_BALANCE };
})();
