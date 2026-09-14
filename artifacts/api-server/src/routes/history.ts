import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type IRouter } from "express";
import {
  GetSignalHistoryResponse,
  RegisterFeaturedSignalsBody,
  RegisterFeaturedSignalsResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";

type SignalMarket = "full" | "firstHalf" | "live";
type SignalOutcome = "hit" | "miss" | null;

type StoredSignal = {
  id: string;
  fixtureId: number;
  homeTeam: string;
  awayTeam: string;
  market: SignalMarket;
  line: string;
  edge: number;
  probability: number;
  recordedAt: string;
  resolvedAt: string | null;
  outcome: SignalOutcome;
  realResult: string | null;
};

type HistoryState = { signals: StoredSignal[] };

export type ResolutionFixture = {
  fixture?: {
    id?: number;
    status?: { short?: string };
  };
  goals?: {
    home?: number | null;
    away?: number | null;
  };
  score?: {
    halftime?: {
      home?: number | null;
      away?: number | null;
    };
    fulltime?: {
      home?: number | null;
      away?: number | null;
    };
  };
};

const STATE_FILE = path.resolve(
  import.meta.dirname,
  "../data/signal-history.json",
);
const INVALID_STATUSES = new Set(["CANC", "ABD", "PST", "SUSP"]);

let state: HistoryState = { signals: [] };
let loaded = false;
let saveQueue = Promise.resolve();

async function loadState() {
  if (loaded) return;
  try {
    const content = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(content) as Partial<HistoryState>;
    state = { signals: Array.isArray(parsed.signals) ? parsed.signals : [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ err: error }, "Unable to load signal history");
    }
  }
  loaded = true;
}

function saveState() {
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      const temporaryFile = `${STATE_FILE}.tmp`;
      await fs.writeFile(temporaryFile, JSON.stringify(state, null, 2), "utf8");
      await fs.rename(temporaryFile, STATE_FILE);
    });
  return saveQueue;
}

export function evaluateSignalLine(
  line: string,
  homeScore: number,
  awayScore: number,
): boolean | null {
  if (line === "Ambas marcam 1T") {
    return homeScore > 0 && awayScore > 0;
  }
  const match = /^Over\s+(\d+(?:\.\d+)?)(?:\s+HT)?$/i.exec(line);
  if (!match) return null;
  return homeScore + awayScore > Number(match[1]);
}

function resolveSignal(
  signal: StoredSignal,
  fixture: ResolutionFixture,
): StoredSignal | null {
  const status = fixture.fixture?.status?.short;
  if (status && INVALID_STATUSES.has(status)) return null;
  if (status !== "FT") return signal;

  const score =
    signal.market === "firstHalf"
      ? fixture.score?.halftime
      : fixture.score?.fulltime ?? fixture.goals;
  const homeScore = score?.home;
  const awayScore = score?.away;
  if (typeof homeScore !== "number" || typeof awayScore !== "number") {
    return signal;
  }

  const hit = evaluateSignalLine(signal.line, homeScore, awayScore);
  if (hit === null) return signal;
  const suffix =
    signal.market === "firstHalf"
      ? "ao intervalo"
      : `${homeScore + awayScore} golos`;

  return {
    ...signal,
    resolvedAt: new Date().toISOString(),
    outcome: hit ? "hit" : "miss",
    realResult: `${homeScore}-${awayScore} (${suffix})`,
  };
}

export async function resolveSignalsFromFixtures(
  fixtures: ResolutionFixture[],
) {
  await loadState();
  const pendingIds = new Set(
    state.signals
      .filter((signal) => signal.outcome === null)
      .map((signal) => signal.fixtureId),
  );
  if (pendingIds.size === 0) return;

  const fixturesById = new Map(
    fixtures
      .filter(
        (fixture) =>
          typeof fixture.fixture?.id === "number" &&
          pendingIds.has(fixture.fixture.id),
      )
      .map((fixture) => [fixture.fixture!.id!, fixture]),
  );
  if (fixturesById.size === 0) return;

  let changed = false;
  state.signals = state.signals.flatMap((signal) => {
    if (signal.outcome !== null) return [signal];
    const fixture = fixturesById.get(signal.fixtureId);
    if (!fixture) return [signal];
    const resolved = resolveSignal(signal, fixture);
    if (resolved === null) {
      changed = true;
      return [];
    }
    if (resolved !== signal) changed = true;
    return [resolved];
  });
  if (changed) await saveState();
}

const router: IRouter = Router();

router.post("/signals", async (req, res) => {
  try {
    await loadState();
    const payload = RegisterFeaturedSignalsBody.parse(req.body);
    const existingIds = new Set(state.signals.map((signal) => signal.id));
    const recordedAt = new Date().toISOString();
    let changed = false;

    for (const signal of payload.signals) {
      const id = `${signal.fixtureId}:${signal.market}`;
      if (existingIds.has(id)) continue;
      state.signals.push({
        ...signal,
        id,
        recordedAt,
        resolvedAt: null,
        outcome: null,
        realResult: null,
      });
      existingIds.add(id);
      changed = true;
    }
    if (changed) await saveState();
    res.json(RegisterFeaturedSignalsResponse.parse({ ok: true }));
  } catch (error) {
    req.log.warn({ err: error }, "Unable to register featured signals");
    res.status(400).json({ error: "invalid_signals" });
  }
});

router.get("/history", async (req, res) => {
  try {
    await loadState();
    res.json(GetSignalHistoryResponse.parse({ signals: state.signals }));
  } catch (error) {
    req.log.error({ err: error }, "Unable to read signal history");
    res.status(500).json({ error: "history_unavailable" });
  }
});

export default router;