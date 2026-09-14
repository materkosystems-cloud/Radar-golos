import { Router, type IRouter } from "express";
import {
  GetLiveFixturesResponse,
  GetTodayFixturesResponse,
} from "@workspace/api-zod";
import { resolveSignalsFromFixtures } from "./history";

const router: IRouter = Router();

const API_FOOTBALL_URL = "https://v3.football.api-sports.io/fixtures";
const TODAY_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const LIVE_CACHE_TTL_MS = 20 * 60 * 1000;
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
  fixtures: NormalizedLiveFixture[];
  fetchedAt: Date;
  nextRefreshAt: Date;
};

let todayCache: TodayFixtureCache | null = null;
let todayRefreshPromise: Promise<TodayFixtureCache> | null = null;
let liveCache: LiveFixtureCache | null = null;
let liveRefreshPromise: Promise<LiveFixtureCache> | null = null;

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
  const minute = item.fixture?.status?.elapsed;
  const homeScore = item.goals?.home;
  const awayScore = item.goals?.away;

  if (
    !fixture ||
    !LIVE_STATUSES.has(fixture.status) ||
    getServerDate(fixture.kickoff) !== currentServerDate ||
    typeof minute !== "number" ||
    typeof homeScore !== "number" ||
    typeof awayScore !== "number"
  ) {
    return null;
  }

  return {
    ...fixture,
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

  if (!response.ok) {
    throw new Error(`API-Football returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as ApiFootballResponse;
  const hasErrors =
    payload.errors &&
    (Array.isArray(payload.errors)
      ? payload.errors.length > 0
      : Object.keys(payload.errors).length > 0);

  if (hasErrors) {
    throw new Error("API-Football returned an error response");
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
  const currentServerDate = getServerDate();
  const response = await fetchApiFootball("live=all");
  await resolveSignalsFromFixtures(response);
  const fixtures = response
    .map((fixture) => normalizeLiveFixture(fixture, currentServerDate))
    .filter((fixture): fixture is NormalizedLiveFixture => fixture !== null);
  const fetchedAt = new Date();

  return {
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
    log(
      { err: error, date },
      "Unable to refresh today's fixtures; checking last valid cache",
    );

    if (todayCache && todayCache.date === date) {
      return {
        data: todayCache,
        stale: true,
        warning: "não foi possível atualizar os jogos — usando última lista válida",
      };
    }

    throw error;
  }
}

async function getLiveFixtures(
  log: (obj: object, msg: string) => void,
) {
  if (liveCache && liveCache.nextRefreshAt.getTime() > Date.now()) {
    return { data: liveCache, stale: false, warning: null };
  }

  if (!liveRefreshPromise) {
    liveRefreshPromise = fetchLiveFixtures()
      .then((freshCache) => {
        liveCache = freshCache;
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
    log(
      { err: error },
      "Unable to refresh live fixtures; returning an empty safe state",
    );

    const fetchedAt = new Date();
    return {
      data: {
        fixtures: [],
        fetchedAt,
        nextRefreshAt: new Date(fetchedAt.getTime() + LIVE_CACHE_TTL_MS),
      },
      stale: true,
      warning:
        "não foi possível atualizar os jogos ao vivo — nova tentativa em 20 minutos",
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
  const date = getServerDate();

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

    res.json(data);
  } catch (error) {
    req.log.error({ err: error, date }, "Today's fixtures are unavailable");
    res.status(503).json({
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