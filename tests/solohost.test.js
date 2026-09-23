import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

test('SoloHost knowledge is embedded in the Builder prompts', async () => {
  const p = await import('../src/ai/prompts.js');
  assert.match(p.SYSTEM, /pi\.ui\.primary/);
  assert.match(p.SYSTEM, /127\.0\.0\.1:HOST:CONTAINER/);
  assert.match(p.SYSTEM, /config_options\.yml/);
});

test('SoloHost package generator emits the two required files', async () => {
  const { writeSoloHostPackage } = await import('../src/release/solohost.js');
  const root = '/tmp/paf-solohost-test';
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
  const project = { name: 'Test App', idea: 'A test app' };
  const result = await writeSoloHostPackage({ project, sourceDir: root, image: 'ghcr.io/test/app:1.0.0', hostPort: 18123 });
  assert.equal(result.files.includes('docker-compose.yml'), true);
  assert.equal(result.files.includes('config_options.yml'), true);
  const compose = fs.readFileSync(`${root}/solohost/docker-compose.yml`, 'utf8');
  assert.match(compose, /pi\.ui\.primary: "true"/);
  assert.match(compose, /127\.0\.0\.1:18123:8080/);
  assert.equal(fs.existsSync(`${root}/docker-compose.yml`), true);
  assert.equal(fs.existsSync(`${root}/config_options.yml`), true);
});


test('SoloHost release kit includes beginner metadata and exact image address', async () => {
  const { writeSoloHostPackage } = await import('../src/release/solohost.js');
  const root = '/tmp/paf-solohost-kit-test';
  fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
  const result = await writeSoloHostPackage({ project: { name: 'Demo App', idea: 'A demo app' }, sourceDir: root, image: 'ghcr.io/demo/demo-app:1.2.3', hostPort: 18124 });
  assert.deepEqual(result.files.sort(), ['APP_INFO.md', 'INSTALL.md', 'LOGO_PROMPT.txt', 'README.md', 'config_options.yml', 'docker-compose.yml'].sort());
  assert.match(fs.readFileSync(`${root}/solohost/APP_INFO.md`, 'utf8'), /ghcr\.io\/demo\/demo-app:1\.2\.3/);
  assert.match(fs.readFileSync(`${root}/solohost/LOGO_PROMPT.txt`, 'utf8'), /logo/i);
});


test('project exporter creates source and SoloHost ZIPs without secrets', async () => {
  const { createProjectZip } = await import('../src/projects/exporter.js');
  const root = '/tmp/paf-export-test';
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(`${root}/source/solohost`, { recursive: true });
  fs.writeFileSync(`${root}/source/index.html`, '<h1>Demo</h1>');
  fs.writeFileSync(`${root}/source/.env`, 'SECRET=do-not-export');
  fs.writeFileSync(`${root}/source/solohost/docker-compose.yml`, 'services: {}');
  fs.writeFileSync(`${root}/source/solohost/config_options.yml`, 'title: Demo');
  const source = await createProjectZip({ sourceDir: `${root}/source`, outputDir: `${root}/artifacts`, slug: 'demo', kind: 'project' });
  const install = await createProjectZip({ sourceDir: `${root}/source`, outputDir: `${root}/artifacts`, slug: 'demo', kind: 'solohost' });
  assert.equal(fs.existsSync(source.path), true);
  assert.equal(fs.existsSync(install.path), true);
  const listSource = execFileSync('unzip', ['-l', source.path], { encoding: 'utf8' });
  const listInstall = execFileSync('unzip', ['-l', install.path], { encoding: 'utf8' });
  assert.match(listSource, /index\.html/);
  assert.doesNotMatch(listSource, /\.env\s/);
  assert.match(listInstall, /docker-compose\.yml/);
  assert.doesNotMatch(listInstall, /index\.html/);
});

test('top-level Builder compose keeps SoloHost-compatible runtime environment', async () => {
  const fs = await import('node:fs/promises');
  const yml = await fs.readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(yml, /image:\s*ghcr\.io\/cannoi\/app-builder-pi-solohost:latest/);
  assert.match(yml, /127\.0\.0\.1:18781:8080/);
  assert.doesNotMatch(yml, /PREVIEW_REQUIRE_INTERNET/);
  assert.doesNotMatch(yml, /PREVIEW_REQUIRE_BROWSER_TEST/);
});

test('SoloHost install kit contains only the compose/config contract files', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-kit-'));
  const { writeSoloHostPackage } = await import('../src/release/solohost.js');
  const r = await writeSoloHostPackage({ project: { name: 'Demo', idea: 'Simple app' }, sourceDir: dir, image: 'ghcr.io/demo/demo:1.0.0' });
  assert.deepEqual(r.files.sort(), ['APP_INFO.md','INSTALL.md','LOGO_PROMPT.txt','README.md','config_options.yml','docker-compose.yml'].sort());
  assert.match(await fs.readFile(path.join(dir, 'solohost', 'docker-compose.yml'), 'utf8'), /image:\s*ghcr\.io\/demo\/demo:1\.0\.0/);
  assert.doesNotMatch(await fs.readFile(path.join(dir, 'solohost', 'docker-compose.yml'), 'utf8'), /\bbuild:/);
});

test('SoloHost package generation does not assume container port 8080 when app listens on PORT or exposes another port', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { writeSoloHostPackage } = await import('../src/release/solohost.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paf-solohost-port-'));
  const project = { name: 'Radio', idea: 'Radio', slug: 'radio' };
  await fs.writeFile(path.join(root, 'server.js'), 'const PORT = process.env.PORT || 3000;');
  await fs.writeFile(path.join(root, 'Dockerfile'), 'EXPOSE 3000\n');
  const result = await writeSoloHostPackage({ project, sourceDir: root, image: 'ghcr.io/cannoi/radio:0.1.0', hostPort: 18273 });
  const compose = await fs.readFile(path.join(root, 'solohost', 'docker-compose.yml'), 'utf8');
  assert.equal(result.containerPort, 3000);
  assert.match(compose, /18273:3000/);
  assert.doesNotMatch(compose, /18273:8080/);
  await fs.rm(root, { recursive: true, force: true });
});
