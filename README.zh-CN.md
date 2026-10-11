# Zotero PDF Noir（中文说明）

[English](README.md)

Zotero PDF 阅读器的深色模式图像处理插件。白底插图不再刺眼：接近白色的
中性像素一律透明（全图处理，无内部例外），接近黑色的中性像素按同一条镜像
对称色带翻转亮度、提亮为浅色；颜色由相对色度门限过滤——发布默认下只有
完全饱和的像素保持不动。插图的轮廓线、标注、图标、网格线等内容烘焙在位图
里，走这套像素变换；PDF 若在位图之上另画了矢量副本，则由 Zotero 自带的
深色处理（pdf.js 的 `Blender`）映射，页面级矢量内容（正文、栏线）同样
交给 Zotero。

## 安装

### 从发布包安装（推荐）

1. 从 [GitHub Releases](https://github.com/Zhanyuanium/Zotero-PDF-Noir/releases)
   下载 `.xpi` 文件。
2. Zotero 中打开 **工具 → 插件**，点击齿轮图标 ⚙，选择
   **Install Add-on From File…（从文件安装插件）**。
3. 选择下载的 `.xpi`，确认安装提示。
4. 如提示要求则重启 Zotero（本插件为 bootstrapped 扩展）。
5. 在阅读器中打开 PDF，并选择**深色主题**（阅读器工具栏的「Aa」主题
   按钮；「Dark」即默认深色主题）。浅色主题下插件有意不介入。

插件声明支持 Zotero 10.0.0 起，实机测试在 Zotero 10.0.6 上完成。安装
XPI 不需要 Bun、Node 或独立 Firefox。插件依赖 Zotero 10 的 `Blender`
行为，`manifest.json` 在 10.0.0 以下拒绝安装。

### 从源码构建（开发路径）

```sh
bun install
bun run build
```

随后按上面的步骤安装 `build/zotero-pdf-noir-<版本>.xpi`。

### 设置

插件通过自带的设置面板配置：**编辑 → 设置 →「Zotero PDF Noir」**，位于
设置侧边栏底部。面板包含总开关与三个相互独立的数值滑杆——中性色阈值、
亮度带宽、检测灵敏度——每个滑杆都有实时百分比数值显示，另有**恢复默认**
按钮。修改后约 1.5 秒内即可在已打开的阅读器中生效，无需滚动或缩放。

全新配置以 100%（阈值）、60%（亮度带宽）、70%（检测灵敏度）起步；默认值
只在偏好从未被设置过时生效，因此已有配置保留原值，没有迁移逻辑。

插件只处理 PDF 中的光栅图像；页面文字、矢量图形与阅读器界面仍由 Zotero
自身处理。

## 结构

| 路径 | 用途 |
|---|---|
| `manifest.json` | 插件 ID `pdf-noir@zotero-plugins`；`applications.zotero` 含 `id`、`update_url`、`strict_min_version`（10.0.0）与 `strict_max_version` |
| `bootstrap.js` | 生命周期、查找查看器窗口、向 pdf.js 查看器 realm 注入脚本、精确版本号校验、收集日志、开发用自动打开 |
| `content/scripts/noir/classify.js` | 白底线图判定（运行于查看器 realm） |
| `content/scripts/noir/transform.js` | 像素变换（运行于查看器 realm） |
| `content/scripts/noir/cache.js` | 特征缓存（与参数无关）+ 变换画布缓存，按上游图像身份分键，受单图上限与全局字节预算（LRU 淘汰）约束 |
| `content/scripts/noir/hook.js` | 拦截 `Blender.prototype.customDrawImage`、记录上游图像身份、检测 transfer map、分发绘制、立即 `repaint()` |
| `content/preferences.xhtml` | 设置面板片段，由 `bootstrap.js` 经 `Zotero.PreferencePanes.register()` 注册 |
| `content/preferences.js` | 面板数值显示联动 + 恢复默认 |
| `prefs.js` | 全部五项偏好的默认声明：`extensions.pdf-noir.enable`（布尔）、`.classSensitivity`、`.chromaThreshold`、`.bandWidth`（字符串）、`.devAutoOpenItem`（数字） |
| `locale/` | 面板的 Fluent 文案（`en-US`、`zh-CN`；所有消息 id 以 `pdfnoir-prefs-` 为前缀） |
| `tests/` | `bun test` 测试：色带、色度门限、判定、缓存、面板滑杆、参数拆分 |
| `scripts/build.ts` | 零依赖打包 → `build/*.xpi`（附完全相同的 `.zip`） |
| `docs/m0-findings.md` | Zotero 10.0.6 深色模式图像渲染机制（M0 调查结论） |
| `docs/neutral-band.md` | 色带与色度门限机制：色带几何、重叠推导、门限说明、结果缓存键 |

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
         （记录上游 imgData/bitmap 身份与当前 transfer map，供缓存使用）
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
会安全退化为「不介入」；原方法每次绘制至多调用一次（noir 命中时不会再走到
它），try/catch 只包裹 noir 准备阶段，任何异常都回退到未改动的原始调用；
卸载时恢复所有被包装的方法并删除标记，停用/启用循环后可干净地重新安装。

若某个窗口仍在运行其它 BUILD 的代码（例如插件更新时阅读器一直开着），
该窗口不会被当作「已注入」：bootstrap 会先卸载旧钩子、删除 `PDFNoir`
命名空间，再注入当前 BUILD（同一窗口的重试限流为每 5 秒一次）。

### 判定（`classify.js`）

特征在降采样副本（长边约 192px）上计算，变换本身始终使用源分辨率以保
细线。三个特征均为 0..1 的比例，且**只统计不透明像素**：透明像素不计入
任何分母，`flat` 的像素对要求两端都不透明，因此透明边距不会造成误判：

| 特征 | 定义 |
|---|---|
| `nearWhite` | 明度 > 0.94 且相对饱和度 < 0.1 |
| `lowSat` | 通道极差 <= 32 或相对饱和度 < 0.2 |
| `flat` | 相邻不透明像素对的最大通道差 <= 12 |
| `darkNeutral` | （仅记录）L < 0.5 且中性 |

三者同时达到阈值才判为白底线图。阈值由 `classSensitivity` 偏好 `s`（0..1）
派生：

```
tNearWhite = 0.45 - 0.27*s      (s=0.7 → 0.261)
tLowSat    = 0.75 - 0.25*s      (s=0.7 → 0.575)
tFlat      = 0.55 - 0.25*s      (s=0.7 → 0.375)
```

`s` **只影响判定**：像素变换不读取它，因此对在两种灵敏度下都被判为白底线图
的图像，像素输出逐字节一致。`s` 只决定图像是否被处理，不决定如何处理。

默认 `0.7`（激进）按产品决定选取，可覆盖白底 + 彩色曲线的常见论文插图。
照片类内容（无白色背景、平坦度低）在 `classSensitivity` 任意取值下都透传。

### 变换（`transform.js`）

中性色明度轴由**一条镜像对称的中性色带**统一处理（`params({chromaT,
bandWidth})`）：近白端与近黑端宽度相同、ramp 形状相同、彩色门限相同。
色带外缘固定为 `BAND_OUTER_HI = 0.934`，`bandWidth` 只移动内缘（`darkLo`
镜像外缘、`darkHi` 镜像内缘），因此两端始终共享同一带宽：

| 端 | 色带（发布默认 `bandWidth` = 0.6） | 效果 |
|---|---|---|
| 近白端 | `[whiteLo, whiteHi]` = `[0.334, 0.934]` | `alpha = alpha * (1 - wWhite)` —— 去除 |
| 近黑端 | `[darkLo, darkHi]` = `[0.066, 0.666]` | `rgb = mix(rgb, flipped, wDark)` —— 亮度翻转 |

发布默认宽度下两端**在明度轴中部重叠**，中间调像素因此默认就会被同时施加
两种效果——白端的 alpha 降低与黑端的亮度翻转。该重叠有界：只要
`bandWidth` 不超过 0.868，两端同时生效处的权重之和就不大于 1，没有像素会
被过度处理。色带几何、权重和推导、超过 0.868 后的行为、固定常量、
`CHROMA_FLOOR` 说明与结果缓存键的构成见
[docs/neutral-band.md](docs/neutral-band.md)。

`flipped` 是该像素明度的镜像（`L -> 1 - L`）落在「主题前景 → 白」轴上的
颜色：

```
flipped = fg + (255 - fg) * (1 - L)
```

即**纯黑变为白色**（最深的墨色落在近白处——正是近白端「变为主题背景」的
镜像；最深的中性墨色是输出的最亮值）。翻转以与原色的 mix 施加，因此中暗
墨色落在原色与该值之间。

**彩色保护是相对色度门限**，判定使用**相对色度**而非绝对通道极差：

```
chroma = spread / max(最大通道, CHROMA_FLOOR)   （CHROMA_FLOOR = 32）
chroma >= chromaT 即判为彩色、保持不动，chromaT = 偏好 chromaThreshold（发布默认 1）
```

相对色度达到阈值的像素按彩色处理、保持不动；低于阈值的像素才可能进入
色带。改用相对度量的原因：暗色高饱和色（如 `(40,0,0)`）绝对极差很小却
完全饱和，此前的绝对极差门限（`spread >= 40 + 24*s`）会误判并把它们提亮。

发布默认下只有**完全饱和**的像素能达到门限：相对色度要有 1.0，最小通道
必须恰为 0，因此中等饱和的颜色会被当作墨色、可能被翻转提亮。该默认值是
在实际素材上实机测试后选定的。调低 `chromaThreshold` 可保护更多颜色；
取 0 时每个像素都被视为彩色，整个变换成为空操作。

不做连通性判断、没有内部例外：接近白色的像素无论在何处都按背景处理
（白色填充块、面板、烘焙白字同样去除）。

变换就地单遍修改 `ImageData`，并按「上游图像身份 + 源矩形 + 像素尺寸 +
变换参数」缓存；同一图像同一缩放下的重复渲染（滚动、重绘）直接命中缓存，
处于 transfer map 下的绘制绕过缓存。内存受单图上限与全局 64 MiB 预算
（LRU 淘汰）约束；`uninstall` 时清空缓存。

### 日志

统一 `[PDF-Noir]` 前缀写入 Zotero 调试日志（`-console` 或
帮助 → Debug Output Logging → View Output）。每次图像绘制一行，命中与
未命中都有：

```
[PDF-Noir] #1 img1 <w>x<h> src=up noir cache=miss cls=miss feats{white=… lowSat=… flat=… dark=…} thr{white=… lowSat=… flat=…} ms=… removed=…
[PDF-Noir] #2 img2 <w>x<h> src=up pass cls=miss feats{white=… lowSat=… flat=… dark=…} thr{white=… lowSat=… flat=…} ms=…
```

`src=up` 表示缓存键来自上游 `imgData`/bitmap；`noir` 表示已变换，`pass`
表示原样交给 Blender（`skip=...` 标注原因：`lightTheme`、`forceInversion`、
`entirePage`、`tooLarge`）；`cache=` 为变换画布缓存，`cls=` 为分类特征缓存；
`xf=on` 标记处于 transfer map 下的绘制（该次绘制禁用缓存）；`removed=`
为按背景去除的像素占比（近白权重超过 0.5）。查看器 realm
无法调用 `Zotero.debug`，日志先缓存在窗口上，由 `bootstrap.js` 每 1.5s
收集转发。注意 Zotero `-console` 的 stdout 有缓冲，重定向的日志文件可能
要到 Zotero 退出后才完整。

## 偏好设置

| Pref | 类型 | 默认 | 读取时钳制 | 含义 |
|---|---|---|---|---|
| `extensions.pdf-noir.enable` | 布尔 | `true` | — | 总开关（未设置视为启用） |
| `extensions.pdf-noir.classSensitivity` | 字符串 | `"0.7"` | 0 … 1 | **只影响判定**：光栅图像被判为白底线图的积极性 |
| `extensions.pdf-noir.chromaThreshold` | 字符串 | `"1"` | 0 … 1 | 相对色度门限：达到或超过即视为彩色、保持不动；发布默认下只有完全饱和（某通道恰为 0）的像素能达到 |
| `extensions.pdf-noir.bandWidth` | 字符串 | `"0.6"` | 0 … 1 | 中性色带沿明度轴的宽度；发布默认宽度下近白端与近黑端在中间调重叠 |
| `extensions.pdf-noir.devAutoOpenItem` | 数字 | `0` | — | 仅开发用，不出现在界面（启动时自动打开的 item ID；`0` 为关闭） |

三个数值项以**字符串**存储，因为 Firefox 默认偏好没有浮点类型；在设置面板
中各自对应一个带实时百分比数值显示的滑杆。修改方法：

1. **编辑 → 设置 →「Zotero PDF Noir」**——插件启动时注册的面板，位于设置
   侧边栏底部。数值显示也会跟随面板之外（配置编辑器）的修改；改动会在约
   1.5 秒内反映到已打开的阅读器，无需滚动或缩放。
2. 配置编辑器仍然可用：**编辑 → 设置 → 高级 → 配置编辑器**，接受警告，
   搜索 `extensions.pdf-noir`。`enable` 为布尔值，三个数值项为上表中的
   字符串。
3. 超出范围的值在读取时被钳制：手工改出的越界值会被静默修正到最近的边界
   而不是被采纳；钳制范围与滑杆一致（均为 0 … 1）。
4. 面板中的**恢复默认**按钮通过 `Zotero.Prefs.set(..., true)` 写回全部四项
   界面偏好。

## 构建

```sh
bun install
bun run build
bun test          # 测试套件：色带、色度门限、判定、缓存、缓存键、
                  # 参数拆分、变换参数契约、零宽色带安全、
                  # 面板滑杆网格契约
# → build/zotero-pdf-noir-<版本>.xpi
# → build/zotero-pdf-noir-<版本>.zip（内容完全相同；xpi 本质即 zip）
```

xpi 根路径仅含 `manifest.json`、`bootstrap.js`、`prefs.js`、`content/`、
`locale/` 与 `LICENSE`。

## 已知行为 / 副作用

- **白底线图会为深色模式重绘。** 接近白色的中性像素一律透明（全图处理，
  含图内白色填充与面板，不做连通性判断）；其上的近黑中性墨迹向白色翻转，
  因此白底上的黑网格与黑字变为浅色且可读。
- **中间调像素默认就会被处理。** 发布默认带宽 0.6 下，近白端与近黑端在
  明度轴中部重叠，中间调像素会同时承受两种效果；浅色与中等饱和的填充可能
  变淡或变亮。调低 `bandWidth` 可收窄色带、保留更多此类像素。
- **发布默认色度门限下只有完全饱和的颜色受保护。** `chromaThreshold` 为
  1.0 时，只有相对色度达到 1.0（某个通道恰为 0）的像素保持不动；中等饱和
  的颜色（如 `(200,50,50)`）会按墨色处理而被提亮；调低门限可保护更多
  颜色。
- **以下情形原样透传：** 浅色主题不介入；启用 `invertImages` 的主题
  （如 Zotero 的「黑色」主题）保持其全反相行为；整页扫描件与超过 8MP 的
  图像原样交给 Blender。
- **偏好变更约 1.5 秒内作用到已打开的阅读器**，无需滚动或缩放：插件重读
  影响渲染的偏好并强制重绘。

## 排障

1. **确认插件已启用**：工具 → 插件，确认「Zotero PDF Noir」为启用状态，
   安装或更新后重启过 Zotero。
2. **确认阅读器主题**：插件只作用于深色主题；用阅读器工具栏的「Aa」按钮
   切到「Dark」等深色主题。
3. **重新打开 PDF**：关闭阅读器标签页再打开——钩子在阅读器启动时安装并
   强制重绘一次；在此之前已渲染完成的页面要等重渲染才会应用。
4. **先开调试日志，再重开 PDF**：在打开 PDF **之前**开启
   帮助 → Debug Output Logging → Enable Output Logging（及 View Output），
   或以 `-console` 启动——钩子在阅读器启动时就会记录安装信息，事后再开
   日志会漏掉这些行。然后搜索 `[PDF-Noir]`：
   - 出现 `hook install build=...` 与 `attached; Blender hook armed` 说明
     钩子已就绪；
   - 逐图像行会显示 `noir` 或 `pass` 及实测特征值；`pass skip=...` 会说明
     插件有意不处理的原因（`lightTheme`、`forceInversion`、`entirePage`、
     `tooLarge`）；
   - **完全没有 `[PDF-Noir]` 行也可能是注入失败**（不一定是「没有绘制
     光栅图像」）：纯文本页不经过该路径，但若连 `hook install` 行都没有，
     请确认插件已启用、阅读器标签页是在 Zotero 启动之后打开的，并查找
     注入错误（`loadSubScript`、`inline injection`、`script tag
     injection`）。
5. 注意 Zotero `-console` 的 stdout 有缓冲：重定向的日志文件可能要等到
   Zotero 退出后才完整。

## 反馈

问题反馈请发至
[github.com/Zhanyuanium/Zotero-PDF-Noir/issues](https://github.com/Zhanyuanium/Zotero-PDF-Noir/issues)，
并附上 Zotero 版本、所用阅读器主题与覆盖问题现象的 `[PDF-Noir]` 日志
（见排障第 4 条）。

## 许可

Zotero PDF Noir 采用 **GNU Affero 通用公共许可证 v3.0（AGPL-3.0）**，
全文见 [LICENSE](LICENSE)。
