/* =========================================================================
 * ui.js —— 界面与交互
 *
 * 数据流：raw(原始行) → prepare(归一化) → computeBalances(倒推) → applyFilters(视图)
 * ========================================================================= */
(function () {
  'use strict';

  const P = window.LedgerParse;
  const C = window.LedgerCalc;
  const R = window.LedgerRules;
  const S = window.LedgerStore;
  const CH = window.LedgerCharts;
  const H = window.LedgerHealth;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */
  function defaultSettings() {
    return {
      mode: 'account',
      groupBy: 'month',
      view: 'summary',
      baseDate: '',
      baseDateAuto: true,          // 用户手动改过基准日后就不再被自动覆盖
      bases: Object.create(null),
      extraAccounts: [],
      excluded: [],
      excludeKeywords: '',
      filters: { from: '', to: '', keyword: '', dir: 'all', account: 'all', category: 'all' },
      rules: { internal: R.clone(R.DEFAULT_INTERNAL_RULES), category: R.clone(R.DEFAULT_CATEGORY_RULES) },
      refundMode: {}
    };
  }

  const state = {
    raw: [],
    files: {},
    settings: defaultSettings(),
    prepared: [],
    scoped: [],
    filtered: [],
    bal: null,
    page: 1,
    pageSize: 120
  };

  const SOURCE_LABEL = { wechat: '微信', alipay: '支付宝', manual: '手记', unknown: '未知' };

  /* ------------------------------------------------------------------ *
   * 持久化
   * ------------------------------------------------------------------ */
  let saveTimer = null;

  function scheduleSave() {
    $('saveBadge').textContent = '保存中…';
    $('saveBadge').className = 'badge';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; void doSave(); }, 500);
  }

  async function doSave() {
    const payload = { v: 1, raw: state.raw, files: state.files, settings: state.settings };
    const res = await S.save('workspace', payload);
    const mode = res.mode || S.currentMode();
    const badge = $('saveBadge');
    if (res.ok) {
      badge.textContent = mode === 'idb' ? '已保存到本机' : (mode === 'localStorage' ? '已保存（兼容模式）' : '仅本次会话');
      badge.className = 'badge ' + (mode === 'memory' ? 'warn' : 'ok');
    } else {
      badge.textContent = '保存失败';
      badge.className = 'badge err';
      toast(res.error || '保存失败，请导出备份', true);
    }
  }

  function normalizeWorkspace(data) {
    const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (!obj(data) || !Array.isArray(data.raw) || (data.v != null && data.v !== 1)) throw new Error('不支持的备份格式');
    for (const t of data.raw) {
      if (!obj(t) || typeof t.amount !== 'number' || !Number.isFinite(t.amount) ||
          typeof t.time !== 'number' || !Number.isFinite(new Date(t.time).getTime())) throw new Error('交易金额或时间无效');
      for (const k of ['id', 'src', 'file', 'dir', 'dirText', 'txType', 'counterparty', 'item', 'status', 'state', 'method', 'note', 'fundState', 'orderNo']) {
        if (t[k] != null && typeof t[k] !== 'string') throw new Error('交易字段无效：' + k);
      }
      for (const k of ['fee', 'refundCol']) if (t[k] != null && (typeof t[k] !== 'number' || !Number.isFinite(t[k]))) throw new Error('费用或退款金额无效');
    }
    const s = data.settings == null ? {} : data.settings;
    if (!obj(s) || (data.files != null && !obj(data.files))) throw new Error('设置或文件列表无效');
    for (const k of ['bases', 'rules', 'filters', 'refundMode']) if (s[k] != null && !obj(s[k])) throw new Error('设置字段无效：' + k);
    for (const k of ['excluded', 'extraAccounts']) if (s[k] != null && (!Array.isArray(s[k]) || s[k].some(v => typeof v !== 'string'))) throw new Error('设置列表无效：' + k);
    for (const [k, v] of Object.entries(s.bases || {})) {
      if (v !== '' && (typeof v !== 'number' && typeof v !== 'string' || !Number.isFinite(Number(v)))) throw new Error('基准余额无效：' + k);
    }
    for (const v of Object.values(data.files || {})) if (!obj(v)) throw new Error('文件信息无效');
    for (const [k, v] of Object.entries(s.filters || {})) if (typeof v !== 'string') throw new Error('筛选条件无效：' + k);
    for (const k of ['baseDate', 'excludeKeywords']) if (s[k] != null && typeof s[k] !== 'string') throw new Error('设置字段无效：' + k);
    for (const k of ['internal', 'category']) if (s.rules && s.rules[k] != null) {
      if (!Array.isArray(s.rules[k])) throw new Error('规则列表无效');
      for (const r of s.rules[k]) {
        if (!obj(r) || !Array.isArray(r.keys) || r.keys.some(v => typeof v !== 'string')) throw new Error('规则关键词无效');
        for (const field of ['id', 'src', 'account', 'dir', 'counter', 'note', 'cat']) if (r[field] != null && typeof r[field] !== 'string') throw new Error('规则字段无效');
      }
    }
    const d = defaultSettings();
    const safe = Object.fromEntries(Object.keys(d).filter(k => Object.prototype.hasOwnProperty.call(s, k)).map(k => [k, s[k]]));
    const settings = Object.assign(d, safe, {
      bases: Object.assign(Object.create(null), s.bases || {}),
      rules: Object.assign({}, d.rules, s.rules || {}),
      filters: Object.assign({}, d.filters, s.filters || {})
    });
    if (!Object.prototype.hasOwnProperty.call(s, 'baseDateAuto')) settings.baseDateAuto = !settings.baseDate;
    return { raw: data.raw, files: Object.assign(Object.create(null), data.files || {}), settings };
  }

  async function loadSaved() {
    const data = await S.load('workspace');
    if (data) {
      try { Object.assign(state, normalizeWorkspace(data)); }
      catch (e) { toast('本机账本数据异常，未覆盖原存储：' + e.message, true); }
    }
    const mode = S.currentMode();
    const badge = $('saveBadge');
    badge.textContent = mode === 'idb' ? '已保存到本机' : (mode === 'localStorage' ? '已保存（兼容模式）' : '仅本次会话');
    badge.className = 'badge ' + (mode === 'memory' ? 'warn' : 'ok');
  }

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */
  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast on' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast' + (isErr ? ' err' : ''); }, 3200);
  }

  function money(n) { return C.fmt(n); }

  /**
   * HTML 转义。
   * 警告区用的是 innerHTML（要保留 <b> 标签），而里面会插进商家名、商品名、
   * 交易类型这些**来自账单文件的内容**。账单文件是外部输入，不转义就等于
   * 让一个账单文件能往页面里塞标签。
   */
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function csvCell(v) {
    if (v == null) return '';
    let s = String(v);
    // 账单文字不能在 Excel 中被当作公式；真正的金额列仍保留为数字。
    if (typeof v === 'string' && /^[\s\x00-\x1f]*[=+@-]/.test(s) && !/^[+-]?\d+(?:\.\d+)?$/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function toCSV(rows) {
    return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  }
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
  }

  function openModal(html, onMount) {
    $('modalBox').innerHTML = html;
    $('modal').classList.add('on');
    if (onMount) onMount($('modalBox'));
  }
  function closeModal() { $('modal').classList.remove('on'); }

  function uniqueFileKey(fileName) {
    if (!state.files[fileName]) return fileName;
    let i = 2;
    while (state.files[fileName + '#' + i]) i++;
    return fileName + '#' + i;
  }

  /* ------------------------------------------------------------------ *
   * 导入
   * ------------------------------------------------------------------ */

  /** 按内容哈希找已导入过的同一个文件（同一个文件导两次会让收支直接翻倍） */
  function findFileByHash(hash) {
    if (!hash) return null;
    for (const key in state.files) {
      const f = state.files[key];
      if (f && !f.error && f.hash === hash) return f;
    }
    return null;
  }

  /**
   * 弹窗询问：内容重复，还导吗？返回 true = 仍然导入。
   *
   * 关键：弹窗可能被 Escape 或点遮罩关掉。这两种情况下如果不把 promise 结掉，
   * await 会永远挂在那里 —— 导入流程会静默卡死，用户看着"什么也没发生"。
   * 所以任何一种关闭方式都必须走同一个 finish()。
   */
  function confirmDuplicate(existing, name) {
    return new Promise((resolve) => {
      let done = false;
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      const onOverlay = (e) => { if (e.target === $('modal')) finish(false); };
      function finish(val) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey);
        $('modal').removeEventListener('click', onOverlay);
        closeModal();
        resolve(val);
      }
      openModal(`
        <h3>这个文件已经导入过了</h3>
        <p class="hint" style="margin:0 0 10px">
          「${escHtml(name)}」和已导入的「${escHtml(existing.name)}」<b>内容完全一致</b>（文件指纹相同）。
          再导一次会让收入和支出都翻一倍，余额反推也会跟着错。
        </p>
        <div class="modal-actions">
          <button class="btn ghost" id="dupSkip">跳过这个文件（推荐）</button>
          <button class="btn primary" id="dupGo">仍然导入</button>
        </div>
      `, (box) => {
        box.querySelector('#dupSkip').addEventListener('click', () => finish(false));
        box.querySelector('#dupGo').addEventListener('click', () => finish(true));
      });
      document.addEventListener('keydown', onKey);
      $('modal').addEventListener('click', onOverlay);
    });
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    let added = 0, failed = 0, skippedDup = 0;
    const batchHash = new Map();          // 同一批里也要查重

    for (const file of files) {
      const res = await P.parseBillFile(file);
      if (!res.ok) {
        failed++;
        const key = uniqueFileKey(file.name);
        state.files[key] = {
          name: file.name, key: key, error: res.error,
          failed: true, importedAt: Date.now()
        };
        continue;
      }

      // ---- 内容级去重 ----
      const dup = findFileByHash(res.hash) ||
        (res.hash && batchHash.get(res.hash)) || null;
      if (dup) {
        const go = await confirmDuplicate(dup, file.name);
        if (!go) { skippedDup++; continue; }
      }
      if (res.hash) batchHash.set(res.hash, { name: file.name });

      const key = uniqueFileKey(file.name);
      const txs = res.txs.map((t, i) => Object.assign({}, t, { id: key + '#' + i, file: key }));
      state.raw = state.raw.concat(txs);
      state.files[key] = {
        name: file.name,
        key: key,
        source: res.source,
        encoding: res.encoding,
        count: txs.length,
        hash: res.hash,
        size: res.size,
        hasSeparateRefundRow: res.hasSeparateRefundRow,
        quality: res.stats || null,
        log: res.log || [],
        importedAt: Date.now()
      };
      added += txs.length;
    }

    syncBaseDate();
    render();
    scheduleSave();

    const bits = [];
    if (added) bits.push('已导入 ' + added + ' 笔交易');
    if (skippedDup) bits.push('跳过 ' + skippedDup + ' 个重复文件');
    if (failed) bits.push(failed + ' 个文件解析失败');
    if (bits.length) toast(bits.join('，'), !!failed);
  }

  /**
   * 基准日同步。
   * 以前这里无条件覆盖用户手设的基准日——用户把基准日改到"账单覆盖的最后一天"，
   * 下一次导入文件就被冲掉了，而且界面上没有任何提示。
   * 现在：用户手动改过（baseDateAuto === false）就绝不动它，只在体检里提示口径不一致。
   */
  function syncBaseDate() {
    if (!state.raw.length) { state.settings.baseDate = ''; state.settings.baseDateAuto = true; return; }
    if (state.settings.baseDateAuto === false) return;   // 用户设过，尊重用户
    const last = Math.max.apply(null, state.raw.map(t => t.time));
    state.settings.baseDate = C.ymd(new Date(last));
  }

  /* ------------------------------------------------------------------ *
   * 渲染主流程
   * ------------------------------------------------------------------ */
  function render() {
    const st = state.settings;

    const prepared = C.prepare(state.raw, {
      rules: st.rules,
      fileInfo: state.files,
      excluded: new Set(st.excluded),
      refundMode: st.refundMode
    });
    prepared.sort((a, b) => a.time - b.time || a.seq - b.seq);
    state.prepared = prepared;

    // 排除关键词：同时从"余额计算范围"里剔除
    const scoped = applyExcludeKeywords(prepared, st.excludeKeywords);
    state.scoped = scoped;

    const bal = C.computeBalances(scoped, st.bases);
    state.bal = bal;

    const filtered = applyViewFilters(scoped);
    state.filtered = filtered;

    const has = state.raw.length > 0;
    $('emptyState').style.display = has ? 'none' : '';
    $('kpis').style.display = has ? '' : 'none';
    $('toolbar').style.display = has ? '' : 'none';

    renderKpis(filtered, bal);
    renderBasePanel(scoped, bal);
    renderWarnings(scoped, filtered, bal);
    renderSummary(filtered);
    renderDetail(filtered, bal);
    renderFileList();
    renderFilterOptions(scoped);
    renderQuality();
    renderCharts(filtered);
    renderHealth(scoped, bal);
  }

  function applyExcludeKeywords(prepared, kwText) {
    const ex = String(kwText || '').split(/[,，;；\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!ex.length) return prepared;
    return prepared.filter(t => {
      const blob = [t.title, t.counterparty, t.item, t.note, t.txType, t.category, t.orderNo].join(' ').toLowerCase();
      return !ex.some(k => blob.includes(k));
    });
  }

  function applyViewFilters(list) {
    const f = state.settings.filters;
    const kw = (f.keyword || '').trim().toLowerCase();
    const from = f.from ? new Date(f.from + 'T00:00:00').getTime() : null;
    const to = f.to ? new Date(f.to + 'T23:59:59').getTime() : null;

    return list.filter(t => {
      if (from != null && t.time < from) return false;
      if (to != null && t.time > to) return false;
      if (f.dir !== 'all' && t.dir !== f.dir) return false;
      if (f.account !== 'all' && t.account !== f.account) return false;
      if (f.category !== 'all' && t.category !== f.category) return false;
      if (kw) {
        const blob = [t.title, t.counterparty, t.item, t.note, t.orderNo, t.category, t.txType].join(' ').toLowerCase();
        if (!blob.includes(kw)) return false;
      }
      return true;
    });
  }

  /* --------------------------- KPI --------------------------- */
  function renderKpis(list, bal) {
    const box = $('kpis');
    box.innerHTML = '';
    let income = 0, expense = 0, count = 0;
    let minT = Infinity, maxT = -Infinity;
    for (const t of list) {
      if (!t.skip) {
        // 和 calc.js 的 summarize 用同一套按分取整口径，
        // 否则同一屏上"KPI 支出合计"和"汇总表 支出"可能差几分钱
        if (t.dir === 'in') income = C.round2(income + t.netAmount);
        else if (t.dir === 'out') expense = C.round2(expense + t.netAmount);
        count++;
      }
      if (t.time < minT) minT = t.time;
      if (t.time > maxT) maxT = t.time;
    }
    const net = income - expense;
    const knownAccounts = bal.accounts.filter(a => a.known);

    const cards = [
      { label: '收入合计', value: money(income) + ' 元', cls: 'pos', sub: state.settings.filters.from || (list.length ? C.ymd(new Date(minT)) : '') + (list.length ? ' 起' : '') },
      { label: '支出合计', value: money(expense) + ' 元', cls: 'neg', sub: list.length ? '共 ' + count + ' 笔' : '' },
      { label: '净额', value: (net >= 0 ? '+' : '') + money(net) + ' 元', cls: net >= 0 ? 'pos' : 'neg', sub: '收入 − 支出' },
      { label: '合计基准余额', value: knownAccounts.length ? money(bal.mergedBase) + ' 元' : '待填写', cls: '', sub: knownAccounts.length ? knownAccounts.length + ' 个账户已填' : '在左侧填「现在还剩多少」' },
      { label: '区间末笔交易', value: list.length ? (balanceAfter(bal, list) == null ? '待填写' : money(balanceAfter(bal, list)) + ' 元') : '—', cls: '', sub: '合计口径交易后余额' },
      { label: '统计区间', value: list.length ? C.ymd(new Date(minT)) : '—', cls: '', sub: list.length ? '至 ' + C.ymd(new Date(maxT)) : '暂无数据' }
    ];

    for (const c of cards) {
      const k = el('div', 'kpi' + (c.cls ? ' ' + c.cls : ''));
      k.appendChild(el('div', 'k-label', c.label));
      k.appendChild(el('div', 'k-value', c.value));
      k.appendChild(el('div', 'k-sub', c.sub || ''));
      box.appendChild(k);
    }
  }

  function balanceAfter(bal, list) {
    // 取时间最晚那一笔的合计余额。
    // 一个基准余额都没填时合计轨道是空的，此时返回 null（而不是 NaN），
    // 否则 KPI 卡片会显示成" 元"这种半截数字。
    let last = null;
    for (const t of list) {
      const b = bal.merged.get(t.id);
      if (b && (!last || t.time > last.t.time)) last = { t: t, b: b };
    }
    return last ? last.b.after : null;
  }

  /* --------------------------- 余额面板 --------------------------- */
  let baseSig = '';

  /**
   * 写基准余额。
   * 用 defineProperty 而不是直接赋值：账户名要是 "__proto__"，
   * `obj['__proto__'] = 100` 会走原型链的 setter，值根本存不进去（刷新即丢）。
   */
  function setBase(acct, val) {
    Object.defineProperty(st.bases, acct, {
      value: val, writable: true, enumerable: true, configurable: true
    });
  }

  function renderBasePanel(scoped, bal) {
    const st = state.settings;
    const counts = new Map();
    for (const t of scoped) counts.set(t.account, (counts.get(t.account) || 0) + 1);

    const accounts = bal.accounts.map(a => a.account);
    const list = Array.from(new Set(accounts.concat(st.extraAccounts)));
    list.sort((a, b) => a.localeCompare(b, 'zh'));

    const sig = list.map(a => a + ':' + (counts.get(a) || 0)).join('|');
    if (sig !== baseSig) {
      baseSig = sig;
      const box = $('baseList');
      box.innerHTML = '';
      if (!list.length) {
        const p = el('p', 'hint small', '导入账单后，这里会列出所有账户，逐个填上当前余额。');
        box.appendChild(p);
      }
      for (const acct of list) {
        const row = el('div', 'base-row');
        const name = el('div', 'acct');
        name.appendChild(document.createTextNode(acct));
        name.appendChild(el('span', 'cnt', (counts.get(acct) || 0) + ' 笔'));
        name.title = acct;
        const input = el('input');
        input.type = 'number';
        input.step = '0.01';
        input.dataset.acct = acct;
        input.placeholder = '余额';
        const v = st.bases[acct];
        if (v != null) input.value = v;
        else input.classList.add('unknown');
        input.addEventListener('input', () => {
          const raw = input.value.trim();
          if (raw === '') { delete st.bases[acct]; input.classList.add('unknown'); }
          else {
            const n = parseFloat(raw);
            if (isFinite(n)) { setBase(acct, n); input.classList.remove('unknown'); }
          }
          refreshBalances();
          scheduleSave();
        });
        row.appendChild(name);
        row.appendChild(input);
        box.appendChild(row);
      }
    }

    const total = bal.mergedBase;
    $('baseTotal').textContent = bal.accounts.some(a => a.known) ? money(total) + ' 元' : '—';
    $('baseDate').value = st.baseDate || '';

    const lastTime = state.raw.length ? Math.max.apply(null, state.raw.map(t => t.time)) : null;
    const hint = $('baseHint');
    if (!lastTime) hint.textContent = '导入账单后，默认以最后一笔交易的日期为基准日。';
    else {
      const lastD = C.ymd(new Date(lastTime));
      const base = st.baseDate;
      if (!base) hint.textContent = '请选择基准日。';
      else if (base > lastD) hint.innerHTML = '⚠ 基准日 <b>' + escHtml(base) + '</b> 晚于最后一笔交易（' + lastD + '）。这段时间里的交易不在账单中，反推出的余额会偏大，建议把基准日改回 ' + lastD + '。';
      else hint.textContent = '基准日 ' + base + '，最后一笔交易 ' + lastD + '。填入"这一天之后你实际有的钱"即可倒推。';
    }
  }

  /** 只重算余额并刷新表格，不重建输入框（避免输入时失焦） */
  function refreshBalances() {
    const st = state.settings;
    // 口径必须和 render() 完全一致：以前这里有个 `scoped.length ? scoped : prepared` 的兜底，
    // 一旦排除关键词把所有交易都排掉，余额口径会突然从"排除后"跳回"全部"，数字凭空一变。
    // 现在：永远用 scoped；"合计基准余额"是否稳定由 calc.js 保证（基准余额与流水无关）。
    const scoped = state.scoped;
    const bal = C.computeBalances(scoped, st.bases);
    state.bal = bal;
    const filtered = applyViewFilters(scoped);
    state.filtered = filtered;
    renderKpis(filtered, bal);
    renderWarnings(scoped, filtered, bal);
    renderSummary(filtered);
    renderDetail(filtered, bal);
    renderCharts(filtered);
    renderHealth(scoped, bal);
    const total = bal.mergedBase;
    $('baseTotal').textContent = bal.accounts.some(a => a.known) ? money(total) + ' 元' : '—';
  }

  /* --------------------------- 提示 / 警告 --------------------------- */
  function renderWarnings(scoped, filtered, bal) {
    const box = $('warnBox');
    box.innerHTML = '';
    const items = [];

    const known = bal.accounts.filter(a => a.known).length;
    if (state.raw.length && known === 0) {
      items.push({ level: 'info', text: '还没有填写基准余额，余额列暂时是空的。在左侧「② 余额反推」里填上你现在实际有的钱，就能反推出每笔支出前的余额。' });
    }

    for (const w of bal.warnings) items.push({ level: w.level, text: w.text });

    // 基准日 与 账单最后一天 不一致
    const lastTime = state.raw.length ? Math.max.apply(null, state.raw.map(t => t.time)) : null;
    const st = state.settings;
    if (lastTime && st.baseDate) {
      const lastD = C.ymd(new Date(lastTime));
      if (st.baseDate > lastD) {
        items.push({ level: 'warn', text: '基准日晚于账单最后一笔交易（' + lastD + '），这期间的收入支出没有账单，反推余额会偏大。' });
      } else if (st.baseDate < lastD) {
        items.push({
          level: 'warn',
          text: '基准日 <b>' + escHtml(st.baseDate) + '</b> 早于账单最后一笔交易（' + lastD + '）。' +
            '基准余额会被当成最后一笔交易之后的余额来倒推，' + lastD + ' 当天的交易会被算进余额，结果偏小。' +
            '除非你的账单确实只覆盖到 ' + escHtml(st.baseDate) + '，否则请把基准日改回 ' + lastD + '。'
        });
      }
    }

    // 收支方向没识别出来：这些钱既没算收入也没算支出，余额链条在这里是断的。
    // 以前这条路径完全没人管 —— 整份账单的钱会静默归零，界面一声不吭。
    // 注意这里要看 prepared（全部导入的行）而不是 scoped：
    // 否则被"排除关键词"挡住的行就把问题一起藏起来了。
    const unknownDir = state.prepared.filter(t => t.dir === 'unknown' && !t.userExcluded);
    if (unknownDir.length) {
      items.push({
        level: 'warn',
        text: '有 <b>' + unknownDir.length + '</b> 笔流水没能判断出收支方向，<b>这些钱既没算收入也没算支出</b>，余额链条在这里是断的。' +
          ' 例如：' + unknownDir.slice(0, 3).map(t => escHtml(H.labelOf(t))).join('；') +
          ' 多半是账单里「收/支」列的写法比较特殊，或者这份账单根本没有这一列。'
      });
    }

    // 账单里根本没有「收/支」列 → 那个文件的全部流水都没参与计算
    const noDirFiles = Object.keys(state.files).filter(k =>
      state.files[k] && state.files[k].quality && state.files[k].quality.noDirColumn);
    if (noDirFiles.length) {
      items.push({
        level: 'warn',
        text: '有 <b>' + noDirFiles.length + '</b> 个文件里没有「收/支」列（' +
          escHtml(noDirFiles.map(k => state.files[k].name).join('、')) +
          '），没法判断哪笔是收入哪笔是支出，<b>这些文件的流水全部没有参与余额计算</b>。' +
          '请确认导出的是"账单明细列表"而不是"账单概览"。'
      });
    }

    // 不计收支未识别
    const unknownNeutral = scoped.filter(t => t.kind === 'unknown' && t.dir !== 'unknown');
    if (unknownNeutral.length) {
      items.push({
        level: 'warn',
        text: '有 <b>' + unknownNeutral.length + '</b> 笔"不计收支"的流水没匹配到划转规则，余额未发生变化。' +
          ' 例如：' + unknownNeutral.slice(0, 3).map(t => escHtml(H.labelOf(t))).join('；') +
          ' 需要的话到「⑥ 规则」里加一条。'
      });
    }

    // 部分退款未知
    const partial = scoped.filter(t => t.flags.some(f => f.indexOf('部分退款') >= 0));
    if (partial.length) {
      items.push({ level: 'warn', text: '有 <b>' + partial.length + '</b> 笔部分退款查不到退款金额，仍按原金额计算。可在明细里点「排除」手动剔除。' });
    }

    // 关闭交易
    const closed = scoped.filter(t => t.flags.some(f => f.indexOf('交易关闭') >= 0));
    if (closed.length) items.push({ level: 'info', text: '已自动排除 <b>' + closed.length + '</b> 笔"交易关闭/失败"的记录（钱并未实际付出）。' });

    // 用户手动排除
    const userEx = scoped.filter(t => t.userExcluded).length;
    if (userEx) items.push({ level: 'info', text: '你手动排除了 <b>' + userEx + '</b> 笔交易，它们不参与余额计算。' });

    // 排除关键词
    const kw = (st.excludeKeywords || '').trim();
    if (kw) {
      const hit = Math.max(0, state.prepared.length - scoped.length);
      items.push({
        level: 'info',
        text: '排除关键词「' + escHtml(kw) + '」已生效，命中 <b>' + hit + '</b> 笔交易不参与余额计算' +
          '（这些行也不会出现在明细表和导出里）。'
      });
    }

    // 疑似重复
    const dups = C.findDuplicates(scoped);
    if (dups.length) {
      const d = dups[0];
      items.push({
        level: 'warn',
        text: '发现 <b>' + dups.length + '</b> 组疑似重复记账（金额相同、时间接近、一收一支）：例如「' +
          escHtml(H.labelOf(d.a)) + '」' + (SOURCE_LABEL[d.a.src] || '') + ' ↔ 「' + escHtml(H.labelOf(d.b)) + '」' + (SOURCE_LABEL[d.b.src] || '') +
          '。可能是同一次转账在两个平台各记了一笔，确认后可手动排除其中一条。'
      });
    }

    for (const it of items) {
      const d = el('div', 'warn-item ' + it.level);
      d.innerHTML = it.text;
      box.appendChild(d);
    }
  }

  /* --------------------------- 分组汇总 --------------------------- */
  function renderSummary(list) {
    const st = state.settings;
    const wrap = $('summaryWrap');
    if (!state.raw.length) { wrap.style.display = 'none'; return; }
    if (st.view === 'detail') { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    const g = st.groupBy;
    $('summaryTitle').textContent = g === 'day' ? '按日汇总' : (g === 'month' ? '按月汇总' : '按年汇总');
    const rows = C.summarize(list, g, state.bal);

    let income = 0, expense = 0, cnt = 0;
    for (const r of rows) { income += r.income; expense += r.expense; cnt += r.count; }
    $('summaryHint').textContent = rows.length + ' 组 · ' + cnt + ' 笔 · 收 ' + money(income) + ' / 支 ' + money(expense);

    if (!rows.length) {
      $('summaryTable').innerHTML = '<div class="card-empty">当前筛选下没有数据</div>';
      return;
    }

    const t = el('table');
    const thead = el('thead');
    const hr = el('tr');
    ['期间', '笔数', '收入', '支出', '净额', '期初余额(合计)', '期末余额(合计)'].forEach((h, i) => {
      const th = el('th', i >= 1 ? 'num' : '');
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    t.appendChild(thead);

    const tb = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      const cells = [
        { v: r.label, cls: '' },
        { v: r.count, cls: 'num' },
        { v: money(r.income), cls: 'num amount-in' },
        { v: money(r.expense), cls: 'num amount-out' },
        { v: (r.net >= 0 ? '+' : '') + money(r.net), cls: 'num ' + (r.net >= 0 ? 'pos' : 'neg') },
        { v: r.begin == null ? '—' : money(r.begin), cls: 'num' },
        { v: r.end == null ? '—' : money(r.end), cls: 'num' }
      ];
      for (const c of cells) {
        const td = el('td', c.cls);
        td.textContent = c.v;
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
    t.appendChild(tb);

    const wrapT = el('div');
    wrapT.appendChild(t);
    $('summaryTable').innerHTML = '';
    $('summaryTable').appendChild(wrapT);
  }

  /* --------------------------- 明细 --------------------------- */
  function renderDetail(list, bal) {
    const st = state.settings;
    const wrap = $('detailWrap');
    if (!state.raw.length) { wrap.style.display = 'none'; return; }
    if (st.view === 'summary') { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    $('detailHint').textContent = list.length + ' 笔' + (st.mode === 'merged' ? ' · 余额列为全部账户合计' : ' · 余额列为该笔所在账户');

    if (!list.length) {
      $('detailTable').innerHTML = '<div class="card-empty">当前筛选下没有数据</div>';
      $('pager').innerHTML = '';
      return;
    }

    const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
    if (state.page > pages) state.page = pages;
    const start = (state.page - 1) * state.pageSize;
    // 明细按时间倒序（最新在前），跟账单 App 的习惯一致
    const ordered = list.slice().reverse();
    const slice = ordered.slice(start, start + state.pageSize);

    const t = el('table');
    const thead = el('thead');
    const hr = el('tr');
    // 口径切换必须真的换列。
    // 以前「按账户分别 / 全部合计」这个开关只改了下面那行提示文案，
    // 表头和数字一个都没变 —— 用户以为切了口径，其实看到的是同一份数据。
    const mergedMode = st.mode === 'merged';
    const cols = [
      { k: 'time', h: '时间' },
      { k: 'src', h: '来源' },
      { k: 'acct', h: '账户' },
      { k: 'cat', h: '分类' },
      { k: 'title', h: '摘要' },
      { k: 'dir', h: '收支' },
      { k: 'amt', h: '金额', num: true },
      { k: 'net', h: '净额', num: true },
      mergedMode ? { k: 'mb', h: '合计余额(前)', num: true }
        : { k: 'ab', h: '账户余额(前)', num: true },
      mergedMode ? { k: 'ma', h: '合计余额(后)', num: true }
        : { k: 'aa', h: '账户余额(后)', num: true },
      mergedMode ? null : { k: 'mt', h: '合计余额(后)', num: true },
      { k: 'note', h: '备注 / 标记' }
    ].filter(Boolean);
    cols.forEach(c => {
      const th = el('th', c.num ? 'num' : '');
      th.textContent = c.h;
      hr.appendChild(th);
    });
    const thAct = el('th', ''); thAct.textContent = '操作'; hr.appendChild(thAct);
    thead.appendChild(hr);
    t.appendChild(thead);

    const tb = el('tbody');
    for (const tx of slice) {
      const tr = el('tr');
      if (tx.userExcluded) tr.classList.add('excluded');
      if (tx.kind === 'internal') tr.classList.add('internal');

      const rec = bal.balances.get(tx.id);
      const acc = rec ? rec.primary : null;
      const mg = bal.merged.get(tx.id);

      for (const col of cols) {
        let td;
        switch (col.k) {
          case 'time': {
            td = el('td', 'mono');
            td.textContent = C.ymdhm(new Date(tx.time));
            break;
          }
          case 'src': {
            td = el('td');
            td.appendChild(el('span', 'pill src-' + tx.src, SOURCE_LABEL[tx.src] || tx.src));
            break;
          }
          case 'acct':
            td = el('td', '', tx.account);
            break;
          case 'cat': {
            td = el('td');
            td.appendChild(el('span', 'pill', tx.category));
            break;
          }
          case 'title': {
            td = el('td', 'title');
            td.textContent = tx.title;
            td.title = tx.title;
            break;
          }
          case 'dir': {
            td = el('td');
            const dirCls = tx.dir === 'in' ? 'in' : (tx.dir === 'out' ? 'out' : (tx.dir === 'neutral' ? 'neutral' : 'unknown'));
            td.appendChild(el('span', 'pill ' + dirCls, tx.dirText || (tx.dir === 'neutral' ? '不计收支' : '未知')));
            break;
          }
          case 'amt': {
            td = el('td', 'num ' + (tx.dir === 'in' ? 'amount-in' : (tx.dir === 'out' ? 'amount-out' : '')));
            td.textContent = tx.dir === 'out' ? '-' + money(tx.amount) : (tx.dir === 'in' ? '+' + money(tx.amount) : money(tx.amount));
            break;
          }
          case 'net': {
            td = el('td', 'num');
            td.textContent = (tx.netAmount != null && tx.netAmount !== tx.amount)
              ? money(tx.netAmount)
              : (tx.dir === 'neutral' ? '—' : '');
            break;
          }
          case 'ab': td = el('td', 'num', acc ? money(acc.before) : '—'); break;
          case 'aa': td = el('td', 'num', acc ? money(acc.after) : '—'); break;
          case 'mb': td = el('td', 'num', mg ? money(mg.before) : '—'); break;
          case 'ma': td = el('td', 'num', mg ? money(mg.after) : '—'); break;
          case 'mt': td = el('td', 'num', mg ? money(mg.after) : '—'); break;
          case 'note': {
            td = el('td');
            const flags = tx.flags || [];
            const noteText = [tx.note, tx.txType && tx.txType !== tx.dirText ? tx.txType : ''].filter(Boolean).join(' · ');
            if (noteText) td.appendChild(document.createTextNode(noteText));
            for (const f of flags) {
              td.appendChild(el('span', 'rowflag', f));
            }
            break;
          }
          default:
            td = el('td');
        }
        tr.appendChild(td);
      }

      const tdAct = el('td');
      const btn = el('button', 'exclude-btn' + (tx.userExcluded ? ' on' : ''), tx.userExcluded ? '↺' : '✕');
      btn.title = tx.userExcluded ? '恢复计入' : '排除这一笔（不参与余额计算）';
      btn.addEventListener('click', () => {
        const ex = new Set(state.settings.excluded);
        if (ex.has(tx.id)) ex.delete(tx.id); else ex.add(tx.id);
        state.settings.excluded = Array.from(ex);
        render();
        scheduleSave();
      });
      tdAct.appendChild(btn);
      tr.appendChild(tdAct);

      tb.appendChild(tr);
    }
    t.appendChild(tb);

    $('detailTable').innerHTML = '';
    $('detailTable').appendChild(t);

    // 分页
    const pg = $('pager');
    pg.innerHTML = '';
    const mk = (label, page, disabled) => {
      const b = el('button', 'btn small ghost', label);
      b.disabled = !!disabled;
      b.addEventListener('click', () => { state.page = page; renderDetail(state.filtered, bal); });
      return b;
    };
    pg.appendChild(mk('« 首页', 1, state.page === 1));
    pg.appendChild(mk('‹ 上一页', state.page - 1, state.page === 1));
    const info = el('span');
    info.textContent = '第 ' + state.page + ' / ' + pages + ' 页 · 第 ' + (start + 1) + '-' + Math.min(start + state.pageSize, list.length) + ' 笔';
    pg.appendChild(info);
    pg.appendChild(mk('下一页 ›', state.page + 1, state.page === pages));
    pg.appendChild(mk('末页 »', pages, state.page === pages));
    const spacer = el('div', 'spacer'); pg.appendChild(spacer);
    const sizeSel = el('select');
    sizeSel.style.border = '1px solid var(--line)';
    sizeSel.style.borderRadius = '7px';
    sizeSel.style.padding = '4px 6px';
    [60, 120, 300, 1000].forEach(n => {
      const o = el('option', '', n + ' 行/页');
      o.value = n;
      if (n === state.pageSize) o.selected = true;
      sizeSel.appendChild(o);
    });
    sizeSel.addEventListener('change', () => { state.pageSize = +sizeSel.value; state.page = 1; renderDetail(state.filtered, bal); });
    pg.appendChild(sizeSel);
  }

  /* --------------------------- 文件列表 --------------------------- */
  function removeFile(key) {
    const info = state.files[key];
    delete state.files[key];
    state.raw = state.raw.filter(t => t.file !== key);
    // 排除记录的 id 形如 "文件名#序号"。同名文件会被加上 "#2" 后缀，
    // 所以光用 startsWith(key + '#') 判断会误伤：删掉 "账单.csv" 会把
    // "账单.csv#2" 的排除记录一起清掉。这里要求后半段是纯序号才算命中。
    state.settings.excluded = state.settings.excluded.filter(id => {
      if (id.indexOf(key + '#') !== 0) return true;
      return !/^\d+$/.test(id.slice(key.length + 1));
    });
    if (state.settings.refundMode) delete state.settings.refundMode[key];
    baseSig = '';
    render();
    scheduleSave();
    if (info && !info.error) toast('已移除「' + info.name + '」');
  }

  const REFUND_MODES = [
    { v: 'auto', t: '退款方式：自动' },
    { v: 'raw', t: '退款方式：按原样（退款是独立一行）' },
    { v: 'net', t: '退款方式：按状态净额（退款标在原行上）' }
  ];

  function renderFileList() {
    const ul = $('fileList');
    ul.innerHTML = '';
    const keys = Object.keys(state.files);
    if (!keys.length) return;

    // 内容指纹 → 出现次数，用来标"这个文件被导入了两次"
    const hashCount = new Map();
    for (const k of keys) {
      const h = state.files[k] && state.files[k].hash;
      if (h) hashCount.set(h, (hashCount.get(h) || 0) + 1);
    }

    for (const key of keys) {
      const info = state.files[key];
      const li = el('li');

      const fname = el('div', 'fname', info.name);
      li.appendChild(fname);

      if (info.error) {
        li.appendChild(el('div', 'ferr', '✕ ' + info.error));
        const btn = el('button', '', '✕');
        btn.title = '移除这条失败记录';
        btn.addEventListener('click', () => removeFile(key));
        li.appendChild(btn);
        ul.appendChild(li);
        continue;
      }

      const srcName = SOURCE_LABEL[info.source] || info.source;
      let meta = srcName + ' · ' + info.count + ' 笔' + (info.encoding ? ' · ' + info.encoding : '');
      if (info.hasSeparateRefundRow) meta += ' · 含独立退款行';
      li.appendChild(el('div', 'fmeta', meta));

      if (info.hash && hashCount.get(info.hash) > 1) {
        li.appendChild(el('div', 'ferr', '⚠ 内容与另一个已导入文件完全相同，重复导入了'));
      }

      // 导入质量
      const q = info.quality;
      if (q) {
        const bits = [];
        if (q.totalRows) bits.push('读到 ' + q.totalRows + ' 行');
        bits.push('解析 ' + q.parsed + ' 笔');
        if (q.skipped) bits.push('跳过 ' + q.skipped + ' 行');
        if (q.repaired) bits.push('修复列错位 ' + q.repaired + ' 行');
        li.appendChild(el('div', 'fmeta', bits.join(' · ')));
      }

      for (const l of (info.log || [])) li.appendChild(el('div', 'fmeta', l));

      // 退款处理方式（每个文件可以单独指定）
      const sel = el('select', 'fsel');
      for (const m of REFUND_MODES) {
        const o = el('option', '', m.t);
        o.value = m.v;
        sel.appendChild(o);
      }
      const cur = (state.settings.refundMode && state.settings.refundMode[key]) || 'auto';
      sel.value = cur;
      sel.addEventListener('change', () => {
        if (!state.settings.refundMode) state.settings.refundMode = {};
        if (sel.value === 'auto') delete state.settings.refundMode[key];
        else state.settings.refundMode[key] = sel.value;
        render();
        scheduleSave();
      });
      li.appendChild(sel);

      const btn = el('button', '', '✕');
      btn.title = '移除这个文件的全部记录';
      btn.addEventListener('click', () => removeFile(key));
      li.appendChild(btn);

      ul.appendChild(li);
    }
  }

  /* --------------------------- 导入质量报告 --------------------------- */
  function renderQuality() {
    const box = $('qualityBody');
    if (!box) return;
    box.innerHTML = '';
    const keys = Object.keys(state.files);
    if (!keys.length) {
      box.appendChild(el('p', 'hint small', '导入账单后，这里会显示每个文件的读取行数、跳过原因和自动修复情况。'));
      return;
    }

    let totalRows = 0, parsed = 0, skipped = 0, repaired = 0, failed = 0, okFiles = 0;
    const rows = [];
    for (const key of keys) {
      const f = state.files[key];
      if (!f) continue;
      if (f.error) {
        failed++;
        rows.push({ f: f, err: true });
        continue;
      }
      okFiles++;
      const q = f.quality || {};
      totalRows += q.totalRows || 0;
      parsed += q.parsed || 0;
      skipped += q.skipped || 0;
      repaired += q.repaired || 0;
      rows.push({ f: f, q: q });
    }

    const sum = el('p', 'quality-summary');
    sum.innerHTML = '共 <b>' + okFiles + '</b> 个文件解析成功，<b>' + failed + '</b> 个失败；' +
      '读到 <b>' + totalRows + '</b> 行，解析出 <b>' + parsed + '</b> 笔，跳过 <b>' + skipped + '</b> 行' +
      (repaired ? '，自动修复列错位 <b>' + repaired + '</b> 行' : '') + '。';
    box.appendChild(sum);

    for (const r of rows) {
      const f = r.f;
      const card = el('div', 'quality-row');
      card.appendChild(el('div', 'qr-name', f.name));
      if (r.err) {
        card.appendChild(el('div', 'qr-flag err', '✕ ' + f.error));
        box.appendChild(card);
        continue;
      }
      const q = r.q || {};
      const grid = el('div', 'qr-grid');
      const put = (k, v, cls) => {
        grid.appendChild(el('span', '', k));
        const b = el('span', cls || '', v);
        grid.appendChild(b);
      };
      put('来源', (SOURCE_LABEL[f.source] || f.source) + ' · ' + (f.encoding || '未知编码'));
      put('读取行数', q.totalRows != null ? q.totalRows : '—');
      put('解析成功', q.parsed != null ? q.parsed + ' 笔' : '—');
      if (q.skipped) {
        put('跳过', q.skipped + ' 行（时间 ' + (q.skippedNoTime || 0) + ' / 金额 ' + (q.skippedNoAmount || 0) + '）', 'qr-flag');
      }
      if (q.repaired) put('列错位修复', q.repaired + ' 行', 'qr-flag');
      if (q.noDirColumn) {
        put('⚠ 收/支列', '这份账单里没有「收/支」列，全部流水都没有参与余额计算', 'qr-flag err');
      } else if (q.unknownDir) {
        put('⚠ 方向不明', q.unknownDir + ' 行没能判断出收支方向，没有参与余额计算', 'qr-flag');
      }
      put('退款形态', f.hasSeparateRefundRow ? '独立退款行' : '状态标记（按净额）');
      put('文件指纹', f.hash || '—');
      if (f.size != null) put('文件大小', (f.size / 1024).toFixed(1) + ' KB');
      card.appendChild(grid);
      box.appendChild(card);
    }
  }

  /* --------------------------- 筛选选项 --------------------------- */
  function renderFilterOptions(scoped) {
    const accSel = $('fAccount');
    const cur = accSel.value;
    const accounts = Array.from(new Set(scoped.map(t => t.account))).sort((a, b) => a.localeCompare(b, 'zh'));
    accSel.innerHTML = '';
    const o0 = el('option', '', '全部'); o0.value = 'all'; accSel.appendChild(o0);
    for (const a of accounts) {
      const o = el('option', '', a); o.value = a; accSel.appendChild(o);
    }
    accSel.value = accounts.indexOf(cur) >= 0 ? cur : 'all';
    if (accSel.value !== cur) state.settings.filters.account = accSel.value;

    const catSel = $('fCategory');
    const curC = catSel.value;
    const cats = Array.from(new Set(scoped.map(t => t.category))).sort((a, b) => a.localeCompare(b, 'zh'));
    catSel.innerHTML = '';
    const c0 = el('option', '', '全部'); c0.value = 'all'; catSel.appendChild(c0);
    for (const c of cats) {
      const o = el('option', '', c); o.value = c; catSel.appendChild(o);
    }
    catSel.value = cats.indexOf(curC) >= 0 ? curC : 'all';
    if (catSel.value !== curC) state.settings.filters.category = catSel.value;
  }

  /* --------------------------- 图表 --------------------------- */
  function renderCharts(list) {
    const wrap = $('chartsWrap');
    if (!wrap) return;
    if (!state.raw.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    // 1. 支出分类占比（环形图）
    const cats = CH.aggregateByCategory(list, 'out');
    const shown = CH.topN(cats, 9);
    const donut = CH.donut(shown, { centerLabel: '支出合计' });

    $('chartDonut').innerHTML = donut.svg;
    const lg = $('donutLegend');
    lg.innerHTML = '';
    for (const d of donut.legend) {
      const li = el('li');
      const sw = el('i', 'sw');
      sw.style.background = d.color;
      li.appendChild(sw);
      li.appendChild(el('span', 'nm', d.label));
      li.appendChild(el('span', 'vl', money(d.value)));
      li.appendChild(el('span', 'pc', d.pct.toFixed(1) + '%'));
      lg.appendChild(li);
    }
    if (!donut.legend.length) {
      lg.appendChild(el('li', '', '当前筛选下没有支出'));
    }

    // 2. 月度收支趋势（双向柱）
    const byMonth = new Map();
    for (const t of list) {
      const k = C.ym(new Date(t.time));
      if (!byMonth.has(k)) byMonth.set(k, { key: k, label: k.slice(2), income: 0, expense: 0 });
      const g = byMonth.get(k);
      if (t.skip) continue;
      if (t.dir === 'in') g.income += t.netAmount;
      else if (t.dir === 'out') g.expense += t.netAmount;
    }
    const rows = Array.from(byMonth.values()).sort((a, b) => (a.key < b.key ? -1 : 1));
    $('chartTrend').innerHTML = CH.trend(rows);

    const ti = rows.reduce((s, r) => s + r.income, 0);
    const te = rows.reduce((s, r) => s + r.expense, 0);
    $('chartHint').textContent = '统计区间内 ' + rows.length + ' 个月 · 收 ' + money(ti) + ' / 支 ' + money(te);
  }

  /* --------------------------- 账本体检 --------------------------- */
  function renderHealth(scoped, bal) {
    const wrap = $('healthWrap');
    if (!wrap) return;
    if (!state.raw.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    const report = H.run({
      prepared: state.prepared,
      scoped: scoped,
      bal: bal,
      files: state.files
    });

    const score = report.health;
    const cls = score >= 80 ? 'ok' : (score >= 50 ? 'warn' : 'err');
    const sn = $('healthScore');
    sn.textContent = score;
    sn.className = 'score-num ' + cls;
    const bar = $('healthBar');
    bar.style.width = score + '%';
    bar.className = cls;
    $('healthText').textContent = score >= 80 ? '账本状态良好' : (score >= 50 ? '有需要注意的地方' : '建议先处理下面的问题');

    const body = $('healthBody');
    body.innerHTML = '';
    const list = el('div', 'health-list');
    for (const c of report.checks) {
      const item = el('div', 'health-item ' + c.level);
      const head = el('div', 'hi-head');
      head.appendChild(el('span', 'hi-dot'));
      head.appendChild(el('span', 'hi-title', c.title));
      head.appendChild(el('span', 'hi-sum', c.summary));
      item.appendChild(head);
      if (c.details && c.details.length) {
        const ul = el('ul', 'hi-details');
        for (const d of c.details) ul.appendChild(el('li', '', d));
        item.appendChild(ul);
      }
      list.appendChild(item);
    }
    body.appendChild(list);

    $('healthHint').textContent = report.checks.length + ' 项检查 · ' +
      report.checks.filter(c => c.level === 'err').length + ' 项异常 / ' +
      report.checks.filter(c => c.level === 'warn').length + ' 项提醒';
  }

  /* ------------------------------------------------------------------ *
   * 规则编辑
   * ------------------------------------------------------------------ */
  function renderRules() {
    const box = $('rulesBody');
    box.innerHTML = '';

    const h1 = el('h3', '', '内部划转规则');
    h1.style.fontSize = '12.5px';
    h1.style.margin = '2px 0 8px';
    box.appendChild(h1);
    const p1 = el('p', 'hint small', '「不计收支」的流水落到哪个账户、什么方向。{method} 代表该行的支付方式。');
    p1.style.marginBottom = '8px';
    box.appendChild(p1);

    const list1 = el('div', 'rule-list');
    state.settings.rules.internal.forEach((rule, idx) => {
      const row = el('div', 'rule-row' + (rule.enabled === false ? ' off' : ''));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = rule.enabled !== false;
      cb.addEventListener('change', () => { rule.enabled = cb.checked; renderRules(); refreshAll(); });
      row.appendChild(cb);

      const box2 = el('div', 'k');
      const kIn = el('input', 'kw'); kIn.type = 'text'; kIn.value = (rule.keys || []).join(',');
      kIn.placeholder = '关键词(逗号分隔)';
      kIn.addEventListener('input', () => { rule.keys = kIn.value.split(/[,，]/).map(s => s.trim()).filter(Boolean); refreshAll(); });
      const accIn = el('input'); accIn.type = 'text'; accIn.value = rule.account || '';
      accIn.placeholder = '账户';
      accIn.addEventListener('input', () => { rule.account = accIn.value; refreshAll(); });
      const dirSel = el('select');
      ['in', 'out'].forEach(v => {
        const o = el('option', '', v === 'in' ? '资金流入' : '资金流出');
        o.value = v; if (rule.dir === v) o.selected = true;
        dirSel.appendChild(o);
      });
      dirSel.addEventListener('change', () => { rule.dir = dirSel.value; refreshAll(); });
      const cIn = el('input', 'full'); cIn.type = 'text'; cIn.value = rule.counter || '';
      cIn.placeholder = '对向账户(可空)';
      cIn.addEventListener('input', () => { rule.counter = cIn.value; refreshAll(); });
      box2.appendChild(kIn); box2.appendChild(accIn); box2.appendChild(dirSel); box2.appendChild(cIn);
      row.appendChild(box2);

      const rm = el('button', 'rm', '✕');
      rm.title = '删除这条规则';
      rm.addEventListener('click', () => {
        state.settings.rules.internal.splice(idx, 1);
        renderRules(); refreshAll();
      });
      row.appendChild(rm);

      list1.appendChild(row);
    });
    box.appendChild(list1);

    const add1 = el('button', 'btn small ghost', '+ 新增划转规则');
    add1.style.width = '100%';
    add1.style.marginTop = '7px';
    add1.addEventListener('click', () => {
      state.settings.rules.internal.push({ keys: [], account: '', dir: 'in', counter: '', enabled: true, note: '手动添加' });
      renderRules(); refreshAll();
      const rows = $('rulesBody').querySelectorAll('.rule-list')[0].querySelectorAll('.rule-row');
      const last = rows[rows.length - 1];
      if (last) { const inp = last.querySelector('input[type=text]'); if (inp) inp.focus(); }
    });
    box.appendChild(add1);

    const h2 = el('h3', '', '分类规则');
    h2.style.fontSize = '12.5px';
    h2.style.margin = '16px 0 8px';
    box.appendChild(h2);
    const p2 = el('p', 'hint small', '按关键词给流水归类，顺序即优先级，第一条命中即生效。');
    p2.style.marginBottom = '8px';
    box.appendChild(p2);

    const list2 = el('div', 'rule-list');
    state.settings.rules.category.forEach((rule, idx) => {
      const row = el('div', 'rule-row' + (rule.enabled === false ? ' off' : ''));
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = rule.enabled !== false;
      cb.addEventListener('change', () => { rule.enabled = cb.checked; renderRules(); refreshAll(); });
      row.appendChild(cb);
      const box2 = el('div', 'k');
      const catIn = el('input', 'full'); catIn.type = 'text'; catIn.value = rule.cat || '';
      catIn.placeholder = '分类名';
      catIn.addEventListener('input', () => { rule.cat = catIn.value; refreshAll(); });
      const kIn = el('input', 'kw'); kIn.type = 'text'; kIn.value = (rule.keys || []).join(',');
      kIn.placeholder = '关键词(逗号分隔)';
      kIn.addEventListener('input', () => { rule.keys = kIn.value.split(/[,，]/).map(s => s.trim()).filter(Boolean); refreshAll(); });
      box2.appendChild(catIn); box2.appendChild(kIn);
      row.appendChild(box2);

      const rm = el('button', 'rm', '✕');
      rm.title = '删除这条规则';
      rm.addEventListener('click', () => {
        state.settings.rules.category.splice(idx, 1);
        renderRules(); refreshAll();
      });
      row.appendChild(rm);

      list2.appendChild(row);
    });
    box.appendChild(list2);

    const add2 = el('button', 'btn small ghost', '+ 新增分类规则');
    add2.style.width = '100%';
    add2.style.marginTop = '7px';
    add2.addEventListener('click', () => {
      state.settings.rules.category.push({ cat: '', keys: [], enabled: true });
      renderRules(); refreshAll();
      const lists = $('rulesBody').querySelectorAll('.rule-list');
      const rows = lists[lists.length - 1].querySelectorAll('.rule-row');
      const last = rows[rows.length - 1];
      if (last) { const inp = last.querySelector('input[type=text]'); if (inp) inp.focus(); }
    });
    box.appendChild(add2);
  }

  function refreshAll() {
    render();
    scheduleSave();
  }

  /* ------------------------------------------------------------------ *
   * 手动记一笔
   * ------------------------------------------------------------------ */
  function openManualForm() {
    const accounts = Array.from(new Set(state.prepared.map(t => t.account)));
    const cats = Array.from(new Set(state.prepared.map(t => t.category).filter(c => c && c !== '未分类')));
    const now = new Date();
    const dt = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

    openModal(`
      <h3>手动记一笔</h3>
      <p class="hint" style="margin:0 0 12px">现金支出、银行卡转账等不在微信/支付宝账单里的记录，可以手动补。手动记录同样参与余额反推。</p>
      <div class="field-row">
        <div class="field"><label>时间</label><input type="datetime-local" id="mTime" value="${dt}"></div>
        <div class="field"><label>收支</label><select id="mDir"><option value="out">支出</option><option value="in">收入</option></select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>金额（元）</label><input type="number" id="mAmount" step="0.01" min="0" placeholder="0.00"></div>
        <div class="field"><label>账户</label><input type="text" id="mAccount" list="mAccountList" value="现金" placeholder="现金 / 微信·零钱">
          <datalist id="mAccountList">${accounts.map(a => '<option value="' + escHtml(a) + '">').join('')}</datalist>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>分类</label><input type="text" id="mCat" list="mCatList" placeholder="餐饮">
          <datalist id="mCatList">${cats.map(c => '<option value="' + escHtml(c) + '">').join('')}</datalist>
        </div>
        <div class="field"><label>对方 / 摘要</label><input type="text" id="mTitle" placeholder="买了什么"></div>
      </div>
      <div class="field"><label>备注</label><input type="text" id="mNote" placeholder="可空"></div>
      <div class="modal-actions">
        <button class="btn ghost" id="mCancel">取消</button>
        <button class="btn primary" id="mOk">保存</button>
      </div>
    `, (box) => {
      box.querySelector('#mCancel').addEventListener('click', closeModal);
      box.querySelector('#mOk').addEventListener('click', () => {
        const amount = Number(box.querySelector('#mAmount').value);
        if (!isFinite(amount) || amount <= 0) { toast('金额填一下', true); return; }
        if (!Number.isSafeInteger(Math.round(amount * 100)) || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) { toast('金额最多保留两位小数，且不能超出安全范围', true); return; }
        const t = new Date(box.querySelector('#mTime').value).getTime();
        if (!Number.isFinite(t)) { toast('请填写有效的交易时间', true); return; }
        const dir = box.querySelector('#mDir').value;
        const cat = (box.querySelector('#mCat').value || '').trim();
        const title = (box.querySelector('#mTitle').value || '').trim();
        const acct = (box.querySelector('#mAccount').value || '').trim() || '现金';
        const note = (box.querySelector('#mNote').value || '').trim();
        const id = 'manual#' + Date.now() + '#' + (state.manualSeq = (state.manualSeq || 0) + 1);
        state.raw.push({
          id: id, src: 'manual', file: '手动记录', seq: state.raw.length,
          time: isFinite(t) ? t : Date.now(),
          dir: dir, dirText: dir === 'in' ? '收入' : '支出',
          amount: amount,
          txType: cat || '手动记录', counterparty: title, item: title,
          status: '已记录', state: 'success', stateFullRefund: false,
          method: acct,
          refundCol: null, fee: 0, orderNo: '', note: note, fundState: '', srcPlace: ''
        });
        closeModal();
        syncBaseDate();
        render();
        scheduleSave();
        toast('已记一笔 ' + money(amount) + ' 元');
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */
  function exportDetail() {
    const rows = C.buildDetailRows(state.filtered, state.bal);
    download('流水明细_' + stamp() + '.csv', toCSV(rows), 'text/csv;charset=utf-8');
  }

  function exportSummary(forGroup) {
    const st = state.settings;
    const g = forGroup || st.groupBy;
    const rows = C.buildSummaryRows(state.filtered, g, state.bal);
    const name = g === 'day' ? '按日汇总' : (g === 'month' ? '按月汇总' : '按年汇总');
    download(name + '_' + stamp() + '.csv', toCSV(rows), 'text/csv;charset=utf-8');
  }

  function exportDailyMonthlyYearly() {
    ['day', 'month', 'year'].forEach((g, i) => setTimeout(() => exportSummary(g), i * 350));
  }

  function exportBackup() {
    const payload = { v: 1, exportedAt: new Date().toISOString(), raw: state.raw, files: state.files, settings: state.settings };
    download('账本备份_' + stamp() + '.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  }

  function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function importBackup(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const next = normalizeWorkspace(JSON.parse(reader.result));
        if (!confirm('恢复备份会替换当前账本，是否继续？建议先导出当前备份。')) return;
        Object.assign(state, next);
        state.page = 1;
        syncFilterInputs();
        renderRules();
        baseSig = '';
        render();
        scheduleSave();
        toast('已恢复 ' + state.raw.length + ' 笔记录');
      } catch (e) {
        toast('备份文件读取失败：' + e.message, true);
      }
    };
    reader.onerror = () => toast('备份文件读取失败', true);
    reader.readAsText(file, 'utf-8');
  }

  /* ------------------------------------------------------------------ *
   * 示例数据
   * ------------------------------------------------------------------ */
  function loadDemo() {
    const demo = window.LedgerDemo.build();
    state.raw = demo.raw;
    state.files = demo.files;
    state.settings.bases = demo.bases;
    state.settings.excluded = [];
    state.settings.filters = { from: '', to: '', keyword: '', dir: 'all', account: 'all', category: 'all' };
    state.settings.excludeKeywords = '';
    state.settings.baseDateAuto = true;
    syncBaseDate();
    baseSig = '';
    render();
    scheduleSave();
    toast('已载入示例数据，可直接体验余额反推');
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */
  function bind() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && saveTimer) { clearTimeout(saveTimer); saveTimer = null; void doSave(); }
    });
    // 导入
    $('btnPick').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      handleFiles(e.target.files);
      e.target.value = '';
    });

    const dz = $('dropZone');
    const overlay = $('dropOverlay');
    let dragDepth = 0;
    ['dragenter', 'dragover'].forEach(ev => {
      document.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev === 'dragenter') dragDepth++;
        overlay.classList.add('on');
        dz.classList.add('hot');
      });
    });
    document.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) { overlay.classList.remove('on'); dz.classList.remove('hot'); }
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      overlay.classList.remove('on');
      dz.classList.remove('hot');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    // 口径 / 分组 / 视图
    $('modeSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      state.settings.mode = b.dataset.mode;
      [...$('modeSeg').children].forEach(x => x.classList.toggle('on', x === b));
      render(); scheduleSave();
    });
    $('groupSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-g]');
      if (!b) return;
      state.settings.groupBy = b.dataset.g;
      [...$('groupSeg').children].forEach(x => x.classList.toggle('on', x === b));
      render(); scheduleSave();
    });
    $('viewSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      state.settings.view = b.dataset.v;
      [...$('viewSeg').children].forEach(x => x.classList.toggle('on', x === b));
      render(); scheduleSave();
    });

    // 基准日
    $('baseDate').addEventListener('change', (e) => {
      state.settings.baseDate = e.target.value;
      state.settings.baseDateAuto = false;      // 用户手动设过 → 以后导入文件也不再覆盖
      render(); scheduleSave();
    });
    $('btnResetBaseDate').addEventListener('click', () => {
      state.settings.baseDateAuto = true;
      syncBaseDate();
      render(); scheduleSave();
      toast('基准日已恢复为账单最后一笔交易的日期');
    });

    // 账户增删
    $('btnAddAccount').addEventListener('click', () => {
      const name = prompt('账户名称（例如：招商银行储蓄卡、现金、余额宝）');
      if (!name) return;
      const acct = name.trim();
      if (!state.settings.extraAccounts.includes(acct)) state.settings.extraAccounts.push(acct);
      baseSig = '';
      render(); scheduleSave();
    });
    $('btnResetBase').addEventListener('click', () => {
      state.settings.bases = {};
      baseSig = '';
      render(); scheduleSave();
    });

    // 筛选：离散控件用 change，文本框统一用 input + 防抖
    // （以前关键词用 change、排除关键词用 input，行为不一致；而且排除关键词每敲一键就全量重算）
    const bindFilter = (id, key) => {
      $(id).addEventListener('change', (e) => {
        state.settings.filters[key] = e.target.value;
        state.page = 1;
        render(); scheduleSave();
      });
    };
    bindFilter('fFrom', 'from');
    bindFilter('fTo', 'to');
    bindFilter('fDir', 'dir');
    bindFilter('fAccount', 'account');
    bindFilter('fCategory', 'category');

    let textTimer = null;
    const bindTextFilter = (id, apply) => {
      $(id).addEventListener('input', (e) => {
        apply(e.target.value);
        state.page = 1;
        clearTimeout(textTimer);
        textTimer = setTimeout(() => { render(); scheduleSave(); }, 260);
      });
    };
    bindTextFilter('fKeyword', v => { state.settings.filters.keyword = v; });
    bindTextFilter('fExclude', v => { state.settings.excludeKeywords = v; });
    $('btnClearFilter').addEventListener('click', () => {
      state.settings.filters = { from: '', to: '', keyword: '', dir: 'all', account: 'all', category: 'all' };
      state.settings.excludeKeywords = '';
      $('fFrom').value = ''; $('fTo').value = ''; $('fKeyword').value = '';
      $('fDir').value = 'all'; $('fAccount').value = 'all'; $('fCategory').value = 'all';
      $('fExclude').value = '';
      state.page = 1;
      render(); scheduleSave();
    });

    // 折叠面板
    document.querySelectorAll('.collapsible > h2').forEach(h => {
      h.addEventListener('click', () => h.parentElement.classList.toggle('closed'));
    });

    // 导出菜单
    $('btnMenu').addEventListener('click', (e) => {
      e.stopPropagation();
      $('exportMenu').classList.toggle('on');
    });
    document.addEventListener('click', () => $('exportMenu').classList.remove('on'));
    $('exportMenu').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-export]');
      if (!b) return;
      $('exportMenu').classList.remove('on');
      const kind = b.dataset.export;
      if (kind === 'detail') exportDetail();
      else if (kind === 'summary') exportSummary();
      else if (kind === 'daily') exportDailyMonthlyYearly();
      else if (kind === 'backup') exportBackup();
    });

    // 备份
    $('btnBackup').addEventListener('click', () => {
      const inp = el('input');
      inp.type = 'file';
      inp.accept = '.json';
      inp.addEventListener('change', () => { if (inp.files[0]) importBackup(inp.files[0]); });
      inp.click();
    });

    // 清空
    $('btnReset').addEventListener('click', () => {
      if (!confirm('确定清空全部账单记录和余额设置吗？此操作不可撤销。')) return;
      state.raw = []; state.files = {}; state.settings = defaultSettings();
      baseSig = '';
      render(); scheduleSave();
      toast('已清空');
    });

    // 手动记一笔 / 示例
    $('btnManual').addEventListener('click', openManualForm);
    $('btnDemo').addEventListener('click', loadDemo);
    $('btnDemo2').addEventListener('click', loadDemo);

    // 弹窗关闭
    $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  async function boot() {
    // 先把上次的数据读回来，再挂事件监听：
    // 否则用户可能在 IndexedDB 读取完成前点「载入示例」，随后被读回来的旧数据覆盖掉。
    await loadSaved();
    bind();
    syncBaseDate();
    syncFilterInputs();
    renderRules();
    render();
    if (state.raw.length) toast('已恢复上次的数据：' + state.raw.length + ' 笔');
  }

  /** 把持久化的筛选条件回填到输入框（只在启动时做一次，避免打断输入） */
  function syncFilterInputs() {
    const f = state.settings.filters;
    $('fFrom').value = f.from || '';
    $('fTo').value = f.to || '';
    $('fKeyword').value = f.keyword || '';
    $('fDir').value = f.dir || 'all';
    $('fAccount').value = f.account || 'all';
    $('fCategory').value = f.category || 'all';
    $('fExclude').value = state.settings.excludeKeywords || '';
    $('modeSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === state.settings.mode));
    $('groupSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.g === state.settings.groupBy));
    $('viewSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === state.settings.view));
  }

  /* ------------------------------------------------------------------ *
   * 测试钩子
   * 浏览器控制台里可以直接看 window.LedgerUI.state，
   * 自动化测试也能靠它驱动真实界面，不用靠"点到某个按钮"来触发。
   * ------------------------------------------------------------------ */
  window.LedgerUI = {
    state: state,
    render: render,
    renderCharts: renderCharts,
    renderHealth: renderHealth,
    renderQuality: renderQuality,
    handleFiles: handleFiles,
    syncBaseDate: syncBaseDate,
    refreshBalances: refreshBalances,
    boot: boot,
    toCSV: toCSV,
    csvCell: csvCell
  };

  document.addEventListener('DOMContentLoaded', boot);
})();
