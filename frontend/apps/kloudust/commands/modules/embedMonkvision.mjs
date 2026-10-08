/**
 * Embeds MonkVision dashboards. Logs into MonkVision with the loginapp JWT
 * and hands that login to the MonkVision iframe when it asks.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

import {tkmlogin} from "../../3p/tkmlogin.mjs";
import {loginmanager} from "../../js/loginmanager.mjs";

const AUTH_REQUEST = "monkvision:embed-auth-request", AUTH_RESPONSE = "monkvision:embed-auth-response",
    LOGOUT_REQUEST = "monkvision:embed-logout", IFRAME_ID = "monkvision";
let settings, loginKey, origin;

const HTML_TEMPLATE = monkvisionFrontendURL => `
<style>
html, body {
    height: 100%;
    margin: 0;
    padding: 0;
}

div#body {
    width: 100%;
    height: 100vh;
    margin: 0;
    padding: 0;
    overflow: hidden;
}

iframe#${IFRAME_ID} {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
}
</style>

<div id="body">
    <iframe
        id="${IFRAME_ID}"
        src="${monkvisionFrontendURL}">
    </iframe>
</div>
`;

async function init(embeddedApp) {
    settings = embeddedApp.settings; origin = new URL(settings.FRONTEND_URL).origin;
    loginKey = APP_CONSTANTS.EMBEDDED_APP_LOGIN_KEY_PREFIX+embeddedApp.name;
    loginmanager.addLoginListener(_login);
    loginmanager.addLogoutListener(_logout);
}

async function getHTML(_formJSON, _cmdmanager) {
    window.addEventListener("message", _authBridge);    // page loads clear window listeners, re-adding the same function is a no-op
    return HTML_TEMPLATE(settings.FRONTEND_URL);
}

async function _login(resultURL) {
    $$.libsession.remove(loginKey);
    const loginResult = await tkmlogin.verify(`${settings.API_LOGIN}?op=verify&noonce=true`, resultURL);
    if (!loginResult?.response?.result) {LOG.error("MonkVision login failed."); return;}
    const loginURL = new URL(loginResult.url);
    $$.libsession.set(loginKey, {...loginResult, url: `${loginURL.origin}${loginURL.pathname}`});
}

const _logout = _ => document.getElementById(IFRAME_ID)?.contentWindow?.postMessage({type: LOGOUT_REQUEST}, origin);

function _authBridge(event) {
    const iframe = document.getElementById(IFRAME_ID);
    if (event.origin !== origin || event.source !== iframe?.contentWindow || event.data?.type !== AUTH_REQUEST) return;
    const loginResult = $$.libsession.get(loginKey);    // session returns a proxy which can't be posted, so copy it
    if (loginResult) iframe.contentWindow.postMessage({type: AUTH_RESPONSE, loginResponse: JSON.parse(JSON.stringify(loginResult))}, origin);
}

export const embedMonkvision = {init, getHTML};
