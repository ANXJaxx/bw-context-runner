const axios = require('axios');
const { siteUrl, getCredentialsForSite } = require('./load-config');

function wpClient(site) {
    const { username, appPassword } = getCredentialsForSite(site);
    const auth = Buffer.from(username + ':' + appPassword).toString('base64');
    return axios.create({
        baseURL: siteUrl(site) + '/wp-json',
        headers: {
            'Authorization': 'Basic ' + auth,
            'Content-Type': 'application/json',
        },
        timeout: 60000,
    });
}

function logAxiosError(err) {
    if (err.response) {
        console.error('HTTP ' + err.response.status + ' ' + err.response.statusText);
        console.error('Body:', JSON.stringify(err.response.data, null, 2).slice(0, 2000));
    } else {
        console.error(err.message);
    }
}

module.exports = { wpClient, logAxiosError };
