# Zotero PDF Noir（中文说明）

Zotero PDF 阅读器的深色模式图像处理插件。白底插图不再刺眼：接近白色的
中性像素一律透明（全图处理，无内部例外），接近黑色的中性像素按同一条镜像
对称色带翻转亮度、提亮为前景浅色，彩色原样保留。插图的轮廓线、标注、
图标、网格线等内容烘焙在位图里，走这套像素变换；PDF 若在位图之上另画了
矢量副本，则由 Zotero 自带的深色处理（pdf.js 的 `Blender`）映射，页面级
矢量内容（正文、栏线）同样交给 Zotero。

已在 Zotero 10.0.6（Firefox ESR 140）上以 `samples/` 中的样例论文验证
（第 2 页 Fig. 1、第 5 页 Fig. 3，阅读器深色主题）。

## 安装与使用

```sh
bun install
bun run build
```

1. Zotero 中打开 **工具 → 插件**，点击齿轮图标 ⚙，选择
   **Install Add-on From File…（从文件安装插件）**。
2. 选择 `build/zotero-pdf-noir-<版本>.xpi`。
3. 确认安装提示；如要求则重启 Zotero。
4. 在阅读器中打开 PDF，并选择**深色主题**（阅读器工具栏的「Aa」主题
   按钮；「Dark」即默认深色主题）。浅色主题下插件有意不介入。

插件只处理 PDF 中的光栅图像；页面文字、矢量图形与阅读器界面仍由 Zotero
自身处理。

## 结构

| 路径 | 用途 |
|---|---|
| `manifest.json` | 插件 ID `pdf-noir@zotero-plugins`；`applications.zotero` 必须同时含 `id`、`update_url`、`strict_max_version`，缺一即被 Zotero 拒装 |
| `bootstrap.js` | 生命周期、查找查看器窗口、向 pdf.js 查看器 realm 注入脚本、收集日志、开发用自动打开 |
| `content/scripts/noir/classify.js` | 白底线图判定（运行于查看器 realm） |
| `content/scripts/noir/transform.js` | 像素变换（运行于查看器 realm） |
| `content/scripts/noir/cache.js` | 特征缓存（与参数无关）+ 变换画布缓存，按上游图像身份分键 |
| `content/scripts/noir/hook.js` | 拦截 `Blender.prototype.customDrawImage`、记录上游图像身份、分发绘制 |
| `prefs.js` | `extensions.pdf-noir.enable`（布尔）、`extensions.pdf-noir.sensitivity`（字符串 `"0.7"`） |
| `scripts/build.ts` | 零依赖打包 → `build/*.xpi`（附完全相同的 `.zip`） |
| `docs/m0-findings.md` | Zotero 10.0.6 深色模式图像渲染机制（M0 调查结论） |

## 实现要点

### 拦截点

Zotero 的 pdf.js 分支用 `Blender` 类处理深色模式图像。其构造函数用实例
自有箭头函数覆盖 `ctx.drawImage`（`... => this.customDrawImage(args)`），
使一切 canvas 层钩子失效。因此插件包装
`Blender.prototype.customDrawImage`，在查看器 realm 内经实例原型链取得：

```
PDFPageProxy.prototype.render
  -> InternalRenderTask.prototype.initializeGraphics   （取得 gfx）
    -> CanvasGraphics.prototype.paintInlineImageXObject[Group]
         （记录上游 imgData/bitmap 身份，供缓存使用）
    -> Blender.prototype.customDrawImage               （真正的钩子）
```

阅读器打开后的首屏渲染可能先于钩子就绪；就绪后插件会对页面视图调用一次
`reset()` + `pdfViewer.update()`，使当前可见页立即重渲染并走上 noir 路径。

`customDrawImage` 收到的是原始 drawImage 参数（3/5/9 参数形式）。包装函数
按与 Blender 完全相同的口径解析源矩形，然后：

- 以下情形原样透传：`ctx.skipBlender`、浅色主题（`!blender.dark`）、主题
  `invertImages`（如 Zotero 的「黑色」主题）、整页候选、超过 8MP 的图像。
  整页候选指「包围盒面积与页面面积之差小于页面面积的 25%」，即整页扫描件；
- 其余先判定；白底线图则用 noir 变换后的画布，经 Blender 自带的
  `origDrawImage` 以相同参数形式绘制；
- 判定不中则调用原始 `customDrawImage`，Blender 行为完全不变。

安全：插件触碰的每个 pdf.js 内部符号都先做存在性检查，Zotero 升级改名后
会安全退化为「不介入」；原方法每次绘制只调用一次，try/catch 只包裹 noir
准备阶段，任何异常都回退到未改动的原始调用；卸载时恢复所有被包装的方法并
删除标记，停用/启用循环后可干净地重新安装。

### 判定（`classify.js`）

特征在降采样副本（长边约 192px）上计算，变换本身始终使用源分辨率以保
细线。三个特征均为 0..1 的比例：

