// A single connection built on first use and rebuilt on demand. `connect` is
// only invoked when `ensure()` is called, so nothing is spawned for users who
// never open the resource — under MV3 this keeps a recycled service worker from
// re-spawning a native process on every wake. A failed attempt drops the cache
// so the next `ensure()` retries; `invalidate()` does the same for a connection
// that was healthy and then died.
export function createLazyConnection(connect) {
    let pending = null;

    function ensure() {
        if (!pending) {
            pending = connect();
            pending.catch(() => {
                pending = null;
            });
        }
        return pending;
    }

    function invalidate() {
        pending = null;
    }

    return { ensure, invalidate };
}
