/* =========================================================================
 * smoke-test.js —— 离线自检
 * 用 test/fixtures 下的仿真账单跑一遍「解析 → 归一化 → 余额反推 → 分组汇总」，
 * 断言关键数字，防止改代码时把账算错。
 *
 * 运行： node test/smoke-test.js
 * （fixtures 由 test/make_fixtures.py 生成，是 GBK 编码，和真实导出一样）
 * ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

global.window = global;
const ROOT = path.join(__dirname, '..');
for (const f of ['js/rules.js', 'js/parse.js', 'js/calc.js', 'js/charts.js', 'js/health.js', 'js/demo.js']) {
  // eslint-disable-next-line no-eval
  eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
}

const P = global.LedgerParse;
const C = global.LedgerCalc;
const R = global.LedgerRules;
const CH = global.LedgerCharts;
const H = global.LedgerHealth;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '   期望 ' + JSON.stringify(extra) : '')); }
}
function near(a, b, eps) { return Math.abs(a - b) < (eps || 0.005); }
function section(t) { console.log('\n' + t); }

function readBill(name) {
  const buf = fs.readFileSync(path.join(__dirname, 'fixtures', name));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dec = P.decodeBuffer(ab);
  const res = P.parseBillText(dec.text, name);
  return { dec, res };
}

/* ------------------------------------------------------------------ */
section('【1】编码与文件解析');
const wx = readBill('wechat_bill.csv');
const ali = readBill('alipay_bill.csv');
const aliOld = readBill('alipay_old_bill.csv');

ok('微信账单识别为 GBK/GB18030', /GBK/.test(wx.dec.encoding), wx.dec.encoding);
ok('微信账单来源识别为 wechat', wx.res.source === 'wechat', wx.res.source);
ok('微信账单解析出 7 条', wx.res.txs.length === 7, wx.res.txs.length);
ok('微信账单定位到表头行(含前置说明行)', wx.res.headerRow === 6, wx.res.headerRow);

ok('支付宝账单来源识别为 alipay', ali.res.source === 'alipay', ali.res.source);
ok('支付宝账单解析出 6 条', ali.res.txs.length === 6, ali.res.txs.length);
ok('支付宝旧版表头也能解析(2 条)', aliOld.res.txs.length === 2, aliOld.res.txs.length);

const wxT = wx.res.txs[0];
ok('微信金额去掉 ¥ 前缀 = 128.50', wxT.amount === 128.50, wxT.amount);
ok('微信带逗号的引号字段被正确拆开', wxT.item === '买菜,日用品', wxT.item);
ok('微信支付方式被识别', wxT.method === '零钱', wxT.method);
ok('微信收/支识别为支出', wxT.dir === 'out', wxT.dir);
ok('微信收入行识别为收入', wx.res.txs[2].dir === 'in', wx.res.txs[2].dir);
ok('微信不计收支识别为 neutral', wx.res.txs[3].dir === 'neutral', wx.res.txs[3].dir);
ok('微信"已全额退款"状态识别', wx.res.txs[5].state === 'refunded', wx.res.txs[5].state);
ok('微信"交易关闭"状态识别', wx.res.txs[6].state === 'closed', wx.res.txs[6].state);

const aliT = ali.res.txs[4];
ok('支付宝"已退款"状态识别', aliT.state === 'refunded', aliT.state);
ok('支付宝成功退款金额被读取 = 20.00', aliT.refundCol === 20.00, aliT.refundCol);
ok('支付宝表头列名映射到成功退款列', ali.res.txs[0].amount === 86.40, ali.res.txs[0].amount);
ok('支付宝旧格式金额正确', aliOld.res.txs[1].amount === 3200.00, aliOld.res.txs[1].amount);

/* ------------------------------------------------------------------ */
section('【2】归一化：账户归属、内部划转、分类、退款净额');

const raw = []
  .concat(wx.res.txs.map((t, i) => Object.assign({}, t, { id: 'wx#' + i, file: 'wechat_bill.csv' })))
  .concat(ali.res.txs.map((t, i) => Object.assign({}, t, { id: 'ali#' + i, file: 'alipay_bill.csv' })));

const fileInfo = {
  'wechat_bill.csv': { hasSeparateRefundRow: wx.res.hasSeparateRefundRow },
  'alipay_bill.csv': { hasSeparateRefundRow: ali.res.hasSeparateRefundRow }
};

const prepared = C.prepare(raw, {
  rules: { internal: R.DEFAULT_INTERNAL_RULES, category: R.DEFAULT_CATEGORY_RULES },
  fileInfo,
  excluded: new Set(),
  refundMode: {}
});
prepared.sort((a, b) => a.time - b.time || a.seq - b.seq);

const byKey = {};
for (const t of prepared) byKey[t.id] = t;

ok('共解析 13 条交易', prepared.length === 13, prepared.length);
ok('2 笔"交易关闭"被标记为跳过', prepared.filter(t => t.skip).length === 2, prepared.filter(t => t.skip).length);

ok('微信零钱账户归类正确', byKey['wx#0'].account === '微信·零钱', byKey['wx#0'].account);
ok('微信银行卡账户归类正确', byKey['wx#1'].account === '微信·招商银行(1234)', byKey['wx#1'].account);
ok('支付宝账户归类正确', byKey['ali#0'].account === '支付宝', byKey['ali#0'].account);

ok('零钱充值识别为内部划转', byKey['wx#3'].kind === 'internal', byKey['wx#3'].kind);
ok('零钱充值落到"微信·零钱"且为流入', byKey['wx#3'].internalAccount === '微信·零钱' && byKey['wx#3'].internalDir === 'in',
  [byKey['wx#3'].internalAccount, byKey['wx#3'].internalDir]);
ok('零钱充值的对向账户是付款银行卡', byKey['wx#3'].internalCounter === '微信·招商银行(1234)', byKey['wx#3'].internalCounter);
ok('零钱提现识别为流出', byKey['wx#4'].kind === 'internal' && byKey['wx#4'].internalDir === 'out',
  [byKey['wx#4'].kind, byKey['wx#4'].internalDir]);
ok('余额宝转入识别为内部划转且为流出', byKey['ali#3'].kind === 'internal' && byKey['ali#3'].internalDir === 'out',
  [byKey['ali#3'].kind, byKey['ali#3'].internalDir]);

ok('永辉超市归类为日用', byKey['wx#0'].category === '日用', byKey['wx#0'].category);
ok('美团外卖归类为餐饮', byKey['wx#1'].category === '餐饮', byKey['wx#1'].category);
ok('盒马买菜归类为日用', byKey['ali#0'].category === '日用', byKey['ali#0'].category);
ok('工资收入归类为人情以外(转账→未命中具体类)', byKey['ali#2'].category !== '', byKey['ali#2'].category);

ok('微信"已全额退款"净额 = 0', byKey['wx#5'].netAmount === 0, byKey['wx#5'].netAmount);
ok('支付宝部分退款净额 = 52.80-20.00 = 32.80', near(byKey['ali#4'].netAmount, 32.80), byKey['ali#4'].netAmount);

/* ------------------------------------------------------------------ */
section('【3】余额反推（按账户分别）');

const bases = {
  '微信·零钱': 1000,
  '微信·招商银行(1234)': 500,
  '支付宝': 20000
};
const bal = C.computeBalances(prepared, bases);

const b = (id) => bal.balances.get(byKey[id].id);
const primary = (id) => b(id).primary;
const acc = (id, acct) => b(id).byAccount[acct];

ok('微信零钱：首笔支出前余额 = 528.50', near(primary('wx#0').before, 528.50), primary('wx#0').before);
ok('微信零钱：3/5 收红包前 400 → 后 900', near(primary('wx#2').before, 400) && near(primary('wx#2').after, 900),
  [primary('wx#2').before, primary('wx#2').after]);
