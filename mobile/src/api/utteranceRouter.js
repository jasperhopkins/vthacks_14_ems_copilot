// Deciding what the medic just said was *for*.
//
// This is the state machine that sits between Amazon Transcribe's settled
// segments and the agent: it separates patient narration from requests
// addressed to Copilot, decides when a request has finished being spoken,
// and makes sure neither kind of speech is thrown away.
//
// It lives here, as a pure module with no React and no timers of its own,
// for the same reason `common/protocol_search.py` has no boto3: it is the
// part that is worth testing, and it could not be tested while it was
// seven `useRef`s tangled into a 1100-line screen. Every rule below was a
// bug first -- see `mobile/tools/test_utterance_router.mjs`, which has a
// case for each.
//
// The caller drives it with events and performs the effects it returns.
// It never calls back and never schedules anything; `armMs` is a request
// for the caller to set a timer that calls `timeout()`.
//
// Effects returned by every event method:
//
//   { narration, dispatch, armMs, awaiting }
//
//   narration  text to append to the running call transcript, or null
//   dispatch   an utterance to send to the agent now, or null
//   armMs      set the settle timer to this many ms; 0 disarms it;
//              null leaves whatever timer is running alone
//   awaiting   whether the UI should say "still listening"

// "Copilot", as Transcribe actually writes it -- it varies between
// "copilot", "co-pilot" and "co pilot" depending on how it's said.
export const WAKE_WORD = /\bco[\s-]?pilot\b/i;

// A trailing fragment that might be the front half of a wake word split
// across two settled segments ("Co…" / "…pilot, what's the dose"). Held
// back for one segment rather than emitted, because a wake word that
// arrives in two pieces otherwise matches nothing at all: the request is
// missed *and* the word "Copilot" lands in the patient's narrative.
const WAKE_PREFIX = /^co[-\s]?(p|pi|pil|pilo)?$/i;

export const DEFAULTS = {
  // How long after a phrase settles before deciding the medic has
  // stopped. Transcribe settles at any natural pause -- a breath, a
  // moment's thought -- so dispatching on the first settled segment
  // answers half a question.
  settleMs: 1500,

  // ...and how long to wait when the request does not sound finished.
  // Transcribe punctuates, so a segment that ends without a full stop,
  // question mark or exclamation is mid-thought, and the medic is
  // drawing breath rather than waiting for an answer. A flat window
  // cannot tell those apart: short enough to feel responsive to "what's
  // the epi dose?" is short enough to guillotine someone dictating a
  // report, which is the reported failure. This only ever *extends*, so
  // a complete-sounding question is as quick as it ever was.
  openSettleMs: 2600,

  // Ceiling on how long one request may keep growing. This used to be
  // 6s, which is *less than a medic takes to dictate a write-up request*,
  // so a long one was guillotined mid-sentence and the remainder became a
  // second, unrelated-looking turn. That is the "one PCR split across
  // several turns" failure. The cap exists to stop continuous cab chatter
  // burying a request, and word count does that job better than a clock:
  // chatter hits `maxWords` long before a genuine request does.
  maxMs: 15000,
  maxWords: 140,

  // Requests that arrive while the assistant is still answering are held,
  // not dropped. Two is generous for the few seconds a turn takes; past
  // that, extra speech is merged into the last queued request so the
  // words still reach the agent rather than vanishing.
  maxQueued: 2,

  // A segment settling within this long after the microphone was muted
  // was spoken *before* the mute -- it is the tail of the medic's own
  // speech, still in flight through Transcribe -- so it belongs in the
  // narration. Anything later is discarded.
  muteGraceMs: 1500,
};

const NONE = { narration: null, dispatch: null, armMs: null, awaiting: false };

const words = (s) => (s ? s.trim().split(/\s+/).filter(Boolean) : []);
const normalize = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** Everything after the wake word, or null when there is no wake word. */
export function commandAfterWake(text) {
  const match = WAKE_WORD.exec(text);
  if (!match) return null;
  return text.slice(match.index + match[0].length).replace(/^[\s,.:;-]+/, "").trim();
}

