require("dotenv").config({ path: require("path").join(process.env.HOME, "mywebsite", ".env") });
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const crypto = require("crypto");                                       
const { ReosGuard } = require("reos-guard.cjs");

const WEB_DIR = path.join(process.env.HOME, "mywebsite");
const BUILD_DIR = path.join(WEB_DIR, "builds");                         
const DB_PATH = path.join(WEB_DIR, "users.json");
const CLIENTS_TXT_PATH = path.join(WEB_DIR, "clients.txt");             
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET || "6LfvUJEtAAAAAEBMaqt07UAWRYpcKMwixXMmajpH";
const RUST_SEARCH_HOST = process.env.RUST_SEARCH_HOST || "127.0.0.1";   
const RUST_SEARCH_PORT = process.env.RUST_SEARCH_PORT || 5000;
const EMAILS_DB = path.join(WEB_DIR, "emails.json");
const FORMS_DB = path.join(WEB_DIR, "forms.json");
const RESPONSES_DB = path.join(WEB_DIR, "form_responses.json");

const authorizationCodes = new Map();                                   
const reos = new ReosGuard({
    secretKey: process.env.REOS_SECRET_KEY || "d8a1ee18db162f4ec43d709043a4645bc9bef4ba4d0a42a405ac726165eb6fac",
    difficulty: 5,
    maxRisk: 60
});

if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
}

function readJsonDb(filePath) {
    if (!fs.existsSync(filePath)) return {};
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
    } catch (e) {
        return {};
    }
}

function writeJsonDb(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4), "utf8");
}

function getEmailsDb() {
    return readJsonDb(EMAILS_DB);
}

function getClientsFromTxt() {
    const clients = {};
    if (fs.existsSync(CLIENTS_TXT_PATH)) {
        const fileContent = fs.readFileSync(CLIENTS_TXT_PATH, "utf8");
        const lines = fileContent.split(/\r?\n/);
        for (let line of lines) {
            line = line.trim();
            if (line && !line.startsWith("#")) {
                const parts = line.split("|");
                if (parts.length >= 3) {
                    const cId = parts[0].trim();
                    const cSecret = parts[1].trim();
                    const cRedirect = parts[2].trim();
                    const cOwner = parts[3] ? parts[3].trim() : "system";
                    clients[cId] = { secret: cSecret, redirectUri: cRedirect, owner: cOwner };
                }
            }
        }
    } else {
        const defaultData = "sample_app_id|sample_app_secret|https://jwt.io|system\ngoogle_client_id|google_secret_key_123|https://www.google.com|system\n";
        fs.writeFileSync(CLIENTS_TXT_PATH, defaultData);
        clients["sample_app_id"] = { secret: "sample_app_secret", redirectUri: "https://jwt.io", owner: "system" };
        clients["google_client_id"] = { secret: "google_secret_key_123", redirectUri: "https://www.google.com", owner: "system" };
    }
    return clients;
}

function saveClientsToTxt(clientsObj) {
    let lines = [];
    for (const [id, data] of Object.entries(clientsObj)) {
        lines.push(`${id}|${data.secret}|${data.redirectUri}|${data.owner || "system"}`);
    }
    fs.writeFileSync(CLIENTS_TXT_PATH, lines.join("\n") + "\n");
}