| 特征 | 定义 |
|---|---|
| `nearWhite` | 明度 > 0.94 且相对饱和度 < 0.1 |
| `lowSat` | 通道极差 <= 32 或相对饱和度 < 0.2 |
| `flat` | 相邻像素对的最大通道差 <= 12 |
| `darkNeutral` | （仅记录）L < 0.5 且中性 |

三者同时达到阈值才判为白底线图。阈值由灵敏度 pref `s`（0..1）派生：

```
tNearWhite = 0.45 - 0.27*s      (s=0.7 → 0.261)
tLowSat    = 0.75 - 0.25*s      (s=0.7 → 0.575)
tFlat      = 0.55 - 0.25*s      (s=0.7 → 0.375)
```

默认 `0.7`（激进）按产品决定选取，可覆盖白底 + 彩色曲线的常见论文插图。

### 变换（`transform.js`）

中性色明度轴由**一条镜像对称的中性色带**统一处理（`params(s)`）：近白端与
近黑端宽度相同、ramp 形状相同、彩色门限相同，两端分别施加对称的效果：

| 端 | 色带（s = 0.7） | 效果 |
|---|---|---|
| 近白端 | `[whiteLo, whiteHi]` = `[0.768, 0.934]` | `alpha = 255 * (1 - wWhite)` —— 去除 |
| 近黑端 | `[darkLo, darkHi]` = `[0.066, 0.232]` | `rgb = mix(rgb, flipped, wDark)` —— 亮度翻转 |

其中 `darkLo = 1 - whiteHi`、`darkHi = 1 - whiteLo`，两端永远共享同一带宽；
`sensitivity` 同时加宽或收窄两端。ramp 连续平滑，抗锯齿边缘渐变过渡而非硬
阈值光晕；中间亮度区间不动。

`flipped` 是该像素明度的镜像（`L -> 1 - L`）落在「主题前景 → 白」轴上的
颜色：最深的墨色落在主题前景色上，纯黑接近白——正是近白端「变为主题背景」
的镜像。**高饱和像素不动**（绝对通道极差门限 `spread >= neutralSpread`），
红/橙/蓝/绿曲线保持原色。不做连通性判断、没有内部例外：接近白色的像素无论
在何处都按背景处理（白色填充块、面板、烘焙白字同样去除）。

变换就地单遍修改 `ImageData`，并按「上游图像身份 + 源矩形 + 像素尺寸 +
参数」缓存；同一图像同一缩放下的重复渲染（滚动、重绘）直接命中缓存；只改
`sensitivity` 时复用已缓存的分类特征，仅重算变换。样例论文实测：815x629
图像约 20ms、1629x1258/2100x2389 图像约 85–135ms（仅首次渲染）。

### 日志

统一 `[PDF-Noir]` 前缀写入 Zotero 调试日志（`-console` 或
帮助 → Debug Output Logging → View Output）。每次图像绘制一行，命中与
未命中都有：

```
[PDF-Noir] #1 img1 815x629 src=up noir cache=miss cls=miss feats{white=0.880 lowSat=0.968 flat=0.891 dark=0.023} thr{white=0.261 lowSat=0.575 flat=0.375} ms=20 removed=0.895
[PDF-Noir] #2 img2 900x675 src=up pass cls=miss feats{white=0.000 lowSat=0.217 flat=0.328 dark=0.031} thr{white=0.261 lowSat=0.575 flat=0.375} ms=3
```

`src=up` 表示缓存键来自上游 `imgData`/bitmap；`noir` 表示已变换，`pass`
表示原样交给 Blender（`skip=...` 标注原因：`lightTheme`、`forceInversion`、
`entirePage`、`tooLarge`）；`cache=` 为变换画布缓存，`cls=` 为分类特征缓存。
查看器 realm 无法调用 `Zotero.debug`，日志先缓存在窗口上，由
`bootstrap.js` 每 1.5s 收集转发。注意 Zotero `-console` 的 stdout 有缓冲，
重定向的日志文件可能要到 Zotero 退出后才完整。

## 偏好设置

| Pref | 默认 | 含义 |
|---|---|---|
| `extensions.pdf-noir.enable` | `true` | 总开关（未设置视为启用） |
| `extensions.pdf-noir.sensitivity` | `"0.7"` | 判定/变换的激进程度 0..1，字符串存储（Firefox 默认偏好无浮点类型） |
| `extensions.pdf-noir.devAutoOpenItem` | 未设置 | 仅开发用：启动时打开指定 item ID（自动化测试 profile 使用；未设置时无行为） |

修改方法：

1. **编辑 → 设置 → 高级 → 配置编辑器**，接受警告。
2. 搜索 `extensions.pdf-noir`。
3. `extensions.pdf-noir.enable` 为布尔值；`extensions.pdf-noir.sensitivity`
   为 **字符串**，取值 `"0"`–`"1"`，越大越激进（同时加宽共享中性色带的
   两端），默认 `"0.7"`。
