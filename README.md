# 雾光庭院 · mistgarden

> 一个部署在 GitHub Pages 上的个人导航引导页

> [!NOTE]
> **本仓库的全部代码、样式、文档（包括这份自述文件）均由 AI 完成**，仓库主人只负责提出需求、验收效果和发布。

## 简介

`mistgarden`（雾光庭院）是一个简约的个人导航主页。页面用暗色主题加毛玻璃（Glassmorphism）风格，支持昼夜模式切换和背景图自动轮换，右下角还有一个 Live2D 看板娘，适合当浏览器主页，或者作为个人站点的统一入口。

## 功能特性

### 页面

- 🌗 **昼夜模式**：一键切换夜间或白天主题；没有手动选过时，6~18 点自动用浅色
- 🖼️ **动态背景**：随机背景图自动轮换，新旧图交叉淡入淡出，随时可以关闭，改用固定背景
- 🎴 **毛玻璃卡片**：大尺寸云母质感容器，里面有导航、社群等模块
- 📋 **双列导航**：8 个常用站点链接，桌面端和手机端都保持一行两张（手机端显示有问题已经改成适应一行了）
- 💬 **一言**：随机显示一句名言，点击刷新
- 🕐 **实时时钟**：显示当前日期和时间
- ⏱️ **运行计时**：页脚显示网站已经运行了多久
- 🎵 **背景音乐**：APlayer 播放器，用户同意后才加载播放器和音源，不同意就一个音乐请求都不发
- 🎶 **歌单切换**：播放器顶部可以选默认歌单、网易云热歌榜、抖音热门榜，或者自定义歌单（网易云 / QQ 音乐 / 酷狗，填 ID 或分享链接）；QQ、酷狗的歌会自动匹配网易云的完整音源，选择会记住
- 🌸 **樱花和粒子特效**，切到后台时暂停
- 📱 **响应式适配**：支持手机、平板和桌面端

### Live2D 看板娘（电脑端 / 平板）

- 📱 **平板适配**：触摸屏没有悬停，点 👕 / ⓘ 开关菜单，点看板娘身上弹出音乐菜单，点别处收起；手机（含横屏）不加载
- 🎀 **在线模型**：模型来自开源项目 [fghrsh/live2d_api](https://github.com/fghrsh/live2d_api)，通过 jsDelivr CDN 加载，仓库里不放模型文件。现在有 7 个角色、199 套服装，第一次访问默认是 Tia · maid black
- 🧰 **仿原版菜单**：参照 [live2d-widget](https://github.com/stevenjoezhang/live2d-widget)，有文字气泡和竖排工具栏，工具栏里是一言、切换角色、换装、拍照、主题、随机背景、关于、退出
- 👗 **换装**：鼠标停在 👕 上，可以选上一件、下一件、随机，或者输入序号直接换
- 🎶 **音乐互动**：
  - 首次访问由看板娘在气泡里问要不要放音乐，选择前一直显示
  - 鼠标停在看板娘身上，可以开始放歌、上一首、暂停或继续、下一首、打开播放器
  - 切歌时看板娘会报一下歌名
- 💬 **文字提示**：根据时间打招呼；鼠标经过页面元素时说台词；复制内容、切回页面、闲置一段时间时都会说话
- 💾 **记住选择**：角色、服装、是否退出都存在 `localStorage` 里，下次访问自动还原
- 📐 **自动取景**：按模型实际画出来的像素校正缩放和位置，各模型的尺寸声明不统一也能完整显示，气泡贴着头顶放
- 🗄️ **衣柜页** [`wardrobe.html`](wardrobe.html)：按角色分页展示全部服装，缩略图用到时才生成。它通过 `BroadcastChannel` 和主页互通：
  - 在衣柜里点「给看板娘穿上」，主页马上换装
  - 主页换装后，衣柜会同步高亮「正在穿」
  - 主页没开着时，选择会记下来，下次打开主页就穿这件

## 目录结构

```
index.html                 主页（页面结构 + 背景、主题、音乐询问等页面脚本）
style.css                  主页样式（包括看板娘的气泡、工具栏）
wardrobe.html              看板娘衣柜页
assets/
  live2d.js                看板娘：加载、取景、气泡、工具栏、换装、音乐互动、和衣柜互通
  live2d-models.json       角色 / 服装清单（default 字段是首次访问的默认模型）
  wardrobe.js / .css       衣柜页脚本和样式
  player.js                音乐播放器（歌单解析、按需取直链）
  APlayer.min.js / .css    APlayer 播放器
photos/                    图片资源
```

## 自定义

| 想改什么 | 在哪里改 |
| --- | --- |
| 随机背景图 API | `index.html` 里的 `BG_API`（桌面）和 `BG_API_MOBILE`（手机） |
| 歌单（默认歌单 / 榜单） | `assets/player.js` 里的 `PRESETS`（`default` 是默认歌单，ID 都是网易云歌单 ID） |
| 网站运行起始时间 | `index.html` 里的 `startTime` |
| 默认看板娘 / 服装 | `assets/live2d-models.json` 里的 `default: { c: 角色下标, o: 服装下标 }` |
| 看板娘台词 | `assets/live2d.js` 里的 `HOVER`、`CLICK` 和 `welcomeMessage()` |

> 注意：背景图会自动轮换，所以图片 API 的调用量不小。自己部署时请换成自己的图片 API。

改完 `style.css` 或 `assets/*.js` 以后，记得把 `index.html` 里对应的 `?v=` 版本号一起改掉。站点走 Cloudflare 缓存，不改版本号会出现「新 HTML + 旧 CSS」的情况。

## 技术栈

- 纯 HTML + CSS + JavaScript，不依赖前端框架
- Live2D：Cubism 2 Core + PIXI.js v6 + [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)（CDN 按需加载）
- 音乐：[APlayer](https://github.com/DIYgod/APlayer)
- GitHub Pages 静态托管

## 致谢

- Live2D 模型：[fghrsh/live2d_api](https://github.com/fghrsh/live2d_api)，模型版权归各原作者所有，仅供学习交流
- 看板娘交互设计参考：[stevenjoezhang/live2d-widget](https://github.com/stevenjoezhang/live2d-widget)
- 一言：[hitokoto.cn](https://hitokoto.cn)

## License

MIT
