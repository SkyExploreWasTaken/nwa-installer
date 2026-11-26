// SPDX-License-Identifier: GPL-3.0-or-later
// How the NumPlay games are shown, 'list' (the default) or 'grid', remembered in the browser's storage. Storage may
// be missing or refuse (private mode, blocked cookies): then the default holds and nothing throws.
export const VIEWS = ['list', 'grid'];
const KEY = 'nwa-np-view';

export function loadView(storage) {
  try {
    const v = storage.getItem(KEY);
    return VIEWS.includes(v) ? v : 'list';
  } catch { return 'list'; }
}

export function saveView(storage, view) {
  if (!VIEWS.includes(view)) return false;
  try { storage.setItem(KEY, view); return true; } catch { return false; }
}
