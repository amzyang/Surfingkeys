import { encode } from '@msgpack/msgpack';

import WebSocketTransport from 'src/nvim/transport/websocket';
import type { MessageType } from 'src/nvim/types';

const sockets: MockWebSocket[] = [];

class MockWebSocket {
    static readonly OPEN = 1;

    static readonly CLOSED = 3;

    readyState: number = MockWebSocket.OPEN;

    binaryType = 'blob';

    sent: Uint8Array[] = [];

    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;

    onopen: (() => void) | null = null;

    onclose: (() => void) | null = null;

    constructor(readonly url: string) {
        sockets.push(this);
    }

    send(data: Uint8Array): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = MockWebSocket.CLOSED;
        if (this.onclose) {
            this.onclose();
        }
    }

    receive(bytes: Uint8Array): void {
        if (this.onmessage) {
            this.onmessage({ data: bytes.slice().buffer });
        }
    }
}

(global as any).WebSocket = MockWebSocket;

const MESSAGES: MessageType[] = [
    [2, 'redraw', [['flush']]],
    [1, 7, null, { mode: 'n' }],
    [2, 'surfingkeys:rpc', ['WriteData', [['hello', 'world']]]],
];

const encodeAll = (messages: MessageType[]): Uint8Array => {
    const parts = messages.map((message) => encode(message));
    const stream = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    parts.reduce((offset, part) => {
        stream.set(part, offset);
        return offset + part.length;
    }, 0);
    return stream;
};

// Let the decoding async generator run to completion for everything queued so far.
const drain = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

const connect = (): { transport: WebSocketTransport; socket: MockWebSocket; received: MessageType[] } => {
    const transport = new WebSocketTransport('127.0.0.1:1234/token');
    const received: MessageType[] = [];
    transport.on('nvim:data', (message: MessageType) => received.push(message));
    const socket = sockets[sockets.length - 1];
    socket.onopen!();
    return { transport, socket, received };
};

describe('WebSocketTransport', () => {
    beforeEach(() => {
        sockets.length = 0;
    });

    test('reads binary frames as ArrayBuffer', () => {
        connect();
        expect(sockets[0].binaryType).toBe('arraybuffer');
        expect(sockets[0].url).toBe('ws://127.0.0.1:1234/token');
    });

    test('emits every message exactly once when the last one is split across chunks', async () => {
        const { socket, received } = connect();
        const stream = encodeAll(MESSAGES);
        const cut = stream.length - Math.floor(encode(MESSAGES[2]).length / 2);

        socket.receive(stream.slice(0, cut));
        await drain();
        socket.receive(stream.slice(cut));
        await drain();

        expect(received).toEqual(MESSAGES);
    });

    test('emits every message exactly once when fed one byte at a time', async () => {
        const { socket, received } = connect();
        const stream = encodeAll(MESSAGES);

        for (let i = 0; i < stream.length; i += 1) {
            socket.receive(stream.slice(i, i + 1));
        }
        await drain();

        expect(received).toEqual(MESSAGES);
    });

    test('emits messages arriving in a single chunk', async () => {
        const { socket, received } = connect();

        socket.receive(encodeAll(MESSAGES));
        await drain();

        expect(received).toEqual(MESSAGES);
    });

    test('sends requests as msgpack-rpc request messages', () => {
        const { transport, socket } = connect();

        transport.send('nvim:write', 3, 'nvim_input', ['x']);

        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0]).toEqual(encode([0, 3, 'nvim_input', ['x']]));
    });

    test('emits `nvim:connection_failed` when it closes before opening', () => {
        const transport = new WebSocketTransport('127.0.0.1:1234/token');
        const failed = jest.fn();
        const closed = jest.fn();
        transport.on('nvim:connection_failed', failed);
        transport.on('nvim:close', closed);

        sockets[0].close();

        expect(failed).toHaveBeenCalled();
        expect(closed).not.toHaveBeenCalled();
    });

    test('emits `nvim:close` when it closes after opening', () => {
        const { transport, socket } = connect();
        const closed = jest.fn();
        const failed = jest.fn();
        transport.on('nvim:close', closed);
        transport.on('nvim:connection_failed', failed);

        socket.close();

        expect(closed).toHaveBeenCalled();
        expect(failed).not.toHaveBeenCalled();
    });
});
