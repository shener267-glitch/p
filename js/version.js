// Single source of truth for the app version shown in the UI. Bump this
// with each meaningful change.
(function () {
  'use strict';
  var VERSION = '1.4.1';

  var badge = document.getElementById('versionBadge');
  if (badge) badge.textContent = 'v' + VERSION;

  var footer = document.getElementById('versionFooter');
  if (footer) footer.textContent = 'v' + VERSION;

  window.APP_VERSION = VERSION;
})();
