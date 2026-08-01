import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomInt } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT_TEMPLATE } from "./prompt.js";

const PORT = Number(process.env.PORT ?? 3111);
const MODEL = "claude-sonnet-4-6";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.warn(
    "[pinechar] ANTHROPIC_API_KEY is not set — /negotiate will fail closed on every request.",
  );
}

// Reads ANTHROPIC_API_KEY from the environment itself; null when unset so the
// route can fall back rather than throw at boot.
const anthropic = ANTHROPIC_API_KEY ? new Anthropic() : null;

// The extension calls in as chrome-extension://<id>. Unpacked extension IDs are
// derived from the install path, so yours is stable but unguessable from here:
// copy it off chrome://extensions into EXTENSION_ID to pin this down.
const EXTENSION_ID = process.env.EXTENSION_ID;
const allowedOrigin = EXTENSION_ID ? `chrome-extension://${EXTENSION_ID}` : null;

if (!allowedOrigin) {
  console.warn(
    "[pinechar] EXTENSION_ID not set — allowing any chrome-extension:// origin (dev only).",
  );
}

// ---------------------------------------------------------------------------
// Score → minutes
// ---------------------------------------------------------------------------

// Indexed by score - 1. Score 6 is the anchor row: 30 / 20 / 10.
// 1-3 is denial territory per the prompt's score bands, so it pays out nothing.
const MINUTES_BY_SCORE = {
  lenient: [0, 0, 0, 10, 15, 30, 40, 50, 60, 60],
  moderate: [0, 0, 0, 5, 10, 20, 25, 35, 45, 60],
  strict: [0, 0, 0, 3, 5, 10, 15, 20, 30, 40],
};

const MIN_MINUTES = 1;
const MAX_MINUTES = 60;

function normalizeStrictness(value) {
  return Object.hasOwn(MINUTES_BY_SCORE, value) ? value : "moderate";
}

function minutesFor(score, strictness) {
  // Normalizes internally: this runs outside the route's try/catch, so an
  // unknown strictness must not turn into a 500 instead of a denial.
  const raw = MINUTES_BY_SCORE[normalizeStrictness(strictness)][score - 1] ?? 0;

  // The 1-60 clamp applies to grants only. Clamping a denial up to 1 would hand
  // out a minute of access on every refusal, which is the one outcome a blocker
  // must never produce.
  if (raw <= 0) return 0;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, raw));
}

// ---------------------------------------------------------------------------
// Unlock code
// ---------------------------------------------------------------------------

// No I/O/0/1 — the user types this back by hand, so ambiguous glyphs are out.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode() {
  const block = () =>
    Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `${block()}-${block()}`;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const MAX_PERSONA_CHARS = 300;
const DEFAULT_PERSONA = "A fair, plain-spoken gatekeeper.";

// The persona lands inside a quoted slot in the template, so an unescaped quote
// would let it break out of the voice layer and write free-form system text.
// Rule 7 makes judgment immune to what it *says*; this keeps it inside the slot.
function sanitizePersona(raw) {
  if (typeof raw !== "string") return DEFAULT_PERSONA;
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ") // control chars, incl. newlines
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PERSONA_CHARS);
  return cleaned || DEFAULT_PERSONA;
}

// Rule 12 lets the judge ask before scoring, which means a negotiation can now
// fail to terminate. One question is the budget; past that the answer is as
// good as it will get.
const MAX_QUESTIONS = 1;

