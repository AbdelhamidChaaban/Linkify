const axios = require('axios');

const API_KEY = process.env.CAPTCHA_API_KEY || '';
const API_URL = 'http://2captcha.com';

/**
 * Solve reCAPTCHA v2 using 2captcha API
 * @param {string} siteKey - reCAPTCHA site key
 * @param {string} pageUrl - URL of the page with CAPTCHA
 * @returns {Promise<string>} CAPTCHA token
 */
async function solveCaptcha(siteKey, pageUrl) {
  try {
    console.log('🔐 Submitting CAPTCHA to 2captcha...');
    
    const submitResponse = await axios.post(`${API_URL}/in.php`, null, {
      params: {
        key: API_KEY,
        method: 'userrecaptcha',
        googlekey: siteKey,
        pageurl: pageUrl,
        json: 1
      },
      timeout: 10000
    });

    const submitData = submitResponse.data;
    
    if (submitData.status !== 1) {
      throw new Error(`Failed to submit CAPTCHA: ${submitData.request || 'Unknown error'}`);
    }

    const captchaId = submitData.request;
    console.log(`⏳ CAPTCHA submitted. ID: ${captchaId}. Waiting for solution...`);

    let attempts = 0;
    const maxAttempts = 60;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const resultResponse = await axios.get(`${API_URL}/res.php`, {
        params: {
          key: API_KEY,
          action: 'get',
          id: captchaId,
          json: 1
        },
        timeout: 10000
      });

      const resultData = resultResponse.data;
      
      if (resultData.status === 1) {
        console.log('✅ CAPTCHA solved successfully!');
        return resultData.request;
      } else if (resultData.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`CAPTCHA solving failed: ${resultData.request || 'Unknown error'}`);
      }
      
      attempts++;
    }

    throw new Error('CAPTCHA solving timeout - took too long');
  } catch (error) {
    console.error('❌ Error solving CAPTCHA:', error.message);
    throw error;
  }
}

/**
 * Extract reCAPTCHA site key from page
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<string|null>} Site key or null
 */
async function getCaptchaSiteKey(page) {
  try {
    const siteKey = await page.evaluate(() => {
      const captchaFrame = document.querySelector('iframe[src*="recaptcha"]');
      if (captchaFrame) {
        const src = captchaFrame.src;
        const match = src.match(/[?&]k=([^&]+)/);
        if (match) return match[1];
      }

      const script = Array.from(document.querySelectorAll('script')).find(s => 
        s.textContent.includes('recaptcha') || s.src?.includes('recaptcha')
      );
      
      if (script) {
        const text = script.textContent || '';
        const match = text.match(/['"]sitekey['"]\s*:\s*['"]([^'"]+)['"]/) ||
                     text.match(/data-sitekey=['"]([^'"]+)['"]/);
        if (match) return match[1];
      }

      const siteKeyAttr = document.querySelector('[data-sitekey]');
      if (siteKeyAttr) {
        return siteKeyAttr.getAttribute('data-sitekey');
      }

      return null;
    });

    return siteKey;
  } catch (error) {
    return null;
  }
}

/**
 * Inject and execute CAPTCHA token
 * @param {Object} page - Puppeteer page object
 * @param {string} token - CAPTCHA token
 * @returns {Promise<void>}
 */
async function injectCaptchaToken(page, token) {
  await page.evaluate((token) => {
    const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
    if (textarea) {
      textarea.value = token;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }

    const iframe = document.querySelector('iframe[src*="recaptcha"]');
    if (iframe && iframe.contentWindow) {
      try {
        iframe.contentWindow.postMessage(token, '*');
      } catch (e) {}
    }

    if (window.grecaptcha && window.grecaptcha.getResponse) {
      const callback = window.grecaptcha.getResponse();
      if (callback && typeof callback === 'function') {
        callback(token);
      }
    }
  }, token);

  await new Promise(resolve => setTimeout(resolve, 500));
}

module.exports = {
  solveCaptcha,
  getCaptchaSiteKey,
  injectCaptchaToken
};

