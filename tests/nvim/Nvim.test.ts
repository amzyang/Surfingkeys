import Nvim from 'src/nvim/Nvim';

import type { Transport } from 'src/nvim/types';

type MockTransport = Transport & { send: jest.Mock; close: jest.Mock };

const mockTransports: MockTransport[] = [];

jest.mock('src/nvim/transport/websocket', () => {
    // The factory may not close over imports, so pull EventEmitter in lazily.
    const { EventEmitter: MockEmitter } = require('events');
    return function () {
        const transport = Object.assign(new MockEmitter(), {
            send: jest.fn(),
            close: jest.fn(),
        });
        mockTransports.push(transport);
        return transport;
    };
});

const latestTransport = (): MockTransport => mockTransports[mockTransports.length - 1];

describe('Nvim', () => {
    let nvim: Nvim;
    let mockTransport: MockTransport;

    beforeEach(() => {
        mockTransports.length = 0;
        nvim = new Nvim();
        nvim.connect("ws://mock");
        mockTransport = latestTransport();
    });

    describe('notification', () => {
        test('send `nvim_subscribe` when you subscribe', () => {
            nvim.on('onSomething', () => null);
            expect(mockTransport.send).toHaveBeenCalledWith('nvim:write', 1, 'nvim_subscribe', ['onSomething']);
        });

        test('does not subscribe twice on the same event', () => {
            nvim.on('onSomething', () => null);
            nvim.on('onSomething', () => null);
            expect(mockTransport.send).toHaveBeenCalledWith('nvim:write', 1, 'nvim_subscribe', ['onSomething']);
            expect(mockTransport.send).toHaveBeenCalledTimes(1);
        });

        test('send `nvim_unsubscribe` when you subscribe', () => {
            const listener = () => null;
            nvim.on('onSomething', listener);
            nvim.removeListener('onSomething', listener);
            expect(mockTransport.send).toHaveBeenCalledWith('nvim:write', 2, 'nvim_unsubscribe', ['onSomething']);
        });

        test('does not unsubscribe if you have events with that name', () => {
            const listener = () => null;
            const anotherListener = () => null;
            nvim.on('onSomething', listener);
            nvim.on('onSomething', anotherListener);
            nvim.removeListener('onSomething', listener);
            expect(mockTransport.send).not.toHaveBeenCalledWith('nvim:write', 2, 'nvim_unsubscribe', ['onSomething']);
        });

        test('receives notification for subscription', () => {
            const callback = jest.fn();
            nvim.on('onSomething', callback);
            mockTransport.emit('nvim:data', [2, 'onSomething', 'params1']);
            expect(callback).toHaveBeenCalledWith('params1');
            mockTransport.emit('nvim:data', [2, 'onSomething', 'params2']);
            expect(callback).toHaveBeenCalledWith('params2');
        });

        test('does not receives notifications that are not subscribed', () => {
            const callback = jest.fn();
            nvim.on('onSomething', callback);
            mockTransport.emit('nvim:data', [2, 'onSomethingElse', 'params1']);
            expect(callback).not.toHaveBeenCalled();
        });
    });

    describe('request message type', () => {
        test('receives result of request', async () => {
            const errorSpy = jest.spyOn(console, 'error').mockImplementationOnce(() => {
                /* empty */
            });
            mockTransport.emit('nvim:data', [0]);
            expect(errorSpy).toHaveBeenCalled();
        });
    });

    describe('predefined commands', () => {
        const commands = [
            ['subscribe', 'subscribe'],
            ['unsubscribe', 'unsubscribe'],
            ['callFunction', 'call_function'],
            ['command', 'command'],
            ['input', 'input'],
            ['inputMouse', 'input_mouse'],
            ['getMode', 'get_mode'],
            ['uiTryResize', 'ui_try_resize'],
            ['uiAttach', 'ui_attach'],
            ['getHlByName', 'get_hl_by_name'],
            ['paste', 'paste'],
        ] as const;
        commands.forEach(([command, request]) => {
            test(`${command}`, () => {
                nvim[command]('param1', 'param2');
                expect(mockTransport.send).toHaveBeenCalledWith('nvim:write', 1, `nvim_${request}`, ['param1', 'param2']);
            });
        });

        test('eval', () => {
            nvim.eval('param1');
            expect(mockTransport.send).toHaveBeenCalledWith('nvim:write', 1, `nvim_eval`, ['param1']);
        });

        test('getShortMode returns mode', async () => {
            const resultPromise = nvim.getShortMode();
            mockTransport.emit('nvim:data', [1, 1, null, { mode: 'n' }]);
            expect(await resultPromise).toBe('n');
        });

        test('getShortMode cut CTRL- from mode', async () => {
            const resultPromise = nvim.getShortMode();
            mockTransport.emit('nvim:data', [1, 1, null, { mode: 'CTRL-n' }]);
            expect(await resultPromise).toBe('n');
        });
    });

    test('emit `close` when transport emits `nvim:close`', () => {
        const callback1 = jest.fn();
        const callback2 = jest.fn();

        nvim.on('nvim:close', callback1);
        nvim.on('nvim:close', callback2);

        mockTransport.emit('nvim:close');

        expect(callback1).toHaveBeenCalled();
        expect(callback2).toHaveBeenCalled();
    });

    describe('connection lifecycle', () => {
        test('rejects pending requests when the connection closes', async () => {
            const pending = nvim.getMode();

            mockTransport.emit('nvim:close');

            await expect(pending).rejects.toThrow('Neovim connection closed');
        });

        test('closes the previous transport when connecting to another url', () => {
            const previous = mockTransport;

            nvim.connect('ws://another');

            expect(previous.close).toHaveBeenCalled();
            expect(mockTransports).toHaveLength(2);
        });

        test('ignores data coming from a transport it replaced', () => {
            const previous = mockTransport;
            const callback = jest.fn();
            nvim.on('onSomething', callback);

            nvim.connect('ws://another');
            previous.emit('nvim:data', [2, 'onSomething', 'stale']);

            expect(callback).not.toHaveBeenCalled();
        });

        test('reuses the connection when the url did not change', () => {
            const connectExisting = jest.fn();
            nvim.on('nvim:connectExisting', connectExisting);
            mockTransport.emit('nvim:open');

            nvim.connect('ws://mock');

            expect(connectExisting).toHaveBeenCalled();
            expect(mockTransports).toHaveLength(1);
        });

        test('rejects pending requests when it moves to another url', async () => {
            const pending = nvim.getMode();

            nvim.connect('ws://another');

            await expect(pending).rejects.toThrow('Neovim connection closed');
        });

        test('does not report a url switch as a shutdown', () => {
            const closed = jest.fn();
            nvim.on('nvim:close', closed);

            nvim.connect('ws://another');

            expect(closed).not.toHaveBeenCalled();
        });

        test('forwards `nvim:decode_error`', () => {
            const callback = jest.fn();
            nvim.on('nvim:decode_error', callback);

            mockTransport.emit('nvim:decode_error', new Error('bad frame'));

            expect(callback).toHaveBeenCalled();
        });
    });
});
