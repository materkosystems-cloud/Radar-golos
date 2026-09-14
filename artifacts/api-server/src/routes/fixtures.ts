import { Router, type IRouter } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  GetLiveFixturesResponse,
  GetTodayFixturesResponse,
} from "@workspace/api-zod";
import { resolveSignalsFromFixtures } from "./history";

const router: IRouter = Router();

const API_FOOTBALL_URL = "https://v3.football.api-sports.io/fixtures";
const TODAY_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const LIVE_CACHE_TTL_MS = 20 * 60 * 1000;
const LIVE_CACHE_FILE = path.resolve(
  import.meta.dirname,
  "../data/live-fixtures-cache.json",
);
const LIVE_STATUSES = new Set(["1H", "HT", "2H", "ET", "BT", "P", "LIVE"]);

type ApiFootballFixture = {
  fixture?: {
    id?: number;
    date?: string;
    status?: {
      short?: string;
      long?: string;
      elapsed?: number | null;
    };
  };
  league?: {
    name?: string;
    country?: string;
  };
  teams?: {
    home?: { name?: string };
    away?: { name?: string };
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

type ApiFootballResponse = {
  response?: ApiFootballFixture[];
  errors?: Record<string, unknown> | string[];
};

class ApiFootballError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiFootballError";
  }
}

type NormalizedFixture = {
  id: number;
  homeTeam: string;
  awayTeam: string;
  league: string;
  country: string;
  kickoff: Date;
  status: string;
};

type NormalizedLiveFixture = NormalizedFixture & {
  apiMinute: number;
  minute: number;
  homeScore: number;
  awayScore: number;
};

type TodayFixtureCache = {
  date: string;
  fixtures: NormalizedFixture[];
  fetchedAt: Date;
  nextRefreshAt: Date;
};

type LiveFixtureCache = {
  sourceCount: number;
  liveCount: number;
  fixtures: NormalizedLiveFixture[];
  fetchedAt: Date;
  nextRefreshAt: Date;
};

let todayCache: TodayFixtureCache | null = null;
let todayRefreshPromise: Promise<TodayFixtureCache> | null = null;
let liveCache: LiveFixtureCache | null = null;
let liveRefreshPromise: Promise<LiveFixtureCache> | null = null;
let liveCacheLoaded = false;
let liveCacheIsFallback = false;
let liveFallbackWarning =
  "não foi possível atualizar os jogos ao vivo — usando última lista válida";

