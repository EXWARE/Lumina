const fs = require('fs');
const html = fs.readFileSync('detail.html', 'utf8');

const dlIdx = html.indexOf('download.php?video=');
if (dlIdx !== -1) {
    console.log('Found download link surrounding HTML:');
    console.log(html.slice(dlIdx - 300, dlIdx + 300));
} else {
    console.log('Download link not found');
}
