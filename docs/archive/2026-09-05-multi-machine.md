> Archived on 2026-09-05. Historical design only; commands and assumptions
> below may be obsolete or unimplemented. Do not use as operating instructions.
> Current authority: [documentation index](../README.md).

# Later — other machines (not built)

Goal only. Do not implement in the current CLI or skill procedure.

Let a second machine reach Grove ground over **Tailscale or Headscale**
(same WireGuard overlay; Headscale if we self-host). One engine set, one
writer. Typical split: homelab (or the always-on box) owns engines and k3s;
the laptop is a client. Named URLs and DBeaver still point at that one host.

Not in that first slice:

- binding engines on `0.0.0.0`
- treating a laptop as a default k8s worker
- a second MySQL (or engine set) per machine

Wait until “open this stack from another box” repeats and a VPN/SSH
one-liner is not enough.
