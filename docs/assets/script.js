// oneshot docs — copy-to-clipboard with graceful fallback

(function () {
  'use strict';

  var copyStatus = document.getElementById('copyStatus');
  var copySuccessIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>';
  var copyStatusTimer;

  function flashCopyStatus(message) {
    if (!copyStatus) return;
    copyStatus.textContent = message;
    copyStatus.classList.add('visible');
    clearTimeout(copyStatusTimer);
    copyStatusTimer = setTimeout(function () {
      copyStatus.classList.remove('visible');
    }, 1800);
  }

  function fallbackCopy(text) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    var copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  }

  document.querySelectorAll('.copy-btn[data-copy]').forEach(function (btn) {
    var original = btn.innerHTML;
    var resetTimer;

    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');

      function resetButtonState() {
        btn.classList.remove('copied', 'copy-failed');
        btn.innerHTML = original;
      }

      function showCopied() {
        btn.classList.add('copied');
        btn.classList.remove('copy-failed');
        btn.innerHTML = copySuccessIcon;
        flashCopyStatus('Copied to clipboard');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(resetButtonState, 1800);
      }

      function showFailure() {
        btn.classList.add('copy-failed');
        btn.classList.remove('copied');
        flashCopyStatus('Copy failed');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(resetButtonState, 1800);
      }

      if (!text) {
        showFailure();
        return;
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(showCopied).catch(function () {
          fallbackCopy(text) ? showCopied() : showFailure();
        });
        return;
      }

      fallbackCopy(text) ? showCopied() : showFailure();
    });
  });
})();
