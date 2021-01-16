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
