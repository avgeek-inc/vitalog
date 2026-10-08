# Vitalog brand

Vitalog's mark is a slim, upright red heart with a gently curved front and shallow sculpted depth. The front faces right, with a narrow visible edge on the left. Its deep warm red material uses soft form shadows and restrained satin highlights. This keeps the heart recognizable at small sizes while matching the crafted 3D objects used by Towbar and Mill. Preserve its orientation and proportions; do not inflate the body or add symbols, outlines or detached shadows. Place the transparent mark on plain light or dark surfaces.

The source is [`assets/brand/vitalog-mark-source.png`](../assets/brand/vitalog-mark-source.png), a 1254 × 1254 RGBA PNG. Preserve the source alpha when producing the 256 px application/documentation/plugin mark, 64 px favicon/composer icon and 180 px touch icon. Resize from the source rather than enlarging a smaller derivative. Keep the existing reserved image dimensions in the UI to avoid layout shifts, and retain the accessible brand name in the lockup.

The Next.js app serves PNGs from `apps/web/public/brand` at `/brand/`. The plugin package uses identical copies. The page's CSP permits local images and framework data images; external images remain blocked.

The light accent changed from `oklch(0.25 0.015 160)` to `oklch(0.55 0.21 25)`, with `oklch(0.99 0 0)` foreground: a warm red with readable light text. The dark accent changed from `oklch(0.85 0.02 160)` to `oklch(0.75 0.14 25)`, with dark foreground `oklch(0.18 0.01 25)`: a lighter red that remains distinct on dark surfaces. The accent/foreground pairs have WCAG contrast ratios of 5.26:1 in light mode and 7.99:1 in dark mode, calculated from the sRGB luminance of the OKLCH tokens. Both remain inside sRGB. The focus ring follows the accent. Neutral page/card surfaces preserve the Towbar and Mill hierarchy.

## Edit prompt

Use case: precise-object-edit. Preserve one upright red heart and its recognizable silhouette. Give it a gently curved front, shallow depth around one tenth of its width, soft rounded edges and a restrained satin surface. Show the front facing right with a narrow visible left edge. Keep a deep warm red material near `#D01C29`, with subtle natural shading rather than glossy highlights. Match the sculpted craftsmanship of Mill's windmill without the bulk of an inflated heart. Center the complete object on a square transparent canvas with balanced padding. No text, symbols, outlines, pedestal, extra objects or detached ground shadow.
