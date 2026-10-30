'use strict';

// Generates the PNG images from the SVG sources (npm run icons; needs @resvg/resvg-js, a development dependency):
//  - 16/32/64/80/128 icons in assets/ (assets/icon.svg for 64 px and up, assets/icon-small.svg for 16 and 32 px);
//  - README images in docs/images/ from assets/doc/*.svg: banner and flow diagram, light and dark
//    (banner-light.svg -> readme-banner-light.png, flow-dark.svg -> readme-flow-dark.png, etc.).
// The README sources are in assets/doc/ (outside the assets/*.png pattern copied into the deployed site).
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.join(__dirname, '..');
const assets = path.join(root, 'assets');
const docSources = path.join(assets, 'doc');
const docImages = path.join(root, 'docs', 'images');
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
  render(size <= SMALL_MAX ? small : full, size, path.join(assets, `icon-${size}.png`));
});

if (fs.existsSync(docSources)) {
  fs.mkdirSync(docImages, { recursive: true });
  fs.readdirSync(docSources)
    .filter((f) => f.endsWith('.svg'))
    .sort()
    .forEach((f) => {
      const svg = fs.readFileSync(path.join(docSources, f), 'utf8');
      // Width of 1080 px or that of the file, at most 2160: sharp images on dense screens, light folder.
      const declared = Number(/viewBox="0 0 (\d+)/.exec(svg)[1]);
      render(svg, Math.min(declared * 1.08, 2160), path.join(docImages, `readme-${f.replace(/\.svg$/, '.png')}`));
    });
}
