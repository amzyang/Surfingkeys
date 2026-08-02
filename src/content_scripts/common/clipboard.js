import { RUNTIME } from './runtime.js';
import {
    actionWithSelectionPreserved,
    getBrowserName,
    setSanitizedContent,
    showBanner,
} from './utils.js';

function createClipboard() {
    var self = {};

    var holder = document.createElement('textarea');
    holder.contentEditable = true;
    holder.enableAutoFocus = true;
    holder.id = 'sk_clipboard';

    function clipboardActionWithSelectionPreserved(cb) {
        actionWithSelectionPreserved(function(selection) {
            // avoid editable body
            document.documentElement.appendChild(holder);

            cb(selection);

            holder.remove();
        });
    }

    function readViaNativeMessaging(onReady) {
        RUNTIME('readClipboard', null, onReady);
    }

    function readViaNavigatorClipboard(onReady) {
        navigator.clipboard.readText().then((data) => {
            // call back onReady in a different thread to avoid breaking UI operations
            // such as Front.openOmnibar
            setTimeout(function() {
                onReady({ data });
            }, 0);
        });
    }

    function readViaExecCommand(onReady) {
        clipboardActionWithSelectionPreserved(function() {
            holder.value = '';
            setSanitizedContent(holder, '');
            holder.focus();
            document.execCommand("paste");
        });
        var data = holder.value;
        if (data === "") {
            data = holder.innerHTML.replace(/<br>/gi,"\n");
        }
        onReady({data: data});
    }

    function writeViaExecCommand(text) {
        clipboardActionWithSelectionPreserved(function() {
            holder.value = text;
            holder.select();
            document.execCommand('copy');
            holder.value = '';
        });
    }

    function writeViaBackground(text) {
        RUNTIME("writeClipboard", { text });
    }

    // resolve the strategies once: Safari reads through native messaging;
    // Firefox uses navigator.clipboard when present; execCommand otherwise.
    // navigator.clipboard.writeText does not work on http sites, nor in
    // chrome's background script, hence Chrome writes via execCommand here.
    const browserName = getBrowserName();
    const read = browserName.startsWith("Safari") ? readViaNativeMessaging
        : (browserName === "Firefox" && typeof navigator.clipboard === 'object'
            && typeof navigator.clipboard.readText === 'function') ? readViaNavigatorClipboard
        : readViaExecCommand;
    const write = browserName === "Chrome" ? writeViaExecCommand : writeViaBackground;

    /**
     * Read from clipboard.
     *
     * @param {function} onReady a callback function to handle text read from clipboard.
     * @name Clipboard.read
     *
     * @example
     * Clipboard.read(function(response) {
     *   console.log(response.data);
     * });
     */
    self.read = read;

    /**
     * Write text to clipboard.
     *
     * @param {string} text the text to be written to clipboard.
     * @name Clipboard.write
     *
     * @example
     * Clipboard.write(window.location.href);
     */
    self.write = function(text) {
        write(text);
        showBanner("Copied: " + text);
    };

    return self;

}

export default createClipboard;
