// oneshot docs — minimal interactivity

(function () {
  'use strict';

  // ---- Mobile Menu ----
  const sidebar = document.getElementById('sidebar');
  const menuToggle = document.getElementById('menuToggle');
  const overlay = document.getElementById('sidebarOverlay');
  const copyStatus = document.getElementById('copyStatus');
  const navLinks = document.querySelectorAll('.nav-link');
  const firstNavLink = navLinks[0];
  const copySuccessIcon =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>';

  function setMenuState(isOpen) {
    menuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    menuToggle.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
  }

  function openMenu() {
    sidebar.classList.add('open');
    menuToggle.classList.add('active');
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
    setMenuState(true);
    if (firstNavLink) firstNavLink.focus();
  }

  function closeMenu(returnFocus) {
    sidebar.classList.remove('open');
    menuToggle.classList.remove('active');
    overlay.classList.remove('visible');
    document.body.style.overflow = '';
    setMenuState(false);
    if (returnFocus) menuToggle.focus();
  }

  menuToggle.addEventListener('click', function () {
    sidebar.classList.contains('open') ? closeMenu(true) : openMenu();
  });

  overlay.addEventListener('click', function () {
    closeMenu(true);
  });

  // Close on nav link click (mobile)
  navLinks.forEach(function (link) {
    link.addEventListener('click', closeMenu);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && sidebar.classList.contains('open')) {
      closeMenu(true);
    }
  });

  window.addEventListener('resize', function () {
    if (window.innerWidth > 768 && sidebar.classList.contains('open')) {
      closeMenu(false);
    }
  });

  // ---- Active Section Highlighting ----
  const sections = document.querySelectorAll('section[id]');

  const observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute('id');
          navLinks.forEach(function (link) {
            const isActive = link.getAttribute('href') === '#' + id;
            link.classList.toggle('active', isActive);
            if (isActive) {
              link.setAttribute('aria-current', 'true');
            } else {
              link.removeAttribute('aria-current');
            }
          });
        }
      });
    },
    {
      rootMargin: '-20% 0px -60% 0px',
      threshold: 0,
    }
  );

  sections.forEach(function (section) {
    observer.observe(section);
  });

  // ---- Copy Buttons ----
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
