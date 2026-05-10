/* visitor-tracker.js — ATM with No PIN
   Logs each page visit to Firebase Firestore: visits collection
   Uses multiple geo APIs with fallback for best IPv6 coverage
*/
(async function() {
  try {
    const { initializeApp, getApps } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    const { getFirestore, addDoc, collection, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    const cfg = {
      apiKey: "AIzaSyAzlx4DVWbSkB4aM-njR55IT5qSPv4CFuk",
      authDomain: "atmwithnopin-c5bd7.firebaseapp.com",
      projectId: "atmwithnopin-c5bd7",
      storageBucket: "atmwithnopin-c5bd7.firebasestorage.app",
      messagingSenderId: "404706016435",
      appId: "1:404706016435:web:b5e3cf34ccc9b669bd04c6"
    };

    const app = getApps().length ? getApps()[0] : initializeApp(cfg);
    const db = getFirestore(app);

    // Browser fingerprinting
    function parseBrowser(ua) {
      if (/Edg\//.test(ua)) return 'Edge';
      if (/OPR\/|Opera/.test(ua)) return 'Opera';
      if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return 'Chrome';
      if (/Firefox\//.test(ua)) return 'Firefox';
      if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return 'Safari';
      if (/MSIE|Trident/.test(ua)) return 'IE';
      return 'Other';
    }
    function parseOS(ua) {
      if (/Windows NT 10/.test(ua)) return 'Windows 10/11';
      if (/Windows NT 6\.3/.test(ua)) return 'Windows 8.1';
      if (/Windows/.test(ua)) return 'Windows';
      if (/Mac OS X/.test(ua)) return 'macOS';
      if (/iPhone/.test(ua)) return 'iOS (iPhone)';
      if (/iPad/.test(ua)) return 'iOS (iPad)';
      if (/Android/.test(ua)) return 'Android';
      if (/Linux/.test(ua)) return 'Linux';
      return 'Other';
    }
    function parseDevice(ua) {
      if (/Mobi|Android|iPhone|iPad/.test(ua)) return 'Mobile';
      if (/Tablet/.test(ua)) return 'Tablet';
      return 'Desktop';
    }

    // Deduplicate — don't log same session twice within 30 min
    const sessionKey = 'atm_visit_' + window.location.pathname;
    const lastVisit = sessionStorage.getItem(sessionKey);
    if (lastVisit && Date.now() - parseInt(lastVisit) < 30 * 60 * 1000) return;
    sessionStorage.setItem(sessionKey, Date.now().toString());

    const ua = navigator.userAgent;
    const visitData = {
      page: window.location.pathname || '/',
      pageTitle: document.title || '',
      referrer: document.referrer || 'direct',
      browser: parseBrowser(ua),
      os: parseOS(ua),
      device: parseDevice(ua),
      language: navigator.language || 'unknown',
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
      timestamp: serverTimestamp(),
      ip: 'unknown', city: 'unknown', region: 'unknown', state: 'unknown',
      country: 'unknown', org: 'unknown', postal: 'unknown',
      latitude: null, longitude: null,
    };

    // GEO LOOKUP — try multiple APIs, best IPv6 coverage wins
    // API 1: ip-api.com — excellent IPv6, returns city+state+region
    async function tryIpApi() {
      const r = await fetch('http://ip-api.com/json/?fields=status,message,country,regionName,city,zip,lat,lon,isp,org,query', 
        { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return false;
      const d = await r.json();
      if (d.status !== 'success') return false;
      visitData.ip      = d.query      || 'unknown';
      visitData.city    = d.city       || 'unknown';
      visitData.region  = d.regionName || 'unknown'; // full state name e.g. "Connecticut"
      visitData.state   = d.regionName || 'unknown';
      visitData.country = d.country    || 'unknown';
      visitData.org     = d.org || d.isp || 'unknown';
      visitData.postal  = d.zip        || 'unknown';
      visitData.latitude  = d.lat      || null;
      visitData.longitude = d.lon      || null;
      return true;
    }

    // API 2: ipapi.co — fallback, good IPv6 support
    async function tryIpApiCo() {
      const r = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return false;
      const d = await r.json();
      if (d.error) return false;
      visitData.ip      = d.ip              || 'unknown';
      visitData.city    = d.city            || 'unknown';
      visitData.region  = d.region          || 'unknown';
      visitData.state   = d.region          || 'unknown';
      visitData.country = d.country_name    || 'unknown';
      visitData.org     = d.org             || 'unknown';
      visitData.postal  = d.postal          || 'unknown';
      visitData.latitude  = d.latitude      || null;
      visitData.longitude = d.longitude     || null;
      return true;
    }

    // API 3: freeipapi.com — another fallback, handles IPv6
    async function tryFreeIpApi() {
      const r = await fetch('https://freeipapi.com/api/json', { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return false;
      const d = await r.json();
      visitData.ip      = d.ipAddress       || 'unknown';
      visitData.city    = d.cityName        || 'unknown';
      visitData.region  = d.regionName      || 'unknown';
      visitData.state   = d.regionName      || 'unknown';
      visitData.country = d.countryName     || 'unknown';
      visitData.org     = 'unknown';
      visitData.postal  = d.zipCode         || 'unknown';
      visitData.latitude  = d.latitude      || null;
      visitData.longitude = d.longitude     || null;
      return true;
    }

    // Try APIs in order — first success wins
    try { await tryIpApi(); } catch(e) {
      try { await tryIpApiCo(); } catch(e2) {
        try { await tryFreeIpApi(); } catch(e3) {}
      }
    }

    await addDoc(collection(db, 'visits'), visitData);

  } catch(e) {
    // Silent fail — never breaks the page
  }
})();
