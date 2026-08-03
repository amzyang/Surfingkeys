import {
    LOG,
    filterByTitleOrUrl,
} from '../common/utils.js';
import {
    loadRawSettingsFromStorage,
    start
} from './start.js';

function loadRawSettings(keys, cb, defaultSet) {
    loadRawSettingsFromStorage(keys, cb, defaultSet, {useSync: true, dropLocalPath: true});
}

function _applyProxySettings(proxyConf) {
    if (!proxyConf.proxyMode || proxyConf.proxyMode === 'clear') {
        chrome.proxy.settings.clear({scope: 'regular'});
    } else {
        var autoproxy_pattern = proxyConf.autoproxy_hosts.map(function(h) {
            return h.filter(function(a) {
                return a.indexOf('*') !== -1;
            }).join('|');
        });
        var autoproxy_hosts = proxyConf.autoproxy_hosts.map(function(h) {
            return Object.fromEntries(h.filter(function(a) {
                return a.indexOf('*') === -1;
            }).map(function(a) { return [a, 1]; }));
        });
        var config = {
            mode: (["always", "byhost", "bypass"].indexOf(proxyConf.proxyMode) !== -1) ? "pac_script" : proxyConf.proxyMode,
            pacScript: {
                data: `var pacGlobal = {
                        hosts: ${JSON.stringify(autoproxy_hosts)},
                        autoproxy_pattern: ${JSON.stringify(autoproxy_pattern)},
                        proxyMode: '${proxyConf.proxyMode}',
                        proxy: ${JSON.stringify(proxyConf.proxy)}
                    };
                    function FindProxyForURL(url, host) {
                        var lastPos;
                        if (pacGlobal.proxyMode === "always") {
                            return pacGlobal.proxy[0];
                        } else if (pacGlobal.proxyMode === "bypass") {
                            var pp = new RegExp(pacGlobal.autoproxy_pattern[0]);
                            do {
                                if (pacGlobal.hosts[0].hasOwnProperty(host)
                                    || (pacGlobal.autoproxy_pattern[0].length && pp.test(host))) {
                                    return "DIRECT";
                                }
                                lastPos = host.indexOf('.') + 1;
                                host = host.slice(lastPos);
                            } while (lastPos >= 1);
                            return pacGlobal.proxy[0];
                        } else {
                            for (var i = 0; i < pacGlobal.proxy.length; i++) {
                                var pp = new RegExp(pacGlobal.autoproxy_pattern[i]);
                                var ahost = host;
                                do {
                                    if (pacGlobal.hosts[i].hasOwnProperty(ahost)
                                        || (pacGlobal.autoproxy_pattern[i].length && pp.test(ahost))) {
                                        return pacGlobal.proxy[i];
                                    }
                                    lastPos = ahost.indexOf('.') + 1;
                                    ahost = ahost.slice(lastPos);
                                } while (lastPos >= 1);
                            }
                            return "DIRECT";
                        }
                    }`
            }
        };
        chrome.proxy.settings.set( {value: config, scope: 'regular'}, function() {
        });
    }
}

function _setNewTabUrl(){
    return  "chrome://newtab/";
}

function getLatestHistoryItem(text, maxResults, cb) {
    let endTime = new Date().getTime();
    let results = [];
    const impl = (endTime, maxResults, cb) => {
        const prefetch = maxResults * Math.pow(10, Math.min(2, text.length));
        chrome.history.search({
            startTime: 0,
            endTime,
            text: "",
            maxResults: prefetch
        }, function(items) {
            const filtered = filterByTitleOrUrl(items, text, false);
            results = [...results, ...filtered];
            if (items.length < maxResults || results.length >= maxResults) {
                // all items are scanned or we have got what we want
                cb(results.slice(0, maxResults));
            } else {
                endTime = items[items.length-1].lastVisitTime - 0.01;
                impl(endTime, maxResults, cb);
            }
        });
    };

    impl(endTime, maxResults, cb);
}

function generatePassword() {
    const random = new Uint32Array(8);
    self.crypto.getRandomValues(random);
    return Array.from(random).join("");
}

// A connection that survived this long is treated as healthy, so that quitting
// neovim after a real editing session does not eat into the crash-loop budget.
const NATIVE_STABLE_MS = 60000;
const NATIVE_MAX_RETRIES = 5;

let nativeConnected = false;
let nativeConnectedAt = 0;
let nativeRetries = 0;
const nvimServer = {};

function setNvimServerInstance(instance) {
    nvimServer.instance = instance;
    // connectNative may never be called, keep the rejection from going unhandled.
    instance.catch(() => {});
}

function startNative() {
    return new Promise((resolve, reject) => {
        const nm = chrome.runtime.connectNative("surfingkeys");
        const password = generatePassword();
        nm.onDisconnect.addListener(() => {
            // read lastError to suppress "Unchecked runtime.lastError"
            void chrome.runtime.lastError;
            if (!nativeConnected) {
                delete nvimServer.instance;
                LOG("warn", "Failed to connect neovim, please make sure your neovim version 0.5 or above.");
            } else {
                if (Date.now() - nativeConnectedAt > NATIVE_STABLE_MS) {
                    nativeRetries = 0;
                }
                if (nativeRetries < NATIVE_MAX_RETRIES) {
                    nativeRetries += 1;
                    // The timer is lost when the service worker is recycled, which is
                    // fine: waking it up runs this module again and starts over.
                    setTimeout(() => {
                        setNvimServerInstance(startNative());
                    }, Math.min(1000 * Math.pow(2, nativeRetries - 1), 30000));
                } else {
                    delete nvimServer.instance;
                    LOG("warn", `Neovim disconnected ${nativeRetries} times in a row, stopped reconnecting.`);
                }
            }
            reject(new Error("Neovim native messaging host disconnected."));
        });
        nm.onMessage.addListener((resp) => {
            if (resp.status === true) {
                nativeConnected = true;
                if (resp.res.event === "serverStarted") {
                    nativeConnectedAt = Date.now();
                    const url = `127.0.0.1:${resp.res.port}/${password}`;
                    resolve({url, nm});
                }
            } else if (resp.err) {
                LOG("error", resp.err);
                reject(new Error(String(resp.err)));
            }
        });
        nm.postMessage({
            startServer: true,
            password
        });
    });
}
setNvimServerInstance(startNative());

start({
    name: "Chrome",
    detectTabTitleChange: true,
    getLatestHistoryItem,
    loadRawSettings,
    nvimServer,
    _applyProxySettings,
    _setNewTabUrl
});