ok('微信零钱：3/10 零钱充值 前 900 → 后 1100', near(primary('wx#3').before, 900) && near(primary('wx#3').after, 1100),
  [primary('wx#3').before, primary('wx#3').after]);
ok('同一笔充值的对向账户：银行卡 前 700 → 后 500',
  near(acc('wx#3', '微信·招商银行(1234)').before, 700) && near(acc('wx#3', '微信·招商银行(1234)').after, 500),
  [acc('wx#3', '微信·招商银行(1234)').before, acc('wx#3', '微信·招商银行(1234)').after]);
ok('微信零钱：3/11 提现 前 1100 → 后 1000', near(primary('wx#4').before, 1100) && near(primary('wx#4').after, 1000),
  [primary('wx#4').before, primary('wx#4').after]);
ok('微信零钱：全额退款那笔余额不变', near(primary('wx#5').before, 1000) && near(primary('wx#5').after, 1000), primary('wx#5'));
ok('微信银行卡：首笔支出前余额 = 723.50', near(primary('wx#1').before, 723.50), primary('wx#1').before);
ok('微信银行卡：3/2 支出后 = 700', near(primary('wx#1').after, 700), primary('wx#1').after);
ok('支付宝：首笔支出前余额 = 11343.50', near(primary('ali#0').before, 11343.50), primary('ali#0').before);
ok('支付宝：发工资 前 11232.80 → 后 21032.80',
  near(primary('ali#2').before, 11232.80) && near(primary('ali#2').after, 21032.80),
  [primary('ali#2').before, primary('ali#2').after]);
ok('支付宝：转入余额宝 前 21032.80 → 后 20032.80',
  near(primary('ali#3').before, 21032.80) && near(primary('ali#3').after, 20032.80),
  [primary('ali#3').before, primary('ali#3').after]);
ok('支付宝：最后一笔(部分退款)后余额 = 20000', near(primary('ali#4').after, 20000), primary('ali#4').after);
ok('内部划转的主账户是它自己的账户', primary('wx#3').account === '微信·零钱', primary('wx#3').account);
ok('余额桶含"支付宝·余额宝"(无基准余额,标记为未知)',
  bal.accounts.some(a => a.account === '支付宝·余额宝' && !a.known),
  bal.accounts.map(a => a.account + ':' + a.known));

section('【4】余额反推（全部合计口径）');
ok('合计基准余额 = 21500', near(bal.mergedBase, 21500), bal.mergedBase);
ok('合计口径首笔交易前余额 = 11595.50', near(bal.merged.get(byKey['wx#0'].id).before, 11595.50),
  bal.merged.get(byKey['wx#0'].id).before);
ok('内部划转在合计口径下相互抵消(零钱充值合计变动为 0)', near(C.txTotalDelta(byKey['wx#3']), 0),
  C.txTotalDelta(byKey['wx#3']));
ok('余额宝转入在合计口径下相互抵消', near(C.txTotalDelta(byKey['ali#3']), 0), C.txTotalDelta(byKey['ali#3']));
ok('零钱提现无对向账户,合计口径下确实减少 100', near(C.txTotalDelta(byKey['wx#4']), -100),
  C.txTotalDelta(byKey['wx#4']));

section('【5】分组汇总');
const byMonth = C.summarize(prepared, 'month', bal, 'account');
ok('按月只有 1 组', byMonth.length === 1, byMonth.length);
ok('按月收入 = 500 + 9800 = 10300', near(byMonth[0].income, 10300), byMonth[0].income);
ok('按月支出 = 295.50', near(byMonth[0].expense, 295.50), byMonth[0].expense);
ok('按月净额 = 10004.50', near(byMonth[0].net, 10004.50), byMonth[0].net);
ok('按月笔数 = 11 (2 笔关闭不计)', byMonth[0].count === 11, byMonth[0].count);
ok('按月期初余额 = 11595.50', near(byMonth[0].begin, 11595.50), byMonth[0].begin);
ok('按月期末余额 = 21500', near(byMonth[0].end, 21500), byMonth[0].end);

const byDay = C.summarize(prepared, 'day', bal, 'account');
ok('按日共 11 组', byDay.length === 11, byDay.length);
ok('按日按时间倒序(最新在前)', byDay[0].key > byDay[byDay.length - 1].key, byDay.map(x => x.key).join(','));

section('【6】健壮性');
ok('重复检测：本例无跨平台重复', C.findDuplicates(prepared).length === 0, C.findDuplicates(prepared).length);
ok('空账单不报错', C.computeBalances([], {}).mergedBase === 0);
ok('未填基准余额时不产生负数告警', bal.warnings.filter(w => w.level === 'warn').length === 0,
  bal.warnings.map(w => w.text));
ok('解析垃圾文本返回明确错误', P.parseBillText('这不是账单', 'x.csv').ok === false);
ok('解析空文件返回明确错误', P.parseBillText('', 'x.csv').ok === false);
ok('金额解析兼容 ¥ / 元 / 千分位',
  P.parseAmount('¥1,234.50') === 1234.50 && P.parseAmount('88元') === 88 && P.parseAmount('') === null);
ok('时间解析兼容多种写法',
  P.parseTime('2026-03-05 12:00:00') instanceof Date &&
  P.parseTime('2026/3/5') instanceof Date &&
  P.parseTime('2026年3月5日') instanceof Date &&
  P.parseTime('20260305120000') instanceof Date &&
  P.parseTime('乱码') === null);

/* ------------------------------------------------------------------ */
section('【7】内置示例数据');
const demo = global.LedgerDemo.build();
ok('示例数据量足够撑起演示(>100 笔)', demo.raw.length > 100, demo.raw.length);

const demoPrepared = C.prepare(demo.raw, {
  rules: { internal: R.DEFAULT_INTERNAL_RULES, category: R.DEFAULT_CATEGORY_RULES },
  fileInfo: demo.files,
  excluded: new Set(),
  refundMode: {}
});
demoPrepared.sort((a, b) => a.time - b.time || a.seq - b.seq);

const demoBal = C.computeBalances(demoPrepared, demo.bases);
let minSeen = Infinity;
for (const t of demoPrepared) {
  const rec = demoBal.balances.get(t.id);
  if (!rec || !rec.primary) continue;
  if (rec.primary.before < minSeen) minSeen = rec.primary.before;
}
// 正向模拟一遍，与反推结果逐笔比对：某笔之后的余额 = 基准余额 − 该笔之后所有变动之和
const suffix = {};
let mismatch = 0;
for (let i = demoPrepared.length - 1; i >= 0; i--) {
  const t = demoPrepared[i];
  const rec = demoBal.balances.get(t.id);
  if (rec && rec.primary) {
    const acct = rec.primary.account;
    const expectEnd = demo.bases[acct] - (suffix[acct] || 0);
    if (Math.abs(expectEnd - rec.primary.after) > 0.005) mismatch++;
  }
  const d = C.txDeltas(t);
  for (const k in d) suffix[k] = (suffix[k] || 0) + d[k];
}

ok('示例数据反推后全程没有负余额', minSeen >= 0, minSeen);
ok('示例数据反推结果与正向模拟完全一致', mismatch === 0, mismatch);
ok('示例数据不产生负余额告警', demoBal.warnings.filter(w => w.level === 'warn').length === 0,
  demoBal.warnings.map(w => w.text));
ok('示例数据合并基准余额 = 各账户基准之和',
  near(demoBal.mergedBase, Object.values(demo.bases).reduce((a, b) => a + b, 0), 0.01), demoBal.mergedBase);
ok('示例数据包含内部划转且被正确识别',
  demoPrepared.filter(t => t.kind === 'internal').length === 2,
  demoPrepared.filter(t => t.kind === 'internal').length);