/** The part of a segment that is patient narration: everything *before*
 *  the wake word. Talking to Copilot is not patient care, and letting the
 *  command into the transcript is what produced PCRs with every field
 *  null -- the request is a non-empty string, so the backend's
 *  empty-transcript guard never fired and extraction ran on it. */
export function narrationOf(text) {
  const match = WAKE_WORD.exec(text);
  return (match ? text.slice(0, match.index) : text).trim();
}

export function createUtteranceRouter(options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  let pending = "";           // the request currently being collected
  let startedAt = 0;          // when collection began, for the maxMs cap
  let awaitingCommand = false; // they said "Copilot" and nothing else yet
  let busy = false;           // a turn is in flight
  let queue = [];             // requests waiting for that turn to end
  let muted = false;
  let mutedAt = 0;
  let held = [];              // segments that settled while muted
  let carry = "";             // a possible split wake word, held one segment

  /** Fold `carry` into the incoming segment so a wake word broken across
   *  two segments is still seen as one word. */
  function joinCarry(text) {
    if (!carry) return { text, carried: "" };
    const joined = `${carry} ${text}`.trim();
    const carried = carry;
    carry = "";
    return { text: joined, carried };
  }

  /** Pull a trailing wake-word fragment off narration and hold it. */
  function deferWakePrefix(text) {
    const parts = words(text);
    if (parts.length && WAKE_PREFIX.test(parts[parts.length - 1])) {
      carry = parts.pop();
      return parts.join(" ");
    }
    return text;
  }

    // Does the collected request sound like a finished sentence?
  function soundsComplete(text) {
    return /[.?!]["')\]]?\s*$/.test((text || "").trim());
  }

  function capReached(now) {
    return (now - startedAt) >= cfg.maxMs || words(pending).length >= cfg.maxWords;
  }

  function armFor(now) {
    if (capReached(now)) return null;   // caller should flush instead
    const left = cfg.maxMs - (now - startedAt);
    const want = soundsComplete(pending) ? cfg.settleMs : cfg.openSettleMs;
    return Math.max(0, Math.min(want, left));
  }

  function beginPending(text, now) {
    pending = text;
    startedAt = now;
    awaitingCommand = false;
  }

  /** Hand one finished request off, or hold it if a turn is running.
   *  Nothing is ever dropped here -- that was the single biggest source
   *  of "I asked and it just ignored me". */
  function release(utterance) {
    const request = (utterance || "").trim();
    if (!request) return null;
    if (!busy) return request;
    if (queue.length < cfg.maxQueued) {
      queue.push(request);
    } else {
      // Rather than discard it, glue it onto the last one queued. Two
      // questions in one prompt is a worse answer; a silently dropped
      // question is no answer at all.
      queue[queue.length - 1] = `${queue[queue.length - 1]} ${request}`.trim();
    }
    return null;
  }

  function clearPending() {
    pending = "";
    startedAt = 0;
  }

  return {
    /** One settled segment of speech. */
    segment(rawText, now = Date.now()) {
      const incoming = (rawText || "").trim();
      if (!incoming) return { ...NONE, awaiting: awaitingCommand || !!pending };

      // While the assistant is speaking the microphone is fed silence, so
      // anything settling now was said before the mute. Decide at unmute,
      // when the reply text is known and can be told apart from it.
      if (muted) {
        held.push({ text: incoming, at: now });
        return { ...NONE, awaiting: awaitingCommand || !!pending };
      }

      const { text } = joinCarry(incoming);
      const command = commandAfterWake(text);
      let narration = deferWakePrefix(narrationOf(text));

      // Mid-request: everything landing inside the window is part of the
      // same question, wake word or not -- "Copilot, what's the dose
      // for…" and "…a 40 kilo kid" arrive separately and are one thing.
      if (pending) {
        if (command === null) {
          pending = `${pending} ${text}`.trim();
          const armMs = armFor(now);
          if (armMs === null) {
            const out = release(pending);
            clearPending();
            return { narration: narration || null, dispatch: out, armMs: 0, awaiting: false };
          }
          return { narration: narration || null, dispatch: null, armMs, awaiting: true };
        }
        // They said "Copilot" again: a new request, not a continuation.
        const out = release(pending);
        if (command) {
          beginPending(command, now);
          return { narration: narration || null, dispatch: out, armMs: armFor(now), awaiting: true };
        }
        clearPending();
        awaitingCommand = true;
        return { narration: narration || null, dispatch: out, armMs: 0, awaiting: true };
      }

      // They said "Copilot" last time and this is the follow-up.
      if (awaitingCommand && command === null) {
        beginPending(text, now);
        // The follow-up to a bare wake word is the request, so it is not
        // narration -- it is the medic talking to the assistant.
        return { narration: null, dispatch: null, armMs: armFor(now), awaiting: true };
      }

      if (command === null) {
        return { narration: narration || null, dispatch: null, armMs: null, awaiting: false };
      }
      if (command === "") {
        awaitingCommand = true;
        return { narration: narration || null, dispatch: null, armMs: 0, awaiting: true };
      }
      beginPending(command, now);
      return { narration: narration || null, dispatch: null, armMs: armFor(now), awaiting: true };
    },

    /** The settle timer expired: the medic has stopped talking. */
    timeout(now = Date.now()) {
      if (!pending) return { ...NONE, awaiting: awaitingCommand };
      const out = release(pending);
      clearPending();
      return { narration: null, dispatch: out, armMs: 0, awaiting: false };
    },

    /** A turn has been handed to the agent. */
    turnStarted() {
      busy = true;
    },

    /**
     * The agent's turn is over, including its spoken reply. Anything the
     * medic asked meanwhile goes now.
     *
     * Note what `busy` does when a request is waiting: it stays set. The
     * caller hands the queued turn off on a later tick, and if `busy`
     * went false in between, a segment settling inside that window would
     * dispatch straight away *and* the queued one would follow -- two
     * turns in flight against one encounter. Staying busy until the next
     * turn actually starts closes the window rather than narrowing it.
     */
    turnEnded() {
      const next = queue.shift() || null;
      busy = next !== null;
      return { narration: null, dispatch: next, armMs: null, awaiting: false };
    },

    /** Hold a request that the caller could not start. Belt and braces
     *  for the same invariant: only ever one turn in flight. */
    enqueue(utterance) {
      release(utterance);
    },

    muteStarted(now = Date.now()) {
      muted = true;
      mutedAt = now;
      held = [];
    },

    /**
     * The microphone is live again.
     *
     * Segments that settled just after the mute began were spoken before
     * it and are kept; later ones are dropped. Anything that reads as the
     * assistant's own reply coming back through the microphone is dropped
     * whatever its timing -- the mute is belt, this is braces, and the
     * failure it guards against (the assistant narrating itself into the
     * patient's chart) is bad enough to want both.
     */
    muteEnded(replyText = "", now = Date.now()) {
      muted = false;
      const reply = normalize(replyText);
      const kept = held
        .filter((h) => (h.at - mutedAt) <= cfg.muteGraceMs)
        .map((h) => h.text)
        .filter((t) => {
          const n = normalize(t);
          return n && !(reply && reply.includes(n));
        });
      held = [];
      if (!kept.length) return { ...NONE, awaiting: awaitingCommand || !!pending };
      const narration = deferWakePrefix(narrationOf(kept.join(" ")));
      return {
        narration: narration || null,
        dispatch: null,
        armMs: null,
        awaiting: awaitingCommand || !!pending,
      };
    },

    /** Drop a half-collected request without touching the narration --
     *  used when the socket reconnects under a partly-spoken question. */
    resetPending() {
      clearPending();
      awaitingCommand = false;
      carry = "";
      return { narration: null, dispatch: null, armMs: 0, awaiting: false };
    },

    /** Full reset, for starting a session. */
    reset() {
      clearPending();
      awaitingCommand = false;
      busy = false;
      queue = [];
      muted = false;
      mutedAt = 0;
      held = [];
      carry = "";
    },

    /** Test/diagnostic view. */
    state() {
      return { pending, awaitingCommand, busy, queued: [...queue], muted, carry };
    },
  };
}
