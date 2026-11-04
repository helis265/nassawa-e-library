"use strict";

// The API and static site share one origin so authentication cookies stay simple.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const BOOKS_DIR = path.resolve(process.env.BOOKS_DIR || path.join(ROOT, "BOOKS"));
const STORE_FILE = path.join(DATA_DIR, "library.json");
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_VIDEO_UPLOAD_BYTES = 300 * 1024 * 1024;
const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const SESSION_COOKIE = "nasawa_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "richardcameron185@gmail.com").trim().toLowerCase();
const ALLOWED_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".pptm", ".xls", ".xlsx", ".txt", ".rtf",
  ".csv", ".md", ".epub", ".odt", ".ods", ".odp", ".jpg", ".jpeg", ".png"
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v"]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".m4v": "video/x-m4v", ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12"
};
const sessions = new Map();
const DEFAULT_DEVELOPERS = [
  {
    id: "richard-cameron",
    name: "Richard Cameron",
    role: "Lead Developer & Systems Architect",
    bio: "Builds the library experience, product flow, and technical systems behind a smooth learning environment.",
    accent: "sage"
  },
  {
    id: "joshua",
    name: "Joshua",
    role: "Co-Developer & Product Partner",
    bio: "Helps shape the academic experience, feature planning, and student-first improvements across the platform.",
    accent: "gold"
  }
];
const DEFAULT_DEPARTMENTS = [
  "Accounting", "Administrative Studies", "Automobile Mechanics", "Brick Laying",
  "Carpentry and Joinery", "Community Development", "Fabrication and Welding",
  "General Fitting", "Human Resource Management", "Information and Communication Technology",
  "Motorcycle Mechanics", "Procurement", "Public Health"
];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function normalizeDeveloper(rawDeveloper, index) {
  const accentOptions = ["sage", "sand", "blue", "rose", "gold", "lavender"];
  return {
    id: cleanText(rawDeveloper?.id, 80) || `developer-${index + 1}`,
    name: cleanText(rawDeveloper?.name, 80) || DEFAULT_DEVELOPERS[index]?.name || `Developer ${index + 1}`,
    role: cleanText(rawDeveloper?.role, 80) || DEFAULT_DEVELOPERS[index]?.role || "Developer",
    bio: cleanText(rawDeveloper?.bio, 300) || DEFAULT_DEVELOPERS[index]?.bio || "",
    accent: accentOptions.includes(rawDeveloper?.accent) ? rawDeveloper.accent : defaultAccent(index),
    photo: typeof rawDeveloper?.photo === "string" && /^[a-f0-9-]{36}\.(?:jpe?g|png)$/i.test(rawDeveloper.photo) ? rawDeveloper.photo : ""
  };
}

function defaultAccent(index) {
  return ["sage", "gold"][index] || "sage";
}

// Keep credentials out of every API response, even for administrator listings.
function readStore() {
  try {
    const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return {
      users: Array.isArray(store.users) ? store.users : [],
      books: Array.isArray(store.books) ? store.books : [],
      videos: Array.isArray(store.videos) ? store.videos : [],
      departments: Array.isArray(store.departments) ? store.departments : [],
      hierarchyInitialized: store.hierarchyInitialized === true,
      excludedBookSources: Array.isArray(store.excludedBookSources) ? store.excludedBookSources : [],
      activity: Array.isArray(store.activity) ? store.activity : [],
      developers: Array.isArray(store.developers) && store.developers.length ? store.developers : DEFAULT_DEVELOPERS
    };
  } catch (error) {
    if (error.code === "ENOENT") return { users: [], books: [], videos: [], departments: [], hierarchyInitialized: false, excludedBookSources: [], activity: [], developers: DEFAULT_DEVELOPERS };
    throw new Error(`Could not read library data: ${error.message}`);
  }
}

let store = readStore();
store.developers = (Array.isArray(store.developers) ? store.developers : []).map(normalizeDeveloper);
if (!store.developers.length) store.developers = DEFAULT_DEVELOPERS.map((developer, index) => normalizeDeveloper(developer, index));
store.departments = store.departments.map((department) => ({
  id: cleanText(department?.id, 80) || crypto.randomUUID(),
  name: cleanText(department?.name, 100),
  levels: (Array.isArray(department?.levels) ? department.levels : []).map((level) => ({
    id: cleanText(level?.id, 80) || crypto.randomUUID(),
    name: cleanText(level?.name, 80),
    subjects: (Array.isArray(level?.subjects) ? level.subjects : []).map((subject) => ({
      id: cleanText(subject?.id, 80) || crypto.randomUUID(),
      name: cleanText(subject?.name, 100)
    })).filter((subject) => subject.name)
  })).filter((level) => level.name)
})).filter((department) => department.name);

