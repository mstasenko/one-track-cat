# OneTrackCat icon

`icon.svg` is the canonical, editable icon. It recreates the original
black-cat-and-play-button design as vector paths without embedded raster data,
fonts, or third-party resources.

The application UI and this repository's main README use the SVG directly.
Native Linux desktop integration uses `../src/icon.png`, which is
rendered from the SVG at 512×512 pixels. Regenerate it with:

```bash
npm run build:icon
```
