import { installChromeMock } from './chromeMock';

const startWith = (nvimServer) => {
    const handle = installChromeMock();
    const { start } = require('src/background/start.js');
    start({
        getLatestHistoryItem: jest.fn(),
        _setNewTabUrl: jest.fn(),
        _getContainerName: jest.fn(),
        loadRawSettings: jest.fn(),
        nvimServer,
    });
    return handle;
};

describe('connectNative', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    test('responds with an error when the native host is unavailable', () => {
        const { messageListener } = startWith(undefined);
        const sendResponse = jest.fn();

        messageListener({ action: 'connectNative', mode: 'embed' }, null, sendResponse);

        expect(sendResponse).toHaveBeenCalledWith({
            error: 'Neovim native messaging host is not available.',
        });
    });

    test('responds with the server url and forwards the mode', async () => {
        const nm = { postMessage: jest.fn() };
        const { messageListener } = startWith({
            instance: Promise.resolve({ url: '127.0.0.1:4242/secret', nm }),
        });
        const sendResponse = jest.fn();

        messageListener({ action: 'connectNative', mode: 'embed' }, null, sendResponse);
        await Promise.resolve();

        expect(nm.postMessage).toHaveBeenCalledWith({ mode: 'embed' });
        expect(sendResponse).toHaveBeenCalledWith({ url: '127.0.0.1:4242/secret' });
    });

    test('responds with a serializable error message when the host failed to start', async () => {
        const { messageListener } = startWith({
            instance: Promise.reject(new Error('nvim exited before starting the server')),
        });
        const sendResponse = jest.fn();

        messageListener({ action: 'connectNative', mode: 'standalone' }, null, sendResponse);
        await Promise.resolve();
        await Promise.resolve();

        expect(sendResponse).toHaveBeenCalledWith({
            error: 'nvim exited before starting the server',
        });
        // An Error instance would serialize to `{}` over chrome.runtime messaging.
        expect(typeof sendResponse.mock.calls[0][0].error).toBe('string');
    });
});
