'use strict';

// The package verifier is isolated from the device controller: it never loads
// main.js, takes the hardware session lock, or opens a keyboard connection.
const verifyArgument = process.argv.find(argument => argument.startsWith('--verify-package='));
if (verifyArgument) {
  require('./package-verification').run(verifyArgument.slice('--verify-package='.length));
} else {
  require('./main');
}
