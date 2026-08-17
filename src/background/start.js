import {
    filterByTitleOrUrl,
} from '../common/utils.js';
import llmClients from './llm.js';

function request(url, onReady, headers, data, onException) {
    headers = headers || {};
    const CHARTSET_RE = /(?:charset|encoding)\s*=\s*['"]? *([\w\-]+)/i;

    fetch(url, {
        method: (data !== undefined) ? "POST" : "GET",
        headers,
        body: data,
    }).then(res => {
        const cs = res.headers.get('content-type') ? res.headers.get('content-type').match(CHARTSET_RE) : [];

        return Promise.all([
            Promise.resolve(cs && cs.length > 1 ? cs[1] : "utf-8"),
            res.arrayBuffer()
        ])
    }).then(res => {
        const decoder = new TextDecoder(res[0]);
        const content = decoder.decode(res[1]);
        onReady(content);
    }).catch(exp => {
        onException && onException(exp);
    });
}

function getSubSettings(set, keys) {
    var subset;
    if (!keys) {
        // if null/undefined/""
        subset = set;
    } else {
        if ( !(keys instanceof Array) ) {
            keys = [ keys ];
        }
        subset = {};
        keys.forEach(function(k) {
            subset[k] = set[k];
        });
    }
    return subset;
}

function _save(storage, data, cb) {
    if (storage === chrome.storage.sync) {
        // don't store snippets from localPath into sync storage, since sync storage has its quota.
        if (data.localPath) {
            delete data.snippets;
            delete data.localPath;
        }
        if (Object.keys(data).length > 1) {
            storage.set(data, cb);
        }
    } else {
        if (data.localPath) {
            delete data.snippets;
            // try to fetch snippets from localPath and cache it in local storage.
            request(data.localPath, function(resp) {
                data.snippets = resp;
                storage.set(data, cb);
            });
        } else {
            storage.set(data, cb);
        }
    }
}

function loadRawSettingsFromStorage(keys, cb, defaultSet, options) {
    var useSync = options && options.useSync;
    var dropLocalPath = options && options.dropLocalPath;
    var rawSet = defaultSet || {};
    var serve = function() {
        var subset = getSubSettings(rawSet, keys);
        if (chrome.runtime.lastError) {
            subset.error = "Settings sync may not work thoroughly because of: " + chrome.runtime.lastError.message;
        }
        cb(subset);
    };
    chrome.storage.local.get(null, function(localSet) {
        if (!useSync) {
            Object.assign(rawSet, localSet);
            serve();
            return;
        }
        var localSavedAt = localSet.savedAt || 0;
        chrome.storage.sync.get(null, function(syncSet) {
            var syncSavedAt = syncSet.savedAt || 0;
            if (localSavedAt > syncSavedAt) {
                Object.assign(rawSet, localSet);
                _save(chrome.storage.sync, localSet, serve);
            } else if (localSavedAt < syncSavedAt) {
                if (dropLocalPath) {
                    // don't sync local path
                    delete syncSet.localPath;
                }
                Object.assign(rawSet, syncSet);
                serve();
                _save(chrome.storage.local, syncSet);
            } else {
                Object.assign(rawSet, localSet);
                serve();
            }
        });
    });
}

function start(browser) {
    var self = {};

    const isMV3 = chrome.runtime.getManifest().manifest_version === 3;

    var tabHistory = [],
        tabHistoryIndex = 0,
        chromelikeNewTabPosition = 0,
        historyTabAction = false;

    // data by tab id
    var tabActivated = {},
        tabMessages = {},
        tabURLs = {},
        tabIcons = {};

    var newTabUrl = browser._setNewTabUrl();

    var conf = {
        llm: { },
        focusAfterClosed: "right",
        tabsMRUOrder: true,
        newTabPosition: 'default',
        showTabIndices: false
    };

    var bookmarkFolders = [];
    function getFolders(tree, root) {
        var cd = root;
        if (tree.title !== "" && (!tree.hasOwnProperty('url') || tree.url === undefined)) {
            cd += "/" + tree.title;
            bookmarkFolders.push({id: tree.id, title: cd + "/"});
        }
        if (tree.hasOwnProperty('children')) {
            for (var i = 0; i < tree.children.length; ++i) {
                getFolders(tree.children[i], cd);
            }
        }
    }

    function createBookmark(page, onCreated) {
        if (page.path.length) {
            chrome.bookmarks.create({
                'parentId': page.folder,
                'title': page.path.shift()
            }, function(newFolder) {
                page.folder = newFolder.id;
                createBookmark(page, onCreated);
            });
        } else {
            chrome.bookmarks.create({
                'parentId': page.folder,
                'title': page.title,
                'url': page.url
            }, function(ret) {
                onCreated(ret);
            });
        }
    }

    // in-memory settings cache, saves reading the whole storage(local + sync)
    // on every message from content scripts; our own writes are patched back in,
    // only foreign changes(another device, settings reset) drop it.
    var _cachedSet = null;
    // callers arriving while a load is in flight, all served from that single
    // load instead of each reading the whole storage again
    var _pendingLoads = null;
    chrome.storage.onChanged.addListener(function(changes, areaName) {
        if (!_cachedSet) {
            return;
        }
        if (areaName === "local") {
            for (var k in changes) {
                if (!("newValue" in changes[k])) {
                    // a key was removed(settings reset), reload from scratch
                    _cachedSet = null;
                    return;
                }
            }
            for (var k in changes) {
                _cachedSet[k] = changes[k].newValue;
            }
        } else if (!(changes.savedAt && changes.savedAt.newValue === _cachedSet.savedAt)) {
            // a sync change that does not echo our own write(_save stamps both
            // areas with the same savedAt) comes from another device, drop the
            // cache so the next load reconciles by savedAt
            _cachedSet = null;
        }
    });
    function loadSettings(keys, cb) {
        // top-level fields are copied so that callers can decorate the result
        // without polluting the cache; nested objects stay shared with the cache,
        // callers persist their mutations, which patches them back into the cache.
        const serve = function(set) {
            if (keys) {
                cb(getSubSettings(set, keys));
            } else {
                cb(Object.assign({}, set));
            }
        };
        if (_cachedSet) {
            serve(_cachedSet);
            return;
        }
        if (_pendingLoads) {
            _pendingLoads.push(serve);
            return;
        }
        _pendingLoads = [serve];
        var tmpSet = {
            blocklist: {},
            marks: {},
            findHistory: [],
            cmdHistory: [],
            sessions: {},
            proxyMode: 'clear',
            autoproxy_hosts: [],
            proxy: []
        };

        browser.loadRawSettings(null, function(set) {
            if (typeof(set.proxy) === "string") {
                set.proxy = [set.proxy];
                set.autoproxy_hosts = [set.autoproxy_hosts];
            }
            const serveAll = function() {
                const pending = _pendingLoads;
                _pendingLoads = null;
                pending.forEach((serveOne) => serveOne(set));
            };
            const done = function() {
                _cachedSet = set;
                serveAll();
            };
            if (!set.localPath) {
                done();
            } else if (set.snippets) {
                // stale-while-revalidate: serve the persisted snippets right away,
                // refresh from localPath in background for the next page load;
                // keyed loads never paid this fetch before the cache existed,
                // keep it that way
                done();
                if (!keys) {
                    request(appendNonce(set.localPath), function(resp) {
                        if (resp !== set.snippets) {
                            // local only: _save strips localPath snippets from sync
                            // anyway(quota), and a content refresh is not a user
                            // edit, so savedAt stays untouched
                            chrome.storage.local.set({snippets: resp});
                            if (set.showAdvanced) {
                                registerUserScript(resp);
                            }
                        }
                    }, undefined, undefined, function() {
                        // keep serving the stale snippets on refresh failures
                        console.error("Failed to refresh snippets from " + set.localPath);
                    });
                }
            } else {
                request(appendNonce(set.localPath), function(resp) {
                    set.snippets = resp;
                    done();
                }, undefined, undefined, function () {
                    // failed to read snippets from localPath; not cached, so the
                    // next load retries the fetch
                    set.error = "Failed to read snippets from " + set.localPath;
                    serveAll();
                });
            }
        }, tmpSet);
    }

    if (browser._applyProxySettings) {
        loadSettings(null, browser._applyProxySettings);
    }

    function removeTab(tabId) {
        delete tabActivated[tabId];
        delete tabMessages[tabId];
        delete tabURLs[tabId];
        delete tabIcons[tabId];
        tabHistory = tabHistory.filter(function(e) {
            return e !== tabId;
        });
        if (_queueURLs.length) {
            chrome.tabs.create({
                active: false,
                url: _queueURLs.shift()
            });
        }

        _updateTabIndices();
    }
    chrome.tabs.onRemoved.addListener(removeTab);
    function _setScrollPos_bg(tabId) {
        if (tabMessages.hasOwnProperty(tabId)) {
            const message = tabMessages[tabId];
            sendTabMessage(tabId, 0, {
                subject: "setScrollPos",
                scrollLeft: message.scrollLeft,
                scrollTop: message.scrollTop
            });
            delete tabMessages[tabId];
        }
    }

    function sendTabMessage(tabId, frameId, message) {
        const opts = (frameId === -1) ? undefined : {frameId: frameId};
        // use catch to suppress Uncaught (in promise) Error on sending message to unsupported tabs like chrome://
        const p = chrome.tabs.sendMessage(tabId, message, opts);
        if (p) {
            p.catch((e) => {});
        }
    }
    var _lastActiveTabId = null;
    function _tabActivated(tabId) {
        if (_lastActiveTabId !== tabId) {
            if (_lastActiveTabId !== null) {
                sendTabMessage(_lastActiveTabId, 0, {
                    subject: 'tabDeactivated'
                });
            }
            sendTabMessage(tabId, 0, {
                subject: 'tabActivated'
            });
            _lastActiveTabId = tabId;
        }
    }
    chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
        if (changeInfo.status === "loading") {
            // the browser resets a tab-specific icon on navigation
            delete tabIcons[tabId];
        } else if (changeInfo.status === "complete") {
            if (tab.active) {
                _tabActivated(tabId);
            }
        }
        // url changes(SPA history navigation included) also trigger the event
        // listener check, as sites may replace the document without a title change
        if (browser.detectTabTitleChange && (changeInfo.title || changeInfo.url)) {
            sendTabMessage(tabId, 0, {
                subject: 'titleChanged',
                changeInfo
            });
        }
    });
    chrome.windows.onFocusChanged.addListener(function(w) {
        getActiveTab(function(tab) {
            _tabActivated(tab.id);
        });
    });

    ['onCreated', 'onMoved', 'onDetached', 'onAttached'].forEach(function(evt) {
        chrome.tabs[evt].addListener(function() {
            _updateTabIndices();
        });
    });
    chrome.tabs.onActivated.addListener(function(activeInfo) {
        if (!historyTabAction && activeInfo.tabId != tabHistory[tabHistory.length - 1]) {
            if (tabHistory.length > 10) {
                tabHistory.shift();
            }
            if (tabHistoryIndex != tabHistory.length - 1) {
                tabHistory.splice(tabHistoryIndex + 1, tabHistory.length - 1);
            }
            tabHistory.push(activeInfo.tabId);
            tabHistoryIndex = tabHistory.length - 1;
        }
        tabActivated[activeInfo.tabId] = new Date().getTime();
        _tabActivated(activeInfo.tabId);
        historyTabAction = false;
        chromelikeNewTabPosition = 0;

        _updateTabIndices();
    });

    function getActiveTab(cb) {
        chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            tabs.length > 0 && cb(tabs[0]);
        });
    }
    chrome.commands.onCommand.addListener(function(command) {
        switch (command) {
            case 'restartext':
                chrome.tabs.query({}, function(tabs) {
                    tabs.forEach(function(tab) {
                        chrome.tabs.reload(tab.id);
                    });
                    chrome.runtime.reload();
                });
                break;
            case 'previousTab':
            case 'nextTab':
                getActiveTab(function(tab) {
                    var index = (command === 'previousTab') ? tab.index - 1 : tab.index + 1;
                    chrome.tabs.query({ windowId: tab.windowId }, function(tabs) {
                        index = ((index % tabs.length) + tabs.length) % tabs.length;
                        chrome.tabs.update(tabs[index].id, { active: true });
                    });
                });
                break;
            case 'closeTab':
                getActiveTab(function(tab) {
                    chrome.tabs.remove(tab.id);
                });
                break;
            case 'proxyThis':
                getActiveTab(function(tab) {
                    var host = new URL(tab.url || tab.pendingUrl).host;
                    updateProxy({
                        host: host,
                        operation: "toggle"
                    }, function() {
                        chrome.tabs.reload(tab.id, {
                            bypassCache: true
                        });
                    });
                });
                break;
            default:
                break;
        }
    });

    function _response(message, sendResponse, result) {
        sendResponse(result);
    }
    function handleMessage(_message, _sender, _sendResponse) {
        if (self.hasOwnProperty(_message.action)) {
            var result = self[_message.action](_message, _sender, _sendResponse);
            if (_message.needResponse) {
                if (result) {
                    _sendResponse(result);
                    _message.needResponse = false;
                }
                // else an asynchronous response will be sent using sendResponse later.
                return _message.needResponse;
            }
        } else {
            console.log("[unexpected runtime message] " + JSON.stringify(_message));
        }
    }
    chrome.runtime.onMessage.addListener(handleMessage);
    if (isMV3) {
        chrome.runtime.onUserScriptMessage.addListener(handleMessage);
        chrome.runtime.onInstalled.addListener((e) => {
            chrome.userScripts.configureWorld({
                csp: 'script-src \'self\' \'unsafe-eval\'',
                messaging: true
            });
        });
    }

    function _updateSettings(diffSettings, afterSet) {
        diffSettings.savedAt = new Date().getTime();
        _save(chrome.storage.local, diffSettings, function() {
            _save(chrome.storage.sync, diffSettings, function() {
                // read lastError to suppress "Unchecked runtime.lastError"
                void chrome.runtime.lastError;
            });
            if (afterSet) {
                afterSet();
            }
        });
    }

    function _broadcastSettings(data) {
        chrome.tabs.query({}, function(tabs) {
            tabs.forEach(function(tab) {
                sendTabMessage(tab.id, -1, {
                    subject: 'settingsUpdated',
                    settings: data
                });
            });
        });
    }

    function _updateAndPostSettings(diffSettings, afterSet) {
        _broadcastSettings(diffSettings);
        _updateSettings(diffSettings, afterSet);
    }

    function _updateTabIndices() {
        if (conf.showTabIndices) {
            chrome.tabs.query({currentWindow: true}, function(tabs) {
                tabs.forEach(function(tab) {
                    sendTabMessage(tab.id, 0, {
                        subject: "tabIndexChange",
                        index: tab.index + 1
                    });
                });
            });
        }
    }

    function getSenderUrl(sender) {
        // use the tab's url if sender is a frame with blank url.
        return (sender.frameId !== 0 && sender.url === "about:blank") ? sender.tab.url : sender.url;
    }
    function _getState(set, url, blocklistPattern, lurkingPattern) {
        if (set.blocklist['.*']) {
            return "disabled";
        }
        if (url) {
            if (set.blocklist[url.origin]) {
                return "disabled";
            }
            if (blocklistPattern) {
                blocklistPattern = new RegExp(blocklistPattern.source, blocklistPattern.flags);
                if (blocklistPattern.test(url.href)) {
                    return "disabled";
                }
            }
            if (lurkingPattern) {
                lurkingPattern = new RegExp(lurkingPattern.source, lurkingPattern.flags);
                if (lurkingPattern.test(url.href)) {
                    return "lurking";
                }
            }
        }
        return "enabled";
    }
    self.toggleBlocklist = function(message, sender, sendResponse) {
        loadSettings('blocklist', function(data) {
            var origin = ".*";
            var senderOrigin = sender.origin || new URL(getSenderUrl(sender)).origin;
            if (chrome.runtime.getURL("/").toLowerCase().indexOf(senderOrigin.toLowerCase()) !== 0 && senderOrigin !== "null") {
                origin = senderOrigin;
            }
            if (data.blocklist.hasOwnProperty(origin)) {
                delete data.blocklist[origin];
            } else {
                data.blocklist[origin] = 1;
            }
            _updateAndPostSettings({blocklist: data.blocklist}, function() {
                sendResponse({
                    state: _getState(data, sender.tab ? new URL(getSenderUrl(sender)) : null, message.blocklistPattern, message.lurkingPattern),
                    blocklist: data.blocklist,
                    url: origin
                });
            });
        });
    };
    self.getState = function(message, sender, sendResponse) {
        loadSettings(['blocklist', 'noPdfViewer', 'proxyMode', 'proxy'], function(data) {
            if (sender.tab) {
                _response(message, sendResponse, {
                    noPdfViewer: data.noPdfViewer,
                    proxyMode: data.proxyMode,
                    proxy: data.proxy,
                    state: _getState(data, new URL(getSenderUrl(sender)), message.blocklistPattern, message.lurkingPattern)
                });
            }
        });
    };

    self.addVIMark = function(message, sender, sendResponse) {
        loadSettings('marks', function(data) {
            Object.assign(data.marks, message.mark);
            _updateAndPostSettings({marks: data.marks});
        });
    };
    self.jumpVIMark = function(message, sender, sendResponse) {
        loadSettings("marks", function(data) {
            var marks = data.marks;
            if (marks.hasOwnProperty(message.mark)) {
                var markInfo = marks[message.mark];
                chrome.tabs.query({}, function(tabs) {
                    tabs = tabs.filter(function(t) {
                        return t.url === markInfo.url;
                    });

                    if (tabs.length === 0) {
                        markInfo.tab = {
                            tabbed: true,
                            active: true
                        };
                        self.openLink(markInfo, sender, sendResponse);
                    } else {
                        if (markInfo.scrollLeft || markInfo.scrollTop) {
                            tabMessages[tabs[0].id] = {
                                scrollLeft: markInfo.scrollLeft,
                                scrollTop: markInfo.scrollTop
                            };
                        }
                        if (tabs[0].id === sender.tab.id) {
                            _setScrollPos_bg(tabs[0].id);
                        } else {
                            chrome.tabs.update(tabs[0].id, {
                                active: true
                            });
                        }
                    }
                });
            }
        });
    };

    function appendNonce(url) {
        if (/https?:\/\//.test(url)) {
            url = url.replace(/\?$/, "");
            let u = new URL(url);
            let con = u.search ? "&" : "?";
            url = `${url}${con}nonce=${new Date().getTime()}`;
        }
        return url;
    }

    function _loadSettingsFromUrl(url, cb) {
        request(appendNonce(url), function(resp) {
            _updateAndPostSettings({localPath: url, snippets: resp});
            registerUserScript(resp, () => {
                cb({status: "Succeeded", snippets: resp});
            });
        }, undefined, undefined, function (po) {
            cb({status: "Failed"});
        });
    };

    self.resetSettings = function(message, sender, sendResponse) {
        chrome.storage.local.clear();
        chrome.storage.sync.clear();
        loadSettings(null, function(data) {
            browser._applyProxySettings?.(data);
            _response(message, sendResponse, {
                settings: data
            });
            _broadcastSettings(data);
        });
    };
    self.loadSettingsFromUrl = function(message, sender, sendResponse) {
        _loadSettingsFromUrl(message.url, function(status) {
            _response(message, sendResponse, status);
        });
    };
    function _filterByTitleOrUrl(tabs, query) {
        tabs = tabs.filter(function(b) {
            return b.url;
        });
        return filterByTitleOrUrl(tabs, query, false);
    }
    self.getRecentlyClosed = function(message, sender, sendResponse) {
        chrome.sessions.getRecentlyClosed({}, function(sessions) {
            var tabs = [];
            for (var i = 0; i < sessions.length; i ++) {
                var s = sessions[i];
                if (s.hasOwnProperty('window')) {
                    tabs = tabs.concat(s.window.tabs);
                } else if (s.hasOwnProperty('tab')) {
                    tabs.push(s.tab);
                }
            }
            tabs = _filterByTitleOrUrl(tabs, message.query);
            _response(message, sendResponse, {
                urls: tabs
            });
        });
    };
    self.getTopSites = function(message, sender, sendResponse) {
        if (chrome.topSites) {
            chrome.topSites.get(function(urls) {
                urls = _filterByTitleOrUrl(urls, message.query);
                _response(message, sendResponse, {
                    urls: urls
                });
            });
        } else {
            _response(message, sendResponse, {
                urls: []
            });
        }
    };


    function _getHistory(text, maxResults, cb, sortByMostUsed) {
        browser.getLatestHistoryItem?.(text, maxResults, (items) => {
            if (sortByMostUsed) {
                items = items.sort(function(a, b) {
                    return b.visitCount - a.visitCount;
                });
            }
            cb(items);
        });
    }
    self.getAllURLs = function(message, sender, sendResponse) {
        chrome.bookmarks.search(message.query || {}, function(bmItems) {
            var urls = bmItems,
                requestCount = message.maxResults || 100;
            var maxResults = requestCount - urls.length;
            if (maxResults > 0) {
                _getHistory(message.query || "", maxResults,  function(historyItems) {
                    urls = urls.concat(historyItems);
                    _response(message, sendResponse, {
                        urls: urls
                    });
                }, true);
            } else {
                _response(message, sendResponse, {
                    urls: urls.slice(0, requestCount)
                });
            }
        });
    };
    self.getTabs = function(message, sender, sendResponse) {
        var tab = sender.tab;
        var queryInfo = message.queryInfo || {};
        chrome.tabs.query(queryInfo, function(tabs) {
            tabs = _filterByTitleOrUrl(tabs, message.filter);
            if (tabs.length > message.tabsThreshold && conf.tabsMRUOrder) {
                // only remove current tab when tabsMRUOrder is enabled.
                tabs = tabs.filter(function(b) {
                    return b.id !== tab.id;
                });
                tabs.sort(function(x, y) {
                    // Shift tabs without "last access" data to the end
                    var a = x.lastAccessed || tabActivated[x.id];
                    var b = y.lastAccessed || tabActivated[y.id];

                    if (!isFinite(a) && !isFinite(b)) {
                        return 0;
                    }

                    if (!isFinite(a)) {
                        return 1;
                    }

                    if (!isFinite(b)) {
                        return -1;
                    }

                    return b - a;
                });
            }
            _response(message, sendResponse, {
                tabs: tabs
            });
        });
    };
    self.createTabGroup = function(message, sender, sendResponse) {
        chrome.tabs.group({tabIds: [sender.tab.id], groupId: message.groupId}, function(groupId) {
            if (message.title || message.color) {
                chrome.tabGroups.update(groupId, {
                    title: message.title,
                    color: message.color
                });
            }
        });
    };
    self.ungroupTab = function(message, sender, sendResponse) {
        chrome.tabs.ungroup([sender.tab.id]);
    };
    self.collapseGroup = function(message, sender, sendResponse) {
        chrome.tabGroups.update(message.groupId, {collapsed: message.collapsed});
    };
    self.getTabGroups = function(message, sender, sendResponse) {
        chrome.tabGroups.query({}, function(groups) {
            let activeGroup = -1;
            // retrieve all tabs of each group
            chrome.tabs.query({}, function(tabs) {
                const tabsInGroup = {};
                tabs.forEach(function(tab) {
                    if (tab.groupId && tab.groupId !== (chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1)) {
                        if (!tabsInGroup[tab.groupId]) {
                            tabsInGroup[tab.groupId] = [];
                        }
                        if (tab.id === sender.tab.id) {
                            activeGroup = tab.groupId;
                        }
                        tabsInGroup[tab.groupId].push({
                            id: tab.id,
                            title: tab.title,
                            url: tab.url,
                            favIconUrl: tab.favIconUrl,
                            active: tab.active,
                            index: tab.index
                        });
                    }
                });

                groups = groups.filter((g) => !g.hermit);
                groups.forEach(function(group) {
                    group.tabs = tabsInGroup[group.id] || [];
                    group.active = group.id === activeGroup;
                });

                _response(message, sendResponse, {
                    groups: groups
                });
            });
        });
    };
    self.togglePinTab = function(message, sender, sendResponse) {
        getActiveTab(function(tab) {
            return chrome.tabs.update(tab.id, {
                pinned: !tab.pinned
            });
        });
    };
    self.closeTabByIds = function(message, sender, sendResponse) {
        chrome.tabs.remove(message.tabIds);
    };
    function focusTab(windowId, tabId) {
        chrome.windows.update(windowId, {
            focused: true
        }, function() {
            chrome.tabs.update(tabId, {
                active: true
            });
        });
    }
    self.focusTab = function(message, sender, sendResponse) {
        if (message.windowId !== undefined && sender.tab.windowId !== message.windowId) {
            focusTab(message.windowId, message.tabId);
        } else {
            chrome.tabs.update(message.tabId, {
                active: true
            });
        }
    };
    // Fire-and-forget tab actions return {} so that handleMessage answers a
    // needResponse sender immediately, instead of returning true and leaving
    // the channel hanging until the service worker is recycled.
    self.focusTabByIndex = function(message, sender, sendResponse) {
        var queryInfo = message.queryInfo || {currentWindow: true};
        chrome.tabs.query(queryInfo, function(tabs) {
            if (message.repeats > 0 && message.repeats <= tabs.length) {
                chrome.tabs.update(tabs[message.repeats - 1].id, {
                    active: true
                });
            }
        });
        return {};
    };
    self.goToLastTab = function(message, sender, sendResponse) {
        if (tabHistory.length > 1) {
            var lastTab = tabHistory[tabHistory.length - 2];
            chrome.tabs.update(lastTab, {
                active: true
            });
        }
    };
    self.historyTab = function(message, sender, sendResponse) {
        if (tabHistory.length > 0) {
            historyTabAction = true;
            if (message.hasOwnProperty("index")) {
                tabHistoryIndex = (parseInt(message.index) + tabHistory.length) % tabHistory.length;
            } else {
                tabHistoryIndex += message.backward ? -1 : 1;
                if (tabHistoryIndex < 0) {
                    tabHistoryIndex = 0;
                } else if (tabHistoryIndex >= tabHistory.length) {
                    tabHistoryIndex = tabHistory.length - 1;
                }
            }
            const tabId = tabHistory[tabHistoryIndex];
            chrome.tabs.update(tabId, {
                active: true
            });
        }
    };
    // limit to between 0 and length
    function _fixTo(to, length) {
        if (to < 0) {
            to = 0;
        } else if (to >= length){
            to = length;
        }
        return to;
    }
    // round base ahead if repeats reaches length
    function _roundBase(base, repeats, length) {
        if (repeats > length - base) {
            base -= repeats - (length - base);
        }
        return base;
    }
    function _nextTab(tab, step) {
        if (tab) {
            chrome.tabs.query({
                windowId: tab.windowId
            }, function(tabs) {
                if (tab.index == 0 && step == -1) {
                    step = tabs.length -1 ;
                } else if (tab.index == tabs.length -1 && step == 1 ) {
                    step = 1 - tabs.length ;
                }
                var to = _fixTo(tab.index + step, tabs.length - 1);
                chrome.tabs.update(tabs[to].id, {
                    active: true
                });
            });
        } else {
            getActiveTab(function(t) {
                _nextTab(t, step);
            });
        }
    }
    self.nextTab = function(message, sender, sendResponse) {
        _nextTab(sender.tab, message.repeats);
        return {};
    };
    self.previousTab = function(message, sender, sendResponse) {
        _nextTab(sender.tab, -message.repeats);
        return {};
    };
    function _roundRepeatTabs(tab, repeats, operation) {
        if (tab) {
            chrome.tabs.query({
                windowId: tab.windowId
            }, function(tabs) {
                var tabIds = tabs.map(function(e) {
                    return e.id;
                });
                repeats = _fixTo(repeats, tabs.length);
                var base = _roundBase(tab.index, repeats, tabs.length);
                operation(tabIds.slice(base, base + repeats));
            });
        } else {
            getActiveTab(function(t) {
                _roundRepeatTabs(t, repeats, operation);
            });
        }
    }
    self.reloadTab = function(message, sender, sendResponse) {
        _roundRepeatTabs(sender.tab, message.repeats, function(tabIds) {
            tabIds.forEach(function(tabId) {
                chrome.tabs.reload(tabId, {
                    bypassCache: message.nocache
                });
            });
        });
        return {};
    };
    self.closeTab = function(message, sender, sendResponse) {
        _roundRepeatTabs(sender.tab, message.repeats, function(tabIds) {
            chrome.tabs.remove(tabIds, function() {
                if ( conf.focusAfterClosed === "left" ) {
                    _nextTab(sender.tab, -1);
                } else if ( conf.focusAfterClosed === "last" ) {
                    self.historyTab({backward: true});
                }
            });
        });
        return {};
    };

    function _closeTab(s, n) {
        chrome.tabs.query({currentWindow: true}, function(tabs) {
            tabs = tabs.map(function(e) { return e.id; });
            chrome.tabs.remove(tabs.slice(s.tab.index + (n < 0 ? n : 1),
                                          s.tab.index + (n < 0 ? 0 : 1 + n)));
        });
    };

    self.closeTabLeft  = function(message, sender, senderResponse) { _closeTab(sender, -message.repeats); return {}; };
    self.closeTabRight = function(message, sender, senderResponse) { _closeTab(sender, message.repeats); return {}; };
    self.closeTabsToLeft = function(message, sender, senderResponse) { _closeTab(sender, -sender.tab.index); };
    self.closeTabsToRight = function(message, sender, senderResponse) {
        chrome.tabs.query({currentWindow: true},
                          function(tabs) { _closeTab(sender, tabs.length - sender.tab.index); });
    };
    self.tabOnly = function(message, sender, sendResponse) {
        chrome.tabs.query({currentWindow: true}, function(tabs) {
            tabs = tabs.filter(function(t) {
                return t.id != sender.tab.id && !t.pinned;
            }).map(function(t) { return t.id });
            chrome.tabs.remove(tabs);
        });
    };

    self.closeAudibleTab = function(message, sender, sendResponse) {
        chrome.tabs.query({audible: true}, function(tabs) {
            if (tabs) {
                chrome.tabs.remove(tabs[0].id)
            }
        });
    };
    self.muteTab = function(message, sender, sendResponse) {
        var tab = sender.tab;
        chrome.tabs.update(tab.id, {
            muted: ! tab.mutedInfo.muted
        });
    };
    self.openLast = function(message, sender, sendResponse) {
        if (browser.restoreLastTab) {
            browser.restoreLastTab(function(response) {
                _response(message, sendResponse, response);
            });
        } else {
            chrome.sessions.restore();
        }
    };
    self.duplicateTab = function(message, sender, sendResponse) {
        chrome.tabs.duplicate(sender.tab.id, function() {
            if (message.active === false) {
                chrome.tabs.update(sender.tab.id, { active: true });
            }
        });
    };
    let previousWindowChoice = -1;
    self.getWindows = function (message, sender, sendResponse) {
        chrome.tabs.query({currentWindow: false}, function(tabs) {
            const windows = {};
            tabs.forEach(t => {
                const tabsInWindow = windows[t.windowId] || [];
                tabsInWindow.push({title: t.title, url: t.url});
                windows[t.windowId] = tabsInWindow;
            });
            _response(message, sendResponse, {
                windows: Object.keys(windows).map(w => {
                    return {
                        id: w,
                        tabs: windows[w],
                        isPreviousChoice: (parseInt(w) === previousWindowChoice)
                    };
                })
            });
        });
    };
    self.moveToWindow = function(message, sender, sendResponse) {
        if (message.windowId === -1) {
            chrome.windows.create({tabId: sender.tab.id});
        } else {
            chrome.tabs.move(sender.tab.id, {windowId: message.windowId, index: -1}, () => {
                focusTab(message.windowId, sender.tab.id);
            });
        }
        previousWindowChoice = message.windowId;
    };
    self.gatherWindows = function(message, sender, sendResponse) {
        const windowId = sender.tab.windowId;
        chrome.tabs.query({currentWindow: false}, function(tabs) {
            tabs.forEach(function(tab) {
                chrome.tabs.move(tab.id, {windowId, index: -1});
            });
        });
    };
    self.gatherTabs = function(message, sender, sendResponse) {
        const windowId = sender.tab.windowId;
        message.tabs.forEach(function(tab) {
            chrome.tabs.move(tab.id, {windowId, index: -1});
        });
    };
    self.getBookmarkFolders = function(message, sender, sendResponse) {
        chrome.bookmarks.getTree(function(tree) {
            bookmarkFolders = [];
            getFolders(tree[0], "");
            _response(message, sendResponse, {
                folders: bookmarkFolders
            });
        });
    };
    self.createBookmark = function(message, sender, sendResponse) {
        removeBookmark(message.page.url, function() {
            createBookmark(message.page, function(ret) {
                _response(message, sendResponse, {
                    bookmark: ret
                });
            });
        });
    };
    function filterBookmarksByQuery(bookmarks, query, caseSensitive) {
        return bookmarks.filter(function(b) {
            var title = b.title, url = b.url;
            if (!caseSensitive) {
                title = title.toLowerCase();
                url = url && url.toLowerCase();
                query = query.toLowerCase();
            }
            return title.indexOf(query) !== -1 || (url && url.indexOf(query) !== -1);
        });
    }
    self.getBookmarks = function(message, sender, sendResponse) {
        if (message.parentId) {
            chrome.bookmarks.getSubTree(message.parentId, function(tree) {
                var bookmarks = tree[0].children;
                if (message.query && message.query.length) {
                    bookmarks = filterBookmarksByQuery(bookmarks, message.query, message.caseSensitive);
                }
                _response(message, sendResponse, {
                    bookmarks: bookmarks
                });
            });
        } else {
            if (message.query && message.query.length) {
                chrome.bookmarks.search(message.query, function(tree) {
                    _response(message, sendResponse, {
                        bookmarks: filterBookmarksByQuery(tree, message.query, message.caseSensitive)
                    });
                });
            } else {
                chrome.bookmarks.getTree(function(tree) {
                    _response(message, sendResponse, {
                        bookmarks: tree[0].children
                    });
                });
            }
        }
    };
    self.getHistory = function(message, sender, sendResponse) {
        _getHistory(message.query || "", message.maxResults || 100, function(tree) {
            _response(message, sendResponse, {
                history: tree
            });
        }, message.sortByMostUsed);
    };
    self.addHistories = function(message, sender, sendResponse) {
        message.history.forEach(h => {
            chrome.history.addUrl({url: h});
        });
    };
    function normalizeURL(url) {
        if (!/^view-source:|^javascript:/.test(url) && /^(?:https?:\/\/)?(?:[^@\/\n]+@)?(?:www\.)?([^:\/\n]+)/im.test(url)) {
            if (/^[\w-]+?:/i.test(url)) {
                url = url;
            } else {
                url = "http://" + url;
            }
        }
        return url;
    }

    function openUrlInNewTab(currentTab, url, message) {
        var newTabPosition;
        if (currentTab) {
            switch (conf.newTabPosition) {
                case 'left':
                    newTabPosition = currentTab.index;
                    break;
                case 'right':
                    newTabPosition = currentTab.index + 1;
                    break;
                case 'first':
                    newTabPosition = 0;
                    break;
                case 'last':
                    break;
                default:
                    newTabPosition = currentTab.index + 1 + chromelikeNewTabPosition;
                    chromelikeNewTabPosition++;
                    break;
            }
        }
        var createProperties = {
            url: url,
            active: message.tab.active,
            index: newTabPosition,
            pinned: message.tab.pinned,
            openerTabId: currentTab.id
        };
        if (message.tab.cookieStoreId) {
            createProperties.cookieStoreId = message.tab.cookieStoreId;
        }
        chrome.tabs.create(createProperties, function(tab) {
            if (message.scrollLeft || message.scrollTop) {
                tabMessages[tab.id] = {
                    scrollLeft: message.scrollLeft,
                    scrollTop: message.scrollTop
                };
            }
        });
    }

    self.openLink = function(message, sender, sendResponse) {
        var url = normalizeURL(message.url);
        if (url.startsWith("javascript:")) {
            sendTabMessage(sender.tab.id, 0, {
                subject: "showBanner",
                message: "JavaScript URLs are not allowed in such operation."
            });
        } else {
            if (message.tab.cookieStoreId) {
                if (browser.name !== "Firefox") {
                    delete message.tab.cookieStoreId;
                } else if (sender.tab && sender.tab.cookieStoreId === message.tab.cookieStoreId) {
                    delete message.tab.cookieStoreId;
                }
            }
            if (message.tab.cookieStoreId) {
                openUrlInNewTab(sender.tab, url, message);
            } else if (message.tab.tabbed) {
                if (sender.frameId !== 0 && chrome.runtime.getURL("pages/frontend.html") === sender.url
                    || !sender.tab) {
                    // if current call was made from Omnibar, the sender.tab may be stale,
                    // as sender was bound when port was created.
                    getActiveTab(function(tab) {
                        openUrlInNewTab(tab, url, message);
                    });
                } else {
                    openUrlInNewTab(sender.tab, url, message);
                }
            } else {
                chrome.tabs.update({
                    url: url,
                    pinned: message.tab.pinned || sender.tab.pinned
                }, function(tab) {
                    if (message.scrollLeft || message.scrollTop) {
                        tabMessages[tab.id] = {
                            scrollLeft: message.scrollLeft,
                            scrollTop: message.scrollTop
                        };
                    }
                });
            }
        }
    };
    self.viewSource = function(message, sender, sendResponse) {
        message.url = 'view-source:' + sender.tab.url;
        self.openLink(message, sender, sendResponse);
    };
    // the \n keeps a trailing line comment in the user's snippets from eating
    // the closing braces; the api.js specifier differs between the registered
    // script('./api.js', kept byte-identical with persisted registrations) and
    // dynamic execution(absolute URL)
    function buildSnippetsCode(snippets, apiSpecifier, runNow) {
        return `import('${apiSpecifier}').then((module) => {module.default("${chrome.runtime.getURL("/")}", (api, settings) => {${snippets}\n}${runNow ? ", true" : ""})});`;
    }
    // last snippets known registered(null = known unregistered), saves a
    // userScripts.getScripts round trip + full code compare on every frame's
    // getSettings; undefined = unknown, forces a real check on the next call
    var _registeredSnippets;
    function registerUserScript(snippets, callback) {
        snippets = snippets || null;
        if (!isUserScriptsAvailable() || snippets === _registeredSnippets) {
            callback && callback();
            return;
        }
        const userScriptId = "settingsSnippets";
        const invokeCallback = () => {
            if (chrome.runtime.lastError) {
                console.error("userScripts API error:", chrome.runtime.lastError);
                _registeredSnippets = undefined;
            } else {
                _registeredSnippets = snippets;
            }
            callback && callback();
        };
        if (snippets) {
            chrome.userScripts.getScripts({ids:[userScriptId]}, (r) => {
                if (chrome.runtime.lastError) {
                    console.error("userScripts.getScripts error:", chrome.runtime.lastError);
                    callback && callback();
                    return;
                }
                const code = buildSnippetsCode(snippets, './api.js');
                // document_start so that user mappings become usable along with built-in
                // ones, instead of waiting for document_idle(after page load).
                const runAt = "document_start";
                const registerSettingSnippets = () => {
                    chrome.userScripts.register([{
                        allFrames: true,
                        id: userScriptId,
                        matches: ['*://*/*', 'file:///*'],
                        runAt,
                        js: [{code}]
                    }], invokeCallback);
                };
                if (r.length > 0) {
                    // also re-register scripts persisted before runAt was introduced
                    if (r[0].js[0].code !== code || r[0].runAt !== runAt) {
                        chrome.userScripts.unregister({ids:[userScriptId]}, registerSettingSnippets);
                    } else {
                        _registeredSnippets = snippets;
                        callback && callback();
                    }
                } else {
                    registerSettingSnippets();
                }
            });
        } else {
            chrome.userScripts.getScripts({ids:[userScriptId]}, (r) => {
                if (chrome.runtime.lastError) {
                    console.error("userScripts.getScripts error:", chrome.runtime.lastError);
                    callback && callback();
                    return;
                }
                if (r.length > 0) {
                    chrome.userScripts.unregister({ids:[userScriptId]}, invokeCallback);
                } else {
                    _registeredSnippets = null;
                    callback && callback();
                }
            });
        }
    }

    function injectSnippetsIntoTab(tabId, snippets, frameIds) {
        // scripting.executeScript rejects world USER_SCRIPT; userScripts.execute
        // (Chrome 135+) is the API for dynamic injection into that world
        if (!isUserScriptsAvailable() || !chrome.userScripts.execute) {
            return;
        }
        // runNow: by injection time the frame's content world is already
        // initialized, so its one-shot runUserScript dispatch won't come again
        const code = buildSnippetsCode(snippets, chrome.runtime.getURL("/") + 'api.js', true);
        // fails for tabs we cannot access(chrome://, web store, uncommitted navigations)
        chrome.userScripts.execute({
            target: frameIds ? { tabId: tabId, frameIds: frameIds } : { tabId: tabId },
            js: [{code}]
        }).catch(() => {});
    }

    // session-restored tabs whose navigation committed before Chrome finished
    // restoring the persisted userScripts registration miss the document_start
    // injection on browser startup; replay the snippets into them once.
    chrome.runtime.onStartup.addListener(function() {
        if (!isUserScriptsAvailable()) {
            return;
        }
        loadSettings(['snippets', 'showAdvanced'], function(set) {
            if (!set.showAdvanced || !set.snippets) {
                return;
            }
            chrome.tabs.query({url: ["http://*/*", "https://*/*", "file:///*"], discarded: false}, function(tabs) {
                tabs.forEach(function(tab) {
                    injectSnippetsIntoTab(tab.id, set.snippets);
                });
            });
        });
    });

    function onFullSettingsRequested(data, callback) {
        data.isMV3 = isMV3;
        data.isUserScriptsAvailable = isUserScriptsAvailable();
        if (isMV3) {
            data.showAdvanced = data.isUserScriptsAvailable && data.showAdvanced;
        }

        if (data.isUserScriptsAvailable && data.showAdvanced) {
            registerUserScript(data.snippets, callback);
        } else if (data.isUserScriptsAvailable) {
            registerUserScript(null, callback);
        } else {
            callback && callback();
        }
    }
    self.getSettings = function(message, sender, sendResponse) {
        var pf = loadSettings;
        if (message.key === "RAW") {
            pf = browser.loadRawSettings;
            message.key = "";
        }
        pf(message.key, function(data) {
            if (message.key === undefined) {
                onFullSettingsRequested(data);
                if (isMV3 && data.showAdvanced && data.snippets && sender.url) {
                    const extPages = ["/pages/pdf_viewer.html", "/pages/markdown.html"];
                    if (extPages.some(p => sender.url.startsWith(chrome.runtime.getURL(p)))) {
                        injectSnippetsIntoTab(sender.tab.id, data.snippets);
                    } else if (sender.tab && sender.frameId !== undefined && /^about:/.test(sender.url)) {
                        // about:srcdoc/about:blank frames run content scripts
                        // (match_about_blank) but the registered user script can't
                        // match about: URLs(the userScripts API has no
                        // matchOriginAsFallback) — inject into that frame directly
                        injectSnippetsIntoTab(sender.tab.id, data.snippets, [sender.frameId]);
                    }
                }
                if (isMV3 && sender.url && !sender.url.startsWith(chrome.runtime.getURL("/"))) {
                    // on MV3 web frames never evaluate snippets in the content
                    // world(the userScripts API runs them), don't ship the whole
                    // config to every frame of every page; extension pages
                    // (options editor) still need it
                    delete data.snippets;
                }
            }

            _response(message, sendResponse, {
                settings: data
            });
        });
    };
    function isUserScriptsAvailable() {
        try {
            if (chrome.userScripts) {
                return true;
            }
        } catch {
            return false;
        }
        return false;
    }
    self.updateSettings = function(message, sender, sendResponse) {
        let error = "";
        if (message.scope === "snippets") {
            // For settings from snippets, don't broadcast the update
            // neither persist into storage
            for (var k in message.settings) {
                if (conf.hasOwnProperty(k)) {
                    conf[k] = message.settings[k];
                }
            }
            const llmConf = conf.llm;
            if (llmConf.ollama && llmConf.ollama.model) {
                llmClients.ollama.model = llmConf.ollama.model;
            }
            if (llmConf.bedrock
                && llmConf.bedrock.accessKeyId
                && llmConf.bedrock.secretAccessKey
                && llmConf.bedrock.model) {
                llmClients.bedrock.init(llmConf.bedrock);
                delete message.settings.llm.bedrock;
            }
            if (llmConf.custom) {
                const reservedNames = ['bedrock', 'ollama', 'custom'];
                for (const name in llmConf.custom) {
                    if (llmConf.custom.hasOwnProperty(name) && llmConf.custom[name].serviceUrl) {
                        if (reservedNames.indexOf(name) !== -1) {
                            console.warn(`[Surfingkeys] "${name}" is a built-in LLM provider, skipped as a custom provider.`);
                            continue;
                        }
                        llmClients.custom.register(name, llmConf.custom[name]);
                        llmClients[name] = llmClients.custom;
                    }
                }
                delete message.settings.llm.custom;
            }
            return { error };
        } else {
            if (message.settings.showAdvanced && isMV3) {
                if (isUserScriptsAvailable()) {
                    chrome.userScripts.configureWorld({
                        csp: 'script-src \'self\' \'unsafe-eval\'',
                        messaging: true
                    });
                    _updateAndPostSettings(message.settings);
                    registerUserScript(message.settings.snippets, () => {
                        _response(message, sendResponse, { error });
                    });
                    return;
                } else {
                    error = "Advanced mode is only available when Developer mode is turned on from chrome://extensions/.";
                }
            } else {
                _updateAndPostSettings(message.settings);
            }
        }
        return { error };
    };
    self.updateInputHistory = function(message, sender, sendResponse) {
        let key = undefined, value;
        for (var k in message) {
            key = k + "History";
            value = message[k];
            break;
        }
        if (key) {
            loadSettings(key, function(data) {
                let curr = data[key] || [];
                let toUpdate = {};
                if (value.constructor.name === "Array") {
                    toUpdate[key] = value;
                    _updateAndPostSettings(toUpdate);
                } else if (value.trim().length && value !== ".") {
                    curr = curr.filter(function(c) {
                        return c.trim().length && c !== value && c !== ".";
                    });
                    curr.unshift(value);
                    if (curr.length > 50) {
                        curr.pop();
                    }
                    toUpdate[key] = curr;
                    _updateAndPostSettings(toUpdate);
                }
                _response(message, sendResponse, {
                    history: curr
                });
            });
        }
    };
    const _iconsByStatus = {
        enabled: "icons/48.png",
        disabled: "icons/48-x.png",
        lurking: "icons/48-l.png",
    };
    // embedded copies of src/icons/48*.png so the MV3 service worker never
    // fetches them (setIcon({path}) would re-fetch on every call); the toolbar
    // icon tests verify these stay in sync with the files
    const _iconBase64 = {
        "icons/48.png": "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",
        "icons/48-x.png": "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAQAAAD9CzEMAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH5QwLCy4bFZtlsAAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmUHAAAGWElEQVRYw+2XfXBVxRnGf7vnfiQR8gGSBqQZUi2gpnxkAJtIwk2EAP3Aqp0ikBaalnYYaqfjANZ+YMfRMjjD0FhLUaAlJgQi1YKtiKESUzGQIFCLQwarBAyd1FYMXJLc5Jw9u/3jnpvexBsI+ldn2DOzc3bn7PO8z7vvu/seuN7+j1pD3HvzkFeJayP5y9hISnL37PPR0esUfjqC1wgBLySRIYqZJ0LyswKJhYR2We/bR528VGTDYfI/CcFzfAN47l5RJkMiQyIRWEgEEoFAIi/LP4mqmfuvRHFFBX/Idaqs24VfEnssBAILvLFARnhDLMn/91GmJ8SQiSYrgV2Bmgd6TzLF+EUCm4SnQyKT5WxxuqlwOtA4NAXbWUZ1kt4kvm0h456ogzxYT010bDDoVQUbhuyiHUl2nSyMQlhxkBIL2StPi3YL4bdGimyREQUwaJdHZj4eDYurEFT5nc2iPAbt9d3ygqwNNKUfSgt/NMyMCr83vyf6deMUppo8M9eMcNMoC9VeRcFWvsu277NZ9DnBQtqi0qr+TJfvTlFoJqhbVECtyq3INBC/sQ055gtmhtw468JVFPwuR53p55Q33XvGjJAVvjxfqoWLCuuSwmNwiJl9axop8BzV4A85V4ki+1mDBkz02Tlu5qgV+i0RkqkSMP8SEwuPHYI4eDx4EPzGGYjn6z/ccpeaBgKNxMDacRUd+6ySaKyAaTFfLmhv7AP8XzPcLynWH+x++4p5UGuZ+0iK2g5UpG/oaKYkmregu1mY3xoPXxznaTNM1ciNHw+ZOAU1XEw1RQAaiXs6e013vZwQC0MDZdNPNjMjbnE9oXlskLfBDWHnoMh01Fd8f1ZzODDYJm+9Wb1rvGn/5JGF4ikfPnxYWFiPFjxyhC/2s+5B0fylwDzZGRQiR95NUKMPiOUvnRs0irZ8x91qogfBkxN+3HHGyvJh4UdgNSXN+frl9xMkpUEASwKRCfbrKk1hDlpfld37E++Bvi1qv4mon19YZbK8HMU4bDiW837Cw2xpNPftYIv7okJhl6h79rNzkDDN9GS9eFOPXi3o83/r+brIA4ngZ/Msz/vnTJyfHy7VGS4u2o48CosSh6lIERhw2GPfx/CY9zRiy7kpwfEJbzhKR/+6Rbjah98NarQ2b9t5s8Y3vJPYRV0GoEs38U3QGDQaQ/KOwFxZlPjOUIUqTadqv/K70sVtk8+7Jpw7SKKJDgOIcM6HF6dZ3jFsMGfvbF+fp3gq7wfHP05gZ+IG1vje7R1ljXZtX91ly/zCZw1G8A+BQRy5nE3QA0cjm+cHVaags5zj63gYgHwOx9bkOB8eiEuw0LgOM/zsIJksDxrAHHezTcB4DtI4/0mz7KDCXrR+1MPel4e5Y/b0hhntBW295frSgvS4QuFs0gv1R2clItiB+4E4D/K8/hxJxtsDgzEa1yhUemQFrAfgR0KV9hb1ZnWP5aR/7qWuvkwimaZFM0RDIoIliG5xAsQFRsfco3FRGScddclByd7Vj41/iErgV+aGtcm/NxjsO9442+DEImA5EaDZDOKi70XMPjCd7o0x6zUuOrfF0f9UKNSwi/U/S1kKFNPW01R+0+3+X1pPlg6Dvw5amQy4DwIv4WhIMR64i0ZNbkxxG5VxcFFjwk2rboFbaWUuL59686fHVtd1hq5Q+gwgKG+TtVaa8EO8htaFnQdVp4vCReV2NayctolicuMqwCETQMpqky4CBoPbp8H88Om/uy02Dg4uzpjI0fLHs0dEq5QV11abbmcZu9N6dpr5/aYjwdJDbk+j6Nt4F90mqvx7K70yew1PDEJg9R/uoYaRdtetFPWzwG+GP7Rx7+fdSbpPl0kzhWrhpKWTs6byt3OlUQdzYmiF16uB9gN6wNljFb3yFu/pG/HOp/4gspXmlLVb3xlSbVrLXfbwOeKZARfLrq8J/aBrFC6xWzvWa9yxsiERfEKChdRwt5280vctESdRj+naU10lt8WuVBHXW2eSJ1f/FsqGWl0vBk6pxVXJWfJV09OnIVT92I7l8pX+wkzYt7l44vaWE0D1tf0f7OJ+oHoWS0yJudmzZ2XZpsV73QUGsDBN4uWU3dtOwXK2fPJ/tD/6ulLlRL2AqUwiK2XdvT9ZXGGCviPiNT6qDAuWsf3T/l/u7DdaJ7jerrf49l9W/aYrKC46wQAAAABJRU5ErkJggg==",
        "icons/48-l.png": "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",
    };
    const _iconImageData = {};
    function _getIconImageData(path) {
        if (!_iconImageData[path]) {
            const bytes = Uint8Array.from(atob(_iconBase64[path]), (c) => c.charCodeAt(0));
            _iconImageData[path] = createImageBitmap(new Blob([bytes], {type: "image/png"}))
                .then((img) => {
                    const canvas = new OffscreenCanvas(img.width, img.height);
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    return ctx.getImageData(0, 0, img.width, img.height);
                });
        }
        return _iconImageData[path];
    }
    self.setSurfingkeysIcon = function(message, sender, sendResponse) {
        const path = _iconsByStatus[message.status] || _iconsByStatus.enabled;
        const tabId = sender.tab ? sender.tab.id : undefined;
        if (tabId !== undefined) {
            if (tabIcons[tabId] === path) {
                return;
            }
            tabIcons[tabId] = path;
        }
        if (isMV3) {
            _getIconImageData(path).then((imageData) => {
                chrome.action.setIcon({imageData, tabId});
            });
        } else {
            chrome.browserAction.setIcon({path, tabId});
        }
    };
    self.request = function(message, sender, sendResponse) {
        request(message.url, function(res) {
            _response(message, sendResponse, {
                text: res
            });
        }, message.headers, message.data, (e) => {
            _response(message, sendResponse, {
                error: e.toString()
            });
        });
    };
    self.requestImage = function(message, sender, sendResponse) {
        fetch(message.url, {
            method: "GET"
        }).then(res => {
            return res.blob()
        }).then(blob => {
            return createImageBitmap(blob)
        }).then(img => {
            const canvas = new OffscreenCanvas(img.width, img.height)
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0,0, canvas.width, canvas.height);
            canvas.convertToBlob().then(blob => {
                const fr = new FileReader();
                fr.onload = function(e) {
                    _response(message, sendResponse, {
                        text: e.target.result
                    });
                }
                fr.readAsDataURL(blob);
            });
        }).catch(exp => {
            _response(message, sendResponse, {
                text: ""
            });
        });
    };
    self.nextFrame = function(message, sender, sendResponse) {
        const tid = sender.tab.id;
        chrome.scripting.executeScript({
            target: {
                allFrames: true,
                tabId: tid,
            },
            func: () => {
                return typeof(getFrameId) === 'function' ? getFrameId() : 0;
            },
        }, function(framesInTab) {
            framesInTab = framesInTab.map((res) => {
                return res.result;
            }).filter((frameId) => {
                return frameId;
            });

            if (framesInTab.length > 0) {
                let i = 0;
                for (i = 0; i < framesInTab.length; i++) {
                    if (framesInTab[i] === message.frameId) {
                        break;
                    }
                }
                i = (i === framesInTab.length - 1) ? 0 : i + 1;
                sendTabMessage(tid, -1, {
                    subject: "focusFrame",
                    frameId: framesInTab[i]
                });
            }
        });
    };
    self.moveTab = function(message, sender, sendResponse) {
        chrome.tabs.query({
            windowId: sender.tab.windowId
        }, function(tabs) {
            var to = _fixTo(sender.tab.index + message.step * message.repeats, tabs.length);
            chrome.tabs.move(sender.tab.id, {
                index: to
            });
        });
        return {};
    };
    function _quit() {
        chrome.windows.getAll({
            populate: false
        }, function(windows) {
            windows.forEach(function(w) {
                chrome.windows.remove(w.id);
            });
        });
    }
    self.quit = function(message, sender, sendResponse) {
        _quit();
    };
    self.createSession = function(message, sender, sendResponse) {
        loadSettings('sessions', function(data) {
            chrome.tabs.query({}, function(tabs) {
                var tabGroup = {};
                tabs.forEach(function(tab) {
                    if (tab && tab.index !== void 0) {
                        if (!tabGroup.hasOwnProperty(tab.windowId)) {
                            tabGroup[tab.windowId] = [];
                        }
                        if (tab.url !== newTabUrl) {
                            tabGroup[tab.windowId].push(tab.url);
                        }
                    }
                });
                var tabg = [];
                for (var k in tabGroup) {
                    if (tabGroup[k].length) {
                        tabg.push(tabGroup[k]);
                    }
                }
                data.sessions[message.name] = {};
                data.sessions[message.name]['tabs'] = tabg;
                _updateAndPostSettings({
                    sessions: data.sessions
                }, (message.quitAfterSaved ? _quit : undefined));
            });
        });
    };
    self.openSession = function(message, sender, sendResponse) {
        loadSettings('sessions', function(data) {
            if (data.sessions.hasOwnProperty(message.name)) {
                var urls = data.sessions[message.name]['tabs'];
                urls[0].forEach(function(url) {
                    chrome.tabs.create({
                        url: url,
                        active: false,
                        pinned: false
                    });
                });
                for (var i = 1; i < urls.length; i++) {
                    var a = urls[i];
                    chrome.windows.create({}, function(win) {
                        a.forEach(function(url) {
                            chrome.tabs.create({
                                windowId: win.id,
                                url: url,
                                active: false,
                                pinned: false
                            });
                        });
                    });
                }
                chrome.tabs.query({
                    url: newTabUrl
                }, function(tabs) {
                    chrome.tabs.remove(tabs.map(function(t) {
                        return t.id;
                    }));
                });
            }
        });
    };
    self.deleteSession = function(message, sender, sendResponse) {
        loadSettings('sessions', function(data) {
            delete data.sessions[message.name];
            _updateAndPostSettings({
                sessions: data.sessions
            });
        });
    };
    self.closeDownloadsShelf = function(message, sender, sendResponse) {
        if (message.clearHistory) {
            chrome.downloads.erase({"urlRegex": ".*"});
        } else {
            chrome.downloads.setShelfEnabled(false);
            chrome.downloads.setShelfEnabled(true);
        }
    };
    self.getDownloads = function(message, sender, sendResponse) {
        chrome.downloads.search(message.query, function(items) {
            _response(message, sendResponse, {
                downloads: items
            });
        });
    };
    self.download = function(message, sender, sendResponse) {
        chrome.downloads.download({
            url: message.url,
            filename: message.filename,
            saveAs: message.saveAs
        });
    };
    self.tabURLAccessed = function(message, sender, sendResponse) {
        if (sender.tab) {
            var tabId = sender.tab.id;
            _setScrollPos_bg(tabId);
            if (!tabURLs.hasOwnProperty(tabId)) {
                tabURLs[tabId] = {};
            }
            tabURLs[tabId][message.url] = message.title;
            return {
                active: sender.tab.active,
                index: conf.showTabIndices ? sender.tab.index + 1 : 0
            };
        } else {
            return {};
        }
    };
    self.getTabURLs = function(message, sender, sendResponse) {
        var tabURL = tabURLs[sender.tab.id] || {};
        tabURL = Object.keys(tabURL).map(function(u) {
            return {
                url: u,
                title: tabURL[u]
            };
        });
        return {
            urls: tabURL
        };
    };
    self.getTopURL = function(message, sender, sendResponse) {
        return {
            url: sender.tab ? sender.tab.url : ""
        };
    };

    function updateProxy(message, cb) {
        loadSettings(['proxyMode', 'proxy', 'autoproxy_hosts'], function(proxyConf) {
            if (message.operation === "deleteProxyPair") {
                proxyConf.proxy.splice(message.number, 1);
                proxyConf.autoproxy_hosts.splice(message.number, 1);
            } else if (message.operation === "set") {
                proxyConf.proxyMode = message.mode;
                proxyConf.proxy = message.proxy;
                proxyConf.autoproxy_hosts = message.host;
            } else {
                if (message.mode) {
                    proxyConf.proxyMode = message.mode;
                }
                if (!message.number) {
                    message.number = 0;
                }
                if (message.proxy) {
                    proxyConf.proxy[message.number] = message.proxy;
                    if (proxyConf.autoproxy_hosts.length <= message.number) {
                        proxyConf.autoproxy_hosts[message.number] = [];
                    }
                }
                if (message.host) {
                    var hostsDict = Object.fromEntries(proxyConf.autoproxy_hosts[message.number].map((h) => [h, 1]));
                    var hosts = message.host.split(/\s*[ ,\n]\s*/);
                    if (message.operation === "toggle") {
                        hosts.forEach(function(host) {
                            if (hostsDict.hasOwnProperty(host)) {
                                delete hostsDict[host];
                            } else {
                                hostsDict[host] = 1;
                            }
                        });
                    } else if (message.operation === "add") {
                        hosts.forEach(function(host) {
                            hostsDict[host] = 1;
                        });
                    } else {
                        hosts.forEach(function(host) {
                            delete hostsDict[host];
                        });
                    }
                    proxyConf.autoproxy_hosts[message.number] = Object.keys(hostsDict);
                }
            }
            var diffSet = {
                autoproxy_hosts: proxyConf.autoproxy_hosts,
                proxyMode: proxyConf.proxyMode,
                proxy: proxyConf.proxy
            };
            _updateAndPostSettings(diffSet);
            browser._applyProxySettings?.(proxyConf);
            cb && cb(diffSet);
        });
    }
    self.updateProxy = function(message, sender, sendResponse) {
        updateProxy(message, function(diffSet) {
            _response(message, sendResponse, diffSet);
        });
    };
    self.setZoom = function(message, sender, sendResponse) {
        var tabId = sender.tab.id;
        var zoomFactor = message.zoomFactor * message.repeats;
        if (zoomFactor == 0) {
            chrome.tabs.getZoomSettings(tabId, function(settings) {
                const defaultZoom = settings.defaultZoomFactor ?
                    settings.defaultZoomFactor : 1;
                chrome.tabs.setZoom(tabId, defaultZoom);
            });
        } else {
            chrome.tabs.getZoom(tabId, function(zf) {
                chrome.tabs.setZoom(tabId, zf + zoomFactor);
            });
        }
        return {};
    };
    function _removeURL(uid, cb) {
        var type = uid[0], uid = uid.substr(1);
        if (type === 'B') {
            chrome.bookmarks.remove(uid, cb);
        } else if (type === 'H') {
            chrome.history.deleteUrl({url: uid}, cb);
        } else if (type === 'T') {
            uid = uid.split(":").map(function(u) {
                return parseInt(u);
            });
            chrome.windows.update(uid[0], {
                focused: true
            }, function() {
                chrome.tabs.remove(uid[1], cb);
            });
        } else if (type === 'M') {
            loadSettings('marks', function(data) {
                delete data.marks[uid];
                _updateAndPostSettings({marks: data.marks}, cb);
            });
        }
    }
    self.removeURL = function(message, sender, sendResponse) {
        var removed = 0,
            totalToRemoved = message.uid.length,
            uid = message.uid;
        if (typeof(message.uid) === "string") {
            totalToRemoved = 1;
            uid = [ message.uid ];
        }
        function _done() {
            removed ++;
            if (removed === totalToRemoved) {
                _response(message, sendResponse, {
                    response: "Done"
                });
            }
        }
        uid.forEach(function(u) {
            _removeURL(u, _done);
        });

    };
    self.localData = function(message, sender, sendResponse) {
        if (message.data.constructor === Object) {
            chrome.storage.local.set(message.data, function() {
            });
            // broadcast the change also, such as lastKeys
            // we would set lastKeys in sync to avoid breaching chrome.storage.sync.MAX_WRITE_OPERATIONS_PER_MINUTE
            _broadcastSettings(message.data);
        } else {
            // string or array of string keys
            chrome.storage.local.get(message.data, function(data) {
                _response(message, sendResponse, {
                    data: data
                });
            });
        }
    };
    self.captureVisibleTab = function(message, sender, sendResponse) {
        chrome.tabs.captureVisibleTab(null, {format: "png"}, function(dataUrl) {
            _response(message, sendResponse, {
                dataUrl: dataUrl
            });
        });
    };
    self.getCaptureSize = function(message, sender, sendResponse) {
        chrome.tabs.captureVisibleTab(null, {format: "png"}, function(dataUrl) {
            fetch(dataUrl)
                .then(function(res) {
                    return res.blob();
                })
                .then(function(blob) {
                    return createImageBitmap(blob);
                })
                .then(function(img) {
                    _response(message, sendResponse, {
                        width: img.width,
                        height: img.height
                    });
                });
        });
    };
    self.deleteHistoryOlderThan = function(message, sender, sendResponse) {
        var days = message.days || 0, hours = message.hours || 0;
        chrome.history.deleteRange({
            startTime: 0,
            endTime: new Date().getTime() - (days * 86400 + hours * 3600) * 1000
        }, function() {
        });
    };
    function removeBookmark(url, cb) {
        chrome.bookmarks.search({
            url: url
        }, function(bookmarks) {
            bookmarks.forEach(function(b) {
                chrome.bookmarks.remove(b.id);
            });
            cb && cb();
        });
    }
    self.removeBookmark = function(message, sender, sendResponse) {
        removeBookmark(sender.tab.url);
    };
    self.getBookmark = function(message, sender, sendResponse) {
        chrome.bookmarks.search({
            url: sender.tab.url
        }, function(bookmarks) {
            _response(message, sendResponse, {
                bookmarks: bookmarks
            });
        });
    };

    var _queueURLs = [];
    self.queueURLs = function(message, sender, sendResponse) {
        _queueURLs = _queueURLs.concat(message.urls);
    };
    self.getQueueURLs = function(message, sender, sendResponse) {
        return {
            queueURLs: _queueURLs
        };
    };
    self.clearQueueURLs = function(message, sender, sendResponse) {
        _queueURLs = [];
    };

    self.getVoices = function(message, sender, sendResponse) {
        chrome.tts.getVoices(function(voices) {
            _response(message, sendResponse, {
                voices: voices
            });
        });
    };

    self.read = function(message, sender, sendResponse) {
        var options = message.options || {};
        options.onEvent = function(ttsEvent) {
            // https://developer.chrome.com/docs/extensions/mv2/messaging/
            // If multiple pages are listening for onMessage events, only the first to call sendResponse()
            // for a particular event will succeed in sending the response. All other responses to that event will be ignored.
            //
            // Thus for the later events after `start` we will send them in sendTabMessage.
            if (ttsEvent.type === "start") {
                _response(message, sendResponse, {
                    ttsEvent: ttsEvent
                });
            } else {
                sendTabMessage(sender.tab.id, -1, {
                    subject: 'onTtsEvent',
                    ttsEvent: ttsEvent
                });
            }
        };
        chrome.tts.speak(message.content, options);
    };
    self.stopReading = function(message, sender, sendResponse) {
        chrome.tts.stop();
    };

    self.openIncognito = function(message, sender, sendResponse) {
        chrome.windows.create({"url": message.url, "incognito": true});
    };

    self.writeClipboard = function (message, sender, sendResponse) {
        navigator.clipboard.writeText(message.text)
    };
    self.readClipboard = function (message, sender, sendResponse) {
        // only for Safari
        chrome.runtime.sendNativeMessage("application.id", {command: "Clipboard.read"}, function(response) {
            _response(message, sendResponse, response);
        });
    };
    function toUTF8(str) {
        try {
            return decodeURIComponent(escape(str));
        } catch {
            return str;
        }
    }
    let clientInLLMRequest = {tabId: 0, frameId: 0, origin: ""};
    const sendLLMessage = (message) => {
        if (browser.sendLLMessage && chrome.runtime.getURL("/").toLowerCase().indexOf(clientInLLMRequest.origin) === 0) {
            browser.sendLLMessage(message);
        } else {
            sendTabMessage(clientInLLMRequest.tabId, clientInLLMRequest.frameId, message);
        }
    };

    self.llmRequest = function (message, sender, sendResponse) {
        clientInLLMRequest.tabId = sender.tab.id;
        clientInLLMRequest.frameId = sender.frameId;
        clientInLLMRequest.origin = sender.origin.toLowerCase();

        const provider = message.provider;
        if (llmClients.hasOwnProperty(provider)) {
            const llmClient = llmClients[provider];
            llmClient(message, {
                onComplete: (message) => {
                    if (message.content && message.content.constructor.name === "Array") {
                        message.content = message.content.map((c) => {
                            return c.type === "text" ? { type: "text", text: toUTF8(c.text) } : c;
                        });
                    }
                    sendLLMessage({
                        subject: 'llmResponse',
                        message,
                        done: true
                    });
                },
                onChunk: (chunk) => {
                    sendLLMessage({
                        subject: 'llmResponse',
                        chunk: toUTF8(chunk)
                    });
                },
            });
        } else {
            sendLLMessage({
                subject: 'llmResponse',
                chunk: `**Warning:** There is no LLM provider ${provider} implemented.`
            });
        }
    };
    self.getAllLlmProviders = function (message, sender, sendResponse) {
        _response(message, sendResponse, {
            providers: Object.keys(llmClients).filter(p => p !== 'custom')
        });
    };

    self.getContainers = browser._getContainers ? browser._getContainers(self, _response) : function(message, sender, sendResponse) {
        _response(message, sendResponse, { containers: [] });
    };
    chrome.runtime.setUninstallURL("http://brookhong.github.io/2018/01/30/why-did-you-uninstall-surfingkeys.html");

    self.connectNative = function (message, sender, sendResponse) {
        if (!browser.nvimServer) {
            _response(message, sendResponse, {
                error: "Neovim native messaging host is not available."
            });
            return;
        }
        browser.nvimServer.ensure().then(({url, nm}) => {
            nm.postMessage({
                mode: message.mode
            });
            _response(message, sendResponse, {
                url,
            });
        }).catch((error) => {
            // An Error instance would serialize to `{}` over runtime messaging.
            _response(message, sendResponse, {
                error: error.message,
            });
        });
    };
}

export {
    _save,
    getSubSettings,
    loadRawSettingsFromStorage,
    start
};
