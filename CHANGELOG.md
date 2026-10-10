# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Colour preservation via a relative chroma gate: clearly saturated colours
  (dark red, blue, orange, magenta, ...) are never modified. An absolute
  channel-spread gate misjudged dark saturated colours; the relative measure
  fixes that.
- Classification of images (line art vs photo-like content) with a
  sensitivity preference (`extensions.zotero.pdfnoir.sensitivity`) and an
  enable/disable preference.
- Identity-keyed caches for classification features and transformed canvases,
  bounded by a per-image cap and a global byte budget with LRU eviction.
- Debug logging preference (`extensions.zotero.pdfnoir.debug`).
- Test suite (`bun test`) covering the transform band, the chroma gate,
  classification and the caches.

### Notes

- Verified on Zotero 10.0.6 only.
- Transfer-map draws (`CanvasGraphics.current.transferMaps`) bypass the
  caches, since the same image data produces different pixels under a
  transfer map.
