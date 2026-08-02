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

start({
    name: "Safari",
    loadRawSettings,
    _setNewTabUrl
});
