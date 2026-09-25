# 导航配置说明（NAV_LINKS）

Fork 这个仓库之后，**改导航只需要动 `index.html` 最前面那一块**，其余文件都不用碰。

## 改哪里

打开 `index.html`，第 6 行开始就是导航配置区，长这样：

```html
<script>
window.NAV_COLUMNS = 'auto';

window.NAV_LINKS = [
  { name: '主页', desc: '雾光庭院主页', url: 'https://wgty.top', icon: 'https://.../1.jpg' },
  { name: '博客', desc: '个人博客站点', url: 'https://blog.wgty.top', icon: 'https://.../2.jpg' }
];
</script>
```

- 删掉一行 = 少一个卡片
- 复制一行 = 多一个卡片
- 数组顺序 = 页面显示顺序
- 最后一行末尾不要留逗号

## 每个字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 卡片标题 |
| `url` | 是 | 点击后跳转的地址 |
| `desc` | 否 | 副标题，省略则只显示标题 |
| `icon` | 否 | 图片网址（`http(s)://`、`data:`、`/` 或 `./` 开头）或直接写 emoji，如 `'🎵'`；留空时显示 `name` 的首字 |
| `newTab` | 否 | 默认新标签页打开；写 `newTab: false` 就在当前页打开 |

两种图标写法：

```js
{ name: '音乐', desc: '在线听歌', url: 'https://music.example.com', icon: '🎵' }
{ name: '图床', desc: '图片托管', url: 'https://image.example.com', icon: './photos/tuchuang.png' }
```

## 列数怎么变

`NAV_COLUMNS = 'auto'` 时，先按导航数量算出一个**列数上限**：

| 导航数量 | 列数上限 | 效果 |
| --- | --- | --- |
| 1 ~ 8 | 2 | 保持原来的双列 |
| 9 ~ 15 | 3 | 9 个正好 3 × 3 |
| 16 及以上 | 4 | 16 个正好 4 × 4 |

再和**屏幕档位**取较小值，得到实际列数：

| 屏幕宽度 | 最多几列 | 说明 |
| --- | --- | --- |
| ≥ 1920px | 4 | 16 个导航在这里才是 4 × 4 |
| 1025 ~ 1919px | 3 | 9 个导航在这里是 3 × 3 |
| 421 ~ 1024px | 2 | 平板 / 手机，和改造前完全一样 |
| ≤ 420px | 1 | 竖屏手机放不下两列时的单列长条，同样没改 |

> 8 个导航在任何屏幕上都还是老样子的 2 列，这次改造对现有站点零影响。

想固定列数上限，把 `NAV_COLUMNS` 改成 `2`、`3` 或 `4`（写数字，不要引号）：

```js
window.NAV_COLUMNS = 3;   // 上限锁成 3 列；窄屏仍会按档位降到 2 / 1 列
```

### 多出来的列怎么放下

**全靠内容区向两侧扩展，卡片一点都不缩。** 图标始终 48px、标题 15px、描述两行、
右侧箭头保留，和 2 列时完全一致。

`.container` 的 `max-width` 按列数变化，同时左右留出死区，避开两个固定浮层：

```
看板娘 .live2d-wrap   right: 0      宽 min(40vw, 380px)
播放器                left: 16px    宽 280px
--nav-safe: 390px     ← 380 + 10 缝隙，内容区两侧各让出这么多

max-width = min( 理想宽度 , max( 保底宽度 , 100vw - --nav-safe × 2 ) )
```

| 列数 | 理想宽度 | 保底宽度 |
| --- | --- | --- |
| 2 | 720px（不变） | — |
| 3 | 1040px | 760px |
| 4 | 1370px | 不需要：4 列只在 ≥1920px 出现，1920 − 780 = 1140px 已经够宽 |

换算公式：`卡片宽 = (容器宽 − 40 容器内边距 − 32 卡片内边距 − 12 × (列数 − 1) 间距) ÷ 列数`

实现上由渲染脚本把列数写到 `<body data-nav-cols="N">`，CSS 再用
`body[data-nav-cols="N"] .container` 调整宽度
（CSS 无法从 `.link-grid` 向上选中父级 `.container`，所以要借 body 传递）。

## 各屏宽下的实际表现

| 视口宽度 | 16 个导航 | 容器 | 卡片宽 | 两侧死区 | 压到看板娘 |
| --- | --- | --- | --- | --- | --- |
| 2560px | **4 × 4** | 1370px | 306px | 595px | 否 |
| 1920px | **4 × 4** | 1140px | 248px | 390px | 否 |
| 1600px | 3 × 6 | 820px | 228px | 390px | 否 |
| 1440px | 3 × 6 | 760px | 208px | 340px | 40px |
| 1366px | 3 × 6 | 760px | 208px | 303px | 77px |
| 1024px | 2 × 8 | 720px | 298px | 152px | 和改造前一致 |
| ≤ 420px | 单列 | 按屏宽 | — | — | 和改造前一致 |

1366 ~ 1440px 这一档卡片只有 208px，是为了给看板娘让位。觉得太窄的话，把 `style.css`
里的 `--nav-safe` 调小（例如 `200px`）就能换回更宽的卡片，代价是内容区右缘会压到看板娘身上。

改这几条 `@media` 时注意：都要写成 `body[data-nav-cols="N"] .xxx` 的形式，
和基础规则保持同样的优先级，靠书写顺序决定谁生效。若写成 `.link-grid[data-cols]`
优先级会低于前面的规则，导致规则不生效。

## 实现位置

| 位置 | 作用 |
| --- | --- |
| `index.html` 头部 `NAV_LINKS` / `NAV_COLUMNS` | 数据与列数上限 |
| `index.html` 的 `<nav id="linkGrid">` 及其后的内联脚本 | 用 DOM API 渲染卡片，算出列数写入 `data-cols` 与 `body[data-nav-cols]` |
| `style.css` 的 `.link-grid[data-cols="N"]` 规则 | 各列数下的栅格 |
| `style.css` 的 `body[data-nav-cols="N"] .container` | 各列数下的内容区宽度（向两侧扩展） |
| `style.css` 的 `--nav-safe` | 左右死区宽度，避开看板娘 / 播放器 |
| `style.css` 的 `@media 1919/1024/640/420` | 屏幕档位决定的列数上限 |

渲染全程使用 `createElement` + `textContent`，配置里的文字不会被当作 HTML 解析，标题里放 `<` `&` 之类的字符是安全的。

## 注意

改完 `style.css` 记得把 `index.html` 里 `style.css?v=` 的版本号一起改（站点走 Cloudflare，CSS 边缘缓存 4 小时，不换版本号会出现「新 HTML + 旧 CSS」）。只改 `NAV_LINKS` 不动 CSS 的话，不需要改版本号。
