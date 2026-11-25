// SPDX-License-Identifier: GPL-3.0-or-later
// THE one gate for every developer feature of the page: ?mock (a pretend calculator from dev/mock/), ?debug (the
// page's state on window.nwaDebug) and ?debug&simulate=<id> (a simulated calculator for trying the half-supported
// screens, see simulate.js). The page reads its URL's flags only through devFlags(); nothing else parses them.
//
// Decided by NODE_ENV alone, once when this module loads: server.js hands the NODE_ENV it runs with to the page as
// lib/build-mode.js. NODE_ENV=production: production, every flag ignored (devFlags() gives { mock: false, debug: false,
// simulate: null } whatever the URL). Any other NODE_ENV (unset: 'development'): the flags work.
//   isDevMode() -> boolean          devFlags() -> { mock, debug, simulate }
//   (isDevEnv / parseDevFlags: the same for a given NODE_ENV and URL, for the tests)
import { NODE_ENV } from './build-mode.js';

export const SIMULATIONS = ['n0100', 'n0110-old', 'n0115-old'];

export const isDevEnv = (nodeEnv) => nodeEnv !== 'production';

const OFF = Object.freeze({ mock: false, debug: false, simulate: null });

export function parseDevFlags(search, dev) {
  if (!dev) return OFF;
  const q = new URLSearchParams(search || '');
  const debug = q.has('debug');
  const sim = q.get('simulate');
  // a simulation only with ?debug too, and only one of the known ones
  const simulate = debug && SIMULATIONS.includes(sim) ? sim : null;
  // (a simulation replaces the mock calculator: never both)
  return Object.freeze({ mock: q.has('mock') && !simulate, debug, simulate });
}

const DEV = isDevEnv(NODE_ENV);
const FLAGS = parseDevFlags(typeof location === 'undefined' ? '' : location.search, DEV);
export const isDevMode = () => DEV;
export const devFlags = () => FLAGS;
