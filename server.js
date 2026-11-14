// --- START OF FILE server.js ---

try {
    require("dotenv").config();
} catch {
    // dotenv is optional on Render when environment variables are set in the dashboard
}

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const crypto = require("crypto");
const dns = require("dns");
const net = require("net");

const parsedPort = Number(process.env.PORT);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 8085;
const WEB_DIR = process.env.WEB_DIR ? path.resolve(process.env.WEB_DIR) : __dirname;

// Hardcoded fallback credentials (can still be overridden via Render Environment Variables)
const DEFAULT_GEMINI_API_KEY = "AQ.Ab8RN6I7kjna51_D_q2pEY07gwsd9KVKZCqAH3RPkFTdiB0Yvw";
const DEFAULT_RECAPTCHA_SITE_KEY = "6LeD-h8uAAAAAHsY8YD4gsXy7_T1sgmuKKrXm8BX";
const DEFAULT_RECAPTCHA_SECRET_KEY = "6LeD-h8uAAAAACH2yKsEzsc-TVV8U-WusqUHP_q7";

let DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : WEB_DIR;
try {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (err) {
    console.warn(`[⚠️ Storage] Cannot write to DATA_DIR (${DATA_DIR}): ${err.message}. Falling back to /tmp/reos-data`);
    DATA_DIR = "/tmp/reos-data";
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

const DB_PATH = path.join(DATA_DIR, "users.json");
const CLIENTS_TXT_PATH = path.join(DATA_DIR, "clients.txt");
const EMAILS_DB = path.join(DATA_DIR, "emails.json");
const FORMS_DB = path.join(DATA_DIR, "forms.json");
const RESPONSES_DB = path.join(DATA_DIR, "form_responses.json");

const RECAPTCHA_SECRET_KEY = (process.env.RECAPTCHA_SECRET_KEY || DEFAULT_RECAPTCHA_SECRET_KEY).trim();
const RECAPTCHA_SITE_KEY = (process.env.RECAPTCHA_SITE_KEY || DEFAULT_RECAPTCHA_SITE_KEY).trim();
const parsedMinScore = Number(process.env.RECAPTCHA_MIN_SCORE);
const RECAPTCHA_MIN_SCORE =
    process.env.RECAPTCHA_MIN_SCORE !== undefined &&
    process.env.RECAPTCHA_MIN_SCORE !== "" &&
    Number.isFinite(parsedMinScore)
        ? parsedMinScore
        : 0.5;
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || "").trim();
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB limit
const MAX_FETCH_BYTES = 100 * 1024; // 100 KB limit for URL fetcher

const BLOCKED_STATIC_FILES = new Set([
    "users.json",
    "clients.txt",
    "emails.json",
    "forms.json",
    "form_responses.json",
    "package.json",
    "package-lock.json",
    ".env",
    path.basename(__filename).toLowerCase()
]);

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const authorizationCodes = new Map();
const accessTokens = new Map();

function hasOwn(obj, key) {
    return (
        Boolean(obj) &&
        typeof obj === "object" &&
        typeof key === "string" &&
        !RESERVED_KEYS.has(key) &&
        Object.prototype.hasOwnProperty.call(obj, key)
    );
}

function isSafeKey(key) {
    return typeof key === "string" && key.length > 0 && !RESERVED_KEYS.has(key);
}

function escapeHtml(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function sanitizePipeField(str) {
    return String(str || "").replace(/[\r\n|]/g, "").trim();
}

function stripWrappingQuotes(value) {
    const trimmed = String(value || "").trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

function isRecaptchaEnabled() {
    return Boolean(RECAPTCHA_SECRET_KEY && RECAPTCHA_SITE_KEY);
}

function isHttpsRequest(req) {
    const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    return proto === "https" || Boolean(req.socket?.encrypted);
}

function buildSessionCookie(req, username) {
    const parts = [
        `session=${encodeURIComponent(username)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax"
    ];
    if (isHttpsRequest(req)) {
        parts.push("Secure");
    }
    return parts.join("; ");
}

function pruneExpiredTokens(map) {
    const now = Date.now();
    for (const [k, v] of map.entries()) {
        if (!v || now > v.expiresAt) {
            map.delete(k);
        }
    }
}

function isValidHttpUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

function isRedirectUriAllowed(registeredRaw, requestedUrl) {
    if (!registeredRaw || typeof registeredRaw !== "string") return false;
    const candidates = registeredRaw.split(",").map(s => s.trim()).filter(Boolean);
    for (const candidate of candidates) {
        let regUrl;
        try {
            regUrl = new URL(candidate);
        } catch {
            continue;
        }
        if (regUrl.origin !== requestedUrl.origin) continue;
        if (regUrl.pathname === "/" || regUrl.pathname === "") {
            return true;
        }
        const normalizedRegPath = regUrl.pathname.replace(/\/+$/, "");
        const normalizedReqPath = requestedUrl.pathname.replace(/\/+$/, "");
        if (
            normalizedReqPath === normalizedRegPath ||
            normalizedReqPath.startsWith(normalizedRegPath + "/")
        ) {
            return true;
        }
    }
    return false;
}

function isPrivateIpv4(ip) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
        return true;
    }
    const [a, b, c] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
    if (a >= 224) return true; // multicast & reserved
    return false;
}

function isPrivateIp(ip) {
    const normalized = String(ip || "").trim().toLowerCase().split("%")[0];
    const family = net.isIP(normalized);
    if (!family) return true;
    if (family === 4) return isPrivateIpv4(normalized);

    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) {
        const mapped = normalized.slice(7);
        if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped);
        const hexParts = mapped.split(":");
        if (hexParts.length === 2) {
            const hi = parseInt(hexParts[0], 16);
            const lo = parseInt(hexParts[1], 16);
            if (!Number.isNaN(hi) && !Number.isNaN(lo)) {
                const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
                return isPrivateIpv4(v4);
            }
        }
        return true;
    }
    const firstWord = parseInt(normalized.split(":")[0] || "0", 16);
    if ((firstWord & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((firstWord & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((firstWord & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
}

function safeLookup(hostname, options, callback) {
    if (typeof options === "function") {
        callback = options;
        options = {};
    }
    const ipFamily = net.isIP(hostname);
    if (ipFamily) {
        if (isPrivateIp(hostname)) {
            return callback(new Error("Access to private or loopback IP addresses is blocked"));
        }
        if (options && options.all) {
            return callback(null, [{ address: hostname, family: ipFamily }]);
        }
        return callback(null, hostname, ipFamily);
    }

    dns.lookup(hostname, { all: true }, (err, addresses) => {
        if (err) return callback(err);
        if (!Array.isArray(addresses) || addresses.length === 0) {
            return callback(new Error("Host resolution returned no addresses"));
        }
        for (const entry of addresses) {
            if (isPrivateIp(entry.address)) {
                return callback(new Error("Target host resolves to a blocked private or internal IP"));
            }
        }
        if (options && options.all) {
            return callback(null, addresses);
        }
        return callback(null, addresses[0].address, addresses[0].family);
    });
}

function getGeminiApiKey() {
    const candidates = [
        process.env.GEMINI_API_KEY,
        process.env.GOOGLE_API_KEY,
        process.env.VERTEX_API_KEY,
        process.env.GEMINI_AUTH_KEY,
        DEFAULT_GEMINI_API_KEY
    ];
    for (const candidate of candidates) {
        const cleaned = stripWrappingQuotes(candidate);
        if (cleaned) return cleaned;
    }
    return "";
}

function extractGeminiRestText(data) {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return "";
    const answer = parts
        .filter(part => part && typeof part.text === "string" && !part.thought)
        .map(part => part.text)
        .join("");
    if (answer) return answer;
    return parts
        .filter(part => part && typeof part.text === "string")
        .map(part => part.text)
        .join("");
}

function isSurfaceOrAuthError(err) {
    const status = Number(err?.status || err?.code);
    const msg = String(err?.message || "");
    const lowerMsg = msg.toLowerCase();
    const apiStatus = String(err?.apiStatus || "");
    return (
        status === 401 ||
        status === 403 ||
        (status === 400 && (msg.includes("API_KEY_INVALID") || lowerMsg.includes("api key not valid"))) ||
        apiStatus === "UNAUTHENTICATED" ||
        apiStatus === "PERMISSION_DENIED" ||
        msg.includes("API_KEY_INVALID") ||
        msg.includes("API_KEY_SERVICE_BLOCKED") ||
        msg.includes("ACCESS_TOKEN_TYPE_UNSUPPORTED") ||
        msg.includes("UNAUTHENTICATED") ||
        msg.includes("PERMISSION_DENIED")
    );
}

function generateGeminiReplyRest({ apiKey, model, prompt, useVertexExpress }) {
    const hostname = useVertexExpress ? "aiplatform.googleapis.com" : "generativelanguage.googleapis.com";
    const apiPath = useVertexExpress
        ? `/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent`
        : `/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const payload = JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }]
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, val) => {
            if (settled) return;
            settled = true;
            fn(val);
        };

        const apiReq = https.request(
            {
                hostname,
                path: apiPath,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                    "x-goog-api-key": apiKey
                }
            },
            (apiRes) => {
                let raw = "";
                apiRes.on("data", (chunk) => { raw += chunk; });
                apiRes.on("end", () => {
                    let parsed = {};
                    try {
                        parsed = JSON.parse(raw || "{}");
                    } catch {
                        // ignore non-JSON body
                    }

                    if (apiRes.statusCode >= 200 && apiRes.statusCode < 300) {
                        return done(resolve, extractGeminiRestText(parsed));
                    }

                    const errInfo = parsed?.error || {};
                    const err = new Error(errInfo.message || `Gemini API HTTP ${apiRes.statusCode}`);
                    err.status = apiRes.statusCode;
                    err.code = errInfo.code || apiRes.statusCode;
                    err.apiStatus = errInfo.status || "";
                    err.details = errInfo.details || [];
                    done(reject, err);
                });
            }
        );

        apiReq.setTimeout(30000, () => {
            apiReq.destroy(new Error("Gemini API request timeout"));
        });

        apiReq.on("error", (err) => done(reject, err));
        apiReq.write(payload);
        apiReq.end();
    });
}

