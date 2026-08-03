import { EventEmitter } from 'events';
import type { Transport, Args, MessageType } from 'src/nvim/types';
import { encode, decodeMultiStream } from "@msgpack/msgpack";

class WebSocketTransport extends EventEmitter implements Transport {
    socket: WebSocket;
    open: boolean;

    private chunks: Uint8Array[] = [];
    private wake: (() => void) | null = null;
    private closed = false;

    constructor(url: string) {
        super();

        this.open = false;
        this.socket = new WebSocket(`ws://${url}`);
        // Deliver frames as ArrayBuffer so that they can be queued synchronously,
        // a Blob would need an await and could reorder two frames of the same tick.
        this.socket.binaryType = 'arraybuffer';

        this.socket.onmessage = ({ data }) => {
            this.chunks.push(new Uint8Array(data));
            const wake = this.wake;
            this.wake = null;
            if (wake) {
                wake();
            }
        };
        this.socket.onopen = () => {
            this.open = true;
            this.emit('nvim:open');
        };
        this.socket.onclose = () => {
            this.markClosed();
            if (this.open) {
                this.open = false;
                this.emit('nvim:close');
            } else {
                this.emit('nvim:connection_failed');
            }
        };

        void this.decodeLoop();
    }

    private markClosed(): void {
        this.closed = true;
        const wake = this.wake;
        this.wake = null;
        if (wake) {
            wake();
        }
    }

    /**
     * Yields socket frames as they arrive, so that the msgpack decoder owns the
     * reassembly of values that span several frames.
     */
    private async *frames(): AsyncGenerator<Uint8Array> {
        for (;;) {
            while (this.chunks.length) {
                yield this.chunks.shift() as Uint8Array;
            }
            if (this.closed) {
                return;
            }
            await new Promise<void>((resolve) => {
                this.wake = resolve;
            });
        }
    }

    private async decodeLoop(): Promise<void> {
        try {
            for await (const message of decodeMultiStream(this.frames())) {
                this.emit('nvim:data', message as MessageType);
            }
        } catch (e) {
            // Trailing bytes of a value cut short by the close are expected.
            // Anything else means the stream is no longer trustworthy.
            if (!this.closed) {
                this.emit('nvim:decode_error', e);
                this.close();
            }
        }
    }

    send(channel: string, ...args: Args): void {
        if (channel === 'nvim:write') {
            const req = [0, ...args];
            if (this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(encode(req));
            } else if (this.open) {
                this.open = false;
                this.markClosed();
                this.emit('nvim:close');
            }
        }
    }

    close(): void {
        this.markClosed();
        this.socket.close();
    }
}

export default WebSocketTransport;
