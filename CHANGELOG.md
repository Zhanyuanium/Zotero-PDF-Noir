# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-12

### Added

- 新增 Zotero 内置设置面板（`Zotero.PreferencePanes.register()`，位于
  编辑 → 设置 →「Zotero PDF Noir」，侧边栏底部）：总开关、三个以百分比
  实时显示数值的滑杆，以及「恢复默认」按钮；无障碍标注齐备（`aria-labelledby` /
  `control` / `aria-describedby`）。三个滑杆统一以 0.01 为步进（检测灵敏度
  原为 0.05）。
- In-Zotero settings pane (`Zotero.PreferencePanes.register()`; Edit →
  Settings → "Zotero PDF Noir", at the bottom of the sidebar): the master
  switch, three numeric sliders whose live readouts are percentages, and a
  Restore Defaults button; the accessibility wiring (`aria-labelledby` /
  `control` / `aria-describedby`) is in place. All three sliders step by 0.01
  (the detection slider previously stepped by 0.05).
- 三项互不耦合的调节：`classSensitivity` 只决定光栅图像是否被判为白底线图；
  `chromaThreshold` 与 `bandWidth` 只塑造像素变换。分类阈值与像素变换参数
  相互独立：对在两种灵敏度下都被判为白底线图的图像，像素输出逐字节一致。
- Three independent knobs: `classSensitivity` only decides whether a raster
  image counts as white-background line art; `chromaThreshold` and `bandWidth`
  only shape the pixel transform. The classification thresholds and the
  pixel-transform parameters are independent: for any image classified as
  white-background line art at BOTH sensitivities, the pixel output is
  identical.

### Changed

- **破坏性变更**：移除 `extensions.pdf-noir.sensitivity`，且不做迁移。此前它
  同时驱动分类判定与像素变换；由于一直没有设置界面，它的值只可能是在配置
  编辑器中手工写入的，因此这次拆分是有意的破坏性变更。替代项为
  `classSensitivity`（默认 `"0.7"`）以及 `chromaThreshold`（默认 `"1"`）
  与 `bandWidth`（默认 `"0.6"`）。
- **BREAKING**: `extensions.pdf-noir.sensitivity` is removed, with no
  migration. It drove both classification and the pixel transform; there has
  never been a settings UI, so its value could only have been hand-edited in
  the Config Editor — the split is a deliberate breaking change. Replacements:
  `classSensitivity` (default `"0.7"`) plus `chromaThreshold` (default `"1"`)
  and `bandWidth` (default `"0.6"`).
- 变换改为锚定固定外缘 + 可调带宽：`BAND_OUTER_HI = 0.934` 固定，`bandWidth`
  只移动内缘；`darkLo` 改为镜像**外**缘（不再读 `whiteHi`），消除旧命名的
  歧义。发布默认带宽 0.6 下白端 `[0.334, 0.934]`、黑端 `[0.066, 0.666]`，
  两端在明度轴中部重叠；`chromaT` 默认 1。取 0 时两端都不生效（有防护，
  避免除零写出 `NaN`）。
- `bandWidth` 的滑杆范围与读取时钳制由 0 … 0.5 扩至 0 … 1.00。发布默认
  0.6 即已在中间调重叠：两端同时生效处权重之和为
  `(1 - 2*inner) / bandWidth`，不超过 0.868 时该和不大于 1，因此重叠有界、
  没有像素被过度处理；超过 0.868 后权重和可超过 1（滑杆最右端即该情形），
  由 `clamp01` 逐权重兜底。
- The transform is anchored on a fixed outer edge with an adjustable width:
  `BAND_OUTER_HI = 0.934` is fixed and `bandWidth` moves only the inner edge;
  `darkLo` now mirrors the OUTER edge instead of reading `whiteHi`, removing the
  old naming ambiguity. At the shipped default 0.6 the band is white `[0.334,
  0.934]`, black `[0.066, 0.666]` — the ends overlap in the middle of the
  lightness axis — and `chromaT` defaults to 1. At 0 both ends are inert
  (guarded, so the zero-width ramp cannot write `NaN`).
- The `bandWidth` slider and read-time clamp widened from 0 … 0.5 to 0 … 1.00.
  The shipped default 0.6 already overlaps the two ends in the mid-tones: where
  both ends are active their weights sum to `(1 - 2*inner) / bandWidth`, at most
  1 for every `bandWidth` up to 0.868, so the overlap is bounded and no pixel is
  over-processed; above 0.868 the sum can exceed 1 (the far right of the
  slider), with `clamp01` bounding each weight.
