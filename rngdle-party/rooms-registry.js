// One code space for every game.
//
// Each game keeps its own rooms and its own websocket path, but codes used to
// be minted per game — so RNGdle and HorsRNG could both hand out "A7K2" at the
// same time and a code on its own meant nothing. Allocating through here makes
// a code globally unique and tells us which game it belongs to, which is what
// lets a single join box send someone to the right game.

const owner = new Map();   // CODE -> gameId

// Ambiguous glyphs (I, L, O, 0, 1) are already left out: these get read aloud
// across a room and typed on phones.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Mint a code that no game is currently using, and record who owns it. */
export function claimCode(gameId) {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
  } while (owner.has(code));
  owner.set(code, gameId);
  return code;
}

/** Hand a code back when its room is torn down, so it can be reused. */
export function releaseCode(code) {
  if (code) owner.delete(String(code).toUpperCase());
}

/** Which game owns this code, or null if nobody does. */
export function gameFor(code) {
  return owner.get(String(code || "").toUpperCase()) || null;
}

/** Where a player with this code should be sent. */
export const GAME_PATHS = {
  rngdle: "/",
  horsrng: "/horsrng",
  imposter: "/imposter",
  rngoldrush: "/rngoldrush"
};

export const GAME_NAMES = {
  rngdle: "RNGdle",
  horsrng: "HorsRNG",
  imposter: "ImpostRNG",
  rngoldrush: "RNGold Rush"
};

export function liveRoomCount() { return owner.size; }
