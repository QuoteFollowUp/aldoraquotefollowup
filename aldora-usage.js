/* Aldora usage tracker — shared by every Aldora app.
   Add ONE line to each app's index.html, just before </body>:
     <script src="https://aldoramobilequotefollowup.netlify.app/aldora-usage.js" data-app="sales-hub"></script>
   It reports "this person opened this app" to the Quote Follow Up app's usage report, using the same
   personal access code they signed in with. Nothing else is sent. If no code is found, nothing is sent.
   An app can also report explicitly right after sign-in:  window.AldoraUsage.open('VCDR-TDMR');  */
(function () {
  var API = 'https://aldoramobilequotefollowup.netlify.app/api/data';
  var me = document.currentScript;
  var APP = (me && me.getAttribute('data-app')) || location.hostname.split('.')[0];
  var CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$|^\d{4}$/i;
  function findCode() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i), v = localStorage.getItem(k) || '';
        if (!/code|access|login|auth|pin/i.test(k)) continue;
        var t = v.trim().replace(/^"|"$/g, '');
        if (CODE_RE.test(t)) return t;
        try { var o = JSON.parse(v); if (o && typeof o === 'object') { var c = o.code || o.accessCode || o.pin; if (c && CODE_RE.test(String(c).trim())) return String(c).trim(); } } catch (e) {}
      }
    } catch (e) {}
    return '';
  }
  var last = 0;
  function open(code) {
    code = code || findCode();
    if (!code) return;
    var now = Date.now();
    if (now - last < 30 * 60000) return;
    last = now;
    try { fetch(API + '?usage=open&app=' + encodeURIComponent(APP), { headers: { 'x-access-code': code }, cache: 'no-store', mode: 'cors' }).catch(function () {}); } catch (e) {}
  }
  window.AldoraUsage = { open: function (code) { last = 0; open(code); } };
  setTimeout(function () { open(); }, 1500);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') open(); });
})();
