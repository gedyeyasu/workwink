import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { demoJobs, demoProfile } from "./demo-data.js";
import { matchJob } from "./matching.js";

const root = join(fileURLToPath(new URL("..", import.meta.url)), "web");
const swipes = [];

const server = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") return send(response, 204, "");
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/health") return sendJson(response, 200, { ok: true, mode: "demo" });
    if (url.pathname === "/api/profile" && request.method === "GET") return sendJson(response, 200, demoProfile);
    if (url.pathname === "/api/jobs" && request.method === "GET") {
      const filters = Object.fromEntries(url.searchParams.entries());
      const jobs = demoJobs.filter((job) => !filters.workStyle || filters.workStyle === "Any" || job.workStyle === filters.workStyle)
        .filter((job) => !filters.minCompensation || job.compensation_max >= Number(filters.minCompensation))
        .map((job) => ({ ...job, match: matchJob(job, demoProfile, { preferenceLift: swipes.filter((swipe) => swipe.direction === "right").length * 0.01 }) }));
      return sendJson(response, 200, { jobs, swipes });
    }
    if (url.pathname === "/api/swipes" && request.method === "POST") {
      const body = await readJson(request); swipes.push({ ...body, createdAt: new Date().toISOString() });
      return sendJson(response, 201, { ok: true, swipe: swipes.at(-1) });
    }
    if (url.pathname === "/api/application-draft" && request.method === "POST") {
      const body = await readJson(request);
      return sendJson(response, 200, { jobId: body.jobId, status: "ready_for_review", resumeBullets: ["Led platform reliability improvements across distributed services.", "Built developer tooling that reduced deployment feedback loops."], coverLetter: `Hi ${body.company} team,\n\nI’m excited about the ${body.title} role because it sits at the intersection of platform reliability and a thoughtful developer experience. My background in Go, Kubernetes, AWS, and observability maps directly to the problems described in this role.\n\nBest,\nAlex Morgan` });
    }
    return serveStatic(url.pathname, response);
  } catch (error) { console.error(error); sendJson(response, 500, { error: "Something went wrong." }); }
});

server.listen(process.env.PORT || 4173, () => console.log(`Career Crush is running at http://localhost:${process.env.PORT || 4173}`));

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = normalize(join(root, requested));
  if (!filePath.startsWith(root)) return send(response, 403, "Forbidden");
  try { const data = await readFile(filePath); const type = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" }[extname(filePath)] ?? "application/octet-stream"; response.setHeader("Content-Type", `${type}; charset=utf-8`); send(response, 200, data); }
  catch { send(response, 404, "Not found"); }
}
function readJson(request) { return new Promise((resolve, reject) => { let body = ""; request.on("data", (chunk) => body += chunk); request.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch (error) { reject(error); } }); }); }
function sendJson(response, status, data) { response.setHeader("Content-Type", "application/json; charset=utf-8"); send(response, status, JSON.stringify(data)); }
function send(response, status, body) { response.writeHead(status); response.end(body); }
