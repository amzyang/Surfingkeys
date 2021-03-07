mapkey('R', '#4Reload the page', function() {
    RUNTIME("reloadTab", { nocache: true });
});
mapkey('x', '#3Go one tab left', function() { RUNTIME("previousTab"); });
mapkey('c', '#3Go one tab right', function() { RUNTIME("nextTab"); });
mapkey('o', '#8Open a URL in current tab', function() {
  Front.openOmnibar({type : "URLs", extra : "getAllSites", tabbed : false});
});
mapkey('e', '#8Open a URL in non-active tab', function() {
  Front.openOmnibar(
      {type : "URLs", extra : "getAllSites", tabbed : true, activeTab : false});
});
mapkey(';', '#8Open commands',
       function() { Front.openOmnibar({type : "Commands"}); });
mapkey('d', '#3Close current tab', function() { RUNTIME("closeTab"); });
mapkey('u', '#3Restore closed tab', function() { RUNTIME("openLast"); });
aceVimMap(';', ':', 'normal');
aceVimMap(',', ';', 'normal');
mapkey('H', '#4Go back in history', function() { history.go(-1); },
       {repeatIgnore : true});
mapkey('L', '#4Go forward in history', function() { history.go(1); },
       {repeatIgnore : true});
mapkey('b', '#3Choose a tab', function() { Front.chooseTab(); });
mapkey('F', '#1Open multiple links in non-active new tabs', function() {
  Hints.create("", Hints.dispatchMouseClick,
               {multipleHits : false, tabbed : true, active : false});
});
mapkey('zz', '#3zoom reset', function() {
    RUNTIME('setZoom', {
        zoomFactor: 0
    });
});
map('gf', 'F');


mapkey('T', '#4Edit current URL with vim editor, and open in new tab', function() {
    Front.showEditor(window.location.href, function(data) {
        tabOpenLink(data);
    }, 'input');
});
mapkey('O', '#4Edit current URL with vim editor, and reload', function() {
    Front.showEditor(window.location.href, function(data) {
        window.location.href = data;
    }, 'input');
});


if (window.origin === "https://www.google.com") {
  function cycleGoogleSuggestions(forward) {
    var suggestions = document.querySelectorAll("ul>li.sbct");
    var selected = document.querySelector("ul>li.sbct.sbhl");
    var next;
    if (selected) {
      selected.classList.remove("sbhl");
      var next = Array.from(suggestions).indexOf(selected) + (forward ? 1 : -1);
      if (next === suggestions.length || next === -1) {
        next = {innerText : window.userInput};
      } else {
        next = suggestions[next];
        next.classList.add("sbhl");
      }
    } else {
      window.userInput = document.querySelector("input.gsfi").value;
      next = forward ? suggestions[0] : suggestions[suggestions.length - 1];
      next.classList.add("sbhl");
    }
    document.querySelector("input.gsfi").value = next.innerText;
  }
  imapkey('<Ctrl-p>', 'cycle google suggestions',
          function() { cycleGoogleSuggestions(false); });
  imapkey('<Ctrl-n>', 'cycle google suggestions',
          function() { cycleGoogleSuggestions(true); });
}
// -----------------------------------------------------------------------------------------------------------------------
//
// pentadactyl ctrl-a/ctrl-x support
// copy from pentadactyl
let incrementURL = function incrementURL(count) {
  let url = window.location.href;
  let matches = url.match(/(.*?)(\d+)(\D*)$/);
  let oldNum = matches[2];

  // disallow negative numbers as trailing numbers are often proceeded by
  // hyphens
  let newNum = String(Math.max(parseInt(oldNum, 10) + count, 0));
  if (/^0/.test(oldNum))
    while (newNum.length < oldNum.length)
      newNum = "0" + newNum;

  matches[2] = newNum;
  window.location.href = matches.slice(1).join("");
};
mapkey('<Ctrl-a>', '#8Increment last number in URL', function() {
  let repeats = RUNTIME.repeats;
  RUNTIME.repeats = 1;
  incrementURL(Math.max(repeats, 1));
});
mapkey('<Ctrl-x>', '#8Decrement last number in URL', function() {
  let repeats = RUNTIME.repeats;
  RUNTIME.repeats = 1;
  incrementURL(-Math.max(repeats, 1));
});

// -----------------------------------------------------------------------------------------------------------------------
// Change hints styles
// -----------------------------------------------------------------------------------------------------------------------
Hints.characters = "asdfgqwertvbn";
Hints.style(
    'border: solid 1px #ff79c6; color:#44475a; background: #f1fa8c; background-color: #f1fa8c; font-size: 10pt; font-family: "Fira Code"');
Hints.style(
    'border: solid 8px #ff79c6;padding: 1px;background: #f1fa8c; font-family: "Fira Code"',
    "text");
