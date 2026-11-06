# 本地账本契约

- 浏览器入口 index.html，脚本通过 LedgerParse/LedgerCalc/LedgerRules/LedgerStore/LedgerUI 通信，不依赖后端或其他服务。
- 输入：用户选择的微信/支付宝 CSV/TSV/TXT 账单；手动录入交易；标准 JSON 备份。
- 标准备份仍为 `{v:1, raw:Array, files:Object, settings:Object}`。raw 交易的 amount/time 必须为有限数值，设置规则和文件信息必须符合结构；无效备份提示错误，原数据保持不变；有效备份恢复前确认整体替换。
- 内部持久化：LedgerStore.load(key) 返回原 workspace；save(key,value) 返回 `{ok,mode,error?}`。IDB/LS 新增内部信封 `{__ledgerStore:2,revision,value}`，兼容读取旧 raw workspace；IDB/LS 按版本选较新副本，保存串行化，全部持久化失败则返回 ok=false 并保留会话内快照。
- 模式：idb / localStorage / memory；不把内存模式当作持久化成功。
- 导出：标准 JSON 不改变；CSV 保持原列，公式前缀文字转为文本，数值不转为公式。
- 手动金额最多两位小数且为正的安全数值；完整账户名原样参与归一化。
- 页面数据按浏览器来源隔离，端口改变需导出/恢复备份。无网络上传；Python 启动器仅提供静态文件。
- 回滚旧版本前通过标准 JSON 导出，不让旧版直接读取新内部信封。