function saveStore() {
  const temporaryFile = `${STORE_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, STORE_FILE);
}

function ensureDepartment(name) {
  const cleanName = cleanText(name, 100) || "General";
  let department = store.departments.find((item) => item.name.toLowerCase() === cleanName.toLowerCase());
  if (!department) {
    department = { id: crypto.randomUUID(), name: cleanName, levels: [] };
    store.departments.push(department);
  }
  return department;
}

function ensureLevel(department, name) {
  const cleanName = cleanText(name, 80) || "General";
  let level = department.levels.find((item) => item.name.toLowerCase() === cleanName.toLowerCase());
  if (!level) {
    level = { id: crypto.randomUUID(), name: cleanName, subjects: [] };
    department.levels.push(level);
  }
  return level;
}

function ensureSubject(level, name) {
  const cleanName = cleanText(name, 100) || "General";
  let subject = level.subjects.find((item) => item.name.toLowerCase() === cleanName.toLowerCase());
  if (!subject) {
    subject = { id: crypto.randomUUID(), name: cleanName };
    level.subjects.push(subject);
  }
  return subject;
}

function assignResourceLocation(resource) {
  const parts = (resource.sourcePath || "").split(/[\\/]/).filter(Boolean);
  const levelName = resource.level || parts.find((part) => /^level\\s*\\d+$/i.test(part)) || "General";
  const levelIndex = parts.findIndex((part) => /^level\\s*\\d+$/i.test(part));
  const subjectName = resource.subject || (levelIndex >= 0 && parts[levelIndex + 1] && levelIndex + 1 < parts.length - 1
    ? parts[levelIndex + 1] : "General");
  const department = ensureDepartment(resource.category);
  const level = ensureLevel(department, levelName);
  const subject = ensureSubject(level, subjectName);
  resource.category = department.name;
  resource.level = level.name;
  resource.subject = subject.name;
  resource.departmentId = department.id;
  resource.levelId = level.id;
  resource.subjectId = subject.id;
}

function initializeHierarchy() {
  if (!store.hierarchyInitialized) {
    DEFAULT_DEPARTMENTS.forEach((name) => {
      const department = ensureDepartment(name);
      [1, 2, 3, 4].forEach((number) => ensureLevel(department, `Level ${number}`));
    });
    store.hierarchyInitialized = true;
  }
  store.books.forEach(assignResourceLocation);
  store.videos.forEach(assignResourceLocation);
}

initializeHierarchy();

function findLevel(levelId) {
  for (const department of store.departments) {
    const level = department.levels.find((item) => item.id === levelId);
    if (level) return { department, level };
  }
  return null;
}

function findSubject(subjectId) {
  for (const department of store.departments) {
    for (const level of department.levels) {
      const subject = level.subjects.find((item) => item.id === subjectId);
      if (subject) return { department, level, subject };
    }
  }
  return null;
}

function resourceLocation(body) {
  const department = store.departments.find((item) => item.id === body.departmentId);
  const level = department?.levels.find((item) => item.id === body.levelId);
  const subject = level?.subjects.find((item) => item.id === body.subjectId);
  if (!department || !level || !subject) {
    throw Object.assign(new Error("Choose a valid department, level, and subject."), { status: 400 });
  }
  return {
    category: department.name, level: level.name, subject: subject.name,
    departmentId: department.id, levelId: level.id, subjectId: subject.id
  };
}

function deleteResources(predicate) {
  const removedBooks = store.books.filter(predicate);
  const removedVideos = store.videos.filter(predicate);
  for (const book of removedBooks) {
    if (book.sourcePath && !store.excludedBookSources.includes(book.sourcePath)) store.excludedBookSources.push(book.sourcePath);
  }
  const removedIds = new Set([...removedBooks, ...removedVideos].map((resource) => resource.id));
  store.books = store.books.filter((book) => !removedIds.has(book.id));
  store.videos = store.videos.filter((video) => !removedIds.has(video.id));
  store.activity = store.activity.filter((item) => !removedIds.has(item.bookId));
  for (const resource of [...removedBooks, ...removedVideos]) {
    if (!resource.storedName) continue;
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, resource.storedName));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, createdAt: user.createdAt };
}

function cookieValue(request, name) {
  const cookies = (request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator !== -1 && cookie.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(cookie.slice(separator + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function setSessionCookie(response, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}${secure}`);
}

function clearSessionCookie(response) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function currentUser(request) {
  const token = cookieValue(request, SESSION_COOKIE);
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  const user = store.users.find((candidate) => candidate.id === session.userId && candidate.active);
  if (!user) sessions.delete(token);
  return user || null;
}

function requireUser(request, response) {
  const user = currentUser(request);
  if (!user) sendError(response, 401, "Please log in to continue.");
  return user;
}

function requireAdmin(request, response) {
  const user = requireUser(request, response);
  if (!user) return null;
  if (user.role !== "admin") {
    sendError(response, 403, "Administrator access is required.");
    return null;
  }
  return user;
}

function readBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let oversized = false;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > maximumBytes) {
        oversized = true;
        chunks.length = 0;
      } else if (!oversized) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (oversized) reject(Object.assign(new Error("Request is too large."), { status: 413 }));
      else resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

async function readJson(request) {
  const body = await readBody(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw Object.assign(new Error("Please provide valid JSON."), { status: 400 });
  }
}

function cleanText(value, maximumLength) {
  return typeof value === "string" ? value.trim().slice(0, maximumLength) : "";
}

function recordActivity(userId, bookId, action) {
  store.activity.push({ id: crypto.randomUUID(), userId, bookId, action, at: new Date().toISOString() });
  if (store.activity.length > 5000) store.activity.splice(0, store.activity.length - 5000);
}

