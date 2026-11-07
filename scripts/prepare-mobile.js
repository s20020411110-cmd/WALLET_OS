const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'www');
const files = [
  'index.html',
  'sw.js',
  'manifest.webmanifest',
  'icon.svg'
];

fs.mkdirSync(output, { recursive: true });

for (const name of files) {
  const source = path.join(root, name);
  const destination = path.join(output, name);
  if (!fs.existsSync(source)) {
    throw new Error('Required WALLET OS web asset is missing: ' + name);
  }
  fs.copyFileSync(source, destination);
}

console.log('Prepared Capacitor web bundle: ' + files.join(', '));
