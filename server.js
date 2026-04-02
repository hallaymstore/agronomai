const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL =
  process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "agronomai";
const SESSION_SECRET = process.env.SESSION_SECRET || "agronomai_dev_secret";
const SESSION_TTL_DAYS = Math.max(1, Number(process.env.SESSION_TTL_DAYS || 7));
const MAX_BODY_SIZE = 15 * 1024 * 1024;
const SESSION_COOKIE_NAME = "agronomai_session";

const state = {
  mongoReady: false,
  mongoEnabled: false,
  mongoError: "",
  collections: null,
  inMemoryAnalyses: [],
  inMemoryContacts: [],
  inMemoryUsers: [],
  inMemorySessions: [],
  inMemoryChats: [],
  startedAt: new Date().toISOString(),
};

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function createId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function plusDaysIso(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function normalizeArray(value, fallback = []) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function stringOrFallback(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function safeNumber(value, fallback = 65) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeSeverity(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "yuqori" || raw.includes("yuq")) {
    return "yuqori";
  }
  if (raw === "orta" || raw.includes("o'rta") || raw.includes("orta")) {
    return "orta";
  }
  return "past";
}

function parseJsonLoose(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Bo'sh javob olindi.");
  }

  const cleaned = text
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (directError) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw directError;
    }
    return JSON.parse(match[0]);
  }
}

function extractOutputText(responseData) {
  if (typeof responseData?.output_text === "string" && responseData.output_text.trim()) {
    return responseData.output_text.trim();
  }

  const collected = [];
  for (const item of responseData?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        collected.push(content.text.trim());
      }
    }
  }

  return collected.join("\n").trim();
}

function normalizeAnalysis(raw, meta = {}) {
  return {
    summary: stringOrFallback(
      raw.summary,
      "Rasm va matn asosida taxminiy tahlil tayyorlandi."
    ),
    detectedPlant: stringOrFallback(
      raw.detectedPlant || raw.plantName,
      meta.plantType || "Aniqlanmadi"
    ),
    condition: stringOrFallback(
      raw.condition || raw.diagnosis,
      "Taxminiy holat bildirildi"
    ),
    severity: normalizeSeverity(raw.severity),
    confidence: safeNumber(raw.confidence, meta.hasImage ? 78 : 58),
    diagnosis: stringOrFallback(
      raw.diagnosis,
      "Bu tashxis yakuniy laborator xulosa emas, taxminiy AI baho."
    ),
    possibleCauses: normalizeArray(raw.possibleCauses, [
      "Noto'g'ri sug'orish rejimi",
      "Yorug'lik muvozanati buzilishi",
    ]),
    immediateActions: normalizeArray(raw.immediateActions, [
      "Zararlangan barglarni alohida kuzating.",
      "Keyingi 24 soat ichida sug'orish rejimini tekshiring.",
    ]),
    weeklyCare: normalizeArray(raw.weeklyCare, [
      "Haftasiga bir marta barg holatini tekshiring.",
      "Tuproq namligini muntazam kuzating.",
    ]),
    watering: stringOrFallback(
      raw.watering,
      "Tuproqning ustki 2-3 sm qatlami quriganda me'yorida sug'oring."
    ),
    light: stringOrFallback(
      raw.light,
      "Tarqoq, ammo yetarli yorug'lik tavsiya etiladi."
    ),
    nutrition: stringOrFallback(
      raw.nutrition,
      "Vegetatsiya davrida muvozanatli o'g'itdan me'yorida foydalaning."
    ),
    prevention: normalizeArray(raw.prevention, [
      "Havo almashinuvini yaxshilang.",
      "Barglarni ortiqcha nam qoldirmang.",
    ]),
    whenToEscalate: stringOrFallback(
      raw.whenToEscalate,
      "Belgilar 5-7 kun ichida kamaymasa, agronom yoki fitopatologga murojaat qiling."
    ),
    disclaimer: stringOrFallback(
      raw.disclaimer,
      "AI tavsiyasi taxminiy bo'lib, kuchli zararlanishda mutaxassis ko'rigi kerak."
    ),
    imageQuality: stringOrFallback(
      raw.imageQuality,
      meta.hasImage
        ? "Rasm sifati qoniqarli deb baholandi."
        : "Rasm yuborilmagani uchun faqat matn asosida tahlil qilindi."
    ),
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const entries = header.split(";").map((item) => item.trim()).filter(Boolean);
  const cookies = {};

  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }
  if (options.path) {
    parts.push(`Path=${options.path}`);
  }
  if (options.expires) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  return parts.join("; ");
}

