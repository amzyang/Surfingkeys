const { TextEncoder, TextDecoder } = require('util');

// jsdom does not expose TextEncoder/TextDecoder, which aws4fetch (imported by
// src/background/llm.js) needs at module scope.
if (typeof global.TextEncoder === 'undefined') {
    global.TextEncoder = TextEncoder;
}
if (typeof global.TextDecoder === 'undefined') {
    global.TextDecoder = TextDecoder;
}
