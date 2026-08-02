import {
    loadRawSettingsFromStorage,
    start
} from './start.js';

function loadRawSettings(keys, cb, defaultSet) {
    loadRawSettingsFromStorage(keys, cb, defaultSet);
}

function _setNewTabUrl(){
    return "about:newtab";
}

function _getContainers(self, _response) {
    return function (message, sender, sendResponse){
        browser.contextualIdentities.query({}).then(function(containers){
            _response(message, sendResponse, {
                containers: containers
            });
        }, function(err){
            _response(message, sendResponse, {
                containers: []
            });
        });
    };
}

function getLatestHistoryItem(text, maxResults, cb) {
    chrome.history.search({
        startTime: 0,
        text,
        maxResults
    }, function(items) {
        cb(items);
    });
}

start({
    name: "Firefox",
    detectTabTitleChange: true,
    getLatestHistoryItem,
    loadRawSettings,
    _setNewTabUrl,
    _getContainers
});