function appendSetCookie(res, cookieValue) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, cookieValue]);
    return;
  }

  res.setHeader("Set-Cookie", [current, cookieValue]);
}

function safeEqualText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function signSessionToken(rawToken) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(rawToken).digest("hex");
}

function buildSignedSessionToken(rawToken) {
  return `${rawToken}.${signSessionToken(rawToken)}`;
}

function readRawSessionToken(signedToken) {
  const value = String(signedToken || "");
  const separator = value.lastIndexOf(".");
  if (separator === -1) {
    return "";
  }

  const rawToken = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = signSessionToken(rawToken);
  if (!safeEqualText(signature, expected)) {
    return "";
  }

  return rawToken;
}

function setSessionCookie(res, rawToken) {
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE_NAME, buildSignedSessionToken(rawToken), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    })
  );
}

function clearSessionCookie(res) {
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      expires: new Date(0),
      maxAge: 0,
    })
  );
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function sanitizeUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
  };
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error("Yuborilgan ma'lumot hajmi juda katta."));
        req.destroy();
        return;
      }
      raw += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("JSON format noto'g'ri."));
      }
    });

    req.on("error", reject);
  });
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({
        salt,
        hash: derivedKey.toString("hex"),
      });
    });
  });
}

async function verifyPassword(password, salt, hash) {
  const next = await hashPassword(password, salt);
  return safeEqualText(next.hash, hash);
}

async function initMongo() {
  if (!MONGODB_URI) {
    state.mongoReady = true;
    state.mongoEnabled = false;
    state.mongoError = "MONGODB_URI berilmagan, vaqtinchalik xotira ishlatiladi.";
    return;
  }

  try {
    const { MongoClient } = require("mongodb");
    const client = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 4000,
    });

    await client.connect();
    const db = client.db(MONGODB_DB);

    state.collections = {
      analyses: db.collection("analyses"),
      contacts: db.collection("contacts"),
      users: db.collection("users"),
      sessions: db.collection("sessions"),
      chats: db.collection("chats"),
    };

    await state.collections.analyses.createIndex({ userId: 1, createdAt: -1 });
    await state.collections.contacts.createIndex({ createdAt: -1 });
    await state.collections.users.createIndex({ emailLower: 1 }, { unique: true });
    await state.collections.sessions.createIndex({ token: 1 }, { unique: true });
    await state.collections.sessions.createIndex({ userId: 1, createdAt: -1 });
    await state.collections.chats.createIndex({ userId: 1, createdAt: -1 });

    state.mongoReady = true;
    state.mongoEnabled = true;
    state.mongoError = "";
    console.log("[MongoDB] Ulandi.");
  } catch (error) {
    state.mongoReady = true;
    state.mongoEnabled = false;
    state.mongoError = error.message;
    console.warn("[MongoDB] Ulanmadi:", error.message);
  }
}

async function saveAnalysis(record) {
  const doc = { ...record, createdAt: record.createdAt || nowIso() };
  if (state.mongoEnabled && state.collections?.analyses) {
    await state.collections.analyses.insertOne(doc);
    return "mongodb";
  }

  state.inMemoryAnalyses.unshift(doc);
  state.inMemoryAnalyses = state.inMemoryAnalyses.slice(0, 80);
  return "memory";
}

async function saveContact(record) {
  const doc = { ...record, createdAt: record.createdAt || nowIso() };
  if (state.mongoEnabled && state.collections?.contacts) {
    await state.collections.contacts.insertOne(doc);
    return "mongodb";
  }

  state.inMemoryContacts.unshift(doc);
  state.inMemoryContacts = state.inMemoryContacts.slice(0, 80);
  return "memory";
}

