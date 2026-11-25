// SPDX-License-Identifier: GPL-3.0-or-later
// NODE_ENV, handed to the page (env.js reads it). server.js never serves this file: it answers this path with the
// NODE_ENV it runs with ('development' when unset). This copy is only what another web server hosting public/ as it
// is would send: production, so every developer feature stays off there.
export const NODE_ENV = 'production';
