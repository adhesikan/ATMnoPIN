/* visitor-tracker.js — ATM with No PIN
   Logs each page visit to Firebase Firestore: visits collection
   Captures: IP, geo, browser, OS, screen, referrer, page, timestamp
   Silently fails if blocked — never affects user experience
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

    // Parse browser & OS from user agent
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

    // Base data from browser
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
      // Geo filled in below
      ip: 'unknown',
      city: 'unknown',
      region: 'unknown',
      country: 'unknown',
      org: 'unknown',
      postal: 'unknown',
    };

    // Geo + IP lookup via ipapi.co (free, 1000/day)
    try {
      const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const geo = await res.json();
        visitData.ip       = geo.ip       || 'unknown';
        visitData.city     = geo.city     || 'unknown';
        visitData.region   = geo.region   || 'unknown';
        visitData.country  = geo.country_name || geo.country || 'unknown';
        visitData.org      = geo.org      || 'unknown';
        visitData.postal   = geo.postal   || 'unknown';
        visitData.latitude  = geo.latitude  || null;
        visitData.longitude = geo.longitude || null;
      }
    } catch(e) {
      // geo failed — still log without it
    }

    await addDoc(collection(db, 'visits'), visitData);

  } catch(e) {
    // Silent fail — never breaks the page
  }
})();
