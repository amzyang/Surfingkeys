import {
    NATIVE_HOST_NAME,
} from '../common/utils.js';
import {
    loadRawSettingsFromStorage,
    start
} from './start.js';

function loadRawSettings(keys, cb, defaultSet) {
    loadRawSettingsFromStorage(keys, cb, defaultSet, {useSync: true});
}

function _setNewTabUrl(){
    return  "favorites://";
}

function restoreLastTab(cb) {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {command: "reopenLastTab"}, cb);
}

function sendLLMessage(message) {
    chrome.runtime.sendMessage(message);
}

start({
    name: "Safari",
    loadRawSettings,
    restoreLastTab,
    sendLLMessage,
    _setNewTabUrl
});
