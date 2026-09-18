# Boardly branding

The selected identity is a white owl on a near-black rounded tile. The name is **Boardly**. Ben approved the black treatment and deployment across the homepage and application on 10 September 2026.

The approved original PNG files live in `client/public/landing/brand/`. `scripts/prepare-brand-assets.cjs` embeds those unchanged images into cropped SVG viewports, which remove the presentation margins for small headers and browser icons. These wrappers contain raster artwork; they are not editable vector masters. Rerun that script only when replacing the source artwork.

Use `BrandLogo` for React brand placements. Cloud workspaces have a shared brand bar so the identity remains visible in company, board and project views. The homepage, authentication card, favicon, Apple touch icon and web manifest use the same selected assets. Light surfaces use the dark wordmark, while dark surfaces use the white text treatment for contrast.

Regenerate homepage product screenshots with `scripts/capture-marketing.cjs` using its isolated demonstration workspace. Never publish screenshots of private production projects as marketing artwork.
