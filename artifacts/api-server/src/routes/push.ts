import { promises as fs } from "node:fs";
import path from "node:path";
import { Router, type IRouter } from "express";
import webpush, { type PushSubscription } from "web-push";
import {
  GetVapidPublicKeyResponse,
  SubscribePushBody,
  SubscribePushResponse,
  UpdateFavoriteIdsBody,
  UpdateFavoriteIdsResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { getLiveFixturesForNotifications } from "./fixtures";

export const EVENTS_POLL_INTERVAL_SECONDS = 60;

const API_FOOTBALL_EVENTS_URL =
  "https://v3.football.api-sports.io/fixtures/events";
const STATE_FILE = path.resolve(
  import.meta.dirname,
  "../data/push-state.json",
);

type StoredState = {
  subscriptions: PushSubscription[];
  favoriteIds: number[];
  seenEvents: Record<string, string[]>;
};

type ApiEvent = {
  time?: { elapsed?: number | null; extra?: number | null };
  team?: { id?: number; name?: string };
  player?: { id?: number; name?: string };
  assist?: { id?: number; name?: string };
  type?: string;
  detail?: string;
  comments?: string | null;
};

let state: StoredState = {
  subscriptions: [],
  favoriteIds: [],
  seenEvents: {},
};
let stateLoaded = false;
let savePromise = Promise.resolve();

function getVapidKeys() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    throw new Error("VAPID keys are not configured");
  }
  return { publicKey, privateKey };
}

async function loadState() {
  if (stateLoaded) return;
  try {
    const content = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(content) as Partial<StoredState>;
    state = {
      subscriptions: Array.isArray(parsed.subscriptions)
        ? parsed.subscriptions
        : [],
      favoriteIds: Array.isArray(parsed.favoriteIds) ? parsed.favoriteIds : [],
      seenEvents:
        parsed.seenEvents && typeof parsed.seenEvents === "object"
          ? parsed.seenEvents
          : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn({ err: error }, "Unable to load push notification state");
    }
  }
  stateLoaded = true;
}

function saveState() {
  savePromise = savePromise.then(async () => {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  });
  return savePromise;
}

function eventKey(event: ApiEvent): string {
  return JSON.stringify([
    event.time?.elapsed,
    event.time?.extra,
    event.team?.id,
    event.player?.id,
    event.assist?.id,
    event.type,
    event.detail,
    event.comments,
  ]);
}

function isImportantEvent(event: ApiEvent): boolean {
  return (
    event.type === "Goal" ||
    (event.type === "Card" &&
      (event.detail === "Yellow Card" || event.detail === "Red Card"))
  );
}

function buildNotification(
  event: ApiEvent,
  fixture: {
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
  },
) {
  const minute = event.time?.elapsed;
  const extra = event.time?.extra;
  const minuteLabel =
    typeof minute === "number"
      ? `${minute}${typeof extra === "number" && extra > 0 ? `+${extra}` : ""}'`
      : "agora";
  const actor = event.player?.name ?? event.team?.name ?? "Jogador";

  if (event.type === "Goal") {
    return {
      title: "⚽ Golo!",
      body: `${fixture.homeTeam} ${fixture.homeScore}-${fixture.awayScore} ${fixture.awayTeam} (${minuteLabel}) · ${actor}`,
    };
  }
  if (event.detail === "Red Card") {
    return {
      title: "🟥 Cartão vermelho",
      body: `${actor} · ${event.team?.name ?? "Equipa"} (${minuteLabel})`,
    };
  }
  return {
    title: "🟨 Cartão amarelo",
    body: `${actor} · ${event.team?.name ?? "Equipa"} (${minuteLabel})`,
  };
}

async function sendToAllSubscriptions(payload: {
  title: string;
  body: string;
}) {
  const invalidEndpoints = new Set<string>();
  await Promise.allSettled(
    state.subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({ ...payload, url: "/" }),
        );
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          invalidEndpoints.add(subscription.endpoint);
          return;
        }
        throw error;
      }
    }),
  );
  if (invalidEndpoints.size > 0) {
    state.subscriptions = state.subscriptions.filter(
      (subscription) => !invalidEndpoints.has(subscription.endpoint),
    );
  }
}