async function listHistory(userId, limit = 6) {
  if (state.mongoEnabled && state.collections?.analyses) {
    return state.collections.analyses
      .find(
        { userId },
        {
          projection: {
            _id: 0,
            id: 1,
            summary: 1,
            detectedPlant: 1,
            condition: 1,
            severity: 1,
            confidence: 1,
            createdAt: 1,
            plantType: 1,
          },
        }
      )
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  return state.inMemoryAnalyses
    .filter((item) => item.userId === userId)
    .slice(0, limit)
    .map((item) => ({
      id: item.id,
      summary: item.summary,
      detectedPlant: item.detectedPlant,
      condition: item.condition,
      severity: item.severity,
      confidence: item.confidence,
      createdAt: item.createdAt,
      plantType: item.plantType,
    }));
}

async function findUserByEmail(email) {
  const emailLower = String(email || "").trim().toLowerCase();
  if (!emailLower) {
    return null;
  }

  if (state.mongoEnabled && state.collections?.users) {
    return state.collections.users.findOne({ emailLower }, { projection: { _id: 0 } });
  }

  return state.inMemoryUsers.find((item) => item.emailLower === emailLower) || null;
}

async function findUserById(userId) {
  if (!userId) {
    return null;
  }

  if (state.mongoEnabled && state.collections?.users) {
    return state.collections.users.findOne({ id: userId }, { projection: { _id: 0 } });
  }

  return state.inMemoryUsers.find((item) => item.id === userId) || null;
}

async function createUserRecord(user) {
  if (state.mongoEnabled && state.collections?.users) {
    await state.collections.users.insertOne(user);
    return "mongodb";
  }

  state.inMemoryUsers.unshift(user);
  return "memory";
}

async function createSessionRecord(userId) {
  const session = {
    id: createId(),
    token: crypto.randomBytes(32).toString("hex"),
    userId,
    createdAt: nowIso(),
    expiresAt: plusDaysIso(SESSION_TTL_DAYS),
  };

  if (state.mongoEnabled && state.collections?.sessions) {
    await state.collections.sessions.insertOne(session);
    return session;
  }

  state.inMemorySessions.unshift(session);
  state.inMemorySessions = state.inMemorySessions
    .filter((item) => item.expiresAt > nowIso())
    .slice(0, 200);
  return session;
}

async function findSessionByToken(rawToken) {
  if (!rawToken) {
    return null;
  }

  if (state.mongoEnabled && state.collections?.sessions) {
    return state.collections.sessions.findOne({
      token: rawToken,
      expiresAt: { $gt: nowIso() },
    });
  }

  state.inMemorySessions = state.inMemorySessions.filter((item) => item.expiresAt > nowIso());
  return state.inMemorySessions.find((item) => item.token === rawToken) || null;
}

async function deleteSessionByToken(rawToken) {
  if (!rawToken) {
    return;
  }

  if (state.mongoEnabled && state.collections?.sessions) {
    await state.collections.sessions.deleteOne({ token: rawToken });
    return;
  }

  state.inMemorySessions = state.inMemorySessions.filter((item) => item.token !== rawToken);
}

async function saveChatMessage(message) {
  const doc = { ...message, createdAt: message.createdAt || nowIso() };
  if (state.mongoEnabled && state.collections?.chats) {
    await state.collections.chats.insertOne(doc);
    return "mongodb";
  }

  state.inMemoryChats.push(doc);
  state.inMemoryChats = state.inMemoryChats.slice(-400);
  return "memory";
}

async function listChatMessages(userId, limit = 20) {
  if (state.mongoEnabled && state.collections?.chats) {
    const items = await state.collections.chats
      .find(
        { userId },
        {
          projection: {
            _id: 0,
            id: 1,
            role: 1,
            text: 1,
            hasImage: 1,
            createdAt: 1,
          },
        }
      )
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return items.reverse();
  }

  return state.inMemoryChats
    .filter((item) => item.userId === userId)
    .slice(-limit)
    .map((item) => ({
      id: item.id,
      role: item.role,
      text: item.text,
      hasImage: item.hasImage,
      createdAt: item.createdAt,
    }));
}

async function getAuthContext(req) {
  const cookies = parseCookies(req);
  const rawToken = readRawSessionToken(cookies[SESSION_COOKIE_NAME] || "");
  if (!rawToken) {
    return { user: null, session: null };
  }

  const session = await findSessionByToken(rawToken);
  if (!session) {
    return { user: null, session: null };
  }

  const user = await findUserById(session.userId);
  if (!user) {
    return { user: null, session: null };
  }

  return {
    user: sanitizeUser(user),
    session,
  };
}

async function requireAuth(req, res) {
  const auth = await getAuthContext(req);
  if (!auth.user) {
    sendJson(res, 401, {
      ok: false,
      error: "Davom etish uchun login qiling.",
    });
    return null;
  }

  return auth;
}

function buildAgronomyPrompt({ plantType, symptom, prompt, hasImage }) {
  return [
    "You are Agronom AI, an expert assistant for plant care, greenhouse diagnostics, home gardening, and field crop observation.",
    "Analyze the user's plant issue carefully.",
    "Return ONLY valid JSON and no markdown.",
    "All values must be in Uzbek Latin.",
    'Use this exact schema: {"summary":"","detectedPlant":"","condition":"","severity":"past|orta|yuqori","confidence":0,"diagnosis":"","possibleCauses":[""],"immediateActions":[""],"weeklyCare":[""],"watering":"","light":"","nutrition":"","prevention":[""],"whenToEscalate":"","disclaimer":"","imageQuality":""}',
    "If the image is blurry or uncertain, say that clearly and lower confidence.",
    "Keep items practical and short. Avoid medical-style certainty.",
    "",
    `Plant type from user: ${plantType || "Noma'lum"}`,
    `Observed symptom from user: ${symptom || "Kiritilmagan"}`,
    `User request: ${prompt || "Rasm asosida o'simlik parvarishi bo'yicha tavsiya bering."}`,
    `Image attached: ${hasImage ? "yes" : "no"}`,
  ].join("\n");
}

function buildChatInstructions(userName) {
  return [
    "You are Agronom AI, a practical Uzbek Latin speaking plant-care assistant.",
    "You help with plant care, diseases, pests, irrigation, fertilizers, soil, greenhouse, garden, and crop questions.",
    "Answer in Uzbek Latin only.",
    "Be conversational, clear, and actionable.",
    "If the user shares an image, mention visible clues carefully and say when you are uncertain.",
    "Prefer short paragraphs or bullet points with concrete next steps.",
    `User name: ${userName || "Foydalanuvchi"}`,
  ].join("\n");
}

async function callGroqResponses(payload) {
  const response = await fetch("https://api.groq.com/openai/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
        data?.message ||
        data?.raw ||
        "Groq Responses API xatolik qaytardi."
    );
  }

  return data;
}

