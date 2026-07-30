const fs = require('fs');
const html = fs.readFileSync('visualskins.html', 'utf8');

const matches = html.match(/<a[^>]*href="\/tag\/([^"]+)"[^>]*>([^<]+)<\/a>/g);
if (matches) {
    const cats = matches.map(m => {
        const urlMatch = m.match(/href="(\/tag\/[^"]+)"/);
        const nameMatch = m.match(/>([^<]+)<\/a>/);
        return {
            url: urlMatch ? urlMatch[1] : null,
            name: nameMatch ? nameMatch[1] : null
        };
    }).filter((v, i, a) => a.findIndex(t => (t.url === v.url)) === i); // unique
    console.log(cats);
}
