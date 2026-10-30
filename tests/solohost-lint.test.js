import test from 'node:test';
import assert from 'node:assert/strict';
import { lintPackage } from '../src/release/solohost-lint.js';

const goodCompose = `services:
  app:
    image: ghcr.io/demo/app:1.2.3
    restart: unless-stopped
    labels:
      pi.ui.primary: "true"
    ports:
      - "127.0.0.1:18123:8080"
    environment:
      ADMIN_PASSWORD: \${ADMIN_PASSWORD}
volumes:
  data:
`;
const goodConfig = `title: "Demo"
output_file: .env
fields:
  - name: ADMIN_PASSWORD
    type: password
    preserve_if_blank: true
    help: "Admin password"
`;

test('good package has no errors', () => {
  const r = lintPackage({ composeText: goodCompose, configText: goodConfig });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
});

test('build: is an error', () => {
  const compose = goodCompose.replace('image: ghcr.io/demo/app:1.2.3', 'build: .\n    image: ghcr.io/demo/app:1.2.3');
  const r = lintPackage({ composeText: compose, configText: goodConfig });
  assert.ok(r.errors.some((e) => e.rule === 'E-BUILD'));
});

test('cap_add is an error', () => {
  const compose = goodCompose.replace('restart: unless-stopped', 'cap_add: ["NET_ADMIN"]\n    restart: unless-stopped');
  const r = lintPackage({ composeText: compose, configText: goodConfig });
  assert.ok(r.errors.some((e) => e.rule === 'E-CAP_ADD'));
});

test('bind mount is an error', () => {
  const compose = goodCompose.replace('volumes:\n  data:', '    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\nvolumes:\n  data:');
  const r = lintPackage({ composeText: compose, configText: goodConfig });
  assert.ok(r.errors.some((e) => e.rule === 'E-BIND-MOUNT'));
});

test('undeclared var is an error', () => {
  const compose = goodCompose.replace(
    'ADMIN_PASSWORD: ${ADMIN_PASSWORD}',
    'ADMIN_PASSWORD: ${ADMIN_PASSWORD}\n      OTHER: ${OTHER}',
  );
  const r = lintPackage({ composeText: compose, configText: goodConfig });
  assert.ok(r.errors.some((e) => e.rule === 'E-UNDECLARED-VAR' && e.params?.var === 'OTHER'));
});

test('comment ${VAR} is ignored (parsed values only)', () => {
  const compose = goodCompose + '\n# example: ${FAKE_IN_COMMENT}\n';
  const r = lintPackage({ composeText: compose, configText: goodConfig });
  assert.ok(!r.errors.some((e) => e.params?.var === 'FAKE_IN_COMMENT'));
});

test('visible_if object form is valid', () => {
  const config = `title: "X"
output_file: .env
fields:
  - name: PROVIDER
    type: select
    default: "a"
    options:
      - value: a
        label: A
  - name: KEY
    type: password
    preserve_if_blank: true
    visible_if:
      field: PROVIDER
      in: [a]
`;
  const compose = `services:
  app:
    image: ghcr.io/x/y:1
    labels:
      pi.ui.primary: "true"
    ports:
      - "127.0.0.1:18111:8080"
    environment:
      PROVIDER: \${PROVIDER}
      KEY: \${KEY}
`;
  const r = lintPackage({ composeText: compose, configText: config });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
});

test('set-only var used in compose needs hidden field', () => {
  const config = `title: "X"
output_file: .env
fields:
  - name: MODE
    type: select
    default: "a"
    options:
      - value: a
        label: A
        set:
          BASE_URL: "http://x"
`;
  const compose = `services:
  app:
    image: ghcr.io/x/y:1
    labels:
      pi.ui.primary: "true"
    ports:
      - "127.0.0.1:18111:8080"
    environment:
      MODE: \${MODE}
      BASE_URL: \${BASE_URL}
`;
  const r = lintPackage({ composeText: compose, configText: config });
  assert.ok(r.errors.some((e) => e.rule === 'E-SET-ONLY-VAR-USED' && e.params?.var === 'BASE_URL'), JSON.stringify(r.errors));
});

test('fixed secret is an error', () => {
  const config = goodConfig + `\nfixed_values:\n  - name: API_KEY\n    value: "sk-secret"\n`;
  const r = lintPackage({ composeText: goodCompose, configText: config });
  assert.ok(r.errors.some((e) => e.rule === 'E-FIXED-SECRET'));
});

test('unknown field type is an error', () => {
  const config = `title: "X"\noutput_file: .env\nfields:\n  - name: ADMIN_PASSWORD\n    type: textarea\n`;
  const r = lintPackage({ composeText: goodCompose, configText: config });
  assert.ok(r.errors.some((e) => e.rule === 'E-FIELD-TYPE'));
});

test('omit without volume is error when policy omits', () => {
  const compose = `services:\n  app:\n    image: ghcr.io/x/y:1\n    labels:\n      pi.ui.primary: "true"\n    ports:\n      - "127.0.0.1:18111:8080"\n`;
  const config = `title: "X"\noutput_file: .env\nfields: []\n`;
  const r = lintPackage({ composeText: compose, configText: config, policy: { mode: 'defaults', fields: {} } });
  assert.ok(r.errors.some((e) => e.rule === 'E-OMIT-NEEDS-VOLUME'));
});