async function callGeminiSurface({ apiKey, model, prompt, useVertexExpress }) {
    try {
        const { GoogleGenAI } = require("@google/genai");
        const ai = new GoogleGenAI({
            vertexai: Boolean(useVertexExpress),
            apiKey
        });
        const response = await ai.models.generateContent({
            model,
            contents: prompt
        });
        return response?.text ?? "";
    } catch (sdkErr) {
        if (
            sdkErr?.code === "MODULE_NOT_FOUND" ||
            sdkErr instanceof TypeError ||
            isSurfaceOrAuthError(sdkErr)
        ) {
            return await generateGeminiReplyRest({ apiKey, model, prompt, useVertexExpress });
        }
        throw sdkErr;
    }
}

async function generateGeminiReply(prompt) {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
        const err = new Error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY / VERTEX_API_KEY).");
        err.status = 500;
        throw err;
    }

    const model = process.env.GEMINI_MODEL || "gemini-4-hydrogen";
    const useVertexEnv = (
        process.env.GOOGLE_GENAI_USE_VERTEXAI ||
        process.env.GOOGLE_GENAI_USE_ENTERPRISE ||
        ""
    ).trim().toLowerCase();

    if (useVertexEnv === "true") {
        return await callGeminiSurface({ apiKey, model, prompt, useVertexExpress: true });
    }
    if (useVertexEnv === "false") {
        return await callGeminiSurface({ apiKey, model, prompt, useVertexExpress: false });
    }

    const preferVertexFirst =
        !process.env.GEMINI_API_KEY &&
        !process.env.GOOGLE_API_KEY &&
        Boolean(process.env.VERTEX_API_KEY);

    try {
        return await callGeminiSurface({ apiKey, model, prompt, useVertexExpress: preferVertexFirst });
    } catch (firstErr) {
        if (isSurfaceOrAuthError(firstErr) && (apiKey.startsWith("AQ.") || process.env.VERTEX_API_KEY)) {
            return await callGeminiSurface({ apiKey, model, prompt, useVertexExpress: !preferVertexFirst });
        }
        throw firstErr;
    }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
    if (res.headersSent) return;
    res.writeHead(statusCode, { "Content-Type": "application/json", ...extraHeaders });
    res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html, extraHeaders = {}) {
    if (res.headersSent) return;
    res.writeHead(statusCode, { "Content-Type": "text/html", ...extraHeaders });
    res.end(html);
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        let settled = false;

        req.on("data", (chunk) => {
            if (settled) return;
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
                settled = true;
                const err = new Error("Payload Too Large");
                err.statusCode = 413;
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks).toString("utf8"));
        });

        req.on("error", (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
    });
}

