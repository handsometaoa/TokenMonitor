import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = process.cwd();
const resourcesDir = join(root, 'resources', 'icons');
const buildDir = join(root, 'build');
await mkdir(resourcesDir, { recursive: true });
await mkdir(buildDir, { recursive: true });

function traySvg(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <g fill="${color}">
    <rect x="5" y="15" width="6" height="12" rx="2.4"/>
    <rect x="13" y="9" width="6" height="18" rx="2.4"/>
    <rect x="21" y="4" width="6" height="23" rx="2.4"/>
  </g>
</svg>`;
}

function appSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="120" y1="80" x2="920" y2="960" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2F6BFF"/>
      <stop offset="0.55" stop-color="#6D5DF6"/>
      <stop offset="1" stop-color="#B05CF2"/>
    </linearGradient>
    <linearGradient id="shine" x1="260" y1="180" x2="720" y2="860" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="22" stdDeviation="26" flood-color="#172554" flood-opacity="0.30"/>
    </filter>
  </defs>
  <rect x="62" y="62" width="900" height="900" rx="228" fill="url(#bg)" filter="url(#shadow)"/>
  <rect x="62" y="62" width="900" height="900" rx="228" fill="url(#shine)"/>
  <g fill="#ffffff">
    <rect x="274" y="522" width="112" height="236" rx="56" opacity="0.86"/>
    <rect x="456" y="378" width="112" height="380" rx="56" opacity="0.94"/>
    <rect x="638" y="236" width="112" height="522" rx="56"/>
  </g>
  <circle cx="694" cy="236" r="42" fill="#C8F25A"/>
</svg>`;
}

const trayColors = {
  normal: '#2F6BFF',
  warn: '#D97706',
  danger: '#DC2626',
  stale: '#8B8F98',
  off: '#A1A1AA',
};

for (const [name, color] of Object.entries(trayColors)) {
  const svg = Buffer.from(traySvg(color));
  await sharp(svg).resize(32, 32).png().toFile(join(resourcesDir, `tray-${name}.png`));
  await sharp(svg).resize(64, 64).png().toFile(join(resourcesDir, `tray-${name}@2x.png`));

  const icoPngs = [];
  for (const size of [16, 24, 32, 48, 64]) {
    icoPngs.push(await sharp(svg).resize(size, size).png().toBuffer());
  }
  const ico = await pngToIco(icoPngs);
  await writeFile(join(resourcesDir, `tray-${name}.ico`), ico);
}

const appBuffer = Buffer.from(appSvg());
await sharp(appBuffer).resize(1024, 1024).png().toFile(join(buildDir, 'icon.png'));
await sharp(appBuffer).resize(512, 512).png().toFile(join(resourcesDir, 'app.png'));
const appIcoPngs = [];
for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  appIcoPngs.push(await sharp(appBuffer).resize(size, size).png().toBuffer());
}
const appIco = await pngToIco(appIcoPngs);
await writeFile(join(buildDir, 'icon.ico'), appIco);

console.log('Generated app and tray icons.');
