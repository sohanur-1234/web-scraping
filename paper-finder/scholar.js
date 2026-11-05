// Content script: runs on Google Scholar result pages that Paper Finder opened.
// It only reads the page and reports results (or a CAPTCHA) to the background worker.
(function () {
  const send = (msg) => chrome.runtime.sendMessage({ type: 'scholar-page', ...msg });

  const onSorry = location.pathname.startsWith('/sorry');
  const hasResultsBox = !!document.querySelector('#gs_res_ccl_mid');
  const captcha =
    onSorry ||
    !!document.querySelector('#gs_captcha_ccl, #captcha-form, form[action*="sorry"]') ||
    (!hasResultsBox && /unusual traffic/i.test((document.body && document.body.innerText) || ''));

  if (captcha) {
    send({ captcha: true, results: [], hasNext: false });
    return;
  }

  const results = [...document.querySelectorAll('#gs_res_ccl_mid .gs_r.gs_or')]
    .map((el) => {
      const a = el.querySelector('.gs_rt a');
      const title = ((el.querySelector('.gs_rt') || {}).textContent || '')
        .replace(/^\s*\[[A-Z]+\]\s*/, '')
        .trim();
      const pdfA = el.querySelector('.gs_or_ggsm a, .gs_ggs a');
      const meta = ((el.querySelector('.gs_a') || {}).textContent || '').replace(/\u00a0/g, ' ');
      const years = meta.match(/\b(?:19|20)\d{2}\b/g);
      return {
        title,
        link: a ? a.href : '',
        pdf: pdfA ? pdfA.href : '',
        meta,
        year: years ? Number(years[years.length - 1]) : null,
      };
    })
    .filter((r) => r.title);

  const hasNext = !!document.querySelector('#gs_n a[aria-label="Next"], #gs_n .gs_ico_nav_next');
  send({ captcha: false, results, hasNext });
})();
