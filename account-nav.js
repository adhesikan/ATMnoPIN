/*
 * Account nav enhancement. Every nav ships a safe default
 * <a href="/login" data-account-nav>Sign In</a>; if /api/auth/me says the
 * visitor is signed in, swap those links to "My ATM" -> /account, and point
 * CREATE MY ATM CTAs ([data-account-cta], default /login?next=...) straight
 * at /ai-profile-generator. Reads only `authenticated`; fails silently.
 */
(function () {
  try {
    var links = document.querySelectorAll('[data-account-nav]');
    var ctas = document.querySelectorAll('[data-account-cta]');
    if ((!links.length && !ctas.length) || typeof fetch !== 'function') return;
    fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || data.authenticated !== true) return;
        for (var i = 0; i < links.length; i++) {
          links[i].setAttribute('href', '/account');
          links[i].textContent = 'My ATM';
        }
        for (var j = 0; j < ctas.length; j++) {
          ctas[j].setAttribute('href', '/ai-profile-generator');
        }
      })
      .catch(function () {});
  } catch (e) {}
})();
