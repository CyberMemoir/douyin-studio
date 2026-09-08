# Douyin Studio visual specification

Reference: `concept.png`, generated with built-in Image Gen before implementation (1536 × 1024).

## Brief / prompt

A complete Chinese local-first video discovery web app, not a landing page. True-white sidebar and panels, cool near-white workspace, coral action color, ink typography, outlined icons, deliberate whitespace. Sidebar: 视频搜索 / 实时热点 / 下载中心 / 使用指南. Header: 工作台 / 视频搜索 and GitHub. Heading: 找到值得收藏的内容。 Supporting text: 搜索抖音视频，追踪实时热点，把灵感保存到本地。 Search placeholder: 搜索关键词，或粘贴抖音视频链接. Search button: 搜索. Count selector: 结果数量 / 20 条. Result panel: 搜索结果 / 等待搜索; film-search empty icon; 下一份灵感，从这里开始; 输入关键词探索视频，或粘贴分享链接直接解析。 Suggestions: AI 工具 / 旅行灵感 / 摄影技巧. Bottom steps: 01 扫码登录 / 02 搜索或粘贴 / 03 保存到本地. Right rail: 此刻热榜 / 来自抖音实时热榜 / 热点正在等你发现 / 获取热榜 / 点击话题，一键搜索相关视频. Bottom sidebar: browser connection state / 仅在本机运行 / 检查连接. Footer: 内容与登录数据保存在这台电脑，不上传到服务器。 No invented metrics or photos; all UI code-native, no decorative gradients or eyebrows.

## Tokens and anatomy

- Workspace #f8f9fb, surfaces #ffffff, ink #20232b, secondary #747782, line #e0e2e8; accent #ed4d63, selected #fff0f2.
- Sidebar 260 px at desktop; header 76 px; content 48 px padding. Desktop two-column results / trends rail 2fr / 1fr, 18 px gap.
- Chinese sans-serif PingFang SC / Microsoft YaHei / system; 36 px H1, 18 px supporting copy, 18 px panel titles, 14–16 px controls.
- Radius 8 px inputs and buttons, 10 px panels; no elevated nested card containers.
- Lucide thin outlined search, flame, download, book, external-link, refresh icons; code-native play brand and film-search icon.
- Explicit responsive variant: compact brand / horizontal navigation and one content column below 900 px; input and action remain usable at 390 px.

## Components and behavior

App shell; SearchView; SearchResults and video result rows; TrendPanel and full TrendView; DownloadsView and task rows; GuideView; connection dialog; shared Buttons/EmptyState/feedback; API state hooks. All content states come from the local backend, not fixture data.

## Necessary state variants

Actual connection status replaces the mockup's preselected connected label. Video rows use live covers and metadata after a real search; download actions use actual transfer progress; failures and login requirements remain explicit. Guide and download views extend the same surface / table / typography language. No unrelated publishing, AI generation, comments, messages, or analytics screens.
