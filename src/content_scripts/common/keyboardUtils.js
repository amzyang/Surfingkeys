const KeyboardUtils = {
    keyCodesMac: {
        Minus: ["-", "_"],
        Equal: ["=", "+"],
        BracketLeft: ["[", "{"],
        BracketRight: ["]", "}"],
        Backslash: ["\\", "|"],
        Semicolon: [";", ":"],
        Quote: ["'", "\""],
        Comma: [",", "<"],
        Period: [".", ">"],
        Slash: ["/", "?"]
    },
    keyCodes: {
        ESC: 27,
        backspace: 8,
        deleteKey: 46,
        enter: 13,
        ctrlEnter: 10,
        space: 32,
        shiftKey: 16,
        ctrlKey: 17,
        f1: 112,
        f12: 123,
        comma: 188,
        tab: 9,
        downArrow: 40,
        upArrow: 38
    },
    modifierKeys: {
        16: "Shift",
        17: "Ctrl",
        18: "Alt",
        91: "Meta",
        92: "Meta",
        93: "ContextMenu",
        229: "Process"
    },
    keyNames: {
        8:   'Backspace',
        9:   'Tab',
        12:  'NumLock',
        27:  'Esc',
        32:  'Space',
        46:  'Delete',
    },
};

KeyboardUtils.platform = "Windows";
if (typeof(navigator) !== 'undefined') {
    if (navigator.platform.indexOf("Mac") !== -1) {
        KeyboardUtils.platform = "Mac";
    } else if (navigator.userAgent.indexOf("Linux") !== -1) {
        KeyboardUtils.platform = "Linux";
    }
}

KeyboardUtils.getKeyChar = function(event) {
    var character;
    if (event.keyCode in this.modifierKeys) {
        character = "";
    } else {
        if (this.keyNames.hasOwnProperty(event.keyCode)) {
            character = this.keyNames[event.keyCode];
        } else {
            character = event.key || "";
            if (["Shift", "Meta", "Alt", "Ctrl"].indexOf(character) !== -1) {
                character = "";
            }
            if (character.charCodeAt(0) > 127   // Alt-s is ß under Mac
                || character === "Dead"         // Alt-i is Dead under Mac
            ) {
                if (event.keyCode < 127) {
                    character = String.fromCharCode(event.keyCode);
                    character = event.shiftKey ? character : character.toLowerCase();
                } else if (this.keyCodesMac.hasOwnProperty(event.code)) {
                    // Alt-/ or Alt-?
                    character = this.keyCodesMac[event.code][event.shiftKey ? 1 : 0];
                }
            } else if (character === "Unidentified") {
                // for IME on
                character = "";
            }
        }
        if (event.shiftKey && character.length > 1) {
            character = "Shift-" + character;
        }
        if (character.length > 0) {
            if (event.metaKey) {
                character = "Meta-" + character;
            }
            if (event.altKey) {
                character = "Alt-" + character;
            }
            if (event.ctrlKey) {
                character = "Ctrl-" + character;
            }
        }
        if (character.length > 1) {
            character = "<" + character + ">";
        }
    }
    if (!(character in _keyCharCache)) {
        _keyCharCache[character] =
            KeyboardUtils.decodeKeystroke(KeyboardUtils.encodeKeystroke(character)) === character
                ? KeyboardUtils.encodeKeystroke(character) : character;
    }
    return _keyCharCache[character];
};

KeyboardUtils.isWordChar = function(event) {
    return (event.keyCode < 123 && event.keyCode >= 97 || event.keyCode < 91 && event.keyCode >= 65 || event.keyCode < 58 && event.keyCode >= 48);
};

function _encodeKeystroke(s, k) {
    var mod = 0;
    if (s.indexOf("Ctrl-") !== -1) {
        mod |= 1;
    }
    if (s.indexOf("Alt-") !== -1) {
        mod |= 2;
    }
    if (s.indexOf("Meta-") !== -1) {
        mod |= 4;
    }
    if (s.indexOf("Shift-") !== -1) {
        mod |= 8;
    }
    var code;
    if (k.length > 1) {
        code = 256 + KeyboardUtils.specialKeys.indexOf(k);
    } else {
        code = k.charCodeAt(0);
    }

    // <flag: always 1><flag: 1 bit, 0 for visible keys, 1 for invisible keys><key: 8 bits><mod: 4 bits>
    code = 8192 + (code << 4) + mod;
    return String.fromCharCode(code);
}
var _keyCharCache = Object.create(null);
var _ekp = /<(?:Ctrl-)?(?:Alt-)?(?:Meta-)?(?:Shift-)?([^>]+|.)>/g;
KeyboardUtils.encodeKeystroke = function (s) {
    var ekp = _ekp;
    ekp.lastIndex = 0;
    var mtches, ret = "", lastIndex = 0;
    while ((mtches = ekp.exec(s)) !== null) {
        ret += s.substr(lastIndex, mtches.index - lastIndex);
        ret += _encodeKeystroke(mtches[0], mtches[1]);
        lastIndex = ekp.lastIndex;
    }
    ret += s.substr(lastIndex);
    return ret;
};

KeyboardUtils.specialKeys = ['Esc', 'Space', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Enter', 'Tab', 'Delete', 'End', 'Home', 'Insert', 'NumLock', 'PageDown', 'PageUp', 'Pause', 'ScrollLock', 'CapsLock', 'PrintScreen', 'Escape', 'Hyper'];

KeyboardUtils.decodeKeystroke = function (s) {
    var ret = "";
    for (var i = 0; i < s.length; i++) {
        var r = s[i].charCodeAt(0);
        if (r > 8192) {
            r = r - 8192;
            var flag = r >> 12,
                key = (r % 4096) >> 4,
                mod = r & 15;
            if (flag) {
                r = KeyboardUtils.specialKeys[key % 256];
            } else {
                r = String.fromCharCode(key);
            }
            if (mod & 8) {
                r = "Shift-" + r;
            }
            if (mod & 4) {
                r = "Meta-" + r;
            }
            if (mod & 2) {
                r = "Alt-" + r;
            }
            if (mod & 1) {
                r = "Ctrl-" + r;
            }
            ret += "<" + r + ">";
        } else {
            ret += s[i];
        }
    }
    return ret;
};

export default KeyboardUtils;
