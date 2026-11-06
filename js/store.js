/* =========================================================================
 * store.js —— 本地持久化
 *
 * 优先 IndexedDB（容量大）；不可用时退回 localStorage；再不行就纯内存。
 * 所有数据只留在本机浏览器，不上传任何服务器。
 * ========================================================================= */
window.LedgerStore = (function () {
  'use strict';

  const DB_NAME = 'local-ledger-db';
  const DB_VER = 1;
  const STORE = 'kv';
  const LS_KEY = 'local-ledger-workspace';

  let dbPromise = null;
  let mode = 'unknown';   // 'idb' | 'localStorage' | 'memory'

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('no indexedDB')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => reject(req.error || new Error('indexedDB open failed'));
      req.onblocked = () => reject(new Error('indexedDB blocked'));
    }).catch((err) => { dbPromise = null; throw err; });
    return dbPromise;
  }

  function idbGet(key) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbSet(key, value) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  function idbDel(key) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  const memory = new Map();

  /**
   * 读 localStorage 里的旧数据。
   * 数据损坏（比如上次写到一半被中断）时 JSON.parse 会抛异常 —— 以前这个异常
   * 会一路冒到 load() 的兜底分支，于是每次启动都读不出数据、账本看着是空的，
   * 而且坏数据还留在原地，下次照样坏。这里直接把坏数据清掉。
   */
  function readLS() {
    let raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { return null; }
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (e) {
      try { localStorage.removeItem(LS_KEY); } catch (e2) { /* ignore */ }
      return null;
    }
  }

  // 保留存储版本号并比较两份副本；降级写入成功后，即使旧 IDB 删除失败也不会回滚。
  let revision = 0;
  let saveQueue = Promise.resolve();
  function unwrap(v) {
    return v && v.__ledgerStore === 2 ? v.value : v;
  }
  function version(v) {
    return v && v.__ledgerStore === 2 ? Number(v.revision) || 0 : 0;
  }
  async function load(key) {
    if (memory.has(key)) { mode = 'memory'; return unwrap(memory.get(key)); }
    const ls = readLS();
    let idb;
    let idbOK = false;
    try { idb = await idbGet(key); idbOK = true; } catch (e) { /* 读取备用副本 */ }
    // 旧版成功写 IDB 时会清 LS，因此无版本号时 LS 的存在表示较新的降级副本。
    const useLS = ls != null && (idb === undefined || version(ls) >= version(idb));
    const chosen = useLS ? ls : idb;
    revision = Math.max(revision, version(chosen));
    mode = useLS || !idbOK ? 'localStorage' : 'idb';
    return unwrap(chosen);
  }

  function save(key, value) {
    // 调用时拍快照并串行落盘，避免异步旧写入最后完成而覆盖新记录。
    let snapshot;
    try { snapshot = JSON.parse(JSON.stringify(value)); }
    catch (e) { return Promise.resolve({ ok: false, mode, error: '数据无法序列化，请导出备份。' }); }
    revision = Math.max(Date.now(), revision + 1);
    const entry = { __ledgerStore: 2, revision, value: snapshot };
    const job = saveQueue.then(async () => {
      memory.set(key, entry);
      try {
        await idbSet(key, entry);
        mode = 'idb';
        try { localStorage.removeItem(LS_KEY); } catch (e) { /* 比较版本号兜底 */ }
        memory.delete(key);
        return { ok: true, mode };
      } catch (e) {
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(entry));
          mode = 'localStorage';
          memory.delete(key);
          return { ok: true, mode };
        } catch (e2) {
          mode = 'memory';
          return { ok: false, mode, error: '浏览器存储不可用，数据仅保留在本次会话，请及时导出备份。' };
        }
      }
    });
    saveQueue = job.catch(() => {});
    return job;
  }

  function currentMode() { return mode; }

  return { load, save, currentMode };
})();
