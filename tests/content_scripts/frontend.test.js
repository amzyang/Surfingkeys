/*
 * The frontend iframe runs the default mappings against its own Front, so a front
 * method a default mapping calls has to exist there too, not only on the content
 * window's stub in front.js.
 */
import fs from 'fs';
import path from 'path';

jest.mock('marked', () => ({ marked: { parse: (str) => str } }));

describe('frontend iframe', () => {
    beforeAll(() => {
        const html = fs.readFileSync(
            path.resolve(__dirname, '../../src/content_scripts/ui/frontend.html'), 'utf8');
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        document.head.innerHTML = parsed.head.innerHTML;
        document.body.innerHTML = parsed.body.innerHTML;
        global.chrome = {
            runtime: {
                getURL: (p) => `chrome-extension://surfingkeys${p}`,
                getManifest: () => ({manifest_version: 3}),
                sendMessage: jest.fn(),
                onMessage: {addListener: jest.fn()},
            },
            storage: {local: {get: (keys, cb) => cb({logLevels: []})}},
        };
        require('../../src/content_scripts/ui/frontend.js');
    });

    it('handles ? from the usage popup without throwing', () => {
        const errors = [];
        const onError = (e) => {
            errors.push(e.error);
            e.preventDefault();
        };
        window.addEventListener('error', onError);
        window.dispatchEvent(new KeyboardEvent('keydown', {key: '?'}));
        window.removeEventListener('error', onError);
        expect(errors).toEqual([]);
    });
});