function handleBuildRequest(req, res) {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
        try {
            const { html, kotlin, java, gradle } = JSON.parse(body);
            const buildId = "app_" + Date.now();
            const appFolder = path.join(BUILD_DIR, buildId);
            const srcDir = path.join(appFolder, "src", "com", "amake", "generated");
            const assetsDir = path.join(appFolder, "assets");
            const binDir = path.join(appFolder, "bin");

            fs.mkdirSync(srcDir, { recursive: true });
            fs.mkdirSync(assetsDir, { recursive: true });
            fs.mkdirSync(binDir, { recursive: true });

            fs.writeFileSync(path.join(assetsDir, "index.html"), html || "<h1>Amake App</h1>");
            fs.writeFileSync(path.join(appFolder, "MainActivity.kt"), kotlin || "");
            fs.writeFileSync(path.join(appFolder, "Helper.java"), java || "");
            fs.writeFileSync(path.join(appFolder, "build.gradle"), gradle || "");

            const manifestContent = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.amake.app${Date.now()}"
    android:versionCode="1"
    android:versionName="1.0">
    <uses-permission android:name="android.permission.INTERNET" />
    <application android:label="Amake App" android:allowBackup="true">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;
            fs.writeFileSync(path.join(appFolder, "AndroidManifest.xml"), manifestContent);

            const mainActivityJava = `package com.example.${Date.now()};
import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.setWebViewClient(new WebViewClient());
        webView.loadUrl("file:///android_asset/index.html");
        setContentView(webView);
    }
}`;
            fs.writeFileSync(path.join(srcDir, "MainActivity.java"), mainActivityJava);

            const { execSync } = require("child_process");
            const unsignedApk = path.join(appFolder, "app-unsigned.apk");
            const finalApk = path.join(appFolder, "app-release.apk");
            const finalAab = path.join(appFolder, "app-release.aab");

            try {
                execSync(`aapt package -f -m -J "${binDir}" -M "${appFolder}/AndroidManifest.xml" -S "${appFolder}" -A "${assetsDir}" -I "$ANDROID_HOME/platforms/android-30/android.jar" -F "${unsignedApk}"`, { stdio: 'ignore' });
                execSync(`ecj -d "${binDir}" "${srcDir}/MainActivity.java"`, { stdio: 'ignore' });
                execSync(`dx --dex --output="${binDir}/classes.dex" "${binDir}"`, { stdio: 'ignore' });
                execSync(`cd "${binDir}" && aapt add "${unsignedApk}" classes.dex`, { stdio: 'ignore' });
                execSync(`apksigner sign --key debug.pk8 --cert debug.x509.pem --out "${finalApk}" "${unsignedApk}"`, { stdio: 'ignore' });
            } catch (cmdErr) {
                const fallbackApkTemplate = path.join(__dirname, "base-wrapper.apk");
                if (fs.existsSync(fallbackApkTemplate)) {
                    fs.copyFileSync(fallbackApkTemplate, finalApk);
                } else {
                    execSync(`cd "${assetsDir}" && zip -0 -r "${finalApk}" .`);
                }
            }

            fs.copyFileSync(finalApk, finalAab);

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                status: "success",
                apkUrl: `/builds/${buildId}/app-release.apk`,
                aabUrl: `/builds/${buildId}/app-release.aab`
            }));
        } catch (e) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: e.message }));
        }
    });
}

function proxyToRust(searchQuery, res) {
    const rustOptions = {
        hostname: RUST_SEARCH_HOST,
        port: RUST_SEARCH_PORT,
        path: `/api/search?q=${encodeURIComponent(searchQuery)}`,
        method: "GET"
    };

    const rustReq = http.request(rustOptions, (rustRes) => {
        let rustBody = "";
        rustRes.on("data", chunk => { rustBody += chunk; });
        rustRes.on("end", () => {
            res.writeHead(rustRes.statusCode, {
                "Content-Type": rustRes.headers["content-type"] || "text/html; charset=utf-8",
                "Content-Length": Buffer.byteLength(rustBody)
            });
            res.end(rustBody);
        });
    });

    rustReq.on("error", (err) => {
        console.error("[❌ Rust Search Sync Error]:", err.message);
        res.writeHead(502, { "Content-Type": "text/html" });
        res.end("<h1>502 Bad Gateway</h1><p>Search service unavailable.</p>");
    });

    rustReq.end();
}

function proxyCrawlToRust(body, res) {
    const rustOptions = {
        hostname: RUST_SEARCH_HOST,
        port: RUST_SEARCH_PORT,
        path: "/crawl",
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
        }
    };

    const rustReq = http.request(rustOptions, (rustRes) => {
        let rustBody = "";
        rustRes.on("data", chunk => { rustBody += chunk; });
        rustRes.on("end", () => {
            res.writeHead(rustRes.statusCode, { "Content-Type": "application/json" });
            res.end(rustBody);
        });
    });

    rustReq.on("error", (err) => {
        console.error("[❌ Rust Crawler Sync Error]:", err.message);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Crawler service unavailable" }));
    });

    rustReq.write(body);
    rustReq.end();
}

