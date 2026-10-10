# Vitalog brand

The editable source of truth is [`assets/brand/Vitalog.sketch`](../assets/brand/Vitalog.sketch), copied from the designed Desktop document. Use its heart symbols and OpenGraph frame directly; preserve their shape, padding, colors and transparency.

Native PNG exports are checked into [`assets/brand/exports`](../assets/brand/exports). The transparent, edge, opaque and favicon variants are 1024 × 1024; the OpenGraph image is 1200 × 630. [`vitalog-mark-source.png`](../assets/brand/vitalog-mark-source.png) is the full-resolution transparent symbol export.

The application, documentation and plugin use identical 256 px mark and 64 px favicon exports. The touch icon is 180 px. Export these directly from the 400 px Sketch symbols at scales `0.64`, `0.16` and `0.45`, respectively. Use `vitalog_light_transparent` for the mark and touch icon, and `vitalog_favicon` for the favicon and composer icon. Keep the existing reserved image dimensions in the UI to avoid layout shifts, and retain the accessible brand name in the lockup.

The Next.js app serves PNGs from `apps/web/public/brand` at `/brand/`. The plugin package uses identical copies. The page's CSP permits local images and framework data images; external images remain blocked.

The light accent changed from `oklch(0.25 0.015 160)` to `oklch(0.55 0.21 25)`, with `oklch(0.99 0 0)` foreground: a warm red with readable light text. The dark accent changed from `oklch(0.85 0.02 160)` to `oklch(0.75 0.14 25)`, with dark foreground `oklch(0.18 0.01 25)`: a lighter red that remains distinct on dark surfaces. The accent/foreground pairs have WCAG contrast ratios of 5.26:1 in light mode and 7.99:1 in dark mode, calculated from the sRGB luminance of the OKLCH tokens. Both remain inside sRGB. The focus ring follows the accent. Neutral page/card surfaces preserve the Towbar and Mill hierarchy.

## Export from Sketch

On macOS with Sketch installed:

```bash
/Applications/Sketch.app/Contents/MacOS/sketchtool export layers \
  assets/brand/Vitalog.sketch \
  --items=C8AE01E3-9256-4388-B4DE-98D2C5CEDD25,44BF5C0F-3D7E-446F-A392-74E63EE68334,04636875-A2D2-4024-A964-2D5CC35D4242,5A94D076-6099-4F7D-8A17-7B323695E056,F07C6ECF-5C2F-46AC-AB0B-1D7067784F33,9B02298D-9D2A-481A-BB3D-782055A4F7B3,0E57921F-4D51-421D-829B-0966928463BA \
  --formats=png --scales=2.56 --output=assets/brand/exports --overwriting=YES

/Applications/Sketch.app/Contents/MacOS/sketchtool export layers \
  assets/brand/Vitalog.sketch --item=1E62C943-841F-46B7-96A6-867BFD302407 \
  --formats=png --scales=1 --output=assets/brand/exports --overwriting=YES
```

Sketch names the 1024 px exports with an `@2x` suffix. Copy the OpenGraph export to `docs/assets/vitalog-og.png` for documentation social previews. After refreshing the app icons, copy the favicon and mark to `plugin/assets/icon.png` and `plugin/assets/logo.png`, then run `npm run docs:generate` and `npm run plugin:package` to synchronize and verify the distributed assets.
