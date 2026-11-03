"use strict";

// Keep the interface state in memory; user accounts, books, and activity live on the server.
const DEPARTMENTS = [
  "Accounting", "Administrative Studies", "Automobile Mechanics", "Brick Laying",
  "Carpentry and Joinery", "Community Development", "Fabrication and Welding",
  "General Fitting", "Human Resource Management", "Information and Communication Technology",
  "Motorcycle Mechanics", "Procurement", "Public Health"
];
const COVER_TONES = ["sage", "sand", "blue", "rose", "gold", "lavender"];
const OFFLINE_ACCOUNTS_KEY = "nasawa-offline-accounts";
const OFFLINE_SESSION_KEY = "nasawa-offline-session";
const OFFLINE_FAVORITES_KEY = "nasawa-offline-favorites";
const OFFLINE_ACTIVITY_KEY = "nasawa-offline-activity";
const OFFLINE_ABOUT_KEY = "nasawa-offline-about";
const state = {
  user: null,
  books: [],
  videos: [],
  developers: [],
  offlineMode: window.location.protocol === "file:",
  view: "home",
  category: "All departments",
  selectedLevel: "",
  selectedSubject: "",
  videoCategory: "All departments",
  query: "",
  adminTab: "books",
  authMode: "login"
};

// Escape all server-provided text before placing it into generated interface markup.
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const authScreen = $("#auth-screen");
const app = $("#app");
const pageContent = $("#page-content");
const authForm = $("#auth-form");

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(date));
}

