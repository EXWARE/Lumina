const https = require('https');
const fs = require('fs');

https.get('https://visualskins.com/skin/mond', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
}, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        fs.writeFileSync('test.html', data);
        console.log("Done. Length: " + data.length);
    });
}).on('error', (err) => {
    console.log("Error: " + err.message);
});
