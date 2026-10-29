"use client";

// Place at: frontend-next/src/app/japanese/cram/page.tsx
//
// Grammar cram (Bunpro-style). Nothing here touches /f-api/v1/flashcard,
// so cramming never changes the difficulty saved by normal reviews.

import { useCallback, useEffect, useRef, useState } from "react";
import { useUser } from "@/context/UserContext";
import LoginButton from "@/components/LoginButton";

/* ----------------------------- types ----------------------------- */
interface Example {
  jp: string;
  romaji: string;
  en: string;
  grammar_audio: string;
}

interface CramItem {
  title: string;
  p_tag: string;
  s_tag?: string;
  short_explanation: string;
  long_explanation: string;
  formation: string;
  examples: Example[];
  difficulty?: string;
}

interface Card {
  item: CramItem;
  exIdx: number; // which example sentence is shown
  correct: number;
  wrong: number;
}

type Mode = "reading" | "listening";
type Filter = "all" | "unknown" | "hard" | "not_easy" | "missed_last_session";
type Phase = "setup" | "session" | "summary";

const LEVELS = ["JLPT_N5", "JLPT_N4", "JLPT_N3", "JLPT_N2", "JLPT_N1"];
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All grammar points" },
  { value: "unknown", label: "Not rated yet" },
  { value: "hard", label: "Marked hard" },
  { value: "not_easy", label: "Anything not marked easy" },
  { value: "missed_last_session", label: "Missed in my last cram" },
];

const btn =
  "rounded-md px-4 py-2 text-sm font-semibold shadow-md transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500";