async function loadLiveCache() {
  if (liveCacheLoaded) return;
  liveCacheLoaded = true;
  try {
    const parsed = JSON.parse(
      await fs.readFile(LIVE_CACHE_FILE, "utf8"),
    ) as LiveFixtureCache;
    if (Array.isArray(parsed.fixtures) && parsed.fetchedAt) {
      liveCache = {
        sourceCount: parsed.sourceCount ?? parsed.fixtures.length,
        liveCount: parsed.liveCount ?? parsed.fixtures.length,
        fixtures: parsed.fixtures.map((fixture) => ({
          ...fixture,
          kickoff: new Date(fixture.kickoff),
        })),
        fetchedAt: new Date(parsed.fetchedAt),
        nextRefreshAt: new Date(parsed.nextRefreshAt),
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[Ao Vivo] Não foi possível carregar o cache persistente");
    }
  }
}

async function saveLiveCache(cache: LiveFixtureCache) {
  await fs.mkdir(path.dirname(LIVE_CACHE_FILE), { recursive: true });
  const temporaryFile = `${LIVE_CACHE_FILE}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(cache), "utf8");
  await fs.rename(temporaryFile, LIVE_CACHE_FILE);
}

function getServerDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeFixture(
  item: ApiFootballFixture,
): NormalizedFixture | null {
  const fixtureId = item.fixture?.id;
  const kickoffValue = item.fixture?.date;
  const homeTeam = item.teams?.home?.name;
  const awayTeam = item.teams?.away?.name;
  const league = item.league?.name;
  const country = item.league?.country;
  const status = item.fixture?.status?.short;

  if (
    typeof fixtureId !== "number" ||
    !kickoffValue ||
    !homeTeam ||
    !awayTeam ||
    !league ||
    !country ||
    !status
  ) {
    return null;
  }

  const kickoff = new Date(kickoffValue);
  if (Number.isNaN(kickoff.getTime())) {
    return null;
  }

  return {
    id: fixtureId,
    homeTeam,
    awayTeam,
    league,
    country,
    kickoff,
    status,
  };
}

function normalizeLiveFixture(
  item: ApiFootballFixture,
  currentServerDate: string,
): NormalizedLiveFixture | null {
  const fixture = normalizeFixture(item);
  const elapsedMinute = item.fixture?.status?.elapsed;
  const shortStatusMinute = Number(item.fixture?.status?.short);
  const minute =
    typeof elapsedMinute === "number"
      ? elapsedMinute
      : Number.isFinite(shortStatusMinute)
        ? shortStatusMinute
        : null;
  const homeScore = item.goals?.home;
  const awayScore = item.goals?.away;

  if (
    !fixture ||
    !LIVE_STATUSES.has(fixture.status) ||
    getServerDate(fixture.kickoff) !== currentServerDate ||
    minute === null ||
    typeof homeScore !== "number" ||
    typeof awayScore !== "number"
  ) {
    return null;
  }

  console.log("[Ao Vivo minuto: API → interface]", {
    fixtureId: fixture.id,
    apiMinute: minute,
    interfaceMinute: minute,
  });

  return {
    ...fixture,
    apiMinute: minute,
    minute,
    homeScore,
    awayScore,
  };
}

async function fetchApiFootball(query: string): Promise<ApiFootballFixture[]> {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    throw new Error("API_FOOTBALL_KEY is not configured");
  }

  const response = await fetch(`${API_FOOTBALL_URL}?${query}`, {
    headers: {
      "x-apisports-key": apiKey,
    },
  });
  const rawResponse = await response.text();
  const quotaIndicatedByBody =
    /request limit for the day|daily quota|quota.*exhausted/i.test(rawResponse);
  console.log("[API-Football diagnóstico]", {
    query,
    date: new URLSearchParams(query).get("date"),
    statusHttp: response.status,
    quotaIndicatedByBody,
    rawResponseFirst500: rawResponse.slice(0, 500),
  });

  if (!response.ok) {
    throw new ApiFootballError(
      `API-Football returned HTTP ${response.status}`,
      response.status,
    );
  }

  let payload: ApiFootballResponse;
  try {
    payload = JSON.parse(rawResponse) as ApiFootballResponse;
  } catch {
    throw new ApiFootballError(
      "API-Football returned invalid JSON",
      response.status,
    );
  }
  const hasErrors =
    payload.errors &&
    (Array.isArray(payload.errors)
      ? payload.errors.length > 0
      : Object.keys(payload.errors).length > 0);

  if (hasErrors) {
    throw new ApiFootballError(
      "API-Football returned an error response",
      quotaIndicatedByBody ? 429 : response.status,
    );
  }

  return payload.response ?? [];
}

async function fetchTodayFixtures(date: string): Promise<TodayFixtureCache> {
  const response = await fetchApiFootball(`date=${date}`);
  await resolveSignalsFromFixtures(response);
  const fixtures = response
    .map(normalizeFixture)
    .filter((fixture): fixture is NormalizedFixture => fixture !== null);
  const fetchedAt = new Date();

  return {
    date,
    fixtures,
    fetchedAt,
    nextRefreshAt: new Date(fetchedAt.getTime() + TODAY_CACHE_TTL_MS),
  };
}

async function fetchLiveFixtures(): Promise<LiveFixtureCache> {
  const currentServerDate = new Date().toISOString().split("T")[0];
  console.log("[API-Football data da query]", {
    date: currentServerDate,
    systemDateIso: new Date().toISOString(),
  });
  const response = await fetchApiFootball(`date=${currentServerDate}`);
  await resolveSignalsFromFixtures(response);
  const fixtures = response
    .map((fixture) => normalizeLiveFixture(fixture, currentServerDate))
    .filter((fixture): fixture is NormalizedLiveFixture => fixture !== null);
  console.log("[Ao Vivo filtro por data]", {
    date: currentServerDate,
    beforeFilter: response.length,
    afterFilter: fixtures.length,
    allowedStatuses: [...LIVE_STATUSES],
  });
  const fetchedAt = new Date();

  return {
    sourceCount: response.length,
    liveCount: fixtures.length,
    fixtures,
    fetchedAt,
    nextRefreshAt: new Date(fetchedAt.getTime() + LIVE_CACHE_TTL_MS),
  };
}

async function getTodayFixtures(
  date: string,
  log: (obj: object, msg: string) => void,
) {
  if (
    todayCache &&
    todayCache.date === date &&
    todayCache.nextRefreshAt.getTime() > Date.now()
  ) {
    return { data: todayCache, stale: false, warning: null };
  }

  if (!todayRefreshPromise) {
    todayRefreshPromise = fetchTodayFixtures(date)
      .then((freshCache) => {
        todayCache = freshCache;
        return freshCache;
      })
      .finally(() => {
        todayRefreshPromise = null;
      });
  }

  try {
    const freshCache = await todayRefreshPromise;
    return { data: freshCache, stale: false, warning: null };
  } catch (error) {
    const quotaExhausted =
      error instanceof ApiFootballError && error.status === 429;
    log(
      { err: error, date },
      "Unable to refresh today's fixtures; checking last valid cache",
    );

    if (todayCache && todayCache.date === date) {
      return {
        data: todayCache,
        stale: true,
        warning: quotaExhausted
          ? "Quota diária esgotada, aguarde amanhã"
          : "não foi possível atualizar os jogos — usando última lista válida",
      };
    }

    throw error;
  }
}

async function getLiveFixtures(
  log: (obj: object, msg: string) => void,
) {
  await loadLiveCache();
  if (liveCache && liveCache.nextRefreshAt.getTime() > Date.now()) {
    return {
      data: liveCache,
      stale: liveCacheIsFallback,
      warning: liveCacheIsFallback ? liveFallbackWarning : null,
    };
  }

  if (!liveRefreshPromise) {
    liveRefreshPromise = fetchLiveFixtures()
      .then((freshCache) => {
        liveCache = freshCache;
        liveCacheIsFallback = false;
        void saveLiveCache(freshCache).catch((error) => {
          log({ err: error }, "Unable to persist live fixture cache");
        });
        return freshCache;
      })
      .finally(() => {
        liveRefreshPromise = null;
      });
  }

  try {
    const freshCache = await liveRefreshPromise;
    return { data: freshCache, stale: false, warning: null };
  } catch (error) {
    const quotaExhausted =
      error instanceof ApiFootballError && error.status === 429;
    liveFallbackWarning = quotaExhausted
      ? "Quota diária esgotada, aguarde amanhã"
      : "não foi possível atualizar os jogos ao vivo — usando última lista válida";
    console.log("[Ao Vivo filtro por data]", {
      date: getServerDate(),
      beforeFilter: 0,
      afterFilter: 0,
      upstreamError: true,
      upstreamStatus:
        error instanceof ApiFootballError ? error.status : undefined,
      quotaExhausted,
      allowedStatuses: [...LIVE_STATUSES],
    });
    log(
      { err: error },
      "Unable to refresh live fixtures; returning an empty safe state",
    );

    if (liveCache) {
      liveCacheIsFallback = true;
      liveCache.nextRefreshAt = new Date(Date.now() + LIVE_CACHE_TTL_MS);
      return {
        data: liveCache,
        stale: true,
        warning: liveFallbackWarning,
      };
    }

    const fetchedAt = new Date();
    liveCache = {
      sourceCount: 0,
      liveCount: 0,
      fixtures: [],
      fetchedAt,
      nextRefreshAt: new Date(fetchedAt.getTime() + LIVE_CACHE_TTL_MS),
    };
    liveCacheIsFallback = true;
    return {
      data: liveCache,
      stale: true,
      warning: quotaExhausted
        ? "Quota diária esgotada, aguarde amanhã"
        : "não foi possível atualizar os jogos ao vivo — nova tentativa em 20 minutos",
    };
  }
}

export async function getLiveFixturesForNotifications(
  log: (obj: object, msg: string) => void,
): Promise<NormalizedLiveFixture[]> {
  const result = await getLiveFixtures(log);
  return result.data.fixtures;
}

router.get("/fixtures/today", async (req, res) => {
  const date = new Date().toISOString().split("T")[0];
  console.log("[API-Football data da query]", {
    date,
    systemDateIso: new Date().toISOString(),
  });

  try {
    const result = await getTodayFixtures(date, (obj, message) =>
      req.log.warn(obj, message),
    );

    const data = GetTodayFixturesResponse.parse({
      fixtures: result.data.fixtures,
      date: result.data.date,
      fetchedAt: result.data.fetchedAt,
      nextRefreshAt: result.data.nextRefreshAt,
      stale: result.stale,
      warning: result.warning,
    });

    return res.json(data);
  } catch (error) {
    req.log.error({ err: error, date }, "Today's fixtures are unavailable");
    if (error instanceof ApiFootballError && error.status === 429) {
      return res.json(
        GetTodayFixturesResponse.parse({
          fixtures: [],
          date,
          fetchedAt: new Date(),
          nextRefreshAt: new Date(Date.now() + LIVE_CACHE_TTL_MS),
          stale: true,
          warning: "Quota diária esgotada, aguarde amanhã",
        }),
      );
    }
    return res.status(503).json({
      error: "fixtures_unavailable",
      warning:
        "não foi possível carregar os jogos reais de hoje — tente novamente mais tarde",
    });
  }
});

router.get("/fixtures/live", async (req, res) => {
  try {
    const result = await getLiveFixtures((obj, message) =>
      req.log.warn(obj, message),
    );

    const data = GetLiveFixturesResponse.parse({
      sourceCount: result.data.sourceCount,
      liveCount: result.data.liveCount,
      fixtures: result.data.fixtures,
      fetchedAt: result.data.fetchedAt,
      nextRefreshAt: result.data.nextRefreshAt,
      stale: result.stale,
      warning: result.warning,
    });

    res.json(data);
  } catch (error) {
    req.log.error({ err: error }, "Live fixtures are unavailable");
    res.status(503).json({
      error: "live_fixtures_unavailable",
      warning:
        "não foi possível carregar os jogos ao vivo — tente novamente mais tarde",
    });
  }
});

export default router;