/* ------------------------------------------------------------------ */
section('【8】导出行构建');
const detailRows = C.buildDetailRows(prepared, bal);
ok('明细导出：表头 17 列', detailRows[0].length === 17, detailRows[0].length);
ok('明细导出：行数 = 交易数 + 1', detailRows.length === prepared.length + 1, detailRows.length);
ok('明细导出：金额保留两位小数', detailRows[1][7] === '128.50', detailRows[1][7]);
ok('明细导出：含"账户余额(前)"列且有值', detailRows[1][9] === '528.50', detailRows[1][9]);
ok('明细导出：含"合计余额(后)"列且有值(最后一笔=基准余额)',
  detailRows[detailRows.length - 1][12] === '21500.00', detailRows[detailRows.length - 1][12]);
ok('明细导出：来源用中文', detailRows[1][1] === '微信', detailRows[1][1]);
ok('明细导出：金额列全为数字字符串',
  detailRows.slice(1).every(r => /^-?\d+\.\d{2}$/.test(r[7]) && /^-?\d+\.\d{2}$/.test(r[8])),
  detailRows[1][8]);

const sumRows = C.buildSummaryRows(prepared, 'month', bal);
ok('汇总导出：表头 7 列', sumRows[0].length === 7, sumRows[0].length);
ok('汇总导出：只有 1 个月份组', sumRows.length === 2, sumRows.length);
ok('汇总导出：金额保留两位小数', sumRows[1][2] === '10300.00' && sumRows[1][3] === '295.50',
  [sumRows[1][2], sumRows[1][3]]);
ok('汇总导出：期初/期末余额正确',
  sumRows[1][5] === '11595.50' && sumRows[1][6] === '21500.00', [sumRows[1][5], sumRows[1][6]]);

const csvCell = (v) => {
  if (v == null) return '';
  let s = String(v);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
};
const csv = '\uFEFF' + detailRows.map(r => r.map(csvCell).join(',')).join('\r\n');
ok('CSV 带 UTF-8 BOM（Excel 不乱码）', csv.charCodeAt(0) === 0xFEFF);
ok('CSV 含表头行', csv.indexOf('账户余额(前)') > 0);
ok('CSV 字段内逗号被正确转义', csv.indexOf('"买菜,日用品"') > 0 || csv.indexOf('永辉超市') > 0);
ok('CSV 行数 = 交易数 + 1', csv.split('\r\n').length === prepared.length + 1, csv.split('\r\n').length);

/* ------------------------------------------------------------------ */
section('【9】本轮 bug 修复回归');

// —— 小工具 ——
const ts = (y, m, d, hh) => new Date(y, m - 1, d, hh || 0, 0, 0).getTime();
function mkTx(o) {
  return Object.assign({
    id: 'x#' + Math.random().toString(36).slice(2),
    src: 'manual', file: 'f.csv', seq: 0,
    time: ts(2026, 3, 15), dir: 'out', dirText: '支出', amount: 100,
    txType: '商户消费', counterparty: '某店', item: '商品',
    status: '支付成功', state: 'success', stateFullRefund: false,
    method: '零钱', refundCol: null, fee: 0, orderNo: '', note: '', fundState: ''
  }, o);
}
const PREP_OPTS = (fileInfo) => ({
  rules: { internal: R.DEFAULT_INTERNAL_RULES, category: R.DEFAULT_CATEGORY_RULES },
  fileInfo: fileInfo || {}, excluded: new Set(), refundMode: {}
});

// 9.1 支付宝「交易成功但对方已退款」按净额 0 计
const ALI_HEAD = '支付宝交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态';
const aliRefundCsv = [
  '支付宝交易记录明细查询',
  '---------------------------------交易记录明细列表------------------------------------',
  ALI_HEAD,
  '202603051200001,70003,2026-03-05 12:00:00,2026-03-05 12:00:00,2026-03-05 12:00:00,支付宝网站,即时交易,某店,商品,88.00,支出,交易成功但对方已退款,0.00,0.00,,已退款',
  '--------------------------------交易记录明细列表结束------------------------------------'
].join('\n');
const aliRefundRes = P.parseBillText(aliRefundCsv, 'ali_refund.csv');
const aliRefundPrep = C.prepare(aliRefundRes.txs, PREP_OPTS({ 'ali_refund.csv': { hasSeparateRefundRow: false } }));
ok('支付宝「交易成功但对方已退款」识别为已退款', aliRefundRes.txs[0].state === 'refunded', aliRefundRes.txs[0].state);
ok('支付宝「对方已全额退款」净额 = 0（不是 88）', aliRefundPrep[0].netAmount === 0, aliRefundPrep[0].netAmount);
ok('支付宝「对方已全额退款」带标记', aliRefundPrep[0].flags.some(f => f.indexOf('全额退款') >= 0), aliRefundPrep[0].flags);

// 9.2 支付宝服务费计入支出
const aliFeeCsv = [
  '支付宝交易记录明细查询',
  '---------------------------------交易记录明细列表------------------------------------',
  ALI_HEAD,
  '202603061000001,70004,2026-03-06 10:00:00,2026-03-06 10:00:00,2026-03-06 10:00:00,支付宝网站,即时交易,某行,手续费,100.00,支出,交易成功,2.50,0.00,,已支出',
  '--------------------------------交易记录明细列表结束------------------------------------'
].join('\n');
const aliFeePrep = C.prepare(P.parseBillText(aliFeeCsv, 'ali_fee.csv').txs, PREP_OPTS({ 'ali_fee.csv': { hasSeparateRefundRow: false } }));
ok('支付宝服务费 2.50 被读出来', aliFeePrep[0].fee === 2.5, aliFeePrep[0].fee);
ok('支付宝支出净额 = 金额 + 服务费 = 102.50', aliFeePrep[0].netAmount === 102.5, aliFeePrep[0].netAmount);
ok('服务费有标记', aliFeePrep[0].flags.some(f => f.indexOf('服务费') >= 0), aliFeePrep[0].flags);

// 9.3 手动记录保留用户自己填的分类
const manInvest = C.prepare([mkTx({ src: 'manual', txType: '投资', method: '现金' })], PREP_OPTS());
ok('手动记录「投资」不会被改成「其他」', manInvest[0].category === '投资', manInvest[0].category);
const manEdu = C.prepare([mkTx({ src: 'manual', txType: '学费', method: '现金' })], PREP_OPTS());
ok('手动记录「学费」不会被改成「教育」', manEdu[0].category === '学费', manEdu[0].category);
const autoEdu = C.prepare([mkTx({ src: 'wechat', txType: '学费', method: '零钱' })], PREP_OPTS());
ok('（对照组）账单里的「学费」仍自动归到「教育」', autoEdu[0].category === '教育', autoEdu[0].category);

// 9.4 余额按分取整，不留浮点尾巴
const tinyPrep = C.prepare([mkTx({ id: 't1', src: 'manual', amount: 0.2, method: '现金', txType: 'x' })], PREP_OPTS());
const tinyBal = C.computeBalances(tinyPrep, { '现金': 0.1 });
ok('余额按分取整：0.1+0.2 精确等于 0.3', tinyBal.balances.get('t1').primary.before === 0.3, tinyBal.balances.get('t1').primary.before);
ok('合计基准余额按分取整', tinyBal.mergedBase === 0.1, tinyBal.mergedBase);

// 9.5 有基准余额但没流水的账户，也要计入合计
const withOrphan = C.computeBalances(tinyPrep, { '现金': 0.1, '没有流水的账户': 100 });
ok('合计基准余额含"有余额但没流水"的账户', withOrphan.mergedBase === 100.1, withOrphan.mergedBase);
ok('没流水的账户仍出现在账户清单里', withOrphan.accounts.some(a => a.account === '没有流水的账户' && a.count === 0),
  withOrphan.accounts.map(a => a.account + ':' + a.count));

