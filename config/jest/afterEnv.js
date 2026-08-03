const { TextEncoder, TextDecoder } = require('util');

// jsdom ships neither, but both are globals in every browser context we target
// and dependencies of src/background reach for them at import time.
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;