4. 阅读器打开期间约 1.5s 后生效；要立即看到效果，缩放或滚动 PDF 触发页面
   重渲染（缓存按灵敏度分键，新值在下一次渲染时应用）。

## 构建

```sh
bun install
bun run build
# → build/zotero-pdf-noir-<版本>.xpi
# → build/zotero-pdf-noir-<版本>.zip（内容完全相同；xpi 本质即 zip）
```

xpi 根路径仅含 `manifest.json`、`bootstrap.js`、`prefs.js` 与 `content/`。

## 验证（M2.1 实际执行）

1. 在 `%TEMP%` 建立独立测试 profile：`extensions.startupScanScopes=1`、
   `ui.systemUsesDarkMode=1`，`extensions/` 下放 proxy 文件指向本仓库
   （迭代期免打包）。
2. 以 `-no-remote -profile <测试> -datadir <测试> -console` 启动 Zotero。
3. 打开样例论文、深色主题，日志确认：
   - Fig. 1（`815x629`）：`noir ... feats{white=0.880 lowSat=0.968 flat=0.891}`
   - Fig. 3（`1050x1195`）：`noir ... feats{white=0.780 lowSat=0.862 flat=0.841}`
   - 一张照片类图像（`900x675`）：`pass ... feats{white=0.000 lowSat=0.217 flat=0.328}`
   - 灵敏度改为 `"0.25"` 后日志阈值变为
     `thr{white=0.383 lowSat=0.688 flat=0.488}`。
   - 同一缩放下的重复渲染出现 `cache=hit`（上游身份跨渲染稳定）。
4. `winapp ui screenshot` 截图确认：Fig. 1、Fig. 3 白底消失、细线与坐标
   标注可读、彩色曲线与曲面保持原色，渲染无破损。
5. 阅读器打开状态下停用 → 启用插件：钩子能重新安装并继续绘制（无重复
   包装、无残留标记）。

## 已知行为 / 副作用

- **所有接近白色的中性像素都会去除**，包括图内白色填充与面板（Fig. 1 的
  白色地面、Fig. 3 的白色绘图区底面）。其上的墨色会提升为前景浅色，因此
  白底上的黑网格、黑字变为浅色且可读。这是既定行为（无内部例外）。
- **浅色低饱和填充同样会被淡化**（如 Fig. 1 的浅粉椭圆会变成略透的灰粉）。
  这是「近白中性色一律去除」的必然代价；调低 `sensitivity` 可保留更多此类
  浅色调。
- **图内深色线条由像素层翻转。** 插图的轮廓线、标注、图标、网格线等内容
  烘焙在位图里，共享的近黑色带能直接覆盖（Fig. 1 实测：图区内 max<40 的
  像素数由上一版的 2516 降为 0）。
- **PDF 可能还会在位图之上叠加图内元素的矢量副本**（样例第 2 页有 35 条
  近黑填充标注路径，其矩形落在位图矩形内）。这些样式在到达本插件之前，
  已被 Zotero 自带的 Blender 映射为主题浅色（实测 `styles seen=50
  rewritten=0`，到达值为 `stroke #d8dee9`、`fill #b5bbc6`），因此它们不是
  轮廓显深的原因，本插件不介入。M3 曾实现矢量层 hook，后因冗余而删除。
- 整页光栅图（扫描页）透传给 Blender 原有处理，不做 noir 变换。
- `invertImages` 主题（如 Zotero 的「黑色」主题）整体透传，保持其全反相
  行为；浅色主题不介入。
- 阅读器打开期间每 1.5s 重读一次 `sensitivity`；改动影响图像的下一次
  渲染。
- 仅在 Zotero 10.0.6 上验证。

## 排障

1. **确认插件已启用**：工具 → 插件，确认「Zotero PDF Noir」为启用状态，
   安装或更新后重启过 Zotero。
2. **确认阅读器主题**：插件只作用于深色主题；用阅读器工具栏的「Aa」按钮
   切到「Dark」等深色主题。
3. **重新打开 PDF**：关闭阅读器标签页再打开——钩子在阅读器启动时安装并
   强制重绘一次；在此之前已渲染完成的页面要等重渲染才会应用。
4. **查看日志**：帮助 → Debug Output Logging → View Output（或以
   `-console` 启动），搜索 `[PDF-Noir]`：
   - 出现 `hook install build=...` 与 `attached; Blender hook armed` 说明
     钩子已就绪；
   - 逐图像行会显示 `noir` 或 `pass` 及实测特征值；`pass skip=...` 会说明
     插件有意不处理的原因（`lightTheme`、`forceInversion`、`entirePage`、
     `tooLarge`）；
   - 若完全没有相关行，说明本次没有绘制光栅图像——纯文本页不经过该路径。
