import {
    LOG,
    NATIVE_HOST_NAME,
} from '../common/utils.js';

function generatePassword() {
    const random = new Uint32Array(8);
    self.crypto.getRandomValues(random);
    return Array.from(random).join("");
}

// Connects to the native messaging host that runs neovim (src/nvim/server) and
// returns the handle Chrome and Firefox pass to start() as `browser.nvimServer`;
// Safari has no such host and passes none.
//
// The host is launched by the first `ensure()` or `request()`, not at load: an MV3
// service worker runs this module again on every wake, and each run would spawn a
// headless neovim even for a user who never opens the editor.
//
// `ensure()` returns `instance`, a promise of {url, nm}. It rejects when the host
// never answers, and the next call tries again.
//
// `ready` means the host has answered, and the editor is offered on that: a pending
// or dropped connection may have no host behind it.
//
// `request` shares this connection, so one neovim answers both the editor and every
// settings read.
function createNvimServer() {
    const nvimServer = {ready: false};
    let nativeConnected = false;

    // Without a growing delay, a host that dies as it starts is relaunched as fast
    // as the OS can fail it. Never gives up, so fixing the host recovers on its own.
    const RECONNECT_DELAY_MS = 1000;
    const RECONNECT_DELAY_MAX_MS = 30000;
    let reconnectDelay = RECONNECT_DELAY_MS;

    // Keyed by request id, because the editor and a settings read are outstanding at
    // once and a reply says nothing else about which one it answers.
    const pending = new Map();
    let nextRequestId = 1;

    // `reachable` resolves on the host's first message of any kind, and rejects if
    // the connection drops before one. Requests wait on it rather than on `instance`,
    // which also needs the editor's websocket server to come up.
    let port = null;
    let reachable = null;

    // The browser's reason for the last disconnect, reported to a request that
    // arrives while `port` is null.
    let lastFailure = "";

    // Settlers of a pending `instance`, so every attempt of one retry run settles
    // the SAME promise a caller is already holding.
    let settleInstance = null;
    let failInstance = null;

    let launched = false;

    // An `instance` left resolved across a retry hands out the port that just died,
    // so a pending one takes its place before each attempt.
    function armInstance() {
        if (settleInstance) {
            return;
        }
        nvimServer.instance = new Promise((resolve, reject) => {
            settleInstance = resolve;
            failInstance = reject;
        });
        // Nothing need be waiting on it, and an unobserved rejection is logged as an
        // error.
        nvimServer.instance.catch(() => {});
    }

    function rejectPending(reason) {
        const waiting = Array.from(pending.values());
        pending.clear();
        waiting.forEach((entry) => entry.reject(new Error(reason)));
    }

    // Hands `resp` to the request it answers, if any. Returns whether it did, so
    // the caller can fall through to the editor's own handling.
    function deliver(resp) {
        if (resp.id !== undefined && pending.has(resp.id)) {
            const entry = pending.get(resp.id);
            pending.delete(resp.id);
            entry.resolve(resp);
            return true;
        }
        if (resp.id !== undefined) {
            return false;
        }
        // Only a new enough server.lua echoes the id. Without one, the reply can
        // only belong to the single outstanding request -- except the editor's own,
        // which never goes through request() and is told apart by shape.
        const isEditorReply = resp.res && (resp.res.event || resp.res.mode);
        if (pending.size === 1 && !isEditorReply) {
            const [id, entry] = Array.from(pending.entries())[0];
            pending.delete(id);
            entry.resolve(resp);
            return true;
        }
        return false;
    }

    function startNative() {
        let markReachable;
        let markUnreachable;
        reachable = new Promise((resolve, reject) => {
            markReachable = resolve;
            markUnreachable = reject;
        });
        // Nothing need be waiting on it, and an unobserved rejection is logged as an
        // error.
        reachable.catch(() => {});

        const nm = chrome.runtime.connectNative(NATIVE_HOST_NAME);
        port = nm;
        const password = generatePassword();
        let answeredAt = null;
        nm.onDisconnect.addListener((disconnected) => {
            // Firefox reports it on the port, Chrome in runtime.lastError.
            const reason = (disconnected && disconnected.error && disconnected.error.message)
                || (chrome.runtime.lastError && chrome.runtime.lastError.message)
                || "";
            nvimServer.ready = false;
            if (port === nm) {
                port = null;
            }
            const failure = reason || "the connection to neovim was lost";
            lastFailure = failure;
            markUnreachable(new Error(failure));
            // A request on a dead port is never answered. One made during the wait
            // below is refused by `port` being null, since `reachable` stays resolved
            // once a host has spoken.
            rejectPending(failure);
            if (nativeConnected) {
                armInstance();
                // A host that had been up a while died of something done in the
                // editor -- `:q` quits it -- not of starting up, so it comes straight
                // back: the next editor would otherwise wait out the delay.
                const upAWhile = answeredAt !== null
                    && Date.now() - answeredAt >= RECONNECT_DELAY_MS;
                const delay = upAWhile ? 0 : reconnectDelay;
                if (!upAWhile) {
                    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_DELAY_MAX_MS);
                }
                setTimeout(startNative, delay);
            } else {
                delete nvimServer.instance;
                settleInstance = null;
                launched = false;
                failInstance(new Error(failure));
                LOG("warn", "Failed to connect neovim"
                    + (reason ? ": " + reason : "")
                    + ". See src/nvim/server/Readme.md to install the native"
                    + " messaging host; neovim must be 0.10 or above.");
            }
        });
        nm.onMessage.addListener(async (resp) => {
            markReachable();
            if (answeredAt === null) {
                answeredAt = Date.now();
            }
            // A host that answered got up, so its next failure starts the delay over.
            reconnectDelay = RECONNECT_DELAY_MS;
            if (deliver(resp)) {
                return;
            }
            if (resp.status === true) {
                nativeConnected = true;
                // A host that does not know a command answers with no `res`, and a
                // throw in here goes unreported.
                if (resp.res && resp.res.event === "serverStarted") {
                    const url = `127.0.0.1:${resp.res.port}/${password}`;
                    nvimServer.ready = true;
                    if (settleInstance) {
                        const settle = settleInstance;
                        settleInstance = null;
                        settle({url, nm});
                    }
                }
            } else if (resp.err) {
                LOG("error", resp.err);
            }
        });
        nm.postMessage({
            startServer: true,
            password
        });
    }

    // Resolves with the host's reply to `message`; rejects when the host cannot be
    // reached.
    //
    // No deadline here -- the caller owns that, and two would let the shorter one
    // decide which reason is reported. `signal` releases the entry: one held after
    // the caller gives up can no longer be matched to a reply carrying no id.
    nvimServer.request = function(message, {signal} = {}) {
        launch();
        return Promise.resolve(reachable).then(() => {
            if (signal && signal.aborted) {
                throw new Error("the request was abandoned");
            }
            if (!port) {
                throw new Error(lastFailure || "the connection to neovim is not open");
            }
            return new Promise((resolve, reject) => {
                const id = nextRequestId++;
                pending.set(id, {resolve, reject});
                if (signal) {
                    signal.addEventListener("abort", () => {
                        if (pending.delete(id)) {
                            reject(new Error("the request was abandoned"));
                        }
                    }, {once: true});
                }
                port.postMessage(Object.assign({}, message, {id}));
            });
        });
    };

    function launch() {
        if (!launched) {
            launched = true;
            armInstance();
            startNative();
        }
    }

    nvimServer.ensure = function() {
        launch();
        return nvimServer.instance;
    };

    return nvimServer;
}

export {
    createNvimServer,
}