async function fetchFixtureEvents(fixtureId: number): Promise<ApiEvent[]> {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) throw new Error("API_FOOTBALL_KEY is not configured");
  const response = await fetch(
    `${API_FOOTBALL_EVENTS_URL}?fixture=${fixtureId}`,
    { headers: { "x-apisports-key": apiKey } },
  );
  if (!response.ok) {
    throw new Error(`API-Football events returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    response?: ApiEvent[];
    errors?: Record<string, unknown> | unknown[];
  };
  return payload.response ?? [];
}

async function pollFavoriteEvents() {
  await loadState();
  if (state.favoriteIds.length === 0 || state.subscriptions.length === 0) return;

  const liveFixtures = await getLiveFixturesForNotifications((obj, message) =>
    logger.warn(obj, message),
  );
  const favoriteSet = new Set(state.favoriteIds);
  const monitored = liveFixtures.filter((fixture) =>
    favoriteSet.has(fixture.id),
  );

  for (const fixture of monitored) {
    try {
      const events = (await fetchFixtureEvents(fixture.id)).filter(
        isImportantEvent,
      );
      const keys = events.map(eventKey);
      const previous = state.seenEvents[String(fixture.id)];
      if (!previous) {
        state.seenEvents[String(fixture.id)] = keys;
        continue;
      }
      const seen = new Set(previous);
      for (const event of events) {
        const key = eventKey(event);
        if (seen.has(key)) continue;
        await sendToAllSubscriptions(buildNotification(event, fixture));
        seen.add(key);
      }
      state.seenEvents[String(fixture.id)] = [...seen];
    } catch (error) {
      logger.warn(
        { err: error, fixtureId: fixture.id },
        "Unable to poll favorite fixture events",
      );
    }
  }
  await saveState();
}

export function startPushEventPolling() {
  try {
    const { publicKey, privateKey } = getVapidKeys();
    webpush.setVapidDetails(
      "mailto:notifications@radardegolos.app",
      publicKey,
      privateKey,
    );
  } catch (error) {
    logger.error({ err: error }, "Push notifications are not configured");
    return;
  }
  void loadState();
  setInterval(() => {
    void pollFavoriteEvents().catch((error) => {
      logger.error({ err: error }, "Push event polling cycle failed");
    });
  }, EVENTS_POLL_INTERVAL_SECONDS * 1000).unref();
}

const router: IRouter = Router();

router.get("/vapid-public-key", (_req, res) => {
  try {
    const data = GetVapidPublicKeyResponse.parse({
      publicKey: getVapidKeys().publicKey,
    });
    res.json(data);
  } catch {
    res.status(503).json({ error: "push_not_configured" });
  }
});

router.post("/subscribe", async (req, res) => {
  try {
    await loadState();
    const subscription = SubscribePushBody.parse(req.body);
    state.subscriptions = [
      ...state.subscriptions.filter(
        (stored) => stored.endpoint !== subscription.endpoint,
      ),
      subscription,
    ];
    await saveState();
    res.json(SubscribePushResponse.parse({ ok: true }));
  } catch (error) {
    req.log.warn({ err: error }, "Unable to store push subscription");
    res.status(400).json({ error: "invalid_subscription" });
  }
});

router.post("/favorites", async (req, res) => {
  try {
    await loadState();
    const payload = UpdateFavoriteIdsBody.parse(req.body);
    state.favoriteIds = [...new Set(payload.fixtureIds)];
    await saveState();
    res.json(UpdateFavoriteIdsResponse.parse({ ok: true }));
  } catch (error) {
    req.log.warn({ err: error }, "Unable to store favorite fixture IDs");
    res.status(400).json({ error: "invalid_favorites" });
  }
});

export default router;