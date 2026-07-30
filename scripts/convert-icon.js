/**
 * Converts src/ui/assets/icon.png → build/icon.ico
 * Run once before building: npm run convert-icon
 */
const pngToIco = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const srcPng = path.join(__dirname, '..', 'src', 'ui', 'assets', 'icon.png');
const destDir = path.join(__dirname, '..', 'build');
const destIco = path.join(destDir, 'icon.ico');

if (!fs.existsSync(srcPng)) {
    console.error('❌ icon.png not found at:', srcPng);
    console.error('   Make sure you have saved your logo to src/ui/assets/icon.png');
    process.exit(1);
}

if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

console.log('🔄 Converting icon.png → icon.ico...');

pngToIco([srcPng])
    .then(buf => {
        fs.writeFileSync(destIco, buf);
        console.log('✅ icon.ico saved to build/icon.ico');
        console.log('   You can now run: npm run dist');
    })
    .catch(err => {
        console.error('❌ Conversion failed:', err.message);
        process.exit(1);
    });