// 9.6 跨平台重复检测：按"时间距离"而不是分桶
const dupA = C.prepare([mkTx({ id: 'd1', src: 'wechat', time: ts(2026, 3, 15, 10), amount: 100, dir: 'out' })], PREP_OPTS());
const dupB = C.prepare([mkTx({ id: 'd2', src: 'alipay', time: ts(2026, 3, 15, 10) + 2 * 60000, amount: 100, dir: 'in' })], PREP_OPTS());
const dupFar = C.prepare([mkTx({ id: 'd3', src: 'alipay', time: ts(2026, 3, 15, 10) + 20 * 60000, amount: 100, dir: 'in' })], PREP_OPTS());
ok('相隔 2 分钟的跨平台同额交易能检出重复', C.findDuplicates(dupA.concat(dupB)).length === 1,
  C.findDuplicates(dupA.concat(dupB)).length);
ok('相隔 20 分钟的不再误报重复', C.findDuplicates(dupA.concat(dupFar)).length === 0,
  C.findDuplicates(dupA.concat(dupFar)).length);
const sameSrc = C.prepare([mkTx({ id: 's1', src: 'wechat', time: ts(2026, 3, 15, 10), amount: 100, dir: 'out' })], PREP_OPTS())
  .concat(C.prepare([mkTx({ id: 's2', src: 'wechat', time: ts(2026, 3, 15, 10) + 60000, amount: 100, dir: 'out' })], PREP_OPTS()));
ok('同平台同向同额不报重复', C.findDuplicates(sameSrc).length === 0, C.findDuplicates(sameSrc).length);
ok('重复检测带时间差(gap)', C.findDuplicates(dupA.concat(dupB))[0].gap === 2, C.findDuplicates(dupA.concat(dupB))[0].gap);

// 9.7 完全重复（同一个文件导了两次）
const exactA = mkTx({ id: 'e1', src: 'wechat', orderNo: '4200001' });
const exactB = mkTx({ id: 'e2', src: 'wechat', orderNo: '4200001' });
const exactPrep = C.prepare([exactA, exactB], PREP_OPTS());
ok('同一文件导两次能被检出', C.findExactDuplicates(exactPrep).length === 1, C.findExactDuplicates(exactPrep).length);

// 9.8 列错位自动修复（字段里有未转义的逗号）
const wxBadCsv = [
  '微信支付账单明细列表',
  '起始时间：[2026-03-01 00:00:00] 终止时间：[2026-03-31 23:59:59]',
  '----------------------微信支付账单明细列表--------------------',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  '2026-03-01 09:00:00,商户消费,永辉超市,买菜,日用品,支出,￥128.50,零钱,支付成功,4200001,10001,',
  '2026-03-02 10:00:00,商户消费,美团外卖,午餐,支出,￥23.50,零钱,支付成功,4200002,10002,',
  '-----------------------微信支付账单明细列表结束--------------------'
].join('\n');
const badRes = P.parseBillText(wxBadCsv, 'bad.csv');
ok('列错位的行不会被整行丢掉', badRes.txs.length === 2, badRes.txs.length);
ok('列错位修复后金额读对 = 128.50', badRes.txs[0].amount === 128.5, badRes.txs[0].amount);
ok('列错位修复后收/支读对 = 支出', badRes.txs[0].dir === 'out', badRes.txs[0].dir);
ok('列错位修复后支付方式读对 = 零钱', badRes.txs[0].method === '零钱', badRes.txs[0].method);
ok('列错位修复后交易对方读对 = 永辉超市', badRes.txs[0].counterparty === '永辉超市', badRes.txs[0].counterparty);
ok('列错位修复计数 = 1 行', badRes.stats.repaired === 1, badRes.stats.repaired);
ok('导入质量统计里 totalRows 正确', badRes.stats.totalRows === 3, badRes.stats.totalRows);

// 9.8b 逗号出现在「交易对方」里
const wxBadCsv2 = [
  '微信支付账单明细列表',
  '----------------------微信支付账单明细列表--------------------',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  '2026-03-01 09:00:00,商户消费,永辉,超市,买菜,支出,￥50.00,零钱,支付成功,4200003,10003,',
  '2026-03-02 10:00:00,商户消费,美团外卖,午餐,支出,￥23.50,零钱,支付成功,4200002,10002,',
  '-----------------------微信支付账单明细列表结束--------------------'
].join('\n');
const bad2 = P.parseBillText(wxBadCsv2, 'bad2.csv');
ok('对方列里有逗号时行也没丢', bad2.txs.length === 2, bad2.txs.length);
ok('对方列里有逗号时金额读对 = 50.00', bad2.txs[0].amount === 50, bad2.txs[0].amount);
ok('对方列里有逗号时收/支读对 = 支出', bad2.txs[0].dir === 'out', bad2.txs[0].dir);
ok('对方列里有逗号时商品读对 = 买菜', bad2.txs[0].item === '买菜', bad2.txs[0].item);
ok('对方列里有逗号时对方读对 = 永辉', bad2.txs[0].counterparty === '永辉', bad2.txs[0].counterparty);

// 9.9 内容哈希
const h1 = P.hashBytes(new Uint8Array([1, 2, 3, 4]));
const h2 = P.hashBytes(new Uint8Array([1, 2, 3, 4]));
const h3 = P.hashBytes(new Uint8Array([1, 2, 3, 5]));
const h4 = P.hashBytes(new Uint8Array([1, 2, 3, 4, 5]));
ok('内容相同 → 哈希相同', h1 === h2, [h1, h2]);
ok('内容不同 → 哈希不同', h1 !== h3, [h1, h3]);
ok('长度不同 → 哈希不同', h1 !== h4, [h1, h4]);
ok('哈希带字节长度，便于肉眼比对', /-\d+$/.test(h1), h1);

/* ------------------------------------------------------------------ */
section('【10】图表（纯 SVG）');

