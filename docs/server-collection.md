# 服务器采集与媒体证据接口

常驻采集由 CyberMemoir [独立采集服务](https://github.com/CyberMemoir/cyber-memoir/tree/codex/bilibili-text-collector-20261014/apps/collector) 调度；工作台仅在同机 `127.0.0.1:4321` 提供串行浏览器任务。正常配置账号后可使用 `DOUYIN_HEADLESS=true`，不用 AI 调度、LLM、OCR/ASR 或全视频理解。

`POST /api/search`、`/api/trends`、`/api/comments` 接受 32–128 个字母/数字/下划线/连字符的 `Idempotency-Key`。保留 JSON、`X-Studio-Client: 1` 和同机访问限制。回执含原请求摘要和 job ID，与任务一起先 fsync/原子替换 state，再执行浏览器操作或返回响应。相同键/输入返回原任务；输入冲突或原结果淘汰返回 409，不产生新任务。达到 10000 回执容量返回 503，需归档运维，不能靠换键继续重提。

`GET /api/receipts/:key` 找回提交结果（未收到提交则 404），`GET /api/jobs/:id` 读取持久状态。进程重启会将原未完成任务标为失败；不会用未保存的闭包重新执行。丢失提交响应时先查原键，不用新键猜测。完成结果依旧受瞬时任务历史上限约束，因此中央服务及时归档；回执墓碑保留，避免历史淘汰导致重复提交。

搜索接受 `maxScrolls` 0–2，默认 2；滚动之前至少等 20 秒。评论仍限顶层响应和有限滚动，保存原始响应哈希与 JSON pointer。搜索/详情/热榜的访问限制与评论共享持久暂停标记 `comments-access-pause.json`（保留旧文件名兼容），读取在连接浏览器前检查。人工处理官方页面后，保存旧标记、解除并重启工作台，最后恢复中央队列；没有自动试探恢复。

查询 trim 后须为 1–400 个 UTF-16 单元，中央配置校验与此保持一致。即使末页 `has_more=0`，若观察到的评论超过 `limit` 而规范化输出被截断，`endReason` 仍为 `limit`；原始页保留，中央窗口记为 partial，不能标为入口已完整导出。

共享服务负责发现热词后有界搜索视频、可选自动派发评论、跨窗口去重、磁盘预算和告警。热词不是实际人的搜索日志，标题/评论是观察表达，原研究者输入另存。单次 `scripts/collect.ts` 保留原有有界工作流，常驻队列不要与 UI 的大量手动任务混用。

离线测试验证回执重放、重启恢复、冲突拒绝和原有页面解析；真实账号、Linux 常驻浏览器、连续窗口和监控通知仍待服务器验收。

## 可选媒体证据描述

中央服务先用原有 keyed `/api/search` 解析一个规范视频 URL，再用完成任务的 `GET /api/jobs/:id/source-media` 取得 `schemaVersion: 1`、videoId、canonicalUrl、observedAt、durationSeconds、mediaUrls、subtitleTracks 和 subtitleCoverage。媒体地址只取带请求视频 ID 的结构化记录；通用 DOM video 元素的 UI fallback 不进入证据下载。描述只在成功 resolve 任务上可用；缺失、未完成或已淘汰返回 409，不新建任务。描述随 state 持久保存并随瞬时任务淘汰，不从后续更新的视频缓存猜回旧任务结果。

`subtitleTracks` 只来自详情页面正常提供的 `video track[src]`；`page_tracks_only` 不代表全平台字幕覆盖。没有 OCR/ASR、模型 fallback 或猜测地址。临时媒体/字幕直链只通过该同机端点提供给中央归档，不进入普通 `/api/state`、事件快照、任务、回执和搜索导出。state.json 仍是私有文件。

中央 `collect_media` 默认关闭；启用后由中央按数量/字节/请求预算获取直链 MP4 与现成字幕、保存哈希和时间定位。工作台不自动下载新文件、不合并/解密分段、不生成梗定义或关系。现有 UI 下载功能保持独立，常驻采集不要与同账号的大量手动操作混跑。离线 API/重启/隐私测试不等同真实媒体可取得或可播放验收。

