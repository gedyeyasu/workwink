(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const els = {
    form: $("#searchForm"),
    query: $("#query"),
    workspace: $("#workspace"),
    stage: $("#cardStage"),
    resultCount: $("#resultCount"),
    activeFilters: $("#activeFilters"),
    degraded: $("#degradedNotice"),
    sourceStatus: $("#sourceStatus"),
    clearFilters: $("#clearFilters"),
    skills: $("#skills"),
    company: $("#company"),
    titleFamily: $("#titleFamily"),
    postedAge: $("#postedAge"),
    salaryMin: $("#salaryMin"),
    salaryOutput: $("#salaryOutput"),
    sort: $("#sort"),
    swipeActions: $("#swipeActions"),
    passJob: $("#passJob"),
    saveJob: $("#saveJob"),
    loadMore: $("#loadMore"),
    template: $("#jobCardTemplate")
    ,resumeForm: $("#resumeForm")
    ,resumeFile: $("#resumeFile")
    ,profileResult: $("#profileResult")
  };

  const state = {
    jobs: [],
    total: 0,
    nextCursor: null,
    controller: null,
    debounceTimer: null,
    requestSerial: 0,
    hasSearched: false,
    loadingMore: false,
    profile: null
  };

  function splitValues(value) {
    return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 30);
  }

  function selectedChips(group) {
    return $$(`[data-filter-group="${group}"] .filter-chip.active`).map((chip) => chip.dataset.value);
  }

  function getRequest(cursor = null) {
    const minimumSalary = Number(els.salaryMin.value) || null;
    const postedWithinDays = Number(els.postedAge.value) || null;
    return {
      query: els.query.value.trim(),
      filters: {
        workModes: selectedChips("workMode"),
        seniority: selectedChips("seniority"),
        titleFamilies: els.titleFamily.value ? [els.titleFamily.value] : [],
        skills: splitValues(els.skills.value),
        companies: splitValues(els.company.value),
        employmentTypes: [],
        industries: [],
        minimumSalary,
        includeUnknownSalary: minimumSalary === null,
        postedWithinDays
      },
      sort: els.sort.value,
      pageSize: 20,
      cursor
    };
  }

  function syncUrl() {
    const request = getRequest();
    const params = new URLSearchParams();
    if (request.query) params.set("q", request.query);
    const mappings = [
      ["mode", request.filters.workModes],
      ["level", request.filters.seniority],
      ["family", request.filters.titleFamilies],
      ["skills", request.filters.skills],
      ["company", request.filters.companies]
    ];
    mappings.forEach(([key, values]) => values.length && params.set(key, values.join(",")));
    if (request.filters.postedWithinDays) params.set("age", String(request.filters.postedWithinDays));
    if (request.filters.minimumSalary) params.set("salary", String(request.filters.minimumSalary));
    if (request.sort !== "relevance") params.set("sort", request.sort);
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
  }

  function restoreUrlState() {
    const params = new URLSearchParams(location.search);
    els.query.value = params.get("q") ?? "";
    const activate = (group, values) => {
      const selected = new Set((values ?? "").split(",").filter(Boolean));
      $$(`[data-filter-group="${group}"] .filter-chip`).forEach((chip) => chip.classList.toggle("active", selected.has(chip.dataset.value)));
    };
    activate("workMode", params.get("mode"));
    activate("seniority", params.get("level"));
    els.titleFamily.value = (params.get("family") ?? "").split(",")[0] ?? "";
    els.skills.value = params.get("skills") ?? "";
    els.company.value = params.get("company") ?? "";
    els.postedAge.value = params.get("age") ?? "30";
    els.salaryMin.value = params.get("salary") ?? "0";
    els.sort.value = params.get("sort") ?? "relevance";
    updateSalaryLabel();
  }

  function updateSalaryLabel() {
    const amount = Number(els.salaryMin.value);
    els.salaryOutput.value = amount ? `$${Math.round(amount / 1000)}k+` : "Any";
  }

  function activeFilterEntries() {
    const request = getRequest();
    return [
      ...request.filters.workModes.map((value) => ({ group: "workMode", value, label: value })),
      ...request.filters.seniority.map((value) => ({ group: "seniority", value, label: value })),
      ...request.filters.titleFamilies.map((value) => ({ group: "titleFamily", value, label: value })),
      ...request.filters.skills.map((value) => ({ group: "skills", value, label: value })),
      ...request.filters.companies.map((value) => ({ group: "company", value, label: value })),
      ...(request.filters.postedWithinDays ? [{ group: "age", value: String(request.filters.postedWithinDays), label: `${request.filters.postedWithinDays}d` }] : []),
      ...(request.filters.minimumSalary ? [{ group: "salary", value: String(request.filters.minimumSalary), label: `$${Math.round(request.filters.minimumSalary / 1000)}k+` }] : [])
    ];
  }

  function renderActiveFilters() {
    els.activeFilters.replaceChildren(...activeFilterEntries().map((entry) => {
      const chip = document.createElement("span");
      chip.className = "active-filter";
      chip.append(document.createTextNode(entry.label));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${entry.label} filter`);
      remove.textContent = "×";
      remove.addEventListener("click", () => removeFilter(entry));
      chip.append(remove);
      return chip;
    }));
  }

  function removeFilter(entry) {
    if (entry.group === "workMode" || entry.group === "seniority") {
      const chip = $(`[data-filter-group="${entry.group}"] [data-value="${CSS.escape(entry.value)}"]`);
      chip?.classList.remove("active");
    } else if (entry.group === "titleFamily") els.titleFamily.value = "";
    else if (entry.group === "skills") els.skills.value = splitValues(els.skills.value).filter((value) => value !== entry.value).join(", ");
    else if (entry.group === "company") els.company.value = splitValues(els.company.value).filter((value) => value !== entry.value).join(", ");
    else if (entry.group === "age") els.postedAge.value = "";
    else if (entry.group === "salary") { els.salaryMin.value = "0"; updateSalaryLabel(); }
    scheduleSearch();
  }

  function showLoading(loadMore) {
    if (loadMore) {
      els.loadMore.disabled = true;
      els.loadMore.textContent = "Loading…";
      return;
    }
    els.swipeActions.classList.add("hidden");
    els.loadMore.classList.add("hidden");
    els.stage.innerHTML = `<div class="state-panel"><span class="loader" aria-hidden="true"></span><h3>Reading the live index</h3><p>Ranking fresh roles against your search and filters…</p></div>`;
  }

  function showError(error) {
    const message = error?.message || "Live search could not be reached.";
    els.stage.innerHTML = "";
    const panel = document.createElement("div");
    panel.className = "state-panel error";
    const title = document.createElement("h3");
    title.textContent = "The signal dropped";
    const detail = document.createElement("p");
    detail.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", () => performSearch());
    panel.append(title, detail, retry);
    els.stage.append(panel);
    els.resultCount.textContent = "Unavailable";
    els.swipeActions.classList.add("hidden");
    els.loadMore.classList.add("hidden");
  }

  function showEmpty() {
    els.stage.innerHTML = `<div class="state-panel"><span class="welcome-orbit" aria-hidden="true"><i></i></span><h3>No live matches yet</h3><p>Try a broader title, remove a filter, or expand the posted date. Nothing synthetic has been added.</p></div>`;
    els.swipeActions.classList.add("hidden");
    els.loadMore.classList.add("hidden");
  }

  function formatRelativeDate(value) {
    if (!value) return "Freshness unknown";
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return "Recently indexed";
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
    if (minutes < 2) return "Just indexed";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function formatSalary(salary) {
    if (!salary) return "Salary not listed";
    if (salary.sourceText) return salary.sourceText;
    const min = salary.annualMin ?? salary.min;
    const max = salary.annualMax ?? salary.max;
    const currency = salary.currency === "USD" ? "$" : salary.currency ? `${salary.currency} ` : "";
    const compact = (value) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
    if (min != null && max != null) return `${currency}${compact(min)}–${compact(max)}`;
    if (min != null) return `${currency}${compact(min)}+`;
    if (max != null) return `Up to ${currency}${compact(max)}`;
    return "Salary not listed";
  }

  function hostname(value, fallback) {
    try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return fallback; }
  }

  function createCard(job) {
    const card = els.template.content.firstElementChild.cloneNode(true);
    const set = (field, value) => { $(`[data-field="${field}"]`, card).textContent = value; };
    const company = job.companyName || "Company undisclosed";
    set("company", company);
    set("title", job.title || "Untitled role");
    set("location", [job.location, job.workMode && job.workMode !== "unknown" ? job.workMode : ""].filter(Boolean).join(" · ") || "Location not listed");
    set("salary", formatSalary(job.salary));
    set("description", job.description || job.requirements || "Open the source listing for full role details.");
    const freshnessDate = job.postedAt || job.collectedAt || job.verifiedAt;
    set("freshness", formatRelativeDate(freshnessDate));
    set("indexed", job.collectedAt ? `Collected ${new Date(job.collectedAt).toLocaleString()}` : "Collection time unavailable");
    const sourceLink = $("[data-field=source]", card);
    sourceLink.href = job.sourceUrl;
    sourceLink.textContent = job.source || hostname(job.sourceUrl, "source");
    const applyLink = $("[data-field=apply]", card);
    applyLink.href = job.applyUrl || job.sourceUrl;
    const logo = $(".company-logo", card);
    logo.textContent = company.slice(0, 1).toUpperCase();
    const palette = ["#d9ff43", "#9e83ff", "#ff8d78", "#6ee7ce", "#f0c66b"];
    logo.style.background = palette[Math.abs([...company].reduce((sum, char) => sum + char.charCodeAt(0), 0)) % palette.length];
    const skillList = $("[data-field=skills]", card);
    (job.skills || []).slice(0, 7).forEach((skill) => {
      const badge = document.createElement("span");
      badge.textContent = skill;
      skillList.append(badge);
    });
    card.dataset.applyUrl = applyLink.href;
    card.dataset.jobId = job.jobId;
    const match = matchJob(job);
    if (match) {
      const badge = $("[data-field=match]", card);
      badge.textContent = `${match.score}% match`;
      badge.title = match.reasons.join(" · ");
      badge.classList.remove("hidden");
    }
    attachSwipe(card);
    return card;
  }

  function matchJob(job) {
    if (!state.profile) return null;
    const candidateSkills = new Set(state.profile.skills.map((item) => item.name.toLowerCase()));
    const jobSkills = (job.skills || []).map((item) => item.toLowerCase());
    const matchedSkills = jobSkills.filter((item) => candidateSkills.has(item));
    const roleMatch = state.profile.targetRoles.values.some((role) => {
      const words = role.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
      return words.some((word) => (job.title || "").toLowerCase().includes(word));
    });
    const workModeMatch = state.profile.preferences.workModes.values.includes(job.workMode);
    const skillScore = Math.min(60, matchedSkills.length * 12);
    const score = Math.min(99, 20 + skillScore + (roleMatch ? 15 : 0) + (workModeMatch ? 5 : 0));
    const reasons = [
      ...matchedSkills.slice(0, 4).map((skill) => `Resume evidence: ${skill}`),
      ...(roleMatch ? ["Target-role alignment"] : []),
      ...(workModeMatch ? [`${job.workMode} preference`] : [])
    ];
    return { score, reasons };
  }

  async function enrichTopCard() {
    const card = $(".job-card:last-child", els.stage);
    if (!card?.dataset.jobId || card.dataset.aiLoaded) return;
    card.dataset.aiLoaded = "loading";
    try {
      const response = await fetch(`/api/ai/jobs/${encodeURIComponent(card.dataset.jobId)}/profile`, { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const body = await response.json();
      const profile = body.profile;
      if (!profile) return;
      $("[data-field=ai-one-liner]", card).textContent = profile.oneLiner;
      $("[data-field=ai-mission]", card).textContent = profile.mission;
      $("[data-field=ai-profile]", card).classList.remove("hidden");
      card.dataset.aiLoaded = "true";
    } catch {
      card.dataset.aiLoaded = "failed";
    }
  }

  function renderDeck() {
    els.stage.innerHTML = "";
    if (!state.jobs.length) {
      showEmpty();
      return;
    }
    state.jobs.slice(0, 3).reverse().forEach((job) => els.stage.append(createCard(job)));
    els.swipeActions.classList.remove("hidden");
    els.loadMore.classList.toggle("hidden", !state.nextCursor || state.jobs.length > 5);
    els.loadMore.disabled = false;
    els.loadMore.textContent = "Load more matches";
    void enrichTopCard();
  }

  function renderResponse(response, append) {
    state.jobs = append ? [...state.jobs, ...(response.items || [])] : (response.items || []);
    state.total = Number(response.total) || state.jobs.length;
    state.nextCursor = response.nextCursor || null;
    els.resultCount.textContent = `${state.total.toLocaleString()} ${state.total === 1 ? "role" : "roles"}`;
    els.degraded.classList.toggle("hidden", !response.degraded);
    els.degraded.textContent = response.degraded
      ? `Hybrid ranking is degraded; showing live ${response.mode || "lexical"} results. (${response.tookMs ?? "—"} ms)`
      : "";
    if (response.dataFreshness) {
      els.sourceStatus.className = "source-status ready";
      els.sourceStatus.lastElementChild.textContent = `Live index · ${formatRelativeDate(response.dataFreshness)}`;
    }
    applyFacetCounts(response.facets || {});
    renderDeck();
  }

  function applyFacetCounts(facets) {
    const groups = { workMode: facets.workModes, seniority: facets.seniority };
    Object.entries(groups).forEach(([group, buckets]) => {
      const counts = new Map((buckets || []).map((bucket) => [bucket.value, bucket.count]));
      $$(`[data-filter-group="${group}"] .filter-chip`).forEach((chip) => {
        if (!chip.dataset.label) chip.dataset.label = chip.textContent;
        const count = counts.get(chip.dataset.value);
        chip.textContent = `${chip.dataset.label}${Number.isFinite(count) ? ` ${count}` : ""}`;
      });
    });
  }

  async function performSearch({ append = false } = {}) {
    const cursor = append ? state.nextCursor : null;
    if (append && !cursor) return;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const serial = ++state.requestSerial;
    state.hasSearched = true;
    state.loadingMore = append;
    syncUrl();
    renderActiveFilters();
    showLoading(append);
    try {
      const response = await fetch("/api/search/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(getRequest(cursor)),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || `Search failed (${response.status})`);
      if (serial !== state.requestSerial) return;
      renderResponse(payload, append);
    } catch (error) {
      if (error.name === "AbortError" || serial !== state.requestSerial) return;
      showError(error);
    } finally {
      if (serial === state.requestSerial) state.loadingMore = false;
    }
  }

  function scheduleSearch() {
    clearTimeout(state.debounceTimer);
    updateSalaryLabel();
    renderActiveFilters();
    state.debounceTimer = setTimeout(() => performSearch(), 150);
  }

  function dismiss(direction, openRole = false) {
    const topCard = $(".job-card:last-child", els.stage);
    if (!topCard || !state.jobs.length) return;
    if (openRole) window.open(topCard.dataset.applyUrl, "_blank", "noopener,noreferrer");
    topCard.classList.add(direction === "right" ? "exit-right" : "exit-left");
    setTimeout(() => {
      state.jobs.shift();
      if (state.jobs.length < 4 && state.nextCursor && !state.loadingMore) void performSearch({ append: true });
      else renderDeck();
    }, 260);
  }

  function attachSwipe(card) {
    let startX = 0;
    let currentX = 0;
    let dragging = false;
    card.addEventListener("pointerdown", (event) => {
      if (event.target.closest("a")) return;
      startX = event.clientX;
      currentX = 0;
      dragging = true;
      card.classList.add("dragging");
      card.setPointerCapture(event.pointerId);
    });
    card.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      currentX = event.clientX - startX;
      card.style.transform = `translateX(${currentX}px) rotate(${currentX / 30}deg)`;
      $(".stamp-save", card).style.opacity = String(Math.max(0, Math.min(1, currentX / 100)));
      $(".stamp-pass", card).style.opacity = String(Math.max(0, Math.min(1, -currentX / 100)));
    });
    const release = () => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove("dragging");
      if (Math.abs(currentX) > 100) dismiss(currentX > 0 ? "right" : "left");
      else {
        card.style.transform = "";
        $(".stamp-save", card).style.opacity = "";
        $(".stamp-pass", card).style.opacity = "";
      }
    };
    card.addEventListener("pointerup", release);
    card.addEventListener("pointercancel", release);
  }

  async function checkHealth() {
    try {
      const response = await fetch("/api/health", { headers: { accept: "application/json" } });
      const body = await response.json();
      const ready = body?.dependencies?.search === "ready";
      els.sourceStatus.className = `source-status ${ready ? "ready" : "failed"}`;
      els.sourceStatus.lastElementChild.textContent = ready ? "Live search connected" : "Live search degraded";
    } catch {
      els.sourceStatus.className = "source-status failed";
      els.sourceStatus.lastElementChild.textContent = "API unreachable";
    }
  }

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    clearTimeout(state.debounceTimer);
    void performSearch();
    els.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $$("[data-query]").forEach((button) => button.addEventListener("click", () => {
    els.query.value = button.dataset.query;
    void performSearch();
    els.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $$(".filter-chip").forEach((button) => button.addEventListener("click", () => {
    button.classList.toggle("active");
    scheduleSearch();
  }));
  [els.titleFamily, els.postedAge, els.sort].forEach((element) => element.addEventListener("change", scheduleSearch));
  [els.skills, els.company].forEach((element) => element.addEventListener("input", scheduleSearch));
  els.salaryMin.addEventListener("input", scheduleSearch);
  els.clearFilters.addEventListener("click", () => {
    $$(".filter-chip.active").forEach((chip) => chip.classList.remove("active"));
    els.titleFamily.value = "";
    els.skills.value = "";
    els.company.value = "";
    els.postedAge.value = "";
    els.salaryMin.value = "0";
    els.sort.value = "relevance";
    scheduleSearch();
  });
  els.passJob.addEventListener("click", () => dismiss("left"));
  els.saveJob.addEventListener("click", () => dismiss("right", true));
  els.loadMore.addEventListener("click", () => void performSearch({ append: true }));
  els.resumeFile.addEventListener("change", () => {
    const file = els.resumeFile.files?.[0];
    if (file) $(".resume-picker").textContent = file.name;
  });
  els.resumeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = els.resumeFile.files?.[0];
    if (!file) return;
    const submit = $("button[type=submit]", els.resumeForm);
    submit.disabled = true;
    submit.textContent = "Reading résumé…";
    els.profileResult.classList.remove("hidden");
    els.profileResult.textContent = "Extracting evidence from your PDF…";
    try {
      const form = new FormData();
      form.append("resume", file);
      form.append("preferences", JSON.stringify({
        location: { city: "Austin", region: "Texas", radiusMiles: 50 },
        workModes: ["remote", "hybrid"]
      }));
      const response = await fetch("/api/profile/resume", { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message || "Resume parsing failed.");
      state.profile = body.profile;
      const skills = state.profile.skills.map((item) => item.name);
      els.query.value = state.profile.targetRoles.values[0] || "software engineer";
      els.skills.value = skills.slice(0, 8).join(", ");
      $$("[data-filter-group=workMode] .filter-chip").forEach((chip) => chip.classList.toggle("active", state.profile.preferences.workModes.values.includes(chip.dataset.value)));
      els.profileResult.innerHTML = `<strong>Profile ready</strong><span>${state.profile.targetRoles.values.join(" · ")}</span><span>${skills.length} evidenced skills · Austin, Texas · remote/hybrid</span><small>${state.profile.extraction.pageCount} pages parsed; raw résumé stored: no</small>`;
      await performSearch();
      els.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      els.profileResult.textContent = error.message || "Resume parsing failed.";
    } finally {
      submit.disabled = false;
      submit.textContent = "Build my profile";
    }
  });

  restoreUrlState();
  renderActiveFilters();
  void checkHealth();
  void performSearch();
})();