function parseFormOrJson(req, body) {
    const contentType = (req.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("application/json")) {
        const parsed = JSON.parse(body || "{}");
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    return querystring.parse(body);
}

function getClientIp(req) {
    const forwarded = req.headers["x-forwarded-for"];
    let ip = "";
    if (typeof forwarded === "string" && forwarded.length > 0) {
        ip = forwarded.split(",")[0].trim();
    } else {
        ip = req.socket?.remoteAddress || "";
    }
    return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function verifyRecaptcha(token, remoteIp) {
    if (!isRecaptchaEnabled()) {
        return Promise.resolve({ success: true, skipped: true });
    }

    if (!token || typeof token !== "string") {
        return Promise.resolve({ success: false, reason: "Please complete the Google reCAPTCHA challenge." });
    }

    const postData = querystring.stringify({
        secret: RECAPTCHA_SECRET_KEY,
        response: token.trim(),
        remoteip: remoteIp || ""
    });

    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };

        const options = {
            hostname: "www.google.com",
            path: "/recaptcha/api/siteverify",
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(postData)
            }
        };

        const verifyReq = https.request(options, (verifyRes) => {
            let raw = "";
            verifyRes.on("data", (chunk) => { raw += chunk; });
            verifyRes.on("end", () => {
                try {
                    const data = JSON.parse(raw || "{}");
                    if (!data.success) {
                        const codes = Array.isArray(data["error-codes"]) ? data["error-codes"].join(", ") : "verification_failed";
                        return finish({ success: false, reason: `reCAPTCHA failed (${codes})` });
                    }
                    if (typeof data.score === "number" && data.score < RECAPTCHA_MIN_SCORE) {
                        return finish({ success: false, reason: "Suspicious activity detected by reCAPTCHA." });
                    }
                    return finish({ success: true, score: data.score });
                } catch {
                    return finish({ success: false, reason: "Invalid response from Google reCAPTCHA." });
                }
            });
        });

        verifyReq.setTimeout(10000, () => {
            verifyReq.destroy(new Error("reCAPTCHA verification timeout"));
        });

        verifyReq.on("error", (err) => {
            console.error("[⚠️ reCAPTCHA] Network error:", err.message);
            finish({ success: false, reason: "Unable to reach Google reCAPTCHA service." });
        });

        verifyReq.write(postData);
        verifyReq.end();
    });
}

