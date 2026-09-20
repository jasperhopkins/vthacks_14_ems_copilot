// Giving the iOS audio session back, reliably.
//
// `setAudioModeAsync({allowsRecording: true})` puts the session into
// `playAndRecord` for the **whole app**, not just the screen that asked.
// Any screen that takes it therefore has to hand it back -- on blur *and*
// on unmount, because backing out of a screen pops it and only unmount
// runs on that path.
//
// The retry is the part that is easy to get wrong. `AudioStream.stop()` is
// synchronous in JavaScript, but the native capture graph does not finish
// tearing down before the next line runs, so an immediate
// `setAudioModeAsync` is refused with OSStatus 561017449 -- `'!pri'`,
// `AVAudioSessionErrorCodeInsufficientPriority`. Swallowing that failure
// silently is worse than not trying: the session stays in playAndRecord,
// and every later playback anywhere in the app is affected. So: try, back
// off, try again, and say so if it never takes.
//
// Decoding these codes is a four-char-code trick worth knowing:
//   python3 -c "print(bytes.fromhex(hex(561017449)[2:]).decode())"  ->  !pri
import { setAudioModeAsync } from "expo-audio";

// Three passes, ~800ms total. Not retries-on-failure: passes. An attempt
// can *succeed* and still be undone a moment later, because
// `AudioStream.stop()` ends with
//   try? AVAudioSession.sharedInstance().setActive(false, ...)
// and that lands whenever the native teardown gets to it. One successful
// setCategory is therefore not enough -- the later passes are what put the
// session back after a straggling deactivation.
const RELEASE_PASSES_MS = [0, 200, 600];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PLAYBACK_MODE = { allowsRecording: false, playsInSilentMode: true };

/**
 * One fast attempt to get a playback-capable, active session.
 *
 * For the moment just before playing something, where the ~800ms of
 * `releaseAudioSession` would be heard as lag. Never rejects.
 */
export async function enterPlaybackSession() {
  try {
    await setAudioModeAsync(PLAYBACK_MODE);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand the session back for good, on the way out of a screen.
 * Never rejects. Returns whether the last pass took.
 */
export async function releaseAudioSession() {
  let ok = false;
  for (const delay of RELEASE_PASSES_MS) {
    if (delay) await sleep(delay);
    try {
      await setAudioModeAsync(PLAYBACK_MODE);
      ok = true;
    } catch {
      ok = false;   // still held; a later pass may get it
    }
  }
  if (!ok) {
    // Worth seeing in the log rather than discovering through silence.
    console.warn("[audio] could not release the recording session");
  }
  return ok;
}
