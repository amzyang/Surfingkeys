import {
    showPopup,
} from './utils.js';
import { dispatchSKEvent, runtime, RUNTIME } from './runtime.js';

// Text-to-speech through the background `read` action(chrome.tts, Chrome only).
// Works from both the content window and the frontend iframe: the first tts
// event comes back as the message response, later ones are streamed to the tab
// as onTtsEvent messages.
function readText(text, options) {
    options = options || {
        enqueue: true,
        voiceName: runtime.conf.defaultVoice
    };
    var stopPattern = /[\s\u00a0]/g,
        verbose = options.verbose,
        onEnd = options.onEnd;
    delete options.verbose;
    delete options.onEnd;
    const onTtsEvent = function(res) {
        if (verbose) {
            if (res.ttsEvent.type === "start") {
                showPopup(text);
            } else if (res.ttsEvent.type === "word") {
                stopPattern.lastIndex = res.ttsEvent.charIndex;
                var updated, end = stopPattern.exec(text);
                if (end) {
                    updated = text.substr(0, res.ttsEvent.charIndex)
                        + "<font style='font-weight: bold; text-decoration: underline'>"
                        + text.substr(res.ttsEvent.charIndex, end.index - res.ttsEvent.charIndex + 1)
                        + "</font>"
                        + text.substr(end.index);
                } else {
                    updated = text.substr(0, res.ttsEvent.charIndex)
                        + "<font style='font-weight: bold; text-decoration: underline'>"
                        + text.substr(res.ttsEvent.charIndex)
                        + "</font>";
                }
                showPopup(updated);
            } else if (res.ttsEvent.type === "end") {
                dispatchSKEvent("front", ['hidePopup']);
            }
        }
        if (onEnd && (res.ttsEvent.type === "end" || res.ttsEvent.type === "interrupted")) {
            onEnd();
        }
        return res.ttsEvent.type !== "end";
    };
    // the background streams further TTS progress as onTtsEvent messages
    runtime.on('onTtsEvent', onTtsEvent);
    RUNTIME('read', {
        content: text,
        options: options
    }, onTtsEvent);
}

export default readText;