function atomicWriteFileSync(filePath, content) {
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filePath);
}

function readJsonDb(filePath) {
    const target = Object.create(null);
    if (!fs.existsSync(filePath)) return target;
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return target;
        }
        for (const [k, v] of Object.entries(parsed)) {
            if (!RESERVED_KEYS.has(k)) {
                target[k] = v;
            }
        }
        return target;
    } catch {
        return target;
    }
}

function writeJsonDb(filePath, data) {
    const clean = {};
    if (data && typeof data === "object") {
        for (const [k, v] of Object.entries(data)) {
            if (!RESERVED_KEYS.has(k)) {
                clean[k] = v;
            }
        }
    }
    atomicWriteFileSync(filePath, JSON.stringify(clean, null, 4));
}

function ensureUsersDbSeeded() {
    if (!fs.existsSync(DB_PATH) || fs.readFileSync(DB_PATH, "utf8").trim() === "") {
        writeJsonDb(DB_PATH, {
            reos_user: {
                password: "password123",
                picture: "https://ui-avatars.com/api/?name=reos_user&background=2563eb&color=fff",
                type: "reos"
            }
        });
    }
}

function getEmailsDb() {
    return readJsonDb(EMAILS_DB);
}

function getClientsFromTxt() {
    const clients = Object.create(null);
    try {
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
                        if (isSafeKey(cId)) {
                            clients[cId] = { secret: cSecret, redirectUri: cRedirect, owner: cOwner };
                        }
                    }
                }
            }
        } else {
            const defaultData = "sample_app_id|sample_app_secret|https://jwt.io|system\ngoogle_client_id|google_secret_key_123|https://www.google.com|system\n";
            atomicWriteFileSync(CLIENTS_TXT_PATH, defaultData);
            clients["sample_app_id"] = { secret: "sample_app_secret", redirectUri: "https://jwt.io", owner: "system" };
            clients["google_client_id"] = { secret: "google_secret_key_123", redirectUri: "https://www.google.com", owner: "system" };
        }
    } catch (err) {
        console.error("Failed reading/initializing clients.txt:", err);
    }
    return clients;
}