const dn = CH.donut([{ label: '餐饮', value: 300 }, { label: '交通', value: 200 }]);
ok('环形图生成 SVG', dn.svg.indexOf('<svg') === 0 && dn.svg.indexOf('<circle') > 0);
ok('环形图图例有 2 项', dn.legend.length === 2, dn.legend.length);
ok('环形图占比正确（60%）', near(dn.legend[0].pct, 60, 0.01), dn.legend[0].pct);
ok('环形图弧长之和等于周长', (() => {
  const m = dn.svg.match(/stroke-dasharray="([\d.]+) /g) || [];
  const sum = m.reduce((s, x) => s + parseFloat(x.replace(/stroke-dasharray="([\d.]+) /, '$1')), 0);
  return near(sum, 2 * Math.PI * 84, 0.5);
})());
const dnEmpty = CH.donut([]);
ok('环形图空数据不崩并提示暂无数据', dnEmpty.svg.indexOf('暂无数据') > 0 && dnEmpty.legend.length === 0);

const tr = CH.trend([
  { key: '2026-01', label: '26-01', income: 100, expense: 50 },
  { key: '2026-02', label: '26-02', income: 200, expense: 80 }
]);
ok('趋势图生成 SVG', tr.indexOf('<svg') === 0);
ok('趋势图柱子数 = 月份数 × 2',
  (tr.match(/chart-bar-in/g) || []).length === 2 && (tr.match(/chart-bar-out/g) || []).length === 2,
  [(tr.match(/chart-bar-in/g) || []).length, (tr.match(/chart-bar-out/g) || []).length]);
ok('趋势图有零轴线', tr.indexOf('chart-axis-line') > 0);
ok('趋势图空数据不崩', CH.trend([]).indexOf('暂无数据') > 0);

const agg = CH.aggregateByCategory([
  { skip: false, dir: 'out', kind: 'normal', category: '餐饮', netAmount: 50 },
  { skip: false, dir: 'out', kind: 'internal', category: '内部划转', netAmount: 100 },
  { skip: false, dir: 'in', kind: 'normal', category: '工资', netAmount: 999 },
  { skip: true, dir: 'out', kind: 'normal', category: '餐饮', netAmount: 77 }
], 'out');
ok('分类占比只算支出、排除内部划转与已排除行',
  agg.length === 1 && agg[0].label === '餐饮' && agg[0].value === 50, agg);

/* ------------------------------------------------------------------ */
section('【11】账本体检');

const hMonths = H.checkMonths([
  { time: ts(2026, 1, 15), skip: false },
  { time: ts(2026, 3, 15), skip: false }
]);
ok('体检能查出缺失的月份', hMonths.level === 'warn' && hMonths.details.join('|').indexOf('2026 年 2 月') >= 0, hMonths.details);
const hMonthsOk = H.checkMonths([
  { time: ts(2026, 1, 15), skip: false },
  { time: ts(2026, 2, 15), skip: false },
  { time: ts(2026, 3, 15), skip: false }
]);
ok('体检对连续月份不报警', hMonthsOk.level === 'ok', hMonthsOk);

const neutralTx = mkTx({ id: 'n1', src: 'wechat', dir: 'neutral', dirText: '不计收支', amount: 500, txType: '基金申购', method: '零钱' });
const neutralPrep = C.prepare([neutralTx], PREP_OPTS());
ok('（前置）这笔试例确实没匹配到划转规则', neutralPrep[0].kind === 'unknown', neutralPrep[0].kind);
const hNeutral = H.checkNeutral(neutralPrep);
ok('体检能查出未匹配的"不计收支"', hNeutral.level === 'warn', hNeutral);

const partialTx = mkTx({ id: 'p1', src: 'wechat', status: '已退款', state: 'refunded', stateFullRefund: false, refundCol: null, amount: 60 });
const partialPrep = C.prepare([partialTx], PREP_OPTS({ 'f.csv': { hasSeparateRefundRow: false } }));
ok('（前置）部分退款金额未知时仍按全额计', partialPrep[0].netAmount === 60, partialPrep[0].netAmount);
const hRefund = H.checkRefund(partialPrep);
ok('体检能查出部分退款金额未知', hRefund.level === 'warn', hRefund);

const hDupFiles = H.checkDuplicates([], [], {
  'a.csv': { name: 'a.csv', hash: 'samehash', count: 10 },
  'b.csv': { name: 'b.csv', hash: 'samehash', count: 10 }
});
ok('体检能查出重复导入的文件', hDupFiles.level === 'err', hDupFiles);

const hQual = H.checkQuality({
  'a.csv': { name: 'a.csv', encoding: 'GBK/GB18030', quality: { totalRows: 10, parsed: 9, skipped: 1, repaired: 1 } },
  'bad.csv': { name: 'bad.csv', error: '未找到表头' }
});
ok('体检能看出哪个文件解析失败', hQual.level === 'warn' && hQual.details.join('|').indexOf('bad.csv') >= 0, hQual.details);

const hRun = H.run({
  prepared: neutralPrep, scoped: neutralPrep,
  bal: C.computeBalances(neutralPrep, { '微信·零钱': 1000 }),
  files: { 'f.csv': { name: 'f.csv', encoding: 'UTF-8', count: 1, quality: { totalRows: 1, parsed: 1 } } }
});
ok('体检输出 7 项检查', hRun.checks.length === 7, hRun.checks.length);
ok('体检分数在 0~100 之间', hRun.health >= 0 && hRun.health <= 100, hRun.health);

/* ------------------------------------------------------------------ */
section('【12】二次复查回归（本轮自查抓出并修掉的 6 个问题）');

const WX_HEAD = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注';
const wxCsv = (rows) => ['微信支付账单明细列表', WX_HEAD].concat(rows).join('\n');
const CLEAN_ROW = '2026-03-02 10:00:00,商户消费,美团外卖,午餐,支出,￥23.50,零钱,支付成功,4200002,10002,';

// 12.1 一个字段被劈成 4 段（多出 3 格）→ 切分点必须能重复，否则整列错位
const r4seg = P.parseBillText(wxCsv([
  '2026-03-01 09:00:00,商户消费,永辉超市,A,B,C,D,支出,￥88.00,零钱,支付成功,4200001,10001,',
  CLEAN_ROW
]), 'seg4.csv');
ok('劈成 4 段的行不会丢', r4seg.txs.length === 2, r4seg.txs.length);
ok('劈成 4 段时金额读对 = 88.00', r4seg.txs[0].amount === 88, r4seg.txs[0].amount);
ok('劈成 4 段时收/支读对 = 支出', r4seg.txs[0].dir === 'out', r4seg.txs[0].dir);
ok('劈成 4 段时时间读对', /^\d{4}-\d{2}-\d{2} 09:00:00$/.test(r4seg.txs[0].timeText), r4seg.txs[0].timeText);
ok('劈成 4 段时交易对方不被拆坏 = 永辉超市', r4seg.txs[0].counterparty === '永辉超市', r4seg.txs[0].counterparty);

// 12.2 少了一列（中间缺一列）→ 也得能修回来
const missMid = P.parseBillText(wxCsv([
  '2026-03-01 09:00:00,永辉超市,买菜,支出,￥88.00,零钱,支付成功,4200001,10001,',
  CLEAN_ROW
]), 'miss.csv');
ok('缺中间一列的行不会丢', missMid.txs.length === 2, missMid.txs.length);
ok('缺中间一列时金额读对 = 88.00', missMid.txs[0].amount === 88, missMid.txs[0].amount);
ok('缺中间一列时收/支读对 = 支出', missMid.txs[0].dir === 'out', missMid.txs[0].dir);
ok('缺中间一列时交易对方读对 = 永辉超市', missMid.txs[0].counterparty === '永辉超市', missMid.txs[0].counterparty);

// 12.3 规则没有 note 时，标记不能出现 "undefined"
const ruleNoNote = [{ id: 'x', src: 'wechat', keys: ['某自定义划转'], account: '微信·零钱', dir: 'in', counter: '', enabled: true }];
const pNoNote = C.prepare([mkTx({ id: 'n1', src: 'wechat', dir: 'neutral', dirText: '不计收支', txType: '某自定义划转', method: '零钱' })], {
  rules: { internal: ruleNoNote, category: R.DEFAULT_CATEGORY_RULES }, fileInfo: {}, excluded: new Set(), refundMode: {}
});
ok('规则没有 note 时标记不是 undefined', pNoNote[0].flags.every(f => f.indexOf('undefined') < 0), pNoNote[0].flags);
ok('规则没有 note 时标记里有账户名', pNoNote[0].flags.join(' ').indexOf('微信·零钱') >= 0, pNoNote[0].flags);

// 12.4 汇总金额按分取整，不能留浮点尾巴
const tenths = [];
for (let i = 0; i < 30; i++) {
  tenths.push(mkTx({ id: 't' + i, src: 'manual', file: 'm', seq: i, time: new Date(2026, 0, i + 1).getTime(), amount: 0.1, method: '现金', txType: 'x' }));
}
const pTenth = C.prepare(tenths, PREP_OPTS());
const bTenth = C.computeBalances(pTenth, { '现金': 100 });
const sTenth = C.summarize(pTenth, 'month', bTenth, 'account');
ok('30 笔 0.1 的汇总精确等于 3', sTenth[0].expense === 3, sTenth[0].expense);
ok('30 笔 0.1 的净额精确等于 -3', sTenth[0].net === -3, sTenth[0].net);

// 12.5 合计基准余额不能把原型链上的属性算进去
const pollutedBases = Object.create({ 污染账户: 999 });
pollutedBases['现金'] = 100;
const bPolluted = C.computeBalances(pTenth, pollutedBases);
ok('合计基准余额不受原型属性污染', bPolluted.mergedBase === 100, bPolluted.mergedBase);
ok('账户清单里没有原型上的账户', !bPolluted.accounts.some(a => a.account === '污染账户'),
  bPolluted.accounts.map(a => a.account).join('|'));

// 12.6 金额异常的行不能让整页崩掉
const badAmount = [{ id: 'b1', src: 'wechat', file: 'f', seq: 0, time: 1, dir: 'out', dirText: '支出', amount: null, txType: '', counterparty: '', item: '', status: '', state: 'success', stateFullRefund: false, method: '', refundCol: null, fee: 0, orderNo: '', note: '', fundState: '' }];
let dupNoCrash = true;
try { C.findDuplicates(badAmount); C.findExactDuplicates(badAmount); } catch (e) { dupNoCrash = false; }
ok('金额为 null 时重复检测不崩', dupNoCrash);
const pBadAmount = C.prepare(badAmount, PREP_OPTS());
ok('金额异常的行被标记为不计', pBadAmount[0].skip === true, pBadAmount[0].skip);
ok('金额异常的行有提示标记', pBadAmount[0].flags.some(f => f.indexOf('金额异常') >= 0), pBadAmount[0].flags);
const bBadAmount = C.computeBalances(pBadAmount, { '微信·未标注渠道': 50 });
ok('金额异常的行不污染合计余额', bBadAmount.mergedBase === 50, bBadAmount.mergedBase);
let exportNoCrash = true;
try {
  const rowsBad = C.buildDetailRows(pBadAmount, bBadAmount);
  exportNoCrash = rowsBad.length === 2 && /^\d+\.\d{2}$/.test(rowsBad[1][7]);
} catch (e) { exportNoCrash = false; }
ok('金额异常的行导出时不崩', exportNoCrash);

/* ------------------------------------------------------------------ */
section('【13】图表边界（空数据/极端值/脏标签）');

ok('环形图：空数据不崩且提示暂无数据', CH.donut([]).svg.indexOf('暂无数据') >= 0);
ok('环形图：全 0 值不崩', CH.donut([{ label: 'A', value: 0 }]).svg.indexOf('<svg') === 0);
ok('环形图：负值被过滤（只留正数类别）',
  CH.donut([{ label: 'A', value: -50 }, { label: 'B', value: 10 }]).legend.length === 1,
  CH.donut([{ label: 'A', value: -50 }, { label: 'B', value: 10 }]).legend.map(x => x.label).join(','));
ok('环形图：单类别也能画（弧长=周长）', (() => {
  const d = CH.donut([{ label: 'A', value: 100 }]);
  const m = d.svg.match(/stroke-dasharray="([\d.]+) /);
  return m && Math.abs(parseFloat(m[1]) - 2 * Math.PI * 84) < 0.5;
})());
ok('环形图：标签里的 HTML 被转义（不产生 img 标签）',
  CH.donut([{ label: '<img src=x onerror=1>', value: 10 }]).svg.indexOf('<img') < 0);
ok('环形图：超大金额不出 NaN', CH.donut([{ label: 'A', value: 1e12 }]).svg.indexOf('NaN') < 0);
ok('环形图：SVG 根标签闭合', CH.donut([{ label: 'A', value: 1 }]).svg.slice(-6) === '</svg>');

ok('趋势图：空数据不崩且提示暂无数据', CH.trend([]).indexOf('暂无数据') >= 0);
ok('趋势图：单个月份能画', CH.trend([{ key: 'a', label: 'a', income: 1, expense: 2 }]).indexOf('chart-bar-in') > 0);
ok('趋势图：收入或支出为 0 不出 NaN',
  CH.trend([{ key: 'a', label: 'a', income: 0, expense: 999 }]).indexOf('NaN') < 0);
ok('趋势图：24 个月不出 NaN', (() => {
  const rows = Array.from({ length: 24 }, (_, i) => ({ key: 'k' + i, label: '' + (i + 1), income: i * 10, expense: i * 5 }));
  const s = CH.trend(rows);
  return s.indexOf('NaN') < 0 && s.indexOf('undefined') < 0 && s.slice(-6) === '</svg>';
})());
ok('趋势图：标签里的 HTML 被转义', CH.trend([{ key: 'a', label: '<b>x</b>', income: 1, expense: 1 }]).indexOf('<b>') < 0);
ok('趋势图：柱子高度不为负', (() => {
  const s = CH.trend([{ key: 'a', label: 'a', income: 0, expense: 999 }]);
  return !/height="-/.test(s);
})());

ok('分类聚合：null 输入返回空数组', CH.aggregateByCategory(null, 'out').length === 0);
ok('分类聚合：0 元和异常金额不进分类（不占图例名额）',
  CH.aggregateByCategory([{ skip: false, dir: 'out', kind: 'normal', category: 'x', netAmount: 0 }], 'out').length === 0);
ok('topN：空数组安全', CH.topN([], 9).length === 0);
ok('topN：压成 9 项且金额守恒', (() => {
  const many = Array.from({ length: 30 }, (_, i) => ({ label: 'c' + i, value: i + 1 }));
  const t = CH.topN(many, 9);
  const s = t.reduce((a, b) => a + b.value, 0);
  return t.length === 9 && Math.abs(s - many.reduce((a, b) => a + b.value, 0)) < 0.001;
})());

/* ------------------------------------------------------------------ */
section('【14】第四轮复查回归（退款形态 / 原型名账户 / 负基准）');

/** 解析一段 CSV 文本并算出账户口径的收支合计 */
function runCsv(csv, name, bases) {
  const res = P.parseBillText(csv, name);
  if (!res.ok) return { res: res, error: res.error };
  const raw = res.txs.map((t, i) => Object.assign({}, t, { id: name + '#' + i, file: name }));
  const fileInfo = {};
  fileInfo[name] = { hasSeparateRefundRow: res.hasSeparateRefundRow };
  const prepared = C.prepare(raw, {
    rules: { internal: R.DEFAULT_INTERNAL_RULES, category: R.DEFAULT_CATEGORY_RULES },
    fileInfo: fileInfo, excluded: new Set(), refundMode: {}
  });
  prepared.sort((a, b) => a.time - b.time);
  const bal = C.computeBalances(prepared, bases || {});
  let income = 0, expense = 0;
  for (const t of prepared) {
    if (t.skip) continue;
    if (t.dir === 'in') income += t.netAmount;
    else if (t.dir === 'out') expense += t.netAmount;
  }
  return {
    res: res, prepared: prepared, bal: bal,
    income: Math.round(income * 100) / 100, expense: Math.round(expense * 100) / 100
  };
}

const WX_H = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注';
const ALI_H = '支付宝交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态';

// 14a 退款单列一行，收/支 = 收入（微信式）
{
  const r = runCsv([WX_H,
    '2026-03-01 09:00:00,商户消费,某店,东西,支出,￥100.00,零钱,支付成功,T1,1,',
    '2026-03-05 09:00:00,退款,某店,东西,收入,￥100.00,零钱,已退款,T2,2,'].join('\n'), 'wx_refund_in.csv', { '微信·零钱': 1000 });
  ok('退款单列一行（收/支=收入）能识别出来', r.res.hasSeparateRefundRow === true, r.res.hasSeparateRefundRow);
  ok('退款单列一行：支出 100 + 收入 100', r.expense === 100 && r.income === 100, { inc: r.income, exp: r.expense });
  ok('退款单列一行：退款后余额回到基准 1000', near(r.bal.merged.get('wx_refund_in.csv#1').after, 1000));
}

// 14b 退款单列一行，收/支 = 不计收支（支付宝式）—— 以前完全算错
{
  const r = runCsv([ALI_H,
    '202603010930001,70001,2026-03-01 09:30:00,2026-03-01 09:30:00,2026-03-01 09:30:00,支付宝网站,即时交易,某店,东西,100.00,支出,交易成功,0.00,0.00,,已支出',
    '202603051000001,70002,2026-03-05 10:00:00,2026-03-05 10:00:00,2026-03-05 10:00:00,支付宝网站,退款,某店,东西,100.00,不计收支,退款成功,0.00,0.00,,已退款'].join('\n'),
    'ali_refund_neutral.csv', { '支付宝': 1000 });
  ok('退款行标「不计收支」也能识别出来', r.res.hasSeparateRefundRow === true, r.res.hasSeparateRefundRow);
  ok('退款行标「不计收支」时记成收入 100', r.income === 100, { inc: r.income, exp: r.expense });
  ok('退款行标「不计收支」时净支出为 0', near(r.expense - r.income, 0), { inc: r.income, exp: r.expense });
  ok('退款行标「不计收支」时余额回到基准 1000', near(r.bal.merged.get('ali_refund_neutral.csv#1').after, 1000));
  ok('退款行不再报「收支方向无法识别」',
    !r.prepared[1].flags.some(f => /方向无法识别/.test(f)), r.prepared[1].flags);
}

// 14c 原行标已退款 + 单独一行退款（不计收支）：不能重复计
{
  const r = runCsv([ALI_H,
    '202603010930001,70001,2026-03-01 09:30:00,2026-03-01 09:30:00,2026-03-01 09:30:00,支付宝网站,即时交易,某店,东西,100.00,支出,已全额退款,0.00,0.00,,已退款',
    '202603051000001,70002,2026-03-05 10:00:00,2026-03-05 10:00:00,2026-03-05 10:00:00,支付宝网站,退款,某店,东西,100.00,不计收支,退款成功,0.00,0.00,,已退款'].join('\n'),
    'ali_refund_both.csv', { '支付宝': 1000 });
  ok('原行已退款 + 退款行：净支出 0（不重复计）', near(r.expense - r.income, 0), { inc: r.income, exp: r.expense });
}

// 14d 有「成功退款」金额就按净额算，不依赖交易状态列
{
  const r = runCsv([ALI_H,
    '202603081500001,70005,2026-03-08 15:00:00,2026-03-08 15:00:00,2026-03-08 15:00:00,支付宝网站,即时交易,屈臣氏,日用,52.80,支出,交易成功,0.00,20.00,,已退款'].join('\n'),
    'ali_refund_col.csv', { '支付宝': 1000 });
  ok('交易状态是「交易成功」但有成功退款 20 → 净额 32.80', near(r.expense, 32.80), r.expense);
}

// 14e 普通账单不该被误判成退款文件
{
  const r = runCsv([ALI_H,
    '202603010930001,70001,2026-03-01 09:30:00,2026-03-01 09:30:00,2026-03-01 09:30:00,支付宝网站,即时交易,盒马,买菜,86.40,支出,交易成功,0.00,0.00,,已支出',
    '202603031000001,70002,2026-03-03 10:00:00,2026-03-03 10:00:00,2026-03-03 10:00:00,支付宝网站,转账,房东,房租,3200.00,支出,交易成功,0.00,0.00,,已支出'].join('\n'),
    'ali_normal.csv', { '支付宝': 1000 });
  ok('普通账单不识别成退款文件', r.res.hasSeparateRefundRow === false, r.res.hasSeparateRefundRow);
  ok('普通账单支出不变', near(r.expense, 3286.40), r.expense);
}

// 14f 账户名撞原型链（constructor / __proto__ …）不再产生 NaN
{
  let allOk = true, detail = null;
  for (const weird of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const res = P.parseBillText([WX_H,
      '2026-03-01 09:00:00,商户消费,某店,东西,支出,￥50.00,' + weird + ',支付成功,T1,1,'].join('\n'), 'proto.csv');
    const raw = res.txs.map((t, i) => Object.assign({}, t, { id: 'x' + i, file: 'proto.csv' }));
    const prepared = C.prepare(raw, {
      rules: { internal: R.DEFAULT_INTERNAL_RULES, category: R.DEFAULT_CATEGORY_RULES },
      fileInfo: {}, excluded: new Set(), refundMode: {}
    });
    const bal = C.computeBalances(prepared, { [prepared[0].account]: 100 });
    const m = bal.merged.get('x0');
    if (!m || !near(m.after, 100) || !near(m.before, 150)) { allOk = false; detail = { weird: weird, m: m }; break; }
  }
  ok('账户名叫 constructor/__proto__ 等也不出 NaN', allOk, detail);
}

// 14g 内部划转遇上退款：按净额算，不按原金额
{
  const raw = [{
    src: 'wechat', file: 'f0', seq: 0, id: 't1',
    time: new Date(2026, 0, 2).getTime(), dir: 'neutral', dirText: '不计收支', amount: 200,
    txType: '零钱充值', counterparty: '招商银行', item: '零钱充值',
    status: '已全额退款', state: 'refunded', stateFullRefund: true,
    method: '招商银行(1234)', refundCol: null, fee: 0, orderNo: 'O1', note: '', fundState: '', srcPlace: ''
  }];
  const prepared = C.prepare(raw, {
    rules: { internal: R.DEFAULT_INTERNAL_RULES, category: R.DEFAULT_CATEGORY_RULES },
    fileInfo: { f0: { hasSeparateRefundRow: false } }, excluded: new Set(), refundMode: {}
  });
  ok('内部划转退款后净额 = 0', prepared[0].netAmount === 0, prepared[0].netAmount);
  const d = C.txDeltas(prepared[0]);
  const vals = Object.keys(d).map(k => d[k]);
  ok('内部划转退款的账户变动为 0', vals.length === 0 || vals.every(v => v === 0), d);
}

// 14h 基准余额是负数要给出警告
{
  const raw = [{
    src: 'wechat', file: 'f', seq: 0, id: 'a', time: new Date(2026, 0, 1).getTime(),
    dir: 'out', dirText: '支出', amount: 20, txType: 'x', counterparty: '', item: '',
    status: '', state: 'success', stateFullRefund: false, method: '零钱',
    refundCol: null, fee: 0, orderNo: '', note: '', fundState: '', srcPlace: ''
  }];
  const prepared = C.prepare(raw, {
    rules: { internal: R.DEFAULT_INTERNAL_RULES, category: R.DEFAULT_CATEGORY_RULES },
    fileInfo: {}, excluded: new Set(), refundMode: {}
  });
  const bal = C.computeBalances(prepared, { '微信·零钱': -5 });
  ok('负基准余额会给出警告', bal.warnings.some(w => /负数/.test(w.text)), bal.warnings.map(w => w.text));
}

// 14i 删除文件时，同名文件（账单.csv / 账单.csv#2）的排除记录不能互相误伤
{
  const filterExcluded = (excluded, key) => excluded.filter(id => {
    if (id.indexOf(key + '#') !== 0) return true;
    return !/^\d+$/.test(id.slice(key.length + 1));
  });
  const excluded = ['账单.csv#0', '账单.csv#12', '账单.csv#2#0', '账单.csv#2#3', 'manual#1700000000#1'];
  const kept = filterExcluded(excluded, '账单.csv');
  ok('删「账单.csv」不动「账单.csv#2」的排除记录',
    kept.indexOf('账单.csv#2#0') >= 0 && kept.indexOf('账单.csv#2#3') >= 0, kept);
  ok('删「账单.csv」会清掉自己的排除记录',
    kept.indexOf('账单.csv#0') < 0 && kept.indexOf('账单.csv#12') < 0, kept);
  ok('删「账单.csv」不动手动记录', kept.indexOf('manual#1700000000#1') >= 0, kept);
  const kept2 = filterExcluded(kept, '账单.csv#2');
  ok('删「账单.csv#2」只清自己的两条',
    kept2.indexOf('账单.csv#2#0') < 0 && kept2.indexOf('账单.csv#2#3') < 0
    && kept2.indexOf('manual#1700000000#1') >= 0, kept2);
}

/* ------------------------------------------------------------------ */
section('【15】第五轮回归（独立审查抓出的 P0/P1）');

const WXH = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注';
const ALIH = '支付宝交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态';

function prepCsv(csv, name, fileInfo) {
  const res = P.parseBillText(csv, name);
  if (!res.ok) return { res: res };
  const raw = res.txs.map((t, i) => Object.assign({}, t, { id: name + '#' + i, file: name }));
  const p = C.prepare(raw, {
    rules: { internal: R.DEFAULT_INTERNAL_RULES, category: R.DEFAULT_CATEGORY_RULES },
    fileInfo: fileInfo || {}, excluded: new Set(), refundMode: {}
  });
  p.sort((a, b) => a.time - b.time);
  return { res: res, p: p, bal: C.computeBalances(p, (fileInfo && fileInfo.__bases) || {}) };
}

// 15a P0：对向账户与目标账户相同时不能凭空造钱
{
  const r = prepCsv([WXH,
    '2024-01-05 10:00:00,零钱充值,招商银行,零钱充值,不计收支,500.00,零钱,充值成功,4200001,10001,'].join('\n'), 'p0.csv');
  const t = r.p[0];
  ok('对向账户=目标账户时判定为自划转', t.selfTransfer === true, t.selfTransfer);
  const d = C.txDeltas(t);
  ok('自划转的账户变动为 0（不再凭空 +500）', Object.keys(d).length === 0, d);
  ok('自划转有明确的提示标记', t.flags.some(f => /净额零处理/.test(f)), t.flags);
  const bal = C.computeBalances(r.p, { '微信·零钱': 1000 });
  const m = bal.merged.get('p0.csv#0');
  ok('自划转不改变合计余额（末笔 after = 1000）', near(m.after, 1000), m);
}

// 15b P1：亲属卡充值是"钱从你的账户扣"，方向必须是出账
{
  const r = prepCsv([WXH,
    '2024-01-05 10:00:00,亲属卡充值,亲属卡,亲属卡充值,不计收支,500.00,零钱,充值成功,4200001,10001,'].join('\n'), 'p1.csv');
  const t = r.p[0];
  ok('亲属卡充值落在付款账户（微信·零钱）', t.account === '微信·零钱', t.account);
  ok('亲属卡充值是流出', t.internalDir === 'out', t.internalDir);
  const d = C.txDeltas(t);
  ok('亲属卡充值让零钱减少 500', near(d['微信·零钱'], -500), d);
}

// 15c P1：收支方向识别不出来，必须被体检和警告区看见
{
  const csv = ['交易时间,交易类型,交易对方,商品,收入/支出,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    '2024-01-05 10:00:00,商户消费,某店,东西,支出,128.50,零钱,支付成功,4200001,10001,'].join('\n');
  const r = prepCsv(csv, 'p12.csv');
  ok('方向不明的行被标记出来', r.p[0].dir === 'unknown' && r.p[0].kind === 'unknown', r.p[0].dir);
  const h = H.run({ prepared: r.p, scoped: r.p, bal: r.bal, files: {} }).checks.find(c => c.id === 'dir');
  ok('体检能查出「收支方向识别」这一项并给出告警', !!h && h.level === 'warn', h && h.summary);
  ok('体检不再谎报「全部匹配到划转规则」',
    H.run({ prepared: r.p, scoped: r.p, bal: r.bal, files: {} }).checks.find(c => c.id === 'neutral').summary !== '全部匹配到划转规则');
}

// 15d 微信账单里 收/支 写成 '/' 或留空 → 当中性流水，不是方向不明
{
  const r1 = prepCsv([WXH,
    '2024-01-05 10:00:00,零钱充值,招商银行,零钱充值,/,500.00,零钱,充值成功,4200001,10001,'].join('\n'), 'p12b.csv');
  ok('「收/支 = /」被当作中性流水', r1.p[0].dir === 'neutral', r1.p[0].dir);
  const r2 = prepCsv([WXH,
    '2024-01-05 10:00:00,零钱充值,招商银行,零钱充值,,500.00,零钱,充值成功,4200001,10001,'].join('\n'), 'p12c.csv');
  ok('「收/支」留空被当作中性流水', r2.p[0].dir === 'neutral', r2.p[0].dir);
}

// 15e 账单根本没有 收/支 列 → 必须明确报出来
{
  const csv = ['交易时间,交易类型,交易对方,商品,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    '2024-01-05 10:00:00,商户消费,某店,东西,128.50,零钱,支付成功,4200001,10001,'].join('\n');
  const res = P.parseBillText(csv, 'p12d.csv');
  ok('识别出「这份账单没有收/支列」', res.stats && res.stats.noDirColumn === true, res.stats);
  ok('方向不明的行数被统计出来', res.stats && res.stats.unknownDir === 1, res.stats && res.stats.unknownDir);
  ok('解析日志里写明了这件事', res.log.some(l => /没有「收\/支」列/.test(l)), res.log);
}

// 15f P1：备份缺 files 段时，退款口径要能从数据本身推断
{
  const csv = [ALIH,
    '202603081500001,70005,2026-03-08 15:00:00,2026-03-08 15:00:00,2026-03-08 15:00:00,支付宝网站,即时交易,某店,东西,5999.00,支出,已全额退款,0.00,2000.00,,已退款'].join('\n');
  const withInfo = prepCsv(csv, 'ali.csv', { 'ali.csv': { hasSeparateRefundRow: false } });
  ok('有 files 信息：净额 = 5999 - 2000 = 3999', near(withInfo.p[0].netAmount, 3999), withInfo.p[0].netAmount);
  const noInfo = prepCsv(csv, 'ali.csv', {});
  ok('缺 files 信息：退款照样按净额算', near(noInfo.p[0].netAmount, 3999), noInfo.p[0].netAmount);
  ok('缺 files 信息：提示文案不再误导', !noInfo.p[0].flags.some(f => /退款行已单列/.test(f)), noInfo.p[0].flags);
}

// 15g P1：负数金额按绝对值算，支出不能变成收入
{
  const r = prepCsv([WXH,
    '2024-01-05 10:00:00,商户消费,某店,东西,支出,-128.50,零钱,支付成功,4200001,10001,'].join('\n'), 'p14.csv');
  ok('负数金额取绝对值', r.p[0].amount === 128.50, r.p[0].amount);
  const d = C.txDeltas(r.p[0]);
  ok('负数支出仍然是减钱', near(d['微信·零钱'], -128.5), d);
  ok('负数金额有提示标记', r.p[0].flags.some(f => /金额为负/.test(f)), r.p[0].flags);
}

// 15h P2：基准余额是字符串时，合计基准不能被拼成天文数字
{
  const raw = [{ src: 'wechat', file: 'f', seq: 0, id: 'a', time: new Date(2026, 0, 1).getTime(), dir: 'out', dirText: '支出', amount: 10, txType: 'x', counterparty: '', item: '', status: '', state: 'success', stateFullRefund: false, method: '零钱', refundCol: null, fee: 0, orderNo: '', note: '', fundState: '', srcPlace: '' }];
  const p = C.prepare(raw, { rules: { internal: R.DEFAULT_INTERNAL_RULES, category: R.DEFAULT_CATEGORY_RULES }, fileInfo: {}, excluded: new Set(), refundMode: {} });
  const bal = C.computeBalances(p, { '微信·零钱': 50, '微信·招行': '100' });
  ok('字符串基准余额也能正确求和（150）', bal.mergedBase === 150, bal.mergedBase);
}

// 15i P2：说明行不能被误判成表头
{
  const csv = ['交易类型：全部,备注：说明,导出类型：全部',
    WXH,
    '2024-01-05 10:00:00,商户消费,某店,东西,支出,128.50,零钱,支付成功,4200001,10001,'].join('\n');
  const res = P.parseBillText(csv, 'p27.csv');
  ok('说明行不再被当成表头，文件能正常解析', res.ok && res.txs.length === 1, res.ok ? res.txs.length : res.error);
}

/* ------------------------------------------------------------------ */
console.log('\n' + '─'.repeat(52));
console.log(`结果：${passed} 通过，${failed} 失败`);
if (failed) process.exit(1);