async function callGroqChat(payload) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      data?.error?.message || data?.message || data?.raw || "Groq Chat API xatoligi."
    );
  }

  return data;
}

async function generateAgronomyAnalysis({ plantType, symptom, prompt, imageDataUrl }) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY topilmadi. .env ichiga kalitni kiriting.");
  }

  const hasImage = Boolean(imageDataUrl);
  const combinedPrompt = buildAgronomyPrompt({
    plantType,
    symptom,
    prompt,
    hasImage,
  });

  try {
    const responseData = await callGroqResponses({
      model: GROQ_MODEL,
      instructions:
        "Return strict JSON only. Be concise, practical, and helpful for plant care.",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: combinedPrompt },
            ...(hasImage
              ? [{ type: "input_image", detail: "auto", image_url: imageDataUrl }]
              : []),
          ],
        },
      ],
      max_output_tokens: 900,
    });

    return normalizeAnalysis(parseJsonLoose(extractOutputText(responseData)), {
      plantType,
      hasImage,
    });
  } catch (responsesError) {
    const chatData = await callGroqChat({
      model: GROQ_MODEL,
      temperature: 0.2,
      max_completion_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are Agronom AI. Return only valid JSON in Uzbek Latin with practical plant-care advice.",
        },
        {
          role: "user",
          content: hasImage
            ? [
                { type: "text", text: combinedPrompt },
                { type: "image_url", image_url: { url: imageDataUrl } },
              ]
            : combinedPrompt,
        },
      ],
    });

    try {
      const content = chatData?.choices?.[0]?.message?.content || "";
      return normalizeAnalysis(parseJsonLoose(content), { plantType, hasImage });
    } catch (parseError) {
      throw new Error(
        `Groq javobi JSON sifatida ajratilmadi. Responses error: ${responsesError.message}`
      );
    }
  }
}

