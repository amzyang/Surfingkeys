import readText from './common/tts.js';
import { start } from './content.js';

function usePdfViewer() {
    window.location.replace(chrome.runtime.getURL("/pages/pdf_viewer.html") + "?file=" + encodeURIComponent(document.URL));
}

start({
    usePdfViewer,
    readText
});