function initials(name = "Nasawa") {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function notify(message, isError = false) {
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " is-error" : ""}`;
  toast.textContent = message;
  $("#toast-region").append(toast);
  window.setTimeout(() => toast.remove(), 3800);
}

function readLocalJSON(key, fallback) {
  const value = localStorage.getItem(key);
  return value ? JSON.parse(value) : fallback;
}

function offlineBookCatalog() {
  const paths = window.NASAWA_BOOK_CATALOG || [];
  const favorites = readLocalJSON(OFFLINE_FAVORITES_KEY, {});
  const departments = new Map([
    ["INFORMATION AND COMMUNICATION TECHNOLOGY", "Information and Communication Technology"],
    ["FABLICATION AND WELDING", "Fabrication and Welding"]
  ]);
  return paths.map((relativePath, index) => {
    const segments = relativePath.split("/");
    const fileName = segments[segments.length - 1];
    const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    const departmentFolder = segments[0].toUpperCase();
    const department = departments.get(departmentFolder) || departmentFolder.toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
    const levelFolder = segments.find((part) => /^level\s*\d+$/i.test(part)) || "";
    const levelIndex = levelFolder ? segments.indexOf(levelFolder) : -1;
    const subject = levelIndex >= 0 && segments[levelIndex + 1] && levelIndex + 1 < segments.length - 1
      ? segments[levelIndex + 1] : "";
    const id = `offline-${index + 1}`;
    return {
      id, title: fileName.slice(0, -extension.length).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim(),
      author: "Nasawa Technical College", category: department, description: "",
      fileName, extension, size: 0, uploadedAt: new Date(index).toISOString(),
      favorite: (favorites[state.user?.id] || []).includes(id),
      relativePath, level: levelFolder, subject,
      fileUrl: `./BOOKS/${segments.map(encodeURIComponent).join("/")}`
    };
  });
}

function titleCaseFolder(value = "") {
  return value.trim().split(/[\s_-]+/).filter(Boolean).map((word) => (
    word.length <= 3 ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()
  )).join(" ");
}

function bookHierarchy(book) {
  const parts = (book.relativePath || "").split(/[\\/]/).filter(Boolean);
  const level = book.level || parts.find((part) => /^level\s*\d+$/i.test(part)) || "Other resources";
  const levelIndex = parts.findIndex((part) => /^level\s*\d+$/i.test(part));
  const subject = book.subject || (levelIndex >= 0 && parts[levelIndex + 1] !== parts[parts.length - 1] ? parts[levelIndex + 1] : "General");
  return { level: titleCaseFolder(level), subject: titleCaseFolder(subject) };
}

function offlinePasswordHash(password, salt) {
  if (!window.crypto?.subtle) throw new Error("Secure browser sign-in needs HTTPS. Serve this static site over HTTPS or on localhost.");
  const bytes = new Uint8Array(salt.match(/.{2}/g).map((part) => Number.parseInt(part, 16)));
  return window.crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"])
    .then((key) => window.crypto.subtle.deriveBits({ name: "PBKDF2", salt: bytes, iterations: 120000, hash: "SHA-256" }, key, 256))
    .then((derived) => [...new Uint8Array(derived)].map((value) => value.toString(16).padStart(2, "0")).join(""));
}

async function offlineApi(url, options = {}) {
  const method = options.method || "GET";
  const payload = typeof options.body === "string" ? JSON.parse(options.body) : {};
  const accounts = readLocalJSON(OFFLINE_ACCOUNTS_KEY, []);
  const session = readLocalJSON(OFFLINE_SESSION_KEY, null);
  const route = url.split("?")[0];
  const fail = (message, status = 400) => {
    const error = new Error(message);
    error.status = status;
    throw error;
  };

  if (route === "/api/me" && method === "GET") {
    if (!session) fail("Please log in to continue.", 401);
    return { user: session };
  }
  if (route === "/api/auth/register" && method === "POST") {
    const name = String(payload.name || "").trim();
    const email = String(payload.email || "").trim().toLowerCase();
    const password = String(payload.password || "");
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || password.length > 128) {
      fail("Enter your name, a valid email, and a password between 10 and 128 characters.");
    }
    if (email === "richardcameron185@gmail.com") fail("Administrator sign-in requires the server-enabled deployment.", 403);
    if (accounts.some((account) => account.email === email)) fail("An account already exists for that email.", 409);
    const salt = [...window.crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, "0")).join("");
    const user = { id: `local-${window.crypto.randomUUID()}`, name, email, role: "student", active: true, createdAt: new Date().toISOString() };
    accounts.push({ ...user, salt, passwordHash: await offlinePasswordHash(password, salt) });
    localStorage.setItem(OFFLINE_ACCOUNTS_KEY, JSON.stringify(accounts));
    localStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(user));
    return { user };
  }
  if (route === "/api/auth/login" && method === "POST") {
    const email = String(payload.email || "").trim().toLowerCase();
    if (email === "richardcameron185@gmail.com") fail("Administrator sign-in requires the server-enabled deployment.", 403);
    const account = accounts.find((candidate) => candidate.email === email);
    if (!account) fail("Email or password is incorrect.", 401);
    const passwordHash = await offlinePasswordHash(String(payload.password || ""), account.salt);
    if (passwordHash !== account.passwordHash || !account.active) fail("Email or password is incorrect.", 401);
    const user = { id: account.id, name: account.name, email: account.email, role: "student", active: true, createdAt: account.createdAt };
    localStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(user));
    return { user };
  }
  if (route === "/api/auth/logout" && method === "POST") {
    localStorage.removeItem(OFFLINE_SESSION_KEY);
    return { ok: true };
  }
  if (!session) fail("Please log in to continue.", 401);
  if (route === "/api/books" && method === "GET") return { books: offlineBookCatalog() };
  if (route === "/api/about" && method === "GET") {
    return { developers: readLocalJSON(OFFLINE_ABOUT_KEY, [
      { id: "richard-cameron", name: "Richard Cameron", role: "Lead Developer & Systems Architect", bio: "Builds the library experience, product flow, and technical systems behind a smooth learning environment.", accent: "sage" },
      { id: "joshua", name: "Joshua", role: "Co-Developer & Product Partner", bio: "Helps shape the academic experience, feature planning, and student-first improvements across the platform.", accent: "gold" }
    ]) };
  }
  if (route === "/api/videos" && method === "GET") return { videos: [] };
  if (route === "/api/activity" && method === "GET") return { activity: readLocalJSON(OFFLINE_ACTIVITY_KEY, {})[session.id] || [] };
  const favoriteMatch = route.match(/^\/api\/books\/([^/]+)\/favorite$/);
  if (favoriteMatch && method === "PUT") {
    const favorites = readLocalJSON(OFFLINE_FAVORITES_KEY, {});
    const userFavorites = favorites[session.id] || [];
    const index = userFavorites.indexOf(favoriteMatch[1]);
    if (index === -1) userFavorites.push(favoriteMatch[1]);
    else userFavorites.splice(index, 1);
    favorites[session.id] = userFavorites;
    localStorage.setItem(OFFLINE_FAVORITES_KEY, JSON.stringify(favorites));
    return { favorite: index === -1 };
  }
  if (route.startsWith("/api/admin/")) fail("Admin dashboard actions need the server-enabled deployment.", 403);
  fail("This action is unavailable in static browser mode.", 404);
}

async function api(url, options = {}) {
  if (state.offlineMode) return offlineApi(url, options);
  let response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: options.body instanceof FormData
        ? { ...(options.headers || {}) }
        : { "Content-Type": "application/json", ...(options.headers || {}) }
    });
  } catch {
    state.offlineMode = true;
    return offlineApi(url, options);
  }
  const contentType = response.headers.get("content-type") || "";
  if (window.location.protocol === "file:" || !contentType.includes("application/json") && response.status >= 200 && response.status < 500) {
    state.offlineMode = true;
    return offlineApi(url, options);
  }
  const result = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {


    if (response.status === 401 && state.user) showAuth();
    throw new Error(result?.error || `The library server returned an unexpected response (HTTP ${response.status}). Check the server URL and deployment logs.`);
  }


  if (!result && !url.includes("/file")) throw new Error("The library server returned an unexpected response. Check the deployment logs.");
  return result;
}

function showAuth() {
  state.user = null;


  app.classList.add("is-hidden");
  authScreen.classList.remove("is-hidden");
  setAuthMode("login");
}

function setAuthMode(mode) {
  
  state.authMode = mode; 












  const registering = mode === "register";
  $("#name-field").classList.toggle("is-hidden", !registering);
  $("#auth-kicker").textContent = registering ? "START SOMETHING GREAT" : "WELCOME BACK";
  $("#auth-title").textContent = registering ? "Your library awaits." : "Good to see you.";
  $("#auth-subtitle").textContent = registering ? "Create your account and explore." : "Sign in to continue your learning journey.";
  $("#auth-submit-label").textContent = registering ? "Create account" : "Log in";
  $('[name="password"]', authForm).autocomplete = registering ? "new-password" : "current-password";
  $$(".auth-tab").forEach((button) => {
    const active = button.dataset.authMode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#auth-message").textContent = "";
}

async function loadLibrary() {
  const result = await api("/api/books");
  state.books = result.books;
  renderPage();
  renderDepartments();
}

async function loadAbout() {
  const result = await api("/api/about");
  state.developers = result.developers || [];
}

async function loadVideos() {
  const result = await api("/api/videos");
  state.videos = result.videos;
  if (state.view === "videos") renderVideos();
}

async function enterLibrary(user) {
  state.user = user;
  authScreen.classList.add("is-hidden");
  app.classList.remove("is-hidden");
  $("#sidebar-name").textContent = user.name;
  $("#sidebar-role").textContent = user.role === "admin" ? "Library administrator" : "Student account";
  $("#sidebar-avatar").textContent = initials(user.name);
  $("#topbar-avatar").textContent = initials(user.name);
  const oldAdminLink = $('[data-view="admin"]');
  if (oldAdminLink) oldAdminLink.remove();
  if (user.role === "admin") {
    const adminLink = document.createElement("button");
    adminLink.className = "nav-link";
    adminLink.dataset.view = "admin";
    adminLink.innerHTML = '<span class="nav-icon">⚙</span>Admin dashboard';
    $(".nav-list").append(adminLink);
  }
  state.view = "home";
  state.category = "All departments";
  await Promise.all([loadAbout(), loadLibrary(), loadVideos()]);
}

function renderDepartments() {
  const categories = [...new Set([...DEPARTMENTS, ...state.books.map((book) => book.category)].filter(Boolean))];
  $("#department-nav").innerHTML = categories.map((category) => `
    <button class="nav-link${["department-levels", "department-subjects", "subject-books"].includes(state.view) && state.category === category ? " is-active" : ""}" data-department="${escapeHTML(category)}">
      <span class="nav-icon">↗</span>${escapeHTML(category)}
    </button>`).join("");
}

function booksForDepartment(department) {
  return state.books.filter((book) => book.category === department);
}

function renderDepartmentLevels() {
  const books = booksForDepartment(state.category);
  const levels = [...new Set(books.map((book) => bookHierarchy(book).level))];
  $("#breadcrumb-current").textContent = state.category;
  pageContent.innerHTML = `
    <div class="page-intro"><span class="eyebrow">DEPARTMENT LIBRARY</span><h1>${escapeHTML(state.category)}</h1><p>Choose a level to browse its subjects.</p></div>
    <div class="hierarchy-grid">
      ${levels.length ? levels.map((level) => `
        <button class="hierarchy-card" data-level="${escapeHTML(level)}">
          <span class="hierarchy-card-icon">▤</span>
          <span><strong>${escapeHTML(level)}</strong><small>${books.filter((book) => bookHierarchy(book).level === level).length} resources</small></span>
          <span class="hierarchy-card-arrow">→</span>
        </button>`).join("") : '<div class="empty-state"><strong>No resources in this department yet</strong>Resources are grouped by level and subject when they are present in the BOOKS folder.</div>'}
    </div>`;
  syncNavigation();
}

function renderDepartmentSubjects() {
  const books = booksForDepartment(state.category).filter((book) => bookHierarchy(book).level === state.selectedLevel);
  const subjects = [...new Set(books.map((book) => bookHierarchy(book).subject))];
  $("#breadcrumb-current").textContent = `${state.category} / ${state.selectedLevel}`;
  pageContent.innerHTML = `
    <div class="hierarchy-breadcrumb"><button class="text-button" data-back-to-levels>← ${escapeHTML(state.category)}</button></div>
    <div class="page-intro"><span class="eyebrow">${escapeHTML(state.category)}</span><h1>${escapeHTML(state.selectedLevel)}</h1><p>Choose a subject to open its learning resources.</p></div>
    <div class="hierarchy-grid">
      ${subjects.length ? subjects.map((subject) => `
        <button class="hierarchy-card" data-subject="${escapeHTML(subject)}">
          <span class="hierarchy-card-icon">▧</span>
          <span><strong>${escapeHTML(subject)}</strong><small>${books.filter((book) => bookHierarchy(book).subject === subject).length} resources</small></span>
          <span class="hierarchy-card-arrow">→</span>
        </button>`).join("") : '<div class="empty-state"><strong>No subjects available</strong>This level does not contain any subject folders yet.</div>'}
    </div>`;
  syncNavigation();
}

function bookTone(category) {
  let total = 0;
  for (const character of category) total = (total * 31 + character.charCodeAt(0)) >>> 0;
  return COVER_TONES[total % COVER_TONES.length];
}

function bookCard(book) {
  const extension = book.extension.replace(".", "").toUpperCase();
  const tone = bookTone(book.category);
  const glyph = escapeHTML((book.title.trim()[0] || "N").toUpperCase());
  return `
    <article class="book-card" data-open-book="${book.id}" tabindex="0" role="button" aria-label="Open ${escapeHTML(book.title)}">
      <div class="book-cover cover-${tone}">
        <span class="cover-glyph">${glyph}</span><span class="cover-type">${escapeHTML(extension)}</span>
        <button class="favorite-button${book.favorite ? " is-saved" : ""}" data-favorite="${book.id}" aria-label="${book.favorite ? "Remove saved book" : "Save book"}" title="${book.favorite ? "Remove from saved" : "Save book"}">${book.favorite ? "♥" : "♡"}</button>
      </div>
      <h3>${escapeHTML(book.title)}</h3>
      <p class="book-author">${escapeHTML(book.author || "Nasawa Technical College")}</p>
      <div class="book-meta"><span class="book-tag">${escapeHTML(book.category)}</span><span>${formatSize(book.size)}</span></div>
    </article>`;
}

function visibleBooks() {
  let books = [...state.books];
  if (state.view === "saved") books = books.filter((book) => book.favorite);
  if (state.view === "category") books = books.filter((book) => book.category === state.category);
  if (state.view === "subject-books") {
    books = books.filter((book) => {
      const location = bookHierarchy(book);
      return book.category === state.category && location.level === state.selectedLevel && location.subject === state.selectedSubject;
    });
  }
  if (state.query) {
    const query = state.query.toLocaleLowerCase();
    books = books.filter((book) => [book.title, book.author, book.category, book.description].some((value) => (value || "").toLocaleLowerCase().includes(query)));
  }
  return books.sort((left, right) => new Date(right.uploadedAt) - new Date(left.uploadedAt));
}

// Render cards from the current search, department, and saved-book filters.
function cardsMarkup(books) {
  if (!books.length) {
    const title = state.view === "saved" ? "Nothing saved just yet" : "Your library is ready to grow";
    const detail = state.query ? "Try a different search term." : state.user.role === "admin" ? "Add your first learning resource from the admin dashboard." : "Check back soon for learning resources from your department.";
    return `<div class="empty-state"><strong>${title}</strong>${detail}</div>`;
  }
  return books.map(bookCard).join("");
}

function renderAbout() {
  $("#breadcrumb-current").textContent = "About";
  const developers = state.developers.length ? state.developers : [
    { id: "richard-cameron", name: "Richard Cameron", role: "Lead Developer & Systems Architect", bio: "Builds the library experience, product flow, and technical systems behind a smooth learning environment.", accent: "sage" },
    { id: "joshua", name: "Joshua", role: "Co-Developer & Product Partner", bio: "Helps shape the academic experience, feature planning, and student-first improvements across the platform.", accent: "gold" }
  ];
  pageContent.innerHTML = `
    <div class="page-intro"><span class="eyebrow">WHO BUILT THIS</span><h1>About the development team</h1><p>We created this library to support practical learning, digital access, and a stronger student experience.</p></div>
    <div class="team-grid">
      ${developers.map((developer) => `
        <article class="team-card ${developer.accent || "sage"}">
          <div class="member-photo">${developer.photo ? `<img src="/api/about/photos/${encodeURIComponent(developer.photo)}" alt="${escapeHTML(developer.name)}">` : escapeHTML(initials(developer.name))}</div>
          <div class="member-meta">
            <h3>${escapeHTML(developer.name)}</h3>
            <p class="member-role">${escapeHTML(developer.role)}</p>
            <p class="member-bio">${escapeHTML(developer.bio)}</p>
          </div>
        </article>`).join("")}
    </div>`;
  syncNavigation();
}

function renderVideos() {
  $("#breadcrumb-current").textContent = "Video lessons";
  const departments = [...new Set([...DEPARTMENTS, ...state.videos.map((video) => video.category)])];
  const query = state.query.toLocaleLowerCase();
  const videos = state.videos.filter((video) => (
    (state.videoCategory === "All departments" || video.category === state.videoCategory)
    && (!query || [video.title, video.category, video.description].some((value) => (value || "").toLocaleLowerCase().includes(query)))
  ));
  pageContent.innerHTML = `
    <div class="page-intro"><span class="eyebrow">WATCH AND LEARN</span><h1>Video lessons</h1><p>Explore practical lessons uploaded for each department.</p></div>
    <label class="field video-filter">Department
      <select id="video-department-filter">
        <option ${state.videoCategory === "All departments" ? "selected" : ""}>All departments</option>
        ${departments.map((department) => `<option ${state.videoCategory === department ? "selected" : ""}>${escapeHTML(department)}</option>`).join("")}
      </select>
    </label>
    <div class="video-grid">
      ${videos.length ? videos.map((video) => `
        <article class="video-card">
          <video controls preload="metadata" playsinline src="/api/videos/${encodeURIComponent(video.id)}/file">${escapeHTML(video.title)}</video>
          <div class="video-card-copy"><span class="book-tag">${escapeHTML(video.category)}</span><h2>${escapeHTML(video.title)}</h2>
            ${video.description ? `<p>${escapeHTML(video.description)}</p>` : ""}
          </div>
        </article>`).join("") : '<div class="empty-state"><strong>No video lessons yet</strong>Videos added by the library administrator will appear here.</div>'}
    </div>`;
  syncNavigation();
}

function renderHome() {
  const books = visibleBooks();
  const categoryCount = new Set(state.books.map((book) => book.category)).size;
  const savedCount = state.books.filter((book) => book.favorite).length;
  const heading = state.view === "saved" ? "Saved books" : state.view === "category" ? state.category : state.view === "subject-books" ? state.selectedSubject : "Explore the collection";
  const description = state.view === "saved" ? "Your personal reading list, all in one place." : state.view === "category" ? "Resources from this department." : state.view === "subject-books" ? `${state.category} · ${state.selectedLevel}` : "Practical knowledge for every path you're building.";
  $("#breadcrumb-current").textContent = state.view === "saved" ? "Saved books" : state.view === "category" ? state.category : state.view === "subject-books" ? `${state.category} / ${state.selectedLevel} / ${state.selectedSubject}` : "Discover";
  pageContent.innerHTML = `
    ${state.view === "home" ? `
      <section class="welcome-banner">
        <div class="banner-copy"><span class="eyebrow">YOUR CAMPUS. YOUR NEXT CHAPTER.</span><h1>Welcome in, ${escapeHTML(state.user.name.split(/\s+/)[0])}.</h1><p>Find the knowledge that moves your future forward.</p></div>
        <div class="banner-decoration" aria-hidden="true">✳</div>
      </section>
      <div class="stats-strip">
        <div class="stat-item"><span class="stat-icon">▤</span><span><strong class="stat-value">${state.books.length}</strong><span class="stat-label">Learning resources</span></span></div>
        <div class="stat-item"><span class="stat-icon">⌘</span><span><strong class="stat-value">${categoryCount}</strong><span class="stat-label">Departments</span></span></div>
        <div class="stat-item"><span class="stat-icon">♡</span><span><strong class="stat-value">${savedCount}</strong><span class="stat-label">Saved for later</span></span></div>
      </div>
      <div class="section-heading"><div><h2>Browse by department</h2><p>Find resources for what you're learning.</p></div></div>
      <div class="category-pills">
        <button class="category-pill${state.category === "All departments" ? " is-active" : ""}" data-category="All departments">All departments</button>
        ${[...new Set([...DEPARTMENTS, ...state.books.map((book) => book.category)])].map((category) => `<button class="category-pill${state.category === category ? " is-active" : ""}" data-department="${escapeHTML(category)}">${escapeHTML(category)}</button>`).join("")}
      </div>` : `
      <div class="page-intro"><span class="eyebrow">NASAWA LIBRARY</span><h1>${escapeHTML(heading)}</h1><p>${escapeHTML(description)}</p></div>`}
    ${state.view === "subject-books" ? `<div class="hierarchy-breadcrumb"><button class="text-button" data-back-to-subjects>← ${escapeHTML(state.selectedLevel)} subjects</button></div>` : ""}
    <div class="section-heading"><div><h2>${state.view === "home" ? "Recently added" : `${books.length} ${books.length === 1 ? "resource" : "resources"}`}</h2><p>${state.view === "home" ? "A fresh place to start." : "Explore and keep learning."}</p></div>${state.user.role === "admin" && state.view === "home" ? '<button class="button button-quiet button-small" data-action="upload">＋ Add resource</button>' : ""}</div>
    <div class="book-grid">${cardsMarkup(state.view === "home" ? books.slice(0, 8) : books)}</div>
    ${state.view === "home" && books.length > 8 ? '<div class="section-heading"><button class="text-button" data-view="all-books">View all resources →</button></div>' : ""}`;
  syncNavigation();
}

async function renderActivity() {
  $("#breadcrumb-current").textContent = "My activity";
  pageContent.innerHTML = '<div class="page-intro"><span class="eyebrow">YOUR LEARNING JOURNEY</span><h1>My activity</h1><p>Your recently opened and downloaded resources.</p></div><div class="activity-list"><div class="empty-state">Loading your activity…</div></div>';
  syncNavigation();
  try {
    const { activity } = await api("/api/activity");
    if (state.view !== "activity") return;
    $(".activity-list").innerHTML = activity.length ? activity.map((item) => `
      <div class="activity-row"><span class="activity-icon">${item.action === "downloaded" ? "↓" : "◉"}</span><div><strong>${escapeHTML(item.title)}</strong><p>${item.action === "downloaded" ? "Downloaded" : "Opened"} · ${formatDate(item.at)}</p></div></div>`).join("") : '<div class="empty-state"><strong>Your story starts here</strong>Open or download a book and it will show up here.</div>';
  } catch (error) {
    notify(error.message, true);
  }
}

function syncNavigation() {
  $$(".nav-link", $(".nav-list")).forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.view);
  });
  $$(".nav-link", $("#department-nav")).forEach((button) => {
    button.classList.toggle("is-active", ["department-levels", "department-subjects", "subject-books"].includes(state.view) && button.dataset.department === state.category);
  });
}

async function renderAdmin() {
  $("#breadcrumb-current").textContent = "Admin dashboard";
  pageContent.innerHTML = '<div class="empty-state">Loading dashboard…</div>';
  syncNavigation();
  try {
    const stats = await api("/api/admin/stats");
    const isBooks = state.adminTab === "books";
    const isUsers = state.adminTab === "users";
    const isVideos = state.adminTab === "videos";
    const isAbout = state.adminTab === "about";
    pageContent.innerHTML = `
      <div class="section-heading">
        <div class="page-intro"><span class="eyebrow">LIBRARY MANAGEMENT</span><h1>Admin dashboard</h1><p>Manage learning resources, people, and the campus story.</p></div>
        <div class="admin-toolbar">
          ${isBooks ? '<button class="button button-primary button-small" data-action="upload">＋ Upload resource</button>' : ""}
          ${isVideos ? '<button class="button button-primary button-small" data-action="upload-video">＋ Upload video</button>' : ""}
          <button class="button button-quiet button-small" data-action="manage-users">Manage users</button>
        </div>
      </div>
      <div class="admin-overview">
        <div class="admin-stat"><span>Library resources</span><strong>${stats.books}</strong></div>
        <div class="admin-stat"><span>Video lessons</span><strong>${stats.videos}</strong></div>
        <div class="admin-stat"><span>Student accounts</span><strong>${stats.users}</strong></div>
        <div class="admin-stat"><span>Downloads</span><strong>${stats.downloads}</strong></div>
        <div class="admin-stat"><span>Online reads</span><strong>${stats.reads}</strong></div>
      </div>
      <div class="admin-tabs">
        <button class="admin-tab${isBooks ? " is-active" : ""}" data-admin-tab="books">Library catalog</button>
        <button class="admin-tab${isVideos ? " is-active" : ""}" data-admin-tab="videos">Video lessons</button>
        <button class="admin-tab${isUsers ? " is-active" : ""}" data-admin-tab="users">User accounts</button>
        <button class="admin-tab${isAbout ? " is-active" : ""}" data-admin-tab="about">About team</button>
      </div>
      <div class="admin-panel" id="admin-panel"><div class="empty-state">Loading…</div></div>`;
    await renderAdminTable();
  } catch (error) {
    pageContent.innerHTML = `<div class="empty-state"><strong>Dashboard unavailable</strong>${escapeHTML(error.message)}</div>`;
  }
}

async function renderAdminTable() {
  const panel = $("#admin-panel");
  if (!panel) return;
  if (state.adminTab === "about") {
    const { developers } = await api("/api/admin/about");
    panel.innerHTML = `
      <div class="admin-panel-header"><h2>Development team</h2><span>${developers.length} team profiles</span></div>
      <form id="about-form" class="about-form">
        <div class="about-fields">
          ${developers.map((developer, index) => `
            <fieldset class="developer-editor" data-developer-id="${escapeHTML(developer.id)}" data-developer-index="${index}">
              <legend>${escapeHTML(developer.name || `Developer ${index + 1}`)}</legend>
              <div class="profile-photo-editor">
                <div class="member-photo">${developer.photo ? `<img src="/api/about/photos/${encodeURIComponent(developer.photo)}" alt="${escapeHTML(developer.name)}">` : escapeHTML(initials(developer.name))}</div>
                <div class="profile-photo-actions">
                  <label class="button button-quiet button-small">Change photo<input type="file" accept=".jpg,.jpeg,.png" data-developer-photo="${escapeHTML(developer.id)}" hidden></label>
                  <button class="button button-danger button-small${developer.photo ? "" : " is-hidden"}" type="button" data-remove-photo="${escapeHTML(developer.id)}">Remove photo</button>
                </div>
              </div>
              <label class="field">Name<input name="name-${index}" value="${escapeHTML(developer.name || "")}" maxlength="80"></label>
              <label class="field">Role<input name="role-${index}" value="${escapeHTML(developer.role || "")}" maxlength="80"></label>
              <label class="field">Accent<select name="accent-${index}">
                ${["sage","sand","blue","rose","gold","lavender"].map((accent) => `<option value="${accent}" ${developer.accent === accent ? "selected" : ""}>${escapeHTML(accent)}</option>`).join("")}
              </select></label>
              <label class="field">Bio<textarea name="bio-${index}" rows="3" maxlength="300">${escapeHTML(developer.bio || "")}</textarea></label>
            </fieldset>`).join("")}
        </div>
        <div class="dialog-actions about-save-row"><button class="button button-primary" type="submit">Save profiles</button></div>
      </form>`;
    return;
  }
  const booksTab = state.adminTab === "books";
  const videosTab = state.adminTab === "videos";
  const data = await api(booksTab ? "/api/admin/books" : videosTab ? "/api/admin/videos" : "/api/admin/users");
  if (booksTab) {
    panel.innerHTML = `
      <div class="admin-panel-header"><h2>Library catalog</h2><span>${data.books.length} total resources</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>RESOURCE</th><th>DEPARTMENT</th><th>FORMAT</th><th>DOWNLOADS</th><th>ACTION</th></tr></thead>
      <tbody>${data.books.length ? data.books.map((book) => `<tr>
        <td><strong>${escapeHTML(book.title)}</strong><br>${escapeHTML(book.author)}</td><td>${escapeHTML(book.category)}</td>
        <td>${escapeHTML(book.extension.replace(".", "").toUpperCase())} · ${formatSize(book.size)}</td><td>${book.downloads}</td>
        <td><button class="button button-danger button-small" data-delete-book="${book.id}">Delete</button></td>
      </tr>`).join("") : '<tr><td colspan="5">No resources yet. Upload the first book to get started.</td></tr>'}</tbody></table></div>`;
  } else if (videosTab) {
    panel.innerHTML = `
      <div class="admin-panel-header"><h2>Video lessons</h2><span>${data.videos.length} total videos</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>VIDEO</th><th>DEPARTMENT</th><th>FORMAT</th><th>SIZE</th><th>ACTION</th></tr></thead>
      <tbody>${data.videos.length ? data.videos.map((video) => `<tr>
        <td><strong>${escapeHTML(video.title)}</strong></td><td>${escapeHTML(video.category)}</td>
        <td>${escapeHTML(video.extension.replace(".", "").toUpperCase())}</td><td>${formatSize(video.size)}</td>
        <td><button class="button button-danger button-small" data-delete-video="${escapeHTML(video.id)}">Delete</button></td>
      </tr>`).join("") : '<tr><td colspan="5">No videos yet. Upload the first department lesson.</td></tr>'}</tbody></table></div>`;
  } else {
    panel.innerHTML = `
      <div class="admin-panel-header"><h2>User accounts</h2><span>${data.users.length} accounts</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th>ACTION</th></tr></thead>
      <tbody>${data.users.length ? data.users.map((user) => `<tr>
        <td><strong>${escapeHTML(user.name)}</strong></td><td>${escapeHTML(user.email)}</td><td>${user.role === "admin" ? "Administrator" : "Student"}</td>
        <td><span class="status-badge${user.active ? "" : " is-inactive"}">${user.active ? "Active" : "Suspended"}</span></td>
        <td>${user.role === "admin" ? "—" : `<div class="table-actions"><button class="button button-quiet button-small" data-toggle-user="${user.id}" data-active="${user.active}">${user.active ? "Suspend" : "Restore"}</button><button class="button button-danger button-small" data-delete-user="${user.id}">Delete</button></div>`}</td>
      </tr>`).join("") : '<tr><td colspan="5">No accounts found.</td></tr>'}</tbody></table></div>`;
  }
}

function renderPage() {
  if (!state.user) return;
  if (state.view === "about") return void renderAbout();
  if (state.view === "activity") return void renderActivity();
  if (state.view === "videos") return void renderVideos();
  if (state.view === "department-levels") return void renderDepartmentLevels();
  if (state.view === "department-subjects") return void renderDepartmentSubjects();
  if (state.view === "admin") return void renderAdmin();
  renderHome();
}

function setView(view, category = state.category) {
  state.view = view;
  state.category = category;
  if (view === "category") $("#breadcrumb-current").textContent = category;
  renderPage();
  $("#sidebar").classList.remove("is-open");
}

function dialogHeader(title) {
  return `<div class="dialog-header"><h2>${escapeHTML(title)}</h2><button class="icon-button" data-dialog-close aria-label="Close dialog">×</button></div>`;
}

function showBook(bookId) {
  const book = state.books.find((item) => item.id === bookId);
  if (!book) return;
  const dialog = $("#book-dialog");
  const extension = book.extension;
  const canPreview = [".pdf", ".txt", ".md", ".csv", ".jpg", ".jpeg", ".png"].includes(extension);
  const fileUrl = book.fileUrl || `/api/books/${encodeURIComponent(book.id)}/file`;
  let preview = "";
  if (canPreview) {
    if ([".txt", ".md", ".csv"].includes(extension)) {
      preview = `<iframe class="reader-frame" title="Preview ${escapeHTML(book.title)}" src="${fileUrl}"></iframe>`;
    } else if ([".jpg", ".jpeg", ".png"].includes(extension)) {
      preview = `<img class="reader-frame" alt="${escapeHTML(book.title)}" src="${fileUrl}">`;
    } else {
      preview = `<iframe class="reader-frame" title="Preview ${escapeHTML(book.title)}" src="${fileUrl}"></iframe>`;
    }
  } else {
    preview = '<div class="empty-state"><strong>Ready when you are</strong>This file format is available to download and open in your preferred app.</div>';
  }
  dialog.className = "dialog-shell book-dialog";
  dialog.innerHTML = `
    ${dialogHeader("Resource details")}
    <div class="dialog-body">
      <div class="book-cover dialog-book-cover cover-${bookTone(book.category)}"><span class="cover-glyph">${escapeHTML((book.title[0] || "N").toUpperCase())}</span><span class="cover-type">${escapeHTML(extension.slice(1).toUpperCase())}</span></div>
      <div class="dialog-book-copy"><h2>${escapeHTML(book.title)}</h2><p>${escapeHTML(book.author)} · ${escapeHTML(book.category)} · ${formatSize(book.size)}</p>
        ${book.description ? `<p>${escapeHTML(book.description)}</p>` : ""}
      </div>
      <div class="reader-content">${preview}</div>
    </div>
    <div class="dialog-actions">
      <button class="button button-quiet" data-dialog-close>Close</button>
      <a class="button button-primary" href="${fileUrl}?download=1" download>Download resource ↓</a>
    </div>`;
  dialog.showModal();
}

function showUploadDialog(type = "book") {
  const isVideo = type === "video";
  const formId = isVideo ? "video-upload-form" : "upload-form";
  const extensions = isVideo ? ".mp4,.webm,.mov,.m4v" : ".pdf,.doc,.docx,.ppt,.pptx,.pptm,.xls,.xlsx,.txt,.rtf,.csv,.md,.epub,.odt,.ods,.odp,.jpg,.jpeg,.png";
  const dialog = $("#upload-dialog");
  dialog.className = "dialog-shell upload-dialog";
  dialog.innerHTML = `
    ${dialogHeader(isVideo ? "Upload a department video" : "Add a learning resource")}
    <form id="${formId}">
      <div class="dialog-body">
        <label class="upload-drop" id="upload-drop" for="upload-file"><strong>Choose a file or drop it here</strong><span>${isVideo ? "MP4, WebM, MOV, or M4V · Up to 300 MB" : "PDF, Word, PowerPoint, Excel, EPUB, images and more · Up to 50 MB"}</span><input id="upload-file" name="file" type="file" accept="${extensions}" required hidden></label>
        <div class="upload-preview is-hidden" id="upload-preview"><span id="upload-file-name"></span><span id="upload-file-size"></span></div>
        <div class="upload-fields-row">
          <label class="field">${isVideo ? "Video title" : "Resource title"}<input name="title" maxlength="140" placeholder="e.g. Workshop safety essentials"></label>
          ${isVideo ? "" : '<label class="field">Author or publisher<input name="author" maxlength="100" placeholder="Nasawa Technical College"></label>'}
        </div>
        <label class="field upload-category-field">Department<select name="category" required>${DEPARTMENTS.map((department) => `<option>${escapeHTML(department)}</option>`).join("")}<option>General</option></select></label>
        <label class="field upload-description-field">About this resource<textarea name="description" rows="3" maxlength="1200" placeholder="A short description to help students choose this resource."></textarea></label>
        <p class="form-message" id="upload-message" aria-live="polite"></p>
      </div>
      <div class="dialog-actions"><button class="button button-quiet" type="button" data-dialog-close>Cancel</button><button class="button button-primary" type="submit">${isVideo ? "Upload video ↑" : "Upload resource ↑"}</button></div>
    </form>`;
  dialog.showModal();
  const fileInput = $("#upload-file", dialog);
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    $("#upload-preview", dialog).classList.toggle("is-hidden", !file);
    if (file) {
      $("#upload-file-name", dialog).textContent = file.name;
      $("#upload-file-size", dialog).textContent = formatSize(file.size);
    }
  });
  const drop = $("#upload-drop", dialog);
  drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("is-dragging"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-dragging"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-dragging");
    const [file] = event.dataTransfer.files;
    if (file) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event("change"));
    }
  });
}

function showUsersDialog() {
  state.adminTab = "users";
  renderAdmin();
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(authForm);
  const registering = state.authMode === "register";
  const button = $('[type="submit"]', authForm);
  const message = $("#auth-message");
  button.disabled = true;
  $("#auth-submit-label").textContent = registering ? "Creating account…" : "Signing in…";
  message.textContent = "";
  message.classList.remove("is-success");
  try {
    const result = await api(registering ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        name: formData.get("name"), email: formData.get("email"), password: formData.get("password")
      })
    });
    authForm.reset();
    await enterLibrary(result.user);
  } catch (error) {
    if (state.user) showAuth();
    message.textContent = error.message;
  } finally {
    button.disabled = false;
    $("#auth-submit-label").textContent = registering ? "Create account" : "Log in";
  }
});

$$(".auth-tab").forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));

document.addEventListener("click", async (event) => {
  // Event delegation keeps dynamic book cards and admin tables wired after each render.
  const viewButton = event.target.closest("[data-view]");
  const categoryButton = event.target.closest("[data-category]");
  const favoriteButton = event.target.closest("[data-favorite]");
  const card = event.target.closest("[data-open-book]");
  const dialogClose = event.target.closest("[data-dialog-close]");
  const action = event.target.closest("[data-action]");

  if (viewButton) {
    event.preventDefault();
    setView(viewButton.dataset.view === "all-books" ? "all" : viewButton.dataset.view);
  }
  const departmentButton = event.target.closest("[data-department]");
  if (departmentButton) {
    state.category = departmentButton.dataset.department;
    state.selectedLevel = "";
    state.selectedSubject = "";
    setView("department-levels");
  }
  const levelButton = event.target.closest("[data-level]");
  if (levelButton) {
    state.selectedLevel = levelButton.dataset.level;
    setView("department-subjects");
  }
  const subjectButton = event.target.closest("[data-subject]");
  if (subjectButton) {
    state.selectedSubject = subjectButton.dataset.subject;
    setView("subject-books");
  }
  if (event.target.closest("[data-back-to-levels]")) setView("department-levels");
  if (event.target.closest("[data-back-to-subjects]")) setView("department-subjects");
  if (categoryButton) {
    const category = categoryButton.dataset.category;
    state.category = category;
    setView(category === "All departments" ? "home" : "category", category);
  }
  if (favoriteButton) {
    event.stopPropagation();
    try {
      await api(`/api/books/${encodeURIComponent(favoriteButton.dataset.favorite)}/favorite`, { method: "PUT" });
      await loadLibrary();
    } catch (error) {
      notify(error.message, true);
    }
  } else if (card && !event.target.closest("button")) {
    showBook(card.dataset.openBook);
  }
  if (dialogClose) dialogClose.closest("dialog").close();
  if (action?.dataset.action === "upload") showUploadDialog();
  if (action?.dataset.action === "upload-video") showUploadDialog("video");
  if (action?.dataset.action === "manage-users") {
    state.adminTab = "users";
    renderAdmin();
  }
  const adminTab = event.target.closest("[data-admin-tab]");
  if (adminTab) {
    state.adminTab = adminTab.dataset.adminTab;
    renderAdmin();
  }
  const deleteBook = event.target.closest("[data-delete-book]");
  if (deleteBook && window.confirm("Delete this resource? This also removes its uploaded file.")) {
    try {
      await api(`/api/admin/books/${encodeURIComponent(deleteBook.dataset.deleteBook)}`, { method: "DELETE" });
      notify("Resource deleted.");
      await loadLibrary();
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
  }
  const toggleUser = event.target.closest("[data-toggle-user]");
  if (toggleUser) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(toggleUser.dataset.toggleUser)}`, {
        method: "PATCH", body: JSON.stringify({ active: toggleUser.dataset.active !== "true" })
      });
      notify("Account status updated.");
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
  }
  const deleteUser = event.target.closest("[data-delete-user]");
  if (deleteUser && window.confirm("Permanently delete this student account?")) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(deleteUser.dataset.deleteUser)}`, { method: "DELETE" });
      notify("Student account deleted.");
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
  }
  const deleteVideo = event.target.closest("[data-delete-video]");
  if (deleteVideo && window.confirm("Delete this video lesson? This also removes its uploaded file.")) {
    try {
      await api(`/api/admin/videos/${encodeURIComponent(deleteVideo.dataset.deleteVideo)}`, { method: "DELETE" });
      notify("Video deleted.");
      await loadVideos();
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
  }
  const removePhoto = event.target.closest("[data-remove-photo]");
  if (removePhoto && window.confirm("Remove this developer photo?")) {
    try {
      const developerId = removePhoto.dataset.removePhoto;
      const result = await api(`/api/admin/about/photo/${encodeURIComponent(developerId)}`, { method: "DELETE" });
      state.developers = state.developers.map((developer) => developer.id === developerId ? result.developer : developer);
      await renderAdmin();
      notify("Developer photo removed.");
    } catch (error) {
      notify(error.message, true);
    }
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "about-form") {
    event.preventDefault();
    const form = event.target;
    const developers = Array.from(form.querySelectorAll(".developer-editor")).map((fieldSet) => ({
      id: fieldSet.dataset.developerId,
      name: form.elements[`name-${fieldSet.dataset.developerIndex}`].value,
      role: form.elements[`role-${fieldSet.dataset.developerIndex}`].value,
      accent: form.elements[`accent-${fieldSet.dataset.developerIndex}`].value,
      bio: form.elements[`bio-${fieldSet.dataset.developerIndex}`].value
    }));
    try {
      await api("/api/admin/about", { method: "PUT", body: JSON.stringify({ developers }) });
      const result = await api("/api/about");
      state.developers = result.developers;
      notify("Developer profiles updated.");
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (!["upload-form", "video-upload-form"].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target;
  const isVideo = form.id === "video-upload-form";
  const fileInput = $('[name="file"]', form);
  const message = $("#upload-message", form);
  const submit = $('[type="submit"]', form);
  if (!fileInput.files[0]) {
    message.textContent = "Choose a file before uploading.";
    return;
  }
  submit.disabled = true;
  submit.textContent = "Uploading…";
  message.textContent = "";
  try {
    const result = await api(isVideo ? "/api/admin/videos" : "/api/admin/books", { method: "POST", body: new FormData(form) });
    $("#upload-dialog").close();
    notify(`${isVideo ? result.video.title : result.book.title} is now in the library.`);
    if (isVideo) await loadVideos();
    else await loadLibrary();
    await renderAdmin();
  } catch (error) {
    message.textContent = error.message;
    submit.disabled = false;
    submit.textContent = isVideo ? "Upload video ↑" : "Upload resource ↑";
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.matches("[data-developer-photo]")) {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("developerId", input.dataset.developerPhoto);
    formData.append("file", file);
    input.disabled = true;
    try {
      const result = await api("/api/admin/about/photo", { method: "POST", body: formData });
      state.developers = state.developers.map((developer) => developer.id === result.developer.id ? result.developer : developer);
      const fieldSet = input.closest(".developer-editor");
      const preview = $(".member-photo", fieldSet);
      preview.innerHTML = `<img src="/api/about/photos/${encodeURIComponent(result.developer.photo)}" alt="${escapeHTML(result.developer.name)}">`;
      $("[data-remove-photo]", fieldSet).classList.remove("is-hidden");
      notify("Developer photo updated.");
    } catch (error) {
      notify(error.message, true);
    } finally {
      input.disabled = false;
      input.value = "";
    }
  }
  if (event.target.id === "video-department-filter") {
    state.videoCategory = event.target.value;
    renderVideos();
  }
});

$("#search-input").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  if (["activity", "admin", "department-levels", "department-subjects"].includes(state.view)) state.view = "home";
  renderPage();
});

$("#refresh-button").addEventListener("click", async () => {
  try {
    await loadLibrary();
    notify("Library refreshed.");
  } catch (error) {
    notify(error.message, true);
  }
});

$("#logout-button").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    showAuth();
  } catch (error) {
    notify(error.message, true);
  }
});

$("#menu-button").addEventListener("click", () => $("#sidebar").classList.add("is-open"));
$("#sidebar-close").addEventListener("click", () => $("#sidebar").classList.remove("is-open"));
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    $("#search-input").focus();
  }
  if (event.key === "Escape") $("#sidebar").classList.remove("is-open");
  if (event.key === "Enter" && event.target.matches("[data-open-book]")) showBook(event.target.dataset.openBook);
});

async function initialize() {
  try {
    const { user } = await api("/api/me");
    await enterLibrary(user);
  } catch (error) {
    if (error.message !== "Please log in to continue.") notify(error.message, true);
    showAuth();
    if (state.offlineMode) {
      $("#auth-note").textContent = "Offline browser sign-in is stored on this device. Administrator features require a server.";
    }
  }
}

initialize();