# Test Fixture

`samples/` holds the third-party PDF used to verify the plugin during development.
These papers are **not** redistributed with this repository and are ignored by git.

Expected fixture (obtain from IEEE Xplore; DOI 10.1109/TVT.2025.3534502):

- `Dual-Grained_Recursive_Bayesian_Filtering_for_UAV-Enabled_Satellite_User_Terminal_Surveillance.pdf`
  - 6 pages
  - page 2: `/Im1` 1629x1258 (Fig. 1, white-background schematic with colour annotations)
  - page 3: `/Im2` 347x203
  - page 5: `/Im3` 2100x2389 (Fig. 3)

Both figures are the reason this plugin exists: Zotero's built-in dark mode dims them
(`overlay`, alpha 0.8) instead of removing the white background, so the background glares
and the text baked into the figure becomes unreadable.

To reproduce the verification runs, drop the file in this directory, build with
`bun run build`, install the XPI in a Zotero profile, open it in dark mode and inspect
pages 2 and 5. Expect `[PDF-Noir]` log lines with `noir` for those images.