async function generateAgronomyChatReply({ userName, message, imageDataUrl, history }) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY topilmadi. .env ichiga kalitni kiriting.");
  }

  const hasImage = Boolean(imageDataUrl);
  const safeMessage = message || "Rasmni ko'rib, o'simlik holati bo'yicha maslahat bering.";
  const recentHistory = Array.isArray(history) ? history.slice(-8) : [];

  try {
    const responseData = await callGroqResponses({
      model: GROQ_MODEL,
      instructions: buildChatInstructions(userName),
      input: [
        ...recentHistory.map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: [{ type: "input_text", text: String(item.text || "") }],
        })),
        {
          role: "user",
          content: [
            { type: "input_text", text: safeMessage },
            ...(hasImage
              ? [{ type: "input_image", detail: "auto", image_url: imageDataUrl }]
              : []),
          ],
        },
      ],
      max_output_tokens: 800,
    });

    const reply = extractOutputText(responseData);
    if (!reply) {
      throw new Error("AI javobi bo'sh keldi.");
    }
    return reply;
  } catch (responsesError) {
    const chatData = await callGroqChat({
      model: GROQ_MODEL,
      temperature: 0.4,
      max_completion_tokens: 800,
      messages: [
        {
          role: "system",
          content: buildChatInstructions(userName),
        },
        ...recentHistory.map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: String(item.text || ""),
        })),
        {
          role: "user",
          content: hasImage
            ? [
                { type: "text", text: safeMessage },
                { type: "image_url", image_url: { url: imageDataUrl } },
              ]
            : safeMessage,
        },
      ],
    });

    const reply = String(chatData?.choices?.[0]?.message?.content || "").trim();
    if (!reply) {
      throw new Error(`AI javobi olinmadi. Responses error: ${responsesError.message}`);
    }
    return reply;
  }
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  return mimeTypes[ext] || "application/octet-stream";
}

async function serveStatic(req, res, pathname) {
  const aliases = {
    "/": "/index.html",
    "/login": "/login.html",
    "/register": "/register.html",
    "/chat": "/chat.html",
    "/guide": "/guide.html",
  };

  const requestedPath = aliases[pathname] || pathname;
  const protectedPages = new Set(["/chat.html"]);
  const guestPages = new Set(["/login.html", "/register.html"]);

  if (protectedPages.has(requestedPath) || guestPages.has(requestedPath)) {
    const auth = await getAuthContext(req);
    if (protectedPages.has(requestedPath) && !auth.user) {
      redirect(res, "/login.html");
      return;
    }
    if (guestPages.has(requestedPath) && auth.user) {
      redirect(res, "/chat.html");
      return;
    }
  }

  const safePath = decodeURIComponent(requestedPath);
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    let filePath = resolvedPath;
    const stats = await fs.promises.stat(filePath);
    if (stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    const content = await fs.promises.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": getMimeType(filePath),
      "Content-Length": content.length,
      "Cache-Control": filePath.endsWith(".html") ? "no-store" : "public, max-age=600",
    });
    res.end(content);
  } catch (error) {
    sendText(res, 404, "Sahifa topilmadi.");
  }
}

