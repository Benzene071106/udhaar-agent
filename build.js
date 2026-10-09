// Inlines core/agent-core.js into the web page. Outputs:
//   dist/udhaar-agent.html             page body (published as the hosted demo link)
//   dist/udhaar-agent-standalone.html  full HTML document (open in Chrome for live mic, or serve from any host)
const fs = require('fs');
const path = require('path');
const root = __dirname;
const core = fs.readFileSync(path.join(root, 'core/agent-core.js'), 'utf8');
const src = fs.readFileSync(path.join(root, 'web/index.src.html'), 'utf8');
const qr = fs.readFileSync(path.join(root, 'vendor/qrcode-generator.js'), 'utf8'); // MIT, Kazuhiko Arase
const page = src.replace('/*__CORE__*/', () => qr + '\n' + core);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/udhaar-agent.html'), page);
fs.writeFileSync(path.join(root, 'dist/udhaar-agent-standalone.html'),
  '<!doctype html>\n<html lang="hi">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n</head>\n<body>\n' + page + '\n</body>\n</html>\n');
console.log('built dist/udhaar-agent.html and dist/udhaar-agent-standalone.html');
