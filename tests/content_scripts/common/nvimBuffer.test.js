import { sanitizeNvimBufferName } from 'src/content_scripts/common/nvimBuffer.js';

describe('sanitizeNvimBufferName', () => {
    test('keeps ordinary host/tag names untouched', () => {
        expect(sanitizeNvimBufferName('github.com/textarea')).toBe('github.com/textarea');
        expect(sanitizeNvimBufferName('example.com:3000/input')).toBe('example.com:3000/input');
    });

    test('neutralizes a double quote (VimScript comment) in the tag', () => {
        // <x"y> parses to nodeName x"y in Chrome, so the tag is page-controlled.
        expect(sanitizeNvimBufferName('example.com/x"y')).toBe('example.com/x_y');
    });

    test('neutralizes a bar (VimScript command separator)', () => {
        expect(sanitizeNvimBufferName('a.com/b|call system("x")')).not.toContain('|');
        expect(sanitizeNvimBufferName('a.com/b|c')).toBe('a.com/b_c');
    });

    test('neutralizes newlines and carriage returns', () => {
        expect(sanitizeNvimBufferName('a.com/b\ncall foo()')).not.toMatch(/[\r\n]/);
        expect(sanitizeNvimBufferName('a.com/b\r\nc')).toBe('a.com/b__c');
    });

    test('neutralizes whitespace and backslash', () => {
        expect(sanitizeNvimBufferName('a.com/b c')).toBe('a.com/b_c');
        expect(sanitizeNvimBufferName('a.com/b\\c')).toBe('a.com/b_c');
    });

    test('coerces a non-string to an empty string', () => {
        expect(sanitizeNvimBufferName(undefined)).toBe('');
        expect(sanitizeNvimBufferName(null)).toBe('');
    });
});
