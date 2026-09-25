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

`NAV_COLUMNS = 'auto'` 时，列数跟着导航数量走：

| 导航数量 | 列数 | 效果 |
| --- | --- | --- |
| 1 ~ 8 | 2 | 保持原来的双列 |
| 9 ~ 15 | 3 | 9 个正好 3 × 3 |
| 16 及以上 | 4 | 16 个正好 4 × 4 |

想固定列数，把 `NAV_COLUMNS` 改成 `2`、`3` 或 `4`（写数字，不要引号）：

```js
window.NAV_COLUMNS = 3;   // 无论多少个都强制 3 列
```

3 列和 4 列时卡片会自动瘦身：内边距、图标、字号变小，描述收成一行，4 列还会隐藏右侧箭头，避免文字被挤爆。

## 窄屏降级

无论配了几列，小屏都会自动降级，不需要额外配置：

| 视口宽度 | 实际列数 |
| --- | --- |
| > 900px | 按 `data-cols`（2 / 3 / 4） |
| ≤ 900px | 最多 3 列（4 列降为 3 列） |
| ≤ 640px | 统一 2 列 |
| ≤ 420px | 单列 |

## 实现位置

| 位置 | 作用 |
| --- | --- |
| `index.html` 头部 `NAV_LINKS` / `NAV_COLUMNS` | 数据与列数开关 |
| `index.html` 的 `<nav id="linkGrid">` 及其后的内联脚本 | 用 DOM API 渲染卡片，算出列数写入 `data-cols` |
| `style.css` 的 `.link-grid[data-cols="N"]` 规则 | 各列数下的栅格与卡片尺寸 |
| `style.css` 的 `@media 900/640/420` | 窄屏降级 |

渲染全程使用 `createElement` + `textContent`，配置里的文字不会被当作 HTML 解析，标题里放 `<` `&` 之类的字符是安全的。

## 注意

改完 `style.css` 记得把 `index.html` 里 `style.css?v=` 的版本号一起改（站点走 Cloudflare，CSS 边缘缓存 4 小时，不换版本号会出现「新 HTML + 旧 CSS」）。只改 `NAV_LINKS` 不动 CSS 的话，不需要改版本号。
