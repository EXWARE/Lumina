const https = require('https');

https.get('https://visualskins.com/', (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        // Find elements with class "item" or similar. Let's just log the first 2000 chars to see what it looks like.
        const match = data.match(/<div class="item">.*?<\/div>/s);
        if (match) {
            console.log(match[0]);
        } else {
            console.log(data.substring(0, 1000));
            console.log("No item class found, searching for <article...");
            const articleMatch = data.match(/<article.*?>.*?<\/article>/s);
            if (articleMatch) console.log(articleMatch[0]);
        }
    });
}).on('error', (err) => {
    console.log("Error: " + err.message);
});
