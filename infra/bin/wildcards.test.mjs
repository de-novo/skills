// The DNS wildcard rule and the TLS wildcard rule, each as its RFC states
// it, and doctor --probe reporting each boundary as its own observation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

import { probeAddressing } from '../lib/doctor.mjs';
import { dnsWildcardSynthesizes, tlsNameMatches, wildcardExplanation } from '../lib/wildcards.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'cli.mjs');

test('TLS: a wildcard matches one label in the left-most position and nothing else (RFC 9525 §6.3)', () => {
  assert.equal(tlsNameMatches('*.local.example.com', 'acme.local.example.com'), true);
  assert.equal(tlsNameMatches('*.local.example.com', 'web.acme.local.example.com'), false);
  assert.equal(tlsNameMatches('*.acme.local.example.com', 'web.acme.local.example.com'), true);
  assert.equal(tlsNameMatches('*.local.example.com', 'local.example.com'), false, 'the wildcard label is not optional');
  assert.equal(tlsNameMatches('web.*.example.com', 'web.acme.example.com'), false, 'only the left-most label may be a wildcard');
  assert.equal(tlsNameMatches('w*.example.com', 'web.example.com'), false, 'a partial wildcard is not matched');
  assert.equal(tlsNameMatches('*.com', 'example.com'), false, 'a wildcard needs at least two labels beneath it');
  assert.equal(tlsNameMatches('web.example.com', 'WEB.example.com.'), true, 'case and the trailing dot do not matter');
});

test('DNS: a wildcard synthesizes at any depth below an empty parent and stops where a name exists (RFC 4592 §3.3.1)', () => {
  const wildcard = '*.local.example.com';
  assert.equal(dnsWildcardSynthesizes({ wildcard, qname: 'acme.local.example.com' }).synthesizes, true);
  assert.equal(dnsWildcardSynthesizes({ wildcard, qname: 'web.acme.local.example.com' }).synthesizes, true, 'two labels below an empty parent are covered');
  const withProject = dnsWildcardSynthesizes({ wildcard, qname: 'web.acme.local.example.com', existing: ['acme.local.example.com'] });
  assert.equal(withProject.synthesizes, false, 'an existing intermediate name is the closest encloser instead');
  assert.match(withProject.why, /acme\.local\.example\.com exists, so the closest encloser is not local\.example\.com/);
  const withSibling = dnsWildcardSynthesizes({ wildcard, qname: 'web.acme.local.example.com', existing: ['api.acme.local.example.com'] });
  assert.equal(withSibling.synthesizes, false, 'a name below the intermediate makes the intermediate exist');
  assert.equal(dnsWildcardSynthesizes({ wildcard, qname: 'acme.local.example.com', existing: ['acme.local.example.com'] }).synthesizes, false, 'an existing name is answered by its own records');
  assert.equal(dnsWildcardSynthesizes({ wildcard, qname: 'other.example.com' }).synthesizes, false);
  assert.equal(dnsWildcardSynthesizes({ wildcard: 'local.example.com', qname: 'x.local.example.com' }).synthesizes, false);
  // The two rules disagree on the very name Grove renders.
  assert.deepEqual(wildcardExplanation('web.acme.local.example.com'), [
    { pattern: '*.acme.local.example.com', tls: true, dns: true },
    { pattern: '*.local.example.com', tls: false, dns: true },
  ]);
});

test('doctor --probe reports dns per rendered name and names listener, route, tls, and revision as not measured', async (t) => {
  const rows = await probeAddressing(['localhost', 'nothing.invalid']);
  assert.equal(rows[0].dns.state, 'ready');
  assert.ok(rows[0].dns.addresses.length > 0);
  assert.equal(rows[1].dns.state, 'missing');
  for (const row of rows) {
    assert.equal(row.rendered.state, 'ready');
    for (const boundary of ['listener', 'route', 'tls', 'revision']) {
      assert.equal(row[boundary].state, 'unknown');
      assert.match(row[boundary].detail, /not measured/);
    }
  }

  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'doctor-probe-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.agents'), { recursive: true });
  writeFileSync(path.join(root, '.agents/runtime-profile.yml'), stringify({ project: { slug: 'probed' }, services: { api: {} }, data: { infra: 'project' }, overlay: 'none', addressing: { tld: 'localhost' } }));
  const environment = { ...process.env, GROVE_STATE_DIR: path.join(root, 'state') };
  delete environment.DRYAD_PROJECT;
  const result = spawnSync(process.execPath, [CLI, 'doctor', '--project', root, '--probe', '--json'], { env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.probe.dns.length, 1);
  assert.equal(report.probe.dns[0].host, 'api.probed.localhost');
  assert.ok(['ready', 'missing'].includes(report.probe.dns[0].dns.state), 'whether this resolver answers *.localhost is measured, not assumed');
  assert.match(report.probe.note, /a resolved name is not a listener/);
  const text = spawnSync(process.execPath, [CLI, 'doctor', '--project', root, '--probe'], { env: environment, encoding: 'utf8' });
  assert.match(text.stdout, /probe        dns [01]\/1 names resolve here; listener, route, tls, revision not measured/);
  assert.match(text.stdout, /\*\.probed\.localhost  tls matches · dns wildcard would synthesize/);
  assert.match(text.stdout, /\*\.localhost  tls no match · dns wildcard would synthesize/);
  // Without --probe nothing is looked up and the section is absent.
  assert.equal(JSON.parse(spawnSync(process.execPath, [CLI, 'doctor', '--project', root, '--json'], { env: environment, encoding: 'utf8' }).stdout).probe, undefined);
});