function publicBook(book, userId) {
  return {
    id: book.id, title: book.title, author: book.author, category: book.category,
    level: book.level || "General", subject: book.subject || "General",
    departmentId: book.departmentId, levelId: book.levelId, subjectId: book.subjectId,
    description: book.description, fileName: book.fileName, extension: book.extension,
    size: book.size, uploadedAt: book.uploadedAt, downloads: book.downloads || 0,
    reads: book.reads || 0, favorite: (book.favorites || []).includes(userId),
    relativePath: book.sourcePath || ""
  };
}

function publicVideo(video) {
  return {
    id: video.id, title: video.title, category: video.category, description: video.description,
    level: video.level || "General", subject: video.subject || "General",
    departmentId: video.departmentId, levelId: video.levelId, subjectId: video.subjectId,
    fileName: video.fileName, extension: video.extension, size: video.size, uploadedAt: video.uploadedAt
  };
}

function importBooksFromFolder() {
  if (!fs.existsSync(BOOKS_DIR)) return;
  const departmentNames = new Map([
    ["ACCOUNTING", "Accounting"],
    ["ADMINISTRATIVESTUDIES", "Administrative Studies"],
    ["AUTOMOBILEMECHANICS", "Automobile Mechanics"],
    ["BRICKLAYING", "Brick Laying"],
    ["CARPENTRYANDJOINERY", "Carpentry and Joinery"],
    ["COMMUNITYDEVELOPMENT", "Community Development"],
    ["FABLICATIONANDWELDING", "Fabrication and Welding"],
    ["FABRICATIONANDWELDING", "Fabrication and Welding"],
    ["GENERALFITTING", "General Fitting"],
    ["HUMANRESOURCEMANAGEMENT", "Human Resource Management"],
    ["ICT", "Information and Communication Technology"],
    ["INFORMATIONANDCOMMUNICATIONTECHNOLOGY", "Information and Communication Technology"],
    ["MOTORCYCLEMECHANICS", "Motorcycle Mechanics"],
    ["PROCUREMENT", "Procurement"],
    ["PUBLICHEALTH", "Public Health"]
  ]);
  const importedPaths = new Set([
    ...store.books.map((book) => book.sourcePath),
    ...store.excludedBookSources
  ].filter(Boolean).map((sourcePath) => sourcePath.toLowerCase()));
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) continue;
      const sourcePath = path.relative(BOOKS_DIR, filePath);
      if (importedPaths.has(sourcePath.toLowerCase())) continue;
      const relativeParts = sourcePath.split(path.sep);
      const departmentKey = (relativeParts[0] || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
      const category = departmentNames.get(departmentKey) || "General";
      const storedName = `${crypto.randomUUID()}${extension}`;
      fs.copyFileSync(filePath, path.join(UPLOAD_DIR, storedName), fs.constants.COPYFILE_EXCL);
      const title = path.basename(entry.name, extension).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
      store.books.push({
        id: crypto.randomUUID(), title: title || entry.name, author: "Nasawa Technical College",
        category, description: `Department learning resource${relativeParts.length > 1 ? ` · ${relativeParts.slice(1, -1).join(" · ")}` : ""}.`,
        fileName: entry.name, extension, storedName, sourcePath: sourcePath.toLowerCase(),
        size: fs.statSync(filePath).size, uploadedAt: new Date().toISOString(),
        downloads: 0, reads: 0, favorites: []
      });
      importedPaths.add(sourcePath.toLowerCase());
    }
  };
  walk(BOOKS_DIR);
}