function saveClientsToTxt(clientsObj) {
    const lines = [];
    for (const [id, data] of Object.entries(clientsObj)) {
        const cleanId = sanitizePipeField(id);
        if (!cleanId) continue;
        lines.push(`${cleanId}|${sanitizePipeField(data.secret)}|${sanitizePipeField(data.redirectUri)}|${sanitizePipeField(data.owner || "system")}`);
    }
    atomicWriteFileSync(CLIENTS_TXT_PATH, lines.join("\n") + "\n");
}

async function handleAuthWorkflow(formData, res, req) {
    const action = formData.auth_action === "register" ? "register" : "login";
    const userIn = typeof formData.username === "string" ? formData.username.trim() : "";
    const passIn = typeof formData.password === "string" ? formData.password.trim() : "";
    const recaptchaToken =
        (typeof formData["g-recaptcha-response"] === "string" && formData["g-recaptcha-response"]) ||
        (typeof formData.recaptcha_token === "string" && formData.recaptcha_token) ||
        "";

    if (!userIn || !passIn || !isSafeKey(userIn)) {
        return sendHtml(res, 400, "<h3>Username and Password are required.</h3><a href=\"/login.html\">Back to Login</a>");
    }

    const remoteIp = getClientIp(req);
    const result = await verifyRecaptcha(recaptchaToken, remoteIp);

    if (!result.success) {
        return sendHtml(
            res,
            403,
            `<h3>Access Blocked</h3><p>[reCAPTCHA] ${escapeHtml(result.reason)}</p><a href="/login.html">Try Again</a>`
        );
    }

    ensureUsersDbSeeded();

    const users = readJsonDb(DB_PATH);
    const defaultPic = "https://ui-avatars.com/api/?name=" + encodeURIComponent(userIn) + "&background=2563eb&color=fff";

    if (action === "register") {
        if (hasOwn(users, userIn)) {
            return sendHtml(res, 400, "<h3>Username already registered!</h3><a href=\"/login.html\">Try Another</a>");
        }

        users[userIn] = { password: passIn, picture: defaultPic, type: "reos" };
        writeJsonDb(DB_PATH, users);

        const redirectUrl = `/pg2.html?user=${encodeURIComponent(userIn)}&pic=${encodeURIComponent(defaultPic)}`;
        res.writeHead(302, {
            "Location": redirectUrl,
            "Set-Cookie": buildSessionCookie(req, userIn)
        });
        return res.end();
    } else {
        const storedUser = hasOwn(users, userIn) ? users[userIn] : null;
        const storedPass = storedUser && typeof storedUser === "object" ? storedUser.password : storedUser;
        const userPic = storedUser && typeof storedUser === "object" && storedUser.picture ? storedUser.picture : defaultPic;

        if (storedUser && typeof storedPass === "string" && storedPass.length > 0 && storedPass === passIn) {
            const redirectUrl = `/pg2.html?user=${encodeURIComponent(userIn)}&pic=${encodeURIComponent(userPic)}`;
            res.writeHead(302, {
                "Location": redirectUrl,
                "Set-Cookie": buildSessionCookie(req, userIn)
            });
            return res.end();
        } else {
            return sendHtml(res, 401, "<h3>Access Denied</h3><p>Invalid credentials or user not registered.</p><a href=\"/login.html\">Back to Login</a>");
        }
    }
}