async function handleRegister(req, res) {
  try {
    const body = await readJsonBody(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const password = String(body.password || "");

    if (name.length < 2) {
      sendJson(res, 400, { ok: false, error: "Ism kamida 2 belgidan iborat bo'lsin." });
      return;
    }

    if (!isValidEmail(email)) {
      sendJson(res, 400, { ok: false, error: "Email manzili noto'g'ri." });
      return;
    }

    if (password.length < 6) {
      sendJson(res, 400, { ok: false, error: "Parol kamida 6 belgidan iborat bo'lsin." });
      return;
    }

    if (await findUserByEmail(email)) {
      sendJson(res, 409, { ok: false, error: "Bu email bilan foydalanuvchi mavjud." });
      return;
    }

    const passwordData = await hashPassword(password);
    const user = {
      id: createId(),
      name,
      email,
      emailLower: email.toLowerCase(),
      passwordHash: passwordData.hash,
      passwordSalt: passwordData.salt,
      createdAt: nowIso(),
    };

    const storage = await createUserRecord(user);
    const session = await createSessionRecord(user.id);
    setSessionCookie(res, session.token);

    sendJson(res, 201, {
      ok: true,
      storage,
      user: sanitizeUser(user),
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || "Ro'yxatdan o'tib bo'lmadi." });
  }
}

async function handleLogin(req, res) {
  try {
    const body = await readJsonBody(req);
    const email = String(body.email || "").trim();
    const password = String(body.password || "");

    const user = await findUserByEmail(email);
    if (!user) {
      sendJson(res, 401, { ok: false, error: "Email yoki parol noto'g'ri." });
      return;
    }

    const matched = await verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!matched) {
      sendJson(res, 401, { ok: false, error: "Email yoki parol noto'g'ri." });
      return;
    }

    const session = await createSessionRecord(user.id);
    setSessionCookie(res, session.token);

    sendJson(res, 200, {
      ok: true,
      user: sanitizeUser(user),
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || "Login bo'lmadi." });
  }
}

async function handleLogout(req, res) {
  try {
    const cookies = parseCookies(req);
    const rawToken = readRawSessionToken(cookies[SESSION_COOKIE_NAME] || "");
    await deleteSessionByToken(rawToken);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || "Logout bo'lmadi." });
  }
}

async function handleAnalyze(req, res, auth) {
  try {
    const body = await readJsonBody(req);
    const prompt = String(body.prompt || "").trim();
    const plantType = String(body.plantType || "").trim();
    const symptom = String(body.symptom || "").trim();
    const imageDataUrl = String(body.imageDataUrl || "").trim();
    const sessionId = String(body.sessionId || "").trim() || createId();

    if (!prompt && !symptom && !imageDataUrl) {
      sendJson(res, 400, {
        ok: false,
        error: "Kamida rasm yoki muammo tavsifini yuboring.",
      });
      return;
    }

    if (imageDataUrl && !/^data:image\/[a-zA-Z+.-]+;base64,/.test(imageDataUrl)) {
      sendJson(res, 400, {
        ok: false,
        error: "Rasm formati noto'g'ri. Fayl yoki kameradan qayta yuboring.",
      });
      return;
    }

    const analysis = await generateAgronomyAnalysis({
      plantType,
      symptom,
      prompt,
      imageDataUrl,
    });

    const record = {
      id: createId(),
      userId: auth.user.id,
      sessionId,
      plantType: plantType || analysis.detectedPlant,
      symptom,
      prompt,
      hasImage: Boolean(imageDataUrl),
      summary: analysis.summary,
      detectedPlant: analysis.detectedPlant,
      condition: analysis.condition,
      severity: analysis.severity,
      confidence: analysis.confidence,
      createdAt: nowIso(),
    };

    const storage = await saveAnalysis(record);
    sendJson(res, 200, { ok: true, storage, analysis, record });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message || "Tahlil jarayonida xatolik yuz berdi.",
    });
  }
}

