# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