async function handleDeleteAccount(req, res) {
    try {
        const body = await readBody(req);
        const { username, password } = JSON.parse(body || "{}");
        const cleanUser = typeof username === "string" ? username.trim() : "";

        if (!cleanUser || !isSafeKey(cleanUser)) {
            return sendJson(res, 400, { success: false, message: "Username is required." });
        }

        if (!fs.existsSync(DB_PATH)) {
            return sendJson(res, 404, { success: false, message: "Account not found." });
        }

        const users = readJsonDb(DB_PATH);
        const targetKey = hasOwn(users, cleanUser)
            ? cleanUser
            : Object.keys(users).find(k => k.trim().toLowerCase() === cleanUser.toLowerCase());

        if (!targetKey || !hasOwn(users, targetKey)) {
            return sendJson(res, 404, { success: false, message: "Account not found." });
        }

        const storedUser = users[targetKey];
        const storedPass = storedUser && typeof storedUser === "object" ? storedUser.password : storedUser;
        const isStoredGoogleAccount =
            Boolean(storedUser && typeof storedUser === "object" && storedUser.type === "google" && !storedPass);

        if (!isStoredGoogleAccount) {
            if (typeof password !== "string" || !password) {
                return sendJson(res, 400, { success: false, message: "Password is required for Reos accounts." });
            }
            if (typeof storedPass !== "string" || !storedPass || storedPass !== password) {
                return sendJson(res, 401, { success: false, message: "Invalid username or password." });
            }
        }

        delete users[targetKey];
        writeJsonDb(DB_PATH, users);

        const clients = getClientsFromTxt();
        let clientsUpdated = false;
        for (const [id, data] of Object.entries(clients)) {
            if (data.owner && data.owner.trim().toLowerCase() === targetKey.trim().toLowerCase()) {
                delete clients[id];
                clientsUpdated = true;
            }
        }
        if (clientsUpdated) {
            saveClientsToTxt(clients);
        }

        return sendJson(res, 200, { success: true, message: "Account deleted successfully from disk." });
    } catch (err) {
        console.error("Delete Error:", err);
        const status = err.statusCode || (err instanceof SyntaxError ? 400 : 500);
        return sendJson(res, status, {
            success: false,
            message: status === 413 ? "Request too large." : status === 400 ? "Invalid JSON body." : "Server error during account deletion."
        });
    }
}

async function handleRequest(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-