async function handleChat(req, res, auth) {
  try {
    const body = await readJsonBody(req);
    const text = String(body.message || "").trim();
    const imageDataUrl = String(body.imageDataUrl || "").trim();

    if (!text && !imageDataUrl) {
      sendJson(res, 400, {
        ok: false,
        error: "Kamida xabar yoki rasm yuboring.",
      });
      return;
    }

    if (imageDataUrl && !/^data:image\/[a-zA-Z+.-]+;base64,/.test(imageDataUrl)) {
      sendJson(res, 400, {
        ok: false,
        error: "Rasm formati noto'g'ri.",
      });
      return;
    }

    const userMessage = {
      id: createId(),
      userId: auth.user.id,
      role: "user",
      text: text || "Rasm yuborildi. Shu rasm bo'yicha maslahat bering.",
      hasImage: Boolean(imageDataUrl),
      createdAt: nowIso(),
    };

    await saveChatMessage(userMessage);
    const history = await listChatMessages(auth.user.id, 10);
    const reply = await generateAgronomyChatReply({
      userName: auth.user.name,
      message: userMessage.text,
      imageDataUrl,
      history,
    });

    const assistantMessage = {
      id: createId(),
      userId: auth.user.id,
      role: "assistant",
      text: reply,
      hasImage: false,
      createdAt: nowIso(),
    };

    await saveChatMessage(assistantMessage);

    sendJson(res, 200, {
      ok: true,
      reply,
      messages: [userMessage, assistantMessage],
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message || "Chat javobini olib bo'lmadi.",
    });
  }
}

async function handleContact(req, res) {
  try {
    const body = await readJsonBody(req);
    const name = String(body.name || "").trim();
    const phone = String(body.phone || "").trim();
    const message = String(body.message || "").trim();

    if (!name || !phone || !message) {
      sendJson(res, 400, {
        ok: false,
        error: "Ism, telefon va xabar to'liq bo'lishi kerak.",
      });
      return;
    }

    const storage = await saveContact({
      id: createId(),
      name,
      phone,
      message,
      createdAt: nowIso(),
    });

    sendJson(res, 200, {
      ok: true,
      storage,
      message: "So'rovingiz qabul qilindi. Tez orada bog'lanamiz.",
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message || "Xabar yuborib bo'lmadi.",
    });
  }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = requestUrl.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      app: "Agronom AI",
      startedAt: state.startedAt,
      groqConfigured: Boolean(GROQ_API_KEY),
      mongoEnabled: state.mongoEnabled,
      mongoReady: state.mongoReady,
      mongoError: state.mongoError,
      model: GROQ_MODEL,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const auth = await getAuthContext(req);
    sendJson(res, 200, {
      ok: true,
      authenticated: Boolean(auth.user),
      user: auth.user,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/history") {
    const auth = await requireAuth(req, res);
    if (!auth) {
      return;
    }

    try {
      const limit = Math.max(1, Math.min(12, Number(requestUrl.searchParams.get("limit")) || 6));
      const items = await listHistory(auth.user.id, limit);
      sendJson(res, 200, { ok: true, items });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/chat/history") {
    const auth = await requireAuth(req, res);
    if (!auth) {
      return;
    }

    try {
      const limit = Math.max(1, Math.min(40, Number(requestUrl.searchParams.get("limit")) || 20));
      const items = await listChatMessages(auth.user.id, limit);
      sendJson(res, 200, { ok: true, items });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/register") {
    await handleRegister(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/login") {
    await handleLogin(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    await handleLogout(req, res);
    return;
  }

  if (req.method === "POST" && pathname === "/api/analyze") {
    const auth = await requireAuth(req, res);
    if (!auth) {
      return;
    }
    await handleAnalyze(req, res, auth);
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    const auth = await requireAuth(req, res);
    if (!auth) {
      return;
    }
    await handleChat(req, res, auth);
    return;
  }

  if (req.method === "POST" && pathname === "/api/contact") {
    await handleContact(req, res);
    return;
  }

  await serveStatic(req, res, pathname);
});

initMongo().finally(() => {
  server.listen(PORT, () => {
    console.log(`Agronom AI server ready: http://localhost:${PORT}`);
  });
});
