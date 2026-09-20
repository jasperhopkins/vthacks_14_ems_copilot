// The hands-free routing rules, exercised without a device.
//
// Every case here is a failure that actually happened in the cab. The
// router is pure and takes `now` as an argument, so a six-second pause is
// a number rather than a six-second test.
//
//   node mobile/tools/test_utterance_router.mjs
import { createUtteranceRouter, DEFAULTS } from "../src/api/utteranceRouter.js";

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`ok    ${name}`); }
  else { fail++; console.error(`FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); }
}
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ---------------------------------------------------------------- basics
{
  const r = createUtteranceRouter();
  const a = r.segment("58 year old male with crushing chest pain", 0);
  eq("plain narration is recorded, nothing dispatched",
     [a.narration, a.dispatch], ["58 year old male with crushing chest pain", null]);

  const b = r.segment("Copilot, what's the adult aspirin dose", 1000);
  eq("a wake word starts a request and is kept out of the narration",
     [b.narration, b.dispatch], [null, null]);
  eq("...on the longer window, since Transcribe left it unpunctuated",
     b.armMs, DEFAULTS.openSettleMs);

  const c = r.timeout(2600);
  eq("the request goes when the medic stops talking", c.dispatch, "what's the adult aspirin dose");
}

// ------------------------------------------- continuation across a pause
{
  const r = createUtteranceRouter();
  r.segment("Copilot, what's the dose", 0);
  const more = r.segment("for a 40 kilo kid", 900);
  eq("a segment inside the window extends the same request", more.dispatch, null);
  eq("the settle clock restarts on a continuation", more.armMs, DEFAULTS.openSettleMs);
  eq("one question, not two", r.timeout(2500).dispatch, "what's the dose for a 40 kilo kid");
}

// --------------------------------------------------- THE REPORTED FAILURE
// A dictated write-up request runs well past the old 6s ceiling. It used
// to be cut in half: the first part dispatched as its own turn, the rest
// arriving with no request open and ending up as narration only.
{
  const r = createUtteranceRouter();
  r.segment("Copilot, write that up", 0);
  r.segment("58 year old male", 1200);
  r.segment("crushing substernal chest pain radiating to the jaw", 2600);
  r.segment("we gave 324 of aspirin and two sprays of nitro", 4200);
  const late = r.segment("vitals 140 over 90, heart rate 96, sats 94 percent", 7000);
  eq("a 7-second dictated request is still one request", late.dispatch, null);
  const out = r.timeout(8600).dispatch;
  ok("the whole request survives past the old 6s cap",
     out.startsWith("write that up") && out.includes("aspirin") && out.includes("sats 94"),
     out);
}

{
  const r = createUtteranceRouter({ maxMs: 15000 });
  r.segment("Copilot, tell me about", 0);
  const capped = r.segment("and on and on", 15100);
  ok("past maxMs the request is flushed rather than grown forever",
     capped.dispatch !== null && capped.armMs === 0, JSON.stringify(capped));
}

{
  const r = createUtteranceRouter({ maxWords: 10 });
  r.segment("Copilot, one two three", 0);
  const big = r.segment("four five six seven eight nine ten eleven", 500);
  ok("continuous chatter is capped on words, not only on the clock",
     big.dispatch !== null, JSON.stringify(big));
}

// ------------------------------------------- adaptive settle window
{
  const r = createUtteranceRouter();
  const done = r.segment("Copilot, what's the epi dose?", 0);
  eq("a complete-sounding question keeps the short window", done.armMs, DEFAULTS.settleMs);
}

{
  const r = createUtteranceRouter();
  const open = r.segment("Copilot, write that up, 58 year old male", 0);
  eq("a request left mid-thought waits longer before dispatching",
     open.armMs, DEFAULTS.openSettleMs);
  const more = r.segment("with crushing chest pain and diaphoresis", 2000);
  eq("...and keeps waiting while the dictation continues", more.armMs, DEFAULTS.openSettleMs);
  eq("nothing has been sent yet", more.dispatch, null);
}

{
  const r = createUtteranceRouter();
  r.segment("Copilot, what's the dose for", 0);
  const finished = r.segment("a 40 kilo child.", 1000);
  eq("once it sounds finished the window shortens again",
     finished.armMs, DEFAULTS.settleMs);
}

{
  const r = createUtteranceRouter({ maxMs: 3000 });
  const open = r.segment("Copilot, tell me about", 0);
  ok("the long window never outruns maxMs", open.armMs <= 3000, String(open.armMs));
}

// ------------------------------------------ never drop a request when busy
{
  const r = createUtteranceRouter();
  r.segment("Copilot, what's the epi dose", 0);
  const first = r.timeout(1600);
  eq("first request dispatches", first.dispatch, "what's the epi dose");

  r.turnStarted();
  r.segment("Copilot, and the pediatric one", 2000);
  const whileBusy = r.timeout(3600);
  eq("a request asked mid-answer is NOT dispatched immediately", whileBusy.dispatch, null);
  eq("...it is queued, not discarded", r.state().queued, ["and the pediatric one"]);

  const after = r.turnEnded();
  eq("...and goes as soon as the turn ends", after.dispatch, "and the pediatric one");
}

{
  const r = createUtteranceRouter({ maxQueued: 2 });
  r.turnStarted();
  for (const q of ["one", "two", "three"]) {
    r.segment(`Copilot, ${q}`, 0);
    r.timeout(2000);
  }
  const q = r.state().queued;
  eq("beyond the queue cap, words are merged rather than lost",
     [q.length, q[1]], [2, "two three"]);
}

{
  // The window between "turn finished" and "the queued turn actually
  // started" must not look idle, or a segment settling inside it
  // dispatches alongside the queued one.
  const r = createUtteranceRouter();
  r.turnStarted();
  r.segment("Copilot, first question", 0);
  r.timeout(3000);
  const handoff = r.turnEnded();
  eq("turnEnded hands over the queued request", handoff.dispatch, "first question");
  ok("...and stays busy until that turn starts", r.state().busy === true,
     JSON.stringify(r.state()));

  r.segment("Copilot, second question", 4000);
  const racing = r.timeout(7000);
  eq("a request settling in the handoff window is queued, not dispatched",
     racing.dispatch, null);
  eq("...and is still there", r.state().queued, ["second question"]);
}

{
  const r = createUtteranceRouter();
  r.turnStarted();
  r.enqueue("held by the caller");
  eq("enqueue holds rather than drops", r.state().queued, ["held by the caller"]);
  eq("and it is released in order", r.turnEnded().dispatch, "held by the caller");
}

{
  const r = createUtteranceRouter();
  r.turnStarted();
  const empty = r.turnEnded();
  eq("with nothing queued the router goes idle", [empty.dispatch, r.state().busy], [null, false]);
}

// ------------------------------------------- narration during a spoken reply
{
  const r = createUtteranceRouter({ muteGraceMs: 1500 });
  r.muteStarted(1000);
  r.segment("blood pressure is 140 over 90", 1300);   // said before the mute
  r.segment("something much later", 5000);            // long after
  const out = r.muteEnded("The adult dose is 324 milligrams.", 5200);
  eq("speech still in flight when the reply started is kept",
     out.narration, "blood pressure is 140 over 90");
}

{
  const r = createUtteranceRouter();
  r.muteStarted(0);
  r.segment("The adult dose is 324 milligrams", 200);
  const out = r.muteEnded("The adult dose is 324 milligrams.", 400);
  eq("the assistant's own voice never reaches the narration", out.narration, null);
}

// ------------------------------------------- wake word split across segments
{
  const r = createUtteranceRouter();
  const a = r.segment("patient is diaphoretic co", 0);
  eq("a trailing wake-word fragment is held back, not narrated",
     a.narration, "patient is diaphoretic");
  const b = r.segment("pilot, what's the protocol", 600);
  eq("...and joins the next segment to form the wake word", b.dispatch, null);
  eq("the split wake word still starts a request",
     r.timeout(2200).dispatch, "what's the protocol");
}

{
  const r = createUtteranceRouter();
  r.segment("give him some co", 0);
  const b = r.segment("oxygen by mask", 600);
  eq("a held fragment that turns out not to be a wake word is still narrated",
     b.narration, "co oxygen by mask");
}

// ------------------------------------------------------ bare wake word
{
  const r = createUtteranceRouter();
  const a = r.segment("Copilot", 0);
  eq("a bare wake word waits for the command", [a.dispatch, a.awaiting], [null, true]);
  const b = r.segment("check epi against propranolol", 900);
  eq("the follow-up is the request, not narration", b.narration, null);
  eq("and it dispatches on settle", r.timeout(2500).dispatch, "check epi against propranolol");
}

// ---------------------------------------------- re-waking mid-request
{
  const r = createUtteranceRouter();
  r.segment("Copilot, what's the dose", 0);
  const again = r.segment("Copilot, actually check interactions", 800);
  eq("saying the wake word again sends the previous request", again.dispatch, "what's the dose");
  eq("...and starts a new one", r.timeout(2400).dispatch, "actually check interactions");
}

// ---------------------------------------------------- reconnect safety
{
  const r = createUtteranceRouter();
  r.segment("Copilot, half a quest", 0);
  r.resetPending();
  eq("a half-spoken request is dropped on reconnect", r.state().pending, "");
  const after = r.segment("patient is alert and oriented", 5000);
  eq("...and later speech is plain narration again",
     after.narration, "patient is alert and oriented");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
