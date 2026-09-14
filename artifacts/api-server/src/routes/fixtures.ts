import { Router, type IRouter } from "express";
import { GetTodayFixturesResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const API_FOOTBALL_URL = "https://v3.football.api-sports.io/fixtures";
const CACHE_TTL_MS = 15 * 60 * 1000;

type ApiFootballFixture = {
  fixture?: {
    id?: number;
    date?: string;
    status?: {
      short?: string;
      long?: string;
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
};

type ApiFootballResponse = {
  response?: ApiFootballFixture[];
  errors?: Record<string, unknown> | string[];
};

type FixtureCache = {
  date: string;
  fixtures: ReturnType<typeof normalizeFixture>[];
  fetchedAt: Date;
  nextRefreshAt: Date;
};

let cache: FixtureCache | null = null;
let refreshPromise: Promise<FixtureCache> | null = null;

function getServerDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeFixture(item: ApiFootballFixture) {
  const fixtureId = item.fixture?.id;
  const kickoff = item.fixture?.date;
  const homeTeam = item.teams?.home?.name;
  const awayTeam = item.teams?.away?.name;
  const league = item.league?.name;
  const country = item.league?.country;

  if (
    typeof fixtureId !== "number" ||
    !kickoff ||
    !homeTeam ||
    !awayTeam ||
    !league ||
    !country
  ) {
    return null;
  }

  return {
    id: fixtureId,
    homeTeam,
    awayTeam,
    league,
    country,
    kickoff: new Date(kickoff),
    status: item.fixture?.status?.short || item.fixture?.status?.long || "NS",
  };
}

async function fetchTodayFixtures(date: string): Promise<FixtureCache> {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) {
    throw new Error("API_FOOTBALL_KEY is not configured");
  }

  const response = await fetch(`${API_FOOTBALL_URL}?date=${date}`, {
    headers: {
      "x-apisports-key": apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`API-Football returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as ApiFootballResponse;
  const errors =
    payload.errors &&
    (Array.isArray(payload.errors)
      ? payload.errors.length > 0
      : Object.keys(payload.errors).length > 0);

  if (errors) {
    throw new Error("API-Football returned an error response");
  }

  const fixtures = (payload.response ?? [])
    .map(normalizeFixture)
    .filter((fixture): fixture is NonNullable<typeof fixture> => fixture !== null);
  const fetchedAt = new Date();

  return {
    date,
    fixtures,
    fetchedAt,
    nextRefreshAt: new Date(fetchedAt.getTime() + CACHE_TTL_MS),
  };
}

async function getCachedFixtures(date: string, log: (obj: object, msg: string) => void) {
  const hasFreshCache =
    cache &&
    cache.date === date &&
    cache.nextRefreshAt.getTime() > Date.now();

  if (hasFreshCache && cache) {
    return { data: cache, stale: false, warning: null };
  }

  if (!refreshPromise) {
    refreshPromise = fetchTodayFixtures(date)
      .then((freshCache) => {
        cache = freshCache;
        return freshCache;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  try {
    const freshCache = await refreshPromise;
    return { data: freshCache, stale: false, warning: null };
  } catch (error) {
    log(
      { err: error, date },
      "Unable to refresh today's fixtures; checking last valid cache",
    );

    if (cache && cache.date === date) {
      return {
        data: cache,
        stale: true,
        warning: "não foi possível atualizar os jogos — usando última lista válida",
      };
    }

    throw error;
  }
}

router.get("/fixtures/today", async (req, res) => {
  const date = getServerDate();

  try {
    const result = await getCachedFixtures(date, (obj, message) =>
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

export default router;