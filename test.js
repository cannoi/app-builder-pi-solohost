const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('Running SoloHost Browser verification...');

const pkg = require('./package.json');
assert.strictEqual(pkg.name, 'solohost-browser-hub');
assert.ok(pkg.version);
console.log('✓ package.json');

['server.js', 'public/index.html', 'public/style.css', 'public/app.js', 'lib/app-manager.js', 'lib/store.js'].forEach((f) => {
  assert.ok(fs.existsSync(path.join(__dirname, f)), 'missing ' + f);
});
console.log('✓ required files');

const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, 'public/style.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

assert.ok(!css.includes('apps-grid'));
assert.ok(!html.includes('app-card'));
assert.ok(!html.includes('dashboard-section'));
assert.ok(html.includes('constellation'));
assert.ok(css.includes('.app-node'));
assert.ok(js.includes('layoutPositions'));
assert.ok(server.includes('/api/apps'));
assert.ok(server.includes("/apps/"));
assert.ok(server.includes("/api/proxy"));
assert.ok(server.includes("PROXY_PORT"));
assert.ok(server.includes("frame-ancestors") === false); // upstream framing headers are intentionally stripped at the proxy
assert.ok(server.includes("Blocked private address"));
assert.ok(server.includes("rewriteHtml"));
assert.ok(!server.includes('dockerode'));
assert.ok(fs.readFileSync(path.join(__dirname, 'docker-compose.yml'), 'utf8').includes('18081:8081'));
console.log('✓ freeform UI + API contracts');

console.log('All static tests passed successfully.');
process.exit(0);
