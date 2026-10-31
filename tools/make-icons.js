'use strict';

// Generates the PNG images from the SVG sources (npm run icons; needs @resvg/resvg-js, a development dependency):
//  - 16/32/64/80/128 icons in package/assets/ (assets/icon.svg for 64 px and up, assets/icon-small.svg for 16 and 32 px);
// The README images are rendered by tools/New-DocumentationImages.js (npm run images), not from SVG files.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.join(__dirname, '..');
const assets = path.join(root, 'assets'); // SVG sources
const outAssets = path.join(root, 'package', 'assets'); // generated PNG icons, used by the build
const SIZES = [16, 32, 64, 80, 128];
const SMALL_MAX = 32;

function render(svg, width, file) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: true, defaultFontFamily: 'Segoe UI' } }).render().asPng();
  fs.writeFileSync(file, png);
  console.log(`written ${path.relative(process.cwd(), file)} (${png.length} bytes)`);
}

const full = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8');
const small = fs.readFileSync(path.join(assets, 'icon-small.svg'), 'utf8');
SIZES.forEach((size) => {
  render(size <= SMALL_MAX ? small : full, size, path.join(outAssets, `icon-${size}.png`));
});