function questionsAsked(body) {
  const n = Number(body?.questionsAsked);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function asJson(value, fallback) {
  return value === undefined || value === null
    ? fallback
    : JSON.stringify(value, null, 2);
}

function buildContextBlock(body) {
  const { goalsText, ledger, today, todayEvents, settings, site } = body;
  const goals =
    typeof goalsText === "string" && goalsText.trim() ? goalsText : "(none set)";

  const asked = questionsAsked(body);

  return [
    "=== REQUEST CONTEXT ===",
    "",
    "SITE:",
    typeof site === "string" && site ? site : "unknown",
    "",
    "GOALS (verbatim, as the user wrote them):",
    goals,
    "",
    "LEDGER (this week's events):",
    asJson(ledger, "[]"),
    "",
    "TODAY (requests, grants, time used, flags):",
    asJson(today, "{}"),
    "",
    "TODAY'S CALENDAR EVENTS:",
    asJson(todayEvents, "[]"),
    "",
    "SETTINGS:",
    asJson(settings, "{}"),
    "",
    // Counted by the client, which is the only party that knows how this
    // negotiation has gone — the server sees each turn cold.
    `CLARIFYING QUESTIONS ALREADY ASKED: ${asked}${
      asked >= MAX_QUESTIONS ? " — limit reached; judge now, do not ask another." : ""
    }`,
  ].join("\n");
}

function buildSystemPrompt(body) {
  const persona = sanitizePersona(body?.settings?.persona);
  // Replacer function, not a string: a persona containing $& or $1 would
  // otherwise be interpreted as a replacement pattern and corrupt the prompt.
  const withPersona = SYSTEM_PROMPT_TEMPLATE.replace("{{PERSONA}}", () => persona);
  return `${withPersona}\n\n${buildContextBlock(body)}`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function extractJson(text) {
  // The prompt says no fences, but models emit them anyway often enough that
  // stripping is cheaper than a retry.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced ? fenced[1] : text).trim();

  // Outermost braces, in case the object arrives wrapped in a sentence.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function validateDecision(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  // A question is the one shape that carries no score: rule 12 has the judge
  // still gathering facts, so there is nothing to pay out or log yet.
  if (parsed.decision === "question") {
    const message = typeof parsed.message === "string" ? parsed.message : "";
    return message.trim() ? { kind: "question", message } : null;
  }

  // No `decision` at all still validates as a judgment — the score is what
  // makes it one, and a missing field shouldn't fail an otherwise good answer.
  const score = Number(parsed.score);
  if (!Number.isInteger(score) || score < 1 || score > 10) return null;

  return {
    kind: "judgment",
    score,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    claims: Array.isArray(parsed.claims)
      ? parsed.claims.filter((c) => typeof c === "string")
      : [],
    message: typeof parsed.message === "string" ? parsed.message : "",
  };
}

// Every failure path lands here, and it is always a denial — a gate that opens
// when the judge is unreachable is worse than no gate.
function fallbackDecision(reason) {
  console.error("[pinechar] falling back to denial:", reason);
  return {
    decision: "denied",
    score: 1,
    minutes: 0,
    code: null,
    claims: [],
    reasoning: `Fallback denial: ${reason}`,
    message:
      "I couldn't reach a decision just now, so the gate stays shut. Try again in a moment.",
  };
}

function describeError(err) {
  if (err instanceof Anthropic.RateLimitError) return "rate limited";
  if (err instanceof Anthropic.AuthenticationError) return "authentication failed";
  if (err instanceof Anthropic.APIConnectionError) return "could not reach the API";
  if (err instanceof Anthropic.APIError) return `API error ${err.status}`;
  return "unexpected error";
}

function normalizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const messages = raw
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }))
    .filter((m) => m.content.trim());

  if (!messages.length || messages[0].role !== "user") return null;
  return messages;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const corsOptions = {
  origin(origin, callback) {
    // No Origin header at all: curl, health checks, server-to-server. Not a
    // browser request, so CORS isn't what's protecting it anyway.
    if (!origin) return callback(null, true);

    if (allowedOrigin) return callback(null, origin === allowedOrigin);

    // Dev fallback: any extension, but still nothing from an ordinary web page.
    return callback(null, origin.startsWith("chrome-extension://"));
  },
  methods: ["POST"],
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

app.post("/negotiate", async (req, res) => {
  const body = req.body ?? {};
  const messages = normalizeMessages(body.messages);

  // Log shapes rather than contents — goals and calendar entries are personal.
  console.log("[pinechar] POST /negotiate", {
    messages: messages?.length ?? 0,
    goalsChars: body.goalsText?.length ?? 0,
    todayEvents: Array.isArray(body.todayEvents) ? body.todayEvents.length : 0,
    site: body.site ?? null,
  });

  if (!messages) {
    return res.status(400).json({
      error: "messages must be a non-empty array whose first entry is a user turn",
    });
  }

  if (!anthropic) return res.json(fallbackDecision("ANTHROPIC_API_KEY not configured"));

  const strictness = normalizeStrictness(body.settings?.strictness);
  let decision;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: buildSystemPrompt(body),
      messages,
    });

    // content is a union — thinking blocks ride alongside the text on 4.6.
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    decision = validateDecision(extractJson(text));

    if (!decision) {
      console.error("[pinechar] unparseable model output:", text.slice(0, 500));
      return res.json(fallbackDecision("model returned malformed JSON"));
    }
  } catch (err) {
    console.error("[pinechar] Anthropic call failed:", err);
    return res.json(fallbackDecision(describeError(err)));
  }

  // No score, no payout, no ledger entry — the conversation just continues.
  if (decision.kind === "question") {
    if (questionsAsked(body) >= MAX_QUESTIONS) {
      // The instruction to stop asking was explicit and in-context. Rather than
      // let the gate loop forever, it closes — same fail-closed rule as every
      // other path where the judge doesn't produce a usable decision.
      return res.json(fallbackDecision("judge exceeded its clarifying-question budget"));
    }
    return res.json({ decision: "question", message: decision.message });
  }

  const minutes = minutesFor(decision.score, strictness);

  res.json({
    // Derived here, not taken from the model: the score bands and the
    // strictness table decide the outcome, and the judge never sees minutes.
    decision: minutes > 0 ? "granted" : "denied",
    score: decision.score,
    minutes,
    code: minutes > 0 ? generateCode() : null,
    reasoning: decision.reasoning,
    // The extension writes these into the ledger, which is what lets rule 5
    // catch a claim being spent twice — without them the week has no memory.
    claims: decision.claims,
    message: decision.message,
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[pinechar] listening on http://localhost:${PORT} (model: ${MODEL})`);
});
