import { createLazyConnection } from 'src/background/lazyConnection.js';

describe('createLazyConnection', () => {
    test('does not connect until ensure() is called', () => {
        const connect = jest.fn(() => Promise.resolve('conn'));

        createLazyConnection(connect);

        expect(connect).not.toHaveBeenCalled();
    });

    test('caches the connection across ensure() calls', async () => {
        const connect = jest.fn(() => Promise.resolve('conn'));
        const { ensure } = createLazyConnection(connect);

        const a = ensure();
        const b = ensure();

        expect(a).toBe(b);
        expect(connect).toHaveBeenCalledTimes(1);
        await expect(a).resolves.toBe('conn');
    });

    test('rebuilds after a failed connection', async () => {
        const connect = jest
            .fn()
            .mockReturnValueOnce(Promise.reject(new Error('host missing')))
            .mockReturnValueOnce(Promise.resolve('conn'));
        const { ensure } = createLazyConnection(connect);

        await expect(ensure()).rejects.toThrow('host missing');
        // Let the internal .catch that clears the cache run.
        await Promise.resolve();

        await expect(ensure()).resolves.toBe('conn');
        expect(connect).toHaveBeenCalledTimes(2);
    });

    test('invalidate() forces the next ensure() to rebuild', async () => {
        const connect = jest
            .fn()
            .mockReturnValueOnce(Promise.resolve('first'))
            .mockReturnValueOnce(Promise.resolve('second'));
        const { ensure, invalidate } = createLazyConnection(connect);

        await expect(ensure()).resolves.toBe('first');
        invalidate();

        await expect(ensure()).resolves.toBe('second');
        expect(connect).toHaveBeenCalledTimes(2);
    });
});
