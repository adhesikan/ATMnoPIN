/*
 * Account nav enhancement. Every nav ships a safe default
 * <a href="/login" data-account-nav>Sign In</a>; if /api/auth/me says the
 * visitor is signed in, swap those links to "My ATM" -> /account.
 * Reads only `authenticated`; fails silently.
 */
(function () {
  try {
    var links = document.querySelectorAll('[data-account-nav]');
    if (!links.length || typeof fetch !== 'function') return;
    fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || data.authenticated !== true) return;
        for (var i = 0; i < links.length; i++) {
          links[i].setAttribute('href', '/account');
          links[i].textContent = 'My ATM';
        }
      })
      .catch(function () {});
  } catch (e) {}
})();