async function handleAuthWorkflow(formData, res, req) {
    const action = formData.auth_action || "login";
    const userIn = formData.username ? formData.username.trim() : "";
    const passIn = formData.password ? formData.password.trim() : "";
    const reosToken = formData.reos_token || "";

    if (!userIn || !passIn) {
        res.writeHead(400, { "Content-Type": "text/html" });
        return res.end("<h3>Username and Password are required.</h3><a href=\"/login.html\">Back to Login</a>");
    }

    const remoteIp = req.socket.remoteAddress;
    const result = await reos.verifyToken(reosToken, "", remoteIp);

    if (!result.success) {
        res.writeHead(403, { "Content-Type": "text/html" });
        return res.end(`<h3>Access Blocked</h3><p>[ReosGuard] ${result.reason}</p><a href="/login.html">Try Again</a>`);
    }

    if (!fs.existsSync(DB_PATH) || fs.readFileSync(DB_PATH, "utf8").trim() === "") {
        fs.writeFileSync(DB_PATH, JSON.stringify({ "reos_user": { password: "password123", picture: "https://ui-avatars.com/api/?name=reos_user&background=2563eb&color=fff" } }, null, 4));
    }

    let users = {};
    try { users = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch (e) { users = {}; }

    const defaultPic = "https://ui-avatars.com/api/?name=" + encodeURIComponent(userIn) + "&background=2563eb&color=fff";

    if (action === "register") {
        if (users[userIn]) {
            res.writeHead(400, { "Content-Type": "text/html" });
            return res.end("<h3>Username already registered!</h3><a href=\"/login.html\">Try Another</a>");
        }

        users[userIn] = { password: passIn, picture: defaultPic, type: "reos" };
        fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 4));

        const redirectUrl = `/pg2.html?user=${encodeURIComponent(userIn)}&pic=${encodeURIComponent(defaultPic)}`;
        res.writeHead(302, { "Location": redirectUrl });
        return res.end();
    } else {
        const storedUser = users[userIn];
        const storedPass = typeof storedUser === "object" ? storedUser.password : storedUser;
        const userPic = typeof storedUser === "object" && storedUser.picture ? storedUser.picture : defaultPic;

        if (storedUser && storedPass === passIn) {
            const redirectUrl = `/pg2.html?user=${encodeURIComponent(userIn)}&pic=${encodeURIComponent(userPic)}`;
            res.writeHead(302, { "Location": redirectUrl });
            return res.end();
        } else {
            res.writeHead(401, { "Content-Type": "text/html" });
            return res.end("<h3>Access Denied</h3><p>Invalid credentials or user not registered.</p><a href=\"/login.html\">Back to Login</a>");
        }
    }
}

function handleDeleteAccount(req, res) {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
        try {
            const { username, password, isGoogle } = JSON.parse(body || "{}");
            const cleanUser = (username || "").trim();

            if (!cleanUser) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ success: false, message: "Username is required." }));
            }

            if (!fs.existsSync(DB_PATH)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ success: false, message: "Database file missing." }));
            }

            let users = {};
            try { users = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch (e) { users = {}; }

            const targetKey = Object.keys(users).find(k => k.trim().toLowerCase() === cleanUser.toLowerCase()) || cleanUser;
            const isGoogleAccount = isGoogle || cleanUser.toLowerCase().endsWith("@gmail.com");

            if (!isGoogleAccount) {
                if (!password) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ success: false, message: "Password is required for Reos accounts." }));
                }
                const storedUser = users[targetKey];
                const storedPass = typeof storedUser === "object" ? storedUser.password : storedUser;
                if (!storedUser || storedPass !== password) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ success: false, message: "Invalid username or password." }));
                }
            }

            Object.keys(users).forEach(k => {
                if (k.trim().toLowerCase() === cleanUser.toLowerCase()) {
                    delete users[k];
                }
            });

            fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 4), "utf8");

            const clients = getClientsFromTxt();
            let clientsUpdated = false;
            for (const [id, data] of Object.entries(clients)) {
                if (data.owner && data.owner.trim().toLowerCase() === cleanUser.toLowerCase()) {
                    delete clients[id];
                    clientsUpdated = true;
                }
            }
            if (clientsUpdated) {
                saveClientsToTxt(clients);
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ success: true, message: "Account deleted successfully from disk." }));
        } catch (err) {
            console.error("Delete Error:", err);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ success: false, message: "Server error during account deletion." }));
        }
    });
}