- 发布默认值改为 `chromaThreshold` `"1"`、`bandWidth` `"0.6"`（`bandWidth`
  由 1.0.0 的 0.166 调整而来）：这组更激进的默认值在实际素材上经实机测试
  选定。Firefox 默认偏好只在用户从未设置过该项时生效，因此全新配置得到
  新默认值，已有配置保留原值；没有迁移逻辑。
- The shipped defaults are now `chromaThreshold` `"1"` and `bandWidth` `"0.6"`
  (`bandWidth` moved from 1.0.0's 0.166), chosen after live testing on the
  material the plugin is used with. A Firefox default pref only applies when
  the user has never set that pref, so fresh profiles get the new defaults and
  existing profiles keep their stored values; there is no migration.
- 设置面板中的「中性色带宽度」更名为「亮度带宽」：该控件设定的是色带沿
  **明度轴**的宽度。偏好键与元素 id 不变；英文文案为 "Lightness band
  width"。
- The pane control "Neutral band width" is renamed "Lightness band width": it
  sets the band's width along the **lightness** axis. The pref key and element
  ids are unchanged; the Chinese label is 「亮度带宽」.
- `strict_min_version` 由 `10.0.6` 下调为 `10.0.0`（`strict_max_version` 仍为
  `10.*`）；实机测试仍在 Zotero 10.0.6 上完成。
- `strict_min_version` lowered from `10.0.6` to `10.0.0` (`strict_max_version`
  stays `10.*`); live testing was still done on Zotero 10.0.6.
- `chromaThreshold` 的滑杆范围扩至 0–1（原 0.05–0.30），读取时同样钳制在
  0–1；发布默认值为 1。此时只有相对色度恰为 1.0 的完全饱和像素（某通道为
  0）能达到门限，其余颜色都会被当作墨色处理；0 则把每个像素都视为彩色、
  整个变换成为空操作。两端退化但平稳，不是错误。
- The `chromaThreshold` slider range widened to 0–1 (was 0.05–0.30), clamped to
  the same range at read time; the shipped default is 1. At that value only
  fully saturated pixels (relative chroma exactly 1.0, one channel at zero)
  still clear the gate and everything else is treated as ink; 0 treats every
  pixel as coloured and turns the transform into a complete no-op. Both
  endpoints are degenerate but graceful, not errors.
- `neutralSpread` 由 `40 + 24*s` 改为固定常量 `NEUTRAL_SPREAD = 56.8`：它只
  决定抗锯齿 ramp 的形状，不再是用户可调项。
- `neutralSpread` is now the fixed constant `NEUTRAL_SPREAD = 56.8` (was
  `40 + 24*s`): it shapes the anti-aliasing ramp and is no longer a user knob.
- 结果缓存键由灵敏度改为实际变换参数：`resKey(fkey, P, fgHex)` 现由 chromaT +
  带宽 + 前景色构成；改动其中任何一项都会使结果缓存未命中；特征缓存与参数
  无关，不受影响。
- The result-cache key now reflects the actual transform parameters instead of
  sensitivity: `resKey(fkey, P, fgHex)` is built from chromaT + band width +
  foreground. Changing any of them misses the result cache; the feature cache is
  parameter-independent and unaffected.
- `BUILD`（`bootstrap.js`、`hook.js`）与 `manifest.json`、`package.json` 版本
  升至 `1.1.0`（必须完全一致）。
- `BUILD` (`bootstrap.js`, `hook.js`) and the `manifest.json` / `package.json`
  versions bumped to `1.1.0` (they must match exactly).
- 打包白名单加入 `locale/`（`scripts/build.ts`）；xpi 根路径现为
  `manifest.json`、`bootstrap.js`、`prefs.js`、`content/`、`locale/`、`LICENSE`。
- The build allowlist (`scripts/build.ts`) now also ships `locale/`; the xpi root
  is `manifest.json`, `bootstrap.js`, `prefs.js`, `content/`, `locale/`,
  `LICENSE`.
- 测试新增覆盖：默认参数精确值、外缘镜像不变量、权重和上界（两端同时
  生效时权重之和为 `(1 - 2*inner) / bandWidth`，在 `bandWidth` 不超过
  0.868 时不超过 1，超过后按设计在中间调重叠）、零宽色带安全
  （`bandWidth` 0 时逐字节不变且权重为 0 而非 `NaN`）、面板滑杆网格契约
  （范围、步进与落在网格上的默认值）；另有
  拆分回归防护（相同变换参数 + 不同分类灵敏度必须逐字节一致）、
  `transformImageData` 参数契约回归防护（含真实钩子调用边界）、缓存键
  测试；连续性容差随字节分辨率缩放。
- Added test coverage: exact default parameter values, the outer-edge mirror
  invariant, the weight-sum bound (where both ends are active their weights sum
  to `(1 - 2*inner) / bandWidth`, at most 1 for every `bandWidth` up to 0.868;
  above that the ends overlap in the mid-tones by design), zero-width band
  safety (`bandWidth` 0 leaves every pixel byte-identical and reports zero
  weights, not `NaN`), and the pane slider grid contract (ranges, steps and
  on-grid defaults); plus the split regression guard (same transform opts +
  different classification sensitivity must produce byte-identical output), the
  `transformImageData` parameter-contract regression guard (including the real
  hook call boundary), and cache-key tests; continuity tolerances scale with
  byte resolution.

### Fixed

- 修改偏好后立即重绘：bootstrap 记录影响渲染的偏好签名（`classSensitivity`、
  `chromaThreshold`、`bandWidth`、`enable`），签名变化时在下一次 1.5s 周期调用
  `PDFNoir.hook.repaint()`（重置 `app.pdfViewer._pages` 中的全部页面视图并
  `pdfViewer.update()`），已打开的阅读器约 1.5 秒内自动更新，不再需要等约 2 秒后
  缩放或滚动。钩子未安装或查看器未就绪时 `repaint` 为受保护的空操作；签名在
  `startup()` 时播种，首次 tick 不会触发多余重绘。
- Pref changes now repaint immediately: bootstrap keeps a signature of the
  render-affecting prefs (`classSensitivity`, `chromaThreshold`, `bandWidth`,
  `enable`) and, when it changes, calls `PDFNoir.hook.repaint()` at the next
  1.5 s tick (resets every page view in `app.pdfViewer._pages`, not only the
  visible ones, and calls `pdfViewer.update()`), so an open reader updates
  within about 1.5 s with no scrolling or zooming. The previous "change the
  pref, wait ~2 s, then zoom or scroll" behaviour is gone;
  `repaint` is a guarded no-op when the hook is not installed or the viewer is
  not ready, and the signature is seeded at `startup()` so the first tick does
  not cause a spurious repaint.

设置面板落地：判定与像素变换从此各由独立偏好控制，修改偏好立即重绘。 /
The settings pane lands: classification and the pixel transform are now governed
by independent prefs, and pref changes repaint immediately.

## [1.0.1] - 2026-10-10

### Changed

- `strict_max_version` 从 `10.0.*` 放宽为 `10.*`。Zotero 将 `strict_max_version`
  视为硬边界，`10.0.*` 会导致 Zotero 10.1 及以后的用户永远收不到更新且无任何提示。
  `strict_min_version` 仍为 `10.0.6`，这是唯一实测过的版本。
- Widened `strict_max_version` from `10.0.*` to `10.*`. Zotero treats the field as a
  hard bound, so a `10.0.*` ceiling would silently lock Zotero 10.1 and later out of
  updates. `strict_min_version` stays at `10.0.6`, the only verified release.

### Added

- `scripts/release.ts` generates the update manifest from the built XPI and
  computes its sha512, so the hash in `update.json` cannot drift from the
  artefact it describes.

代码逻辑未变，仅版本号与打包范围调整。 / No behaviour change; version bump and
release-range fix only.

## [1.0.0] - 2026-10-10 — 初版 / Initial release

### Added

- Dark-mode handling for white-background line-art figures in the Zotero PDF
  reader: near-white background pixels are made transparent so the theme
  background shows through, while the figure's line work stays readable.
- Mirror-symmetric neutral-lightness band: near-black neutral ink is flipped
  to light (pure black becomes white), the middle of the lightness axis is
  left untouched.
- Colour preservation via a relative chroma gate: pixels whose relative chroma
  reaches the threshold are treated as coloured and left untouched, so clearly
  saturated mid-tone colours (dark red, blue, orange, magenta, ...) are
  preserved. An absolute channel-spread gate misjudged dark saturated colours;
  the relative measure fixes that.
- Classification of images (line art vs photo-like content) with a
  sensitivity preference (`extensions.pdf-noir.sensitivity`) and an
  enable/disable preference.
- Identity-keyed caches for classification features and transformed canvases,
  bounded by a per-image cap and a global byte budget with LRU eviction.
- Debug logging: lines carrying the `[PDF-Noir]` prefix are written to
  Zotero's debug output; whether they are persisted is controlled by Zotero's
  own "Debug Output Logging" feature, not by a plugin preference.
- Test suite (`bun test`) covering the transform band, the chroma gate,
  classification and the caches.

### Notes

- Verified on Zotero 10.0.6 only.
- Transfer-map draws (`CanvasGraphics.current.transferMaps`) bypass the
  caches, since the same image data produces different pixels under a
  transfer map.
