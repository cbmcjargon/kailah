// Renders the extension's toolbar/store icons from public/icon.svg.
//   node scripts/make-extension-icons.mjs
// The PNGs are committed (extension/icons/) so the extension build is
// deterministic and needs no native image library; rerun this only when the
// logo changes. sharp is already a devDependency.
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const svg = fileURLToPath(new URL('../public/icon.svg', import.meta.url))
const outDir = fileURLToPath(new URL('../extension/icons/', import.meta.url))
mkdirSync(outDir, { recursive: true })
for (const size of [16, 32, 48, 128]) {
  // Rasterized at the SVG's native 512px, then downsampled: crisper small
  // icons than rendering the vector straight at 16px.
  await sharp(svg)
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(`${outDir}icon-${size}.png`)
  console.log(`extension/icons/icon-${size}.png`)
}