/* ----------------------------- page ----------------------------- */
export default function CramPage() {
  const { userId, loggedIn, loading } = useUser();

  const [phase, setPhase] = useState<Phase>("setup");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // setup choices
  const [levels, setLevels] = useState<string[]>(["JLPT_N5"]);
  const [filter, setFilter] = useState<Filter>("all");
  const [mode, setMode] = useState<Mode>("reading");
  const [limit, setLimit] = useState(20);

  // session state
  const [cards, setCards] = useState<Card[]>([]);
  const [queue, setQueue] = useState<number[]>([]); // indices into cards
  const [revealed, setRevealed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const currentIdx = queue[0];
  const current = currentIdx !== undefined ? cards[currentIdx] : undefined;
  const example = current ? current.item.examples[current.exIdx] : undefined;

  /* ----------------------------- audio ----------------------------- */
  const playAudio = useCallback((url: string, slow = false) => {
    audioRef.current?.pause();
    const a = new Audio(url);
    a.playbackRate = slow ? 0.75 : 1;
    audioRef.current = a;
    a.play().catch(() => {
      /* autoplay can be blocked; the Play button still works */
    });
  }, []);

  // In listening mode, try to play the sentence when a new card appears.
  useEffect(() => {
    if (phase === "session" && mode === "listening" && example) {
      playAudio(example.grammar_audio);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, mode, currentIdx, current?.exIdx]);

  /* ----------------------------- session ----------------------------- */
  const startWith = (items: CramItem[]) => {
    const fresh: Card[] = items.map((item) => ({
      item,
      exIdx: Math.floor(Math.random() * item.examples.length),
      correct: 0,
      wrong: 0,
    }));
    setCards(fresh);
    setQueue(fresh.map((_, i) => i));
    setRevealed(false);
    setPhase("session");
  };

  const buildSession = async () => {
    if (!userId || levels.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/f-api/v1/cram/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, p_tags: levels, filter, limit }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not build session");
      if (!data.items || data.items.length === 0) {
        setError("No grammar points match those choices. Try a different filter or level.");
        return;
      }
      startWith(data.items as CramItem[]);
    } catch (e: any) {
      setError(e.message || "Could not build session");
    } finally {
      setBusy(false);
    }
  };

  const saveSession = async (finalCards: Card[]) => {
    try {
      await fetch("/f-api/v1/cram/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          mode,
          filter,
          p_tags: levels,
          items: finalCards.map((c) => ({
            p_tag: c.item.p_tag,
            title: c.item.title,
            correct: c.correct,
            wrong: c.wrong,
          })),
        }),
      });
    } catch (e) {
      console.error("Failed to save cram session:", e);
    }
  };

  const answer = useCallback(
    (gotIt: boolean) => {
      if (currentIdx === undefined) return;
      const updated = cards.map((c, i) =>
        i !== currentIdx
          ? c
          : {
              ...c,
              correct: c.correct + (gotIt ? 1 : 0),
              wrong: c.wrong + (gotIt ? 0 : 1),
              // after a miss, show a different example sentence next time
              exIdx: gotIt ? c.exIdx : (c.exIdx + 1) % c.item.examples.length,
            }
      );
      const rest = queue.slice(1);
      // a missed card goes to the back of the queue and must be answered right
      const nextQueue = gotIt ? rest : [...rest, currentIdx];

      setCards(updated);
      setQueue(nextQueue);
      setRevealed(false);

      if (nextQueue.length === 0) {
        saveSession(updated);
        setPhase("summary");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cards, queue, currentIdx, userId, mode, filter, levels]
  );

  /* ----------------------------- keyboard ----------------------------- */
  useEffect(() => {
    if (phase !== "session") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        if (!revealed) setRevealed(true);
      } else if (revealed && e.key === "1") {
        answer(false);
      } else if (revealed && e.key === "2") {
        answer(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, revealed, answer]);

  /* ----------------------------- render ----------------------------- */
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="text-gray-500">Loading...</span>
      </div>
    );
  }

  if (!loggedIn) {
    return (
      <div className="mx-auto max-w-md p-6">
        <h2 className="mb-4 text-xl font-bold">Please log in</h2>
        <p className="mb-4">You need to be logged in to cram.</p>
        <LoginButton />
      </div>
    );
  }

  /* ---------- setup ---------- */
  if (phase === "setup") {
    const toggleLevel = (l: string) =>
      setLevels((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]));

    return (
      <div className="min-h-screen bg-gray-100 p-4 text-black dark:bg-gray-900 dark:text-white">
        <div className="mx-auto max-w-xl space-y-6 rounded-xl bg-blue-50 p-6 shadow-xl dark:bg-gray-800">
          <div>
            <h1 className="text-2xl font-bold">Grammar cram</h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              Practice without changing your review schedule. Cram results never touch the difficulty
              you set in normal flashcards.
            </p>
          </div>

          <fieldset>
            <legend className="mb-2 font-semibold">Levels</legend>
            <div className="flex flex-wrap gap-2">
              {LEVELS.map((l) => (
                <button
                  key={l}
                  onClick={() => toggleLevel(l)}
                  aria-pressed={levels.includes(l)}
                  className={`${btn} ${
                    levels.includes(l)
                      ? "bg-blue-500 text-white"
                      : "bg-white text-gray-800 hover:bg-gray-100"
                  }`}
                >
                  {l.replace("JLPT_", "")}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="block">
            <span className="mb-2 block font-semibold">Which grammar points</span>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
              className="w-full rounded-md border border-gray-300 bg-white p-2 text-gray-800"
            >
              {FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset>
            <legend className="mb-2 font-semibold">Mode</legend>
            <div className="flex gap-2">
              {(["reading", "listening"] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={`${btn} ${
                    mode === m ? "bg-blue-500 text-white" : "bg-white text-gray-800 hover:bg-gray-100"
                  }`}
                >
                  {m === "reading" ? "Reading" : "Listening"}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-600 dark:text-gray-300">
              {mode === "reading"
                ? "You see a Japanese sentence. Work out the grammar and meaning, then reveal the answer."
                : "You hear a sentence first. Reveal to see the text, translation and grammar."}
            </p>
          </fieldset>

          <label className="block">
            <span className="mb-2 block font-semibold">Number of cards: {limit}</span>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-full"
            />
          </label>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            onClick={buildSession}
            disabled={busy || levels.length === 0}
            className={`${btn} w-full bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50`}
          >
            {busy ? "Building session..." : "Start cram"}
          </button>
        </div>
      </div>
    );
  }

  /* ---------- summary ---------- */
  if (phase === "summary") {
    const missed = cards.filter((c) => c.wrong > 0);
    const firstTry = cards.length - missed.length;
    return (
      <div className="min-h-screen bg-gray-100 p-4 text-black dark:bg-gray-900 dark:text-white">
        <div className="mx-auto max-w-xl space-y-6 rounded-xl bg-blue-50 p-6 shadow-xl dark:bg-gray-800">
          <h1 className="text-2xl font-bold">Session complete</h1>
          <p>
            {firstTry} of {cards.length} right the first time.
            {missed.length > 0 && ` ${missed.length} needed another try.`}
          </p>

          {missed.length > 0 && (
            <div>
              <h2 className="mb-2 font-semibold">Missed</h2>
              <ul className="space-y-1 text-sm">
                {missed.map((c) => (
                  <li key={`${c.item.p_tag}-${c.item.title}`} className="rounded bg-white p-2 text-gray-800">
                    {c.item.title}
                    <span className="ml-2 text-gray-500">({c.wrong}x)</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {missed.length > 0 && (
              <button
                onClick={() => startWith(missed.map((c) => c.item))}
                className={`${btn} bg-blue-500 text-white hover:bg-blue-600`}
              >
                Cram the missed ones
              </button>
            )}
            <button
              onClick={() => setPhase("setup")}
              className={`${btn} bg-white text-gray-800 hover:bg-gray-100`}
            >
              New session
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- session ---------- */
  if (!current || !example) return null;
  const remaining = queue.length;
  const done = cards.filter((c) => c.correct > 0).length;

  return (
    <div className="min-h-screen bg-gray-100 p-4 text-black dark:bg-gray-900 dark:text-white">
      <div className="mx-auto max-w-2xl space-y-4">
        <div className="flex items-center justify-between text-sm">
          <button onClick={() => setPhase("setup")} className="underline">
            End session
          </button>
          <span>
            {done} / {cards.length} done, {remaining} in queue
          </span>
        </div>
        <div className="h-2 w-full rounded bg-gray-300">
          <div
            className="h-2 rounded bg-blue-500 transition-all"
            style={{ width: `${(done / cards.length) * 100}%` }}
          />
        </div>

        <div className="space-y-5 rounded-xl bg-blue-50 p-6 text-gray-800 shadow-xl">
          {/* prompt */}
          <div className="text-center">
            {mode === "listening" && !revealed ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">Listen, then reveal.</p>
                <div className="flex justify-center gap-2">
                  <button
                    onClick={() => playAudio(example.grammar_audio)}
                    className={`${btn} bg-blue-200 text-blue-900 hover:bg-blue-300`}
                  >
                    Play
                  </button>
                  <button
                    onClick={() => playAudio(example.grammar_audio, true)}
                    className={`${btn} bg-blue-200 text-blue-900 hover:bg-blue-300`}
                  >
                    Play slowly
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-2xl font-bold leading-relaxed">{example.jp}</p>
            )}
            {mode === "reading" && !revealed && (
              <p className="mt-3 text-sm text-gray-600">
                Which grammar point is this, and what does the sentence mean?
              </p>
            )}
          </div>

          {/* answer */}
          {revealed && (
            <div className="space-y-3">
              <div className="rounded-lg bg-white p-4 shadow-sm">
                <p className="text-sm text-gray-600">{example.romaji}</p>
                <p className="mt-1 italic">{example.en}</p>
                <button
                  onClick={() => playAudio(example.grammar_audio)}
                  className="mt-2 text-sm text-blue-700 underline"
                >
                  Play audio
                </button>
              </div>
              <div className="rounded-lg bg-white p-4 shadow-sm">
                <h2 className="text-lg font-bold">{current.item.title}</h2>
                <p className="mt-1 text-sm italic text-gray-600">{current.item.short_explanation}</p>
                <p className="mt-2 text-sm">
                  <span className="font-semibold">Formation:</span> {current.item.formation}
                </p>
              </div>
            </div>
          )}

          {/* controls */}
          <div className="flex justify-center gap-3">
            {!revealed ? (
              <button
                onClick={() => setRevealed(true)}
                className={`${btn} bg-blue-500 text-white hover:bg-blue-600`}
              >
                Show answer (Space)
              </button>
            ) : (
              <>
                <button
                  onClick={() => answer(false)}
                  className={`${btn} bg-red-200 text-red-900 hover:bg-red-300`}
                >
                  Missed it (1)
                </button>
                <button
                  onClick={() => answer(true)}
                  className={`${btn} bg-blue-200 text-blue-900 hover:bg-blue-300`}
                >
                  Got it (2)
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
