---
name: New ecosystem adapter
about: Propose or claim an adapter for an ecosystem greenbatch does not cover
title: 'adapter: '
labels: ['adapter']
---

## Ecosystem

<!-- Python (uv/pip), Go, Rust, Gradle, pnpm, ... -->

## The mechanics

Answering these is most of the design, and they are what the contract in
[docs/adapters.md](../../docs/adapters.md) needs from you:

- **Manifest and lockfile:** which files does an update touch?
- **Detection:** what proves this ecosystem, and what near misses must be *refused*? A
  shared manifest filename with a different tool is the trap npm fell into with pnpm.
- **Discovery:** what reports available updates without writing to the tree?
- **Levers:** how many distinct ways can a version move? Maven has three, which is why
  its element ids encode the mechanism.
- **Version scheme:** how are patch/minor/major decided, and what counts as a
  prerelease?
- **Families:** which packages must move together, if any?
- **Unmovable versions:** is there an equivalent of Maven's BOM pinning, where an update
  exists but there is no lever for it?

## Are you writing it?

<!-- Claiming it is welcome. So is proposing it for someone else. -->
