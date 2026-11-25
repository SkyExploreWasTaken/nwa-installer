// SPDX-License-Identifier: GPL-3.0-or-later
// Which Epsilon to offer, from what the local server keeps (/api/firmware/<model>.json) and what the calculator runs.
// Staying on the version the calculator runs is the default whenever that version is kept on this computer, so an
// update is never forced; the other kept versions (newest first) and NumWorks' latest are offered next to it. Only when
// the current version isn't kept does the default fall back to the latest.
//   firmwareChoices(info, { version, patch }) -> { options: [{ version, patch, size, kind, channel, available }], selected }
//   channel: 'stable' or 'beta' (a version kept from NumWorks' beta channel is labeled as such; never the default
//   unless the calculator already runs it)
//   kind: 'current' | 'latest' | 'cached'; available: false when the file isn't kept yet (can't be installed)

// newest first: 24.10.1 before 24.4.0 (numeric parts compared as numbers)
export function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/), pb = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const c = /^\d+$/.test(x) && /^\d+$/.test(y) ? +x - +y : x.localeCompare(y);
    if (c) return c;
  }
  return 0;
}

export function firmwareChoices(info, current) {
  // (a server without a cache, or the mock: only the latest, as a kept file)
  const kept = info.versions || [{ version: info.version, patch_level: info.patch_level, size: info.size }];
  const latest = info.version;
  const byVersion = new Map(kept.map((v) => [v.version, v]));
  const opt = (version, kind) => {
    const v = byVersion.get(version);
    const isLatest = version === latest;
    return { version, patch: v?.patch_level ?? (isLatest ? info.patch_level : null), size: v?.size ?? (isLatest ? info.size : 0),
      kind, channel: v?.channel || (isLatest && info.channel) || 'stable', available: !!v };
  };
  const options = [];
  const currentKept = current && byVersion.has(current.version);
  if (currentKept) options.push(opt(current.version, 'current'));
  const others = new Set(kept.map((v) => v.version));
  if (latest) others.add(latest);
  if (currentKept) others.delete(current.version);
  for (const v of [...others].sort((a, b) => compareVersions(b, a))) options.push(opt(v, v === latest ? 'latest' : 'cached'));
  const stable = (o) => o.available && o.channel !== 'beta';
  const selected = currentKept ? current.version
    : (options.find((o) => o.kind === 'latest' && stable(o)) || options.find(stable) || options.find((o) => o.available) || options[0])?.version ?? null;
  return { options, selected };
}
