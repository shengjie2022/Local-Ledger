/* =========================================================================
 * rules.js —— 规则表（可编辑，存本地）
 *
 * 1) 内部划转规则：把"不计收支"的流水落到具体账户与方向上。
 *    例：微信零钱提现 → 微信·零钱 减少；微信零钱充值 → 微信·零钱 增加。
 *    counter 为对向账户；"{method}"是占位符，代表该行"支付方式"列推导出的账户。
 * 2) 分类规则：按关键词把流水归类，用于账本"条理清晰"。
 *    顺序即优先级，第一条命中即生效。
 * ========================================================================= */
window.LedgerRules = (function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 内部划转规则
   * dir: 'in' 资金进入 account / 'out' 资金离开 account
   * counter: 对向账户；空表示对向账户未知（资金离开已统计范围）
   *
   * 关于「亲属卡充值」：微信官方口径是"钱从你的账户里扣，不是转给对方账户"，
   * 对方只是拿到消费额度。所以它是**出账**：付款账户（支付方式列）减钱，
   * 亲属卡在账本范围之外。以前写成 account='微信·零钱', dir='in'，
   * 等于"给亲属卡充钱反而自己的零钱变多"，方向是反的。
   * ------------------------------------------------------------------ */
  const DEFAULT_INTERNAL_RULES = [
    // —— 微信 ——
    { id: 'wx_lqcz', src: 'wechat', keys: ['零钱充值', '零钱转入'], account: '微信·零钱', dir: 'in', counter: '微信·{method}', enabled: true, note: '零钱充值：零钱增加，来源账户(通常是银行卡)减少' },
    { id: 'wx_lqtx', src: 'wechat', keys: ['零钱提现', '零钱转出'], account: '微信·零钱', dir: 'out', counter: '', enabled: true, note: '零钱提现：零钱减少' },
    { id: 'wx_lqtt_in', src: 'wechat', keys: ['零钱通转入', '转入零钱通'], account: '微信·零钱通', dir: 'in', counter: '微信·零钱', enabled: true, note: '零钱→零钱通' },
    { id: 'wx_lqtt_out', src: 'wechat', keys: ['零钱通转出', '零钱通赎回', '零钱通转回'], account: '微信·零钱', dir: 'in', counter: '微信·零钱通', enabled: true, note: '零钱通→零钱' },
    { id: 'wx_qinshu', src: 'wechat', keys: ['亲属卡充值'], account: '微信·{method}', dir: 'out', counter: '', enabled: true, note: '亲属卡充值：钱从你的账户划到亲属卡的额度里' },

    // —— 支付宝 ——
    { id: 'ali_yeb_in', src: 'alipay', keys: ['余额宝转入', '转入余额宝'], account: '支付宝', dir: 'out', counter: '支付宝·余额宝', enabled: true, note: '支付宝余额→余额宝' },
    { id: 'ali_yeb_out', src: 'alipay', keys: ['余额宝转出', '余额宝赎回', '余额宝转回'], account: '支付宝', dir: 'in', counter: '支付宝·余额宝', enabled: true, note: '余额宝→支付宝余额' },
    { id: 'ali_cz', src: 'alipay', keys: ['余额充值', '账户充值', '充值'], account: '支付宝', dir: 'in', counter: '', enabled: true, note: '余额充值：支付宝余额增加' },
    { id: 'ali_tx', src: 'alipay', keys: ['提现', '账户转出', '转出至银行卡'], account: '支付宝', dir: 'out', counter: '', enabled: true, note: '支付宝余额提现' },
    { id: 'ali_xyk', src: 'alipay', keys: ['信用卡还款', '花呗还款', '花呗账单分期'], account: '支付宝', dir: 'out', counter: '', enabled: true, note: '用支付宝余额还信用卡/花呗' }
  ];

  /* ------------------------------------------------------------------ *
   * 分类规则（顺序即优先级）
   * ------------------------------------------------------------------ */
  const DEFAULT_CATEGORY_RULES = [
    { id: 'c_food', cat: '餐饮', keys: ['美团', '饿了么', '肯德基', '麦当劳', '星巴克', '瑞幸', '蜜雪冰城', '喜茶', '奈雪', '海底捞', '必胜客', '汉堡', '火锅', '烧烤', '快餐', '外卖', '餐厅', '饭店', '食堂', '美食', '小吃', '面馆', '咖啡', '饮品', '餐饮', '食品', '蛋糕', '茶饮', 'food', 'cafe', 'restaurant'], enabled: true },
    { id: 'c_traffic', cat: '交通', keys: ['滴滴', '地铁', '公交', '打车', '出行', '高铁', '火车', '机票', '航空', '加油', '停车', 'etc', 'taxi', 'uber', '高德', '12306', '铁路', '车票'], enabled: true },
    { id: 'c_house', cat: '居住', keys: ['房租', '租金', '物业', '物业费', '水费', '电费', '燃气', '天然气', '取暖费', '供暖', '公寓', '中介费', '押金'], enabled: true },
    { id: 'c_comm', cat: '通讯', keys: ['话费', '流量', '宽带', '通信', '充值中心', '三大运营商', '中国移动', '中国联通', '中国电信'], enabled: true },
    { id: 'c_shop', cat: '购物', keys: ['淘宝', '天猫', '京东', '拼多多', '唯品会', '抖音商城', '小米商城', '商场', '百货', '优衣库', '网购', '商城', '得物', '小红书', '闲鱼', '小米有品'], enabled: true },
    { id: 'c_daily', cat: '日用', keys: ['超市', '便利店', '全家', '罗森', '7-11', '屈臣氏', '纸巾', '洗发', '牙膏', '日用', '家清', '洗衣', '生鲜', '盒马', '永辉', '大润发', '家乐福', '华润万家', '山姆', '叮咚', '买菜', '菜市场', '蔬菜', '水果', '钱大妈', '每日优鲜'], enabled: true },
    { id: 'c_life', cat: '生活', keys: ['快递', '物流', '中通', '顺丰', '圆通', '申通', '韵达', '菜鸟', '邮政', '家政', '理发', '美容', '干洗', '开锁', '搬家'], enabled: true },
    { id: 'c_med', cat: '医疗', keys: ['医院', '药店', '药房', '挂号', '体检', '医疗', '诊所', '口腔', '疫苗', '急诊'], enabled: true },
    { id: 'c_edu', cat: '教育', keys: ['学费', '培训', '网课', '课程', '书店', '图书', '文具', '考试', '报名费', '驾校', '辅导'], enabled: true },
    { id: 'c_fun', cat: '娱乐', keys: ['电影', '影院', '影城', '游戏', '会员', '视频', '音乐', 'steam', '演出', '门票', 'ktv', '健身', '游泳', '瑜伽', '密室', '剧本杀', '台球', '猫眼', '剧场', '订阅'], enabled: true },
    { id: 'c_gift', cat: '人情', keys: ['红包', '礼物', '随礼', '转账给', '份子钱', '请客', '孝敬', '压岁钱', '慰问'], enabled: true },
    { id: 'c_pet', cat: '宠物', keys: ['猫粮', '狗粮', '猫砂', '宠物', '驱虫', '猫', '狗'], enabled: true },
    { id: 'c_digital', cat: '数码', keys: ['手机', '电脑', '数码', '耳机', '相机', '平板', '显示器', '充电器', '外设'], enabled: true },
    { id: 'c_cloth', cat: '服饰', keys: ['衣服', '外套', '裤子', '裙子', '内衣', '袜子', '球鞋', '服饰', '鞋'], enabled: true },
    { id: 'c_ins', cat: '保险', keys: ['保险', '保费', '医保补充', '重疾', '意外险'], enabled: true }
  ];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ------------------------------------------------------------------ *
   * 匹配：命中关键词最长的规则优先（更具体的优先）
   * ------------------------------------------------------------------ */
  function matchInternalRule(tx, rules) {
    const blob = [tx.txType, tx.item, tx.counterparty, tx.note, tx.fundState, tx.status].join(' ');
    if (!blob.trim()) return null;
    let best = null;
    let bestLen = 0;
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      if (rule.src && rule.src !== 'any' && tx.src && rule.src !== tx.src) continue;
      for (const k of rule.keys || []) {
        if (blob.includes(k) && k.length > bestLen) {
          best = rule; bestLen = k.length;
        }
      }
    }
    return best ? { rule: best, keyword: bestLen } : null;
  }

  function matchCategory(tx, rules) {
    const blob = [tx.item, tx.counterparty, tx.txType, tx.note].join(' ').toLowerCase();
    if (!blob.trim()) return '其他';
    for (const rule of rules) {
      if (rule.enabled === false) continue;
      for (const k of rule.keys || []) {
        if (blob.includes(String(k).toLowerCase())) return rule.cat;
      }
    }
    return '其他';
  }

  /** 把规则的 counter 占位符展开成真实账户名 */
  function resolveAccountName(template, tx) {
    if (!template) return null;
    if (template.includes('{method}')) {
      const m = (tx.method || '').trim();
      if (!m) return null;
      return template.split('{method}').join(m);
    }
    return template;
  }

  return {
    DEFAULT_INTERNAL_RULES,
    DEFAULT_CATEGORY_RULES,
    clone,
    matchInternalRule,
    matchCategory,
    resolveAccountName
  };
})();
