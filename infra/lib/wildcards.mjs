// Two wildcard rules that are often confused, each written down as the
// standard it comes from says it, so a document and a doctor probe can
// explain a hostname instead of guessing.
//
//   DNS (RFC 4592 §§2.2.1, 3.3.1): a wildcard owner `*.example` is used
//   to synthesize an answer for a query name when that name does not
//   exist, its closest encloser is the wildcard's parent, and no name
//   between them exists. That covers any number of labels below the
//   parent (`a.b.example` as well as `a.example`), and stops covering a
//   subtree the moment a name in it exists.
//
//   TLS (RFC 9525 §6.3): a certificate name `*.example` matches exactly one
//   label in the wildcard's position, and only the left-most label may be
//   a wildcard. `*.example` matches `a.example` and never `a.b.example`.
//
// Neither function looks anything up. They take names and say what the
// rule says about them.

function labels(name) {
  return name.toLowerCase().replace(/\.$/, '').split('.').filter((label) => label.length > 0);
}

function isParent(parent, name) {
  return name.length > parent.length && parent.every((label, index) => label === name[name.length - parent.length + index]);
}

// Whether a TLS certificate name matches a host name (RFC 9525 §6.3): a
// wildcard is the whole left-most label, matches one label, and never a
// label of a public suffix or the name itself.
export function tlsNameMatches(pattern, host) {
  const p = labels(pattern);
  const h = labels(host);
  if (p.length === 0 || h.length === 0) return false;
  if (p.some((label, index) => label.includes('*') && (index !== 0 || label !== '*'))) return false;
  if (p[0] !== '*') return p.length === h.length && p.every((label, index) => label === h[index]);
  if (p.length < 3) return false;
  if (h.length !== p.length) return false;
  return p.slice(1).every((label, index) => label === h[index + 1]);
}

// Whether a DNS wildcard owner would synthesize an answer for a query name
// (RFC 4592 §3.3.1), given the names that exist in the zone. `existing` is
// the list of names the zone holds (the wildcard owner itself excluded);
// a name with any records, or with a name below it, exists.
export function dnsWildcardSynthesizes({ wildcard, qname, existing = [] }) {
  const w = labels(wildcard);
  if (w[0] !== '*' || w.length < 2) return { synthesizes: false, why: 'the wildcard owner must be *.<parent>' };
  const parent = w.slice(1);
  const q = labels(qname);
  const names = existing.map(labels);
  const exists = (name) => names.some((entry) => entry.length === name.length && entry.every((label, index) => label === name[index]) || isParent(name, entry));
  if (!isParent(parent, q)) return { synthesizes: false, why: `${qname} is not below ${parent.join('.')}` };
  if (exists(q)) return { synthesizes: false, why: `${qname} exists in the zone; no wildcard applies` };
  // The closest encloser must be the wildcard's parent: no name between
  // the parent and the query name may exist.
  for (let depth = parent.length + 1; depth < q.length; depth += 1) {
    const between = q.slice(q.length - depth);
    if (exists(between)) return { synthesizes: false, why: `${between.join('.')} exists, so the closest encloser is not ${parent.join('.')}` };
  }
  return { synthesizes: true, why: `${qname} does not exist, its closest encloser is ${parent.join('.')}, and nothing between them exists (${q.length - parent.length} label${q.length - parent.length === 1 ? '' : 's'} below)` };
}

// For a rendered host, what each rule says about the wildcard one level
// above its project (`*.<project>.<tld>`) and one above that (`*.<tld>`).
export function wildcardExplanation(host) {
  const h = labels(host);
  const rows = [];
  for (let cut = 1; cut < h.length && cut <= 2; cut += 1) {
    const pattern = `*.${h.slice(cut).join('.')}`;
    rows.push({
      pattern,
      tls: tlsNameMatches(pattern, host),
      dns: dnsWildcardSynthesizes({ wildcard: pattern, qname: host }).synthesizes,
    });
  }
  return rows;
}