// -----------------------------------------------------------------------------------------------------------------------
// Change search marks and cursor
// -----------------------------------------------------------------------------------------------------------------------
Visual.style('marks', 'background-color: #f1fa8c;');
Visual.style('cursor', 'background-color: #6272a4; color: #f8f8f2');
// -----------------------------------------------------------------------------------------------------------------------
// Change theme
// // Change fonts
// // Change colors
// -----------------------------------------------------------------------------------------------------------------------
settings.theme = `
.sk_theme input {
    font-family: "Fira Code";
}
.sk_theme .url {
    font-size: 11px;
}
#sk_omnibarSearchResult li div.url {
    font-weight: normal;
}
.sk_theme .omnibar_timestamp {
    font-size: 12px;
    font-weight: bold;
}
#sk_omnibarSearchArea input {
    font-size: 14px;
}
.sk_theme .omnibar_visitcount {
    font-size: 12px;
    font-weight: bold;
}
body {
    font-family: "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, monospace;
    font-size: 14px;
}
kbd {
    font: 11px "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, monospace;
}
#sk_omnibarSearchArea .prompt, #sk_omnibarSearchArea .resultPage {
    font-size: 14px;
}
.sk_theme {
    background: #282a36;
    color: #f8f8f2;
}
.sk_theme tbody {
    color: #ff5555;
}
.sk_theme input {
    color: #ffb86c;
}
.sk_theme .url {
    color: #6272a4;
}
#sk_omnibarSearchResult>ul>li {
    background: #282a36;
}
#sk_omnibarSearchResult ul li:nth-child(odd) {
    background: #282a36;
}
.sk_theme #sk_omnibarSearchResult ul li:nth-child(odd) {
    background: #282a36;
}
.sk_theme .annotation {
    color: #6272a4;
}
.sk_theme .focused {
    background: #44475a !important;
}
.sk_theme kbd {
    background: #f8f8f2;
    color: #44475a;
}
.sk_theme .frame {
    background: #8178DE9E;
}
.sk_theme .omnibar_highlight {
    color: #8be9fd;
}
.sk_theme .omnibar_folder {
    color: #ff79c6;
}
.sk_theme .omnibar_timestamp {
    color: #bd93f9;
}
.sk_theme .omnibar_visitcount {
    color: #f1fa8c;
}

.sk_theme .prompt, .sk_theme .resultPage {
    color: #50fa7b;
}
.sk_theme .feature_name {
    color: #ff5555;
}
.sk_omnibar_middle #sk_omnibarSearchArea {
    border-bottom: 1px solid #282a36;
}
#sk_status {
    border: 1px solid #282a36;
}
#sk_richKeystroke {
    background: #282a36;
    box-shadow: 0px 2px 10px rgba(40, 42, 54, 0.8);
}
#sk_richKeystroke kbd>.candidates {
    color: #ff5555;
}
#sk_keystroke {
    background-color: #282a36;
    color: #f8f8f2;
}
kbd {
    border: solid 1px #f8f8f2;
    border-bottom-color: #f8f8f2;
    box-shadow: inset 0 -1px 0 #f8f8f2;
}
#sk_frame {
    border: 4px solid #ff5555;
    background: #8178DE9E;
    box-shadow: 0px 0px 10px #DA3C0DCC;
}
#sk_banner {
    border: 1px solid #282a36;
    background: rgb(68, 71, 90);
}
div.sk_tabs_bg {
    background: #f8f8f2;
}
div.sk_tab {
    background: -webkit-gradient(linear, left top, left bottom, color-stop(0%,#6272a4), color-stop(100%,#44475a));
}
div.sk_tab_title {
    color: #f8f8f2;
}
div.sk_tab_url {
    color: #8be9fd;
}
div.sk_tab_hint {
    background: -webkit-gradient(linear, left top, left bottom, color-stop(0%,#f1fa8c), color-stop(100%,#ffb86c));
    color: #282a36;
    border: solid 1px #282a36;
}
#sk_bubble {
    border: 1px solid #f8f8f2;
    color: #282a36;
    background-color: #f8f8f2;
}
#sk_bubble * {
    color: #282a36 !important;
}
div.sk_arrow[dir=down]>div:nth-of-type(1) {
    border-top: 12px solid #f8f8f2;
}
div.sk_arrow[dir=up]>div:nth-of-type(1) {
    border-bottom: 12px solid #f8f8f2;
}
div.sk_arrow[dir=down]>div:nth-of-type(2) {
    border-top: 10px solid #f8f8f2;
}
div.sk_arrow[dir=up]>div:nth-of-type(2) {
    border-bottom: 10px solid #f8f8f2;
}
#sk_omnibar {
    width: 100%;
    left: 0%;
}
}`;
// -----------------------------------------------------------------------------------------------------------------------
// Change position
// -----------------------------------------------------------------------------------------------------------------------
settings.omnibarPosition = "bottom";
// -----------------------------------------------------------------------------------------------------------------------
// Hints overlap
// -----------------------------------------------------------------------------------------------------------------------
settings.hintAlign = "left"
