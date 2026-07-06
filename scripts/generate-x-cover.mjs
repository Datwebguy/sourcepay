import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const svgPath = path.join(__dirname, 'public', 'sourcepay-x-cover.svg');
const pngPath = path.join(__dirname, 'public', 'sourcepay-x-cover.png');

console.log('Converting SourcePay X cover SVG to PNG...');
console.log(`Input: ${svgPath}`);
console.log(`Output: ${pngPath}`);

sharp(svgPath)
  .png({ quality: 95, progressive: true })
  .resize(1500, 500, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toFile(pngPath)
  .then(() => {
    const stats = fs.statSync(pngPath);
    console.log(`✅ X cover image created successfully!`);
    console.log(`   File size: ${(stats.size / 1024).toFixed(2)} KB`);
    console.log(`   Dimensions: 1500x500px`);
    console.log(`   Ready to upload to X/Twitter`);
  })
  .catch((err) => {
    console.error('❌ Error converting SVG to PNG:', err.message);
    process.exit(1);
  });
