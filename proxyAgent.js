const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

function normalizeHttpProxyUrl(raw) {
    if (!raw || typeof raw !== 'string') return '';

    let value = raw.trim();
    if (!value) return '';
    if (!/^[a-z]+:\/\//i.test(value)) value = `http://${value}`;

    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Proxy URL must use http:// or https://');
    }

    parsed.hash = '';
    return parsed.toString();
}

function createProxyAgent(targetUrl, proxyUrl) {
    const normalizedProxyUrl = normalizeHttpProxyUrl(proxyUrl);
    if (!normalizedProxyUrl) return null;

    const target = new URL(targetUrl);
    return target.protocol === 'https:'
        ? new HttpsProxyAgent(normalizedProxyUrl)
        : new HttpProxyAgent(normalizedProxyUrl);
}

module.exports = {
    normalizeHttpProxyUrl,
    createProxyAgent
};
