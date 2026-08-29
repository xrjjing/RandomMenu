# 今天吃什么 · RandomMenu

家庭菜单小程序：解决每天「吃什么」的选择困难。管理家庭菜谱、按手头原料找菜、随机转盘选菜、做菜记录统计。

## 功能一览

| 模块 | 说明 |
|---|---|
| 菜谱管理 | 内置 80 道家常菜与饮品，可新增 / 编辑 / 删除，支持图片（≤5 张）、原料、分步做法 |
| 原料库 | 独立原料管理：新增 / 重命名 / 删除，展示被引用菜品数，调料自动标记 |
| 按料找菜 | 首页勾选「冰箱里有什么」，支持交集匹配（按匹配度排序）与完全匹配两种模式；另支持自然语言一句话找菜（AI） |
| 随机转盘 | 从候选菜品中 Canvas 绘制转盘随机抽取，确认后直接落账 |
| 做菜记录 | 每日落账可撤销；按日 / 月 / 年统计，柱状图 / 饼图展示，附原料使用榜 |
| AI 助手 | AI 推荐找菜 / 今日简报 / 做菜小贴士 / 信息补全 / 写做法（流式）/ AI 生图与图生图 / AI 月报与分享海报 / 提示词管理 / 用量统计 |

## 技术栈

原生微信小程序 · TDesign miniprogram 组件库 · 微信云开发文档数据库 + 云存储 + 云函数 · Less

- 数据库读写由小程序端 SDK 直连（集合权限全开，见「快速开始」）；云函数仅两个：`login`（openid 身份）与 `ai-image`（AI 生图/图生图，腾讯云 SD 系列）
- AI 生文走小程序端 SDK 直调（`packages/dish/ai/`），支持流式输出；图表与转盘均为 Canvas 2D 自绘组件，无外部图表依赖

## 目录结构

```
RandomMenu/
├── pages/               # 主包四个 tab 页（home 首页 / menu 菜谱 / stats 统计 / more 更多）
├── packages/            # 分包（ingredient 原料库 / dish 菜品详情与编辑 / dish/ai AI 助手）
├── components/          # 自绘组件（spin-wheel 转盘 / bar-chart 柱状图 / pie-chart 饼图）
├── api/                 # 数据层统一封装（db.js 云数据库 / seed.js 内置数据导入 / upload.js 图片上传）
├── utils/               # 纯逻辑工具（normalize 归一化 / seasonings 调料集合 / stats 统计计算）
├── data/                # 内置菜谱数据（builtin-dishes.js，由 scripts 清洗脚本生成）
├── test/                # node --test 单元测试（与 utils 纯逻辑一一对应）
├── scripts/             # 开发脚本（clean-ingredients.js 原料清洗）
├── config/              # 云环境配置
├── custom-tab-bar/      # 自定义 tabBar
├── miniprogram_npm/     # TDesign 组件库（构建产物）
└── dishes.json / drinks.json   # 内置菜谱原始数据源（清洗脚本输入）
```

## 快速开始

1. 用微信开发者工具导入本项目，工具菜单 →「构建 npm」，编译运行。
2. 打开云开发控制台，创建数据库集合：`dishes`、`ingredients`、`records`、`app_meta`。
3. 四个集合的权限均设为**自定义安全规则**：`{"read": true, "write": true}`（家庭内部使用，零云函数的前提）。
4. 小程序「更多」页点击「初始化内置菜谱」，一键导入 80 道内置菜品与 130 种原料（首次导入加锁防重复，重试只补缺失不覆盖）。

## 开发约定

- **数据层收敛**：所有数据库操作只写在 `api/db.js`（及 `api/seed.js`、`api/upload.js`），页面禁止直接调用 `wx.cloud`。
- **纯逻辑进 utils**：可被 node 独立验证的纯函数（归一化、匹配排序、日期、统计）放入 `utils/`，并在 `test/` 下用 `node --test` 配套单测。
- **样式基线**：遵循 `app.less` 设计变量——暖橙主色 `#ff8c42`、圆角卡片 `.card`、浅灰背景 `#f5f6f7`。
- **内置数据**：`data/builtin-dishes.js` 由脚本生成，勿手改；改数据源请重跑清洗脚本。

## 常用命令

```bash
node --test                  # 运行全部单元测试
node scripts/clean-ingredients.js   # 清洗内置菜谱数据（重新生成 data/builtin-dishes.js）
```
