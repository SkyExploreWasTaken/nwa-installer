// SPDX-License-Identifier: GPL-3.0-or-later
// The errors lib/ throws: a code and its numbers for the page to say in its own language (err.<code> in
// public/i18n/), and an English message for Node tools, tests and the log. lib/ never imports the page's i18n.
//   throw new InstallerError('storage.full', {}, 'The files do not fit in the calculator storage');
export class InstallerError extends Error {
  constructor(code, params = {}, message = code, options) {
    super(message, options);
    this.name = 'InstallerError';
    this.code = code;
    this.params = params;
  }
}