const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    const rawUrl = req.url || "/";
    const [parsedUrl, queryString] = rawUrl.split("?");
    const queryParams = querystring.parse(queryString || "");

    if (parsedUrl === "/oauth/authorize" || parsedUrl === "/oauth/auth") {
        const clientId = queryParams.client_id;
        const redirectUri = queryParams.redirect_uri;
        const state = queryParams.state || "";

        if (!clientId || !redirectUri) {
            res.writeHead(400, { "Content-Type": "text/html" });
            return res.end("<h3>Missing required OAuth parameters: client_id and redirect_uri.</h3>");
        }

        const clients = getClientsFromTxt();
        const client = clients[clientId];

        if (!client) {
            res.writeHead(400, { "Content-Type": "text/html" });
            return res.end("<h3>Invalid Client ID</h3>");
        }

        if (req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                const formData = querystring.parse(body);
                const username = (formData.username || "").trim();
                const password = (formData.password || "").trim();

                let users = {};
                try { users = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch (e) { users = {}; }

                const storedUser = users[username];
                const storedPass = typeof storedUser === "object" ? storedUser.password : storedUser;

                if (!storedUser || storedPass !== password) {
                    res.writeHead(401, { "Content-Type": "text/html" });
                    return res.end(`
                        <script>
                            alert("Invalid username or password. Please try again.");
                            window.history.back();
                        </script>
                    `);
                }

                const authCode = crypto.randomBytes(16).toString("hex");
                authorizationCodes.set(authCode, {
                    clientId,
                    redirectUri,
                    user: username,
                    expiresAt: Date.now() + 600000
                });

                const targetUrl = new URL(redirectUri);
                targetUrl.searchParams.set("code", authCode);
                if (state) targetUrl.searchParams.set("state", state);

                res.writeHead(302, { "Location": targetUrl.toString() });
                return res.end();
            });
            return;
        }

        if (req.method === "GET") {
            res.writeHead(200, { "Content-Type": "text/html" });
            return res.end(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Sign in with Reos Account</title>
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                        .login-card { background: #1e293b; padding: 32px; border-radius: 12px; width: 100%; max-width: 380px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); border: 1px solid #334155; }
                        .logo { font-size: 24px; font-weight: bold; color: #3b82f6; text-align: center; margin-bottom: 8px; }
                        .subtitle { font-size: 14px; color: #94a3b8; text-align: center; margin-bottom: 24px; }
                        .app-info { background: #0f172a; padding: 12px; border-radius: 8px; font-size: 13px; color: #cbd5e1; margin-bottom: 20px; border-left: 4px solid #3b82f6; }
                        label { font-size: 12px; font-weight: 600; text-transform: uppercase; color: #94a3b8; display: block; margin-bottom: 6px; }
                        input { width: 100%; padding: 10px; margin-bottom: 16px; border: 1px solid #475569; background: #0f172a; color: #fff; border-radius: 6px; box-sizing: border-box; }
                        input:focus { border-color: #3b82f6; outline: none; }
                        button { width: 100%; background: #2563eb; color: white; border: none; padding: 12px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 14px; }
                        button:hover { background: #1d4ed8; }
                        .footer { font-size: 11px; color: #64748b; text-align: center; margin-top: 20px; }
                    </style>
                </head>
                <body>
                    <div class="login-card">
                        <div class="logo">Reos Security</div>
                        <div class="subtitle">OAuth 2.0 Identity Service</div>

                        <div class="app-info">
                            <strong>${clientId}</strong> requests access to your Reos Account.
                        </div>

                        <form method="POST" action="/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}">
                            <label>Username</label>
                            <input type="text" name="username" placeholder="Enter Reos Username" required autocomplete="username">

                            <label>Password</label>
                            <input type="password" name="password" placeholder="Enter Password" required autocomplete="current-password">

                            <button type="submit">Authorize & Continue</button>
                        </form>
                        <div class="footer">Protected by Reos-Guard Tiered Intelligence</div>
                    </div>
                </body>
                </html>
            `);
        }
    }

    if (parsedUrl === "/oauth/token" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            const params = querystring.parse(body);
            const grantType = params.grant_type;
            const clientId = params.client_id;
            const clientSecret = params.client_secret;

            const clients = getClientsFromTxt();
            const client = clients[clientId];

            if (!client || client.secret !== clientSecret) {
                res.writeHead(401, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "invalid_client", error_description: "Invalid client credentials." }));
            }

            if (grantType === "authorization_code") {
                const code = params.code;
                const authData = authorizationCodes.get(code);

                if (!authData || authData.clientId !== clientId || Date.now() > authData.expiresAt) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid or expired authorization code." }));
                }

                authorizationCodes.delete(code);
            } else if (grantType !== "client_credentials") {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "unsupported_grant_type", error_description: "Grant type not supported." }));
            }

            const token = crypto.randomBytes(24).toString("hex");
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                access_token: token,
                token_type: "Bearer",
                expires_in: 3600
            }));
        });
        return;
    }

    if (parsedUrl === "/oauth/userinfo" && (req.method === "GET" || req.method === "POST")) {
        const authHeader = req.headers["authorization"];
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            res.writeHead(401, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "unauthorized" }));
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
            sub: "user_" + crypto.randomBytes(4).toString("hex"),
            name: "Reos User",
            email: "user@reos.internal"
        }));
    }

    // --- REOS EMAIL SERVICE ENDPOINTS ---
    if (parsedUrl === "/api/email/create" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const { username, emailPrefix } = JSON.parse(body);
                if (!username || !emailPrefix) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ success: false, message: "Missing username or emailPrefix." }));
                }

                const cleanEmail = `${emailPrefix.trim().toLowerCase()}@reostech`;
                const db = getEmailsDb();

                if (db[cleanEmail]) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ success: false, message: "This @reostech email address is already taken." }));
                }

                db[cleanEmail] = {
                    email: cleanEmail,
                    owner: username.trim(),
                    createdAt: new Date().toISOString(),
                    inbox: []
                };

                writeJsonDb(EMAILS_DB, db);
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ success: true, email: cleanEmail }));
            } catch (err) {
                res.writeHead(500, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ success: false, message: "Server error parsing request." }));
            }
        });
        return;
    }

    if (parsedUrl === "/api/email/list" && req.method === "GET") {
        const currentUser = queryParams.user ? queryParams.user.trim() : null;
        if (!currentUser) {
            res.writeHead(400, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ success: false, message: "Missing ?user= parameter." }));
        }

        const db = getEmailsDb();
        const userEmails = Object.values(db).filter(e => e.owner && e.owner.toLowerCase() === currentUser.toLowerCase());

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, emails: userEmails }));
    }

    if (parsedUrl === "/api/email/send" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const { recipient, sender, subject, message } = JSON.parse(body);
                const db = getEmailsDb();

                if (!db[recipient]) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ success: false, message: "Recipient @reostech address does not exist." }));
                }

                db[recipient].inbox.push({
                    id: "msg_" + Math.random().toString(36).substr(2, 9),
                    sender: sender || "Anonymous",
                    subject: subject || "No Subject",
                    message: message || "",
                    receivedAt: new Date().toISOString()
                });

                writeJsonDb(EMAILS_DB, db);
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ success: true, message: "Email sent successfully!" }));
            } catch (err) {
                res.writeHead(500, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ success: false, message: "Failed to send email." }));
            }
        });
        return;
    }

    // ==========================================
    // REOS FORMS SYSTEM ENDPOINTS
    // ==========================================
    if (parsedUrl === "/api/forms/save" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            try {
                const formData = JSON.parse(body);
                const { id, userId, title, description, fields } = formData;

                if (!id || !userId || !fields) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ success: false, message: "Missing required form fields or userId." }));
                }

                const forms = readJsonDb(FORMS_DB);
                forms[id] = {
                    id,
                    userId: userId.trim(),
                    title: title || "Untitled Form",
                    description: description || "",
                    fields,
                    updatedAt: new Date().toISOString()
                };

                writeJsonDb(FORMS_DB, forms);

                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ success: true, form: forms[id], message: "Form saved successfully!" }));
            } catch (e) {
                res.writeHead(500, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ success: false, message: "Error saving form schema." }));
            }
        });
        return;
    }

    if (parsedUrl.startsWith("/api/forms/get/") && req.method === "GET") {
        const formId = parsedUrl.replace("/api/forms/get/", "").trim();
        const forms = readJsonDb(FORMS_DB);

        if (forms[formId]) {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ success: true, form: forms[formId] }));
        } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ success: false, message: "Form not found." }));
        }
    }

    if (parsedUrl.startsWith("/api/forms/submit/") && req.method === "POST") {
        const formId = parsedUrl.replace("/api/forms/submit/", "").trim();
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            try {
                const submissionData = JSON.parse(body);
                const formsDb = readJsonDb(FORMS_DB);
                const targetForm = formsDb[formId];

                if (!targetForm) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ success: false, message: "Form not found." }));
                }

                // 1. Save Form Response
                const responsesDb = readJsonDb(RESPONSES_DB);
                if (!responsesDb[formId]) {
                    responsesDb[formId] = [];
                }

                const newSubmission = {
                    submissionId: "sub_" + Math.random().toString(36).substr(2, 9),
                    submittedAt: new Date().toISOString(),
                    answers: submissionData.answers || {}
                };
                responsesDb[formId].push(newSubmission);
                writeJsonDb(RESPONSES_DB, responsesDb);

                // 2. Trigger Automatic @reostech Email Notification to Form Owner
                if (targetForm.userId) {
                    const emailsDb = getEmailsDb();
                    const ownerEmailKey = Object.keys(emailsDb).find(
                        key => emailsDb[key].owner && emailsDb[key].owner.toLowerCase() === targetForm.userId.toLowerCase()
                    );

                    if (ownerEmailKey) {
                        let answerSummary = "";
                        targetForm.fields.forEach(f => {
                            let ans = submissionData.answers[f.id];
                            if (Array.isArray(ans)) ans = ans.join(', ');
                            answerSummary += `- ${f.label}: ${ans || 'No answer'}\n`;
                        });

                        emailsDb[ownerEmailKey].inbox.push({
                            id: "msg_" + Math.random().toString(36).substr(2, 9),
                            sender: "notifications@reostech",
                            subject: `New Submission: ${targetForm.title}`,
                            message: `You received a new response for your form "${targetForm.title}".\n\nSubmitted Answers:\n${answerSummary}`,
                            receivedAt: new Date().toISOString()
                        });
                        writeJsonDb(EMAILS_DB, emailsDb);
                    }
                }

                res.writeHead(201, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ success: true, message: "Response recorded successfully!" }));
            } catch (e) {
                res.writeHead(500, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ success: false, message: "Error recording submission." }));
            }
        });
        return;
    }

    if (parsedUrl.startsWith("/api/forms/responses/") && req.method === "GET") {
        const formId = parsedUrl.replace("/api/forms/responses/", "").trim();
        const currentUser = queryParams.user ? queryParams.user.trim() : null;

        const forms = readJsonDb(FORMS_DB);
        const form = forms[formId];

        if (!form) {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ success: false, message: "Form not found." }));
        }

        if (form.userId.toLowerCase() !== (currentUser || "").toLowerCase()) {
            res.writeHead(403, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ success: false, message: "Unauthorized: You do not own this form." }));
        }

        const responsesDb = readJsonDb(RESPONSES_DB);
        const submissions = responsesDb[formId] || [];

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, form, submissions }));
    }

    if (parsedUrl === "/api/chat" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
            const parsedForm = querystring.parse(body);
            const userPrompt = parsedForm.message || "";
            if (!userPrompt) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "No prompt provided" }));
            }
            try {
                const { GoogleGenAI } = require("@google/genai");
                const ai = new GoogleGenAI();
                const response = await ai.models.generateContent({
                    model: "gemini-3.8-flash",
                    contents: userPrompt
                });
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ reply: response.text }));
            } catch (err) {
                console.error("Gemini API Error:", err);
                res.writeHead(500, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Failed to generate AI response" }));
            }
        });
        return;
    }

    if (parsedUrl === "/api/fetch-url" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            try {
                const { url } = JSON.parse(body);
                if (!url) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "URL missing" }));
                }
                const fetchClient = url.startsWith("https") ? https : http;
                fetchClient.get(url, (webRes) => {
                    let pageData = "";
                    webRes.on("data", chunk => { pageData += chunk; });
                    webRes.on("end", () => {
                        const cleanText = pageData.replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").slice(0, 5000);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ text: cleanText }));
                    });
                }).on("error", () => {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Unable to fetch webpage content" }));
                });
            } catch (e) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid JSON body" }));
            }
        });
        return;
    }

    if (parsedUrl === "/api/user/delete" && req.method === "POST") {
        return handleDeleteAccount(req, res);
    }

    if (parsedUrl === "/reos-guard.js" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        return res.end(ReosGuard.clientScript);
    }

    if (parsedUrl === "/api/reos/challenge" && req.method === "POST") {
        const challenge = reos.generateChallenge(req.socket.remoteAddress);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ challenge }));
    }

    if (parsedUrl === "/amake" || parsedUrl === "/amake.html") {
        const amakePath = path.join(WEB_DIR, "amake.html");
        if (fs.existsSync(amakePath)) {
            res.writeHead(200, { "Content-Type": "text/html" });
            return res.end(fs.readFileSync(amakePath));
        }
    }

    if (parsedUrl === "/api/build" && req.method === "POST") {
        return handleBuildRequest(req, res);
    }

    if (parsedUrl.startsWith("/builds/")) {
        const filePath = path.join(WEB_DIR, parsedUrl);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath);
            const contentType = ext === ".apk"
                ? "application/vnd.android.package-archive"
                : "application/octet-stream";

            res.writeHead(200, {
                "Content-Type": contentType,
                "Content-Disposition": "attachment; filename=\"" + path.basename(filePath) + "\""
            });
            return fs.createReadStream(filePath).pipe(res);
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Requested package binary not found" }));
    }

    if (parsedUrl === "/api/search") {
        if (req.method === "GET") {
            const searchQuery = queryParams.q || queryParams.query || "";
            return proxyToRust(searchQuery, res);
        }

        if (req.method === "POST") {
            let body = "";
            req.on("data", chunk => { body += chunk; });
            req.on("end", () => {
                let searchQuery = queryParams.q || queryParams.query || "";
                if (!searchQuery && body) {
                    try {
                        const parsedBody = JSON.parse(body);
                        searchQuery = parsedBody.query || parsedBody.q || "";
                    } catch (e) {
                        const parsedForm = querystring.parse(body);
                        searchQuery = parsedForm.q || parsedForm.query || "";
                    }
                }
                return proxyToRust(searchQuery, res);
            });
            return;
        }
    }

    if (parsedUrl === "/crawl" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            proxyCrawlToRust(body, res);
        });
        return;
    }

    if (parsedUrl === "/auth/workflow" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            const formData = querystring.parse(body);
            return handleAuthWorkflow(formData, res, req);
        });
        return;
    }

    if (parsedUrl === "/auth/google" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            try {
                const parsed = JSON.parse(body || "{}");
                const token = parsed.token;
                if (!token) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ status: "error", message: "Token missing" }));
                }
                https.get("https://oauth2.googleapis.com/tokeninfo?id_token=" + token, (gRes) => {
                    let gData = "";
                    gRes.on("data", chunk => gData += chunk);
                    gRes.on("end", () => {
                        try {
                            const gPayload = JSON.parse(gData || "{}");
                            if (gPayload.email) {
                                const email = gPayload.email;
                                const picture = gPayload.picture || "";

                                let users = {};
                                try { users = JSON.parse(fs.readFileSync(DB_PATH, "utf8")); } catch (e) { users = {}; }

                                if (typeof users[email] !== "object") {
                                    users[email] = { picture: picture, type: "google" };
                                } else {
                                    users[email].picture = picture;
                                }
                                fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 4));

                                res.writeHead(200, {
                                    "Content-Type": "application/json",
                                    "Set-Cookie": "session=" + encodeURIComponent(email) + "; Path=/; HttpOnly"
                                });
                                return res.end(JSON.stringify({
                                    status: "success",
                                    redirect: "/pg2.html?user=" + encodeURIComponent(email) + "&pic=" + encodeURIComponent(picture)
                                }));
                            } else {
                                res.writeHead(401, { "Content-Type": "application/json" });
                                return res.end(JSON.stringify({ status: "error", message: "Invalid Google Token" }));
                            }
                        } catch (e) {
                            res.writeHead(500, { "Content-Type": "application/json" });
                            return res.end(JSON.stringify({ status: "error", message: "Failed to parse Google response" }));
                        }
                    });
                }).on("error", () => {
                    res.writeHead(500, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ status: "error", message: "Google verification request failed" }));
                });
            } catch (err) {
                res.writeHead(400, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ status: "error", message: "Invalid request payload" }));
            }
        });
        return;
    }

    if (parsedUrl === "/console/add-client" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            const formData = querystring.parse(body);
            const user = formData.user || "system";
            const redirectUri = formData.redirect_uri;

            if (redirectUri) {
                const clients = getClientsFromTxt();
                const newClientId = "client_" + crypto.randomBytes(4).toString("hex");
                const newSecret = "sec_" + crypto.randomBytes(12).toString("hex");

                clients[newClientId] = { secret: newSecret, redirectUri: redirectUri, owner: user };
                saveClientsToTxt(clients);
            }

            res.writeHead(302, { "Location": "/console?user=" + encodeURIComponent(user) });
            return res.end();
        });
        return;
    }

    if (parsedUrl === "/console/add-guard" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            const formData = querystring.parse(body);
            const user = formData.user || "system";
            const websiteUrl = formData.website_url;
            let guardId = "", guardSecret = "";

            if (websiteUrl) {
                const clients = getClientsFromTxt();
                guardId = "guard_" + crypto.randomBytes(4).toString("hex");
                guardSecret = "guard_sec_" + crypto.randomBytes(12).toString("hex");

                clients[guardId] = { secret: guardSecret, redirectUri: websiteUrl, owner: user };
                saveClientsToTxt(clients);
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ status: "success", guardId, guardSecret, redirect: "/console?user=" + encodeURIComponent(user) }));
        });
        return;
    }

    if (parsedUrl === "/console/delete-client" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            const formData = querystring.parse(body);
            const user = formData.user || "system";
            const clientId = formData.client_id;

            if (clientId) {
                const clients = getClientsFromTxt();
                if (clients[clientId]) {
                    delete clients[clientId];
                    saveClientsToTxt(clients);
                }
            }

            res.writeHead(302, { "Location": "/console?user=" + encodeURIComponent(user) });
            return res.end();
        });
        return;
    }

    if (req.method === "GET" && parsedUrl === "/console") {
        const currentUser = queryParams.user ? queryParams.user.trim() : null;

        if (!currentUser) {
            res.writeHead(401, { "Content-Type": "text/html" });
            return res.end("<h3>Access Denied</h3><p>You must log in with an official account to access the console.</p><a href=\"/login.html?next=console.html\">Go to Login</a>");
        }

        const clients = getClientsFromTxt();
        let rowsHtml = "";
        for (const [id, data] of Object.entries(clients)) {
            rowsHtml += `
                <tr style="border-bottom: 1px solid #e2e8f0;">
                    <td style="padding: 12px; font-family: monospace;">${id}</td>
                    <td style="padding: 12px; font-family: monospace; color: #d97706;">${data.secret}</td>
                    <td style="padding: 12px; font-size: 13px;">${data.redirectUri}</td>
                    <td style="padding: 12px; font-size: 13px; font-weight: bold; color: #2563eb;">${data.owner}</td>
                    <td style="padding: 12px;">
                        <form action="/console/delete-client" method="POST" style="margin:0;">
                            <input type="hidden" name="client_id" value="${id}">
                            <input type="hidden" name="user" value="${currentUser}">
                            <button type="submit" style="background: #ef4444; color: white; border: none; padding: 6px 12px; font-size: 12px; border-radius: 4px; cursor: pointer;">Delete</button>
                        </form>
                    </td></tr>
            `;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>Reos Developer Console</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
                    header { background: #ffffff; border-bottom: 1px solid #e2e8f0; padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; }
                    .logo { font-size: 20px; font-weight: 700; color: #2563eb; }
                    .container { max-width: 950px; margin: 40px auto; padding: 0 20px; }
                    .card { background: white; padding: 28px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
                    h2 { margin-top: 0; font-size: 20px; }
                    input { width: 100%; padding: 10px; margin-top: 6px; margin-bottom: 16px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box; }
                    button { background: #2563eb; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; }
                    button:hover { opacity: 0.9; }
                    table { width: 100%; border-collapse: collapse; text-align: left; }
                    th { padding: 12px; border-bottom: 2px solid #cbd5e1; font-size: 13px; color: #64748b; }
                </style>
            </head>
            <body>
                <header>
                    <div class="logo">Reos Developer Console</div>
                    <div>Account: <strong>${currentUser}</strong> | <a href="/login.html?next=console.html" style="color: #64748b; text-decoration: none;">Switch Account</a></div>
                </header>
                <div class="container">
                    <div class="card">
                        <h2>Create OAuth 2.0 Client ID</h2>
                        <form action="/console/add-client" method="POST">
                            <input type="hidden" name="user" value="${currentUser}">
                            <label style="font-size: 14px; font-weight: 500;">Authorized Redirect URI</label>
                            <input type="url" name="redirect_uri" placeholder="https://yourdomain.com/callback" required>
                            <button type="submit">+ Create Credentials</button>
                        </form>
                    </div>
                    <div class="card">
                        <h2>Registered OAuth Apps</h2>
                        <table>
                            <thead>
                                <tr>
                                    <th>Client ID</th>
                                    <th>Client Secret</th>
                                    <th>Redirect URI</th>
                                    <th>Linked Account</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>${rowsHtml}</tbody>
                        </table>
                    </div>
                </div>
            </body>
            </html>
        `);
    }

    let relativeUrl = parsedUrl;
    if (relativeUrl === "/" || relativeUrl === "/index" || relativeUrl === "/index.html") {
        relativeUrl = "/index.html";
    }

    let filePath = path.join(WEB_DIR, relativeUrl);
    let ext = path.extname(filePath);
    let contentType = "text/html";

    if (ext === ".css") contentType = "text/css";
    if (ext === ".js") contentType = "application/javascript";
    if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    if (ext === ".png") contentType = "image/png";
    if (ext === ".apk") contentType = "application/vnd.android.package-archive";
    if (ext === ".exe") contentType = "application/x-msdownload";
    if (ext === ".tar.gz") contentType = "application/gzip";

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("404 Not Found");
        } else {
            res.writeHead(200, { "Content-Type": contentType });
            res.end(content);
        }
    });
});

server.listen(8085, "0.0.0.0", () => {
    console.log("⚡ Reos Server running on Port 8085 with Email & Form System enabled!");
});