function parseMultipart(buffer, contentType) {
  // Split on the multipart boundary as bytes so uploaded documents are never decoded as text.
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw Object.assign(new Error("The upload form is missing its boundary."), { status: 400 });
  const boundary = Buffer.from(`--${(boundaryMatch[1] || boundaryMatch[2]).trim()}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    start += boundary.length;
    if (buffer.slice(start, start + 2).toString() === "--") break;
    if (buffer.slice(start, start + 2).toString() === "\r\n") start += 2;
    const next = buffer.indexOf(boundary, start);
    if (next === -1) break;
    let part = buffer.slice(start, next);
    if (part.slice(-2).toString() === "\r\n") part = part.slice(0, -2);
    const separator = part.indexOf(Buffer.from("\r\n\r\n"));
    if (separator !== -1) {
      const headers = part.slice(0, separator).toString("utf8");
      const data = part.slice(separator + 4);
      const field = headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
      if (field) parts.push({ name: field[1], filename: field[2], data });
    }
    start = next;
  }
  return parts;
}

function fileNameHeader(fileName) {
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function inlineFileHeader(fileName) {
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

async function handleApi(request, response, url) {
  const pathname = decodeURIComponent(url.pathname);
  const method = request.method;

  if (pathname === "/api/auth/register" && method === "POST") {
    const body = await readJson(request);
    const name = cleanText(body.name, 80);
    const email = cleanText(body.email, 254).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 128) {
      return sendError(response, 400, "Enter your name, a valid email, and a password between 10 and 128 characters.");
    }
    if (store.users.some((user) => user.email === email)) return sendError(response, 409, "An account already exists for that email.");
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
    // Public registration can only create student accounts; admin access is provisioned at startup.
    const user = { id: crypto.randomUUID(), name, email, salt, passwordHash, role: "student", active: true, createdAt: new Date().toISOString() };
    store.users.push(user);
    saveStore();
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MAX_AGE * 1000 });
    setSessionCookie(response, token);
    return sendJson(response, 201, { user: safeUser(user) });
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const body = await readJson(request);
    const email = cleanText(body.email, 254).toLowerCase();
    const user = store.users.find((candidate) => candidate.email === email);
    const password = typeof body.password === "string" ? body.password : "";
    const salt = user ? user.salt : "00000000000000000000000000000000";
    const expected = user ? user.passwordHash : "0".repeat(128);
    const actual = (await scrypt(password, salt, 64)).toString("hex");
    const matches = crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
    if (!user || !matches || !user.active) return sendError(response, 401, "Email or password is incorrect.");
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MAX_AGE * 1000 });
    setSessionCookie(response, token);
    return sendJson(response, 200, { user: safeUser(user) });
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = cookieValue(request, SESSION_COOKIE);
    sessions.delete(token);
    clearSessionCookie(response);
    return sendJson(response, 200, { ok: true });
  }

  const user = requireUser(request, response);
  if (!user) return;

  if (pathname === "/api/me" && method === "GET") {
    return sendJson(response, 200, { user: safeUser(user) });
  }

  if (pathname === "/api/departments" && method === "GET") {
    return sendJson(response, 200, { departments: store.departments });
  }

  if (pathname === "/api/admin/departments" && method === "GET") {
    if (!requireAdmin(request, response)) return;
    return sendJson(response, 200, { departments: store.departments });
  }

  if (pathname === "/api/admin/departments" && method === "POST") {
    if (!requireAdmin(request, response)) return;
    const body = await readJson(request);
    const name = cleanText(body.name, 100);
    if (!name) return sendError(response, 400, "A department name is required.");
    if (store.departments.some((department) => department.name.toLowerCase() === name.toLowerCase())) {
      return sendError(response, 409, "That department already exists.");
    }
    const department = { id: crypto.randomUUID(), name, levels: [] };
    store.departments.push(department);
    saveStore();
    return sendJson(response, 201, { department });
  }

  const departmentMatch = pathname.match(/^\/api\/admin\/departments\/([a-f0-9-]+)$/i);
  if (departmentMatch && (method === "PATCH" || method === "DELETE")) {
    if (!requireAdmin(request, response)) return;
    const department = store.departments.find((item) => item.id === departmentMatch[1]);
    if (!department) return sendError(response, 404, "This department could not be found.");
    if (method === "PATCH") {
      const body = await readJson(request);
      const name = cleanText(body.name, 100);
      if (!name) return sendError(response, 400, "A department name is required.");
      if (store.departments.some((item) => item.id !== department.id && item.name.toLowerCase() === name.toLowerCase())) {
        return sendError(response, 409, "That department already exists.");
      }
      department.name = name;
      [...store.books, ...store.videos].filter((resource) => resource.departmentId === department.id).forEach((resource) => { resource.category = name; });
      saveStore();
      return sendJson(response, 200, { department });
    }
    deleteResources((resource) => resource.departmentId === department.id);
    store.departments = store.departments.filter((item) => item.id !== department.id);
    saveStore();
    return sendJson(response, 200, { ok: true });
  }

  const departmentLevelsMatch = pathname.match(/^\/api\/admin\/departments\/([a-f0-9-]+)\/levels$/i);
  if (departmentLevelsMatch && method === "POST") {
    if (!requireAdmin(request, response)) return;
    const department = store.departments.find((item) => item.id === departmentLevelsMatch[1]);
    if (!department) return sendError(response, 404, "This department could not be found.");
    const body = await readJson(request);
    const name = cleanText(body.name, 80);
    if (!name) return sendError(response, 400, "A level name is required.");
    if (department.levels.some((item) => item.name.toLowerCase() === name.toLowerCase())) return sendError(response, 409, "That level already exists in this department.");
    const level = { id: crypto.randomUUID(), name, subjects: [] };
    department.levels.push(level);
    saveStore();
    return sendJson(response, 201, { level });
  }

  const levelMatch = pathname.match(/^\/api\/admin\/levels\/([a-f0-9-]+)$/i);
  if (levelMatch && (method === "PATCH" || method === "DELETE")) {
    if (!requireAdmin(request, response)) return;
    const found = findLevel(levelMatch[1]);
    if (!found) return sendError(response, 404, "This level could not be found.");
    if (method === "PATCH") {
      const body = await readJson(request);
      const name = cleanText(body.name, 80);
      if (!name) return sendError(response, 400, "A level name is required.");
      if (found.department.levels.some((item) => item.id !== found.level.id && item.name.toLowerCase() === name.toLowerCase())) return sendError(response, 409, "That level already exists in this department.");
      found.level.name = name;
      [...store.books, ...store.videos].filter((resource) => resource.levelId === found.level.id).forEach((resource) => { resource.level = name; });
      saveStore();
      return sendJson(response, 200, { level: found.level });
    }
    deleteResources((resource) => resource.levelId === found.level.id);
    found.department.levels = found.department.levels.filter((item) => item.id !== found.level.id);
    saveStore();
    return sendJson(response, 200, { ok: true });
  }

  const levelSubjectsMatch = pathname.match(/^\/api\/admin\/levels\/([a-f0-9-]+)\/subjects$/i);
  if (levelSubjectsMatch && method === "POST") {
    if (!requireAdmin(request, response)) return;
    const found = findLevel(levelSubjectsMatch[1]);
    if (!found) return sendError(response, 404, "This level could not be found.");
    const body = await readJson(request);
    const name = cleanText(body.name, 100);
    if (!name) return sendError(response, 400, "A subject name is required.");
    if (found.level.subjects.some((item) => item.name.toLowerCase() === name.toLowerCase())) return sendError(response, 409, "That subject already exists in this level.");
    const subject = { id: crypto.randomUUID(), name };
    found.level.subjects.push(subject);
    saveStore();
    return sendJson(response, 201, { subject });
  }

  const subjectMatch = pathname.match(/^\/api\/admin\/subjects\/([a-f0-9-]+)$/i);
  if (subjectMatch && (method === "PATCH" || method === "DELETE")) {
    if (!requireAdmin(request, response)) return;
    const found = findSubject(subjectMatch[1]);
    if (!found) return sendError(response, 404, "This subject could not be found.");
    if (method === "PATCH") {
      const body = await readJson(request);
      const name = cleanText(body.name, 100);
      if (!name) return sendError(response, 400, "A subject name is required.");
      if (found.level.subjects.some((item) => item.id !== found.subject.id && item.name.toLowerCase() === name.toLowerCase())) return sendError(response, 409, "That subject already exists in this level.");
      found.subject.name = name;
      [...store.books, ...store.videos].filter((resource) => resource.subjectId === found.subject.id).forEach((resource) => { resource.subject = name; });
      saveStore();
      return sendJson(response, 200, { subject: found.subject });
    }
    deleteResources((resource) => resource.subjectId === found.subject.id);
    found.level.subjects = found.level.subjects.filter((item) => item.id !== found.subject.id);
    saveStore();
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === "/api/books" && method === "GET") {
    return sendJson(response, 200, { books: store.books.map((book) => publicBook(book, user.id)) });
  }

  if (pathname === "/api/activity" && method === "GET") {
    const activity = store.activity.filter((item) => item.userId === user.id).slice(-100).reverse().map((item) => ({
      ...item,
      title: store.books.find((book) => book.id === item.bookId)?.title
        || store.videos.find((video) => video.id === item.bookId)?.title
        || "Removed resource"
    }));
    return sendJson(response, 200, { activity });
  }

  if (pathname === "/api/about" && method === "GET") {
    return sendJson(response, 200, { developers: store.developers.map((developer) => ({ ...developer })) });
  }

  const profilePhotoMatch = pathname.match(/^\/api\/about\/photos\/([a-f0-9-]{36}\.(?:jpe?g|png))$/i);
  if (profilePhotoMatch && method === "GET") {
    const photoName = profilePhotoMatch[1];
    if (!store.developers.some((developer) => developer.photo === photoName)) {
      return sendError(response, 404, "This profile photo is no longer available.");
    }
    const photoPath = path.join(UPLOAD_DIR, photoName);
    if (!fs.existsSync(photoPath)) return sendError(response, 404, "The profile photo could not be found.");
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(photoName).toLowerCase()],
      "Content-Length": fs.statSync(photoPath).size,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store"
    });
    return fs.createReadStream(photoPath).pipe(response);
  }

  if (pathname === "/api/videos" && method === "GET") {
    return sendJson(response, 200, { videos: store.videos.map(publicVideo) });
  }

  const videoFileMatch = pathname.match(/^\/api\/videos\/([a-f0-9-]+)\/file$/i);
  if (videoFileMatch && method === "GET") {
    const video = store.videos.find((candidate) => candidate.id === videoFileMatch[1]);
    if (!video) return sendError(response, 404, "This video is no longer available.");
    const filePath = path.join(UPLOAD_DIR, video.storedName);
    if (!fs.existsSync(filePath)) return sendError(response, 404, "The video file could not be found.");
    const fileSize = fs.statSync(filePath).size;
    const range = request.headers.range;
    let start = 0;
    let end = fileSize - 1;
    let status = 200;
    if (range) {
      const match = range.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
        return response.end();
      }
      if (!match[1]) {
        start = Math.max(0, fileSize - Number(match[2]));
      } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : end;
      }
      if (start >= fileSize || end < start) {
        response.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
        return response.end();
      }
      end = Math.min(end, fileSize - 1);
      status = 206;
    }
    const headers = {
      "Content-Type": MIME_TYPES[video.extension] || "application/octet-stream",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Content-Disposition": inlineFileHeader(video.fileName),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store"
    };
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${fileSize}`;
    response.writeHead(status, headers);
    return fs.createReadStream(filePath, { start, end }).pipe(response);
  }

  const fileMatch = pathname.match(/^\/api\/books\/([a-f0-9-]+)\/file$/i);
  if (fileMatch && method === "GET") {
    const book = store.books.find((candidate) => candidate.id === fileMatch[1]);
    if (!book) return sendError(response, 404, "This book is no longer available.");
    const filePath = path.join(UPLOAD_DIR, book.storedName);
    if (!fs.existsSync(filePath)) return sendError(response, 404, "The library file could not be found.");
    const isDownload = url.searchParams.get("download") === "1";
    if (isDownload) {
      book.downloads = (book.downloads || 0) + 1;
      recordActivity(user.id, book.id, "downloaded");
      saveStore();
    } else {
      book.reads = (book.reads || 0) + 1;
      recordActivity(user.id, book.id, "opened");
      saveStore();
    }
    const previewable = [".pdf", ".txt", ".md", ".csv", ".jpg", ".jpeg", ".png"].includes(book.extension);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[book.extension] || "application/octet-stream",
      "Content-Length": fs.statSync(filePath).size,
      "Content-Disposition": isDownload || !previewable ? fileNameHeader(book.fileName) : inlineFileHeader(book.fileName),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store"
    });
    return fs.createReadStream(filePath).pipe(response);
  }

  const favoriteMatch = pathname.match(/^\/api\/books\/([a-f0-9-]+)\/favorite$/i);
  if (favoriteMatch && method === "PUT") {
    const book = store.books.find((candidate) => candidate.id === favoriteMatch[1]);
    if (!book) return sendError(response, 404, "This book is no longer available.");
    book.favorites ||= [];
    const index = book.favorites.indexOf(user.id);
    if (index === -1) book.favorites.push(user.id);
    else book.favorites.splice(index, 1);
    saveStore();
    return sendJson(response, 200, { favorite: index === -1 });
  }

  if (pathname === "/api/admin/stats" && method === "GET") {
    if (!requireAdmin(request, response)) return;
    return sendJson(response, 200, {
      books: store.books.length, users: store.users.filter((candidate) => candidate.role === "student").length,
      videos: store.videos.length,
      downloads: store.books.reduce((total, book) => total + (book.downloads || 0), 0),
      reads: store.books.reduce((total, book) => total + (book.reads || 0), 0)
    });
  }

  if (pathname === "/api/admin/about" && method === "GET") {
    if (!requireAdmin(request, response)) return;
    return sendJson(response, 200, { developers: store.developers.map((developer) => ({ ...developer })) });
  }

  if (pathname === "/api/admin/about" && method === "PUT") {
    if (!requireAdmin(request, response)) return;
    const body = await readJson(request);
    if (!Array.isArray(body.developers)) return sendError(response, 400, "Provide a list of developer profiles.");
    const developers = body.developers.slice(0, 6).map((developer, index) => {
      const existing = store.developers.find((profile) => profile.id === developer?.id);
      return normalizeDeveloper({ ...developer, photo: existing?.photo || developer?.photo }, index);
    });
    store.developers = developers;
    saveStore();
    return sendJson(response, 200, { developers });
  }

  if (pathname === "/api/admin/about/photo" && method === "POST") {
    if (!requireAdmin(request, response)) return;
    const contentType = request.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) return sendError(response, 400, "Profile photos must be uploaded using the photo form.");
    const body = await readBody(request, MAX_PROFILE_PHOTO_BYTES + 64 * 1024);
    const parts = parseMultipart(body, contentType);
    const values = Object.fromEntries(parts.filter((part) => !part.filename).map((part) => [part.name, part.data.toString("utf8")]));
    const upload = parts.find((part) => part.name === "file" && part.filename);
    if (!upload || !upload.data.length) return sendError(response, 400, "Choose a profile photo.");
    const developer = store.developers.find((profile) => profile.id === values.developerId);
    if (!developer) return sendError(response, 404, "This developer profile could not be found.");
    const fileName = path.basename(upload.filename).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
    const extension = path.extname(fileName).toLowerCase();
    if (![".jpg", ".jpeg", ".png"].includes(extension)) return sendError(response, 415, "Profile photos must be JPG or PNG images.");
    if (upload.data.length > MAX_PROFILE_PHOTO_BYTES) return sendError(response, 413, "Profile photos must be 5 MB or smaller.");
    const storedName = `${crypto.randomUUID()}${extension}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, storedName), upload.data, { flag: "wx", mode: 0o600 });
    const oldPhoto = developer.photo;
    developer.photo = storedName;
    saveStore();
    if (oldPhoto && !store.developers.some((profile) => profile.photo === oldPhoto)) {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, oldPhoto));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return sendJson(response, 200, { developer: { ...developer } });
  }

  const profilePhotoDeleteMatch = pathname.match(/^\/api\/admin\/about\/photo\/([a-z0-9-]{1,80})$/i);
  if (profilePhotoDeleteMatch && method === "DELETE") {
    if (!requireAdmin(request, response)) return;
    const developer = store.developers.find((profile) => profile.id === profilePhotoDeleteMatch[1]);
    if (!developer) return sendError(response, 404, "This developer profile could not be found.");
    const oldPhoto = developer.photo;
    developer.photo = "";
    saveStore();
    if (oldPhoto && !store.developers.some((profile) => profile.photo === oldPhoto)) {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, oldPhoto));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return sendJson(response, 200, { developer: { ...developer } });
  }

  if (pathname === "/api/admin/videos" && method === "POST") {
    if (!requireAdmin(request, response)) return;
    const contentType = request.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) return sendError(response, 400, "Video uploads must use a multipart form.");
    const body = await readBody(request, MAX_VIDEO_UPLOAD_BYTES + 256 * 1024);
    const parts = parseMultipart(body, contentType);
    const values = Object.fromEntries(parts.filter((part) => !part.filename).map((part) => [part.name, part.data.toString("utf8")]));
    const upload = parts.find((part) => part.name === "file" && part.filename);
    if (!upload || !upload.data.length) return sendError(response, 400, "Choose a video to upload.");
    const fileName = path.basename(upload.filename).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
    const extension = path.extname(fileName).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(extension)) return sendError(response, 415, "Videos must be MP4, WebM, MOV, or M4V.");
    if (upload.data.length > MAX_VIDEO_UPLOAD_BYTES) return sendError(response, 413, "Videos must be 300 MB or smaller.");
    const title = cleanText(values.title, 140) || path.basename(fileName, extension).replace(/[_-]+/g, " ");
    if (!title) return sendError(response, 400, "A video title is required.");
    const location = resourceLocation(values);
    const storedName = `${crypto.randomUUID()}${extension}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, storedName), upload.data, { flag: "wx", mode: 0o600 });
    const video = {
      id: crypto.randomUUID(), title, ...location, description: cleanText(values.description, 1200),
      fileName, extension, storedName, size: upload.data.length, uploadedAt: new Date().toISOString()
    };
    store.videos.push(video);
    saveStore();
    return sendJson(response, 201, { video: publicVideo(video) });
  }

  if (pathname === "/api/admin/videos" && method === "GET") {
    if (!requireAdmin(request, response)) return;
    return sendJson(response, 200, { videos: store.videos.map(publicVideo) });
  }

  const adminVideoEditMatch = pathname.match(/^\/api\/admin\/videos\/([a-f0-9-]+)$/i);
  if (adminVideoEditMatch && method === "PATCH") {
    if (!requireAdmin(request, response)) return;
    const video = store.videos.find((item) => item.id === adminVideoEditMatch[1]);
    if (!video) return sendError(response, 404, "This video could not be found.");
    const body = await readJson(request);
    const title = cleanText(body.title, 140);
    if (!title) return sendError(response, 400, "A video title is required.");
    video.title = title;
    video.description = cleanText(body.description, 1200);
    if (body.departmentId || body.levelId || body.subjectId) Object.assign(video, resourceLocation(body));
    saveStore();
    return sendJson(response, 200, { video: publicVideo(video) });
  }

  const adminVideoMatch = pathname.match(/^\/api\/admin\/videos\/([a-f0-9-]+)$/i);
  if (adminVideoMatch && method === "DELETE") {
    if (!requireAdmin(request, response)) return;
    const index = store.videos.findIndex((video) => video.id === adminVideoMatch[1]);
    if (index === -1) return sendError(response, 404, "This video has already been removed.");
    const [video] = store.videos.splice(index, 1);
    store.activity = store.activity.filter((item) => item.bookId !== video.id);
    saveStore();
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, video.storedName));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === "/api/admin/books" && method === "POST") {
    if (!requireAdmin(request, response)) return;
    const contentType = request.headers["content-type"] || "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) return sendError(response, 400, "Book uploads must use a multipart form.");
    const body = await readBody(request, MAX_UPLOAD_BYTES + 256 * 1024);
    const parts = parseMultipart(body, contentType);
    const values = Object.fromEntries(parts.filter((part) => !part.filename).map((part) => [part.name, part.data.toString("utf8")]));
    const upload = parts.find((part) => part.name === "file" && part.filename);
    if (!upload || !upload.data.length) return sendError(response, 400, "Choose a file to upload.");
    const fileName = path.basename(upload.filename).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 180);
    const extension = path.extname(fileName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) return sendError(response, 415, "This file type is not supported.");
    if (upload.data.length > MAX_UPLOAD_BYTES) return sendError(response, 413, "Files must be 50 MB or smaller.");
    const title = cleanText(values.title, 140) || path.basename(fileName, extension).replace(/[_-]+/g, " ");
    if (!title) return sendError(response, 400, "A book title is required.");
    const location = resourceLocation(values);
    const storedName = `${crypto.randomUUID()}${extension}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, storedName), upload.data, { flag: "wx", mode: 0o600 });
    const book = {
      id: crypto.randomUUID(), title, author: cleanText(values.author, 100) || "Nasawa Technical College",
      ...location, description: cleanText(values.description, 1200), fileName, extension,
      storedName, size: upload.data.length, uploadedAt: new Date().toISOString(),
      downloads: 0, reads: 0, favorites: []
    };
    store.books.push(book);
    saveStore();
    return sendJson(response, 201, { book: publicBook(book, user.id) });
  }

  if (pathname === "/api/admin/books" && method === "GET") {
    if (!requireAdmin(request, response)) return;
    return sendJson(response, 200, { books: store.books.map((book) => publicBook(book, user.id)) });
  }

  const adminBookEditMatch = pathname.match(/^\/api\/admin\/books\/([a-f0-9-]+)$/i);
  if (adminBookEditMatch && method === "PATCH") {
    if (!requireAdmin(request, response)) return;
    const book = store.books.find((item) => item.id === adminBookEditMatch[1]);
    if (!book) return sendError(response, 404, "This book could not be found.");
    const body = await readJson(request);
    const title = cleanText(body.title, 140);
    if (!title) return sendError(response, 400, "A book title is required.");
    book.title = title;
    book.author = cleanText(body.author, 100) || book.author;
    book.description = cleanText(body.description, 1200);
    if (body.departmentId || body.levelId || body.subjectId) Object.assign(book, resourceLocation(body));
    saveStore();
    return sendJson(response, 200, { book: publicBook(book, user.id) });
  }

  const adminBookMatch = pathname.match(/^\/api\/admin\/books\/([a-f0-9-]+)$/i);
  if (adminBookMatch && method === "DELETE") {
    if (!requireAdmin(request, response)) return;
    const index = store.books.findIndex((book) => book.id === adminBookMatch[1]);
    if (index === -1) return sendError(response, 404, "This book has already been removed.");
    const [book] = store.books.splice(index, 1);
    store.activity = store.activity.filter((item) => item.bookId !== book.id);
    if (book.sourcePath && !store.excludedBookSources.includes(book.sourcePath)) {
      store.excludedBookSources.push(book.sourcePath);
    }
    saveStore();
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, book.storedName));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === "/api/admin/users" && method === "GET") {
    if (!requireAdmin(request, response)) return;
    return sendJson(response, 200, { users: store.users.map(safeUser) });
  }

  const userMatch = pathname.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/i);
  if (userMatch && method === "PATCH") {
    if (!requireAdmin(request, response)) return;
    const target = store.users.find((candidate) => candidate.id === userMatch[1]);
    if (!target) return sendError(response, 404, "This account could not be found.");
    const body = await readJson(request);
    if (target.id === user.id && body.active === false) return sendError(response, 400, "You cannot suspend your own account.");
    if (target.role === "admin" && body.role !== "admin") return sendError(response, 400, "The primary administrator role cannot be removed.");
    if (body.active === true || body.active === false) target.active = body.active;
    if (body.role === "student") target.role = "student";
    saveStore();
    return sendJson(response, 200, { user: safeUser(target) });
  }

  if (userMatch && method === "DELETE") {
    if (!requireAdmin(request, response)) return;
    const target = store.users.find((candidate) => candidate.id === userMatch[1]);
    if (!target) return sendError(response, 404, "This account could not be found.");
    if (target.id === user.id || target.role === "admin") return sendError(response, 400, "Administrator accounts cannot be deleted here.");
    store.users = store.users.filter((candidate) => candidate.id !== target.id);
    store.activity = store.activity.filter((item) => item.userId !== target.id);
    store.books.forEach((book) => { book.favorites = (book.favorites || []).filter((id) => id !== target.id); });
    saveStore();
    return sendJson(response, 200, { ok: true });
  }

  return sendError(response, 404, "That library endpoint does not exist.");
}

function serveStatic(request, response, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendError(response, 400, "Invalid URL.");
  }
  if (pathname === "/") pathname = "/INDEX.HTML";
  const publicFiles = new Map([
    ["/INDEX.HTML", path.join(ROOT, "INDEX.HTML")],
    ["/STYLE.CSS", path.join(ROOT, "STYLE.CSS")],
    ["/SCRIPT.JS", path.join(ROOT, "SCRIPT.JS")],
    ["/BOOK-CATALOG.JS", path.join(ROOT, "BOOK-CATALOG.JS")],
    ["/PHOTOS/IMG-1.JPG", path.join(ROOT, "PHOTOS", "IMG-1.jpg")]
  ]);
  const filePath = publicFiles.get(pathname.toUpperCase());
  if (!filePath) return sendError(response, 404, "Page not found.");
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) return sendError(response, 404, "Page not found.");
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stats.size,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; frame-src 'self'; object-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

async function start() {
  // Provision the first administrator from environment variables, never from committed source.
  const admin = store.users.find((user) => user.email === ADMIN_EMAIL);
  if (!store.developers.length) store.developers = DEFAULT_DEVELOPERS.map((developer, index) => normalizeDeveloper(developer, index));
  if (!admin) {
    const password = process.env.ADMIN_PASSWORD;
    if (!password || password.length < 10 || password.length > 128) {
      throw new Error("Set ADMIN_PASSWORD to a unique password between 10 and 128 characters before starting the server.");
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
    store.users.push({
      id: crypto.randomUUID(), name: "Library Administrator", email: ADMIN_EMAIL,
      salt, passwordHash, role: "admin", active: true, createdAt: new Date().toISOString()
    });
    saveStore();
  } else if (admin.role !== "admin") {
    throw new Error(`The configured administrator email ${ADMIN_EMAIL} is already registered as a student.`);
  }
  importBooksFromFolder();
  initializeHierarchy();
  saveStore();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
          response.setHeader("Allow", "GET, POST, PUT, PATCH, DELETE");
          return sendError(response, 405, "This request method is not supported.");
        }
        await handleApi(request, response, url);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        return sendError(response, 405, "This request method is not supported.");
      }
      serveStatic(request, response, url);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status === 500) console.error("Request failed:", error);
      sendError(response, status, status === 500 ? "The library could not complete this request." : error.message);
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Nasawa E-Library is listening on port ${PORT}.`);
  });
}

start().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
