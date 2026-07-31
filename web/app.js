const state = { jobs: [], index: 0, swipes: [], filters: { workStyle: "Any", minCompensation: "140000" } };
const deck = document.querySelector("#deck");
const toast = document.querySelector("#toast");
const modal = document.querySelector("#modal");

await loadJobs();
document.addEventListener("click", handleClick);
document.addEventListener("keydown", (event) => { if (event.key === "ArrowLeft") swipe("left"); if (event.key === "ArrowRight") swipe("right"); if (event.key === "ArrowUp") showDetails(currentJob()); if (event.key === "Escape") closeModal(); });

async function loadJobs() {
  const params = new URLSearchParams(state.filters);
  const response = await fetch(`/api/jobs?${params}`); const data = await response.json();
  state.jobs = data.jobs; state.swipes = data.swipes; state.index = 0; render();
}
function render() {
  const remaining = state.jobs.slice(state.index);
  document.querySelector("#result-count").textContent = remaining.length;
  document.querySelector("#match-count").textContent = state.swipes.filter((swipe) => swipe.direction === "right").length;
  document.querySelector("#swipe-copy").textContent = `${state.swipes.length} swipe${state.swipes.length === 1 ? "" : "s"}`;
  deck.innerHTML = remaining.slice(0, 2).map((job, position) => cardMarkup(job, position)).join(""); renderSaved();
}
function cardMarkup(job, position) {
  return `<article class="job-card ${position ? "is-behind" : ""}" data-job-id="${job.id}"><div class="job-top"><div class="company-logo">${job.logo}</div><div class="job-meta"><h2>${job.title}</h2><p>${job.company} · ${job.location}</p></div><div class="match-badge"><strong>${job.match.score}</strong><span>MATCH</span></div></div><div class="job-facts"><span class="fact">${job.workStyle}</span><span class="fact">${job.compensation}</span><span class="fact">Posted ${job.posted}</span></div><p class="job-description">${job.description}</p><div class="job-tags">${job.tags.map((tag) => `<span class="job-tag">${tag}</span>`).join("")}</div><div class="job-footer"><span class="source"><i>●</i> ${job.source} · collected ${job.collectedAt}</span><button class="why-button" data-action="details" data-job-id="${job.id}">Why this match <span>↗</span></button></div></article>`;
}
async function handleClick(event) {
  const target = event.target.closest("[data-action], [data-filter]"); if (!target) return;
  const action = target.dataset.action;
  if (target.dataset.filter) return applyFilter(target.dataset.filter, target);
  if (action === "pass") return swipe("left"); if (action === "like" || action === "save") return swipe("right"); if (action === "undo") return undo(); if (action === "refresh") return loadJobs();
  if (action === "details") return showDetails(findJob(target.dataset.jobId) ?? currentJob()); if (action === "edit-profile") return showProfile(); if (action === "close-modal") return closeModal(); if (action === "show-matches") return showSavedMessage(); if (action === "apply-draft") return createDraft(target.dataset.jobId); if (action === "save-profile") return saveProfile();
}
async function swipe(direction) {
  const job = currentJob(); if (!job) return showToast("You’re all caught up. Refresh for more roles.");
  const card = deck.querySelector(".job-card:not(.is-behind)"); card?.classList.add(direction === "right" ? "swiped-right" : "swiped-left"); state.swipes.push({ jobId: job.id, direction }); state.index += 1;
  await fetch("/api/swipes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.id, direction }) }); setTimeout(() => render(), 200); showToast(direction === "right" ? `${job.company} saved to your matches ♥` : "Passed — your feed is learning.");
}
function undo() { if (!state.index || !state.swipes.length) return showToast("Nothing to undo yet."); state.index -= 1; state.swipes.pop(); render(); showToast("Last swipe undone"); }
function applyFilter(type, chip) { if (type === "workStyle") state.filters.workStyle = state.filters.workStyle === "Remote" ? "Any" : "Remote"; if (type === "compensation") state.filters.minCompensation = state.filters.minCompensation === "140000" ? "0" : "140000"; document.querySelectorAll(".filter-chip").forEach((item) => item.classList.remove("selected")); chip.classList.add("selected"); loadJobs(); }
function showDetails(job) {
  if (!job) return;
  modal.querySelector("#modal-content").innerHTML = `<p class="eyebrow">MATCH EXPLAINED · ${job.company.toUpperCase()}</p><h2>${job.match.score}% <em>match</em></h2><p>Career Crush combines semantic skill fit, your hard constraints, learned preferences, listing freshness, and growth potential.</p><div class="evidence-list">${job.match.reasons.map((reason) => `<div class="evidence">${reason}</div>`).join("")}${job.match.risks.map((risk) => `<div class="risk">${risk}</div>`).join("")}</div><button class="modal-cta" data-action="apply-draft" data-job-id="${job.id}">Prepare my application →</button>`; openModal();
}
function showProfile() { modal.querySelector("#modal-content").innerHTML = `<p class="eyebrow">YOUR PROFILE</p><h2>Make your next yes <em>count.</em></h2><p>Career Crush uses this to personalize your feed. Your profile stays private until you approve an application.</p><div class="form-grid"><label>RESUME<input class="resume-drop" type="file" accept=".pdf,.doc,.docx" /></label><label>TARGET ROLE<input value="Staff Platform Engineer" /></label><label>HOME BASE<input value="Austin, TX" /></label><label>MINIMUM COMPENSATION<input value="$140,000" /></label><label>WORK STYLE<select><option>Remote</option><option>Hybrid</option><option>On-site</option></select></label><button class="modal-cta" data-action="save-profile">Save profile →</button></div>`; openModal(); }
async function createDraft(jobId) { const job = findJob(jobId); if (!job) return; const button = modal.querySelector("[data-action=apply-draft]"); if (button) { button.textContent = "Drafting your application…"; button.disabled = true; } const response = await fetch("/api/application-draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, company: job.company, title: job.title }) }); const draft = await response.json(); modal.querySelector("#modal-content").innerHTML = `<p class="eyebrow">APPLICATION COCKPIT · READY FOR REVIEW</p><h2>Make it <em>personal.</em></h2><p>Here’s a first draft built from your profile and the evidence in this role. Nothing is submitted automatically.</p><strong>Tailored resume bullets</strong><div class="draft-block">• ${draft.resumeBullets.join("\n• ")}</div><strong>Cover letter</strong><div class="draft-block">${draft.coverLetter}</div><button class="modal-cta" data-action="close-modal">Save draft for later →</button>`; }
function saveProfile() { closeModal(); showToast("Profile updated — your feed will keep learning."); }
function showSavedMessage() { showToast("Your matches will appear here as you swipe right."); }
function findJob(jobId) { return state.jobs.find((job) => job.id === jobId); } function currentJob() { return state.jobs[state.index]; }
function openModal() { modal.classList.add("open"); modal.setAttribute("aria-hidden", "false"); } function closeModal() { modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); }
function showToast(message) { toast.textContent = message; toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2300); }
function renderSaved() { const saved = state.swipes.filter((swipe) => swipe.direction === "right").map((swipe) => findJob(swipe.jobId)).filter(Boolean); const empty = document.querySelector("#saved-empty"); const list = document.querySelector("#saved-list"); empty.style.display = saved.length ? "none" : "flex"; list.innerHTML = saved.map((job) => `<div class="saved-job"><div class="saved-logo">${job.logo}</div><div><b>${job.title}</b><span>${job.company} · ${job.match.score}% match</span></div></div>`).join(""); }
